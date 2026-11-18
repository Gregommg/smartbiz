export const TOKEN = 'smartbiz_token'
export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg) } }
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

let refreshing: Promise<boolean> | null = null
function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST' })
    .then(async r => { if (!r.ok) return false; localStorage.setItem(TOKEN, (await r.json()).token); return true })
    .catch(() => false).finally(() => { refreshing = null })
  return refreshing
}
type Opts = { method?: string; body?: unknown }
async function call(path: string, o: Opts, retried = false): Promise<Response> {
  const h: Record<string, string> = {}
  const t = localStorage.getItem(TOKEN)
  if (t) h.Authorization = 'Bearer ' + t
  if (o.body !== undefined) h['Content-Type'] = 'application/json'
  const r = await fetch('/api' + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers: h, body: o.body !== undefined ? JSON.stringify(o.body) : undefined })
  if (r.status === 401 && !retried && !/^\/auth\/(login|register|refresh|logout|accept-invite|forgot|reset)/.test(path)) {
    if (await refresh()) return call(path, o, true)   // quietly renew the short-lived token from the long-lived session cookie
    localStorage.removeItem(TOKEN); window.dispatchEvent(new Event('sb-auth-lost'))
  }
  return r
}
export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const r = await call(path, o)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(j.details?.length ? `${j.error}: ${j.details.join('; ')}` : j.error || 'Request failed', r.status)
  return j as T
}
export async function apiBlob(path: string): Promise<Blob> {
  const r = await call(path, {})
  if (!r.ok) throw new ApiError('Could not download the file', r.status)
  return r.blob()
}
