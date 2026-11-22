import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ackRows, loadView, resetViewCache, threadStatus } from './view'
import { deskClaudeMd, resetLocks } from './threads'
import { hashText } from './recipe'

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

test('view: the scripts line counts candidates and adopted scripts', async () => {
  const h = setup()
  const meta = (status: string) => JSON.stringify({ name: 'n', sha256: 'x', status })
  expect((await loadView(h.host)).scripts).toEqual({ candidates: 0, adopted: 0, needsUpdate: 0, waiting: [] })
  h.files.set('/h/.lean-agent/scripts/candidates/a/meta.json', meta('candidate'))
  h.files.set('/h/.lean-agent/scripts/candidates/b/meta.json', meta('rejected'))
  h.files.set('/h/.lean-agent/scripts/c/meta.json', meta('adopted'))
  h.files.set('/h/.lean-agent/p/scripts/d/meta.json', meta('adopted'))
  expect((await loadView(h.host)).scripts).toEqual({ candidates: 1, adopted: 2, needsUpdate: 2, waiting: [] }) // adopted scripts without their files are not intact
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
    expect(await ui.find({ type: 'Text', text: /1\.0\.22/ })).toBeTruthy()
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
  expect((await loadView(h.host)).budget).toBe('$1.50 · 7d $1.50') // the pane prints it after "budget today:"
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
  expect((await ui.find({ type: 'Text', text: /t1 asks: which db\?/ }))?.text).toBeTruthy() // in "Needs you"
  expect(await ui.find({ type: 'Text', text: /which cache/ })).toBeFalsy()
  await ui.unmount()
})

test('pane More section (projects and scripts): name, private, open threads, stale rules; hidden private ones left out', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ p: { path: '/w/p' }, secret: { path: '/w/s', private: true } }))
  h.files.set('/h/.lean-agent/p/learn.json', JSON.stringify({ sha: 'a', areas: { ui: { globs: ['ui/**'], sha: 'a', lines: 5, stale: 'x' } } }))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ private: 'off' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /▸ More \(1 projects, 0 scripts\)/ })).toBeTruthy() // folded by default
  expect(await ui.find({ type: 'Text', text: /p · open/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /Projects/ })).toBeFalsy() // no section of its own any more
  await ui.press({ key: 'sec-more' })
  expect(await ui.find({ type: 'Button', text: /▾ More \(1 projects, 0 scripts\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Scripts: 0 candidates, 0 adopted/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /p · open · 2 thread\(s\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 rule area\(s\) stale/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /secret/ })).toBeFalsy()
  await ui.unmount()
})

test('pane thread card shows the thread\'s model/effort badge', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'one', project: 'p', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'opus', effort: 'high' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /opus\/high · \w+ · no review/ })).toBeTruthy()
  await ui.unmount()
})

// ---- fold / unfold, answers, close / reopen ----------------------------------------------------------------------------------
const rec = (o: unknown) => JSON.stringify(o) + '\n'
const thr = (h: any, id: string, o: Record<string, unknown> = {}) => h.files.set(`/h/.lean-agent/threads/${id}/thread.json`, JSON.stringify({ id, title: `title ${id}`, project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
const SID_OF = (n: number) => `0000000${n}-2222-3333-4444-555555555555`

test('sections are toggle buttons with counts; the state survives a remount; defaults: goals, threads and inbox open, closed and More folded', async ($, on) => {
  const h = setup(on, [])
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /▾ Goals \(2\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(2 unread\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ More \(0 projects, 0 scripts\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▾ Threads \(2\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ Closed \(1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /ship it/ })).toBeTruthy()
  await ui.press({ key: 'sec-goals' })
  expect(await ui.find({ type: 'Text', text: /ship it/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /▸ Goals \(2\)/ })).toBeTruthy()
  await ui.unmount()
  ui = await $.ui.mount(PANE as any) // redraw: still folded
  expect(await ui.find({ type: 'Button', text: /▸ Goals \(2\)/ })).toBeTruthy()
  await ui.press({ key: 'sec-goals' })
  expect(await ui.find({ type: 'Text', text: /ship it/ })).toBeTruthy()
  void h
  await ui.unmount()
})

test('inbox: grouped by thread, unread first (all of them), a row expands to its full text, ack moves a row to the read ones', async ($, on) => {
  const h = setup(on, [])
  const long = 'x'.repeat(260) + ' THE-END' // longer than a card's last-report line (200) and an inbox row's (70)
  const rows = Array.from({ length: 12 }, (_, n) => ({ ts: h.clock.t - (12 - n) * 1000, from: n % 2 ? 't1' : 't2', kind: 'report', text: n === 11 ? long : `report ${n}`, state: 'working' }))
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', rows.map(rec).join(''))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(12 unread\)/ })).toBeTruthy()
  const rowsDrawn = async () => (await ui.findAll({ type: 'Button', text: /^[▸▾] (● )?(\? )?(report|x)/ })).length
  expect(await ui.find({ type: 'Button', text: /▾ t1 one \(6 unread\)/ })).toBeTruthy() // a group per thread, open while it has unread rows
  expect(await ui.find({ type: 'Button', text: /▾ t2 two \(6 unread\)/ })).toBeTruthy()
  expect(await rowsDrawn()).toBe(12) // every unread row
  expect(await ui.find({ type: 'Text', text: /THE-END/ })).toBeFalsy() // cut at one line
  await ui.press({ key: 'row-11' })
  expect(await ui.find({ type: 'Text', text: /THE-END/ })).toBeTruthy() // the full report text
  await ui.press({ key: 'row-11' })
  expect(await ui.find({ type: 'Text', text: /THE-END/ })).toBeFalsy() // and collapses again
  await ui.press({ key: 'ack-11' })
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(11 unread\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▾ t1 one \(5 unread, 1 read\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'ack-11' })).toBeFalsy() // read: no ack button, dimmed, after the unread rows
  expect(await ui.find({ type: 'Button', key: 'row-11' })).toBeTruthy()
  await ui.unmount()
})

test('inbox: at most the last 5 read rows per thread, "show all" expands; read rows older than 7 days are archived (still in the file)', async ($, on) => {
  const h = setup(on, [])
  const day = 86_400_000
  // t2: 9 read rows from the last days; t1: 2 read rows 8 days old, 1 unread row
  const rows = [
    ...Array.from({ length: 9 }, (_, n) => ({ ts: h.clock.t - (10 - n) * 60_000, from: 't2', kind: 'report', text: `recent ${n}`, state: 'working' })),
    { ts: h.clock.t - 8 * day, from: 't1', kind: 'report', text: 'old a', state: 'working' },
    { ts: h.clock.t - 8 * day, from: 't1', kind: 'report', text: 'old b', state: 'working' },
    { ts: h.clock.t - 1000, from: 't1', kind: 'report', text: 'fresh', state: 'working' },
  ]
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', rows.map(rec).join(''))
  h.files.set('/h/.lean-agent/desk/pane-ack.json', JSON.stringify({ upTo: 11, ns: [] })) // the first 11 rows are read, "fresh" is not
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(1 unread\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▾ t1 one \(1 unread\)/ })).toBeTruthy() // the 2 old read rows are archived: not even counted
  expect(await ui.find({ type: 'Text', text: /2 read message\(s\) older than 7 days are archived/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /old a/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /fresh/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ t2 two \(9 read\)/ })).toBeTruthy() // nothing unread: folded
  await ui.press({ key: 'grp-btn-t2' })
  const drawn = async () => (await ui.findAll({ type: 'Button', text: /recent/ })).length
  expect(await drawn()).toBe(5) // the last 5 read rows
  expect(await ui.find({ type: 'Button', text: /recent 8/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /recent 3/ })).toBeFalsy()
  await ui.press({ key: 'answers-more-t2' })
  expect(await drawn()).toBe(9)
  await ui.press({ key: 'answers-less-t2' })
  expect(await drawn()).toBe(5)
  // ack all: the unread row is read; the read rows stay in the file
  await ui.press({ key: 'ack-all' })
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(all read\)/ })).toBeTruthy()
  expect(h.files.get('/h/.lean-agent/desk/inbox.jsonl')!.split('\n').filter(Boolean)).toHaveLength(12)
  await ui.unmount()
})

test('a script waiting for the desk shows Adopt / Reject; each is two-step, Reject drops it, Adopt adopts through decide and logs the user\'s decision', async ($, on) => {
  const h = setup(on, [])
  const text = 'print(1)\n'
  const sha = hashText(text)
  const waiting = (name: string) => {
    const dir = `/h/.lean-agent/scripts/candidates/${name}`
    h.files.set(`${dir}/${name}.py`, text)
    h.files.set(`${dir}/meta.json`, JSON.stringify({ name, purpose: 'Print one', run: 'python3 {script}', inputs: ['none'], outputs: ['stdout'], project: 'global', author: 't1', created: 1, sha256: sha, file: `${name}.py`, status: 'audited', audit: { ts: 1, by: 't1', sha, claimed: 'adopt', verdict: 'adapt', reads: [], writes: [], network: true, deletes: false, secrets: false, hardcoded: [], deterministic: true, errorsHandled: true, generalises: true, changes: ['mod: it uses the network'], blockers: ['uses the network'], reason: '', waits: true } }))
  }
  waiting('keep')
  waiting('drop')
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /Needs you \(2\)/ })).toBeTruthy() // a script that waits for the user's decision is a need
  await ui.press({ key: 'sec-more' })
  expect((await ui.find({ type: 'Text', text: /2 waiting for you/ }))).toBeTruthy() // and counted in More's scripts line
  expect(await ui.find({ type: 'Text', text: /keep \(global\) waits for you: uses the network/ })).toBeTruthy()
  await ui.press({ key: 'sr-drop' })
  expect(await ui.find({ type: 'Button', text: /Confirm reject drop/ })).toBeTruthy()
  expect(JSON.parse(h.files.get('/h/.lean-agent/scripts/candidates/drop/meta.json')!).status).toBe('audited') // armed only
  await ui.press({ key: 'sr-drop' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/scripts/candidates/drop/meta.json')!).status).toBe('rejected')
  await ui.press({ key: 'sa-keep' })
  expect(h.files.has('/h/.lean-agent/scripts/keep/meta.json')).toBe(false) // armed only
  await ui.press({ key: 'sa-keep' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/scripts/keep/meta.json')!).status).toBe('adopted')
  const log = h.files.get('/h/.lean-agent/scripts/decisions.jsonl')!
  expect(log).toContain('"value":"adopt"')
  expect(log).toContain('"value":"reject"')
  await ui.unmount()
})

test('Close is two-step (arm, confirm within 10 s); it closes through lean_thread close, clears the goal, and the row moves to Closed with Reopen', async ($, on) => {
  const h = setup(on, [])
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'close-t2' })
  expect(await ui.find({ type: 'Button', text: /Confirm close t2/ })).toBeTruthy()
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t2/thread.json')!).state).toBe('open') // armed only
  h.clock.t += 11_000 // the confirm lapses
  await ui.unmount()
  const ui2 = await $.ui.mount(PANE as any)
  expect(await ui2.find({ type: 'Button', text: /Confirm close t2/ })).toBeFalsy()
  await ui2.press({ key: 'close-t2' })
  await ui2.press({ key: 'close-t2' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t2/thread.json')!).state).toBe('closed')
  expect(JSON.parse(h.files.get('/h/.lean-agent/goals.json')!).t2).toBeUndefined()
  expect(await ui2.find({ type: 'Button', text: /▸ Closed \(2\)/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Button', text: /▾ Threads \(1\)/ })).toBeTruthy()
  await ui2.press({ key: 'sec-closed' })
  await ui2.press({ key: 'reopen-t2' }) // a fresh session: claude --bg, never --resume
  const calls = h.claudeCalls()
  expect(calls.some((a: string[]) => a[0] === '--bg')).toBe(true)
  expect(calls.some((a: string[]) => a.includes('--resume'))).toBe(false)
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t2/thread.json')!).state).toBe('open')
  await ui2.unmount()
})

test('a working thread has no Close (a busy label); needs-you shows for a session waiting on a prompt', async ($, on) => {
  const h = setup(on, [{ sessionId: SID, name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1, waitingFor: 'permission prompt' }])
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', key: 'close-t1' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^waiting for you: open it in the app/ })).toBeTruthy() // on its card
  expect(await ui.find({ type: 'Text', text: /t1 waits on a prompt in its own session/ })).toBeTruthy() // and in "Needs you"
  expect(await ui.find({ type: 'Text', text: /^busy$/ })).toBeFalsy() // no second word for "working"
  expect(await ui.find({ type: 'Button', key: 'close-t2' })).toBeTruthy() // an idle one still offers it
  void h
  await ui.unmount()
})

test('a session waiting on a prompt gets no Close; arming one Close then pressing another re-arms without closing either; a thread that turned busy between the presses is not closed', async ($, on) => {
  const rows: any[] = [{ sessionId: SID, name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1, waitingFor: 'permission prompt' }]
  const h = setup(on, rows)
  thr(h, 't4', { sid: SID_OF(4) })
  rows.push({ sessionId: SID_OF(4), name: 'y', cwd: '/y', status: 'idle', state: 'done', startedAt: 1 })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', key: 'close-t1' })).toBeFalsy() // needs you: not offered
  expect(await ui.find({ type: 'Text', text: /waiting for you/ })).toBeTruthy()
  const st = (id: string) => JSON.parse(h.files.get(`/h/.lean-agent/threads/${id}/thread.json`)!).state
  await ui.press({ key: 'close-t2' })
  await ui.press({ key: 'close-t4' }) // another button: arms t4, t2 is not closed
  expect([st('t2'), st('t4')]).toEqual(['open', 'open'])
  expect(await ui.find({ type: 'Button', text: /Confirm close t4/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Confirm close t2/ })).toBeFalsy()
  rows[1].status = 'busy' // t4 turns busy before the second press
  rows[1].state = 'working'
  resetViewCache()
  await ui.press({ key: 'close-t4' })
  expect(st('t4')).toBe('open') // re-checked at the second press: nothing live is stopped
  expect(h.claudeCalls().some((a: string[]) => a[0] === 'stop')).toBe(false)
  await ui.unmount()
})

test('Close all done: 2+ done threads, two-step, closes only done ones that are not working; blocked, asking and progress stay', async ($, on) => {
  const rows = [{ sessionId: SID_OF(4), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }]
  const h = setup(on, rows)
  for (const [id, n] of [['t4', 4], ['t5', 5], ['t6', 6], ['t7', 7], ['t8', 8]] as const) thr(h, id, { sid: SID_OF(n) })
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', [
    { ts: 1, from: 't4', kind: 'report', text: 'merged', state: 'done' }, // done but its session is working
    { ts: 2, from: 't5', kind: 'report', text: 'merged', state: 'done' },
    { ts: 3, from: 't6', kind: 'report', text: 'merged', state: 'done' },
    { ts: 4, from: 't7', kind: 'report', text: 'stuck', state: 'blocked' },
    { ts: 5, from: 't8', kind: 'report', text: 'merged', state: 'done' },
    { ts: 6, from: 't8', kind: 'ask', text: 'one more thing?' }, // a later question: not done any more
    { ts: 7, from: 't1', kind: 'report', text: 'halfway', state: 'working' },
  ].map(rec).join(''))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /^Close all done \(2\)$/ })).toBeTruthy() // t5 and t6 (t4 is working)
  await ui.press({ key: 'close-done' })
  expect(await ui.find({ type: 'Button', text: /Confirm close all done \(2\)/ })).toBeTruthy()
  const st = (id: string) => JSON.parse(h.files.get(`/h/.lean-agent/threads/${id}/thread.json`)!).state
  expect(['t4', 't5', 't6', 't7', 't8', 't1', 't2'].map(st)).toEqual(['open', 'open', 'open', 'open', 'open', 'open', 'open'])
  await ui.press({ key: 'close-done' })
  expect(['t4', 't5', 't6', 't7', 't8', 't1', 't2'].map(st)).toEqual(['open', 'closed', 'closed', 'open', 'open', 'open', 'open'])
  expect(await ui.find({ type: 'Button', text: /Close all done/ })).toBeFalsy()
  await ui.unmount()
})

// ---- restart buttons -----------------------------------------------------------------------------------------------
const NEW_SID = '99999999-8888-7777-6666-555555555555'
const T1_DIR = '/h/.lean-agent/threads/t1'
// rows with a process in the thread's own folder; `claude stop` ends it; `--bg` starts NEW_SID
function restartable(h: any, rows: any[]) {
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(rows) }
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW_SID}\n` }
    if (a[0] === 'stop') {
      for (const r of rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
}

test('every open thread has Restart; it is two-step; the confirmed press stops the session and starts a NEW one with the handover', async ($, on) => {
  const rows = [{ sessionId: SID, name: 'x', cwd: T1_DIR, status: 'idle', state: 'done', startedAt: 1, pid: 42, id: 'abcd1234' }]
  const h = setup(on, rows)
  restartable(h, rows)
  thr(h, 't5', { state: 'parked' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', key: 'restart-t1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-t2' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-t5' })).toBeFalsy() // parked: not open
  await ui.press({ key: 'restart-t1' })
  expect(await ui.find({ type: 'Button', text: /^Confirm restart t1$/ })).toBeTruthy() // an idle thread: no warning
  expect(h.claudeCalls().some((a: string[]) => a[0] === '--bg' || a[0] === 'stop')).toBe(false) // armed only
  await ui.press({ key: 'restart-t1' })
  const calls = h.claudeCalls()
  expect(calls.filter((a: string[]) => a[0] === 'stop').length).toBe(1)
  const bg = calls.filter((a: string[]) => a[0] === '--bg')
  expect(bg.length).toBe(1)
  expect(calls.some((a: string[]) => a.includes('--resume'))).toBe(false)
  expect(bg[0]![bg[0]!.length - 1]).toContain('Restarted from the pane.')
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe(NEW_SID)
  expect(await ui.find({ type: 'Text', text: /t1 restarted as a new session/ })).toBeTruthy()
  await ui.unmount()
})

test('Restart of a working thread warns that the current step is lost, and still restarts it on the second press', async ($, on) => {
  const rows = [{ sessionId: SID, name: 'x', cwd: T1_DIR, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234' }]
  const h = setup(on, rows)
  restartable(h, rows)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', key: 'close-t1' })).toBeFalsy() // a working thread cannot be closed ...
  await ui.press({ key: 'restart-t1' }) // ... but it can be restarted
  expect(await ui.find({ type: 'Button', text: /^Confirm restart t1 \(it is working: the current step is lost\)$/ })).toBeTruthy()
  expect(h.claudeCalls().some((a: string[]) => a[0] === 'stop')).toBe(false)
  await ui.press({ key: 'restart-t1' })
  expect(h.claudeCalls().filter((a: string[]) => a[0] === 'stop').length).toBe(1)
  expect(h.claudeCalls().filter((a: string[]) => a[0] === '--bg').length).toBe(1)
  await ui.unmount()
})

test('a finished thread row says the next message starts a new session', async ($, on) => {
  const h = setup(on, [])
  thr(h, 't6', { finished: 5 })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /finished: next message starts a new session/ })).toBeTruthy()
  await ui.unmount()
})

// A desk request that reports `n` tokens of context (the plugin notes it for its compaction and the pane's bar). The hook is registered
// before the test first touches `$` (an engine rule): call deskFeed(on) first, then `await feed($, n)` once the desk is started.
function deskFeed(on: any) {
  let tokens = 0
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
  })
  return async ($: any, n: number) => {
    tokens = n
    const st = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as any)
    for (;;) if ((await st.next()).done) break
  }
}

test('Restart desk is two-step: the confirmed press writes the handover, opens a new desk and says so; a failed open names the handover file', async ($, on) => {
  const feed = deskFeed(on)
  const h = setup(on, [])
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  await inDesk($)
  await feed($, 170_000) // 85 % of the default limit: the button is beside the bar
  const DESKPANE = { ...PANE, surface: 'desktop' } as const
  const ui = await $.ui.mount(DESKPANE as any)
  await ui.press({ key: 'restart-desk' })
  expect(await ui.find({ type: 'Button', text: /Confirm restart desk/ })).toBeTruthy()
  expect(h.files.has('/h/.lean-agent/desk/handover.md')).toBe(false) // armed only
  const opened = () => h.calls.filter((c: any) => c.argv[0] === 'open')
  expect(opened()).toHaveLength(0)
  let handoverWhenOpened = false
  h.opener.handler = () => { handoverWhenOpened = h.files.has('/h/.lean-agent/desk/handover.md'); return { exitCode: 0, stdout: '' } }
  await ui.press({ key: 'restart-desk' })
  const md = h.files.get('/h/.lean-agent/desk/handover.md')!
  expect(md).toContain('# Desk handover')
  expect(md).toContain('ship it') // the goals
  expect(opened().map((c: any) => c.argv)).toEqual([['open', 'claude://code/new?folder=%2Fh%2Flean-agent-desk']]) // the deep link, not `claude --desktop`
  expect(handoverWhenOpened).toBe(true) // the handover first, then the link
  expect(h.claudeCalls().some((a: string[]) => a[0] === '--desktop')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /New desk opened with the handover: close this one/ })).toBeTruthy()
  // the open fails: the handover is there and the notice says where
  h.opener.handler = () => ({ exitCode: 1, stdout: '', stderr: 'no app' })
  await ui.press({ key: 'restart-desk' })
  await ui.press({ key: 'restart-desk' })
  expect(await ui.find({ type: 'Text', text: /handover\.md/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Could not open the Claude app: no app; start a new session in ~\/lean-agent-desk by hand/ })).toBeTruthy()
  await ui.unmount()
})

// (deskcompact.test.ts covers the compaction states; here the desk's context size comes from a request, as in a real session)
test('header: a desk under 80 % of its limit has the bar and no Restart desk button beside it; from 80 % the button is beside the bar; over the limit it is also a need; the footer button is always there', async ($, on) => {
  const feed = deskFeed(on)
  const h = setup(on, [])
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  await inDesk($)
  const DESKPANE = { ...PANE, surface: 'desktop' } as const
  let ui = await $.ui.mount(DESKPANE as any)
  expect(await ui.find({ type: 'Text', text: /desk context: known after the next request/ })).toBeTruthy() // nothing was asked yet
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk-footer', text: 'Restart desk' })).toBeTruthy() // no context figure yet: still there
  await ui.unmount()
  await feed($, 40_000)
  ui = await $.ui.mount(DESKPANE as any)
  expect(await ui.find({ type: 'Text', text: /40k of 200k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk-footer', text: 'Restart desk' })).toBeTruthy() // under 80 %: the footer button, not the header's
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeFalsy()
  await ui.unmount()
  await feed($, 170_000)
  ui = await $.ui.mount(DESKPANE as any)
  expect(await ui.find({ type: 'Text', text: /170k of 200k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk-top' })).toBeFalsy() // still under the limit: not yet a need
  await ui.unmount()
  await feed($, 210_000)
  ui = await $.ui.mount(DESKPANE as any)
  expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /desk context 210k is over its limit \(200k\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk-top' })).toBeTruthy() // the button on the need's own card
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeTruthy() // and beside the bar
  await ui.press({ key: 'restart-desk-top' })
  expect(await ui.find({ type: 'Button', text: /Confirm restart desk/ })).toBeTruthy() // one two-step for both
  expect(await ui.findAll({ type: 'Button', text: /Confirm restart desk/ })).toHaveLength(3) // the card, beside the bar, the footer
  await ui.unmount()
})

test('the footer Restart desk button works under 80 %: the first press arms it, the second writes the handover and opens a new desk', async ($, on) => {
  const feed = deskFeed(on)
  const h = setup(on, [])
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  await inDesk($)
  await feed($, 40_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeFalsy() // nothing beside the bar
  await ui.press({ key: 'restart-desk-footer' })
  expect(await ui.find({ type: 'Button', key: 'restart-desk-footer', text: /Confirm restart desk/ })).toBeTruthy()
  expect(h.files.has('/h/.lean-agent/desk/handover.md')).toBe(false) // armed only
  expect(h.calls.filter((c: any) => c.argv[0] === 'open')).toHaveLength(0)
  await ui.press({ key: 'restart-desk-footer' })
  expect(h.files.get('/h/.lean-agent/desk/handover.md')).toContain('# Desk handover')
  expect(h.calls.filter((c: any) => c.argv[0] === 'open')).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /New desk opened with the handover: close this one/ })).toBeTruthy()
  await ui.unmount()
})

test('the /lean-agent-restart-desk command does the same in the desk, and refuses elsewhere', async ($, on) => {
  const h = setup(on, [])
  on('command.run', () => ({}))
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  await inDesk($)
  const r: any = await $.command.run({ command: 'lean-agent-restart-desk', surface: 'desktop' } as any)
  expect(JSON.stringify(r)).toContain('New desk opened with the handover: close this one')
  expect(h.files.has('/h/.lean-agent/desk/handover.md')).toBe(true)
  expect(h.calls.some((c: any) => c.argv[0] === 'open' && c.argv[1] === 'claude://code/new?folder=%2Fh%2Flean-agent-desk')).toBe(true)
  expect(h.claudeCalls().some((a: string[]) => a[0] === '--desktop')).toBe(false)
})

test('a new desk session start serves the handover: it is renamed, so a later desk does not find a stale one', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  h.files.set('/h/.lean-agent/desk/handover.md', '# Desk handover (written earlier)')
  await inDesk($)
  expect(h.files.has('/h/.lean-agent/desk/handover.md')).toBe(false)
  const moved = [...h.files.keys()].filter(k => /\/desk\/handover-read-.+\.md$/.test(k))
  expect(moved).toHaveLength(1)
  expect(h.files.get(moved[0]!)).toBe('# Desk handover (written earlier)')
})

test('a desk session start whose own id is not known leaves a handover that names its writer', async ($, on) => {
  const h = setup(on, [])
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  const md = '# Desk handover (written earlier)\n\n<!-- lean-agent: written-by-session sess-A -->\n'
  h.files.set('/h/.lean-agent/desk/handover.md', md)
  await inDesk($)
  expect(h.files.get('/h/.lean-agent/desk/handover.md')).toBe(md)
  expect([...h.files.keys()].some(k => k.includes('handover-read-'))).toBe(false)
})

test('through the real session start: the writer\'s own start (same id) leaves the handover, another desk session consumes it', async ($, on) => {
  const h = setup(on, [])
  let sid = 'sess-A'
  on('session.id', () => ({ value: sid }))
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  const md = '# Desk handover (written earlier)\n\n<!-- lean-agent: written-by-session sess-A -->\n'
  h.files.set('/h/.lean-agent/desk/handover.md', md)
  await inDesk($) // session A starts again (resume, reload)
  expect(h.files.get('/h/.lean-agent/desk/handover.md')).toBe(md)
  sid = 'sess-B'
  await inDesk($) // a new desk session B
  expect(h.files.has('/h/.lean-agent/desk/handover.md')).toBe(false)
  expect([...h.files.keys()].filter(k => /\/desk\/handover-read-.+\.md$/.test(k))).toHaveLength(1)
})

test('the restart command writes the handover with the id of the session that ran it', async ($, on) => {
  const h = setup(on, [])
  on('command.run', () => ({}))
  on('session.id', () => ({ value: 'sess-A' }))
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  await inDesk($)
  await $.command.run({ command: 'lean-agent-restart-desk', surface: 'desktop' } as any)
  expect(String(h.files.get('/h/.lean-agent/desk/handover.md')).trimEnd().endsWith('<!-- lean-agent: written-by-session sess-A -->')).toBe(true)
})

test('the desk guide tells a new desk session to read desk/handover.md (the restart path relies on it)', async () => {
  const h = fakeHost(null)
  // the template's own line, as templates/front-desk.md has it
  h.files.set('/p/templates/front-desk.md', 'At the start of a session read `{{lean}}/desk/handover.md` if it exists and is newer than your session')
  const md = await deskClaudeMd(h.host, '/p')
  expect(md).toContain('read `/h/.lean-agent/desk/handover.md` if it exists')
})
