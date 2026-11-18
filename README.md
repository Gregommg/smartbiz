# SmartBiz: sales, stock and business reports for shops and wholesalers (OnyxTech)

Multi-business SaaS. Node.js + Express + TypeScript API, PostgreSQL, React + Vite web app (installable on phones and tablets).
One server serves both the API and the web app. Each business's data is separate; each user only sees the branches they are assigned to.

## What is included
- **Business and people:** register a business (14-day free trial), branches, staff invitations by email with a role and branch access, forgot/reset password, owner can change roles/branches, disable users,
  email a reset link or set a temporary password. Users stay signed in until they sign out. **Two-step sign-in (authenticator app + recovery codes)** for anyone; owner can reset a colleague's.
- **Roles:** owner (everything), manager (products, purchasing, stock, expenses, refunds, discounts, reports, cash-ups), cashier (sell, own sales, customers; cannot see cost prices), storekeeper (stock, purchasing).
- **Products:** SKU, barcode, category, unit, cost, price, reorder level, **variants** (size/colour created together, each with its own stock and barcode), **tax class**, **batch and expiry tracking**, CSV import with opening stock.
- **Stock ledger:** every change is an immutable record (the database refuses edits and deletes); stock never goes below zero; adjustments need a reason; transfers between branches (batches travel with the stock).
  **Batches and expiry:** sold first-expiry-first-out, expired stock is never sold, refunds go back to the batch they came from, expiry report, write-offs, daily email.
- **Purchasing:** suppliers, purchase orders, partial receipts (with batch and expiry), weighted-average cost. **Supplier invoices and payables:** invoices, part payments, what you owe and how late (ageing).
- **Point of sale:** scanner-friendly search (USB/Bluetooth scanner or **phone camera**), cart, discounts and price changes (managers only), cash with change, card, bank, **M-Pesa prompt sent to the customer's phone with automatic confirmation**
  (or a typed code), **sale on customer account**, split payments, printable receipt with VAT and your KRA PIN, receipts by **WhatsApp** or **SMS**, duplicate-proof retries.
- **Works offline:** the till keeps selling with no internet (cash, card, bank, typed M-Pesa code). Sales are saved on the device and sent automatically when the connection returns, each recorded exactly once with its real time.
- **Customer credit:** credit limits, balances, payments received, statements, refunds to the account, write-offs (owner), amounts customers owe you.
- **Cash-up:** cashiers open their till with a float and close it by counting; SmartBiz shows the expected cash and the difference; optional "must open the till before selling".
- **VAT and eTIMS:** VAT-inclusive pricing with tax classes, VAT on receipts and in reports, and a queue holding every sale's invoice data ready for KRA eTIMS (**not connected, see below**).
- **Refunds, expenses, customers, sales history, reports** (net sales, margin, profit, VAT, credit, payables, best sellers, low stock, slow movers) and **CSV downloads for your accountant** (sales, payments, expenses, purchases, stock, customer balances, supplier invoices, cash-ups).
- **Daily email** to owners and managers: low stock, expiring stock, overdue supplier invoices.
- **Subscriptions:** plans by branches and users, trial, grace, read-only; M-Pesa checkout; platform console (all businesses, manual payments, plan prices, owner password and two-step help).
- **Phone and tablet friendly**, installable web app. There is no APK or app-store app.

## Not built (do not describe as available)
- **A working KRA eTIMS connection.** Only the queue exists. SmartBiz is not connected to KRA and its receipts are NOT KRA tax invoices. Getting approved and connected needs KRA and an approved route (and the adapter in `server/src/etims.ts` to be written against it). Take tax advice first.
- **Payroll and HR:** these belong to the separate PeopleOS product, and statutory rates must be verified by a professional.
- Direct links to accounting software (CSV downloads are provided instead); a QR code for two-step setup (a setup key and link are shown); barcode label printing; supplier returns; per-batch prices;
  offline refunds, stock work or purchasing (only selling works offline); account sales and M-Pesa prompts while offline; push notifications; email receipts.

## Requirements
Node.js 20+, npm, a PostgreSQL database (free option: https://neon.tech), an SMTP account for email, a Safaricom Daraja app for your subscription payments.

## Run on your computer
1. Create a PostgreSQL database and copy its connection string (Neon: keep `?sslmode=require`).
2. API, from the `smartbiz` folder:
   ```
   cd server
   npm install
   cp .env.example .env        # Windows: copy .env.example .env
   ```
   Fill `DATABASE_URL` and `JWT_SECRET` (generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`), then `npm run dev`.
   Tables are created automatically. Expected: `SmartBiz listening on port 4000`.
3. Web app, new terminal, from the `smartbiz` folder: `cd web && npm install && npm run dev`, open http://localhost:5173.
4. Click **Register a business**. You become the owner. Add branches, staff and products.
5. Your own platform login (to see all customer businesses): `cd server && npm run platform-admin -- you@yourdomain.co.ke 'a-long-password'`, sign in, open the **Platform** tab.

## Email (invitations, password resets, alerts)
**Important on Render:** free Render web services block the usual email ports (SMTP 25, 465 and 587), so email sent over SMTP fails there. Use a web-API email service instead; it works on every host.
1. Create an account with Brevo (https://www.brevo.com) or Resend (https://resend.com). Check the provider's current free limits and terms.
2. Brevo: verify the address you will send from, then create an API key. Resend: verify your domain, then create an API key (Resend only emails other people from a verified domain).
3. In Render > Environment set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY=...` and `EMAIL_FROM="Your Company <the-address-you-verified>"` (for Resend: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=...`), then redeploy.
4. Sign in as the admin/owner and use **Send me a test email** (TechDesk: Users page; SmartBiz: Team page). It shows the real error if something is wrong, and the start-up log prints `Email: brevo (from ...)` or `Email: NOT CONFIGURED: ...`.
If an email cannot be sent, the app now says so and shows the invitation or reset link so you can send it yourself.
A "From" address you have not verified (or a free Gmail/Yahoo address) is often rejected or lands in spam. SMTP (`SMTP_*`) still works on hosts that allow it.
**Verified:** the Brevo and Resend requests, the error messages and the fallback link, tested against a local stand-in server. **Not tested:** real delivery through Brevo or Resend (do the test-email step above).

## M-Pesa and other keys
Set `APP_URL` (links in emails).Set `ENCRYPTION_KEY` once and never change it. Set `AT_*` to allow SMS receipts. Set `MPESA_*` and `MPESA_CALLBACK_SECRET` for subscription payments to YOU
(Daraja sandbox first; `APP_URL` must be a public https address so Safaricom can reach `APP_URL/api/mpesa/callback/<secret>`). Details are in `server/.env.example`.

## Plans and prices
Starter (1 branch, 3 users), Business (3 branches, 10 users), Growth (10 branches, 30 users). **The KSh prices are placeholders, not market-validated.**
Change them without code: `PATCH /api/platform/plans/<code>` with `{"price_month": 2000}` as platform admin.

## Run the tests (no database setup needed)
`cd server && npm install && npm test` starts a temporary PostgreSQL automatically (it cannot run as the Linux root user).

## Deploy on Render (single web service)
1. Push the folder to GitHub (`.env` is git-ignored).
2. Render > New > Web Service. Build: `cd web && npm install && npm run build && cd ../server && npm install && npm run build`. Start: `cd server && npm start`.
3. Environment variables from `server/.env.example`, plus `NODE_VERSION=20`. Set `APP_URL` to the Render URL.
4. Run `npm run platform-admin -- ...` once from the Render shell. After you register your own business, set `ALLOW_REGISTRATION=false` if you only want invited customers.
5. Use a paid database plan for real customers: a free database can be paused or deleted, and a shop's sales records are critical. Set up backups and test a restore before launch.

## Verification status
**Verified (automated, real PostgreSQL 18, 28 server tests + 4 offline-queue tests passing):** everything from the first version, plus: two-step sign-in (codes, replay refused, recovery codes once, owner reset, secrets stored encrypted);
VAT calculated on what was actually charged, reduced by refunds; variants all-or-nothing; batches (earliest-expiry-first, expired never sold, refunds to the original batch, transfers keep batches, write-off, batch totals always equal the balance);
credit limits (including exactly at the limit), customer payments and statements, refunds to account, write-offs; supplier invoices, part payments and ageing; cash-up expected cash and difference, optional enforcement;
M-Pesa till credentials stored encrypted, STK request built from them, callback secret, payment usable once and large enough; SMS receipts including provider failure; eTIMS queue states and retries with a fake adapter;
offline sale time limits and safe retries; daily digest once a day; CSV exports with spreadsheet-formula protection; isolation between businesses. The offline queue logic (never double-sends, refusals do not block others, another user's sales wait) has its own tests.
TypeScript builds pass; the zip was installed, built and tested from a clean folder.

**Untested, check these yourself:**
1. **Offline selling on a real phone.** Open SmartBiz online once at the branch and sign in. Switch on airplane mode, make 2 cash sales, switch it off, wait 30 seconds, and confirm both appear in Sales exactly once with the correct times and stock reduced.
2. **Camera barcode scanning** (needs a browser with BarcodeDetector, e.g. Chrome on Android) and a USB/Bluetooth scanner.
3. **M-Pesa at the till** with your own Daraja sandbox app (the live calls to Safaricom have never been run here), and **SMS** with an Africa's Talking account.
4. **Two-step sign-in with a real authenticator app** (type the setup key shown).
5. WhatsApp links, receipt printing, email, Render/Neon deployment, installing on a phone, and the whole interface on real phones and tablets.
6. A day of pretend trading, then compare reports to your own notes.

**Known limits:** offline sales are refused on sync if stock changed meanwhile (they appear as "needs attention" for a manager); offline sales older than 72 hours are refused; the offline product list and stock figures are a snapshot from the last time the till was online; unsent sales live in the browser's storage (about a few hundred sales)
and are lost if the browser data is cleared; a device should be online at least once a day; cost uses a weighted average across branches; the expected cash in cash-up does not include cash paid to suppliers; VAT assumes prices include VAT, with one rate per product;
batch tracking cannot be switched off once used; M-Pesa callbacks are unsigned by Safaricom so they rely on a per-business secret URL, a matching pending request and the amount check; SMS costs are paid by whoever owns the Africa's Talking account;
logo icons are low-resolution crops from your brand board; login attempts are limited per IP (30 per 15 minutes).
