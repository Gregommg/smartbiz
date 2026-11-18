import crypto from 'node:crypto'
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32(buf: Buffer) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += ALPHA[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out }
function unb32(s: string) { let bits = ''; for (const ch of s.replace(/=+$/, '')) bits += ALPHA.indexOf(ch).toString(2).padStart(5, '0'); const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out) }
export const newSecret = () => b32(crypto.randomBytes(20))
export function hotp(secret: string, counter: number) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', unb32(secret)).update(c).digest(), o = h[19] & 15
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0')
}
export const totpAt = (secret: string, t = Date.now()) => hotp(secret, Math.floor(t / 30000))
/** Returns the matched 30-second step, or null. A step at or before `afterStep` is refused so a code cannot be replayed. */
export function verifyTotp(secret: string, code: string, afterStep: number | null, now = Date.now()): number | null {
  const step = Math.floor(now / 30000)
  for (const d of [-1, 0, 1]) {
    const s = step + d
    if (afterStep !== null && s <= afterStep) continue
    const want = Buffer.from(hotp(secret, s)), got = Buffer.from(code)
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return s
  }
  return null
}
export const otpauth = (email: string, secret: string) => `otpauth://totp/SmartBiz:${encodeURIComponent(email)}?secret=${secret}&issuer=SmartBiz`
