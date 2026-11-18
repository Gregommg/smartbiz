import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errMsg, TOKEN } from './api'
import { useInstall } from './ui'
import { loadQueue, syncQueue, type SendResult } from './offline'
import { Auth, AcceptInvite, ResetPassword, Forgot, ChangePassword, AccountPage } from './Auth'
import { PosPage } from './Pos'
import { ProductsPage } from './Products'
import { StockPage, BuyingPage } from './Stock'
import { SalesPage, ExpensesPage, CustomersPage } from './Sales'
import { ReportsPage } from './Reports'
import { PayablesPage, CashUpPage, SettingsPage } from './Business'
import { TeamPage, BillingPage, PlatformPage } from './Admin'

export type Role = 'owner' | 'manager' | 'cashier' | 'storekeeper'
export type Branch = { id: string; name: string }
export type Me = { id: string; name: string; email: string; role: Role; is_platform: boolean; must_change_password: boolean; mfa_enabled: boolean; branches: Branch[]; sub: { state: string; plan: string; periodEnd: string; business: string } }
type View = 'pos' | 'products' | 'stock' | 'buying' | 'sales' | 'expenses' | 'customers' | 'cashup' | 'payables' | 'reports' | 'team' | 'settings' | 'billing' | 'platform' | 'account'
const NAV: { k: View; label: string; roles: Role[] }[] = [
  { k: 'pos', label: 'Sell', roles: ['owner', 'manager', 'cashier'] }, { k: 'products', label: 'Products', roles: ['owner', 'manager', 'cashier', 'storekeeper'] },
  { k: 'stock', label: 'Stock', roles: ['owner', 'manager', 'storekeeper'] }, { k: 'buying', label: 'Purchasing', roles: ['owner', 'manager', 'storekeeper'] },
  { k: 'sales', label: 'Sales', roles: ['owner', 'manager', 'cashier'] }, { k: 'customers', label: 'Customers', roles: ['owner', 'manager', 'cashier'] },
  { k: 'cashup', label: 'Cash-up', roles: ['owner', 'manager', 'cashier'] }, { k: 'expenses', label: 'Expenses', roles: ['owner', 'manager'] },
  { k: 'payables', label: 'Suppliers owed', roles: ['owner', 'manager'] }, { k: 'reports', label: 'Reports', roles: ['owner', 'manager'] },
  { k: 'team', label: 'Team', roles: ['owner'] }, { k: 'settings', label: 'Settings', roles: ['owner'] }, { k: 'billing', label: 'Billing', roles: ['owner'] },
]
async function sendSale(body: unknown): Promise<SendResult> {
  try { await api('/sales', { body }); return { ok: true } }
  catch (e) { if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) return { ok: false, network: true, error: 'offline' }; return { ok: false, network: false, error: errMsg(e) } }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null); const [ready, setReady] = useState(false); const [view, setView] = useState<View | null>(null); const [cached, setCached] = useState(false)
  const [branch, setBranch] = useState(localStorage.getItem('sb_branch') ?? ''); const [hash, setHash] = useState(location.hash); const install = useInstall()
  const [online, setOnline] = useState(navigator.onLine); const [pending, setPending] = useState(loadQueue().length)
  useEffect(() => { const h = () => setHash(location.hash); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h) }, [])
  useEffect(() => { const h = () => { localStorage.removeItem('sb_me'); setMe(null) }; addEventListener('sb-auth-lost', h); return () => removeEventListener('sb-auth-lost', h) }, [])
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false), q = () => setPending(loadQueue().length)
    addEventListener('online', up); addEventListener('offline', down); addEventListener('sb-queue', q)
    return () => { removeEventListener('online', up); removeEventListener('offline', down); removeEventListener('sb-queue', q) }
  }, [])
  const loadMe = useCallback(() => {
    api<Me>('/me').then(m => { localStorage.setItem('sb_me', JSON.stringify(m)); setCached(false); setMe(m) })
      .catch(e => { if (e instanceof TypeError) { const c = localStorage.getItem('sb_me'); if (c && localStorage.getItem(TOKEN)) { setCached(true); setMe(JSON.parse(c)) } } })   // no connection: open with the last known details so selling can continue
      .finally(() => setReady(true))
  }, [])
  useEffect(loadMe, [loadMe])
  useEffect(() => {   // send queued offline sales whenever we are online (they belong to the signed-in user only)
    if (!me || !online || cached) return
    const run = () => { void syncQueue(sendSale, q => q.userId === me.id) }
    run(); const t = setInterval(run, 30000); return () => clearInterval(t)
  }, [me, online, cached])
  const signedIn = (t: string) => { localStorage.setItem(TOKEN, t); location.hash = ''; setReady(false); loadMe() }
  const signOut = async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined); localStorage.removeItem(TOKEN); localStorage.removeItem('sb_me'); setMe(null); setView(null) }
  const token = new URLSearchParams(hash.split('?')[1] ?? '').get('token') ?? ''
  if (hash.startsWith('#/invite')) return <AcceptInvite token={token} onDone={signedIn} />
  if (hash.startsWith('#/reset')) return <ResetPassword token={token} />
  if (hash.startsWith('#/forgot')) return <Forgot />
  if (!ready) return <p className="pad">Loading…</p>
  if (!me) return <Auth onAuth={signedIn} />
  if (me.must_change_password) return <ChangePassword forced onDone={signedIn} onCancel={signOut} />
  const items = NAV.filter(n => n.roles.includes(me.role)), current: View = view ?? items[0]?.k ?? 'account'
  const branchId = me.branches.some(b => b.id === branch) ? branch : me.branches[0]?.id ?? ''
  const sub = me.sub, owner = me.role === 'owner'
  const graceEnd = new Date(new Date(sub.periodEnd).getTime() + 7 * 864e5).toLocaleDateString()
  return (<>
    <header>
      <div className="top"><img className="logo" src="/onyx-symbol.png" alt="" width="32" height="31" /><b>SmartBiz</b><span className="by">{sub.business}</span><span className="sp" />
        {me.branches.length > 1 && <select className="branch" aria-label="Branch" value={branchId} onChange={e => { setBranch(e.target.value); localStorage.setItem('sb_branch', e.target.value) }}>{me.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
        {install.canInstall && <button className="inst" onClick={install.run}>Install app</button>}
        <button onClick={() => setView('account')}>{me.name}</button><button onClick={signOut}>Sign out</button></div>
      <div className="navlinks">{items.map(n => <button key={n.k} className={current === n.k ? 'on' : ''} onClick={() => setView(n.k)}>{n.label}{n.k === 'pos' && pending > 0 ? ` (${pending} unsent)` : ''}</button>)}{me.is_platform && <button className={current === 'platform' ? 'on' : ''} onClick={() => setView('platform')}>Platform</button>}</div>
    </header>
    {(!online || cached) && <div className="banner warn" role="status">You are offline. You can keep selling; sales are saved on this device and sent when the connection returns.{pending > 0 ? ` ${pending} waiting to be sent.` : ''}</div>}
    {online && !cached && pending > 0 && <div className="banner info" role="status">{pending} offline sale(s) waiting to be sent. Open Sell to see them.</div>}
    {!me.is_platform && sub.state !== 'active' && <div className={'banner ' + (sub.state === 'trialing' ? 'info' : 'warn')} role="status">
      {sub.state === 'trialing' && `Free trial ends ${new Date(sub.periodEnd).toLocaleDateString()}.${owner ? ' Choose and pay for a plan under Billing.' : ''}`}
      {sub.state === 'grace' && `Your subscription has expired. Renew by ${graceEnd} to keep full access.${owner ? ' Go to Billing.' : ' Ask the owner.'}`}
      {sub.state === 'suspended' && `Your subscription has expired and SmartBiz is read-only.${owner ? ' Renew under Billing.' : ' Ask the owner to renew.'}`}</div>}
    <main>
      {me.branches.length === 0 && current !== 'account' && <p className="err">You are not assigned to any branch. Ask the owner to assign you one.</p>}
      {current === 'pos' && <PosPage me={me} branchId={branchId} online={online && !cached} />}
      {current === 'products' && <ProductsPage me={me} branchId={branchId} />}
      {current === 'stock' && <StockPage me={me} branchId={branchId} />}
      {current === 'buying' && <BuyingPage me={me} branchId={branchId} />}
      {current === 'sales' && <SalesPage me={me} branchId={branchId} />}
      {current === 'expenses' && <ExpensesPage me={me} branchId={branchId} />}
      {current === 'customers' && <CustomersPage me={me} branchId={branchId} />}
      {current === 'cashup' && <CashUpPage me={me} branchId={branchId} />}
      {current === 'payables' && <PayablesPage />}
      {current === 'reports' && <ReportsPage me={me} />}
      {current === 'team' && owner && <TeamPage me={me} reload={loadMe} />}
      {current === 'settings' && owner && <SettingsPage />}
      {current === 'billing' && owner && <BillingPage />}
      {current === 'platform' && me.is_platform && <PlatformPage />}
      {current === 'account' && <AccountPage name={me.name} email={me.email} role={me.role} canInstall={install.canInstall} install={install.run} mfaEnabled={me.mfa_enabled} onMfaChange={loadMe} />}
    </main>
  </>)
}
