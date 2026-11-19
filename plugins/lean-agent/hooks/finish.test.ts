// Done = session over (finish.ts + threads.ts) and the restart action.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { doneSession, finishedText, resetFinish, sweepFinished } from './finish'
import { loadView } from './view'

const SID = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const INBOX = `${L}/desk/inbox.jsonl`

const rec = (o: Record<string, unknown>) => JSON.stringify({ ts: 5_000_000, from: 't1', kind: 'report', ...o }) + '\n'
const DONE = rec({ state: 'done', text: 'branch fix-x, worktree /w, last commit abc1234, not pushed, next: open the PR' })

// a thread t1 with an idle session (a process), a scripted `claude`, and a done report unless told otherwise
function setup(o: { thread?: Record<string, unknown>; inbox?: string | null; row?: Record<string, unknown>; stopFails?: boolean } = {}) {
  resetLocks()
  resetFinish()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'opus', effort: 'medium', ...o.thread }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  if (o.inbox !== null) h.files.set(INBOX, o.inbox ?? DONE)
  const st = { rows: [{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      if (o.stopFails) return { exitCode: 1, stdout: '', stderr: 'no such session' }
      for (const r of st.rows) r.pid = 0 // the process is gone after a stop
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const thread = () => JSON.parse(h.files.get(`${T1}/thread.json`)!)
  const starts = () => h.claudeCalls().filter(x => x[0] === '--bg' && !x.includes('--resume')) // new sessions (a resume is `--bg --resume`)
  const stops = () => h.claudeCalls().filter(x => x[0] === 'stop')
  return { h, st, run: (i: any) => leanThread(h.host, ROOT, i), thread, starts, stops }
}

test('finish: a done report and an idle session: the process is stopped and the thread is marked finished', async () => {
  const { run, thread, stops, starts } = setup()
  const r = await run({ action: 'finish', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(r.text).toBe('t1 finished: next message starts a new session')
  expect(finishedText('t1')).toBe(r.text)
  expect((r.data as any).finished).toBe(true)
  expect(stops()).toEqual([['stop', 'abcd1234']])
  expect(starts().length).toBe(0)
  expect(typeof thread().finished).toBe('number')
  // a second call changes nothing
  expect((await run({ action: 'finish', tN: 't1' })).text).toContain('already finished')
  expect(stops().length).toBe(1)
})

test('finish: a thread that reported done but is still working is left alone, and stopped once it is idle', async () => {
  for (const row of [{ status: 'busy' }, { status: 'idle', state: 'working' }]) {
    const { st, run, thread, stops } = setup({ row })
    const a = await run({ action: 'finish', tN: 't1' })
    expect(a.text).toContain('still working')
    expect((a.data as any).finished).toBe(false)
    expect(stops().length).toBe(0)
    expect(thread().finished).toBeUndefined()
    st.rows[0].status = 'idle'
    st.rows[0].state = 'done'
    expect((await run({ action: 'finish', tN: 't1' })).text).toBe('t1 finished: next message starts a new session')
    expect(stops().length).toBe(1)
  }
})

test('finish: only a LAST report of done, written since the session was started or woken, finishes it', async () => {
  const cases: [string, string | null, Record<string, unknown>?][] = [
    ['blocked', rec({ state: 'blocked', text: 'need creds' })],
    ['progress', rec({ state: 'working', text: 'halfway' })],
    ['question after done', DONE + rec({ kind: 'ask', ts: 5_000_001, text: 'which page?' })],
    ['progress after done', DONE + rec({ state: 'working', ts: 5_000_001, text: 'one more thing' })],
    ['no report at all', null],
    ['a done report of another thread', rec({ from: 't2', state: 'done', text: 'x' })],
    ['a done report from before the last wake', DONE, { lastWake: 6_000_000 }],
  ]
  for (const [name, inbox, thread] of cases) {
    const s = setup({ inbox, thread })
    const r = await s.run({ action: 'finish', tN: 't1' })
    expect([name, r.text.includes('finished:'), s.stops().length]).toEqual([name, false, 0])
    expect(s.thread().finished).toBeUndefined()
  }
  // a progress report BEFORE the done one does not matter
  const ok = setup({ inbox: rec({ state: 'working', ts: 4_000_000, text: 'p' }) + DONE })
  expect((await ok.run({ action: 'finish', tN: 't1' })).data).toEqual({ finished: true })
})

test('finish: never a session outside the thread folder; a failing stop marks nothing; parked threads are not finished', async () => {
  const away = setup({ row: { cwd: '/somewhere/else' } })
  const a = await away.run({ action: 'finish', tN: 't1' })
  expect(a.ok).toBe(false)
  expect(a.text).toContain('outside the thread folder')
  expect(away.stops().length).toBe(0)
  expect(away.thread().finished).toBeUndefined()
  const bad = setup({ stopFails: true })
  expect((await bad.run({ action: 'finish', tN: 't1' })).ok).toBe(false)
  expect(bad.thread().finished).toBeUndefined()
  const parked = setup({ thread: { state: 'parked' } })
  expect((await parked.run({ action: 'finish', tN: 't1' })).ok).toBe(false)
  expect(parked.stops().length).toBe(0)
  const none = setup({ thread: { sid: '' } })
  expect((await none.run({ action: 'finish', tN: 't1' })).text).toContain('no session')
  // a session that is already gone from the list is marked without a stop
  const gone = setup()
  gone.st.rows = []
  expect((await gone.run({ action: 'finish', tN: 't1' })).data).toEqual({ finished: true })
  expect(gone.stops().length).toBe(0)
})

test('sweepFinished runs only the candidates and returns the ids that finished', async () => {
  const { h, run } = setup()
  const mk = (id: string, t: Record<string, unknown>) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: id, project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, ...t }))
  mk('t2', { finished: 1 }) // finished already
  mk('t3', { state: 'parked' })
  mk('t4', { sid: '' })
  mk('t5', {}) // no done report
  h.files.set(INBOX, DONE + rec({ from: 't2', state: 'done', text: 'x' }) + rec({ from: 't3', state: 'done', text: 'x' }) + rec({ from: 't4', state: 'done', text: 'x' }))
  const ran: string[] = []
  const did = await sweepFinished(h.host, async id => {
    ran.push(id)
    return run({ action: 'finish', tN: id })
  })
  expect(ran).toEqual(['t1'])
  expect(did).toEqual(['t1'])
  expect(await doneSession(h.host, '/h', JSON.parse(h.files.get(`${L}/threads/t5/thread.json`)!))).toBe(false)
})

test('after finish a send starts a NEW session with the handover, never a resume', async () => {
  const { run, thread, starts, stops, h } = setup()
  await run({ action: 'finish', tN: 't1' })
  const r = await run({ action: 'send', tN: 't1', text: 'also check the signup page' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('finished earlier')
  expect(starts().length).toBe(1)
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  const argv = starts()[0]!
  expect(argv).toContain('opus') // the thread's recorded model and effort
  const prompt = argv[argv.length - 1]!
  expect(prompt).toContain('fix the login bug') // the brief
  expect(prompt).toContain('branch fix-x, worktree /w, last commit abc1234') // the done report
  expect(prompt).toContain('also check the signup page') // the queued message
  expect(thread().sid).toBe(NEW)
  expect(thread().sids).toContain(SID)
  expect(thread().finished).toBeUndefined()
  expect(stops().length).toBe(1) // (only the finish stop: the process was gone)
})

test('wake, resume and start of a finished thread also start a new session; with nothing queued wake stays quiet', async () => {
  const quiet = setup({ thread: { finished: 1 } })
  expect((await quiet.run({ action: 'wake', tN: 't1' })).text).toContain('nothing queued')
  expect(quiet.starts().length).toBe(0)
  const w = setup({ thread: { finished: 1 } })
  w.h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 1, text: 'one more thing' }) + '\n')
  expect((await w.run({ action: 'wake', tN: 't1' })).text).toContain('new session')
  expect(w.starts().length).toBe(1)
  expect(w.h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  const r = setup({ thread: { finished: 1 } })
  const rr = await r.run({ action: 'resume', tN: 't1' })
  expect(rr.text).toContain('new session')
  expect(r.starts().length).toBe(1)
  expect(r.h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  expect(r.thread().finished).toBeUndefined()
  const s = setup({ thread: { finished: 1 } })
  expect((await s.run({ action: 'start', tN: 't1' })).text).toContain('new session')
  expect(s.starts().length).toBe(1)
  expect(s.h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
})

test('a thread that reported done and is idle but not yet marked (the tick has not run) also gets a new session on send', async () => {
  const { run, starts, h, thread } = setup()
  expect((await run({ action: 'send', tN: 't1', text: 'quick follow-up' })).ok).toBe(true)
  expect(starts().length).toBe(1)
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  expect(thread().sid).toBe(NEW)
})

test('a done thread that is still working just queues the message; a thread that did not report done is resumed as before', async () => {
  const busy = setup({ row: { status: 'busy' } })
  const a = await busy.run({ action: 'send', tN: 't1', text: 'hello' })
  expect(a.text).toContain('is running')
  expect(busy.starts().length).toBe(0)
  const plain = setup({ inbox: rec({ state: 'working', text: 'p' }) })
  await plain.run({ action: 'send', tN: 't1', text: 'carry on' })
  expect(plain.h.claudeCalls().some(x => x.includes('--resume') && x.includes(SID))).toBe(true)
  expect(plain.stops().length).toBe(1) // the lingering idle process is stopped before the resume, as ever
})

test('1.0.6 leftovers are harmless: a checkpoint.json and the old thread.json counters change nothing', async () => {
  const { h, run, starts } = setup({ inbox: rec({ state: 'working', text: 'p' }), thread: { checkpoints: 2, lastCheckpoint: 5 } })
  h.files.set(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: 9_000_000, tokens: 130_000 }))
  await run({ action: 'send', tN: 't1', text: 'carry on' })
  expect(h.claudeCalls().some(x => x.includes('--resume'))).toBe(true) // an ordinary wake: the old request is ignored
  expect(starts().length).toBe(0)
  const v = await loadView(h.host)
  expect(v.threads.find(t => t.id === 't1')).toBeTruthy()
  expect(JSON.stringify(v)).not.toMatch(/checkpoint/i)
  expect((await run({ action: 'park', tN: 't1' })).text).toBe('t1 parked')
  expect((await run({ action: 'reopen', tN: 't1' })).ok).toBe(true)
})

test('the pane row of a finished thread carries finished', async () => {
  const { h } = setup({ thread: { finished: 7 } })
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'b', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const v = await loadView(h.host)
  expect(v.threads.find(t => t.id === 't1')?.finished).toBe(true)
  expect(v.threads.find(t => t.id === 't2')?.finished).toBeUndefined()
})

// ---- restart ----------------------------------------------------------------------------------------------------------
test('restart: the session is stopped and a NEW one starts with the handover, same model and effort', async () => {
  const { run, starts, stops, thread, h } = setup({ inbox: DONE })
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 1, text: 'remember the staging url' }) + '\n')
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  const r = await run({ action: 'restart', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 restarted as a new session')
  expect(stops()).toEqual([['stop', 'abcd1234']])
  expect(starts().length).toBe(1)
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  const argv = starts()[0]!
  expect(argv.slice(0, 7)).toEqual(['--bg', '-n', 't1 · fix login', '--model', 'opus', '--effort', 'medium'])
  const prompt = argv[argv.length - 1]!
  for (const w of ['Restarted from the pane.', 'fix the login bug', 'ship the login fix', 'last commit abc1234', 'remember the staging url']) expect(prompt).toContain(w)
  expect(thread().sid).toBe(NEW)
  expect(thread().sids).toContain(SID)
  expect(thread().finished).toBeUndefined()
})

test('restart: a WORKING session is stopped too (its current step is lost)', async () => {
  const { run, starts, stops, st } = setup({ row: { status: 'busy', state: 'working' } })
  const r = await run({ action: 'restart', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(stops().length).toBe(1)
  expect(starts().length).toBe(1)
  expect(st.rows[0].pid).toBe(0) // it was gone before the new session started
})

test('restart: parked or closed threads, a session outside the thread folder and a failing stop start nothing', async () => {
  for (const state of ['parked', 'closed']) {
    const s = setup({ thread: { state } })
    const r = await s.run({ action: 'restart', tN: 't1' })
    expect([state, r.ok, r.text.includes('reopen it first')]).toEqual([state, false, true])
    expect(s.starts().length + s.stops().length).toBe(0)
  }
  const away = setup({ row: { cwd: '/somewhere/else', status: 'busy' } })
  const a = await away.run({ action: 'restart', tN: 't1' })
  expect(a.ok).toBe(false)
  expect(a.text).toContain('outside the thread folder')
  expect(away.stops().length + away.starts().length).toBe(0)
  const bad = setup({ stopFails: true, row: { status: 'busy' } })
  const b = await bad.run({ action: 'restart', tN: 't1' })
  expect(b.ok).toBe(false)
  expect(bad.starts().length).toBe(0)
  expect(bad.thread().sid).toBe(SID)
})

test('restart of a thread with no session yet just starts one', async () => {
  const { run, starts, stops } = setup({ thread: { sid: '' } })
  expect((await run({ action: 'restart', tN: 't1' })).ok).toBe(true)
  expect(starts().length).toBe(1)
  expect(stops().length).toBe(0)
})
