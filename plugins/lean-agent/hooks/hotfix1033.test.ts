// 1.0.33 hotfix (1.0.32: four threads "ended at once", no report; the cause was the background sessions' login and nothing said so): the turn-end reason line with the login verdict (turnreason.ts),
// no nudge for a thread that cannot run, ONE desk alert and the restart once the login works (authwatch.ts), the shared nudge cap and the ONE stuck alert (continuepending.ts), "consumed" only once the model
// answered (register.tsx / delivery.ts), a failed action shown as failed (deskactions.ts), the work item create request and its failure text, the open-only list, config validate for keys nothing
// reads, and a feedback draft delivered to the feedback folder with no working thread (deliver.ts). Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { MAX_NUDGES_RUN, continueTick, noteTurnEnd, readCState } from './continuepending'
import { emptyFacts, factsOf, isAuthError, readTurn, reasonLine, recordTurn } from './turnreason'
import { authHealth, authRows, authTick } from './authwatch'
import { peekNotice } from './notices'
import { leanThread, listScope, resetLocks } from './threads'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { configTool } from './configtool'
import { deliver } from './deliver'
import { ACTION_KINDS, addActionRequest, answerAction, approveAction, checkAction, actionListText, resetActions } from './deskactions'
import { relaxOwnTaskForSpecs } from './owntask'
relaxOwnTaskForSpecs()

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const MIN = 60_000
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? '{}')

// ---- B. the reason line ---------------------------------------------------------------------------------------------------------------------
test('reasonLine: no model call + the API error; a refusal; no reason from the engine; an answer without a report; facts only', () => {
  const f = { steps: 0, calls: 0, denied: 0, usage: false, ms: 2300 }
  expect(reasonLine({ ...f, reason: 'error', error: 'invalid_request: 400 system prompt' })).toBe('no model call, error: invalid_request: 400 system prompt, 0 tool calls, 2 s')
  expect(reasonLine({ ...f, reason: 'error' })).toBe('no model call, error (the engine gave no text), 0 tool calls, 2 s')
  expect(reasonLine({ ...f, reason: 'refusal', refusal: 'cyber: classifier', steps: 1, usage: true })).toBe('1 model request, model refused: cyber: classifier, 0 tool calls, 2 s')
  expect(reasonLine({ ...f })).toBe('no model call, no reason from the engine, 0 tool calls, 2 s')
  expect(reasonLine({ ...f, reason: 'answer', steps: 2, usage: true, calls: 1, ms: 4000 })).toBe('2 model requests, answered, no report, 1 tool call, 4 s')
  expect(reasonLine({ ...f, reason: 'aborted', denied: 2, calls: 2, deniedText: 'lean-agent: this session is at its limit' })).toBe('no model call, interrupted, 2 tool calls (2 refused: lean-agent: this session is at its limit), 2 s')
  expect(reasonLine({ ...f, error: 'the mod refused the request: the daily $1.00 budget for thread sessions is used' })).toContain('the mod refused the request')
})

test('factsOf reads the engine\'s turn.complete (reason, durationMs, usage, refusal); recordTurn counts the turn ends in a row with no tool call and restarts the count on a tool call or a new session', async () => {
  const h = fakeHost(null)
  h.files.set(`${T1}/thread.json`, '{}')
  const err = factsOf(emptyFacts(), { reason: 'error', durationMs: 1800 }, 'rate_limit')
  expect(err).toMatchObject({ reason: 'error', ms: 1800, usage: false, error: 'rate_limit', steps: 0 })
  expect(factsOf(emptyFacts(), { reason: 'refusal', durationMs: 1, usage: { input_tokens: 1 }, refusal: { category: 'cyber', explanation: 'x' } }).refusal).toBe('cyber: x')
  expect((await recordTurn(h.host, 't1', { sid: S1, facts: err, now: 1 }))!.run).toBe(1)
  expect((await recordTurn(h.host, 't1', { sid: S1, facts: err, now: 2 }))!.run).toBe(2)
  expect((await recordTurn(h.host, 't1', { sid: S1, facts: { ...err, calls: 3 }, now: 3 }))!.run).toBe(0)
  expect((await recordTurn(h.host, 't1', { sid: S1, facts: err, now: 4 }))!.run).toBe(1)
  expect((await recordTurn(h.host, 't1', { sid: 'another-session', facts: err, now: 5 }))!.run).toBe(1) // a new session starts its own count
  expect((await readTurn(h.host, '/h/.lean-agent'.replace('/.lean-agent', ''), 't1'))?.line).toContain('error: rate_limit')
})

// ---- A (re-scoped): the login ---------------------------------------------------------------------------------------------------------------------
test('isAuthError: the engine\'s authentication words and the texts of a missing / expired login; other errors and the mod\'s own refusal are not', () => {
  for (const e of ['authentication_failed', 'authentication_failed: 401 invalid credentials', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error', 'unknown: No session', 'unknown: Not logged in · Please run /login', 'unknown: OAuth token has expired', 'unknown: HTTP 401 Unauthorized', 'invalid x-api-key', 'session expired']) expect([e, isAuthError(e)]).toEqual([e, true])
  for (const e of ['rate_limit', 'overloaded: 529', 'invalid_request: 400 prompt is too long', 'server_error', 'billing_error', 'max_output_tokens', undefined, '', 'the mod refused the request: the daily $1.00 budget for thread sessions is used']) expect([e, isAuthError(e)]).toEqual([e, false])
})

test('the reason line says "not logged in (run claude auth login)" for the engine\'s authentication error, and "check claude auth login / network" from the facts alone (no model call, within seconds, twice)', async () => {
  const h = fakeHost(null)
  h.files.set(`${T1}/thread.json`, '{}')
  const base = { ...emptyFacts(), reason: 'error', ms: 2000 }
  const a = await recordTurn(h.host, 't1', { sid: S1, facts: { ...base, error: 'authentication_failed: No session' }, now: 1 })
  expect(a!.auth).toBe('yes')
  expect(a!.line).toBe('no model call, not logged in (run claude auth login; the engine said: authentication_failed: No session), 0 tool calls, 2 s')
  // facts only: the first quick turn with no model call is not yet a verdict, the second one is
  const h2 = fakeHost(null)
  h2.files.set(`${T1}/thread.json`, '{}')
  const first = await recordTurn(h2.host, 't1', { sid: S1, facts: base, now: 1 })
  expect(first!.auth).toBeUndefined()
  const second = await recordTurn(h2.host, 't1', { sid: S1, facts: base, now: 2 })
  expect(second!.auth).toBe('maybe')
  expect(second!.line).toBe('no model call, check claude auth login / network, 0 tool calls, 2 s')
  // a slow turn, a turn with a model request or a tool call, the mod's own refusal: never a login verdict
  for (const f of [{ ...base, ms: 90_000 }, { ...base, steps: 1, usage: true }, { ...base, calls: 2 }, { ...base, error: 'the mod refused the request: the daily budget is used' }]) {
    const r = await recordTurn(h2.host, 't1', { sid: S1, facts: f, now: 3 })
    expect([JSON.stringify(f), r!.auth]).toEqual([JSON.stringify(f), undefined])
  }
})

test('a thread whose turn ended on a login failure is NOT nudged: 10 turn ends in 5 minutes send nothing and raise no stuck alert', { timeoutMs: 20_000 }, async () => {
  const h = loopWorld()
  const sent: string[] = []
  const notices: string[] = []
  for (let k = 0; k < 10; k++) {
    h.clock.t = T0 + k * 30_000
    await recordTurn(h.host, 't1', { sid: S1, facts: { ...emptyFacts(), reason: 'error', error: 'authentication_failed', ms: 1500 }, now: h.clock.t })
    expect(await noteTurnEnd(h.host, 't1', { sid: S1, since: h.clock.t - 2_000, lastText: null })).toBe('none')
    h.clock.t += 25_000
    for (const n of await continueTick(h.host, { agents: async () => [row()], send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })) notices.push(n.text)
  }
  expect(sent).toEqual([])
  expect(notices).toEqual([])
  expect(json(h, `${T1}/continue-pending.json`)).toEqual({})
  expect(json(h, `${T1}/ended-noreport.json`)).toEqual({}) // not "ended without a report": the login is the reason
})

function authWorld() {
  const h = fakeHost(null)
  h.clock.t = T0
  const mk = (id: string, o: { state?: string; sid?: string; auth?: 'yes' | 'maybe'; usage?: boolean; at?: number } = {}) => {
    h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: id, project: 'acme', state: o.state ?? 'open', sid: o.sid ?? `sid-${id}`, created: 1, lastWake: 1, delivered: 0 }))
    h.files.set(`${L}/threads/${id}/turn-reason.json`, JSON.stringify({ at: o.at ?? T0, sid: o.sid ?? `sid-${id}`, run: 2, reason: 'error', steps: o.usage ? 1 : 0, calls: 0, denied: 0, usage: !!o.usage, ms: 1500, ...(o.auth ? { auth: o.auth } : {}), line: 'x' }))
  }
  const restarted: string[] = []
  // (a real restart is a new session: the thread's sid changes, so its old record no longer counts)
  const deps = { restart: async (id: string, _why: string) => (restarted.push(id), h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, state: 'open', sid: `new-${id}` })), { ok: true, text: 'restarted' }) as any }
  return { h, mk, restarted, deps }
}

test('threads that cannot run (not logged in): ONE desk alert for all of them, later ones only join the standing notice; the finding and the doctor row name the fix', { timeoutMs: 20_000 }, async () => {
  const w = authWorld()
  w.mk('t1', { auth: 'yes' })
  w.mk('t2', { auth: 'yes' })
  w.mk('t3', { state: 'closed', auth: 'yes' }) // closed: not counted
  w.mk('t4', { sid: 'sid-new', auth: 'yes' })
  w.h.files.set(`${L}/threads/t4/turn-reason.json`, JSON.stringify({ at: T0, sid: 'old-session', run: 2, reason: 'error', steps: 0, calls: 0, denied: 0, usage: false, ms: 1, auth: 'yes', line: 'x' })) // another session's record: not counted
  const first = await authTick(w.h.host, w.deps)
  expect(first).toHaveLength(1)
  expect(first[0]!.text).toBe('2 threads cannot run: not logged in (t1, t2). Run claude auth login in a terminal, then restart them')
  expect(await peekNotice(w.h.host, 'auth-login')).toBe(first[0]!.text)
  expect(await authTick(w.h.host, w.deps)).toEqual([]) // one alert
  w.mk('t5', { auth: 'yes' })
  expect(await authTick(w.h.host, w.deps)).toEqual([]) // a later one joins the notice, no second alert
  expect(await peekNotice(w.h.host, 'auth-login')).toContain('3 threads cannot run: not logged in (t1, t2, t5)')
  const health = await authHealth(w.h.host)
  expect(health!.text).toContain('not logged in (t1, t2, t5)')
  expect(health!.fix).toContain('claude auth login')
  expect((await authRows(w.h.host))[0]).toMatch(/^FIX  login: 3 threads cannot run: not logged in/)
  expect(w.restarted).toEqual([]) // nothing is restarted while the login fails
})

test('when a later turn of any thread has model usage the alert clears and the waiting threads are restarted ONCE with their task (open ones only); the facts-only verdict says "check claude auth login / network"', { timeoutMs: 20_000 }, async () => {
  const w = authWorld()
  w.mk('t1', { auth: 'yes' })
  w.mk('t2', { auth: 'yes' })
  w.mk('t3', { auth: 'maybe' })
  expect((await authTick(w.h.host, w.deps))[0]!.text).toBe('3 threads cannot run: not logged in (t1, t2, t3). Run claude auth login in a terminal, then restart them')
  w.h.files.set(`${L}/threads/t3/thread.json`, JSON.stringify({ id: 't3', title: 't3', state: 'closed', sid: 'sid-t3', created: 1, lastWake: 1, delivered: 0 })) // closed meanwhile: never reopened or restarted
  w.mk('t9', { usage: true, at: T0 + 60_000 }) // the user ran claude auth login: a thread's model call works
  w.h.clock.t = T0 + 70_000
  const out = await authTick(w.h.host, w.deps)
  expect(out).toEqual([{ id: 'auth', text: 'the login works again: restarted t1, t2 once with their task' }])
  expect(w.restarted).toEqual(['t1', 't2'])
  expect(await peekNotice(w.h.host, 'auth-login')).toBeFalsy()
  expect(await authTick(w.h.host, w.deps)).toEqual([]) // once: nothing more, no second restart
  expect(w.restarted).toEqual(['t1', 't2'])
  // the facts-only wording
  const f = authWorld()
  f.mk('t1', { auth: 'maybe' })
  expect((await authTick(f.h.host, f.deps))[0]!.text).toBe('1 thread ended at once with no model call (t1): check claude auth login / network, then restart them')
  // nobody fails any more (the user restarted it): the alert ends quietly
  f.mk('t1', {})
  expect(await authTick(f.h.host, f.deps)).toEqual([])
  expect(await peekNotice(f.h.host, 'auth-login')).toBeFalsy()
  expect(await authHealth(f.h.host)).toBeNull()
})

// ---- B through the engine: a thread's turn that dies on an API error writes the one-line reason ---------------------------------------------
async function threadSession($: any, on: any) {
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {}))
  resetLocks()
  h.files.set('/r/templates/thread.md', '# {{id}}')
  h.files.set('/r/templates/front-desk.md', 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('clock.every', (() => ({ value: { cancel() {} } })) as any)
  on('session.cwd', () => ({ value: T1 }))
  on('session.root', () => ({ value: T1 }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  // what the engine answers beneath the mod for the events these specs raise
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  on('session.receive', (_: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.StopFailure', (_: any, e: any) => ({ value: {} }) as any)
  return h
}
const stepOf = ($: any, i: number) => {
  const st = $.turn.step({ turnId: 'u1', index: i, model: 'sonnet', messageCount: 1 } as any)
  return (async () => {
    for (;;) {
      const n = await st.next()
      if (n.done) return n.value
    }
  })()
}

test('a thread turn that ends with reason "error" and no model request records "no model call, error: ..." (engine events turn.start / classic.StopFailure / turn.complete)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on)
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  await $.turn.start({ turnId: 'u1', text: 'go' } as any)
  await ($ as any).classic.StopFailure({ error: 'invalid_request', error_details: '400 system: the first block must be the Claude Code identity' })
  await $.turn.complete({ answer: '', durationMs: 2300, isAborted: false, turnId: 'u1', reason: 'error' } as any)
  const rec = json(h, `${T1}/turn-reason.json`)
  expect(rec).toMatchObject({ sid: 'sess-x', reason: 'error', steps: 0, calls: 0, usage: false, run: 1 })
  expect(rec.error).toContain('invalid_request')
  expect(rec.line).toContain('no model call, error: invalid_request')
  expect(rec.line).toContain('0 tool calls, 2 s')
  // the same again: the second turn end with no tool call in a row
  await $.turn.start({ turnId: 'u2', text: 'go' } as any)
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: false, turnId: 'u2', reason: 'answer' } as any)
  // the second turn end in a row with no model call within seconds, and no error text: the facts say "check claude auth login / network" (turnreason.ts authOf)
  expect(json(h, `${T1}/turn-reason.json`)).toMatchObject({ run: 2, reason: 'answer', auth: 'maybe' })
  expect(json(h, `${T1}/turn-reason.json`).line).toBe('no model call, check claude auth login / network, 0 tool calls, 1 s')
})

test('a thread turn the engine ends with authentication_failed records "not logged in (run claude auth login)" (the engine\'s own error word, through classic.StopFailure)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on)
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  await $.turn.start({ turnId: 'u1', text: 'go' } as any)
  await ($ as any).classic.StopFailure({ error: 'authentication_failed', error_details: 'No session' })
  await $.turn.complete({ answer: '', durationMs: 1200, isAborted: false, turnId: 'u1', reason: 'error' } as any)
  const rec = json(h, `${T1}/turn-reason.json`)
  expect(rec.auth).toBe('yes')
  expect(rec.line).toContain('not logged in (run claude auth login')
  expect(rec.line).toContain('authentication_failed: No session')
})

test('a thread turn that made a model request and a tool call records them and restarts the count', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on)
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'sonnet', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
  })
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  await $.turn.start({ turnId: 'u1', text: 'go' } as any)
  await stepOf($, 0)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as any).catch(() => undefined)
  await $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 'u1', reason: 'answer', usage: { model: 'sonnet', input_tokens: 10, output_tokens: 5 } } as any)
  const rec = json(h, `${T1}/turn-reason.json`)
  expect(rec).toMatchObject({ steps: 1, usage: true, run: 0 })
  expect(rec.calls).toBeGreaterThanOrEqual(1)
  expect(rec.line).toContain('1 model request')
})

// ---- D. consumed: only once the model answered ------------------------------------------------------------------------------------------------
test('a direct message / wake prompt is "consumed" when the model answered the turn that carried it, not when it arrived (no "read 0 s after sending")', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on)
  let usage: unknown = undefined
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', ...(usage ? { usage } : {}) } as any
  })
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 1_000, from: 'desk', text: 'start on the task' }) + '\n')
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  const consumed = () => json(h, `${T1}/consumed.json`).n ?? 0
  // the message arrives (the desk's direct send): the session receives it, a turn starts for it ...
  await $.session.receive({ text: '[lean-agent] message from the desk:\nstart on the task\n<!-- lean:n=1 -->', origin: { kind: 'plugin', plugin: 'lean-agent' } } as any)
  await $.prompt.submit({ text: '[lean-agent] message from the desk:\nstart on the task\n<!-- lean:n=1 -->', origin: { kind: 'plugin', plugin: 'lean-agent' } } as any)
  await $.turn.start({ turnId: 'u1', text: 'x' } as any)
  expect(consumed()).toBe(0) // ... and nothing counts as read yet
  // the request fails (no usage): still not read
  await stepOf($, 0)
  expect(consumed()).toBe(0)
  await $.turn.complete({ answer: '', durationMs: 500, isAborted: false, turnId: 'u1', reason: 'error' } as any)
  expect(consumed()).toBe(0)
  // the model answers a request that carried it: consumed
  usage = { model: 'sonnet', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await stepOf($, 1)
  expect(consumed()).toBe(1)
  expect(json(h, `${T1}/msgs.json`)['1']?.readAt).toBeGreaterThan(0)
})

// ---- C. the shared nudge cap ------------------------------------------------------------------------------------------------------------------
function loopWorld(o: { config?: unknown } = {}) {
  resetActivity()
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'move the files', project: 'acme', state: 'open', sid: S1, created: 1, lastWake: T0 - 60 * MIN, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, '1. move the files\n2. update the index\n')
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - 5 * MIN, kind: 'prompt' }))
  h.files.set(`${L}/config.json`, JSON.stringify(o.config ?? {}))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: S1, name: 't1 · move', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }]) } : { exitCode: 0, stdout: '' })
  return h
}
const row = () => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '' }) as any

test('10 turn ends in 5 minutes with no tool call (the 1.0.32 loop) produce 2 nudges and ONE desk alert with the reason line; the list says "stuck: ended at once N times"', { timeoutMs: 20_000 }, async () => {
  const h = loopWorld() // the defaults: keep-going on, the end-nudge on
  const sent: string[] = []
  const notices: string[] = []
  const facts = { ...emptyFacts(), reason: 'answer', steps: 1, usage: true, ms: 3_000 } // the model answers with plain text and no report, again and again (no login problem: it has model usage)
  for (let k = 0; k < 10; k++) {
    h.clock.t = T0 + k * 30_000
    await recordTurn(h.host, 't1', { sid: S1, facts, now: h.clock.t })
    await noteTurnEnd(h.host, 't1', { sid: S1, since: h.clock.t - 2_000, lastText: null })
    h.clock.t += 25_000 // the desk's tick after the continue delay
    for (const n of await continueTick(h.host, { agents: async () => [row()], send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })) notices.push(n.text)
  }
  expect(MAX_NUDGES_RUN).toBe(2)
  expect(sent).toHaveLength(2)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('t1 is stuck: it ended its turn')
  expect(notices[0]).toContain('1 model request, answered, no report, 0 tool calls, 3 s')
  expect(notices[0]).toContain('restart t1 with its task')
  expect(notices[0]).toContain('or ask the user')
  const cs = await readCState(h.host, '/h', 't1')
  expect(cs.stuck?.n).toBeGreaterThanOrEqual(3)
  expect(json(h, `${T1}/continue-pending.json`)).toEqual({}) // nothing is pending: the mod stopped
  const list = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(list).toContain('stuck: ended at once')
  expect(list).toContain('1 model request, answered, no report, 0 tool calls, 3 s')
  expect((await leanThread(h.host, '/p', { action: 'list', verbose: true })).text).toContain('why: 1 model request, answered, no report')
})

test('a tool call (or a report) between turn ends lifts the count: the thread is nudged again, and a new session starts clean', { timeoutMs: 20_000 }, async () => {
  const h = loopWorld()
  const sent: string[] = []
  const t = async () => (await continueTick(h.host, { agents: async () => [row()], send: async (id: string, text: string) => (sent.push(text), { ok: true, text: 'sent' }) })).map(n => n.text)
  let now = T0
  const turnEnd = async () => {
    await noteTurnEnd(h.host, 't1', { sid: S1, since: now - 2_000, lastText: null })
    now += 25_000
    h.clock.t = now
    return t()
  }
  h.clock.t = now
  await turnEnd()
  await turnEnd()
  expect(sent).toHaveLength(2)
  expect((await turnEnd()).join('|')).toContain('stuck')
  expect(sent).toHaveLength(2)
  // the thread works: a tool call after the last nudge
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: now + 1_000, kind: 'tool' }))
  now += 5_000
  h.clock.t = now
  await t()
  expect((await readCState(h.host, '/h', 't1')).stuck).toBeUndefined()
  expect((await readCState(h.host, '/h', 't1')).nudgeRun).toBe(0)
  await turnEnd()
  expect(sent).toHaveLength(3) // nudged again
})

// ---- E / F. a failed action is failed; the work item create request -----------------------------------------------------------------------------
const TOKEN = 'SECRET-TOKEN-0123456789'
const CREATE = { kind: 'ado-workitem-create', params: { org: 'acme', project: 'Shop App', type: 'Bug', title: 'Worker restart telemetry is missing', description: 'line 1\nline "2"', area: 'Shop App\\Team A', iteration: 'Shop App\\Sprint 4' } }
function azWorld(post: (argv: string[], stdin: string) => { exitCode: number; stdout: string; stderr?: string }) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'telemetry', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = (argv, c) => (argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? (argv.includes('POST') ? post(argv, c.stdin ?? '') : { exitCode: 0, stdout: JSON.stringify({ value: [], workItems: [], count: 0 }) }) : { exitCode: 127, stdout: '', stderr: 'unknown' })
  const told: string[] = []
  return { h, told, tell: async (_t: string, text: string) => void told.push(text), posts: () => h.calls.filter(c => c.argv[0] === 'curl' && c.argv.includes('POST')) }
}
const bodyOf = (stdin: string) => JSON.parse(/data-binary = "(.*)"/.exec(stdin)![1]!.replace(/\\(["\\nrt])/g, (_m, c: string) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' })[c]!))

test('ado-workitem-create builds POST .../_apis/wit/workitems/$Bug?api-version=7.1 with application/json-patch+json and a JSON ARRAY of add operations; area and iteration paths keep their backslash', () => {
  expect(Object.keys(ACTION_KINDS)).toContain('ado-workitem-create')
  const c = checkAction(CREATE as any)
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(c.plan.method).toBe('POST')
  expect(c.plan.url).toBe('https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/$Bug?api-version=7.1')
  expect(c.plan.contentType).toBe('application/json-patch+json')
  const ops = JSON.parse(c.plan.body)
  expect(Array.isArray(ops)).toBe(true)
  expect(ops).toEqual([
    { op: 'add', path: '/fields/System.Title', value: 'Worker restart telemetry is missing' },
    { op: 'add', path: '/fields/System.Description', value: 'line 1\nline "2"' },
    { op: 'add', path: '/fields/System.AreaPath', value: 'Shop App\\Team A' },
    { op: 'add', path: '/fields/System.IterationPath', value: 'Shop App\\Sprint 4' },
  ])
  // a type with a space is encoded in the URL, never in the body
  const story = checkAction({ kind: 'ado-workitem-create', params: { org: 'acme', project: 'Shop App', type: 'User Story', title: 'x' } } as any)
  expect(story.ok && story.plan.url).toBe('https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/$User%20Story?api-version=7.1')
})

test('the create goes out on the wire as built (curl config on stdin: the body unchanged, the content type, the token only on stdin); a 400 answer is "failed (HTTP 400): <the service\'s message>"', async () => {
  const s = azWorld(() => ({ exitCode: 22, stdout: '{"$id":"1","message":"TF401320: Rule Error for field Area Path. Error code: Required, InvalidTreeName.","typeKey":"RuleValidationException"}', stderr: 'curl: (22) The requested URL returned error: 400' }))
  const r = await addActionRequest(s.h.host, 't5', { ...CREATE, why: 'track it' } as any)
  expect(r.ok, r.text).toBe(true)
  await answerAction(s.h.host, r.request!.id, 'approve', 'pane')
  const out = await approveAction(s.h.host, r.request!.id, s.tell)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('failed (HTTP 400: TF401320: Rule Error for field Area Path.')
  const post = s.posts()[0]!
  expect(post.argv.at(-1)).toBe('https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/$Bug?api-version=7.1')
  expect(post.argv).toContain('POST')
  expect(post.stdin).toContain('header = "Content-Type: application/json-patch+json"')
  expect(bodyOf(post.stdin!)).toEqual(JSON.parse(checkAction(CREATE as any).ok ? (checkAction(CREATE as any) as any).plan.body : '[]'))
  expect(post.argv.join(' ')).not.toContain(TOKEN)
  // E: shown as failed, never as approved-and-waiting; the thread is told; the same id is not sent again (no duplicate work item)
  const list = await actionListText(s.h.host, s.tell)
  expect(list).toContain(`${r.request!.id} · t5 · ado-workitem-create · failed: HTTP 400: TF401320`)
  expect(list).not.toContain('call lean_thread approve-action')
  expect(s.told.at(-1)).toContain('NEW request')
  const again = await approveAction(s.h.host, r.request!.id, s.tell)
  expect(again.ok).toBe(false)
  expect(again.text).toContain('never sent again under this id')
  expect(s.posts()).toHaveLength(1)
})

test('a request an older version left "approved" after an HTTP failure (its history says action-failed) is shown as failed, not offered for approve-action', async () => {
  const s = azWorld(() => ({ exitCode: 0, stdout: '{"id":9}' }))
  const r = await addActionRequest(s.h.host, 't5', { ...CREATE, why: 'track it' } as any)
  await answerAction(s.h.host, r.request!.id, 'approve', 'pane')
  s.h.files.set(`${L}/threads/t5/history.jsonl`, JSON.stringify({ ts: 1, kind: 'action-failed', id: r.request!.id, action: 'ado-workitem-create', result: 'Azure DevOps refused or could not be reached: curl: (22) The requested URL returned error: 400' }) + '\n')
  const list = await actionListText(s.h.host, s.tell)
  expect(list).toContain('ado-workitem-create · failed: HTTP 400')
  expect(list).not.toContain('call lean_thread approve-action')
  expect(s.posts()).toHaveLength(0) // nothing was sent by listing
  // a failure that is not an HTTP answer stays approved
  const s2 = azWorld(() => ({ exitCode: 0, stdout: '{"id":9}' }))
  const r2 = await addActionRequest(s2.h.host, 't5', { ...CREATE, why: 'track it' } as any)
  await answerAction(s2.h.host, r2.request!.id, 'approve', 'pane')
  s2.h.files.set(`${L}/threads/t5/history.jsonl`, JSON.stringify({ ts: 1, kind: 'action-failed', id: r2.request!.id, result: 'no token: az login' }) + '\n')
  expect(await actionListText(s2.h.host, s2.tell)).toContain('call lean_thread approve-action')
})

// ---- G. the open-only list --------------------------------------------------------------------------------------------------------------------------
test('lean_thread list shows the OPEN threads and ends with "N closed (list closed)"; text closed / all shows the rest', async () => {
  const h = loopWorld()
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'old one', project: 'acme', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/threads/t3/thread.json`, JSON.stringify({ id: 't3', title: 'older one', project: 'acme', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const open = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(open).toContain('t1 ')
  expect(open).not.toContain('t2 ')
  expect(open).not.toContain('t3 ')
  expect(open.trimEnd().split('\n').at(-1)).toBe('2 closed (list closed)')
  const closed = (await leanThread(h.host, '/p', { action: 'list', text: 'closed' })).text
  expect(closed).toContain('t2 ')
  expect(closed).toContain('t3 ')
  expect(closed).not.toContain('t1 ')
  const all = (await leanThread(h.host, '/p', { action: 'list', text: 'all' })).text
  for (const id of ['t1 ', 't2 ', 't3 ']) expect(all).toContain(id)
  expect(all).not.toContain('closed (list closed)')
  expect([listScope(undefined), listScope('closed'), listScope(' ALL '), listScope('something else')]).toEqual(['open', 'closed', 'all', 'open'])
  // nothing closed: no last line
  const h2 = loopWorld()
  expect((await leanThread(h2.host, '/p', { action: 'list' })).text).not.toContain('closed')
})

// ---- H. config validate ------------------------------------------------------------------------------------------------------------------------------
test('config validate: keys nothing reads are "not read by any 1.0.x version" and offer lean_config unset; desk: {} and desk: {contextLimit: N} are fine; a bare desk key is explained; unset removes only a flagged key', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, JSON.stringify({ max_thread_sessions: 4, update_channel: 'stable', desk: { contextLimit: 70000 }, threads: {} }, null, 2))
  const r = await configTool(h.host, { action: 'validate' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('unknown setting "max_thread_sessions"')
  expect(r.text).toContain('unknown setting "update_channel"')
  expect(r.text).toContain('not read by any 1.0.x version')
  expect(r.text).toContain('lean_config unset max_thread_sessions removes it')
  expect(r.text).not.toContain('"desk"')
  expect(r.text).not.toContain('desk.contextLimit')
  // the empty group and the group with a value
  for (const desk of [{}, { contextLimit: 70000 }]) {
    h.files.set(`${L}/config.json`, JSON.stringify({ desk }))
    const v = await configTool(h.host, { action: 'validate' })
    expect([JSON.stringify(desk), v.ok, v.text]).toEqual([JSON.stringify(desk), true, expect.stringContaining('0 problems')])
  }
  // desk as a bare key with a value that is not an object: named as a group, with the way out
  for (const bad of ['front', 5, null, ['x']]) {
    h.files.set(`${L}/config.json`, JSON.stringify({ desk: bad }))
    const v = await configTool(h.host, { action: 'validate' })
    expect(v.ok).toBe(false)
    expect(v.text).toContain('"desk" is a group of settings (desk.<name>) and must hold an object')
    expect(v.text).toContain('lean_config unset desk removes it')
    expect(v.text).not.toContain('unknown setting "desk"')
  }
  // unset: not automatic; on request it removes the flagged key and nothing else
  h.files.set(`${L}/config.json`, JSON.stringify({ max_thread_sessions: 4, desk: { contextLimit: 70000 } }))
  const u = await configTool(h.host, { action: 'unset', key: 'max_thread_sessions' })
  expect(u.ok, u.text).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toEqual({ desk: { contextLimit: 70000 } })
  const refuse = await configTool(h.host, { action: 'unset', key: 'no_such_key_at_all' })
  expect(refuse.ok).toBe(false)
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toEqual({ desk: { contextLimit: 70000 } })
  const group = await configTool(h.host, { action: 'unset', key: 'desk' }) // a group holding real settings is not "flagged": not removed
  expect(group.ok).toBe(false)
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toEqual({ desk: { contextLimit: 70000 } })
})

// ---- J. a feedback draft to the feedback folder, no working thread ----------------------------------------------------------------------------
function draftWorld(cfg: object | null = { feedback: { destination: 'folder', folder: '~/Downloads' } }) {
  const h = fakeHost(null)
  resetLocks()
  if (cfg) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  h.files.set(`${L}/feedback-drafts/2026-11-25-menu.md`, '# the menu hides the new setting\n')
  h.files.set(`${L}/feedback-export/2026-11-25-1000.md`, '# export\n')
  h.files.set('/h/Downloads/.keep', '')
  h.files.set('/h/Elsewhere/.keep', '')
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/threads/t5/scratch/feedback-draft.md`, '# from a thread\n')
  h.files.set(`${L}/threads/t5/scratch/notes.md`, 'not a draft')
  h.exec.handler = argv => {
    if (argv[0] !== 'cp') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    const [src, dest] = [argv[argv.length - 2]!, argv[argv.length - 1]!]
    if (h.files.has(dest)) return { exitCode: 1, stdout: '', stderr: 'exists' }
    h.files.set(dest, h.files.get(src)!)
    return { exitCode: 0, stdout: '' }
  }
  return h
}

test('deliver copies a feedback draft into feedback.folder with no thread; the file is never overwritten; one file per call', async () => {
  const h = draftWorld()
  const draft = `${L}/feedback-drafts/2026-11-25-menu.md`
  const a = await deliver(h.host, { file: draft })
  expect(a.ok, a.text).toBe(true)
  expect(h.files.get('/h/Downloads/2026-11-25-menu.md')).toBe('# the menu hides the new setting\n')
  expect(a.text).toContain('/h/Downloads/2026-11-25-menu.md')
  h.files.set(draft, '# changed\n')
  const b = await deliver(h.host, { file: draft, tN: 't0' })
  expect(b.ok, b.text).toBe(true)
  expect(h.files.get('/h/Downloads/2026-11-25-menu.md')).toBe('# the menu hides the new setting\n') // the first copy is untouched
  expect(h.files.get('/h/Downloads/2026-11-25-menu-2.md')).toBe('# changed\n')
  expect(b.text).toContain('nothing was overwritten')
  expect((await deliver(h.host, { file: `${draft}\n${L}/feedback-export/2026-11-25-1000.md` })).ok).toBe(false) // two files are not one call
  const named = await deliver(h.host, { file: `${L}/feedback-export/2026-11-25-1000.md`, name: 'export-for-acme.md', to: 'feedback' })
  expect(named.ok, named.text).toBe(true)
  expect(h.files.get('/h/Downloads/export-for-acme.md')).toBe('# export\n')
  // a thread's scratch file named as a draft, `to` left out
  const t = await deliver(h.host, { tN: 't5', file: `${L}/threads/t5/scratch/feedback-draft.md` })
  expect(t.ok, t.text).toBe(true)
  expect(h.files.get('/h/Downloads/feedback-draft.md')).toBe('# from a thread\n')
})

test('deliver of a feedback draft is refused: outside the folder, feedback.folder not set, destination without folder, an unrelated file, a big file, a name with a slash, a symlink out', async () => {
  const draft = `${L}/feedback-drafts/2026-11-25-menu.md`
  const h = draftWorld()
  const other = await deliver(h.host, { file: draft, to: '/h/Elsewhere' })
  expect(other.ok).toBe(false)
  expect(other.text).toContain('only to feedback.folder')
  expect(h.files.has('/h/Elsewhere/2026-11-25-menu.md')).toBe(false)
  for (const name of ['../x.md', 'a/b.md', '.hidden']) expect((await deliver(h.host, { file: draft, name })).ok).toBe(false)
  expect([...h.files.keys()].filter(k => k.startsWith('/h/Downloads/') && !k.endsWith('.keep'))).toEqual([])
  // not a draft: a thread's other scratch file, a random file, no thread
  expect((await deliver(h.host, { file: '/h/Elsewhere/.keep' })).text).toContain('needs tN')
  expect((await deliver(h.host, { file: `${L}/threads/t5/scratch/notes.md` })).text).toContain('needs tN')
  // a draft path with .. out of the drafts folder is not a draft
  expect((await deliver(h.host, { file: `${L}/feedback-drafts/../threads/t5/scratch/notes.md` })).ok).toBe(false)
  // a symlink inside the drafts folder that points elsewhere
  h.files.set('/h/Elsewhere/secret.md', 'secret')
  h.links.set(`${L}/feedback-drafts/link.md`, '/h/Elsewhere/secret.md')
  expect((await deliver(h.host, { file: `${L}/feedback-drafts/link.md` })).ok).toBe(false)
  expect(h.files.has('/h/Downloads/link.md')).toBe(false)
  // the folder is a symlink out of the user's home
  const hs = draftWorld()
  hs.files.set('/outside/x/.keep', '')
  hs.links.set('/h/Downloads', '/outside/x')
  const esc = await deliver(hs.host, { file: draft })
  expect(esc.ok).toBe(false)
  expect(esc.text).toContain('outside the user\'s home')
  // a big draft
  const hb = draftWorld()
  hb.files.set(`${L}/feedback-drafts/big.md`, 'x'.repeat(300 * 1024))
  const big = await deliver(hb.host, { file: `${L}/feedback-drafts/big.md` })
  expect(big.ok).toBe(false)
  expect(big.text).toContain('at most')
  // feedback.folder not set, destination without folder, no config at all
  const none = draftWorld({ feedback: { destination: 'folder' } })
  expect((await deliver(none.host, { file: draft })).text).toContain('feedback.folder is not set')
  const local = draftWorld({ feedback: { destination: 'local', folder: '~/Downloads' } })
  expect((await deliver(local.host, { file: draft })).text).toContain('only when it includes folder')
  const bare = draftWorld(null)
  expect((await deliver(bare.host, { file: draft })).ok).toBe(false)
  for (const w of [none, local, bare]) expect([...w.files.keys()].filter(k => k.startsWith('/h/Downloads/') && !k.endsWith('.keep'))).toEqual([])
})
