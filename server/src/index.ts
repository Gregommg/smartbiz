import 'dotenv/config'
import { createApp } from './app.js'
import { migrate } from './db.js'
import { smtpMailer, describeEmail } from './mail.js'
import { makeNotifier } from './core.js'
import { sendDigests } from './digest.js'
import { processEtimsQueue, disabledEtims } from './etims.js'

await migrate()
console.log('Email:', describeEmail())
const notify = makeNotifier(smtpMailer())
setInterval(() => sendDigests(notify).catch(e => console.error('digest failed:', e)), 3600e3)
setInterval(() => processEtimsQueue(disabledEtims).catch(e => console.error('eTIMS queue failed:', e)), 300e3)
const port = Number(process.env.PORT ?? 4000)
createApp().listen(port, () => console.log(`SmartBiz listening on port ${port}`))
