// The review size before fan-out and its caps in usage tokens (reviewspend.ts, reviewcost.ts fanOutText): a busy day's ledger, the stated default, the two thresholds and confirm.
// Synthetic names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { expectedReviewCost, expectedText, fanOutText, reviewCostLine, addPrepNote } from './reviewcost'
import { spendStop } from './reviewspend'

const L = '/h/.lean-agent'
const row = (o: Record<string, unknown>) => JSON.stringify({ ts: 1, role: 'thread', tN: 't1', agent: 'lean-agent:reviewer', model: 'sonnet', usd: 0.5, ...o })

test('the fan-out line: areas x passes x the median usage tokens of the earlier passes, or the stated default', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  const none = await expectedReviewCost(h.host, 'shop', 1)
  expect(none).toMatchObject({ tokens: 500_000, samples: 0 })
  expect(fanOutText(none, 3)).toBe('3 areas x 1 pass ~ 1.5M usage tokens (default 500k tokens a pass: no earlier review run in your ledger)')
  expect(expectedText(none, 'sonnet')).toBe('expected review usage ~500k tokens (1 pass, sonnet; default 500k tokens a pass, no earlier reviewer pass on this project in the ledger)')
  // five passes of a busy day: 400k 350k 350k 350k 500k -> median 350k
  h.files.set(`${L}/ledger.jsonl`, [['a1', 400_000], ['a2', 350_000], ['a3', 350_000], ['a4', 350_000], ['a5', 500_000]].map(([agentId, inp]) => row({ agentId, in: inp })).join('\n') + '\n')
  const some = await expectedReviewCost(h.host, 'shop', 2)
  expect(some).toMatchObject({ tokens: 700_000, passes: 2, samples: 5 })
  expect(fanOutText(some, 4)).toBe('4 areas x 2 passes ~ 2.8M usage tokens (from your last 5 review runs)')
  expect(fanOutText({ ...some, samples: 1, passes: 1, tokens: 1_000_000 }, 1)).toBe('1 area x 1 pass ~ 1M usage tokens (from your last 1 review run)')
})

test('a pass is counted in WEIGHTED usage tokens: output x 5, cache write x 1.25, cache read x 0.1; two requests of one agent are one pass; another project\'s passes are not counted', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', project: 'other' }))
  h.files.set(`${L}/ledger.jsonl`, [
    row({ agentId: 'a1', in: 100_000, out: 20_000 }), // 200k
    row({ agentId: 'a1', in: 0, cache_write: 80_000, cache_read: 100_000 }), // + 100k + 10k = 310k in all
    row({ agentId: 'b1', tN: 't2', in: 9_000_000 }), // another project
  ].join('\n') + '\n')
  const e = await expectedReviewCost(h.host, 'shop', 1)
  expect(e).toMatchObject({ tokens: 310_000, samples: 1 })
  h.files.set(`${L}/config.json`, JSON.stringify({ budget: { weights: { output: 1 } } })) // the factors move it
  expect((await expectedReviewCost(h.host, 'shop', 1)).tokens).toBe(100_000 + 20_000 + 100_000 + 10_000)
})

test('the line every prepare ends with: review usage for a sha, in tokens', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  await addPrepNote(h.host, 'shop', { ts: 0, sha: '3f9c2ab41d02e7', level: 'full' })
  h.files.set(`${L}/ledger.jsonl`, [row({ ts: 5, agentId: 'a1', in: 300_000 }), row({ ts: 6, agentId: 'a2', in: 110_000 })].join('\n') + '\n')
  expect(await reviewCostLine(h.host, 'shop', 't1', '3f9c2ab41d02e7')).toBe('review usage for 3f9c2ab41d02: 410k tokens over 2 passes, 2 requests')
})

test('above review.askAboveTokens (2M) it does not start and the thread is told to lean_ask; confirm goes on', async () => {
  const h = fakeHost(null)
  expect(await spendStop(h.host, 'shop', 1_999_000, 'x', false)).toBeNull()
  const t = (await spendStop(h.host, 'shop', 2_600_000, '2 areas x 1 pass ~ 2.6M usage tokens (from your last 5 review runs)', false))!
  expect(t).toContain('NOT started')
  expect(t).toContain('above review.askAboveTokens 2M')
  expect(t).toContain('lean_ask')
  expect(t).toContain('expected usage ~2.6M tokens')
  expect(t).toContain('confirm: true')
  expect(t).not.toContain('$')
  expect(await spendStop(h.host, 'shop', 2_600_000, 'x', true)).toBeNull()
})

test('above review.maxTokens (10M) it refuses outright unless confirm; both keys move; 0 turns a key off; the old USD keys are not read', async () => {
  const h = fakeHost(null)
  const big = (await spendStop(h.host, 'shop', 12_000_000, '9 areas x 1 pass ~ 12M usage tokens (from your last 4 review runs)', false))!
  expect(big).toContain('above review.maxTokens 10M')
  expect(big).toContain('level "light"')
  expect(await spendStop(h.host, 'shop', 12_000_000, 'x', true)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ review: { askAboveTokens: 4_000_000, maxTokens: 20_000_000 } }))
  expect(await spendStop(h.host, 'shop', 3_000_000, 'x', false)).toBeNull()
  expect(await spendStop(h.host, 'shop', 5_000_000, 'x', false)).toContain('review.askAboveTokens 4M')
  expect(await spendStop(h.host, 'shop', 25_000_000, 'x', false)).toContain('review.maxTokens 20M')
  h.files.set(`${L}/config.json`, JSON.stringify({ 'review.askAboveTokens': 0, 'review.maxTokens': 0 }))
  expect(await spendStop(h.host, 'shop', 500_000_000, 'x', false)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ review: { askAboveUsd: 0, maxUsd: 1 } })) // enforce nothing
  expect(await spendStop(h.host, 'shop', 12_000_000, 'x', false)).toContain('review.maxTokens 10M')
})
