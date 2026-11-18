import type { Express } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { me, need, branchIds, requireBranch, money } from './core.js'
import { dateStr, todayEAT, win } from './time.js'

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null)
const dayKey = (col: string) => `to_char(${col} AT TIME ZONE 'Africa/Nairobi','YYYY-MM-DD')`

export function registerReports(app: Express) {
  app.get('/api/reports/summary', need('owner', 'manager'), async (req, res) => {
    const u = me(res), today = todayEAT()
    const q = z.object({ from: dateStr.default(today), to: dateStr.default(today), branchId: z.string().uuid().optional() }).parse(req.query)
    if (q.from > q.to || Date.parse(q.to) - Date.parse(q.from) > 366 * 864e5) return void res.status(400).json({ error: 'Choose a valid date range of up to 12 months' })
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    const P = [u.business_id, q.from, q.to, ids]
    const S = `s.business_id=$1 AND s.branch_id=ANY($4::uuid[]) AND ${win('s.created_at', 2, 3)}`
    const R = `r.business_id=$1 AND r.branch_id=ANY($4::uuid[]) AND ${win('r.created_at', 2, 3)}`
    const [sales, cogs, refunds, exp, expCat, payIn, payOut, daySales, dayCogs, dayRef, top, slow, cashier, cat, low, value] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n, coalesce(sum(s.total),0) AS gross, coalesce(sum(s.discount),0) AS discounts FROM sales s WHERE ${S}`, P),
      pool.query(`SELECT coalesce(sum(si.qty*si.unit_cost),0) AS cogs FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${S}`, P),
      pool.query(`SELECT count(*)::int AS n, coalesce(sum(r.amount),0) AS amount, coalesce(sum(r.qty*si.unit_cost),0) AS cogs FROM sale_refunds r JOIN sale_items si ON si.id=r.sale_item_id WHERE ${R}`, P),
      pool.query(`SELECT coalesce(sum(amount),0) AS total FROM expenses WHERE business_id=$1 AND branch_id=ANY($4::uuid[]) AND spent_on BETWEEN $2::date AND $3::date`, P),
      pool.query(`SELECT category AS label, sum(amount) AS n FROM expenses WHERE business_id=$1 AND branch_id=ANY($4::uuid[]) AND spent_on BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, P),
      pool.query(`SELECT sp.method AS label, sum(sp.amount) AS n FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE ${S} GROUP BY 1`, P),
      pool.query(`SELECT r.method AS label, sum(r.amount) AS n FROM sale_refunds r WHERE ${R} GROUP BY 1`, P),
      pool.query(`SELECT ${dayKey('s.created_at')} AS d, sum(s.total) AS v FROM sales s WHERE ${S} GROUP BY 1`, P),
      pool.query(`SELECT ${dayKey('s.created_at')} AS d, sum(si.qty*si.unit_cost) AS v FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${S} GROUP BY 1`, P),
      pool.query(`SELECT ${dayKey('r.created_at')} AS d, sum(r.amount) AS v, sum(r.qty*si.unit_cost) AS c FROM sale_refunds r JOIN sale_items si ON si.id=r.sale_item_id WHERE ${R} GROUP BY 1`, P),
      pool.query(`SELECT si.product_id, min(si.name) AS name, sum(si.qty-si.refunded_qty) AS qty,
        sum((si.qty-si.refunded_qty)*si.unit_price*s.total/NULLIF(s.subtotal,0)) AS revenue,
        sum((si.qty-si.refunded_qty)*(si.unit_price*s.total/NULLIF(s.subtotal,0)-si.unit_cost)) AS margin
        FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${S} GROUP BY si.product_id HAVING sum(si.qty-si.refunded_qty)>0 ORDER BY revenue DESC LIMIT 10`, P),
      pool.query(`SELECT p.id,p.name,sum(sb.qty) AS qty,sum(sb.qty*p.cost) AS value FROM products p JOIN stock_balances sb ON sb.product_id=p.id
        WHERE p.business_id=$1 AND p.active AND sb.branch_id=ANY($4::uuid[]) AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND ${S})
        GROUP BY p.id HAVING sum(sb.qty)>0 ORDER BY sum(sb.qty*p.cost) DESC LIMIT 10`, P),
      pool.query(`SELECT u.name AS label, count(*)::int AS count, sum(s.total) AS n FROM sales s JOIN users u ON u.id=s.cashier_id WHERE ${S} GROUP BY u.name ORDER BY 3 DESC`, P),
      pool.query(`SELECT coalesce(c.name,'Uncategorised') AS label, sum((si.qty-si.refunded_qty)*si.unit_price*s.total/NULLIF(s.subtotal,0)) AS n
        FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE ${S} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, P),
      pool.query(`SELECT p.id,p.sku,p.name,b.name AS branch,sb.qty,p.reorder_level FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN branches b ON b.id=sb.branch_id
        WHERE p.business_id=$1 AND sb.branch_id=ANY($2::uuid[]) AND p.active AND p.reorder_level>0 AND sb.qty<=p.reorder_level ORDER BY sb.qty,p.name LIMIT 50`, [u.business_id, ids]),
      pool.query(`SELECT coalesce(sum(sb.qty*p.cost),0) AS v FROM stock_balances sb JOIN products p ON p.id=sb.product_id WHERE p.business_id=$1 AND sb.branch_id=ANY($2::uuid[])`, [u.business_id, ids]),
    ])
    const [vatOut, vatRef, creditSales, recv, pay] = await Promise.all([
      pool.query(`SELECT coalesce(sum(s.tax_total),0) AS v FROM sales s WHERE ${S}`, P), pool.query(`SELECT coalesce(sum(r.tax),0) AS v FROM sale_refunds r WHERE ${R}`, P),
      pool.query(`SELECT coalesce(sum(sp.amount),0) AS v FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE sp.method='credit' AND ${S}`, P),
      pool.query('SELECT coalesce(sum(amount),0) AS v FROM customer_ledger WHERE business_id=$1', [u.business_id]),
      pool.query(`SELECT coalesce(sum(i.amount - coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id=i.id),0)),0) AS v FROM supplier_invoices i WHERE i.business_id=$1`, [u.business_id])])
    const gross = sales.rows[0].gross as number, refAmt = refunds.rows[0].amount as number
    const net = money(gross - refAmt), netCogs = money((cogs.rows[0].cogs as number) - (refunds.rows[0].cogs as number)), margin = money(net - netCogs), expenses = exp.rows[0].total as number
    const methods: Record<string, number> = {}
    for (const r of payIn.rows) methods[r.label] = (methods[r.label] ?? 0) + r.n
    for (const r of payOut.rows) methods[r.label] = (methods[r.label] ?? 0) - r.n
    const days = new Map<string, { date: string; sales: number; margin: number }>()
    const day = (d: string) => days.get(d) ?? days.set(d, { date: d, sales: 0, margin: 0 }).get(d)!
    for (const r of daySales.rows) { day(r.d).sales += r.v; day(r.d).margin += r.v }
    for (const r of dayCogs.rows) day(r.d).margin -= r.v
    for (const r of dayRef.rows) { day(r.d).sales -= r.v; day(r.d).margin -= r.v - r.c }
    const series: { date: string; sales: number; margin: number }[] = []
    for (let t = Date.parse(q.from); t <= Date.parse(q.to); t += 864e5) { const k = new Date(t).toISOString().slice(0, 10); const d = days.get(k); series.push({ date: k, sales: money(d?.sales ?? 0), margin: money(d?.margin ?? 0) }) }
    const topRows = top.rows.map(r => ({ ...r, revenue: money(r.revenue), margin: money(r.margin) }))
    const insights: string[] = []
    if (topRows[0]) insights.push(`${topRows[0].name} brought in the most revenue (${topRows[0].revenue.toLocaleString('en-KE')}).`)
    if (slow.rows.length) insights.push(`${slow.rows.length} stocked product(s) had no sales in this period, holding about ${money(slow.rows.reduce((a, r) => a + r.value, 0)).toLocaleString('en-KE')} of stock at cost.`)
    if (low.rows.length) insights.push(`${low.rows.length} product(s) are at or below their reorder level.`)
    if (net > 0 && expenses / net > 0.5) insights.push(`Expenses are ${pct(expenses, net)}% of net sales in this period.`)
    res.json({ from: q.from, to: q.to,
      summary: { transactions: sales.rows[0].n, gross_sales: gross, discounts: sales.rows[0].discounts, refunds: refAmt, refund_count: refunds.rows[0].n, net_sales: net, cost_of_goods: netCogs, gross_margin: margin,
        margin_pct: pct(margin, net), expenses, estimated_profit: money(margin - expenses), avg_basket: sales.rows[0].n ? money(gross / sales.rows[0].n) : 0, stock_value: value.rows[0].v,
        vat_collected: money((vatOut.rows[0].v as number) - (vatRef.rows[0].v as number)), credit_sales: creditSales.rows[0].v, receivables: recv.rows[0].v, payables: pay.rows[0].v },
      byMethod: Object.entries(methods).map(([label, n]) => ({ label, n: money(n) })), series, topProducts: topRows, slowMovers: slow.rows, byCashier: cashier.rows, byCategory: cat.rows.map(r => ({ ...r, n: money(r.n) })),
      expensesByCategory: expCat.rows, lowStock: low.rows, insights })
  })
}
