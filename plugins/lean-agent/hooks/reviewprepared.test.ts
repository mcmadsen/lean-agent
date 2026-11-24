import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { noteReviewed } from './reviewkind'
import { notePrepare } from './reviewprepared'
import { reviewReport } from './reviewevidence'

// A review thread prepares a PR twice (the first range is wrong, the second is the real one): the later prepare replaces the earlier one and
// `done` counts the areas of the LAST prepare only. Synthetic numbers: 320 files in the wrong range, 1 file in the right one.
const L = '/h/.lean-agent'
const HEAD = 'e'.repeat(40)
const BASE = 'b'.repeat(40)
const ok = (stdout = '') => ({ exitCode: 0, stdout })
const approve = { verdict: 'approve', goal: 'g', findings: [], reuse: [], coverage: [] }
const section = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`
const SMALL = section('src/a.ts')
const BIGFILES = Array.from({ length: 320 }, (_, i) => `pkg${i % 4}/sub${i % 8}/f${i}.ts`)

function setup(thread = 't1') {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/${thread}/thread.json`, JSON.stringify({ id: thread, project: 'app' }))
  h.store.set(`review.marker.${thread}`, { kind: 'review', project: 'app', ref: '12', ts: 1 })
  const range = (names: string[], diff: string) => (h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    if (s.includes('remote get-url')) return ok('https://git.example/org/app.git\n')
    if (s.includes(' init ') || s.includes(' fetch ')) return ok()
    if (s.includes('rev-parse')) { const r = a[a.length - 1]!.replace('^{commit}', ''); return ok((r.startsWith('refs/ext/head') ? HEAD : r.startsWith('refs/ext/base') ? BASE : r) + '\n') }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: 1, stdout: '' }
    if (s.includes('merge-base')) return ok(BASE + '\n')
    if (s.includes('--name-status')) return ok(names.map(n => `M\t${n}`).join('\n') + '\n')
    if (s.includes(' diff ')) return ok(diff)
    return { exitCode: 1, stdout: '' }
  })
  const wrong = () => range(BIGFILES, BIGFILES.map(section).join(''))
  const right = () => range(['src/a.ts'], SMALL)
  return { h, wrong, right }
}
const tool = (h: any, input: Record<string, unknown>, thread = 't1') => threadTool(h.host, thread, 'lean_review', input)
const rec = (h: any) => JSON.parse(h.files.get(`${L}/app/reviews/${HEAD}.json`)!)
const slots = (h: any, thread = 't1') => h.store.get(`review.prepared.${thread}`) as Record<string, { last: any; older: any[] }>
const WRONG = { action: 'prepare', ref: '12', base: 'wrongbase', level: 'full', confirm: true }
const RIGHT = { action: 'prepare', ref: '12', base: 'main', level: 'full' }

test('the report: prepare wrong -> prepare right -> record -> done is accepted (the first prepare\'s areas no longer block)', { timeoutMs: 20_000 }, async () => {
  const { h, wrong, right } = setup()
  wrong()
  const first = await tool(h, WRONG)
  expect(first.ok).toBe(true)
  expect(first.text).toContain('"tooLarge":true')
  const n = slots(h)['PR #12']!.last.areas.length
  expect(n).toBeGreaterThan(1)
  h.clock.t += 60_000
  right()
  const second = await tool(h, RIGHT)
  expect(second.ok).toBe(true)
  expect(second.text).toMatch(new RegExp(`replaces the earlier prepare of 00:16 UTC: ${n} areas / 320 files; now 1 area / 1 file`))
  expect(slots(h)['PR #12']!.last).toMatchObject({ id: 'p2', files: 1, areas: [] })
  expect(slots(h)['PR #12']!.older).toHaveLength(1)
  expect(slots(h)['PR #12']!.older[0]).toMatchObject({ id: 'p1', files: 320, superseded: expect.any(Number) })
  expect((await reviewReport(h.host, 't1', 'done', 'fine')).text).toContain('no lean_review record exists')
  h.clock.t += 60_000
  expect((await tool(h, { sha: HEAD, mode: 'external', base: 'main', passes: 1, review: approve })).ok).toBe(true)
  const done = await reviewReport(h.host, 't1', 'done', 'fine')
  expect(done.ok).toBe(true)
  expect(done.text).toContain('prepare checked: p2 of 00:17 UTC: 1 area / 1 file')
})

test('the first prepare of a ref says nothing about replacing; the old head-keyed list is cleared by a later small prepare', { timeoutMs: 20_000 }, async () => {
  const { h, right } = setup()
  right()
  const p = await tool(h, RIGHT)
  expect(p.text).not.toContain('replaces the earlier prepare')
  expect(slots(h)['PR #12']!.last).toMatchObject({ id: 'p1', files: 1 })
})

test('a done with a record missing for an area of the LAST prepare is still refused, and says which prepare it checked', { timeoutMs: 20_000 }, async () => {
  const { h, wrong } = setup()
  wrong()
  await tool(h, WRONG)
  const areas = slots(h)['PR #12']!.last.areas as string[]
  h.clock.t += 60_000
  const a1 = await tool(h, { ...RIGHT, scope: areas[0] })
  expect(a1.ok).toBe(true)
  expect(slots(h)['PR #12']!.last.id).toBe('p1') // an area pass is part of its prepare: it replaces nothing
  const r1 = await tool(h, { sha: HEAD, mode: 'external', base: 'main', scope: areas[0], review: approve })
  expect(r1.ok).toBe(true)
  const refused = await reviewReport(h.host, 't1', 'done', 'fine')
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain(`${areas.slice(1).join(', ')} of the last prepare (p1, 320 files)`)
  expect(refused.text).toContain('never review files outside the PR')
})

test('the area records of an earlier prepare of the same head are kept as superseded history and never required', { timeoutMs: 20_000 }, async () => {
  const { h, wrong, right } = setup()
  wrong()
  await tool(h, WRONG)
  const areas = slots(h)['PR #12']!.last.areas as string[]
  await tool(h, { ...RIGHT, scope: areas[0] })
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', scope: areas[0], review: approve })
  expect(Object.keys(rec(h).areas)).toEqual([areas[0]])
  h.clock.t += 60_000
  right()
  await tool(h, RIGHT)
  expect(rec(h).areas).toBeUndefined()
  expect(rec(h).superseded).toMatchObject([{ prepare: 'p1', areas: { [areas[0]!]: { verdict: 'approve' } } }])
  // the superseded record is no record of the new range: a fresh record is needed
  expect((await reviewReport(h.host, 't1', 'done', 'fine')).ok).toBe(false)
  h.clock.t += 60_000
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', review: approve })
  expect((await reviewReport(h.host, 't1', 'done', 'fine')).ok).toBe(true)
})

test('reset-prepare drops the stale state (records kept), says what it dropped, and a done after it asks for a prepare', { timeoutMs: 20_000 }, async () => {
  const { h, wrong, right } = setup()
  expect((await tool(h, { action: 'reset-prepare' })).text).toContain('no prepared state')
  wrong()
  await tool(h, WRONG)
  const areas = slots(h)['PR #12']!.last.areas as string[]
  await tool(h, { ...RIGHT, scope: areas[0] })
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', scope: areas[0], review: approve })
  const other = await tool(h, { action: 'reset-prepare', ref: '99' })
  expect(other.text).toContain('nothing was dropped')
  expect(other.text).toContain('PR #12')
  const out = await tool(h, { action: 'reset-prepare', ref: 'https://git.example/org/app/pull/12' })
  expect(out.ok).toBe(true)
  expect(out.text).toContain('dropped the prepared state of PR #12')
  expect(out.text).toContain('p1 of 00:16 UTC')
  expect(out.text).toContain('320 files')
  expect(out.text).toContain('records are kept as history')
  expect(slots(h)['PR #12']!.last).toBeNull()
  expect(rec(h).superseded[0].areas[areas[0]!]).toBeTruthy() // the record is history, not deleted
  const gate = await reviewReport(h.host, 't1', 'done', 'fine')
  expect(gate.ok).toBe(false)
  expect(gate.text).toContain('was reset')
  // prepare again: no "replaces" sentence (nothing was live), and done is accepted after a record
  h.clock.t += 60_000
  right()
  expect((await tool(h, RIGHT)).text).not.toContain('replaces the earlier prepare')
  h.clock.t += 60_000
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', review: approve })
  expect((await reviewReport(h.host, 't1', 'done', 'fine')).ok).toBe(true)
})

test('two refs of one thread keep their own prepared state: a prepare or a reset of one never touches the other', { timeoutMs: 20_000 }, async () => {
  const { h, wrong, right } = setup()
  wrong()
  await tool(h, WRONG)
  right()
  const b = await tool(h, { ...RIGHT, ref: '13' })
  expect(b.text).not.toContain('replaces the earlier prepare')
  expect(slots(h)['PR #12']!.last).toMatchObject({ id: 'p1', files: 320 })
  expect(slots(h)['PR #13']!.last).toMatchObject({ id: 'p1', files: 1 })
  await tool(h, { action: 'reset-prepare', ref: '13' })
  expect(slots(h)['PR #12']!.last).toMatchObject({ id: 'p1', files: 320 })
  expect(slots(h)['PR #13']!.last).toBeNull()
  // another thread's state is its own too
  expect(slots(h, 't2')).toBeUndefined()
})

test('done: the last prepare holds more files than the forge lists -> "the range of the last prepare looks wrong; prepare again"', { timeoutMs: 20_000 }, async () => {
  const { h } = setup()
  await noteReviewed(h.host, 't1', 'app', HEAD)
  await notePrepare(h.host, 't1', 'PR #12', { project: 'app', head: HEAD, mb: BASE, files: 1200, lines: 9000, forgeN: 7, areas: ['area-1', 'area-2'] })
  const gate = await reviewReport(h.host, 't1', 'done', 'fine')
  expect(gate.ok).toBe(false)
  expect(gate.text).toContain('the range of the last prepare looks wrong; prepare again')
  expect(gate.text).toContain('1200 files')
  expect(gate.text).toContain('forge lists 7 files')
  expect(gate.text).not.toContain('no record')
  // a later prepare with the forge's own count lifts it
  h.clock.t += 60_000
  const again = await notePrepare(h.host, 't1', 'PR #12', { project: 'app', head: HEAD, mb: BASE, files: 7, lines: 519, forgeN: 7, areas: [] })
  expect(again).toContain('replaces the earlier prepare of 00:16 UTC: 2 areas / 1200 files; now 1 area / 7 files')
  expect((await reviewReport(h.host, 't1', 'done', 'fine')).text).toContain('no lean_review record exists')
})
