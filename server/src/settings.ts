import type { Express } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { pool } from './db.js'
import { HttpError, me, need, audit, appUrl, type Notifier } from './core.js'
import { encrypt, decrypt } from './secrets.js'
import { processEtimsQueue } from './etims.js'
import type { Deps } from './billing.js'
import type { Creds } from './mpesa.js'
import { normalisePhone } from './billing.js'

const text = (n: number) => z.string().trim().max(n)
const uuid = z.string().uuid()
// Starting tax classes only. Rates are NOT verified for your business: the owner must check them with KRA or a tax adviser and edit them.
export async function ensureTaxClasses(businessId: string) {
  if ((await pool.query('SELECT 1 FROM tax_classes WHERE business_id=$1 LIMIT 1', [businessId])).rowCount) return
  await pool.query(`INSERT INTO tax_classes(business_id,code,name,rate) VALUES ($1,'STD','Standard rated',16),($1,'ZERO','Zero rated',0),($1,'EXEMPT','Exempt',0) ON CONFLICT DO NOTHING`, [businessId])
}

export function registerSettings(app: Express, d: Deps) {
  app.get('/api/settings', need('owner', 'manager'), async (_q, res) => {
    const u = me(res)
    const s = (await pool.query('SELECT * FROM business_settings WHERE business_id=$1', [u.business_id])).rows[0] ?? {}
    await ensureTaxClasses(u.business_id)
    const mp = (await pool.query('SELECT env,shortcode,party_b,tx_type,enabled FROM mpesa_settings WHERE business_id=$1', [u.business_id])).rows[0]
    res.json({ settings: { legalName: s.legal_name ?? '', kraPin: s.kra_pin ?? '', address: s.address ?? '', phone: s.phone ?? '', receiptFooter: s.receipt_footer ?? '', vatRegistered: !!s.vat_registered,
      etimsEnabled: !!s.etims_enabled, requireCashSession: !!s.require_cash_session, smsReceipts: !!s.sms_receipts },
      mpesa: mp ? { configured: true, env: mp.env, shortcode: mp.shortcode, partyB: mp.party_b, txType: mp.tx_type, enabled: mp.enabled } : { configured: false }, smsAvailable: !!process.env.AT_API_KEY })
  })
  app.put('/api/settings', need('owner'), async (req, res) => {
    const u = me(res)
    const b = z.object({ legalName: text(150), kraPin: text(11).regex(/^([AP]\d{9}[A-Z])?$/i, 'A KRA PIN looks like A123456789Z'), address: text(200), phone: text(30), receiptFooter: text(200),
      vatRegistered: z.boolean(), etimsEnabled: z.boolean(), requireCashSession: z.boolean(), smsReceipts: z.boolean() }).parse(req.body)
    await pool.query(`INSERT INTO business_settings(business_id,legal_name,kra_pin,address,phone,receipt_footer,vat_registered,etims_enabled,require_cash_session,sms_receipts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (business_id) DO UPDATE SET legal_name=$2,kra_pin=$3,address=$4,phone=$5,receipt_footer=$6,vat_registered=$7,etims_enabled=$8,require_cash_session=$9,sms_receipts=$10`,
      [u.business_id, b.legalName || null, b.kraPin.toUpperCase() || null, b.address || null, b.phone || null, b.receiptFooter || null, b.vatRegistered, b.etimsEnabled, b.requireCashSession, b.smsReceipts])
    await audit(pool, u, 'settings.update', 'business', u.business_id, { vat: b.vatRegistered, etims: b.etimsEnabled })
    res.json({ ok: true })
  })
  app.get('/api/tax-classes', async (_q, res) => {
    const u = me(res); await ensureTaxClasses(u.business_id)
    res.json((await pool.query('SELECT id,code,name,rate FROM tax_classes WHERE business_id=$1 ORDER BY code', [u.business_id])).rows)
  })
  app.post('/api/tax-classes', need('owner'), async (req, res) => {
    const u = me(res), b = z.object({ code: text(20).min(1), name: text(80).min(1), rate: z.number().min(0).max(100) }).parse(req.body)
    res.status(201).json((await pool.query('INSERT INTO tax_classes(business_id,code,name,rate) VALUES($1,$2,$3,$4) RETURNING id', [u.business_id, b.code.toUpperCase(), b.name, b.rate])).rows[0])
  })
  app.patch('/api/tax-classes/:id', need('owner'), async (req, res) => {
    const u = me(res), b = z.object({ name: text(80).min(1).optional(), rate: z.number().min(0).max(100).optional() }).parse(req.body)
    const r = await pool.query('UPDATE tax_classes SET name=COALESCE($1,name), rate=COALESCE($2,rate) WHERE id=$3 AND business_id=$4 RETURNING id', [b.name ?? null, b.rate ?? null, uuid.parse(req.params.id), u.business_id])
    if (!r.rowCount) throw new HttpError(404, 'Tax class not found')
    await audit(pool, u, 'tax.update', 'tax_class', String(req.params.id), b); res.json({ ok: true })
  })

  // ---- the business's own M-Pesa till / paybill (credentials stored encrypted) ----
  app.put('/api/settings/mpesa', need('owner'), async (req, res) => {
    const u = me(res)
    const b = z.object({ env: z.enum(['sandbox', 'production']), shortcode: text(20).min(3), partyB: text(20).min(3), txType: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']), enabled: z.boolean(),
      consumerKey: text(200).optional(), consumerSecret: text(200).optional(), passkey: text(300).optional() }).parse(req.body)
    const cur = (await pool.query('SELECT consumer_key_enc,consumer_secret_enc,passkey_enc,callback_secret FROM mpesa_settings WHERE business_id=$1', [u.business_id])).rows[0]
    if (!cur && !(b.consumerKey && b.consumerSecret && b.passkey)) throw new HttpError(400, 'Enter the consumer key, consumer secret and passkey')
    await pool.query(`INSERT INTO mpesa_settings(business_id,env,shortcode,party_b,tx_type,consumer_key_enc,consumer_secret_enc,passkey_enc,callback_secret,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT (business_id) DO UPDATE SET env=$2,shortcode=$3,party_b=$4,tx_type=$5,consumer_key_enc=$6,consumer_secret_enc=$7,passkey_enc=$8,enabled=$10,updated_at=now()`,
      [u.business_id, b.env, b.shortcode, b.partyB, b.txType, b.consumerKey ? encrypt(b.consumerKey) : cur.consumer_key_enc, b.consumerSecret ? encrypt(b.consumerSecret) : cur.consumer_secret_enc,
        b.passkey ? encrypt(b.passkey) : cur.passkey_enc, cur?.callback_secret ?? crypto.randomBytes(24).toString('base64url'), b.enabled])
    await audit(pool, u, 'settings.mpesa', 'business', u.business_id, { env: b.env, shortcode: b.shortcode })
    res.json({ ok: true })
  })
  const credsFor = async (businessId: string) => {
    const s = (await pool.query('SELECT * FROM mpesa_settings WHERE business_id=$1 AND enabled', [businessId])).rows[0]
    if (!s) throw new HttpError(400, 'M-Pesa payments are not set up for this business')
    return { creds: { env: s.env, consumerKey: decrypt(s.consumer_key_enc), consumerSecret: decrypt(s.consumer_secret_enc), shortcode: s.shortcode, partyB: s.party_b, passkey: decrypt(s.passkey_enc), txType: s.tx_type } as Creds, secret: s.callback_secret as string }
  }
  app.post('/api/till-mpesa', need('owner', 'manager', 'cashier'), async (req, res) => {
    const u = me(res), b = z.object({ branchId: uuid, phone: text(20), amount: z.number().positive().max(250000) }).parse(req.body)
    const { requireBranch } = await import('./core.js'); await requireBranch(u, b.branchId)
    const phone = normalisePhone(b.phone), { creds, secret } = await credsFor(u.business_id)
    const row = (await pool.query('INSERT INTO till_mpesa(business_id,branch_id,user_id,phone,amount) VALUES($1,$2,$3,$4,$5) RETURNING id', [u.business_id, b.branchId, u.id, phone, b.amount])).rows[0]
    try {
      const r = await d.mpesa.stkPushFor(creds, { phone, amount: b.amount, ref: 'SB' + row.id.slice(0, 8), callbackUrl: `${appUrl()}/api/till-mpesa/callback/${u.business_id}/${secret}`, desc: 'Purchase' })
      await pool.query('UPDATE till_mpesa SET checkout_request_id=$2 WHERE id=$1', [row.id, r.checkoutRequestId])
    } catch (e) {
      console.error('Till M-Pesa STK push failed:', (e as Error).message)
      await pool.query("UPDATE till_mpesa SET status='failed', updated_at=now() WHERE id=$1", [row.id])
      throw new HttpError(502, 'Could not send the M-Pesa prompt. Check the M-Pesa settings or ask the customer to pay another way.')
    }
    res.status(201).json({ id: row.id })
  })
  app.get('/api/till-mpesa/:id', need('owner', 'manager', 'cashier'), async (req, res) => {
    const r = (await pool.query('SELECT id,status,amount,paid_amount,receipt,sale_id FROM till_mpesa WHERE id=$1 AND business_id=$2', [uuid.parse(req.params.id), me(res).business_id])).rows[0]
    if (!r) throw new HttpError(404, 'Payment request not found')
    res.json(r)
  })

  // ---- eTIMS submission queue (the KRA connection itself is NOT implemented) ----
  app.get('/api/etims', need('owner', 'manager'), async (_q, res) => {
    const u = me(res)
    const c = (await pool.query('SELECT status, count(*)::int AS n FROM etims_queue WHERE business_id=$1 GROUP BY 1', [u.business_id])).rows
    const recent = (await pool.query(`SELECT q.id,q.status,q.attempts,q.last_error,q.updated_at,s.number FROM etims_queue q JOIN sales s ON s.id=q.sale_id WHERE q.business_id=$1 AND q.status<>'sent' ORDER BY q.updated_at DESC LIMIT 20`, [u.business_id])).rows
    res.json({ counts: Object.fromEntries(c.map(r => [r.status, r.n])), pending: recent, connected: d.etims.ping ? await d.etims.ping().catch(() => false) : false })
  })
  app.post('/api/etims/retry', need('owner', 'manager'), async (_q, res) => { res.json({ sent: await processEtimsQueue(d.etims, me(res).business_id) }) })
}
export const publicNotify = (_n: Notifier) => undefined
export async function tillMpesaCallback(businessId: string, secret: string, cb: any) {
  const s = (await pool.query('SELECT callback_secret FROM mpesa_settings WHERE business_id=$1', [businessId])).rows[0]
  const want = Buffer.from(s?.callback_secret ?? ''), got = Buffer.from(secret)
  if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false
  const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i: any) => [i.Name, i.Value]))
  if (cb.ResultCode === 0) await pool.query("UPDATE till_mpesa SET status='paid', receipt=$3, paid_amount=$4, updated_at=now() WHERE checkout_request_id=$1 AND business_id=$2 AND status='pending'", [String(cb.CheckoutRequestID), businessId, String(items.MpesaReceiptNumber ?? ''), Number(items.Amount)])
  else await pool.query("UPDATE till_mpesa SET status='failed', updated_at=now() WHERE checkout_request_id=$1 AND business_id=$2 AND status='pending'", [String(cb.CheckoutRequestID), businessId])
  return true
}
