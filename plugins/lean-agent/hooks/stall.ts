// Stall watchdog (1.0.20; field: a thread showed "running" for about 3 hours with no report while 3 desk messages sat unread, nothing flagged it).
// A thread whose session is alive and working but made no tool call and no report for `threads.stallMinutes` (default 20), or whose queued
// messages stayed unread that long, is "stalled" (threadstate.ts truthOf: red in the pane and in `lean_thread list`, which names the last
// activity time). The thread's own hooks write <thread folder>/activity.json (a tool call of the thread or of one of its workers, a report,
// a prompt), so a thread that waits on a background worker which is still working is NOT stalled: the worker's tool calls count.
// The desk's timer (stallTick) raises ONE notice + toast per stall, keeps desk/stalls.json for the reminder line the desk gets once per desk turn
// while the stall lasts (stallLines), and, when `threads.stallRestart` is true (default false), restarts the thread by script through the same
// stop + fresh session path as the automatic restart at the context limit (leanThread action stall-restart, force) and says so.
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState, unconsumed } from './delivery'
import { lastActivity, stallConfig, threadsConfig, truthOf } from './threadstate'
import type { AgentRow, Out, Thread } from './threads'

export const MAX_STALL_TRIES = 3 // a failed stall restart: tried at most this often per stall, then ONE notice
export type StallRec = { since: number; idleSince: number; unread: number; tries?: number }
export type Stalls = Record<string, StallRec>
export const stallsFile = (home: string) => `${deskState(home)}/stalls.json`
const readStalls = async (h: Host, home: string): Promise<Stalls> => {
  const s = await readJson<Stalls | null>(h, stallsFile(home), null)
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
}

export type StallDeps = { agents: () => Promise<AgentRow[] | null>; restart: (id: string, why: string) => Promise<Out> }
export type StallNotice = { id: string; text: string }

const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000))
const unreadText = (n: number) => (n ? `, ${n} message${n === 1 ? '' : 's'} unread` : '')
export const stallText = (id: string, ms: number, unread: number) => `${id} has done nothing for ${mins(ms)} min${unreadText(unread)}`

let ticking = false
export async function stallTick(h: Host, deps: StallDeps): Promise<StallNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } catch {
    return [] // a watchdog never throws into the timer
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: StallDeps): Promise<StallNotice[]> {
  const home = await homeDir(h)
  const ents = await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])
  const ids = ents.map(e => e.name).filter(n => /^t\d+$/.test(n))
  const cfg = await stallConfig(h, home)
  const stuckMinutes = (await threadsConfig(h, home)).stuckMinutes
  const stalls = await readStalls(h, home)
  const before = JSON.stringify(stalls)
  const out: StallNotice[] = []
  const rows = ids.length ? await deps.agents() : null
  if (!rows) return [] // no listing: nothing is claimed, the records stay
  for (const id of ids) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    const truth =
      t && t.state === 'open' && t.sid && !t.finished
        ? truthOf({ threadState: t.state, row: rows.find(a => a.sid === t.sid), queued: (await unconsumed(h, home, id)).msgs, now, stuckMinutes, stallMinutes: cfg.minutes, activityAt: await lastActivity(h, home, id, t.lastWake) })
        : null
    if (!truth || truth.word !== 'stalled') {
      delete stalls[id] // not (or no longer) stalled: the next stall gets its own notice
      continue
    }
    const ms = truth.stalledMs ?? 0
    const rec: StallRec = stalls[id] ?? { since: now, idleSince: now - ms, unread: truth.unread }
    const fresh = !stalls[id]
    rec.unread = truth.unread
    rec.idleSince = now - ms
    stalls[id] = rec
    const base = stallText(id, ms, truth.unread)
    if (!cfg.restart) {
      if (fresh) out.push({ id, text: `${base}: wake or restart it` })
      continue
    }
    if ((rec.tries ?? 0) >= MAX_STALL_TRIES) continue // gave up for this stall (the notice was sent)
    const r = await deps.restart(id, `Its previous session stalled: no tool call or report for ${mins(ms)} min${unreadText(truth.unread)}; restarted by script (threads.stallRestart).`)
    if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
      delete stalls[id] // a new session: the stall is over
      out.push({ id, text: `${base}: restarted it as a new session by script (threads.stallRestart is on)` })
    } else {
      rec.tries = (rec.tries ?? 0) + 1
      // (before the last try: retried at the next tick, the notice comes with the last one)
      if (rec.tries >= MAX_STALL_TRIES) out.push({ id, text: `${base}: the automatic restart failed ${rec.tries} times (last reason: ${r.text.slice(0, 160)}); wake or restart it by hand` })
    }
  }
  for (const id of Object.keys(stalls)) if (!ids.includes(id)) delete stalls[id]
  if (JSON.stringify(stalls) !== before) await writeJson(h, stallsFile(home), stalls)
  return out
}

// The reminder for the desk's context, once per desk turn while a stall lasts: one line, or null.
export async function stallLines(h: Host): Promise<string | null> {
  const home = await homeDir(h)
  const stalls = await readStalls(h, home)
  const now = await h.clock.now()
  const lines = Object.entries(stalls).map(([id, r]) => `${stallText(id, now - r.idleSince, r.unread)}: wake or restart it`)
  return lines.length ? `[lean-agent] stalled: ${lines.join('; ')}` : null
}
