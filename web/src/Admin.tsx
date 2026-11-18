import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from './api'
import { Err, Field, day, kes } from './ui'
import type { Me } from './App'

type Plan = { code: string; name: string; max_branches: number; max_users: number; price_month: number }
type MailOut = { emailSent?: boolean; emailError?: string; link?: string }
const mailMsg = (r: MailOut, to: string, what: string) => r.emailSent === false ? `The email could not be sent (${r.emailError}). Send this ${what} to ${to} yourself: ${r.link}` : `${what[0].toUpperCase()}${what.slice(1)} emailed to ${to}.`

function EmailCheck() {
  const [st, setSt] = useState<{ provider: string; ready: boolean; problem: string | null; from: string } | null>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  useEffect(() => { api<NonNullable<typeof st>>('/email/status').then(setSt).catch(() => undefined) }, [])
  const test = async () => { setErr(''); setMsg(''); setBusy(true); try { const r = await api<{ sentTo: string }>('/email/test', { body: {} }); setMsg(`Test email sent to ${r.sentTo}. Check your inbox and spam folder.`) } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) } }
  return <div className="card"><h2>Email</h2>{st && (st.ready ? <p>Sending through <b>{st.provider}</b> from {st.from}.</p> : <p className="err">Email is not set up: {st.problem}</p>)}
    <button className="btn alt" disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send me a test email'}</button>{msg && <p role="status">{msg}</p>}{err && <p className="err" role="alert">{err}</p>}</div>
}


export function TeamPage({ me, reload }: { me: Me; reload: () => void }) {
  type U = { id: string; name: string; email: string; role: string; active: boolean; branch_ids: string[] }
  type B = { id: string; name: string; address: string | null; active: boolean }
  type Inv = { id: string; email: string; role: string; expires_at: string }
  const [users, setUsers] = useState<U[]>([]); const [branches, setBranches] = useState<B[]>([]); const [inv, setInv] = useState<Inv[]>([]); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [bn, setBn] = useState(''); const [f, setF] = useState({ email: '', role: 'cashier', branchIds: [] as string[] }); const [edit, setEdit] = useState<U | null>(null); const [pwFor, setPwFor] = useState<U | null>(null); const [pw, setPw] = useState('')
  const load = useCallback(() => { api<U[]>('/users').then(setUsers).catch(e => setErr(errMsg(e))); api<B[]>('/branches').then(setBranches).catch(() => undefined); api<Inv[]>('/invites').then(setInv).catch(() => undefined) }, [])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, msg: string | ((v: any) => string) = '') => { setErr(''); setOk(''); try { const v = await fn(); const m = typeof msg === 'function' ? msg(v) : msg; if (m) setOk(m); load(); reload() } catch (x) { setErr(errMsg(x)) } }
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
  const active = branches.filter(b => b.active)
  const Pick = ({ ids, set }: { ids: string[]; set: (v: string[]) => void }) => <fieldset style={{ border: '1px solid var(--line)', borderRadius: 6 }}><legend>Branches</legend>{active.map(b => <label key={b.id}><input type="checkbox" checked={ids.includes(b.id)} onChange={() => set(toggle(ids, b.id))} /> {b.name}</label>)}</fieldset>
  return (<>
    {ok && <p role="status" style={{ wordBreak: 'break-all' }}>{ok}</p>}<Err e={err} />
    <EmailCheck />
    <div className="card"><h2>Branches</h2>{branches.map(b => <div key={b.id} className="acts" style={{ margin: '.4rem 0' }}><span>{b.name}{!b.active && ' (inactive)'}</span>
      <button className="btn alt" onClick={() => act(() => api(`/branches/${b.id}`, { method: 'PATCH', body: { active: !b.active } }))}>{b.active ? 'Deactivate' : 'Activate'}</button></div>)}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/branches', { body: { name: bn } }); setBn('') }, 'Branch added.') }}><Field label="New branch name" value={bn} set={setBn} /><button className="btn">Add branch</button></form></div>
    <div className="card"><h2>Invite a team member</h2><p className="mute">They receive an email with a link to choose their password. Cashiers sell; storekeepers handle stock and purchasing; managers also see reports, expenses and refunds.</p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); const to = f.email; void act(async () => { const r = await api<MailOut>('/invites', { body: f }); setF({ ...f, email: '' }); return r }, r => mailMsg(r, to, 'invitation link')) }}>
        <div className="row"><Field label="Email" type="email" value={f.email} set={v => setF({ ...f, email: v })} /><label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="cashier">Cashier</option><option value="storekeeper">Storekeeper</option><option value="manager">Manager</option></select></label></div>
        <Pick ids={f.branchIds} set={v => setF({ ...f, branchIds: v })} /><button className="btn" disabled={f.branchIds.length === 0}>Send invitation</button></form></div>
    {pwFor && <div className="card"><h2>Temporary password for {pwFor.name}</h2><form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api(`/users/${pwFor.id}/password`, { body: { password: pw } }); setPwFor(null); setPw('') }, `Temporary password set for ${pwFor.name}. Give it to them privately; they must choose their own at sign-in.`) }}>
      <Field label="Temporary password (10+ characters)" value={pw} set={setPw} /><button className="btn">Set password</button> <button type="button" className="btn alt" onClick={() => setPwFor(null)}>Cancel</button></form></div>}
    {edit && <div className="scrim" onClick={() => setEdit(null)}><div className="sheet" onClick={e => e.stopPropagation()}><h2>{edit.name}</h2>
      {edit.role !== 'owner' && <><label>Role<select value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value })}><option value="cashier">Cashier</option><option value="storekeeper">Storekeeper</option><option value="manager">Manager</option></select></label>
        <Pick ids={edit.branch_ids} set={v => setEdit({ ...edit, branch_ids: v })} /><button className="btn" disabled={edit.branch_ids.length === 0} onClick={() => act(async () => { await api(`/users/${edit.id}`, { method: 'PATCH', body: { role: edit.role, branchIds: edit.branch_ids } }); setEdit(null) }, 'Saved.')}>Save</button></>}{' '}<button className="btn alt" onClick={() => setEdit(null)}>Close</button></div></div>}
    {inv.length > 0 && <div className="card"><h2>Pending invitations</h2>{inv.map(i => <p key={i.id}>{i.email} ({i.role}) · expires {day(i.expires_at)} <button className="btn alt" style={{ margin: 0 }} onClick={() => act(() => api(`/invites/${i.id}`, { method: 'DELETE' }))}>Revoke</button></p>)}</div>}
    <div className="wrap"><table className="cards"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branches</th><th>Status</th><th></th></tr></thead><tbody>
      {users.map(u => <tr key={u.id}><td data-label="Name">{u.name}</td><td data-label="Email">{u.email}</td><td data-label="Role">{u.role}</td><td data-label="Branches">{u.role === 'owner' ? 'All' : branches.filter(b => u.branch_ids.includes(b.id)).map(b => b.name).join(', ') || '—'}</td><td data-label="Status">{u.active ? 'Active' : 'Disabled'}</td>
        <td data-label="">{u.id !== me.id && u.role !== 'owner' && <div className="acts"><button className="btn alt" onClick={() => setEdit(u)}>Role and branches</button>
          <button className="btn alt" onClick={() => act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }))}>{u.active ? 'Disable' : 'Enable'}</button>
          <button className="btn alt" onClick={() => act(() => api<MailOut>(`/users/${u.id}/reset-link`, { method: 'POST', body: {} }), r => mailMsg(r, u.email, 'password reset link'))}>Email reset link</button>
          <button className="btn alt" onClick={() => { setPwFor(u); setPw('') }}>Temporary password</button>
          <button className="btn alt" onClick={() => act(() => api(`/users/${u.id}/mfa-reset`, { method: 'POST', body: {} }), `Two-step sign-in reset for ${u.name}.`)}>Reset two-step</button></div>}</td></tr>)}</tbody></table></div>
  </>)
}

export function BillingPage() {
  type Pay = { id: string; plan_code: string; months: number; amount: number; method: string; status: string; mpesa_receipt: string | null; created_at: string }
  type B = { plan_code: string; plan_name: string; max_branches: number; max_users: number; branches: number; users: number; period_end: string; state: string; plans: Plan[]; payments: Pay[] }
  const [b, setB] = useState<B | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false); const [f, setF] = useState({ planCode: 'business', months: 1, phone: '' })
  const load = useCallback(() => { api<B>('/billing').then(setB).catch(e => setErr(errMsg(e))) }, [])
  useEffect(load, [load])
  async function pay(e: FormEvent) {
    e.preventDefault(); setErr(''); setMsg(''); setBusy(true)
    try {
      const out = await api<{ paymentId: string }>('/billing/checkout', { body: f }); setMsg('Check your phone and enter your M-Pesa PIN to approve the payment…')
      for (let i = 0; i < 30; i++) {
        await new Promise(res => setTimeout(res, 4000))
        const p = await api<{ status: string }>(`/billing/payments/${out.paymentId}`)
        if (p.status === 'paid') { setMsg('Payment received. Your subscription is active.'); setTimeout(() => location.reload(), 1500); break }
        if (p.status === 'failed') { setMsg(''); setErr('The payment was cancelled or failed. You can try again.'); break }
      }
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false); load() }
  }
  if (!b) return <>{err ? <Err e={err} /> : <p>Loading…</p>}</>
  const plan = b.plans.find(p => p.code === f.planCode)
  return (<>
    <div className="card"><h2>Your subscription</h2><p><b>{b.plan_name}</b> plan · status <span className="tag">{b.state}</span> · {b.state === 'trialing' ? 'trial ends' : 'paid until'} {day(b.period_end)}</p>
      <p>Branches: {b.branches} of {b.max_branches} · Users: {b.users} of {b.max_users}</p></div>
    <div className="card"><h2>Pay with M-Pesa</h2><form onSubmit={pay}>
      {b.plans.map(p => <label key={p.code}><input type="radio" name="plan" checked={f.planCode === p.code} onChange={() => setF({ ...f, planCode: p.code })} /> {p.name}: {p.max_branches} branch(es), {p.max_users} users, {kes(p.price_month)} per month</label>)}
      <div className="row"><label>Period<select value={f.months} onChange={e => setF({ ...f, months: Number(e.target.value) })}><option value={1}>1 month</option><option value={12}>12 months</option></select></label><Field label="M-Pesa phone number" value={f.phone} set={v => setF({ ...f, phone: v })} /></div>
      <p>Total: <b>{plan ? kes(plan.price_month * f.months) : ''}</b></p><button className="btn" disabled={busy}>{busy ? 'Waiting for payment…' : 'Send M-Pesa prompt'}</button></form>{msg && <p>{msg}</p>}<Err e={err} /></div>
    <h2>Recent payments</h2><div className="wrap"><table className="cards"><thead><tr><th>Date</th><th>Plan</th><th>Months</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
      {b.payments.length === 0 && <tr><td colSpan={7} className="mute">No payments yet.</td></tr>}
      {b.payments.map(p => <tr key={p.id}><td data-label="Date">{day(p.created_at)}</td><td data-label="Plan">{p.plan_code}</td><td data-label="Months">{p.months}</td><td data-label="Amount">{kes(p.amount)}</td><td data-label="Method">{p.method}</td><td data-label="Status">{p.status}</td><td data-label="Receipt">{p.mpesa_receipt ?? '—'}</td></tr>)}</tbody></table></div>
  </>)
}

export function PlatformPage() {
  type Biz = { id: string; name: string; plan_code: string; period_end: string; state: string; branches: number; users: number }
  type Own = { id: string; name: string; email: string; active: boolean }
  const [rows, setRows] = useState<Biz[]>([]); const [plans, setPlans] = useState<Plan[]>([]); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [f, setF] = useState({ bizId: '', planCode: 'starter', months: 1, amount: '', reference: '' }); const [open, setOpen] = useState<Biz | null>(null); const [owners, setOwners] = useState<Own[]>([]); const [pwFor, setPwFor] = useState<Own | null>(null); const [pw, setPw] = useState('')
  const load = useCallback(() => { api<Biz[]>('/platform/businesses').then(setRows).catch(e => setErr(errMsg(e))); api<Plan[]>('/plans').then(setPlans).catch(() => undefined) }, [])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, msg: string | ((v: any) => string)) => { setErr(''); setOk(''); try { const v = await fn(); setOk(typeof msg === 'function' ? msg(v) : msg); load() } catch (x) { setErr(errMsg(x)) } }
  const show = async (b: Biz) => { setOpen(b); setPwFor(null); setErr(''); try { setOwners(await api<Own[]>(`/platform/businesses/${b.id}/owners`)) } catch (x) { setErr(errMsg(x)) } }
  return (<>
    <h1>Customer businesses</h1>{ok && <p role="status" style={{ wordBreak: 'break-all' }}>{ok}</p>}<Err e={err} />
    <div className="wrap"><table className="cards"><thead><tr><th>Business</th><th>Plan</th><th>Status</th><th>Until</th><th>Branches</th><th>Users</th><th></th></tr></thead><tbody>
      {rows.map(b => <tr key={b.id}><td data-label="Business">{b.name}</td><td data-label="Plan">{b.plan_code}</td><td data-label="Status">{b.state}</td><td data-label="Until">{day(b.period_end)}</td><td data-label="Branches">{b.branches}</td><td data-label="Users">{b.users}</td><td data-label=""><button className="btn alt" onClick={() => show(b)}>Owners</button></td></tr>)}</tbody></table></div>
    {open && <div className="card" style={{ marginTop: '1rem' }}><h2>Owners of {open.name}</h2>{owners.map(o => <div key={o.id} className="acts" style={{ margin: '.5rem 0' }}><span>{o.name} ({o.email})</span>
      <button className="btn alt" onClick={() => act(() => api<MailOut>(`/platform/users/${o.id}/reset-link`, { method: 'POST', body: {} }), r => mailMsg(r, o.email, 'password reset link'))}>Email reset link</button><button className="btn alt" onClick={() => { setPwFor(o); setPw('') }}>Temporary password</button><button className="btn alt" onClick={() => act(() => api(`/platform/users/${o.id}/mfa-reset`, { method: 'POST', body: {} }), `Two-step sign-in reset for ${o.name}.`)}>Reset two-step</button></div>)}
      {pwFor && <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(async () => { await api(`/platform/users/${pwFor.id}/password`, { body: { password: pw } }); setPwFor(null); setPw('') }, `Temporary password set for ${pwFor.name}. Give it to them privately.`) }}><Field label={`Temporary password for ${pwFor.name} (10+ characters)`} value={pw} set={setPw} /><button className="btn">Set password</button></form>}</div>}
    <div className="card" style={{ marginTop: '1rem' }}><h2>Record a bank / cash / paybill payment</h2><form onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api(`/platform/businesses/${f.bizId}/payments`, { body: { planCode: f.planCode, months: f.months, amount: Number(f.amount), reference: f.reference } }), 'Payment recorded.') }}>
      <div className="row"><label>Business<select value={f.bizId} onChange={e => setF({ ...f, bizId: e.target.value })} required><option value="">Choose…</option>{rows.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Plan<select value={f.planCode} onChange={e => setF({ ...f, planCode: e.target.value })}>{plans.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label><label>Months<input type="number" min={1} max={36} value={f.months} onChange={e => setF({ ...f, months: Number(e.target.value) })} /></label></div>
      <div className="row"><Field label="Amount received (KSh)" type="number" value={f.amount} set={v => setF({ ...f, amount: v })} /><Field label="Reference" value={f.reference} set={v => setF({ ...f, reference: v })} /></div><button className="btn">Record payment</button></form></div>
  </>)
}
