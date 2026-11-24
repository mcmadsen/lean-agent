// Messages to a thread: delivery states (msgstate.ts), `lean_thread messages tN`, the reply of `send`, the unread escalation by script,
// the answer that clears waiting, the idle-without-report alert and the restart that carries in-flight corrections. Synthetic ids and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { deliveryTick, resetUnavailable, setThreadSender } from './deliver-to-thread'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { resetActivity } from './threadstate'
import { takeBatch } from './delivery'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 1_000_000
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? '{}')

function setup(o: { row?: Record<string, unknown>; direct?: boolean; config?: unknown } = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetActivity()
  resetUnavailable()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  const st = { rows: [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const sent: { sid: string; text: string }[] = []
  // direct: the desk's session can send (SendMessage); default false = "this session has no SendMessage tool" (the field report)
  setThreadSender(o.direct ? async (sid, text) => void sent.push({ sid, text }) : null)
  const rows = async () => st.rows.map(r => ({ sid: r.sessionId, name: '', cwd: r.cwd, status: r.status, state: r.state, startedAt: 1, pid: r.pid, id: r.id, waitingFor: r.waitingFor ?? '' })) as any
  const restarts: { id: string; why: string; rewind: number }[] = []
  const deps = { agents: rows, restart: async (id: string, why: string, rewind: number) => (restarts.push({ id, why, rewind }), { ok: true, text: 'restarted', data: { fresh: true } }) }
  return { h, st, sent, deps, restarts }
}
const send = (h: any, text: string) => leanThread(h.host, ROOT, { action: 'send', tN: 't1', text })
const messages = (h: any) => leanThread(h.host, ROOT, { action: 'messages', tN: 't1' })
const activity = (h: any, at: number, kind = 'tool') => h.files.set(`${T1}/activity.json`, JSON.stringify({ at, kind }))
const after = <T>(f: () => T) => {
  try {
    return f()
  } finally {
    setThreadSender(null)
  }
}

// ---- 1. delivery state ---------------------------------------------------------------------------------------------------------------
test('send to a working thread without a direct route: "m1: queued, not read yet" and what will happen', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  const r = await send(h, 'use sqlite')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('m1: queued, not read yet')
  expect(r.text).toContain('only be reached through its inbox')
  expect(r.text).toContain('next tool call')
  expect(r.text).toContain('45 s')
  after(() => 0)
})

test('send with a direct route: "delivered", not "queued"', { timeoutMs: 20_000 }, async () => {
  const { h, sent } = setup({ direct: true })
  const r = await send(h, 'use sqlite')
  expect(sent).toHaveLength(1)
  expect(r.text).toContain('m1: delivered')
  expect(r.text).not.toContain('only be reached through its inbox')
  after(() => 0)
})

test('the thread-side mod reads the inbox at its next tool call: the message becomes consumed, with readAt', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'use sqlite')
  expect((await messages(h)).text).toContain('m1 queued')
  h.clock.t = T0 + 20_000
  expect(await takeBatch(h.host, 't1')).toContain('use sqlite')
  const m = (await messages(h)).text
  expect(m).toContain('m1 consumed')
  expect(m).toContain('use sqlite')
  expect(json(h, `${T1}/msgs.json`)['1'].readAt).toBe(T0 + 20_000)
  after(() => 0)
})

test('`messages tN` lists the last messages with state and age, no model call', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'first')
  h.clock.t = T0 + 4 * 60_000
  await send(h, 'second')
  await takeBatch(h.host, 't1')
  h.clock.t = T0 + 5 * 60_000
  await send(h, 'third')
  const m = (await messages(h)).text
  const lines = m.split('\n')
  expect(lines[0]).toContain('t1')
  expect(m).toMatch(/m1 consumed .*5 min.*first/)
  expect(m).toMatch(/m3 queued .*third/)
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(0)
  after(() => 0)
})

test('messages without tN, or for a thread with no messages, says so', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  expect((await leanThread(h.host, ROOT, { action: 'messages' })).ok).toBe(false)
  expect((await messages(h)).text).toContain('no messages')
  after(() => 0)
})
