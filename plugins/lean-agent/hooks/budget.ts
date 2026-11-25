// The ledger of usage (design 2.7). Every model request of a turn (main or subagent) is appended to ledger.jsonl with its usage (input, output, cache read and
// write tokens) and, as an ESTIMATE at public list prices, its cost in USD. Since 1.0.33 nothing is capped or shown in USD: budgets, cards and stats count usage
// tokens (usage.ts); the USD estimate stays in the ledger only for the optional `stats.showUsd` line of `lean_doctor stats`.
import { appendJsonl, homeDir, leanDir } from './state'
import { LEDGER } from './ledger'
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
  return PRICES[Object.keys(PRICES).find(k => m.includes(k)) ?? 'sonnet'] as Price
}
export function costUsd(model: string, u: Usage | null | undefined): number {
  if (!u) return 0
  const p = priceOf(model)
  const usd = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
  return Math.round(usd * 1e6) / 1e6
}

export type Config = { attribution?: boolean; learn?: { maxExplorers?: number }; desk?: { autoRelay?: boolean; autoResume?: boolean; reportChars?: number /* reportdigest.ts: characters of a thread report the desk gets (default 400; 0 = the full text) */; autoRestart?: boolean /* deskcompact.ts: the mod opens the new desk itself when it must be restarted (default true; false = the Restart desk button only) */ }; deskTokens?: number; notify?: { toast?: boolean; sound?: boolean } /* notify.ts: toasts for the desk (default on); sound is accepted, no clip is bundled */; toolResultChars?: number; threadToolResultChars?: number /* cap.ts: a thread's own results (default 8000) */; refusals?: { repeat?: number } /* refusals.ts: how often one refusal pattern repeats before the doctor names it (default 3) */; checkpoint?: { deskTokens?: number } /* the 1.0.6 key: deskTokens is still read from it */ }
// effort / tmodel: a thread's row carries the effort and the model the thread was started with (thread.json); `model` is what answered
// fresh: the first main-loop request of a thread session (what a restart costs before any work; stats.ts threadSpendParts)
// usd: the estimate at list prices (stats.showUsd); tN is set ONLY for a thread's own session and its subagents (register.tsx), never for the desk or a plain session
export type Row = { ts: number; role: string; tN?: string; agentId?: string; agent?: string; effort?: string; tmodel?: string; fresh?: true; model: string; in: number; out: number; cache_read: number; cache_write: number; usd: number }

export const ledgerFile = (home: string) => `${leanDir(home)}/${LEDGER}`
export { readConfig } from './budgetcfg'

export async function record(h: Host, ctx: { role: string; tN?: string; agentId?: string; agent?: string; effort?: string; tmodel?: string; fresh?: true }, model: string, u: Usage | null | undefined): Promise<Row | null> {
  if (!u) return null
  const home = await homeDir(h)
  const row: Row = {
    ts: await h.clock.now(), ...ctx, model,
    in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0,
    usd: costUsd(model, u),
  }
  const line: any = { ...row } // zero token counts are left out: a row is about 100 bytes shorter, every reader takes a missing number as 0
  for (const k of ['in', 'out', 'cache_read', 'cache_write'] as const) if (!line[k]) delete line[k]
  await appendJsonl(h, ledgerFile(home), line)
  return row
}

export function summarize(rows: Row[], since = 0): { total: number; byModel: Record<string, number>; byAgent: Record<string, number>; byThread: Record<string, number> } {
  const out = { total: 0, byModel: {} as Record<string, number>, byAgent: {} as Record<string, number>, byThread: {} as Record<string, number> }
  for (const r of rows) {
    if (r.ts < since) continue
    out.total += r.usd
    out.byModel[r.model] = (out.byModel[r.model] ?? 0) + r.usd
    const a = (r.agent ?? 'main').replace(/^lean-agent:/, '') // both spellings of an agent type are one line
    out.byAgent[a] = (out.byAgent[a] ?? 0) + r.usd
    const t = r.tN ?? r.role
    out.byThread[t] = (out.byThread[t] ?? 0) + r.usd
  }
  return out
}
