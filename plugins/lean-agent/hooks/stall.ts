// Stall watchdog (1.0.20; field: a thread showed "running" for about 3 hours with no report while 3 desk messages sat unread, nothing flagged it).
// A thread whose session is alive and working but made no tool call and no report for `threads.stallMinutes` (default 10 since 1.0.28; 5 for a keep-going thread; a stalled thread at 80% of its context limit is restarted at once), or whose queued
// messages stayed unread that long, is "stalled" (threadstate.ts truthOf: red in the pane and in `lean_thread list`, which names the last
// activity time). The thread's own hooks write <thread folder>/activity.json (a tool call of the thread or of one of its workers, a report,
// a prompt), so a thread that waits on a background worker which is still working is NOT stalled: the worker's tool calls count.
// The desk's timer (stallTick) raises ONE notice + toast per stall, keeps desk/stalls.json for the reminder line the desk gets once per desk turn
// while the stall lasts (stallLines), and, when `threads.stallRestart` is true (default false), restarts the thread by script through the same
// stop + fresh session path as the automatic restart at the context limit (leanThread action stall-restart, force) and says so.
import { homeDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { setNotice } from './notices'
import { idleNoReport, lastActivity, readWaiting, stallConfig, stallFor, threadsConfig, truthOf } from './threadstate'
import { haltedSince } from './continuepending'
import { waitingOn } from './waitevent'
import { alertText, endDue, endNudgeOn, markAlerted, wasNudged } from './endnudge'
import { kTokens, readContext, threadLimits } from './threadcontext'
import type { AgentRow, Out, Thread } from './threads'

export const CAP_SHARE = 0.8 // a stalled thread at this share of the context limit is restarted at once
export const MAX_STALL_TRIES = 3 // a failed stall restart: tried at most this often per stall, then ONE notice
export type StallRec = { since: number; idleSince: number; unread: number; tries?: number }
export type Stalls = Record<string, StallRec>
export const stallsFile = (home: string) => `${deskState(home)}/stalls.json`
export const idleFile = (home: string) => `${deskState(home)}/idle-alerts.json` // tN -> the last-activity time of the idle spell the desk was told about
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
  const idles = await readJson<Record<string, number>>(h, idleFile(home), {})
  const idlesBefore = JSON.stringify(idles)
  const deskRecs = ids.length ? await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`).catch(() => [] as DeskRec[]) : []
  const out: StallNotice[] = []
  const rows = ids.length ? await deps.agents() : null
  if (!rows) return [] // no listing: nothing is claimed, the records stay
  for (const id of ids) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    let truth =
      t && t.state === 'open' && t.sid && !t.finished
        ? truthOf({ threadState: t.state, row: rows.find(a => a.sid === t.sid), queued: (await unconsumed(h, home, id)).msgs, now, stuckMinutes, stallMinutes: stallFor(cfg.minutes, t), activityAt: await lastActivity(h, home, id, t.lastWake), waitingSince: (await readWaiting(h, home, id))?.since ?? null })
        : null
    // a thread that keeps stopping after "next:" (continuepending.ts gave up continuing it) is in the stall state even while its session is idle
    const halted = truth && (truth.word === 'idle' || truth.word === 'running' || truth.word === 'stuck') ? await haltedSince(h, home, id) : null
    if (truth && halted) truth = { ...truth, word: 'stalled', stalledMs: Math.max(0, now - halted) }
    // idle with no report (1.0.31; field: three threads sat "idle · no report yet" and only a full listing found them): ONE notice per idle spell (keyed by the last activity)
    const lastRec = t ? deskRecs.filter(r => r && r.from === id && (r.kind === 'report' || r.kind === 'ask')).pop() : undefined
    const idle0 = t && truth ? idleNoReport({ word: truth.word, keepGoing: t.keepGoing === true, lastAt: truth.lastAt, now, minutes: cfg.idleAlertMinutes, since: Math.max(Number(t.lastWake) || 0, Number(t.created) || 0), lastRec }) : null
    // the report rule (1.0.32, endnudge.ts): a turn that ended without a final report, nudged, and still none after idleAlertMinutes: ONE desk alert per spell; it replaces
    // the plain idle alert above (which an earlier report of the session or keep-going would have silenced)
    const ended = t && truth && (await endNudgeOn(h, home)) ? await endDue(h, home, t, { word: truth.word, now, minutes: cfg.idleAlertMinutes, recs: deskRecs }) : null
    if (ended && t && !ended.rec.alerted) {
      await markAlerted(h, home, id, ended.rec, now)
      out.push({ id, text: `${alertText(id, ended.ms, t.title ?? '', await wasNudged(h, home, id, ended.rec.first))}${ended.rec.hint ? '; its last text handed over a result it did not verify itself' : ''}` })
    }
    // a thread that really waits (for the push result, an action, your answer, CI: waitevent.ts) is not idle without a report: no alert
    const idle = ended || (idle0 && (await waitingOn(h, home, id))) ? null : idle0
    if (idle && t) {
      if (idles[id] !== idle.since) {
        idles[id] = idle.since
        const said = lastRec && lastRec.ts >= Math.max(Number(t.lastWake) || 0, Number(t.created) || 0) ? `; its last word was a progress report: "${String(lastRec.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"` : ''
        out.push({ id, text: `${id} idle for ${mins(idle.ms)} min with no report: ${t.title ?? ''}${said}` })
      }
    } else delete idles[id]
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
    // at 80% of the context limit a stalled thread is restarted at once (1.0.28; field: stalled at 112k of 120k, flagged only after 20 minutes)
    const ctx = t ? await readContext(h, home, t) : null
    const limit = (await threadLimits(h)).limit
    const nearCap = !!ctx && ctx.tokens >= limit * CAP_SHARE
    if (!cfg.restart && !nearCap) {
      if (fresh && !halted) out.push({ id, text: `${base}: wake or restart it` })
      continue
    }
    if ((rec.tries ?? 0) >= MAX_STALL_TRIES) continue // gave up for this stall (the notice was sent)
    const again = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null) // the moment it acts: never a parked or closed thread
    if (!again || again.state !== 'open') {
      delete stalls[id]
      continue
    }
    const r = await deps.restart(id, nearCap ? `Its previous session stalled at ${ctx!.tokens} tokens (limit ${limit}): no tool call or report for ${mins(ms)} min; restarted by script with the handover.` : `Its previous session stalled: no tool call or report for ${mins(ms)} min${unreadText(truth.unread)}; restarted by script (threads.stallRestart).`)
    if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
      delete stalls[id] // a new session: the stall is over
      await setNotice(h, `restart-${id}`, null)
      out.push({ id, text: nearCap ? `${id} stalled at ${kTokens(ctx!.tokens)} of ${kTokens(limit)}: restarted` : `${base}: restarted it as a new session by script (threads.stallRestart is on)` })
    } else {
      rec.tries = (rec.tries ?? 0) + 1
      // (before the last try: retried at the next tick, the notice comes with the last one)
      if (rec.tries >= MAX_STALL_TRIES) {
        const text = `${base}: the automatic restart failed ${rec.tries} times (last reason: ${r.text.slice(0, 160)}); wake or restart it by hand`
        out.push({ id, text })
        await setNotice(h, `restart-${id}`, text) // a line at the top of the pane with a Dismiss (dismiss.ts kind restart)
      }
    }
  }
  for (const id of Object.keys(stalls)) if (!ids.includes(id)) delete stalls[id]
  for (const id of Object.keys(idles)) if (!ids.includes(id)) delete idles[id]
  if (JSON.stringify(stalls) !== before) await writeJson(h, stallsFile(home), stalls)
  if (JSON.stringify(idles) !== idlesBefore) await writeJson(h, idleFile(home), idles)
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
