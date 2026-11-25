// Per-thread context limit and soft budget (1.0.31), by script; the budget is in usage tokens since 1.0.34 (usage.ts). `lean_thread limit tN <tokens>` / `lean_thread budget tN <tokens>`
// carry the number in `text` (no new field in the tool schema); "off" removes the override. The values live on the thread (thread.json tokenLimit, budgetTokens) and survive every restart.
import { kTokens, limitsOf, OVERRIDE_MAX, OVERRIDE_MIN, overrideOk } from './threadcontext'
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { cfgNum } from './budgetcfg'
import { parseTokenCount, budgetText as fmtBudget, fmtTokens } from './formatusage'
import { threadTotals } from './usage'
export { threadTotals }

// "90000", "90k", "90 k", "off" -> tokens | null (off) | an error text
export function parseTokens(text: unknown): number | null | string {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) return `limit needs the number of tokens (${kTokens(OVERRIDE_MIN)} to ${kTokens(OVERRIDE_MAX)}), e.g. 90000 or 90k, or "off" to remove the override`
  if (s === 'off' || s === 'none' || s === 'default') return null
  const m = /^(\d+(?:\.\d+)?)\s*(k?)$/.exec(s)
  const n = m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) : NaN
  if (!Number.isFinite(n)) return `limit: "${s.slice(0, 20)}" is not a number of tokens (90000 or 90k, or "off")`
  if (!overrideOk(n)) return `limit: ${n} tokens is outside ${kTokens(OVERRIDE_MIN)}-${kTokens(OVERRIDE_MAX)} (a smaller limit restarts every few turns, a larger one is what the restart limit is for)`
  return n
}
export function limitReply(id: string, tokens: number | null, cfg: unknown): string {
  if (tokens === null) return `${id}: own context limit removed; the shared limit applies again (${kTokens(limitsOf(cfg as never).limit)} hard, soft checkpoint ${kTokens(limitsOf(cfg as never).warn)})`
  const l = limitsOf(cfg as never, tokens)
  return `${id}: own context limit ${kTokens(l.limit)} (hard); it is told to checkpoint at ${kTokens(l.warn)} (soft). Kept over every restart; "limit ${id} off" removes it`
}

// "2m", "500k", "1.5M", "2000000", "off" -> usage tokens | null (off: config threads.softTokens again) | an error text. 0 turns the thread's soft budget off for it.
export function parseBudget(text: unknown): number | null | string {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) return 'budget needs the amount in usage tokens, e.g. 2m or 500k, 0 for no budget on this thread, or "off" to use config threads.softTokens again'
  if (s === 'off' || s === 'default') return null
  const n = parseTokenCount(s)
  if (n === null || n > 1e12) return `budget: "${s.slice(0, 20)}" is not an amount of usage tokens (2m or 500k, 0 = none, or "off")`
  return n
}

// ---- the soft budget of a thread (config threads.softTokens, none by default; thread.json budgetTokens overrides it; 0 = none) -------------------------------
// The thread's usage is ITS OWN lifetime total in usage tokens (usage.ts threadTotals: the rows of its own sessions, restarts and subagents, from its creation on; never the desk's,
// never another thread's, never a shared counter). At 80% the thread gets ONE nudge and the desk ONE notice; at 100% the DESK gets one notice (raise / park / continue) and the thread
// goes on: the soft budget never stops a thread by itself. A real stop is the separate hard cap (config threads.hardTokens, none by default): at it the thread is told to report and
// stop, and the guard refuses its NEW Agent calls (never an edit in progress: no tool of its own is cut). The state is <thread>/budget.json, written by the desk tick.
export type BLevel = 'ok' | 'near' | 'over'
export const budgetLevel = (spent: number, budget: number): BLevel => (spent >= budget ? 'over' : spent >= budget * 0.8 ? 'near' : 'ok')
// "6.4k/8k tokens"
export const budgetText = (spent: number, budget: number): string => `${fmtBudget(spent, budget)} tokens`
export const budgetFile = (home: string, id: string) => `${threadsDir(home)}/${id}/budget.json`
// when each level was announced (ms), for THIS budget value; hard / hardTokens: the hard cap was reached (the guard refuses new Agent calls while it is set)
export type BudgetRec = { budget: number; near?: number; over?: number; hard?: number; hardTokens?: number }

export const nearNudge = (spent: number, budget: number): string => `[lean-agent] You have used 80% of your soft budget (${budgetText(spent, budget)}): this is a nudge, not a stop. Keep going on the cheapest path (a script before a model, haiku workers, no repeat reads) and report with lean_report at the next natural point.`
export const overNote = (id: string, spent: number, budget: number): string => `${id}: soft budget ${budgetText(spent, budget)} passed: the thread goes on. Raise it (budget ${id} <tokens>), park it (thread park ${id}), or leave it (config threads.hardTokens sets a real stop)`
export const hardNudge = (spent: number, hard: number): string => `[lean-agent] Your hard budget cap is reached (${budgetText(spent, hard)}, config threads.hardTokens): report now with lean_report (state done, or blocked with what is left) and stop. New Agent calls are refused; nothing already running is cut.`
export const budgetRefusal = (hard: number): string => `lean-agent: this thread's hard cap of ${fmtTokens(hard)} usage tokens (config threads.hardTokens) is used: no new Agent call. Report with lean_report (done, or blocked with what is left) and stop; the user can raise threads.hardTokens`
// the hard cap in usage tokens, or null (the default: none; 0 = none)
export async function hardOf(h: Host): Promise<number | null> {
  const n = await cfgNum(h, 'threads.hardTokens')
  return n !== null && n > 0 ? n : null
}
// the budget of a thread in usage tokens, or null when it has none (the default; config 0 or the thread's own 0)
export async function budgetOf(h: Host, t: { budgetTokens?: unknown }): Promise<number | null> {
  const own = typeof t.budgetTokens === 'number' && Number.isFinite(t.budgetTokens) && t.budgetTokens >= 0 ? t.budgetTokens : null
  const b = own ?? (await cfgNum(h, 'threads.softTokens')) ?? 0
  return b > 0 ? b : null
}

// `lean_doctor stats`: the live threads at or over 80% of their budget, '' when none (or no budget set)
export async function budgetLine(h: Host): Promise<string> {
  const home = await homeDir(h)
  const totals = await threadTotals(h)
  const rows: string[] = []
  const ids = (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  for (const id of ids) {
    const t = await readJson<{ state?: string; budgetTokens?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null).catch(() => null)
    if (!t || t.state === 'closed') continue
    const b = await budgetOf(h, t)
    if (b === null) continue
    const lvl = budgetLevel(totals[id] ?? 0, b)
    if (lvl !== 'ok') rows.push(`${id} ${budgetText(totals[id] ?? 0, b)}${lvl === 'over' ? '!' : ''}`)
  }
  const soft = await cfgNum(h, 'threads.softTokens')
  return rows.length ? `thread budgets (80% or more used${soft ? `; threads.softTokens ${fmtTokens(soft)}` : ''}): ${rows.join(', ')}` : ''
}
