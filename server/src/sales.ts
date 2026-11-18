import type { Express } from 'express'
import { z } from 'zod'
import { pool, tx, type Q } from './db.js'
import { HttpError, me, need, audit, money, branchIds, requireBranch, type U } from './core.js'
import { moveStock, returnAllocations } from './stock.js'
import { dateStr, todayEAT, win } from './time.js'
import { normalisePhone, type Deps } from './billing.js'

const uuid = z.string().uuid()

async function getSale(q: Q, id: string, businessId: string) {
  const s = (await q.query(`SELECT s.id,s.number,s.subtotal,s.discount,s.total,s.tax_total,s.offline,s.created_at,s.branch_id,s.cashier_id,s.customer_id,b.name AS branch,u.name AS cashier,c.name AS customer,c.phone AS customer_phone,biz.name AS business,
      st.legal_name,st.kra_pin,st.address AS business_address,st.phone AS business_phone,st.receipt_footer,coalesce(st.vat_registered,false) AS vat_registered,eq.status AS etims_status
    FROM sales s JOIN branches b ON b.id=s.branch_id JOIN users u ON u.id=s.cashier_id JOIN businesses biz ON biz.id=s.business_id LEFT JOIN customers c ON c.id=s.customer_id
    LEFT JOIN business_settings st ON st.business_id=s.business_id LEFT JOIN etims_queue eq ON eq.sale_id=s.id WHERE s.id=$1 AND s.business_id=$2`, [id, businessId])).rows[0]
  if (!s) return null
  const items = (await q.query('SELECT id,product_id,name,qty,unit_price,line_total,tax_rate,tax_amount,refunded_qty FROM sale_items WHERE sale_id=$1 ORDER BY name,id', [id])).rows
  const payments = (await q.query('SELECT method,amount,tendered,reference FROM sale_payments WHERE sale_id=$1 ORDER BY method', [id])).rows
  const refunds = (await q.query(`SELECT r.id,r.qty,r.amount,r.reason,r.method,r.created_at,a.name AS actor,si.name AS item FROM sale_refunds r JOIN sale_items si ON si.id=r.sale_item_id
    LEFT JOIN users a ON a.id=r.actor_id WHERE r.sale_id=$1 ORDER BY r.created_at`, [id])).rows
  return { ...s, items, payments, refunds }
}
async function visibleSale(u: U, id: string) {
  const s = await getSale(pool, id, u.business_id)
  if (!s || !(await branchIds(u)).includes(s.branch_id) || (u.role === 'cashier' && s.cashier_id !== u.id)) throw new HttpError(404, 'Sale not found')
  return s
}
const balanceOf = async (c: Q, customerId: string) => (await c.query('SELECT coalesce(sum(amount),0) AS b FROM customer_ledger WHERE customer_id=$1', [customerId])).rows[0].b as number

export function registerSales(app: Express, d: Deps) {
  const saleBody = z.object({
    branchId: uuid, customerId: uuid.nullable().optional(), idempotencyKey: z.string().min(8).max(100), offline: z.boolean().optional(), soldAt: z.string().datetime().optional(),
    items: z.array(z.object({ productId: uuid, qty: z.number().positive().max(100000), unitPrice: z.number().min(0).max(1e9).optional() })).min(1).max(200),
    discount: z.number().min(0).max(1e9).default(0),
    payments: z.array(z.object({ method: z.enum(['cash', 'mpesa', 'card', 'bank', 'credit']), amount: z.number().positive().max(1e9), tendered: z.number().positive().max(1e9).optional(),
      reference: z.string().trim().max(60).optional(), mpesaRequestId: uuid.optional() })).min(1).max(4),
  })

  app.post('/api/sales', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), b = saleBody.parse(req.body)
    await requireBranch(u, b.branchId)
    const existing = async () => { const r = (await pool.query('SELECT id FROM sales WHERE business_id=$1 AND idem_key=$2', [u.business_id, b.idempotencyKey])).rows[0]; return r ? getSale(pool, r.id, u.business_id) : null }
    const dup = await existing()
    if (dup) return void res.json(dup)   // the same sale was already recorded (for example a retry after a network drop or an offline sync)
    let soldAt: string | null = null
    if (b.soldAt) {
      const t = Date.parse(b.soldAt)
      if (!b.offline) throw new HttpError(400, 'A sale time can only be supplied for offline sales')
      if (t > Date.now() + 5 * 60e3 || t < Date.now() - 72 * 3600e3) throw new HttpError(400, 'This offline sale is too old or has a time in the future. Ask a manager to record it.')
      soldAt = b.soldAt
    }
    const privileged = u.role !== 'cashier'
    if (!privileged && b.discount > 0) throw new HttpError(403, 'Only a manager or owner can give a discount')
    const settings = (await pool.query('SELECT * FROM business_settings WHERE business_id=$1', [u.business_id])).rows[0]
    const ids = [...new Set(b.items.map(i => i.productId))].sort()
    const prods = (await pool.query(`SELECT p.id,p.name,p.price,p.cost,t.rate AS tax_rate,t.code AS tax_code FROM products p LEFT JOIN tax_classes t ON t.id=p.tax_class_id WHERE p.business_id=$1 AND p.active AND p.id=ANY($2::uuid[])`, [u.business_id, ids])).rows
    if (prods.length !== ids.length) throw new HttpError(400, 'One or more products are unavailable')
    const byId = new Map(prods.map(p => [p.id as string, p]))
    const vat = !!settings?.vat_registered
    const lines = b.items.map(i => {
      const p = byId.get(i.productId)!, price = i.unitPrice ?? (p.price as number)
      if (!privileged && price !== p.price) throw new HttpError(403, 'Only a manager or owner can change a price')
      return { productId: p.id as string, name: p.name as string, qty: i.qty, price, cost: p.cost as number, total: money(i.qty * price), rate: vat ? ((p.tax_rate as number | null) ?? 0) : 0, tax: 0 }
    })
    const subtotal = money(lines.reduce((a, l) => a + l.total, 0))
    if (b.discount > subtotal) throw new HttpError(400, 'The discount cannot be more than the subtotal')
    const total = money(subtotal - b.discount)
    if (total <= 0) throw new HttpError(400, 'The sale total must be greater than zero')
    const factor = total / subtotal
    for (const l of lines) l.tax = l.rate > 0 ? money(money(l.total * factor) * l.rate / (100 + l.rate)) : 0   // prices include VAT; tax is the VAT part of what was actually charged
    const taxTotal = money(lines.reduce((a, l) => a + l.tax, 0))
    const paid = money(b.payments.reduce((a, p) => a + p.amount, 0))
    if (Math.abs(paid - total) > 0.004) throw new HttpError(400, `Payments (${paid}) must add up to the total (${total})`)
    const credit = money(b.payments.filter(p => p.method === 'credit').reduce((a, p) => a + p.amount, 0))
    if (credit > 0 && !b.customerId) throw new HttpError(400, 'Choose the customer to put this on their account')
    for (const p of b.payments) {
      if (p.method === 'mpesa' && !p.mpesaRequestId && (p.reference?.length ?? 0) < 6) throw new HttpError(400, 'Enter the M-Pesa transaction code or use the M-Pesa prompt')
      if (p.mpesaRequestId && p.method !== 'mpesa') throw new HttpError(400, 'An M-Pesa request can only be used for an M-Pesa payment')
      if (p.tendered !== undefined && (p.method !== 'cash' || p.tendered < p.amount)) throw new HttpError(400, 'Cash tendered must be at least the cash amount')
    }
    if (b.customerId && !(await pool.query('SELECT 1 FROM customers WHERE id=$1 AND business_id=$2 AND active', [b.customerId, u.business_id])).rowCount) throw new HttpError(400, 'Unknown customer')
    const session = (await pool.query('SELECT id FROM cash_sessions WHERE branch_id=$1 AND user_id=$2 AND closed_at IS NULL', [b.branchId, u.id])).rows[0]
    if (settings?.require_cash_session && !session && !b.offline) throw new HttpError(409, 'Open your till session first (Cash-up)')
    const wanted = new Map<string, number>()
    for (const l of lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.qty)
    try {
      const saleId = await tx(async c => {
        const bal = (await c.query('SELECT product_id,qty FROM stock_balances WHERE branch_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE', [b.branchId, ids])).rows
        const have = new Map(bal.map(r => [r.product_id as string, r.qty as number]))
        const short = ids.filter(id => (have.get(id) ?? 0) + 1e-9 < wanted.get(id)!).map(id => byId.get(id)!.name)
        if (short.length) throw new HttpError(409, `Not enough stock: ${short.join(', ')}`)
        if (credit > 0) {
          const cu = (await c.query('SELECT credit_limit FROM customers WHERE id=$1 FOR UPDATE', [b.customerId])).rows[0], owes = await balanceOf(c, b.customerId!)
          if (owes + credit > cu.credit_limit + 0.004) throw new HttpError(409, `Credit limit exceeded: limit ${cu.credit_limit}, already owes ${owes}`)
        }
        const n = (await c.query('UPDATE businesses SET sale_seq=sale_seq+1 WHERE id=$1 RETURNING sale_seq', [u.business_id])).rows[0].sale_seq
        const s = (await c.query(`INSERT INTO sales(business_id,branch_id,number,cashier_id,customer_id,subtotal,discount,total,tax_total,idem_key,session_id,offline,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now())) RETURNING id`,
          [u.business_id, b.branchId, n, u.id, b.customerId ?? null, subtotal, b.discount, total, taxTotal, b.idempotencyKey, session?.id ?? null, !!b.offline, soldAt])).rows[0]
        for (const l of lines) await c.query('INSERT INTO sale_items(sale_id,product_id,name,qty,unit_price,unit_cost,line_total,tax_rate,tax_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [s.id, l.productId, l.name, l.qty, l.price, l.cost, l.total, l.rate, l.tax])
        for (const p of b.payments) {
          let ref = p.reference ?? null
          if (p.mpesaRequestId) {   // a payment the customer approved on their phone: it must be paid, large enough, and not used before
            const m = (await c.query("UPDATE till_mpesa SET sale_id=$3, updated_at=now() WHERE id=$1 AND business_id=$2 AND status='paid' AND sale_id IS NULL AND paid_amount >= $4 RETURNING receipt", [p.mpesaRequestId, u.business_id, s.id, p.amount])).rows[0]
            if (!m) throw new HttpError(400, 'That M-Pesa payment was not found, is not paid, is too small, or was already used')
            ref = m.receipt
          }
          await c.query('INSERT INTO sale_payments(sale_id,method,amount,tendered,reference) VALUES($1,$2,$3,$4,$5)', [s.id, p.method, p.amount, p.tendered ?? null, ref])
        }
        if (credit > 0) await c.query(`INSERT INTO customer_ledger(business_id,customer_id,type,amount,ref_id,branch_id,created_by) VALUES($1,$2,'sale',$3,$4,$5,$6)`, [u.business_id, b.customerId, credit, s.id, b.branchId, u.id])
        for (const id of ids) await moveStock(c, { businessId: u.business_id, branchId: b.branchId, productId: id, qty: -wanted.get(id)!, type: 'sale', unitCost: byId.get(id)!.cost, refType: 'sale', refId: s.id, actor: u.id })
        if (settings?.etims_enabled) {   // internal invoice data for the (not yet connected) KRA eTIMS route
          const payload = { receiptNumber: n, soldAt: soldAt ?? new Date().toISOString(), seller: { name: settings.legal_name, kraPin: settings.kra_pin }, buyerId: b.customerId ?? null,
            items: lines.map(l => ({ name: l.name, qty: l.qty, unitPrice: l.price, total: l.total, taxRate: l.rate, tax: l.tax })), subtotal, discount: b.discount, total, tax: taxTotal, payments: b.payments.map(p => ({ method: p.method, amount: p.amount })) }
          await c.query('INSERT INTO etims_queue(business_id,sale_id,payload) VALUES($1,$2,$3)', [u.business_id, s.id, JSON.stringify(payload)])
        }
        await audit(c, u, b.offline ? 'sale.create_offline' : 'sale.create', 'sale', s.id, { number: n, total })
        return s.id as string
      })
      res.status(201).json(await getSale(pool, saleId, u.business_id))
    } catch (e: any) {
      if (e?.code === '23505' && String(e.constraint ?? '').includes('idem_key')) { const again = await existing(); if (again) return void res.json(again) }
      throw e
    }
  })

  app.get('/api/sales', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), today = todayEAT()
    const q = z.object({ from: dateStr.default(today), to: dateStr.default(today), branchId: uuid.optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT s.id,s.number,s.total,s.offline,s.created_at,b.name AS branch,u.name AS cashier,c.name AS customer,
      EXISTS (SELECT 1 FROM sale_refunds r WHERE r.sale_id=s.id) AS has_refund, eq.status AS etims_status
      FROM sales s JOIN branches b ON b.id=s.branch_id JOIN users u ON u.id=s.cashier_id LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN etims_queue eq ON eq.sale_id=s.id
      WHERE s.business_id=$1 AND s.branch_id=ANY($2::uuid[]) AND ($3::boolean OR s.cashier_id=$4) AND ${win('s.created_at', 5, 6)} ORDER BY s.created_at DESC LIMIT 200`,
      [u.business_id, ids, u.role !== 'cashier', u.id, q.from, q.to])).rows)
  })
  app.get('/api/sales/:id', need('owner', 'manager', 'cashier'), async (req, res) => { res.json(await visibleSale(me(res), uuid.parse(req.params.id))) })

  app.post('/api/sales/:id/receipt-sms', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), sale = await visibleSale(u, uuid.parse(req.params.id)), b = z.object({ phone: z.string().max(20).optional() }).parse(req.body)
    if (!(await pool.query('SELECT 1 FROM business_settings WHERE business_id=$1 AND sms_receipts', [u.business_id])).rowCount) throw new HttpError(400, 'SMS receipts are switched off in Settings')
    const phone = normalisePhone(b.phone ?? sale.customer_phone ?? '')
    if ((await pool.query("SELECT count(*)::int AS n FROM sms_log WHERE business_id=$1 AND created_at > now() - interval '1 day'", [u.business_id])).rows[0].n >= 300) throw new HttpError(429, 'Daily SMS limit reached')
    const r = await d.sms.send(phone, `${sale.business} receipt #${String(sale.number).padStart(6, '0')}: KSh ${sale.total.toFixed(2)}. Thank you!`)
    await pool.query('INSERT INTO sms_log(business_id,sale_id,phone,ok,detail) VALUES($1,$2,$3,$4,$5)', [u.business_id, sale.id, phone, r.ok, r.error ?? r.id ?? null])
    if (!r.ok) throw new HttpError(502, 'The SMS could not be sent. ' + (r.error ?? ''))
    res.json({ ok: true })
  })

  app.post('/api/sales/:id/refund', need('owner', 'manager'), async (req, res) => {
    const u = me(res), sale = await visibleSale(u, uuid.parse(req.params.id))
    const b = z.object({ reason: z.string().trim().min(3).max(200), method: z.enum(['cash', 'mpesa', 'card', 'bank', 'credit']).default('cash'),
      items: z.array(z.object({ saleItemId: uuid, qty: z.number().positive().max(100000) })).min(1).max(200) }).parse(req.body)
    if (b.method === 'credit' && !sale.customer_id) throw new HttpError(400, 'Only sales to a named customer can be refunded to their account')
    const out = await tx(async c => {
      let total = 0
      for (const line of b.items) {
        const it = (await c.query('SELECT si.*, s.total AS sale_total, s.subtotal AS sale_subtotal FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.id=$1 AND si.sale_id=$2 FOR UPDATE OF si', [line.saleItemId, sale.id])).rows[0]
        if (!it) throw new HttpError(400, 'Unknown item on this sale')
        if (line.qty > it.qty - it.refunded_qty + 1e-9) throw new HttpError(400, `You cannot refund more than was sold of ${it.name}`)
        const amount = money(line.qty * it.unit_price * (it.sale_total / it.sale_subtotal)), tax = money(it.tax_amount * line.qty / it.qty)   // refund the price actually paid after any order discount
        total = money(total + amount)
        await c.query('INSERT INTO sale_refunds(sale_id,sale_item_id,business_id,branch_id,qty,amount,tax,reason,method,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [sale.id, it.id, u.business_id, sale.branch_id, line.qty, amount, tax, b.reason, b.method, u.id])
        await c.query('UPDATE sale_items SET refunded_qty=refunded_qty+$1 WHERE id=$2', [line.qty, it.id])
        await moveStock(c, { businessId: u.business_id, branchId: sale.branch_id, productId: it.product_id, qty: line.qty, type: 'sale_return', unitCost: it.unit_cost, refType: 'sale', refId: sale.id, reason: b.reason, actor: u.id,
          returnTo: await returnAllocations(c, sale.id, it.product_id, line.qty) })
      }
      if (b.method === 'credit') await c.query(`INSERT INTO customer_ledger(business_id,customer_id,type,amount,ref_id,branch_id,created_by,note) VALUES($1,$2,'refund',$3,$4,$5,$6,$7)`, [u.business_id, sale.customer_id, -total, sale.id, sale.branch_id, u.id, b.reason])
      await audit(c, u, 'sale.refund', 'sale', sale.id, { total, reason: b.reason })
      return total
    })
    res.status(201).json({ refunded: out })
  })

  // ---- expenses ----
  app.get('/api/expenses', need('owner', 'manager'), async (req, res) => {
    const u = me(res), today = todayEAT()
    const q = z.object({ from: dateStr.default(today.slice(0, 8) + '01'), to: dateStr.default(today), branchId: uuid.optional() }).parse(req.query)
    const ids = q.branchId ? [await requireBranch(u, q.branchId)] : await branchIds(u)
    res.json((await pool.query(`SELECT e.id,e.category,e.amount,e.method,e.note,e.spent_on,b.name AS branch,a.name AS by FROM expenses e JOIN branches b ON b.id=e.branch_id LEFT JOIN users a ON a.id=e.created_by
      WHERE e.business_id=$1 AND e.branch_id=ANY($2::uuid[]) AND e.spent_on BETWEEN $3::date AND $4::date ORDER BY e.spent_on DESC,e.created_at DESC LIMIT 300`, [u.business_id, ids, q.from, q.to])).rows)
  })
  app.post('/api/expenses', need('owner', 'manager'), async (req, res) => {
    const u = me(res)
    const b = z.object({ branchId: uuid, category: z.string().trim().min(1).max(60), amount: z.number().positive().max(1e9), method: z.enum(['cash', 'mpesa', 'bank', 'card']), note: z.string().trim().max(200).optional(), spentOn: dateStr.default(todayEAT()) }).parse(req.body)
    await requireBranch(u, b.branchId)
    const r = (await pool.query('INSERT INTO expenses(business_id,branch_id,category,amount,method,note,spent_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [u.business_id, b.branchId, b.category, b.amount, b.method, b.note ?? null, b.spentOn, u.id])).rows[0]
    await audit(pool, u, 'expense.create', 'expense', r.id, { amount: b.amount, category: b.category })
    res.status(201).json(r)
  })
}
