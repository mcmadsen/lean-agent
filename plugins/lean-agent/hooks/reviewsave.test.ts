import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { areaIn, blockFrom, saveReviewerBlock } from './reviewsave'
import { reviewBlock } from './scratchnotes'

const L = '/h/.lean-agent'
const ANSWER = 'Done.\n```json\n{"verdict":"changes-requested","goal":"g","findings":[{"n":1,"severity":"minor","category":"correctness","path":"src/a.ts","line":3,"text":"x","fix":"y"}],"reuse":[],"coverage":[]}\n```\n'

test('the reviewer\'s json block is found in its answer; an answer without one saves nothing', () => {
  expect(blockFrom(ANSWER)?.verdict).toBe('changes-requested')
  expect(blockFrom('{"verdict":"approve","findings":[]}')?.verdict).toBe('approve')
  expect(blockFrom('no block here')).toBeNull()
  expect(blockFrom('```json\n{"unrelated":1}\n```')).toBeNull()
  expect(areaIn('AREA REVIEW area-4 of 6 (12 changed files)')).toBe('area-4')
  expect(areaIn('LEAN-REVIEW-PREP {}')).toBe('full')
  expect(reviewBlock('review-area-4-2.json')).toBe(true)
  expect(reviewBlock('notes.md')).toBe(false)
})

test('the block is saved to scratch/review-<area>-<pass>.json of the thread, one file per pass', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  const p1 = await saveReviewerBlock(h.host, 't1', 'AREA REVIEW area-4 of 6', ANSWER)
  expect(p1).toBe(`${L}/threads/t1/scratch/review-area-4-1.json`)
  expect(JSON.parse(String(h.files.get(p1!))).verdict).toBe('changes-requested')
  const p2 = await saveReviewerBlock(h.host, 't1', 'AREA REVIEW area-4 of 6', ANSWER)
  expect(p2).toBe(`${L}/threads/t1/scratch/review-area-4-2.json`)
  expect(await saveReviewerBlock(h.host, 't1', 'the whole PR', ANSWER)).toBe(`${L}/threads/t1/scratch/review-full-1.json`)
  expect(await saveReviewerBlock(h.host, 't1', 'x', 'no block')).toBeNull()
  expect(await saveReviewerBlock(h.host, 'desk', 'x', ANSWER)).toBeNull()
})
