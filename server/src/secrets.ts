import crypto from 'node:crypto'
// AES-256-GCM for stored secrets (M-Pesa credentials, MFA secrets). Set ENCRYPTION_KEY once and never change it; it falls back to JWT_SECRET.
const key = () => crypto.createHash('sha256').update('smartbiz-enc:' + (process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || '')).digest()
export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.')
}
export function decrypt(s: string) {
  const [iv, tag, enc] = s.split('.').map(x => Buffer.from(x, 'base64'))
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}
