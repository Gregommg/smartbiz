import { useEffect, useState } from 'react'
import { api, apiBlob, errMsg } from './api'
import { Bars, Err, LineChart, daysAgo, kes, num, today } from './ui'
import type { Me } from './App'

type L = { label: string; n: number }
type R = { from: string; to: string
  summary: { transactions: number; gross_sales: number; discounts: number; refunds: number; refund_count: number; net_sales: number; cost_of_goods: number; gross_margin: number; margin_pct: number | null; expenses: number; estimated_profit: number; avg_basket: number; stock_value: number; vat_collected: number; credit_sales: number; receivables: number; payables: number }
  byMethod: L[]; series: { date: string; sales: number; margin: number }[]; topProducts: { product_id: string; name: string; qty: number; revenue: number; margin: number }[]
  slowMovers: { id: string; name: string; qty: number; value: number }[]; byCashier: { label: string; count: number; n: number }[]; byCategory: L[]; expensesByCategory: L[]
  lowStock: { id: string; sku: string; name: string; branch: string; qty: number; reorder_level: number }[]; insights: string[] }

export function ReportsPage({ me }: { me: Me }) {
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today()); const [branch, setBranch] = useState(''); const [r, setR] = useState<R | null>(null); const [err, setErr] = useState('')
  useEffect(() => { setR(null); setErr(''); api<R>(`/reports/summary?from=${from}&to=${to}${branch ? `&branchId=${branch}` : ''}`).then(setR).catch(e => setErr(errMsg(e))) }, [from, to, branch])
  const preset = (a: string, b: string) => { setFrom(a); setTo(b) }
  const s = r?.summary
  return (<>
    <div className="tabs"><button onClick={() => preset(today(), today())}>Today</button><button onClick={() => preset(daysAgo(6), today())}>Last 7 days</button><button onClick={() => preset(today().slice(0, 8) + '01', today())}>This month</button><button onClick={() => preset(daysAgo(29), today())}>Last 30 days</button><button onClick={() => window.print()}>Print</button></div>
    <div className="row"><label>From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      {me.branches.length > 1 && <label>Branch<select value={branch} onChange={e => setBranch(e.target.value)}><option value="">All my branches</option>{me.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}</div>
    <Err e={err} />{!r && !err && <p>Loading…</p>}
    {r && s && <>
      <div className="stats"><div className="stat"><b>{kes(s.net_sales)}</b>net sales</div><div className="stat"><b>{kes(s.gross_margin)}</b>gross margin{s.margin_pct !== null ? ` (${s.margin_pct}%)` : ''}</div><div className="stat"><b>{kes(s.expenses)}</b>expenses</div>
        <div className="stat"><b className={s.estimated_profit < 0 ? 'low' : ''}>{kes(s.estimated_profit)}</b>estimated profit</div><div className="stat"><b>{s.transactions}</b>sales</div><div className="stat"><b>{kes(s.avg_basket)}</b>average sale</div>
        <div className="stat"><b>{kes(s.refunds)}</b>refunded ({s.refund_count})</div><div className="stat"><b>{kes(s.stock_value)}</b>stock value at cost</div>
        <div className="stat"><b>{kes(s.vat_collected)}</b>VAT collected</div><div className="stat"><b>{kes(s.credit_sales)}</b>sold on account</div><div className="stat"><b>{kes(s.receivables)}</b>customers owe you</div><div className="stat"><b>{kes(s.payables)}</b>you owe suppliers</div></div>
      <p className="mute">Net sales = sales minus refunds. Gross margin = net sales minus the cost of the goods sold. Estimated profit = gross margin minus expenses. These are management figures, not audited accounts or tax figures. VAT collected is for information only: confirm figures with your accountant before filing.</p>
      {r.insights.length > 0 && <div className="card"><h2>Things worth a look</h2><ul>{r.insights.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      <div className="card"><h2>Net sales and gross margin per day</h2><LineChart data={r.series} /><p className="legend mute"><span style={{ color: '#6c00ff' }}>━ Net sales</span><span style={{ color: '#12a150' }}>╍ Gross margin</span></p></div>
      <div className="grid2"><div className="card"><h2>How customers paid (net of refunds)</h2><Bars rows={r.byMethod} fmt={kes} /></div><div className="card"><h2>Sales by category</h2><Bars rows={r.byCategory} fmt={kes} /></div>
        <div className="card"><h2>Sales by cashier</h2><Bars rows={r.byCashier.map(c => ({ label: `${c.label} (${c.count})`, n: c.n }))} fmt={kes} /></div><div className="card"><h2>Expenses by category</h2><Bars rows={r.expensesByCategory} fmt={kes} /></div></div>
      <h2>Best sellers</h2><div className="wrap"><table className="cards"><thead><tr><th>Product</th><th className="right">Sold</th><th className="right">Revenue</th><th className="right">Margin</th></tr></thead><tbody>
        {r.topProducts.length === 0 && <tr><td colSpan={4} className="mute">No sales in this period.</td></tr>}
        {r.topProducts.map(p => <tr key={p.product_id}><td data-label="Product">{p.name}</td><td data-label="Sold" className="right">{num(p.qty)}</td><td data-label="Revenue" className="right">{kes(p.revenue)}</td><td data-label="Margin" className="right">{kes(p.margin)}</td></tr>)}</tbody></table></div>
      <h2 style={{ marginTop: '1rem' }}>Low stock</h2><div className="wrap"><table className="cards"><thead><tr><th>Product</th><th>Branch</th><th className="right">In stock</th><th className="right">Reorder at</th></tr></thead><tbody>
        {r.lowStock.length === 0 && <tr><td colSpan={4} className="mute">Nothing is below its reorder level.</td></tr>}
        {r.lowStock.map(p => <tr key={p.id + p.branch}><td data-label="Product">{p.name}</td><td data-label="Branch">{p.branch}</td><td data-label="In stock" className="right low">{num(p.qty)}</td><td data-label="Reorder at" className="right">{num(p.reorder_level)}</td></tr>)}</tbody></table></div>
      <h2 style={{ marginTop: '1rem' }}>Not selling (stock but no sales in this period)</h2><div className="wrap"><table className="cards"><thead><tr><th>Product</th><th className="right">In stock</th><th className="right">Value at cost</th></tr></thead><tbody>
        {r.slowMovers.length === 0 && <tr><td colSpan={3} className="mute">Every stocked product sold at least once.</td></tr>}
        {r.slowMovers.map(p => <tr key={p.id}><td data-label="Product">{p.name}</td><td data-label="In stock" className="right">{num(p.qty)}</td><td data-label="Value at cost" className="right">{kes(p.value)}</td></tr>)}</tbody></table></div>
      <div className="card" style={{ marginTop: '1rem' }}><h2>Download for your accountant (CSV)</h2><p className="mute">For the dates and branch chosen above.</p>
        {(['sales', 'payments', 'expenses', 'purchases', 'stock', 'customers', 'suppliers', 'cashups'] as const).map(k => <button key={k} className="btn alt paybtn" onClick={async () => {
          setErr(''); try { const url = URL.createObjectURL(await apiBlob(`/exports/${k}?from=${from}&to=${to}${branch ? `&branchId=${branch}` : ''}`)); const a = document.createElement('a'); a.href = url; a.download = `smartbiz-${k}-${from}-${to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (x) { setErr(errMsg(x)) } }}>{{ sales: 'Sales (items)', payments: 'Payments', expenses: 'Expenses', purchases: 'Purchases', stock: 'Stock value', customers: 'Customer balances', suppliers: 'Supplier invoices', cashups: 'Cash-ups' }[k]}</button>)}</div>
    </>}
  </>)
}
