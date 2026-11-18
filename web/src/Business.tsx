import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from './api'
import { Err, Field, day, kes, today, when } from './ui'
import type { Me } from './App'

export function PayablesPage() {
  type Ov = { total: number; current: number; d1_30: number; d31_60: number; d61: number; suppliers: { id: string; name: string; owed: number; current: number; d1_30: number; d31_60: number; d61: number }[] }
  type Inv = { id: string; invoice_no: string; invoice_date: string; due_date: string; amount: number; supplier: string; outstanding: number; days_overdue: number }
  const [tab, setTab] = useState<'owed' | 'invoices' | 'add'>('owed'); const [ov, setOv] = useState<Ov | null>(null); const [inv, setInv] = useState<Inv[]>([]); const [status, setStatus] = useState('open')
  const [sups, setSups] = useState<{ id: string; name: string }[]>([]); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [f, setF] = useState({ supplierId: '', invoiceNo: '', invoiceDate: today(), dueDate: today(), amount: '', notes: '' }); const [pay, setPay] = useState<Inv | null>(null); const [pf, setPf] = useState({ amount: '', method: 'bank', reference: '', paidOn: today() })
  const load = useCallback(() => {
    api<Ov>('/payables').then(setOv).catch(e => setErr(errMsg(e))); api<Inv[]>(`/supplier-invoices?status=${status}`).then(setInv).catch(() => undefined); api<{ id: string; name: string }[]>('/suppliers').then(setSups).catch(() => undefined)
  }, [status])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, msg: string) => { setErr(''); setOk(''); try { await fn(); setOk(msg); load() } catch (x) { setErr(errMsg(x)) } }
  return (<>
    <div className="tabs"><button className={tab === 'owed' ? 'on' : ''} onClick={() => setTab('owed')}>What we owe</button><button className={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>Invoices</button><button className={tab === 'add' ? 'on' : ''} onClick={() => setTab('add')}>Add invoice</button></div>
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    {tab === 'owed' && ov && <><div className="stats"><div className="stat"><b>{kes(ov.total)}</b>owed to suppliers</div><div className="stat"><b>{kes(ov.current)}</b>not yet due</div><div className="stat"><b>{kes(ov.d1_30)}</b>1 to 30 days late</div><div className="stat"><b className={ov.d31_60 ? 'low' : ''}>{kes(ov.d31_60)}</b>31 to 60 days late</div><div className="stat"><b className={ov.d61 ? 'low' : ''}>{kes(ov.d61)}</b>over 60 days late</div></div>
      <div className="wrap"><table className="cards"><thead><tr><th>Supplier</th><th className="right">Owed</th><th className="right">Not due</th><th className="right">1-30</th><th className="right">31-60</th><th className="right">61+</th></tr></thead><tbody>
        {ov.suppliers.length === 0 && <tr><td colSpan={6} className="mute">You do not owe any supplier.</td></tr>}
        {ov.suppliers.map(s => <tr key={s.id}><td data-label="Supplier">{s.name}</td><td data-label="Owed" className="right">{kes(s.owed)}</td><td data-label="Not due" className="right">{kes(s.current)}</td><td data-label="1-30" className="right">{kes(s.d1_30)}</td><td data-label="31-60" className="right">{kes(s.d31_60)}</td><td data-label="61+" className="right">{kes(s.d61)}</td></tr>)}</tbody></table></div></>}
    {tab === 'invoices' && <><label>Show<select value={status} onChange={e => setStatus(e.target.value)}><option value="open">Unpaid</option><option value="paid">Paid</option><option value="all">All</option></select></label>
      <div className="wrap"><table className="cards"><thead><tr><th>Supplier</th><th>Invoice</th><th>Due</th><th className="right">Amount</th><th className="right">Still owed</th><th></th></tr></thead><tbody>
        {inv.length === 0 && <tr><td colSpan={6} className="mute">Nothing here.</td></tr>}
        {inv.map(i => <tr key={i.id}><td data-label="Supplier">{i.supplier}</td><td data-label="Invoice">{i.invoice_no}</td><td data-label="Due" className={i.days_overdue > 0 && i.outstanding > 0 ? 'low' : ''}>{day(i.due_date)}{i.days_overdue > 0 && i.outstanding > 0 ? ` (${i.days_overdue} days late)` : ''}</td><td data-label="Amount" className="right">{kes(i.amount)}</td><td data-label="Still owed" className="right">{kes(i.outstanding)}</td>
          <td data-label="">{i.outstanding > 0.004 && <button className="btn alt" onClick={() => { setPay(i); setPf({ amount: String(i.outstanding), method: 'bank', reference: '', paidOn: today() }) }}>Record payment</button>}</td></tr>)}</tbody></table></div></>}
    {tab === 'add' && <div className="card"><h2>Add a supplier invoice</h2><form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/supplier-invoices', { body: { supplierId: f.supplierId, invoiceNo: f.invoiceNo, invoiceDate: f.invoiceDate, dueDate: f.dueDate, amount: Number(f.amount), notes: f.notes || undefined } }); setF({ ...f, invoiceNo: '', amount: '', notes: '' }); setTab('invoices') }, 'Invoice added.') }}>
      <label>Supplier<select value={f.supplierId} onChange={e => setF({ ...f, supplierId: e.target.value })} required><option value="">Choose…</option>{sups.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <div className="row"><Field label="Invoice number" value={f.invoiceNo} set={v => setF({ ...f, invoiceNo: v })} /><Field label="Amount (KSh)" type="number" value={f.amount} set={v => setF({ ...f, amount: v })} /></div>
      <div className="row"><label>Invoice date<input type="date" value={f.invoiceDate} onChange={e => setF({ ...f, invoiceDate: e.target.value })} required /></label><label>Payment due<input type="date" value={f.dueDate} onChange={e => setF({ ...f, dueDate: e.target.value })} required /></label></div>
      <Field label="Notes (optional)" required={false} value={f.notes} set={v => setF({ ...f, notes: v })} /><button className="btn">Save invoice</button></form></div>}
    {pay && <div className="scrim" onClick={() => setPay(null)}><div className="sheet" onClick={e => e.stopPropagation()}><h2>Pay {pay.supplier}, invoice {pay.invoice_no}</h2><p className="mute">Still owed {kes(pay.outstanding)}</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api(`/supplier-invoices/${pay.id}/payments`, { body: { amount: Number(pf.amount), method: pf.method, reference: pf.reference || undefined, paidOn: pf.paidOn } }); setPay(null) }, 'Payment recorded.') }}>
        <Field label="Amount (KSh)" type="number" value={pf.amount} set={v => setPf({ ...pf, amount: v })} /><label>Paid by<select value={pf.method} onChange={e => setPf({ ...pf, method: e.target.value })}><option value="bank">Bank</option><option value="mpesa">M-Pesa</option><option value="cash">Cash</option><option value="card">Card</option></select></label>
        <Field label="Reference (optional)" required={false} value={pf.reference} set={v => setPf({ ...pf, reference: v })} /><label>Date paid<input type="date" value={pf.paidOn} onChange={e => setPf({ ...pf, paidOn: e.target.value })} required /></label><Err e={err} /><button className="btn">Save</button> <button type="button" className="btn alt" onClick={() => setPay(null)}>Cancel</button></form></div></div>}
  </>)
}

export function CashUpPage({ me, branchId }: { me: Me; branchId: string }) {
  type Cur = { id: string; opened_at: string; opening_float: number; sales: number; refunds: number; received: number; expenses: number; expected: number }
  type Hist = { id: string; opened_at: string; closed_at: string | null; opening_float: number; counted_cash: number | null; expected_cash: number | null; variance: number | null; note: string | null; cashier: string; branch: string }
  type Res = { expected: number; counted: number; variance: number }
  const mgr = me.role !== 'cashier'
  const [cur, setCur] = useState<Cur | null>(null); const [hist, setHist] = useState<Hist[]>([]); const [err, setErr] = useState(''); const [fl, setFl] = useState('0'); const [counted, setCounted] = useState(''); const [note, setNote] = useState(''); const [res, setRes] = useState<Res | null>(null)
  const load = useCallback(() => {
    if (!branchId) return
    api<Cur | null>(`/cash-sessions/current?branchId=${branchId}`).then(setCur).catch(e => setErr(errMsg(e)))
    if (mgr) api<Hist[]>(`/cash-sessions?branchId=${branchId}`).then(setHist).catch(() => undefined)
  }, [branchId, mgr])
  useEffect(load, [load])
  const act = async (fn: () => Promise<void>) => { setErr(''); try { await fn(); load() } catch (x) { setErr(errMsg(x)) } }
  return (<>
    <Err e={err} />
    {res && <div className="card"><h2>Session closed</h2><p>Expected in drawer: <b>{kes(res.expected)}</b> · Counted: <b>{kes(res.counted)}</b></p><p className={res.variance === 0 ? 'ok' : 'low'}>{res.variance === 0 ? 'The cash balances.' : res.variance < 0 ? `Short by ${kes(-res.variance)}` : `Over by ${kes(res.variance)}`}</p><button className="btn alt" onClick={() => setRes(null)}>OK</button></div>}
    {!cur && <div className="card"><h2>Open your till</h2><p className="mute">Count the cash in the drawer before you start. SmartBiz then works out how much should be there when you close.</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/cash-sessions/open', { body: { branchId, openingFloat: Number(fl) } }) }) }}><Field label="Opening cash (KSh)" type="number" value={fl} set={setFl} /><button className="btn">Open till</button></form></div>}
    {cur && <div className="card"><h2>Your till is open</h2><p className="mute">Since {when(cur.opened_at)}</p>
      <div className="stats"><div className="stat"><b>{kes(cur.opening_float)}</b>opening cash</div><div className="stat"><b>{kes(cur.sales)}</b>cash sales</div><div className="stat"><b>{kes(cur.received)}</b>customer payments in cash</div><div className="stat"><b>{kes(cur.refunds)}</b>cash refunds</div><div className="stat"><b>{kes(cur.expenses)}</b>cash expenses</div><div className="stat"><b>{kes(cur.expected)}</b>should be in drawer</div></div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { setRes(await api<Res>(`/cash-sessions/${cur.id}/close`, { body: { countedCash: Number(counted), note: note || undefined } })); setCounted(''); setNote('') }) }}>
        <Field label="Cash you counted (KSh)" type="number" value={counted} set={setCounted} /><Field label="Note (optional)" required={false} value={note} set={setNote} /><button className="btn">Close till</button></form></div>}
    {mgr && <><h2>Till sessions this month</h2><div className="wrap"><table className="cards"><thead><tr><th>Opened</th><th>Cashier</th><th className="right">Expected</th><th className="right">Counted</th><th className="right">Difference</th><th>Note</th></tr></thead><tbody>
      {hist.length === 0 && <tr><td colSpan={6} className="mute">No sessions yet.</td></tr>}
      {hist.map(h => <tr key={h.id}><td data-label="Opened">{when(h.opened_at)}</td><td data-label="Cashier">{h.cashier}</td><td data-label="Expected" className="right">{h.expected_cash == null ? 'open' : kes(h.expected_cash)}</td><td data-label="Counted" className="right">{h.counted_cash == null ? '—' : kes(h.counted_cash)}</td><td data-label="Difference" className={'right' + (h.variance ? ' low' : '')}>{h.variance == null ? '—' : kes(h.variance)}</td><td data-label="Note">{h.note ?? '—'}</td></tr>)}</tbody></table></div></>}
  </>)
}

export function SettingsPage() {
  type S = { legalName: string; kraPin: string; address: string; phone: string; receiptFooter: string; vatRegistered: boolean; etimsEnabled: boolean; requireCashSession: boolean; smsReceipts: boolean }
  type Tax = { id: string; code: string; name: string; rate: number }
  type Mp = { configured: boolean; env?: string; shortcode?: string; partyB?: string; txType?: string; enabled?: boolean }
  type Et = { counts: Record<string, number>; pending: { id: string; status: string; attempts: number; last_error: string | null; number: number }[]; connected: boolean }
  const [s, setS] = useState<S | null>(null); const [tax, setTax] = useState<Tax[]>([]); const [mp, setMp] = useState<Mp>({ configured: false }); const [sms, setSms] = useState(false); const [et, setEt] = useState<Et | null>(null)
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [nt, setNt] = useState({ code: '', name: '', rate: '' })
  const [mf, setMf] = useState({ env: 'sandbox', shortcode: '', partyB: '', txType: 'CustomerPayBillOnline', enabled: true, consumerKey: '', consumerSecret: '', passkey: '' })
  const load = useCallback(() => {
    api<{ settings: S; mpesa: Mp; smsAvailable: boolean }>('/settings').then(r => { setS(r.settings); setMp(r.mpesa); setSms(r.smsAvailable); if (r.mpesa.configured) setMf(m => ({ ...m, env: r.mpesa.env!, shortcode: r.mpesa.shortcode!, partyB: r.mpesa.partyB!, txType: r.mpesa.txType!, enabled: !!r.mpesa.enabled })) }).catch(e => setErr(errMsg(e)))
    api<Tax[]>('/tax-classes').then(setTax).catch(() => undefined); api<Et>('/etims').then(setEt).catch(() => undefined)
  }, [])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, msg: string) => { setErr(''); setOk(''); try { await fn(); setOk(msg); load() } catch (x) { setErr(errMsg(x)) } }
  if (!s) return <>{err ? <Err e={err} /> : <p>Loading…</p>}</>
  const up = (k: keyof S) => (v: string) => setS({ ...s, [k]: v })
  const tog = (k: 'vatRegistered' | 'etimsEnabled' | 'requireCashSession' | 'smsReceipts', label: string, hint = '') => <label><input type="checkbox" checked={s[k]} onChange={e => setS({ ...s, [k]: e.target.checked })} /> {label}{hint && <small className="mute"> {hint}</small>}</label>
  return (<>
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    <div className="card"><h2>Business details and receipts</h2><form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api('/settings', { method: 'PUT', body: s }), 'Settings saved.') }}>
      <div className="row"><Field label="Legal business name (printed on receipts)" required={false} value={s.legalName} set={up('legalName')} /><Field label="KRA PIN" required={false} value={s.kraPin} set={up('kraPin')} placeholder="A123456789Z" /></div>
      <div className="row"><Field label="Address" required={false} value={s.address} set={up('address')} /><Field label="Phone" required={false} value={s.phone} set={up('phone')} /></div><Field label="Receipt footer" required={false} value={s.receiptFooter} set={up('receiptFooter')} />
      {tog('vatRegistered', 'We are VAT registered', '(prices include VAT; receipts show the VAT part)')}{tog('requireCashSession', 'Cashiers must open their till before selling', '(see Cash-up)')}
      {tog('smsReceipts', 'Allow sending receipts by SMS', sms ? '' : '(SMS is not set up on this server yet)')}{tog('etimsEnabled', 'Queue invoices for KRA eTIMS', '(see the warning below)')}
      <button className="btn">Save</button></form></div>
    <div className="card"><h2>VAT and tax classes</h2><p className="mute">These starting rates are NOT verified for your business. Check them with KRA or a tax adviser and correct them. Each product is given a tax class under Products.</p>
      {tax.map(t => <div className="row" key={t.id} style={{ alignItems: 'end' }}><b>{t.code}</b><label>Name<input defaultValue={t.name} onBlur={e => e.target.value !== t.name && act(() => api(`/tax-classes/${t.id}`, { method: 'PATCH', body: { name: e.target.value } }), 'Saved.')} /></label>
        <label>Rate %<input type="number" min={0} max={100} step="any" defaultValue={t.rate} onBlur={e => Number(e.target.value) !== t.rate && act(() => api(`/tax-classes/${t.id}`, { method: 'PATCH', body: { rate: Number(e.target.value) } }), 'Saved.')} /></label></div>)}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/tax-classes', { body: { code: nt.code, name: nt.name, rate: Number(nt.rate) } }); setNt({ code: '', name: '', rate: '' }) }, 'Tax class added.') }}>
        <div className="row"><Field label="New code" value={nt.code} set={v => setNt({ ...nt, code: v })} /><Field label="Name" value={nt.name} set={v => setNt({ ...nt, name: v })} /><Field label="Rate %" type="number" value={nt.rate} set={v => setNt({ ...nt, rate: v })} /></div><button className="btn alt">Add class</button></form></div>
    <div className="card"><h2>KRA eTIMS</h2><p className="low"><b>Not connected.</b> SmartBiz saves the data of each sale in a queue ready for eTIMS, but it is NOT connected to KRA, and the receipts it prints are NOT KRA tax invoices. Getting approved for eTIMS and connecting it needs KRA and an approved route. Speak to KRA or a tax adviser first.</p>
      {et && <p>Queue: {Object.entries(et.counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'empty'} · Connection: {et.connected ? 'connected' : 'none'}</p>}
      {et && et.pending.length > 0 && <div className="wrap"><table><thead><tr><th>Receipt</th><th>Status</th><th>Tries</th><th>Last problem</th></tr></thead><tbody>{et.pending.map(p => <tr key={p.id}><td>#{String(p.number).padStart(6, '0')}</td><td>{p.status.replace('_', ' ')}</td><td>{p.attempts}</td><td>{p.last_error ?? '—'}</td></tr>)}</tbody></table></div>}
      <button className="btn alt" onClick={() => act(async () => { const r = await api<{ sent: number }>('/etims/retry', { body: {} }); if (!r.sent) throw new Error('Nothing was sent: there is no eTIMS connection.') }, 'Sent.')}>Try sending the queue</button></div>
    <div className="card"><h2>Take M-Pesa payments at the till</h2><p className="mute">Use your own Safaricom Daraja app, so customers' money goes straight to your till or paybill. Keys are stored encrypted and never shown again. Leave a key blank to keep the saved one. Use the sandbox until Safaricom approves you for production.</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/settings/mpesa', { method: 'PUT', body: { env: mf.env, shortcode: mf.shortcode, partyB: mf.partyB, txType: mf.txType, enabled: mf.enabled, ...(mf.consumerKey ? { consumerKey: mf.consumerKey } : {}), ...(mf.consumerSecret ? { consumerSecret: mf.consumerSecret } : {}), ...(mf.passkey ? { passkey: mf.passkey } : {}) } }); setMf({ ...mf, consumerKey: '', consumerSecret: '', passkey: '' }) }, 'M-Pesa settings saved.') }}>
        <div className="row"><label>Environment<select value={mf.env} onChange={e => setMf({ ...mf, env: e.target.value })}><option value="sandbox">Sandbox (testing)</option><option value="production">Production</option></select></label>
          <label>Payment type<select value={mf.txType} onChange={e => setMf({ ...mf, txType: e.target.value })}><option value="CustomerPayBillOnline">Paybill</option><option value="CustomerBuyGoodsOnline">Buy Goods (till)</option></select></label></div>
        <div className="row"><Field label="Shortcode" value={mf.shortcode} set={v => setMf({ ...mf, shortcode: v })} /><Field label="Till / paybill number (PartyB)" value={mf.partyB} set={v => setMf({ ...mf, partyB: v })} /></div>
        <div className="row"><Field label={mp.configured ? 'Consumer key (blank = unchanged)' : 'Consumer key'} required={!mp.configured} value={mf.consumerKey} set={v => setMf({ ...mf, consumerKey: v })} /><Field label={mp.configured ? 'Consumer secret (blank = unchanged)' : 'Consumer secret'} required={!mp.configured} value={mf.consumerSecret} set={v => setMf({ ...mf, consumerSecret: v })} /></div>
        <Field label={mp.configured ? 'Passkey (blank = unchanged)' : 'Passkey'} required={!mp.configured} value={mf.passkey} set={v => setMf({ ...mf, passkey: v })} />
        <label><input type="checkbox" checked={mf.enabled} onChange={e => setMf({ ...mf, enabled: e.target.checked })} /> Turned on</label><button className="btn">Save M-Pesa settings</button></form></div>
  </>)
}
