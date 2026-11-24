import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { ANSWER_CHARS, answerCharsOf, answerLength, answersReset, longAnswerLines, noteAgentCall, scratchPath, startAgent, stopAnswer } from './answers'

const DIR = '/h/.lean-agent/threads/t1'
const READER = 'lean-agent:reader-haiku'
const long = (n: number) => 'x'.repeat(n)

test('the file of a subagent: <thread folder>/scratch/<job>-<short id>.md, the job from the Agent call, paired by type', () => {
  answersReset()
  noteAgentCall(DIR, READER, 'lookup')
  noteAgentCall(DIR, 'lean-agent:reviewer', null)
  noteAgentCall(DIR, 'other:thing', 'lookup') // not a lean-agent subagent: ignored
  const line = startAgent(DIR, 'agent-ABC123xyz', READER)!
  expect(line).toContain(`${DIR}/scratch/lookup-123xyz.md`)
  expect(line).toContain('at most 5 lines')
  expect(startAgent(DIR, 'rv0001', 'lean-agent:reviewer')).toContain(`${DIR}/scratch/review-rv0001.md`)
  expect(startAgent(DIR, 'zz', 'other:thing')).toBeNull()
  expect(startAgent(DIR, 'q9q9q9', 'lean-agent:worker-haiku')).toContain(`${DIR}/scratch/worker-haiku-q9q9q9.md`) // no call seen: the type names it
  expect(scratchPath(DIR, 'lookup', 'A-b_c')).toBe(`${DIR}/scratch/lookup-abc.md`)
})

test('the stop event: a long answer is sent back ONCE with its size and path; the second long answer is let through and counted', () => {
  answersReset()
  noteAgentCall(DIR, READER, 'lookup')
  startAgent(DIR, 'w1aaaa', READER)
  const path = `${DIR}/scratch/lookup-w1aaaa.md`
  expect(stopAnswer(DIR, 'w1aaaa', READER, long(1200), 1200)).toBeNull() // at the limit: fine
  const first = stopAnswer(DIR, 'w1aaaa', READER, long(1500), 1200)
  expect(first?.block).toBe(`your answer is 1500 characters: write the full findings to ${path} and answer again with the path and at most 5 lines`)
  expect(stopAnswer(DIR, 'w1aaaa', READER, long(1600), 1200)).toEqual({ tooLong: { chars: 1600, path } })
  expect(stopAnswer(DIR, 'w1aaaa', READER, long(10), 1200)).toBeNull() // the short answer after the request
  expect(stopAnswer(DIR, 'w2bbbb', READER, long(1500), 1200)?.block).toContain('1500 characters') // another subagent: asked once itself
  expect(stopAnswer(DIR, 'w3cccc', 'other:thing', long(5000), 1200)).toBeNull() // not ours
})

test('the machine lines (LEAN-FEEDBACK, LEAN-AUDIT) are not counted; workers.answerChars changes the limit', () => {
  const feedback = 'LEAN-FEEDBACK ' + long(800)
  expect(answerLength(`${DIR}/scratch/a.md\nok\n${feedback}`)).toBe(`${DIR}/scratch/a.md\nok`.length)
  expect(answerCharsOf({})).toBe(ANSWER_CHARS)
  expect(answerCharsOf({ workers: { answerChars: 500 } })).toBe(500)
  expect(answerCharsOf({ 'workers.answerChars': 3000 })).toBe(3000)
  expect(answerCharsOf({ workers: { answerChars: 5 } })).toBe(ANSWER_CHARS)
})

// ---- through the engine ---------------------------------------------------------------------------------------------------------------
async function session($: any, on: any) {
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStart', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('tool.call', () => ({ result: 'ok' }) as any)
  resetLocks()
  answersReset()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true } as any)
  return h
}
const rows = (h: any) => (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

test('through the engine: SubagentStart names the file (the call input is not changed); SubagentStop blocks the first long answer and records the second', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on)
  await $.tool.call({ tool: 'Agent', subagent_type: READER, prompt: 'job: lookup\nwhere is x', toolUseId: 'u1' } as any)
  const s: any = await $.classic.SubagentStart({ agent_id: 'agentw1', agent_type: READER } as any)
  expect((s.additionalContext ?? []).join('\n')).toContain(`${DIR}/scratch/lookup-gentw1.md`)
  const stop = { agent_id: 'agentw1', agent_type: READER, stop_hook_active: false, last_assistant_message: long(2000) } as any
  const a: any = await $.classic.SubagentStop(stop)
  expect(a.block).toContain('your answer is 2000 characters')
  expect(rows(h).filter((r: any) => r.rule === 'answer-too-long')).toEqual([])
  const b: any = await $.classic.SubagentStop({ ...stop, stop_hook_active: true })
  expect(b.block).toBeUndefined()
  expect(rows(h).filter((r: any) => r.rule === 'answer-too-long')).toEqual([]) // let through: NOT a refusal row (the export lists those)
  const counted = (h.files.get('/h/.lean-agent/counters.jsonl') ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
  expect(counted.length).toBe(1)
  expect(counted[0]).toMatchObject({ rule: 'answer-too-long', agent: 'reader-haiku', chars: 2000, thread: 't1' })
  expect((await longAnswerLines(h.host, h.clock.t + 1000, 7))[0]).toContain('long answers let through after one reminder (7d): 1 (reader-haiku 1); longest 2000 characters')
  expect(await longAnswerLines(h.host, h.clock.t + 8 * 86_400_000, 7)).toEqual([])
  const c: any = await $.classic.SubagentStop({ ...stop, agent_id: 'agentw2', last_assistant_message: 'path\nok' })
  expect(c.block).toBeUndefined()
})
