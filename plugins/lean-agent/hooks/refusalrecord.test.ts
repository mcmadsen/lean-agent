// Every refusal path of 1.0.15 and every missing tool writes ONE record (feedback.ts logRefusal / logMissingTool: role, rule id, short text,
// running version) that the feedback export lists under "Guard refusals" / "Missing tools", and `lean_doctor refusals` groups.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { exportFeedback } from './feedbackexport'
import { logMissingTool, logRefusal } from './feedback'
import { maskMcp } from './feedbackexport'
import { groupMissing, missingWhat, refusalsText, ruleOf, workerLines } from './refusals'
import { reviewTool } from './reviewtool'
import { fetchExternal } from './reviewext'
import { readJsonl } from './state'
import { resetFolderLocks } from './folderlock'
import { orchReset } from './orchestrate'

const L = '/h/.lean-agent'
const ROOT = '/p'

const mstore = new Map<string, unknown>() // the engine's store as the mod sees it ($.store)
async function session($: any, on: any, cwd: string, answer: (e: any) => any = () => ({ result: 'ok' })) {
  const h = fakeHost(on, { orchestrate: true })
  on('store.get', (_: any, e: any) => ({ value: mstore.get(String(e.key ?? e.name ?? e.k)) }))
  on('store.set', (_: any, e: any) => { mstore.set(String(e.key ?? e.name ?? e.k), e.value)
    return { value: null }
  })
  resetLocks()
  resetFolderLocks()
  orchReset()
  h.clock.t = 1_000_000
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.15' }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '[]' })
  on('clock.after', () => new Promise(() => {}))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'lean-agent:worker-haiku', status: 'running' }] }))
  on('ui.status', () => ({ value: null }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('tool.call', (_: any, e: any) => answer(e) as any)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return h
}
const rows = (h: any) => readJsonl<any>(h.host, `${L}/refusals.jsonl`)
const exported = async (h: any) => {
  const r = await exportFeedback(h.host, ROOT, { version: '1.0.15' })
  return h.files.get(r.path!)! as string
}
const brief = (n: number, extra = '') => `job: lookup\nwhere is thing ${n} defined?${extra}`

test('thread orchestrate, why-sonnet, brief too long and the retry limit are recorded with role, rule id, text and version, and reach the export', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`)
  await $.tool.call({ tool: 'Edit', file_path: '/r/app/src/a.ts', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet', prompt: brief(1) } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: brief(2, 'x'.repeat(3100)) } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(3) } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(3) } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(3, '\nwhy-sonnet: the first answer lacked the file') } as any) // a changed brief is a new job
  const got = (await rows(h)).filter(r => r.kind === 'refusal' && r.rule !== 'result-trimmed') // (an answer that is not in the job schema is counted too: below)
  expect(got.map(r => r.rule)).toEqual(['thread-orchestrate', 'why-sonnet-missing', 'brief-too-long', 'retry-limit'])
  expect(got[0]).toMatchObject({ role: 'thread', src: 'guard', tool: 'Edit', thread: 't1', what: 'Edit project' }) // what was tried: the tool and the kind of its path
  expect(typeof got[0].version).toBe('string') // the running version
  const t = await exported(h)
  expect(t).toContain('## Guard refusals since the last export')
  for (const id of ['thread-orchestrate:', 'why-sonnet-missing:', 'brief-too-long:', 'retry-limit:']) expect(t).toContain(id)
})

test('a worker over its step budget and an MCP call without a grant are recorded with the worker role', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`)
  for (let i = 0; i < 25; i++) await $.tool.call({ tool: 'Read', file_path: '/r/app/a.ts', agentId: 'agent-1' } as any) // (no job line: the ceiling, 24)
  await $.tool.call({ tool: 'mcp__datadog__query', agentId: 'agent-1' } as any)
  const got = (await rows(h)).filter(r => r.kind === 'refusal')
  expect(got.map(r => r.rule)).toContain('worker-step-budget')
  expect(got.every(r => r.role === 'worker')).toBe(true)
  const t = await exported(h)
  expect(t).toContain('worker-step-budget:')
})

test('a step-budget refusal records the job, the run\'s calls, its budget and the brief size; the export counts RUNS per job, not refused calls', { timeoutMs: 20_000 }, async ($, on) => {
  const answer = (e: any) => (e.tool === 'Agent' ? { result: 'Async agent launched successfully.\nagentId: agent-1 (use SendMessage)' } : { result: 'ok' }) // a background worker: its grant binds to its id
  const h = await session($, on, `${L}/threads/t1`, answer)
  const prompt = `job: edit\nchange thing${'x'.repeat(980)}` // 1000+ characters, within the brief cap
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt } as any)
  for (let i = 0; i < 18; i++) await $.tool.call({ tool: 'Read', file_path: '/r/app/a.ts', agentId: 'agent-1' } as any) // an edit job: 16 calls, then 2 refused ones
  const got = (await rows(h)).filter(r => r.rule === 'worker-step-budget')
  expect(got).toHaveLength(2)
  expect(got[0]).toMatchObject({ role: 'worker', job: 'edit', calls: 17, budget: 16, chars: prompt.length, run: 'agent1' })
  expect(got[1]).toMatchObject({ calls: 18, budget: 16 })
  const t = await exported(h)
  expect(t).toContain(`step budget used by 1 edit run(s) (2 refused calls; budget 16 tool calls; median 17 calls made; brief characters: median ${prompt.length}, largest ${prompt.length})`)
})

test('answer-too-long rows of 1.0.31 are not listed as refusals (a counter now)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`)
  h.files.set(`${L}/refusals.jsonl`, JSON.stringify({ ts: 1_000_000, src: 'guard', kind: 'refusal', role: 'worker', rule: 'answer-too-long', text: 'answer-too-long: a second answer of 3000 characters, let through', agent: 'reader-sonnet', version: '1.0.31' }) + '\n')
  expect(await exported(h)).not.toContain('answer-too-long')
  expect(await refusalsText(h.host, 7)).not.toContain('answer-too-long')
})

test('the desk routing refusal is recorded',{ timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, '/h/lean-agent-desk')
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', prompt: brief(9) } as any)
  expect(r.deny).toContain('the desk routes')
  const got = (await rows(h)).filter(x => x.rule === 'desk-routing')
  expect(got).toHaveLength(1)
  expect(got[0]).toMatchObject({ role: 'desk', kind: 'refusal' })
  expect(await exported(h)).toContain('desk-routing:')
})

test('lean_run refusals and a refused action kind are recorded', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`)
  const run: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_run', command: 'git push origin main' } as any)
  expect(run.isError).toBe(true)
  const rep: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_report', state: 'blocked', text: 'need a write', action: { kind: 'delete-everything', params: {}, why: 'x' } } as any)
  expect(rep.isError).toBe(true)
  const got = (await rows(h)).map(r => r.rule)
  expect(got).toContain('run-refused')
  expect(got).toContain('action-unknown-kind')
  const t = await exported(h)
  expect(t).toContain('run-refused:')
  expect(t).toContain('action-unknown-kind:')
})

test('a review thread that reports done without a record is recorded; a refused external review is too', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`)
  mstore.set('review.marker.t1', { kind: 'review', project: 'app', ref: '12', ts: 1 }) // the mod's store: a review thread's marker
  const rep: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_report', state: 'done', text: 'looks fine' } as any)
  expect(JSON.stringify(rep)).toContain('this is a review thread')
  const ext = await reviewTool(h.host, 'app', { action: 'prepare', ref: 'a..b', level: 'full' }, 't1')
  expect(ext.ok).toBe(false)
  const got = (await rows(h)).map(r => r.rule)
  expect(got).toContain('review-report-gate')
  expect(got).toContain('external-review-refused')
  const t = await exported(h)
  expect(t).toContain('review-report-gate:')
  expect(t).toContain('external-review-refused:')
})

test('a worker result trimmed to its schema is counted', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`, e => (e.tool === 'Agent' ? { result: 'well, I looked around and found many things\n'.repeat(40) } : { result: 'ok' }))
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(5) } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(6) } as any)
  const got = (await rows(h)).filter(r => r.rule === 'result-trimmed')
  expect(got).toHaveLength(2)
  expect(got[0]).toMatchObject({ role: 'worker', thread: 't1' })
  expect(await exported(h)).toMatch(/\(x2\) \[reader-haiku\] result-trimmed:/)
})

test('a tool that is not available, and a worker\'s split / missing / refused lines, are recorded as missing tools and exported grouped with counts', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, `${L}/threads/t1`, e =>
    e.tool === 'mcp__datadog__query' || e.tool === 'WebFetch'
      ? { result: `Error: No such tool available: ${e.tool}`, isError: true }
      : e.tool === 'Agent'
        ? { result: 'answer:\nnothing\nrefs: none\nsplit: the second half\nmissing: mcp__datadog__query' }
        : { result: 'ok' },
  )
  await $.tool.call({ tool: 'mcp__datadog__query' } as any)
  await $.tool.call({ tool: 'mcp__datadog__query' } as any)
  await $.tool.call({ tool: 'WebFetch' } as any)
  await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: brief(7) } as any)
  const miss = (await rows(h)).filter(r => r.kind === 'missing-tool')
  expect(miss.map(r => r.tool).sort()).toEqual(['WebFetch', 'mcp datadog', 'mcp datadog', 'missing', 'split'])
  expect(miss.find(r => r.tool === 'WebFetch')).toMatchObject({ role: 'thread', thread: 't1' })
  expect(miss.find(r => r.tool.startsWith('split'))).toMatchObject({ role: 'worker', job: 'lookup' })
  const g = await groupMissing(h.host)
  expect(g.total).toBe(5)
  expect(g.groups[0]).toMatchObject({ what: 'mcp datadog', n: 2 })
  const t = await exported(h)
  expect(t).toContain('## Missing tools since the last export')
  expect(t).toContain('- (x2) [thread] mcp datadog')
  expect(t).toContain('[worker] split (job lookup)')
  expect(t).not.toContain('the second half') // a worker's own words never reach the export
  expect(await refusalsText(h.host)).toContain('missing tool(s)')
  // missing-tool rows are not counted as guard refusals
  expect(t.split('## Missing tools')[0]).not.toContain('mcp datadog')
})

test('the helpers: one record format, rule ids, what counts as a missing tool', async () => {
  const h = fakeHost(null)
  h.clock.t = 5
  await logRefusal(h.host, { role: 'thread', rule: 'x-rule', text: 'short', tool: 'Edit', version: '1.0.15' })
  await logMissingTool(h.host, { role: 'worker', what: 'mcp jira', job: 'check', version: '1.0.15' })
  expect(await readJsonl<any>(h.host, `${L}/refusals.jsonl`)).toEqual([
    { ts: 5, src: 'guard', kind: 'refusal', role: 'thread', rule: 'x-rule', text: 'short', tool: 'Edit', version: '1.0.15' },
    { ts: 5, src: 'guard', kind: 'missing-tool', role: 'worker', tool: 'mcp jira', job: 'check', text: 'missing tool: mcp jira', version: '1.0.15' },
  ])
  expect(ruleOf('the desk routes: start or ask a thread (lean_thread new / send)')).toBe('desk-routing')
  expect(ruleOf('lean-agent: mcp__x__y refused: server x is not granted for this job (allow-mcp: none); use only those')).toBe('allow-mcp-other-server')
  expect(ruleOf('lean-agent: strict mode: route this to a thread')).toBe('desk-strict')
  expect(missingWhat('Bash', 'exit code 1: tests failed')).toBeNull()
  expect(missingWhat('mcp__jira__get', 'MCP server jira is not connected')).toBe('mcp jira')
  expect(workerLines('answer:\nx\nsplit: a\nSplit: b\nrefused: c\nmissing: d')).toEqual(['split', 'refused', 'missing'])
})

test('the export masks MCP server names that are not well-known public ones', () => {
  expect(maskMcp('lean-agent: mcp__initech-prod-db__run_query refused: server initech-prod-db is not granted for this job (allow-mcp: azure-devops, initech-prod-db)')).toBe(
    'lean-agent: mcp__<server>__<tool> refused: server <server> is not granted for this job (allow-mcp: azure-devops, <server>)',
  )
  expect(maskMcp('mcp initech-prod-db')).toBe('mcp <server>')
  expect(maskMcp('mcp datadog and mcp server notes')).toBe('mcp datadog and mcp server notes')
})

test('the external review scratch repository runs git with its own hooks, fsmonitor and ssh command overridden', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = (argv: string[]) => ({ exitCode: argv.includes('get-url') ? 0 : 1, stdout: argv.includes('get-url') ? 'https://github.com/acme/app.git\n' : '' })
  await fetchExternal(h.host, 'app', '12')
  const scratchCalls = h.calls.filter(c => c.argv.includes('-C') && c.argv[c.argv.indexOf('-C') + 1]!.includes('/scratch/'))
  expect(scratchCalls.length).toBeGreaterThan(0)
  for (const c of scratchCalls) for (const f of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.sshCommand=ssh']) expect(c.argv).toContain(f)
})
