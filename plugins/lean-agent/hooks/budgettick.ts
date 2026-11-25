// The desk's minute tick for budget and window awareness (1.0.31), by script, no model turn. Each part returns the notice lines the desk shows (one per event):
//   windowParkTick: while the 5h window is above window.throttleAbove (throttle.ts) every OPEN thread with priority low is parked (threads.ts window-park: no auto continue,
//     no auto restart: parked threads are skipped by all of them); when the window is below the line again or has reset, the threads THIS tick parked are resumed
//     (window-resume). A thread the user parked is never touched (thread.json windowParked marks ours). One notice each way.
//   softCheckpointTick: a thread over its soft checkpoint size (threads.softCheckpointTokens, default 80k; the per-thread limit moves it) whose session is idle with work left
//     is checkpointed and restarted by script (the automatic restart path: fresh session, handover, snapshot) once per session; a working thread was told by its own warn line.
import { homeDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { windowState } from './throttle'
import { deskState } from './delivery'
import { readContext, threadLimitsFor } from './threadcontext'
import { budgetFile, budgetLevel, budgetOf, budgetText, hardNudge, hardOf, nearNudge, overNote, threadTotals } from './budgetthread'
import type { BudgetRec } from './budgetthread'
import { MIN_GAP_MS, turnState } from './autorestart'
import { isWorking } from './threads'
import type { DeskRec } from './delivery'
import type { AgentRow, Out, Thread } from './threads'

export type TickDeps = { thread: (i: { action: string; tN: string; reason?: string; force?: boolean; text?: string }) => Promise<Out> }
const idsOf = async (h: Host, home: string): Promise<string[]> => (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
const threadOf = (h: Host, home: string, id: string) => readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null).catch(() => null)

export async function windowParkTick(h: Host, deps: TickDeps): Promise<string[]> {
  try {
    const s = await windowState(h)
    const home = await homeDir(h)
    const done: string[] = []
    if (s.level !== 'ok') {
      for (const id of await idsOf(h, home)) {
        const t = await threadOf(h, home, id)
        if (!t || t.state !== 'open' || t.priority !== 'low' || t.windowParked) continue
        const r = await deps.thread({ action: 'window-park', tN: id }).catch(() => null)
        if (r?.ok) done.push(id)
      }
      if (!done.length) return []
      const until = s.resetsAt ? ` or the window resets at ${new Date(s.resetsAt).toISOString().slice(11, 16)} UTC` : ''
      return [`5h window at ${Math.round(s.pct ?? 0)}% (above ${s.throttleAbove}%): parked ${done.join(', ')} (priority low) until it drops below the line${until}; no restart or continue until then`]
    }
    for (const id of await idsOf(h, home)) {
      const t = await threadOf(h, home, id)
      if (!t || !t.windowParked) continue
      const r = await deps.thread({ action: 'window-resume', tN: id }).catch(() => null)
      if (r?.ok) done.push(id)
    }
    return done.length ? [`5h window is ${s.pct === null ? 'reset' : `at ${Math.round(s.pct)}%`}, below ${s.throttleAbove}%: resumed ${done.join(', ')} (priority low, parked by the window)`] : []
  } catch {
    return [] // a timer never throws
  }
}

// The soft budget (budgetthread.ts): at 80% of a thread's own spend ONE nudge to the thread and ONE desk notice; at 100% ONE desk notice (raise / park / continue) and the thread goes on.
// Only the hard cap (config threads.hardTokens, none by default) stops a thread: it is told to report and stop, and budget.json says "hard" so the guard refuses its new Agent calls.
// The figure is the thread's OWN usage tokens (usage.ts threadTotals: its sessions, restarts and subagents from its creation on; never the desk's or another thread's).
// The levels are recorded per budget value (<thread>/budget.json): raising the budget announces them again.
export async function softBudgetTick(h: Host, deps: TickDeps): Promise<string[]> {
  const out: string[] = []
  try {
    const home = await homeDir(h)
    let totals: Record<string, number> | undefined
    for (const id of await idsOf(h, home)) {
      const t = await threadOf(h, home, id)
      if (!t || t.state === 'closed' || t.state === 'closing') continue
      const budget = await budgetOf(h, t)
      const hard = await hardOf(h)
      const have = await readJson<BudgetRec | null>(h, budgetFile(home, id), null)
      if (budget === null && hard === null) {
        if (have?.hard || have?.over) await writeJson(h, budgetFile(home, id), {}) // both switched off: the refusal ends
        continue
      }
      totals ??= await threadTotals(h)
      const spent = totals[id] ?? 0
      const now = await h.clock.now()
      const send = async (text: string) => deps.thread({ action: 'send', tN: id, text }).catch(() => null)
      const rec: BudgetRec = have && have.budget === (budget ?? 0) ? { ...have } : { budget: budget ?? 0 }
      if (rec.hardTokens !== undefined && rec.hardTokens !== hard) { delete rec.hard; delete rec.hardTokens } // the cap was changed or removed: the refusal ends, a new cap is announced again
      if ((rec as { hardUsd?: number }).hardUsd !== undefined) { delete rec.hard; delete (rec as { hardUsd?: number }).hardUsd } // a USD cap of 1.0.33: no longer enforced
      let changed = have?.budget !== rec.budget || have?.hardTokens !== rec.hardTokens || (have as { hardUsd?: number } | null)?.hardUsd !== undefined
      // the hard cap (threads.hardTokens, none by default): the only level that stops a thread: told to report and stop, new Agent calls refused (guard.ts reads budget.json)
      if (hard !== null && spent >= hard && !rec.hard) {
        rec.hard = now
        rec.hardTokens = hard
        await writeJson(h, budgetFile(home, id), rec)
        await send(hardNudge(spent, hard))
        out.push(`${id}: hard cap ${budgetText(spent, hard)} reached: told to report and stop; its new Agent calls are refused (raise threads.hardTokens, or remove it, to let it go on)`)
        changed = false
      }
      const level = budget === null ? 'ok' : budgetLevel(spent, budget)
      if (budget !== null && level === 'over' && !rec.over) {
        // the soft budget never stops a thread: ONE notice to the desk (raise / park / continue); the thread is not messaged and goes on
        rec.over = now
        rec.near ??= now
        await writeJson(h, budgetFile(home, id), rec)
        out.push(overNote(id, spent, budget))
        changed = false
      } else if (budget !== null && level === 'near' && !rec.near) {
        rec.near = now
        await writeJson(h, budgetFile(home, id), rec)
        await send(nearNudge(spent, budget))
        out.push(`${id}: 80% of its soft budget used (${budgetText(spent, budget)}): nudged to take the cheapest path and report at the next natural point; it goes on`)
        changed = false
      }
      if (changed) await writeJson(h, budgetFile(home, id), rec) // a changed budget or cap forgets the old levels
    }
  } catch {
    /* a timer never throws */
  }
  return out
}

export const SOFT_IDLE_MS = 120_000 // the session ended its turn this long ago (a thread that is still being worked with is left alone)
const softFile = (home: string, id: string) => `${threadsDir(home)}/${id}/softcheckpoint.json`
const kk = (n: number) => `${Math.round(n / 1000)}k`

export async function softCheckpointTick(h: Host, deps: TickDeps & { agents: () => Promise<AgentRow[] | null> }): Promise<string[]> {
  const out: string[] = []
  try {
    const home = await homeDir(h)
    let rows: AgentRow[] | null | undefined
    let recs: DeskRec[] | undefined
    for (const id of await idsOf(h, home)) {
      const t = await threadOf(h, home, id)
      if (!t || t.state !== 'open' || !t.sid || t.finished) continue
      const ctx = await readContext(h, home, t)
      if (!ctx) continue
      const l = await threadLimitsFor(h, id)
      if (ctx.tokens <= l.warn || ctx.tokens >= l.limit) continue // under the soft line, or at the hard limit (the stop and the automatic restart own that)
      const now = await h.clock.now()
      if (now - ctx.at < SOFT_IDLE_MS) continue
      if ((await readJson<{ sid?: string } | null>(h, softFile(home, id), null))?.sid === t.sid) continue // once per session
      const mk = await readJson<{ last?: { at?: number } } | null>(h, `${threadsDir(home)}/${id}/autorestart.json`, null)
      if (typeof mk?.last?.at === 'number' && now - mk.last.at < MIN_GAP_MS) continue // one automatic restart per 10 minutes, shared
      rows ??= await deps.agents()
      if (!rows) return out
      const row = rows.find(a => a.sid === t.sid)
      if (!row || isWorking(row) || row.waitingFor) continue // working: its own warn line told it; waiting: a question or an approval is the user's
      recs ??= await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
      if (turnState(recs, id, t.lastWake) !== 'work') continue // done or waiting: the next message starts it fresh anyway
      await writeJson(h, softFile(home, id), { sid: t.sid, at: now, tokens: ctx.tokens }) // (before the restart: a failed one is not retried every minute)
      const r = await deps.thread({ action: 'auto-restart', tN: id, reason: `Its context was ${ctx.tokens} tokens, over the soft checkpoint size ${l.warn}: checkpointed while idle and restarted by script (a long thread re-reads its whole context every turn).`, force: false })
      if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
        await writeJson(h, `${threadsDir(home)}/${id}/autorestart.json`, { last: { at: now, oldSid: t.sid } })
        out.push(`${id}: context ${kk(ctx.tokens)} passed the soft checkpoint size ${kk(l.warn)} while idle: checkpointed and restarted as a new session by script`)
      }
    }
  } catch {
    /* a timer never throws */
  }
  return out
}
