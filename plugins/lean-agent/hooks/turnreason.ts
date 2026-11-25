// The reason a thread's turn ended (1.0.33; field: four threads "ended at once" with no report and the desk, the pane and the user could not tell why: the session logs are raw terminal output).
// By script, no model: the thread's own mod collects the FACTS of a main-loop turn (the engine's turn.complete: reason answer | aborted | refusal | error, durationMs, usage absent when no model
// request counted; classic.StopFailure: the API error's word and details; its own count of model requests (turn.step), tool calls and refused tool calls) and writes
// <thread folder>/turn-reason.json at every turn end. One line says it: "no model call, error: rate_limit, 0 tool calls, 2 s". Where the engine gives no reason the line says so:
// "no reason from the engine, 1 model request, 0 tool calls, 4 s". Shown in `lean_thread list`, in the desk's alert (continuepending.ts cap alert, stall.ts) and in lean_doctor.
// `run` = turn ends in a row with no tool call between (the count of "ended at once N times").
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'

export type TurnFacts = {
  reason?: string // the engine's: answer | aborted | refusal | error
  steps: number // model requests this turn (turn.step)
  calls: number // tool calls the model made
  denied: number // of those, refused by a rule (the guard, the context stop, the budget)
  deniedText?: string // the last refusal, cut
  usage: boolean // the engine counted a real request (turn.complete usage present)
  ms: number
  error?: string // classic.StopFailure: the error word and details
  refusal?: string // a model refusal: category / explanation
}
// auth: 'yes' = the engine said the login is the problem (classic.StopFailure's error word authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required,
// cloud_credential_error, or an error text naming "not logged in" / "no session" / 401 / OAuth ...): nothing a nudge can fix. 'maybe' = no error text, but twice in a row the turn ended within
// seconds with no model call: the facts say "check claude auth login / network". A turn that had model usage is neither.
export type TurnRec = TurnFacts & { at: number; sid: string; run: number; line: string; auth?: 'yes' | 'maybe' }
export const turnFile = (home: string, id: string) => `${threadsDir(home)}/${id}/turn-reason.json`
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: unknown, n: number) => (typeof s === 'string' ? flat(s).slice(0, n) : '')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export const AUTH_WORDS = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']
const AUTH_TEXT = /not logged in|no session|log ?in (?:again|required)|please (?:run )?\/?login|authenticat|unauthori[sz]ed|\b401\b|oauth|credential|token (?:has )?(?:expired|invalid)|invalid (?:x-)?api[ -]?key|session (?:has )?(?:expired|not found)|expired (?:session|token|login)/i
export const isAuthError = (error: unknown): boolean => typeof error === 'string' && !!error && !/^the mod refused the request/.test(error) && (AUTH_WORDS.some(w => error.includes(w)) || AUTH_TEXT.test(error))
export const AUTH_FIX = 'run claude auth login'
export const AUTH_MAYBE = 'ended at once, no model call: check claude auth login / network'
// the facts that say "no model call, ended within seconds" (the fallback when the engine names no cause)
const quickNoModel = (f: Pick<TurnFacts, 'usage' | 'steps' | 'calls' | 'ms' | 'error'>): boolean => !f.usage && f.steps === 0 && f.calls === 0 && f.ms <= 30_000 && !(f.error ?? '').startsWith('the mod refused the request')

// the one line (no "ended at once" prefix: the list adds its own word)
export function reasonLine(f: Pick<TurnFacts, 'reason' | 'steps' | 'calls' | 'denied' | 'deniedText' | 'usage' | 'ms' | 'error' | 'refusal'>, auth?: 'yes' | 'maybe'): string {
  const model = !(f.usage || f.steps > 0) ? 'no model call' : f.steps > 0 ? plural(f.steps, 'model request') : 'model called'
  const why = auth === 'yes' ? `not logged in (${AUTH_FIX}${f.error ? `; the engine said: ${cut(f.error, 100)}` : ''})` : auth === 'maybe' ? AUTH_MAYBE.replace(/^ended at once, no model call: /, '') : f.error ? `error: ${cut(f.error, 120)}` : f.refusal ? `model refused: ${cut(f.refusal, 120)}` : f.reason === 'aborted' ? 'interrupted' : f.reason === 'error' ? 'error (the engine gave no text)' : f.reason === 'answer' ? 'answered, no report' : f.reason === 'refusal' ? 'model refused' : ''
  const parts = [model, why || 'no reason from the engine', plural(f.calls, 'tool call') + (f.denied ? ` (${f.denied} refused${f.deniedText ? `: ${cut(f.deniedText, 80)}` : ''})` : ''), `${Math.max(0, Math.round(f.ms / 1000))} s`]
  return parts.join(', ')
}

// the login verdict of one turn end: the engine's own word / text wins; else the facts (no model call, within seconds, the SECOND time in a row)
export function authOf(f: TurnFacts, run: number): 'yes' | 'maybe' | undefined {
  if (f.usage || f.steps > 0) return undefined
  if (isAuthError(f.error)) return 'yes'
  return run >= 2 && quickNoModel(f) ? 'maybe' : undefined
}
export async function readTurn(h: Host, home: string, id: string): Promise<TurnRec | null> {
  const r = await readJson<Partial<TurnRec> | null>(h, turnFile(home, id), null)
  return r && typeof r === 'object' && Number(r.at) > 0 && typeof r.sid === 'string' && typeof r.line === 'string' ? ({ ...r, at: Number(r.at), run: Number(r.run) || 0 } as TurnRec) : null
}

// the thread's own mod, at a main-loop turn end: the facts become the record; `run` counts the turn ends with no tool call between. Never throws.
export async function recordTurn(h: Host, id: string, o: { sid: string; facts: TurnFacts; now?: number }): Promise<TurnRec | null> {
  try {
    const home = await homeDir(h)
    const now = o.now ?? (await h.clock.now())
    const prev = await readTurn(h, home, id)
    const f = o.facts
    const run = f.calls > 0 ? 0 : prev && prev.sid === o.sid ? prev.run + 1 : 1
    const auth = authOf(f, run)
    const rec: TurnRec = { ...f, at: now, sid: o.sid, run, ...(auth ? { auth } : {}), line: reasonLine(f, auth) }
    await writeJson(h, turnFile(home, id), rec)
    return rec
  } catch {
    return null // an observation: never blocks a turn end
  }
}
// classic.StopFailure can arrive after turn.complete: its text is added to the record just written (same session, within 30 s, no error yet)
export async function addTurnError(h: Host, id: string, o: { sid: string; error: string; now?: number }): Promise<void> {
  try {
    const home = await homeDir(h)
    const rec = await readTurn(h, home, id)
    const now = o.now ?? (await h.clock.now())
    if (!rec || rec.sid !== o.sid || rec.error || now - rec.at > 30_000) return
    const f = { ...rec, error: cut(o.error, 160) }
    const auth = authOf(f, rec.run)
    const { auth: _old, ...rest } = f
    await writeJson(h, turnFile(home, id), { ...rest, ...(auth ? { auth } : {}), line: reasonLine(f, auth) })
  } catch {
    /* an observation */
  }
}
// the error text of a StopFailure event: the word and its details
export const stopFailureText = (e: unknown): string => {
  const x = e as { error?: unknown; error_details?: unknown } | null
  return [cut(x?.error, 60), cut(x?.error_details, 120)].filter(Boolean).join(': ')
}

// the facts of one turn, collected in memory by the thread's mod (register.tsx); `resetFacts` at turn.start
export const emptyFacts = (): TurnFacts => ({ steps: 0, calls: 0, denied: 0, usage: false, ms: 0 })
// the end: the engine's turn.complete event + what was counted
export function factsOf(counted: TurnFacts, e: { reason?: unknown; durationMs?: unknown; usage?: unknown; refusal?: { category?: unknown; explanation?: unknown } | null } | null | undefined, error?: string): TurnFacts {
  const reason = typeof e?.reason === 'string' ? e.reason : undefined
  const refusal = e?.refusal ? [cut(e.refusal.category, 60), cut(e.refusal.explanation, 120)].filter(Boolean).join(': ') : ''
  return { ...counted, ...(reason ? { reason } : {}), usage: counted.usage || (!!e?.usage && typeof e.usage === 'object'), ms: Number(e?.durationMs) >= 0 ? Number(e?.durationMs) : counted.ms, ...(error ? { error } : {}), ...(refusal ? { refusal } : {}) }
}
