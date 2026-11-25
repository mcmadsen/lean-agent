// Window-aware throttling (1.0.31), by script. The plan's 5-hour window is what actually stops work (the optional token caps of 1.0.33, budget.windowTokens and
// budget.allTimeTokens, hold new work the same way), so it is read
// from desk/windows.json (windows.ts, written by every session's mod) and acted on:
//   window.throttleAbove (70): above it every new Agent call must run on haiku (the guard refuses the others), the desk warns on `new` / `start` and refuses a thread
//     with priority low, and running threads with priority low are PARKED by script (and resumed by script when the window is below again or has reset).
//   window.blockAbove (92): above it no new thread and no new Agent / reviewer fan-out starts, except for a thread with priority urgent.
//   window.capFiveHourPct (none): the user's own cap in percent: AT it all new work is held (urgent included) and the desk says when the window resets.
// A reading whose window has reset (resetsAt in the past) counts as nothing measured. No model decides any of this.
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { cfgNum, cfgRaw } from './budgetcfg'
import { kb, passBytes } from './reviewarea'
import { fmtUntil } from './limits'
import { capReached } from './usage'
import type { TokenCap } from './usage'
import { fmtTokens } from './formatusage'

export type WLevel = 'ok' | 'throttled' | 'blocked' | 'capped'
export type WState = { pct: number | null; resetsAt: number; level: WLevel; throttleAbove: number; blockAbove: number; cap: number | null; tokenCap?: TokenCap }
export type Priority = 'low' | 'normal' | 'urgent'
export const priorityOf = (v: unknown): Priority => (v === 'low' || v === 'urgent' ? v : 'normal')

// pure: the level of a percentage
export function levelFor(pct: number | null, throttleAbove: number, blockAbove: number, cap: number | null): WLevel {
  if (pct === null) return 'ok'
  if (cap !== null && pct >= cap) return 'capped'
  if (pct > blockAbove) return 'blocked'
  if (pct > throttleAbove) return 'throttled'
  return 'ok'
}

// The optional token caps (config budget.windowTokens, budget.allTimeTokens; usage.ts) hold new work the way window.capFiveHourPct does: level 'capped', tokenCap says which.
export async function windowState(h: Host): Promise<WState> {
  const s = await pctState(h)
  const tc = await capReached(h) // (none set = no ledger read)
  return tc ? { ...s, level: 'capped', tokenCap: tc } : s
}
// held text of a reached token cap: "your cap of 5M usage tokens (budget.windowTokens) is reached (5.2M used)"
const tokenCapText = (c: TokenCap): string => `your cap of ${fmtTokens(c.cap)} usage tokens (${c.key}) is reached (${fmtTokens(c.used)} used)`
const tokenCapEnd = async (h: Host, s: WState): Promise<string> => (s.tokenCap?.scope === 'allTime' ? 'until you raise budget.allTimeTokens or start again (lean_config set budget.since today)' : `until the window resets (${await resetText(h, s)})`)

async function pctState(h: Host): Promise<WState> {
  const throttleAbove = (await cfgNum(h, 'window.throttleAbove')) ?? 70
  const blockAbove = (await cfgNum(h, 'window.blockAbove')) ?? 92
  const cap = await cfgNum(h, 'window.capFiveHourPct')
  try {
    // desk/windows.json (windows.ts writes it; read here directly: windows.ts imports delivery.ts, and reviewtool.ts and guard.ts must not reach that: import cycle)
    const home = (await h.env.get('HOME'))?.replace(/\/+$/, '')
    const snap = home ? await readJson<{ windows?: { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }[] } | null>(h, `${leanDir(home)}/desk/windows.json`, null) : null
    const w = Array.isArray(snap?.windows) ? snap!.windows!.find(x => x?.kind === 'five_hour') : undefined
    const pct = Number(w?.percentUsed)
    const resetsAt = typeof w?.resetsAt === 'number' ? w.resetsAt : Date.parse(String(w?.resetsAt ?? '')) || 0
    const now = await h.clock.now()
    if (!w || !Number.isFinite(pct) || (resetsAt && resetsAt <= now)) return { pct: null, resetsAt: 0, level: 'ok', throttleAbove, blockAbove, cap }
    const p = Math.max(0, Math.min(100, pct))
    return { pct: p, resetsAt, level: levelFor(p, throttleAbove, blockAbove, cap), throttleAbove, blockAbove, cap }
  } catch {
    return { pct: null, resetsAt: 0, level: 'ok', throttleAbove, blockAbove, cap }
  }
}

const pctText = (s: WState) => (s.pct === null && s.tokenCap ? 'not measured' : `${Math.round(s.pct ?? 0)}%`)
const resetText = async (h: Host, s: WState): Promise<string> => (s.resetsAt ? `resets ${fmtUntil(s.resetsAt, await h.clock.now())}` : 'reset time unknown')

// "5h window 74%: throttled (haiku only, no low priority threads)" for `lean_thread list` and `lean_doctor stats`; '' when nothing is measured
export async function throttleLine(h: Host): Promise<string> {
  const s = await windowState(h)
  if (s.tokenCap) return `5h window ${pctText(s)}: ${tokenCapText(s.tokenCap)}: all new work is held ${await tokenCapEnd(h, s)}`
  if (s.pct === null) return ''
  const what = s.level === 'capped' ? `cap ${s.cap}% reached: all new work is held, ${await resetText(h, s)}` : s.level === 'blocked' ? `blocked above ${s.blockAbove}%: no new threads or reviewers (urgent excepted), ${await resetText(h, s)}` : s.level === 'throttled' ? `throttled above ${s.throttleAbove}%: new agents haiku only, low priority threads wait, ${await resetText(h, s)}` : `under the throttle line ${s.throttleAbove}%${s.cap !== null ? `, cap ${s.cap}%` : ''}`
  return `5h window ${pctText(s)}: ${what}`
}

// ---- the guard: a new Agent call -----------------------------------------------------------------------------------------------------------
// null = allowed. `model`: the effective model of the call (an override, else the agent type's own, else ''); `urgent`: the calling thread has priority urgent.
// The override a user can give: raise window.throttleAbove (100 = off) in config.json; no thread can write it.
export async function agentWindowDenial(h: Host, model: string, urgent: boolean): Promise<string | null> {
  const s = await windowState(h)
  if (s.level === 'ok') return null
  if (s.tokenCap) return `lean-agent: ${tokenCapText(s.tokenCap)}, so all new work is held ${await tokenCapEnd(h, s)}. Report to the desk with lean_report and wait; do not start agents`
  if (s.level === 'capped') return `lean-agent: 5h window at ${pctText(s)}: your cap of ${s.cap}% (window.capFiveHourPct) is reached, so all new work is held until the window resets (${await resetText(h, s)}). Report to the desk with lean_report and wait; do not start agents`
  if (s.level === 'blocked' && !urgent) return `lean-agent: 5h window at ${pctText(s)}: above ${s.blockAbove}%, no new agent or reviewer fan-out starts until the window resets (${await resetText(h, s)}; only a thread with priority urgent may). Finish and checkpoint your own work, then report with lean_report`
  if (/haiku/i.test(model)) return null
  return `lean-agent: 5h window at ${pctText(s)}: haiku only; ask the user to lift it (config window.throttleAbove). Start the agent with model "haiku" (lean-agent:worker-haiku / lean-agent:reader-haiku, or model: "haiku" on the Agent call), or do the step yourself`
}

// ---- the desk: new / start ------------------------------------------------------------------------------------------------------------
// { refuse } stops the call before anything is created; { warn } is one line the reply carries.
export async function newWorkGate(h: Host, priority: Priority): Promise<{ refuse?: string; warn?: string }> {
  const s = await windowState(h)
  if (s.level === 'ok') return {}
  const reset = await resetText(h, s)
  if (s.tokenCap) return { refuse: `not started: ${tokenCapText(s.tokenCap)}. All new work is held ${await tokenCapEnd(h, s)}: tell the user when. Nothing was created` }
  if (s.level === 'capped') return { refuse: `not started: your 5h cap of ${s.cap}% (window.capFiveHourPct) is reached (window at ${pctText(s)}, ${reset}). All new work is held until the window resets: tell the user when. Nothing was created` }
  if (s.level === 'blocked' && priority !== 'urgent') return { refuse: `not started: the 5h window is at ${pctText(s)} (above window.blockAbove ${s.blockAbove}%, ${reset}). Only priority urgent starts now: tell the user, or wait for the reset. Nothing was created` }
  if (s.level === 'throttled' && priority === 'low') return { refuse: `not started: the 5h window is at ${pctText(s)} (above window.throttleAbove ${s.throttleAbove}%, ${reset}) and this thread has priority low: it waits until the window is below the line or resets. Nothing was created` }
  return { warn: `WARNING 5h window at ${pctText(s)}: throttled (above ${s.throttleAbove}%): this thread's agents run on haiku only until the window drops or resets (${reset}); say so to the user if it matters` }
}

// ---- lean_review prepare: the same window rules before any reviewer is started --------------------------------------------------------------------
// { stop } refuses the prepare (blocked, capped); { note } is a line for the reply (throttled: the reviewer agents must run on haiku, the guard refuses sonnet).
// review.holdWhenThrottled (default true; 1.0.33): a FULL review the throttle would run on haiku, on a diff one haiku pass cannot read (passBytes, reviewarea.ts), is HELD instead of run: such a
// pass reads a part of the diff, the record tool refuses green for it, and the attempt is spent. `confirm` is the user's word ("go": a weaker haiku review, never green); urgent threads are not held.
const holdOn = async (h: Host): Promise<boolean> => {
  const v = await cfgRaw(h, 'review.holdWhenThrottled').catch(() => undefined)
  return !(v === false || v === 'false')
}
export const heldText = (pct: string, above: number, bytes: number, until: string): string =>
  `prepare: HELD: 5h window at ${pct} (above window.throttleAbove ${above}%): only haiku may run now, and one haiku pass reads about ${kb(passBytes())} of this ${kb(bytes)} diff, so it could not reach a green record. The review is held until sonnet is available (the window drops below ${above}%, ${until}) or the user says go (then prepare again with confirm: true for a weaker haiku review that is never green; do NOT confirm on your own). Tell the desk now (lean_report state blocked, or lean_ask with the options "wait until sonnet is available" | "go on with haiku, weaker, never green"); config review.holdWhenThrottled false turns the hold off`
export async function reviewWindowGate(h: Host, thread: string, o: { level?: string; bytes?: number; confirm?: boolean } = {}): Promise<{ stop?: string; note?: string }> {
  const s = await windowState(h)
  if (s.level === 'ok') return {}
  if (s.level === 'throttled' && o.level === 'full' && o.confirm !== true && (o.bytes ?? 0) > passBytes() && (await holdOn(h)) && !(/^t\d+$/.test(thread) && (await threadPriority(h, thread)) === 'urgent')) return { stop: heldText(pctText(s), s.throttleAbove, o.bytes ?? 0, await resetText(h, s)) }
  const urgent = /^t\d+$/.test(thread) && (await threadPriority(h, thread)) === 'urgent'
  if (s.tokenCap) return { stop: `prepare: NOT started: ${tokenCapText(s.tokenCap)}, all new work is held ${await tokenCapEnd(h, s)}. Tell the user; run the review after that` }
  if (s.level === 'capped') return { stop: `prepare: NOT started: 5h window at ${pctText(s)}: your cap of ${s.cap}% (window.capFiveHourPct) is reached, all new work is held until the window resets (${await resetText(h, s)}). Tell the user; run the review after the reset` }
  if (s.level === 'blocked' && !urgent) return { stop: `prepare: NOT started: 5h window at ${pctText(s)}: above ${s.blockAbove}%, no reviewer fan-out starts until the window resets (${await resetText(h, s)}; only a thread with priority urgent may). Tell the user; run the review after the reset` }
  return { note: `5h window at ${pctText(s)}: throttled (above ${s.throttleAbove}%): start the reviewer agent with model "haiku" (an Agent call on sonnet is refused until the window drops, or the user lifts it with window.throttleAbove); it is a weaker review: say so in the record` }
}

// the priority recorded on a thread ('normal' when none)
export async function threadPriority(h: Host, id: string): Promise<Priority> {
  const t = await readJson<{ priority?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${id}/thread.json`, null).catch(() => null)
  return priorityOf(t?.priority)
}
