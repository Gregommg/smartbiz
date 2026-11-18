import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { ZodError } from 'zod'
import { smtpMailer } from './mail.js'
import { daraja } from './mpesa.js'
import { HttpError, authenticate, makeNotifier, secret } from './core.js'
import { registerAuthPublic, registerAccount } from './auth.js'
import { registerBilling, registerBillingPublic, type Deps } from './billing.js'
import { registerCatalog } from './catalog.js'
import { registerStock } from './stock.js'
import { registerSales } from './sales.js'
import { registerReports } from './reports.js'
import { africasTalking } from './sms.js'
import { disabledEtims } from './etims.js'
import { registerSettings, tillMpesaCallback } from './settings.js'
import { registerCredit } from './credit.js'
import { registerPayables } from './payables.js'
import { registerCashup } from './cashup.js'
import { registerExports } from './exports.js'

export function createApp(deps: Partial<Deps> = {}) {
  secret()
  const d: Deps = { mailer: deps.mailer ?? smtpMailer(), mpesa: deps.mpesa ?? daraja(), sms: deps.sms ?? africasTalking(), etims: deps.etims ?? disabledEtims }
  const notify = makeNotifier(d.mailer)
  const app = express()
  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false }))
  app.use(express.json({ limit: '1mb' }))

  registerAuthPublic(app, notify)
  registerBillingPublic(app)
  // Safaricom calls this for a business's own till payments. The secret in the URL is per business and stored with their credentials.
  app.post('/api/till-mpesa/callback/:businessId/:secret', async (req, res) => {
    const ok = /^[0-9a-f-]{36}$/.test(String(req.params.businessId)) && (!req.body?.Body?.stkCallback?.CheckoutRequestID || await tillMpesaCallback(String(req.params.businessId), String(req.params.secret), req.body.Body.stkCallback))
    if (!ok) return void res.status(404).json({ error: 'Not found' })
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  })
  app.use('/api', authenticate)
  registerAccount(app, notify)
  registerCatalog(app)
  registerStock(app)
  registerSales(app, d)
  registerSettings(app, d)
  registerCredit(app)
  registerPayables(app)
  registerCashup(app)
  registerExports(app)
  registerReports(app)
  registerBilling(app, d, notify)
  app.use('/api', (_q, _s, next) => next(new HttpError(404, 'Not found')))

  const dist = path.resolve(process.env.WEB_DIST ?? '../web/dist')
  if (fs.existsSync(dist)) {
    app.use(express.static(dist))
    app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next())
  }

  app.use((err: any, _q: Request, res: Response, _n: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', details: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`) })
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details })
    if (err?.code === '23505') return res.status(409).json({ error: 'That record already exists (duplicate SKU, barcode, name or email)' })
    if (err?.code === '23514' && String(err.constraint).includes('qty')) return res.status(409).json({ error: 'Not enough stock for this change' })
    if (err?.code === '23514') return res.status(400).json({ error: 'A value is out of range' })
    if (err?.code === '23503') return res.status(409).json({ error: 'This record is in use and cannot be changed that way' })
    console.error(err)
    res.status(500).json({ error: 'Something went wrong on our side' })
  })
  return app
}
