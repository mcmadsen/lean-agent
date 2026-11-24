// Per-thread context limit and soft budget (1.0.31), by script. `lean_thread limit tN <tokens>` / `lean_thread budget tN <usd>` carry the number in `text` (no new
// field in the tool schema); "off" removes the override. The values live on the thread (thread.json tokenLimit, budgetUsd) and survive every restart.
import { kTokens, limitsOf, OVERRIDE_MAX, OVERRIDE_MIN, overrideOk } from './threadcontext'
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { syncRollup } from './ledger'
import { cfgNum } from './budgetcfg'

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

// "10", "$10", "10.5", "off" -> USD | null (off) | an error text. 0 turns the thread's soft budget off for it.
export function parseUsd(text: unknown): number | null | string {
  const s = String(text ?? '').trim().toLowerCase().replace(/^\$/, '')
  if (!s) return 'budget needs the amount in USD, e.g. 6 or 6.5, 0 for no budget on this thread, or "off" to use config threads.softUsd again'
  if (s === 'off' || s === 'default') return null
  const n = /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN
  if (!Number.isFinite(n) || n > 10_000) return `budget: "${s.slice(0, 20)}" is not an amount in USD (6 or 6.5, 0 = none, or "off")`
  return n
}

// ---- the soft budget of a thread (config threads.softUsd, default 8; thread.json budgetUsd overrides it; 0 = none) ----------------------------------------
// The thread's spend is its lifetime total in the usage ledger (the rollup, per `tN`). At 80% the thread gets ONE nudge and the desk ONE notice; at 100% the thread is told to
// report and stop, and the guard refuses its NEW Agent calls (never an edit in progress: no tool of its own is cut). The state is <thread>/budget.json, written by the desk tick.
export type BLevel = 'ok' | 'near' | 'over'
export const budgetLevel = (spent: number, budget: number): BLevel => (spent >= budget ? 'over' : spent >= budget * 0.8 ? 'near' : 'ok')
const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
// "$6.40/$8"
export const budgetText = (spent: number, budget: number): string => `$${spent.toFixed(2)}/$${money(budget)}`
export const budgetFile = (home: string, id: string) => `${threadsDir(home)}/${id}/budget.json`
export type BudgetRec = { budget: number; near?: number; over?: number } // when each level was announced (ms), for THIS budget value

export const nearNudge = (spent: number, budget: number): string => `[lean-agent] You have used 80% of your budget (${budgetText(spent, budget)}): finish the step you are on, checkpoint (lean_run checkpoint), and report with lean_report. Do not start new work.`
export const overNudge = (spent: number, budget: number): string => `[lean-agent] Your budget is used (${budgetText(spent, budget)}): report now with lean_report (state done, or blocked with what is left) and stop. New Agent calls are refused; nothing already running is cut.`
export const budgetRefusal = (budget: number): string => `lean-agent: this thread's budget of $${money(budget)} is used: no new Agent call. Report with lean_report (done, or blocked with what is left) and stop; the user can raise it with lean_thread budget`

// lifetime USD per thread from the rollup (ledger.ts keeps KEEP_DAYS days)
export async function threadTotals(h: Host): Promise<Record<string, number>> {
  const ro = await syncRollup(h)
  const out: Record<string, number> = {}
  for (const d of Object.values(ro.days)) for (const [id, a] of Object.entries(d.tN ?? {})) if (/^t\d+$/.test(id)) out[id] = (out[id] ?? 0) + (a[0] ?? 0)
  return out
}
// the budget of a thread in USD, or null when it has none (config 0 or the thread's own 0)
export async function budgetOf(h: Host, t: { budgetUsd?: unknown }): Promise<number | null> {
  const own = typeof t.budgetUsd === 'number' && Number.isFinite(t.budgetUsd) && t.budgetUsd >= 0 ? t.budgetUsd : null
  const b = own ?? (await cfgNum(h, 'threads.softUsd')) ?? 8
  return b > 0 ? b : null
}

// `lean_doctor stats`: the live threads at or over 80% of their budget, '' when none (or no budget set)
export async function budgetLine(h: Host): Promise<string> {
  const home = await homeDir(h)
  const totals = await threadTotals(h)
  const rows: string[] = []
  const ids = (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  for (const id of ids) {
    const t = await readJson<{ state?: string; budgetUsd?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null).catch(() => null)
    if (!t || t.state === 'closed') continue
    const b = await budgetOf(h, t)
    if (b === null) continue
    const lvl = budgetLevel(totals[id] ?? 0, b)
    if (lvl !== 'ok') rows.push(`${id} ${budgetText(totals[id] ?? 0, b)}${lvl === 'over' ? '!' : ''}`)
  }
  return rows.length ? `thread budgets (80% or more used; threads.softUsd ${(await cfgNum(h, 'threads.softUsd')) ?? 8}): ${rows.join(', ')}` : ''
}
