// 1.0.33: a review does not run where it cannot go green. (1) the 5h-window throttle HOLDS a full review whose diff one haiku pass cannot read (review.holdWhenThrottled), instead of spending
// a record attempt on it; (2) the diff's bytes are compared with what one reviewer pass reads in its 16 calls, and the areas are split further by script (more than 6 when needed) with the numbers
// said; (3) a local range far larger than its own commits warns. Synthetic numbers.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { REVIEWER_STEPS } from './jobs'
import { BYTES_PER_CALL, MAX_AREAS, MAX_AREAS_HARD, areaCount, areasCoverage, coverageNote, inArea, keepSections, partition, passBytes } from './reviewarea'
import { reviewWindowGate } from './throttle'

const L = '/h/.lean-agent'
const HOUR = 3_600_000
const win = (h: ReturnType<typeof fakeHost>, five: number) =>
  h.files.set(`${L}/desk/windows.json`, JSON.stringify({ v: 1, at: h.clock.t, windows: [{ kind: 'five_hour', percentUsed: five, resetsAt: h.clock.t + 2 * HOUR }, { kind: 'seven_day', percentUsed: 46, resetsAt: h.clock.t + 50 * HOUR }] }))
const cfg = (h: ReturnType<typeof fakeHost>, o: unknown) => h.files.set(`${L}/config.json`, JSON.stringify(o))
const world = () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', project: 'shop', priority: 'urgent' }))
  return h
}
const BIG = 875_000

test('what one pass reads: 16 calls of 5.5 KB; areas grow from 6 to what the bytes need, never past the hard cap', () => {
  expect(REVIEWER_STEPS * BYTES_PER_CALL).toBe(passBytes())
  expect(areaCount(10_000)).toBe(MAX_AREAS)
  expect(areaCount(passBytes() * MAX_AREAS)).toBe(MAX_AREAS)
  expect(areaCount(BIG)).toBe(10) // 875 KB over 88 KB a pass: 10 areas
  expect(areaCount(BIG)).toBeGreaterThan(MAX_AREAS)
  expect(areaCount(1e12)).toBe(MAX_AREAS_HARD)
})

test('coverageNote: silent when the diff fits one pass; otherwise sizes, the share one pass reads and how many passes cover it', () => {
  expect(coverageNote(passBytes())).toBeNull()
  const t = coverageNote(BIG, 'area-3')!
  expect(t).toContain('COVERAGE: area-3 is 875 KB')
  expect(t).toContain('about 88 KB in its 16 tool calls')
  expect(t).toContain('about 10% of it')
  expect(t).toContain('10 passes are needed')
})

// a diff of n files in folders f0..f(m-1), `bytes` per file
const diffOf = (files: number, folders: number, bytes: number) =>
  Array.from({ length: files }, (_v, i) => `diff --git a/f${i % folders}/file${i}.ts b/f${i % folders}/file${i}.ts\n--- a/f${i % folders}/file${i}.ts\n+++ b/f${i % folders}/file${i}.ts\n@@ -1 +1 @@\n+${'x'.repeat(bytes)}\n`).join('')
const statsOf = (files: number, folders: number) => Array.from({ length: files }, (_v, i) => ({ path: `f${i % folders}/file${i}.ts`, add: 40, del: 0 }))

test('a 393-file, 875 KB diff is split into the areas its bytes need, each within one pass, and the thread is told the sizes', () => {
  const files = 393
  const bytes = Math.floor(BIG / files)
  const diff = diffOf(files, 200, bytes)
  const areas = partition(statsOf(files, 200), areaCount(diff.length))
  expect(areas.length).toBeGreaterThan(MAX_AREAS)
  expect(areas.length).toBeLessThanOrEqual(MAX_AREAS_HARD)
  expect(areas.reduce((n, a) => n + a.files, 0)).toBe(files) // every file is in exactly one area
  const text = areasCoverage(diff, areas)
  expect(text).toContain(`split by script into ${areas.length} areas`)
  expect(text).not.toContain('still more than one pass')
  for (const a of areas) expect(keepSections(diff, p => inArea(p, a, areas)).length).toBeLessThanOrEqual(passBytes())
  // one folder that no split can break up: said, with what a pass covers
  const lone = diffOf(3, 1, 60_000)
  const one = partition(statsOf(3, 1), areaCount(lone.length))
  expect(areasCoverage(lone, one)).toContain('is still more than one pass reads')
})

test('throttled window + a full review whose diff one haiku pass cannot read: HELD (no reviewer, no record attempt), with the percent, the way out and the desk wording', async () => {
  const h = world()
  win(h, 73)
  const held = await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG })
  expect(held.stop).toContain('HELD: 5h window at 73%')
  expect(held.stop).toContain('above window.throttleAbove 70%')
  expect(held.stop).toContain('sonnet is available')
  expect(held.stop).toContain('875 KB')
  expect(held.stop).toContain('confirm: true')
  expect(held.stop).toContain('lean_ask')
  expect(held.note).toBeUndefined()
})

test('the hold has its ways out: the user\'s go (confirm), a small diff, a light review, an urgent thread, a window below the line, review.holdWhenThrottled false', async () => {
  const h = world()
  win(h, 73)
  const note = (r: { stop?: string; note?: string }) => {
    expect(r.stop).toBeUndefined()
    expect(r.note).toContain('model "haiku"')
  }
  note(await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG, confirm: true })) // the user said go
  note(await reviewWindowGate(h.host, 't1', { level: 'full', bytes: passBytes() })) // one haiku pass reads all of it
  note(await reviewWindowGate(h.host, 't1', { level: 'light', bytes: BIG })) // a light review is never green anyway
  note(await reviewWindowGate(h.host, 't2', { level: 'full', bytes: BIG })) // urgent
  note(await reviewWindowGate(h.host, 't1', { level: 'full' })) // no size known
  cfg(h, { review: { holdWhenThrottled: false } })
  note(await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG }))
  cfg(h, { 'review.holdWhenThrottled': 'false' })
  note(await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG }))
  cfg(h, {})
  expect((await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG })).stop).toContain('HELD')
  win(h, 60)
  expect(await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG })).toEqual({})
  win(h, 93) // blocked and capped keep their own stop texts
  expect((await reviewWindowGate(h.host, 't1', { level: 'full', bytes: BIG })).stop).toContain('no reviewer fan-out starts until the window resets')
})
