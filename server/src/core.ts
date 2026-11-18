import type { NextFunction, Request, Response } from 'express'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { pool, type Q } from './db.js'
import type { Mailer } from './mail.js'

export type Role = 'owner' | 'manager' | 'cashier' | 'storekeeper'
/** branch_ids: null means every branch of the business (owner). */
export type U = { id: string; business_id: string; role: Role; name: string; email: string; is_platform: boolean; must_change_password: boolean; branch_ids: string[] | null; password_changed_at?: Date }
export class HttpError extends Error { constructor(public status: number, message: string, public details?: string[]) { super(message) } }
export const me = (res: Response) => res.locals.user as U
export const money = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
export const canSeeCost = (u: U) => u.role !== 'cashier'
export const GRACE_DAYS = 7
export const appUrl = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
export const hashTok = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
export const secret = () => {
  const s = process.env.JWT_SECRET
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to 32+ characters')
  return s
}
export const sign = (id: string, pv: Date) => jwt.sign({ uid: id, pv: pv.getTime() }, secret(), { expiresIn: '15m' })
export const audit = (q: Q, u: { id: string; business_id: string }, action: string, entity: string, id: string, detail: object = {}) =>
  q.query('INSERT INTO audit_logs(business_id,actor_id,action,entity,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)', [u.business_id, u.id, action, entity, id, JSON.stringify(detail)])
export const need = (...roles: Role[]) => (_q: Request, res: Response, next: NextFunction) =>
  roles.includes(me(res).role) ? next() : next(new HttpError(403, 'You do not have permission for this action'))

export function subState(o: { period_end: Date | string; paid: boolean }, now = new Date()) {
  const end = new Date(o.period_end).getTime(), t = now.getTime()
  if (t <= end) return o.paid ? 'active' : 'trialing'
  return t <= end + GRACE_DAYS * 864e5 ? 'grace' : 'suspended'
}
export async function branchIds(u: U): Promise<string[]> {
  if (u.branch_ids) return u.branch_ids
  return (await pool.query('SELECT id FROM branches WHERE business_id=$1 AND active', [u.business_id])).rows.map(r => r.id)
}
export async function requireBranch(u: U, id: string) {
  if (!(await branchIds(u)).includes(id)) throw new HttpError(403, 'You do not have access to this branch')
  return id
}
export async function assertUserSlot(businessId: string, q: Q = pool) {
  const r = (await q.query(`SELECT p.max_users, (SELECT count(*)::int FROM users WHERE business_id=$1 AND active) AS used
    FROM businesses b JOIN plans p ON p.code=b.plan_code WHERE b.id=$1`, [businessId])).rows[0]
  if (r.used >= r.max_users) throw new HttpError(402, `Your plan allows ${r.max_users} users. Upgrade your plan to add more.`)
}
export async function assertBranchSlot(businessId: string, q: Q = pool) {
  const r = (await q.query(`SELECT p.max_branches, (SELECT count(*)::int FROM branches WHERE business_id=$1 AND active) AS used
    FROM businesses b JOIN plans p ON p.code=b.plan_code WHERE b.id=$1`, [businessId])).rows[0]
  if (r.used >= r.max_branches) throw new HttpError(402, `Your plan allows ${r.max_branches} branch(es). Upgrade your plan to add more.`)
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) throw new HttpError(401, 'Sign in required')
  let p: { uid: string; pv: number }
  try { p = jwt.verify(token, secret()) as { uid: string; pv: number } } catch { throw new HttpError(401, 'Session expired, sign in again') }
  const { rows } = await pool.query(`SELECT u.id,u.business_id,u.role,u.name,u.email,u.is_platform,u.must_change_password,u.password_changed_at,
    b.period_end,b.paid,b.plan_code, b.name AS business_name,
    CASE WHEN u.role='owner' THEN NULL ELSE (SELECT coalesce(array_agg(ub.branch_id), '{}') FROM user_branches ub JOIN branches br ON br.id=ub.branch_id AND br.active WHERE ub.user_id=u.id) END AS branch_ids
    FROM users u JOIN businesses b ON b.id=u.business_id WHERE u.id=$1 AND u.active`, [p.uid])
  const r = rows[0]
  if (!r || p.pv !== new Date(r.password_changed_at).getTime()) throw new HttpError(401, 'Session expired, sign in again')
  const state = subState(r)
  res.locals.user = { id: r.id, business_id: r.business_id, role: r.role, name: r.name, email: r.email, is_platform: r.is_platform, must_change_password: r.must_change_password, branch_ids: r.branch_ids }
  res.locals.sub = { state, plan: r.plan_code, periodEnd: r.period_end, business: r.business_name }
  if (r.must_change_password && !['/me', '/auth/change-password'].includes(req.path)) throw new HttpError(403, 'Please choose a new password first')
  if (state === 'suspended' && !r.is_platform && req.method !== 'GET' && !req.path.startsWith('/billing') && !req.path.startsWith('/auth/'))
    throw new HttpError(402, 'Your subscription has expired. The owner can renew it under Billing.')
  next()
}

export function makeNotifier(mail: Mailer) {
  const send = (to: string[], subject: string, text: string) => {
    const list = [...new Set(to)].filter(Boolean)
    if (list.length) mail(list, subject, text).catch(e => console.error('email failed:', (e as Error).message))
  }
  const sendNow = async (to: string[], subject: string, text: string): Promise<{ ok: boolean; error?: string }> => {
    const list = [...new Set(to)].filter(Boolean)
    try { await mail(list, subject, text); return { ok: true } } catch (e) { console.error('email failed:', (e as Error).message); return { ok: false, error: (e as Error).message } }
  }
  return { send, sendNow }
}
export type Notifier = ReturnType<typeof makeNotifier>
/** Sends now and tells the truth: if the email fails, the caller gets the link so the owner can pass it on by hand. */
export async function emailOrLink(notify: Notifier, to: string, subject: string, text: string, link: string) {
  const r = await notify.sendNow([to], subject, text)
  return r.ok ? { emailSent: true } : { emailSent: false, emailError: r.error, link }
}

export async function makeToken(c: Q, purpose: 'invite' | 'reset', email: string, businessId: string, role: string | null, userId: string | null, hours: number, detail: object = {}) {
  const raw = crypto.randomBytes(32).toString('base64url')
  await c.query(`INSERT INTO auth_tokens(purpose,email,business_id,role,user_id,detail,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(hours=>$8::int))`,
    [purpose, email, businessId, role, userId, JSON.stringify(detail), hashTok(raw), hours])
  return raw
}

const COOKIE = 'sb_session', SESSION_DAYS = 180
export const cookieOf = (req: Request) => (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1)
const cookieOpts = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/api/auth', maxAge: SESSION_DAYS * 864e5 })
export const SESSION = { COOKIE, SESSION_DAYS, cookieOpts }
/** Long-lived login: random token in an httpOnly cookie; only its hash is stored. */
export async function startSession(req: Request, res: Response, userId: string) {
  const raw = crypto.randomBytes(32).toString('base64url')
  await pool.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+make_interval(days=>$3::int))', [userId, hashTok(raw), SESSION_DAYS])
  res.cookie(COOKIE, raw, cookieOpts(req))
}
