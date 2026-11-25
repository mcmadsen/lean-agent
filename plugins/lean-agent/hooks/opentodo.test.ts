// The open-TODO rule (1.0.31): a thread turn that ends while its task list has an open item is continued by script, whatever words the last text used; the
// guards (once per turn end, never while a tool runs, 6 in a row, the user's message). Synthetic ids, names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { peekNotice } from './notices'
import { continueTick, noteTurnEnd, TODO_TEXT } from './continuepending'
import { addActionRequest, resetActions } from './deskactions'
import { threadTool } from './delivery'
import { resetLocks } from './threads'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const pend = (h: any) => JSON.parse(h.files.get(`${T1}/continue-pending.json`) ?? '{}')
const cstate = (h: any) => JSON.parse(h.files.get(`${T1}/continue-state.json`) ?? '{}')

// the user's own text (field report, 1.0.30)
const USER_TEXT = 'The doc update went through. The old "Next: C2" bullet is now replaced by the C3 one, which is what I wanted, so nothing needs restoring. TODO 1 is finished and reported. I\'m continuing with TODO 2 (C3, wiring the handler to the engine) in the next step.'
const TASKS = [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'pending' }, { content: 'TODO 3', status: 'pending' }]

function setup(o: { thread?: Record<string, unknown>; config?: unknown } = {}) {
  resetActivity()
  resetLocks()
  resetActions()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0, ...o.thread }))
  const cfg0 = (o.config ?? { threads: { keepGoing: false } }) as { threads?: object }
  h.files.set(`${L}/config.json`, JSON.stringify({ ...cfg0, threads: { ...cfg0.threads, endNudge: false } })) // (the keep-going default is its own spec; so is the end-nudge, endnudge.test.ts)
  return h
}
const end = (h: any, lastText: string | null, tasks: unknown = TASKS, since = T0 - 60_000) => noteTurnEnd(h.host, 't1', { sid: S1, since, lastText, ...(tasks === null ? {} : { tasks }) }) // tasks null: none passed (the snapshot is read)
const tick = (h: any, sent: string[], rows: any[] = [row()]) => continueTick(h.host, { agents: async () => rows, send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })
const inbox = (h: any, r: Record<string, unknown>) => h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: T0 - 1000, from: 't1', kind: 'report', text: 'x', ...r }) + '\n')

test('the user\'s text: a turn that ends "I\'m continuing with TODO 2 in the next step" with TODO 2 open is continued with the title of the first open item', async () => {
  const h = setup()
  expect(await end(h, USER_TEXT)).toBe('todo')
  expect(pend(h)).toMatchObject({ at: T0, sid: S1, kind: 'todo', text: 'TODO 2' })
  const sent: string[] = []
  h.clock.t = T0 + 19_000
  await tick(h, sent)
  expect(sent).toEqual([])
  h.clock.t = T0 + 21_000
  await tick(h, sent)
  expect(sent).toEqual(['t1|Continue: TODO 2. Do it now; do not end your turn announcing the next step.'])
  expect(TODO_TEXT('TODO 2')).toBe(sent[0]!.slice(3))
  expect(pend(h)).toEqual({}) // once per turn end
  await tick(h, sent)
  expect(sent).toHaveLength(1)
})

test('no phrase is needed: any last text, or no text at all, with an open item (pending or in_progress)', async () => {
  for (const text of ['Whatever words.', 'ok', null]) {
    const h = setup()
    expect(await end(h, text, [{ content: 'Wire it', status: 'in_progress' }])).toBe('todo')
  }
  const h = setup()
  expect(await end(h, 'x', [{ subject: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, 'three'])).toBe('todo')
  expect(pend(h).text).toBe('two')
})

test('the open items come from the snapshot (state.json) when the turn end passes none; a snapshot of another session or an older turn counts for nothing', async () => {
  const snap = (o: Record<string, unknown>) => JSON.stringify({ v: 1, id: 't1', at: T0 - 1000, sid: S1, dir: T1, branch: '', head: '', status: [], diffStat: '', edited: [], tasks: [{ text: 'TODO 2', status: 'pending' }], lastReport: null, questions: [], tokens: null, ...o })
  const h = setup()
  h.files.set(`${T1}/state.json`, snap({}))
  expect(await end(h, 'Going on.', null)).toBe('todo')
  expect(pend(h).text).toBe('TODO 2')
  const other = setup()
  other.files.set(`${T1}/state.json`, snap({ sid: 'other' }))
  expect(await end(other, 'Going on.', null)).toBe('none')
  const old = setup()
  old.files.set(`${T1}/state.json`, snap({ at: T0 - 600_000 }))
  expect(await end(old, 'Going on.', null)).toBe('none')
})

test('a thread with only completed items (or none) is not continued', async () => {
  const h = setup()
  expect(await end(h, 'All items finished.', [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'completed' }])).toBe('none')
  expect(await end(h, 'Fine.', [])).toBe('none')
  expect(await end(h, 'Fine.', [{ content: 'x', status: 'cancelled' }, { content: 'y', status: 'deleted' }])).toBe('none')
  expect(pend(h)).toEqual({})
})

test('done, blocked, a question, a request for the user, waiting, a hard stop, parked, finished, threads.autoContinue false: no continue even with an open item', async () => {
  for (const r of [{ state: 'done' }, { state: 'blocked' }, { state: 'waiting' }, { kind: 'ask' }]) {
    const h = setup()
    inbox(h, r)
    expect(await end(h, 'Going on with TODO 2.')).toBe('none')
  }
  const q = setup()
  expect(await end(q, 'TODO 1 is done. Do you want TODO 2 next?')).toBe('none')
  let h = setup()
  h.files.set(`${T1}/contextstop.json`, JSON.stringify({ sid: S1, at: T0, tokens: 130_000, limit: 120_000, notices: 0, pending: [] }))
  expect(await end(h, 'Going on.')).toBe('none')
  h = setup()
  h.files.set(`${T1}/waiting.json`, JSON.stringify({ since: T0 - 2000, text: 'which branch?' }))
  expect(await end(h, 'Going on.')).toBe('none')
  expect(await end(setup({ thread: { state: 'parked' } }), 'Going on.')).toBe('none')
  expect(await end(setup({ thread: { finished: T0 - 5 } }), 'Going on.')).toBe('none')
  expect(await end(setup({ config: { threads: { keepGoing: false, autoContinue: false } } }), 'Going on.')).toBe('none')
})

test('a pending request for the user (a remote write waits for Approve) is not a turn that forgot its work', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-sid-1' }))
  const reply = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
  const r = await threadTool(h.host, 't1', 'lean_report', { state: 'working', text: 'I need to reply to a PR thread', action: { kind: 'ado-pr-reply', params: reply, why: 'close it' } }, async () => ({ isDelivered: true }))
  expect(r.ok, r.text).toBe(true)
  expect(await end(h, 'Waiting for that, then TODO 2.')).toBe('none')
})

test('never while a tool runs, never after the user\'s own message arrived meanwhile, never for a parked thread or another session', async () => {
  const running = setup()
  await end(running, USER_TEXT)
  const sent: string[] = []
  running.clock.t = T0 + 30_000
  await tick(running, sent, [row({ status: 'busy', state: 'working' })])
  expect(sent).toEqual([])
  expect(pend(running).kind).toBe('todo') // re-checked at the next tick
  await tick(running, sent, [row({ waitingFor: 'permission' })])
  expect(sent).toEqual([])
  const msg = setup()
  await end(msg, USER_TEXT)
  msg.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 + 5_000, kind: 'message' })) // the user wrote meanwhile: the session is woken by that message
  msg.clock.t = T0 + 30_000
  const s2: string[] = []
  await tick(msg, s2)
  expect(s2).toEqual([])
  expect(pend(msg)).toEqual({})
  for (const th of [{ state: 'parked' }, { sid: 'other' }, { finished: 5 }]) {
    const h = setup()
    await end(h, USER_TEXT)
    h.files.set(`${T1}/thread.json`, JSON.stringify({ ...JSON.parse(h.files.get(`${T1}/thread.json`)!), ...th }))
    h.clock.t = T0 + 30_000
    const s3: string[] = []
    await tick(h, s3)
    expect(s3).toEqual([])
  }
})

test('the loop guard: 6 continues in a row without a tool call or a changed task list, then ONE desk notice and no more; a tool call or a changed list lifts it', async () => {
  const h = setup()
  const sent: string[] = []
  const notes: string[] = []
  for (let i = 0; i < 9; i++) {
    h.clock.t = T0 + i * 100_000
    expect(await end(h, `Turn ${i}. I'm continuing with TODO 2 in the next step.`, TASKS, h.clock.t - 60_000)).toBe('todo')
    h.clock.t += 25_000
    notes.push(...(await tick(h, sent)).map(n => n.text))
  }
  expect(sent).toHaveLength(2) // (1.0.33: the one shared counter, at most 2 nudges of any kind with no tool call between: it comes before the old 6)
  expect(notes.filter(n => !n.includes('was continued by the mod'))).toHaveLength(1)
  expect(notes.filter(n => n.includes('t1 is stuck: it ended its turn'))).toHaveLength(1)
  expect(await peekNotice(h.host, 'continue-t1')).toContain('t1 is stuck')
  expect(cstate(h).halted).toBeGreaterThan(0) // the stall state reads it (stall.ts)
  // a changed task list lifts the halt: the next turn end is continued again
  h.clock.t += 100_000
  const changed = [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'completed' }, { content: 'TODO 3', status: 'pending' }]
  await end(h, 'Going on.', changed, h.clock.t - 60_000)
  h.clock.t += 25_000
  await tick(h, sent)
  expect(sent).toHaveLength(3)
  expect(sent[2]).toContain('Continue: TODO 3.')
  expect(cstate(h).stuck).toBeUndefined()
  expect(cstate(h).halted).toBeUndefined()
  expect(await peekNotice(h.host, 'continue-t1')).toBeFalsy()
  // a tool call between the continues also resets the count
  const g = setup()
  const s2: string[] = []
  for (let i = 0; i < 8; i++) {
    g.clock.t = T0 + i * 100_000
    await end(g, 'Going on.', TASKS, g.clock.t - 60_000)
    g.files.set(`${T1}/activity.json`, JSON.stringify({ at: g.clock.t - 30_000, kind: 'tool' }))
    g.clock.t += 25_000
    await tick(g, s2)
  }
  expect(s2).toHaveLength(8)
})

test('it works with keep-going on too (the open item wins over the plain "Continue with the next step"), and without a task list keep-going is the plain one', async () => {
  const h = setup({ thread: { keepGoing: true } })
  expect(await end(h, 'Going on.')).toBe('todo')
  expect(await end(h, 'Going on.', [])).toBe('keep')
  const sent: string[] = []
  await end(h, 'Going on.')
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent).toEqual(['t1|Continue: TODO 2. Do it now; do not end your turn announcing the next step.'])
})

test('a turn that announces a restart is the checkpoint\'s, not a todo continue', async () => {
  const h = setup()
  expect(await end(h, 'My context is near its cap.\nNext: a fresh session continues with TODO 2')).toBe('next')
  expect(pend(h).kind).toBe('next')
})
