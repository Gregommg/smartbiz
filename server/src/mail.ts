import nodemailer from 'nodemailer'

export type Mailer = (to: string[], subject: string, text: string) => Promise<void>
type Provider = 'brevo' | 'resend' | 'smtp' | 'none'

export function emailProvider(): Provider {
  const e = process.env, p = (e.EMAIL_PROVIDER ?? '').toLowerCase()
  if (p === 'brevo' || p === 'resend' || p === 'smtp') return p
  if (e.BREVO_API_KEY) return 'brevo'
  if (e.RESEND_API_KEY) return 'resend'
  if (e.SMTP_HOST) return 'smtp'
  return 'none'
}
export const emailFrom = () => process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || ''
const parseFrom = (s: string) => { const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { name: undefined, email: s.trim() } }

/** What is configured, without revealing any secret. `ready` is false when something needed is missing. */
export function emailStatus() {
  const e = process.env, provider = emailProvider(), from = emailFrom()
  let problem = ''
  if (provider === 'none') problem = 'No email service is set up. Set EMAIL_PROVIDER=brevo (or resend) with its API key, and EMAIL_FROM.'
  else if (provider === 'brevo' && !e.BREVO_API_KEY) problem = 'BREVO_API_KEY is missing.'
  else if (provider === 'resend' && !e.RESEND_API_KEY) problem = 'RESEND_API_KEY is missing.'
  else if (provider === 'smtp' && !e.SMTP_HOST) problem = 'SMTP_HOST is missing.'
  else if (!from) problem = 'EMAIL_FROM is missing (the address emails are sent from).'
  return { provider, from, ready: !problem, problem: problem || null }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, name: string) {
  let r: Response
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }) }
  catch (e) { throw new Error(`Could not reach ${name}: ${(e as Error).message}`) }
  if (!r.ok) throw new Error(`${name} refused the email (HTTP ${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`)
}

let smtp: { key: string; t: ReturnType<typeof nodemailer.createTransport> } | null = null
export function createMailer(): Mailer {
  return async (to, subject, text) => {
    const st = emailStatus(); if (!st.ready) throw new Error(st.problem!)
    const e = process.env, from = parseFrom(st.from)
    if (st.provider === 'brevo')
      return postJson(e.BREVO_API_URL ?? 'https://api.brevo.com/v3/smtp/email', { 'api-key': e.BREVO_API_KEY! }, { sender: { ...(from.name ? { name: from.name } : {}), email: from.email }, to: to.map(email => ({ email })), subject, textContent: text }, 'Brevo')
    if (st.provider === 'resend')
      return postJson(e.RESEND_API_URL ?? 'https://api.resend.com/emails', { Authorization: `Bearer ${e.RESEND_API_KEY}` }, { from: st.from, to, subject, text }, 'Resend')
    const port = Number(e.SMTP_PORT ?? 587)
    const key = `${e.SMTP_HOST}:${port}:${e.SMTP_USER}`
    if (smtp?.key !== key) smtp = { key, t: nodemailer.createTransport({ host: e.SMTP_HOST, port, secure: port === 465, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined }) }
    try { await smtp.t.sendMail({ from: st.from, to, subject, text }) }
    catch (err: any) {
      if (['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'ECONNECTION', 'EDNS'].includes(err?.code))
        throw new Error(`Could not connect to the SMTP server (${err.code}). Some hosts, including Render free instances, block SMTP ports 25/465/587. Use EMAIL_PROVIDER=brevo or resend instead.`)
      throw err
    }
  }
}
export const smtpMailer = createMailer   // older name, kept so existing imports keep working
export const describeEmail = () => { const s = emailStatus(); return s.ready ? `${s.provider} (from ${s.from})` : `NOT CONFIGURED: ${s.problem}` }
