import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errMsg } from './api'
import { Err, kes, num, when } from './ui'
import { cacheCatalog, enqueue, loadCatalog, loadQueue, queuedQty, removeFromQueue, retryFailed, searchCatalog, type Catalogued, type Queued } from './offline'
import { Scanner, canScan } from './Scanner'
import type { Me } from './App'

type P = Catalogued
type Line = { p: P; qty: number; price: number }
type Method = 'cash' | 'mpesa' | 'card' | 'bank' | 'credit'
type Pay = { method: Method; amount: string; tendered: string; reference: string; mpesaRequestId?: string; phone: string; stk?: 'waiting' | 'paid' | 'failed'; stkMsg?: string }
type Cust = { id: string; name: string; phone: string | null; credit_limit: number; balance: number }
export type Sale = { id: string; number: number; subtotal: number; discount: number; total: number; tax_total: number; offline: boolean; created_at: string; branch: string; cashier: string; customer: string | null; customer_phone?: string | null; customer_id?: string | null; business: string
  legal_name?: string | null; kra_pin?: string | null; business_address?: string | null; business_phone?: string | null; receipt_footer?: string | null; vat_registered?: boolean; etims_status?: string | null; pending?: boolean
  items: { id: string; product_id: string; name: string; qty: number; unit_price: number; line_total: number; tax_rate?: number; tax_amount?: number; refunded_qty: number }[]
  payments: { method: string; amount: number; tendered: number | null; reference: string | null }[]
  refunds: { id: string; qty: number; amount: number; reason: string; method: string; created_at: string; actor: string | null; item: string }[] }

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
const waPhone = (p: string) => { const d = p.replace(/\D/g, ''); return d.startsWith('0') ? '254' + d.slice(1) : d }

export function Receipt({ s }: { s: Sale }) {
  const label = s.pending ? 'PENDING ' + s.id.slice(-6).toUpperCase() : '#' + String(s.number).padStart(6, '0')
  return <div className="receipt"><h3>{s.legal_name || s.business}</h3>{s.business_address && <div style={{ textAlign: 'center' }}>{s.business_address}</div>}{s.business_phone && <div style={{ textAlign: 'center' }}>Tel {s.business_phone}</div>}
    {s.kra_pin && <div style={{ textAlign: 'center' }}>PIN {s.kra_pin}</div>}<div style={{ textAlign: 'center' }}>{s.branch}</div><hr />
    <div className="r"><span>Receipt {label}</span><span>{when(s.created_at)}</span></div><div>Served by {s.cashier}{s.customer ? ` · ${s.customer}` : ''}</div>{s.pending && <div><b>Saved offline. Will be sent when online.</b></div>}<hr />
    {s.items.map(i => <div key={i.id}><div>{i.name}</div><div className="r"><span>{num(i.qty)} x {i.unit_price.toFixed(2)}</span><span>{i.line_total.toFixed(2)}</span></div></div>)}<hr />
    <div className="r"><span>Subtotal</span><span>{s.subtotal.toFixed(2)}</span></div>
    {s.discount > 0 && <div className="r"><span>Discount</span><span>-{s.discount.toFixed(2)}</span></div>}
    {s.vat_registered && s.tax_total > 0 && <div className="r"><span>VAT included</span><span>{s.tax_total.toFixed(2)}</span></div>}
    <div className="r"><b>TOTAL</b><b>{s.total.toFixed(2)}</b></div><hr />
    {s.payments.map((p, i) => <div key={i}><div className="r"><span>{p.method === 'credit' ? 'ON ACCOUNT' : p.method.toUpperCase()}{p.reference ? ` ${p.reference}` : ''}</span><span>{p.amount.toFixed(2)}</span></div>
      {p.tendered != null && <div className="r"><span>Tendered / change</span><span>{p.tendered.toFixed(2)} / {r2(p.tendered - p.amount).toFixed(2)}</span></div>}</div>)}
    {s.refunds.length > 0 && <><hr /><div>Refunded: {s.refunds.reduce((a, r) => a + r.amount, 0).toFixed(2)}</div></>}
    <hr /><div style={{ textAlign: 'center' }}>{s.receipt_footer || 'Thank you'}</div></div>
}

export function ReceiptActions({ s, onClose }: { s: Sale; onClose: () => void }) {
  const [phone, setPhone] = useState(s.customer_phone ?? ''); const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const text = `${s.legal_name || s.business} receipt #${String(s.number).padStart(6, '0')}: KSh ${s.total.toFixed(2)}. Thank you!`
  return <div style={{ textAlign: 'center' }}><button className="btn" onClick={() => window.print()}>Print receipt</button>{' '}<button className="btn alt" onClick={onClose}>Close</button>
    {!s.pending && <div className="card" style={{ textAlign: 'left', marginTop: '.8rem' }}><label>Send to customer's phone<input value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712345678" /></label>
      <a className={'btn alt' + (phone ? '' : ' off')} style={{ margin: '.6rem .4rem 0 0' }} href={phone ? `https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(text)}` : undefined} target="_blank" rel="noreferrer">WhatsApp</a>
      <button className="btn alt" disabled={!phone} onClick={async () => { setErr(''); setMsg(''); try { await api(`/sales/${s.id}/receipt-sms`, { body: { phone } }); setMsg('SMS sent.') } catch (x) { setErr(errMsg(x)) } }}>SMS</button>
      {msg && <p role="status">{msg}</p>}<Err e={err} /></div>}</div>
}

export function PosPage({ me, branchId, online }: { me: Me; branchId: string; online: boolean }) {
  const priv = me.role !== 'cashier'
  const [q, setQ] = useState(''); const [list, setList] = useState<P[]>([]); const [stale, setStale] = useState(false); const [cart, setCart] = useState<Line[]>([])
  const [discount, setDiscount] = useState(''); const [customers, setCustomers] = useState<Cust[]>([]); const [customerId, setCustomerId] = useState('')
  const [pays, setPays] = useState<Pay[] | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState<Sale | null>(null); const [scan, setScan] = useState(false)
  const [queue, setQueue] = useState<Queued[]>(loadQueue().filter(x => x.userId === me.id)); const key = useRef(newKey())
  useEffect(() => { const h = () => setQueue(loadQueue().filter(x => x.userId === me.id)); addEventListener('sb-queue', h); return () => removeEventListener('sb-queue', h) }, [me.id])
  useEffect(() => {   // keep a copy of the product and customer lists on this device for offline use
    if (!branchId || !online) return
    api<P[]>(`/products?branchId=${branchId}&active=1&limit=1000`).then(p => cacheCatalog(branchId, p)).catch(() => undefined)
    api<Cust[]>('/customers').then(c => { setCustomers(c); localStorage.setItem('sb_customers', JSON.stringify(c)) }).catch(() => undefined)
  }, [branchId, online])
  useEffect(() => { if (!online) { try { setCustomers(JSON.parse(localStorage.getItem('sb_customers') ?? '[]')) } catch { /* none cached */ } } }, [online])
  const fromCache = useCallback(() => { const c = loadCatalog(branchId); setStale(true); setList(c ? searchCatalog(c.products, q).map(p => ({ ...p, stock: p.stock - queuedQty(branchId, p.id) })) : []) }, [branchId, q])
  useEffect(() => {
    if (!branchId) return
    const t = setTimeout(async () => {
      if (!online) return fromCache()
      try { setList(await api<P[]>(`/products?q=${encodeURIComponent(q)}&branchId=${branchId}&active=1&limit=40`)); setStale(false) } catch (e) { if (e instanceof TypeError) fromCache(); else setErr(errMsg(e)) }
    }, 250)
    return () => clearTimeout(t)
  }, [q, branchId, online, fromCache, queue.length])
  const add = (p: P) => { setErr(''); setCart(c => c.some(l => l.p.id === p.id) ? c.map(l => l.p.id === p.id ? { ...l, qty: l.qty + 1 } : l) : [...c, { p, qty: 1, price: p.price }]) }
  async function byCode(code: string) {   // barcode scanners type the code and press Enter; the camera scanner calls this too
    const c = code.trim(); if (!c) return
    try {
      if (online) add(await api<P>(`/products/lookup?code=${encodeURIComponent(c)}&branchId=${branchId}`))
      else { const hit = searchCatalog(loadCatalog(branchId)?.products ?? [], c).find(p => p.barcode === c || p.sku.toLowerCase() === c.toLowerCase()); if (!hit) throw new Error('x'); add(hit) }
      setQ('')
    } catch { if (list.length === 1) { add(list[0]); setQ('') } else setErr('No exact match. Pick a product from the list.') }
  }
  const subtotal = r2(cart.reduce((a, l) => a + l.qty * l.price, 0)), disc = priv ? Math.min(Number(discount) || 0, subtotal) : 0, total = r2(subtotal - disc)
  const paid = pays ? r2(pays.reduce((a, p) => a + (Number(p.amount) || 0), 0)) : 0, ready = pays !== null && total > 0 && Math.abs(paid - total) < 0.005 && !pays.some(p => p.stk === 'waiting')
  const setPay = (i: number, v: Partial<Pay>) => setPays(ps => ps!.map((p, j) => j === i ? { ...p, ...v } : p))
  const cust = customers.find(c => c.id === customerId)
  async function prompt(i: number) {   // ask the customer's phone to approve the payment, then wait for confirmation
    const p = pays![i]; setErr(''); setPay(i, { stk: 'waiting', stkMsg: 'Sending…' })
    try {
      const r = await api<{ id: string }>('/till-mpesa', { body: { branchId, phone: p.phone, amount: Number(p.amount) } }); setPay(i, { stkMsg: 'Ask the customer to enter their M-Pesa PIN…' })
      for (let n = 0; n < 40; n++) {
        await new Promise(res => setTimeout(res, 3000))
        const s = await api<{ status: string; receipt: string | null }>(`/till-mpesa/${r.id}`)
        if (s.status === 'paid') return setPay(i, { stk: 'paid', mpesaRequestId: r.id, reference: s.receipt ?? '', stkMsg: `Paid. Code ${s.receipt}` })
        if (s.status === 'failed') return setPay(i, { stk: 'failed', stkMsg: 'The customer cancelled or the payment failed.' })
      }
      setPay(i, { stk: 'failed', stkMsg: 'No answer yet. You can try again or enter the code manually.' })
    } catch (x) { setPay(i, { stk: 'failed', stkMsg: errMsg(x) }) }
  }
  const saleBody = () => ({ branchId, idempotencyKey: key.current, customerId: customerId || null, discount: disc,
    items: cart.map(l => ({ productId: l.p.id, qty: l.qty, ...(l.price !== l.p.price ? { unitPrice: l.price } : {}) })),
    payments: pays!.map(p => ({ method: p.method, amount: Number(p.amount), ...(p.method === 'cash' && p.tendered ? { tendered: Number(p.tendered) } : {}), ...(p.reference && !p.mpesaRequestId ? { reference: p.reference } : {}), ...(p.mpesaRequestId ? { mpesaRequestId: p.mpesaRequestId } : {}) })) })
  const finish = (s: Sale) => { setDone(s); setCart([]); setPays(null); setDiscount(''); setCustomerId(''); key.current = newKey() }
  function saveOffline() {
    if (pays!.some(p => p.method === 'credit' || p.mpesaRequestId)) return setErr('Account sales and M-Pesa prompts need a connection. Choose cash, card, bank or enter an M-Pesa code.')
    const body = { ...saleBody(), offline: true, soldAt: new Date().toISOString() }
    enqueue({ key: key.current, userId: me.id, branchId, body, label: cart.map(l => `${l.qty} x ${l.p.name}`).join(', '), total, at: body.soldAt, })
    finish({ id: key.current, number: 0, pending: true, subtotal, discount: disc, total, tax_total: 0, offline: true, created_at: body.soldAt, branch: me.branches.find(b => b.id === branchId)?.name ?? '', cashier: me.name, customer: null, business: me.sub.business,
      items: cart.map((l, i) => ({ id: String(i), product_id: l.p.id, name: l.p.name, qty: l.qty, unit_price: l.price, line_total: r2(l.qty * l.price), refunded_qty: 0 })),
      payments: pays!.map(p => ({ method: p.method, amount: Number(p.amount), tendered: p.tendered ? Number(p.tendered) : null, reference: p.reference || null })), refunds: [] })
  }
  async function charge() {
    setErr(''); setBusy(true)
    try {
      if (!online) saveOffline()
      else { try { finish(await api<Sale>('/sales', { body: saleBody() })) } catch (x) { if (x instanceof TypeError) saveOffline(); else throw x } }   // the connection dropped: keep the sale on this device
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const unsent = queue.filter(x => x.status === 'pending').length
  return (<>
    {stale && <p className="mute">Showing the product list saved on this device. Stock figures may be out of date.</p>}
    <div className="pos">
      <div><label>Search or scan<input autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && byCode(q)} placeholder="Name, SKU or scan barcode, then Enter" /></label>
        {canScan && <button className="btn alt" onClick={() => setScan(true)}>Scan with camera</button>}
        <div className="tiles">{list.map(p => <button key={p.id} className="tile" disabled={p.stock <= 0} onClick={() => add(p)}><b>{p.name}</b>{kes(p.price)}<br /><small>{p.stock > 0 ? `${num(p.stock)} ${p.unit} in stock` : 'Out of stock'}</small></button>)}</div>
        {list.length === 0 && <p className="mute">No products found.</p>}</div>
      <div className="card cart"><h2>Current sale</h2>
        {cart.length === 0 && <p className="mute">Tap a product to add it.</p>}
        {cart.map(l => <div className="line" key={l.p.id}><div style={{ flex: 1 }}><b>{l.p.name}</b>{l.qty > l.p.stock && <div className="low">Only {num(l.p.stock)} in stock</div>}</div>
          <input aria-label={`Quantity of ${l.p.name}`} type="number" min={0.001} step="any" value={l.qty} onChange={e => setCart(cart.map(x => x.p.id === l.p.id ? { ...x, qty: Number(e.target.value) } : x))} />
          {priv ? <input aria-label={`Price of ${l.p.name}`} type="number" min={0} step="any" value={l.price} onChange={e => setCart(cart.map(x => x.p.id === l.p.id ? { ...x, price: Number(e.target.value) } : x))} /> : <span>{kes(l.price)}</span>}
          <button className="btn alt" style={{ margin: 0, minHeight: 36 }} aria-label={`Remove ${l.p.name}`} onClick={() => setCart(cart.filter(x => x.p.id !== l.p.id))}>✕</button></div>)}
        {priv && cart.length > 0 && <label>Discount (KSh)<input type="number" min={0} step="any" value={discount} onChange={e => setDiscount(e.target.value)} /></label>}
        {cart.length > 0 && <label>Customer (optional)<select value={customerId} onChange={e => setCustomerId(e.target.value)}><option value="">Walk-in</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <div className="total">{kes(total)}</div><Err e={err} />
        <button className="btn" disabled={cart.length === 0 || total <= 0 || cart.some(l => !(l.qty > 0))} onClick={() => setPays([{ method: 'cash', amount: total.toFixed(2), tendered: '', reference: '', phone: cust?.phone ?? '' }])}>Charge</button>{' '}
        {cart.length > 0 && <button className="btn alt" onClick={() => { setCart([]); setDiscount('') }}>Clear</button>}</div>
    </div>
    {queue.length > 0 && <div className="card"><h2>Sales saved on this device ({queue.length})</h2><p className="mute">{unsent > 0 ? 'These are sent automatically when the connection returns.' : ''} Sales marked "needs attention" were refused when sent (for example not enough stock). Ask a manager.</p>
      {queue.map(x => <div key={x.key} className="acts" style={{ margin: '.4rem 0' }}><span>{when(x.at)} · {kes(x.total)} · {x.label.slice(0, 60)} · {x.status === 'failed' ? <b className="low">needs attention: {x.error}</b> : 'waiting'}</span>
        {x.status === 'failed' && <><button className="btn alt" onClick={() => retryFailed(x.key)}>Try again</button><button className="btn alt" onClick={() => { if (confirm('Discard this sale? The money was not recorded in SmartBiz.')) removeFromQueue(x.key) }}>Discard</button></>}</div>)}</div>}
    {pays && <div className="scrim"><div className="sheet"><h2>Payment: {kes(total)}</h2>{!online && <p className="mute">Offline: cash, card, bank or a typed M-Pesa code only.</p>}
      {pays.map((p, i) => <div className="card" key={i}><div className="row"><label>Method<select value={p.method} onChange={e => setPay(i, { method: e.target.value as Method, mpesaRequestId: undefined, stk: undefined, stkMsg: undefined })}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank">Bank</option>{online && customerId && <option value="credit">On account</option>}</select></label>
        <label>Amount<input type="number" min={0} step="any" value={p.amount} onChange={e => setPay(i, { amount: e.target.value })} /></label></div>
        {p.method === 'cash' && <><label>Cash received (optional)<input type="number" min={0} step="any" value={p.tendered} onChange={e => setPay(i, { tendered: e.target.value })} /></label>
          {Number(p.tendered) > Number(p.amount) && <p>Change to give: <b>{kes(r2(Number(p.tendered) - Number(p.amount)))}</b></p>}</>}
        {p.method === 'mpesa' && <>{online && <div className="row"><label>Customer phone<input value={p.phone} onChange={e => setPay(i, { phone: e.target.value })} placeholder="0712345678" /></label>
          <button className="btn alt" disabled={!p.phone || p.stk === 'waiting' || p.stk === 'paid'} onClick={() => prompt(i)}>Send M-Pesa prompt</button></div>}
          {p.stkMsg && <p className={p.stk === 'paid' ? 'ok' : p.stk === 'failed' ? 'low' : ''}>{p.stkMsg}</p>}
          {!p.mpesaRequestId && <label>M-Pesa transaction code (if the customer paid another way)<input value={p.reference} onChange={e => setPay(i, { reference: e.target.value.toUpperCase() })} placeholder="e.g. QWE123ABCD" /></label>}</>}
        {p.method === 'credit' && cust && <p>{cust.name} owes {kes(cust.balance)} of a {kes(cust.credit_limit)} limit. Available: <b>{kes(Math.max(0, cust.credit_limit - cust.balance))}</b></p>}
        {pays.length > 1 && <button className="btn alt" onClick={() => setPays(pays.filter((_, j) => j !== i))}>Remove</button>}</div>)}
      {pays.length < 4 && <button className="btn alt" onClick={() => setPays([...pays, { method: 'mpesa', amount: Math.max(0, r2(total - paid)).toFixed(2), tendered: '', reference: '', phone: cust?.phone ?? '' }])}>Split payment</button>}
      <p>{Math.abs(paid - total) < 0.005 ? <span className="ok">Payments match the total.</span> : <span className="low">{paid < total ? `Still to pay: ${kes(r2(total - paid))}` : `Over by ${kes(r2(paid - total))}`}</span>}</p><Err e={err} />
      <button className="btn" disabled={!ready || busy} onClick={charge}>{busy ? 'Saving…' : online ? 'Complete sale' : 'Save sale on this device'}</button>{' '}<button className="btn alt" onClick={() => setPays(null)}>Back</button></div></div>}
    {done && <div className="scrim"><div className="sheet"><Receipt s={done} /><ReceiptActions s={done} onClose={() => setDone(null)} /></div></div>}
    {scan && <Scanner onCode={c => { setScan(false); void byCode(c) }} onClose={() => setScan(false)} />}
  </>)
}
