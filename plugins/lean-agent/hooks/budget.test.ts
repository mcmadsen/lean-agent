import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { costUsd, overBudget, record, spentToday, summarize } from './budget'

const U = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }

test('prices by model family from the four token counts', () => {
  expect(costUsd('claude-haiku-5-5', U)).toBe(7.35)
  expect(costUsd('claude-sonnet-5-5', U)).toBe(22.05)
  expect(costUsd('claude-opus-5-5', U)).toBe(36.75)
  expect(costUsd('unknown-model', { input_tokens: 1_000_000 })).toBe(3)
  expect(costUsd('x', null)).toBe(0)
})

test('record appends a ledger row; spentToday sums only today, per role', async () => {
  const h = fakeHost(null)
  await record(h.host, { role: 'thread', tN: 't1', agentId: 'a1', agent: 'worker-haiku' }, 'haiku', { input_tokens: 1_000_000 })
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  h.clock.t += 2 * 86_400_000
  await record(h.host, { role: 'desk' }, 'sonnet', { output_tokens: 1_000_000 })
  expect(await record(h.host, { role: 'desk' }, 'sonnet', null)).toBeNull()
  expect(await spentToday(h.host)).toBe(15)
  expect(await spentToday(h.host, 'thread')).toBe(0)
  const rows = h.files.get('/h/.lean-agent/ledger.jsonl')!.trim().split('\n').map(l => JSON.parse(l))
  expect(rows[0]).toMatchObject({ role: 'thread', tN: 't1', agentId: 'a1', agent: 'worker-haiku', model: 'haiku', in: 1_000_000, usd: 1 })
})

test('cost-only caps: daily per role, per worker type, per-worker default; nothing set = no limit', async () => {
  const h = fakeHost(null)
  expect(await overBudget(h.host, 'desk', { spent: 999 })).toBeNull()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ dailyCapUsd: { desk: 1 }, workerCapUsd: 2, workerCaps: { 'worker-opus': 5 } }))
  expect(await overBudget(h.host, 'desk', null)).toBeNull()
  await record(h.host, { role: 'desk' }, 'haiku', { input_tokens: 1_000_000 })
  expect(await overBudget(h.host, 'desk', null)).toContain('daily $1.00')
  expect(await overBudget(h.host, 'thread', { type: 'worker-sonnet', spent: 1.5 })).toBeNull()
  expect(await overBudget(h.host, 'thread', { type: 'worker-sonnet', spent: 2 })).toContain('$2.00 budget')
  expect(await overBudget(h.host, 'thread', { type: 'worker-opus', spent: 4 })).toBeNull()
  expect(await overBudget(h.host, 'thread', { type: 'worker-opus', spent: 5 })).toContain('$5.00 budget')
})

test('summarize groups by model, agent and thread', () => {
  const r = (o: any) => ({ ts: 10, role: 'thread', model: 'haiku', in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 1, ...o })
  const s = summarize([r({ tN: 't1' }), r({ tN: 't1', agent: 'worker-haiku' }), r({ role: 'desk', model: 'sonnet', usd: 2 }), r({ ts: 1 })], 5)
  expect(s.total).toBe(4)
  expect(s.byModel).toEqual({ haiku: 2, sonnet: 2 })
  expect(s.byAgent).toEqual({ main: 3, 'worker-haiku': 1 })
  expect(s.byThread).toEqual({ t1: 2, desk: 2 })
})
