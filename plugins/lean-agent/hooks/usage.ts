// Usage tokens (1.0.34): the ONE unit lean-agent counts work in. The plan limits are the 5 h window and the 7 d window, not dollars, so every budget,
// card and stat is in weighted "usage tokens" (input-equivalent):
//   tokens = input + 1.25 x cache write + 0.1 x cache read + 5 x output     (config budget.weights {input, cacheWrite, cacheRead, output} moves the factors)
// The numbers are the ones the ledger rows already carry (budget.ts record: the usage of every model request); the raw sums are always kept next to the
// weighted ones ("raw" in `lean_doctor stats`). Two scopes: the CURRENT 5 h WINDOW (since the reset time the engine reports minus 5 h, else a rolling 5 h) and
// ALL TIME (since config budget.since, default the first usage the mod has; `lean_config set budget.since today` starts again). No USD in here.
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { LEDGER, dayOf, fileSize, ledgerFiles, normalizeRow, readFrom, syncRollup } from './ledger'
import type { Agg, Norm } from './ledger'
import { cfgNum, cfgRaw } from './budgetcfg'

export type Raw = { input: number; cacheWrite: number; cacheRead: number; output: number }
export type Weights = Raw
export const DEFAULT_WEIGHTS: Weights = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }
export const WINDOW_MS = 5 * 3_600_000
const DAY_MS = 86_400_000

export const noRaw = (): Raw => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
// THE function: input-equivalent weighted usage tokens of a set of raw counts (rounded to a whole token)
export function usageTokens(r: Partial<Raw> | null | undefined, w: Weights = DEFAULT_WEIGHTS): number {
  if (!r) return 0
  return Math.round((r.input ?? 0) * w.input + (r.cacheWrite ?? 0) * w.cacheWrite + (r.cacheRead ?? 0) * w.cacheRead + (r.output ?? 0) * w.output)
}
export const rawSum = (r: Raw): number => r.input + r.cacheWrite + r.cacheRead + r.output
export const rawOfAgg = (a: Agg | undefined): Raw => ({ input: a?.[1] ?? 0, output: a?.[2] ?? 0, cacheRead: a?.[3] ?? 0, cacheWrite: a?.[4] ?? 0 })
export const rawOfRow = (r: Pick<Norm, 'in' | 'out' | 'cr' | 'cw'>): Raw => ({ input: r.in, output: r.out, cacheRead: r.cr, cacheWrite: r.cw })
// the usage object of a model request (budget.ts Usage)
export const rawOfUsage = (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined): Raw => ({ input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 })
export function addRaw(into: Raw, r: Raw): Raw {
  into.input += r.input
  into.cacheWrite += r.cacheWrite
  into.cacheRead += r.cacheRead
  into.output += r.output
  return into
}

// config budget.weights: each factor a finite number of at least 0, else its default (a half-written object keeps the other defaults)
export function weightsFrom(v: unknown): Weights {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const f = (k: keyof Weights): number => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) && (o[k] as number) >= 0 ? (o[k] as number) : DEFAULT_WEIGHTS[k])
  return { input: f('input'), cacheWrite: f('cacheWrite'), cacheRead: f('cacheRead'), output: f('output') }
}
export const weightsOf = async (h: Host): Promise<Weights> => weightsFrom(await cfgRaw(h, 'budget.weights').catch(() => undefined))

// a total: the weighted tokens, the raw sums behind them, the requests
export type Tally = { tokens: number; raw: Raw; requests: number }
export const emptyTally = (): Tally => ({ tokens: 0, raw: noRaw(), requests: 0 })
export function addTally(t: Tally, r: Raw, requests: number, w: Weights): void {
  addRaw(t.raw, r)
  t.requests += requests
  t.tokens = usageTokens(t.raw, w) // (from the raw sums: the weighted number never drifts by rounding)
}
const bump = (m: Record<string, Tally>, k: string, r: Raw, n: number, w: Weights) => addTally((m[k] ??= emptyTally()), r, n, w)

// the kinds the doctor and the pane split by: the session itself, reviewers, workers, readers (explorer / auditor are readers: read-only)
export type Kind = 'main' | 'reviewers' | 'workers' | 'readers' | 'other'
export const KINDS: readonly Kind[] = ['main', 'reviewers', 'workers', 'readers', 'other']
export function kindOf(agent: string): Kind {
  const a = String(agent ?? '').replace(/^lean-agent:/, '')
  if (!a || a === 'main') return 'main'
  if (/^reviewer/.test(a)) return 'reviewers'
  if (/^worker/.test(a)) return 'workers'
  if (/^(reader|explorer|auditor)/.test(a)) return 'readers'
  return 'other'
}

export type Split = { total: Tally; byRole: Record<string, Tally>; byKind: Record<string, Tally>; byThread: Record<string, Tally> }
export const emptySplit = (): Split => ({ total: emptyTally(), byRole: {}, byKind: {}, byThread: {} })
// created: thread id -> creation time; a row of an id from before the thread was created belongs to an earlier holder of the id and is in no thread's figure
export function splitRows(rows: Norm[], w: Weights, created: Record<string, number> = {}): Split {
  const s = emptySplit()
  for (const r of rows) {
    const raw = rawOfRow(r)
    addTally(s.total, raw, 1, w)
    bump(s.byRole, r.role, raw, 1, w)
    bump(s.byKind, kindOf(r.agent), raw, 1, w)
    if (r.role === 'thread' && /^t\d+$/.test(r.tN) && r.ts >= (created[r.tN] ?? 0)) bump(s.byThread, r.tN, raw, 1, w) // (a desk or plain row never counts for a thread, whatever its tN says)
  }
  return s
}

// ---- the current window ------------------------------------------------------------------------------------------------------------------------------
// desk/windows.json (windows.ts writes it; read here directly: windows.ts imports delivery.ts, and the guard must not reach that: import cycle)
export type WindowInfo = { start: number; resetsAt: number; pct: number | null; weekPct: number | null; rolling: boolean; now: number }
export async function windowInfo(h: Host): Promise<WindowInfo> {
  const now = await h.clock.now()
  const rolling = { start: now - WINDOW_MS, resetsAt: 0, pct: null as number | null, weekPct: null as number | null, rolling: true, now }
  try {
    const home = (await h.env.get('HOME'))?.replace(/\/+$/, '')
    const snap = home ? await readJson<{ windows?: { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }[] } | null>(h, `${leanDir(home)}/desk/windows.json`, null) : null
    const list = Array.isArray(snap?.windows) ? snap!.windows! : []
    const pctOf = (w: { percentUsed?: unknown } | undefined): number | null => {
      const n = Number(w?.percentUsed)
      return w && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
    }
    const five = list.find(x => x?.kind === 'five_hour')
    const seven = list.find(x => x?.kind === 'seven_day')
    const weekPct = pctOf(seven)
    const resetsAt = typeof five?.resetsAt === 'number' ? five.resetsAt : Date.parse(String(five?.resetsAt ?? '')) || 0
    // a window that has reset (or whose reset time is unknown) is not the current one: a rolling 5 h stands in
    if (!five || !resetsAt || resetsAt <= now) return { ...rolling, weekPct }
    return { start: resetsAt - WINDOW_MS, resetsAt, pct: pctOf(five), weekPct, rolling: false, now }
  } catch {
    return rolling
  }
}

const TAIL_BYTES = 4_000_000 // a 5 h window is a few thousand rows (about 150 bytes each)
const MAX_FILES = 3
// the ledger rows at or after `since`, from the tail of ledger.jsonl (and the newest rotated file when the live one starts inside the span)
export const rowsSince = async (h: Host, since: number): Promise<Norm[]> => (await rowsSinceX(h, since)).rows
// reached: the read got back past `since` (an older row was seen, or every file was read whole), so no row at or after it is missing
export async function rowsSinceX(h: Host, since: number): Promise<{ rows: Norm[]; reached: boolean }> {
  const home = await homeDir(h)
  const names = await ledgerFiles(h, home)
  const order = [LEDGER, ...names.filter(n => n !== LEDGER && !/^ledger-legacy/.test(n)).reverse()].slice(0, MAX_FILES)
  const out: Norm[] = []
  let reached = false
  for (const n of order) {
    const path = `${leanDir(home)}/${n}`
    const size = await fileSize(h, path)
    if (!size) continue
    const off = Math.max(0, size - TAIL_BYTES)
    let text = ''
    try {
      text = await readFrom(h, path, off)
    } catch {
      continue
    }
    let older = false
    const lines = text.split('\n')
    if (off > 0) lines.shift() // the first line of a tail may be cut
    for (const line of lines) {
      if (!line.trim()) continue
      let r: Norm | null = null
      try {
        r = normalizeRow(JSON.parse(line))
      } catch {
        continue
      }
      if (!r) continue
      if (r.ts >= since) out.push(r)
      else older = true
    }
    if (older) { reached = true; break }
    if (off > 0) break // this file is longer than the tail read: what is before it is not known
    reached = n === order[order.length - 1] || reached // (every file read whole)
  }
  return { rows: out, reached }
}

// ---- a thread's OWN usage ---------------------------------------------------------------------------------------------------------------------
// Ledger rows carry the thread id (tN) of the session that made the request: a thread's own session, its restarts and its subagents; the desk and plain sessions
// have none. A thread id can be handed out AGAIN (a removed folder): the new thread must not inherit the old holder's rows, so a thread counts only rows from its
// own creation on (thread.json `created`). 1.0.33 summed every kept day of the id (budgetthread.ts threadTotals): a thread that reused an id started "over budget".
export async function threadCreated(h: Host): Promise<Record<string, number>> {
  const home = await homeDir(h)
  const out: Record<string, number> = {}
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<{ created?: unknown } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null).catch(() => null)
    const c = Number(t?.created)
    out[e.name] = Number.isFinite(c) && c > 0 ? c : 0
  }
  return out
}

export type WindowUsage = WindowInfo & Split & { weights: Weights; rows: Norm[] }
const memo = new WeakMap<Host, { key: string; v: WindowUsage }>() // per host object: one pane refresh reads the ledger once
export async function windowUsage(h: Host): Promise<WindowUsage> {
  const info = await windowInfo(h)
  const home = await homeDir(h)
  const w = await weightsOf(h)
  const size = (await fileSize(h, `${leanDir(home)}/${LEDGER}`)) ?? 0
  const key = `${home}|${size}|${info.start}|${JSON.stringify(w)}`
  const m = memo.get(h)
  if (m?.key === key) return { ...m.v, ...info } // (the pct and the clock stay live)
  const rows = (await rowsSince(h, info.start)).filter(r => r.ts <= info.now + 60_000)
  const v: WindowUsage = { ...info, ...splitRows(rows, w, await threadCreated(h)), weights: w, rows }
  memo.set(h, { key, v })
  return v
}

// ---- all time ----------------------------------------------------------------------------------------------------------------------------------
// config budget.since: a day (2026-11-25) or a moment (2026-11-25T09:14:00Z); anything else is "not set" (the default: the first usage the mod has)
export function parseSince(v: unknown): number | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`)
    return Number.isFinite(t) && dayOf(t) === s ? t : null
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}
export type AllTime = Split & { since: number; fromConfig: boolean; weights: Weights; first: string | null; days: number }
export async function allTimeUsage(h: Host): Promise<AllTime> {
  const w = await weightsOf(h)
  const ro = await syncRollup(h)
  const keys = Object.keys(ro.days).sort()
  const first = ro.old?.from ?? keys[0] ?? null
  const cfgSince = parseSince(await cfgRaw(h, 'budget.since').catch(() => undefined))
  const since = cfgSince ?? (first ? Date.parse(`${first}T00:00:00Z`) : await h.clock.now())
  const sinceDay = dayOf(since)
  const s = emptySplit()
  const add = (a: Agg | undefined, into: Record<string, Tally> | null, k: string) => {
    if (!a) return
    const raw = rawOfAgg(a)
    if (into) bump(into, k, raw, a[5] ?? 0, w)
  }
  let days = 0
  for (const d of keys) {
    if (d < sinceDay) continue
    if (d === sinceDay && since % DAY_MS !== 0) continue // a moment inside this day: its rows are added below
    const day = ro.days[d]!
    days++
    addTally(s.total, rawOfAgg(day.t), day.t[5] ?? 0, w)
    for (const [k, a] of Object.entries(day.role)) add(a, s.byRole, k)
    for (const [k, a] of Object.entries(day.agent)) add(a, s.byKind, kindOf(k))
    for (const [k, a] of Object.entries(day.tN)) if (/^t\d+$/.test(k)) add(a, s.byThread, k)
  }
  if (since % DAY_MS !== 0) {
    const part = (await rowsSince(h, since)).filter(r => dayOf(r.ts) === sinceDay && r.ts >= since)
    const ps = splitRows(part, w)
    addTally(s.total, ps.total.raw, ps.total.requests, w)
    for (const [dst, src] of [[s.byRole, ps.byRole], [s.byKind, ps.byKind], [s.byThread, ps.byThread]] as const) for (const [k, t] of Object.entries(src)) bump(dst, k, t.raw, t.requests, w)
    if (part.length) days++
  }
  // history older than the rollup keeps (KEEP_DAYS) is one block of totals: counted when the start is on or before its first day
  if (ro.old && since <= Date.parse(`${ro.old.from}T00:00:00Z`)) addTally(s.total, rawOfAgg(ro.old.t), ro.old.t[5] ?? 0, w)
  return { ...s, since, fromConfig: cfgSince !== null, weights: w, first, days }
}

// each thread's OWN lifetime weighted tokens, from the rollup (ledger.ts keeps KEEP_DAYS days per thread): what the soft / hard budgets, the list and the doctor compare
// with. Only the thread's own rows count (its tN: its sessions, restarts and subagents), and only from its creation on: whole days after the creation day come from the
// rollup, the creation day itself from the ledger rows at or after `created` (when the tail read reaches that far; else the day's aggregate, which can only be too big
// when an earlier holder of the id ran the same day). A thread that has not run yet is 0.
export async function threadTotals(h: Host): Promise<Record<string, number>> {
  const w = await weightsOf(h)
  const ro = await syncRollup(h)
  const created = await threadCreated(h)
  const days = Object.keys(ro.days).sort()
  const firstDay = new Map<string, string>() // id -> the creation day's aggregate exists
  for (const id of Object.keys(created)) if (created[id] && ro.days[dayOf(created[id]!)]?.tN?.[id]) firstDay.set(id, dayOf(created[id]!))
  const need = [...firstDay.keys()].map(id => created[id]!)
  const part = need.length ? await rowsSinceX(h, Math.min(...need)) : { rows: [] as Norm[], reached: false }
  const raw: Record<string, Raw> = {}
  for (const d of days) {
    for (const [id, a] of Object.entries(ro.days[d]!.tN ?? {})) {
      if (!/^t\d+$/.test(id)) continue
      const c = created[id] ?? 0
      if (c && d < dayOf(c)) continue // an earlier holder of the id
      if (c && d === dayOf(c) && part.reached) continue // counted from the rows below
      addRaw((raw[id] ??= noRaw()), rawOfAgg(a))
    }
  }
  if (part.reached) {
    for (const r of part.rows) {
      const c = created[r.tN] ?? 0
      if (r.role !== 'thread' || !c || firstDay.get(r.tN) !== dayOf(r.ts) || r.ts < c) continue
      addRaw((raw[r.tN] ??= noRaw()), rawOfRow(r))
    }
  }
  for (const id of Object.keys(created)) raw[id] ??= noRaw() // (a thread with no row yet: 0)
  return Object.fromEntries(Object.entries(raw).map(([id, r]) => [id, usageTokens(r, w)]))
}

// ---- the optional caps (config budget.windowTokens, budget.allTimeTokens; none by default) ------------------------------------------------------
export type TokenCap = { scope: 'window' | 'allTime'; key: string; cap: number; used: number }
const capOf = async (h: Host, key: 'budget.windowTokens' | 'budget.allTimeTokens'): Promise<number | null> => {
  const n = await cfgNum(h, key)
  return n !== null && n > 0 ? n : null
}
// the caps that are set, with what is used against them
export async function tokenCaps(h: Host): Promise<TokenCap[]> {
  const out: TokenCap[] = []
  const wc = await capOf(h, 'budget.windowTokens')
  if (wc !== null) out.push({ scope: 'window', key: 'budget.windowTokens', cap: wc, used: (await windowUsage(h)).total.tokens })
  const ac = await capOf(h, 'budget.allTimeTokens')
  if (ac !== null) out.push({ scope: 'allTime', key: 'budget.allTimeTokens', cap: ac, used: (await allTimeUsage(h)).total.tokens })
  return out
}
// the first cap that is reached (used >= cap), or null: new work is held while one is
export async function capReached(h: Host): Promise<TokenCap | null> {
  try {
    return (await tokenCaps(h)).find(c => c.used >= c.cap) ?? null
  } catch {
    return null
  }
}
