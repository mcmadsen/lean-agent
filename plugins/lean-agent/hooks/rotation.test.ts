// Ledger rotation under failure and concurrency: no row is counted twice or lost, a regrown fresh file is never read from a stale offset.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { dayOf, rotateLedger, syncRollup } from './ledger'
import { modelMismatches } from './stats'
import { record, spentToday } from './budget'

const L = '/h/.lean-agent'
const NOON = Date.UTC(2026, 10, 18, 12)
const row = (ts: number, o: Record<string, unknown> = {}) => JSON.stringify({ ts, role: 'thread', tN: 't1', model: 'claude-sonnet-5-5', in: 1000, usd: 1, ...o }) + '\n'
const old = (iso: string) => JSON.stringify({ id: 'r1', ts: iso, project: 'p', model: 'sonnet', usage: { input_tokens: 1 }, cost_usd: 0.5 }) + '\n'
const setup = () => {
  const h = fakeHost(null)
  h.clock.t = NOON
  return h
}
const total = (ro: any) => Math.round(Object.values<any>(ro.days).reduce((s, d) => s + d.t[0], 0) * 1e6) / 1e6

test('a rotation whose rollup write was lost: the renamed file is found by its start and not folded again', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, old('2026-11-10T08:00:00') + row(NOON, { usd: 2 }))
  const before = await syncRollup(h.host)
  expect(total(before)).toBe(2.5)
  // the crash: the file was renamed, the rollup still says "ledger.jsonl at offset X"
  h.files.set(`${L}/ledger-legacy.jsonl`, h.files.get(`${L}/ledger.jsonl`)!)
  h.files.delete(`${L}/ledger.jsonl`)
  const a = await syncRollup(h.host)
  expect(total(a)).toBe(2.5)
  expect(a.rows).toBe(2)
  expect(Object.keys(a.files)).toEqual(['ledger-legacy.jsonl'])
  // and the fresh ledger.jsonl that grows past the old offset is read from its start, not from the stale offset
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 4 }) + row(NOON, { usd: 8 }) + row(NOON, { usd: 16 }))
  const b = await syncRollup(h.host)
  expect(total(b)).toBe(2.5 + 28)
  expect(b.rows).toBe(5)
})

test('a fresh ledger.jsonl that outgrew the old offset (rotation lost, no rename seen) rebuilds from the files instead of reading mid-line', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 1 }))
  await syncRollup(h.host)
  // someone moved the file away and a new one grew longer than the folded offset
  h.files.set(`${L}/ledger-2026-10.jsonl`, row(NOON - 40 * 86_400_000, { usd: 1 }))
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 3 }) + row(NOON, { usd: 5 }) + row(NOON, { usd: 7 }))
  const ro = await syncRollup(h.host)
  expect(total(ro)).toBe(1 + 3 + 5 + 7)
  expect(ro.bad).toBe(0)
})

test('a sync between the rename and the rollup write counts the moved file once (the rename is recognised)', async () => {
  const h = setup()
  const mixed = old('2026-11-10T08:00:00') + row(NOON, { usd: 2 })
  h.files.set(`${L}/ledger.jsonl`, mixed)
  await syncRollup(h.host)
  // what another session sees mid-rotation: the old name gone, the new one there, the rollup not yet rewritten
  h.files.set(`${L}/ledger-legacy.jsonl`, mixed)
  h.files.delete(`${L}/ledger.jsonl`)
  expect(total(await syncRollup(h.host))).toBe(2.5)
  expect((await syncRollup(h.host)).rows).toBe(2)
})

test('the cap cache is dropped by a rotation: a regrown ledger.jsonl is never read from the old file\'s offset', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, old('2026-11-10T08:00:00') + row(NOON, { role: 'desk', usd: 2 }))
  expect(await spentToday(h.host, 'desk')).toBe(2) // the cache now holds an offset into the mixed file
  expect((await rotateLedger(h.host)).length).toBe(1)
  // the fresh file outgrows that offset before this session's next request
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON, { role: 'desk', usd: 2 })) // the 1.0 row stayed in ledger.jsonl (the split)
  h.files.set(`${L}/ledger.jsonl`, h.files.get(`${L}/ledger.jsonl`)! + row(NOON, { role: 'desk', usd: 3 }) + row(NOON, { role: 'desk', usd: 4 }) + row(NOON, { role: 'desk', usd: 5 }) + row(NOON, { role: 'desk', usd: 6 }))
  expect(await spentToday(h.host, 'desk')).toBe(2 + 3 + 4 + 5 + 6)
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host, 'desk')).toBe(2 + 3 + 4 + 5 + 6 + 3)
})

test('a role-less 1.0 row is uncapped on both cache paths', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, JSON.stringify({ ts: NOON, model: 'm', usd: 9 }) + '\n' + row(NOON, { role: 'desk', usd: 1 }))
  expect(await spentToday(h.host, 'desk')).toBe(1) // rebuilt from the rollup
  expect(await spentToday(h.host)).toBe(1)
  h.files.set(`${L}/ledger.jsonl`, h.files.get(`${L}/ledger.jsonl`)! + JSON.stringify({ ts: NOON, model: 'm', usd: 9 }) + '\n') // appended by someone else
  expect(await spentToday(h.host)).toBe(1) // topped up from the tail
})

test('a worker on another model is no mismatch; the session\'s own requests are compared', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`,
    row(NOON, { role: 'desk', model: 'claude-opus-5-5', usd: 1 }) + // the desk pin is opus by default
    row(NOON, { role: 'desk', model: 'claude-haiku-5-5', agent: 'lean-agent:worker-haiku', usd: 0.4 }) +
    row(NOON, { role: 'thread', model: 'claude-opus-5-5', agent: 'lean-agent:worker-opus', usd: 3 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  expect(await modelMismatches(h.host)).toEqual([])
  h.files.set(`${L}/ledger.jsonl`, h.files.get(`${L}/ledger.jsonl`)! + row(NOON, { role: 'desk', model: 'claude-sonnet-5-5', usd: 5 }))
  expect((await modelMismatches(h.host)).length).toBe(1)
  expect(dayOf(NOON)).toBe('2026-11-18')
})
