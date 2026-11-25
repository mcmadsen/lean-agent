import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { costUsd, record, summarize } from './budget'
import { dayOf, syncRollup } from './ledger'
import { allTimeUsage, rawOfAgg, usageTokens } from './usage'

const U = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }

test('prices by model family from the four token counts (the estimate behind the optional stats.showUsd line)', () => {
  expect(costUsd('claude-haiku-5-5', U)).toBe(7.35)
  expect(costUsd('claude-sonnet-5-5', U)).toBe(22.05)
  expect(costUsd('claude-opus-5-5', U)).toBe(36.75)
  expect(costUsd('unknown-model', { input_tokens: 1_000_000 })).toBe(3)
  expect(costUsd('x', null)).toBe(0)
})

test('record appends a ledger row with the four token counts (and the usd estimate); a null usage appends nothing; no store cache is kept', async () => {
  const h = fakeHost(null)
  await record(h.host, { role: 'thread', tN: 't1', agentId: 'a1', agent: 'worker-haiku' }, 'haiku', { input_tokens: 1_000_000 })
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  h.clock.t += 2 * 86_400_000
  await record(h.host, { role: 'desk' }, 'sonnet', { output_tokens: 1_000_000 })
  expect(await record(h.host, { role: 'desk' }, 'sonnet', null)).toBeNull()
  const rows = h.files.get('/h/.lean-agent/ledger.jsonl')!.trim().split('\n').map(l => JSON.parse(l))
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatchObject({ role: 'thread', tN: 't1', agentId: 'a1', agent: 'worker-haiku', model: 'haiku', in: 1_000_000, usd: 1 })
  expect(rows[1].tN).toBeUndefined() // the desk's row carries no thread id: it can never count for a thread
  expect(await h.host.store.get('ledger-today')).toBeUndefined() // the daily USD cache of 1.0.33 is gone
})

test('the rollup keeps the tokens per day: weighted = input + 1.25 cache write + 0.1 cache read + 5 output, the raw sums beside them', async () => {
  const h = fakeHost(null)
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 100 })
  const day = (await syncRollup(h.host)).days[dayOf(h.clock.t)]!
  expect(rawOfAgg(day.t)).toEqual({ input: 1000, cacheWrite: 1000, cacheRead: 10_000, output: 100 })
  expect(usageTokens(rawOfAgg(day.t))).toBe(1000 + 1250 + 1000 + 500)
  expect((await allTimeUsage(h.host)).total.tokens).toBe(3750)
})

test('summarize groups by model, agent and thread', () => {
  const r = (o: any) => ({ ts: 10, role: 'thread', model: 'haiku', in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 1, ...o })
  const s = summarize([r({ tN: 't1' }), r({ tN: 't1', agent: 'worker-haiku' }), r({ role: 'desk', model: 'sonnet', usd: 2 }), r({ ts: 1 })], 5)
  expect(s.total).toBe(4)
  expect(s.byModel).toEqual({ haiku: 2, sonnet: 2 })
  expect(s.byAgent).toEqual({ main: 3, 'worker-haiku': 1 })
  expect(s.byThread).toEqual({ t1: 2, desk: 2 })
})

test('stats merge both spellings of an agent type into one line', () => {
  const r = (o: any) => ({ ts: 10, role: 'thread', model: 'haiku', in: 0, out: 0, usd: 1, ...o })
  expect(summarize([r({ agent: 'lean-agent:worker-haiku' }), r({ agent: 'worker-haiku' })], 0).byAgent).toEqual({ 'worker-haiku': 2 })
})
