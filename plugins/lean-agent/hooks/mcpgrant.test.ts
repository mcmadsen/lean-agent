// MCP access is opt-in per job (mcpgrant.ts, guard.ts): a granted server is allowed, another server, a write tool and a call without a grant are refused.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, hasGrants, parseGrants, recordGrant } from './guard'
import { isWriteTool, mcpDecision, toolPart } from './mcpgrant'
import { threadSettings } from './leantools'

const thread = { kind: 'thread', id: 't1' } as const
const DD = 'mcp__claude_ai_Datadog__search_logs'
const run = (h: any, agentType: string, agentId: string, e: any, role: any = thread) => decide(h.host, { role, cwd: '/r/app', agentType, agentId }, e)

test('brief lines: allow-mcp and allow-mcp-write are parsed apart, with the job type', () => {
  const g = parseGrants('job: lookup\nallow-mcp: Datadog, sentry\nallow-mcp-write: Datadog\nfind the errors')
  expect(g.mcp).toEqual(['Datadog', 'sentry'])
  expect(g.mcpWrite).toEqual(['Datadog'])
  expect(g.job).toBe('lookup')
  expect(parseGrants('allow-mcp-write: Datadog').mcp).toEqual([]) // the longer key is not an allow-mcp line
  expect(hasGrants(parseGrants('allow-mcp: x'))).toBe(true)
  expect(hasGrants(parseGrants('job: run'))).toBe(true)
  expect(hasGrants(parseGrants('plain brief'))).toBe(false)
})

test('write tools are recognised by name (verb first, camelCase too, or a write word inside)', () => {
  for (const t of ['create_monitor', 'updateDashboard', 'delete_slo', 'upsert_event', 'edit_notebook', 'run_query_job', 'trigger_pipeline', 'execute_workflow', 'send_message', 'x_write_y', 'remove_user'])
    expect([t, isWriteTool(`mcp__s__${t}`)]).toEqual([t, true])
  for (const t of ['search_logs', 'get_monitor', 'list_dashboards', 'query_metrics', 'analyze_traces', 'settings_overview', 'describe_service'])
    expect([t, isWriteTool(`mcp__s__${t}`)]).toEqual([t, false])
  expect(toolPart('mcp__claude_ai_Datadog__createMonitor')).toBe('create_monitor')
})

test('decision: granted server read tool allowed; no grant, other server, write tool refused; own server never judged', () => {
  expect(mcpDecision({ mcp: ['Datadog'] }, DD)).toBeNull()
  expect(mcpDecision({ mcp: ['datadog'] }, 'mcp__plugin_datadog_datadog__get_monitor')).toBeNull() // either spelling of the server
  expect(mcpDecision({}, DD)).toContain('no allow-mcp line')
  expect(mcpDecision({ mcp: [] }, DD)).toContain('no allow-mcp line')
  const other = mcpDecision({ mcp: ['Sentry'] }, DD)
  expect(other).toContain('not granted')
  expect(other).toContain('allow-mcp: Sentry')
  expect(mcpDecision({ mcp: ['Datadog'] }, 'mcp__claude_ai_Datadog__create_monitor')).toContain('allow-mcp-write')
  expect(mcpDecision({ mcp: ['Datadog'], mcpWrite: ['Datadog'] }, 'mcp__claude_ai_Datadog__delete_monitor')).toContain("user's approval through the desk")
  expect(mcpDecision({}, 'mcp__lean-agent__lean_report')).toBeNull()
  expect(mcpDecision({}, 'Read')).toBeNull()
})

test('guard: a worker or reader gets exactly the granted server, read-only, for that job', async () => {
  const h = fakeHost(null)
  await recordGrant(h.host, thread, 'c1', 'lean-agent:reader-mcp', parseGrants('job: lookup\nallow-mcp: Datadog\ncheck the error rate'))
  expect(await run(h, 'lean-agent:reader-mcp', 'r1', { tool: 'mcp__claude_ai_Datadog__search_logs' })).toBeNull() // granted
  expect(await run(h, 'lean-agent:reader-mcp', 'r1', { tool: 'mcp__claude_ai_Sentry__search_issues' })).toContain('not granted') // another server
  expect(await run(h, 'lean-agent:reader-mcp', 'r1', { tool: 'mcp__claude_ai_Datadog__create_monitor' })).toContain('write tool') // a write tool
  expect(await run(h, 'lean-agent:reader-mcp', 'r1', { tool: 'mcp__lean-agent__lean_report' })).toBeNull()
  // no grant at all (a brief without allow-mcp): every MCP tool is refused, for every lean-agent type, bare or prefixed
  for (const t of ['lean-agent:reader-haiku', 'lean-agent:worker-sonnet', 'reader-mcp', 'lean-agent:explorer', 'unresolved'])
    expect([t, await run(h, t, `x-${t}`, { tool: DD })]).toEqual([t, expect.stringContaining('no allow-mcp line')])
  // a second agent of the same type has no grant of its own
  expect(await run(h, 'lean-agent:reader-mcp', 'r2', { tool: DD })).toContain('no allow-mcp line')
  // the thread's own loop and a foreign agent type are not judged by this rule
  expect(await decide(h.host, { role: thread, cwd: '/r/app' }, { tool: DD })).toBeNull()
  expect(await run(h, 'general-purpose', 'g1', { tool: DD })).toBeNull()
})

test('guard: allow-mcp lines in an Agent call of the desk or a subagent are refused (only a thread records grants)', async () => {
  const h = fakeHost(null)
  const e = { tool: 'Agent', subagent_type: 'lean-agent:reader-mcp', prompt: 'allow-mcp: Datadog' }
  expect(await decide(h.host, { role: { kind: 'desk' }, cwd: '/r' }, e)).toContain('allow-mcp')
  expect(await decide(h.host, { role: thread, cwd: '/r', agentType: 'lean-agent:worker-sonnet', agentId: 'w' }, e)).toContain('cannot own grants')
  expect(await decide(h.host, { role: thread, cwd: '/r' }, e)).toBeNull()
})

test('the project list is respected: a connector the project lists is never in a deny rule', () => {
  const s = threadSettings({ mcp: ['Datadog'], extraDeny: ['mcp__claude_ai_Datadog__search_logs', 'mcp__claude_ai_Other__x', 'Glob'] })
  expect(s.permissions.deny).not.toContain('mcp__claude_ai_Datadog__search_logs')
  expect(s.permissions.deny).toContain('mcp__claude_ai_Other__x')
  expect(s.permissions.deny).toContain('Glob')
  expect(threadSettings().permissions.deny.some(t => t.startsWith('mcp__'))).toBe(false) // by default no connector is touched
  expect(Object.keys(threadSettings().env).some(k => /CLAUDEAI_MCP/.test(k))).toBe(false)
})
