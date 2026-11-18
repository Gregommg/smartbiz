import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore, enqueue, loadQueue, syncQueue, markFailed, retryFailed, removeFromQueue, cacheCatalog, loadCatalog, searchCatalog, queuedQty } from '../src/offline.ts'

const item = (key: string, qty = 1, userId = 'u1') => ({ key, userId, branchId: 'b1', label: key, total: 100, at: new Date().toISOString(), body: { items: [{ productId: 'p1', qty }] } })

test('queue keeps sales, ignores duplicates, tracks promised stock', () => {
  const s = memoryStore(); enqueue(item('a', 2), s); enqueue(item('a', 2), s); enqueue(item('b', 3), s)
  assert.equal(loadQueue(s).length, 2); assert.equal(queuedQty('b1', 'p1', s), 5); assert.equal(queuedQty('b2', 'p1', s), 0)
  markFailed('b', 'Not enough stock', s); assert.equal(queuedQty('b1', 'p1', s), 2)   // a failed sale no longer holds stock
  retryFailed('b', s); assert.equal(loadQueue(s).find(x => x.key === 'b')!.status, 'pending'); removeFromQueue('a', s); assert.deepEqual(loadQueue(s).map(x => x.key), ['b'])
})
test('sync: sent sales are removed, refusals need attention and do not block the rest', async () => {
  const s = memoryStore(); for (const k of ['a', 'b', 'c']) enqueue(item(k), s)
  const sent: string[] = []
  const r = await syncQueue(async body => { const k = (body as any).k; sent.push(k); return { ok: true } }, () => true, s)
  assert.equal(r.synced, 3); assert.equal(loadQueue(s).length, 0)
  for (const k of ['a', 'b', 'c']) enqueue({ ...item(k), body: { k, items: [] } }, s)
  const r2 = await syncQueue(async body => (body as any).k === 'b' ? { ok: false, network: false, error: 'Not enough stock: Milk' } : { ok: true }, () => true, s)
  assert.deepEqual(r2, { synced: 2, failed: 1 }); const left = loadQueue(s); assert.equal(left.length, 1); assert.equal(left[0].status, 'failed'); assert.equal(left[0].error, 'Not enough stock: Milk')
})
test('sync stops on a network failure and keeps everything for later; only the signed-in user\'s sales are sent', async () => {
  const s = memoryStore(); enqueue(item('a'), s); enqueue(item('b'), s); enqueue(item('c', 1, 'someone-else'), s)
  let calls = 0
  const r = await syncQueue(async () => { calls++; return { ok: false, network: true, error: 'offline' } }, q => q.userId === 'u1', s)
  assert.equal(calls, 1); assert.deepEqual(r, { synced: 0, failed: 0 }); assert.equal(loadQueue(s).filter(x => x.status === 'pending').length, 3)
  const r2 = await syncQueue(async () => ({ ok: true }), q => q.userId === 'u1', s); assert.equal(r2.synced, 2); assert.deepEqual(loadQueue(s).map(x => x.key), ['c'])   // another user's sale waits for them
})
test('offline catalogue: cached per branch, searched by name, SKU or exact barcode', () => {
  const s = memoryStore(); assert.equal(loadCatalog('b1', s), null)
  cacheCatalog('b1', [{ id: '1', sku: 'SUG1', barcode: '6001', name: 'Sugar 1kg', price: 200, stock: 5, unit: 'pcs' }, { id: '2', sku: 'MLK', barcode: null, name: 'Milk', price: 60, stock: 9, unit: 'pcs' }], s)
  const c = loadCatalog('b1', s)!.products
  assert.deepEqual(searchCatalog(c, 'sug').map(p => p.id), ['1']); assert.deepEqual(searchCatalog(c, 'MLK').map(p => p.id), ['2']); assert.deepEqual(searchCatalog(c, '6001').map(p => p.id), ['1']); assert.equal(searchCatalog(c, '').length, 2)
})
