// stats by the thread's model/effort, and "threads at the default" (the ledger rows carry effort and the thread's model since this version).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { normalizeRow, syncRollup } from './ledger'
import { statsText } from './stats'

const L = '/h/.lean-agent'
const NOW = Date.UTC(2026, 10, 18, 12)
const row = (tN: string, usd: number, o: Record<string, unknown> = {}) => JSON.stringify({ ts: NOW - 1000, role: 'thread', tN, agent: undefined, model: 'claude-sonnet-5-5', usd, ...o }) + '\n'

function setup(rows: string, cfg?: object) {
  const h = fakeHost(null)
  h.clock.t = NOW
  h.files.set(`${L}/ledger.jsonl`, rows)
  if (cfg) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  return h
}

test('a row\'s effort and the thread\'s own model are read; rows without them stay valid', () => {
  expect(normalizeRow({ ts: 1, role: 'thread', tN: 't1', model: 'm', usd: 1, effort: 'high', tmodel: 'sonnet' })).toMatchObject({ effort: 'high', tmodel: 'sonnet' })
  const old = normalizeRow({ ts: 1, role: 'thread', tN: 't1', model: 'm', usd: 1 })!
  expect(old.effort).toBeUndefined()
  expect(old.tmodel).toBeUndefined()
})

test('stats: threads by model/effort, the share from before effort was recorded, and the default\'s count, spend and median', async () => {
  const h = setup(
    row('t1', 1, { effort: 'high', tmodel: 'sonnet' }) +
      row('t1', 1, { effort: 'high', tmodel: 'sonnet', agent: 'lean-agent:worker-haiku', model: 'claude-haiku-5-5' }) + // a worker's row counts for its thread's choice
      row('t2', 3, { effort: 'high', tmodel: 'sonnet' }) +
      row('t3', 5, { effort: 'medium', tmodel: 'opus', model: 'claude-opus-5-5' }) +
      row('t4', 2) + // before effort was recorded
      row('t9' + '1763467200000' + '123', 7, { effort: 'high', tmodel: 'sonnet' }) + // compare's throw-away folder is no thread
      JSON.stringify({ ts: NOW - 500, role: 'desk', model: 'claude-sonnet-5-5', usd: 4, effort: 'high' }) + '\n', // the desk is not a thread
  )
  const t = await statsText(h.host, { days: 1 })
  expect(t).toContain('by thread model/effort (1d; the thread\'s own choice, rows since effort was recorded):')
  expect(t).toContain('sonnet/high · 2 thread(s)  $5.00')
  expect(t).toContain('opus/medium · 1 thread(s)  $5.00')
  expect(t).toContain('(+ $9.00 of thread spend from before model and effort were recorded: not split)') // t4's $2 and compare's $7: thread-role rows without a choice
  expect(t).toContain('threads at the default (sonnet/high): 2, $5.00, median $2.50')
  expect(t.slice(t.indexOf('by thread model/effort'))).not.toContain('t91763467200000123') // compare's throw-away folder never joins the split
})

test('stats: the default follows config.json; no recorded effort says so instead of a zero line', async () => {
  const h = setup(row('t1', 2, { effort: 'low', tmodel: 'haiku', model: 'claude-haiku-5-5' }), { threads: { model: 'haiku', effort: 'low' } })
  expect(await statsText(h.host, { days: 1 })).toContain('threads at the default (haiku/low): 1, $2.00, median $2.00')
  const none = setup(row('t1', 2))
  const t = await statsText(none.host, { days: 1 })
  expect(t).toContain('by thread model/effort (1d): none recorded yet')
  expect(t).not.toContain('threads at the default')
})

test('the rollup keeps the thread choices per day, and an old rollup without them still loads', async () => {
  const h = setup(row('t1', 1, { effort: 'high', tmodel: 'sonnet' }))
  const ro = await syncRollup(h.host, NOW)
  expect(ro.days['2026-11-18']!.tme).toEqual({ 't1|sonnet|high': [1, 0, 0, 0, 0, 1] })
  const stored = JSON.parse(h.files.get(`${L}/rollup.json`)!)
  for (const d of Object.values<any>(stored.days)) delete d.tme // a rollup folded by the previous version
  h.files.set(`${L}/rollup.json`, JSON.stringify(stored))
  expect(await statsText(h.host, { days: 1 })).toContain('by thread model/effort (1d): none recorded yet')
})
