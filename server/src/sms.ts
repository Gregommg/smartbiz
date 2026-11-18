export type Sms = { send(to: string, message: string): Promise<{ ok: boolean; id?: string; error?: string }> }
/** Africa's Talking SMS (https://africastalking.com). Needs AT_USERNAME and AT_API_KEY; AT_SENDER_ID optional; AT_ENV=sandbox|production. */
export function africasTalking(): Sms {
  return {
    async send(to, message) {
      const e = process.env
      if (!e.AT_USERNAME || !e.AT_API_KEY) return { ok: false, error: 'SMS is not configured on this server' }
      const base = e.AT_ENV === 'production' ? 'https://api.africastalking.com' : 'https://api.sandbox.africastalking.com'
      const body = new URLSearchParams({ username: e.AT_USERNAME, to: '+' + to.replace(/^\+/, ''), message, ...(e.AT_SENDER_ID ? { from: e.AT_SENDER_ID } : {}) })
      const r = await fetch(`${base}/version1/messaging`, { method: 'POST', headers: { apiKey: e.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body })
      const j = (await r.json().catch(() => ({}))) as any
      const rec = j?.SMSMessageData?.Recipients?.[0]
      if (!r.ok || !rec || !/success/i.test(rec.status)) return { ok: false, error: String(rec?.status ?? j?.SMSMessageData?.Message ?? r.status).slice(0, 200) }
      return { ok: true, id: rec.messageId }
    },
  }
}
