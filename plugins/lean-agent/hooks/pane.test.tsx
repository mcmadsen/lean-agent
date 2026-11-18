import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ackRows, loadView, threadStatus } from './view'
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
  return h
}

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
  await ackRows(h.host, 1)
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
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect((await ui.find({ type: 'Text', text: /ship it/ }))?.text).toContain('t1')
    expect(await ui.find({ type: 'Text', text: /1\.0\.0/ })).toBeTruthy()
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
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /error: agents/ }))?.text).toContain('exited 3')
  await ui.unmount()
})
