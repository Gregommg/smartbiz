import { useEffect, useState } from 'react'

export const kes = (n: number | null | undefined) => 'KSh ' + (n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 3 })
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
export const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
export const when = (d: string) => new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
export const day = (d: string) => new Date(d).toLocaleDateString()

export function Field(p: { label: string; value: string; set: (v: string) => void; type?: string; required?: boolean; placeholder?: string }) {
  return <label>{p.label}<input type={p.type ?? 'text'} value={p.value} placeholder={p.placeholder} required={p.required ?? true} onChange={e => p.set(e.target.value)} /></label>
}
export const Err = ({ e }: { e: string }) => (e ? <p className="err" role="alert">{e}</p> : null)

export function Bars({ rows, fmt = (n: number) => String(n) }: { rows: { label: string; n: number }[]; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(r => Math.abs(r.n)))
  return rows.length ? <>{rows.map(r => <div className="hbar" key={r.label}><span>{r.label.replace('_', ' ')}</span><div className="bar" style={{ width: `${(Math.abs(r.n) / max) * 100}%` }} /><b>{fmt(r.n)}</b></div>)}</> : <p className="mute">No data for this period.</p>
}
export function LineChart({ data }: { data: { date: string; sales: number; margin: number }[] }) {
  const W = 640, H = 220, P = 40, max = Math.max(1, ...data.flatMap(d => [d.sales, d.margin])), min = Math.min(0, ...data.map(d => d.margin))
  const x = (i: number) => P + (data.length < 2 ? (W - P - 10) / 2 : (i * (W - P - 10)) / (data.length - 1)), y = (v: number) => H - 28 - ((v - min) / (max - min)) * (H - 28 - 12)
  const line = (k: 'sales' | 'margin') => data.map((d, i) => `${x(i)},${y(d[k])}`).join(' ')
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Net sales and gross margin per day">
    {[0, 0.5, 1].map(f => { const v = min + (max - min) * f; return <g key={f}><line x1={P} x2={W - 10} y1={y(v)} y2={y(v)} stroke="#dde3ee" /><text x={2} y={y(v) + 4} fontSize="10" fill="#5b6b85">{Math.round(v).toLocaleString('en-KE')}</text></g> })}
    <polyline points={line('sales')} fill="none" stroke="#6c00ff" strokeWidth="2.5" />{data.length < 2 && data[0] && <circle cx={x(0)} cy={y(data[0].sales)} r="4" fill="#6c00ff" />}
    <polyline points={line('margin')} fill="none" stroke="#12a150" strokeWidth="2.5" strokeDasharray="6 4" />{data.length < 2 && data[0] && <circle cx={x(0)} cy={y(data[0].margin)} r="4" fill="#12a150" />}
    <text x={P} y={H - 8} fontSize="11" fill="#5b6b85">{data[0]?.date}</text><text x={W - 10} y={H - 8} fontSize="11" fill="#5b6b85" textAnchor="end">{data[data.length - 1]?.date}</text></svg>
}
export function useInstall() {
  const [ev, setEv] = useState<any>(null)
  useEffect(() => { const h = (e: Event) => { e.preventDefault(); setEv(e) }; addEventListener('beforeinstallprompt', h); return () => removeEventListener('beforeinstallprompt', h) }, [])
  return { canInstall: !!ev, run: async () => { await ev.prompt(); setEv(null) } }
}
export function csvCell(v: unknown) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
export function saveFile(name: string, text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
