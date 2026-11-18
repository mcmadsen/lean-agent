import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ackRows, loadView, resetViewCache, threadStatus } from './view'
import { resetLocks } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const PANE = {
  plugin: 'lean-agent',
  component: 'Pane',
  requestId: 'lean-agent',
  surface: 'terminal',
  props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function setup(on: any = null, rows: any[] = []) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  const f = (p: string, o: unknown) => h.files.set(`/h/.lean-agent/${p}`, typeof o === 'string' ? o : JSON.stringify(o))
  f('goals.json', { t1: { text: 'ship it', ts: 1_000_000 }, t2: { text: 'old goal', ts: 1 } })
  f('desk/inbox.jsonl', [{ ts: 1, from: 't1', kind: 'report', text: 'first done' }, { ts: 2, from: 't2', kind: 'ask', text: 'which db?' }].map(r => JSON.stringify(r)).join('\n') + '\n')
  f('threads/t1/thread.json', { id: 't1', title: 'one', project: 'p', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0 })
  f('threads/t1/notes.md', 'a\n\nlast note\n')
  f('threads/t2/thread.json', { id: 't2', title: 'two', project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 })
  f('threads/t3/thread.json', { id: 't3', title: 'gone', project: 'p', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 })
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(rows) }
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    return { exitCode: 0, stdout: '' }
  }
  if (on) on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return h
}
// a pane test runs in the desk unless it says otherwise
const inDesk = ($: any, cwd = '/h/lean-agent-desk') => $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)

test('view: goals by tone, answers unread first, threads with state and last line', async () => {
  const h = setup(null, [{ sessionId: SID, name: 'x', cwd: '/x', status: 'busy', startedAt: 1 }])
  const v = await loadView(h.host)
  expect(v.errors).toEqual([])
  expect(v.goals.find(g => g.id === 't1')?.tone).toBe('working')
  expect(v.goals.find(g => g.id === 't2')?.tone).toBe('waiting') // an unread question from t2
  expect(v.unread).toBe(2)
  expect(v.answers[0]!.rec.from).toBe('t2') // newest unread first
  expect(v.threads.map(t => t.id)).toEqual(['t2', 't1']) // closed t3 is hidden
  const t1 = v.threads.find(t => t.id === 't1')!
  expect([t1.run, t1.last, t1.resumable]).toEqual(['running', 'last note', false])
  expect(v.threads.find(t => t.id === 't2')!.resumable).toBe(true)
})

test('view: ack one row and ack all move the read marker', async () => {
  const h = setup()
  await ackRows(h.host, 0)
  expect((await loadView(h.host)).unread).toBe(1)
  await ackRows(h.host, 'all')
  expect((await loadView(h.host)).unread).toBe(0)
})

test('view: a failing claude shows an error and still lists threads', async () => {
  const h = setup()
  h.claude.handler = () => ({ exitCode: 2, stdout: '' })
  const v = await loadView(h.host)
  expect(v.errors.join()).toContain('claude agents exited 2')
  expect(v.threads.length).toBe(2)
  expect(v.threads.every(t => !t.resumable)).toBe(true)
})

test('view: no HOME gives an error row, not a throw', async () => {
  const h = setup()
  h.host.env.get = async () => undefined
  expect((await loadView(h.host)).errors[0]).toContain('HOME')
})

test('thread status line: id, budget, unread inbox', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/inbox.jsonl', '{"ts":1,"text":"hi"}\n')
  expect(await threadStatus(h.host, 't1')).toBe('t1 · budget n/a · 1 unread')
})

test('pane renders on every surface; Resume presses one claude --bg --resume', async ($, on) => {
  const h = setup(on, [])
  await inDesk($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect((await ui.find({ type: 'Text', text: /ship it/ }))?.text).toContain('t1')
    expect(await ui.find({ type: 'Text', text: /1\.0\.2/ })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'resume-t1' })
  const resumes = h.claudeCalls().filter((a: string[]) => a.includes('--resume'))
  expect(resumes.length).toBe(1)
  expect(resumes[0]).toContain(SID)
  await ui.unmount()
})

test('pane shows the error instead of going blank', async ($, on) => {
  const h = setup(on)
  h.claude.handler = () => ({ exitCode: 3, stdout: '' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /error: agents/ }))?.text).toContain('exited 3')
  await ui.unmount()
})

test('view: the pane ack never moves the desk marker, and one row acks only itself', async () => {
  const h = setup()
  await ackRows(h.host, 1)
  expect((await loadView(h.host)).answers.find(a => a.n === 0)!.unread).toBe(true)
  expect(h.files.has('/h/.lean-agent/desk/inbox-read.json')).toBe(false)
})

test('view: the budget footer sums usd from ledger rows', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/ledger.jsonl', JSON.stringify({ ts: h.clock.t, role: 'desk', model: 'x', in: 1, out: 1, cache_read: 0, cache_write: 0, usd: 1.5 }) + '\n')
  expect((await loadView(h.host)).budget).toBe('$1.50')
})

test('view and pane: an open question shows until an answer row closes it', async ($, on) => {
  const h = setup(on, [])
  const q = (o: unknown) => JSON.stringify(o) + '\n'
  h.files.set('/h/.lean-agent/questions.jsonl', q({ ts: 1, from: 't1', question: 'which db?' }) + q({ ts: 2, from: 't2', question: 'which cache?' }))
  h.files.set('/h/.lean-agent/answers.jsonl', q({ ts: 3, q: 2, thread: 't2', text: 'redis' }))
  const v = await loadView(h.host)
  expect(v.openQuestions.map(x => [x.q, x.from, x.question])).toEqual([[1, 't1', 'which db?']])
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /open \? t1: which db\?/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /which cache/ })).toBeFalsy()
  await ui.unmount()
})

test('pane Projects section: name, private, open threads, stale rules; hidden private ones left out', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ p: { path: '/w/p' }, secret: { path: '/w/s', private: true } }))
  h.files.set('/h/.lean-agent/p/learn.json', JSON.stringify({ sha: 'a', areas: { ui: { globs: ['ui/**'], sha: 'a', lines: 5, stale: 'x' } } }))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ private: 'off' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /Projects/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /p · open · 2 thread\(s\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 rule area\(s\) stale/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /secret/ })).toBeFalsy()
  await ui.unmount()
})

test('pane thread row shows the thread\'s model/effort', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'opus', effort: 'high' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /t1 · opus\/high/ })).toBeTruthy()
  await ui.unmount()
})
