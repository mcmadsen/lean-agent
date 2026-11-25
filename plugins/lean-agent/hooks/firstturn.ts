// A restarted session must start working (1.0.35). Field (1.0.34): a thread was restarted at its checkpoint, the new session got "Continue now with: ..." and then made no
// model request and no tool call for 12 minutes; the desk's own nudge restarted it once more, with the same result; the user had to open the session and type "continue".
// Nothing looked at "did the NEW session do anything?". Now (by script):
//   - a restart by the mod (checkpoint, context limit, stall) records <thread folder>/first-turn.json {sid, at, text}: the new session and the text it was given;
//   - the thread's own mod writes first-turn-seen.json {sid, at} at the new session's FIRST model answer or tool call;
//   - the desk's timer: no sign within threads.firstTurnSeconds (default 90) -> ONE internal kick (the same text, a real prompt through `send`, never a closed thread),
//     and still no sign after the same time -> ONE desk alert with the turn's reason line (turnreason.ts) and what the user can do ("open tN and type continue" is the last resort).
// The kick counts in the shared nudge counter of the 1.0.33 hotfix (continuepending.ts MAX_NUDGES_RUN: nudges of any kind since the last tool call or report): at the cap there is no
// kick, only the alert. No loop: one kick and one alert per restart.
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { setNotice } from './notices'
import { MAX_NUDGES_RUN, readCState, stateFile } from './continuepending'
import { readTurn } from './turnreason'
import type { AgentRow, Out, Thread } from './threads'

export const FIRST_TURN_SECONDS = 90
export const recFile = (home: string, id: string) => `${threadsDir(home)}/${id}/first-turn.json`
export const seenFile = (home: string, id: string) => `${threadsDir(home)}/${id}/first-turn-seen.json`
export type FirstRec = { sid: string; at: number; text: string; why: string; kicked?: number; alerted?: number }

export async function firstTurnSeconds(h: Host, home: string): Promise<number> {
  const cfg = await readJson<{ threads?: { firstTurnSeconds?: unknown }; 'threads.firstTurnSeconds'?: unknown } | null>(h, `${leanDir(home)}/config.json`, null)
  const v = cfg?.threads?.firstTurnSeconds ?? cfg?.['threads.firstTurnSeconds']
  return typeof v === 'number' && Number.isFinite(v) && v >= 10 ? Math.floor(v) : FIRST_TURN_SECONDS
}

// the desk side: a restart by script started session `sid` with `text` as its instruction (the continue text, or the task)
export async function noteFirstTurn(h: Host, id: string, o: { sid: string; text: string; why: string }): Promise<void> {
  try {
    if (!o.sid) return
    const home = await homeDir(h)
    await writeJson(h, recFile(home, id), { sid: o.sid, at: await h.clock.now(), text: o.text.slice(0, 600), why: o.why } satisfies FirstRec)
  } catch {
    /* a missing record is no watch, never a failed restart */
  }
}

// the thread side: the session made its first model answer or tool call (once per session; the caller keeps the flag)
export async function markFirstSeen(h: Host, id: string, sid: string): Promise<void> {
  try {
    if (!sid) return
    const home = await homeDir(h)
    await writeJson(h, seenFile(home, id), { sid, at: await h.clock.now() })
  } catch {
    /* the desk then kicks a session that was fine: one nudge, never harmful */
  }
}

export type FirstDeps = { agents: () => Promise<AgentRow[] | null>; send: (id: string, text: string) => Promise<Out> }
export type FirstNotice = { id: string; text: string }
export const kickedText = (id: string, secs: number) => `${id}: its new session made no model request or tool call within ${secs} s of the restart: sent it its instruction again (once)`
export const alertText = (id: string, mins: number, line: string): string =>
  `${id} did not start working after its restart (${mins} min, one nudge sent; ${line}). Restart it again from the pane (Restart from handover); only as a last resort open ${id} and type "continue"`

let ticking = false
export async function firstTurnTick(h: Host, deps: FirstDeps): Promise<FirstNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } catch {
    return [] // a timer never throws
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: FirstDeps): Promise<FirstNotice[]> {
  const home = await homeDir(h)
  const out: FirstNotice[] = []
  let rows: AgentRow[] | null | undefined
  const secs = await firstTurnSeconds(h, home)
  for (const id of (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n))) {
    const rec = await readJson<Partial<FirstRec> | null>(h, recFile(home, id), null)
    if (!rec || typeof rec.sid !== 'string' || !rec.sid || typeof rec.at !== 'number') continue
    const drop = () => writeJson(h, recFile(home, id), {})
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    if (!t || t.state !== 'open' || t.sid !== rec.sid || t.finished) {
      await drop() // parked, closed, finished, or another session: nothing to watch
      continue
    }
    const seen = await readJson<{ sid?: string; at?: number } | null>(h, seenFile(home, id), null)
    // (the session's own id can differ from the one `claude --bg` printed: role.ts keeps it in `sids`; a sign older than the restart is the old session's)
    if (seen && typeof seen.sid === 'string' && (seen.sid === rec.sid || ((t.sids ?? []).includes(seen.sid) && Number(seen.at) >= rec.at))) {
      await drop() // it started working
      await setNotice(h, `firstturn-${id}`, null).catch(() => undefined)
      continue
    }
    if (rec.alerted || now - (rec.kicked ?? rec.at) < secs * 1000) continue
    rows ??= await deps.agents()
    if (!rows) continue // no listing: nothing is claimed
    const row = rows.find(a => a.sid === rec.sid)
    if (!row) continue // the session is gone: the other watchdogs (stall, delivery) own that
    if (row.waitingFor) continue // an open prompt is the user's
    // the first model request can be a long one: a session that shows `working` gets three times the time before it counts as silent
    if (row.state === 'working' && now - (rec.kicked ?? rec.at) < secs * 3000) continue
    if (!rec.kicked) {
      const cs = await readCState(h, home, id)
      const run = cs.nudgeSid === t.sid ? (cs.nudgeRun ?? 0) : 0
      if (run >= MAX_NUDGES_RUN) {
        await writeJson(h, recFile(home, id), { ...rec, kicked: now } satisfies Partial<FirstRec>) // the nudge cap is used: no kick, the alert comes after the same time
        continue
      }
      const r = await deps.send(id, String(rec.text ?? '') || 'Continue with the task from your handover now.')
      await writeJson(h, recFile(home, id), { ...rec, kicked: now } satisfies Partial<FirstRec>)
      if (r.ok) {
        await writeJson(h, stateFile(home, id), { ...cs, nudgeRun: run + 1, nudgeSid: t.sid, sentAt: now })
        out.push({ id, text: kickedText(id, secs) })
      }
      continue
    }
    const tr = await readTurn(h, home, id)
    const line = tr && tr.sid === t.sid ? tr.line : 'no turn record: the session made no model request'
    const text = alertText(id, Math.max(1, Math.round((now - rec.at) / 60_000)), line)
    await writeJson(h, recFile(home, id), { ...rec, alerted: now } satisfies Partial<FirstRec>)
    await setNotice(h, `firstturn-${id}`, text).catch(() => undefined)
    out.push({ id, text })
  }
  return out
}
