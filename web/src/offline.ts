// Sales made without a connection are kept on the device and sent later. Each sale carries its own idempotency key, so the server never records one twice.
export type Queued = { key: string; userId: string; branchId: string; body: any; label: string; total: number; at: string; status: 'pending' | 'failed'; error?: string }
export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
function memoryStore(): Store { const m = new Map<string, string>(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) } }
export const defaultStore: Store = typeof localStorage !== 'undefined' ? localStorage : memoryStore()
export { memoryStore }
const QK = 'sb_queue', CK = (b: string) => 'sb_catalog_' + b
const notify = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('sb-queue')) }

export function loadQueue(s: Store = defaultStore): Queued[] { try { return JSON.parse(s.getItem(QK) ?? '[]') } catch { return [] } }
const save = (q: Queued[], s: Store) => { s.setItem(QK, JSON.stringify(q)); notify() }
export function enqueue(item: Omit<Queued, 'status'>, s: Store = defaultStore) {
  const q = loadQueue(s); if (!q.some(x => x.key === item.key)) q.push({ ...item, status: 'pending' }); save(q, s); return q
}
export const removeFromQueue = (key: string, s: Store = defaultStore) => save(loadQueue(s).filter(x => x.key !== key), s)
export const markFailed = (key: string, error: string, s: Store = defaultStore) => save(loadQueue(s).map(x => x.key === key ? { ...x, status: 'failed' as const, error } : x), s)
export const retryFailed = (key: string, s: Store = defaultStore) => save(loadQueue(s).map(x => x.key === key ? { ...x, status: 'pending' as const, error: undefined } : x), s)
/** Units of a product already promised in queued sales, so offline stock figures do not oversell. */
export const queuedQty = (branchId: string, productId: string, s: Store = defaultStore) =>
  loadQueue(s).filter(x => x.branchId === branchId && x.status !== 'failed').reduce((a, x) => a + (x.body.items as any[]).filter(i => i.productId === productId).reduce((b, i) => b + i.qty, 0), 0)

export type Catalogued = { id: string; sku: string; barcode: string | null; name: string; price: number; stock: number; unit: string }
export const cacheCatalog = (branchId: string, products: Catalogued[], s: Store = defaultStore) => { try { s.setItem(CK(branchId), JSON.stringify({ at: Date.now(), products })) } catch { /* storage full: offline search just won't be available */ } }
export function loadCatalog(branchId: string, s: Store = defaultStore): { at: number; products: Catalogued[] } | null { try { return JSON.parse(s.getItem(CK(branchId)) ?? 'null') } catch { return null } }
export function searchCatalog(products: Catalogued[], q: string, limit = 40) {
  const t = q.trim().toLowerCase()
  return products.filter(p => !t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || (p.barcode ?? '') === q.trim()).slice(0, limit)
}

export type SendResult = { ok: true } | { ok: false; network: boolean; error: string }
let syncing = false
/** Sends queued sales in order. A network or server failure stops the run (try again later); a refusal (stock, permission…) marks that sale "needs attention" and carries on. */
export async function syncQueue(send: (body: any) => Promise<SendResult>, belongsTo: (q: Queued) => boolean = () => true, s: Store = defaultStore) {
  if (syncing) return { synced: 0, failed: 0 }
  syncing = true
  let synced = 0, failed = 0
  try {
    for (const q of loadQueue(s).filter(x => x.status === 'pending' && belongsTo(x))) {
      const r = await send(q.body)
      if (r.ok) { removeFromQueue(q.key, s); synced++ }
      else if (r.network) break
      else { markFailed(q.key, r.error, s); failed++ }
    }
  } finally { syncing = false }
  return { synced, failed }
}
