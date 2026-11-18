import { useEffect, useState, type FormEvent } from 'react'
import { api, errMsg, TOKEN } from './api'
import { Err, Field } from './ui'

type PlanRow = { code: string; name: string; max_branches: number; max_users: number; price_month: number }

export function Auth({ onAuth }: { onAuth: (t: string) => void }) {
  const [reg, setReg] = useState(false)
  const [f, setF] = useState({ businessName: '', name: '', email: '', password: '', planCode: 'starter', branchName: 'Main branch' })
  const [plans, setPlans] = useState<PlanRow[]>([]); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const [mfa, setMfa] = useState<{ token: string; code: string } | null>(null)
  useEffect(() => { api<PlanRow[]>('/plans').then(setPlans).catch(() => undefined) }, [])
  const up = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>(reg ? '/auth/register' : '/auth/login', { body: reg ? f : { email: f.email, password: f.password } })
      if (r.mfaRequired) setMfa({ token: r.mfaToken!, code: '' }); else onAuth(r.token!)
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  async function verify(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try { const r = await api<{ token: string }>('/auth/mfa/verify', { body: { mfaToken: mfa!.token, code: mfa!.code.trim() } }); onAuth(r.token) } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  if (mfa) return <div className="auth"><div className="card"><h1>Two-step sign-in</h1><p className="mute">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
    <form onSubmit={verify}><Field label="Code" value={mfa.code} set={v => setMfa({ ...mfa, code: v })} /><Err e={err} /><button className="btn" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button> <button type="button" className="btn alt" onClick={() => { setMfa(null); setErr('') }}>Back</button></form></div></div>
  return (
    <div className="auth"><div className="card">
      <h1>SmartBiz</h1><p className="mute">{reg ? 'Register your business. You become its owner. 14-day free trial, no payment needed to start.' : 'Sign in to your business.'}</p>
      <form onSubmit={submit}>
        {reg && <><Field label="Business name" value={f.businessName} set={up('businessName')} /><Field label="Your name" value={f.name} set={up('name')} /><Field label="First branch name" value={f.branchName} set={up('branchName')} />
          <label>Plan<select value={f.planCode} onChange={e => up('planCode')(e.target.value)}>{plans.map(p => <option key={p.code} value={p.code}>{p.name}: {p.max_branches} branch(es), {p.max_users} users, KSh {p.price_month.toLocaleString('en-KE')}/month</option>)}</select></label></>}
        <Field label="Email" type="email" value={f.email} set={up('email')} />
        <Field label="Password (10+ characters)" type="password" value={f.password} set={up('password')} />
        <Err e={err} />
        <button className="btn" disabled={busy}>{busy ? 'Please wait…' : reg ? 'Register business' : 'Sign in'}</button>{' '}
        <button type="button" className="btn alt" onClick={() => { setReg(!reg); setErr('') }}>{reg ? 'I have an account' : 'Register a business'}</button>
        {!reg && <p><a href="#/forgot">Forgot your password?</a></p>}
      </form>
    </div></div>
  )
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: (t: string) => void }) {
  const [f, setF] = useState({ name: '', password: '' }); const [err, setErr] = useState('')
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { const r = await api<{ token: string }>('/auth/accept-invite', { body: { token, ...f } }); onDone(r.token) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Join your business</h1><p className="mute">Choose your name and a password to finish setting up your SmartBiz account.</p>
    <form onSubmit={go}><Field label="Your name" value={f.name} set={v => setF({ ...f, name: v })} /><Field label="Password (10+ characters)" type="password" value={f.password} set={v => setF({ ...f, password: v })} /><Err e={err} /><button className="btn">Create my account</button></form></div></div>
}
export function ResetPassword({ token }: { token: string }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [done, setDone] = useState(false)
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/auth/reset', { body: { token, password: pw } }); setDone(true) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Choose a new password</h1>{done ? <p>Password changed. <a href="#/">Sign in</a></p> :
    <form onSubmit={go}><Field label="New password (10+ characters)" type="password" value={pw} set={setPw} /><Err e={err} /><button className="btn">Change password</button></form>}</div></div>
}
export function Forgot() {
  const [email, setEmail] = useState(''); const [err, setErr] = useState(''); const [sent, setSent] = useState(false)
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/auth/forgot', { body: { email } }); setSent(true) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Forgot your password?</h1>{sent ? <p>If that email has an account, a reset link is on its way. <a href="#/">Back to sign in</a></p> :
    <form onSubmit={go}><Field label="Email" type="email" value={email} set={setEmail} /><Err e={err} /><button className="btn">Send reset link</button> <a href="#/">Cancel</a></form>}</div></div>
}
export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: (t: string) => void; onCancel?: () => void }) {
  const [f, setF] = useState({ current: '', password: '', again: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  async function go(e: FormEvent) {
    e.preventDefault(); setErr('')
    if (f.password !== f.again) return setErr('The new passwords do not match')
    setBusy(true)
    try { const r = await api<{ token: string }>('/auth/change-password', { body: { current: f.current, password: f.password } }); setF({ current: '', password: '', again: '' }); onDone(r.token) }
    catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const form = <form onSubmit={go}><Field label={forced ? 'Temporary password' : 'Current password'} type="password" value={f.current} set={v => setF({ ...f, current: v })} />
    <Field label="New password (10+ characters)" type="password" value={f.password} set={v => setF({ ...f, password: v })} /><Field label="Repeat new password" type="password" value={f.again} set={v => setF({ ...f, again: v })} />
    <Err e={err} /><button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>{forced && onCancel && <> <button type="button" className="btn alt" onClick={onCancel}>Sign out</button></>}</form>
  return forced ? <div className="auth"><div className="card"><h1>Choose a new password</h1><p className="mute">The owner or an administrator set a temporary password for you. Choose your own to continue.</p>{form}</div></div>
    : <div className="card"><h2>Change password</h2>{form}</div>
}
function MfaCard({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null); const [code, setCode] = useState(''); const [pw, setPw] = useState(''); const [codes, setCodes] = useState<string[] | null>(null); const [err, setErr] = useState('')
  const run = async (fn: () => Promise<void>) => { setErr(''); try { await fn() } catch (x) { setErr(errMsg(x)) } }
  return <div className="card"><h2>Two-step sign-in</h2>
    {codes && <><p><b>Save these recovery codes now.</b> Each works once if you lose your phone. They will not be shown again.</p><pre style={{ background: '#fff', padding: '.6rem', border: '1px solid var(--line)' }}>{codes.join('\n')}</pre><button className="btn alt" onClick={() => setCodes(null)}>I have saved them</button></>}
    {!codes && !enabled && !setup && <><p className="mute">Adds a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) to your password. Recommended for owners and managers.</p>
      <button className="btn" onClick={() => run(async () => setSetup(await api('/auth/mfa/setup', { body: {} })))}>Set up</button></>}
    {setup && <form onSubmit={e => { e.preventDefault(); void run(async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { body: { code } }); setCodes(r.recoveryCodes); setSetup(null); setCode(''); onChange() }) }}>
      <p>In your authenticator app choose "Enter a setup key" and type this key (or open it on your phone):</p><p><b style={{ wordBreak: 'break-all' }}>{setup.secret}</b></p><p><a href={setup.otpauth}>Open in authenticator app</a></p>
      <Field label="6-digit code from the app" value={code} set={setCode} /><button className="btn">Turn on</button></form>}
    {!codes && enabled && <form onSubmit={e => { e.preventDefault(); void run(async () => { await api('/auth/mfa/disable', { body: { password: pw, code } }); setPw(''); setCode(''); onChange() }) }}>
      <p className="ok">Two-step sign-in is on.</p><Field label="Your password" type="password" value={pw} set={setPw} /><Field label="Authenticator or recovery code" value={code} set={setCode} /><button className="btn alt">Turn off</button></form>}
    <Err e={err} /></div>
}
export function AccountPage({ name, email, role, canInstall, install, mfaEnabled, onMfaChange }: { name: string; email: string; role: string; canInstall: boolean; install: () => void; mfaEnabled: boolean; onMfaChange: () => void }) {
  const [msg, setMsg] = useState('')
  return (<>
    <div className="card"><h2>{name}</h2><p className="mute">{email} · {role}</p><p>You stay signed in on this device until you tap Sign out.</p></div>
    <ChangePassword onDone={t => { localStorage.setItem(TOKEN, t); setMsg('Password changed. You were signed out on your other devices.') }} />{msg && <p role="status">{msg}</p>}
    <MfaCard enabled={mfaEnabled} onChange={onMfaChange} />
    <div className="card"><h2>Install SmartBiz on your device</h2>{canInstall && <button className="btn" onClick={install}>Install app</button>}
      <p><b>Android (Chrome):</b> menu ⋮, then "Install app" or "Add to Home screen".</p><p><b>iPhone / iPad (Safari):</b> Share button, then "Add to Home Screen".</p>
      <p><b>Computer (Chrome or Edge):</b> the install icon in the address bar.</p></div>
  </>)
}
