import { pool } from './db.js'
import { todayEAT } from './time.js'
import { appUrl, type Notifier } from './core.js'

/** One email a day (after 07:00 Nairobi time) to owners and managers: low stock, stock about to expire, overdue supplier invoices. Sent only when there is something to report. */
export async function sendDigests(notify: Notifier, opts: { force?: boolean } = {}) {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', hour12: false }))
  if (!opts.force && hour < 7) return 0
  const today = todayEAT(); let sent = 0
  const biz = (await pool.query(`SELECT b.id,b.name FROM businesses b WHERE b.period_end + interval '7 days' > now() AND NOT EXISTS (SELECT 1 FROM digest_log d WHERE d.business_id=b.id AND d.kind='daily' AND d.sent_on=$1::date)`, [today])).rows
  for (const b of biz) {
    await pool.query("INSERT INTO digest_log(business_id,kind,sent_on) VALUES($1,'daily',$2) ON CONFLICT DO NOTHING", [b.id, today])
    const low = (await pool.query(`SELECT p.name,br.name AS branch,sb.qty,p.reorder_level FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN branches br ON br.id=sb.branch_id
      WHERE p.business_id=$1 AND p.active AND br.active AND p.reorder_level>0 AND sb.qty<=p.reorder_level ORDER BY sb.qty LIMIT 15`, [b.id])).rows
    const exp = (await pool.query(`SELECT p.name,br.name AS branch,sb.batch_no,sb.expiry_date,sb.qty FROM stock_batches sb JOIN products p ON p.id=sb.product_id JOIN branches br ON br.id=sb.branch_id
      WHERE p.business_id=$1 AND sb.qty>0 AND sb.expiry_date IS NOT NULL AND sb.expiry_date <= $2::date + 30 ORDER BY sb.expiry_date LIMIT 15`, [b.id, today])).rows
    const overdue = (await pool.query(`SELECT count(*)::int AS n FROM supplier_invoices i WHERE i.business_id=$1 AND i.due_date < $2::date AND i.amount - coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id=i.id),0) > 0.004`, [b.id, today])).rows[0].n
    if (!low.length && !exp.length && !overdue) continue
    const to = (await pool.query("SELECT email FROM users WHERE business_id=$1 AND active AND role IN ('owner','manager') AND NOT is_platform", [b.id])).rows.map(r => r.email)
    const text = [`SmartBiz daily summary for ${b.name}`, '',
      low.length ? `LOW STOCK (${low.length}):\n` + low.map(r => `- ${r.name} at ${r.branch}: ${r.qty} left (reorder at ${r.reorder_level})`).join('\n') : '',
      exp.length ? `\nEXPIRED OR EXPIRING WITHIN 30 DAYS:\n` + exp.map(r => `- ${r.name} (batch ${r.batch_no}) at ${r.branch}: ${r.qty}, expires ${new Date(r.expiry_date).toISOString().slice(0, 10)}`).join('\n') : '',
      overdue ? `\nSUPPLIER INVOICES OVERDUE: ${overdue}` : '', '', appUrl()].filter(x => x !== '').join('\n')
    notify.send(to, `SmartBiz: ${low.length} low stock, ${exp.length} expiring, ${overdue} overdue`, text); sent++
  }
  return sent
}
