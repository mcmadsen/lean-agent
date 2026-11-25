// `lean_doctor stats`: spend, caps, rule loads and worker feedback as compact text, computed here (no model, no ledger read by
// the caller). Spend comes from the rollup (ledger.ts), so it costs a stat and the tail of the ledger, not 27 MB.
import { LEDGER, addTo, dayOf, fileSize, firstRow, merge, normalizeRow, readFrom, syncRollup, zero } from './ledger'
import type { Agg, Dim } from './ledger'
import { projectDir, rulesStats, unverifiedLine } from './rules'
import { deskDir, homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskChoice, modelFamily, threadChoice } from './models'
import { loadOrch } from './orchestrate'
import { tierJobSection } from './workerruns'
import { longAnswerLines } from './answers'
import { appChoseText, readDeskModel, readDeskSwitch } from './deskmodel'
import { isRunning, parseAgents } from './threads'
import { capStats } from './cap'
import { windowLine } from './windows'
import { throttleLine, windowState } from './throttle'
import { budgetLine, budgetOf, threadTotals } from './budgetthread'
import { KINDS, allTimeUsage, rawOfAgg, rawOfRow, threadCreated, tokenCaps, usageTokens, weightsOf, windowUsage } from './usage'
import type { Raw, Weights } from './usage'
import { cardBadge, cardText, fmtTokens, headerText } from './formatusage'
import type { UsageHead } from './formatusage'
import { cfgBool, cfgNum } from './budgetcfg'
export { windowLine } // for the pane (pane.tsx is not edited here): `windowLine(h)` is one line of text

export const STATS_DAYS = 7
export const MAX_STATS_DAYS = 90
const TOP = 10

const usd = (n: number) => `$${n.toFixed(2)}` // only the optional `stats.showUsd` line uses it
const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
// the weighted usage tokens of an aggregate (usage.ts: input + 1.25 cache write + 0.1 cache read + 5 output; config budget.weights) and its raw sums
const tokensOf = (a: Agg | undefined, w: Weights): number => usageTokens(rawOfAgg(a), w)
const rawText = (r: Raw): string => `in ${tok(r.input)} out ${tok(r.output)} cache r ${tok(r.cacheRead)} w ${tok(r.cacheWrite)}`
const line = (name: string, a: Agg, w: Weights) => `  ${name}  ${fmtTokens(tokensOf(a, w))} tokens  ${a[5]} req  raw ${rawText(rawOfAgg(a))}`

// the last `days` calendar days ending at `now` (UTC, as the ledger's days are)
export function lastDays(now: number, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * 86_400_000))
}

// top TOP by usage tokens, the rest in one line
function table(title: string, d: Dim, w: Weights, top = TOP): string[] {
  const rows = Object.entries(d).sort((a, b) => tokensOf(b[1], w) - tokensOf(a[1], w) || a[0].localeCompare(b[0]))
  if (!rows.length) return []
  const out = [`${title}:`, ...rows.slice(0, top).map(([k, a]) => line(k, a, w))]
  if (rows.length > top) {
    const rest = zero()
    for (const [, a] of rows.slice(top)) merge(rest, a)
    out.push(line(`(+${rows.length - top} more)`, rest, w))
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
  const sum = { t: zero(), model: {} as Dim, agent: {} as Dim, role: {} as Dim, tN: {} as Dim, rm: {} as Dim, tme: {} as Dim }
  for (const d of span) {
    const day = ro.days[d]
    if (!day) continue
    merge(sum.t, day.t)
    for (const k of ['model', 'agent', 'role', 'tN', 'rm'] as const) mergeDim(sum[k], day[k])
    if (day.tme) mergeDim(sum.tme, day.tme)
  }
  const td = ro.days[today]
  const out: string[] = []
  out.push(await windowLine(h)) // the plan windows lead: "5h window: 78% used, resets 14:20 (in 1h 13m) | 7d: 41% (snapshot 3 min old)"
  out.push(`lean-agent stats: last ${n} day(s) to ${today}`)
  if ((await windowState(h)).level !== 'ok') out.push(await throttleLine(h)) // "5h window 74%: throttled above 70%: new agents haiku only, ..." (throttle.ts)
  // the period and the files this report read, and a warning when the live file starts inside the window (a rotation moved older rows)
  const read = Object.keys(ro.files).sort()
  out.push(`period: ${span[0]} 00:00Z to now; ledger files read: ${read.join(', ') || 'none'} (rows: ${ro.rows})`)
  const start = await firstRow(h, `${leanDir(home)}/${LEDGER}`).catch(() => null)
  const rotated = read.filter(f => f !== LEDGER)
  if (start && rotated.length && start.ts > Date.parse(`${span[0]}T00:00:00Z`)) out.push(`WARNING: ledger.jsonl starts at ${new Date(start.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC (rotated); older rows of this window are in ${rotated.join(', ')}, which this report read too`)
  const w = await weightsOf(h)
  // usage tokens (usage.ts): weighted = input + 1.25 cache write + 0.1 cache read + 5 output (config budget.weights); the raw sums stay next to them
  out.push(`usage (weighted tokens): today ${fmtTokens(tokensOf(td?.t, w))} (${td?.t[5] ?? 0} req) · ${n}d ${fmtTokens(tokensOf(sum.t, w))} (${sum.t[5]} req) · raw ${n}d ${rawText(rawOfAgg(sum.t))}`)
  out.push(...(await usageScopeLines(h, w)))
  const bl = await budgetLine(h).catch(() => '') // "thread budgets (80% or more used; threads.softTokens 2M): t1 2.1M/2M tokens!" (budgetthread.ts)
  if (bl) out.push(bl)
  out.push(`daily: ${span.map(d => `${d.slice(5)} ${fmtTokens(tokensOf(ro.days[d]?.t, w))}`).join(' · ')}`)
  if (await cfgBool(h, 'stats.showUsd').catch(() => false)) out.push(`estimated cost (API list prices, not what a plan charges): today ${usd(td?.t[0] ?? 0)} · ${n}d ${usd(sum.t[0])}`) // the ONLY USD figure, off by default (config stats.showUsd)
  out.push(...table(`by model (${n}d)`, sum.model, w))
  // opus is the expensive model (the user approves it per thread in the pane): its share of the window, and the threads that run on it
  const os = await opusShare(h, n).catch(() => null)
  if (os && os.total > 0) out.push(`opus share (${n}d): ${Math.round(os.pct)}% of usage tokens (${fmtTokens(os.tokens)} of ${fmtTokens(os.total)})${os.threads.length ? `; threads ${os.threads.join(', ')} used opus or are on it (on opus now: ${os.now.join(', ') || 'none'})` : '; no open thread is on opus'}`)
  out.push(...table(`by role x model (${n}d; a model you did not configure shows here)`, Object.fromEntries(Object.entries(sum.rm).map(([k, a]) => [k.replace('|', ' / '), a])), w))
  out.push(...table(`by role (${n}d)`, sum.role, w))
  out.push(...table(`by agent (${n}d; main = the session itself)`, sum.agent, w))
  out.push(...table(`by thread (${n}d)`, sum.tN, w))
  out.push(...(await tierJobSection(h, now, n).catch(() => [])))
  out.push(...(await longAnswerLines(h, now, n).catch(() => [])))
  // small messages (cap.ts): characters of Bash / MCP output that were cut before they entered a thread's conversation
  const cut = await capStats(h, now, n).catch(() => ({ results: 0, chars: 0 }))
  if (cut.results) out.push(`output cap (${n}d): saved ${tok(cut.chars)} chars in ${cut.results} result${cut.results === 1 ? '' : 's'} (the full text of each is a file under the thread folder)`)
  out.push(...(await threadChoices(h, home, sum.tme, tokensOf(sum.role.thread, w), n, w)))
  // rules
  const projects = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/projects.json`, {})
  const names = opts.project ? [opts.project].filter(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) && !p.includes('..')) : Object.keys(projects && typeof projects === 'object' ? projects : {}).filter(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))
  for (const p of names) {
    const r = await rulesStats(h, p)
    const have = (await h.fs.list(`${projectDir(home, p)}/rules`).catch(() => [])).filter(f => f.name.endsWith('.md')).length
    if (!have) continue
    if (!r.verified) {
      // nothing was ever recorded: "never loaded" would only be the absence of a log
      out.push(`rules ${p}: ${have} rule(s); ${unverifiedLine(p, r)}${r.overCap.length ? `; ${r.overCap.length} over the size cap (${r.overCap.slice(0, 4).map(x => x.split(':')[0]).join(', ')}${r.overCap.length > 4 ? ', ...' : ''}): learn ${p} --trim or lean_rules check` : ''}`)
      continue
    }
    const loads = Object.entries(r.loaded).filter(([f]) => !r.never.includes(f))
    const nv = r.neverConfirmed
    out.push(`rules ${p}: ${have} rule(s), ${have - r.never.length} loaded at least once (${loads.reduce((s, [, c]) => s + c, 0)} loads)${nv.length ? `; never loaded since they were written: ${nv.slice(0, 12).join(', ')}${nv.length > 12 ? ` (+${nv.length - 12})` : ''}` : ''}${r.never.length > nv.length ? `; ${r.never.length - nv.length} not observed yet (written after the last recorded load)` : ''}${r.overCap.length ? `; ${r.overCap.length} over the size cap: learn ${p} --trim or lean_rules check` : ''}`)
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

// Threads by the model/effort they were started with (thread.json, written into each ledger row since the version that added it):
// a table, the share of thread spend that predates it, and "threads at the default" so the user can judge the default.
// Keys of `tme` are `tN|model|effort`; one thread with two choices counts once under each.
export async function threadChoices(h: Host, home: string, tme: Dim, threadTokens: number, n: number, w: Weights): Promise<string[]> {
  const rows = Object.entries(tme).map(([k, a]) => {
    const [tN = '', model = '', effort = ''] = k.split('|')
    return { tN, group: `${family(model)}/${effort}`, a }
  })
  if (!rows.length) return [`by thread model/effort (${n}d): none recorded yet (thread rows carry model and effort since this version)`]
  const groups: Dim = {}
  const threads = new Map<string, Set<string>>()
  for (const r of rows) {
    merge((groups[r.group] ??= zero()), r.a)
    if (!threads.has(r.group)) threads.set(r.group, new Set())
    threads.get(r.group)!.add(r.tN)
  }
  const named: Dim = {}
  for (const [g, a] of Object.entries(groups)) named[`${g} · ${threads.get(g)!.size} thread(s)`] = a
  const out = table(`by thread model/effort (${n}d; the thread's own choice, rows since effort was recorded)`, named, w)
  const split = rows.reduce((s, r) => s + tokensOf(r.a, w), 0)
  if (threadTokens - split > 50) out.push(`  (+ ${fmtTokens(threadTokens - split)} tokens of thread usage from before model and effort were recorded: not split)`)
  const def = await threadChoice(h, home, {}, undefined, (await loadOrch(h).catch(() => undefined))?.on !== false)
  if (typeof def !== 'string') {
    const key = `${family(def.model)}/${def.effort}`
    const mine = rows.filter(r => r.group === key).map(r => tokensOf(r.a, w)).sort((a, b) => a - b)
    const median = mine.length ? (mine.length % 2 ? mine[(mine.length - 1) / 2]! : (mine[mine.length / 2 - 1]! + mine[mine.length / 2]!) / 2) : 0
    out.push(`threads at the default (${key}): ${threads.get(key)?.size ?? 0}, ${fmtTokens(mine.reduce((s, x) => s + x, 0))} tokens, median ${fmtTokens(median)}`)
  }
  return out
}

// The share of the last `days` days' usage tokens that went to opus (any model whose family is opus), and the threads that run on it: the ones that
// used opus in the window (the ledger's thread x model rows) and the open ones started on it (thread.json). Doctor shows a FIX row over
// OPUS_SHARE_FIX percent: opus needs the user's approval, so a high share means threads got it some other way (an older start, a config value).
export const OPUS_SHARE_FIX = 40
// threads: used opus in the window or open on it (history); now: only the open threads that are ON opus now (what doctor can act on)
export type OpusShare = { tokens: number; total: number; pct: number; threads: string[]; now: string[] }
export async function opusShare(h: Host, days = STATS_DAYS): Promise<OpusShare> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const ro = await syncRollup(h, now)
  const w = await weightsOf(h)
  let opus = 0
  let total = 0
  const ids = new Set<string>()
  for (const d of lastDays(now, days)) {
    const day = ro.days[d]
    if (!day) continue
    total += tokensOf(day.t, w)
    for (const [k, a] of Object.entries(day.model)) if (family(k) === 'opus') opus += tokensOf(a, w)
    for (const [k, a] of Object.entries(day.tme ?? {})) {
      const [tN = '', model = ''] = k.split('|')
      if (family(model) === 'opus' && /^t\d+$/.test(tN) && tokensOf(a, w) > 0) ids.add(tN)
    }
  }
  const live = new Set<string>()
  for (const e of (await h.fs.list(threadsDir(home)).catch(() => [])).filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<{ model?: string; state?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (t?.model && family(t.model) === 'opus' && t.state !== 'closed') { ids.add(e.name); live.add(e.name) }
  }
  const byId = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))
  return { tokens: opus, total, pct: total > 0 ? (opus / total) * 100 : 0, threads: [...ids].sort(byId), now: [...live].sort(byId) }
}

// The usage head of the pane (the tokens of the current 5 h window with the plan's percentages) and each thread's usage in that window; null when there is no ledger at all
export type Spend = UsageHead & { byThread: Record<string, number> }
export async function spendNumbers(h: Host): Promise<Spend | null> {
  const home = await homeDir(h)
  if (!(await h.fs.exists(`${leanDir(home)}/ledger.jsonl`).catch(() => false)) && !(await h.fs.exists(`${leanDir(home)}/rollup.json`).catch(() => false))) return null
  const u = await windowUsage(h)
  return { windowTokens: u.total.tokens, windowPct: u.pct, weekPct: u.weekPct, rolling: u.rolling, byThread: Object.fromEntries(Object.entries(u.byThread).map(([k, t]) => [k, t.tokens])) }
}

// What each thread has used in the CURRENT WINDOW, live (usage.ts windowUsage: the rows of ITS OWN tN from its creation on, never the desk's or another thread's): the numbers for a pane card
// (the view reads this; it is the one function to wire). `model` and `effort` are the thread's own choice (thread.json); `over` is set when its LIFETIME usage passed its soft budget
// (config threads.softTokens, or its own: none by default). Threads that used nothing in the window are not listed; an empty object when there is no ledger.
// `reviews`, `restarts`: of those tokens, what the reviewer agents used and what the first request of each fresh session (a restart, before any work) used
// `main`, `workers`: the thread's own session and its worker agents (reviews are the third part): "main 20k · workers 16k · reviews 12k" in the thread pane
export type ThreadCost = { id: string; tokens: number; model: string; effort: string; over: boolean; reviews?: number; restarts?: number; main?: number; workers?: number }
export async function threadCostsToday(h: Host, spend?: Spend | null): Promise<Record<string, ThreadCost>> {
  const s = spend === undefined ? await spendNumbers(h) : spend
  if (!s) return {}
  const home = await homeDir(h)
  const parts = await threadSpendParts(h).catch(() => ({}) as Record<string, SpendParts>)
  const totals = await threadTotals(h).catch(() => ({}) as Record<string, number>)
  const out: Record<string, ThreadCost> = {}
  for (const [id, tokens] of Object.entries(s.byThread)) {
    if (!/^t\d+$/.test(id) || !(tokens > 0)) continue
    const t = await readJson<{ model?: unknown; effort?: unknown; budgetTokens?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const b = t ? await budgetOf(h, t).catch(() => null) : null
    const p = parts[id]
    out[id] = { id, tokens, model: typeof t?.model === 'string' ? t.model : '', effort: typeof t?.effort === 'string' ? t.effort : '', over: b !== null && (totals[id] ?? 0) >= b, ...(p?.reviews ? { reviews: Math.min(p.reviews, tokens) } : {}), ...(p?.restarts ? { restarts: Math.min(p.restarts, tokens) } : {}), ...(p && (p.main || p.workers) ? { main: Math.min(p.main, tokens), workers: Math.min(p.workers, tokens) } : {}) }
  }
  return out
}
// "48k" for a card, "48k!" when it is over its soft budget; "window 48k tokens (reviews 12k, restarts 3k)": the card, the thread pane and `lean_thread list` say the same line (formatusage.ts)
export const costBadge = (c: Pick<ThreadCost, 'tokens' | 'over'>): string => cardBadge(c)
export const costLine = (c: Pick<ThreadCost, 'tokens' | 'over' | 'reviews' | 'restarts' | 'main' | 'workers'>, withSplit = false): string => cardText(c, withSplit)
// One thread's line for a list: null when it used nothing in the window
export async function threadSpendLine(h: Host, id: string): Promise<string | null> {
  const c = (await threadCostsToday(h).catch(() => ({}) as Record<string, ThreadCost>))[id]
  return c ? costLine(c) : null
}

// the window's reviewer, restart, main and worker tokens per thread, from the window's ledger rows (usage.ts windowUsage keeps them): `agent` reviewer rows, and the `fresh` row (the first
// request of a session) of a session that began more than 10 minutes after the thread was created. Only a thread's own rows (role thread, its tN, from its creation on).
export type SpendParts = { reviews: number; restarts: number; main: number; workers: number }
export async function threadSpendParts(h: Host): Promise<Record<string, SpendParts>> {
  const u = await windowUsage(h)
  const created = await threadCreated(h)
  const out: Record<string, SpendParts> = {}
  for (const r of u.rows) {
    if (r.role !== 'thread' || !/^t\d+$/.test(r.tN) || r.ts < (created[r.tN] ?? 0)) continue
    const tk = usageTokens(rawOfRow(r), u.weights)
    const p = (out[r.tN] ??= { reviews: 0, restarts: 0, main: 0, workers: 0 })
    if (r.agent === 'reviewer') p.reviews += tk
    else if (r.agent === 'main') p.main += tk
    else p.workers += tk
    if (r.fresh && r.agent === 'main' && r.ts - (created[r.tN] ?? 0) > 10 * 60_000) p.restarts += tk
  }
  return out
}

export const spendText = (s: Spend): string => headerText(s)

// the scopes of `lean_doctor stats`: the current window (with the engine's percentage, by kind and by thread), all time since budget.since, and the optional caps
const hm = (ts: number) => new Date(ts).toISOString().slice(11, 16)
async function usageScopeLines(h: Host, w: Weights): Promise<string[]> {
  const out: string[] = []
  const u = await windowUsage(h)
  const pct = u.pct === null ? '' : ` (${Math.round(u.pct)}% of the window)`
  out.push(`window: ${fmtTokens(u.total.tokens)} tokens${pct}, ${u.total.requests} req, since ${hm(u.start)}Z ${u.rolling ? '(rolling 5 h: the engine reports no current window)' : `(resets ${hm(u.resetsAt)}Z)`} · raw ${rawText(u.total.raw)}`)
  const kinds = KINDS.map(k => [k, u.byKind[k]?.tokens ?? 0] as const).filter(([, t]) => t > 0)
  if (kinds.length) out.push(`  window by kind: ${kinds.map(([k, t]) => `${k} ${fmtTokens(t)}`).join(' · ')}`)
  const th = Object.entries(u.byThread).sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0])).slice(0, TOP)
  if (th.length) out.push(`  window by thread: ${th.map(([id, t]) => `${id} ${fmtTokens(t.tokens)}`).join(' · ')}`)
  const roles = Object.entries(u.byRole).sort((a, b) => b[1].tokens - a[1].tokens)
  if (roles.length) out.push(`  window by role: ${roles.map(([r, t]) => `${r} ${fmtTokens(t.tokens)}`).join(' · ')}`)
  const a = await allTimeUsage(h)
  out.push(`all time since ${a.fromConfig ? new Date(a.since).toISOString().slice(0, 16).replace('T', ' ') + 'Z (budget.since)' : `${a.first ?? 'now'} (the first usage; lean_config set budget.since today starts again)`}: ${fmtTokens(a.total.tokens)} tokens, ${a.total.requests} req · raw ${rawText(a.total.raw)}`)
  const akinds = KINDS.map(k => [k, a.byKind[k]?.tokens ?? 0] as const).filter(([, t]) => t > 0)
  if (akinds.length) out.push(`  all time by kind: ${akinds.map(([k, t]) => `${k} ${fmtTokens(t)}`).join(' · ')}`)
  const caps = await tokenCaps(h)
  const capOf = (scope: string) => caps.find(c => c.scope === scope)
  const soft = await cfgNum(h, 'threads.softTokens')
  const hard = await cfgNum(h, 'threads.hardTokens')
  const none = (n: number | null) => (n !== null && n > 0 ? fmtTokens(n) : 'none')
  out.push(`token caps (optional; the window percentages are the main control): window ${fmtTokens(u.total.tokens)} of ${capOf('window') ? fmtTokens(capOf('window')!.cap) : 'none'} · all time ${fmtTokens(a.total.tokens)} of ${capOf('allTime') ? fmtTokens(capOf('allTime')!.cap) : 'none'} · per thread soft ${none(soft)}, hard ${none(hard)}`)
  void w
  return out
}

// Sessions on a model lean-agent did not configure: spend today per role x model against the desk's pinned model and the
// threads' recorded ones (a desk started before setup pinned it, a thread from before 1.0.2), and live sessions whose listed
// model differs (`claude agents --json`, when it reports one). Returns one sentence each.
const family = modelFamily
// `info`: spend of today on the model the app started the desk on, when lean-agent switched that session to the pin (deskmodel.ts keeps
// the record): nothing is wrong now, so doctor shows a note, never FIX
// What the desk's own requests (not a worker's) cost on a model other than `desk`, from `since` on, per model: today's rows of the ledger tail
// (the rollup has no clock inside a day). null when the ledger cannot be read, so the caller keeps the whole day's number.
async function deskSpendSince(h: Host, home: string, since: number, desk: string, now: number, w: Weights): Promise<Record<string, number> | null> {
  try {
    const file = `${leanDir(home)}/${LEDGER}`
    const size = await fileSize(h, file)
    if (size === null) return null
    const out: Record<string, number> = {}
    for (const line of (await readFrom(h, file, Math.max(0, size - 4_000_000))).split('\n')) {
      if (!line.includes('"desk"')) continue
      let r: ReturnType<typeof normalizeRow> = null
      try {
        r = normalizeRow(JSON.parse(line))
      } catch {
        continue
      }
      if (r && r.role === 'desk' && r.agent === 'main' && r.ts >= since && dayOf(r.ts) === dayOf(now) && family(r.model) !== desk) out[r.model] = (out[r.model] ?? 0) + usageTokens(rawOfRow(r), w)
    }
    return out
  } catch {
    return null
  }
}
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16)

export async function modelMismatches(h: Host): Promise<string[]> {
  return (await modelRows(h)).fix
}
export async function modelRows(h: Host): Promise<{ fix: string[]; info: string[] }> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const out: string[] = []
  const info: string[] = []
  const desk = (await deskChoice(h, home)).model
  // switched today, and the switch is not undone by a later session that could not be set (deskmodel.ts keeps model.json for that)
  const sw = await readDeskSwitch(h)
  const switched = sw && family(sw.to) === desk && dayOf(sw.at) === dayOf(now) && !(await readDeskModel(h)) ? sw : null
  // the app choosing again: ONE line with the count; the engine's switch event (source "sdk") does not tell the app's default from its model menu
  if (sw && sw.count && sw.count > 1 && dayOf(sw.at) === dayOf(now)) info.push(`${appChoseText(sw.from, sw.count, desk)} (today, last session)${sw.blind ? "; the engine cannot tell the app's choice from its model menu, so lean-agent asks once per session and reapplies the pin: pick " + desk.charAt(0).toUpperCase() + desk.slice(1) + " in the app's model menu to stop it" : ''}`)
  else if (sw?.blind && dayOf(sw.at) === dayOf(now)) info.push(`the desk's model switch is asked once per session: the engine cannot tell the app's choice from its model menu (source "sdk" for both)`)
  const allowed = new Set<string>()
  const def = await threadChoice(h, home, {}, undefined, (await loadOrch(h).catch(() => undefined))?.on !== false)
  if (typeof def !== 'string') allowed.add(family(def.model))
  const sids = new Map<string, { id: string; model?: string }>()
  for (const e of (await h.fs.list(threadsDir(home)).catch(() => [])).filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<{ model?: string; sid?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (t?.model) allowed.add(family(t.model))
    if (t?.sid) sids.set(t.sid, { id: e.name, model: t.model })
  }
  let listing: ReturnType<typeof parseAgents> | null = null
  try {
    const r = await h.process.run(['claude', 'agents', '--json', '--all'])
    if (r.exitCode === 0) listing = parseAgents(r.stdout)
  } catch {
    /* no listing: the ledger below is what there is */
  }
  // "started before setup pinned the model" is said only when it is KNOWN: the live desk session started before the pin was written
  // (desk/pinned.json, written by setup when the pin changed). Otherwise the app chose the model for that session.
  const deskLive = (listing ?? []).find(a => isRunning(a) && !sids.has(a.sid) && a.cwd.replace(/\/$/, '') === deskDir(home))
  const pinRec = await readJson<{ at?: number; model?: string } | null>(h, `${leanDir(home)}/desk/pinned.json`, null)
  const beforePin = !!deskLive && deskLive.startedAt > 0 && typeof pinRec?.at === 'number' && pinRec.at > 0 && pinRec.model === desk && deskLive.startedAt < pinRec.at && !(deskLive.model && family(deskLive.model) === desk)
  const deskWhy = beforePin ? 'that session started before setup pinned the model; close it and open the desk again' : `the app chose another model for this session: pick ${desk.charAt(0).toUpperCase() + desk.slice(1)} in its model menu${deskLive?.model && family(deskLive.model) === desk ? ` (the live desk session runs ${desk} now)` : ''}`
  const ro = await syncRollup(h, now)
  const rm = ro.days[dayOf(now)]?.rmm ?? {} // the sessions' own requests: a worker's model is chosen per call and is no mismatch
  // The desk row counts only what was spent AFTER lean-agent pinned the desk model (desk/pinned.json `at`): money spent on the app's model
  // earlier today (before this version pinned one) is history, a note, never a problem that stays until midnight.
  const pinAt = pinRec?.model === desk && typeof pinRec.at === 'number' && pinRec.at > 0 ? pinRec.at : 0
  const w = await weightsOf(h)
  const afterPin = pinAt && dayOf(pinAt) === dayOf(now) ? await deskSpendSince(h, home, pinAt, desk, now, w) : null
  for (const [k, agg] of Object.entries(rm)) {
    const [role, model = ''] = k.split('|')
    const a0 = tokensOf(agg, w)
    if (role === 'desk' && family(model) !== desk) {
      if (switched && family(switched.from) === family(model)) info.push(`the app started the desk on ${model}; lean-agent switched it to ${desk} (${fmtTokens(a0)} tokens used on ${model} today)`)
      else if (afterPin && !((afterPin[model] ?? 0) > 0)) info.push(`the desk used ${fmtTokens(a0)} tokens today on ${model} before lean-agent pinned ${desk} at ${hhmm(pinAt)} UTC; nothing on it since`)
      else {
        const spent = afterPin ? afterPin[model]! : a0
        const history = a0 - spent // used before the pin: not counted (said only when there is some)
        out.push(`the desk used ${fmtTokens(spent)} tokens ${history > 0 ? `on ${model} since lean-agent pinned ${desk} at ${hhmm(pinAt)} UTC (${fmtTokens(history)} before that is history)` : `today on ${model}`}, lean-agent pins ${desk}: ${deskWhy}`)
      }
    }
    if (role === 'thread' && allowed.size && !allowed.has(family(model))) out.push(`threads used ${fmtTokens(a0)} tokens today on ${model}, but none was started on ${[...allowed].join('/')} only: a thread from before 1.0.2 or a model given by hand; close it and Start again`)
  }
  for (const a of listing ?? []) {
    if (!a.model || !isRunning(a)) continue
    const t = sids.get(a.sid)
    if (t?.model && family(a.model) !== family(t.model)) out.push(`live session ${t.id} runs ${a.model}, lean-agent started it on ${t.model}`)
    else if (!t && a.cwd.replace(/\/$/, '') === deskDir(home) && family(a.model) !== desk) out.push(`the live desk session runs ${a.model}, lean-agent pins ${desk}`)
  }
  return { fix: out, info }
}
export { addTo }
