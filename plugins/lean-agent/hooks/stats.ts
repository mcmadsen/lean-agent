// `lean_doctor stats`: spend, caps, rule loads and worker feedback as compact text, computed here (no model, no ledger read by
// the caller). Spend comes from the rollup (ledger.ts), so it costs a stat and the tail of the ledger, not 27 MB.
import { budgetLimits, readConfig } from './budget'
import { LEDGER, addTo, dayOf, fileSize, firstRow, merge, normalizeRow, readFrom, syncRollup, zero } from './ledger'
import type { Agg, Dim } from './ledger'
import { projectDir, rulesStats, unverifiedLine } from './rules'
import { deskDir, homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskChoice, modelFamily, threadChoice } from './models'
import { appChoseText, readDeskModel, readDeskSwitch } from './deskmodel'
import { isRunning, parseAgents } from './threads'
import { capStats } from './cap'
import { windowLine } from './windows'
export { windowLine } // for the pane (pane.tsx is not edited here): `windowLine(h)` is one line of text

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
  // the period and the files this report read, and a warning when the live file starts inside the window (a rotation moved older rows)
  const read = Object.keys(ro.files).sort()
  out.push(`period: ${span[0]} 00:00Z to now; ledger files read: ${read.join(', ') || 'none'} (rows: ${ro.rows})`)
  const start = await firstRow(h, `${leanDir(home)}/${LEDGER}`).catch(() => null)
  const rotated = read.filter(f => f !== LEDGER)
  if (start && rotated.length && start.ts > Date.parse(`${span[0]}T00:00:00Z`)) out.push(`WARNING: ledger.jsonl starts at ${new Date(start.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC (rotated); older rows of this window are in ${rotated.join(', ')}, which this report read too`)
  out.push(`spend: today ${usd(td?.t[0] ?? 0)} (${td?.t[5] ?? 0} req) · ${n}d ${usd(sum.t[0])} (${sum.t[5]} req)`)
  // caps (config.json dailyCapUsd) against today, per role
  const cfg: any = await readConfig(h, home)
  const caps = cfg?.dailyCapUsd && typeof cfg.dailyCapUsd === 'object' ? (cfg.dailyCapUsd as Record<string, number>) : {}
  const capLines = ['desk', 'thread', 'plain'].map(r => `${r} ${usd(td?.role[r]?.[0] ?? 0)} of ${typeof caps[r] === 'number' ? usd(caps[r]!) : 'no cap'}`)
  out.push(`caps today: ${capLines.join(' · ')}${typeof cfg?.workerCapUsd === 'number' ? ` · per worker ${usd(cfg.workerCapUsd)}` : ''}`)
  out.push(`daily: ${span.map(d => `${d.slice(5)} ${usd(ro.days[d]?.t[0] ?? 0)}`).join(' · ')}`)
  out.push(...table(`by model (${n}d)`, sum.model))
  // opus is the expensive model (the user approves it per thread in the pane): its share of the window, and the threads that run on it
  const os = await opusShare(h, n).catch(() => null)
  if (os && os.total > 0) out.push(`opus share (${n}d): ${Math.round(os.pct)}% of spend (${usd(os.usd)} of ${usd(os.total)})${os.threads.length ? `; threads ${os.threads.join(', ')} spent on opus or are on it (on opus now: ${os.now.join(', ') || 'none'})` : '; no open thread is on opus'}`)
  out.push(...table(`by role x model (${n}d; a model you did not configure shows here)`, Object.fromEntries(Object.entries(sum.rm).map(([k, a]) => [k.replace('|', ' / '), a]))))
  out.push(...table(`by role (${n}d)`, sum.role))
  out.push(...table(`by agent (${n}d; main = the session itself)`, sum.agent))
  out.push(...table(`by thread (${n}d)`, sum.tN))
  // small messages (cap.ts): characters of Bash / MCP output that were cut before they entered a thread's conversation
  const cut = await capStats(h, now, n).catch(() => ({ results: 0, chars: 0 }))
  if (cut.results) out.push(`output cap (${n}d): saved ${tok(cut.chars)} chars in ${cut.results} result${cut.results === 1 ? '' : 's'} (the full text of each is a file under the thread folder)`)
  out.push(...(await threadChoices(h, home, sum.tme, sum.role.thread?.[0] ?? 0, n)))
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
export async function threadChoices(h: Host, home: string, tme: Dim, threadUsd: number, n: number): Promise<string[]> {
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
  const out = table(`by thread model/effort (${n}d; the thread's own choice, rows since effort was recorded)`, named)
  const split = rows.reduce((s, r) => s + r.a[0], 0)
  if (threadUsd - split > 0.005) out.push(`  (+ ${usd(threadUsd - split)} of thread spend from before model and effort were recorded: not split)`)
  const def = await threadChoice(h, home, {})
  if (typeof def !== 'string') {
    const key = `${family(def.model)}/${def.effort}`
    const mine = rows.filter(r => r.group === key).map(r => r.a[0]).sort((a, b) => a - b)
    const median = mine.length ? (mine.length % 2 ? mine[(mine.length - 1) / 2]! : (mine[mine.length / 2 - 1]! + mine[mine.length / 2]!) / 2) : 0
    out.push(`threads at the default (${key}): ${threads.get(key)?.size ?? 0}, ${usd(mine.reduce((s, x) => s + x, 0))}, median ${usd(median)}`)
  }
  return out
}

// The share of the last `days` days' spend that went to opus (any model whose family is opus), and the threads that run on it: the ones that
// spent on opus in the window (the ledger's thread x model rows) and the open ones started on it (thread.json). Doctor shows a FIX row over
// OPUS_SHARE_FIX percent: opus needs the user's approval, so a high share means threads got it some other way (an older start, a config value).
export const OPUS_SHARE_FIX = 40
// threads: spent on opus in the window or open on it (history); now: only the open threads that are ON opus now (what doctor can act on)
export type OpusShare = { usd: number; total: number; pct: number; threads: string[]; now: string[] }
export async function opusShare(h: Host, days = STATS_DAYS): Promise<OpusShare> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const ro = await syncRollup(h, now)
  let usdOpus = 0
  let total = 0
  const ids = new Set<string>()
  for (const d of lastDays(now, days)) {
    const day = ro.days[d]
    if (!day) continue
    total += day.t[0]
    for (const [k, a] of Object.entries(day.model)) if (family(k) === 'opus') usdOpus += a[0]
    for (const [k, a] of Object.entries(day.tme ?? {})) {
      const [tN = '', model = ''] = k.split('|')
      if (family(model) === 'opus' && /^t\d+$/.test(tN) && a[0] > 0) ids.add(tN)
    }
  }
  const live = new Set<string>()
  for (const e of (await h.fs.list(threadsDir(home)).catch(() => [])).filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<{ model?: string; state?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (t?.model && family(t.model) === 'opus' && t.state !== 'closed') { ids.add(e.name); live.add(e.name) }
  }
  const byId = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))
  return { usd: usdOpus, total, pct: total > 0 ? (usdOpus / total) * 100 : 0, threads: [...ids].sort(byId), now: [...live].sort(byId) }
}

// "Today $x · 7d $y" for the pane footer and a thread's status line; null when there is no ledger at all
export type Spend = { today: number; week: number; byThread: Record<string, number> }
// today and the last 7 days in usd, and today's usd per thread (`tN`); null when there is no ledger at all
export async function spendNumbers(h: Host): Promise<Spend | null> {
  const home = await homeDir(h)
  if (!(await h.fs.exists(`${leanDir(home)}/ledger.jsonl`).catch(() => false)) && !(await h.fs.exists(`${leanDir(home)}/rollup.json`).catch(() => false))) return null
  const now = await h.clock.now()
  const ro = await syncRollup(h, now)
  const w = zero()
  for (const d of lastDays(now, STATS_DAYS)) if (ro.days[d]) merge(w, ro.days[d]!.t)
  const today = ro.days[dayOf(now)]
  return { today: today?.t[0] ?? 0, week: w[0], byThread: Object.fromEntries(Object.entries(today?.tN ?? {}).map(([k, a]) => [k, a[0]])) }
}

// What each thread has spent TODAY, live: the numbers for a pane card (the view reads this; it is the one function to wire). `model` and
// `effort` are the thread's own choice (thread.json); `over` is set when it passed the per-thread daily alert (config budget.threadDaily,
// default 20 USD, "off" = never). Threads that spent nothing today are not listed; an empty object when there is no ledger.
export type ThreadCost = { id: string; usd: number; model: string; effort: string; over: boolean }
export async function threadCostsToday(h: Host, spend?: Spend | null): Promise<Record<string, ThreadCost>> {
  const s = spend === undefined ? await spendNumbers(h) : spend
  if (!s) return {}
  const home = await homeDir(h)
  const { thread } = await budgetLimits(h)
  const out: Record<string, ThreadCost> = {}
  for (const [id, usdToday] of Object.entries(s.byThread)) {
    if (!/^t\d+$/.test(id) || !(usdToday > 0)) continue
    const t = await readJson<{ model?: unknown; effort?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    out[id] = { id, usd: usdToday, model: typeof t?.model === 'string' ? t.model : '', effort: typeof t?.effort === 'string' ? t.effort : '', over: thread !== null && usdToday >= thread }
  }
  return out
}
// "$6.20" for a card, "$21.30!" when it is over the alert
export const costBadge = (c: Pick<ThreadCost, 'usd' | 'over'>): string => `$${c.usd.toFixed(2)}${c.over ? '!' : ''}`

export const spendText = (s: Spend): string => `$${s.today.toFixed(2)} · 7d $${s.week.toFixed(2)}`
export async function spendLine(h: Host): Promise<string | null> {
  const s = await spendNumbers(h)
  return s ? spendText(s) : null
}

// Sessions on a model lean-agent did not configure: spend today per role x model against the desk's pinned model and the
// threads' recorded ones (a desk started before setup pinned it, a thread from before 1.0.2), and live sessions whose listed
// model differs (`claude agents --json`, when it reports one). Returns one sentence each.
const family = modelFamily
// `info`: spend of today on the model the app started the desk on, when lean-agent switched that session to the pin (deskmodel.ts keeps
// the record): nothing is wrong now, so doctor shows a note, never FIX
// What the desk's own requests (not a worker's) cost on a model other than `desk`, from `since` on, per model: today's rows of the ledger tail
// (the rollup has no clock inside a day). null when the ledger cannot be read, so the caller keeps the whole day's number.
async function deskSpendSince(h: Host, home: string, since: number, desk: string, now: number): Promise<Record<string, number> | null> {
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
      if (r && r.role === 'desk' && r.agent === 'main' && r.ts >= since && dayOf(r.ts) === dayOf(now) && family(r.model) !== desk) out[r.model] = (out[r.model] ?? 0) + r.usd
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
  const def = await threadChoice(h, home, {})
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
  const afterPin = pinAt && dayOf(pinAt) === dayOf(now) ? await deskSpendSince(h, home, pinAt, desk, now) : null
  for (const [k, a] of Object.entries(rm)) {
    const [role, model = ''] = k.split('|')
    if (role === 'desk' && family(model) !== desk) {
      if (switched && family(switched.from) === family(model)) info.push(`the app started the desk on ${model}; lean-agent switched it to ${desk} (${usd(a[0])} spent on ${model} today)`)
      else if (afterPin && !((afterPin[model] ?? 0) > 0.005)) info.push(`the desk spent ${usd(a[0])} today on ${model} before lean-agent pinned ${desk} at ${hhmm(pinAt)} UTC; nothing on it since`)
      else {
        const spent = afterPin ? afterPin[model]! : a[0]
        const history = a[0] - spent // spent before the pin: not counted (said only when there is some)
        out.push(`the desk spent ${usd(spent)} ${history > 0.005 ? `on ${model} since lean-agent pinned ${desk} at ${hhmm(pinAt)} UTC (${usd(history)} before that is history)` : `today on ${model}`}, lean-agent pins ${desk}: ${deskWhy}`)
      }
    }
    if (role === 'thread' && allowed.size && !allowed.has(family(model))) out.push(`threads spent ${usd(a[0])} today on ${model}, but none was started on ${[...allowed].join('/')} only: a thread from before 1.0.2 or a model given by hand; close it and Start again`)
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
