// 1.0.31: the desk sees what the mod did for a thread: one line per continue in the thread's record, "continued N x" in `lean_thread list`, the first one per thread is
// said once in the desk, the rest are only counted. Synthetic ids, names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { resetLocks, leanThread } from './threads'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { continueTick, noteTurnEnd } from './continuepending'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const log = (h: any) => (h.files.get(`${T1}/continue-log.jsonl`) ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
const TASKS = [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'pending' }]

function setup() {
  resetActivity()
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0 }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { keepGoing: false } }))
  return h
}
async function cycle(h: any, i: number, tasks: unknown, text = 'Going on in the next step.') {
  h.clock.t = T0 + i * 100_000
  await noteTurnEnd(h.host, 't1', { sid: S1, since: h.clock.t - 60_000, lastText: text, tasks })
  h.clock.t += 25_000
  const sent: string[] = []
  const notes = await continueTick(h.host, { agents: async () => [row()], send: async (id: string, t: string) => (sent.push(`${id}|${t}`), { ok: true, text: 'sent' }) })
  return { sent, notes }
}

test('a continue by the open-TODO rule writes one line to the thread record, counts it, and says it once in the desk (the first one)', async () => {
  const h = setup()
  const a = await cycle(h, 0, TASKS)
  expect(a.sent).toHaveLength(1)
  expect(a.notes).toEqual([{ id: 't1', text: 't1 was continued by the mod: open TODO 2 (further continues are counted in the list, not announced)' }])
  expect(log(h)).toEqual([expect.objectContaining({ at: T0 + 25_000, kind: 'todo', text: 'continued by the mod: open TODO 2' })])
  expect(JSON.parse(h.files.get(`${T1}/continue-state.json`)!).total).toBe(1)
  const b = await cycle(h, 1, [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'in_progress' }])
  expect(b.sent).toHaveLength(1)
  expect(b.notes).toEqual([]) // counted silently
  expect(log(h)).toHaveLength(2)
  expect(JSON.parse(h.files.get(`${T1}/continue-state.json`)!).total).toBe(2)
})

test('a continue by an announcement ("next:") is written and counted the same way; a plain keep-going continue is not', async () => {
  const h = setup()
  const a = await cycle(h, 0, [], 'Report.\nNext: wire the timer')
  expect(a.sent).toHaveLength(1)
  expect(log(h)).toEqual([expect.objectContaining({ kind: 'next', text: 'continued by the mod: announced "wire the timer"' })])
  expect(a.notes).toHaveLength(1)
  const k = setup()
  k.files.set(`${L}/config.json`, JSON.stringify({ threads: { keepGoing: true } }))
  const b = await cycle(k, 0, [], 'Finished the module.')
  expect(b.sent).toHaveLength(1)
  expect(log(k)).toEqual([])
  expect(b.notes).toEqual([])
})

test('a failed send writes nothing and counts nothing', async () => {
  const h = setup()
  await noteTurnEnd(h.host, 't1', { sid: S1, since: T0 - 60_000, lastText: 'x', tasks: TASKS })
  h.clock.t = T0 + 25_000
  await continueTick(h.host, { agents: async () => [row()], send: async () => ({ ok: false, text: 'no' }) })
  expect(log(h)).toEqual([])
  expect(JSON.parse(h.files.get(`${T1}/continue-state.json`) ?? '{}').total).toBeUndefined()
})

test('lean_thread list shows "continued N x" for a thread the mod continued, nothing for one it did not', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).not.toContain('continued')
  await cycle(h, 0, TASKS)
  await cycle(h, 1, TASKS)
  await cycle(h, 2, TASKS)
  const text = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(text).toContain('continued 3 x')
  const verbose = (await leanThread(h.host, '/p', { action: 'list', verbose: true })).text
  expect(verbose).toContain('continued 3 x')
})
