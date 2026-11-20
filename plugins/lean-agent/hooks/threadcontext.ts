// A thread's context size and what follows from it ("restart at turn end"). Cache reads of a long conversation dominate a thread's cost,
// so a thread's context is capped: the thread's own mod records the size at the END of each turn (register.tsx, `session.measure`, which
// the engine raises after every main-thread turn; the figure is `$.session.usage()` -> `context.tokens`, the input tokens the last request
// was answered over) into the thread's folder (context.json: tokens, at, sid), written atomically. Nothing ever acts mid-turn: when the
// NEXT message for an idle or done session arrives (send, wake, resume, the chaser) and the recorded size is over `threadTokens`, the desk
// code starts a fresh session with the handover instead of resuming (threads.ts wake). A working session is never touched.
//
// Config (config.json), both numbers of tokens; a value that is not a finite number of at least MIN_TOKENS is ignored (the default applies):
//   threadTokens      default 120000: the limit; a recorded size ABOVE it restarts at the next message (equal is still fine)
//   threadWarnTokens  default 100000 (83% of the limit, to the nearest 1000): above it the pane shows the size in yellow
// A size is only believed for the session it was recorded by (`sid`): an older session's record is ignored, and no record at all (an older
// thread, a failed write) counts as "unknown", never as over the limit: a session is not restarted on a guess.
// Keep mode (thread.json `keep: true`): a thread that reported done is RESUMED for follow-ups until its context passes the limit
// (without keep a done thread's next message starts a new session, finish.ts). Estimates only: the price table is budget.ts's, and no
// model computes anything.
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig, priceOf } from './budget'

export const DEFAULT_LIMIT = 120_000
export const DEFAULT_WARN = 100_000
export const WARN_SHARE = 0.83
export const MIN_TOKENS = 10_000 // a smaller configured value is ignored (a restart every few turns would be worse than none)

export type Limits = { limit: number; warn: number }
const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_TOKENS

// the two limits from a config object (pure); the warn level never exceeds the limit
export function limitsOf(cfg: { threadTokens?: unknown; threadWarnTokens?: unknown } | null | undefined): Limits {
  const limit = valid(cfg?.threadTokens) ? Math.floor(cfg!.threadTokens as number) : DEFAULT_LIMIT
  const asked = valid(cfg?.threadWarnTokens) ? Math.floor(cfg!.threadWarnTokens as number) : Math.round((limit * WARN_SHARE) / 1000) * 1000 // (83% of 120000 = 100000)
  return { limit, warn: Math.min(asked, limit) }
}
export async function threadLimits(h: Host): Promise<Limits> {
  return limitsOf((await readConfig(h, await homeDir(h)).catch(() => null)) as any)
}

// ---- the record: <thread folder>/context.json {tokens, at, sid} ----
export type ContextRec = { tokens: number; at: number; sid: string }
export const contextFile = (home: string, id: string) => `${threadsDir(home)}/${id}/context.json`

// Written by the thread's own mod at the end of a turn; false = nothing written (no usable size or session id), never throws.
export async function recordContext(h: Host, id: string, sid: string, tokens: unknown): Promise<boolean> {
  if (!/^t\d+$/.test(id) || !sid || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return false
  try {
    const rec: ContextRec = { tokens: Math.round(tokens), at: await h.clock.now(), sid }
    await writeJson(h, contextFile(await homeDir(h), id), rec) // atomic: tmp file + mv
    return true
  } catch {
    return false
  }
}

// The recorded size of the thread's CURRENT session, or null (no record, damaged, or recorded by another session id).
export async function readContext(h: Host, home: string, t: { id: string; sid?: string }): Promise<ContextRec | null> {
  if (!t.sid) return null
  const r = await readJson<Partial<ContextRec> | null>(h, contextFile(home, t.id), null)
  if (!r || typeof r !== 'object' || r.sid !== t.sid || typeof r.tokens !== 'number' || !Number.isFinite(r.tokens) || r.tokens < 0) return null
  return { tokens: r.tokens, at: typeof r.at === 'number' ? r.at : 0, sid: r.sid }
}

// ---- level and text ----
export type Level = 'unknown' | 'ok' | 'warn' | 'over'
export const levelOf = (tokens: number | null | undefined, l: Limits): Level =>
  typeof tokens !== 'number' ? 'unknown' : tokens > l.limit ? 'over' : tokens > l.warn ? 'warn' : 'ok'
export const kTokens = (n: number) => `${Math.round(n / 1000)}k`
// "ctx 108k/120k" | "ctx unknown"
export const ctxText = (tokens: number | null | undefined, l: Limits) => (typeof tokens === 'number' ? `ctx ${kTokens(tokens)}/${kTokens(l.limit)}` : 'ctx unknown')

// What the views read: the text, the level (dim under the warn level, yellow above it, red over the limit) and the size
export type CtxView = { text: string; level: Level; tokens?: number }
export function ctxView(rec: ContextRec | null, l: Limits): CtxView {
  const tokens = rec?.tokens
  return { text: ctxText(tokens, l), level: levelOf(tokens, l), ...(typeof tokens === 'number' ? { tokens } : {}) }
}
export async function ctxOf(h: Host, home: string, t: { id: string; sid?: string }, l?: Limits): Promise<CtxView> {
  return ctxView(await readContext(h, home, t), l ?? (await threadLimits(h)))
}

// ---- the decision ----
// idle: the session's turn ended (a working one is never decided about: the next message queues, as before). `done`: its last report is
// done or it was finished. `keep`: the thread's keep mode. `tokens`: the recorded size of this session (null = unknown, never over).
//   resume  - the session continues; `why` says which rule ('keep' = a done thread resumed in keep mode, '' = the plain resume)
//   fresh   - a NEW session with the handover; `cause`: 'context' (over the limit) | 'done' (done, not in keep mode)
export type Decision = { act: 'resume'; why: 'keep' | '' } | { act: 'fresh'; cause: 'context' | 'done' }
export function decide(o: { done: boolean; keep: boolean; tokens: number | null; limit: number }): Decision {
  if (typeof o.tokens === 'number' && o.tokens > o.limit) return { act: 'fresh', cause: 'context' } // (also when keep is on)
  if (o.done && !o.keep) return { act: 'fresh', cause: 'done' }
  return { act: 'resume', why: o.done ? 'keep' : '' }
}

const usd = (n: number) => `~$${Math.max(0.01, n).toFixed(2)}`
// "cached re-read ~$0.04": the recorded context read from the cache once, at the model's cache-read price (an estimate)
export const rereadUsd = (tokens: number, model: string) => (tokens * priceOf(model).cacheRead) / 1e6

// one phrase for the reply of a resume: which rule applied and what it costs (estimates)
export function resumedText(why: 'keep' | '', tokens: number | null, model: string): string {
  const label = why === 'keep' ? 'resumed (keep mode)' : 'resumed'
  return typeof tokens === 'number' ? `${label}: context ${kTokens(tokens)}, cached re-read ${usd(rereadUsd(tokens, model))} (estimate)` : `${label}: context size unknown`
}
// the head of the reply of a fresh session that replaced a resume: why (the start text then says the handover size and its cost)
export const overText = (tokens: number, limit: number) => `context was ${kTokens(tokens)} (limit ${kTokens(limit)}): started a new session with the handover (old conversation kept read-only, not resumed)`
export const notKeepText = 'new session (not in keep mode)'

// keep mode on or off, as said back to the caller
export const keepText = (id: string, on: boolean, l: Limits) =>
  on
    ? `${id} keep mode on: after it reports done, follow-up messages resume the same session until its context passes ${kTokens(l.limit)} tokens, then a new session starts with the handover`
    : `${id} keep mode off: after it reports done, its next message starts a new session (the context limit of ${kTokens(l.limit)} tokens still applies)`
