// Desk -> thread direct delivery (deliver-to-thread.ts, threads.ts send / wake / answer-restart), the verify-then-escalate tick and the waiting state.
// Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { UNAVAILABLE_MS, deliveryTick, directUnavailable, kindOf, resetUnavailable, setThreadSender } from './deliver-to-thread'
import { leanThread, listLine, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { resetActivity, truthOf } from './threadstate'
import { stateOf } from './view'
import { threadTool } from './delivery'
import { deskSettings, mergeDeskSettingsFile } from './leantools'
import { deskToolPossible } from './guard'
import { trimTools } from './squeeze'
import { MOD_SEND_PREFIX, asMod, modSending } from './modsend'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 1_000_000
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? '{}')
const thread = (h: any) => json(h, `${T1}/thread.json`)
const recOf = (h: any) => json(h, `${T1}/delivery.json`)

function setup(o: { config?: unknown; row?: Record<string, unknown>; send?: (sid: string, text: string) => any } = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetActivity()
  resetUnavailable()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  const st = { rows: [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const sent: { sid: string; text: string }[] = []
  setThreadSender(o.send ?? (async (sid, text) => void sent.push({ sid, text })))
  const rows = async () => st.rows.map(r => ({ sid: r.sessionId, name: '', cwd: r.cwd, status: r.status, state: r.state, startedAt: 1, pid: r.pid, id: r.id, waitingFor: r.waitingFor ?? '' })) as any
  const restarts: { id: string; why: string; rewind: number }[] = []
  const deps = { agents: rows, restart: async (id: string, why: string, rewind: number) => (restarts.push({ id, why, rewind }), { ok: true, text: 'restarted', data: { fresh: true } }) }
  return { h, st, sent, deps, restarts }
}
const send = (h: any, text: string) => leanThread(h.host, ROOT, { action: 'send', tN: 't1', text })
const activity = (h: any, at: number, kind = 'tool') => h.files.set(`${T1}/activity.json`, JSON.stringify({ at, kind }))
const waits = (h: any, since: number) => h.files.set(`${T1}/waiting.json`, JSON.stringify({ since, text: 'sqlite or postgres?' }))
const after = <T>(f: () => T) => {
  try {
    return f()
  } finally {
    setThreadSender(null)
  }
}

test('live idle session: the message goes straight to it, no --resume, the inbox row counts as delivered', async () => {
  const { h, sent } = setup()
  const r = await send(h, 'use sqlite')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1: delivered straight to its running session')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.sid).toBe(S1)
  expect(sent[0]!.text).toContain('use sqlite')
  expect(sent[0]!.text).toContain('<!-- lean:n=1 -->')
  expect(h.claudeCalls().filter(x => x[0] === '--bg' || x[0] === 'stop')).toHaveLength(0)
  expect(thread(h).delivered).toBe(1)
  expect(recOf(h)).toMatchObject({ sid: S1, from: 0, upTo: 1, kind: 'instruction' })
  after(() => 0)
})

test('live working session: the message is sent too (read at its next step), not just queued', async () => {
  const { h, sent } = setup({ row: { status: 'busy', state: 'working' } })
  const r = await send(h, 'also run the linter')
  expect(r.text).toContain('delivered straight to its running session')
  expect(sent).toHaveLength(1)
  expect(thread(h).delivered).toBe(1)
  after(() => 0)
})

test('no live session (process gone): the old inbox + `claude --bg --resume` wake, nothing sent', async () => {
  const { h, sent } = setup({ row: { pid: 0 } })
  const r = await send(h, 'use sqlite')
  expect(r.ok).toBe(true)
  expect(sent).toHaveLength(0)
  const resumes = h.claudeCalls().filter(x => x[0] === '--bg' && x.includes('--resume'))
  expect(resumes).toHaveLength(1)
  expect(r.text).toContain('woken with 1 message')
  after(() => 0)
})

test('a session on an open permission prompt cannot take it: plain refusal text, the inbox keeps the message', async () => {
  const { h, sent } = setup({ row: { status: 'busy', state: 'blocked', waitingFor: 'permission: Bash(git push origin fix-1)' } })
  const r = await send(h, 'use sqlite')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 waits on a permission prompt in its own session: permission: Bash(git push origin fix-1)')
  expect(sent).toHaveLength(0)
  expect(thread(h).delivered).toBe(0)
  expect(h.files.get(`${T1}/inbox.jsonl`)).toContain('use sqlite')
  expect(h.files.get(`${T1}/delivery.json`)).toBeUndefined()
  after(() => 0)
})

test('a refused or failed send falls back to the old path and moves nothing', async () => {
  const refused = setup({ row: { status: 'busy', state: 'working' }, send: async () => ({ isDelivered: false, reason: 'no live session on this machine has id abc' }) })
  const r = await send(refused.h, 'hello')
  expect(r.text).toContain('is running')
  expect(r.text).toContain('direct send to t1 refused (no live session on this machine has id abc)') // the reason is said, not swallowed
  expect(thread(refused.h).delivered).toBe(0)
  expect(recOf(refused.h)).toMatchObject({ sid: S1, from: 0, upTo: 1, kind: 'instruction' }) // still watched: the queued message is escalated if the thread does nothing
  const threw = setup({ row: { status: 'busy', state: 'working' }, send: async () => { throw new Error('socket closed') } })
  expect((await send(threw.h, 'hello')).text).toContain('is running')
  expect(thread(threw.h).delivered).toBe(0)
  after(() => 0)
})

test('no sender set (no desk mod): the old behaviour', async () => {
  const { h } = setup({ row: { status: 'busy', state: 'working' } })
  setThreadSender(null)
  expect((await send(h, 'hello')).text).toContain('is running')
  expect(thread(h).delivered).toBe(0)
})

test('kinds: a status check or FYI is never verified; an answer to a waiting thread is (and clears waiting)', async () => {
  expect(kindOf('Status check from the desk: where are you?', false)).toBe('fyi')
  expect(kindOf('FYI the build is green', true)).toBe('fyi')
  expect(kindOf('sqlite', true)).toBe('answer')
  expect(kindOf('sqlite', false)).toBe('instruction')
  const f = setup()
  await send(f.h, 'FYI the build is green')
  expect(f.sent).toHaveLength(1)
  expect(f.h.files.get(`${T1}/delivery.json`)).toBeUndefined() // nothing to verify: nothing to escalate
  const a = setup()
  waits(a.h, T0 - 60_000)
  await send(a.h, 'sqlite')
  expect(recOf(a.h).kind).toBe('answer')
  expect(json(a.h, `${T1}/waiting.json`).since).toBeUndefined() // the answer clears the waiting state
  after(() => 0)
})

test('tick: no activity within 45 s after an answer to a waiting thread: escalate by script, ONE notice, no question to the user', async () => {
  const { h, deps, restarts } = setup({ row: { status: 'busy', state: 'working' } })
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  await send(h, 'sqlite')
  h.clock.t = T0 + 30_000
  expect(await deliveryTick(h.host, deps)).toEqual([]) // inside the 45 s
  h.clock.t = T0 + 46_000
  const notes = await deliveryTick(h.host, deps)
  expect(restarts).toEqual([{ id: 't1', why: expect.stringContaining('did not react'), rewind: 0 }])
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('t1 did not react to your answer within 45 s: restarted it with the answer; its notes are kept')
  expect(recOf(h).sid).toBeUndefined() // dropped
  expect(await deliveryTick(h.host, deps)).toEqual([]) // once
  expect(restarts).toHaveLength(1)
  after(() => 0)
})

test('a send refused for the TARGET (stale id, ...) is still watched; the sweep\'s repeats keep the clock, so the answer to a waiting thread ends in a restart by script', async () => {
  const { h, deps, restarts } = setup({ row: { status: 'busy', state: 'working' }, send: async () => ({ isDelivered: false, reason: 'no live session on this machine has id abc' }) })
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  const r = await send(h, 'sqlite')
  expect(r.text).toContain('no live session on this machine has id abc')
  expect(thread(h).delivered).toBe(0)
  h.clock.t = T0 + 20_000
  await leanThread(h.host, ROOT, { action: 'wake', tN: 't1' }) // the desk's sweep sends the unread inbox again: the clock must NOT restart
  expect(recOf(h).at).toBe(T0)
  h.clock.t = T0 + 46_000
  const notes = await deliveryTick(h.host, deps)
  expect(restarts).toEqual([{ id: 't1', why: expect.stringContaining('did not react'), rewind: 0 }])
  expect(notes[0]!.text).toBe('t1 did not react to your answer within 45 s: restarted it with the answer; its notes are kept')
  after(() => 0)
})

const NO_TOOL = 'this session has no SendMessage tool (messaging between sessions and agents is not on here)'

test('state blocked + status idle + NO waitingFor is an idle session: the engine has no SendMessage -> the wake (stop the idle process, --resume with the message), never a fresh session', async () => {
  let calls = 0
  const { h, st } = setup({ row: { status: 'idle', state: 'blocked' }, send: async () => (calls++, { isDelivered: false, reason: NO_TOOL }) })
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  const r = await send(h, 'sqlite')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 woken with 1 message')
  expect(h.claudeCalls().filter(x => x[0] === 'stop')).toHaveLength(1)
  const starts = h.claudeCalls().filter(x => x[0] === '--bg')
  expect(starts).toHaveLength(1)
  expect(starts[0]).toContain('--resume') // the conversation is kept: no fresh session
  expect(starts[0]![starts[0]!.length - 1]).toContain('sqlite')
  expect(thread(h).sid).toBe(S1)
  expect(thread(h).delivered).toBe(1)
  expect(calls).toBe(1)
  expect(recOf(h)).toMatchObject({ sid: S1, upTo: 1, kind: 'answer' }) // the wake is watched too
  expect(json(h, `${T1}/waiting.json`).since).toBeUndefined()
  expect(JSON.parse((h.files.get(`${T1}/history.jsonl`) ?? '').split('\n')[0]!).why).toContain('direct send unavailable')
  // the refusal is cached for this desk session: the next message does not try the send again
  st.rows[0]!.pid = 42
  h.clock.t = T0 + 31_000
  await send(h, 'and use WAL mode')
  expect(calls).toBe(1)
  expect(h.claudeCalls().filter(x => x[0] === '--bg' && x.includes('--resume'))).toHaveLength(2)
  after(() => 0)
})

test('the cached refusal means no 45 s wait on a send that never went out; it ends after UNAVAILABLE_MS and when the send works again', async () => {
  let ok = false
  const { h, st, sent } = setup({ row: { status: 'busy', state: 'working' }, send: async (sid, text) => (ok ? (void 0, undefined) : { isDelivered: false, reason: NO_TOOL }) })
  await send(h, 'one')
  expect(directUnavailable()).toBe(NO_TOOL)
  expect(JSON.parse(h.files.get(`${T1}/delivery.json`) ?? '{}')).toMatchObject({ upTo: 1 }) // (1.0.31) the message waits in the inbox and is WATCHED: unread for 45 s with a stuck / idle session = restarted by script (msgstate.test.ts)
  expect(sent).toHaveLength(0)
  ok = true
  h.clock.t = T0 + UNAVAILABLE_MS + 1_000
  st.rows[0]!.pid = 42
  const r = await send(h, 'two')
  expect(r.text).toContain('delivered straight to its running session')
  after(() => 0)
})

test('wake without activity after threads.answerWaitSeconds: the escalation to a fresh session by script (one notice); with activity: none', async () => {
  const quiet = setup({ row: { status: 'idle', state: 'blocked' }, send: async () => ({ isDelivered: false, reason: NO_TOOL }) })
  activity(quiet.h, T0 - 60_000)
  waits(quiet.h, T0 - 60_000)
  await send(quiet.h, 'sqlite')
  quiet.h.clock.t = T0 + 30_000
  expect(await deliveryTick(quiet.h.host, quiet.deps)).toEqual([]) // inside the 45 s
  quiet.h.clock.t = T0 + 46_000
  const notes = await deliveryTick(quiet.h.host, quiet.deps)
  expect(quiet.restarts).toEqual([{ id: 't1', why: expect.stringContaining('did not react'), rewind: 0 }])
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('t1 did not react to your answer within 45 s: restarted it with the answer; its notes are kept')
  const live = setup({ row: { status: 'idle', state: 'blocked' }, send: async () => ({ isDelivered: false, reason: NO_TOOL }) })
  activity(live.h, T0 - 60_000)
  waits(live.h, T0 - 60_000)
  await send(live.h, 'sqlite')
  activity(live.h, T0 + 5_000, 'prompt') // the resumed session took the prompt
  live.h.clock.t = T0 + 60_000
  expect(await deliveryTick(live.h.host, live.deps)).toEqual([])
  expect(live.restarts).toHaveLength(0)
  after(() => 0)
})

test('tick: activity newer than the send (a prompt, a tool call, a worker\'s call) = it reacted: no restart, the record is dropped', async () => {
  for (const kind of ['prompt', 'tool', 'worker']) {
    const { h, deps, restarts } = setup()
    await send(h, 'use sqlite')
    activity(h, T0 + 10_000, kind)
    h.clock.t = T0 + 60_000
    expect(await deliveryTick(h.host, deps)).toEqual([])
    expect(restarts).toHaveLength(0)
    expect(recOf(h).sid).toBeUndefined() // dropped
  }
  after(() => 0)
})

test('tick: never while a permission prompt is open (re-checked), nor for a working session that asked nothing (a long tool call)', async () => {
  const p = setup()
  await send(p.h, 'use sqlite')
  p.st.rows[0]!.state = 'blocked'
  p.st.rows[0]!.waitingFor = 'permission: Bash(rm x)'
  p.h.clock.t = T0 + 120_000
  expect(await deliveryTick(p.h.host, p.deps)).toEqual([])
  expect(p.restarts).toHaveLength(0)
  expect(recOf(p.h).sid).toBe(S1) // still watched
  const w = setup({ row: { status: 'busy', state: 'working' } })
  activity(w.h, T0 - 1_000)
  await send(w.h, 'use sqlite')
  w.h.clock.t = T0 + 120_000
  expect(await deliveryTick(w.h.host, w.deps)).toEqual([])
  expect(w.restarts).toHaveLength(0)
  expect(recOf(w.h).sid).toBe(S1)
  after(() => 0)
})

test('tick: an idle session that started no turn is escalated even without a recorded question; the session is gone: also', async () => {
  const idle = setup()
  await send(idle.h, 'use sqlite')
  idle.h.clock.t = T0 + 50_000
  const n = await deliveryTick(idle.h.host, idle.deps)
  expect(n[0]!.text).toBe('t1 did not react to your message within 45 s: restarted it with the message; its notes are kept')
  const gone = setup()
  await send(gone.h, 'use sqlite')
  gone.st.rows[0]!.pid = 0
  gone.st.rows[0]!.status = 'done'
  gone.st.rows[0]!.state = 'done'
  gone.h.clock.t = T0 + 50_000
  await deliveryTick(gone.h.host, gone.deps)
  expect(gone.restarts).toHaveLength(1)
  after(() => 0)
})

test('config threads.escalate false: no restart, one notice that asks; answerWaitSeconds is honoured', async () => {
  const off = setup({ config: { threads: { escalate: false } } })
  await send(off.h, 'use sqlite')
  off.h.clock.t = T0 + 50_000
  const n = await deliveryTick(off.h.host, off.deps)
  expect(off.restarts).toHaveLength(0)
  expect(n).toHaveLength(1)
  expect(n[0]!.text).toContain('threads.escalate is off): restart it with the message?')
  expect(await deliveryTick(off.h.host, off.deps)).toEqual([])
  const slow = setup({ config: { threads: { answerWaitSeconds: 120 } } })
  await send(slow.h, 'use sqlite')
  slow.h.clock.t = T0 + 100_000
  expect(await deliveryTick(slow.h.host, slow.deps)).toEqual([])
  slow.h.clock.t = T0 + 121_000
  expect((await deliveryTick(slow.h.host, slow.deps))[0]!.text).toContain('within 120 s')
  after(() => 0)
})

test('leanThread answer-restart: the inbox goes back to where the batch began; a new session whose first prompt carries the message', async () => {
  const { h, st } = setup()
  await send(h, 'use sqlite')
  expect(thread(h).delivered).toBe(1)
  const r = await leanThread(h.host, ROOT, { action: 'answer-restart', tN: 't1', reason: 'it did not react', rewind: 0 })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 restarted as a new session with the message')
  const starts = h.claudeCalls().filter(x => x[0] === '--bg')
  expect(starts).toHaveLength(1)
  expect(starts[0]![starts[0]!.length - 1]).toContain('use sqlite')
  expect(thread(h).sid).toBe(NEW)
  expect(st.rows[0]!.pid).toBe(0)
  expect((await leanThread(h.host, ROOT, { action: 'answer-restart', tN: 't1' })).ok).toBe(false) // rewind is required
  after(() => 0)
})

test('waiting state: a question with no activity since is `waiting` (not running), the list and pane say so, the answer clears it', async () => {
  const row = { sid: S1, name: '', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'a', waitingFor: '' }
  const base = { threadState: 'open', row, queued: [], now: T0 + 5 * 60_000, activityAt: T0 }
  expect(truthOf(base).word).toBe('running')
  const t = truthOf({ ...base, waitingSince: T0 })
  expect(t.word).toBe('waiting')
  expect(t.text).toContain('waiting for your answer')
  expect(truthOf({ ...base, waitingSince: T0, activityAt: T0 + 20_000 }).word).toBe('running') // it did something since
  expect(truthOf({ ...base, waitingSince: T0, row: { ...row, waitingFor: 'permission: Bash(x)' } }).word).toBe('running') // a permission prompt is the user's, in its own session
  expect(truthOf({ ...base, waitingSince: T0, now: T0 + 3 * 3600_000 }).word).toBe('waiting') // never "stalled" while it waits
  expect(listLine({ id: 't1', state: 'open', live: 'waiting' })).toContain('t1 waiting for your answer')
  expect(stateOf({ live: 'waiting', run: 'running', working: true, asking: false, blocked: false, needsYou: false } as any).word).toBe('waiting for answer')
  // the thread's own lean_ask records it
  const { h } = setup()
  h.clock.t = T0
  await threadTool(h.host, 't1', 'lean_ask', { question: 'sqlite or postgres?' })
  expect(json(h, `${T1}/waiting.json`)).toMatchObject({ since: T0, text: 'sqlite or postgres?' })
  await send(h, 'sqlite')
  expect(json(h, `${T1}/waiting.json`).since).toBeUndefined()
  after(() => 0)
})

test('the desk keeps the SendMessage tool (the engine gates the mod\'s direct send on it); an older settings file that denied it is fixed by the doctor merge', async () => {
  expect(deskSettings().permissions.deny).not.toContain('SendMessage')
  expect(deskSettings().permissions.deny).toContain('ScheduleWakeup')
  const h = fakeHost(null)
  h.files.set('/d/.claude/settings.json', JSON.stringify({ permissions: { deny: ['Agent', 'SendMessage'] } }))
  expect(await mergeDeskSettingsFile(h.host, '/d/.claude/settings.json')).toBe(true)
  const deny = JSON.parse(h.files.get('/d/.claude/settings.json')!).permissions.deny
  expect(deny).toContain('Agent')
  expect(deny).not.toContain('SendMessage')
})

test('the desk\'s tool pool keeps SendMessage for the mod\'s own send (the engine checks the pool); only that send, marked by the mod, passes the guard', async () => {
  expect(deskToolPossible('SendMessage')).toBe(true)
  expect(trimTools([{ name: 'SendMessage' }, { name: 'Edit' }, { name: 'Read' }], 'desk', undefined).map(t => t.name)).toEqual(['SendMessage', 'Read'])
  const line = `${MOD_SEND_PREFIX}:\nhello`
  expect(modSending({ message: line })).toBe(false) // no mod send in progress: the desk model's own call is refused
  await asMod(async () => {
    expect(modSending({ message: line })).toBe(true)
    expect(modSending({ message: 'tell t1 to push' })).toBe(false) // not the mod's line
  })
  expect(modSending({ message: line })).toBe(false)
})

test('waiting reminder: an open question unanswered for waitReminderMinutes comes back ONCE as a notice', async () => {
  const { h, deps } = setup({ row: { status: 'busy', state: 'working' } })
  activity(h, T0 - 1_000)
  waits(h, T0 - 1_000)
  h.clock.t = T0 + 10 * 60_000
  expect(await deliveryTick(h.host, deps)).toEqual([])
  h.clock.t = T0 + 16 * 60_000
  const n = await deliveryTick(h.host, deps)
  expect(n).toHaveLength(1)
  expect(n[0]!.text).toBe('t1 has waited 16 min for your answer: sqlite or postgres?')
  expect(h.files.get(`${L}/desk/notices/wait-t1.json`) ?? [...h.files.keys()].find(k => k.includes('wait-t1'))).toBeDefined()
  expect(await deliveryTick(h.host, deps)).toEqual([]) // once
  // a thread that did something since is not reminded
  const b = setup({ row: { status: 'busy', state: 'working' }, config: { threads: { waitReminderMinutes: 5 } } })
  waits(b.h, T0 - 1_000)
  activity(b.h, T0 + 60_000)
  b.h.clock.t = T0 + 10 * 60_000
  expect(await deliveryTick(b.h.host, b.deps)).toEqual([])
  after(() => 0)
})
