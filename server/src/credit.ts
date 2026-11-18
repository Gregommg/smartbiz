import type { Express } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { HttpError, me, need, audit, money, requireBranch } from './core.js'
import { dateStr } from './time.js'

const uuid = z.string().uuid()

export function registerCredit(app: Express) {
  const customer = async (businessId: string, id: string) => {
    const c = (await pool.query('SELECT id,name,phone,credit_limit FROM customers WHERE id=$1 AND business_id=$2', [id, businessId])).rows[0]
    if (!c) throw new HttpError(404, 'Customer not found')
    return c as { id: string; name: string; phone: string | null; credit_limit: number }
  }
  const owed = async (id: string) => (await pool.query('SELECT coalesce(sum(amount),0) AS b FROM customer_ledger WHERE customer_id=$1', [id])).rows[0].b as number

  // A customer pays money they owe.
  app.post('/api/customers/:id/payments', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), c = await customer(u.business_id, uuid.parse(req.params.id))
    const b = z.object({ amount: z.number().positive().max(1e9), method: z.enum(['cash', 'mpesa', 'card', 'bank']), reference: z.string().trim().max(60).optional(), branchId: uuid, note: z.string().trim().max(200).optional() }).parse(req.body)
    await requireBranch(u, b.branchId)
    if (b.method === 'mpesa' && (b.reference?.length ?? 0) < 6) throw new HttpError(400, 'Enter the M-Pesa transaction code')
    const before = await owed(c.id)
    if (b.amount > before + 0.004) throw new HttpError(400, `This is more than the customer owes (${before})`)
    await pool.query(`INSERT INTO customer_ledger(business_id,customer_id,type,amount,method,reference,branch_id,created_by,note) VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8)`, [u.business_id, c.id, -b.amount, b.method, b.reference ?? null, b.branchId, u.id, b.note ?? null])
    await audit(pool, u, 'customer.payment', 'customer', c.id, { amount: b.amount, method: b.method })
    res.status(201).json({ balance: money(before - b.amount) })
  })
  // Owner write-off or correction (+ increases what they owe, - reduces it). Always needs a note.
  app.post('/api/customers/:id/adjustments', need('owner'), async (req, res) => {
    const u = me(res), c = await customer(u.business_id, uuid.parse(req.params.id))
    const b = z.object({ amount: z.number().refine(n => n !== 0).refine(n => Math.abs(n) <= 1e9), note: z.string().trim().min(3).max(200) }).parse(req.body)
    await pool.query(`INSERT INTO customer_ledger(business_id,customer_id,type,amount,note,created_by) VALUES($1,$2,'adjustment',$3,$4,$5)`, [u.business_id, c.id, b.amount, b.note, u.id])
    await audit(pool, u, 'customer.adjustment', 'customer', c.id, b)
    res.status(201).json({ balance: money(await owed(c.id)) })
  })
  app.get('/api/customers/:id/statement', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), c = await customer(u.business_id, uuid.parse(req.params.id))
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query)
    const rows = (await pool.query(`SELECT l.id,l.type,l.amount,l.method,l.reference,l.note,l.created_at,s.number AS receipt FROM customer_ledger l LEFT JOIN sales s ON s.id=l.ref_id AND l.type IN ('sale','refund')
      WHERE l.customer_id=$1 AND ($2::date IS NULL OR l.created_at >= ($2::date)::timestamp AT TIME ZONE 'Africa/Nairobi') AND ($3::date IS NULL OR l.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')) ORDER BY l.id`, [c.id, q.from ?? null, q.to ?? null])).rows
    const opening = q.from ? (await pool.query(`SELECT coalesce(sum(amount),0) AS b FROM customer_ledger WHERE customer_id=$1 AND created_at < ($2::date)::timestamp AT TIME ZONE 'Africa/Nairobi'`, [c.id, q.from])).rows[0].b as number : 0
    let run = opening
    res.json({ customer: c, opening, rows: rows.map(r => ({ ...r, balance: money((run += r.amount)) })), balance: money(await owed(c.id)) })
  })
  app.get('/api/receivables', need('owner', 'manager'), async (_q, res) => {
    const rows = (await pool.query(`SELECT c.id,c.name,c.phone,c.credit_limit,sum(l.amount) AS balance,max(l.created_at) FILTER (WHERE l.type='payment') AS last_payment
      FROM customers c JOIN customer_ledger l ON l.customer_id=c.id WHERE c.business_id=$1 GROUP BY c.id HAVING sum(l.amount) > 0 ORDER BY sum(l.amount) DESC`, [me(res).business_id])).rows
    res.json({ total: money(rows.reduce((a, r) => a + r.balance, 0)), customers: rows })
  })
}
