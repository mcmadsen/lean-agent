// Threads that run an older plugin than the installed one (1.0.35; the doctor row of skew.ts says WHO, this says what to do about it).
// config threads.restartOlder:
//   ask  (default) the Health row and `lean_doctor restart-older` offer ONE step: "Restart N older threads" (a new session from the handover,
//        by script, through the same restart the context limit uses); the user's press restarts the idle ones, a parked thread with a session
//        too (the restart reopens it, as the pane's Restart does)
//   auto the same restart by itself, desk timer: only a thread that is open and not working (idle or done), never a parked one (it was parked on
//        purpose), never a closed one, at most once per thread per installed version, never in the first 2 minutes after an update (a restart
//        storm), ONE desk notice for the batch
//   off  only the row
// A thread that is working is never touched: it is listed ("t3 is working: restarted when it goes idle") and, in auto, restarted by a later tick.
// A closed (or closing) thread never appears here. A thread that waits on an open prompt is listed, not restarted (the restart would drop it).
import { compareVersions, installedVersion, runningOf } from './skew'
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { isWorking, leanThread, listAgents } from './threads'
import type { AgentRow, Out } from './threads'

export type RestartOlderMode = 'ask' | 'auto' | 'off'
export const AFTER_UPDATE_MS = 120_000 // auto: nothing in the first 2 minutes after the installed version changed
export const stateFile = (home: string) => `${leanDir(home)}/olderrestart.json`
type St = { version?: string; seen?: number; done?: string[] } // the installed version the desk last saw, when, the threads already restarted for it

export async function restartOlderMode(h: Host, home: string): Promise<RestartOlderMode> {
  const cfg = await readJson<any>(h, `${leanDir(home)}/config.json`, {})
  const v = cfg?.['threads.restartOlder'] ?? cfg?.threads?.restartOlder
  return v === 'auto' || v === 'off' || v === 'ask' ? v : 'ask'
}

export type Cand = { id: string; run: string; installed: string; parked: boolean; finished: boolean; sid: string }
// the open threads (and the parked ones with a session) whose recorded session runs an older plugin than the installed one; closed and closing never
export async function olderCandidates(h: Host, root: string): Promise<Cand[]> {
  const installed = await installedVersion(h, root)
  if (!installed) return []
  const dir = threadsDir(await homeDir(h))
  const out: Cand[] = []
  for (const e of await h.fs.list(dir).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<{ state?: string; sid?: string; running?: unknown; finished?: number } | null>(h, `${dir}/${e.name}/thread.json`, null)
    if (!t || (t.state !== 'open' && t.state !== 'parked') || !t.sid) continue
    const run = runningOf(t)
    if (run && compareVersions(run, installed) < 0) out.push({ id: e.name, run, installed, parked: t.state === 'parked', finished: !!t.finished, sid: t.sid })
  }
  return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

export type Plan = { go: Cand[]; skip: { id: string; why: string }[] }
// who is restarted now and who is listed with the reason; `rows`: claude agents (null = the listing failed: nothing is restarted on a guess)
export function planOf(cands: Cand[], rows: AgentRow[] | null, o: { auto: boolean; done?: string[] }): Plan {
  const plan: Plan = { go: [], skip: [] }
  if (!rows) return plan
  for (const c of cands) {
    const row = rows.find(a => a.sid === c.sid)
    if (o.auto && (c.parked || c.finished)) continue // parked on purpose, or finished (a restart would start new work on it): only the user's press does that
    if (o.auto && o.done?.includes(c.id)) continue // once per thread per installed version
    // (a prompt nobody answers is judged first: the engine lists such a session with a state word that counts as running)
    if (row && (row.waitingFor || row.state === 'blocked')) plan.skip.push({ id: c.id, why: `${c.id} waits for you (an open prompt): restart it from its card when you have answered` })
    else if (row && isWorking(row)) plan.skip.push({ id: c.id, why: `${c.id} is working: restarted when it goes idle` })
    else plan.go.push(c)
  }
  return plan
}

export type RestartDeps = {
  agents: () => Promise<AgentRow[] | null>
  restart: (id: string, why: string, parked: boolean) => Promise<Out> // auto-restart for an open thread, restart for a parked one (never a closed one)
}
// the real restart: auto-restart for an open thread (never a closed one; a working one only with force, which is never given here), restart for a parked one
export const olderDeps = (h: Host, root: string): RestartDeps => ({
  agents: () => listAgents(h),
  restart: (id, why, parked) => leanThread(h, root, parked ? { action: 'restart', tN: id } : { action: 'auto-restart', tN: id, reason: why, force: false }),
})
const whyOf = (c: Cand) => `Its session runs the older plugin ${c.run}; restarted by script from its handover on the installed ${c.installed}.`
const names = (cs: Cand[]) => cs.map(c => `${c.id} (was ${c.run})`).join(', ')

const rd = async (h: Host, home: string): Promise<St> => {
  const s = await readJson<St | null>(h, stateFile(home), null)
  return s && typeof s === 'object' ? s : {}
}
const markDone = async (h: Host, home: string, installed: string, ids: string[]): Promise<void> => {
  const s = await rd(h, home)
  const done = s.version === installed ? (s.done ?? []) : []
  await writeJson(h, stateFile(home), { version: installed, seen: s.version === installed ? (s.seen ?? 0) : await h.clock.now(), done: [...new Set([...done, ...ids])] } satisfies St)
}

// the user's step (the pane button, lean_doctor restart-older): restarts what the plan allows, says what it left and why
export async function restartOlderNow(h: Host, root: string, deps: RestartDeps): Promise<{ text: string; restarted: string[]; ok: boolean }> {
  const mode = await restartOlderMode(h, await homeDir(h))
  if (mode === 'off') return { text: 'threads.restartOlder is off: no restart offered (set it to ask or auto)', restarted: [], ok: false }
  const cands = await olderCandidates(h, root)
  if (!cands.length) return { text: 'no thread runs an older plugin than the installed one', restarted: [], ok: true }
  const rows = await deps.agents()
  if (!rows) return { text: 'cannot list sessions (claude agents failed): nothing restarted', restarted: [], ok: false }
  const plan = planOf(cands, rows, { auto: false })
  const restarted: string[] = []
  const failed: string[] = []
  for (const c of plan.go) {
    const r = await deps.restart(c.id, whyOf(c), c.parked).catch((e: unknown) => ({ ok: false, text: String((e as Error)?.message ?? e) }) as Out)
    if (r.ok) restarted.push(c.id)
    else failed.push(`${c.id}: ${r.text.slice(0, 120)}`)
  }
  if (restarted.length) await markDone(h, await homeDir(h), cands[0]!.installed, restarted)
  const text = [restarted.length ? `restarted ${restarted.length} older thread${restarted.length === 1 ? '' : 's'} from their handovers: ${names(plan.go.filter(c => restarted.includes(c.id)))}` : 'restarted none', ...plan.skip.map(s => s.why), ...failed.map(f => `not restarted, ${f}`)].join('; ')
  return { text, restarted, ok: failed.length === 0 }
}

// the desk's timer (auto only): ONE notice per batch
export async function olderTick(h: Host, root: string, deps: RestartDeps): Promise<{ id: string; text: string }[]> {
  const home = await homeDir(h)
  if ((await restartOlderMode(h, home)) !== 'auto') return []
  const installed = await installedVersion(h, root)
  if (!installed) return []
  const now = await h.clock.now()
  const s = await rd(h, home)
  if (s.version !== installed) {
    await writeJson(h, stateFile(home), { version: installed, seen: now, done: [] } satisfies St) // a new installed version: the clock of the first 2 minutes starts here
    return []
  }
  if (now - (s.seen ?? 0) < AFTER_UPDATE_MS) return []
  // (only what the tick may restart is looked for: no `claude agents` call every 30 s for threads that are done, parked or already tried for this version)
  const cands = (await olderCandidates(h, root)).filter(c => !c.parked && !c.finished && !(s.done ?? []).includes(c.id))
  if (!cands.length) return []
  const plan = planOf(cands, await deps.agents(), { auto: true, done: s.done })
  if (!plan.go.length) return []
  const restarted: Cand[] = []
  await markDone(h, home, installed, plan.go.map(c => c.id)) // before the restarts: a failed one is not tried again for this version (no loop)
  for (const c of plan.go) {
    const r = await deps.restart(c.id, whyOf(c), false).catch(() => ({ ok: false, text: '' }) as Out)
    if (r.ok) restarted.push(c)
  }
  if (!restarted.length) return []
  return [{ id: 'older', text: `restarted ${restarted.length} thread${restarted.length === 1 ? '' : 's'} that ran an older plugin than the installed ${installed}: ${names(restarted)} (new sessions from their handovers; threads.restartOlder auto)` }]
}

// the doctor row's words for the config (appended to the FIX row of skew.ts)
export const modeAdvice = (mode: RestartOlderMode, n: number): string =>
  mode === 'ask' ? `Restart ${n} older thread${n === 1 ? '' : 's'}: one press in the Health card, or lean_doctor restart-older (idle ones only; a working one is listed and left)` : mode === 'auto' ? 'lean-agent restarts them by itself when they are idle (threads.restartOlder auto), once per thread per installed version' : ''
export const restartLabel = (n: number): string => `Restart ${n} older thread${n === 1 ? '' : 's'}`
// the number of threads an older-plugin doctor row names (skew.ts skewRow: "N threads run an older plugin ..." or "thread tN running ...")
export const olderRowCount = (row: string): number => (/^(\d+) threads run an older plugin/.exec(row)?.[1] ? Number(/^(\d+) threads run an older plugin/.exec(row)![1]) : /^thread t\d+ running /.test(row) ? 1 : 0)
