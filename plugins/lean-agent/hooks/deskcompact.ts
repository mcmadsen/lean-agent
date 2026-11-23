// The desk's own context. A desk session lives for days: at 80% of its limit (config.json `deskTokens`, default 100000) the handover is written and
// the pane says "restart the desk soon" with the Restart desk button; at 95% of the limit the mod opens the new desk itself at the end of the turn
// (config `desk.autoRestart`, default true since 1.0.28; also for an update, a pin that cannot be applied, lost tools: autoRestartDesk). When it is idle and
// over its limit the mod also tries to compact it (`$.session.compact` with fixed instructions; the app's desk cannot, see below). Every compaction that was vetoed or failed is recorded with its
// reason (desk/compact.json, a notice, the doctor check) and tried again when the desk's turn ends. When compaction is not possible
// the mod writes desk/handover.md and the status line asks the user to type /compact or start a new desk session, which reads it.
// "Restart desk" (pane button, /lean-agent-restart-desk) writes the same handover on demand and opens a new desk session.
//
// A headless (-p / SDK) session, which is what the desk is in Claude Desktop, rejects `$.session.compact` ("not available in a headless
// (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)"). That is no failure and no retry will help: it is
// tried ONCE per session start, recorded as `unavailable` (not `failed`: no notice, the doctor shows an info row, not FIX) and from then on
// the pane and the status line say that the app cannot compact the desk automatically, with the Restart desk button next to it.
//
// Why the mod does not start a /compact itself in such a session: the engine types (plugin-authoring skill) document `$.command.run`
// ("as if the person typed /command args", queued until the session is idle), `$.prompt.submit` and `$.skill.prompt`, but none of them
// says that it works headless, and the only line about the headless case is the rejection above. A `/compact` text sent as a prompt
// would be an ordinary user message to the model, not the command, in an engine that does not run commands there. Until the engine
// documents a headless path, the user types /compact or presses Restart desk.
//
// Threads have no compaction: a thread that reports done is finished as a session (finish.ts), a thread whose recorded context is over
// `threadTokens` gets a new session at its next message (threadcontext.ts), and the pane's Restart button starts one on demand.
import { atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { listActions, standingView } from './deskactions'
import { writesView } from './deskwrites'
import { readSnapshot } from './snapshot'
import { waitingScripts } from './scripts'
import { setNotice } from './notices'
import { dismissOldDesk, recordOldDesk, titleOf } from './olddesk'
import { autoGuard, cancelAutoStart, lastAutoRun, noteAutoRun, resetAuto, retiredInfo, sayGuardOnce, writeAutoStart } from './deskauto'
import type { AutoKind } from './deskauto'
import { readDeskModel } from './deskmodel'
import type { Thread } from './threads'

export const DEFAULT_TOKENS = 100_000 // (was 200k: the desk only routes, a conversation that big is mostly old reports)
export const MIN_TOKENS = 10_000 // a smaller configured value is ignored (a compaction every few turns would be worse than none)
export const DESK_RETRY_MS = 10 * 60_000 // after a vetoed or failed compaction, when no turn end comes sooner
export const SOON_PCT = 80 // from here: the handover is written, the pane says "restart the desk soon" with the Restart desk button
export const soonAt = (limit: number): number => Math.floor((limit * SOON_PCT) / 100)
export const HANDOVER_MAX_CHARS = 12_000 // the desk handover: at most 3k tokens (characters / 4)
const SOON_MS = 30_000

// config.json `deskTokens` (default 100000). The 1.0.6 key `checkpoint.deskTokens` is still read when `deskTokens` is not set.
export async function deskTokens(h: Host): Promise<number> {
  const c: any = await readConfig(h, await homeDir(h))
  const v = c?.deskTokens ?? c?.checkpoint?.deskTokens
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_TOKENS ? Math.floor(v) : DEFAULT_TOKENS
}

export type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined
// what the request was answered over: uncached, cache-read and cache-written input together
export const contextTokens = (u: Usage): number => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0)
export const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// ---- the session's context size (main loop only) -----------------------------------------------------------------
let ctxTokens = 0
let sawUsage = false // a request of this session reported its usage (after a compaction the size is unknown until the next one)
export const noteUsage = (u: Usage): void => {
  const n = contextTokens(u)
  if (n > 0) {
    ctxTokens = n
    sawUsage = true
  }
}
export const hasUsage = (): boolean => sawUsage
export const contextSize = (): number => ctxTokens
export const forgetContext = (): void => {
  ctxTokens = 0 // after a compaction: the next request tells the new size
}

export const DESK_COMPACT_INSTRUCTIONS =
  "lean-agent desk compaction. KEEP: the user's goals; the open threads table (id, title, project, state, last report line); every unanswered thread question; the user's stated preferences and decisions of this session; pending approvals. DROP: tool outputs and old report texts (they are in the desk inbox, ~/.lean-agent/desk/inbox.jsonl)."

export type DeskDeps = {
  tokens: () => Promise<number> // the desk's current context size
  busy: () => boolean // a desk turn is running
  compact: (instructions: string) => Promise<unknown> // $.session.compact; a rejection or a missing function = not possible
  notes: () => Promise<void> // the compaction notes (the session.compact hook does not run for the plugin's own call)
  recent: () => Promise<string[]> // the user's latest messages, for the handover file
  sid?: () => string // this desk session's id: recorded in the handover, so this session's own start never consumes it
  status: (text: string) => void
  reset: () => void // forget the context size: the next request tells the new one
}
// fallback: the size the handover file was written at (0 = none); again: try at the turn's end; vetoes: in a row; episode: a failure or a
// veto is on record and not yet settled; manual: the size at which the engine said it cannot compact this (headless) session (0 = not so)
// written / limitWritten: the handover was written at 80% / at the limit (once each, until the size is below it again); limitPending: the one line
// "the desk reached its limit" is still to be said (`limitLineOnce`); auto: the mod opened the new desk itself (config desk.autoRestart)
type Desk = { retryAt: number; fallback: number; rejected: number; again: boolean; vetoes: number; episode: boolean; manual: number; written: boolean; limitWritten: boolean; limitPending: boolean; limitSaid: boolean; at: { tokens: number; limit: number }; auto: boolean }
const freshDesk = (): Desk => ({ retryAt: 0, fallback: 0, rejected: 0, again: false, vetoes: 0, episode: false, manual: 0, written: false, limitWritten: false, limitPending: false, limitSaid: false, at: { tokens: 0, limit: 0 }, auto: false })
export const MAX_VETOES = 3 // vetoes in a row before the handover file and the /compact line
let ds: Desk = freshDesk()
export const resetDeskCompact = (): void => {
  ctxTokens = 0
  sawUsage = false
  ds = freshDesk()
  resetAuto()
}
// a headless (-p / SDK) session: the engine's own text is "lean-agent: $.session.compact: not available in a headless (-p / SDK) session
// yet: compaction here runs inside a turn (a /compact prompt); ..." (the prefix and the `$.` vary with the engine)
const HEADLESS = /not available in a headless|headless \(-p|\(-p \/ SDK\) session/i
export const isHeadlessReject = (text: unknown): boolean => HEADLESS.test(String(text ?? ''))
// an engine without session.compact (a TypeError, "not available"): no retry will help
const NO_COMPACT = /not a function|no implementation|session\.compact\b[^]{0,80}not available|not available[^]{0,120}session\.compact/i
const hopeless = (e: unknown) => e instanceof TypeError || NO_COMPACT.test(String((e as Error)?.message ?? e)) || isHeadlessReject((e as Error)?.message ?? e)
// the sentences the pane and the status line carry while the mod could not compact
export const manualNote = (tokens: number): string => `desk context ${kTokens(tokens)}: the app cannot compact the desk automatically. Press Restart desk (fresh desk with the handover) or type /compact`
export const deskNote = (): string => (ds.manual ? manualNote(ds.manual) : ds.fallback ? `desk context ${kTokens(ds.fallback)}: type /compact (or start a new desk session; it reads the handover)` : '')

// a vetoed or failed compaction is tried again when the desk's turn ends (register.tsx calls deskTick then)
export const deskRetryWanted = (): boolean => ds.again
export const deskTurnEnded = (): void => {
  if (ds.again) ds.retryAt = 0
}

// ---- the record of the last compaction (desk/compact.json): the doctor shows it, a notice tells the user ----------------
// unavailable: the session cannot compact at all (headless): nothing is broken, the user acts (manualNote)
export type CompactRec = { ts: number; tokens: number; result: 'compacted' | 'vetoed' | 'failed' | 'unavailable'; reason?: string }
const recFile = (home: string) => `${deskState(home)}/compact.json`
export async function lastCompaction(h: Host): Promise<CompactRec | null> {
  const r = await readJson<CompactRec | null>(h, recFile(await homeDir(h)), null)
  if (!r || typeof r !== 'object' || typeof r.result !== 'string') return null
  return r.result === 'failed' && isHeadlessReject(r.reason) ? { ...r, result: 'unavailable' } : r // (a 1.0.8 record of the same rejection)
}
async function record(h: Host, tokens: number, result: CompactRec['result'], reason?: string): Promise<void> {
  try {
    await writeJson(h, recFile(await homeDir(h)), { ts: await h.clock.now(), tokens, result, ...(reason ? { reason: reason.slice(0, 200) } : {}) } satisfies CompactRec)
  } catch {
    /* the record is best effort */
  }
  await setNotice(h, 'desk-compaction', result === 'compacted' || result === 'unavailable' ? null : `desk compaction ${result} at ${kTokens(tokens)}: ${reason || 'no reason given'}; it is tried again when the turn ends`)
}
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 160) || 'no reason given'

// the handover once per stage (80%, the limit): script-built from the stores, so it is ready before the user needs it
async function ensureHandover(h: Host, d: DeskDeps, tokens: number, stage: 'written' | 'limitWritten'): Promise<void> {
  if (ds[stage]) return
  ds[stage] = true
  try {
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []), d.sid?.())
  } catch {
    ds[stage] = false // (tried again at the next tick)
  }
}

export async function deskTick(h: Host, d: DeskDeps): Promise<'compacted' | 'skipped' | 'fallback' | 'busy' | 'quiet' | 'soon'> {
  const limit = await deskTokens(h)
  const tokens = await d.tokens().catch(() => 0)
  ds.at = { tokens, limit }
  if (tokens < soonAt(limit)) ds.written = false
  if (tokens < limit) {
    ds.limitWritten = false
    ds.limitPending = false
    ds.limitSaid = false
    ds.retryAt = 0 // under the limit again: the next climb over it starts afresh
    if (ds.fallback || ds.manual) d.status('') // the "type /compact" line goes away with the reason for it
    if (ds.episode) await record(h, tokens, 'compacted', 'the context is below the limit again') // the notice and the doctor row go with it
    ds.fallback = 0
    ds.manual = 0
    ds.rejected = 0
    ds.vetoes = 0
    ds.again = false
    ds.episode = false
    if (tokens >= soonAt(limit)) {
      await ensureHandover(h, d, tokens, 'written') // 80%: the pane says "restart the desk soon (the handover is ready)"
      return 'soon'
    }
    return 'quiet'
  }
  // The limit. Where the session cannot be compacted (the app's desk: headless) or a compaction did not happen, the handover is written and the desk's
  // next reply starts with one line saying so (once: limitLineOnce); a compaction that works leaves nothing to say.
  const say = () => {
    if (!ds.limitSaid) ds.limitPending = true
  }
  if (ds.manual) {
    // this session cannot compact (headless): asked once, not again until a new session; the line is put back (it may have been replaced)
    ds.again = false
    await ensureHandover(h, d, tokens, 'limitWritten')
    say()
    d.status(deskNote())
    return 'fallback'
  }
  if (d.busy()) return 'busy'
  const now = await h.clock.now()
  if (now < ds.retryAt) {
    if (ds.fallback) d.status(deskNote()) // a status line may have been replaced meanwhile
    return ds.fallback ? 'fallback' : 'quiet'
  }
  ds.retryAt = now + DESK_RETRY_MS // whatever happens next, not again before this (a turn's end brings it forward)
  ds.again = false
  if (!ds.episode) await d.notes().catch(() => undefined) // (once per episode: a retry would append the same notes again)
  let res: any
  try {
    res = await d.compact(DESK_COMPACT_INSTRUCTIONS)
  } catch (err) {
    if (d.busy()) {
      ds.retryAt = now + SOON_MS // rejected because a turn started meanwhile: that is no failure, again at its end
      ds.again = true
      return 'busy'
    }
    ds.episode = true
    if (isHeadlessReject((err as Error)?.message ?? err)) {
      // nothing is broken and no retry will help: one calm state, no failure row, no notice, no handover (Restart desk writes it)
      await record(h, tokens, 'unavailable', why(err))
      ds.manual = tokens
      ds.rejected = 0
      await ensureHandover(h, d, tokens, 'limitWritten') // (the app cannot compact the desk: the handover is what is left)
      say()
      d.status(deskNote())
      return 'fallback'
    }
    await record(h, tokens, 'failed', why(err))
    // a rejection can be transient (an API error, a limit): once more at the turn's end; twice in a row, or an engine that has no
    // session.compact, is "not possible": the handover file and the status line
    if (!hopeless(err) && ++ds.rejected < 2) {
      ds.again = true
      return 'skipped'
    }
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []), d.sid?.())
    ds.limitWritten = true
    say()
    ds.fallback = tokens
    d.status(deskNote())
    return 'fallback'
  }
  ds.rejected = 0
  if (res && typeof res === 'object' && typeof res.skip === 'string') {
    ds.episode = true
    await record(h, tokens, 'vetoed', res.skip || 'a hook vetoed it')
    if (++ds.vetoes < MAX_VETOES) {
      ds.again = true // a hook vetoed it: at the turn's end
      return 'skipped'
    }
    // vetoed every time: the mod cannot compact, the user can (the notice and the doctor row keep the reason)
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []), d.sid?.())
    ds.limitWritten = true
    say()
    ds.fallback = tokens
    d.status(deskNote())
    return 'fallback'
  }
  await record(h, tokens, 'compacted')
  if (ds.fallback) d.status('')
  ds.fallback = 0
  ds.vetoes = 0
  ds.episode = false
  ds.limitPending = false // compacted: the desk is small again, nothing to say
  ds.limitWritten = false
  ds.written = false
  d.reset()
  return 'compacted'
}

// what the pane header says from 80% of the limit (view.ts): amber, with the Restart desk button next to it ('' = below 80%)
export const soonText = (tokens: number, limit: number): string => (limit > 0 && tokens >= soonAt(limit) ? `desk context ${kTokens(tokens)} of ${kTokens(limit)}: restart the desk ${tokens >= limit ? 'now' : 'soon'} (the handover is ready)` : '')

// At the limit the desk's next reply starts with ONE line saying so, once (the prompt hook adds this to the desk's context; null = nothing to say)
export const limitLineOnce = (): string | null => {
  if (!ds.limitPending) return null
  ds.limitPending = false
  ds.limitSaid = true
  const n = `${kTokens(ds.at.tokens)} of ${kTokens(ds.at.limit)}`
  return `[lean-agent] The desk context reached its limit (${n}). Start your next reply with this one line, once, then carry on: "Desk context ${n}: press Restart desk in the pane (the handover is written)."`
}

// config desk.autoRestart (default TRUE since 1.0.28; false = the Restart desk button only): at the end of a desk turn the mod opens the new desk itself
// (restartDesk: the handover is written first, the link is opened without taking the focus) for one of four reasons, in this order:
//   context  the desk's context is at 95% of its limit or over (deskTokens)
//   version  lean-agent was updated and this desk still runs the older code (skew.ts: the same comparison as the status line and the doctor)
//   model    the model pin could not be applied in two tries of this session (deskmodel.ts)
//   tools    the desk lost its tools: the mod's own send was refused with "this session has no SendMessage tool" (deliver-to-thread.ts)
// and only when: this session is the current desk (deskauto.ts retiredInfo); no turn is running (an AskUserQuestion in flight is a running turn);
// the desk is shown in the desktop app; no thread's question to the user is open (the handover carries them, so over 120% of the limit it goes on
// anyway); the loop guard allows it (last one 30+ min ago, fewer than 4 in 24 h: else ONE notice and the amber status line). Requests, approvals,
// grants and threads are in the handover (buildDeskHandover) and need no wait. Once per desk session. A failure is a notice (the Restart desk button is
// still there). A model / tools reason is not repeated for the same cause within 24 h (the new desk would have the same trouble: only the button).
export type AutoIn = {
  tokens: number
  restart: () => Promise<{ ok: boolean; text: string }>
  sid?: string // this desk session
  busy?: boolean // a desk turn is running
  inApp?: boolean // the desk is shown in the desktop app (the surface check)
  skew?: string | null // the skew sentence of this session (skew.ts skewText), when the installed lean-agent is newer
  toolsLost?: string | null // directUnavailable(): why the mod's send to threads is refused for this session
  status?: (text: string) => void // the amber line
  notify?: (text: string) => void // the toast
}
export type AutoOut = 'off' | 'none' | 'retired' | 'busy' | 'app' | 'already' | 'question' | 'guard' | 'restarted' | 'failed'
export const QUESTION_OVER_PCT = 120
export async function autoRestartDesk(h: Host, o: AutoIn): Promise<AutoOut> {
  const home = await homeDir(h)
  if (((await readConfig(h, home)) as any)?.desk?.autoRestart === false) return 'off'
  if (o.sid && (await retiredInfo(h, o.sid))) return 'retired' // a newer desk took over: this one never starts another
  const limit = await deskTokens(h)
  const now = await h.clock.now()
  const last = await lastAutoRun(h)
  const again = (kind: AutoKind, text = '') => !!last && last.kind === kind && now - last.at < 24 * 3_600_000 && (kind !== 'version' || last.text === text)
  let kind: AutoKind | null = null
  let text = ''
  if (o.tokens >= Math.floor((limit * 95) / 100)) [kind, text] = ['context', `context ${kTokens(o.tokens)}`]
  const ver = o.skew ? /code (\S+) is running but (\S+) is installed/.exec(o.skew) : null
  if (!kind && o.skew && !again('version', ver ? `lean-agent updated: running ${ver[1]}, installed ${ver[2]}` : 'lean-agent updated')) [kind, text] = ['version', ver ? `lean-agent updated: running ${ver[1]}, installed ${ver[2]}` : 'lean-agent updated']
  if (!kind && o.sid && !again('model')) {
    const m = await readDeskModel(h)
    if (m && m.session === o.sid && (m.tries ?? 0) >= 2) [kind, text] = ['model', `the model pin could not be applied (${m.tries} tries)`]
  }
  if (!kind && o.toolsLost && !again('tools')) [kind, text] = ['tools', `the desk lost its tools (${why(o.toolsLost).slice(0, 80)})`]
  if (!kind) return 'none'
  if (o.busy) return 'busy'
  if (o.inApp === false) return 'app'
  if (ds.auto) return 'already'
  if ((await openQuestions(h)).length && !(kind === 'context' && o.tokens >= Math.floor((limit * QUESTION_OVER_PCT) / 100))) return 'question' // the user is deciding something: not now (the next turn end asks again)
  const blocked = await autoGuard(h)
  if (blocked) {
    await sayGuardOnce(h, blocked, text)
    o.status?.(`desk restart needed (${text}) but not automatic: ${blocked}. Press Restart desk`)
    return 'guard'
  }
  ds.auto = true
  await writeAutoStart(h, { reason: text, kind, from: o.sid ?? '' }) // (the new desk's start finds it)
  const r = await o.restart().catch(e => ({ ok: false, text: why(e) }))
  if (!r.ok) {
    ds.auto = false
    await cancelAutoStart(h)
    await setNotice(h, 'desk-autorestart', `the desk needs a restart (${text}) and could not open a new one by itself: ${r.text}`)
    return 'failed'
  }
  await noteAutoRun(h, kind, text)
  await setNotice(h, 'desk-autorestart', null)
  o.notify?.(`desk restarted automatically: ${text}`)
  return 'restarted'
}

// the user's latest messages in the desk's conversation (not lean-agent's own relays), for the handover file; `$` is the session handle
export async function recentUser($: any): Promise<string[]> {
  const m: any = await $.session.messages({ last: 40 })
  return (Array.isArray(m) ? m : []).filter((x: any) => x?.role === 'user' && typeof x.text === 'string' && x.text.trim() && !x.text.startsWith('[lean-agent]')).slice(-6).map((x: any) => x.text as string)
}

// this session's id, '' when the engine gives none (never a made-up one: the handover names its writer by it)
export async function sessionId($: any): Promise<string> {
  const s = await $.session.id()
  return typeof s === 'string' ? s : ''
}

// ---- desk/handover.md ---------------------------------------------------------------------------------------------
const flat = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? s.replace(/\s+/g, ' ').trim().slice(0, n - 1) + '…' : s.replace(/\s+/g, ' ').trim())
const cell = (s: string, n: number) => flat(s, n).replace(/\|/g, '/')
export const handoverFile = (home: string) => `${deskState(home)}/handover.md`

// the last line of the file names the session that wrote it (serveHandover: that session's own start must not consume it)
// (anchored to the END of the file: the user's messages, titles and report texts above it may quote such a comment, and none of them counts)
const WRITER = /\n<!-- lean-agent: written-by-session ([A-Za-z0-9_-]{1,80}) -->\s*$/
const sidOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s)
// what one open thread is doing now, by script: its current task (the snapshot's), else its goal (the thread's own line)
async function doingOf(h: Host, home: string, id: string, goal: string): Promise<string> {
  const snap = await readSnapshot(h, home, id).catch(() => null)
  const task = snap?.tasks?.find(t => t.status === 'in_progress') ?? snap?.tasks?.find(t => t.status === 'pending')
  return task ? task.text : goal
}

async function buildDeskHandover(h: Host, tokens: number, recent: string[], sid: string, tight: boolean): Promise<string> {
  const w = (n: number) => (tight ? Math.floor(n / 2) : n) // a handover over its size is built again with half the widths and without the user's last words
  const home = await homeDir(h)
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  const last = new Map<string, DeskRec>()
  for (const r of recs) if (r && typeof r.from === 'string') last.set(r.from, r)
  const rows: string[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    /* no threads */
  }
  for (const e of ents.filter(x => /^t\d+$/.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.state === 'closed') continue
    const lr = last.get(t.id)
    const doing = await doingOf(h, home, t.id, goals?.[t.id]?.text ?? '')
    rows.push(`| ${t.id} | ${cell(t.title, w(50))} | ${cell(t.project || '-', 30)} | ${t.state}${t.finished ? ' (finished: the next message starts a new session)' : ''} | ${cell(doing || '-', w(100))} | ${lr ? cell(`[${lr.kind === 'ask' ? 'question' : lr.state || 'working'}] ${lr.text}`, w(120)) : '-'} |`)
  }
  const goalLines = Object.entries(goals && typeof goals === 'object' ? goals : {}).filter(([, g]) => g && typeof g.text === 'string').map(([id, g]) => `- ${id}: ${flat(g.text!, w(200))}`)
  const qs = (await openQuestions(h)).map(q => `- ${q.from ?? 'desk'}: ${flat(q.question ?? '', w(300))}`)
  // requests that wait for the user's yes (a thread asked the desk to send something), and the written grants that are still in force
  const now = await h.clock.now()
  const reqs = (await listActions(h).catch(() => [])).map(a => `- ${a.id} (${a.thread}, ${a.state}): ${flat(a.headline, w(160))}${a.writes ? ` (${a.writes} writes)` : ''}; the exact text: lean_thread action-list`)
  const grantLines = [
    ...(await writesView(h).catch(() => ({ grants: [] }))).grants.map(g => `- ${g.thread}: ${g.kinds.join('/')} on ${flat(g.scope, 80)}, ${g.used}/${g.cap} used, ${untilText(g.exp, now)}`),
    ...(await standingView(h).catch(() => ({ grants: [] }))).grants.map(g => `- ${g.thread}: status changes (${g.statuses.join('/')}) on ${flat(g.scope, 80)}, ${untilText(g.exp, now)}`),
  ]
  const waiting = (await waitingScripts(h).catch(() => [])).map(s => `- script ${s.name} (${s.project}) waits for the user's decision: ${flat(s.why, 120)}`)
  const read = (await readJson<{ n?: number }>(h, `${deskState(home)}/inbox-read.json`, {})).n || 0
  const unread = Math.max(0, recs.length - read)
  const when = new Date(await h.clock.now()).toISOString()
  const parts = [
    `# Desk handover (written ${when}, context ${tokens > 0 ? kTokens(tokens) : 'size unknown'})`,
    `This desk session replaces the previous one (restarted, or its context was too large). Read this at the start, then carry on; the full report texts are in ${deskState(home)}/inbox.jsonl (${unread} row(s) unread), earlier handoff notes in ${deskState(home)}/notes.md.`,
    `## Unanswered thread questions\n${qs.length ? qs.join('\n') : 'none'}`,
    `## Pending requests (wait for the user's yes)\n${reqs.length ? reqs.join('\n') : 'none'}`,
    `## Pending approvals\n${waiting.length ? waiting.join('\n') : 'none known to the mod (a push approval the user gave in the old chat is single use: ask again if needed)'}`,
    `## Grants in force (written approvals of the user)\n${grantLines.length ? grantLines.join('\n') : 'none'}`,
    `## Open threads (what each is doing now, and its last report)\n| id | title | project | state | doing | last report |\n|---|---|---|---|---|---|\n${rows.length ? rows.join('\n') : '| - | no open threads | | | | |'}`,
    `## Goals\n${goalLines.length ? goalLines.join('\n') : 'none set'}`,
    recent.length && !tight ? `## What the user said last (newest last; their preferences and decisions of the old session are in the old conversation)\n${recent.map(m => `- ${flat(m, 300)}`).join('\n')}` : '',
    sidOk(sid) ? `<!-- lean-agent: written-by-session ${sid} -->` : '',
  ]
  return parts.filter(Boolean).join('\n\n') + '\n'
}
const untilText = (exp: number, now: number): string => (exp > now ? `${Math.max(1, Math.round((exp - now) / 60_000))} min left` : 'expired')

// at most HANDOVER_MAX_CHARS (3k tokens): over it, built again with half the widths and without the user's last words; still over, the middle is cut
// (the writer's id stays the LAST line: serveHandover reads it there)
export async function deskHandover(h: Host, tokens: number, recent: string[], sid = ''): Promise<string> {
  let text = await buildDeskHandover(h, tokens, recent, sid, false)
  if (text.length > HANDOVER_MAX_CHARS) text = await buildDeskHandover(h, tokens, recent, sid, true)
  if (text.length <= HANDOVER_MAX_CHARS) return text
  const tail = WRITER.exec(text)?.[0] ?? '\n'
  const head = text.slice(0, text.length - tail.length)
  return `${head.slice(0, HANDOVER_MAX_CHARS - tail.length - 200).trimEnd()}\n\n(cut: the rest is in ${deskState(await homeDir(h))}/inbox.jsonl)${tail.startsWith('\n') ? tail : `\n${tail}`}`
}

// `sid`: the writing desk session. Unknown, no writer is named (desk.json may still hold an older desk's id): any desk may then serve it.
export async function writeDeskHandover(h: Host, tokens: number, recent: string[], sid = ''): Promise<void> {
  await atomicWrite(h, handoverFile(await homeDir(h)), await deskHandover(h, tokens, recent, sid))
}

// A new desk session's start serves the handover: the file is renamed to handover-read-<date>.md (the last 3 are kept), so a later desk
// never reads a stale one as if it were fresh, and the first prompt names where it is now. null = no handover waiting (or it could not be moved:
// then it stays as it was, and the desk's guide still tells it to read handover.md).
export const KEEP_READ_HANDOVERS = 3
// Only a NEW desk session consumes it: the file names the session that wrote it, and that session's own start (a resume, a compaction, a
// reload) leaves it where it is. A start whose own id is unknown cannot tell, so it leaves a named handover alone too; a handover that
// names no writer (an older file) goes to whichever desk starts.
let servedText: string | null = null
export const servedBody = (): string | null => servedText // the handover the last serveHandover moved (deskauto.ts deskStartLines lists what it holds)
export async function serveHandover(h: Host, sid = ''): Promise<string | null> {
  servedText = null
  try {
    const home = await homeDir(h)
    const from = handoverFile(home)
    if (!(await h.fs.exists(from))) return null
    const body = String(await h.fs.read(from).catch(() => ''))
    const writer = WRITER.exec(body)?.[1]
    if (writer && (!sid || writer === sid)) return null
    const date = new Date(await h.clock.now()).toISOString().slice(0, 19).replace(/:/g, '-')
    let to = `${deskState(home)}/handover-read-${date}.md`
    for (let n = 2; await h.fs.exists(to); n++) to = `${deskState(home)}/handover-read-${date}-${n}.md` // (two starts in one second)
    const written = /^# Desk handover \(written (\S+?),/.exec(body)?.[1] // (its own first line says when)
    const r = await h.process.run(['mv', from, to])
    if (r.exitCode !== 0 || (await h.fs.exists(from))) return null
    const old = (await h.fs.list(deskState(home)).catch(() => [])).filter(f => f.kind === 'file' && /^handover-read-.+\.md$/.test(f.name)).map(f => f.name.replace(/\.md$/, '')).sort().map(n => `${n}.md`) // (the date sorts as text; without the extension, `-2` after the same second sorts after it)
    const drop = old.slice(0, Math.max(0, old.length - KEEP_READ_HANDOVERS)).filter(n => `${deskState(home)}/${n}` !== to)
    if (drop.length) await h.process.run(['rm', '-f', ...drop.map(n => `${deskState(home)}/${n}`)]).catch(() => undefined)
    servedText = body
    return `a desk handover${written ? ` (written ${written})` : ''} from an earlier desk session is waiting in ${to}: read it now (goals, open threads, questions, approvals; disregard it if it is old news), then carry on`
  } catch {
    return null
  }
}

// "Restart desk": the handover is written now, then a new desk session is opened (`open` = setup.ts openDesk). The new session reads the
// handover at its start (the desk's CLAUDE.md says so); the old one stays open until the user closes it.
export const DESK_RESTARTED = 'New desk opened with the handover: close this one'
export async function restartDesk(h: Host, o: { recent: () => Promise<string[]>; open: () => Promise<{ ok: boolean; text: string }>; sid?: () => Promise<string> }): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  try {
    await writeDeskHandover(h, contextSize(), await o.recent().catch(() => []), await o.sid?.().catch(() => '') || '')
  } catch (e) {
    return { ok: false, text: `desk not restarted: the handover could not be written (${why(e)})` }
  }
  // this (old) desk's id and title go into the store BEFORE the new desk opens: its session start finds them (olddesk.ts)
  const oldSid = (await o.sid?.().catch(() => '')) || ''
  const recorded = oldSid ? await recordOldDesk(h, oldSid, await titleOf(h, oldSid)) : false
  const r = await o.open()
  if (!r.ok) {
    if (recorded) await dismissOldDesk(h, 'the new desk did not open: nothing took over').catch(() => undefined) // nothing took over: there is no old desk to archive
    return { ok: false, text: `Handover written to ${handoverFile(home)}, but no new desk was opened: ${r.text}` }
  }
  return { ok: true, text: `${DESK_RESTARTED}. The mod cannot close a desktop session: ${recorded ? 'archive it in the Claude app (right-click, Archive); the new desk reminds you until it is gone' : 'archive it in the Claude app (right-click, Archive); its session id was not known, so no reminder follows'}` }
}
