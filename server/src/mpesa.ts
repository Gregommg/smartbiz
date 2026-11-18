export type Creds = { env: string; consumerKey: string; consumerSecret: string; shortcode: string; partyB: string; passkey: string; txType: string }
type Args = { phone: string; amount: number; ref: string; callbackUrl: string; desc?: string }
export type Mpesa = {
  /** Subscription payments to the platform owner (uses MPESA_* environment variables). */
  stkPush(a: { phone: string; amount: number; ref: string }): Promise<{ checkoutRequestId: string }>
  /** A business's own till or paybill (credentials stored encrypted per business). */
  stkPushFor(c: Creds, a: Args): Promise<{ checkoutRequestId: string }>
}

async function stk(c: Creds, a: Args) {
  const base = c.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'
  const tr = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: 'Basic ' + Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64') } })
  if (!tr.ok) throw new Error(`Daraja auth failed (${tr.status})`)
  const { access_token } = (await tr.json()) as { access_token: string }
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const r = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: c.shortcode, Password: Buffer.from(`${c.shortcode}${c.passkey}${ts}`).toString('base64'), Timestamp: ts, TransactionType: c.txType,
      Amount: Math.ceil(a.amount), PartyA: a.phone, PartyB: c.partyB, PhoneNumber: a.phone, CallBackURL: a.callbackUrl, AccountReference: a.ref.slice(0, 12), TransactionDesc: (a.desc ?? 'Payment').slice(0, 13) }) })
  const j = (await r.json()) as { ResponseCode?: string; CheckoutRequestID?: string }
  if (!r.ok || j.ResponseCode !== '0' || !j.CheckoutRequestID) throw new Error(`STK push rejected: ${JSON.stringify(j).slice(0, 200)}`)
  return { checkoutRequestId: j.CheckoutRequestID }
}
export function daraja(): Mpesa {
  return {
    stkPushFor: stk,
    async stkPush({ phone, amount, ref }) {
      const e = process.env
      for (const k of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'APP_URL']) if (!e[k]) throw new Error(`${k} is not set`)
      return stk({ env: e.MPESA_ENV ?? 'sandbox', consumerKey: e.MPESA_CONSUMER_KEY!, consumerSecret: e.MPESA_CONSUMER_SECRET!, shortcode: e.MPESA_SHORTCODE!, partyB: e.MPESA_SHORTCODE!, passkey: e.MPESA_PASSKEY!, txType: 'CustomerPayBillOnline' },
        { phone, amount, ref, callbackUrl: `${e.APP_URL}/api/mpesa/callback/${e.MPESA_CALLBACK_SECRET}`, desc: 'SmartBiz plan' })
    },
  }
}
