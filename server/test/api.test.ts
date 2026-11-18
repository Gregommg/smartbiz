import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import EmbeddedPostgres from 'embedded-postgres'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { totpAt } from '../src/totp.js'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

let pg: EmbeddedPostgres
let api: ReturnType<typeof request>
let db: typeof import('../src/db.js')
const S: Record<string, any> = {}
const PW = 'longenough1'
const CB = 'cbsecret-123456'
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const mails: { to: string[]; subject: string; text: string }[] = []
let mailFail = false
const mailer = async (to: string[], subject: string, text: string) => { if (mailFail) throw new Error('SMTP connect timeout'); mails.push({ to, subject, text }) }
const stk: any[] = []
const till: { creds: any; a: any }[] = []
const mpesa = { async stkPush(a: any) { stk.push(a); return { checkoutRequestId: 'ws_CO_' + stk.length } }, async stkPushFor(creds: any, a: any) { till.push({ creds, a }); return { checkoutRequestId: 'till_CO_' + till.length } } }
const smsSent: { to: string; message: string }[] = []
const sms = { async send(to: string, message: string) { if (to.endsWith('9999')) return { ok: false, error: 'InvalidPhoneNumber' }; smsSent.push({ to, message }); return { ok: true, id: 'sms1' } } }
let etimsMode: 'ok' | 'fail' | 'off' = 'off'
const submitted: any[] = []
const etims = { async ping() { return etimsMode === 'ok' }, async submit(p: any) { submitted.push(p); if (etimsMode === 'ok') return { ok: true, response: { receiptNo: 'KRA-1' } }; if (etimsMode === 'fail') return { ok: false, error: 'KRA timeout' }; return { ok: false, notConnected: true, error: 'not connected' } } }
const cb = (id: string, code: number, amount: number) => api.post(`/api/mpesa/callback/${CB}`).send({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: code,
  CallbackMetadata: code === 0 ? { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'QWE123XYZ' }] } : undefined } } })
let n = 0
const key = () => `key-${++n}-${Math.random().toString(36).slice(2, 10)}`
const login = (email: string, password = PW) => api.post('/api/auth/login').send({ email, password })
const cookieOf = (r: any) => (r.headers['set-cookie'] as string[])[0].split(';')[0]

async function register(businessName: string, email: string, planCode?: string) {
  const r = await api.post('/api/auth/register').send({ businessName, name: 'Owner', email, password: PW, ...(planCode ? { planCode } : {}) })
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.token as string
}
async function join(owner: string, email: string, role: string, branchIds: string[]) {
  const r = await api.post('/api/invites').set(auth(owner)).send({ email, role, branchIds })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const token = mails.filter(m => m.to.includes(email)).at(-1)!.text.match(/token=([\w-]+)/)![1]
  const a = await api.post('/api/auth/accept-invite').send({ token, name: role, password: PW })
  assert.equal(a.status, 201, JSON.stringify(a.body))
  return { token: a.body.token as string, id: (await api.get('/api/me').set(auth(a.body.token))).body.id as string }
}
const mkProduct = (tok: string, b: object) => api.post('/api/products').set(auth(tok)).send(b)
const sell = (tok: string, branchId: string, items: object[], payments: object[], extra: object = {}) =>
  api.post('/api/sales').set(auth(tok)).send({ branchId, items, payments, idempotencyKey: key(), ...extra })
const stockOf = async (tok: string, branchId: string, productId: string) =>
  ((await api.get(`/api/stock?branchId=${branchId}`).set(auth(tok))).body.find((r: any) => r.product_id === productId)?.qty ?? 0) as number

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pg-')), user: 'sb', password: 'sb', port: 54340, persistent: false })
  await pg.initialise(); await pg.start(); await pg.createDatabase('smartbiz')
  Object.assign(process.env, { DATABASE_URL: 'postgres://sb:sb@localhost:54340/smartbiz', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', MPESA_CALLBACK_SECRET: CB, APP_URL: 'http://app.test' })
  db = await import('../src/db.js'); await db.migrate()
  api = request((await import('../src/app.js')).createApp({ mailer, mpesa, sms, etims }))
})
after(async () => { await db.pool.end(); await pg.stop() })

test('registration, login, sessions and plan validation', async () => {
  const bad = (b: object) => api.post('/api/auth/register').send({ businessName: 'X', name: 'X', email: 'x@x.co', password: PW, ...b })
  assert.equal((await bad({ planCode: 'nope' })).status, 400); assert.equal((await bad({ password: 'short' })).status, 400); assert.equal((await bad({ email: 'nope' })).status, 400)
  S.O = await register('Shop A', 'o@a.co', 'growth'); S.B = await register('Shop B', 'o@b.co', 'starter')
  assert.equal((await bad({ email: 'o@a.co' })).status, 409)
  const me = (await api.get('/api/me').set(auth(S.O))).body
  assert.equal(me.role, 'owner'); assert.equal(me.sub.state, 'trialing'); assert.equal(me.branches.length, 1); S.b1 = me.branches[0].id
  assert.equal((await login('o@a.co', 'wrong-password')).status, 401); assert.equal((await api.get('/api/products')).status, 401)
  const l = await login('o@a.co'); const cookie = cookieOf(l)
  assert.match((l.headers['set-cookie'] as string[])[0], /HttpOnly/i)
  const r = await api.post('/api/auth/refresh').set('Cookie', cookie); assert.equal(r.status, 200)
  assert.equal((await api.get('/api/me').set(auth(r.body.token))).status, 200)
  await api.post('/api/auth/logout').set('Cookie', cookie); assert.equal((await api.post('/api/auth/refresh').set('Cookie', cookie)).status, 401)
  assert.equal((await api.get('/api/plans')).body.length, 3)
})

test('branches, staff invitations and plan limits', async () => {
  const w = await api.post('/api/branches').set(auth(S.O)).send({ name: 'Westlands' }); assert.equal(w.status, 201); S.b2 = w.body.id
  assert.equal((await api.post('/api/branches').set(auth(S.B)).send({ name: 'Second' })).status, 402)   // Starter plan: 1 branch
  assert.equal((await api.post('/api/invites').set(auth(S.O)).send({ email: 'x@a.co', role: 'cashier', branchIds: ['00000000-0000-4000-8000-000000000000'] })).status, 400)
  S.M = await join(S.O, 'm@a.co', 'manager', [S.b1, S.b2]); S.C = await join(S.O, 'c@a.co', 'cashier', [S.b1]); S.K = await join(S.O, 'k@a.co', 'storekeeper', [S.b1])
  assert.equal((await api.post('/api/invites').set(auth(S.M.token)).send({ email: 'z@a.co', role: 'cashier', branchIds: [S.b1] })).status, 403)
  assert.equal((await api.post('/api/invites').set(auth(S.O)).send({ email: 'c@a.co', role: 'cashier', branchIds: [S.b1] })).status, 409)
  assert.equal((await api.get('/api/me').set(auth(S.C.token))).body.branches.length, 1)
  assert.equal((await api.get('/api/users').set(auth(S.C.token))).status, 403)
  assert.equal((await api.get('/api/branches').set(auth(S.C.token))).body.length, 1)
  await join(S.B, 'e1@b.co', 'cashier', (await api.get('/api/branches').set(auth(S.B))).body.map((x: any) => x.id)); await join(S.B, 'e2@b.co', 'cashier', (await api.get('/api/branches').set(auth(S.B))).body.map((x: any) => x.id))
  assert.equal((await api.post('/api/invites').set(auth(S.B)).send({ email: 'e3@b.co', role: 'cashier', branchIds: (await api.get('/api/branches').set(auth(S.B))).body.map((x: any) => x.id) })).status, 402)  // Starter: 3 users
})

test('catalogue: permissions, hidden cost for cashiers, duplicates, barcode lookup', async () => {
  const sug = await mkProduct(S.M.token, { sku: 'SUG1', barcode: '6001', name: 'Sugar 1kg', price: 200, cost: 150, reorderLevel: 0 }); assert.equal(sug.status, 201); S.p1 = sug.body.id
  const mlk = await mkProduct(S.M.token, { sku: 'MLK', name: 'Milk 500ml', price: 60, cost: 40, reorderLevel: 10 }); S.p2 = mlk.body.id
  assert.equal((await mkProduct(S.M.token, { sku: 'SUG1', name: 'Dup', price: 1 })).status, 409)
  assert.equal((await mkProduct(S.M.token, { sku: 'X', barcode: '6001', name: 'Dup barcode', price: 1 })).status, 409)
  assert.equal((await mkProduct(S.C.token, { sku: 'Z', name: 'Z', price: 1 })).status, 403)
  assert.equal((await mkProduct(S.M.token, { sku: 'NEG', name: 'Neg', price: -5 })).status, 400)
  const asCashier = (await api.get(`/api/products?branchId=${S.b1}`).set(auth(S.C.token))).body; assert.equal(asCashier.length, 2); assert.ok(asCashier.every((p: any) => p.cost === null || p.cost === undefined))
  assert.equal((await api.get('/api/products').set(auth(S.M.token))).body.find((p: any) => p.sku === 'SUG1').cost, 150)
  assert.equal((await api.get(`/api/products/lookup?code=6001&branchId=${S.b1}`).set(auth(S.C.token))).body.name, 'Sugar 1kg')
  assert.equal((await api.get(`/api/products/lookup?code=sug1&branchId=${S.b1}`).set(auth(S.C.token))).status, 200)
  assert.equal((await api.get(`/api/products/lookup?code=nope&branchId=${S.b1}`).set(auth(S.C.token))).status, 404)
  assert.equal((await api.get(`/api/products?q=milk`).set(auth(S.C.token))).body.length, 1)
  assert.equal((await api.patch(`/api/products/${S.p1}`).set(auth(S.C.token)).send({ price: 1 })).status, 403)
  assert.equal((await api.post('/api/categories').set(auth(S.M.token)).send({ name: 'Groceries' })).status, 201)
})

test('bulk import is all-or-nothing and loads opening stock', async () => {
  const row = (o: object) => ({ sku: 'N1', name: 'New', price: 10, ...o })
  const imp = (rows: object[], branchId?: string) => api.post('/api/products/bulk').set(auth(S.M.token)).send({ rows, branchId })
  const bad = await imp([row({ sku: 'A1' }), row({ sku: 'a1' }), row({ sku: 'SUG1' }), row({ sku: 'A2', openingQty: 5 })]); assert.equal(bad.status, 400)
  assert.ok(bad.body.details.length >= 3); assert.equal((await api.get('/api/products?q=A1').set(auth(S.M.token))).body.length, 0)
  const ok = await imp([row({ sku: 'P3', name: 'Rice 2kg', price: 20, cost: 10, category: 'Groceries', reorderLevel: 10, openingQty: 5 })], S.b1); assert.equal(ok.status, 201)
  S.p3 = (await api.get('/api/products?q=P3').set(auth(S.M.token))).body[0].id
  assert.equal(await stockOf(S.M.token, S.b1, S.p3), 5)
  assert.equal((await api.get(`/api/stock/movements?productId=${S.p3}`).set(auth(S.M.token))).body[0].type, 'opening')
})

test('stock ledger: adjustments, no negative stock, transfers, append-only history', async () => {
  const adj = (tok: string, b: object) => api.post('/api/stock/adjust').set(auth(tok)).send(b)
  assert.equal((await adj(S.K.token, { branchId: S.b1, productId: S.p1, qty: 100, reason: 'Opening count' })).status, 201)
  assert.equal(await stockOf(S.K.token, S.b1, S.p1), 100)
  assert.equal((await adj(S.K.token, { branchId: S.b1, productId: S.p1, qty: -1000, reason: 'Too much' })).status, 409)
  assert.equal((await adj(S.K.token, { branchId: S.b1, productId: S.p1, qty: 0, reason: 'zero' })).status, 400)
  assert.equal((await adj(S.K.token, { branchId: S.b1, productId: S.p1, qty: -1 })).status, 400)
  assert.equal((await adj(S.C.token, { branchId: S.b1, productId: S.p1, qty: 5, reason: 'no way' })).status, 403)
  assert.equal((await adj(S.K.token, { branchId: S.b2, productId: S.p1, qty: 5, reason: 'wrong branch' })).status, 403)
  assert.equal((await adj(S.K.token, { branchId: S.b1, productId: S.p1, qty: -4, reason: 'Damaged' })).status, 201); assert.equal(await stockOf(S.K.token, S.b1, S.p1), 96)
  const tr = (tok: string, b: object) => api.post('/api/stock/transfer').set(auth(tok)).send({ fromBranchId: S.b1, toBranchId: S.b2, productId: S.p1, ...b })
  assert.equal((await tr(S.K.token, { qty: 10 })).status, 403)
  assert.equal((await tr(S.M.token, { qty: 1000 })).status, 409)
  assert.equal((await tr(S.M.token, { qty: 16 })).status, 201)
  assert.equal(await stockOf(S.M.token, S.b1, S.p1), 80); assert.equal(await stockOf(S.M.token, S.b2, S.p1), 16)
  assert.equal((await api.post('/api/stock/transfer').set(auth(S.M.token)).send({ fromBranchId: S.b1, toBranchId: S.b1, productId: S.p1, qty: 1 })).status, 400)
  await assert.rejects(db.pool.query("UPDATE stock_movements SET qty=999 WHERE type='adjustment'"), /append-only/)
  await assert.rejects(db.pool.query('DELETE FROM stock_movements'), /append-only/)
  assert.equal((await api.get('/api/stock/movements').set(auth(S.C.token))).status, 403)
})

test('purchasing: partial receipts, weighted-average cost, limits', async () => {
  const sup = await api.post('/api/suppliers').set(auth(S.K.token)).send({ name: 'Bidco', phone: '0700111222' }); assert.equal(sup.status, 201)
  const po = (items: object[]) => api.post('/api/purchase-orders').set(auth(S.K.token)).send({ branchId: S.b1, supplierId: sup.body.id, items })
  const a = await po([{ productId: S.p2, qty: 100, unitCost: 50 }]); assert.equal(a.status, 201); assert.equal(a.body.number, 1)
  const itemId = (await api.get(`/api/purchase-orders/${a.body.id}`).set(auth(S.K.token))).body.items[0].id
  const rec = (id: string, qty: number) => api.post(`/api/purchase-orders/${a.body.id}/receive`).set(auth(S.K.token)).send({ items: [{ itemId: id, qty }] })
  assert.equal((await rec(itemId, 40)).body.status, 'partial'); assert.equal(await stockOf(S.K.token, S.b1, S.p2), 40)
  assert.equal((await rec(itemId, 61)).status, 400)
  assert.equal((await api.post(`/api/purchase-orders/${a.body.id}/cancel`).set(auth(S.K.token))).status, 400)
  assert.equal((await rec(itemId, 60)).body.status, 'received'); assert.equal(await stockOf(S.K.token, S.b1, S.p2), 100)
  assert.equal((await rec(itemId, 1)).status, 400)
  const b = await po([{ productId: S.p2, qty: 100, unitCost: 60 }]); const itemB = (await api.get(`/api/purchase-orders/${b.body.id}`).set(auth(S.K.token))).body.items[0].id
  assert.equal((await api.post(`/api/purchase-orders/${b.body.id}/receive`).set(auth(S.K.token)).send({ items: [{ itemId: itemB, qty: 100 }] })).body.status, 'received')
  assert.equal((await api.get('/api/products?q=MLK').set(auth(S.M.token))).body[0].cost, 55)   // (100*50 + 100*60) / 200
  assert.equal((await po([{ productId: S.p2, qty: 5, unitCost: 1 }, { productId: '00000000-0000-4000-8000-000000000000', qty: 1, unitCost: 1 }])).status, 400)
  const c = await po([{ productId: S.p2, qty: 1, unitCost: 1 }]); assert.equal((await api.post(`/api/purchase-orders/${c.body.id}/cancel`).set(auth(S.K.token))).status, 200)
  assert.equal((await api.get('/api/purchase-orders').set(auth(S.C.token))).status, 403)
  assert.equal((await api.get('/api/purchase-orders').set(auth(S.B))).body.length, 0)
})

test('point of sale: totals, payments, permissions, stock checks, idempotency', async () => {
  const items = [{ productId: S.p1, qty: 2 }, { productId: S.p2, qty: 3 }]
  assert.equal((await sell(S.C.token, S.b1, items, [{ method: 'cash', amount: 400 }])).status, 400)                         // does not add up
  assert.equal((await sell(S.C.token, S.b1, items, [{ method: 'mpesa', amount: 580 }])).status, 400)                       // no M-Pesa code
  assert.equal((await sell(S.C.token, S.b1, items, [{ method: 'cash', amount: 560 }], { discount: 20 })).status, 403)       // cashier discount
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1, unitPrice: 1 }], [{ method: 'cash', amount: 1 }])).status, 403)
  assert.equal((await sell(S.C.token, S.b2, items, [{ method: 'cash', amount: 580 }])).status, 403)                          // no access to branch 2
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 500 }], [{ method: 'cash', amount: 100000 }])).status, 409)
  assert.equal((await sell(S.K.token, S.b1, items, [{ method: 'cash', amount: 580 }])).status, 403)                          // storekeepers cannot sell
  assert.equal(await stockOf(S.M.token, S.b1, S.p1), 80)
  const k = key()
  const s1 = await api.post('/api/sales').set(auth(S.C.token)).send({ branchId: S.b1, items, payments: [{ method: 'cash', amount: 580, tendered: 1000 }], idempotencyKey: k })
  assert.equal(s1.status, 201, JSON.stringify(s1.body)); assert.equal(s1.body.number, 1); assert.equal(s1.body.total, 580); assert.equal(s1.body.items.length, 2)
  assert.ok(s1.body.items.every((i: any) => i.unit_cost === undefined))
  const again = await api.post('/api/sales').set(auth(S.C.token)).send({ branchId: S.b1, items, payments: [{ method: 'cash', amount: 580, tendered: 1000 }], idempotencyKey: k })
  assert.equal(again.status, 200); assert.equal(again.body.id, s1.body.id)
  assert.equal(await stockOf(S.M.token, S.b1, S.p1), 78); assert.equal(await stockOf(S.M.token, S.b1, S.p2), 197)
  S.s1 = s1.body
  const s2 = await sell(S.M.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'mpesa', amount: 180, reference: 'QWE123ABCD' }], { discount: 20 })
  assert.equal(s2.status, 201); assert.equal(s2.body.total, 180); S.s2 = s2.body
  const [x, y] = await Promise.all([ // two tills race for the last 5 units of Rice
    sell(S.C.token, S.b1, [{ productId: S.p3, qty: 4 }], [{ method: 'cash', amount: 80 }]), sell(S.M.token, S.b1, [{ productId: S.p3, qty: 4 }], [{ method: 'cash', amount: 80 }])])
  assert.deepEqual([x.status, y.status].sort(), [201, 409]); assert.equal(await stockOf(S.M.token, S.b1, S.p3), 1)
  assert.equal((await api.patch(`/api/products/${S.p3}`).set(auth(S.M.token)).send({ active: false })).status, 200)
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p3, qty: 1 }], [{ method: 'cash', amount: 20 }])).status, 400)
  assert.equal((await api.patch(`/api/products/${S.p3}`).set(auth(S.M.token)).send({ active: true })).status, 200)
})

test('sales history and receipts respect roles, branches and businesses', async () => {
  const mine = (await api.get('/api/sales').set(auth(S.C.token))).body; assert.ok(mine.length >= 1 && mine.every((s: any) => s.cashier === 'cashier'))
  assert.ok((await api.get('/api/sales').set(auth(S.M.token))).body.length > mine.length - 1)
  assert.equal((await api.get(`/api/sales/${S.s2.id}`).set(auth(S.C.token))).status, 404)   // another cashier's sale
  assert.equal((await api.get(`/api/sales/${S.s1.id}`).set(auth(S.C.token))).status, 200)
  assert.equal((await api.get(`/api/sales/${S.s1.id}`).set(auth(S.B)).catch(() => ({ status: 0 }))).status, 404)
  assert.equal((await api.get('/api/sales?from=bad').set(auth(S.M.token))).status, 400)
})

test('refunds: manager only, restocks, cannot exceed what was sold', async () => {
  const item = S.s1.items.find((i: any) => i.product_id === S.p1).id
  const rf = (tok: string, b: object) => api.post(`/api/sales/${S.s1.id}/refund`).set(auth(tok)).send({ reason: 'Customer returned', items: [{ saleItemId: item, qty: 1 }], ...b })
  assert.equal((await rf(S.C.token, {})).status, 403)
  assert.equal((await rf(S.M.token, { reason: 'x' })).status, 400)
  assert.equal((await rf(S.M.token, { items: [{ saleItemId: item, qty: 5 }] })).status, 400)
  const ok = await rf(S.M.token, {}); assert.equal(ok.status, 201); assert.equal(ok.body.refunded, 200)
  assert.equal(await stockOf(S.M.token, S.b1, S.p1), 78)   // 78 before the sale of s2 (1 sold) + 1 returned
  assert.equal((await rf(S.M.token, { items: [{ saleItemId: item, qty: 2 }] })).status, 400)   // only 1 of 2 left to refund
  const detail = (await api.get(`/api/sales/${S.s1.id}`).set(auth(S.M.token))).body
  assert.equal(detail.refunds.length, 1); assert.equal(detail.items.find((i: any) => i.id === item).refunded_qty, 1)
})

test('expenses and reports: net sales, margin, profit, stock value, low stock', async () => {
  const ex = (tok: string, b: object = {}) => api.post('/api/expenses').set(auth(tok)).send({ branchId: S.b1, category: 'Transport', amount: 30, method: 'cash', ...b })
  assert.equal((await ex(S.C.token)).status, 403); assert.equal((await ex(S.K.token)).status, 403); assert.equal((await ex(S.M.token, { amount: 0 })).status, 400); assert.equal((await ex(S.M.token)).status, 201)
  assert.equal((await api.get('/api/expenses').set(auth(S.M.token))).body.length, 1)
  const r = (await api.get('/api/reports/summary').set(auth(S.M.token))).body, s = r.summary
  assert.equal(s.transactions, 3)    // s1, s2 and the one rice sale that won the race
  assert.equal(s.refunds, 200)
  // s1 580 + s2 180 + rice 80 = 840 gross; net 640; COGS: s1 465 + s2 150 + rice 40 = 655, minus refunded 150 = 505
  assert.equal(s.gross_sales, 840); assert.equal(s.net_sales, 640); assert.equal(s.cost_of_goods, 505); assert.equal(s.gross_margin, 135)
  assert.equal(s.expenses, 30); assert.equal(s.estimated_profit, 105); assert.equal(s.margin_pct, 21)
  const m = Object.fromEntries(r.byMethod.map((x: any) => [x.label, x.n])); assert.equal(m.cash, 460); assert.equal(m.mpesa, 180)   // cash: 580 + 80 - 200 refunded
  assert.equal(r.series.length, 1); assert.equal(r.series[0].sales, 640); assert.equal(r.series[0].margin, 135)
  const sugar = r.topProducts.find((p: any) => p.name === 'Sugar 1kg'); assert.equal(sugar.qty, 2); assert.equal(sugar.revenue, 380); assert.equal(sugar.margin, 80)
  assert.ok(r.byCashier.length >= 2); assert.ok(r.lowStock.some((l: any) => l.sku === 'P3'))
  const sv = (await db.pool.query("SELECT sum(sb.qty*p.cost) AS v FROM stock_balances sb JOIN products p ON p.id=sb.product_id JOIN branches b ON b.id=sb.branch_id WHERE b.business_id=(SELECT business_id FROM users WHERE email='o@a.co')")).rows[0].v
  assert.equal(s.stock_value, Number(sv))
  assert.equal((await api.get('/api/reports/summary').set(auth(S.C.token))).status, 403); assert.equal((await api.get('/api/reports/summary').set(auth(S.K.token))).status, 403)
  assert.equal((await api.get('/api/reports/summary?from=2026-12-31&to=2026-01-01').set(auth(S.M.token))).status, 400)
  assert.equal((await api.get('/api/reports/summary').set(auth(S.B))).body.summary.net_sales, 0)
  assert.equal((await api.get(`/api/reports/summary?branchId=${S.b2}`).set(auth(S.M.token))).body.summary.net_sales, 0)
  assert.equal((await api.get(`/api/reports/summary?branchId=${S.b2}`).set(auth(S.C.token))).status, 403)
})

test('business isolation: another business cannot read or use this business data', async () => {
  assert.equal((await api.get('/api/products').set(auth(S.B))).body.length, 0)
  const bBranch = (await api.get('/api/branches').set(auth(S.B))).body[0].id
  assert.equal((await sell(S.B, bBranch, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }])).status, 400)
  assert.equal((await api.post('/api/stock/adjust').set(auth(S.B)).send({ branchId: bBranch, productId: S.p1, qty: 5, reason: 'steal' })).status, 400)
  assert.equal((await api.post('/api/stock/adjust').set(auth(S.B)).send({ branchId: S.b1, productId: S.p1, qty: 5, reason: 'steal' })).status, 403)
  assert.equal((await api.patch(`/api/products/${S.p1}`).set(auth(S.B)).send({ price: 1 })).status, 404)
  assert.equal((await api.get('/api/stock').set(auth(S.B))).body.length, 0)
  assert.equal((await api.get(`/api/stock?branchId=${S.b1}`).set(auth(S.B))).status, 403)
  assert.equal((await api.get('/api/audit').set(auth(S.M.token))).status, 403)
  const log = (await api.get('/api/audit').set(auth(S.O))).body
  for (const a of ['business.register', 'invite.create', 'user.join', 'product.create', 'stock.adjust', 'stock.transfer', 'po.receive', 'sale.create', 'sale.refund', 'expense.create']) assert.ok(log.some((l: any) => l.action === a), 'missing audit ' + a)
})

test('owner manages people: roles, branches, disable, temporary password, reset link', async () => {
  const U = await join(S.O, 'u@a.co', 'cashier', [S.b1])
  assert.equal((await api.patch(`/api/users/${U.id}`).set(auth(S.M.token)).send({ role: 'manager' })).status, 403)
  assert.equal((await api.patch(`/api/users/${U.id}`).set(auth(S.O)).send({ role: 'storekeeper', branchIds: [S.b1, S.b2] })).status, 200)
  assert.deepEqual((await api.get('/api/users').set(auth(S.O))).body.find((u: any) => u.id === U.id).branch_ids.sort(), [S.b1, S.b2].sort())
  const ownerId = (await api.get('/api/me').set(auth(S.O))).body.id
  assert.equal((await api.patch(`/api/users/${ownerId}`).set(auth(S.O)).send({ active: false })).status, 400)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.M.token)).send({ password: 'Temporary-pass-1' })).status, 403)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.O)).send({ password: 'short' })).status, 400)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.O)).send({ password: 'Temporary-pass-1' })).status, 200)
  assert.equal((await api.get('/api/me').set(auth(U.token))).status, 401)
  const t = (await login('u@a.co', 'Temporary-pass-1')).body.token
  assert.equal((await api.get('/api/products').set(auth(t))).status, 403)
  const done = await api.post('/api/auth/change-password').set(auth(t)).send({ current: 'Temporary-pass-1', password: 'my-own-new-pass-7' }); assert.equal(done.status, 200)
  assert.equal((await api.get('/api/products').set(auth(done.body.token))).status, 200)
  assert.equal((await api.post(`/api/users/${U.id}/reset-link`).set(auth(S.O))).status, 200)
  const link = mails.filter(m => m.to.includes('u@a.co')).at(-1)!.text.match(/token=([\w-]+)/)![1]
  assert.equal((await api.post('/api/auth/reset').send({ token: link, password: 'after-reset-pass-3' })).status, 200); assert.equal((await login('u@a.co', 'after-reset-pass-3')).status, 200)
  assert.equal((await api.patch(`/api/users/${U.id}`).set(auth(S.O)).send({ active: false })).status, 200); assert.equal((await login('u@a.co', 'after-reset-pass-3')).status, 401)
  assert.equal((await api.post(`/api/users/${ownerId}/password`).set(auth(S.O)).send({ password: 'Temporary-pass-1' })).status, 400)
})

test('subscription: grace keeps selling, expiry makes it read-only, billing and password change stay open', async () => {
  const setEnd = (iv: string) => db.pool.query(`UPDATE businesses SET period_end=now()-interval '${iv}' WHERE name='Shop A'`)
  const sale = () => sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }])
  await setEnd('3 days'); assert.equal((await api.get('/api/me').set(auth(S.O))).body.sub.state, 'grace'); assert.equal((await sale()).status, 201)
  await setEnd('30 days'); assert.equal((await api.get('/api/me').set(auth(S.O))).body.sub.state, 'suspended')
  assert.equal((await sale()).status, 402); assert.equal((await mkProduct(S.M.token, { sku: 'LATE', name: 'Late', price: 1 })).status, 402)
  assert.equal((await api.get('/api/products').set(auth(S.M.token))).status, 200); assert.equal((await api.get('/api/billing').set(auth(S.O))).status, 200)
  assert.equal((await api.post('/api/auth/change-password').set(auth(S.M.token)).send({ current: PW, password: 'a-new-manager-pass1' })).status, 200)
  S.M.token = (await login('m@a.co', 'a-new-manager-pass1')).body.token
})

test('M-Pesa subscription payment: STK push, callback security, amount check, idempotency', async () => {
  const co = (b: object) => api.post('/api/billing/checkout').set(auth(S.O)).send(b)
  assert.equal((await co({ planCode: 'starter', months: 1, phone: '0712345678' })).status, 400)    // 2 branches, 5 users: too many for Starter
  assert.equal((await co({ planCode: 'business', months: 3, phone: '0712345678' })).status, 400)
  assert.equal((await co({ planCode: 'business', months: 1, phone: '12345' })).status, 400)
  assert.equal((await api.post('/api/billing/checkout').set(auth(S.M.token)).send({ planCode: 'growth', months: 1, phone: '0712345678' })).status, 403)
  const c1 = await co({ planCode: 'growth', months: 1, phone: '0712 345 678' }); assert.equal(c1.status, 201)
  assert.equal(stk.at(-1).phone, '254712345678'); assert.equal(stk.at(-1).amount, 12000)
  assert.equal((await api.post('/api/mpesa/callback/wrong').send({})).status, 404)
  const id1 = 'ws_CO_' + stk.length; await cb(id1, 0, 100)
  assert.equal((await api.get(`/api/billing/payments/${c1.body.paymentId}`).set(auth(S.O))).body.status, 'failed')
  const c2 = await co({ planCode: 'growth', months: 1, phone: '254712345678' }); const id2 = 'ws_CO_' + stk.length; await cb(id2, 0, 12000)
  assert.equal((await api.get(`/api/billing/payments/${c2.body.paymentId}`).set(auth(S.O))).body.status, 'paid')
  const b = (await api.get('/api/billing').set(auth(S.O))).body; assert.equal(b.state, 'active'); assert.ok(new Date(b.period_end) > new Date())
  await cb(id2, 0, 12000); assert.equal((await api.get('/api/billing').set(auth(S.O))).body.period_end, b.period_end)
  assert.equal((await mkProduct(S.M.token, { sku: 'BACK', name: 'Back in business', price: 1 })).status, 201)
})

test('platform admin: sees all businesses, records manual payments, manages owner passwords only', async () => {
  const biz = (await db.pool.query("INSERT INTO businesses(name,paid,period_end) VALUES('OnyxTech Platform',true,now()+interval '100 years') RETURNING id")).rows[0]
  await db.pool.query("INSERT INTO users(business_id,name,email,password_hash,role,is_platform) VALUES($1,'Plat','p@onyx.co',$2,'owner',true)", [biz.id, await bcrypt.hash(PW, 4)])
  const P = (await login('p@onyx.co')).body.token
  assert.equal((await api.get('/api/platform/businesses').set(auth(S.O))).status, 403)
  const list = (await api.get('/api/platform/businesses').set(auth(P))).body; const b = list.find((x: any) => x.name === 'Shop B')
  assert.equal(b.state, 'trialing'); assert.equal(b.branches, 1)
  assert.equal((await api.post(`/api/platform/businesses/${b.id}/payments`).set(auth(S.B)).send({ planCode: 'starter', months: 1, amount: 1500, reference: 'x' })).status, 403)
  assert.equal((await api.post(`/api/platform/businesses/${b.id}/payments`).set(auth(P)).send({ planCode: 'starter', months: 12, amount: 18000, reference: 'Bank ref 889' })).status, 201)
  assert.equal((await api.get('/api/billing').set(auth(S.B))).body.state, 'active')
  assert.equal((await api.patch('/api/platform/plans/starter').set(auth(P)).send({ price_month: 1800 })).status, 200)
  const owners = (await api.get(`/api/platform/businesses/${b.id}/owners`).set(auth(P))).body; assert.deepEqual(owners.map((o: any) => o.email), ['o@b.co'])
  const cashierId = (await api.get('/api/users').set(auth(S.B))).body.find((u: any) => u.role === 'cashier').id
  assert.equal((await api.post(`/api/platform/users/${cashierId}/password`).set(auth(P)).send({ password: 'Temporary-pass-2' })).status, 404)
  assert.equal((await api.post(`/api/platform/users/${owners[0].id}/password`).set(auth(S.O)).send({ password: 'Temporary-pass-2' })).status, 403)
  assert.equal((await api.post(`/api/platform/users/${owners[0].id}/password`).set(auth(P)).send({ password: 'Temporary-pass-2' })).status, 200)
  assert.equal((await api.get('/api/me').set(auth(S.B))).status, 401); assert.equal((await api.get('/api/products').set(auth((await login('o@b.co', 'Temporary-pass-2')).body.token))).status, 403)
})

// ====================================================================== v2 features
import { decrypt } from '../src/secrets.js'
const ymd = (d: number) => new Date(Date.now() + d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
const putSettings = (o: object = {}) => api.put('/api/settings').set(auth(S.O)).send({ legalName: 'Shop A Ltd', kraPin: 'A123456789Z', address: 'Langata', phone: '0700000000', receiptFooter: 'Thank you', vatRegistered: false, etimsEnabled: false, requireCashSession: false, smsReceipts: false, ...o })
const stockAdd = (tok: string, branch: string, product: string, qty: number, extra: object = {}) => api.post('/api/stock/adjust').set(auth(tok)).send({ branchId: branch, productId: product, qty, reason: 'Stock count', ...extra })
const batchesOf = async (tok: string, branch: string, product: string) => (await api.get(`/api/stock/batches?productId=${product}&branchId=${branch}`).set(auth(tok))).body as any[]

test('MFA: authenticator codes, replay protection, recovery codes, owner reset', async () => {
  const setup = await api.post('/api/auth/mfa/setup').set(auth(S.O)); const secret = setup.body.secret
  assert.match(setup.body.otpauth, /^otpauth:\/\/totp\//)
  assert.equal((await api.post('/api/auth/mfa/enable').set(auth(S.O)).send({ code: '000000' })).status, 400)
  const t0 = Date.now(), en = await api.post('/api/auth/mfa/enable').set(auth(S.O)).send({ code: totpAt(secret, t0) })
  assert.equal(en.status, 200); assert.equal(en.body.recoveryCodes.length, 8)
  assert.notEqual((await db.pool.query("SELECT mfa_secret_enc FROM users WHERE email='o@a.co'")).rows[0].mfa_secret_enc, secret)   // stored encrypted
  const l = await login('o@a.co'); assert.equal(l.body.mfaRequired, true); assert.ok(!l.headers['set-cookie'] && !l.body.token)
  const verify = (code: string, tok = l.body.mfaToken) => api.post('/api/auth/mfa/verify').send({ mfaToken: tok, code })
  assert.equal((await verify('123456')).status, 401)
  assert.equal((await verify(totpAt(secret, t0))).status, 401)   // the code used to enable it cannot be used again
  assert.equal((await verify('123456', S.O)).status, 401)        // an ordinary access token is not an MFA token
  const ok = await verify(totpAt(secret, t0 + 30000)); assert.equal(ok.status, 200)
  assert.equal((await api.get('/api/me').set(auth(ok.body.token))).body.mfa_enabled, true)
  assert.equal((await verify(totpAt(secret, t0 + 30000))).status, 401)   // replay refused
  assert.equal((await verify(en.body.recoveryCodes[0])).status, 200); assert.equal((await verify(en.body.recoveryCodes[0])).status, 401)   // recovery code works once
  assert.equal((await api.post('/api/auth/mfa/disable').set(auth(S.O)).send({ password: 'wrong-password', code: en.body.recoveryCodes[1] })).status, 400)
  assert.equal((await api.post('/api/auth/mfa/disable').set(auth(S.O)).send({ password: PW, code: en.body.recoveryCodes[1] })).status, 200)
  assert.ok((await login('o@a.co')).body.token)
  const ks = (await api.post('/api/auth/mfa/setup').set(auth(S.K.token))).body.secret
  await api.post('/api/auth/mfa/enable').set(auth(S.K.token)).send({ code: totpAt(ks) })
  assert.equal((await login('k@a.co')).body.mfaRequired, true)
  assert.equal((await api.post(`/api/users/${S.K.id}/mfa-reset`).set(auth(S.M.token))).status, 403)
  assert.equal((await api.post(`/api/users/${S.K.id}/mfa-reset`).set(auth(S.O))).status, 200); assert.ok((await login('k@a.co')).body.token)
})

test('VAT: tax classes, VAT included in prices, per-line tax, refunds reduce VAT collected', async () => {
  assert.equal((await putSettings({ kraPin: 'bad-pin' })).status, 400)
  assert.equal((await api.put('/api/settings').set(auth(S.M.token)).send({})).status, 403)
  const classes = (await api.get('/api/tax-classes').set(auth(S.M.token))).body; const std = classes.find((c: any) => c.code === 'STD'); assert.equal(std.rate, 16)
  assert.equal((await api.patch(`/api/tax-classes/${std.id}`).set(auth(S.M.token)).send({ rate: 5 })).status, 403)
  const p = await mkProduct(S.M.token, { sku: 'VAT1', name: 'Taxed item', price: 116, cost: 60, taxClassId: std.id }); S.vat = p.body.id
  await stockAdd(S.K.token, S.b1, S.vat, 20)
  const before = await sell(S.C.token, S.b1, [{ productId: S.vat, qty: 1 }], [{ method: 'cash', amount: 116 }]); assert.equal(before.body.tax_total, 0)   // not VAT registered yet
  assert.equal((await putSettings({ vatRegistered: true })).status, 200)
  const s1 = await sell(S.C.token, S.b1, [{ productId: S.vat, qty: 1 }], [{ method: 'cash', amount: 116 }])
  assert.equal(s1.body.tax_total, 16); assert.equal(s1.body.items[0].tax_rate, 16); assert.equal(s1.body.vat_registered, true); assert.equal(s1.body.kra_pin, 'A123456789Z')
  const s2 = await sell(S.M.token, S.b1, [{ productId: S.vat, qty: 1 }], [{ method: 'cash', amount: 100 }], { discount: 16 }); assert.equal(s2.body.tax_total, 13.79)   // tax on what was actually charged
  const item = s2.body.items[0].id
  assert.equal((await api.post(`/api/sales/${s2.body.id}/refund`).set(auth(S.M.token)).send({ reason: 'Returned', items: [{ saleItemId: item, qty: 1 }] })).status, 201)
  const r = (await api.get('/api/reports/summary').set(auth(S.M.token))).body.summary; assert.equal(r.vat_collected, 16)
  const untaxed = await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }]); assert.equal(untaxed.body.tax_total, 0)
})

test('variants: created together, own stock and price, all-or-nothing', async () => {
  const mk = (tok: string, variants: object[]) => api.post('/api/products/variants').set(auth(tok)).send({ groupName: 'T-Shirt', baseSku: 'TS', price: 500, cost: 200, variants })
  assert.equal((await mk(S.C.token, [{ label: 'Small' }])).status, 403)
  const ok = await mk(S.M.token, [{ label: 'Small' }, { label: 'Large', price: 550 }, { label: 'Red / Large', barcode: '7770001' }]); assert.equal(ok.status, 201); assert.equal(ok.body.created, 3)
  const list = (await api.get('/api/products?q=T-Shirt').set(auth(S.M.token))).body
  assert.equal(list.length, 3); assert.ok(list.every((p: any) => p.group_name === 'T-Shirt')); assert.ok(list.some((p: any) => p.sku === 'TS-SMALL' && p.variant === 'Small'))
  assert.equal(list.find((p: any) => p.variant === 'Large').price, 550)
  assert.equal((await mk(S.M.token, [{ label: 'Medium' }, { label: 'Small' }])).status, 409)   // TS-SMALL exists: nothing is created
  assert.equal((await api.get('/api/products?q=T-Shirt').set(auth(S.M.token))).body.length, 3)
})

test('batches and expiry: first-expiry-first-out, expired stock never sold, refunds return to the same batches', async () => {
  const pan = (await mkProduct(S.M.token, { sku: 'PAN', name: 'Panadol', price: 50, cost: 20, trackBatches: true })).body.id; S.pan = pan
  assert.equal((await stockAdd(S.K.token, S.b1, pan, 10)).status, 400)   // batch number required
  for (const [no, d, q] of [['EXP', -1, 5], ['SOON', 10, 5], ['LATE', 200, 10]] as const) assert.equal((await stockAdd(S.K.token, S.b1, pan, q, { batchNo: no, expiry: ymd(d) })).status, 201)
  assert.equal(await stockOf(S.M.token, S.b1, pan), 20)
  const rep = (await api.get('/api/stock/expiry?days=30').set(auth(S.K.token))).body
  assert.deepEqual(rep.map((r: any) => r.batch_no), ['EXP', 'SOON']); assert.equal(rep[0].expired, true); assert.equal(rep[1].expired, false)
  const sale = await sell(S.C.token, S.b1, [{ productId: pan, qty: 12 }], [{ method: 'cash', amount: 600 }]); assert.equal(sale.status, 201)
  assert.deepEqual((await batchesOf(S.K.token, S.b1, pan)).map(b => [b.batch_no, b.qty]), [['EXP', 5], ['LATE', 3]])   // SOON sold first, then LATE; EXP untouched
  assert.equal((await sell(S.C.token, S.b1, [{ productId: pan, qty: 4 }], [{ method: 'cash', amount: 200 }])).status, 409)   // 8 in stock but only 3 sellable
  assert.equal(await stockOf(S.M.token, S.b1, pan), 8)
  assert.equal((await api.post(`/api/sales/${sale.body.id}/refund`).set(auth(S.M.token)).send({ reason: 'Wrong item', items: [{ saleItemId: sale.body.items[0].id, qty: 12 }] })).status, 201)
  assert.deepEqual((await batchesOf(S.K.token, S.b1, pan)).map(b => [b.batch_no, b.qty]), [['EXP', 5], ['SOON', 5], ['LATE', 10]])   // back where they came from
  assert.equal((await api.post('/api/stock/transfer').set(auth(S.M.token)).send({ fromBranchId: S.b1, toBranchId: S.b2, productId: pan, qty: 2 })).status, 201)
  const dest = await batchesOf(S.M.token, S.b2, pan); assert.deepEqual(dest.map(b => [b.batch_no, b.qty]), [['SOON', 2]]); assert.equal(String(dest[0].expiry_date).slice(0, 10), ymd(10))
  const expId = (await batchesOf(S.K.token, S.b1, pan)).find(b => b.batch_no === 'EXP').id
  assert.equal((await stockAdd(S.K.token, S.b1, pan, -5, { batchId: expId, reason: 'Expired, destroyed' })).status, 201)   // writing off expired stock is allowed
  const inv = (await db.pool.query('SELECT sb.qty, (SELECT coalesce(sum(qty),0) FROM stock_batches b WHERE b.product_id=sb.product_id AND b.branch_id=sb.branch_id) AS bsum FROM stock_balances sb WHERE sb.product_id=$1', [pan])).rows
  assert.ok(inv.length === 2 && inv.every(r => r.qty === r.bsum))   // batch totals always equal the stock balance
  assert.equal((await api.patch(`/api/products/${S.p3}`).set(auth(S.M.token)).send({ trackBatches: true })).status, 200)
  assert.deepEqual((await batchesOf(S.K.token, S.b1, S.p3)).map(b => b.batch_no), ['LEGACY'])
  assert.equal((await api.patch(`/api/products/${S.p3}`).set(auth(S.M.token)).send({ trackBatches: false })).status, 400)
  const sup = (await api.post('/api/suppliers').set(auth(S.K.token)).send({ name: 'Pharma Co' })).body.id
  const po = (await api.post('/api/purchase-orders').set(auth(S.K.token)).send({ branchId: S.b1, supplierId: sup, items: [{ productId: pan, qty: 10, unitCost: 20 }] })).body.id
  const item = (await api.get(`/api/purchase-orders/${po}`).set(auth(S.K.token))).body.items[0].id
  const rec = (b: object) => api.post(`/api/purchase-orders/${po}/receive`).set(auth(S.K.token)).send({ items: [{ itemId: item, qty: 10, ...b }] })
  assert.equal((await rec({})).status, 400); assert.equal(await stockOf(S.M.token, S.b1, pan), 13)
  assert.equal((await rec({ batchNo: 'PO1', expiry: ymd(300) })).status, 200); assert.ok((await batchesOf(S.K.token, S.b1, pan)).some(b => b.batch_no === 'PO1' && b.qty === 10))
})

test('credit sales: limits, customer payments, statements, refunds to account, write-offs', async () => {
  await stockAdd(S.K.token, S.b1, S.p1, 50)
  const cu = (await api.post('/api/customers').set(auth(S.C.token)).send({ name: 'Mama Mboga', phone: '0712000111' })).body.id; S.cust = cu
  assert.equal((await api.patch(`/api/customers/${cu}`).set(auth(S.C.token)).send({ creditLimit: 1000 })).status, 403)
  assert.equal((await api.patch(`/api/customers/${cu}`).set(auth(S.M.token)).send({ creditLimit: 1000 })).status, 200)
  const credit = (qty: number, extra: object = {}) => sell(S.C.token, S.b1, [{ productId: S.p1, qty }], [{ method: 'credit', amount: qty * 200 }], { customerId: cu, ...extra })
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'credit', amount: 200 }])).status, 400)   // no customer chosen
  const a = await credit(2); assert.equal(a.status, 201); S.credSale = a.body
  assert.equal((await credit(3)).status, 201)                       // exactly at the 1,000 limit
  assert.equal((await credit(1)).status, 409)                       // over the limit
  const bal = async () => (await api.get('/api/customers?q=mboga').set(auth(S.M.token))).body[0].balance
  assert.equal(await bal(), 1000)
  const pay = (b: object) => api.post(`/api/customers/${cu}/payments`).set(auth(S.C.token)).send({ branchId: S.b1, method: 'cash', amount: 150, ...b })
  assert.equal((await pay({ amount: 5000 })).status, 400); assert.equal((await pay({ method: 'mpesa' })).status, 400)
  assert.equal((await pay({})).body.balance, 850)
  const st = (await api.get(`/api/customers/${cu}/statement`).set(auth(S.M.token))).body
  assert.deepEqual(st.rows.map((r: any) => [r.type, r.amount, r.balance]), [['sale', 400, 400], ['sale', 600, 1000], ['payment', -150, 850]]); assert.ok(st.rows[0].receipt > 0)
  assert.equal((await api.get(`/api/customers/${cu}/statement?from=${ymd(1)}`).set(auth(S.M.token))).body.opening, 850)
  const refundTo = (saleId: string, itemId: string, method: string) => api.post(`/api/sales/${saleId}/refund`).set(auth(S.M.token)).send({ reason: 'Returned goods', method, items: [{ saleItemId: itemId, qty: 1 }] })
  assert.equal((await refundTo(S.s1.id, S.s1.items[0].id, 'credit')).status, 400)   // a walk-in sale has no account to credit
  assert.equal((await refundTo(S.credSale.id, S.credSale.items[0].id, 'credit')).status, 201); assert.equal(await bal(), 650)
  assert.equal((await api.get('/api/receivables').set(auth(S.M.token))).body.customers.find((c: any) => c.name === 'Mama Mboga').balance, 650)
  assert.equal((await api.get('/api/reports/summary').set(auth(S.M.token))).body.summary.credit_sales, 1000)
  assert.equal((await api.post(`/api/customers/${cu}/adjustments`).set(auth(S.M.token)).send({ amount: -650, note: 'Bad debt' })).status, 403)
  assert.equal((await api.post(`/api/customers/${cu}/adjustments`).set(auth(S.O)).send({ amount: -650, note: 'x' })).status, 400)
  assert.equal((await api.post(`/api/customers/${cu}/adjustments`).set(auth(S.O)).send({ amount: -650, note: 'Bad debt written off' })).body.balance, 0)
  assert.ok(!(await api.get('/api/receivables').set(auth(S.M.token))).body.customers.some((c: any) => c.name === 'Mama Mboga'))
  S.X = await register('Shop X', 'x@x.co', 'starter')
  assert.equal((await api.get(`/api/customers/${cu}/statement`).set(auth(S.X))).status, 404)
})

test('supplier payables: invoices, part payments, ageing, permissions', async () => {
  const sup = (await api.post('/api/suppliers').set(auth(S.M.token)).send({ name: 'Unga Ltd' })).body.id
  const inv = (tok: string, b: object) => api.post('/api/supplier-invoices').set(auth(tok)).send({ supplierId: sup, invoiceNo: 'INV-1', invoiceDate: ymd(-60), dueDate: ymd(-40), amount: 1000, ...b })
  const a = await inv(S.M.token, {}); assert.equal(a.status, 201)
  const b = await inv(S.M.token, { invoiceNo: 'INV-2', invoiceDate: ymd(0), dueDate: ymd(10), amount: 2000 }); assert.equal(b.status, 201)
  assert.equal((await inv(S.M.token, {})).status, 409); assert.equal((await inv(S.M.token, { invoiceNo: 'X', dueDate: ymd(-90) })).status, 400); assert.equal((await inv(S.K.token, { invoiceNo: 'Y' })).status, 403)
  const ag = (await api.get('/api/payables').set(auth(S.M.token))).body; assert.equal(ag.total, 3000); assert.equal(ag.current, 2000); assert.equal(ag.d31_60, 1000)
  const pay = (id: string, amount: number) => api.post(`/api/supplier-invoices/${id}/payments`).set(auth(S.M.token)).send({ amount, method: 'bank', reference: 'RTGS1' })
  assert.equal((await pay(a.body.id, 400)).body.outstanding, 600); assert.equal((await pay(a.body.id, 700)).status, 400); assert.equal((await pay(a.body.id, 600)).body.outstanding, 0)
  assert.deepEqual((await api.get('/api/supplier-invoices').set(auth(S.M.token))).body.map((i: any) => i.invoice_no), ['INV-2'])
  assert.deepEqual((await api.get('/api/supplier-invoices?status=paid').set(auth(S.M.token))).body.map((i: any) => i.invoice_no), ['INV-1'])
  assert.equal((await api.get('/api/reports/summary').set(auth(S.M.token))).body.summary.payables, 2000)
  assert.equal((await api.get('/api/supplier-invoices?status=all').set(auth(S.X))).body.length, 0)
  const po = (await api.post('/api/suppliers').set(auth(S.M.token)).send({ name: 'Other supplier' })).body.id
  assert.equal((await inv(S.M.token, { supplierId: po, invoiceNo: 'Z', poId: '00000000-0000-4000-8000-000000000000' })).status, 400)
})

test('cash-up: opening float, expected cash, variance, own session only, optional enforcement', async () => {
  const cur = async () => (await api.get(`/api/cash-sessions/current?branchId=${S.b1}`).set(auth(S.C.token))).body
  assert.equal(await cur(), null)
  const o = await api.post('/api/cash-sessions/open').set(auth(S.C.token)).send({ branchId: S.b1, openingFloat: 500 }); assert.equal(o.status, 201)
  assert.equal((await api.post('/api/cash-sessions/open').set(auth(S.C.token)).send({ branchId: S.b1, openingFloat: 500 })).status, 409)
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }])).status, 201)
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'mpesa', amount: 200, reference: 'ABC123DEF4' }])).status, 201)   // not cash
  assert.equal((await cur()).expected, 700)
  const m = await api.post('/api/cash-sessions/open').set(auth(S.M.token)).send({ branchId: S.b1, openingFloat: 100 })
  assert.equal((await api.post(`/api/cash-sessions/${m.body.id}/close`).set(auth(S.C.token)).send({ countedCash: 100 })).status, 403)
  assert.equal((await api.post(`/api/cash-sessions/${m.body.id}/close`).set(auth(S.M.token)).send({ countedCash: 100 })).body.variance, 0)
  const c = await api.post(`/api/cash-sessions/${o.body.id}/close`).set(auth(S.C.token)).send({ countedCash: 690, note: 'Short by 10' }); assert.equal(c.body.expected, 700); assert.equal(c.body.variance, -10)
  assert.equal((await api.post(`/api/cash-sessions/${o.body.id}/close`).set(auth(S.C.token)).send({ countedCash: 690 })).status, 404)
  assert.equal((await api.get('/api/cash-sessions').set(auth(S.C.token))).status, 403)
  assert.ok((await api.get('/api/cash-sessions').set(auth(S.M.token))).body.some((s: any) => s.variance === -10 && s.cashier === 'cashier'))
  await putSettings({ vatRegistered: true, requireCashSession: true })
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }])).status, 409)
  const o2 = await api.post('/api/cash-sessions/open').set(auth(S.C.token)).send({ branchId: S.b1, openingFloat: 0 })
  assert.equal((await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }])).status, 201)
  await api.post(`/api/cash-sessions/${o2.body.id}/close`).set(auth(S.C.token)).send({ countedCash: 200 }); await putSettings({ vatRegistered: true })
})

test('M-Pesa at the till: encrypted credentials, STK push, secure callback, verified payment used once', async () => {
  const cfg = { env: 'sandbox', shortcode: '174379', partyB: '174379', txType: 'CustomerPayBillOnline', enabled: true, consumerKey: 'ck_test_key', consumerSecret: 'cs_test_secret', passkey: 'pk_test_passkey' }
  assert.equal((await api.put('/api/settings/mpesa').set(auth(S.C.token)).send(cfg)).status, 403); assert.equal((await api.put('/api/settings/mpesa').set(auth(S.M.token)).send(cfg)).status, 403)
  assert.equal((await api.put('/api/settings/mpesa').set(auth(S.O)).send(cfg)).status, 200)
  const shown = (await api.get('/api/settings').set(auth(S.O))).body; assert.equal(shown.mpesa.configured, true); assert.ok(!JSON.stringify(shown).includes('ck_test_key') && !JSON.stringify(shown).includes('pk_test_passkey'))
  const row = (await db.pool.query("SELECT consumer_key_enc,passkey_enc FROM mpesa_settings")).rows[0]; assert.ok(!row.consumer_key_enc.includes('ck_test_key')); assert.equal(decrypt(row.consumer_key_enc), 'ck_test_key')
  const ask = (amount: number) => api.post('/api/till-mpesa').set(auth(S.C.token)).send({ branchId: S.b1, phone: '0712345678', amount })
  const r1 = await ask(200); assert.equal(r1.status, 201)
  const t = till.at(-1)!; assert.equal(t.creds.consumerKey, 'ck_test_key'); assert.equal(t.creds.passkey, 'pk_test_passkey'); assert.equal(t.a.phone, '254712345678')
  const [, biz, secret] = t.a.callbackUrl.match(/till-mpesa\/callback\/([\w-]+)\/([\w-]+)$/)!
  const cbk = (id: string, code: number, amount: number, s = secret) => api.post(`/api/till-mpesa/callback/${biz}/${s}`).send({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: code,
    CallbackMetadata: code === 0 ? { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'RCP1234567' }] } : undefined } } })
  assert.equal((await api.get(`/api/till-mpesa/${r1.body.id}`).set(auth(S.C.token))).body.status, 'pending')
  const useIt = (id: string, amount = 200) => sell(S.C.token, S.b1, [{ productId: S.p1, qty: amount / 200 }], [{ method: 'mpesa', amount, mpesaRequestId: id }])
  assert.equal((await useIt(r1.body.id)).status, 400)                  // not paid yet
  assert.equal((await cbk('till_CO_' + till.length, 0, 200, 'wrong-secret')).status, 404)
  assert.equal((await cbk('till_CO_' + till.length, 0, 200)).status, 200)
  assert.equal((await api.get(`/api/till-mpesa/${r1.body.id}`).set(auth(S.C.token))).body.status, 'paid')
  const ok = await useIt(r1.body.id); assert.equal(ok.status, 201); assert.equal(ok.body.payments[0].reference, 'RCP1234567')
  assert.equal((await useIt(r1.body.id)).status, 400)                  // each payment can be used once
  const r2 = await ask(200); await cbk('till_CO_' + till.length, 0, 200); assert.equal((await useIt(r2.body.id, 400)).status, 400)   // customer paid 200, sale needs 400
  const r3 = await ask(200); await cbk('till_CO_' + till.length, 1032, 0); assert.equal((await api.get(`/api/till-mpesa/${r3.body.id}`).set(auth(S.C.token))).body.status, 'failed')
  assert.equal((await api.get(`/api/till-mpesa/${r1.body.id}`).set(auth(S.X))).status, 404)
})

test('receipts by SMS: needs the setting, uses the customer phone, reports provider failures', async () => {
  const s = await sell(S.C.token, S.b1, [{ productId: S.p1, qty: 1 }], [{ method: 'cash', amount: 200 }], { customerId: S.cust })
  const send = (b: object = {}) => api.post(`/api/sales/${s.body.id}/receipt-sms`).set(auth(S.C.token)).send(b)
  assert.equal((await send()).status, 400)   // switched off
  await putSettings({ vatRegistered: true, smsReceipts: true })
  assert.equal((await send()).status, 200); const m = smsSent.at(-1)!; assert.equal(m.to, '254712000111'); assert.match(m.message, /200\.00/); assert.match(m.message, new RegExp('#' + String(s.body.number).padStart(6, '0')))
  assert.equal((await send({ phone: '0799999999' })).status, 502); assert.equal((await send({ phone: '123' })).status, 400)
  assert.equal((await api.post(`/api/sales/${S.s2.id}/receipt-sms`).set(auth(S.C.token)).send({ phone: '0712000111' })).status, 404)   // not this cashier's sale
  await putSettings({ vatRegistered: true })
})

test('eTIMS queue: invoices are queued with tax data, retried, and honestly reported as not connected', async () => {
  await putSettings({ vatRegistered: true, etimsEnabled: true })
  const std = (await api.get('/api/tax-classes').set(auth(S.M.token))).body.find((c: any) => c.code === 'STD')
  const s = await sell(S.C.token, S.b1, [{ productId: S.vat, qty: 1 }], [{ method: 'cash', amount: 116 }]); assert.equal(s.status, 201); assert.ok(std)
  assert.equal((await api.get(`/api/sales/${s.body.id}`).set(auth(S.C.token))).body.etims_status, 'pending')
  assert.equal((await api.get('/api/etims').set(auth(S.C.token))).status, 403)
  let e = (await api.get('/api/etims').set(auth(S.M.token))).body; assert.ok(e.counts.pending >= 1); assert.equal(e.connected, false)
  etimsMode = 'off'; assert.equal((await api.post('/api/etims/retry').set(auth(S.M.token))).body.sent, 0)
  assert.equal((await api.get(`/api/sales/${s.body.id}`).set(auth(S.C.token))).body.etims_status, 'not_connected')
  etimsMode = 'fail'; await api.post('/api/etims/retry').set(auth(S.M.token))
  e = (await api.get('/api/etims').set(auth(S.M.token))).body; assert.ok(e.pending.some((p: any) => p.status === 'failed' && p.last_error === 'KRA timeout' && p.attempts === 2))
  etimsMode = 'ok'; assert.ok((await api.post('/api/etims/retry').set(auth(S.M.token))).body.sent >= 1)
  e = (await api.get('/api/etims').set(auth(S.M.token))).body; assert.ok(e.counts.sent >= 1); assert.equal(e.connected, true)
  const p = submitted.at(-1); assert.equal(p.seller.kraPin, 'A123456789Z'); assert.equal(p.items[0].taxRate, 16); assert.equal(p.tax, 16)
  assert.equal((await api.get(`/api/sales/${s.body.id}`).set(auth(S.C.token))).body.etims_status, 'sent')
  await putSettings({ vatRegistered: true }); etimsMode = 'off'
})

test('offline sales: synced later with their real time, retried safely, with sensible limits', async () => {
  const at = new Date(Date.now() - 2 * 3600e3).toISOString(), k = key()
  const post = (b: object = {}) => api.post('/api/sales').set(auth(S.C.token)).send({ branchId: S.b1, items: [{ productId: S.p1, qty: 1 }], payments: [{ method: 'cash', amount: 200 }], idempotencyKey: k, ...b })
  assert.equal((await post({ soldAt: at })).status, 400)                                  // a time needs the offline flag
  assert.equal((await post({ offline: true, soldAt: new Date(Date.now() - 100 * 3600e3).toISOString() })).status, 400)   // too old
  assert.equal((await post({ offline: true, soldAt: new Date(Date.now() + 600e3).toISOString() })).status, 400)          // in the future
  await putSettings({ vatRegistered: true, requireCashSession: true })
  const ok = await post({ offline: true, soldAt: at }); assert.equal(ok.status, 201); assert.equal(ok.body.offline, true)   // no till session needed offline
  assert.ok(Math.abs(Date.parse(ok.body.created_at) - Date.parse(at)) < 1000)
  const again = await post({ offline: true, soldAt: at }); assert.equal(again.status, 200); assert.equal(again.body.id, ok.body.id)
  assert.equal((await api.get('/api/sales').set(auth(S.C.token))).body.find((s: any) => s.id === ok.body.id).offline, true)
  await putSettings({ vatRegistered: true })
})

test('daily digest: low stock and expiring stock emailed once a day to owner and managers', async () => {
  const { sendDigests } = await import('../src/digest.js'), { makeNotifier } = await import('../src/core.js')   // loaded late: they need the test database
  const n = await sendDigests(makeNotifier(mailer), { force: true }); assert.ok(n >= 1)
  const m = mails.filter(x => x.subject.startsWith('SmartBiz:')).at(-1)!
  assert.ok(m.to.includes('o@a.co') && m.to.includes('m@a.co')); assert.ok(!m.to.includes('c@a.co')); assert.match(m.text, /LOW STOCK/); assert.match(m.text, /EXPIRED OR EXPIRING/)
  assert.equal(await sendDigests(makeNotifier(mailer), { force: true }), 0)
})

test('accountant exports: CSV for every kind, role protected, formula injection neutralised', async () => {
  const inj = (await mkProduct(S.M.token, { sku: 'INJ', name: '=1+1', price: 10, cost: 5 })).body.id; await stockAdd(S.K.token, S.b1, inj, 5)
  await sell(S.C.token, S.b1, [{ productId: inj, qty: 1 }], [{ method: 'cash', amount: 10 }])
  const get = (kind: string, tok = S.M.token) => api.get(`/api/exports/${kind}`).set(auth(tok))
  const sales = await get('sales'); assert.equal(sales.status, 200); assert.match(sales.headers['content-type'], /text\/csv/); assert.ok(sales.text.startsWith('date,receipt,branch')); assert.ok(sales.text.includes('Sugar 1kg')); assert.ok(sales.text.includes('"\'=1+1"'))
  for (const k of ['payments', 'expenses', 'purchases', 'stock', 'customers', 'suppliers', 'cashups']) assert.equal((await get(k)).status, 200, k)
  assert.ok((await get('suppliers')).text.includes('INV-2')); assert.ok((await get('cashups')).text.includes('-10'))
  assert.equal((await get('sales', S.C.token)).status, 403); assert.equal((await get('nonsense')).status, 400)
  assert.equal((await get('sales', S.X)).text, 'no_data')
})

import http from "node:http"
import { createMailer, emailStatus } from "../src/mail.js"
test("email providers: Brevo and Resend over HTTPS, honest errors, status without secrets", async () => {
  const seen: any[] = []; let code = 200
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { seen.push({ headers: req.headers, body: JSON.parse(b) }); res.statusCode = code; res.end(code === 200 ? "{}" : JSON.stringify({ message: "Invalid API key" })) }) })
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r)); const url = `http://127.0.0.1:${(srv.address() as any).port}`
  const saved = { ...process.env }
  try {
    for (const k of ["EMAIL_PROVIDER", "BREVO_API_KEY", "RESEND_API_KEY", "SMTP_HOST", "EMAIL_FROM", "SMTP_FROM", "SMTP_USER"]) delete process.env[k]
    assert.equal(emailStatus().ready, false); assert.equal(emailStatus().provider, "none")
    await assert.rejects(createMailer()(["a@b.co"], "s", "t"), /No email service/)
    Object.assign(process.env, { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "brevo-secret-key", EMAIL_FROM: "My Shop <no-reply@shop.co.ke>", BREVO_API_URL: url })
    assert.equal(emailStatus().ready, true); assert.ok(!JSON.stringify(emailStatus()).includes("brevo-secret-key"))
    await createMailer()(["x@y.co", "z@y.co"], "Hello", "Body text")
    assert.equal(seen[0].headers["api-key"], "brevo-secret-key"); assert.deepEqual(seen[0].body.sender, { name: "My Shop", email: "no-reply@shop.co.ke" }); assert.deepEqual(seen[0].body.to, [{ email: "x@y.co" }, { email: "z@y.co" }]); assert.equal(seen[0].body.textContent, "Body text")
    code = 401; await assert.rejects(createMailer()(["x@y.co"], "S", "T"), /Brevo refused the email \(HTTP 401\).*Invalid API key/); code = 200
    Object.assign(process.env, { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "resend-secret", RESEND_API_URL: url })
    await createMailer()(["x@y.co"], "Hi", "Txt"); assert.equal(seen[2].headers.authorization, "Bearer resend-secret"); assert.equal(seen[2].body.from, "My Shop <no-reply@shop.co.ke>"); assert.deepEqual(seen[2].body.to, ["x@y.co"])
    Object.assign(process.env, { EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: "1" })   // a blocked or closed SMTP port
    await assert.rejects(createMailer()(["x@y.co"], "S", "T"), /block SMTP ports/)
    delete process.env.EMAIL_FROM; assert.equal(emailStatus().ready, false); assert.match(emailStatus().problem!, /EMAIL_FROM/)
  } finally { srv.close(); for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved) }
})

test('email health: test email tells the truth; a failed invitation hands back a link that works', async () => {
  assert.equal((await api.get('/api/email/status').set(auth(S.M.token))).status, 403); assert.equal((await api.post('/api/email/test').set(auth(S.M.token))).status, 403)
  const st = (await api.get('/api/email/status').set(auth(S.O))).body; assert.ok('provider' in st && 'ready' in st); assert.ok(!JSON.stringify(st).includes('KEY'))
  assert.equal((await api.post('/api/email/test').set(auth(S.O))).status, 200); assert.ok(mails.some(m => m.subject === 'SmartBiz test email' && m.to.includes('o@a.co')))
  const okInv = await api.post('/api/invites').set(auth(S.O)).send({ email: 'ok2@a.co', role: 'cashier', branchIds: [S.b1] }); assert.equal(okInv.body.emailSent, true); assert.equal(okInv.body.link, undefined)
  mailFail = true
  try {
    const bad = await api.post('/api/email/test').set(auth(S.O)); assert.equal(bad.status, 502); assert.match(bad.body.error, /SMTP connect timeout/)
    const inv = await api.post('/api/invites').set(auth(S.O)).send({ email: 'late@a.co', role: 'cashier', branchIds: [S.b1] }); assert.equal(inv.status, 201); assert.equal(inv.body.emailSent, false); assert.match(inv.body.emailError, /timeout/)
    const acc = await api.post('/api/auth/accept-invite').send({ token: inv.body.link.match(/token=([\w-]+)/)![1], name: 'Late', password: PW }); assert.equal(acc.status, 201)
    const id = (await api.get('/api/me').set(auth(acc.body.token))).body.id
    const rl = await api.post(`/api/users/${id}/reset-link`).set(auth(S.O)); assert.equal(rl.body.emailSent, false)
    assert.equal((await api.post('/api/auth/reset').send({ token: rl.body.link.match(/token=([\w-]+)/)![1], password: 'reset-by-hand-pass-1' })).status, 200)
  } finally { mailFail = false }
})
