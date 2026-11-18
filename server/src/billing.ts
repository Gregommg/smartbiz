import type { Express, NextFunction, Request, Response } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool, tx, type Q } from './db.js'
import type { Mailer } from './mail.js'
import type { Mpesa } from './mpesa.js'
import type { Sms } from './sms.js'
import type { Etims } from './etims.js'
import { emailOrLink, HttpError, me, need, audit, subState, makeToken, appUrl, type U, type Notifier } from './core.js'

export type Deps = { mailer: Mailer; mpesa: Mpesa; sms: Sms; etims: Etims }
const password = z.string().min(10, 'Password must be at least 10 characters').max(200)

export function normalisePhone(p: string) {
  const m = p.replace(/[\s-]/g, '').replace(/^\+/, '').match(/^(?:254|0)([17]\d{8})$/)
  if (!m) throw new HttpError(400, 'Enter a valid Kenyan phone number, e.g. 0712345678')
  return '254' + m[1]
}
const applyPlan = (c: Q, businessId: string, plan: string, months: number) =>
  c.query('UPDATE businesses SET plan_code=$2, paid=true, period_end=GREATEST(now(),period_end)+make_interval(months=>$3::int) WHERE id=$1', [businessId, plan, months])

export async function handleStkCallback(cb: any) {
  await tx(async c => {
    const p = (await c.query("SELECT * FROM payments WHERE checkout_request_id=$1 AND status='pending' FOR UPDATE", [String(cb.CheckoutRequestID)])).rows[0]
    if (!p) return
    const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i: any) => [i.Name, i.Value]))
    if (cb.ResultCode !== 0 || Number(items.Amount) < p.amount) { await c.query("UPDATE payments SET status='failed' WHERE id=$1", [p.id]); return }
    await c.query("UPDATE payments SET status='paid', paid_at=now(), mpesa_receipt=$2 WHERE id=$1", [p.id, String(items.MpesaReceiptNumber ?? '')])
    await applyPlan(c, p.business_id, p.plan_code, p.months)
  })
}

export function registerBillingPublic(app: Express) {
  // Daraja callbacks are unsigned: the secret in the URL, a matching pending CheckoutRequestID and the amount check protect this endpoint.
  app.post('/api/mpesa/callback/:secret', async (req, res) => {
    const want = Buffer.from(process.env.MPESA_CALLBACK_SECRET ?? ''), got = Buffer.from(req.params.secret)
    if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return void res.status(404).json({ error: 'Not found' })
    const cb = req.body?.Body?.stkCallback
    if (cb?.CheckoutRequestID) await handleStkCallback(cb)
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  })
}

export function registerBilling(app: Express, d: Deps, notify: Notifier) {
  const platform = (_q: Request, res: Response, next: NextFunction) => me(res).is_platform ? next() : next(new HttpError(403, 'Platform administrators only'))
  const usage = (id: string) => pool.query(`SELECT (SELECT count(*)::int FROM branches WHERE business_id=$1 AND active) AS branches, (SELECT count(*)::int FROM users WHERE business_id=$1 AND active) AS users`, [id]).then(r => r.rows[0])

  app.get('/api/billing', need('owner'), async (_q, res) => {
    const u = me(res)
    const o = (await pool.query(`SELECT b.plan_code,b.period_end,b.paid,p.name AS plan_name,p.max_branches,p.max_users,p.price_month FROM businesses b JOIN plans p ON p.code=b.plan_code WHERE b.id=$1`, [u.business_id])).rows[0]
    const payments = (await pool.query('SELECT id,plan_code,months,amount,method,status,mpesa_receipt,created_at FROM payments WHERE business_id=$1 ORDER BY created_at DESC LIMIT 10', [u.business_id])).rows
    const plans = (await pool.query('SELECT code,name,max_branches,max_users,price_month FROM plans WHERE active ORDER BY price_month')).rows
    res.json({ ...o, ...(await usage(u.business_id)), state: subState(o), payments, plans })
  })
  app.post('/api/billing/checkout', need('owner'), async (req, res) => {
    const u = me(res)
    const b = z.object({ planCode: z.string().min(1).max(30), months: z.union([z.literal(1), z.literal(12)]), phone: z.string().max(20) }).parse(req.body)
    const phone = normalisePhone(b.phone)
    const plan = (await pool.query('SELECT * FROM plans WHERE code=$1 AND active', [b.planCode])).rows[0]
    if (!plan) throw new HttpError(400, 'Unknown plan')
    const use = await usage(u.business_id)
    if (use.branches > plan.max_branches || use.users > plan.max_users)
      throw new HttpError(400, `You use ${use.branches} branch(es) and ${use.users} user(s); ${plan.name} allows ${plan.max_branches} and ${plan.max_users}. Reduce usage or choose a larger plan.`)
    const amount = plan.price_month * b.months
    const p = (await pool.query("INSERT INTO payments(business_id,plan_code,months,amount,method,phone) VALUES($1,$2,$3,$4,'mpesa',$5) RETURNING id", [u.business_id, plan.code, b.months, amount, phone])).rows[0]
    try {
      const r = await d.mpesa.stkPush({ phone, amount, ref: 'SB' + p.id.slice(0, 8) })
      await pool.query('UPDATE payments SET checkout_request_id=$1 WHERE id=$2', [r.checkoutRequestId, p.id])
    } catch (e) {
      console.error('M-Pesa STK push failed:', (e as Error).message)
      await pool.query("UPDATE payments SET status='failed' WHERE id=$1", [p.id])
      throw new HttpError(502, 'Could not start the M-Pesa payment prompt. Try again or contact support.')
    }
    await audit(pool, u, 'billing.checkout', 'payment', p.id, { plan: plan.code, months: b.months, amount })
    res.status(201).json({ paymentId: p.id, amount })
  })
  app.get('/api/billing/payments/:id', need('owner'), async (req, res) => {
    const r = (await pool.query('SELECT id,status,amount,mpesa_receipt FROM payments WHERE id=$1 AND business_id=$2', [z.string().uuid().parse(req.params.id), me(res).business_id])).rows[0]
    if (!r) throw new HttpError(404, 'Payment not found')
    res.json(r)
  })

  // ---- platform administration (your staff only) ----
  app.get('/api/platform/businesses', platform, async (_q, res) => {
    const rows = (await pool.query(`SELECT b.id,b.name,b.plan_code,b.period_end,b.paid,b.created_at,
      (SELECT count(*)::int FROM branches WHERE business_id=b.id AND active) AS branches, (SELECT count(*)::int FROM users WHERE business_id=b.id AND active) AS users
      FROM businesses b ORDER BY b.created_at DESC LIMIT 500`)).rows
    res.json(rows.map(r => ({ ...r, state: subState(r) })))
  })
  app.post('/api/platform/businesses/:id/payments', platform, async (req, res) => {
    const u = me(res), id = z.string().uuid().parse(req.params.id)
    const b = z.object({ planCode: z.string().min(1).max(30), months: z.number().int().min(1).max(36), amount: z.number().int().min(1), reference: z.string().trim().min(1).max(100) }).parse(req.body)
    await tx(async c => {
      if (!(await c.query('SELECT 1 FROM businesses WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'Business not found')
      if (!(await c.query('SELECT 1 FROM plans WHERE code=$1', [b.planCode])).rowCount) throw new HttpError(400, 'Unknown plan')
      const p = (await c.query("INSERT INTO payments(business_id,plan_code,months,amount,method,status,reference,paid_at) VALUES($1,$2,$3,$4,'manual','paid',$5,now()) RETURNING id", [id, b.planCode, b.months, b.amount, b.reference])).rows[0]
      await applyPlan(c, id, b.planCode, b.months)
      await audit(c, { id: u.id, business_id: id }, 'billing.manual_payment', 'payment', p.id, b)
    })
    res.status(201).json({ ok: true })
  })
  app.patch('/api/platform/plans/:code', platform, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), max_branches: z.number().int().min(1).optional(), max_users: z.number().int().min(1).optional(), price_month: z.number().int().min(1).optional(), active: z.boolean().optional() }).parse(req.body)
    const r = await pool.query('UPDATE plans SET name=COALESCE($1,name), max_branches=COALESCE($2,max_branches), max_users=COALESCE($3,max_users), price_month=COALESCE($4,price_month), active=COALESCE($5,active) WHERE code=$6 RETURNING code',
      [b.name ?? null, b.max_branches ?? null, b.max_users ?? null, b.price_month ?? null, b.active ?? null, String(req.params.code)])
    if (!r.rowCount) throw new HttpError(404, 'Plan not found')
    res.json({ ok: true })
  })
  const owner = async (actor: U, id: string) => {
    const t = (await pool.query("SELECT id,business_id,name,email FROM users WHERE id=$1 AND role='owner' AND NOT is_platform", [id])).rows[0]
    if (!t) throw new HttpError(404, 'User not found')
    if (t.id === actor.id) throw new HttpError(400, 'Use Change password for your own account')
    return t as { id: string; business_id: string; name: string; email: string }
  }
  app.get('/api/platform/businesses/:id/owners', platform, async (req, res) => {
    res.json((await pool.query("SELECT id,name,email,active FROM users WHERE business_id=$1 AND role='owner' AND NOT is_platform ORDER BY name", [z.string().uuid().parse(req.params.id)])).rows)
  })
  app.post('/api/platform/users/:id/password', platform, async (req, res) => {
    const u = me(res), t = await owner(u, z.string().uuid().parse(req.params.id)), b = z.object({ password }).parse(req.body)
    await pool.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=true WHERE id=$2', [await bcrypt.hash(b.password, 12), t.id])
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id])
    await audit(pool, { id: u.id, business_id: t.business_id }, 'user.temp_password', 'user', t.id, { by: 'platform' })
    notify.send([t.email], 'Your SmartBiz password was reset', 'A SmartBiz administrator set a temporary password for your account. Sign in with it and you will be asked to choose a new password.')
    res.json({ ok: true })
  })
  app.post('/api/platform/users/:id/mfa-reset', platform, async (req, res) => {
    const u = me(res), t = await owner(u, z.string().uuid().parse(req.params.id))
    await pool.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_pending_enc=NULL WHERE id=$1', [t.id]); await pool.query('DELETE FROM mfa_recovery WHERE user_id=$1', [t.id])
    await audit(pool, { id: u.id, business_id: t.business_id }, 'user.mfa_reset', 'user', t.id, { by: 'platform' })
    res.json({ ok: true })
  })
  app.post('/api/platform/users/:id/reset-link', platform, async (req, res) => {
    const u = me(res), t = await owner(u, z.string().uuid().parse(req.params.id))
    const raw = await makeToken(pool, 'reset', t.email, t.business_id, null, t.id, 1)
    await audit(pool, { id: u.id, business_id: t.business_id }, 'user.reset_link', 'user', t.id, { by: 'platform' })
    res.json({ ok: true, ...(await emailOrLink(notify, t.email, 'Reset your SmartBiz password', `A SmartBiz administrator sent you a password reset link (valid 1 hour):\n${appUrl()}/#/reset?token=${raw}`, `${appUrl()}/#/reset?token=${raw}`)) })
  })
}
