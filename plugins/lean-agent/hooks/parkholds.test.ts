// A PARKED thread is never started, resumed, woken or continued by any automatic path, and `park` clears the pending markers (parkclear.ts). Synthetic ids only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { resetActivity } from './threadstate'
import { autoRestartTick } from './autorestart'
import { stallTick } from './stall'
import { deliveryTick, resetUnavailable, setThreadSender } from './deliver-to-thread'
import { limitTick, readLimit, writeLimit } from './limits'
import { chase } from './chaser'
import { continueTick } from './continuepending'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 50_000_000
const MIN = 60_000

function setup(state = 'parked') {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetActivity()
  resetUnavailable()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state, sid: S1, created: 1, lastWake: T0 - 3 * 60 * MIN, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  const calls: string[] = []
  const row = { sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '' }
  h.claude.handler = (a: string[]) => {
    calls.push(a[0] ?? '')
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify([row]) }
    return { exitCode: 0, stdout: '' }
  }
  const started = () => calls.filter(c => c === '--bg' || c === 'resume' || c === 'stop' || c === '--resume').length
  return { h, row: { ...row, sid: S1 } as any, calls, started }
}
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? 'null')

test('park clears the restart marker, continue-pending, the delivery watch and the usage-limit record; queued messages stay', async () => {
  const { h } = setup('open')
  h.files.set(`${T1}/autorestart.json`, JSON.stringify({ pending: { ts: T0, sid: S1, tokens: 130_000, limit: 120_000 }, last: { at: 5, oldSid: 'x' } }))
  h.files.set(`${T1}/continue-pending.json`, JSON.stringify({ at: T0, sid: S1, kind: 'next', text: 'go' }))
  h.files.set(`${T1}/delivery.json`, JSON.stringify({ at: T0, sid: S1, from: 0, upTo: 1, kind: 'instruction' }))
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: T0, text: 'please look' }) + '\n')
  await writeLimit(h.host, '/h', 't1', { resetAt: T0 + 60 * MIN, seenAt: T0, source: 'mod', sid: S1 })
  expect((await leanThread(h.host, ROOT, { action: 'park', tN: 't1' })).text).toBe('t1 parked')
  expect(json(h, `${T1}/autorestart.json`)).toEqual({ last: { at: 5, oldSid: 'x' } })
  expect(json(h, `${T1}/continue-pending.json`)).toEqual({})
  expect(json(h, `${T1}/delivery.json`)).toEqual({})
  expect((await readLimit(h.host, '/h', 't1'))?.cancelled).toBe('parked')
  expect(h.files.get(`${T1}/inbox.jsonl`)).toContain('please look')
})

test('auto restart at the context limit: a parked thread with the marker present is not restarted', async () => {
  const { h, row, started } = setup()
  h.files.set(`${T1}/autorestart.json`, JSON.stringify({ pending: { ts: T0 - 5 * MIN, sid: S1, tokens: 130_000, limit: 120_000 } }))
  const restarts: string[] = []
  const notes = await autoRestartTick(h.host, { agents: async () => [{ ...row, state: 'idle' }], restart: async id => (restarts.push(id), { ok: true, text: '', data: { fresh: true } }) })
  expect(restarts).toEqual([])
  expect(notes).toEqual([])
  expect(started()).toBe(0)
  expect(json(h, `${T1}/autorestart.json`).pending).toBeUndefined()
})

test('stall restart (also at 80% of the context limit): a parked thread is not restarted', async () => {
  const { h, row } = setup()
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { stallRestart: true } }))
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - 30 * MIN, kind: 'tool' }))
  h.files.set(`${T1}/context.json`, JSON.stringify({ tokens: 115_000, at: T0 - 31 * MIN, sid: S1 }))
  const restarts: string[] = []
  expect(await stallTick(h.host, { agents: async () => [row], restart: async id => (restarts.push(id), { ok: true, text: '', data: { fresh: true } }) })).toEqual([])
  expect(restarts).toEqual([])
})

test('escalation (answer-restart): a parked thread with a delivery watch is not restarted, the watch is dropped', async () => {
  const { h, row } = setup()
  h.files.set(`${T1}/delivery.json`, JSON.stringify({ at: T0 - 2 * MIN, sid: S1, from: 0, upTo: 1, kind: 'instruction' }))
  const restarts: string[] = []
  expect(await deliveryTick(h.host, { agents: async () => [{ ...row, state: 'idle', status: 'idle' }], restart: async id => (restarts.push(id), { ok: true, text: '', data: { fresh: true } }) })).toEqual([])
  expect(restarts).toEqual([])
  expect(json(h, `${T1}/delivery.json`)).toEqual({})
})

test('usage-limit resume: a parked thread is not resumed and its record is cancelled', async () => {
  const { h, row } = setup()
  await writeLimit(h.host, '/h', 't1', { resetAt: T0 - 10 * MIN, seenAt: T0 - 60 * MIN, source: 'mod', sid: S1 })
  const resumed: string[] = []
  await limitTick(h.host, { agents: async () => [{ sid: S1, id: 't1', state: 'blocked', waitingFor: '' }], logs: async () => null, resume: async id => (resumed.push(id), { ok: true, text: '' }) })
  expect(resumed).toEqual([])
  expect((await readLimit(h.host, '/h', 't1'))?.cancelled).toBe('parked')
  void row
})

test('chaser: a parked thread gets no status message', async () => {
  const { h } = setup()
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  const sent: string[] = []
  await chase(h.host, async id => void sent.push(id))
  expect(sent).toEqual([])
})

test('continue-by-script: a parked thread with the record present is not continued', async () => {
  const { h, row } = setup()
  h.files.set(`${T1}/continue-pending.json`, JSON.stringify({ at: T0 - MIN, sid: S1, kind: 'next', text: 'go on' }))
  const sent: string[] = []
  await continueTick(h.host, { agents: async () => [{ ...row, state: 'idle', status: 'idle' }], send: async id => (sent.push(id), { ok: true, text: '' }) })
  expect(sent).toEqual([])
  expect(json(h, `${T1}/continue-pending.json`)).toEqual({})
})

test('deliver-to-thread, approval-result messages, the chaser and scheduled sends all end in `send`: a parked thread is not delivered to or woken, the message is queued', async () => {
  const { h, started } = setup()
  const direct: string[] = []
  setThreadSender(async (sid, text) => void direct.push(`${sid}|${text}`))
  const r = await leanThread(h.host, ROOT, { action: 'send', tN: 't1', text: 'The user approved your request a1-1 and the desk sent it.', internal: true }) // (the mod's own sends are internal; the desk's own send to a parked thread unparks it since 1.0.35: fix751.test.ts)
  setThreadSender(null)
  expect(r.text).toBe('t1 is parked: message queued, no wake')
  expect(direct).toEqual([])
  expect(started()).toBe(0)
  expect(h.files.get(`${T1}/inbox.jsonl`)).toContain('The user approved your request')
  const w = await leanThread(h.host, ROOT, { action: 'wake', tN: 't1' })
  expect(w.text).toBe('t1 is parked: message queued, no wake')
})

test('the restart actions of the timers refuse a parked thread inside the lock (the moment they act), and start nothing', async () => {
  const { h, started } = setup()
  for (const action of ['auto-restart', 'stall-restart', 'answer-restart', 'limit-resume']) {
    const r = await leanThread(h.host, ROOT, { action, tN: 't1', rewind: 0, force: true })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('is parked')
  }
  expect(started()).toBe(0)
})
