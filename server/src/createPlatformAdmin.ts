import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { migrate, pool } from './db.js'

// Usage: npm run platform-admin -- you@yourcompany.com 'a-long-password'
const [email, pw] = process.argv.slice(2)
if (!email || !pw || pw.length < 10) { console.error('Usage: npm run platform-admin -- <email> <password of 10+ characters>'); process.exit(1) }
await migrate()
const hash = await bcrypt.hash(pw, 12)
let biz = (await pool.query("SELECT id FROM businesses WHERE name='OnyxTech Platform' LIMIT 1")).rows[0]
biz ??= (await pool.query("INSERT INTO businesses(name,paid,period_end) VALUES('OnyxTech Platform',true,now()+interval '100 years') RETURNING id")).rows[0]
await pool.query(`INSERT INTO users(business_id,name,email,password_hash,role,is_platform) VALUES($1,'Platform Admin',lower($2),$3,'owner',true)
  ON CONFLICT (email) DO UPDATE SET password_hash=$3, is_platform=true, password_changed_at=now()`, [biz.id, email, hash])
console.log('Platform admin ready:', email.toLowerCase())
await pool.end()
