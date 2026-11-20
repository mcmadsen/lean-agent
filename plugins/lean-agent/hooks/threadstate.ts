// What a thread's session REALLY is, from `claude agents --json --all` (state: working | idle | done ..., pid) and the thread's own queue,
// and the two things that follow from it: the name check and the clean close of a superseded session (`claude rm`).
// Pure helpers and one process call; it imports only types from threads.ts (threads.ts imports this file).
import { readJson, realPath, leanDir, threadsDir, appendJsonl } from './state'
import type { Host } from './state'
import { syncRollup } from './ledger'
import type { AgentRow } from './threads'

// ---- the live word ----------------------------------------------------------------------------------------------------
// working: the process is alive and the turn is going; idle: the process may be alive but the turn ended; gone: the session
// finished or its process exited. `state` working / blocked / idle decides (the listed `status` can still say busy while the turn
// has ended: the field case); any other state falls back to the older `status`, where only idle / done words mean "no live work" and
// anything else, an unknown word included, counts as working, so an uncertain session is never replaced (a resume of a working
// session forks it).
const DONE = new Set(['done', 'completed', 'complete', 'finished', 'stopped', 'exited', 'failed', 'error', 'dead'])
export type Live = 'working' | 'idle' | 'gone'
export function liveOf(r: AgentRow | undefined): Live {
  if (!r) return 'gone'
  if (r.state === 'working' || r.state === 'blocked') return 'working'
  if (r.state === 'idle') return 'idle' // (the field case: the listed status still said busy while the turn had ended)
  if (r.status === 'idle') return 'idle'
  if (DONE.has(r.status)) return 'gone'
  return 'working'
}

// ---- config.json: threads.stuckMinutes (default 10), threads.removeOld (default true) ---------------------------------------
export const STUCK_MINUTES = 10
export type ThreadsConfig = { stuckMinutes: number; removeOld: boolean }
export async function threadsConfig(h: Host, home: string): Promise<ThreadsConfig> {
  const cfg = await readJson<{ threads?: { stuckMinutes?: unknown; removeOld?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  const m = Number(cfg?.threads?.stuckMinutes)
  return { stuckMinutes: Number.isFinite(m) && m > 0 ? m : STUCK_MINUTES, removeOld: cfg?.threads?.removeOld !== false }
}

// ---- running | idle | stuck | done | parked -----------------------------------------------------------------------------
// stuck: the oldest unread queued message is older than stuckMinutes. A working session reads its queue at every tool call (delivery.ts
// takeBatch), so a message that stays unread that long means no tool call and no inbox read; an idle session never reads it.
// A session that waits on a prompt for the user (waitingFor / blocked) is the user's to answer, never "stuck".
export type Word = 'running' | 'idle' | 'stuck' | 'done' | 'parked'
export type Truth = { word: Word; unread: number; oldestMs: number; text: string }
export function truthOf(o: { threadState: string; finished?: boolean; row: AgentRow | undefined; queued: { ts: number }[]; now: number; stuckMinutes?: number }): Truth {
  const unread = o.queued.length
  const oldestMs = unread ? Math.max(0, o.now - Math.min(...o.queued.map(m => Number(m.ts) || o.now))) : 0
  const limit = (o.stuckMinutes ?? STUCK_MINUTES) * 60_000
  const live = liveOf(o.row)
  const waits = !!o.row && (!!o.row.waitingFor || o.row.state === 'blocked')
  let word: Word
  if (o.threadState === 'parked') word = 'parked'
  else if (o.finished || o.threadState === 'closed' || live === 'gone') word = 'done'
  else if (waits) word = 'running'
  else if (unread && oldestMs >= limit) word = 'stuck'
  else word = live === 'working' ? 'running' : 'idle'
  const min = Math.max(1, Math.round(oldestMs / 60_000))
  const text =
    word === 'idle' ? `idle${unread ? `, ${unread} unread queued` : ''}`
    : word === 'stuck' ? `stuck: ${unread} unread queued for ${min} min, no tool call or inbox read`
    : word
  return { word, unread, oldestMs, text }
}

// what to do about a stuck session: wake replaces one whose turn ended; one that still works is replaced only by restart
export const stuckAdvice = (r: AgentRow | undefined): string => (liveOf(r) === 'working' ? 'it still works: restart replaces it (its current step is lost)' : 'wake or restart it')

// A [working] report is only true while the session works: a working report of a session that is not running is stale
export const staleWorking = (lastState: string | undefined, word: Word): boolean => (lastState === undefined || lastState === '' || lastState === 'working') && (word === 'idle' || word === 'done' || word === 'stuck')

// ---- a start or wake whose session ended its turn at once ------------------------------------------------------------------
export const ENDED_AT_ONCE = 'started, but it ended its turn at once: wake it with the task'
// requests the thread's sessions made in all (the ledger's per-thread request count): a turn with no tool call is ONE request, one tool
// call makes two. null = the ledger could not be read (no claim is made then).
const TTL = 20_000
let reqCache: { at: number; by: Map<string, number> } | null = null
export const resetRequestCache = () => {
  reqCache = null
}
export async function requestsOf(h: Host, id: string, now: number): Promise<number | null> {
  try {
    if (!reqCache || now < reqCache.at || now - reqCache.at >= TTL) {
      const ro = await syncRollup(h, now)
      const by = new Map<string, number>()
      for (const d of Object.values(ro.days)) for (const [k, a] of Object.entries(d.tN ?? {})) by.set(k, (by.get(k) ?? 0) + (a?.[5] ?? 0))
      reqCache = { at: now, by }
    }
    return reqCache.by.get(id) ?? 0
  } catch {
    return null
  }
}
// evidence that the session made no tool call since it was STARTED (req0 is written by a start only: a wake never resets it, so a
// status ping answered with one report is not flagged): one request in the ledger and no report of its own in the desk inbox
export const endedAtOnce = (o: { word: Word; req0?: number; req?: number | null; reportsSince: number }): boolean =>
  (o.word === 'idle' || o.word === 'done') && typeof o.req0 === 'number' && typeof o.req === 'number' && o.req - o.req0 <= 1 && o.reportsSince === 0

// ---- the session's name ------------------------------------------------------------------------------------------------------
// "tN · title" for the first session, "tN · title (2)", "(3)" after each replacement
export const sessionName = (id: string, title: string, gen: number) => `${id} · ${title}${gen > 1 ? ` (${gen})` : ''}`
// Claude Code 2.1 can name a background session only at its start (`claude --bg -n`, `claude --bg --resume <id>` takes no flag): no
// command or flag renames a running or stopped one, so a mismatch is reported and left (the doctor row says it)
export const RENAME_NOTE = "Claude Code has no command to rename a background session (-n works only when a session starts), so lean-agent leaves the name; a restart starts a session with the right one"
// null: the row has no name or is not listed (nothing can be said); '' : the name is right; else what the app lists
export function nameProblem(row: AgentRow | undefined, want: string): string | null {
  if (!row || !row.name) return null
  return row.name === want ? '' : row.name
}

// ---- close a superseded session (claude rm) -------------------------------------------------------------------------------
// `claude rm <id>` takes the session out of the app's list and keeps its conversation. It also deletes a worktree the session was started
// in, so only a session that lives in the thread's own folder is removed, and NEVER with --discard-unpushed or --force-remove-worktree:
// a refusal ("not safe") is logged and left. Never a session that works, never the thread's current one.
// does the listed `cwd` belong to the thread's own folder (the listing may print the real path of a linked home)?
export async function inThreadFolder(h: Host, home: string, id: string, cwd: string): Promise<boolean> {
  const own = `${threadsDir(home)}/${id}`
  return !!cwd && (cwd === own || (await realPath(h, cwd)) === (await realPath(h, own)))
}
export type RemoveOut = { removed: boolean; skipped?: string; refused?: string }
export async function removeSession(h: Host, home: string, o: { id: string; sid: string; current: string; row: AgentRow | undefined; log?: boolean }): Promise<RemoveOut> {
  const { row } = o
  if (!row) return { removed: false, skipped: 'not in the session list' }
  if (!o.sid || o.sid === o.current) return { removed: false, skipped: 'it is the thread\'s current session' }
  if (liveOf(row) === 'working' || row.pid > 0) return { removed: false, skipped: 'its process is still alive' }
  const own = `${threadsDir(home)}/${o.id}`
  if (!(await inThreadFolder(h, home, o.id, row.cwd))) return { removed: false, skipped: `it runs outside the thread folder (${row.cwd || 'unknown'})` }
  const argv = ['claude', 'rm', row.id || o.sid.slice(0, 8)] // no flag, ever
  const r = await h.process.run(argv).catch(() => null)
  if (r && r.exitCode === 0) {
    if (o.log) await appendJsonl(h, `${own}/history.jsonl`, { ts: await h.clock.now(), kind: 'rm-old', ok: true, sid: o.sid }).catch(() => undefined)
    return { removed: true }
  }
  const why = r ? (r.stderr || r.stdout).trim().replace(/\s+/g, ' ').slice(0, 160) || `exit ${r.exitCode}` : 'claude rm did not run'
  await appendJsonl(h, `${own}/history.jsonl`, { ts: await h.clock.now(), kind: 'rm-old', ok: false, sid: o.sid, why }).catch(() => undefined)
  return { removed: false, refused: why }
}
