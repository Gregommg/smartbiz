import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from './api'
import { Err, Field, kes, num, saveFile } from './ui'
import type { Me } from './App'

type Prod = { id: string; sku: string; barcode: string | null; name: string; unit: string; price: number; cost: number | null; reorder_level: number; active: boolean; category_id: string | null; category: string | null; stock: number
  group_name: string | null; variant: string | null; tax_class_id: string | null; track_batches: boolean; tax_name: string | null; tax_rate: number | null }
type Cat = { id: string; name: string }
type Tax = { id: string; code: string; name: string; rate: number }

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = [] }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(x => x.trim()))
}
const TEMPLATE = ['sku,name,price,cost,barcode,category,unit,reorder_level,opening_qty,group,variant', 'SUG1,Sugar 1kg,200,150,6001234567890,Groceries,pcs,10,50,,', 'TS-S,T-Shirt - Small,500,200,,Clothing,pcs,2,10,T-Shirt,Small'].join('\n')

export function ProductsPage({ me, branchId }: { me: Me; branchId: string }) {
  const edit = me.role === 'owner' || me.role === 'manager', seeCost = me.role !== 'cashier'
  const [tab, setTab] = useState<'list' | 'form' | 'variants' | 'import'>('list')
  const [rows, setRows] = useState<Prod[]>([]); const [cats, setCats] = useState<Cat[]>([]); const [taxes, setTaxes] = useState<Tax[]>([]); const [q, setQ] = useState(''); const [inactive, setInactive] = useState(false)
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [editing, setEditing] = useState<Prod | null>(null)
  const blank = { sku: '', barcode: '', name: '', categoryId: '', unit: 'pcs', cost: '0', price: '', reorderLevel: '0', groupName: '', variant: '', taxClassId: '', trackBatches: false }
  const [f, setF] = useState(blank); const [csv, setCsv] = useState('')
  const [vf, setVf] = useState({ groupName: '', baseSku: '', price: '', cost: '0', categoryId: '', taxClassId: '', unit: 'pcs' }); const [vrows, setVrows] = useState([{ label: '', barcode: '', price: '' }])
  const load = useCallback(() => {
    api<Prod[]>(`/products?q=${encodeURIComponent(q)}&branchId=${branchId}${inactive ? '' : '&active=1'}&limit=300`).then(setRows).catch(e => setErr(errMsg(e)))
    api<Cat[]>('/categories').then(setCats).catch(() => undefined); api<Tax[]>('/tax-classes').then(setTaxes).catch(() => undefined)
  }, [q, branchId, inactive])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])
  const start = (p: Prod | null) => { setEditing(p); setOk(''); setErr(''); setF(p ? { sku: p.sku, barcode: p.barcode ?? '', name: p.name, categoryId: p.category_id ?? '', unit: p.unit, cost: String(p.cost ?? 0), price: String(p.price), reorderLevel: String(p.reorder_level), groupName: p.group_name ?? '', variant: p.variant ?? '', taxClassId: p.tax_class_id ?? '', trackBatches: p.track_batches } : blank); setTab('form') }
  async function save(e: FormEvent) {
    e.preventDefault(); setErr(''); setOk('')
    const body = { sku: f.sku, barcode: f.barcode || null, name: f.name, categoryId: f.categoryId || null, unit: f.unit, cost: Number(f.cost), price: Number(f.price), reorderLevel: Number(f.reorderLevel), groupName: f.groupName || null, variant: f.variant || null, taxClassId: f.taxClassId || null, ...(f.trackBatches ? { trackBatches: true } : {}) }
    try { if (editing) await api(`/products/${editing.id}`, { method: 'PATCH', body }); else await api('/products', { body }); setOk('Saved.'); setTab('list'); load() } catch (x) { setErr(errMsg(x)) }
  }
  const toggle = async (p: Prod) => { try { await api(`/products/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); load() } catch (x) { setErr(errMsg(x)) } }
  async function makeVariants(e: FormEvent) {
    e.preventDefault(); setErr(''); setOk('')
    try {
      const r = await api<{ created: number }>('/products/variants', { body: { groupName: vf.groupName, baseSku: vf.baseSku, price: Number(vf.price), cost: Number(vf.cost), categoryId: vf.categoryId || null, taxClassId: vf.taxClassId || null, unit: vf.unit,
        variants: vrows.filter(v => v.label.trim()).map(v => ({ label: v.label, ...(v.barcode ? { barcode: v.barcode } : {}), ...(v.price ? { price: Number(v.price) } : {}) })) } })
      setOk(`${r.created} variants created. Add stock to each under Stock or Purchasing.`); setVrows([{ label: '', barcode: '', price: '' }]); setTab('list'); load()
    } catch (x) { setErr(errMsg(x)) }
  }
  async function doImport() {
    setErr(''); setOk('')
    const t = parseCsv(csv); if (t.length < 2) return setErr('Paste a CSV with a header row and at least one product.')
    const h = t[0].map(x => x.trim().toLowerCase()), col = (n: string) => h.indexOf(n)
    const val = (r: string[], n: string) => { const i = col(n); return i >= 0 ? r[i]?.trim() || undefined : undefined }
    const numv = (r: string[], n: string) => { const v = val(r, n); return v === undefined ? undefined : Number(v) }
    const rowsOut = t.slice(1).map(r => ({ sku: val(r, 'sku'), name: val(r, 'name'), price: numv(r, 'price'), cost: numv(r, 'cost'), barcode: val(r, 'barcode'), category: val(r, 'category'), unit: val(r, 'unit'), reorderLevel: numv(r, 'reorder_level'), openingQty: numv(r, 'opening_qty'), group: val(r, 'group'), variant: val(r, 'variant') }))
    try { const r = await api<{ created: number }>('/products/bulk', { body: { branchId, rows: rowsOut } }); setOk(`${r.created} products imported.`); setCsv(''); setTab('list'); load() } catch (x) { setErr(errMsg(x)) }
  }
  return (<>
    {edit && <div className="tabs"><button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>Products</button><button className={tab === 'form' ? 'on' : ''} onClick={() => start(null)}>Add product</button><button className={tab === 'variants' ? 'on' : ''} onClick={() => setTab('variants')}>Add variants</button><button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>Import CSV</button></div>}
    {ok && <p role="status">{ok}</p>}<Err e={err} />
    {tab === 'list' && <><div className="row"><label>Search<input value={q} onChange={e => setQ(e.target.value)} placeholder="Name, SKU, barcode or group" /></label>
      {edit && <label><input type="checkbox" checked={inactive} onChange={e => setInactive(e.target.checked)} /> Show inactive products</label>}</div>
      <div className="wrap"><table className="cards"><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Price</th>{seeCost && <th>Cost</th>}<th>In stock</th><th>Reorder at</th><th></th></tr></thead><tbody>
        {rows.length === 0 && <tr><td colSpan={8} className="mute">No products yet.{edit ? ' Add one or import a CSV.' : ''}</td></tr>}
        {rows.map(p => <tr key={p.id}><td data-label="SKU">{p.sku}</td><td data-label="Product">{p.name}{p.variant && <span className="tag">{p.variant}</span>}{p.track_batches && <span className="tag">batches</span>}{p.tax_rate ? <span className="tag">VAT {p.tax_rate}%</span> : null}{!p.active && <span className="tag">inactive</span>}</td><td data-label="Category">{p.category ?? '—'}</td><td data-label="Price">{kes(p.price)}</td>
          {seeCost && <td data-label="Cost">{kes(p.cost)}</td>}<td data-label="In stock" className={p.reorder_level > 0 && p.stock <= p.reorder_level ? 'low' : ''}>{num(p.stock)} {p.unit}</td><td data-label="Reorder at">{num(p.reorder_level)}</td>
          <td data-label="">{edit && <div className="acts"><button className="btn alt" onClick={() => start(p)}>Edit</button><button className="btn alt" onClick={() => toggle(p)}>{p.active ? 'Deactivate' : 'Activate'}</button></div>}</td></tr>)}</tbody></table></div></>}
    {tab === 'form' && <div className="card"><h2>{editing ? `Edit ${editing.name}` : 'Add a product'}</h2><form onSubmit={save}>
      <div className="row"><Field label="SKU (your own code)" value={f.sku} set={v => setF({ ...f, sku: v })} /><Field label="Barcode (optional)" required={false} value={f.barcode} set={v => setF({ ...f, barcode: v })} /></div>
      <Field label="Product name" value={f.name} set={v => setF({ ...f, name: v })} />
      <div className="row"><Field label="Group (optional, e.g. T-Shirt)" required={false} value={f.groupName} set={v => setF({ ...f, groupName: v })} /><Field label="Variant (optional, e.g. Large / Red)" required={false} value={f.variant} set={v => setF({ ...f, variant: v })} /></div>
      <div className="row"><label>Category<select value={f.categoryId} onChange={e => setF({ ...f, categoryId: e.target.value })}><option value="">None</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><Field label="Unit (pcs, kg, litre)" value={f.unit} set={v => setF({ ...f, unit: v })} />
        <label>Tax class<select value={f.taxClassId} onChange={e => setF({ ...f, taxClassId: e.target.value })}><option value="">None</option>{taxes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}</select></label></div>
      <div className="row"><Field label="Selling price (KSh, VAT included)" type="number" value={f.price} set={v => setF({ ...f, price: v })} /><Field label="Cost price (KSh)" type="number" value={f.cost} set={v => setF({ ...f, cost: v })} /><Field label="Reorder level" type="number" value={f.reorderLevel} set={v => setF({ ...f, reorderLevel: v })} /></div>
      <label><input type="checkbox" checked={f.trackBatches} disabled={!!editing?.track_batches} onChange={e => setF({ ...f, trackBatches: e.target.checked })} /> Track batches and expiry dates (medicines, food). Sold first-expiry-first-out; cannot be switched off later.</label>
      <p className="mute">{editing ? 'Stock quantities are changed under Stock or Purchasing, never here, so the history stays accurate.' : 'After saving, add opening stock under Stock > Adjust, or use Import CSV with opening quantities.'}</p>
      <button className="btn">Save product</button>{' '}<button type="button" className="btn alt" onClick={() => setTab('list')}>Cancel</button></form></div>}
    {tab === 'variants' && <div className="card"><h2>Add variants of one product</h2><p className="mute">For size, colour or flavour. Each variant is its own product with its own stock, price and barcode.</p><form onSubmit={makeVariants}>
      <div className="row"><Field label="Product name (e.g. T-Shirt)" value={vf.groupName} set={v => setVf({ ...vf, groupName: v })} /><Field label="Base SKU (e.g. TS)" value={vf.baseSku} set={v => setVf({ ...vf, baseSku: v })} /></div>
      <div className="row"><Field label="Price for all (KSh)" type="number" value={vf.price} set={v => setVf({ ...vf, price: v })} /><Field label="Cost (KSh)" type="number" value={vf.cost} set={v => setVf({ ...vf, cost: v })} />
        <label>Tax class<select value={vf.taxClassId} onChange={e => setVf({ ...vf, taxClassId: e.target.value })}><option value="">None</option>{taxes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}</select></label></div>
      {vrows.map((v, i) => <div className="row" key={i}><label>Variant {i + 1}<input value={v.label} placeholder="e.g. Small" onChange={e => setVrows(vrows.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} required={i === 0} /></label>
        <label>Barcode (optional)<input value={v.barcode} onChange={e => setVrows(vrows.map((x, j) => j === i ? { ...x, barcode: e.target.value } : x))} /></label><label>Different price (optional)<input type="number" value={v.price} onChange={e => setVrows(vrows.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} /></label></div>)}
      <button type="button" className="btn alt" onClick={() => setVrows([...vrows, { label: '', barcode: '', price: '' }])}>Another variant</button> <button className="btn">Create variants</button></form></div>}
    {tab === 'import' && <div className="card"><h2>Import products from CSV</h2>
      <p className="mute">Columns: sku, name, price (required); cost, barcode, category, unit, reorder_level, opening_qty, group, variant (optional). Opening stock is loaded into the branch selected at the top. If any row has a problem, nothing is imported.</p>
      <button className="btn alt" onClick={() => saveFile('smartbiz-products-template.csv', TEMPLATE)}>Download template</button>
      <label>Choose a CSV file<input type="file" accept=".csv,text/csv" onChange={async e => { const f0 = e.target.files?.[0]; if (f0) setCsv(await f0.text()) }} /></label>
      <label>…or paste CSV here<textarea value={csv} onChange={e => setCsv(e.target.value)} style={{ minHeight: 140, fontFamily: 'monospace' }} /></label>
      <button className="btn" disabled={!csv.trim()} onClick={doImport}>Import</button></div>}
  </>)
}
