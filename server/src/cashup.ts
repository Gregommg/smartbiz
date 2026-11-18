import type { Express } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { HttpError, me, need, audit, money, branchIds, requireBranch } from './core.js'
import { dateStr, todayEAT, win } from './time.js'

const uuid = z.string().uuid()
/** Cash that should be in the drawer: opening float + cash sales + cash received from customers - cash refunds - cash expenses, all by this person at this branch since the session opened. */
async function expectedCash(s: { business_id: string; branch_id: string; user_id: string; opened_at: Date; opening_float: number }) {
  const r = (await pool.query(`SELECT
    (SELECT coalesce(sum(sp.amount),0) FROM sale_payments sp JOIN sales x ON x.id=sp.sale_id WHERE sp.method='cash' AND x.business_id=$1 AND x.branch_id=$2 AND x.cashier_id=$3 AND x.created_at >= $4) AS sales,
    (SELECT coalesce(sum(amount),0) FROM sale_refunds WHERE business_id=$1 AND branch_id=$2 AND actor_id=$3 AND method='cash' AND created_at >= $4) AS refunds,
    (SELECT coalesce(sum(-amount),0) FROM customer_ledger WHERE business_id=$1 AND branch_id=$2 AND created_by=$3 AND type='payment' AND method='cash' AND created_at >= $4) AS received,
    (SELECT coalesce(sum(amount),0) FROM expenses WHERE business_id=$1 AND branch_id=$2 AND created_by=$3 AND method='cash' AND created_at >= $4) AS expenses`, [s.business_id, s.branch_id, s.user_id, s.opened_at])).rows[0]
  return { ...r, expected: money(s.opening_float + r.sales + r.received - r.refunds - r.expenses) }
}

export function registerCashup(app: Express) {
  const cashiers = need('owner', 'manager', 'cashier')
  app.get('/api/cash-sessions/current', cashiers, async (req, res) => {
    const u = me(res), branchId = uuid.parse(req.query.branchId); await requireBranch(u, branchId)
    const s = (await pool.query('SELECT id,opened_at,opening_float FROM cash_sessions WHERE branch_id=$1 AND user_id=$2 AND closed_at IS NULL', [branchId, u.id])).rows[0] ?? null
    res.json(s ? { ...s, ...(await expectedCash({ business_id: u.business_id, branch_id: branchId, user_id: u.id, opened_at: s.opened_at, opening_float: s.opening_float })) } : null)
  })
  app.post('/api/cash-sessions/open', cashiers, async (req, res) => {
    const u = me(res), b = z.object({ branchId: uuid, openingFloat: z.number().min(0).max(1e8) }).parse(req.body)
    await requireBranch(u, b.branchId)
    const r = (await pool.query('INSERT INTO cash_sessions(business_id,branch_id,user_id,opening_float) VALUES($1,$2,$3,$4) RETURNING id', [u.business_id, b.branchId, u.id, b.openingFloat])).rows[0]
    await audit(pool, u, 'cash.open', 'cash_session', r.id, { float: b.openingFloat })
    res.status(201).json(r)
  })
  app.post('/api/cash-sessions/:id/close', cashiers, async (req, res) => {
    const u = me(res), id = uuid.parse(req.params.id), b = z.object({ countedCash: z.number().min(0).max(1e9), note: z.string().trim().max(200).optional() }).parse(req.body)
    const s = (await pool.query('SELECT * FROM cash_sessions WHERE id=$1 AND business_id=$2 AND closed_at IS NULL', [id, u.business_id])).rows[0]
    if (!s) throw new HttpError(404, 'Open session not found')
    if (s.user_id !== u.id && u.role === 'cashier') throw new HttpError(403, 'You can only close your own session')
    const e = await expectedCash(s), variance = money(b.countedCash - e.expected)
    await pool.query('UPDATE cash_sessions SET closed_at=now(), counted_cash=$2, expected_cash=$3, variance=$4, note=$5 WHERE id=$1', [id, b.countedCash, e.expected, variance, b.note ?? null])
    await audit(pool, u, 'cash.close', 'cash_session', id, { counted: b.countedCash, expected: e.expected, variance })
    res.json({ expected: e.expected, counted: b.countedCash, variance, opening_float: s.opening_float, cash_sales: e.sales, cash_received: e.received, cash_refunds: e.refunds, cash_expenses: e.expenses })
  })
  app.get('/api/cash-sessions', need('owner', 'manager'), async (req, res) => {
    const u = me(res), today = todayEAT(), q = z.object({ from: dateStr.default(today.slice(0, 8) + '01'), to: dateStr.default(today), branchId: uuid.optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT c.id,c.opened_at,c.closed_at,c.opening_float,c.counted_cash,c.expected_cash,c.variance,c.note,u.name AS cashier,b.name AS branch FROM cash_sessions c JOIN users u ON u.id=c.user_id JOIN branches b ON b.id=c.branch_id
      WHERE c.business_id=$1 AND c.branch_id=ANY($2::uuid[]) AND ${win('c.opened_at', 3, 4)} ORDER BY c.opened_at DESC LIMIT 300`, [u.business_id, ids, q.from, q.to])).rows)
  })
}
