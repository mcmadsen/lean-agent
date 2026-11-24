// The review cost before fan-out and its cap (reviewspend.ts, reviewcost.ts fanOutText): a sonnet-heavy day's ledger, the stated default, the two thresholds and confirm.
// Synthetic names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { expectedReviewCost, fanOutText } from './reviewcost'
import { spendStop } from './reviewspend'

const L = '/h/.lean-agent'
const row = (o: Record<string, unknown>) => JSON.stringify({ ts: 1, role: 'thread', tN: 't1', agent: 'lean-agent:reviewer', model: 'sonnet', usd: 0.5, ...o })

test('the fan-out line: areas x passes ~ $ from the ledger (median of the earlier passes), or the stated default', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'shop' }))
  const none = await expectedReviewCost(h.host, 'shop', 1)
  expect(fanOutText(none, 3)).toBe('3 areas x 1 pass ~ $4.50 (default $1.50 a pass: no earlier review run in your ledger)')
  // five passes of a sonnet-heavy day: 3.97 3.40 3.40 3.40 4.25 -> median 3.40
  h.files.set(`${L}/ledger.jsonl`, [['a1', 3.97], ['a2', 3.4], ['a3', 3.4], ['a4', 3.4], ['a5', 4.25]].map(([agentId, usd]) => row({ agentId, usd })).join('\n') + '\n')
  const some = await expectedReviewCost(h.host, 'shop', 2)
  expect(fanOutText(some, 4)).toBe('4 areas x 2 passes ~ $27.20 (from your last 5 review runs)')
  expect(fanOutText({ ...some, samples: 1, passes: 1, usd: 1 }, 1)).toBe('1 area x 1 pass ~ $1.00 (from your last 1 review run)')
})

test('above review.askAboveUsd (5) it does not start and the thread is told to lean_ask; confirm goes on', async () => {
  const h = fakeHost(null)
  expect(await spendStop(h.host, 'shop', 4.99, 'x', false)).toBeNull()
  const t = (await spendStop(h.host, 'shop', 6.8, '2 areas x 1 pass ~ $6.80 (from your last 5 review runs)', false))!
  expect(t).toContain('NOT started')
  expect(t).toContain('above review.askAboveUsd $5')
  expect(t).toContain('lean_ask')
  expect(t).toContain('confirm: true')
  expect(await spendStop(h.host, 'shop', 6.8, 'x', true)).toBeNull()
})

test('above review.maxUsd (25) it refuses outright unless confirm; both keys move; 0 turns a key off', async () => {
  const h = fakeHost(null)
  const big = (await spendStop(h.host, 'shop', 31, '9 areas x 1 pass ~ $31.00 (from your last 4 review runs)', false))!
  expect(big).toContain('above review.maxUsd $25')
  expect(big).toContain('level "light"')
  expect(await spendStop(h.host, 'shop', 31, 'x', true)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ review: { askAboveUsd: 10, maxUsd: 40 } }))
  expect(await spendStop(h.host, 'shop', 9, 'x', false)).toBeNull()
  expect(await spendStop(h.host, 'shop', 12, 'x', false)).toContain('review.askAboveUsd $10')
  expect(await spendStop(h.host, 'shop', 45, 'x', false)).toContain('review.maxUsd $40')
  h.files.set(`${L}/config.json`, JSON.stringify({ 'review.askAboveUsd': 0, 'review.maxUsd': 0 }))
  expect(await spendStop(h.host, 'shop', 500, 'x', false)).toBeNull()
})
