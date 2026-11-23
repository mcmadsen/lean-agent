// Automatic restart at the context limit (user: always automatic, by script, no model turn).
// Thread side (hardStop, from threadTurnEnd at the end of every main turn and from the tool.call check every 10 calls, register.tsx): at or over
// `threadTokens` the thread is STOPPED (contextstop.ts: every tool call but lean_report is refused), the state snapshot is written (snapshot.ts)
// and, once per session, a MOD-authored record goes to the desk inbox ("context 123k over the limit 120k: state saved, restart me"); with work
// left <thread>/autorestart.json marks it for the desk; a thread that was WAITING (blocked, a question) is marked and restarted too, with a prompt
// that names the open question; only a thread that reported done is not restarted (1.0.22).
// Desk side (autoRestartTick, the desk mod's timer): the thread is restarted by script (leanThread auto-restart: a fresh session with the
// handover, the snapshot and the pending worker results, the old one removed) as soon as its session is idle (IDLE_MS after the record) or,
// whatever the session shows (then with force: the session is stopped exactly like the manual restart), `threads.stopGraceMinutes` (default 3) after it;
// a failed restart is retried at the next tick (5 tries, then one notice with the reason that offers `restart`); the tick returns the notice text.
// Guards: one automatic restart per thread per 10 minutes, a fresh session that starts over the limit stops and asks the user, only while the
// desk runs (its timer), config threads.autoRestart (default true). The hard stop itself does not depend on any of these.
import { appendJsonl, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import { setNotice } from './notices'
import { logRefusal } from './feedback'
import type { DeskRec } from './delivery'
import { buildSnapshot, takeEdited, writeSnapshot } from './snapshot'
import { kTokens, readContext, recordContext, threadLimits } from './threadcontext'
import { readStop, stopRecordText, writeStop } from './contextstop'
import { holdSilentEnd } from './waitrestart'
import { isWorking } from './threads'
import type { AgentRow, Out, Thread } from './threads'

export const IDLE_MS = 20_000 // the session must have ended its turn this long ago
export const MIN_GAP_MS = 10 * 60_000 // one automatic restart per thread per 10 minutes
export const DEFAULT_GRACE_MIN = 3 // threads.stopGraceMinutes: after the stop record the thread is restarted even if its session still shows as working
const NEWER_TURN_MS = 10_000 // a context record this much newer than the checkpoint is a later turn
export const MAX_TRIES = 5 // a failed automatic restart is retried at the next timer tick; after this many tries ONE desk notice

export type Marker = {
  pending?: { ts: number; sid: string; tokens: number; limit: number; tries?: number; lastTry?: number }
  last?: { at: number; oldSid: string; newSid?: string } // the last automatic restart (newSid: the session it started, set at its first turn end)
  stopped?: boolean // a fresh session started over the limit: no more automatic restarts until the size is under the limit again
}
export const markerFile = (home: string, id: string) => `${threadsDir(home)}/${id}/autorestart.json`
const readMarker = async (h: Host, home: string, id: string): Promise<Marker> => {
  const m = await readJson<Marker | null>(h, markerFile(home, id), null)
  return m && typeof m === 'object' ? m : {}
}

// config threads.autoRestart (default true)
export async function autoRestartOn(h: Host, home: string): Promise<boolean> {
  const cfg = await readJson<{ threads?: { autoRestart?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  return cfg?.threads?.autoRestart !== false
}

// config threads.stopGraceMinutes (default 3): ms after the stop record at which a still-working session is restarted anyway (every tool call of it is refused by then)
export async function stopGraceMs(h: Host, home: string): Promise<number> {
  const cfg = await readJson<{ threads?: { stopGraceMinutes?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  const m = cfg?.threads?.stopGraceMinutes
  return (typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : DEFAULT_GRACE_MIN) * 60_000
}

// Work is left unless the turn that just ended reported done or blocked, or ended with a question. `since`: when the turn started.
export function workLeft(recs: DeskRec[], id: string, since: number): boolean {
  const mine = recs.filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as any).mod && r.ts >= since)
  const last = mine[mine.length - 1]
  return !last || (last.kind !== 'ask' && last.state !== 'done' && last.state !== 'blocked' && last.state !== 'waiting')
}

// How the turn that just ended left the thread (1.0.22): 'done' (finished: its next message starts a fresh session), 'waiting' (its last report was
// blocked or a question: it waits for an answer or an approval) or 'work' (anything else). A stopped thread is restarted for 'work' and 'waiting' alike.
export function turnState(recs: DeskRec[], id: string, since: number): 'work' | 'waiting' | 'done' {
  const mine = recs.filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as any).mod && r.ts >= since)
  const last = mine[mine.length - 1]
  if (!last) return 'work'
  if (last.kind === 'ask' || last.state === 'blocked' || last.state === 'waiting') return 'waiting' // (`waiting`: the restarted thread's own report, 1.0.28)
  return last.state === 'done' ? 'done' : 'work'
}

export type TurnEnd ={ sid: string; tokens: number | null; since: number; tasks?: unknown }
export type TurnOut = { snapshot: boolean; action: 'none' | 'checkpoint' | 'ask'; stop?: { tokens: number; limit: number } | null } // stop: the hard stop applies (null: under the limit)

const firstOf = (mk: Marker, sid: string) => !!(mk.last && sid && sid !== mk.last.oldSid && !mk.last.newSid) // the first turn of the session an automatic restart started

// The hard stop (1.0.19, contextstop.ts): the context is at or over the limit. The snapshot, then ONE record to the desk per session (a second
// call for the same session writes nothing); a thread with work left is also marked for the desk's restart. Never throws.
export async function hardStop(h: Host, id: string, o0: { sid: string; tokens: number; limit: number; since: number; tasks?: unknown }): Promise<TurnOut['action']> {
  try {
    const home = await homeDir(h)
    const o = o0.sid ? o0 : { ...o0, sid: (await readJson<{ sid?: string } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null))?.sid ?? '' } // no session id from the engine: the thread's recorded one
    const prev = await readStop(h, home, id, o.sid)
    if (prev) return 'none'
    const inbox = `${deskState(home)}/inbox.jsonl`
    const now = await h.clock.now()
    let mk = await readMarker(h, home, id)
    const first = firstOf(mk, o.sid)
    if (first) mk = { ...mk, last: { ...mk.last!, newSid: o.sid } }
    const recs = await readJsonl<DeskRec>(h, inbox)
    const st = turnState(recs, id, o.since)
    await writeSnapshot(h, home, await buildSnapshot(h, home, id, { sid: o.sid, tokens: o.tokens, edited: takeEdited(), tasks: o.tasks }))
    await writeStop(h, home, id, { sid: o.sid, at: now, tokens: o.tokens, limit: o.limit, notices: 0, pending: [], ...(st === 'waiting' ? { waiting: true } : {}) })
    // a fresh session that starts over the limit: restarting again would loop; the user decides
    if (first) {
      await appendJsonl(h, inbox, { ts: now, from: id, kind: 'ask', mod: true, text: `${id} was restarted at the context limit, but the new session is again over it (${kTokens(o.tokens)} over ${kTokens(o.limit)}): the handover plus the work do not fit. No more automatic restarts for ${id} until it is under the limit. Raise threadTokens, trim notes.md, or split the task?`, options: ['raise threadTokens', 'trim notes.md and restart', 'split the task'] } satisfies Record<string, unknown>)
      await writeJson(h, markerFile(home, id), { ...mk, stopped: true })
      await logRefusal(h, { role: 'thread', rule: 'auto-restart-loop', text: `automatic restart stopped: the new session is again over the context limit (${kTokens(o.tokens)} over ${kTokens(o.limit)})`, thread: id })
      return 'ask'
    }
    if (st === 'done') return 'none' // done: stopped, but the next message starts the fresh session (wake)
    // work left: the one record to the desk. Waiting (blocked / a question): none, the open question or request stays as it is at the desk; the restart still happens
    if (st === 'work') await appendJsonl(h, inbox, { ts: now, from: id, kind: 'report', state: 'checkpoint', mod: true, text: stopRecordText(o.tokens, o.limit), restart: { tokens: o.tokens, limit: o.limit, sid: o.sid } })
    if (!mk.stopped && (await autoRestartOn(h, home))) await writeJson(h, markerFile(home, id), { ...mk, pending: { ts: now, sid: o.sid, tokens: o.tokens, limit: o.limit } } satisfies Marker)
    return st === 'work' ? 'checkpoint' : 'none'
  } catch {
    return 'none'
  }
}

// The thread's own mod, at the end of a main-thread turn. Never throws.
export async function threadTurnEnd(h: Host, id: string, o: TurnEnd): Promise<TurnOut> {
  const out: TurnOut = { snapshot: false, action: 'none' }
  try {
    const home = await homeDir(h)
    await holdSilentEnd(h, home, id).catch(() => false) // a restarted thread that ends its turn without its `waiting` report: the mod writes it (waitrestart.ts)
    const stopped = o.sid ? await readStop(h, home, id, o.sid) : null
    out.snapshot = await writeSnapshot(h, home, await buildSnapshot(h, home, id, { sid: o.sid, tokens: o.tokens, edited: takeEdited(), tasks: o.tasks, pending: stopped?.pending }))
    if (o.tokens === null) return out
    await recordContext(h, id, o.sid, o.tokens, { sample: true }) // one history sample per turn end (the pane's growth per turn)
    const limit = (await threadLimits(h)).limit
    const mk = await readMarker(h, home, id)
    if (o.tokens < limit) {
      const first = firstOf(mk, o.sid) // the first turn end of the session an automatic restart started
      if (first || mk.stopped) await writeJson(h, markerFile(home, id), { ...mk, ...(first ? { last: { ...mk.last!, newSid: o.sid } } : {}), ...(mk.stopped ? { stopped: false } : {}) })
      out.stop = null
      return out
    }
    out.stop = { tokens: o.tokens, limit }
    out.action = await hardStop(h, id, { sid: o.sid, tokens: o.tokens, limit, since: o.since, tasks: o.tasks })
  } catch {
    /* the snapshot and the restart are best effort: a failure leaves the next message's own check (threads.ts wake) */
  }
  return out
}

// ---- the desk's tick -------------------------------------------------------------------------------------------------------------
export type RestartDeps = {
  agents: () => Promise<AgentRow[] | null>
  restart: (id: string, why: string, force: boolean) => Promise<Out> // force: stop a session that still shows as working (the grace rule applied)
}
export type Notice = { id: string; text: string }

// "new session: handover about 3.2k tokens (~$0.01 first turn, estimate)" taken out of the reply of a start, or ''
const costOf = (text: string) => /handover about [^(]*\(~\$[\d.]+[^)]*\)/.exec(text)?.[0] ?? ''

let ticking = false // one tick at a time: a restart can take longer than the timer's period
export async function autoRestartTick(h: Host, deps: RestartDeps): Promise<Notice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: RestartDeps): Promise<Notice[]> {
  const home = await homeDir(h)
  if (!(await autoRestartOn(h, home))) return []
  const ents = await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])
  const ids = ents.map(e => e.name).filter(n => /^t\d+$/.test(n))
  const out: Notice[] = []
  let rows: AgentRow[] | null | undefined
  const grace = await stopGraceMs(h, home)
  for (const id of ids) {
    const mk = await readMarker(h, home, id)
    const p = mk.pending
    if (!p) continue
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    const drop = () => writeJson(h, markerFile(home, id), { ...mk, pending: undefined })
    if (!t || t.state !== 'open' || t.sid !== p.sid || t.finished) {
      await drop() // parked, closed, or already another session: the checkpoint is stale
      continue
    }
    const ctx = await readContext(h, home, t)
    if (ctx && ctx.sid === p.sid && ctx.at > p.ts + NEWER_TURN_MS && ctx.tokens < p.limit) {
      await drop() // a later turn ended under the limit (compacted, or the limit was raised): no restart is needed
      continue
    }
    if (now - p.ts < IDLE_MS) continue
    if (mk.last && now - mk.last.at < MIN_GAP_MS) continue // one per 10 minutes: it waits
    rows ??= await deps.agents()
    if (!rows) continue
    const row = rows.find(a => a.sid === p.sid)
    if (!row) {
      await drop()
      continue
    }
    // A real open prompt (a permission prompt, a question) is left alone. The engine also labels a session `blocked` when its last turn says it
    // could not finish, which is exactly what a hard-stopped thread says: that label alone never holds the restart back (seen live).
    if (row.waitingFor) continue
    if (isWorking(row) && now - p.ts < grace) continue // idle first; after the grace minutes a session that still shows as working is restarted too (the stop refuses all its tool calls)
    const r = await deps.restart(id, `Its context was ${p.tokens} tokens (limit ${p.limit}): checkpointed at the end of its turn and restarted by script.`, isWorking(row))
    if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
      await setNotice(h, `restart-${id}`, null) // an earlier give-up is over
      await writeJson(h, markerFile(home, id), { last: { at: now, oldSid: p.sid }, ...(mk.stopped ? { stopped: true } : {}) } satisfies Marker)
      out.push({ id, text: `${id}: context ${kTokens(p.tokens)} was over the limit ${kTokens(p.limit)}: restarted as a new session by script (state kept in state.json). ${costOf(r.text)}`.trim() })
    } else {
      const tries = (p.tries ?? 0) + 1
      await writeJson(h, markerFile(home, id), { ...mk, pending: tries >= MAX_TRIES ? undefined : { ...p, tries, lastTry: now } } satisfies Marker)
      if (tries >= MAX_TRIES) {
        const text = `${id}: automatic restart failed ${tries} times (last reason: ${r.text.slice(0, 160)}); it stays stopped at the context limit. Say "restart ${id}" and the desk starts it fresh from the handover.`
        out.push({ id, text })
        await setNotice(h, `restart-${id}`, text) // a line at the top of the pane with a Dismiss (dismiss.ts kind restart)
      }
    }
  }
  return out
}
