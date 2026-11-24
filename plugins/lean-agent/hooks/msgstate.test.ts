// Messages to a thread: delivery states (msgstate.ts), `lean_thread messages tN`, the reply of `send`, the unread escalation by script,
// the answer that clears waiting, the idle-without-report alert and the restart that carries in-flight corrections. Synthetic ids and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { deliveryTick, resetUnavailable, setThreadSender } from './deliver-to-thread'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { resetActivity } from './threadstate'
import { renderReports, takeBatch, unreadReports, worthRelay } from './delivery'
import { loadView } from './view'
import { stallTick } from './stall'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 1_000_000
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? '{}')

function setup(o: { row?: Record<string, unknown>; direct?: boolean; config?: unknown } = {}) {
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
  const st = { rows: [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
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
  // direct: the desk's session can send (SendMessage); default false = "this session has no SendMessage tool" (the field report)
  setThreadSender(o.direct ? async (sid, text) => void sent.push({ sid, text }) : null)
  const rows = async () => st.rows.map(r => ({ sid: r.sessionId, name: '', cwd: r.cwd, status: r.status, state: r.state, startedAt: 1, pid: r.pid, id: r.id, waitingFor: r.waitingFor ?? '' })) as any
  const restarts: { id: string; why: string; rewind: number }[] = []
  const deps = { agents: rows, restart: async (id: string, why: string, rewind: number) => (restarts.push({ id, why, rewind }), { ok: true, text: 'restarted', data: { fresh: true } }) }
  return { h, st, sent, deps, restarts }
}
const send = (h: any, text: string) => leanThread(h.host, ROOT, { action: 'send', tN: 't1', text })
const messages = (h: any) => leanThread(h.host, ROOT, { action: 'messages', tN: 't1' })
const activity = (h: any, at: number, kind = 'tool') => h.files.set(`${T1}/activity.json`, JSON.stringify({ at, kind }))
const after = <T>(f: () => T) => {
  try {
    return f()
  } finally {
    setThreadSender(null)
  }
}

// ---- 1. delivery state ---------------------------------------------------------------------------------------------------------------
test('send to a working thread without a direct route: "m1: queued, not read yet" and what will happen', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  const r = await send(h, 'use sqlite')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('m1: queued, not read yet')
  expect(r.text).toContain('only be reached through its inbox')
  expect(r.text).toContain('next tool call')
  expect(r.text).toContain('45 s')
  after(() => 0)
})

test('send with a direct route: "delivered", not "queued"', { timeoutMs: 20_000 }, async () => {
  const { h, sent } = setup({ direct: true })
  const r = await send(h, 'use sqlite')
  expect(sent).toHaveLength(1)
  expect(r.text).toContain('m1: delivered')
  expect(r.text).not.toContain('only be reached through its inbox')
  after(() => 0)
})

test('the thread-side mod reads the inbox at its next tool call: the message becomes consumed, with readAt', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'use sqlite')
  expect((await messages(h)).text).toContain('m1 queued')
  h.clock.t = T0 + 20_000
  expect(await takeBatch(h.host, 't1')).toContain('use sqlite')
  const m = (await messages(h)).text
  expect(m).toContain('m1 consumed')
  expect(m).toContain('use sqlite')
  expect(json(h, `${T1}/msgs.json`)['1'].readAt).toBe(T0 + 20_000)
  after(() => 0)
})

test('`messages tN` lists the last messages with state and age, no model call', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'first')
  h.clock.t = T0 + 4 * 60_000
  await send(h, 'second')
  await takeBatch(h.host, 't1')
  h.clock.t = T0 + 5 * 60_000
  await send(h, 'third')
  const m = (await messages(h)).text
  const lines = m.split('\n')
  expect(lines[0]).toContain('t1')
  expect(m).toMatch(/m1 consumed .*5 min.*first/)
  expect(m).toMatch(/m3 queued .*third/)
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(0)
  after(() => 0)
})

test('messages without tN, or for a thread with no messages, says so', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  expect((await leanThread(h.host, ROOT, { action: 'messages' })).ok).toBe(false)
  expect((await messages(h)).text).toContain('no messages')
  after(() => 0)
})

// ---- 2. unread escalation by script ----------------------------------------------------------------------------------------------------
const recOf = (h: any) => json(h, `${T1}/delivery.json`)
const woken = (h: any) => h.files.set(`${T1}/thread.json`, JSON.stringify({ ...json(h, `${T1}/thread.json`), lastWake: T0 - 1_000 }))

test('REGRESSION (field report): a send to a stuck thread is queued, unread after 45 s the mod restarts it WITH the text, once; a second identical send is deduped', { timeoutMs: 20_000 }, async () => {
  const { h, deps, restarts } = setup()
  activity(h, T0 - 15 * 60_000) // working, but no tool call for 15 min: stuck (threads.stallMinutes 10)
  const r = await send(h, 'use sqlite, not postgres')
  expect(r.text).toContain('m1: queued, not read yet')
  expect(recOf(h)).toMatchObject({ sid: S1, from: 0, upTo: 1 }) // watched from the moment it was queued
  // 30 s: too early
  h.clock.t = T0 + 30_000
  expect(await deliveryTick(h.host, deps)).toEqual([])
  expect(restarts).toHaveLength(0)
  // the desk sends the same answer again while it is unread: deduped, nothing new is queued
  const again = await send(h, 'use sqlite, not postgres')
  expect(again.text).toContain('already queued as m1')
  expect(again.text).toMatch(/\(30 s\b/)
  expect((h.files.get(`${T1}/inbox.jsonl`) ?? '').trim().split('\n')).toHaveLength(1)
  // 46 s: unread, the session shows no activity: restarted by script, the inbox is rewound to where the batch began
  h.clock.t = T0 + 46_000
  const n1 = await deliveryTick(h.host, deps)
  expect(restarts).toHaveLength(1)
  expect(restarts[0]).toMatchObject({ id: 't1', rewind: 0 })
  expect(restarts[0]!.why).toContain('did not react')
  expect(n1).toHaveLength(1) // the desk is told ONCE, one line
  expect(n1[0]!.text).toContain('restarted it with the message')
  expect(n1[0]!.text).toContain('stuck')
  expect(recOf(h)).toEqual({})
  expect((await messages(h)).text).toContain('the mod woke it')
  // later ticks: nothing again
  h.clock.t = T0 + 120_000
  expect(await deliveryTick(h.host, deps)).toEqual([])
  expect(restarts).toHaveLength(1)
  after(() => 0)
})

test('a working thread that still makes tool calls is NOT restarted: it reads the message at its next tool call', { timeoutMs: 20_000 }, async () => {
  const { h, deps, restarts } = setup()
  activity(h, T0 - 5_000)
  await send(h, 'use sqlite')
  h.clock.t = T0 + 50_000
  activity(h, T0 + 40_000) // it reacted
  expect(await deliveryTick(h.host, deps)).toEqual([])
  expect(restarts).toHaveLength(0)
  expect(recOf(h)).toEqual({}) // the watch ends: it reacted
  after(() => 0)
})

test('a working thread with little activity (less than the stall minutes) keeps being re-checked, not restarted', { timeoutMs: 20_000 }, async () => {
  const { h, deps, restarts } = setup()
  activity(h, T0 - 3 * 60_000)
  await send(h, 'use sqlite')
  h.clock.t = T0 + 50_000
  expect(await deliveryTick(h.host, deps)).toEqual([])
  expect(restarts).toHaveLength(0)
  expect(recOf(h)).toMatchObject({ upTo: 1 })
  after(() => 0)
})

test('an IDLE thread whose queued message stays unread for 45 s is restarted with it (as the wake)', { timeoutMs: 20_000 }, async () => {
  const { h, deps, restarts } = setup({ row: { status: 'idle', state: 'idle' } })
  woken(h) // woken a moment ago: the send queues behind it (no second wake inside 30 s)
  await send(h, 'use sqlite')
  h.clock.t = T0 + 46_000
  const n = await deliveryTick(h.host, deps)
  expect(restarts).toHaveLength(1)
  expect(n).toHaveLength(1)
  after(() => 0)
})

test('the thread read it before the 45 s: no restart, the message is consumed', { timeoutMs: 20_000 }, async () => {
  const { h, deps, restarts } = setup()
  activity(h, T0 - 15 * 60_000)
  await send(h, 'use sqlite')
  h.clock.t = T0 + 20_000
  await takeBatch(h.host, 't1')
  activity(h, T0 + 20_000)
  h.clock.t = T0 + 60_000
  expect(await deliveryTick(h.host, deps)).toEqual([])
  expect(restarts).toHaveLength(0)
  after(() => 0)
})

test('an identical text after the thread read the first one, or past 10 minutes, is a new message; an FYI is never deduped', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'use sqlite')
  await takeBatch(h.host, 't1')
  expect((await send(h, 'use sqlite')).text).toContain('m2: queued')
  h.clock.t = T0 + 11 * 60_000
  const third = await send(h, 'use sqlite') // m2 is still unread but older than 10 minutes: not "already queued"
  expect(third.text).toContain('m3: queued')
  expect((await send(h, 'status check: where are you?')).text).toContain('m4')
  expect((await send(h, 'status check: where are you?')).text).toContain('m5')
  after(() => 0)
})

// ---- 3. an answer clears "waiting for your answer" --------------------------------------------------------------------------------------
const waits = (h: any, since: number) => h.files.set(`${T1}/waiting.json`, JSON.stringify({ since, text: 'sqlite or postgres?' }))
const deskInbox = (h: any, ...recs: object[]) => h.files.set(`${L}/desk/inbox.jsonl`, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
const listText = async (h: any) => (await leanThread(h.host, ROOT, { action: 'list' })).text

test('queuing an answer to a waiting thread clears its waiting state: the list says "answer queued, not read yet (age)" until the thread reads it', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  expect(await listText(h)).toContain('waiting for your answer')
  const r = await send(h, 'postgres')
  expect(r.text).toContain('m1: queued, not read yet')
  expect(json(h, `${T1}/waiting.json`)).toEqual({}) // no longer waiting
  expect(await listText(h)).toContain('answer queued, not read yet (0 s)')
  expect(await listText(h)).not.toContain('waiting for your answer')
  h.clock.t = T0 + 4 * 60_000
  expect(await listText(h)).toContain('answer queued, not read yet (4 min)')
  expect((await messages(h)).text).toContain('answer to its question')
  await takeBatch(h.host, 't1') // consumed: answered, nothing left to show
  expect(await listText(h)).not.toContain('answer queued')
  after(() => 0)
})

test('a plain instruction to a thread that waits for nothing is not an answer: no "answer queued" text', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await send(h, 'also run the linter')
  expect(await listText(h)).not.toContain('answer queued')
  after(() => 0)
})

test('the pane row: the question card is answered (not asking) once an answer is queued, and the row text says so until it is read', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  deskInbox(h, { ts: T0 - 60_000, from: 't1', kind: 'ask', text: 'sqlite or postgres?' })
  const before = (await loadView(h.host)).threads.find(x => x.id === 't1')!
  expect(before.asking).toBe(true)
  await send(h, 'postgres')
  h.clock.t = T0 + 3 * 60_000
  const queued = (await loadView(h.host)).threads.find(x => x.id === 't1')!
  expect(queued.asking).toBe(false)
  expect(queued.liveNote).toContain('answer queued, not read yet (3 min)')
  await takeBatch(h.host, 't1')
  const read = (await loadView(h.host)).threads.find(x => x.id === 't1')!
  expect(read.asking).toBe(false)
  expect(read.liveNote ?? '').not.toContain('answer queued')
  after(() => 0)
})

test('a desk inbox row whose question was already answered is marked answered and is not relayed again', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  activity(h, T0 - 60_000)
  waits(h, T0 - 60_000)
  deskInbox(h, { ts: T0 - 60_000, from: 't1', kind: 'ask', text: 'sqlite or postgres?' }, { ts: T0 - 50_000, from: 't2', kind: 'ask', text: 'other thread question' })
  await send(h, 'postgres')
  const u = await unreadReports(h.host)
  expect(u.recs).toHaveLength(2)
  const text = renderReports(u.recs)
  expect(text).toMatch(/from t1.*\[answered by the desk at \d\d:\d\d \(m1\)/)
  expect(text).not.toMatch(/from t2.*\[answered/)
  expect(worthRelay(u.recs.filter(r => r.from === 't1'))).toBe(false) // nothing left to ask the user for t1
  expect(worthRelay(u.recs)).toBe(true) // t2's question still needs them
  after(() => 0)
})

// ---- 4. idle without a report: ONE desk notice by script, a flag in the list -------------------------------------------------------------------
const idleRow = { status: 'idle', state: 'idle' }
const report = (h: any, rec: object) => h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify(rec) + '\n')

test('a thread idle for 12 min with no report raises ONE notice by script (not before idleAlertMinutes, never twice for the same idle spell)', { timeoutMs: 20_000 }, async () => {
  const { h, deps } = setup({ row: idleRow })
  const sd = { agents: deps.agents, restart: deps.restart as any }
  activity(h, T0 - 5 * 60_000)
  expect(await stallTick(h.host, sd)).toEqual([]) // 5 min: not yet
  h.clock.t = T0 + 7 * 60_000 // 12 min idle
  const n = await stallTick(h.host, sd)
  expect(n).toHaveLength(1)
  expect(n[0]!.id).toBe('t1')
  expect(n[0]!.text).toContain('t1 idle for 12 min with no report')
  expect(n[0]!.text).toContain('fix login')
  h.clock.t = T0 + 20 * 60_000
  expect(await stallTick(h.host, sd)).toEqual([]) // the same spell: told once
  // it works again, then idles again: a new spell, a new notice
  activity(h, T0 + 21 * 60_000)
  h.clock.t = T0 + 22 * 60_000
  expect(await stallTick(h.host, sd)).toEqual([])
  h.clock.t = T0 + 40 * 60_000
  expect(await stallTick(h.host, sd)).toHaveLength(1)
  after(() => 0)
})

test('idle but it reported done or blocked, or it is a keep-going thread, or the alert is off (threads.idleAlertMinutes 0): no notice; a [working] report that was the last word still counts as no report', { timeoutMs: 20_000 }, async () => {
  const a = setup({ row: idleRow })
  activity(a.h, T0 - 12 * 60_000)
  report(a.h, { ts: T0 - 12 * 60_000, from: 't1', kind: 'report', state: 'done', text: 'finished' })
  expect(await stallTick(a.h.host, { agents: a.deps.agents, restart: a.deps.restart as any })).toEqual([])
  const b = setup({ row: idleRow })
  activity(b.h, T0 - 12 * 60_000)
  report(b.h, { ts: T0 - 12 * 60_000, from: 't1', kind: 'report', state: 'blocked', text: 'needs the user' })
  expect(await stallTick(b.h.host, { agents: b.deps.agents, restart: b.deps.restart as any })).toEqual([])
  const c = setup({ row: idleRow })
  c.h.files.set(`${T1}/thread.json`, JSON.stringify({ ...json(c.h, `${T1}/thread.json`), keepGoing: true }))
  activity(c.h, T0 - 12 * 60_000)
  expect(await stallTick(c.h.host, { agents: c.deps.agents, restart: c.deps.restart as any })).toEqual([])
  const d = setup({ row: idleRow, config: { threads: { idleAlertMinutes: 0 } } })
  activity(d.h, T0 - 12 * 60_000)
  expect(await stallTick(d.h.host, { agents: d.deps.agents, restart: d.deps.restart as any })).toEqual([])
  const e = setup({ row: idleRow })
  activity(e.h, T0 - 12 * 60_000)
  report(e.h, { ts: T0 - 12 * 60_000, from: 't1', kind: 'report', state: 'working', text: 'half way through the parser' })
  const n = await stallTick(e.h.host, { agents: e.deps.agents, restart: e.deps.restart as any })
  expect(n).toHaveLength(1)
  expect(n[0]!.text).toContain('half way through the parser')
  after(() => 0)
})

test('idleAlertMinutes is configurable; `lean_thread list` flags the idle thread with no report, the stall features stay as they were', { timeoutMs: 20_000 }, async () => {
  const { h, deps } = setup({ row: idleRow, config: { threads: { idleAlertMinutes: 3 } } })
  activity(h, T0 - 4 * 60_000)
  expect(await listText(h)).toContain('idle 4 min, no report')
  expect(await stallTick(h.host, { agents: deps.agents, restart: deps.restart as any })).toHaveLength(1)
  report(h, { ts: T0, from: 't1', kind: 'report', state: 'done', text: 'finished' })
  expect(await listText(h)).not.toContain('no report')
  after(() => 0)
})

test('the automatic restart failing three times marks the message failed, one notice', { timeoutMs: 20_000 }, async () => {
  const { h, deps } = setup({ row: { status: 'idle', state: 'idle' } })
  const bad = { ...deps, restart: async () => ({ ok: false, text: 'claude --bg refused' }) }
  woken(h)
  await send(h, 'use sqlite')
  const notes: any[] = []
  for (let k = 1; k <= 4; k++) {
    h.clock.t = T0 + 46_000 + k * 5_000
    notes.push(...(await deliveryTick(h.host, bad)))
  }
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toContain('failed 3 times')
  expect((await messages(h)).text).toContain('m1 failed')
  after(() => 0)
})
