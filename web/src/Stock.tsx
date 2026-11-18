import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from './api'
import { Err, Field, day, kes, num, when } from './ui'
import type { Me } from './App'

type Prod = { id: string; sku: string; name: string; cost: number | null; track_batches: boolean }
const useProducts = (branchId: string) => { const [p, setP] = useState<Prod[]>([]); useEffect(() => { if (branchId) api<Prod[]>(`/products?branchId=${branchId}&active=1&limit=500`).then(setP).catch(() => undefined) }, [branchId]); return p }

export function StockPage({ me, branchId }: { me: Me; branchId: string }) {
  type Row = { product_id: string; sku: string; name: string; unit: string; reorder_level: number; branch: string; qty: number; value: number | null }
  type Mv = { id: number; type: string; qty: number; unit_cost: number | null; reason: string | null; created_at: string; product: string; branch: string; actor: string | null }
  const [tab, setTab] = useState<'levels' | 'adjust' | 'transfer' | 'expiry' | 'history'>('levels')
  const products = useProducts(branchId)
  const [rows, setRows] = useState<Row[]>([]); const [mv, setMv] = useState<Mv[]>([]); const [low, setLow] = useState(false); const [q, setQ] = useState('')
  const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [a, setA] = useState({ productId: '', qty: '', reason: '', batchNo: '', expiry: '', batchId: '' }); const [bat, setBat] = useState<{ id: string; batch_no: string; expiry_date: string | null; qty: number }[]>([]); const [exp, setExp] = useState<{ id: string; name: string; branch: string; batch_no: string; expiry_date: string; qty: number; value: number | null; expired: boolean }[]>([]); const [t, setT] = useState({ toBranchId: '', productId: '', qty: '', note: '' })
  const load = useCallback(() => {
    if (!branchId) return
    api<Row[]>(`/stock?branchId=${branchId}${low ? '&low=1' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch(e => setErr(errMsg(e)))
    if (me.role !== 'cashier') api<Mv[]>(`/stock/movements?branchId=${branchId}`).then(setMv).catch(() => undefined)
  }, [branchId, low, q, me.role])
  useEffect(() => { const x = setTimeout(load, 200); return () => clearTimeout(x) }, [load])
  const act = async (fn: () => Promise<unknown>, msg: string, reset: () => void) => { setErr(''); setOk(''); try { await fn(); setOk(msg); reset(); load() } catch (x) { setErr(errMsg(x)) } }
  const adjust = (e: FormEvent) => { e.preventDefault(); void act(() => api('/stock/adjust', { body: { branchId, productId: a.productId, qty: Number(a.qty), reason: a.reason, ...(a.batchNo ? { batchNo: a.batchNo, expiry: a.expiry || null } : {}), ...(a.batchId ? { batchId: a.batchId } : {}) } }), 'Stock adjusted.', () => setA({ productId: '', qty: '', reason: '', batchNo: '', expiry: '', batchId: '' })) }
  const transfer = (e: FormEvent) => { e.preventDefault(); void act(() => api('/stock/transfer', { body: { fromBranchId: branchId, toBranchId: t.toBranchId, productId: t.productId, qty: Number(t.qty), note: t.note || undefined } }), 'Stock transferred.', () => setT({ ...t, productId: '', qty: '', note: '' })) }
  const selected = products.find(p => p.id === a.productId)
  useEffect(() => { if (tab === 'adjust' && selected?.track_batches && branchId) api<typeof bat>(`/stock/batches?productId=${selected.id}&branchId=${branchId}`).then(setBat).catch(() => setBat([])); else setBat([]) }, [tab, selected?.id, selected?.track_batches, branchId])
  useEffect(() => { if (tab === 'expiry') api<typeof exp>(`/stock/expiry?days=60&branchId=${branchId}`).then(setExp).catch(e => setErr(errMsg(e))) }, [tab, branchId])
  const others = me.branches.filter(b => b.id !== branchId)
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0)
  return (<>
    <div className="tabs">{(['levels', 'adjust', 'transfer', 'expiry', 'history'] as const).map(k => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{{ levels: 'Stock levels', adjust: 'Adjust stock', transfer: 'Transfer', expiry: 'Expiry', history: 'History' }[k]}</button>)}</div>
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    {tab === 'levels' && <><div className="row"><label>Search<input value={q} onChange={e => setQ(e.target.value)} /></label><label><input type="checkbox" checked={low} onChange={e => setLow(e.target.checked)} /> Only low stock</label></div>
      <div className="wrap"><table className="cards"><thead><tr><th>SKU</th><th>Product</th><th>In stock</th><th>Reorder at</th><th>Value at cost</th></tr></thead><tbody>
        {rows.length === 0 && <tr><td colSpan={5} className="mute">Nothing in stock here yet. Receive a purchase order or adjust stock.</td></tr>}
        {rows.map(r => <tr key={r.product_id}><td data-label="SKU">{r.sku}</td><td data-label="Product">{r.name}</td><td data-label="In stock" className={r.reorder_level > 0 && r.qty <= r.reorder_level ? 'low' : ''}>{num(r.qty)} {r.unit}</td><td data-label="Reorder at">{num(r.reorder_level)}</td><td data-label="Value at cost">{r.value == null ? '—' : kes(r.value)}</td></tr>)}</tbody></table></div>
      {me.role !== 'cashier' && rows.length > 0 && <p><b>Total value at cost: {kes(total)}</b></p>}</>}
    {tab === 'adjust' && <div className="card"><h2>Adjust stock</h2><p className="mute">Use for stock counts, damage or losses. Every change needs a reason and is kept in the history. Use a minus sign to remove stock.</p>
      <form onSubmit={adjust}><label>Product<select value={a.productId} onChange={e => setA({ ...a, productId: e.target.value })} required><option value="">Choose…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}</select></label>
        <Field label="Quantity to add (or remove, e.g. -3)" type="number" value={a.qty} set={v => setA({ ...a, qty: v })} />
        {selected?.track_batches && Number(a.qty) > 0 && <div className="row"><Field label="Batch number" value={a.batchNo} set={v => setA({ ...a, batchNo: v })} /><label>Expiry date<input type="date" value={a.expiry} onChange={e => setA({ ...a, expiry: e.target.value })} /></label></div>}
        {selected?.track_batches && Number(a.qty) < 0 && <label>Take from batch (blank = earliest expiry first)<select value={a.batchId} onChange={e => setA({ ...a, batchId: e.target.value })}><option value="">Earliest expiry first</option>{bat.map(b => <option key={b.id} value={b.id}>{b.batch_no}{b.expiry_date ? ` (expires ${new Date(b.expiry_date).toLocaleDateString()})` : ''}: {num(b.qty)}</option>)}</select></label>}<Field label="Reason" value={a.reason} set={v => setA({ ...a, reason: v })} placeholder="e.g. Stock count, damaged, expired" /><button className="btn">Save adjustment</button></form></div>}
    {tab === 'transfer' && <div className="card"><h2>Transfer to another branch</h2>{others.length === 0 ? <p className="mute">You need access to at least two branches to transfer stock.</p> :
      <form onSubmit={transfer}><label>To branch<select value={t.toBranchId} onChange={e => setT({ ...t, toBranchId: e.target.value })} required><option value="">Choose…</option>{others.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Product<select value={t.productId} onChange={e => setT({ ...t, productId: e.target.value })} required><option value="">Choose…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}</select></label>
        <Field label="Quantity" type="number" value={t.qty} set={v => setT({ ...t, qty: v })} /><Field label="Note (optional)" required={false} value={t.note} set={v => setT({ ...t, note: v })} /><button className="btn">Transfer</button></form>}</div>}
    {tab === 'expiry' && <><p className="mute">Batches that have expired or expire within 60 days at this branch. Expired stock is never sold. Write it off under Adjust stock.</p><div className="wrap"><table className="cards"><thead><tr><th>Product</th><th>Batch</th><th>Expires</th><th className="right">Quantity</th><th className="right">Value at cost</th></tr></thead><tbody>
      {exp.length === 0 && <tr><td colSpan={5} className="mute">Nothing expiring soon.</td></tr>}
      {exp.map(r => <tr key={r.id}><td data-label="Product">{r.name}</td><td data-label="Batch">{r.batch_no}</td><td data-label="Expires" className={r.expired ? 'low' : ''}>{new Date(r.expiry_date).toLocaleDateString()}{r.expired ? ' (expired)' : ''}</td><td data-label="Quantity" className="right">{num(r.qty)}</td><td data-label="Value at cost" className="right">{r.value == null ? '—' : kes(r.value)}</td></tr>)}</tbody></table></div></>}
    {tab === 'history' && <div className="wrap"><table className="cards"><thead><tr><th>When</th><th>Product</th><th>Type</th><th>Quantity</th><th>Reason</th><th>By</th></tr></thead><tbody>
      {mv.length === 0 && <tr><td colSpan={6} className="mute">No movements yet.</td></tr>}
      {mv.map(m => <tr key={m.id}><td data-label="When">{when(m.created_at)}</td><td data-label="Product">{m.product}</td><td data-label="Type">{m.type.replace('_', ' ')}</td><td data-label="Quantity" className={m.qty < 0 ? 'low' : 'ok'}>{m.qty > 0 ? '+' : ''}{num(m.qty)}</td><td data-label="Reason">{m.reason ?? '—'}</td><td data-label="By">{m.actor ?? '—'}</td></tr>)}</tbody></table></div>}
  </>)
}

export function BuyingPage({ me, branchId }: { me: Me; branchId: string }) {
  type Sup = { id: string; name: string; phone: string | null; email: string | null; active: boolean }
  type Po = { id: string; number: number; status: string; created_at: string; supplier: string; branch: string; total: number }
  type Item = { id: string; sku: string; name: string; track_batches: boolean; qty_ordered: number; qty_received: number; unit_cost: number }
  const [tab, setTab] = useState<'orders' | 'new' | 'suppliers'>('orders'); const products = useProducts(branchId)
  const [sups, setSups] = useState<Sup[]>([]); const [pos, setPos] = useState<Po[]>([]); const [open, setOpen] = useState<(Po & { items: Item[] }) | null>(null); const [recv, setRecv] = useState<Record<string, string>>({}); const [rb, setRb] = useState<Record<string, { batchNo: string; expiry: string }>>({})
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [sf, setSf] = useState({ name: '', phone: '' })
  const [nf, setNf] = useState({ supplierId: '', notes: '' }); const [lines, setLines] = useState([{ productId: '', qty: '', unitCost: '' }])
  const load = useCallback(() => { api<Sup[]>('/suppliers').then(setSups).catch(e => setErr(errMsg(e))); api<Po[]>('/purchase-orders').then(setPos).catch(() => undefined) }, [])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, msg: string) => { setErr(''); setOk(''); try { await fn(); setOk(msg); load() } catch (x) { setErr(errMsg(x)) } }
  const show = async (p: Po) => { setRecv({}); setErr(''); try { setOpen(await api(`/purchase-orders/${p.id}`)) } catch (x) { setErr(errMsg(x)) } }
  const create = (e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/purchase-orders', { body: { branchId, supplierId: nf.supplierId, notes: nf.notes || undefined, items: lines.map(l => ({ productId: l.productId, qty: Number(l.qty), unitCost: Number(l.unitCost) })) } }); setLines([{ productId: '', qty: '', unitCost: '' }]); setTab('orders') }, 'Purchase order created.') }
  const receive = () => act(async () => { const items = Object.entries(recv).filter(([, v]) => Number(v) > 0).map(([itemId, v]) => ({ itemId, qty: Number(v), ...(rb[itemId]?.batchNo ? { batchNo: rb[itemId].batchNo, expiry: rb[itemId].expiry || null } : {}) })); if (!items.length) throw new Error('Enter the quantities you received'); await api(`/purchase-orders/${open!.id}/receive`, { body: { items } }); setOpen(null) }, 'Goods received into stock.')
  return (<>
    <div className="tabs"><button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>Orders</button><button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>New order</button><button className={tab === 'suppliers' ? 'on' : ''} onClick={() => setTab('suppliers')}>Suppliers</button></div>
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    {tab === 'orders' && <div className="wrap"><table className="cards"><thead><tr><th>#</th><th>Supplier</th><th>Branch</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
      {pos.length === 0 && <tr><td colSpan={7} className="mute">No purchase orders yet.</td></tr>}
      {pos.map(p => <tr key={p.id}><td data-label="Order">PO-{p.number}</td><td data-label="Supplier">{p.supplier}</td><td data-label="Branch">{p.branch}</td><td data-label="Date">{day(p.created_at)}</td><td data-label="Total">{kes(p.total)}</td><td data-label="Status"><span className="tag">{p.status}</span></td><td data-label=""><button className="btn alt" onClick={() => show(p)}>Open</button></td></tr>)}</tbody></table></div>}
    {tab === 'new' && <div className="card"><h2>New purchase order</h2><p className="mute">Goods will be received into the branch selected at the top.</p><form onSubmit={create}>
      <label>Supplier<select value={nf.supplierId} onChange={e => setNf({ ...nf, supplierId: e.target.value })} required><option value="">Choose…</option>{sups.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      {lines.map((l, i) => <div className="row" key={i}><label>Product<select value={l.productId} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, productId: e.target.value } : x))} required><option value="">Choose…</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}</select></label>
        <label>Quantity<input type="number" min={0.001} step="any" required value={l.qty} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></label>
        <label>Unit cost (KSh)<input type="number" min={0} step="any" required value={l.unitCost} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, unitCost: e.target.value } : x))} /></label></div>)}
      <button type="button" className="btn alt" onClick={() => setLines([...lines, { productId: '', qty: '', unitCost: '' }])}>Add another product</button>
      <Field label="Notes (optional)" required={false} value={nf.notes} set={v => setNf({ ...nf, notes: v })} /><button className="btn">Create order</button></form></div>}
    {tab === 'suppliers' && <><div className="card"><h2>Add a supplier</h2><form onSubmit={e => { e.preventDefault(); void act(async () => { await api('/suppliers', { body: { name: sf.name, phone: sf.phone || undefined } }); setSf({ name: '', phone: '' }) }, 'Supplier added.') }}>
      <div className="row"><Field label="Name" value={sf.name} set={v => setSf({ ...sf, name: v })} /><Field label="Phone (optional)" required={false} value={sf.phone} set={v => setSf({ ...sf, phone: v })} /></div><button className="btn">Add supplier</button></form></div>
      <div className="wrap"><table className="cards"><thead><tr><th>Supplier</th><th>Phone</th><th>Email</th></tr></thead><tbody>{sups.map(s => <tr key={s.id}><td data-label="Supplier">{s.name}</td><td data-label="Phone">{s.phone ?? '—'}</td><td data-label="Email">{s.email ?? '—'}</td></tr>)}</tbody></table></div></>}
    {open && <div className="scrim" onClick={() => setOpen(null)}><div className="sheet" onClick={e => e.stopPropagation()}><h2>PO-{open.number} · {open.supplier}</h2><p className="mute">{open.branch} · {open.status}</p>
      {open.items.map(i => <div className="row" key={i.id} style={{ alignItems: 'end' }}><div><b>{i.name}</b><br /><small>{num(i.qty_received)} of {num(i.qty_ordered)} received · {kes(i.unit_cost)} each</small></div>
        {open.status !== 'received' && open.status !== 'cancelled' && i.qty_received < i.qty_ordered && <label>Receive now<input type="number" min={0} step="any" max={i.qty_ordered - i.qty_received} value={recv[i.id] ?? ''} onChange={e => setRecv({ ...recv, [i.id]: e.target.value })} /></label>}
        {i.track_batches && Number(recv[i.id]) > 0 && <><label>Batch number<input value={rb[i.id]?.batchNo ?? ''} onChange={e => setRb({ ...rb, [i.id]: { batchNo: e.target.value, expiry: rb[i.id]?.expiry ?? '' } })} /></label><label>Expiry<input type="date" value={rb[i.id]?.expiry ?? ''} onChange={e => setRb({ ...rb, [i.id]: { batchNo: rb[i.id]?.batchNo ?? '', expiry: e.target.value } })} /></label></>}</div>)}
      <Err e={err} />{open.status !== 'received' && open.status !== 'cancelled' && <button className="btn" onClick={receive}>Receive into stock</button>}{' '}
      {open.status === 'ordered' && <button className="btn alt" onClick={() => act(async () => { await api(`/purchase-orders/${open.id}/cancel`, { method: 'POST', body: {} }); setOpen(null) }, 'Order cancelled.')}>Cancel order</button>}{' '}<button className="btn alt" onClick={() => setOpen(null)}>Close</button></div></div>}
  </>)
}
