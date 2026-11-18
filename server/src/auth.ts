import type { Express } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { encrypt, decrypt } from './secrets.js'
import { newSecret, otpauth, verifyTotp } from './totp.js'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { emailStatus, emailProvider } from './mail.js'
import { emailOrLink, HttpError, me, need, audit, sign, secret as jwtSecret, hashTok, makeToken, startSession, cookieOf, SESSION, appUrl, assertUserSlot, assertBranchSlot, branchIds, type U, type Notifier } from './core.js'

const email = z.string().trim().toLowerCase().email().max(200)
const password = z.string().min(10, 'Password must be at least 10 characters').max(200)
const name = z.string().trim().min(1).max(120)
const uuid = z.string().uuid()
const staffRole = z.enum(['manager', 'cashier', 'storekeeper'])
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12)

const recoveryHash = (c: string) => crypto.createHash('sha256').update(c.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex')
/** Accepts a 6-digit authenticator code (once per 30-second step) or an unused recovery code. */
async function checkMfaCode(u: { id: string; mfa_secret_enc: string | null; mfa_last_step: string | number | null }, code: string) {
  if (/^\d{6}$/.test(code) && u.mfa_secret_enc) {
    const step = verifyTotp(decrypt(u.mfa_secret_enc), code, u.mfa_last_step === null ? null : Number(u.mfa_last_step))
    if (step === null) return false
    await pool.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [u.id, step]); return true
  }
  const r = await pool.query('UPDATE mfa_recovery SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL', [u.id, recoveryHash(code)])
  return (r.rowCount ?? 0) > 0
}

export function registerAuthPublic(app: Express, notify: Notifier) {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 10000 : 30 })
  app.get('/api/health', (_q, res) => { res.json({ ok: true }) })
  app.get('/api/plans', async (_q, res) => { res.json((await pool.query('SELECT code,name,max_branches,max_users,price_month FROM plans WHERE active ORDER BY price_month')).rows) })

  app.post('/api/auth/register', limiter, async (req, res) => {
    if (process.env.ALLOW_REGISTRATION === 'false') throw new HttpError(403, 'Registration is disabled')
    const b = z.object({ businessName: name, name, email, password, planCode: z.string().max(30).default('starter'), branchName: z.string().trim().min(1).max(80).default('Main branch') }).parse(req.body)
    if (!(await pool.query('SELECT 1 FROM plans WHERE code=$1 AND active', [b.planCode])).rowCount) throw new HttpError(400, 'Unknown plan')
    const hash = await bcrypt.hash(b.password, 12)
    const user = await tx(async c => {
      const biz = (await c.query('INSERT INTO businesses(name,plan_code) VALUES($1,$2) RETURNING id', [b.businessName, b.planCode])).rows[0]
      const u = (await c.query(`INSERT INTO users(business_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,business_id,name,email,role,password_changed_at`, [biz.id, b.name, b.email, hash, ])).rows[0] as U
      await c.query('INSERT INTO branches(business_id,name) VALUES($1,$2)', [biz.id, b.branchName])
      await audit(c, u, 'business.register', 'business', biz.id)
      return u
    })
    await startSession(req, res, user.id)
    res.status(201).json({ token: sign(user.id, user.password_changed_at as Date) })
  })
  app.post('/api/auth/login', limiter, async (req, res) => {
    const b = z.object({ email, password: z.string().max(200) }).parse(req.body)
    const r = (await pool.query('SELECT id,password_hash,password_changed_at,mfa_enabled FROM users WHERE email=$1 AND active', [b.email])).rows[0]
    const ok = await bcrypt.compare(b.password, r?.password_hash ?? DUMMY_HASH)
    if (!r || !ok) throw new HttpError(401, 'Incorrect email or password')
    if (r.mfa_enabled) return void res.json({ mfaRequired: true, mfaToken: jwt.sign({ uid: r.id, purpose: 'mfa' }, jwtSecret(), { expiresIn: '5m' }) })
    await startSession(req, res, r.id)
    res.json({ token: sign(r.id, r.password_changed_at) })
  })
  app.post('/api/auth/mfa/verify', limiter, async (req, res) => {
    const b = z.object({ mfaToken: z.string().max(1000), code: z.string().trim().min(6).max(30) }).parse(req.body)
    let uid: string
    try { const p = jwt.verify(b.mfaToken, jwtSecret()) as { uid: string; purpose: string }; if (p.purpose !== 'mfa') throw new Error('x'); uid = p.uid } catch { throw new HttpError(401, 'Sign in again') }
    const u = (await pool.query('SELECT id,mfa_secret_enc,mfa_last_step,password_changed_at FROM users WHERE id=$1 AND active AND mfa_enabled', [uid])).rows[0]
    if (!u) throw new HttpError(401, 'Sign in again')
    if (!(await checkMfaCode(u, b.code))) throw new HttpError(401, 'That code is not correct')
    await startSession(req, res, u.id)
    res.json({ token: sign(u.id, u.password_changed_at) })
  })
  app.post('/api/auth/refresh', async (req, res) => {
    const raw = cookieOf(req)
    if (!raw) throw new HttpError(401, 'Not signed in')
    const r = (await pool.query(`UPDATE sessions s SET last_used_at=now(), expires_at=now()+make_interval(days=>$2::int) FROM users u
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.id=s.user_id AND u.active RETURNING u.id,u.password_changed_at`, [hashTok(raw), SESSION.SESSION_DAYS])).rows[0]
    if (!r) { res.clearCookie(SESSION.COOKIE, { path: '/api/auth' }); throw new HttpError(401, 'Not signed in') }
    res.cookie(SESSION.COOKIE, raw, SESSION.cookieOpts(req))
    res.json({ token: sign(r.id, r.password_changed_at) })
  })
  app.post('/api/auth/logout', async (req, res) => {
    const raw = cookieOf(req)
    if (raw) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashTok(raw)])
    res.clearCookie(SESSION.COOKIE, { path: '/api/auth' })
    res.json({ ok: true })
  })
  app.post('/api/auth/forgot', limiter, async (req, res) => {
    const { email: e } = z.object({ email }).parse(req.body)
    const u = (await pool.query('SELECT id,business_id FROM users WHERE email=$1 AND active', [e])).rows[0]
    if (u) {
      const t = await makeToken(pool, 'reset', e, u.business_id, null, u.id, 1)
      notify.send([e], 'Reset your SmartBiz password', `Use this link within 1 hour to choose a new password:\n${appUrl()}/#/reset?token=${t}\n\nIf you did not ask for this, ignore this email.`)
    }
    res.json({ ok: true })
  })
  app.post('/api/auth/reset', limiter, async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(200), password }).parse(req.body)
    const hash = await bcrypt.hash(b.password, 12)
    await tx(async c => {
      const t = (await c.query("SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashTok(b.token)])).rows[0]
      if (!t) throw new HttpError(400, 'This link is invalid or has expired')
      await c.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=false WHERE id=$2', [hash, t.user_id])
      await c.query('DELETE FROM sessions WHERE user_id=$1', [t.user_id])
      await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id])
    })
    res.json({ ok: true })
  })
  app.post('/api/auth/accept-invite', limiter, async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(200), name, password }).parse(req.body)
    const hash = await bcrypt.hash(b.password, 12)
    const user = await tx(async c => {
      const t = (await c.query("SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='invite' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashTok(b.token)])).rows[0]
      if (!t) throw new HttpError(400, 'This invitation is invalid or has expired')
      await assertUserSlot(t.business_id, c)
      const u = (await c.query(`INSERT INTO users(business_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,business_id,name,email,role,password_changed_at`,
        [t.business_id, b.name, t.email, hash, t.role])).rows[0] as U
      const ids: string[] = t.detail?.branchIds ?? []
      await c.query(`INSERT INTO user_branches(user_id,branch_id) SELECT $1,id FROM branches WHERE business_id=$2 AND active AND id=ANY($3::uuid[])`, [u.id, t.business_id, ids])
      await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id])
      await audit(c, u, 'user.join', 'user', u.id, { role: t.role })
      return u
    })
    await startSession(req, res, user.id)
    res.status(201).json({ token: sign(user.id, user.password_changed_at as Date) })
  })
}

export function registerAccount(app: Express, notify: Notifier) {
  app.get('/api/me', async (_q, res) => {
    const u = me(res), ids = await branchIds(u)
    const branches = (await pool.query('SELECT id,name FROM branches WHERE id=ANY($1::uuid[]) ORDER BY name', [ids])).rows
    const mfa = (await pool.query('SELECT mfa_enabled FROM users WHERE id=$1', [u.id])).rows[0].mfa_enabled
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, is_platform: u.is_platform, must_change_password: u.must_change_password, mfa_enabled: mfa, sub: res.locals.sub, branches })
  })
  app.post('/api/auth/mfa/setup', async (_q, res) => {
    const u = me(res), s = newSecret()
    await pool.query('UPDATE users SET mfa_pending_enc=$2 WHERE id=$1', [u.id, encrypt(s)])
    res.json({ secret: s, otpauth: otpauth(u.email, s) })
  })
  app.post('/api/auth/mfa/enable', async (req, res) => {
    const u = me(res), b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body)
    const row = (await pool.query('SELECT mfa_pending_enc FROM users WHERE id=$1', [u.id])).rows[0]
    if (!row?.mfa_pending_enc) throw new HttpError(400, 'Start the setup first')
    const secret = decrypt(row.mfa_pending_enc), step = verifyTotp(secret, b.code, null)
    if (step === null) throw new HttpError(400, 'That code is not correct. Check the time on your phone and try again.')
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').replace(/^(.{5})(.{5})$/, '$1-$2'))
    await tx(async c => {
      await c.query('UPDATE users SET mfa_enabled=true, mfa_secret_enc=$2, mfa_pending_enc=NULL, mfa_last_step=$3 WHERE id=$1', [u.id, encrypt(secret), step])
      await c.query('DELETE FROM mfa_recovery WHERE user_id=$1', [u.id])
      for (const c2 of codes) await c.query('INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)', [u.id, recoveryHash(c2)])
      await audit(c, u, 'user.mfa_enable', 'user', u.id)
    })
    res.json({ recoveryCodes: codes })
  })
  app.post('/api/auth/mfa/disable', async (req, res) => {
    const u = me(res), b = z.object({ password: z.string().max(200), code: z.string().trim().min(6).max(30) }).parse(req.body)
    const row = (await pool.query('SELECT password_hash,mfa_secret_enc,mfa_last_step FROM users WHERE id=$1', [u.id])).rows[0]
    if (!(await bcrypt.compare(b.password, row.password_hash))) throw new HttpError(400, 'Your password is incorrect')
    if (!(await checkMfaCode({ id: u.id, ...row }, b.code))) throw new HttpError(400, 'That code is not correct')
    await pool.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_pending_enc=NULL WHERE id=$1', [u.id]); await pool.query('DELETE FROM mfa_recovery WHERE user_id=$1', [u.id])
    await audit(pool, u, 'user.mfa_disable', 'user', u.id)
    res.json({ ok: true })
  })
  app.post('/api/users/:id/mfa-reset', need('owner'), async (req, res) => {   // a staff member lost their phone
    const u = me(res), id = uuid.parse(req.params.id)
    const r = await pool.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_pending_enc=NULL WHERE id=$1 AND business_id=$2 AND NOT is_platform RETURNING id', [id, u.business_id])
    if (!r.rowCount) throw new HttpError(404, 'User not found')
    await pool.query('DELETE FROM mfa_recovery WHERE user_id=$1', [id]); await audit(pool, u, 'user.mfa_reset', 'user', id)
    res.json({ ok: true })
  })
  app.post('/api/auth/change-password', async (req, res) => {
    const u = me(res)
    const b = z.object({ current: z.string().max(200), password }).parse(req.body)
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0]
    if (!(await bcrypt.compare(b.current, row.password_hash))) throw new HttpError(400, 'Your current password is incorrect')
    if (b.current === b.password) throw new HttpError(400, 'Choose a password different from the current one')
    const n = (await pool.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=false WHERE id=$2 RETURNING password_changed_at', [await bcrypt.hash(b.password, 12), u.id])).rows[0]
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id])
    await startSession(req, res, u.id)
    await audit(pool, u, 'user.password_change', 'user', u.id)
    res.json({ token: sign(u.id, n.password_changed_at) })
  })

  // ---- branches ----
  app.get('/api/branches', async (_q, res) => {
    const u = me(res)
    res.json((await pool.query(`SELECT id,name,address,active FROM branches WHERE business_id=$1 AND ($2 OR id=ANY($3::uuid[])) ORDER BY name`, [u.business_id, u.role === 'owner', u.branch_ids ?? []])).rows)
  })
  app.post('/api/branches', need('owner'), async (req, res) => {
    const u = me(res)
    const b = z.object({ name: z.string().trim().min(1).max(80), address: z.string().trim().max(200).optional() }).parse(req.body)
    await assertBranchSlot(u.business_id)
    const r = (await pool.query('INSERT INTO branches(business_id,name,address) VALUES($1,$2,$3) RETURNING id', [u.business_id, b.name, b.address ?? null])).rows[0]
    await audit(pool, u, 'branch.create', 'branch', r.id, { name: b.name })
    res.status(201).json(r)
  })
  app.patch('/api/branches/:id', need('owner'), async (req, res) => {
    const u = me(res), id = uuid.parse(req.params.id)
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), address: z.string().trim().max(200).optional(), active: z.boolean().optional() }).parse(req.body)
    const cur = (await pool.query('SELECT active FROM branches WHERE id=$1 AND business_id=$2', [id, u.business_id])).rows[0]
    if (!cur) throw new HttpError(404, 'Branch not found')
    if (b.active === false && cur.active && (await pool.query('SELECT count(*)::int AS n FROM branches WHERE business_id=$1 AND active', [u.business_id])).rows[0].n <= 1) throw new HttpError(400, 'You need at least one active branch')
    if (b.active === true && !cur.active) await assertBranchSlot(u.business_id)
    await pool.query('UPDATE branches SET name=COALESCE($1,name), address=COALESCE($2,address), active=COALESCE($3,active) WHERE id=$4', [b.name ?? null, b.address ?? null, b.active ?? null, id])
    await audit(pool, u, 'branch.update', 'branch', id, b)
    res.json({ ok: true })
  })

  // ---- people ----
  app.get('/api/users', need('owner', 'manager'), async (_q, res) => {
    res.json((await pool.query(`SELECT u.id,u.name,u.email,u.role,u.active,coalesce((SELECT array_agg(branch_id) FROM user_branches WHERE user_id=u.id),'{}') AS branch_ids
      FROM users u WHERE u.business_id=$1 ORDER BY u.name`, [me(res).business_id])).rows)
  })
  const validBranches = async (businessId: string, ids: string[]) => {
    const n = (await pool.query('SELECT count(*)::int AS n FROM branches WHERE business_id=$1 AND id=ANY($2::uuid[])', [businessId, ids])).rows[0].n
    if (n !== new Set(ids).size) throw new HttpError(400, 'Unknown branch')
  }
  app.get('/api/email/status', need('owner'), (_q, res) => { res.json(emailStatus()) })
  app.post('/api/email/test', need('owner'), async (_q, res) => {
    const r = await notify.sendNow([me(res).email], 'SmartBiz test email', 'If you can read this, SmartBiz can send email. You can ignore this message.')
    if (!r.ok) throw new HttpError(502, `The email could not be sent: ${r.error}`)
    res.json({ ok: true, provider: emailProvider(), sentTo: me(res).email })
  })
  app.post('/api/invites', need('owner'), async (req, res) => {
    const u = me(res)
    const b = z.object({ email, role: staffRole, branchIds: z.array(uuid).min(1).max(50) }).parse(req.body)
    await validBranches(u.business_id, b.branchIds)
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [b.email])).rowCount) throw new HttpError(409, 'That email address is already registered')
    await assertUserSlot(u.business_id)
    const biz = (await pool.query('SELECT name FROM businesses WHERE id=$1', [u.business_id])).rows[0]
    const raw = await tx(async c => {
      await c.query("DELETE FROM auth_tokens WHERE purpose='invite' AND email=$1 AND used_at IS NULL", [b.email])
      const t = await makeToken(c, 'invite', b.email, u.business_id, b.role, null, 168, { branchIds: b.branchIds })
      await audit(c, u, 'invite.create', 'invite', b.email, { role: b.role })
      return t
    })
    res.status(201).json({ ok: true, ...(await emailOrLink(notify, b.email, `${u.name} invited you to ${biz.name} on SmartBiz`, `You have been invited to ${biz.name} as ${b.role}.\nAccept and choose your password (valid 7 days):\n${appUrl()}/#/invite?token=${raw}`, `${appUrl()}/#/invite?token=${raw}`)) })
  })
  app.get('/api/invites', need('owner'), async (_q, res) => {
    res.json((await pool.query("SELECT id,email,role,expires_at FROM auth_tokens WHERE business_id=$1 AND purpose='invite' AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC", [me(res).business_id])).rows)
  })
  app.delete('/api/invites/:id', need('owner'), async (req, res) => {
    await pool.query("DELETE FROM auth_tokens WHERE id=$1 AND business_id=$2 AND purpose='invite'", [uuid.parse(req.params.id), me(res).business_id])
    res.json({ ok: true })
  })
  app.patch('/api/users/:id', need('owner'), async (req, res) => {
    const u = me(res), id = uuid.parse(req.params.id)
    const b = z.object({ role: staffRole.optional(), active: z.boolean().optional(), branchIds: z.array(uuid).min(1).max(50).optional() }).parse(req.body)
    if (id === u.id) throw new HttpError(400, 'You cannot change your own account here')
    const cur = (await pool.query('SELECT active,role FROM users WHERE id=$1 AND business_id=$2 AND NOT is_platform', [id, u.business_id])).rows[0]
    if (!cur) throw new HttpError(404, 'User not found')
    if (cur.role === 'owner') throw new HttpError(400, 'The owner account cannot be changed')
    if (b.branchIds) await validBranches(u.business_id, b.branchIds)
    if (b.active && !cur.active) await assertUserSlot(u.business_id)
    await tx(async c => {
      await c.query('UPDATE users SET role=COALESCE($1,role), active=COALESCE($2,active) WHERE id=$3', [b.role ?? null, b.active ?? null, id])
      if (b.branchIds) { await c.query('DELETE FROM user_branches WHERE user_id=$1', [id]); await c.query('INSERT INTO user_branches(user_id,branch_id) SELECT $1, unnest($2::uuid[])', [id, b.branchIds]) }
      await audit(c, u, 'user.update', 'user', id, b)
    })
    res.json({ ok: true })
  })
  const target = async (actor: U, id: string) => {
    const t = (await pool.query('SELECT id,business_id,name,email FROM users WHERE id=$1 AND business_id=$2 AND NOT is_platform', [id, actor.business_id])).rows[0]
    if (!t) throw new HttpError(404, 'User not found')
    if (t.id === actor.id) throw new HttpError(400, 'Use Change password for your own account')
    return t as { id: string; business_id: string; name: string; email: string }
  }
  app.post('/api/users/:id/password', need('owner'), async (req, res) => {
    const u = me(res), t = await target(u, uuid.parse(req.params.id)), b = z.object({ password }).parse(req.body)
    await pool.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=true WHERE id=$2', [await bcrypt.hash(b.password, 12), t.id])
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id])
    await audit(pool, u, 'user.temp_password', 'user', t.id)
    notify.send([t.email], 'Your SmartBiz password was reset', 'The business owner set a temporary password for your account. Sign in with it and you will be asked to choose a new password.')
    res.json({ ok: true })
  })
  app.post('/api/users/:id/reset-link', need('owner'), async (req, res) => {
    const u = me(res), t = await target(u, uuid.parse(req.params.id))
    const raw = await makeToken(pool, 'reset', t.email, t.business_id, null, t.id, 1)
    await audit(pool, u, 'user.reset_link', 'user', t.id)
    res.json({ ok: true, ...(await emailOrLink(notify, t.email, 'Reset your SmartBiz password', `The business owner sent you a password reset link (valid 1 hour):\n${appUrl()}/#/reset?token=${raw}`, `${appUrl()}/#/reset?token=${raw}`)) })
  })
  app.get('/api/audit', need('owner'), async (_q, res) => {
    res.json((await pool.query(`SELECT l.id,l.action,l.entity,l.entity_id,l.detail,l.created_at,u.name AS actor FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id
      WHERE l.business_id=$1 ORDER BY l.id DESC LIMIT 100`, [me(res).business_id])).rows)
  })
}
