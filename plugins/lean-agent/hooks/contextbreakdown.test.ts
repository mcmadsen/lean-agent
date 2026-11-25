// What fills a thread's context, in one line (contextstat.ts threadBreakdown / breakdownText, 1.0.27): from a synthetic transcript.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { breakdownText, contextReport, largestFix, sessionBreakdown, threadBreakdown } from './contextstat'

const L = '/h/.lean-agent'
const FILE = '/h/.claude/projects/p/s1.jsonl'
let n = 0
const use = (name: string, input: unknown) => {
  const id = `u${++n}`
  return { id, rec: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } }
}
const res = (id: string, chars: number) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] } })
const pair = (name: string, input: unknown, chars: number) => {
  const u = use(name, input)
  return [u.rec, res(u.id, chars)]
}
const transcript = () => [
  { type: 'user', message: { role: 'user', content: 'F'.repeat(84_000) } }, // the restart prompt: 21k
  ...pair('Bash', { command: 'git diff' }, 24_400),
  ...pair('Bash', { command: 'ls' }, 47_600), // Bash: 18k together
  ...pair('mcp__lean-agent__lean_run', { command: 'yarn test' }, 48_000), // lean_run 12k
  ...pair('Read', { file_path: '/x' }, 36_000), // Read 9k
  ...pair('Agent', { subagent_type: 'worker-sonnet', prompt: 'B'.repeat(36_000) }, 28_000), // briefs 9k, worker answers 7k
  { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'side', name: 'Read', input: { p: 'S'.repeat(40_000) } }] } },
]

test('threadBreakdown: results by tool, own tool inputs with the Agent briefs, worker answers, first prompt, the biggest results (kinds only)', () => {
  const b = threadBreakdown(transcript())
  expect(b.results.Bash).toBe(18_000)
  expect(b.results.lean_run).toBe(12_000)
  expect(b.results.Read).toBe(9_000)
  expect(b.resultsTotal).toBe(39_000)
  expect(b.workers).toBe(7_000)
  expect(b.first).toBe(21_000)
  expect(b.briefs).toBe(9_000)
  expect(b.inputsTotal).toBeGreaterThan(9_000)
  expect(b.inputsTotal).toBeLessThan(10_000) // (the sidechain's input is not the thread's)
  expect(b.top.map(t => t.kind)).toEqual(['lean_run', 'Bash'])
})

test('breakdownText: the one line, sizes by kind, never a result text; ONE fix for the largest source', () => {
  const t = breakdownText(98_000, 120_000, threadBreakdown(transcript()))
  expect(t).toContain('ctx 98k of 120k: tool results 39k (Bash 18k, lean_run 12k, Read 9k), your own tool inputs')
  expect(t).toContain('(Agent briefs 9k)')
  expect(t).toContain('worker answers 7k, first prompt 21k')
  expect(t).toContain('biggest single results: lean_run 12k, Bash 11.9k (never their text)')
  expect(t).toContain('fix for the largest (first prompt):')
  expect(t).not.toContain('xxxx')
  expect(t).not.toContain('\n')
  expect(breakdownText(1, 120_000, threadBreakdown([]))).toBe('')
})

test('the one fix by the largest source: Bash / Read, lean_run, briefs, workers', () => {
  const base = threadBreakdown([])
  expect(largestFix({ ...base, results: { Bash: 9000 }, resultsTotal: 9000 })).toContain('--stat / a path / offset+limit, or have a reader summarise to scratch')
  expect(largestFix({ ...base, results: { Read: 9000 }, resultsTotal: 9000 })).toContain('offset+limit')
  expect(largestFix({ ...base, results: { lean_run: 9000 }, resultsTotal: 9000 })).toContain('run targeted tests')
  expect(largestFix({ ...base, briefs: 9000 })).toContain('point at a notes file instead of restating it')
  expect(largestFix({ ...base, workers: 9000 })).toContain('job schema')
  expect(largestFix(base)).toBe('')
})

test('sessionBreakdown reads the session transcript; lean_doctor context tN carries the same line; no transcript = nothing', async () => {
  const h = fakeHost(null)
  h.exec.handler = () => ({ exitCode: 0, stdout: `${FILE}\n` })
  h.files.set(FILE, transcript().map(r => JSON.stringify(r)).join('\n') + '\n')
  const t = await sessionBreakdown(h.host, '/h', 's1', 98_000, 120_000)
  expect(t).toContain('ctx 98k of 120k: tool results 39k')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'p', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/threads/t1/context.json`, JSON.stringify({ tokens: 98_000, at: 1, sid: 's1' }))
  const rep = await contextReport(h.host, '/h', 't1')
  expect(rep).toContain('ctx 98k of 200k: tool results 39k') // (the default limit, 1.0.35)
  expect(rep).toContain('top sources:')
  h.exec.handler = () => ({ exitCode: 1, stdout: '' })
  expect(await sessionBreakdown(h.host, '/h', 's1', 98_000, 120_000)).toBe('')
})
