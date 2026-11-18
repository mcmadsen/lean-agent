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

test('the feedback log names an agent without the plugin prefix', async () => {
  const h = fakeHost(null)
  await applyFeedback(h.host, { thread: 't1', project: 'proj', agent: 'lean-agent:worker-haiku' }, { status: 'done', missing: '', remember: [] } as any)
  expect(h.files.get('/h/.lean-agent/feedback.jsonl')).toContain('"agent":"worker-haiku"')
})

test('refused, unverified and unreached parse (strings or objects), are capped, and are filed with the running version', async () => {
  const fb = parseFeedback(line({ status: 'partial', refused: [{ command: 'rg -n x f', text: 'only git is allowed (lean-agent 1.0.3)' }, 'ls -la', 5, { text: 'no command' }], unverified: ['retries are 3', 7], unreached: ['services/old', 'tools'], remember: [] }))!
  expect(fb.refused).toEqual([{ command: 'rg -n x f', text: 'only git is allowed (lean-agent 1.0.3)' }, { command: 'ls -la', text: '' }])
  expect(fb.unverified).toEqual(['retries are 3'])
  expect(fb.unreached).toEqual(['services/old', 'tools'])
  const many = parseFeedback(line({ status: 'done', unreached: Array.from({ length: 50 }, (_, i) => `d${i}`) }))!
  expect(many.unreached.length).toBe(20)
  const none = parseFeedback(line({ status: 'done' }))!
  expect([none.refused, none.unverified, none.unreached]).toEqual([[], [], []])

  const h = fakeHost(null)
  await applyFeedback(h.host, { thread: 't1', project: 'proj', agent: 'lean-agent:explorer', version: '1.0.3' }, fb)
  const row = JSON.parse(h.files.get('/h/.lean-agent/feedback.jsonl')!.trim())
  expect(row).toMatchObject({ agent: 'explorer', version: '1.0.3', refused: 2, unverified: 1, unreached: 2, unreachedFolders: ['services/old', 'tools'] })
  const ref = h.files.get('/h/.lean-agent/refusals.jsonl')!.trim().split('\n').map(l => JSON.parse(l))
  expect(ref.map(r => r.command)).toEqual(['rg -n x f', 'ls -la'])
  expect(ref[0]).toMatchObject({ version: '1.0.3', agent: 'explorer', text: 'only git is allowed (lean-agent 1.0.3)' })
})
