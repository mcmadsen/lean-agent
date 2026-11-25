// A reviewer must deliver its report (1.0.35): the hand-back is never refused, maxTurns sits above the budget, the first long answer after the
// budget passes the length guard, and a reviewer that ends with no report is said so by script (reviewdelivery.ts).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { hasReport, noteReviewerEnd, notDeliveredLine, reviewDeliveryReset } from './reviewdelivery'
import { answersReset, noteAgentCall, startAgent, stopAnswer } from './answers'

const DIR = '/h/.lean-agent/threads/t1'
const REV = 'lean-agent:reviewer'

// (agents/reviewer.md maxTurns = REVIEWER_STEPS + 6 and its Budget line: skills-contract.mjs, run by skills-contract.test.sh)

test('the first long answer of a reviewer that used its budget is let through (counted), without the budget it is sent back once as before', () => {
  answersReset()
  noteAgentCall(DIR, REV, null)
  startAgent(DIR, 'rvaaaa', REV)
  const path = `${DIR}/scratch/review-rvaaaa.md`
  const block = '```json\n' + 'x'.repeat(3000) + '\n```'
  expect(stopAnswer(DIR, 'rvaaaa', REV, block, 1200, true)).toEqual({ tooLong: { chars: block.length, path } })
  startAgent(DIR, 'rvbbbb', REV)
  expect(stopAnswer(DIR, 'rvbbbb', REV, block, 1200, false)?.block).toContain('your answer is')
  expect(stopAnswer(DIR, 'rvbbbb', REV, block, 1200, false)?.tooLong).toBeDefined() // the second one: let through as always
  expect(stopAnswer(DIR, 'rvcccc', REV, 'short', 1200, true)).toBeNull() // a short answer says nothing
})

test('hasReport: a verdict line, a review json block or the review file path is a report; silence and the engine\'s limit text are not', () => {
  expect(hasReport(`${DIR}/scratch/review-ab12cd.md\nverdict: approve`)).toBe(true)
  expect(hasReport('```json\n{"verdict":"approve","findings":[]}\n```')).toBe(true)
  expect(hasReport(`${DIR}/scratch/review-ab12cd.md`)).toBe(true)
  expect(hasReport(`wrote ${DIR}/scratch/review-ab12cd.md`)).toBe(false) // a mention is not a report
  expect(hasReport('I could not write review-x.md: the redirect was refused')).toBe(false)
  expect(hasReport('')).toBe(false)
  expect(hasReport('agent hit its turn limit with no report')).toBe(false)
  expect(hasReport('{"unrelated": 1}')).toBe(false)
})

test('a reviewer that ended with no report: one synthesised line with the calls, the budget and its last words; a delivered report says nothing', () => {
  reviewDeliveryReset()
  noteReviewerEnd('t1', { calls: 17, budget: 16, hit: true, last: 'I will now check the callers of\nfoo()' })
  const line = notDeliveredLine('t1', '')!
  expect(line).toBe('review not delivered (synthesised): the reviewer ended with no report after 17 tool calls of 16, budget used; its last words: "I will now check the callers of foo()"; ask again with a smaller area, do not read this as "no findings"')
  expect(notDeliveredLine('t1', '')).toContain('budget unknown') // the record is read once
  noteReviewerEnd('t1', { calls: 9, budget: 16, hit: false, last: '' })
  expect(notDeliveredLine('t1', 'LEAN-FEEDBACK {"status":"failed"}')).toContain('after 9 tool calls of 16, budget not used')
  noteReviewerEnd('t1', { calls: 12, budget: 16, hit: false, last: '' })
  expect(notDeliveredLine('t1', `${DIR}/scratch/review-x1.md\nverdict: changes-requested\n1. major a.ts:3`)).toBeNull()
  expect(notDeliveredLine('t2', 'engine: hit turn limit')).toContain('budget unknown') // another thread: nothing recorded
})

// ---- through the engine ---------------------------------------------------------------------------------------------------------------
async function session($: any, on: any, result: unknown) {
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStart', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('tool.call', () => ({ result }) as any)
  resetLocks()
  answersReset()
  reviewDeliveryReset()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true } as any)
  return h
}

test('through the engine: a reviewer that used its budget and handed back nothing: the Agent result carries the synthesised line; a delivered report carries none', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, '')
  await $.tool.call({ tool: 'Agent', subagent_type: REV, prompt: 'review it', toolUseId: 'u1' } as any)
  await $.classic.SubagentStart({ agent_id: 'agentrv1', agent_type: REV } as any)
  for (let n = 1; n <= 17; n++) await $.tool.call({ tool: 'Bash', command: 'git -C /r/app diff main...abc', agentId: 'agentrv1', agentType: REV } as any)
  await $.classic.SubagentStop({ agent_id: 'agentrv1', agent_type: REV, stop_hook_active: false, last_assistant_message: '' } as any)
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: REV, prompt: 'review it', toolUseId: 'u1' } as any)
  expect((r.context ?? []).join('\n')).toContain('review not delivered (synthesised): the reviewer ended with no report after 17 tool calls of 16, budget used')
})

test('through the engine: a reviewer answer with a verdict line gets no synthesised line', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, `${DIR}/scratch/review-ab12cd.md\nverdict: approve`)
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: REV, prompt: 'review it', toolUseId: 'u2' } as any)
  expect((r.context ?? []).join('\n')).not.toContain('review not delivered')
})
