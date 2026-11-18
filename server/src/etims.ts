import { pool } from './db.js'

export type EtimsResult = { ok: boolean; notConnected?: boolean; error?: string; response?: unknown }
/** Adapter to a KRA-approved eTIMS route. NOT IMPLEMENTED: the default adapter only reports "not connected". */
export type Etims = { submit(payload: object): Promise<EtimsResult>; /** Safe connection check that never submits an invoice. */ ping?(): Promise<boolean> }
export const disabledEtims: Etims = { async submit() { return { ok: false, notConnected: true, error: 'No KRA eTIMS connection is configured' } } }

/** Sends queued invoices through the adapter. Returns how many were sent. */
export async function processEtimsQueue(etims: Etims, businessId?: string, limit = 50) {
  const rows = (await pool.query(`SELECT id,payload FROM etims_queue WHERE status IN ('pending','failed','not_connected') AND attempts < 10 AND ($1::uuid IS NULL OR business_id=$1)
    ORDER BY created_at LIMIT $2`, [businessId ?? null, limit])).rows
  let sent = 0
  for (const r of rows) {
    let res: EtimsResult
    try { res = await etims.submit(r.payload) } catch (e) { res = { ok: false, error: (e as Error).message } }
    if (res.ok) { sent++; await pool.query("UPDATE etims_queue SET status='sent', attempts=attempts+1, response=$2, last_error=NULL, updated_at=now() WHERE id=$1", [r.id, JSON.stringify(res.response ?? {})]) }
    else await pool.query('UPDATE etims_queue SET status=$2, attempts=attempts+1, last_error=$3, updated_at=now() WHERE id=$1', [r.id, res.notConnected ? 'not_connected' : 'failed', res.error ?? 'Unknown error'])
  }
  return sent
}
