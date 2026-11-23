// Stall watchdog (stall.ts, threadstate.ts truthOf / touchActivity, threads.ts list): synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { STALL_MINUTES, resetActivity, stallConfig, touchActivity, truthOf } from './threadstate'
import { stallLines, stallTick } from './stall'
import { stateOf } from './view'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const MIN = 60_000
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any

function setup(o: { config?: unknown; activityMinAgo?: number | null; unread?: number[] } = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetActivity()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 120 * MIN, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  if (o.activityMinAgo !== null) h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - (o.activityMinAgo ?? 25) * MIN, kind: 'tool' }))
  if (o.unread?.length) h.files.set(`${T1}/inbox.jsonl`, o.unread.map(m => JSON.stringify({ ts: T0 - m * MIN, from: 'desk', text: 'please look' })).join('\n') + '\n')
  return h
}
const stalls = (h: any) => JSON.parse(h.files.get(`${L}/desk/stalls.json`) ?? '{}')
const deps = (state: { rows: any[]; restarts: string[]; result?: any }) => ({ agents: async () => state.rows, restart: async (id: string, why: string) => (state.restarts.push(`${id}|${why}`), state.result ?? { ok: true, text: `${id} started`, data: { fresh: true } }) })

test('truthOf: working + no activity for stallMinutes (or an old unread message) is stalled; a worker\'s activity, a prompt for the user and an idle session are not', () => {
  const base = { threadState: 'open', queued: [] as { ts: number }[], now: T0 }
  expect(STALL_MINUTES).toBe(20)
  const s = truthOf({ ...base, row: row(), activityAt: T0 - 25 * MIN })
  expect(s.word).toBe('stalled')
  expect(s.text).toMatch(/^stalled: no tool call or report for 25 min \(last activity \d\d:\d\d\)$/)
  expect(truthOf({ ...base, row: row(), activityAt: T0 - 19 * MIN }).word).toBe('running') // a worker's tool call a minute ago moved activityAt
  expect(truthOf({ ...base, row: row(), activityAt: null }).word).toBe('running') // unknown: no claim
  expect(truthOf({ ...base, row: row(), activityAt: T0 - 5 * MIN, queued: [{ ts: T0 - 21 * MIN }, { ts: T0 - 2 * MIN }] }).word).toBe('stalled') // unread older than that
  expect(truthOf({ ...base, row: row(), activityAt: T0 - 5 * MIN, queued: [{ ts: T0 - 15 * MIN }] }).word).toBe('stuck') // stuckMinutes (10) still applies first
  expect(truthOf({ ...base, row: row({ waitingFor: 'permission' }), activityAt: T0 - 90 * MIN }).word).toBe('running') // the user's to answer
  expect(truthOf({ ...base, row: row({ status: 'idle', state: 'idle' }), activityAt: T0 - 90 * MIN }).word).toBe('idle')
  expect(truthOf({ ...base, row: row(), activityAt: T0 - 30 * MIN, stallMinutes: 45 }).word).toBe('running') // config
  expect(truthOf({ ...base, row: row(), activityAt: T0 - 25 * MIN, queued: [{ ts: T0 - 25 * MIN }, { ts: T0 - 25 * MIN }, { ts: T0 - 25 * MIN }] }).text).toContain('3 unread queued')
})

test('threads.stallMinutes / stallRestart config', async () => {
  expect(await stallConfig(setup().host, '/h')).toEqual({ minutes: 20, restart: false })
  expect(await stallConfig(setup({ config: { threads: { stallMinutes: 5, stallRestart: true } } }).host, '/h')).toEqual({ minutes: 5, restart: true })
  expect(await stallConfig(setup({ config: { threads: { stallMinutes: -1, stallRestart: 'yes' } } }).host, '/h')).toEqual({ minutes: 20, restart: false })
})

test('touchActivity writes the thread\'s own file, at most every 5 s (a report always)', async () => {
  const h = setup({ activityMinAgo: null })
  const at = () => JSON.parse(h.files.get(`${T1}/activity.json`) ?? 'null')
  await touchActivity(h.host, '/h', 't1', 'tool')
  expect(at()).toEqual({ at: T0, kind: 'tool' })
  h.clock.t = T0 + 2_000
  await touchActivity(h.host, '/h', 't1', 'worker')
  expect(at().at).toBe(T0) // throttled
  await touchActivity(h.host, '/h', 't1', 'report', true)
  expect(at()).toEqual({ at: T0 + 2_000, kind: 'report' })
  h.clock.t = T0 + 8_000
  await touchActivity(h.host, '/h', 't1', 'worker')
  expect(at()).toEqual({ at: T0 + 8_000, kind: 'worker' })
})

test('tick: ONE notice per stall (naming minutes and unread), the desk reminder while it lasts, cleared when it works again, a new stall gets a new notice', async () => {
  const h = setup({ unread: [24, 23, 22] })
  const st = { rows: [row()], restarts: [] as string[] }
  const d = deps(st)
  const a = await stallTick(h.host, d)
  expect(a).toEqual([{ id: 't1', text: 't1 has done nothing for 25 min, 3 messages unread: wake or restart it' }])
  expect(await stallTick(h.host, d)).toEqual([]) // the same stall: no second notice
  expect(st.restarts).toEqual([]) // stallRestart is off by default: nothing is restarted
  h.clock.t = T0 + 5 * MIN
  expect(await stallLines(h.host)).toBe('[lean-agent] stalled: t1 has done nothing for 30 min, 3 messages unread: wake or restart it')
  // it works again (a tool call): the record goes, the reminder with it
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: h.clock.t, kind: 'tool' }))
  h.files.set(`${T1}/inbox.jsonl`, '')
  expect(await stallTick(h.host, d)).toEqual([])
  expect(stalls(h)).toEqual({})
  expect(await stallLines(h.host)).toBeNull()
  // a later stall
  h.clock.t += 21 * MIN
  expect((await stallTick(h.host, d)).map(n => n.text)).toEqual(['t1 has done nothing for 21 min: wake or restart it'])
})

test('tick: a thread that waits for the user, an idle one, a parked one and an unreadable listing are never flagged', async () => {
  const h = setup()
  const st = { rows: [row({ waitingFor: 'permission' })], restarts: [] as string[] }
  expect(await stallTick(h.host, deps(st))).toEqual([])
  st.rows = [row({ status: 'idle', state: 'idle' })]
  expect(await stallTick(h.host, deps(st))).toEqual([])
  st.rows = [row()]
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', state: 'parked', sid: S1, lastWake: 0 }))
  expect(await stallTick(h.host, deps(st))).toEqual([])
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', state: 'open', sid: S1, lastWake: 0 }))
  expect(await stallTick(h.host, { agents: async () => null, restart: async () => ({ ok: true, text: '' }) })).toEqual([])
  expect(stalls(h)).toEqual({})
})

test('tick with threads.stallRestart: the mod restarts the stalled thread itself and says so; a failing restart is retried, then ONE notice', async () => {
  const h = setup({ config: { threads: { stallRestart: true } } })
  const st = { rows: [row()], restarts: [] as string[] }
  const a = await stallTick(h.host, deps(st))
  expect(st.restarts).toHaveLength(1)
  expect(st.restarts[0]).toContain('t1|Its previous session stalled: no tool call or report for 25 min')
  expect(a).toEqual([{ id: 't1', text: 't1 has done nothing for 25 min: restarted it as a new session by script (threads.stallRestart is on)' }])
  expect(stalls(h)).toEqual({})
  // a restart that fails: tried at each tick, ONE notice after the third
  const f = setup({ config: { threads: { stallRestart: true } } })
  const bad = { rows: [row()], restarts: [] as string[], result: { ok: false, text: 'claude stop failed: boom' } }
  expect(await stallTick(f.host, deps(bad))).toEqual([])
  expect(await stallTick(f.host, deps(bad))).toEqual([])
  const last = await stallTick(f.host, deps(bad))
  expect(bad.restarts).toHaveLength(3)
  expect(last).toHaveLength(1)
  expect(last[0]!.text).toContain('the automatic restart failed 3 times (last reason: claude stop failed: boom)')
  expect(await stallTick(f.host, deps(bad))).toEqual([]) // given up for this stall
  expect(bad.restarts).toHaveLength(3)
})

test('stall-restart through leanThread: the working session is stopped and a fresh one started (same path as the context restart)', async () => {
  const h = setup({ config: { threads: { stallRestart: true } } })
  const live = [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234' }] as any[]
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(live) }
    if (a[0] === 'stop') {
      for (const r of live) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const agents = async () => live.map(r => row({ sid: r.sessionId, pid: r.pid, status: r.status, state: r.state }))
  const notes = await stallTick(h.host, { agents, restart: (id, why) => leanThread(h.host, '/p', { action: 'stall-restart', tN: id, reason: why, force: true }) })
  expect(h.claudeCalls().filter(x => x[0] === 'stop')).toHaveLength(1)
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(1)
  expect(notes[0]!.text).toContain('restarted it as a new session by script')
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).sid).toBe(NEW)
})

test('lean_thread list names a stalled thread and the time of its last activity; a busy one with fresh activity is running', async () => {
  const h = setup({ unread: [] })
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: S1, name: '', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234' }]) } : { exitCode: 0, stdout: '' })
  const r = await leanThread(h.host, '/p', { action: 'list', verbose: true })
  expect(r.text).toMatch(/t1 · fix login · app \[open, stalled: no tool call or report for 25 min \(last activity \d\d:\d\d\)\]/)
  expect((r.data as any[])[0]).toMatchObject({ live: 'stalled' })
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - MIN, kind: 'worker' }))
  expect((await leanThread(h.host, '/p', { action: 'list', verbose: true })).text).toContain('[open, running]')
})

test('the pane word: stalled is red, and ranks below the user\'s own waits', () => {
  expect(stateOf({ run: 'running', live: 'stalled', working: true } as any)).toEqual({ word: 'stalled', color: 'error' })
  expect(stateOf({ run: 'running', live: 'stalled', working: true, needsYou: true } as any).word).toBe('waiting')
})
