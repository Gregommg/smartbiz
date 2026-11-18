import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool, tx, type Q } from './db.js'
import { HttpError, me, need, audit, money, branchIds, requireBranch, canSeeCost } from './core.js'
import { todayEAT } from './time.js'

const uuid = z.string().uuid()
const esc = (q: string) => '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
export type Batch = { batchNo: string; expiry?: string | null }
export type Alloc = { batchId: string | null; qty: number }
type Move = { businessId: string; branchId: string; productId: string; qty: number; type: string; unitCost?: number | null; refType?: string; refId?: string; reason?: string; actor?: string
  batch?: Batch; batchId?: string; allowExpired?: boolean; returnTo?: Alloc[] }

/** The only way stock changes: updates the balance and appends immutable ledger rows. The balance can never go below zero (database check).
 *  Products that track batches also move batch quantities: first-expiry-first-out on the way out, never selling expired batches. */
export async function moveStock(c: Q, o: Move): Promise<Alloc[]> {
  if (o.qty > 0) await c.query(`INSERT INTO stock_balances(product_id,branch_id,qty) VALUES($1,$2,$3) ON CONFLICT (product_id,branch_id) DO UPDATE SET qty=stock_balances.qty+EXCLUDED.qty`, [o.productId, o.branchId, o.qty])
  else {   // a negative amount can only come out of an existing balance; the database check stops it going below zero
    const r = await c.query('UPDATE stock_balances SET qty=qty+$3 WHERE product_id=$1 AND branch_id=$2', [o.productId, o.branchId, o.qty])
    if (!r.rowCount) throw new HttpError(409, 'Not enough stock for this change')
  }
  const tracked = (await c.query('SELECT track_batches FROM products WHERE id=$1', [o.productId])).rows[0]?.track_batches as boolean
  let allocs: Alloc[] = []
  if (!tracked) allocs = [{ batchId: null, qty: o.qty }]
  else if (o.qty > 0) {
    if (o.returnTo?.length) { for (const a of o.returnTo) { await c.query('UPDATE stock_batches SET qty=qty+$2 WHERE id=$1', [a.batchId, a.qty]); allocs.push(a) } }
    else {
      if (!o.batch?.batchNo?.trim()) throw new HttpError(400, 'Enter the batch number for this product')
      const id = (await c.query(`INSERT INTO stock_batches(product_id,branch_id,batch_no,expiry_date,qty) VALUES($1,$2,$3,$4,$5) ON CONFLICT (product_id,branch_id,batch_no)
        DO UPDATE SET qty=stock_batches.qty+EXCLUDED.qty, expiry_date=COALESCE(stock_batches.expiry_date,EXCLUDED.expiry_date) RETURNING id`, [o.productId, o.branchId, o.batch.batchNo.trim(), o.batch.expiry || null, o.qty])).rows[0].id
      allocs = [{ batchId: id, qty: o.qty }]
    }
  } else {
    let left = -o.qty
    const rows = (await c.query(`SELECT id,qty FROM stock_batches WHERE product_id=$1 AND branch_id=$2 AND qty>0 AND ($3::uuid IS NULL OR id=$3)
      AND ($4::boolean OR expiry_date IS NULL OR expiry_date >= $5::date) ORDER BY expiry_date NULLS LAST, created_at FOR UPDATE`, [o.productId, o.branchId, o.batchId ?? null, !!o.allowExpired, todayEAT()])).rows
    for (const r of rows) {
      if (left <= 1e-9) break
      const take = Math.min(left, r.qty as number)
      await c.query('UPDATE stock_batches SET qty=qty-$2 WHERE id=$1', [r.id, take]); allocs.push({ batchId: r.id, qty: -take }); left -= take
    }
    if (left > 1e-9) throw new HttpError(409, 'Not enough sellable stock (the rest may be expired or in another batch)')
  }
  for (const a of allocs) await c.query(`INSERT INTO stock_movements(business_id,branch_id,product_id,type,qty,unit_cost,ref_type,ref_id,reason,actor_id,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [o.businessId, o.branchId, o.productId, o.type, a.qty, o.unitCost ?? null, o.refType ?? null, o.refId ?? null, o.reason ?? null, o.actor ?? null, a.batchId])
  return allocs
}
/** For a refund: put goods back into the batches they were sold from. Returns [] for products that do not track batches. */
export async function returnAllocations(c: Q, saleId: string, productId: string, qty: number): Promise<Alloc[]> {
  const rows = (await c.query(`SELECT t.batch_id, t.taken - coalesce(r.ret,0) AS room FROM
    (SELECT batch_id, sum(-qty) AS taken, min(id) AS first FROM stock_movements WHERE ref_id=$1 AND product_id=$2 AND type='sale' AND batch_id IS NOT NULL GROUP BY batch_id) t
    LEFT JOIN (SELECT batch_id, sum(qty) AS ret FROM stock_movements WHERE ref_id=$1 AND product_id=$2 AND type='sale_return' AND batch_id IS NOT NULL GROUP BY batch_id) r ON r.batch_id=t.batch_id ORDER BY t.first`, [saleId, productId])).rows
  const out: Alloc[] = []; let left = qty
  for (const r of rows) { if (left <= 1e-9) break; const take = Math.min(left, r.room as number); if (take > 0) { out.push({ batchId: r.batch_id, qty: take }); left -= take } }
  return out
}
const productOk = async (businessId: string, id: string) => {
  const p = (await pool.query('SELECT id,name,track_batches FROM products WHERE id=$1 AND business_id=$2', [id, businessId])).rows[0]
  if (!p) throw new HttpError(400, 'Unknown product')
  return p as { id: string; name: string; track_batches: boolean }
}
const batchIn = z.object({ batchNo: z.string().trim().min(1).max(60), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })

export function registerStock(app: Express) {
  app.get('/api/stock', async (req, res) => {
    const u = me(res)
    const q = z.object({ branchId: uuid.optional(), low: z.enum(['1', '0']).optional(), q: z.string().max(100).optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT p.id AS product_id,p.sku,p.name,p.unit,p.reorder_level,p.track_batches,sb.branch_id,b.name AS branch,sb.qty,CASE WHEN $3 THEN sb.qty*p.cost END AS value
      FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN branches b ON b.id=sb.branch_id
      WHERE p.business_id=$1 AND sb.branch_id=ANY($2::uuid[]) AND ($4::text IS NULL OR p.name ILIKE $4 OR p.sku ILIKE $4) AND ($5::boolean IS FALSE OR (p.reorder_level>0 AND sb.qty<=p.reorder_level))
      ORDER BY p.name,b.name LIMIT 500`, [u.business_id, ids, canSeeCost(u), q.q ? esc(q.q) : null, q.low === '1'])).rows)
  })
  app.get('/api/stock/batches', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res), q = z.object({ productId: uuid, branchId: uuid }).parse(req.query); await requireBranch(u, q.branchId)
    res.json((await pool.query(`SELECT b.id,b.batch_no,b.expiry_date,b.qty FROM stock_batches b JOIN products p ON p.id=b.product_id WHERE p.business_id=$1 AND b.product_id=$2 AND b.branch_id=$3 AND b.qty>0 ORDER BY b.expiry_date NULLS LAST`, [u.business_id, q.productId, q.branchId])).rows)
  })
  app.get('/api/stock/expiry', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res), q = z.object({ days: z.coerce.number().int().min(0).max(365).catch(30), branchId: uuid.optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT b.id,p.name,p.sku,br.name AS branch,b.batch_no,b.expiry_date,b.qty,CASE WHEN $4 THEN b.qty*p.cost END AS value,(b.expiry_date < $3::date) AS expired
      FROM stock_batches b JOIN products p ON p.id=b.product_id JOIN branches br ON br.id=b.branch_id
      WHERE p.business_id=$1 AND b.branch_id=ANY($2::uuid[]) AND b.qty>0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ($3::date + $5::int) ORDER BY b.expiry_date LIMIT 200`, [u.business_id, ids, todayEAT(), canSeeCost(u), q.days])).rows)
  })
  app.get('/api/stock/movements', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res), q = z.object({ productId: uuid.optional(), branchId: uuid.optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT m.id,m.type,m.qty,m.unit_cost,m.reason,m.created_at,p.name AS product,b.name AS branch,a.name AS actor,sb.batch_no
      FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN branches b ON b.id=m.branch_id LEFT JOIN users a ON a.id=m.actor_id LEFT JOIN stock_batches sb ON sb.id=m.batch_id
      WHERE m.business_id=$1 AND m.branch_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR m.product_id=$3) ORDER BY m.id DESC LIMIT 100`, [u.business_id, ids, q.productId ?? null])).rows)
  })
  app.post('/api/stock/adjust', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res)
    const b = z.object({ branchId: uuid, productId: uuid, qty: z.number().refine(n => n !== 0, 'Quantity cannot be zero').refine(n => Math.abs(n) <= 1e7), reason: z.string().trim().min(3).max(200),
      batchNo: z.string().trim().max(60).optional(), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), batchId: uuid.optional() }).parse(req.body)
    await requireBranch(u, b.branchId); await productOk(u.business_id, b.productId)
    await tx(async c => {
      await moveStock(c, { businessId: u.business_id, branchId: b.branchId, productId: b.productId, qty: b.qty, type: 'adjustment', reason: b.reason, actor: u.id,
        batch: b.batchNo ? { batchNo: b.batchNo, expiry: b.expiry } : undefined, batchId: b.batchId, allowExpired: true })   // write-offs may remove expired stock
      await audit(c, u, 'stock.adjust', 'product', b.productId, { branch: b.branchId, qty: b.qty, reason: b.reason })
    })
    res.status(201).json({ ok: true })
  })
  app.post('/api/stock/transfer', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res)
    const b = z.object({ fromBranchId: uuid, toBranchId: uuid, productId: uuid, qty: z.number().positive().max(1e7), note: z.string().trim().max(200).optional() }).parse(req.body)
    if (b.fromBranchId === b.toBranchId) throw new HttpError(400, 'Choose two different branches')
    await requireBranch(u, b.fromBranchId); await requireBranch(u, b.toBranchId); await productOk(u.business_id, b.productId)
    const ref = randomUUID()
    await tx(async c => {
      const base = { businessId: u.business_id, productId: b.productId, refType: 'transfer', refId: ref, reason: b.note, actor: u.id }
      const out = await moveStock(c, { ...base, branchId: b.fromBranchId, qty: -b.qty, type: 'transfer_out' })
      for (const a of out) {
        const info = a.batchId ? (await c.query('SELECT batch_no,expiry_date FROM stock_batches WHERE id=$1', [a.batchId])).rows[0] : null
        await moveStock(c, { ...base, branchId: b.toBranchId, qty: -a.qty, type: 'transfer_in', batch: info ? { batchNo: info.batch_no, expiry: info.expiry_date ? new Date(info.expiry_date).toISOString().slice(0, 10) : null } : undefined })
      }
      await audit(c, u, 'stock.transfer', 'product', b.productId, { from: b.fromBranchId, to: b.toBranchId, qty: b.qty })
    })
    res.status(201).json({ ok: true })
  })

  // ---- purchasing ----
  const buy = need('owner', 'manager', 'storekeeper')
  app.post('/api/purchase-orders', buy, async (req, res) => {
    const u = me(res)
    const b = z.object({ branchId: uuid, supplierId: uuid, notes: z.string().trim().max(300).optional(),
      items: z.array(z.object({ productId: uuid, qty: z.number().positive().max(1e7), unitCost: z.number().min(0).max(1e9) })).min(1).max(200) }).parse(req.body)
    await requireBranch(u, b.branchId)
    if (!(await pool.query('SELECT 1 FROM suppliers WHERE id=$1 AND business_id=$2 AND active', [b.supplierId, u.business_id])).rowCount) throw new HttpError(400, 'Unknown supplier')
    const ids = [...new Set(b.items.map(i => i.productId))]
    if ((await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id=$1 AND id=ANY($2::uuid[])', [u.business_id, ids])).rows[0].n !== ids.length) throw new HttpError(400, 'Unknown product')
    const po = await tx(async c => {
      const n = (await c.query('UPDATE businesses SET po_seq=po_seq+1 WHERE id=$1 RETURNING po_seq', [u.business_id])).rows[0].po_seq
      const r = (await c.query('INSERT INTO purchase_orders(business_id,branch_id,supplier_id,number,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,number', [u.business_id, b.branchId, b.supplierId, n, b.notes ?? null, u.id])).rows[0]
      for (const i of b.items) await c.query('INSERT INTO purchase_items(po_id,product_id,qty_ordered,unit_cost) VALUES($1,$2,$3,$4)', [r.id, i.productId, i.qty, i.unitCost])
      await audit(c, u, 'po.create', 'purchase_order', r.id, { number: n })
      return r
    })
    res.status(201).json(po)
  })
  app.get('/api/purchase-orders', buy, async (req, res) => {
    const u = me(res), st = z.enum(['ordered', 'partial', 'received', 'cancelled']).optional().parse(req.query.status)
    res.json((await pool.query(`SELECT po.id,po.number,po.status,po.created_at,s.name AS supplier,po.supplier_id,b.name AS branch,(SELECT sum(qty_ordered*unit_cost) FROM purchase_items WHERE po_id=po.id) AS total
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id
      WHERE po.business_id=$1 AND po.branch_id=ANY($2::uuid[]) AND ($3::text IS NULL OR po.status=$3) ORDER BY po.number DESC LIMIT 200`, [u.business_id, await branchIds(u), st ?? null])).rows)
  })
  const loadPo = async (u: ReturnType<typeof me>, id: string) => {
    const po = (await pool.query(`SELECT po.id,po.number,po.status,po.notes,po.created_at,po.branch_id,s.name AS supplier,b.name AS branch FROM purchase_orders po
      JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.id=$1 AND po.business_id=$2`, [id, u.business_id])).rows[0]
    if (!po) throw new HttpError(404, 'Purchase order not found')
    await requireBranch(u, po.branch_id)
    return po
  }
  app.get('/api/purchase-orders/:id', buy, async (req, res) => {
    const po = await loadPo(me(res), uuid.parse(req.params.id))
    const items = (await pool.query(`SELECT i.id,i.product_id,p.sku,p.name,p.track_batches,i.qty_ordered,i.qty_received,i.unit_cost FROM purchase_items i JOIN products p ON p.id=i.product_id WHERE i.po_id=$1 ORDER BY p.name`, [po.id])).rows
    res.json({ ...po, items })
  })
  app.post('/api/purchase-orders/:id/receive', buy, async (req, res) => {
    const u = me(res), po0 = await loadPo(u, uuid.parse(req.params.id))
    const b = z.object({ items: z.array(z.object({ itemId: uuid, qty: z.number().positive().max(1e7), batchNo: batchIn.shape.batchNo.optional(), expiry: batchIn.shape.expiry })).min(1).max(200) }).parse(req.body)
    const status = await tx(async c => {
      const po = (await c.query('SELECT id,status,branch_id FROM purchase_orders WHERE id=$1 FOR UPDATE', [po0.id])).rows[0]
      if (po.status === 'cancelled' || po.status === 'received') throw new HttpError(400, `This purchase order is already ${po.status}`)
      for (const line of b.items) {
        const it = (await c.query('SELECT * FROM purchase_items WHERE id=$1 AND po_id=$2 FOR UPDATE', [line.itemId, po.id])).rows[0]
        if (!it) throw new HttpError(400, 'Unknown item on this purchase order')
        if (line.qty > it.qty_ordered - it.qty_received + 1e-9) throw new HttpError(400, 'You cannot receive more than was ordered')
        const have = (await c.query('SELECT coalesce(sum(qty),0) AS q FROM stock_balances WHERE product_id=$1', [it.product_id])).rows[0].q as number
        const cost = (await c.query('SELECT cost FROM products WHERE id=$1 FOR UPDATE', [it.product_id])).rows[0].cost as number
        const avg = have > 0 ? money((have * cost + line.qty * it.unit_cost) / (have + line.qty)) : it.unit_cost   // weighted-average cost
        await c.query('UPDATE products SET cost=$1 WHERE id=$2', [avg, it.product_id])
        await moveStock(c, { businessId: u.business_id, branchId: po.branch_id, productId: it.product_id, qty: line.qty, type: 'purchase', unitCost: it.unit_cost, refType: 'purchase_order', refId: po.id, actor: u.id,
          batch: line.batchNo ? { batchNo: line.batchNo, expiry: line.expiry } : undefined })
        await c.query('UPDATE purchase_items SET qty_received=qty_received+$1 WHERE id=$2', [line.qty, it.id])
      }
      const done = (await c.query('SELECT bool_and(qty_received >= qty_ordered) AS done FROM purchase_items WHERE po_id=$1', [po.id])).rows[0].done
      const st = done ? 'received' : 'partial'
      await c.query('UPDATE purchase_orders SET status=$1 WHERE id=$2', [st, po.id])
      await audit(c, u, 'po.receive', 'purchase_order', po.id, { status: st })
      return st
    })
    res.json({ status })
  })
  app.post('/api/purchase-orders/:id/cancel', buy, async (req, res) => {
    const u = me(res), po = await loadPo(u, uuid.parse(req.params.id))
    if (po.status !== 'ordered') throw new HttpError(400, 'Only orders with nothing received can be cancelled')
    await pool.query("UPDATE purchase_orders SET status='cancelled' WHERE id=$1", [po.id])
    await audit(pool, u, 'po.cancel', 'purchase_order', po.id)
    res.json({ ok: true })
  })
}
