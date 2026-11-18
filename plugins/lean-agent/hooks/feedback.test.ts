import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { applyFeedback, parseFeedback } from './feedback'
import { recordLearn } from './rules'

const line = (o: unknown) => `done.\nLEAN-FEEDBACK ${JSON.stringify(o)}`

test('parses the last LEAN-FEEDBACK line, with or without backticks', () => {
  const fb = parseFeedback(line({ status: 'done', missing: '', remember: ['a fact', { type: 'feedback', text: 'b' }, 7] }))
  expect(fb?.status).toBe('done')
  expect(fb?.remember.map(r => r.text)).toEqual(['a fact', 'b'])
  expect(parseFeedback('x\n`LEAN-FEEDBACK {"status":"failed","missing":"m"}`')?.missing).toBe('m')
  const two = 'LEAN-FEEDBACK {"status":"failed"}\nmore\nLEAN-FEEDBACK {"status":"done"}'
  expect(parseFeedback(two)?.status).toBe('done')
})

test('no line, broken JSON or a non-object parse to null; an unknown status becomes partial', () => {
  expect(parseFeedback('nothing here')).toBeNull()
  expect(parseFeedback('LEAN-FEEDBACK {not json}')).toBeNull()
  expect(parseFeedback('LEAN-FEEDBACK [1]')).toBeNull()
  expect(parseFeedback('LEAN-FEEDBACK {"status":"great"}')?.status).toBe('partial')
})

test('missing paths go to gaps.jsonl, three for one area mark it stale; remember goes to memory', async () => {
  const h = fakeHost(null)
  await recordLearn(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', lines: 9 })
  const ctx = { thread: 't1', project: 'proj', agent: 'worker-haiku' }
  for (let n = 0; n < 3; n++) {
    const fb = parseFeedback(line({ status: 'partial', missing: `had to find services/billing/db${n}.ts`, remember: n === 0 ? ['money is cents'] : [] }))!
    await applyFeedback(h.host, ctx, fb)
  }
  const gaps = (h.files.get('/h/.lean-agent/proj/gaps.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(gaps.length).toBe(3)
  expect(gaps[0].area).toBe('billing')
  expect(JSON.parse(h.files.get('/h/.lean-agent/proj/learn.json')!).areas.billing.stale).toContain('3 gaps')
  expect(h.files.get('/h/.lean-agent/memory/notes.jsonl')).toContain('money is cents')
  expect(h.files.get('/h/.lean-agent/feedback.jsonl')).toContain('worker-haiku')
})

test('without a known project the gap goes to the global gaps.jsonl', async () => {
  const h = fakeHost(null)
  await applyFeedback(h.host, { thread: 't2' }, parseFeedback(line({ status: 'done', missing: 'no docs for src/x/y.ts' }))!)
  expect(h.files.get('/h/.lean-agent/gaps.jsonl')).toContain('src/x/y.ts')
})
