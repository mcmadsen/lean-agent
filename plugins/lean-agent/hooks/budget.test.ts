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

test('the daily sum is cached in the store: new rows are added, the ledger is re-read only when the day changes', async () => {
  const h = fakeHost(null)
  const reads = () => h.files.get('/h/.lean-agent/ledger.jsonl') !== undefined
  let n = 0
  const read = h.host.fs.read
  h.host.fs.read = async (p: string) => { if (p.endsWith('ledger.jsonl')) n++; return read(p) }
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(reads()).toBe(true)
  expect(await spentToday(h.host, 'desk')).toBe(3) // first call: builds the cache (one read)
  const first = n
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host, 'desk')).toBe(6)
  expect(await spentToday(h.host)).toBe(6)
  expect(n).toBe(first) // no re-read after new rows
  h.clock.t += 86_400_000 // next day: rebuilt from the ledger
  expect(await spentToday(h.host, 'desk')).toBe(0)
  expect(n).toBe(first + 1)
})

test('the daily cache loses no row when another writer appended behind its back', async () => {
  const h = fakeHost(null)
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host)).toBe(3)
  // a parallel session appends (its cache update never reaches this store)
  const f = '/h/.lean-agent/ledger.jsonl'
  h.files.set(f, h.files.get(f)! + JSON.stringify({ ts: 10, role: 'thread', model: 'haiku', in: 0, out: 0, cache_read: 0, cache_write: 0, usd: 2 }) + '\n')
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host)).toBe(8)
  expect(await spentToday(h.host, 'thread')).toBe(2)
})

test('workerCaps accept the bare and the prefixed key for either spelling of the type', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ workerCaps: { 'worker-opus': 5, 'lean-agent:worker-sonnet': 3 } }))
  expect(await overBudget(h.host, 'thread', { type: 'lean-agent:worker-opus', spent: 5 })).toContain('$5.00 budget')
  expect(await overBudget(h.host, 'thread', { type: 'worker-opus', spent: 5 })).toContain('$5.00 budget')
  expect(await overBudget(h.host, 'thread', { type: 'lean-agent:worker-sonnet', spent: 3 })).toContain('$3.00 budget')
  expect(await overBudget(h.host, 'thread', { type: 'worker-sonnet', spent: 3 })).toContain('$3.00 budget')
  expect(await overBudget(h.host, 'thread', { type: 'lean-agent:worker-sonnet', spent: 2 })).toBeNull()
})

test('stats merge both spellings of an agent type into one line', () => {
  const r = (o: any) => ({ ts: 10, role: 'thread', model: 'haiku', in: 0, out: 0, usd: 1, ...o })
  expect(summarize([r({ agent: 'lean-agent:worker-haiku' }), r({ agent: 'worker-haiku' })], 0).byAgent).toEqual({ 'worker-haiku': 2 })
})
