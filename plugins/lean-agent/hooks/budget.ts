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
  await syncCache(h, home, row.ts, row)
  return row
}

// Daily sums per role, kept in the mod's store with the ledger byte offset they cover. Writers (other threads' sessions)
// only append, so a cache whose offset is behind the file size is topped up from the ledger tail: no row is lost to a
// concurrent read-modify-write, and the whole ledger is read again only when the day changes or the file shrank.
const enc = new TextEncoder()
const CACHE = 'ledger-today'
type Cache = { day: string; byRole: Record<string, number>; offset?: number }
async function cache(h: Host): Promise<Cache | null> {
  const c = (await h.store.get(CACHE).catch(() => null)) as Cache | null
  return c && typeof c.day === 'string' && c.byRole && typeof c.byRole === 'object' ? c : null
}
async function ledgerSize(h: Host, home: string): Promise<number | null> {
  const r = await h.process.run(['wc', '-c', ledgerFile(home)]).catch(() => null)
  const n = r && r.exitCode === 0 ? parseInt(r.stdout.trim(), 10) : NaN
  return Number.isFinite(n) ? n : null
}
function addRows(c: Cache, text: string): number {
  const end = text.lastIndexOf('\n') + 1 // a torn last line waits for the next sync
  for (const line of text.slice(0, end).split('\n')) {
    try {
      const r = JSON.parse(line) as Row
      if (day(r.ts) === c.day) c.byRole[r.role] = (c.byRole[r.role] ?? 0) + (r.usd || 0)
    } catch {
      /* damaged line */
    }
  }
  return enc.encode(text.slice(0, end)).length
}
async function readLedger(h: Host, home: string): Promise<string> {
  return String((await h.fs.read(ledgerFile(home)).catch(() => '')) ?? '')
}
async function syncCache(h: Host, home: string, now: number, own?: Row): Promise<Cache> {
  const today = day(now)
  let c = await cache(h)
  const size = await ledgerSize(h, home)
  if (c && c.day === today && typeof c.offset === 'number' && size !== null && size >= c.offset) {
    if (size === c.offset) return c
    const ownLen = own ? enc.encode(JSON.stringify(own)).length + 1 : -1
    if (own && size === c.offset + ownLen) {
      c.byRole[own.role] = (c.byRole[own.role] ?? 0) + (own.usd || 0) // only our row is new
      c.offset = size
    } else {
      c.offset += addRows(c, new TextDecoder().decode(enc.encode(await readLedger(h, home)).subarray(c.offset)))
    }
  } else {
    c = { day: today, byRole: {}, offset: 0 }
    c.offset = addRows(c, size === null ? '' : await readLedger(h, home))
  }
  await h.store.set(CACHE, c).catch(() => undefined)
  return c
}

export async function spentToday(h: Host, role?: string): Promise<number> {
  const home = await homeDir(h)
  const c = await syncCache(h, home, await h.clock.now())
  return role ? c.byRole[role] ?? 0 : Object.values(c.byRole).reduce((a, b) => a + b, 0)
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
