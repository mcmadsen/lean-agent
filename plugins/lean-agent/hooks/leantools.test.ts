// Tools removed instead of refused (leantools.ts): the desk's and a thread's settings fragments, and their merge into an existing settings object.
import { expect, test } from 'claude-code/testing'
import { DESK_TOOLS } from './guard'
import { BUILTIN_TOOLS, THREAD_NEVER, deskSettings, leanDeskSettings, leanThreadSettings, mergeSettings, threadSettings } from './leantools'

test('desk: every built-in tool strict mode cannot allow is denied, the ones it can allow are not; connectors and project servers are off', () => {
  const s = deskSettings()
  for (const t of DESK_TOOLS) expect([t, s.permissions.deny.includes(t)]).toEqual([t, false])
  for (const t of ['Agent', 'Task', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Monitor', 'CronCreate', 'EnterPlanMode', 'Workflow']) expect([t, s.permissions.deny.includes(t)]).toEqual([t, true])
  expect(s.permissions.deny.length).toBe(BUILTIN_TOOLS.filter(t => !DESK_TOOLS.includes(t)).length)
  expect(s.permissions.deny.some(t => t.startsWith('mcp__lean-agent'))).toBe(false) // lean-agent's own tools are never denied
  expect(s.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  expect(s.enableAllProjectMcpServers).toBe(false)
  expect(leanDeskSettings).toBe(deskSettings)
})

test('thread: only what lean-agent threads never call; Agent, Skill, the file tools and Bash stay; no connector, no MCP server is touched', () => {
  const s = threadSettings()
  expect(s.permissions.deny).toEqual([...THREAD_NEVER])
  for (const t of ['Agent', 'Task', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch'])
    expect([t, s.permissions.deny.includes(t)]).toEqual([t, false])
  for (const t of ['NotebookEdit', 'CronCreate', 'EnterPlanMode', 'EnterWorktree', 'TaskCreate']) expect([t, s.permissions.deny.includes(t)]).toEqual([t, true])
  expect(Object.keys(s.env).some(k => /MCP/i.test(k))).toBe(false)
  expect(s.enableAllProjectMcpServers).toBeUndefined()
  expect(leanThreadSettings).toBe(threadSettings)
})

test('merge: deny lists are united without duplicates, the existing env value wins, nothing else is touched, a damaged file is replaced by the fragment', () => {
  const base = { model: 'sonnet', permissions: { allow: ['Bash'], deny: ['Read(./secret)', 'Edit'] }, env: { CLAUDE_CODE_DISABLE_CRON: '0', A: '1' } }
  const m = mergeSettings(base, deskSettings())
  expect(m.model).toBe('sonnet')
  expect(m.permissions.allow).toEqual(['Bash'])
  expect(m.permissions.deny.filter((t: string) => t === 'Edit').length).toBe(1)
  expect(m.permissions.deny).toContain('Read(./secret)')
  expect(m.permissions.deny).toContain('Agent')
  expect(m.env.CLAUDE_CODE_DISABLE_CRON).toBe('0')
  expect(m.env.A).toBe('1')
  expect(m.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
  expect(mergeSettings({ enableAllProjectMcpServers: true }, deskSettings()).enableAllProjectMcpServers).toBe(true) // the user's own choice
  expect(mergeSettings(mergeSettings({}, threadSettings()), threadSettings())).toEqual(mergeSettings({}, threadSettings())) // idempotent
  expect(mergeSettings('garbage', threadSettings()).permissions.deny).toEqual([...THREAD_NEVER])
  expect(mergeSettings({ permissions: { deny: 'x' } }, threadSettings()).permissions.deny).toEqual([...THREAD_NEVER])
})
