import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { statsText } from './stats'
import { loadView } from './view'
import { DEFAULT_TOKENS, DESK_COMPACT_INSTRUCTIONS, DESK_RETRY_MS, GAP_MS, MAX_AGE_MS, MAX_TRIES, askText, checkpointConfig, contextTokens, deskNote, deskTick, enter, isPush, noteReported, noteUsage, readRequest, resetCheckpoints, sweepCheckpoints, takeAsk, turnEnded, turnStarted, watch } from './checkpoint'

const SID = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`

// a thread t1 with a running-then-idle session, a scripted `claude` and the usage the main loop reported
function setup(thread: Record<string, unknown> = {}) {
  resetLocks()
  resetCheckpoints()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'opus', effort: 'medium', ...thread }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  const st = { rows: [{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0 // the process is gone after a stop
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  return { h, st, run: (i: any) => leanThread(h.host, ROOT, i) }
}
const over = (n = 120_000) => noteUsage({ input_tokens: 500, cache_read_input_tokens: n - 1_500, cache_creation_input_tokens: 1_000 })
const idle = async () => true

test('context size is input + cache read + cache write; config defaults, overrides and bad values', async () => {
  expect(contextTokens({ input_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 300 })).toBe(321)
  expect(contextTokens(null)).toBe(0)
  const { h } = setup()
  expect(await checkpointConfig(h.host)).toEqual({ enabled: true, threadTokens: DEFAULT_TOKENS, deskTokens: DEFAULT_TOKENS })
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { enabled: false, threadTokens: 50_000, deskTokens: 5 } }))
  expect(await checkpointConfig(h.host)).toEqual({ enabled: false, threadTokens: 50_000, deskTokens: DEFAULT_TOKENS }) // too small a value is ignored
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: 'junk' }))
  expect((await checkpointConfig(h.host)).enabled).toBe(true)
})

test('crossing the threshold gives ONE instruction; below it, disabled, parked and a recent checkpoint give none', async () => {
  const { h } = setup()
  over(99_000)
  expect(await takeAsk(h.host, 't1', idle)).toBeNull() // below 100k
  over(120_000)
  const ask = await takeAsk(h.host, 't1', idle)
  expect(ask).toContain('Context is over 100k: finish the current step, then call lean_report with state \'checkpoint\'')
  expect(ask).toBe(askText(100_000))
  expect(await takeAsk(h.host, 't1', idle)).toBeNull() // once
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('asked')
  // a configured threshold counts
  const b = setup()
  b.h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { threadTokens: 60_000 } }))
  over(70_000)
  expect(await takeAsk(b.h.host, 't1', idle)).toContain('over 60k')
  // disabled, parked, rate-limited
  const c = setup()
  c.h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { enabled: false } }))
  over()
  expect(await takeAsk(c.h.host, 't1', idle)).toBeNull()
  const d = setup({ state: 'parked' })
  over()
  expect(await takeAsk(d.h.host, 't1', idle)).toBeNull()
  const e = setup({ lastCheckpoint: 10_000_000 - 5 * 60_000 })
  over()
  expect(await takeAsk(e.h.host, 't1', idle)).toBeNull() // 5 minutes after the last one
  e.h.clock.t += GAP_MS
  expect(await takeAsk(e.h.host, 't1', idle)).not.toBeNull()
})

test('no instruction while a subagent or a push runs, or while the engine lists a running agent', async () => {
  const { h } = setup()
  over()
  const leave = enter('agent')
  expect(await takeAsk(h.host, 't1', idle)).toBeNull()
  leave()
  leave() // a second call changes nothing
  expect(watch().agents).toBe(0)
  const push = enter('push')
  expect(await takeAsk(h.host, 't1', idle)).toBeNull()
  push()
  expect(await takeAsk(h.host, 't1', async () => false)).toBeNull() // the engine still lists a running subagent
  expect(await takeAsk(h.host, 't1', async () => { throw new Error('no list') })).toBeNull() // an unreadable list counts as running
  expect(await takeAsk(h.host, 't1', idle)).not.toBeNull()
  expect(isPush('git -C /w push origin x')).toBe(true)
  expect(isPush('git -C /w log --oneline')).toBe(false)
  expect(isPush('echo pushed')).toBe(false)
})

test('a checkpoint report is ready at the turn end, never while a subagent runs; the desk starts a FRESH session (not --resume) whose handover has the checkpoint', async () => {
  const { h, st, run } = setup()
  over()
  await takeAsk(h.host, 't1', idle)
  h.files.set(`${L}/desk/inbox.jsonl`, [
    { ts: 5, from: 't1', kind: 'report', state: 'working', text: 'login form found, fixing' },
    { ts: 6, from: 't1', kind: 'report', state: 'checkpoint', text: 'branch fix-login, worktree /w/app/fix-login, last commit abc1234, not pushed. done: form. open: tests. next: run the tests' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  h.files.set(`${L}/memory/notes.jsonl`, JSON.stringify({ from: 't1', text: 'use pnpm' }) + '\n')
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: 7, text: 'also check the logout' }) + '\n')
  expect(await noteReported(h.host, 't1')).toContain('checkpoint recorded')
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('reported')
  // a subagent is still running at the turn end: not ready
  const leave = enter('agent')
  expect(await turnEnded(h.host, 't1', { reason: 'answer', sid: SID, idle })).toBeNull()
  leave()
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('reported')
  expect(await turnEnded(h.host, 't1', { reason: 'answer', sid: SID, idle })).toBe('ready')
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('ready')
  expect(await turnEnded(h.host, 't1', { reason: 'answer', sid: SID, idle })).toBeNull() // once
  // the desk's tick
  expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual(['t1'])
  const calls = h.claudeCalls()
  expect(calls).toContainEqual(['stop', 'abcd1234']) // the old session was stopped first
  const bg = calls.find(a => a[0] === '--bg')!
  expect(bg.includes('--resume')).toBe(false)
  expect(bg.slice(0, 7)).toEqual(['--bg', '-n', 't1 · fix login', '--model', 'opus', '--effort', 'medium']) // the thread's own model and effort
  const prompt = bg[bg.length - 1]!
  expect(prompt).toContain('NEW session')
  expect(prompt).toContain('checkpoint 1')
  expect(prompt).toContain('[checkpoint] branch fix-login, worktree /w/app/fix-login, last commit abc1234')
  expect(prompt).toContain('fix the login bug') // the brief
  expect(prompt).toContain('use pnpm') // remember items
  expect(prompt).toContain('also check the logout') // queued messages
  const t = JSON.parse(h.files.get(`${T1}/thread.json`)!)
  expect(t.sid).toBe(NEW)
  expect(t.sids).toContain(SID)
  expect(t.checkpoints).toBe(1)
  expect(t.lastCheckpoint).toBe(10_000_000)
  expect(t.delivered).toBe(1)
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('done')
  // nothing is started twice, and a second request within 20 minutes is dropped
  expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual([])
  st.rows = [{ sessionId: NEW, name: 't1', cwd: T1, status: 'idle', startedAt: 2, pid: 43, id: 'ffff0000' }]
  await h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: h.clock.t, tokens: 130_000 }))
  h.clock.t += 5 * 60_000
  const r = await run({ action: 'checkpoint', tN: 't1' })
  expect(r.text).toContain('less than 20 minutes')
  expect(h.claudeCalls().filter(a => a[0] === '--bg').length).toBe(1)
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('done')
})

test('a thread that does not report: one reminder turn, then a checkpoint from its earlier reports; no second turn possible = at once', async () => {
  const { h } = setup()
  over()
  await takeAsk(h.host, 't1', idle)
  const sent: string[] = []
  const submit = async (t: string) => void sent.push(t)
  expect(await turnEnded(h.host, 't1', { reason: 'aborted', sid: SID, submit })).toBeNull() // an interrupt is no turn end
  expect(await turnEnded(h.host, 't1', { reason: 'error', sid: SID, submit })).toBeNull()
  expect(await turnEnded(h.host, 't1', { reason: 'answer', sid: SID, submit })).toBe('reminded')
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain("state 'checkpoint'")
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('asked')
  expect(await turnEnded(h.host, 't1', { reason: 'answer', sid: SID, submit })).toBe('ready')
  const rq = await readRequest(h.host, '/h', 't1')
  expect([rq?.phase, rq?.source]).toEqual(['ready', 'fallback'])
  expect(sent.length).toBe(1)
  // the reminder cannot be started
  const b = setup()
  over()
  await takeAsk(b.h.host, 't1', idle)
  expect(await turnEnded(b.h.host, 't1', { reason: 'answer', sid: SID, submit: async () => { throw new Error('busy') } })).toBe('ready')
  const c = setup()
  over()
  await takeAsk(c.h.host, 't1', idle)
  expect(await turnEnded(c.h.host, 't1', { reason: 'answer', sid: SID })).toBe('ready')
  // the fallback handover says the reports are all there is
  const bg = async () => {
    const { run } = c
    c.st.rows[0].pid = 0
    await sweepCheckpoints(c.h.host, id => run({ action: 'checkpoint', tN: id }))
    return c.h.claudeCalls().find(a => a[0] === '--bg')!.at(-1)!
  }
  expect(await bg()).toContain('did not report in time')
})

test('a checkpoint is a progress report when checkpoints are off or one was just made; a thread that is not asked and reports nothing is never touched', async () => {
  const a = setup()
  a.h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { enabled: false } }))
  expect(await noteReported(a.h.host, 't1')).toContain('recorded as a progress report')
  expect(await turnEnded(a.h.host, 't1', { reason: 'answer', sid: SID })).toBeNull()
  expect(await readRequest(a.h.host, '/h', 't1')).toBeNull()
  const b = setup({ lastCheckpoint: 10_000_000 - 60_000 })
  expect(await noteReported(b.h.host, 't1')).toContain('less than 20 minutes')
  const c = setup()
  expect(await turnEnded(c.h.host, 't1', { reason: 'answer', sid: SID })).toBeNull() // never asked
})

test('a start that fails is tried again after a minute and given up after five tries, with a notice; a running session waits without a try', async () => {
  const { h, st, run } = setup()
  await h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: h.clock.t, tokens: 130_000 }))
  st.rows[0].status = 'busy' // working: nothing is stopped or replaced
  expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual(['t1'])
  expect(h.claudeCalls().filter(a => a[0] === '--bg').length).toBe(0)
  expect((await readRequest(h.host, '/h', 't1'))?.tries).toBeUndefined()
  st.rows[0].status = 'idle'
  const base = h.claude.handler
  h.claude.handler = (a: string[], c: any) => (a[0] === '--bg' ? { exitCode: 1, stdout: '', stderr: 'no' } : base(a, c))
  for (let n = 1; n <= MAX_TRIES; n++) {
    expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual(['t1'])
    expect((await readRequest(h.host, '/h', 't1'))?.tries).toBe(n)
    expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual([]) // inside the minute
    h.clock.t += 61_000
  }
  expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual([])
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('failed')
  expect(h.files.get(`${L}/notices/checkpoint-t1.txt`)).toContain('could not start')
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).checkpoints).toBeUndefined() // never counted
})

test('while a checkpoint waits, a message is queued and the old session is not woken; a reopen settles a stale request', async () => {
  const { h, st, run } = setup()
  await h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: h.clock.t, tokens: 130_000, sid: SID }))
  const r = await run({ action: 'send', tN: 't1', text: 'one more thing' })
  expect(r.text).toContain('continue in a fresh session')
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(0)
  expect(h.files.get(`${T1}/inbox.jsonl`)).toContain('one more thing')
  // an explicit resume still resumes
  h.clock.t += 60_000
  expect((await run({ action: 'resume', tN: 't1' })).ok).toBe(true)
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(1)
  // closed, then reopened as a fresh session: the stale ready request is settled, so the tick never stops the new session
  await run({ action: 'close', tN: 't1' })
  st.rows[0].pid = 0
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${NEW}\n` } : a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify(st.rows) } : { exitCode: 0, stdout: '' })
  expect((await run({ action: 'reopen', tN: 't1' })).ok).toBe(true)
  expect((await readRequest(h.host, '/h', 't1'))?.phase).toBe('done')
  expect(await sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))).toEqual([])
})

test('a ready request is withdrawn when the session works on (new turn, a wake since), and when the thread is parked; a finished thread is not checkpointed', async () => {
  // a new main turn after ready
  const a = setup()
  over()
  await takeAsk(a.h.host, 't1', idle)
  await noteReported(a.h.host, 't1')
  expect(await turnEnded(a.h.host, 't1', { reason: 'answer', sid: SID, idle })).toBe('ready')
  await turnStarted(a.h.host, 't1')
  expect((await readRequest(a.h.host, '/h', 't1'))?.phase).toBe('done')
  expect(await sweepCheckpoints(a.h.host, id => a.run({ action: 'checkpoint', tN: id }))).toEqual([])
  expect(await takeAsk(a.h.host, 't1', idle)).not.toBeNull() // asked again at a later boundary
  // a wake after the request: stale in the sweep and in the action
  const b = setup({ lastWake: 10_000_500 })
  await b.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: 10_000_000, tokens: 130_000 }))
  expect(await sweepCheckpoints(b.h.host, id => b.run({ action: 'checkpoint', tN: id }))).toEqual([])
  expect((await readRequest(b.h.host, '/h', 't1'))?.phase).toBe('done')
  await b.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: 10_000_000, tokens: 130_000 }))
  expect((await b.run({ action: 'checkpoint', tN: 't1' })).text).toContain('worked on')
  expect(b.h.claudeCalls().filter(x => x[0] === '--bg').length).toBe(0)
  // parked: never later
  const c = setup()
  await c.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: c.h.clock.t, tokens: 130_000 }))
  await c.run({ action: 'park', tN: 't1' })
  await c.run({ action: 'reopen', tN: 't1' })
  expect(await sweepCheckpoints(c.h.host, id => c.run({ action: 'checkpoint', tN: id }))).toEqual([])
  // finished: the last report is done, so an asked-but-silent thread gets neither a reminder nor a fresh session
  const d = setup()
  over()
  await takeAsk(d.h.host, 't1', idle)
  d.h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: d.h.clock.t + 5, from: 't1', kind: 'report', state: 'done', text: 'all done' }) + '\n')
  const sent: string[] = []
  expect(await turnEnded(d.h.host, 't1', { reason: 'answer', sid: SID, submit: async t => void sent.push(t) })).toBeNull()
  expect(sent).toEqual([])
  // a done report from BEFORE the ask (the thread got more work since) does not excuse it
  const e = setup()
  e.h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: e.h.clock.t - 5, from: 't1', kind: 'report', state: 'done', text: 'all done' }) + '\n')
  over()
  await takeAsk(e.h.host, 't1', idle)
  e.h.clock.t += 1000
  expect(await turnEnded(e.h.host, 't1', { reason: 'answer', sid: SID, submit: async t => void sent.push(t) })).toBe('reminded')
  // the first turn of a process that was resumed outside the desk withdraws a ready file of an earlier process; only once
  const f = setup()
  await f.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: f.h.clock.t, tokens: 130_000 }))
  await turnStarted(f.h.host, 't1')
  expect((await readRequest(f.h.host, '/h', 't1'))?.phase).toBe('done')
  await f.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: f.h.clock.t, tokens: 130_000 }))
  await turnStarted(f.h.host, 't1') // a later turn of the same process: its own ready request is only withdrawn through w.ready
  expect((await readRequest(f.h.host, '/h', 't1'))?.phase).toBe('ready')
  // a ready request the desk could not take for half an hour is dropped (a row that never goes idle)
  const g = setup()
  await g.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: g.h.clock.t, tokens: 130_000 }))
  g.h.clock.t += MAX_AGE_MS + 1000
  expect(await sweepCheckpoints(g.h.host, id => g.run({ action: 'checkpoint', tN: id }))).toEqual([])
  expect((await readRequest(g.h.host, '/h', 't1'))?.phase).toBe('done')
})

test('overlapping desk ticks do not start twice or count a try twice', async () => {
  const { h, run } = setup()
  await h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: h.clock.t, tokens: 130_000 }))
  const [a, b] = await Promise.all([sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id })), sweepCheckpoints(h.host, id => run({ action: 'checkpoint', tN: id }))])
  expect([a.length, b.length].sort()).toEqual([0, 1])
  expect(h.claudeCalls().filter(x => x[0] === '--bg').length).toBe(1)
  // a try that just failed is not repeated by a second action call inside the minute (the lock re-checks)
  const f = setup()
  await f.h.host.fs.write(`${T1}/checkpoint.json`, JSON.stringify({ phase: 'ready', ts: f.h.clock.t - 2000, tokens: 130_000, tries: 1, lastTry: f.h.clock.t - 1000 }))
  expect((await f.run({ action: 'checkpoint', tN: 't1' })).text).toContain('less than a minute')
  expect(f.h.claudeCalls().filter(x => x[0] === '--bg').length).toBe(0)
})

// ---- the desk -----------------------------------------------------------------------------------------------------
function deskDeps(o: { tokens?: number; busy?: boolean; compact?: (i: string) => Promise<unknown> } = {}) {
  const seen = { compact: [] as string[], status: [] as string[], reset: 0, notes: 0 }
  return {
    seen,
    deps: {
      tokens: async () => o.tokens ?? 150_000,
      busy: () => o.busy ?? false,
      compact: async (i: string) => {
        seen.compact.push(i)
        return o.compact ? o.compact(i) : { messages: [] }
      },
      notes: async () => void seen.notes++,
      recent: async () => ['please keep the pane short', 'use sonnet for t3'],
      status: (t: string) => void seen.status.push(t),
      reset: () => void seen.reset++,
    },
  }
}

test('an idle desk over its threshold compacts itself with the fixed instructions; below it, busy or disabled it does not', async () => {
  const { h } = setup()
  const a = deskDeps()
  expect(await deskTick(h.host, a.deps)).toBe('compacted')
  expect(a.seen.compact).toEqual([DESK_COMPACT_INSTRUCTIONS])
  expect(a.seen.notes).toBe(1)
  expect(a.seen.reset).toBe(1)
  for (const w of ['goals', 'open threads table', 'unanswered thread question', 'preferences', 'pending approvals', 'tool outputs', 'old report texts']) expect(DESK_COMPACT_INSTRUCTIONS).toContain(w)
  const b = deskDeps({ busy: true })
  expect(await deskTick(h.host, b.deps)).toBe('busy')
  expect(b.seen.compact).toEqual([])
  const c = deskDeps({ tokens: 90_000 })
  expect(await deskTick(h.host, c.deps)).toBe('quiet')
  expect(c.seen.compact).toEqual([])
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { enabled: false } }))
  const d = deskDeps()
  expect(await deskTick(h.host, d.deps)).toBe('quiet')
  expect(d.seen.compact).toEqual([])
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { deskTokens: 200_000 } }))
  expect(await deskTick(h.host, deskDeps().deps)).toBe('quiet')
})

test('a hook veto is retried later, not turned into a handover; a rejected compact writes desk/handover.md and a status line', async () => {
  const { h } = setup()
  const v = deskDeps({ compact: async () => ({ skip: 'a hook said no' }) })
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  expect(v.seen.reset).toBe(0)
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  expect(await deskTick(h.host, v.deps)).toBe('quiet') // not again for a while
  expect(v.seen.compact.length).toBe(1)
  h.clock.t += DESK_RETRY_MS
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  expect(v.seen.compact.length).toBe(2)
  // rejected (an engine without it, or a turn that started): the handover file
  const r = setup()
  r.h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  r.h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: 5, from: 't1', kind: 'report', state: 'working', text: 'form | found' }) + '\n')
  r.h.files.set(`${L}/questions.jsonl`, JSON.stringify({ ts: 4, from: 't1', question: 'which login page?', answered: false }) + '\n')
  const bad = deskDeps({ compact: async () => { throw new Error('session.compact is not available') } })
  expect(await deskTick(r.h.host, bad.deps)).toBe('fallback')
  const md = r.h.files.get(`${L}/desk/handover.md`)!
  expect(md).toContain('context 150k')
  expect(md).toContain('- t1: ship the login fix')
  expect(md).toContain('| t1 | fix login | app | open | [working] form / found |')
  expect(md).toContain('which login page?')
  expect(md).toContain('use sonnet for t3')
  expect(bad.seen.status).toEqual(['desk context 150k: start a new desk session (it reads the handover)'])
  expect(deskNote()).toBe(bad.seen.status[0])
  expect(bad.seen.reset).toBe(0)
  // the status line is put back while it stays over (a status line may have been replaced), no second handover write
  const writes = r.h.writes.filter(p => p.includes('handover.md')).length
  expect(await deskTick(r.h.host, bad.deps)).toBe('fallback')
  expect(bad.seen.status.length).toBe(2)
  expect(r.h.writes.filter(p => p.includes('handover.md')).length).toBe(writes)
  expect(bad.seen.compact.length).toBe(1)
  // under the threshold again (a new session): the note goes away
  expect(await deskTick(r.h.host, deskDeps({ tokens: 10_000 }).deps)).toBe('quiet')
  expect(deskNote()).toBe('')
})

test('a transient rejection is retried once after 30 s before the handover file; the status line is cleared when the reason is gone', async () => {
  const { h } = setup()
  let n = 0
  const d = deskDeps({ compact: async () => { n++; throw new Error('overloaded, try again') } })
  expect(await deskTick(h.host, d.deps)).toBe('skipped')
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  expect(await deskTick(h.host, d.deps)).toBe('quiet') // inside the 30 s
  h.clock.t += 31_000
  expect(await deskTick(h.host, d.deps)).toBe('fallback') // twice in a row
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(true)
  expect(n).toBe(2)
  // the context fell below the threshold (a new session or a compaction by hand): the line is cleared, once
  const low = deskDeps({ tokens: 20_000 })
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  // a later success after a fallback clears it too
  const e = setup()
  const bad = deskDeps({ compact: async () => { throw new TypeError('x is not a function') } })
  expect(await deskTick(e.h.host, bad.deps)).toBe('fallback') // an engine without session.compact: no retry
  e.h.clock.t += DESK_RETRY_MS
  const good = deskDeps()
  expect(await deskTick(e.h.host, good.deps)).toBe('compacted')
  expect(good.seen.status).toEqual([''])
  expect(deskNote()).toBe('')
})

test('a compact that is rejected because a turn started meanwhile is retried soon, with no handover', async () => {
  const { h } = setup()
  let busy = false
  const d = deskDeps({ compact: async () => { busy = true; throw new Error('a turn is running') } })
  expect(await deskTick(h.host, { ...d.deps, busy: () => busy })).toBe('busy')
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  expect(d.seen.status).toEqual([])
})

// ---- pane and stats -------------------------------------------------------------------------------------------------
test('the pane row carries the checkpoint count; stats count checkpoints per thread', async () => {
  const { h } = setup({ checkpoints: 2 })
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'other', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, checkpoints: 1 }))
  h.files.set(`${L}/threads/t3/thread.json`, JSON.stringify({ id: 't3', title: 'none', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const v = await loadView(h.host)
  expect(v.threads.find(t => t.id === 't1')?.checkpoints).toBe(2)
  expect(v.threads.find(t => t.id === 't3')?.checkpoints).toBeUndefined()
  expect(await statsText(h.host)).toContain('checkpoints: 3 (t1 2, t2 1)')
  const none = setup()
  expect(await statsText(none.h.host)).not.toContain('checkpoints:')
})
