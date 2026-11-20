// The state snapshot (snapshot.ts) and the handover that carries it, its size budget and `lean_doctor handover` (handover.ts).
// Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { buildSnapshot, currentTasks, noteEdited, noteTasks, readSnapshot, resetEdited, resetTasks, snapshotText, takeEdited, tasksOf, writeSnapshot } from './snapshot'
import { buildHandover, fitParts, handoverReport, handoverTokens, setPreflight } from './handover'
import type { Part } from './handover'

const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const THREAD = { id: 't1', title: 'fix login', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }

function setup(o: { git?: boolean; config?: unknown } = {}) {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { path: '/w/app', branch: 'fix-x', thread: 't1' } }))
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  if (o.git !== false) {
    h.git.handler = a => {
      const cmd = a.slice(2).join(' ')
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'fix-x\n' }
      if (cmd === 'rev-parse HEAD') return { exitCode: 0, stdout: 'abc1234567890def\n' }
      if (cmd === 'status --short') return { exitCode: 0, stdout: ' M src/a.ts\n?? src/b.ts\n' }
      if (cmd === 'diff --stat HEAD') return { exitCode: 0, stdout: ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n' }
      return { exitCode: 1, stdout: '' }
    }
  }
  return h
}
const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'

test('snapshot: branch, HEAD, status, diff stat, edited files, tasks, last report, open questions, context, written atomically', async () => {
  const h = setup()
  h.files.set(`${L}/desk/inbox.jsonl`, rec({ ts: 10, from: 't1', kind: 'report', state: 'working', text: 'login form done' }) + rec({ ts: 20, from: 't1', kind: 'ask', text: 'which db?' }) + rec({ ts: 30, from: 't2', kind: 'ask', text: 'other thread' }))
  const s = await buildSnapshot(h.host, '/h', 't1', { sid: 's1', tokens: 98_765.4, edited: ['/w/app/src/a.ts'], tasks: [{ content: 'write the spec', status: 'in_progress' }, 'ship it'] })
  expect(s.branch).toBe('fix-x')
  expect(s.head).toBe('abc1234567890def')
  expect(s.dir).toBe('/w/app')
  expect(s.status).toEqual([' M src/a.ts', '?? src/b.ts'])
  expect(s.diffStat).toContain('1 file changed')
  expect(s.edited).toEqual(['/w/app/src/a.ts'])
  expect(s.tasks).toEqual([{ text: 'write the spec', status: 'in_progress' }, { text: 'ship it', status: 'pending' }])
  expect(s.lastReport).toEqual({ ts: 10, state: 'working', text: 'login form done' })
  expect(s.questions).toEqual(['which db?'])
  expect(s.tokens).toBe(98_765)
  expect(await writeSnapshot(h.host, '/h', s)).toBe(true)
  expect([...h.files.keys()].filter(k => k.includes('.tmp'))).toEqual([]) // tmp file + mv
  expect((await readSnapshot(h.host, '/h', 't1'))?.head).toBe('abc1234567890def')
  expect(JSON.parse(h.files.get(`${T1}/state.json`)!).branch).toBe('fix-x')
})

test('snapshot: a failing git leaves empty fields, never an error; a mod record is not the last report', async () => {
  const h = setup({ git: false })
  h.files.set(`${L}/desk/inbox.jsonl`, rec({ ts: 10, from: 't1', kind: 'report', state: 'working', text: 'real' }) + rec({ ts: 20, from: 't1', kind: 'report', state: 'checkpoint', mod: true, text: 'context over the limit' }))
  const s = await buildSnapshot(h.host, '/h', 't1', {})
  expect([s.branch, s.head, s.status, s.diffStat]).toEqual(['', '', [], ''])
  expect(s.lastReport?.text).toBe('real')
  expect(s.tokens).toBe(null)
})

test('snapshot: the edited-files tracker and the tolerant task list', () => {
  resetEdited()
  noteEdited('/a')
  noteEdited('/a')
  noteEdited(42)
  noteEdited('/b')
  expect(takeEdited()).toEqual(['/a', '/b'])
  resetEdited()
  expect(takeEdited()).toEqual([])
  expect(tasksOf(null)).toEqual([])
  expect(tasksOf([{ subject: 'x', status: 'done' }, {}, 5, ' y '])).toEqual([{ text: 'x', status: 'done' }, { text: 'y', status: 'pending' }])
})

test('snapshot: the task list follows TodoWrite, TaskCreate and TaskUpdate', () => {
  resetTasks()
  noteTasks('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] })
  expect(currentTasks()).toEqual([{ text: 'a', status: 'pending' }])
  noteTasks('TaskCreate', { subject: 'b' })
  noteTasks('TaskUpdate', { taskId: '2', status: 'completed' })
  noteTasks('TaskUpdate', { taskId: '9', status: 'completed' }) // unknown id: ignored
  noteTasks('Other', { todos: [] })
  expect(currentTasks()).toEqual([{ text: 'a', status: 'pending' }, { text: 'b', status: 'completed' }])
  resetTasks()
  expect(currentTasks()).toEqual([])
})

test('handover: carries the snapshot; no preflight module is no section', async () => {
  const h = setup()
  await writeSnapshot(h.host, '/h', await buildSnapshot(h.host, '/h', 't1', { sid: 's1', tokens: 5000, edited: ['/w/app/src/a.ts'], tasks: ['ship it'] }))
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  expect(ho.prompt).toContain('## State at the end of the last turn (state.json)')
  expect(ho.prompt).toContain('branch: fix-x · HEAD abc1234567')
  expect(ho.prompt).toContain('[pending] ship it')
  expect(ho.prompt).toContain(' M src/a.ts')
  expect(ho.prompt).not.toContain('## Preflight')
  expect(ho.missing!.some(m => m.includes('snapshot'))).toBe(false)
  expect(snapshotText((await readSnapshot(h.host, '/h', 't1'))!, 1_000_000)).toContain('taken under a minute ago')
})

test('handover: a registered preflight is a section; a failing one is none', async () => {
  const h = setup()
  setPreflight(async () => '  branch is rebased on main  ')
  expect((await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt).toContain('## Preflight\nbranch is rebased on main')
  setPreflight(async () => {
    throw new Error('boom')
  })
  expect((await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])).prompt).not.toContain('## Preflight')
  setPreflight(null)
})

test('handover: the size budget cuts the least needed first and every cut line names its file', async () => {
  const h = setup({ config: { handoverTokens: 700 } })
  expect(await handoverTokens(h.host, '/h')).toBe(700)
  h.files.set(`${T1}/notes.md`, Array.from({ length: 200 }, (_, i) => `note line ${i} with some words in it`).join('\n'))
  h.files.set(`${L}/memory/notes.jsonl`, Array.from({ length: 20 }, (_, i) => rec({ from: 't1', text: `remember item ${i} `.repeat(8) })).join(''))
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'Because.', [])
  expect(ho.prompt).toContain(`full text in ${T1}/notes.md`)
  expect(ho.prompt).toContain(`full text in ${L}/memory/notes.jsonl`)
  expect(ho.prompt).toContain('Resume the work now') // the task line is never cut
  expect(ho.prompt.length).toBeLessThan(9_000) // (budget 2800 chars; the fixed lines are never cut)
  expect(ho.parts!.find(p => p.name === 'notes')!.cut).toBe(true)
  // the default budget is 6000 tokens
  expect(await handoverTokens(setup().host, '/h')).toBe(6000)
  // a nonsense value is the default
  expect(await handoverTokens(setup({ config: { handoverTokens: 3 } }).host, '/h')).toBe(6000)
})

test('handover: fitParts drops the oldest report lines first and names the inbox', () => {
  const parts: Part[] = [
    { name: 'lead', body: 'lead', mode: 'fixed' },
    { name: 'reports', head: '## R', body: ['- one '.repeat(40), '- two '.repeat(40), '- three newest'].join('\n'), file: '/h/.lean-agent/desk/inbox.jsonl', mode: 'lines' },
  ]
  const out = fitParts(parts, 200)
  const r = out.find(p => p.name === 'reports')!
  expect(r.body).toContain('three newest')
  expect(r.body).not.toContain('- one')
  expect(r.body).toContain('full text in /h/.lean-agent/desk/inbox.jsonl')
  expect(parts[1]!.body).toContain('- one') // the input is untouched
})

test('lean_doctor handover: sections with their tokens and what is missing', async () => {
  const h = setup()
  const text = await handoverReport(h.host, '/h', 't1')
  expect(text).toContain('handover for t1 (fix login): ~')
  expect(text).toContain('of a budget of 6000')
  expect(text).toMatch(/brief\s+~\s*\d+ tokens/)
  expect(text).toContain('no goal')
  expect(text).toContain('no notes')
  expect(text).toContain('no snapshot')
  expect(text).toContain('--- the prompt, as a fresh session gets it ---')
  expect(await handoverReport(h.host, '/h', 't9')).toBe('no thread t9')
  // with a goal, notes and a snapshot nothing of those is missing
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'fix the login' } }))
  h.files.set(`${T1}/notes.md`, 'a note')
  await writeSnapshot(h.host, '/h', await buildSnapshot(h.host, '/h', 't1', { sid: 's1', tokens: 1 }))
  const full = await handoverReport(h.host, '/h', 't1')
  expect(full).not.toContain('no goal')
  expect(full).not.toContain('no notes')
  expect(full).not.toContain('no snapshot')
})
