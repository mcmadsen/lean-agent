import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { threadTool } from './delivery'
import { requestSentence, PROSE_REPLY } from './proserequest'
import { readWaiting } from './threadstate'

const HOME = '/h/.lean-agent'

test('prose requests are found, ordinary and negated sentences are not', () => {
  expect(requestSentence('Recorded the review. One batch of PR comments for approval; nothing is posted until you approve.')).toBe('One batch of PR comments for approval')
  expect(requestSentence('Two comments are ready. OK to post them?')).toBe('OK to post them?')
  expect(requestSentence('Found a conflict in module-a. Should I rebase or merge?')).toBe('Should I rebase or merge?')
  expect(requestSentence('Waiting for your answer on the schema.')).toContain('Waiting for your answer')
  expect(requestSentence('Please confirm the branch name.')).toContain('Please confirm')
  expect(requestSentence('Tell me whether to keep the old column.')).toContain('Tell me whether')
  // not requests
  expect(requestSentence('The comments were approved earlier; posted 4 of them.')).toBeNull()
  expect(requestSentence('No approval needed for this read-only pass.')).toBeNull()
  expect(requestSentence('You approved the plan, so I went on.')).toBeNull()
  expect(requestSentence('Ran 40 specs, all green. Next: the docs.')).toBeNull()
  expect(requestSentence('x'.repeat(300) + ' for approval')?.length).toBeLessThanOrEqual(200)
})

test('a working report with a request in its prose makes a desk question and a waiting record', async () => {
  const h = fakeHost(null)
  const sent: string[] = []
  const r = await threadTool(h.host, 't1', 'lean_report', { text: 'Review recorded. One batch of PR comments for approval; nothing is posted until you approve.', state: 'working' }, async (_s, t) => void sent.push(t))
  expect(r.ok).toBe(true)
  expect(r.text).toContain(PROSE_REPLY)
  const qs = await readJsonl<{ from: string; question: string; report: string; prose: boolean }>(h.host, `${HOME}/questions.jsonl`)
  expect(qs.length).toBe(1)
  expect(qs[0]!.question).toBe('t1 seems to wait for your answer: One batch of PR comments for approval')
  expect(qs[0]!.report).toMatch(/^\d+-t1-report$/)
  const inbox = await readJsonl<{ kind: string; text: string; report?: string }>(h.host, `${HOME}/desk/inbox.jsonl`)
  expect(inbox.map(x => x.kind)).toEqual(['report', 'ask']) // the report is delivered as usual, then the question item
  expect(inbox[1]!.report).toBe(qs[0]!.report)
  const w = await readWaiting(h.host, '/h', 't1')
  expect(w?.text).toContain('seems to wait for your answer')
  expect(sent.some(t => t.includes('asking'))).toBe(true) // the desk is told directly, like a lean_ask
})

test('no item for an action, a lean_ask already open, a done report, a negation or a blocked report', async () => {
  const h = fakeHost(null)
  const q = async () => (await readJsonl(h.host, `${HOME}/questions.jsonl`)).length
  const text = 'Comments for approval.'
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'Review recorded. No approval needed.', state: 'working' })).text).not.toContain(PROSE_REPLY)
  expect((await threadTool(h.host, 't1', 'lean_report', { text, state: 'done' })).text).not.toContain(PROSE_REPLY)
  expect((await threadTool(h.host, 't1', 'lean_report', { text, state: 'blocked' })).text).not.toContain(PROSE_REPLY)
  expect(await q()).toBe(0)
  await threadTool(h.host, 't2', 'lean_ask', { question: 'which db?' })
  expect((await threadTool(h.host, 't2', 'lean_report', { text, state: 'working' })).text).not.toContain(PROSE_REPLY) // it asked: nothing to add
  expect(await q()).toBe(1)
})
