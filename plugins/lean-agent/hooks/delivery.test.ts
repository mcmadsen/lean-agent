import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { consumeWake, sweep, takeBatch, takeReports, threadTool, unreadReports } from './delivery'
import { leanThread, resetLocks } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const T = '/h/.lean-agent/threads/t1'

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk')
  const state = { rows: [] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  return { h, state, call: (i: any) => leanThread(h.host, '/p', i) }
}
const running = (state: any) => (state.rows = [{ sessionId: SID, name: 't1 · a', cwd: T, status: 'busy', startedAt: 1 }])

test('a queued message is delivered exactly once to a busy thread', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  running(state)
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'also b' })
  const first = await takeBatch(h.host, 't1')
  expect(first).toContain('also b')
  expect(first).toContain('message from the desk')
  expect(await takeBatch(h.host, 't1')).toBeNull()
  await call({ action: 'send', tN: 't1', text: 'and c' })
  const second = await takeBatch(h.host, 't1')
  expect(second).toContain('and c')
  expect(second).not.toContain('also b')
})

test('a wake prompt carries its inbox mark: the prompt hook consumes it, the tool hook adds nothing', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: T, status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'wake me' })
  const argv = h.claudeCalls().find(a => a.includes('--resume'))!
  const prompt = argv[argv.length - 1]!
  expect(prompt).toContain('wake me')
  expect(await consumeWake(h.host, 't1', prompt)).toBe(true)
  expect(await takeBatch(h.host, 't1')).toBeNull()
  expect(await consumeWake(h.host, 't1', 'plain prompt')).toBe(false)
})

test('a message after the last tool call is delivered by the sweep, once', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  running(state)
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'late' }) // queued: running
  state.rows[0].status = 'idle' // the turn ended without reading it
  const woken: string[] = []
  expect(await sweep(h.host, async id => { woken.push(id); await call({ action: 'wake', tN: id }) })).toEqual(['t1'])
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(1)
  // the batch is now delivered: a second sweep finds nothing
  expect(await sweep(h.host, async id => woken.push(id))).toEqual([])
})

test('lean_report, lean_ask, lean_goal and lean_remember write; the desk reads each report once', async () => {
  const { h } = setup()
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'done with x', state: 'done' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_ask', { question: 'which db?', options: ['a', 'b'] })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_goal', { update: 'ship login' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_remember', { text: 'uses pnpm' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_report', {})).ok).toBe(false)
  expect(JSON.parse(h.files.get('/h/.lean-agent/goals.json')!).t1.text).toBe('ship login')
  expect(h.files.get('/h/.lean-agent/questions.jsonl')).toContain('which db?')
  expect((await unreadReports(h.host)).recs.length).toBe(2)
  const text = await takeReports(h.host)
  expect(text).toContain('report from t1 (done): done with x')
  expect(text).toContain('question from t1')
  expect(text).toContain('a | b')
  expect(await takeReports(h.host)).toBeNull()
})
