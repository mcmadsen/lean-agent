// A thread's context size and what follows from it ("restart at turn end"). Cache reads of a long conversation dominate a thread's cost,
// so a thread's context is capped: the thread's own mod records the size at the END of each turn (register.tsx, `session.measure`, which
// the engine raises after every main-thread turn; the figure is `$.session.usage()` -> `context.tokens`, the input tokens the last request
// was answered over) into the thread's folder (context.json: tokens, at, sid), written atomically. Nothing ever acts mid-turn: when the
// NEXT message for an idle or done session arrives (send, wake, resume, the chaser) and the recorded size is over `threadTokens`, the desk
// code starts a fresh session with the handover instead of resuming (threads.ts wake). A working session is never touched.
//
// Config (config.json), both numbers of tokens; a value that is not a finite number of at least MIN_TOKENS is ignored (the default applies):
//   threadTokens      default 200000 (1.0.35; 120000 before): the limit; a recorded size ABOVE it restarts at the next message (equal is still fine). The EFFECTIVE limit
//                     is never more than 90% of the model's real context window once the session reported it (context.json `window`): 180000 on a 200k window
//   threads.softCheckpointTokens  default 80% of the effective limit (160000 of 200000): a work thread this big is told once to checkpoint
//   threadWarnTokens  default: the soft checkpoint size, at most 83% of the limit: above it the pane shows the size in yellow
// A size is only believed for the session it was recorded by (`sid`): an older session's record is ignored, and no record at all (an older
// thread, a failed write) counts as "unknown", never as over the limit: a session is not restarted on a guess.
// Keep mode (thread.json `keep: true`): a thread that reported done is RESUMED for follow-ups until its context passes the limit
// (without keep a done thread's next message starts a new session, finish.ts). Estimates only: the price table is budget.ts's, and no
// model computes anything.
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { usageTokens } from './usage'
import { fmtTokens } from './formatusage'
import { readParts } from './ctxparts'
import { effectiveLimit } from './deskcompact'

// ONE value (1.0.35): the thread limit is 200k (it was 120k; the user chose it, like the desk's); everything else is a share of the EFFECTIVE limit, which is the
// configured one but never more than 90% of the model's real context window when the engine reported it (the desk's rule since 1.0.33: deskcompact.ts effectiveLimit;
// a 200k setting on a 200k window is 180k). Higher limit = each turn re-reads a bigger cached context: `threadTokens` lowers it again.
export const DEFAULT_LIMIT = 200_000
export const SOFT_SHARE = 0.8 // the soft checkpoint (threads.softCheckpointTokens) defaults to this share of the effective limit: 160k of 200k, 144k of 180k
export const WARN_SHARE = 0.83 // the warn level (threadWarnTokens) is the soft checkpoint, never above this share of the effective limit
export const softOf = (limit: number): number => Math.floor((limit * SOFT_SHARE) / 1000) * 1000
export const MIN_TOKENS = 10_000 // a smaller configured value is ignored (a restart every few turns would be worse than none)
export const OVERRIDE_MIN = 40_000 // lean_thread limit tN <tokens>: the range one thread's own hard limit may have
export const OVERRIDE_MAX = 200_000

export type Limits = { limit: number; warn: number }
const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_TOKENS
export const overrideOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= OVERRIDE_MIN && v <= OVERRIDE_MAX

type LimitCfg = { threadTokens?: unknown; threadWarnTokens?: unknown; threads?: { softCheckpointTokens?: unknown } | null; 'threads.softCheckpointTokens'?: unknown }
// the two limits from a config object (pure); the warn level never exceeds the limit. The warn level is the soft checkpoint size (threads.softCheckpointTokens, default 80% of the effective limit)
// unless the old threadWarnTokens key is set; a per-thread `override` of the hard limit moves the warn level with it (the same share of it: 80%).
// `window`: the model's real context window as the session reported it (context.json `window`); 0 / absent = not known (nothing is capped on a guess).
// `soft`: the soft checkpoint size, the share of the effective limit unless threads.softCheckpointTokens says another number (an own limit scales that number by its share).
export function limitsOf(cfg: LimitCfg | null | undefined, override?: number | null, window?: number | null): Limits {
  const base = valid(cfg?.threadTokens) ? Math.floor(cfg!.threadTokens as number) : DEFAULT_LIMIT
  const configured = overrideOk(override) ? Math.floor(override) : base
  const limit = effectiveLimit(configured, typeof window === 'number' ? window : 0)
  const softRaw = cfg?.threads?.softCheckpointTokens ?? cfg?.['threads.softCheckpointTokens']
  const scaled = valid(softRaw) ? (overrideOk(override) || limit < base ? Math.round((limit * Math.floor(softRaw)) / base / 1000) * 1000 : Math.floor(softRaw)) : softOf(limit)
  const share83 = Math.round((limit * WARN_SHARE) / 1000) * 1000 // a soft line never sits above 83% of the limit
  const asked = valid(cfg?.threadWarnTokens) ? Math.floor(cfg!.threadWarnTokens as number) : Math.min(scaled, share83)
  return { limit, warn: Math.min(asked, limit) }
}
export async function threadLimits(h: Host): Promise<Limits> {
  return limitsOf((await readConfig(h, await homeDir(h)).catch(() => null)) as any)
}
// the limits of ONE thread: the same, with the thread's own override (thread.json tokenLimit) when it has one, and the window its session reported (context.json)
export async function threadLimitsFor(h: Host, id: string): Promise<Limits> {
  const home = await homeDir(h)
  const ok = /^t\d+$/.test(id)
  const t = ok ? await readJson<{ tokenLimit?: unknown } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null).catch(() => null) : null
  const rec = ok ? await readJson<{ window?: unknown } | null>(h, contextFile(home, id), null).catch(() => null) : null
  return limitsOf((await readConfig(h, home).catch(() => null)) as any, overrideOk(t?.tokenLimit) ? t!.tokenLimit : null, windowOk(rec?.window))
}
const windowOk = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

// ---- the record: <thread folder>/context.json {tokens, at, sid} ----
export type Sample = { at: number; tokens: number }
export const HIST_MAX = 20 // the last turn-end samples kept in context.json (the pane's growth per turn)
export type ContextRec = { tokens: number; at: number; sid: string; hist?: Sample[]; window?: number /* the model's real context window, as the session reported it */ }
export const contextFile = (home: string, id: string) => `${threadsDir(home)}/${id}/context.json`

// Written by the thread's own mod at the end of a turn; false = nothing written (no usable size or session id), never throws.
// `sample`: a turn end, one history sample is kept (the last HIST_MAX); every other write keeps the history of the same session as it was.
export async function recordContext(h: Host, id: string, sid: string, tokens: unknown, o: { sample?: boolean; window?: unknown } = {}): Promise<boolean> {
  if (!/^t\d+$/.test(id) || !sid || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return false
  try {
    const home = await homeDir(h)
    const at = await h.clock.now()
    const old = await readJson<Partial<ContextRec> | null>(h, contextFile(home, id), null)
    let hist = old && old.sid === sid && Array.isArray(old.hist) ? old.hist.filter(x => x && typeof x.at === 'number' && typeof x.tokens === 'number') : []
    if (o.sample) hist = [...hist, { at, tokens: Math.round(tokens) }].slice(-HIST_MAX)
    const window = windowOk(o.window) || (old && old.sid === sid ? windowOk(old.window) : 0) // (a write with no window keeps the one this session reported)
    const rec: ContextRec = { tokens: Math.round(tokens), at, sid, ...(hist.length ? { hist } : {}), ...(window ? { window } : {}) }
    await writeJson(h, contextFile(home, id), rec) // atomic: tmp file + mv
    return true
  } catch {
    return false
  }
}

// The recorded size of the thread's CURRENT session, or null (no record, damaged, or recorded by another session id). The mod writes the
// id its own session resolved to, which can differ from thread.json `sid` after a resume or reload (role.ts recordSid keeps such ids in
// `sids`): that record counts too, but only when it was written since this session was started or woken (`at` >= `lastWake`), so an
// older session's record is never believed.
export async function readContext(h: Host, home: string, t: { id: string; sid?: string; sids?: string[]; lastWake?: number }): Promise<ContextRec | null> {
  if (!t.sid) return null
  const r = await readJson<Partial<ContextRec> | null>(h, contextFile(home, t.id), null)
  if (!r || typeof r !== 'object' || typeof r.sid !== 'string' || typeof r.tokens !== 'number' || !Number.isFinite(r.tokens) || r.tokens < 0) return null
  const at = typeof r.at === 'number' ? r.at : 0
  const mine = r.sid === t.sid || (Array.isArray(t.sids) && t.sids.includes(r.sid) && at >= (t.lastWake ?? 0) && at > 0)
  return mine ? { tokens: r.tokens, at, sid: r.sid, ...(Array.isArray(r.hist) && r.hist.length ? { hist: r.hist } : {}) } : null
}

// ---- level and text ----
export type Level = 'unknown' | 'ok' | 'warn' | 'over'
export const levelOf = (tokens: number | null | undefined, l: Limits): Level =>
  typeof tokens !== 'number' ? 'unknown' : tokens > l.limit ? 'over' : tokens > l.warn ? 'warn' : 'ok'
export const kTokens = (n: number) => `${Math.round(n / 1000)}k`
// "ctx 108k/120k" | "ctx unknown"
// (1.0.26: "ctx 96k/120k (fixed 28k), +3k/turn": the fixed parts of that session, when its breakdown was recorded; ctxparts.ts)
export const ctxText = (tokens: number | null | undefined, l: Limits, growth?: number | null, fixed?: number | null) =>
  typeof tokens === 'number' ? `ctx ${kTokens(tokens)}/${kTokens(l.limit)}${typeof fixed === 'number' && fixed > 0 ? ` (fixed ${kTokens(fixed)})` : ''}${typeof growth === 'number' ? `, +${kTokens(growth)}/turn` : ''}` : 'ctx unknown'

// The mean growth per turn from the turn-end samples: the steps up (a drop is a compaction or a restart, left out), at least two of them, else null.
export function growthPerTurn(hist: Sample[] | undefined): number | null {
  if (!hist || hist.length < 3) return null
  const ups: number[] = []
  for (let i = 1; i < hist.length; i++) {
    const d = hist[i]!.tokens - hist[i - 1]!.tokens
    if (d > 0) ups.push(d)
  }
  if (ups.length < 2) return null
  const mean = ups.reduce((a, b) => a + b, 0) / ups.length
  return mean >= 500 ? mean : null // under half a thousand a turn is not worth a figure
}

// What the views read: the text, the level (dim under the warn level, yellow above it, red over the limit) and the size
export type CtxView = { text: string; level: Level; tokens?: number; fixed?: number }
export function ctxView(rec: ContextRec | null, l: Limits, fixed?: number | null): CtxView {
  const tokens = rec?.tokens
  return { text: ctxText(tokens, l, growthPerTurn(rec?.hist), fixed), level: levelOf(tokens, l), ...(typeof tokens === 'number' ? { tokens } : {}), ...(typeof fixed === 'number' && fixed > 0 ? { fixed } : {}) }
}
export async function ctxOf(h: Host, home: string, t: { id: string; sid?: string; sids?: string[]; lastWake?: number }, l?: Limits): Promise<CtxView> {
  const rec = await readContext(h, home, t)
  const parts = rec ? await readParts(h, home, t.id).catch(() => null) : null
  const fixed = parts && parts.sid === rec!.sid ? parts.first?.fixed : undefined // only the breakdown of the session the size belongs to
  const own = await readJson<{ tokenLimit?: unknown } | null>(h, `${threadsDir(home)}/${t.id}/thread.json`, null).catch(() => null) // the thread's own limit (lean_thread limit) wins over the shared one
  return ctxView(rec, overrideOk(own?.tokenLimit) || windowOk(await readJson<{ window?: unknown } | null>(h, contextFile(home, t.id), null).then(r => r?.window, () => 0)) ? await threadLimitsFor(h, t.id) : (l ?? (await threadLimits(h))), fixed)
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

// "cached re-read ~6k usage tokens": the recorded context read from the cache once, at the cache-read weight (0.1 of an input token; an estimate)
export const rereadTokens = (tokens: number) => usageTokens({ cacheRead: tokens })

// one phrase for the reply of a resume: which rule applied and what it uses (estimates)
export function resumedText(why: 'keep' | '', tokens: number | null, _model?: string): string {
  const label = why === 'keep' ? 'resumed (keep mode)' : 'resumed'
  return typeof tokens === 'number' ? `${label}: context ${kTokens(tokens)}, cached re-read ~${fmtTokens(rereadTokens(tokens))} usage tokens (estimate)` : `${label}: context size unknown`
}
// the head of the reply of a fresh session that replaced a resume: why (the start text then says the handover size and its cost)
export const overText = (tokens: number, limit: number) => `context was ${kTokens(tokens)} (limit ${kTokens(limit)}): started a new session with the handover (old conversation kept read-only, not resumed)`
export const notKeepText = 'new session (not in keep mode)'

// keep mode on or off, as said back to the caller
export const keepText = (id: string, on: boolean, l: Limits) =>
  on
    ? `${id} keep mode on: after it reports done, follow-up messages resume the same session until its context passes ${kTokens(l.limit)} tokens, then a new session starts with the handover`
    : `${id} keep mode off: after it reports done, its next message starts a new session (the context limit of ${kTokens(l.limit)} tokens still applies)`
