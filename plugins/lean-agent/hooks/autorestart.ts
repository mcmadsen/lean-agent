// Automatic restart at the context limit (user: always automatic, by script, no model turn).
// Thread side (threadTurnEnd, the thread's own mod at the end of every main turn): write the state snapshot (snapshot.ts); when the context
// is over `threadTokens` and work is left (the turn did not end with done / blocked / a question), write a MOD-authored record to the desk
// inbox ("context 205k over the limit: checkpointed, restart me") and <thread>/autorestart.json.
// Desk side (autoRestartTick, the desk mod's timer): once the session has been idle for IDLE_MS the thread is restarted by script
// (leanThread auto-restart: a fresh session with the handover, the old one removed) and the tick returns the notice text.
// Guards: never mid-turn (idle session only), one automatic restart per thread per 10 minutes, a fresh session that starts over the limit
// stops and asks the user, only while the desk runs (its timer), config threads.autoRestart (default true).
import { appendJsonl, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { buildSnapshot, takeEdited, writeSnapshot } from './snapshot'
import { kTokens, readContext, threadLimits } from './threadcontext'
import { isWorking, needsYou } from './threads'
import type { AgentRow, Out, Thread } from './threads'

export const IDLE_MS = 20_000 // the session must have ended its turn this long ago
export const MIN_GAP_MS = 10 * 60_000 // one automatic restart per thread per 10 minutes
const NEWER_TURN_MS = 10_000 // a context record this much newer than the checkpoint is a later turn
const RETRY_MS = 60_000
const MAX_TRIES = 3

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

// Work is left unless the turn that just ended reported done or blocked, or ended with a question. `since`: when the turn started.
export function workLeft(recs: DeskRec[], id: string, since: number): boolean {
  const mine = recs.filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as any).mod && r.ts >= since)
  const last = mine[mine.length - 1]
  return !last || (last.kind !== 'ask' && last.state !== 'done' && last.state !== 'blocked')
}

export const checkpointText = (tokens: number, limit: number) => `context ${kTokens(tokens)} over the limit ${kTokens(limit)}: checkpointed, restart me`

export type TurnEnd = { sid: string; tokens: number | null; since: number; tasks?: unknown }
export type TurnOut = { snapshot: boolean; action: 'none' | 'checkpoint' | 'ask' }

// The thread's own mod, at the end of a main-thread turn. Never throws.
export async function threadTurnEnd(h: Host, id: string, o: TurnEnd): Promise<TurnOut> {
  const out: TurnOut = { snapshot: false, action: 'none' }
  try {
    const home = await homeDir(h)
    out.snapshot = await writeSnapshot(h, home, await buildSnapshot(h, home, id, { sid: o.sid, tokens: o.tokens, edited: takeEdited(), tasks: o.tasks }))
    if (o.tokens === null || !(await autoRestartOn(h, home))) return out
    const limit = (await threadLimits(h)).limit
    let mk = await readMarker(h, home, id)
    // the first turn end of the session an automatic restart started (any session but the old one)
    const first = !!(mk.last && o.sid && o.sid !== mk.last.oldSid && !mk.last.newSid)
    if (first) {
      mk = { ...mk, last: { ...mk.last!, newSid: o.sid } }
      await writeJson(h, markerFile(home, id), mk)
    }
    if (o.tokens <= limit) {
      if (mk.stopped) await writeJson(h, markerFile(home, id), { ...mk, stopped: false })
      return out
    }
    const inbox = `${deskState(home)}/inbox.jsonl`
    const now = await h.clock.now()
    // a fresh session that starts over the limit: restarting again would loop; the user decides
    if (first) {
      await appendJsonl(h, inbox, { ts: now, from: id, kind: 'ask', mod: true, text: `${id} was restarted at the context limit, but the new session is again over it (${kTokens(o.tokens)} over ${kTokens(limit)}): the handover plus the work do not fit. No more automatic restarts for ${id} until it is under the limit. Raise threadTokens, trim notes.md, or split the task?`, options: ['raise threadTokens', 'trim notes.md and restart', 'split the task'] } satisfies Record<string, unknown>)
      await writeJson(h, markerFile(home, id), { ...mk, stopped: true })
      out.action = 'ask'
      return out
    }
    if (mk.stopped || mk.pending?.sid === o.sid) return out
    const recs = await readJsonl<DeskRec>(h, inbox)
    if (!workLeft(recs, id, o.since)) return out // done, blocked or a question: the next message starts the fresh session (wake)
    await appendJsonl(h, inbox, { ts: now, from: id, kind: 'report', state: 'checkpoint', mod: true, text: checkpointText(o.tokens, limit), restart: { tokens: o.tokens, limit, sid: o.sid } })
    await writeJson(h, markerFile(home, id), { ...mk, pending: { ts: now, sid: o.sid, tokens: o.tokens, limit } } satisfies Marker)
    out.action = 'checkpoint'
  } catch {
    /* the snapshot and the restart are best effort: a failure leaves the next message's own check (threads.ts wake) */
  }
  return out
}

// ---- the desk's tick -------------------------------------------------------------------------------------------------------------
export type RestartDeps = {
  agents: () => Promise<AgentRow[] | null>
  restart: (id: string, why: string) => Promise<Out>
}
export type Notice = { id: string; text: string }

// "new session: handover about 3.2k tokens (~$0.01 first turn, estimate)" taken out of the reply of a start, or ''
const costOf = (text: string) => /handover about [^(]*\(~\$[\d.]+[^)]*\)/.exec(text)?.[0] ?? ''

export async function autoRestartTick(h: Host, deps: RestartDeps): Promise<Notice[]> {
  const home = await homeDir(h)
  if (!(await autoRestartOn(h, home))) return []
  const ents = await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])
  const ids = ents.map(e => e.name).filter(n => /^t\d+$/.test(n))
  const out: Notice[] = []
  let rows: AgentRow[] | null | undefined
  for (const id of ids) {
    const mk = await readMarker(h, home, id)
    const p = mk.pending
    if (!p) continue
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    const drop = () => writeJson(h, markerFile(home, id), { ...mk, pending: undefined })
    if (!t || t.state !== 'open' || t.sid !== p.sid) {
      await drop() // parked, closed, or already another session: the checkpoint is stale
      continue
    }
    const ctx = await readContext(h, home, t)
    if (ctx && ctx.sid === p.sid && ctx.at > p.ts + NEWER_TURN_MS) {
      await drop() // a later turn ended: it writes its own checkpoint when it is still needed
      continue
    }
    if (now - p.ts < IDLE_MS) continue
    if (mk.last && now - mk.last.at < MIN_GAP_MS) continue // one per 10 minutes: it waits
    if (p.lastTry && now - p.lastTry < RETRY_MS) continue
    rows ??= await deps.agents()
    if (!rows) continue
    const row = rows.find(a => a.sid === p.sid)
    if (!row) {
      await drop()
      continue
    }
    if (isWorking(row) || needsYou(row)) continue // never mid-turn: a working session is left alone, the checkpoint stays
    const r = await deps.restart(id, `Its context was ${p.tokens} tokens (limit ${p.limit}): checkpointed at the end of its turn and restarted by script.`)
    if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
      await writeJson(h, markerFile(home, id), { last: { at: now, oldSid: p.sid }, ...(mk.stopped ? { stopped: true } : {}) } satisfies Marker)
      out.push({ id, text: `${id}: context ${kTokens(p.tokens)} was over the limit ${kTokens(p.limit)}: restarted as a new session by script (checkpoint kept in state.json). ${costOf(r.text)}`.trim() })
    } else {
      const tries = (p.tries ?? 0) + 1
      await writeJson(h, markerFile(home, id), { ...mk, pending: tries >= MAX_TRIES ? undefined : { ...p, tries, lastTry: now } } satisfies Marker)
      if (tries >= MAX_TRIES) out.push({ id, text: `${id}: automatic restart failed ${tries} times (${r.text.slice(0, 160)}); it stays as it is, restart it by hand` })
    }
  }
  return out
}
