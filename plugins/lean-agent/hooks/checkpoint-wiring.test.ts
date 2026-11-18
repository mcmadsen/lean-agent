// The checkpoint through the engine's hooks: usage at turn.step, the instruction in a tool result, the report, the turn end.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'

const T1 = '/h/.lean-agent/threads/t1'

async function thread($: any, on: any, usageTokens: number, o: { call?: (e: any) => any; submitted?: string[] } = {}) {
  const h = fakeHost(on)
  resetLocks()
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('clock.after', () => new Promise(() => {})) // a step's timeout never fires here
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', (_: any, e: any) => {
    o.submitted?.push(e.text)
    return e
  })
  on('turn.complete', () => ({ text: '' }) as any)
  on('turn.start', (_: any, e: any) => e)
  on('tool.call', (_: any, e: any) => (o.call ? o.call(e) : { result: 'ok' }) as any)
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'sonnet', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: usageTokens, cache_creation_input_tokens: 0 } } as any
  })
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  return h
}
const step = async ($: any, i = 0, agentId?: string) => {
  const st = $.turn.step({ turnId: 't', index: i, model: 'sonnet', messageCount: 1, ...(agentId ? { agentId } : {}) } as any)
  for (;;) {
    const n = await st.next()
    if (n.done) return n.value
  }
}
const context = (r: any) => (r?.context ?? []).join('\n')

test('over the threshold the next tool result of the main loop carries ONE instruction; a subagent\'s usage does not count', async ($, on) => {
  const h = await thread($, on, 150_000)
  const r0: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(context(r0)).toBe('') // no usage seen yet
  await step($)
  const r1: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(context(r1)).toContain("Context is over 100k: finish the current step, then call lean_report with state 'checkpoint'")
  const r2: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(context(r2)).not.toContain('Context is over')
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).phase).toBe('asked')
})

test('a subagent\'s big request is no main-loop context', async ($, on) => {
  const h = await thread($, on, 150_000)
  await step($, 0, 'agent-1')
  expect(context(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe('')
  expect(h.files.has(`${T1}/checkpoint.json`)).toBe(false)
})

test('below the threshold nothing is said', async ($, on) => {
  const h = await thread($, on, 20_000)
  await step($)
  expect(context(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe('')
  expect(h.files.has(`${T1}/checkpoint.json`)).toBe(false)
})

test('an Agent call returns its slot: the instruction comes with the Agent result, once the subagent is finished', async ($, on) => {
  const h = await thread($, on, 150_000, { call: () => ({ result: 'worker done' }) })
  await step($)
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet', prompt: 'do it' } as any)
  expect(context(r)).toContain('Context is over 100k') // the subagent is finished: this is the boundary
  expect(h.files.has(`${T1}/checkpoint.json`)).toBe(true)
})

test('the checkpoint report is noted, the turn end makes it ready for the desk; an unrelated turn end does nothing', async ($, on) => {
  const h = await thread($, on, 150_000)
  await $.turn.complete({ turnId: 't', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  expect(h.files.has(`${T1}/checkpoint.json`)).toBe(false)
  await step($)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any) // the instruction
  const rep: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_report', state: 'checkpoint', text: 'branch b, worktree /w, last commit abc1234, pushed no, done x, open y, next z' } as any)
  expect(JSON.stringify(rep)).toContain('checkpoint recorded')
  expect(h.files.get('/h/.lean-agent/desk/inbox.jsonl')).toContain('"state":"checkpoint"')
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).phase).toBe('reported')
  await $.turn.complete({ turnId: 't', answer: 'stopped', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  const rq = JSON.parse(h.files.get(`${T1}/checkpoint.json`)!)
  expect([rq.phase, rq.source]).toEqual(['ready', 'report'])
  expect(rq.tokens).toBeGreaterThanOrEqual(150_000)
})

test('a push returns its slot too, and a new turn after a ready checkpoint withdraws it', async ($, on) => {
  const h = await thread($, on, 150_000)
  await step($)
  const push: any = await $.tool.call({ tool: 'Bash', command: 'git -C /w push origin b' } as any)
  expect(context(push)).toContain('Context is over 100k') // the push is finished: this is the boundary
  await $.tool.call({ tool: 'mcp__lean-agent__lean_report', state: 'checkpoint', text: 'branch b, worktree /w, last commit abc1234, pushed yes, done x, open y, next z' } as any)
  await $.turn.complete({ turnId: 't', answer: 'stopped', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).phase).toBe('ready')
  await $.turn.start({ turnId: 't3', text: 'one more thing', isUserPrompt: true } as any)
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).phase).toBe('done')
})

test('a wake prompt over a large context carries the instruction once (a thread that ended its turn silently is asked at its next prompt)', async ($, on) => {
  await thread($, on, 150_000)
  await step($)
  const a: any = await $.prompt.submit({ text: 'next' } as any)
  expect(context(a)).toContain('Context is over 100k')
  const b: any = await $.prompt.submit({ text: 'again' } as any)
  expect(context(b)).not.toContain('Context is over')
})

test('a thread that ends its turn without reporting gets one reminder prompt submitted, then is ready from its reports', async ($, on) => {
  const submitted: string[] = []
  const h = await thread($, on, 150_000, { submitted })
  await step($)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any) // asked
  await $.turn.complete({ turnId: 't', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  expect(submitted.some(t => t.includes("state 'checkpoint'"))).toBe(true)
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).phase).toBe('asked')
  await $.turn.complete({ turnId: 't2', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  expect(JSON.parse(h.files.get(`${T1}/checkpoint.json`)!).source).toBe('fallback')
})
