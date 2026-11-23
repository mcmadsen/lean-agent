// `lean_doctor overhead` (overhead.ts): the table per role from synthetic plugin files, and the share from a synthetic transcript.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ROLES, measure, overheadReport, skillsListing, tableText, tokens, transcriptShare } from './overhead'

const ROOT = '/p'
function plugin() {
  const h = fakeHost(null)
  h.files.set(`${ROOT}/templates/front-desk.md`, 'd'.repeat(400))
  h.files.set(`${ROOT}/templates/thread.md`, 't'.repeat(800))
  for (const r of ROLES.slice(2)) h.files.set(`${ROOT}/agents/${r}.md`, 'a'.repeat(100 * (ROLES.indexOf(r) + 1)))
  h.files.set(`${ROOT}/skills/both/SKILL.md`, '---\nname: both\ndescription: for both roles\n---\nbody that is never listed')
  h.files.set(`${ROOT}/skills/deskonly/SKILL.md`, '---\nname: deskonly\ndescription: only the desk\nroles: desk\n---\nbody')
  h.files.set(`${ROOT}/skills/threadonly/SKILL.md`, '---\nname: threadonly\ndescription: only a thread\nroles: desk, thread\n---\nbody'.replace('desk, thread', 'thread'))
  return h
}
const tools = { desk: [{ name: 'lean_thread', description: 'x'.repeat(200), inputSchema: { type: 'object' } }], thread: [{ name: 'lean_report', description: 'y'.repeat(100), inputSchema: { type: 'object' } }] }

test('the table has the eight roles; template, agent, skills and lean tools are counted as chars / 4', async () => {
  const h = plugin()
  const rows = await measure(h.host, ROOT, tools)
  expect(rows.map(r => r.role)).toEqual([...ROLES])
  const by = Object.fromEntries(rows.map(r => [r.role, r]))
  expect(by.desk!.template).toBe(100)
  expect(by.thread!.template).toBe(200)
  expect(by['worker-haiku']!.agent).toBe(tokens(300)) // agents/worker-haiku.md is the third role: 100 * 3 chars
  expect(by['worker-haiku']!.template + by['worker-haiku']!.skills + by['worker-haiku']!.tools).toBe(0) // a subagent has no skills listing, no lean tools
  expect(by.desk!.tools).toBeGreaterThan(50)
  expect(by.thread!.tools).toBeGreaterThan(25)
  for (const r of rows) expect(r.total).toBe(r.template + r.agent + r.skills + r.tools)
  const txt = tableText(rows)
  expect(txt.split('\n').length).toBe(9)
  expect(txt).toContain('lean tools')
  expect(txt).toContain('auditor')
})

test('the skills listing is name and description only, per role (a skill with roles: lists only for those)', async () => {
  const h = plugin()
  expect(await skillsListing(h.host, ROOT, 'desk')).toBe('- both: for both roles\n- deskonly: only the desk')
  expect(await skillsListing(h.host, ROOT, 'thread')).toBe('- both: for both roles\n- threadonly: only a thread')
})

test('a missing file or folder counts as zero, never an error', async () => {
  const h = fakeHost(null)
  const rows = await measure(h.host, '/nowhere')
  expect(rows.every(r => r.total === 0)).toBe(true)
})

test('transcript: first request tokens, MCP servers and tool names, MCP instructions', () => {
  const recs = [
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__claude_ai_Datadog__search_logs', 'mcp__claude_ai_Datadog__get_monitor', 'mcp__plugin_figma_figma__get_file', 'WebFetch'] } },
    { type: 'attachment', attachment: { type: 'mcp_instructions_delta', text: 'z'.repeat(400) } },
    { type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 1 }, content: [] } }, // a subagent's request is not the first one
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20000, cache_read_input_tokens: 5 }, content: [{ type: 'tool_use', name: 'mcp__claude_ai_Sentry__x', id: 'a' }, { type: 'tool_use', name: 'Read', id: 'b' }] } },
  ]
  const s = transcriptShare(recs)
  expect(s.first).toBe(20015)
  expect(s.mcpServers).toEqual(['claude_ai_Datadog', 'claude_ai_Sentry', 'plugin_figma_figma'])
  expect(s.mcpTools).toBe(4)
  expect(s.mcpInstructions).toBe(100)
  expect(s.builtinTools).toBe(2)
  expect(transcriptShare([]).first).toBe(0)
})

test('report: table, the note about what no file holds, and the transcript share when records are given', async () => {
  const h = plugin()
  const none = await overheadReport(h.host, ROOT, { tools })
  expect(none).toContain('fixed overhead per role')
  expect(none).toContain('desk ')
  expect(none).not.toContain('first request carried')
  const recs = [{ type: 'assistant', message: { usage: { input_tokens: 18000 }, content: [] } }]
  const withT = await overheadReport(h.host, ROOT, { tools, transcript: recs })
  expect(withT).toContain('first request: 18000 tokens')
  expect(withT).not.toContain('REAL base')
  expect(withT).toContain('MCP named by the transcript: 0 server(s)')
  expect(await overheadReport(h.host, ROOT, { tools, transcript: [{ type: 'user' }] })).toContain('no assistant request with usage')
})
