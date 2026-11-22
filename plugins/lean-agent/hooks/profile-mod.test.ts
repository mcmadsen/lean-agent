// The thread's own session (register.tsx): MCP servers outside the project profile are DEFERRED by tool.describe (never removed, lean-agent's
// own tools untouched), the usage counter counts what the thread calls, and each ledger row carries the thread's model and effort.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'

async function session($: any, on: any, hooks: () => void, o: { cwd?: string; loaded?: object | null; thread?: object } = {}) {
  const h = fakeHost(on)
  hooks() // hooks beneath the plugin must exist before the first $ call
  resetLocks()
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...(o.thread ?? {}) }))
  if (o.loaded !== null) h.files.set(`${L}/threads/t1/loaded.json`, JSON.stringify(o.loaded ?? { mcp: ['db'], plugins: null, needs: [] }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: o.cwd ?? `${L}/threads/t1`, surface: 'desktop', isInteractive: true } as any)
  return h
}
const describe = ($: any, tool: string) => $.tool.describe({ tool, description: 'd', provider: { plugin: 'x', tier: 'user' } } as any)

test('a thread defers the MCP servers outside its profile and leaves everything else alone', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, () => on('tool.describe', (_: any, e: any) => ({ description: e.description })))
  expect(((await describe($, 'mcp__sentry__issues')) as any).isDeferred).toBe(true) // outside: deferred, so ToolSearch still finds it
  expect(((await describe($, 'mcp__plugin_figma_figma__get')) as any).isDeferred).toBe(true)
  expect(((await describe($, 'mcp__sentry__issues')) as any).description).toBe('d') // the text is not touched
  expect(((await describe($, 'mcp__db__query')) as any).isDeferred).toBeUndefined() // in the profile: the engine's own placement stands
  expect(((await describe($, 'mcp__lean-agent__lean_report')) as any).isDeferred).toBeUndefined() // lean-agent's own tools never
  expect(((await describe($, 'Bash')) as any).isDeferred).toBeUndefined()
})

test('a needs entry that was added to the profile keeps its server in front; an empty allow-list defers every other server', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, () => on('tool.describe', (_: any, e: any) => ({ description: e.description })), { loaded: { mcp: ['azure-devops'], plugins: null, needs: ['azure-devops'] } })
  expect(((await describe($, 'mcp__azure-devops__list_prs')) as any).isDeferred).toBeUndefined()
  expect(((await describe($, 'mcp__db__query')) as any).isDeferred).toBe(true)
})

test('no loaded.json defers nothing', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, () => on('tool.describe', (_: any, e: any) => ({ description: e.description })), { loaded: null })
  expect(((await describe($, 'mcp__sentry__issues')) as any).isDeferred).toBeUndefined()
})

test('a loaded.json that holds nothing back (no profile) defers nothing', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, () => on('tool.describe', (_: any, e: any) => ({ description: e.description })), { loaded: { mcp: null, plugins: null, needs: [] } })
  expect(((await describe($, 'mcp__sentry__issues')) as any).isDeferred).toBeUndefined()
})

test('the desk is not a thread: nothing is deferred there', { timeoutMs: 20_000 }, async ($, on) => {
  await session($, on, () => on('tool.describe', (_: any, e: any) => ({ description: e.description })), { cwd: '/h/lean-agent-desk' })
  expect(((await describe($, 'mcp__sentry__issues')) as any).isDeferred).toBeUndefined()
})

test('a deferred server stays callable: its call goes through and is counted by name only', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, () => on('tool.call', () => ({ result: 'issues' }) as any))
  const r: any = await $.tool.call({ tool: 'mcp__sentry__issues', query: 'SECRET-ARGUMENT' } as any)
  expect(r.deny).toBeUndefined()
  await $.tool.call({ tool: 'mcp__sentry__issues' } as any)
  await $.tool.call({ tool: 'Skill', skill: 'figma:implement' } as any)
  await $.tool.call({ tool: 'mcp__lean-agent__lean_report', text: 'x' } as any)
  const u = h.files.get(`${L}/threads/t1/usage.json`)!
  expect(JSON.parse(u)).toEqual({ mcp: { sentry: 2 }, skills: { 'figma:implement': 1 } })
  expect(u).not.toContain('SECRET-ARGUMENT')
})

test('every ledger row of a thread carries the effort and model it was started with', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session(
    $,
    on,
    () =>
      on('turn.step', async function* (_: any, e: any) {
        return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
      }),
    { thread: { model: 'sonnet', effort: 'medium' } },
  )
  const st = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 1 } as any)
  for (;;) if ((await st.next()).done) break
  const row = JSON.parse(h.files.get(`${L}/ledger.jsonl`)!.trim().split('\n')[0]!)
  expect(row).toMatchObject({ role: 'thread', tN: 't1', effort: 'medium', tmodel: 'sonnet', model: 'claude-haiku-5-5' })
})

test('the desk\'s ledger rows carry no thread effort', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session(
    $,
    on,
    () =>
      on('turn.step', async function* (_: any, e: any) {
        return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'sonnet', input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
      }),
    { cwd: '/h/lean-agent-desk', thread: { model: 'opus', effort: 'low' } },
  )
  const st = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1 } as any)
  for (;;) if ((await st.next()).done) break
  const row = JSON.parse(h.files.get(`${L}/ledger.jsonl`)!.trim().split('\n')[0]!)
  expect(row.role).toBe('desk')
  expect(row.effort).toBeUndefined()
  expect(row.tmodel).toBeUndefined()
})
