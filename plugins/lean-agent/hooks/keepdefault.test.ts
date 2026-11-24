// 1.0.31: keep-going is ON by default for review-free work threads (config threads.keepGoing, default true); the per-thread `keep-going off` and every stop still win.
// Synthetic ids, names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { resetLocks, leanThread } from './threads'
import { resetActions } from './deskactions'
import { threadTool } from './delivery'
import { continueTick, noteTurnEnd, MAX_TODO_CONSECUTIVE, KEEP_TEXT } from './continuepending'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const pend = (h: any) => JSON.parse(h.files.get(`${T1}/continue-pending.json`) ?? '{}')

function setup(o: { thread?: Record<string, unknown>; config?: unknown } = {}) {
  resetActivity()
  resetLocks()
  resetActions()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0, ...o.thread }))
  h.files.set(`${L}/config.json`, JSON.stringify({ ...(o.config as object | undefined), threads: { ...(o.config as { threads?: object } | undefined)?.threads, endNudge: false } })) // (1.0.32: the end-nudge has its own specs, endnudge.test.ts)
  return h
}
const end = (h: any, lastText: string | null) => noteTurnEnd(h.host, 't1', { sid: S1, since: T0 - 60_000, lastText, tasks: [] })
const tick = (h: any, sent: string[]) => continueTick(h.host, { agents: async () => [row()], send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })
const inbox = (h: any, r: Record<string, unknown>) => h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: T0 - 1000, from: 't1', kind: 'report', text: 'x', ...r }) + '\n')

test('a plain work thread with no flag and no config is continued at a turn end (default on)', async () => {
  const h = setup()
  expect(await end(h, 'Finished the module.')).toBe('keep')
  const sent: string[] = []
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent).toEqual([`t1|${KEEP_TEXT}`])
})

test('config threads.keepGoing false, or `keep-going off` on the thread, switches it off; an explicit on beats a config off', async () => {
  expect(await end(setup({ config: { threads: { keepGoing: false } } }), 'Finished the module.')).toBe('none')
  expect(await end(setup({ thread: { keepGoing: false } }), 'Finished the module.')).toBe('none')
  expect(await end(setup({ thread: { keepGoing: false }, config: { threads: { keepGoing: true } } }), 'Finished the module.')).toBe('none')
  expect(await end(setup({ thread: { keepGoing: true }, config: { threads: { keepGoing: false } } }), 'Finished the module.')).toBe('keep')
  expect(await end(setup({ config: { threads: { keepGoing: true } } }), 'Finished the module.')).toBe('keep')
})

test('a review thread is not covered by the default (its marker is in the mod store); an explicit on is', async () => {
  const h = setup()
  await h.host.store.set('review.marker.t1', { kind: 'review', project: 'app', ref: '42', ts: 1 })
  expect(await end(h, 'Reviewed the diff.')).toBe('none')
  const g = setup({ thread: { keepGoing: true } })
  await g.host.store.set('review.marker.t1', { kind: 'review', project: 'app', ref: '42', ts: 1 })
  expect(await end(g, 'Reviewed the diff.')).toBe('keep')
})

test('the stops still win under the default: done, blocked, waiting, an ask, a question, a hard stop, a thread told to wait, parked, finished', async () => {
  for (const r of [{ state: 'done' }, { state: 'blocked' }, { state: 'waiting' }, { kind: 'ask' }]) {
    const h = setup()
    inbox(h, r)
    expect(await end(h, 'Finished the module.')).toBe('none')
  }
  expect(await end(setup(), 'Which branch do you want?')).toBe('none')
  let h = setup()
  h.files.set(`${T1}/contextstop.json`, JSON.stringify({ sid: S1, at: T0, tokens: 130_000, limit: 120_000, notices: 0, pending: [] }))
  expect(await end(h, 'Finished the module.')).toBe('none')
  h = setup()
  h.files.set(`${T1}/waiting.json`, JSON.stringify({ since: T0 - 2000, text: 'wait for the user: which branch?' }))
  expect(await end(h, 'Waiting as told.')).toBe('none')
  expect(await end(setup({ thread: { state: 'parked' } }), 'ok')).toBe('none')
  expect(await end(setup({ thread: { finished: T0 - 5 } }), 'ok')).toBe('none')
})

test('a pending request for the user stops the plain keep-going continue too', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-sid-1' }))
  const reply = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
  const r = await threadTool(h.host, 't1', 'lean_report', { state: 'working', text: 'I need to reply to a PR thread', action: { kind: 'ado-pr-reply', params: reply, why: 'close it' } }, async () => ({ isDelivered: true }))
  expect(r.ok, r.text).toBe(true)
  expect(await end(h, 'Waiting for that.')).toBe('none')
})

test('switched off after the record was written: the timer drops it; a default thread that keeps ending its turns is silenced after 6 in a row without a tool call', async () => {
  const h = setup()
  await end(h, 'ok')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { keepGoing: false, endNudge: false } }))
  h.clock.t = T0 + 25_000
  const s1: string[] = []
  await tick(h, s1)
  expect(s1).toEqual([])
  expect(pend(h)).toEqual({})
  const g = setup()
  const sent: string[] = []
  for (let i = 0; i < 10; i++) {
    g.clock.t = T0 + i * 100_000
    await end(g, 'ok')
    g.clock.t += 25_000
    expect(await tick(g, sent)).toEqual([]) // silent: a finished thread that forgot to report is not an alarm
  }
  expect(sent).toHaveLength(MAX_TODO_CONSECUTIVE)
  g.files.set(`${T1}/activity.json`, JSON.stringify({ at: g.clock.t + 1_000, kind: 'tool' }))
  g.clock.t += 5_000
  await tick(g, sent)
  g.clock.t += 100_000
  await end(g, 'ok')
  g.clock.t += 25_000
  await tick(g, sent)
  expect(sent).toHaveLength(MAX_TODO_CONSECUTIVE + 1) // a tool call lifted it
})

test('lean_thread keep-going off stores an explicit off, on stores on, new keepGoing false is kept; the list shows keep-going only for an explicit on', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1', on: false })
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).keepGoing).toBe(false)
  expect((await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1' })).data).toEqual({ keepGoing: false })
  await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1', on: true })
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).keepGoing).toBe(true)
  const g = setup()
  expect((await leanThread(g.host, '/p', { action: 'list' })).text).not.toContain('keep-going') // the default is not repeated on every row
  expect((await leanThread(g.host, '/p', { action: 'keep-going', tN: 't1' })).data).toEqual({ keepGoing: true })
})
