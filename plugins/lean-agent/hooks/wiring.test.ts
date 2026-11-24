import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { REPORT_RULE } from './endnudge'

async function threadSession($: any, on: any, hooks: () => void) {
  const h = fakeHost(on)
  hooks() // hooks beneath the plugin must exist before the first $ call
  resetLocks()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}

test('a worker reply with LEAN-FEEDBACK files its missing context and memory', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on, () => on('tool.call', () => ({ result: 'did it\nLEAN-FEEDBACK {"status":"done","missing":"build flags for src/a/b.ts","remember":["use pnpm"]}' })))
  await $.tool.call({ tool: 'Agent', prompt: 'x' } as any)
  expect(h.files.get('/h/.lean-agent/proj/gaps.jsonl')).toContain('src/a/b.ts')
  expect(h.files.get('/h/.lean-agent/memory/items.json')).toContain('use pnpm') // the one memory store (memory.ts)
})

test('turn.step writes a ledger row and refuses past the daily cap', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on, () =>
    on('turn.step', async function* (_: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: 'haiku', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
    }),
  )
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ dailyCapUsd: { thread: 1 } }))
  const step = async (i: number) => {
    const st = $.turn.step({ turnId: 't', index: i, model: 'haiku', messageCount: 1 } as any)
    for (;;) {
      const n = await st.next()
      if (n.done) return n.value
    }
  }
  const a: any = await step(0)
  expect(a.answer).toBe('ok')
  expect(h.files.get('/h/.lean-agent/ledger.jsonl')).toContain('"usd":1')
  const b: any = await step(1)
  expect(b.answer).toContain('daily $1.00')
})

test('an Agent call records the thread\'s job and mcp grants while it runs and removes them after (allow-edit lines are ignored)', { timeoutMs: 20_000 }, async ($, on) => {
  let during = ''
  let h: any
  h = await threadSession($, on, () =>
    on('tool.call', { tool: 'Agent' }, () => {
      during = h.files.get('/h/.lean-agent/threads/t1/grants.json') ?? ''
      return { result: 'done' } as any
    }),
  )
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet', prompt: 'job: edit\nallow-mcp: srv\nallow-edit: /w/t1' } as any)
  expect(during).toContain('srv')
  expect(during).not.toContain('/w/t1')
  const after = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/grants.json'))
  expect(after.pending).toEqual([])
})

test('a thread cannot ask the user directly', { timeoutMs: 20_000 }, async ($, on) => {
  await threadSession($, on, () => on('tool.call', () => ({ result: 'asked' }) as any))
  const r: any = await $.tool.call({ tool: 'AskUserQuestion' } as any)
  expect(r.deny).toContain('lean_ask')
})

test('prompt.compose adds the standing orders to a thread\'s session section', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on, () => on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as any))
  h.files.set('/h/.lean-agent/memory/items.json', JSON.stringify({ next: 2, items: [{ id: 'm1', scope: 'project:proj', kind: 'rule', text: 'use pnpm', created: 1, source: 'user-typed', uses: 0, lastUsed: 0, status: 'active' }] }))
  const r: any = await $.prompt.compose({ model: 'haiku', promptModel: 'haiku', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  const mem = r.sections.find((s: any) => s.id === 'lean-agent:memory')
  expect(mem.scope).toBe('session')
  expect(mem.text).toContain('use pnpm')
  // the report rule (endnudge.ts) is the FIRST section of a thread session, ahead of the engine's own and the mod's, with its fixed text
  expect(r.sections[0]).toEqual({ id: 'lean-agent:report-rule', text: REPORT_RULE, scope: 'shared' })
  expect(r.sections.filter((s: any) => s.id === 'lean-agent:report-rule')).toHaveLength(1)
})

test('session.compact writes the thread\'s notes first', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on, () => on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as any))
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'remember this', toolUses: [] }] } as any)
  expect(h.files.get('/h/.lean-agent/threads/t1/notes.md')).toContain('remember this')
})

test('the first session.start of any local session unloads a leftover 0.45 launch agent, then migrates', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.files.set('/h/Library/LaunchAgents/com.lean-agent.up.plist', '<plist/>')
  h.files.set('/h/.lean-agent/up.json', '{}')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/somewhere/else', surface: 'cli', isInteractive: true } as any)
  const cmds = h.calls.map(c => c.argv.join(' '))
  expect(cmds.findIndex(c => c.startsWith('launchctl bootout gui/501/com.lean-agent.up'))).toBeGreaterThanOrEqual(0)
  expect(h.files.has('/h/.lean-agent/migrated-1.0.json')).toBe(true)
  expect(h.files.has('/h/Library/LaunchAgents/com.lean-agent.up.plist')).toBe(false)
})

test('the desk records its session id; a thread report goes out through $.session.send and the desk marks the arrival delivered', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'desk-sess-1' }))
  on('session.receive', (_: any, e: any) => ({ text: e.text })) // the engine's own queueing, beneath the plugin's hook
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(JSON.parse(h.files.get('/h/.lean-agent/desk.json') ?? '{}').sid).toBe('desk-sess-1')
  // the desk receives a thread's direct line: its row is marked delivered
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', JSON.stringify({ ts: 77, from: 't1', kind: 'report', text: 'merged', state: 'done' }) + '\n')
  await $.session.receive({ origin: { kind: 'peer', plugin: 'lean-agent' }, text: '[lean-agent] t1 done: merged <!-- lean:r=77:t1:report -->' } as any)
  expect(h.files.get('/h/.lean-agent/desk/inbox-delivered.json')).toContain('77:t1:report')
  // a message that is not from this plugin marks nothing
  await $.session.receive({ origin: { kind: 'peer', plugin: 'other' }, text: '<!-- lean:r=78:t1:report -->' } as any)
  expect(h.files.get('/h/.lean-agent/desk/inbox-delivered.json')).not.toContain('78:t1')
})

test('a thread\'s tool call, a worker\'s tool call and a report write the stall watchdog\'s activity file', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await threadSession($, on, () => on('tool.call', () => ({ result: 'ok' }) as any))
  const at = () => JSON.parse(h.files.get('/h/.lean-agent/threads/t1/activity.json') ?? 'null')
  await $.tool.call({ tool: 'Read', path: '/x' } as any)
  expect(at()).toMatchObject({ at: h.clock.t, kind: 'tool' })
  h.clock.t += 10_000
  await $.tool.call({ tool: 'Read', path: '/y', agentId: 'w1' } as any)
  expect(at()).toMatchObject({ at: h.clock.t, kind: 'worker' })
})
