// lean-agent's own tool schemas are on EVERY request of a session (field: 7.8k tokens in a thread). This spec registers a thread session and a
// desk session through the engine, prints the size of every non-deferred tool (name + description + input schema, chars / 4) and pins the
// total per role so it cannot grow back: thread <= 4.5k tokens, desk <= 6k.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'

export const BUDGET = { thread: 4500, desk: 6000 } // tokens, chars / 4 (including the name)
// what 1.0.25 registered for a thread by the same count (20.8k chars of lean_review 7.3k, lean_script 4.4k, lean_rules 3.2k, lean_report 2.6k, lean_run
// 1.3k, lean_worktree 0.8k, lean_compare 0.6k, three small ones 0.6k): 1.0.26 cuts it by at least 40%
export const WAS_THREAD = 5200

type Spec = { name: string; description?: string; inputSchema?: unknown; isDeferred?: boolean }
const size = (s: Spec): number => JSON.stringify({ name: s.name, description: s.description ?? '', input_schema: s.inputSchema ?? {} }).length

async function register($: any, on: any, cwd: string, files: Record<string, string> = {}): Promise<Spec[]> {
  resetLocks()
  const h = fakeHost(on)
  const specs: Spec[] = []
  for (const [k, v] of Object.entries(files)) h.files.set(k, v)
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', (() => ({ value: { cancel() {} } })) as any)
  on('tool.register', (_: any, e: any) => { specs.push(e); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return specs
}
const report = (role: string, specs: Spec[]) => {
  const rows = specs.filter(s => !s.isDeferred).map(s => [s.name, size(s)] as const).sort((a, b) => b[1] - a[1])
  const total = rows.reduce((n, [, c]) => n + c, 0)
  ;(globalThis as any).console?.log(`tool schemas, ${role}: ${Math.round(total / 4)} tokens (${total} chars) in ${rows.length} tools: ${rows.map(([n, c]) => `${n} ${Math.round(c / 4)}`).join(', ')}; deferred: ${specs.filter(s => s.isDeferred).map(s => s.name).join(', ') || 'none'}`)
  return total / 4
}

test('a thread session registers at most 4.5k tokens of lean-agent tool schemas', { timeoutMs: 20_000 }, async ($, on) => {
  const specs = await register($, on, '/h/.lean-agent/threads/t1', { '/h/.lean-agent/threads/t1/thread.json': JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }) })
  const names = specs.map(s => s.name)
  for (const n of ['lean_report', 'lean_ask', 'lean_review', 'lean_run', 'lean_script']) expect(names).toContain(n)
  for (const n of ['lean_thread', 'lean_doctor']) expect(names).not.toContain(n) // the desk's
  for (const n of ['lean_rules', 'lean_compare', 'lean_worktree', 'lean_profile']) expect([n, specs.find(s => s.name === n)?.isDeferred]).toEqual([n, true]) // one kind of run each: behind ToolSearch
  const tokens = report('thread', specs)
  expect(tokens).toBeLessThanOrEqual(BUDGET.thread)
  expect(tokens).toBeLessThanOrEqual(WAS_THREAD * 0.6) // at least 40% less than 1.0.25
})

test('the desk registers at most 6k tokens of lean-agent tool schemas', { timeoutMs: 20_000 }, async ($, on) => {
  const specs = await register($, on, '/h/lean-agent-desk')
  const names = specs.map(s => s.name)
  for (const n of ['lean_thread', 'lean_doctor', 'lean_script']) expect(names).toContain(n)
  for (const n of ['lean_report', 'lean_review', 'lean_run']) expect(names).not.toContain(n) // a thread's
  expect(report('desk', specs)).toBeLessThanOrEqual(BUDGET.desk)
})
