// compare: parsing of `claude -p --output-format json` and `/context` (fixtures are real outputs), the clean-run settings, the three
// columns, report naming and no contents, suggestions, task mode, the desk and thread entry points.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { allTokens, bySource, compare, historyText, overhead, parseContext, parseRun, parseTokens, taskMode } from './compare'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ROOT = '/plug'
const HELP = '  --max-budget-usd <amount>\n  --settings <file-or-json>\n  --plugin-dir <path>\n  --disable-slash-commands\n  --strict-mcp-config\n  --mcp-config <configs...>\n  --effort <level>\n  --tools <tools...>\n  --allowedTools <tools...>\n  --add-dir <dirs...>\n'

// a real `claude -p "Reply with OK." --output-format json` result, trimmed to its usage
const runJson = (input: number, o: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 2631, total_cost_usd: 0.00219014, result: 'OK', usage: { input_tokens: 2, cache_creation_input_tokens: input - 2 - 28994, cache_read_input_tokens: 28994, output_tokens: 4, iterations: [{ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 28994, cache_creation_input_tokens: input - 2 - 28994, type: 'message' }] }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2 } }, ...o })
// real `/context` output (the clean column, then a thread-shaped one with lean-agent loaded)
const ctxJson = (md: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, result: md, local_command: 'context' })
const CLEAN_CTX = '## Context Usage\n\n**Model:** claude-haiku-5-5  \n**Tokens:** 27.8k / 1m (3%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.9k | 0.3% |\n| System tools | 18.6k | 1.9% |\n| System tools (deferred) | 20.5k | 2.1% |\n| Skills | 6.3k | 0.6% |\n| Messages | 10 | 0.0% |\n| Free space | 939.2k | 93.9% |\n| Autocompact buffer | 33k | 3.3% |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| startup-hook-skill | User | ~100 |\n| datadog:ddsetup | Plugin (datadog) | ~230 |\n| datadog:ddconfig | Plugin (datadog) | ~80 |\n| dataviz | Built-in | ~480 |\n| docs | claude.ai sync | ~340 |\n'
const THREAD_CTX = '## Context Usage\n\n**Model:** claude-haiku-5-5  \n**Tokens:** 28.5k / 1m (3%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.8k | 0.3% |\n| System tools | 16.9k | 1.7% |\n| System tools (deferred) | 20.5k | 2.1% |\n| Custom agents | 429 | 0.0% |\n| Memory files | 937 | 0.1% |\n| Skills | 7.6k | 0.8% |\n| Messages | 10 | 0.0% |\n| Free space | 939.2k | 93.9% |\n\n### Custom agents\n\n| Agent | Source | Tokens |\n|-------|--------|--------|\n| lean-agent:explorer | Plugin | 91 |\n| lean-agent:worker-haiku | Plugin | 57 |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| lean-agent:learn | Plugin (lean-agent) | ~100 |\n| lean-agent:worktree | Plugin (lean-agent) | ~110 |\n| datadog:ddsetup | Plugin (datadog) | ~230 |\n'

test('tokens: k and m suffixes, ~, commas; anything else is null', () => {
  expect(['27.8k', '~100', '1m', '1,234', '10', '33k', '0.3'].map(parseTokens)).toEqual([27800, 100, 1e6, 1234, 10, 33000, 0])
  expect(['', 'abc', '3 sonnets'].map(parseTokens)).toEqual([null, null, null])
})

test('/context: the category table, the model, the total and the lists by source (names only)', () => {
  const c = parseContext(CLEAN_CTX)!
  expect(c.model).toBe('claude-haiku-5-5')
  expect(c.total).toBe(27800)
  expect(c.rows['system prompt']).toBe(2900)
  expect(c.rows['system tools (deferred)']).toBe(20500)
  expect(c.rows.skills).toBe(6300)
  expect(c.rows.messages).toBe(10)
  expect(c.rows['memory files']).toBeUndefined()
  expect(c.lists.skills!.length).toBe(5)
  expect(bySource(c, 'skills').map(([s, t, n]) => `${s}:${t}:${n}`)).toEqual(['Built-in:480:1', 'claude.ai sync:340:1', 'plugin datadog:310:2', 'User:100:1'])
  const t = parseContext(THREAD_CTX)!
  expect(t.rows['custom agents']).toBe(429)
  expect(t.lists['custom agents']!.map(a => a.name)).toEqual(['lean-agent:explorer', 'lean-agent:worker-haiku'])
  expect(parseContext('no table here')).toBeNull()
})

test('the -p JSON: the first iteration\'s input (input + cache creation + cache read), cost, turns, model; arrays, errors and garbage', () => {
  const r = parseRun(runJson(38724))!
  expect(r).toMatchObject({ input: 38724, output: 4, turns: 1, ms: 2631, model: 'claude-haiku-5-5', error: '', text: 'OK' })
  expect(Math.round(r.cost * 1e8)).toBe(219014)
  expect(parseRun(`[${JSON.stringify({ type: 'system' })},${runJson(40000)}]`)!.input).toBe(40000)
  expect(parseRun(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns', usage: { input_tokens: 5 } }))).toMatchObject({ input: 5, error: 'error_max_turns' })
  expect(parseRun('Usage: claude [options]\n' + runJson(1000))!.input).toBe(1000) // a stray line before the JSON
  expect(parseRun('not json')).toBeNull()
  expect(parseRun('{"type":"system"}')).toBeNull()
  expect(allTokens(runJson(1000, { usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 1000 } }))).toBe(1111)
})

// a fake claude: --help lists the flags; /context answers a table by cwd; the turn answers input tokens by cwd and flags
type Seen = { args: string[]; cwd?: string; env?: Record<string, string> }
function setup(opts: { installed?: boolean; flags?: string; costs?: number; mcp?: boolean } = {}) {
  const h = fakeHost(null)
  h.clock.t = Date.UTC(2026, 10, 18, 12)
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' }, secret: { path: '/repo2', private: true } }))
  h.files.set('/repo/CLAUDE.md', 'SECRET-CONTENT: the billing rules are...')
  h.files.set(`${L}/desk/inbox.jsonl`, '')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', '# desk')
  h.files.set(`${ROOT}/templates/thread.md`, '# Thread {{id}}: {{title}}\n')
  if (opts.installed) h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'lean-agent@mk': [{ version: '1.0.4' }], 'other@mk': [{ version: '1' }] } }))
  const seen: Seen[] = []
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: opts.flags ?? HELP }
    seen.push({ args: a, cwd: call.cwd, env: call.env })
    const prompt = a[a.indexOf('-p') + 1]
    const mcpOff = a.includes('--strict-mcp-config')
    const skillsOff = a.includes('--disable-slash-commands')
    const kind = call.cwd === '/repo' ? 'clean' : call.cwd?.includes('/threads/t9') ? 'thread' : call.cwd === '/h/lean-agent-desk' ? 'desk' : 'other'
    if (prompt === '/context') {
      const md = kind === 'clean' ? (opts.mcp ? CLEAN_CTX.replace('| Skills |', '| MCP tools | 9.0k | 0.9% |\n| Skills |') + '\n### MCP tools\n\n| Tool | Server | Tokens |\n|------|--------|--------|\n| mcp__db__query | db | ~900 |\n| mcp__db__list | db | ~700 |\n' : CLEAN_CTX) : THREAD_CTX
      return { exitCode: 0, stdout: ctxJson(md) }
    }
    const input = kind === 'clean' ? 38724 - (mcpOff ? 9000 : 0) - (skillsOff ? 6300 : 0) : kind === 'thread' ? 40906 : kind === 'desk' ? 40726 : 100
    return { exitCode: 0, stdout: runJson(input, { total_cost_usd: opts.costs ?? 0.002 }) }
  }
  return { h, seen }
}

test('overhead: clean (lean-agent switched off by settings), thread-shaped and desk columns; the report is saved by name with numbers only', async () => {
  const { h, seen } = setup({ installed: true, mcp: true })
  await h.host.fs.write(`${L}/proj/rules/a.md`, '# a\n')
  h.files.set(`${L}/proj/gaps.jsonl`, JSON.stringify({ text: 'had to count the open items by hand' }) + '\n')
  const r = await overhead(h.host, ROOT, 'proj')
  expect(r.ok).toBe(true)
  // the clean column: in the project folder, with every installed lean-agent key off and the env's plugin dirs emptied
  const clean = seen.find(s => s.cwd === '/repo' && s.args.includes('Reply with OK.') && !s.args.includes('--disable-slash-commands') && !s.args.includes('--strict-mcp-config'))!
  const settings = JSON.parse(clean.args[clean.args.indexOf('--settings') + 1]!)
  expect(settings).toEqual({ enabledPlugins: { 'lean-agent@mk': false } })
  expect(clean.env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '' })
  // the thread column: a thread-shaped folder (removed afterwards), a desk column in the desk folder; neither switched off
  const th = seen.find(s => s.cwd?.includes('/threads/t9') && s.args.includes('Reply with OK.'))!
  expect(th.args).not.toContain('--settings')
  expect(th.args).not.toContain('--plugin-dir') // installed: the plugin loads by itself
  expect(seen.some(s => s.cwd === '/h/lean-agent-desk' && s.args.includes('Reply with OK.'))).toBe(true)
  expect([...h.files.keys()].some(k => k.includes('/threads/t9'))).toBe(false)
  // every turn: one turn, json, a budget; /context is free (no budget flag)
  for (const s of seen.filter(x => x.args.includes('Reply with OK.'))) expect(s.args).toEqual(expect.arrayContaining(['--output-format', 'json', '--max-turns', '1', '--max-budget-usd']))
  expect(seen.find(s => s.args.includes('/context'))!.args).not.toContain('--max-budget-usd')
  // the table and attribution
  expect(r.text).toContain('| first-turn input (measured) | 38.7k | 40.9k | 40.7k |')
  expect(r.text).toContain('| skills (est.) | 6.3k | 7.6k | 7.6k |')
  expect(r.text).toContain('| custom agents (est.) | 0 | 429 | 429 |')
  expect(r.text).toContain('skills: 6.3k tokens (first turn 38.7k -> 32.4k with skills off)')
  expect(r.text).toContain('MCP servers: 9.0k tokens')
  // saved: <date>-<project>.md and one history line, names and numbers only, no contents, no home or project path
  const file = `${L}/compare/2026-11-18-proj.md`
  expect(h.files.get(file)).toBe(r.text.replace(/Saved: .*$/, '').replace(/\n$/, '\n'))
  expect(h.files.get(file)).not.toContain('SECRET-CONTENT')
  expect(h.files.get(file)).not.toContain('/repo')
  const hist = JSON.parse(h.files.get(`${L}/compare/history.jsonl`)!.trim())
  expect(hist).toMatchObject({ project: 'proj', mode: 'overhead', model: 'haiku', totals: { clean: 38724, thread: 40906, desk: 40726 }, file: '2026-11-18-proj.md' })
  expect(Object.keys(hist).sort()).toEqual(['cost', 'date', 'file', 'mode', 'model', 'project', 'skipped', 'totals'])
  // a second run the same day gets its own name
  await overhead(h.host, ROOT, 'proj')
  expect(h.files.has(`${L}/compare/2026-11-18-proj-2.md`)).toBe(true)
  expect(await historyText(h.host, 'proj')).toContain('proj overhead haiku: clean 38.7k · thread 40.9k · desk 40.7k')
})

test('overhead without an installed lean-agent loads the plugin folder for the thread and desk columns; missing flags are skipped, not guessed', async () => {
  const { h, seen } = setup({ installed: false, flags: '  --settings <x>\n  --plugin-dir <p>\n' })
  const r = await overhead(h.host, ROOT, 'proj')
  expect(r.ok).toBe(true)
  const th = seen.find(s => s.cwd?.includes('/threads/t9') && s.args.includes('Reply with OK.'))!
  expect(th.args).toEqual(expect.arrayContaining(['--plugin-dir', ROOT]))
  const clean = seen.find(s => s.cwd === '/repo' && s.args.includes('Reply with OK.'))!
  expect(clean.args).not.toContain('--settings') // nothing installed to switch off
  expect(clean.args).not.toContain('--max-budget-usd') // this claude has no such flag
  expect(seen.some(s => s.args.includes('--disable-slash-commands'))).toBe(false)
  expect(r.text).not.toContain('One source off')
})

test('the cap stops the runs that would exceed it and says which were not run', async () => {
  const { h } = setup({ costs: 0.2 })
  const r = await overhead(h.host, ROOT, 'proj', { maxUsd: 0.25 })
  expect(r.ok).toBe(true)
  expect(r.text).toMatch(/Not run \(cap reached or failed\): .*desk turn/)
})

test('a project that is unknown, private or without usage is refused plainly', async () => {
  const { h } = setup()
  expect((await overhead(h.host, ROOT, 'nope')).text).toContain('not registered')
  expect((await overhead(h.host, ROOT, 'secret')).text).toContain('private')
  expect((await overhead(h.host, ROOT, '../x')).ok).toBe(false)
  h.claude.handler = (a: string[]) => (a[0] === '--help' ? { exitCode: 0, stdout: HELP } : { exitCode: 1, stdout: '', stderr: 'not signed in' })
  const r = await overhead(h.host, ROOT, 'proj')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('the clean run gave no usage')
})

test('suggestions come from the numbers, each with the concrete step', async () => {
  const { h } = setup({ mcp: true })
  h.files.set(`${L}/proj/rules/a.md`, '# a\n')
  h.files.set(`${L}/proj/rules/b.md`, '# b\n')
  h.files.set(`${L}/proj/gaps.jsonl`, JSON.stringify({ text: 'find all packages that changed' }) + '\n' + JSON.stringify({ text: 'the retry limit' }) + '\n')
  const r = await overhead(h.host, ROOT, 'proj')
  const s = r.text.slice(r.text.indexOf('Suggestions:'))
  expect(s).toContain('a thread session starts at 40.9k tokens vs 38.7k clean; most of the difference: skills +1.3k, memory files +937')
  expect(s).toContain('a desk session starts at 40.7k tokens vs 38.7k clean')
  expect(s).toContain('MCP server db adds ~1.6k tokens (2 tools): add "mcp__db__*" to tools.thread.drop in ~/.lean-agent/config.json')
  expect(s).toContain('2 learned rule(s) never loaded (a.md, b.md): learn proj --trim')
  expect(s).toContain('1 gap(s) look like mechanical work: learn proj --trim lists them as script candidates')
  expect(s).toContain('adds ~310 tokens (2 skills) to every session')
  expect(s).toContain('enabledPlugins')
})

// ---- task mode -----------------------------------------------------------------------------------------------------
function taskHost() {
  const { h, seen } = setup({ installed: true })
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: HELP }
    seen.push({ args: a, cwd: call.cwd, env: call.env })
    const prompt = a[a.indexOf('-p') + 1]!
    if (prompt.startsWith('Two answers')) {
      // the judge: A is the clean answer when it is listed first
      const first = /ANSWER A:\n(\S+)/.exec(prompt)![1]
      const w = first === 'CLEAN-ANSWER' ? 'A' : 'B'
      return { exitCode: 0, stdout: runJson(1000, { result: JSON.stringify({ winner: w, reason: 'the first one names the retry limit (SECRET-REASON)' }), total_cost_usd: 0.01 }) }
    }
    const clean = call.cwd === '/repo'
    return { exitCode: 0, stdout: runJson(1000, { num_turns: clean ? 6 : 4, result: clean ? 'CLEAN-ANSWER about the code' : 'THREAD-ANSWER about the code', total_cost_usd: clean ? 0.3 : 0.2, usage: { input_tokens: 10, cache_read_input_tokens: clean ? 90000 : 50000, cache_creation_input_tokens: 0, output_tokens: 500 } }) }
  }
  return { h, seen }
}

test('task mode runs the same read-only task clean and thread-shaped on one model and effort, then a haiku judge; the report keeps numbers only', async () => {
  const { h, seen } = taskHost()
  const r = await taskMode(h.host, ROOT, 'proj', 'Which module owns retries?')
  expect(r.ok).toBe(true)
  const clean = seen.find(s => s.cwd === '/repo')!
  const th = seen.find(s => s.cwd?.includes('/threads/t9'))!
  for (const s of [clean, th]) {
    expect(s.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob']))
    expect(s.args).toContain('--max-budget-usd')
  }
  expect(clean.args[clean.args.indexOf('--settings') + 1]).toContain('"lean-agent@mk":false')
  expect(th.args).toEqual(expect.arrayContaining(['--add-dir', '/repo']))
  expect(th.args[th.args.indexOf('-p') + 1]).toContain('Work on the repository at /repo (use absolute paths; never cd)')
  const judge = seen.find(s => s.args[s.args.indexOf('-p') + 1]!.startsWith('Two answers'))!
  expect(judge.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '']))
  // numbers, verdict; the clock is even, so A is the clean answer and "A" means the clean run won
  expect(r.text).toContain('| tokens (all turns) | 90.5k | 50.5k |')
  expect(r.text).toContain('Judge (correctness and completeness only): clean.')
  expect(r.text).toContain('The thread used 44% fewer tokens than the clean run.')
  expect(r.text).toContain("Judge's reason (not saved): the first one names the retry limit (SECRET-REASON)")
  const file = `${L}/compare/2026-11-18-proj.md`
  const saved = h.files.get(file)!
  for (const bad of ['CLEAN-ANSWER', 'THREAD-ANSWER', 'SECRET-REASON', 'retries', 'Which module']) expect(saved).not.toContain(bad)
  const hist = JSON.parse(h.files.get(`${L}/compare/history.jsonl`)!.trim())
  expect(hist).toMatchObject({ mode: 'task', project: 'proj', model: 'sonnet', verdict: 'clean', clean: { tokens: 90510, turns: 6 }, thread: { tokens: 50510, turns: 4 } })
  expect(JSON.stringify(hist)).not.toContain('SECRET')
  expect([...h.files.keys()].some(k => k.includes('/threads/t9'))).toBe(false)
  expect(await historyText(h.host)).toContain('task sonnet: clean 90.5k tok $0.300 · thread 50.5k tok $0.200 · judge clean')
})

test('the judge sees the answers in an alternating order and the verdict is mapped back', async () => {
  const { h } = taskHost()
  h.clock.t += 1 // odd: the thread answer is A
  const r = await taskMode(h.host, ROOT, 'proj', 'Which module owns retries?')
  // the judge says "A is better" only when A is CLEAN-ANSWER; here A is the thread answer, so it answers B = clean
  expect(r.text).toContain('Judge (correctness and completeness only): clean.')
})

test('task mode needs a task, both runs and a registered project; the desk is told to use a thread', async () => {
  const { h } = taskHost()
  expect((await taskMode(h.host, ROOT, 'proj', '  ')).ok).toBe(false)
  expect((await compare(h.host, ROOT, { project: 'proj', mode: 'task', task: 'x' }, 'desk')).text).toContain('runs in a thread')
  h.claude.handler = (a: string[]) => (a[0] === '--help' ? { exitCode: 0, stdout: HELP } : { exitCode: 1, stdout: '' })
  const r = await taskMode(h.host, ROOT, 'proj', 'x')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('needs both runs')
  expect((await compare(h.host, ROOT, { mode: 'bogus', project: 'proj' }, 'desk')).ok).toBe(false)
  expect((await compare(h.host, ROOT, { mode: 'overhead' }, 'desk')).text).toContain('needs project')
})

// ---- the entry points --------------------------------------------------------------------------------------------
test('lean_doctor compare (desk) and lean_compare (thread) answer; history needs no claude run', async ($, on) => {
  resetLocks()
  const h = fakeHost(on)
  h.clock.t = Date.UTC(2026, 10, 18, 12)
  h.files.set(`${L}/compare/history.jsonl`, JSON.stringify({ date: '2026-11-17T09:00', project: 'proj', mode: 'overhead', model: 'haiku', totals: { clean: 38000, thread: 40000, desk: 41000 }, cost: 0.01, file: '2026-11-17-proj.md' }) + '\n')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  const d: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'compare', mode: 'history', project: 'proj' } as any)
  expect(String(d?.result ?? d)).toContain('proj overhead haiku: clean 38.0k · thread 40.0k · desk 41.0k')
  const t: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'compare' } as any)
  expect(String(t?.result ?? t)).toContain('needs project')
})

test('a thread asks lean_compare for history, and task mode from the desk is refused', async ($, on) => {
  resetLocks()
  const h = fakeHost(on)
  h.files.set(`${L}/compare/history.jsonl`, JSON.stringify({ date: '2026-11-17T09:00', project: 'proj', mode: 'task', model: 'sonnet', clean: { tokens: 90000, cost: 0.3 }, thread: { tokens: 50000, cost: 0.2 }, verdict: 'tie', cost: 0.5, file: 'x.md' }) + '\n')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_compare', mode: 'history' } as any)
  expect(String(r?.result ?? r)).toContain('proj task sonnet: clean 90.0k tok $0.300 · thread 50.0k tok $0.200 · judge tie')
})
