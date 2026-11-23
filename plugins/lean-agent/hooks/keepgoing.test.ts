// The keep-going standing order, the earlier stall (10 min; 5 for keep-going) and the restart at 80% of the context limit (stall.ts, threads.ts, continuepending.ts).
// Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks, unusedField } from './threads'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { KEEPGOING_STALL_MINUTES, resetActivity, stallFor } from './threadstate'
import { stallTick } from './stall'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const MIN = 60_000
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'busy', state: 'working', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any

function setup(o: { thread?: Record<string, unknown>; config?: unknown; activityMinAgo?: number; tokens?: number } = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetActivity()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 120 * MIN, delivered: 0, model: 'sonnet', effort: 'medium', ...o.thread }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - (o.activityMinAgo ?? 6) * MIN, kind: 'tool' }))
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  if (o.tokens) h.files.set(`${T1}/context.json`, JSON.stringify({ tokens: o.tokens, at: T0 - 20 * MIN, sid: S1 }))
  return h
}
const deps = (state: { restarts: string[]; rows?: any[] }) => ({ agents: async () => state.rows ?? [row()], restart: async (id: string, why: string) => (state.restarts.push(`${id}|${why}`), { ok: true, text: `${id} started`, data: { fresh: true } }) })
const flag = (h: any) => JSON.parse(h.files.get(`${T1}/thread.json`)!).keepGoing

test('keep-going tN on|off (desk): stored in thread.json, said back, shown in the list; without on/off it only says what is set', async () => {
  const h = setup()
  expect((await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1' })).text).toBe('t1 keep-going off')
  const on = await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1', on: true })
  expect(on.ok).toBe(true)
  expect(on.text).toContain('t1 keep-going on')
  expect(flag(h)).toBe(true)
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).toContain('keep-going')
  h.files.set(`${T1}/continue-pending.json`, JSON.stringify({ at: T0, sid: S1, kind: 'keep', text: '' }))
  expect((await leanThread(h.host, '/p', { action: 'keep-going', tN: 't1', on: false })).text).toBe('t1 keep-going off')
  expect(flag(h)).toBeUndefined()
  expect(JSON.parse(h.files.get(`${T1}/continue-pending.json`)!)).toEqual({}) // switched off: nothing pending
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).not.toContain('keep-going')
})

test('keepGoing is a field of new and start, keep-going takes on, action-cancel takes id (the tool entry refuses the others)', () => {
  expect(unusedField({ action: 'new', title: 'x', text: 'y', keepGoing: true })).toBeNull()
  expect(unusedField({ action: 'start', tN: 't1', keepGoing: true })).toBeNull()
  expect(unusedField({ action: 'keep-going', tN: 't1', on: true })).toBeNull()
  expect(unusedField({ action: 'action-cancel', id: 'a1-1' })).toBeNull()
  expect(unusedField({ action: 'send', tN: 't1', text: 'x', keepGoing: true })).not.toBeNull()
})

test('stall defaults: 10 minutes; a keep-going thread is flagged after 5', async () => {
  expect(KEEPGOING_STALL_MINUTES).toBe(5)
  expect(stallFor(10, { keepGoing: true })).toBe(5)
  expect(stallFor(10, {})).toBe(10)
  expect(stallFor(3, { keepGoing: true })).toBe(3) // a smaller configured value stays
  const plain = setup({ activityMinAgo: 6 })
  const a = { restarts: [] as string[] }
  expect(await stallTick(plain.host, deps(a))).toEqual([]) // 6 min: not yet
  const kg = setup({ activityMinAgo: 6, thread: { keepGoing: true } })
  const notes = await stallTick(kg.host, deps({ restarts: [] }))
  expect(notes.map(n => n.text)).toEqual(['t1 has done nothing for 6 min: wake or restart it'])
  const late = setup({ activityMinAgo: 11 })
  expect((await stallTick(late.host, deps({ restarts: [] }))).map(n => n.text)).toEqual(['t1 has done nothing for 11 min: wake or restart it'])
})

test('a stalled thread at 80% of the context limit is restarted at once by script; below it only the flag and the notice', async () => {
  const near = setup({ activityMinAgo: 12, tokens: 112_000 })
  const st = { restarts: [] as string[] }
  const notes = await stallTick(near.host, deps(st))
  expect(st.restarts).toHaveLength(1)
  expect(st.restarts[0]).toContain('t1|Its previous session stalled at 112000 tokens (limit 120000)')
  expect(notes.map(n => n.text)).toEqual(['t1 stalled at 112k of 120k: restarted'])
  const below = setup({ activityMinAgo: 12, tokens: 90_000 })
  const st2 = { restarts: [] as string[] }
  expect((await stallTick(below.host, deps(st2))).map(n => n.text)).toEqual(['t1 has done nothing for 12 min: wake or restart it'])
  expect(st2.restarts).toEqual([])
  const limit = setup({ activityMinAgo: 12, tokens: 80_000, config: { threadTokens: 100_000 } }) // 80% of a configured limit
  const st3 = { restarts: [] as string[] }
  expect((await stallTick(limit.host, deps(st3))).map(n => n.text)).toEqual(['t1 stalled at 80k of 100k: restarted'])
  // a parked thread is never restarted, whatever its size
  const parked = setup({ activityMinAgo: 12, tokens: 118_000, thread: { state: 'parked' } })
  const st4 = { restarts: [] as string[] }
  expect(await stallTick(parked.host, deps(st4))).toEqual([])
  expect(st4.restarts).toEqual([])
})

test('a thread that keeps stopping after "next:" (halted by continuepending) is in the stall state while idle; its own notice is the only one', async () => {
  const h = setup({ activityMinAgo: 1 })
  h.files.set(`${T1}/continue-state.json`, JSON.stringify({ consec: 3, sentAt: T0 - 2 * MIN, halted: T0 - 5 * MIN }))
  const notes = await stallTick(h.host, deps({ restarts: [], rows: [row({ status: 'idle', state: 'idle' })] }))
  expect(notes).toEqual([]) // (the desk notice "t1 keeps stopping after 'next:'" came from continueTick)
  const stalls = JSON.parse(h.files.get(`${L}/desk/stalls.json`)!)
  expect(stalls.t1).toMatchObject({ unread: 0 })
})
