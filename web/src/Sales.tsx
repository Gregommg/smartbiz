import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from './api'
import { Bars, Err, Field, day, kes, num, today, when } from './ui'
import { Receipt, ReceiptActions, type Sale } from './Pos'
import type { Me } from './App'

export function SalesPage({ me, branchId }: { me: Me; branchId: string }) {
  type Row = { id: string; number: number; total: number; offline: boolean; created_at: string; branch: string; cashier: string; customer: string | null; has_refund: boolean; etims_status: string | null }
  const priv = me.role !== 'cashier'
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today()); const [rows, setRows] = useState<Row[]>([]); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [open, setOpen] = useState<Sale | null>(null); const [rf, setRf] = useState<Record<string, string>>({}); const [reason, setReason] = useState(''); const [method, setMethod] = useState('cash')
  const load = useCallback(() => { api<Row[]>(`/sales?from=${from}&to=${to}&branchId=${branchId}`).then(setRows).catch(e => setErr(errMsg(e))) }, [from, to, branchId])
  useEffect(load, [load])
  const show = async (id: string) => { setErr(''); setOk(''); setRf({}); setReason(''); try { setOpen(await api<Sale>(`/sales/${id}`)) } catch (x) { setErr(errMsg(x)) } }
  async function refund(e: FormEvent) {
    e.preventDefault(); setErr('')
    const items = Object.entries(rf).filter(([, v]) => Number(v) > 0).map(([saleItemId, v]) => ({ saleItemId, qty: Number(v) }))
    if (!items.length) return setErr('Enter the quantity to refund')
    try { const r = await api<{ refunded: number }>(`/sales/${open!.id}/refund`, { body: { reason, method, items } }); setOk(`Refunded ${kes(r.refunded)}. The items were returned to stock.`); await show(open!.id); load() } catch (x) { setErr(errMsg(x)) }
  }
  const sum = rows.reduce((a, r) => a + r.total, 0)
  return (<>
    <div className="row"><label>From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label></div>
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    <div className="wrap"><table className="cards"><thead><tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Customer</th><th className="right">Total</th><th></th></tr></thead><tbody>
      {rows.length === 0 && <tr><td colSpan={6} className="mute">No sales in this period.</td></tr>}
      {rows.map(r => <tr key={r.id}><td data-label="Receipt">#{String(r.number).padStart(6, '0')}{r.has_refund && <span className="tag">refund</span>}{r.offline && <span className="tag">offline</span>}{r.etims_status && r.etims_status !== 'sent' && <span className="tag">eTIMS {r.etims_status.replace('_', ' ')}</span>}</td><td data-label="Time">{when(r.created_at)}</td><td data-label="Cashier">{r.cashier}</td><td data-label="Customer">{r.customer ?? 'Walk-in'}</td><td data-label="Total" className="right">{kes(r.total)}</td><td data-label=""><button className="btn alt" onClick={() => show(r.id)}>Open</button></td></tr>)}</tbody></table></div>
    {rows.length > 0 && <p><b>{rows.length} sales · {kes(sum)}</b> (before refunds)</p>}
    {open && <div className="scrim" onClick={() => setOpen(null)}><div className="sheet" onClick={e => e.stopPropagation()}><Receipt s={open} /><ReceiptActions s={open} onClose={() => setOpen(null)} />
      {priv && <div className="card"><h2>Refund items</h2><form onSubmit={refund}>
        {open.items.map(i => <div className="row" key={i.id} style={{ alignItems: 'end' }}><div>{i.name}<br /><small>{num(i.qty - i.refunded_qty)} refundable</small></div>
          {i.qty - i.refunded_qty > 0 && <label>Qty<input type="number" min={0} step="any" max={i.qty - i.refunded_qty} value={rf[i.id] ?? ''} onChange={e => setRf({ ...rf, [i.id]: e.target.value })} /></label>}</div>)}
        <Field label="Reason" value={reason} set={setReason} /><label>Refund paid by<select value={method} onChange={e => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank">Bank</option>{open.customer_id && <option value="credit">Credit to customer's account</option>}</select></label>
        <Err e={err} /><button className="btn">Refund and return to stock</button></form></div>}
    </div></div>}
  </>)
}

export function ExpensesPage({ branchId }: { me: Me; branchId: string }) {
  type Row = { id: string; category: string; amount: number; method: string; note: string | null; spent_on: string; branch: string; by: string | null }
  const [from, setFrom] = useState(today().slice(0, 8) + '01'); const [to, setTo] = useState(today()); const [rows, setRows] = useState<Row[]>([]); const [err, setErr] = useState('')
  const [f, setF] = useState({ category: '', amount: '', method: 'cash', note: '', spentOn: today() })
  const load = useCallback(() => { api<Row[]>(`/expenses?from=${from}&to=${to}&branchId=${branchId}`).then(setRows).catch(e => setErr(errMsg(e))) }, [from, to, branchId])
  useEffect(load, [load])
  async function add(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/expenses', { body: { branchId, category: f.category, amount: Number(f.amount), method: f.method, note: f.note || undefined, spentOn: f.spentOn } }); setF({ ...f, category: '', amount: '', note: '' }); load() } catch (x) { setErr(errMsg(x)) } }
  const byCat: Record<string, number> = {}; rows.forEach(r => { byCat[r.category] = (byCat[r.category] ?? 0) + r.amount })
  return (<>
    <div className="card"><h2>Record an expense</h2><form onSubmit={add}><div className="row"><Field label="Category" value={f.category} set={v => setF({ ...f, category: v })} placeholder="Rent, transport, electricity…" /><Field label="Amount (KSh)" type="number" value={f.amount} set={v => setF({ ...f, amount: v })} /></div>
      <div className="row"><label>Paid by<select value={f.method} onChange={e => setF({ ...f, method: e.target.value })}><option value="cash">Cash (from the till)</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="card">Card</option></select></label>
        <label>Date<input type="date" value={f.spentOn} onChange={e => setF({ ...f, spentOn: e.target.value })} required /></label></div><Field label="Note (optional)" required={false} value={f.note} set={v => setF({ ...f, note: v })} /><Err e={err} /><button className="btn">Save expense</button></form></div>
    <div className="row"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>
    <div className="card"><h2>Total: {kes(rows.reduce((a, r) => a + r.amount, 0))}</h2><Bars rows={Object.entries(byCat).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)} fmt={kes} /></div>
    <div className="wrap"><table className="cards"><thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Paid by</th><th className="right">Amount</th></tr></thead><tbody>
      {rows.length === 0 && <tr><td colSpan={5} className="mute">No expenses in this period.</td></tr>}
      {rows.map(r => <tr key={r.id}><td data-label="Date">{day(r.spent_on)}</td><td data-label="Category">{r.category}</td><td data-label="Note">{r.note ?? '—'}</td><td data-label="Paid by">{r.method}</td><td data-label="Amount" className="right">{kes(r.amount)}</td></tr>)}</tbody></table></div>
  </>)
}

export function CustomersPage({ me, branchId }: { me: Me; branchId: string }) {
  type Row = { id: string; name: string; phone: string | null; credit_limit: number; balance: number }
  type St = { customer: Row; opening: number; balance: number; rows: { id: number; type: string; amount: number; method: string | null; reference: string | null; note: string | null; created_at: string; receipt: number | null; balance: number }[] }
  const mgr = me.role === 'owner' || me.role === 'manager'
  const [rows, setRows] = useState<Row[]>([]); const [q, setQ] = useState(''); const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [f, setF] = useState({ name: '', phone: '' })
  const [st, setSt] = useState<St | null>(null); const [pay, setPay] = useState<Row | null>(null); const [pf, setPf] = useState({ amount: '', method: 'cash', reference: '' }); const [lim, setLim] = useState<Record<string, string>>({}); const [wo, setWo] = useState<Row | null>(null); const [wf, setWf] = useState({ amount: '', note: '' })
  const load = useCallback(() => { api<Row[]>(`/customers?q=${encodeURIComponent(q)}`).then(setRows).catch(e => setErr(errMsg(e))) }, [q])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])
  const act = async (fn: () => Promise<unknown>, msg: string) => { setErr(''); setOk(''); try { await fn(); setOk(msg); load() } catch (x) { setErr(errMsg(x)) } }
  const owed = rows.reduce((a, r) => a + Math.max(0, r.balance), 0)
  return (<>
    {me.role !== 'storekeeper' && <div className="card"><h2>Add a customer</h2><form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/customers', { body: { name: f.name, phone: f.phone || undefined } }); setF({ name: '', phone: '' }) }, 'Customer added.') }}>
      <div className="row"><Field label="Name" value={f.name} set={v => setF({ ...f, name: v })} /><Field label="Phone (optional)" required={false} value={f.phone} set={v => setF({ ...f, phone: v })} /></div><button className="btn">Add customer</button></form></div>}
    {ok && <p role="status">{ok}</p>}<Err e={err} /><label>Search<input value={q} onChange={e => setQ(e.target.value)} placeholder="Name or phone" /></label>
    {owed > 0 && <p><b>Customers owe you {kes(owed)}</b></p>}
    <div className="wrap"><table className="cards"><thead><tr><th>Name</th><th>Phone</th><th className="right">Owes</th><th className="right">Credit limit</th><th></th></tr></thead><tbody>{rows.length === 0 && <tr><td colSpan={5} className="mute">No customers yet.</td></tr>}
      {rows.map(r => <tr key={r.id}><td data-label="Name">{r.name}</td><td data-label="Phone">{r.phone ?? '—'}</td><td data-label="Owes" className={'right' + (r.balance > 0 ? ' low' : '')}>{kes(r.balance)}</td>
        <td data-label="Credit limit" className="right">{mgr ? <input style={{ width: 110 }} aria-label={`Credit limit for ${r.name}`} type="number" min={0} value={lim[r.id] ?? String(r.credit_limit)} onChange={e => setLim({ ...lim, [r.id]: e.target.value })} onBlur={() => lim[r.id] !== undefined && Number(lim[r.id]) !== r.credit_limit && act(() => api(`/customers/${r.id}`, { method: 'PATCH', body: { creditLimit: Number(lim[r.id]) } }), 'Credit limit saved.')} /> : kes(r.credit_limit)}</td>
        <td data-label=""><div className="acts"><button className="btn alt" onClick={async () => { try { setSt(await api<St>(`/customers/${r.id}/statement`)) } catch (x) { setErr(errMsg(x)) } }}>Statement</button>
          {r.balance > 0 && <button className="btn alt" onClick={() => { setPay(r); setPf({ amount: String(r.balance), method: 'cash', reference: '' }) }}>Receive payment</button>}
          {me.role === 'owner' && r.balance !== 0 && <button className="btn alt" onClick={() => { setWo(r); setWf({ amount: String(-r.balance), note: '' }) }}>Write off</button>}</div></td></tr>)}</tbody></table></div>
    {pay && <div className="scrim" onClick={() => setPay(null)}><div className="sheet" onClick={e => e.stopPropagation()}><h2>Payment from {pay.name}</h2><p className="mute">Owes {kes(pay.balance)}</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api(`/customers/${pay.id}/payments`, { body: { branchId, amount: Number(pf.amount), method: pf.method, reference: pf.reference || undefined } }); setPay(null) }, 'Payment recorded.') }}>
        <Field label="Amount (KSh)" type="number" value={pf.amount} set={v => setPf({ ...pf, amount: v })} /><label>Paid by<select value={pf.method} onChange={e => setPf({ ...pf, method: e.target.value })}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank">Bank</option></select></label>
        {pf.method === 'mpesa' && <Field label="M-Pesa transaction code" value={pf.reference} set={v => setPf({ ...pf, reference: v.toUpperCase() })} />}<Err e={err} /><button className="btn">Record payment</button> <button type="button" className="btn alt" onClick={() => setPay(null)}>Cancel</button></form></div></div>}
    {wo && <div className="scrim" onClick={() => setWo(null)}><div className="sheet" onClick={e => e.stopPropagation()}><h2>Write off or correct {wo.name}</h2><p className="mute">Use a minus amount to reduce what they owe. A reason is required and is kept in the audit log.</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api(`/customers/${wo.id}/adjustments`, { body: { amount: Number(wf.amount), note: wf.note } }); setWo(null) }, 'Account adjusted.') }}>
        <Field label="Amount (KSh)" type="number" value={wf.amount} set={v => setWf({ ...wf, amount: v })} /><Field label="Reason" value={wf.note} set={v => setWf({ ...wf, note: v })} /><Err e={err} /><button className="btn">Save</button> <button type="button" className="btn alt" onClick={() => setWo(null)}>Cancel</button></form></div></div>}
    {st && <div className="scrim" onClick={() => setSt(null)}><div className="sheet" style={{ maxWidth: 760 }} onClick={e => e.stopPropagation()}><h2>Statement: {st.customer.name}</h2>
      <div className="wrap"><table><thead><tr><th>Date</th><th>What</th><th className="right">Amount</th><th className="right">Balance</th></tr></thead><tbody>
        {st.rows.length === 0 && <tr><td colSpan={4} className="mute">No activity yet.</td></tr>}
        {st.rows.map(r => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.type === 'sale' ? `Sale #${String(r.receipt).padStart(6, '0')}` : r.type === 'payment' ? `Payment (${r.method}${r.reference ? ' ' + r.reference : ''})` : r.type === 'refund' ? 'Refund to account' : `Adjustment: ${r.note}`}</td><td className="right">{kes(r.amount)}</td><td className="right">{kes(r.balance)}</td></tr>)}</tbody></table></div>
      <p><b>Owes now: {kes(st.balance)}</b></p><button className="btn" onClick={() => window.print()}>Print</button> <button className="btn alt" onClick={() => setSt(null)}>Close</button></div></div>}
  </>)
}
