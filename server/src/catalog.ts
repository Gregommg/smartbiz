import type { Express } from 'express'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { HttpError, me, need, audit, branchIds, requireBranch, canSeeCost } from './core.js'
import { moveStock } from './stock.js'

const uuid = z.string().uuid()
const esc = (q: string) => '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
const text = (n: number) => z.string().trim().min(1).max(n)
const base = { sku: text(60), barcode: text(60).nullable(), name: text(200), categoryId: uuid.nullable(), unit: text(20), cost: z.number().min(0).max(1e9), price: z.number().min(0).max(1e9), reorderLevel: z.number().min(0).max(1e9),
  groupName: text(100).nullable(), variant: text(100).nullable(), taxClassId: uuid.nullable() }
const createProduct = z.object({ ...base, barcode: base.barcode.optional(), categoryId: base.categoryId.optional(), unit: base.unit.default('pcs'), cost: base.cost.default(0), reorderLevel: base.reorderLevel.default(0),
  groupName: base.groupName.optional(), variant: base.variant.optional(), taxClassId: base.taxClassId.optional(), trackBatches: z.boolean().default(false) })
const patchProduct = z.object(base).partial().extend({ active: z.boolean().optional(), trackBatches: z.boolean().optional() })

const PRODUCT_SQL = (stockIds: string) => `SELECT p.id,p.sku,p.barcode,p.name,p.unit,p.price,CASE WHEN $2 THEN p.cost END AS cost,p.reorder_level,p.active,p.category_id,c.name AS category,
  p.group_name,p.variant,p.tax_class_id,p.track_batches,t.name AS tax_name,t.rate AS tax_rate,
  (SELECT coalesce(sum(s.qty),0) FROM stock_balances s WHERE s.product_id=p.id AND s.branch_id=ANY(${stockIds}::uuid[])) AS stock
  FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN tax_classes t ON t.id=p.tax_class_id`

export function registerCatalog(app: Express) {
  const edit = need('owner', 'manager')
  app.get('/api/categories', async (_q, res) => { res.json((await pool.query('SELECT id,name FROM categories WHERE business_id=$1 ORDER BY name', [me(res).business_id])).rows) })
  app.post('/api/categories', edit, async (req, res) => {
    const u = me(res), b = z.object({ name: text(80) }).parse(req.body)
    res.status(201).json((await pool.query('INSERT INTO categories(business_id,name) VALUES($1,$2) RETURNING id,name', [u.business_id, b.name])).rows[0])
  })
  const category = async (businessId: string, id: string | null | undefined) => {
    if (id && !(await pool.query('SELECT 1 FROM categories WHERE id=$1 AND business_id=$2', [id, businessId])).rowCount) throw new HttpError(400, 'Unknown category')
  }
  const taxClass = async (businessId: string, id: string | null | undefined) => {
    if (id && !(await pool.query('SELECT 1 FROM tax_classes WHERE id=$1 AND business_id=$2', [id, businessId])).rowCount) throw new HttpError(400, 'Unknown tax class')
  }

  app.get('/api/products', async (req, res) => {
    const u = me(res)
    const q = z.object({ q: z.string().max(100).optional(), branchId: uuid.optional(), active: z.enum(['1', '0']).optional(), limit: z.coerce.number().int().min(1).max(1000).catch(200) }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`${PRODUCT_SQL('$3')} WHERE p.business_id=$1 AND ($4::text IS NULL OR p.name ILIKE $4 OR p.sku ILIKE $4 OR p.barcode ILIKE $4 OR p.group_name ILIKE $4)
      AND ($5::boolean IS NULL OR p.active=$5) ORDER BY p.name LIMIT $6`, [u.business_id, canSeeCost(u), ids, q.q ? esc(q.q) : null, q.active ? q.active === '1' : null, q.limit])).rows)
  })
  // Exact barcode / SKU match for scanners at the till.
  app.get('/api/products/lookup', async (req, res) => {
    const u = me(res), q = z.object({ code: text(60), branchId: uuid }).parse(req.query)
    const ids = [await requireBranch(u, q.branchId)]
    const r = (await pool.query(`${PRODUCT_SQL('$3')} WHERE p.business_id=$1 AND p.active AND (p.barcode=$4 OR lower(p.sku)=lower($4)) LIMIT 1`, [u.business_id, canSeeCost(u), ids, q.code])).rows[0]
    if (!r) throw new HttpError(404, 'No product with that barcode or SKU')
    res.json(r)
  })
  const insert = (c: { query: Function }, businessId: string, p: { sku: string; barcode?: string | null; name: string; categoryId?: string | null; unit?: string; cost?: number; price: number; reorderLevel?: number; groupName?: string | null; variant?: string | null; taxClassId?: string | null; trackBatches?: boolean }) =>
    c.query(`INSERT INTO products(business_id,sku,barcode,name,category_id,unit,cost,price,reorder_level,group_name,variant,tax_class_id,track_batches) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [businessId, p.sku, p.barcode ?? null, p.name, p.categoryId ?? null, p.unit ?? 'pcs', p.cost ?? 0, p.price, p.reorderLevel ?? 0, p.groupName ?? null, p.variant ?? null, p.taxClassId ?? null, p.trackBatches ?? false])
  app.post('/api/products', edit, async (req, res) => {
    const u = me(res), b = createProduct.parse(req.body)
    await category(u.business_id, b.categoryId); await taxClass(u.business_id, b.taxClassId)
    const r = (await insert(pool, u.business_id, b)).rows[0]
    await audit(pool, u, 'product.create', 'product', r.id, { sku: b.sku })
    res.status(201).json(r)
  })
  // Several variants of one product (size, colour…) in one go. Each variant is its own product with its own stock, price and barcode.
  app.post('/api/products/variants', edit, async (req, res) => {
    const u = me(res)
    const b = z.object({ groupName: text(100), baseSku: text(40), categoryId: uuid.nullable().optional(), unit: text(20).default('pcs'), price: z.number().min(0).max(1e9), cost: z.number().min(0).max(1e9).default(0), reorderLevel: z.number().min(0).default(0), taxClassId: uuid.nullable().optional(),
      variants: z.array(z.object({ label: text(60), sku: text(60).optional(), barcode: text(60).optional(), price: z.number().min(0).max(1e9).optional(), cost: z.number().min(0).max(1e9).optional() })).min(1).max(100) }).parse(req.body)
    await category(u.business_id, b.categoryId); await taxClass(u.business_id, b.taxClassId)
    const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    const ids = await tx(async c => {
      const out: string[] = []
      for (const v of b.variants) out.push((await insert(c, u.business_id, { sku: v.sku ?? `${b.baseSku}-${slug(v.label)}`, barcode: v.barcode, name: `${b.groupName} - ${v.label}`, categoryId: b.categoryId, unit: b.unit, cost: v.cost ?? b.cost, price: v.price ?? b.price, reorderLevel: b.reorderLevel, groupName: b.groupName, variant: v.label, taxClassId: b.taxClassId })).rows[0].id)
      await audit(c, u, 'product.variants', 'product', b.groupName, { count: out.length })
      return out
    })
    res.status(201).json({ created: ids.length, ids })
  })
  app.patch('/api/products/:id', edit, async (req, res) => {
    const u = me(res), id = uuid.parse(req.params.id), b = patchProduct.parse(req.body)
    await category(u.business_id, b.categoryId); await taxClass(u.business_id, b.taxClassId)
    const old = (await pool.query('SELECT price,cost,track_batches FROM products WHERE id=$1 AND business_id=$2', [id, u.business_id])).rows[0]
    if (!old) throw new HttpError(404, 'Product not found')
    if (b.trackBatches === false && old.track_batches) throw new HttpError(400, 'Batch tracking cannot be switched off once it has been used')
    await tx(async c => {
      await c.query(`UPDATE products SET sku=COALESCE($1,sku), barcode=CASE WHEN $2 THEN $3 ELSE barcode END, name=COALESCE($4,name), category_id=CASE WHEN $5 THEN $6::uuid ELSE category_id END,
        unit=COALESCE($7,unit), cost=COALESCE($8,cost), price=COALESCE($9,price), reorder_level=COALESCE($10,reorder_level), active=COALESCE($11,active),
        group_name=CASE WHEN $13 THEN $14 ELSE group_name END, variant=CASE WHEN $15 THEN $16 ELSE variant END, tax_class_id=CASE WHEN $17 THEN $18::uuid ELSE tax_class_id END WHERE id=$12`,
        [b.sku ?? null, 'barcode' in b, b.barcode ?? null, b.name ?? null, 'categoryId' in b, b.categoryId ?? null, b.unit ?? null, b.cost ?? null, b.price ?? null, b.reorderLevel ?? null, b.active ?? null, id,
          'groupName' in b, b.groupName ?? null, 'variant' in b, b.variant ?? null, 'taxClassId' in b, b.taxClassId ?? null])
      if (b.trackBatches && !old.track_batches) {   // existing stock becomes a "LEGACY" batch so batch totals match the balance
        await c.query('UPDATE products SET track_batches=true WHERE id=$1', [id])
        await c.query(`INSERT INTO stock_batches(product_id,branch_id,batch_no,qty) SELECT product_id,branch_id,'LEGACY',qty FROM stock_balances WHERE product_id=$1 AND qty>0`, [id])
      }
      await audit(c, u, 'product.update', 'product', id, { ...b, old_price: old.price, old_cost: old.cost })
    })
    res.json({ ok: true })
  })
  app.post('/api/products/bulk', edit, async (req, res) => {
    const u = me(res)
    const b = z.object({ branchId: uuid.optional(), rows: z.array(z.object({ sku: text(60), barcode: text(60).optional(), name: text(200), category: text(80).optional(), unit: text(20).optional(), group: text(100).optional(), variant: text(100).optional(),
      cost: z.number().min(0).max(1e9).optional(), price: z.number().min(0).max(1e9), reorderLevel: z.number().min(0).max(1e9).optional(), openingQty: z.number().min(0).max(1e9).optional() })).min(1).max(1000) }).parse(req.body)
    if (b.branchId) await requireBranch(u, b.branchId)
    const errors: string[] = [], seen = new Set<string>(), seenBc = new Set<string>()
    b.rows.forEach((r, i) => {
      const k = r.sku.toLowerCase()
      if (seen.has(k)) errors.push(`Row ${i + 1}: SKU ${r.sku} appears twice in the file`); seen.add(k)
      if (r.barcode) { if (seenBc.has(r.barcode)) errors.push(`Row ${i + 1}: barcode ${r.barcode} appears twice in the file`); seenBc.add(r.barcode) }
      if (r.openingQty && !b.branchId) errors.push(`Row ${i + 1}: choose a branch to load opening stock`)
    })
    const ex = (await pool.query('SELECT sku,barcode FROM products WHERE business_id=$1 AND (lower(sku)=ANY($2::text[]) OR barcode=ANY($3::text[]))', [u.business_id, [...seen], [...seenBc]])).rows
    ex.forEach(r => errors.push(`${r.sku} already exists in your catalogue`))
    if (errors.length) throw new HttpError(400, 'The import has problems; nothing was saved', errors.slice(0, 50))
    await tx(async c => {
      const cats = new Map<string, string>()
      for (const r of b.rows) {
        let cid: string | null = null
        if (r.category) {
          if (!cats.has(r.category)) cats.set(r.category, (await c.query('INSERT INTO categories(business_id,name) VALUES($1,$2) ON CONFLICT (business_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [u.business_id, r.category])).rows[0].id)
          cid = cats.get(r.category)!
        }
        const p = (await insert(c, u.business_id, { sku: r.sku, barcode: r.barcode, name: r.name, categoryId: cid, unit: r.unit, cost: r.cost, price: r.price, reorderLevel: r.reorderLevel, groupName: r.group, variant: r.variant })).rows[0]
        if (r.openingQty && r.openingQty > 0) await moveStock(c, { businessId: u.business_id, branchId: b.branchId!, productId: p.id, qty: r.openingQty, type: 'opening', unitCost: r.cost ?? 0, reason: 'Opening stock (import)', actor: u.id })
      }
      await audit(c, u, 'product.import', 'product', 'bulk', { rows: b.rows.length })
    })
    res.status(201).json({ created: b.rows.length })
  })

  // ---- suppliers and customers ----
  const contact = { name: text(120), phone: text(40).optional(), email: text(200).optional(), address: text(200).optional() }
  app.get('/api/suppliers', need('owner', 'manager', 'storekeeper'), async (_q, res) => { res.json((await pool.query('SELECT id,name,phone,email,address,active FROM suppliers WHERE business_id=$1 ORDER BY name', [me(res).business_id])).rows) })
  app.post('/api/suppliers', need('owner', 'manager', 'storekeeper'), async (req, res) => {
    const u = me(res), b = z.object(contact).parse(req.body)
    const r = (await pool.query('INSERT INTO suppliers(business_id,name,phone,email,address) VALUES($1,$2,$3,$4,$5) RETURNING id', [u.business_id, b.name, b.phone ?? null, b.email ?? null, b.address ?? null])).rows[0]
    await audit(pool, u, 'supplier.create', 'supplier', r.id); res.status(201).json(r)
  })
  app.patch('/api/suppliers/:id', edit, async (req, res) => {
    const b = z.object({ ...contact, name: contact.name.optional(), active: z.boolean().optional() }).parse(req.body)
    const r = await pool.query('UPDATE suppliers SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),address=COALESCE($4,address),active=COALESCE($5,active) WHERE id=$6 AND business_id=$7 RETURNING id',
      [b.name ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.active ?? null, uuid.parse(req.params.id), me(res).business_id])
    if (!r.rowCount) throw new HttpError(404, 'Supplier not found')
    res.json({ ok: true })
  })
  app.get('/api/customers', async (req, res) => {
    const q = z.string().max(100).optional().parse(req.query.q)
    res.json((await pool.query(`SELECT c.id,c.name,c.phone,c.email,c.active,c.credit_limit,coalesce((SELECT sum(amount) FROM customer_ledger l WHERE l.customer_id=c.id),0) AS balance
      FROM customers c WHERE c.business_id=$1 AND ($2::text IS NULL OR c.name ILIKE $2 OR c.phone ILIKE $2) ORDER BY c.name LIMIT 200`, [me(res).business_id, q ? esc(q) : null])).rows)
  })
  app.post('/api/customers', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), b = z.object({ name: contact.name, phone: contact.phone, email: contact.email }).parse(req.body)
    const r = (await pool.query('INSERT INTO customers(business_id,name,phone,email) VALUES($1,$2,$3,$4) RETURNING id,name', [u.business_id, b.name, b.phone ?? null, b.email ?? null])).rows[0]
    res.status(201).json(r)
  })
  app.patch('/api/customers/:id', edit, async (req, res) => {
    const b = z.object({ name: contact.name.optional(), phone: contact.phone, email: contact.email, active: z.boolean().optional(), creditLimit: z.number().min(0).max(1e9).optional() }).parse(req.body)
    const r = await pool.query('UPDATE customers SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),active=COALESCE($4,active),credit_limit=COALESCE($5,credit_limit) WHERE id=$6 AND business_id=$7 RETURNING id',
      [b.name ?? null, b.phone ?? null, b.email ?? null, b.active ?? null, b.creditLimit ?? null, uuid.parse(req.params.id), me(res).business_id])
    if (!r.rowCount) throw new HttpError(404, 'Customer not found')
    await audit(pool, me(res), 'customer.update', 'customer', String(req.params.id), b)
    res.json({ ok: true })
  })
}
