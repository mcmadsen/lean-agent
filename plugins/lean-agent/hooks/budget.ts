// Budgets and the ledger (design 2.7). Every model request of a turn (main or subagent) is priced from its usage and
// appended to ledger.jsonl; caps come from config.json. No verified plan-window source exists (R6), so the budget is
// cost-only: a daily USD cap per role and an optional cap per worker.
import { appendJsonl, homeDir, leanDir, readJson, readJsonl } from './state'
import type { Host } from './state'

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export type Price = { in: number; out: number; cacheRead: number; cacheWrite: number } // USD per million tokens
// Public list prices; the family is matched by name so new model ids price like their family.
export const PRICES: Record<string, Price> = {
  haiku: { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}
export function priceOf(model: string): Price {
  const m = String(model ?? '').toLowerCase()
  return PRICES[Object.keys(PRICES).find(k => m.includes(k)) ?? 'sonnet']
}
export function costUsd(model: string, u: Usage | null | undefined): number {
  if (!u) return 0
  const p = priceOf(model)
  const usd = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
  return Math.round(usd * 1e6) / 1e6
}

export type Config = { dailyCapUsd?: { desk?: number; thread?: number; plain?: number }; workerCapUsd?: number; workerCaps?: Record<string, number> }
export type Row = { ts: number; role: string; tN?: string; agentId?: string; agent?: string; model: string; in: number; out: number; cache_read: number; cache_write: number; usd: number }

export const ledgerFile = (home: string) => `${leanDir(home)}/ledger.jsonl`
export const readConfig = (h: Host, home: string) => readJson<Config>(h, `${leanDir(home)}/config.json`, {})
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)

export async function record(h: Host, ctx: { role: string; tN?: string; agentId?: string; agent?: string }, model: string, u: Usage | null | undefined): Promise<Row | null> {
  if (!u) return null
  const home = await homeDir(h)
  const row: Row = {
    ts: await h.clock.now(), ...ctx, model,
    in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0,
    usd: costUsd(model, u),
  }
  await appendJsonl(h, ledgerFile(home), row)
  return row
}

export async function spentToday(h: Host, role?: string): Promise<number> {
  const home = await homeDir(h)
  const today = day(await h.clock.now())
  const rows = await readJsonl<Row>(h, ledgerFile(home))
  return rows.filter(r => day(r.ts) === today && (!role || r.role === role)).reduce((s, r) => s + (r.usd || 0), 0)
}

// A reason to refuse the next request, or null. `spent` is what this worker has used so far.
export async function overBudget(h: Host, role: string, agent: { type?: string; spent: number; cap?: number } | null): Promise<string | null> {
  const home = await homeDir(h)
  const cfg = await readConfig(h, home)
  if (agent) {
    const cap = agent.cap ?? cfg.workerCaps?.[agent.type ?? ''] ?? cfg.workerCapUsd
    if (cap !== undefined && agent.spent >= cap) return `lean-agent: this worker used $${agent.spent.toFixed(2)} of its $${cap.toFixed(2)} budget; stop and report what is done and what is left`
  }
  const cap = cfg.dailyCapUsd?.[role as 'desk']
  if (cap !== undefined) {
    const s = await spentToday(h, role)
    if (s >= cap) return `lean-agent: the daily $${cap.toFixed(2)} budget for ${role} sessions is used ($${s.toFixed(2)}); raise dailyCapUsd in config.json to continue`
  }
  return null
}

export function summarize(rows: Row[], since = 0): { total: number; byModel: Record<string, number>; byAgent: Record<string, number>; byThread: Record<string, number> } {
  const out = { total: 0, byModel: {} as Record<string, number>, byAgent: {} as Record<string, number>, byThread: {} as Record<string, number> }
  for (const r of rows) {
    if (r.ts < since) continue
    out.total += r.usd
    out.byModel[r.model] = (out.byModel[r.model] ?? 0) + r.usd
    const a = r.agent ?? 'main'
    out.byAgent[a] = (out.byAgent[a] ?? 0) + r.usd
    const t = r.tN ?? r.role
    out.byThread[t] = (out.byThread[t] ?? 0) + r.usd
  }
  return out
}
