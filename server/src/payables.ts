import type { Express } from 'express'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { HttpError, me, need, audit, money } from './core.js'
import { dateStr, todayEAT } from './time.js'

const uuid = z.string().uuid()
const OUT = `(i.amount - coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id=i.id),0))`

export function registerPayables(app: Express) {
  const money_ = need('owner', 'manager')
  app.post('/api/supplier-invoices', money_, async (req, res) => {
    const u = me(res)
    const b = z.object({ supplierId: uuid, poId: uuid.nullable().optional(), invoiceNo: z.string().trim().min(1).max(60), invoiceDate: dateStr, dueDate: dateStr, amount: z.number().positive().max(1e9), notes: z.string().trim().max(200).optional() }).parse(req.body)
    if (b.dueDate < b.invoiceDate) throw new HttpError(400, 'The due date cannot be before the invoice date')
    if (!(await pool.query('SELECT 1 FROM suppliers WHERE id=$1 AND business_id=$2', [b.supplierId, u.business_id])).rowCount) throw new HttpError(400, 'Unknown supplier')
    if (b.poId && !(await pool.query('SELECT 1 FROM purchase_orders WHERE id=$1 AND business_id=$2 AND supplier_id=$3', [b.poId, u.business_id, b.supplierId])).rowCount) throw new HttpError(400, 'That purchase order is not for this supplier')
    const r = (await pool.query('INSERT INTO supplier_invoices(business_id,supplier_id,po_id,invoice_no,invoice_date,due_date,amount,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [u.business_id, b.supplierId, b.poId ?? null, b.invoiceNo, b.invoiceDate, b.dueDate, b.amount, b.notes ?? null, u.id])).rows[0]
    await audit(pool, u, 'supplier_invoice.create', 'supplier_invoice', r.id, { invoiceNo: b.invoiceNo, amount: b.amount })
    res.status(201).json(r)
  })
  app.get('/api/supplier-invoices', money_, async (req, res) => {
    const u = me(res), q = z.object({ status: z.enum(['open', 'paid', 'all']).default('open'), supplierId: uuid.optional() }).parse(req.query)
    res.json((await pool.query(`SELECT i.id,i.invoice_no,i.invoice_date,i.due_date,i.amount,s.name AS supplier,i.supplier_id,${OUT} AS outstanding, GREATEST(0, $4::date - i.due_date) AS days_overdue
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.business_id=$1 AND ($2::uuid IS NULL OR i.supplier_id=$2)
      AND ($3='all' OR ($3='open' AND ${OUT} > 0.004) OR ($3='paid' AND ${OUT} <= 0.004)) ORDER BY i.due_date, i.created_at LIMIT 300`, [u.business_id, q.supplierId ?? null, q.status, todayEAT()])).rows)
  })
  app.post('/api/supplier-invoices/:id/payments', money_, async (req, res) => {
    const u = me(res), id = uuid.parse(req.params.id)
    const b = z.object({ amount: z.number().positive().max(1e9), method: z.enum(['cash', 'mpesa', 'bank', 'card']), reference: z.string().trim().max(60).optional(), paidOn: dateStr.default(todayEAT()) }).parse(req.body)
    const left = await tx(async c => {
      const inv = (await c.query(`SELECT i.id,${OUT} AS outstanding FROM supplier_invoices i WHERE i.id=$1 AND i.business_id=$2 FOR UPDATE`, [id, u.business_id])).rows[0]
      if (!inv) throw new HttpError(404, 'Invoice not found')
      if (b.amount > inv.outstanding + 0.004) throw new HttpError(400, `This is more than is still owed on the invoice (${inv.outstanding})`)
      await c.query('INSERT INTO supplier_payments(business_id,invoice_id,amount,method,reference,paid_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [u.business_id, id, b.amount, b.method, b.reference ?? null, b.paidOn, u.id])
      await audit(c, u, 'supplier_invoice.payment', 'supplier_invoice', id, { amount: b.amount })
      return money(inv.outstanding - b.amount)
    })
    res.status(201).json({ outstanding: left })
  })
  app.get('/api/payables', money_, async (_q, res) => {
    const u = me(res), t = todayEAT()
    const rows = (await pool.query(`SELECT s.id,s.name,sum(${OUT}) AS owed,
      sum(CASE WHEN i.due_date >= $2::date THEN ${OUT} ELSE 0 END) AS current,
      sum(CASE WHEN $2::date - i.due_date BETWEEN 1 AND 30 THEN ${OUT} ELSE 0 END) AS d1_30,
      sum(CASE WHEN $2::date - i.due_date BETWEEN 31 AND 60 THEN ${OUT} ELSE 0 END) AS d31_60,
      sum(CASE WHEN $2::date - i.due_date > 60 THEN ${OUT} ELSE 0 END) AS d61
      FROM suppliers s JOIN supplier_invoices i ON i.supplier_id=s.id WHERE s.business_id=$1 GROUP BY s.id HAVING sum(${OUT}) > 0.004 ORDER BY sum(${OUT}) DESC`, [u.business_id, t])).rows
    const sum = (k: string) => money(rows.reduce((a, r) => a + r[k], 0))
    res.json({ total: sum('owed'), current: sum('current'), d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61: sum('d61'), suppliers: rows })
  })
}
