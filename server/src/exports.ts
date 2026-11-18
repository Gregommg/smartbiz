import type { Express } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { me, need, branchIds, requireBranch } from './core.js'
import { dateStr, todayEAT, win } from './time.js'

const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s   // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"'
}
/** CSV files for your accountant. Dates are Nairobi time. */
export function registerExports(app: Express) {
  app.get('/api/exports/:kind', need('owner', 'manager'), async (req, res) => {
    const u = me(res), today = todayEAT()
    const q = z.object({ kind: z.enum(['sales', 'payments', 'expenses', 'purchases', 'stock', 'customers', 'suppliers', 'cashups']), from: dateStr.default(today.slice(0, 8) + '01'), to: dateStr.default(today), branchId: z.string().uuid().optional() }).parse({ ...req.query, kind: req.params.kind })
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    const P = [u.business_id, ids, q.from, q.to]
    const sql: Record<string, string> = {
      sales: `SELECT s.created_at AS date,s.number AS receipt,b.name AS branch,us.name AS cashier,c.name AS customer,si.name AS product,si.qty,si.unit_price,si.line_total,si.tax_rate,si.tax_amount,si.refunded_qty
        FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN branches b ON b.id=s.branch_id JOIN users us ON us.id=s.cashier_id LEFT JOIN customers c ON c.id=s.customer_id
        WHERE s.business_id=$1 AND s.branch_id=ANY($2::uuid[]) AND ${win('s.created_at', 3, 4)} ORDER BY s.number,si.name`,
      payments: `SELECT s.created_at AS date,s.number AS receipt,b.name AS branch,sp.method,sp.amount,sp.reference FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id JOIN branches b ON b.id=s.branch_id
        WHERE s.business_id=$1 AND s.branch_id=ANY($2::uuid[]) AND ${win('s.created_at', 3, 4)} ORDER BY s.number`,
      expenses: `SELECT e.spent_on AS date,b.name AS branch,e.category,e.amount,e.method,e.note FROM expenses e JOIN branches b ON b.id=e.branch_id
        WHERE e.business_id=$1 AND e.branch_id=ANY($2::uuid[]) AND e.spent_on BETWEEN $3::date AND $4::date ORDER BY e.spent_on`,
      purchases: `SELECT m.created_at AS date,po.number AS purchase_order,s.name AS supplier,b.name AS branch,p.sku,p.name AS product,m.qty,m.unit_cost,(m.qty*m.unit_cost) AS value
        FROM stock_movements m JOIN purchase_orders po ON po.id=m.ref_id JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=m.branch_id JOIN products p ON p.id=m.product_id
        WHERE m.business_id=$1 AND m.type='purchase' AND m.branch_id=ANY($2::uuid[]) AND ${win('m.created_at', 3, 4)} ORDER BY m.created_at`,
      stock: `SELECT b.name AS branch,p.sku,p.name AS product,sb.qty,p.cost,(sb.qty*p.cost) AS value FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN branches b ON b.id=sb.branch_id
        WHERE p.business_id=$1 AND sb.branch_id=ANY($2::uuid[]) AND $3::date IS NOT NULL AND $4::date IS NOT NULL ORDER BY p.name`,
      customers: `SELECT c.name,c.phone,c.credit_limit,coalesce(sum(l.amount),0) AS balance FROM customers c LEFT JOIN customer_ledger l ON l.customer_id=c.id WHERE c.business_id=$1 AND $2::uuid[] IS NOT NULL AND $3::date IS NOT NULL AND $4::date IS NOT NULL GROUP BY c.id ORDER BY c.name`,
      suppliers: `SELECT s.name AS supplier,i.invoice_no,i.invoice_date,i.due_date,i.amount,(i.amount - coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id=i.id),0)) AS outstanding
        FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.business_id=$1 AND $2::uuid[] IS NOT NULL AND i.invoice_date BETWEEN $3::date AND $4::date ORDER BY i.invoice_date`,
      cashups: `SELECT c.opened_at,c.closed_at,u.name AS cashier,b.name AS branch,c.opening_float,c.expected_cash,c.counted_cash,c.variance FROM cash_sessions c JOIN users u ON u.id=c.user_id JOIN branches b ON b.id=c.branch_id
        WHERE c.business_id=$1 AND c.branch_id=ANY($2::uuid[]) AND ${win('c.opened_at', 3, 4)} ORDER BY c.opened_at`,
    }
    const rows = (await pool.query(sql[q.kind], P)).rows
    const cols = rows[0] ? Object.keys(rows[0]) : ['no_data']
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="smartbiz-${q.kind}-${q.from}-${q.to}.csv"`)
    res.send([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n'))
  })
}
