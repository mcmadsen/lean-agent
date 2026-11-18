// Checkpoints (1.0.8): a session over ~100k tokens of context checkpoints and continues fresh instead of paying for the whole
// context at every request (the engine's own auto-compact comes very late on a 1M window).
//
// THREAD: the mod watches the main loop's context size (input + cache read + cache write of the latest request). Over the
// threshold it injects ONE instruction at a tool boundary; the thread answers with `lean_report` state `checkpoint`; at the end of
// that turn (never while a subagent or a push runs) the mod writes `threads/tN/checkpoint.json` phase `ready`. A thread that does
// not report after the instruction gets one reminder turn, then is checkpointed anyway from the reports it has. The DESK's 10 s
// tick executes a ready checkpoint (threads.ts action `checkpoint`: a fresh `claude --bg` session with the handover built by
// handover.ts, the old session stopped): the desk is the reliable side, a thread cannot stop itself after starting a new one.
//
// DESK: when idle and over its own threshold it compacts itself (`$.session.compact` with fixed instructions); when that is not
// possible it writes desk/handover.md and asks the user to start a new desk session.
import { atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { waitingScripts } from './scripts'
import { setNotice } from './notices'
import type { Thread } from './threads'

export const DEFAULT_TOKENS = 100_000
export const MIN_TOKENS = 10_000 // a smaller configured value is ignored (a checkpoint every few turns would be worse than none)
export const GAP_MS = 20 * 60_000 // at most one checkpoint per thread in this time
export const DESK_RETRY_MS = 10 * 60_000 // after a vetoed or failed desk compaction
export const TRY_GAP_MS = 60_000 // a failed fresh start of a checkpoint is tried again after this
export const MAX_TRIES = 5
export const MAX_AGE_MS = 30 * 60_000 // a ready request the desk could not take in this time is dropped

export type CheckpointCfg = { enabled: boolean; threadTokens: number; deskTokens: number }
const tokensOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= MIN_TOKENS ? Math.floor(v) : DEFAULT_TOKENS)

// config.json `checkpoint: { enabled (default true), threadTokens (default 100000), deskTokens (default 100000) }`
export async function checkpointConfig(h: Host): Promise<CheckpointCfg> {
  const c: any = (await readConfig(h, await homeDir(h)))?.checkpoint
  const o = c && typeof c === 'object' ? c : {}
  return { enabled: o.enabled !== false, threadTokens: tokensOf(o.threadTokens), deskTokens: tokensOf(o.deskTokens) }
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

// ---- the thread's request file -----------------------------------------------------------------------------------
export type Request = { phase: 'asked' | 'reported' | 'ready' | 'done' | 'failed'; ts: number; source?: 'report' | 'fallback'; tokens?: number; sid?: string; tries?: number; lastTry?: number; n?: number }
const reqFile = (home: string, id: string) => `${threadsDir(home)}/${id}/checkpoint.json`
export async function readRequest(h: Host, home: string, id: string): Promise<Request | null> {
  const r = await readJson<Request | null>(h, reqFile(home, id), null)
  return r && typeof r === 'object' && typeof r.phase === 'string' ? r : null
}
export const writeRequest = (h: Host, home: string, id: string, r: Request) => writeJson(h, reqFile(home, id), r)

export const askText = (threshold: number) =>
  `[lean-agent] Context is over ${kTokens(threshold)}: finish the current step, then call lean_report with state 'checkpoint' (branch, worktree, last commit, pushed?, done, open items, next step) and stop.`
export const REMIND_TEXT = `[lean-agent] Checkpoint: call lean_report now with state 'checkpoint' (branch, worktree, last commit, pushed?, done, open items, next step) and stop. The desk continues this thread in a fresh session from that report.`
export const REPORTED_TEXT = 'checkpoint recorded: the desk starts a fresh session for this thread from it. End your turn now with one short line and start no new work.'

// ---- thread side: what the mod watches ---------------------------------------------------------------------------
export type Watch = { asked: boolean; reported: boolean; reminded: boolean; ready: boolean; started: boolean; agents: number; pushes: number }
const fresh = (): Watch => ({ asked: false, reported: false, reminded: false, ready: false, started: false, agents: 0, pushes: 0 })
let w: Watch = fresh()
export const watch = (): Watch => w
export const resetCheckpoints = (): void => {
  w = fresh()
  ctxTokens = 0
  sawUsage = false
  sweeping = false
  ds = freshDesk()
}
const busy = () => w.agents > 0 || w.pushes > 0

// a main-loop call that runs a subagent or a push: the instruction never comes while one is running
export const isPush = (command: unknown) => typeof command === 'string' && /\bgit\b[^\n|;&]*\bpush\b/.test(command)
export function enter(kind: 'agent' | 'push'): () => void {
  if (kind === 'agent') w.agents++
  else w.pushes++
  let left = false
  return () => {
    if (left) return
    left = true
    if (kind === 'agent') w.agents = Math.max(0, w.agents - 1)
    else w.pushes = Math.max(0, w.pushes - 1)
  }
}

// null = a checkpoint may go ahead; else why not (disabled, thread not open, one was made less than GAP_MS ago)
export async function blocked(h: Host, id: string): Promise<string | null> {
  const cfg = await checkpointConfig(h)
  if (!cfg.enabled) return 'checkpoints are off (config.json checkpoint.enabled)'
  const t = await readJson<Thread | null>(h, `${threadsDir(await homeDir(h))}/${id}/thread.json`, null)
  if (!t || t.state !== 'open') return `thread ${id} is not open`
  const now = await h.clock.now()
  if (t.lastCheckpoint && now - t.lastCheckpoint < GAP_MS) return 'the last checkpoint is less than 20 minutes old'
  return null
}

// At a tool boundary of the main loop: the ONE instruction, or null. Never twice per session, never while a subagent or a push runs.
// `idle` (asked last, only when everything else says yes): false while the engine still lists a running subagent.
export async function takeAsk(h: Host, id: string, idle?: () => Promise<boolean>): Promise<string | null> {
  if (w.asked || w.reported || w.ready || busy() || ctxTokens < MIN_TOKENS) return null // (cheap checks first: this runs at every tool call)
  const cfg = await checkpointConfig(h)
  if (!cfg.enabled || ctxTokens < cfg.threadTokens) return null
  if (await blocked(h, id)) return null
  if (idle && !(await idle().catch(() => false))) return null
  w.asked = true
  await writeRequest(h, await homeDir(h), id, { phase: 'asked', ts: await h.clock.now(), tokens: ctxTokens })
  return askText(cfg.threadTokens)
}

// The thread called lean_report with state checkpoint. Returns the sentence for the tool result.
export async function noteReported(h: Host, id: string): Promise<string> {
  // a thread that was never asked (nothing in this process said the context is large) cannot start its own restart by reporting the state
  if (!w.asked) return 'recorded as a progress report (no checkpoint was asked for); carry on'
  const why = await blocked(h, id)
  if (why) return `recorded as a progress report (no fresh session: ${why}); carry on`
  w.reported = true
  await writeRequest(h, await homeDir(h), id, { phase: 'reported', ts: await h.clock.now(), tokens: ctxTokens })
  return REPORTED_TEXT
}

async function markReady(h: Host, id: string, source: 'report' | 'fallback', sid: string): Promise<void> {
  w.ready = true
  await writeRequest(h, await homeDir(h), id, { phase: 'ready', ts: await h.clock.now(), source, tokens: ctxTokens, sid })
}

// A new main turn started in a session whose checkpoint was ready but not yet taken (the user typed in the app, a wake, a resume):
// the report predates that work, so the request is withdrawn and the thread is asked again at a later boundary.
export async function turnStarted(h: Host, id: string): Promise<void> {
  if (!w.ready) {
    // the first turn of a process that was resumed outside the desk's wake (the app): a ready file of an earlier process is stale too
    if (w.started) return
    w.started = true
    const home = await homeDir(h)
    const old = await readRequest(h, home, id)
    if (old?.phase === 'ready') await writeRequest(h, home, id, { ...old, phase: 'done' })
    return
  }
  w.started = true
  w.ready = false
  w.asked = false
  w.reported = false
  w.reminded = false
  const home = await homeDir(h)
  const rq = await readRequest(h, home, id)
  if (rq?.phase === 'ready') await writeRequest(h, home, id, { ...rq, phase: 'done' })
}

// A request older than the thread's last wake predates work that session did since: it is stale
export const staleRequest = (rq: Request, t: Thread): boolean => rq.ts < (t.lastWake || 0)

// A main turn ended (`aborted` and `error` do not count). Returns what happened: 'ready' (the desk may start the fresh session),
// 'reminded' (one more turn was started), null.
export async function turnEnded(h: Host, id: string, o: { reason?: string; sid: string; submit?: (text: string) => Promise<unknown>; idle?: () => Promise<boolean> }): Promise<'ready' | 'reminded' | null> {
  if (o.reason === 'aborted' || o.reason === 'error') return null
  if ((!w.asked && !w.reported) || w.ready || busy()) return null
  if (await blocked(h, id)) return null
  if (o.idle && !(await o.idle().catch(() => false))) return null
  if (w.reported) {
    await markReady(h, id, 'report', o.sid)
    return 'ready'
  }
  // asked, never reported. A thread whose last report is done has finished its work: no reminder, no fresh session for it.
  const home = await homeDir(h)
  const mine = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r && r.from === id)
  const askedAt = (await readRequest(h, home, id))?.ts ?? 0
  const lastRep = mine[mine.length - 1]
  if (lastRep?.state === 'done' && lastRep.ts > askedAt) return null // (a done report from before the ask was followed by more work)
  // one reminder turn, then a checkpoint from the reports the thread has already written
  if (!w.reminded && o.submit) {
    w.reminded = true
    try {
      await o.submit(REMIND_TEXT)
      return 'reminded'
    } catch {
      /* no second turn can be started: checkpoint now */
    }
  }
  await markReady(h, id, 'fallback', o.sid)
  return 'ready'
}

// ---- desk side: the 10 s tick -------------------------------------------------------------------------------------
// Threads whose request is ready, oldest id first; `run` is leanThread's `checkpoint` action. A start that failed is tried again
// after TRY_GAP_MS and given up after MAX_TRIES (a notice says so).
let sweeping = false // the desk's ticks overlap when a start is slow (a stop waits up to 8 s): one sweep at a time
export async function sweepCheckpoints(h: Host, run: (id: string) => Promise<{ ok: boolean; text: string } | unknown>): Promise<string[]> {
  if (sweeping) return []
  sweeping = true
  try {
    return await sweepAll(h, run)
  } finally {
    sweeping = false
  }
}
async function sweepAll(h: Host, run: (id: string) => Promise<{ ok: boolean; text: string } | unknown>): Promise<string[]> {
  const home = await homeDir(h)
  const did: string[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    return did
  }
  const now = await h.clock.now()
  for (const e of ents.filter(x => /^t\d+$/.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid) continue
    const rq = await readRequest(h, home, e.name)
    if (rq?.phase !== 'ready') continue
    // stale: the session worked on since, or the desk could not take it for MAX_AGE_MS (a row that never goes idle)
    if (staleRequest(rq, t) || now - rq.ts > MAX_AGE_MS) {
      await writeRequest(h, home, e.name, { ...rq, phase: 'done' })
      continue
    }
    if ((rq.tries ?? 0) >= MAX_TRIES) {
      await writeRequest(h, home, e.name, { ...rq, phase: 'failed' })
      await setNotice(h, `checkpoint-${e.name}`, `${e.name}: the checkpoint could not start a fresh session after ${MAX_TRIES} tries; start it with reopen or resume`)
      continue
    }
    if (rq.lastTry && now - rq.lastTry < TRY_GAP_MS) continue
    did.push(e.name)
    await run(e.name)
  }
  return did
}

// ---- desk side: its own context ----------------------------------------------------------------------------------
export const DESK_COMPACT_INSTRUCTIONS =
  "lean-agent desk compaction. KEEP: the user's goals; the open threads table (id, title, project, state, last report line); every unanswered thread question; the user's stated preferences and decisions of this session; pending approvals. DROP: tool outputs and old report texts (they are in the desk inbox, ~/.lean-agent/desk/inbox.jsonl)."

export type DeskDeps = {
  tokens: () => Promise<number> // the desk's current context size
  busy: () => boolean // a desk turn is running
  compact: (instructions: string) => Promise<unknown> // $.session.compact; a rejection or a missing function = not possible
  notes: () => Promise<void> // the compaction notes (the session.compact hook does not run for the plugin's own call)
  recent: () => Promise<string[]> // the user's latest messages, for the handover file
  status: (text: string) => void
  reset: () => void // forget the context size: the next request tells the new one
}
type Desk = { retryAt: number; fallback: number; rejected: number } // fallback: the context size the handover file was written at (0 = none)
const freshDesk = (): Desk => ({ retryAt: 0, fallback: 0, rejected: 0 })
// an engine without session.compact (a TypeError, "not available"): no retry will help
const hopeless = (e: unknown) => e instanceof TypeError || /not a function|session\.compact is not available|no implementation/i.test(String((e as Error)?.message ?? e))
let ds: Desk = freshDesk()
// the sentence the pane footer and the status line carry while only the handover file is possible
export const deskNote = (): string => (ds.fallback ? `desk context ${kTokens(ds.fallback)}: start a new desk session (it reads the handover)` : '')

export async function deskTick(h: Host, d: DeskDeps): Promise<'compacted' | 'skipped' | 'fallback' | 'busy' | 'quiet'> {
  const cfg = await checkpointConfig(h)
  const tokens = cfg.enabled ? await d.tokens().catch(() => 0) : 0
  if (!cfg.enabled || tokens < cfg.deskTokens) {
    if (ds.fallback) d.status('') // the "start a new desk session" line goes away with the reason for it
    ds.fallback = 0
    ds.rejected = 0
    return 'quiet'
  }
  if (d.busy()) return 'busy'
  const now = await h.clock.now()
  if (now < ds.retryAt) {
    if (ds.fallback) d.status(deskNote()) // a status line may have been replaced meanwhile
    return ds.fallback ? 'fallback' : 'quiet'
  }
  ds.retryAt = now + DESK_RETRY_MS // whatever happens next, not again before this
  await d.notes().catch(() => undefined)
  let res: any
  try {
    res = await d.compact(DESK_COMPACT_INSTRUCTIONS)
  } catch (err) {
    if (d.busy()) {
      ds.retryAt = now + 30_000 // rejected because a turn started meanwhile: try again soon
      return 'busy'
    }
    // a rejection can be transient (a turn that just started, an API error, a limit): once more soon; twice in a row, or an engine
    // that has no session.compact, is "not possible": the handover file
    if (!hopeless(err) && ++ds.rejected < 2) {
      ds.retryAt = now + 30_000
      return 'skipped'
    }
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []))
    ds.fallback = tokens
    d.status(deskNote())
    return 'fallback'
  }
  ds.rejected = 0
  if (res && typeof res === 'object' && typeof res.skip === 'string') return 'skipped' // a hook vetoed it: later
  if (ds.fallback) d.status('')
  ds.fallback = 0
  d.reset()
  return 'compacted'
}

// ---- desk/handover.md ---------------------------------------------------------------------------------------------
const flat = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? s.replace(/\s+/g, ' ').trim().slice(0, n - 1) + '…' : s.replace(/\s+/g, ' ').trim())
const cell = (s: string, n: number) => flat(s, n).replace(/\|/g, '/')

export async function deskHandover(h: Host, tokens: number, recent: string[]): Promise<string> {
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
    rows.push(`| ${t.id} | ${cell(t.title, 50)} | ${cell(t.project || '-', 30)} | ${t.state}${t.checkpoints ? ` (checkpoint ${t.checkpoints})` : ''} | ${lr ? cell(`[${lr.kind === 'ask' ? 'question' : lr.state || 'working'}] ${lr.text}`, 120) : '-'} |`)
  }
  const goalLines = Object.entries(goals && typeof goals === 'object' ? goals : {}).filter(([, g]) => g && typeof g.text === 'string').map(([id, g]) => `- ${id}: ${flat(g.text!, 200)}`)
  const qs = (await openQuestions(h)).map(q => `- ${q.from ?? 'desk'}: ${flat(q.question ?? '', 300)}`)
  const waiting = (await waitingScripts(h).catch(() => [])).map(s => `- script ${s.name} (${s.project}) waits for the user's decision: ${flat(s.why, 120)}`)
  const read = (await readJson<{ n?: number }>(h, `${deskState(home)}/inbox-read.json`, {})).n || 0
  const unread = Math.max(0, recs.length - read)
  const when = new Date(await h.clock.now()).toISOString()
  const parts = [
    `# Desk handover (written ${when}, context ${kTokens(tokens)})`,
    `The previous desk session's context grew too large to compact. Read this at the start, then carry on; the full report texts are in ${deskState(home)}/inbox.jsonl (${unread} row(s) unread), earlier handoff notes in ${deskState(home)}/notes.md.`,
    `## Goals\n${goalLines.length ? goalLines.join('\n') : 'none set'}`,
    `## Open threads\n| id | title | project | state | last report |\n|---|---|---|---|---|\n${rows.length ? rows.join('\n') : '| - | no open threads | | | |'}`,
    `## Unanswered thread questions\n${qs.length ? qs.join('\n') : 'none'}`,
    `## Pending approvals\n${waiting.length ? waiting.join('\n') : 'none known to the mod (a push approval the user gave in the old chat is single use: ask again if needed)'}`,
    recent.length ? `## What the user said last (newest last; their preferences and decisions of the old session are in the old conversation)\n${recent.map(m => `- ${flat(m, 300)}`).join('\n')}` : '',
  ]
  return parts.filter(Boolean).join('\n\n') + '\n'
}

export async function writeDeskHandover(h: Host, tokens: number, recent: string[]): Promise<void> {
  await atomicWrite(h, `${deskState(await homeDir(h))}/handover.md`, await deskHandover(h, tokens, recent))
}
