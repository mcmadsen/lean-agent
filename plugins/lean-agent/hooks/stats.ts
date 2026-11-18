// `lean_doctor stats`: spend, caps, rule loads and worker feedback as compact text, computed here (no model, no ledger read by
// the caller). Spend comes from the rollup (ledger.ts), so it costs a stat and the tail of the ledger, not 27 MB.
import { readConfig } from './budget'
import { addTo, dayOf, merge, syncRollup, zero } from './ledger'
import type { Agg, Dim } from './ledger'
import { projectDir, rulesStats } from './rules'
import { deskDir, homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskChoice, threadChoice } from './models'
import { isRunning, parseAgents } from './threads'

export const STATS_DAYS = 7
export const MAX_STATS_DAYS = 90
const TOP = 10

const usd = (n: number) => `$${n.toFixed(2)}`
const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
const line = (name: string, a: Agg) => `  ${name}  ${usd(a[0])}  ${a[5]} req  in ${tok(a[1])} out ${tok(a[2])} cache r ${tok(a[3])} w ${tok(a[4])}`

// the last `days` calendar days ending at `now` (UTC, as the ledger's days are)
export function lastDays(now: number, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86_400_000))
}

// top TOP by spend, the rest in one line
function table(title: string, d: Dim, top = TOP): string[] {
  const rows = Object.entries(d).sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))
  if (!rows.length) return []
  const out = [`${title}:`, ...rows.slice(0, top).map(([k, a]) => line(k, a))]
  if (rows.length > top) {
    const rest = zero()
    for (const [, a] of rows.slice(top)) merge(rest, a)
    out.push(line(`(+${rows.length - top} more)`, rest))
  }
  return out
}

const mergeDim = (into: Dim, from: Dim) => {
  for (const [k, a] of Object.entries(from)) merge((into[k] ??= zero()), a)
}

export async function statsText(h: Host, opts: { days?: number; project?: string } = {}): Promise<string> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const asked = Math.floor(Number(opts.days))
  const n = asked >= 1 ? Math.min(MAX_STATS_DAYS, asked) : STATS_DAYS // a bad value is the default
  const ro = await syncRollup(h, now)
  const span = lastDays(now, n)
  const today = dayOf(now)
  const sum = { t: zero(), model: {} as Dim, agent: {} as Dim, role: {} as Dim, tN: {} as Dim, rm: {} as Dim }
  for (const d of span) {
    const day = ro.days[d]
    if (!day) continue
    merge(sum.t, day.t)
    for (const k of ['model', 'agent', 'role', 'tN', 'rm'] as const) mergeDim(sum[k], day[k])
  }
  const td = ro.days[today]
  const out: string[] = []
  out.push(`lean-agent stats: last ${n} day(s) to ${today}`)
  out.push(`spend: today ${usd(td?.t[0] ?? 0)} (${td?.t[5] ?? 0} req) · ${n}d ${usd(sum.t[0])} (${sum.t[5]} req)`)
  // caps (config.json dailyCapUsd) against today, per role
  const cfg: any = await readConfig(h, home)
  const caps = cfg?.dailyCapUsd && typeof cfg.dailyCapUsd === 'object' ? (cfg.dailyCapUsd as Record<string, number>) : {}
  const capLines = ['desk', 'thread', 'plain'].map(r => `${r} ${usd(td?.role[r]?.[0] ?? 0)} of ${typeof caps[r] === 'number' ? usd(caps[r]!) : 'no cap'}`)
  out.push(`caps today: ${capLines.join(' · ')}${typeof cfg?.workerCapUsd === 'number' ? ` · per worker ${usd(cfg.workerCapUsd)}` : ''}`)
  out.push(`daily: ${span.map(d => `${d.slice(5)} ${usd(ro.days[d]?.t[0] ?? 0)}`).join(' · ')}`)
  out.push(...table(`by model (${n}d)`, sum.model))
  out.push(...table(`by role x model (${n}d; a model you did not configure shows here)`, Object.fromEntries(Object.entries(sum.rm).map(([k, a]) => [k.replace('|', ' / '), a]))))
  out.push(...table(`by role (${n}d)`, sum.role))
  out.push(...table(`by agent (${n}d; main = the session itself)`, sum.agent))
  out.push(...table(`by thread (${n}d)`, sum.tN))
  // rules
  const projects = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/projects.json`, {})
  const names = opts.project ? [opts.project] : Object.keys(projects && typeof projects === 'object' ? projects : {}).filter(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))
  for (const p of names) {
    const r = await rulesStats(h, p)
    const have = (await h.fs.list(`${projectDir(home, p)}/rules`).catch(() => [])).filter(f => f.name.endsWith('.md')).length
    if (!have) continue
    const loads = Object.entries(r.loaded).filter(([f]) => !r.never.includes(f))
    out.push(`rules ${p}: ${have} rule(s), ${have - r.never.length} loaded at least once (${loads.reduce((s, [, c]) => s + c, 0)} loads)${r.never.length ? `; never loaded: ${r.never.slice(0, 12).join(', ')}${r.never.length > 12 ? ` (+${r.never.length - 12})` : ''}` : ''}`)
  }
  // worker feedback and gaps (1.0 files: ~/.lean-agent/feedback.jsonl, gaps.jsonl, <project>/gaps.jsonl)
  const fb = await readJsonl<{ status?: string; agent?: string; missing?: boolean; refused?: number; ts?: number }>(h, `${leanDir(home)}/feedback.jsonl`)
  const st: Record<string, number> = {}
  let missing = 0
  let refused = 0
  for (const r of fb) {
    st[r.status ?? '?'] = (st[r.status ?? '?'] ?? 0) + 1
    if (r.missing) missing++
    refused += r.refused ?? 0
  }
  out.push(`worker feedback (feedback.jsonl): ${fb.length} row(s)${fb.length ? ` · ${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(', ')} · ${missing} with missing context · ${refused} refused command(s)` : ''}`)
  let gaps = (await readJsonl<unknown>(h, `${leanDir(home)}/gaps.jsonl`)).length
  const per: string[] = []
  for (const p of names) {
    const g = (await readJsonl<unknown>(h, `${projectDir(home, p)}/gaps.jsonl`)).length
    if (g) { per.push(`${p} ${g}`); gaps += g }
  }
  out.push(`gaps (gaps.jsonl): ${gaps}${per.length ? ` (${per.join(', ')})` : ''}`)
  // what the ledger held
  const files = Object.keys(ro.files).sort()
  out.push(`ledger: ${ro.rows} row(s) in ${files.length} file(s)${ro.legacy ? `, ${ro.legacy} pre-1.0 (0.45: cost_usd, no role)` : ''}${ro.bad ? `, ${ro.bad} unparsable line(s) skipped` : ''}`)
  // 0.45 leftovers: other things that were once called feedback and gaps, not worker feedback; not counted
  const old: string[] = []
  if (await h.fs.exists(`${leanDir(home)}/feedback`).catch(() => false)) old.push('feedback/ (0.45 notes about lean-agent itself)')
  if (await h.fs.exists(`${leanDir(home)}/work`).catch(() => false)) old.push('work/*/gaps.json (0.45 per-run gaps)')
  if (old.length) out.push(`0.45 leftovers, not counted: ${old.join(', ')}`)
  return out.join('\n')
}

// "Today $x · 7d $y" for the pane footer and a thread's status line; null when there is no ledger at all
export async function spendLine(h: Host): Promise<string | null> {
  const home = await homeDir(h)
  if (!(await h.fs.exists(`${leanDir(home)}/ledger.jsonl`).catch(() => false)) && !(await h.fs.exists(`${leanDir(home)}/rollup.json`).catch(() => false))) return null
  const now = await h.clock.now()
  const ro = await syncRollup(h, now)
  const w = zero()
  for (const d of lastDays(now, STATS_DAYS)) if (ro.days[d]) merge(w, ro.days[d]!.t)
  return `$${(ro.days[dayOf(now)]?.t[0] ?? 0).toFixed(2)} · 7d $${w[0].toFixed(2)}`
}

// Sessions on a model lean-agent did not configure: spend today per role x model against the desk's pinned model and the
// threads' recorded ones (a desk started before setup pinned it, a thread from before 1.0.2), and live sessions whose listed
// model differs (`claude agents --json`, when it reports one). Returns one sentence each.
const family = (m: string) => /haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : /opus/i.test(m) ? 'opus' : m
export async function modelMismatches(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const out: string[] = []
  const desk = (await deskChoice(h, home)).model
  const allowed = new Set<string>()
  const def = await threadChoice(h, home, {})
  if (typeof def !== 'string') allowed.add(family(def.model))
  const sids = new Map<string, { id: string; model?: string }>()
  for (const e of (await h.fs.list(threadsDir(home)).catch(() => [])).filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<{ model?: string; sid?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (t?.model) allowed.add(family(t.model))
    if (t?.sid) sids.set(t.sid, { id: e.name, model: t.model })
  }
  const ro = await syncRollup(h, now)
  const rm = ro.days[dayOf(now)]?.rm ?? {}
  for (const [k, a] of Object.entries(rm)) {
    const [role, model = ''] = k.split('|')
    if (role === 'desk' && family(model) !== desk) out.push(`the desk spent ${usd(a[0])} today on ${model}, lean-agent pins ${desk}: that session started before setup pinned the model; close it and open the desk again`)
    if (role === 'thread' && allowed.size && !allowed.has(family(model))) out.push(`threads spent ${usd(a[0])} today on ${model}, but none was started on ${[...allowed].join('/')} only: a thread from before 1.0.2 or a model given by hand; close it and Start again`)
  }
  try {
    const r = await h.process.run(['claude', 'agents', '--json', '--all'])
    if (r.exitCode === 0) {
      for (const a of parseAgents(r.stdout)) {
        if (!a.model || !isRunning(a)) continue
        const t = sids.get(a.sid)
        if (t?.model && family(a.model) !== family(t.model)) out.push(`live session ${t.id} runs ${a.model}, lean-agent started it on ${t.model}`)
        else if (!t && a.cwd.replace(/\/$/, '') === deskDir(home) && family(a.model) !== desk) out.push(`the live desk session runs ${a.model}, lean-agent pins ${desk}`)
      }
    }
  } catch {
    /* no listing: the ledger above is what there is */
  }
  return out
}
export { addTo }
