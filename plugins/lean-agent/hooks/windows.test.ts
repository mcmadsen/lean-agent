// The plan window (windows.ts): the snapshot of rateLimits, the stats line, the desk's notices at 80 % and 90 %, the hold warning on
// `new` / `start`. Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { holdWarning, parseWindows, readWindows, recordWindows, windowLine, windowTick, windowsFile } from './windows'
import { statsText, windowLine as exported } from './stats'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'

const NOW = 1_700_000_000_000
const MIN = 60_000
const L = '/h/.lean-agent'
const FILE = windowsFile('/h')
const usage = (five: number, seven: number, reset5 = NOW + 73 * MIN) => ({ rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt: new Date(reset5).toISOString() }, { kind: 'seven_day', percentUsed: seven, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }] })
const fresh = () => {
  const h = fakeHost(null)
  h.clock.t = NOW
  return h
}

test('parseWindows is tolerant: the two kinds, ISO or ms reset times, clamps, junk skipped', () => {
  expect(parseWindows(null)).toEqual([])
  expect(parseWindows({ rateLimits: 'x' })).toEqual([])
  const w = parseWindows({ rateLimits: [{ kind: 'five_hour', percentUsed: 120, resetsAt: 5 }, { kind: 'month', percentUsed: 1 }, { kind: 'seven_day', percentUsed: 'n' }, { kind: 'seven_day', percentUsed: 41, resetsAt: 'garbage' }, null] })
  expect(w).toEqual([{ kind: 'five_hour', percentUsed: 100, resetsAt: 5 }, { kind: 'seven_day', percentUsed: 41, resetsAt: 0 }])
})

test('recordWindows snapshots to desk/windows.json; unchanged readings are not rewritten within 2 minutes', async () => {
  const h = fresh()
  expect(await recordWindows(h.host, { context: {} })).toBe(false) // no windows: nothing
  expect(h.files.has(FILE)).toBe(false)
  expect(await recordWindows(h.host, usage(78, 41))).toBe(true)
  const s = await readWindows(h.host, '/h')
  expect(s?.at).toBe(NOW)
  expect(s?.windows.map(x => [x.kind, x.percentUsed])).toEqual([['five_hour', 78], ['seven_day', 41]])
  expect([...h.files.keys()].filter(k => k.includes('.tmp'))).toEqual([]) // atomic
  h.clock.t = NOW + 30_000
  expect(await recordWindows(h.host, usage(78.4, 41))).toBe(false) // the same point
  expect((await readWindows(h.host, '/h'))?.at).toBe(NOW)
  expect(await recordWindows(h.host, usage(79, 41))).toBe(true) // a window moved a point
  h.clock.t = NOW + 5 * MIN
  expect(await recordWindows(h.host, usage(79, 41))).toBe(true) // unchanged but old: the snapshot age stays honest
  expect((await readWindows(h.host, '/h'))?.at).toBe(NOW + 5 * MIN)
})

test('windowLine: "5h window: 78% used, resets HH:MM (in 1h 13m) | 7d: 41%" and the snapshot age; never "no source"', async () => {
  const h = fresh()
  expect(await windowLine(h.host)).toContain('not measured yet')
  expect(await windowLine(h.host)).not.toMatch(/no source/i)
  await recordWindows(h.host, usage(78, 41))
  h.clock.t = NOW + 3 * MIN
  const line = await windowLine(h.host)
  expect(line).toMatch(/^5h window: 78% used, resets .+ \(in 1h 10m\) \| 7d: 41% \(snapshot 3 min old\)$/)
  // a spent window says so instead of a stale percentage
  h.clock.t = NOW + 80 * MIN
  expect(await windowLine(h.host)).toMatch(/^5h window: reset at .+ passed \(was 78%\)/)
  expect(exported).toBe(windowLine)
})

test('lean_doctor stats leads with the window line', async () => {
  const h = fresh()
  await recordWindows(h.host, usage(78, 41))
  const text = await statsText(h.host)
  expect(text.split('\n')[0]).toMatch(/^5h window: 78% used, resets .+ \| 7d: 41%/)
  expect(text.split('\n')[1]).toMatch(/^lean-agent stats:/)
})

test('windowTick: a notice at 80 and at 90, once per window, naming the working threads', async () => {
  const h = fresh()
  const deps = { working: async () => ['t1', 't3'] }
  await recordWindows(h.host, usage(70, 10))
  expect(await windowTick(h.host, deps)).toEqual([])
  h.clock.t = NOW + 3 * MIN
  await recordWindows(h.host, usage(82, 10))
  const a = await windowTick(h.host, deps)
  expect(a).toHaveLength(1)
  expect(a[0]).toMatch(/^5h plan window 82% used \(past 80%, resets .+ in 1h \d+m\); working now: t1, t3$/)
  expect(await windowTick(h.host, deps)).toEqual([]) // once
  await recordWindows(h.host, usage(91, 10))
  const b = await windowTick(h.host, { working: async () => [] })
  expect(b).toHaveLength(1)
  expect(b[0]).toContain('past 90%')
  expect(b[0]).toContain('working now: no thread')
  expect(await windowTick(h.host, deps)).toEqual([])
  // a new window (another reset time) notifies again
  h.clock.t = NOW + 6 * 3_600_000
  await recordWindows(h.host, usage(85, 10, NOW + 11 * 3_600_000))
  expect(await windowTick(h.host, deps)).toHaveLength(1)
  // a window that jumps past both at once is one notice (the higher level)
  const g = fresh()
  await recordWindows(g.host, usage(95, 95))
  const both = await windowTick(g.host, deps)
  expect(both).toHaveLength(2)
  expect(both.every(x => x.includes('past 90%'))).toBe(true)
})

test('holdWarning: above window.holdAbove (default 85) only', async () => {
  const h = fresh()
  expect(await holdWarning(h.host, '/h')).toBe('')
  await recordWindows(h.host, usage(85, 10))
  expect(await holdWarning(h.host, '/h')).toBe('') // not above
  await recordWindows(h.host, usage(86, 10))
  const w = await holdWarning(h.host, '/h')
  expect(w).toMatch(/^WARNING plan window: 5h 86% used \(hold above 85%, resets .+ in 1h 1\dm\)/)
  h.files.set(`${L}/config.json`, JSON.stringify({ window: { holdAbove: 95 } }))
  expect(await holdWarning(h.host, '/h')).toBe('')
  h.files.set(`${L}/config.json`, JSON.stringify({ window: { holdAbove: 50 } }))
  expect(await holdWarning(h.host, '/h')).toContain('hold above 50%')
  h.clock.t = NOW + 2 * 3_600_000 // the window is over
  expect(await holdWarning(h.host, '/h')).not.toContain('5h')
})

test('new / start replies carry the warning above the hold; other actions do not', async () => {
  resetLocks()
  resetFinish()
  resetThreadCache()
  const S = '11111111-2222-3333-4444-555555555555'
  const h = fresh()
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: S, name: 't1', cwd: '/x', status: 'busy', state: 'working', startedAt: 1, pid: 9, id: 'abcd1234' }]) } : { exitCode: 0, stdout: '' })
  const cold = await leanThread(h.host, '/p', { action: 'start', tN: 't1' })
  expect(cold.text).toBe('t1 is already running')
  await recordWindows(h.host, usage(90, 10))
  const hot = await leanThread(h.host, '/p', { action: 'start', tN: 't1' })
  expect(hot.text).toMatch(/^t1 is already running\nWARNING plan window: 5h 90% used/)
  expect(hot.ok).toBe(true)
})
