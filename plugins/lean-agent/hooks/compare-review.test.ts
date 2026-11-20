// compare: what the review found — privacy of the saved report, per-run budgets, runs that stop early, the temp folder, read-only task mode.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { overhead, redactor, scrub, shortName, taskMode } from './compare'

const L = '/h/.lean-agent'
const ROOT = '/plug'
const HELP = '  --max-budget-usd <amount>\n  --settings <x>\n  --plugin-dir <p>\n  --disable-slash-commands\n  --effort <level>\n  --tools <tools...>\n  --allowedTools <tools...>\n  --add-dir <dirs...>\n'
const runJson = (input: number, o: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, total_cost_usd: 0.002, result: 'OK', usage: { input_tokens: 2, cache_creation_input_tokens: input - 2, cache_read_input_tokens: 0, output_tokens: 4 }, modelUsage: { m: {} }, ...o })
const ctx = (extra: string) => JSON.stringify({ type: 'result', is_error: false, result: `## Context Usage\n\n**Model:** m  \n**Tokens:** 10k / 1m (1%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.9k | 0.3% |\n| Memory files | 3.1k | 0.3% |\n| Skills | 1k | 0.1% |\n\n${extra}` })
const MEMORY = '### Memory files\n\n| Memory | Source | Tokens |\n|--------|--------|--------|\n| /work/acme/CLAUDE.md | Project | ~1.8k |\n| /repo/CLAUDE.md | Project | ~900 |\n| /h/.claude/CLAUDE.md | User | ~400 |\n'

function setup() {
  const h = fakeHost(null)
  h.clock.t = Date.UTC(2026, 10, 18, 12)
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${ROOT}/templates/thread.md`, '# Thread {{id}}\n')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', '# desk')
  const seen: { args: string[]; cwd?: string }[] = []
  return { h, seen }
}

test('scrub, shortName and redactor keep folders out: whole path words only, every other absolute path cut to its last part', () => {
  expect(scrub('could not read /home/someone/work/acme/CLAUDE.md (denied)')).toBe('could not read …/CLAUDE.md (denied)')
  expect(scrub('timed out in /h/.lean-agent/threads/t9/x')).toBe('timed out in …/x')
  expect(scrub('no path here, 12/3 ratio')).toBe('no path here, 12/3 ratio')
  expect(scrub('see `/a/b/c.md` and [/x/y/z] and <</p/q/r> and {/m/n/o}')).toBe('see `…/c.md` and […/z] and <<…/r> and {…/o}')
  expect(scrub('open file:///a/b/c now')).toBe('open …/c now')
  expect(scrub('read /home/some user/x/y.md (denied)')).toBe('read …/y.md (denied)')
  expect(scrub('url https://host/a/b stays? and key=/p/q')).toBe('url https://host/a/b stays? and key=…/q')
  expect(shortName('/work/acme/CLAUDE.md')).toBe('…/CLAUDE.md')
  expect(shortName('CLAUDE.md')).toBe('CLAUDE.md')
  const r = redactor('/home/u', '/home/u/app')
  expect(r('/home/u/app/x and /home/u/app-secret/y and /home/u/.claude')).toBe('<project>/x and ~/app-secret/y and ~/.claude')
})

test('the saved report and history never carry a path: memory files above the project, in the home, in the project, and error text', async () => {
  const { h, seen } = setup()
  h.files.set('/repo/CLAUDE.md', 'SECRET-CONTENT')
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: HELP }
    seen.push({ args: a, cwd: call.cwd })
    if (a[a.indexOf('-p') + 1] === '/context') return { exitCode: 0, stdout: ctx(MEMORY) }
    if (call.cwd === '/h/lean-agent-desk') throw new Error('spawn failed in /home/someone/lean-agent-desk/x: ENOENT')
    return { exitCode: 0, stdout: runJson(30000) }
  }
  const r = await overhead(h.host, ROOT, 'proj')
  expect(r.ok).toBe(true)
  const md = h.files.get(`${L}/compare/2026-11-18-proj.md`)!
  for (const bad of ['/work/acme', '/repo', '/h/', '/home/someone', 'SECRET-CONTENT', 'acme']) expect(md).not.toContain(bad)
  expect(md).toContain('Memory files in clean: …/CLAUDE.md 1.8k (untracked), …/CLAUDE.md 900 (untracked), …/CLAUDE.md 400 (untracked)')
  expect(md).toContain('desk turn (spawn failed in …/x: ENOENT')
  expect(h.files.get(`${L}/compare/history.jsonl`)).not.toMatch(/\/work|\/repo|\/home/)
})

test('the temp thread folder is named so that no real thread number can collide, is removed, and a stale one is swept', async () => {
  const { h, seen } = setup()
  const stale = `${L}/threads/t9${Date.UTC(2026, 10, 18, 9)}123`
  const fresh = `${L}/threads/t9${Date.UTC(2026, 10, 18, 11, 59)}456`
  h.files.set(`${stale}/CLAUDE.md`, 'x')
  h.files.set(`${fresh}/CLAUDE.md`, 'x')
  h.files.set(`${L}/threads/t7/thread.json`, '{}')
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: HELP }
    seen.push({ args: a, cwd: call.cwd })
    return { exitCode: 0, stdout: a[a.indexOf('-p') + 1] === '/context' ? ctx('') : runJson(30000) }
  }
  await overhead(h.host, ROOT, 'proj')
  const th = seen.find(s => s.cwd?.includes('/threads/t9'))!
  expect(th.cwd!.slice(th.cwd!.lastIndexOf('/') + 1)).toMatch(/^t9\d{16}$/) // longer than any thread number: nextId ignores it
  expect([...h.files.keys()].filter(k => k.includes('/threads/t9') && !k.startsWith(fresh))).toEqual([]) // its own and the stale one are gone
  expect(h.files.has(`${fresh}/CLAUDE.md`)).toBe(true) // a recent one may belong to a run in progress
  expect(h.files.has(`${L}/threads/t7/thread.json`)).toBe(true)
})

// ---- task mode ---------------------------------------------------------------------------------------------------------
function taskSetup(handler?: (a: string[], call: any) => any, help = HELP) {
  const { h, seen } = setup()
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: help }
    seen.push({ args: a, cwd: call.cwd })
    if (handler) return handler(a, call)
    const prompt = a[a.indexOf('-p') + 1]!
    if (prompt.startsWith('Two answers')) return { exitCode: 0, stdout: runJson(500, { result: '{"winner":"tie","reason":"same"}', total_cost_usd: 0.01 }) }
    return { exitCode: 0, stdout: runJson(1000, { result: 'an answer', total_cost_usd: 0.4, num_turns: 3 }) }
  }
  return { h, seen }
}

test('task mode is only read-only when claude has --tools: without it the mode refuses and nothing runs', async () => {
  const { h, seen } = taskSetup(undefined, '  --max-budget-usd <x>\n  --allowedTools <t>\n')
  const r = await taskMode(h.host, ROOT, 'proj', 'who owns retries?')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('--tools')
  expect(seen.length).toBe(0)
})

test('a run that stopped at its turn limit or answered nothing is no answer: no judge, no verdict, and it says which', async () => {
  const stopped = taskSetup((a, call) => (call.cwd === '/repo' ? { exitCode: 0, stdout: runJson(1000, { is_error: true, subtype: 'error_max_turns', result: '', total_cost_usd: 0.2 }) } : { exitCode: 0, stdout: runJson(1000, { result: 'an answer', total_cost_usd: 0.2 }) }))
  const r = await taskMode(stopped.h.host, ROOT, 'proj', 'who owns retries?')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('the clean run stopped: error_max_turns')
  expect(stopped.seen.some(s => s.args[s.args.indexOf('-p') + 1]!.startsWith('Two answers'))).toBe(false)
  expect(stopped.h.files.has(`${L}/compare/history.jsonl`)).toBe(false)
  const empty = taskSetup((a, call) => ({ exitCode: 0, stdout: runJson(1000, { result: call.cwd === '/repo' ? 'fine' : '   ' }) }))
  expect((await taskMode(empty.h.host, ROOT, 'proj', 'x')).text).toContain('the thread run gave no answer')
})

test('a run killed by its timeout counts at its full budget, and then no second run is paid for', async () => {
  const { h, seen } = taskSetup(() => {
    throw new Error('timed out')
  })
  const r = await taskMode(h.host, ROOT, 'proj', 'x', { maxUsd: 1 })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('the clean run gave no result')
  expect(r.text).toContain('cost so far $1.000') // the killed run counts at its $1 budget
  expect(seen.some(s => s.cwd?.includes('/threads/t9'))).toBe(false) // the first run failed: nothing more to spend
  expect(h.files.has(`${L}/compare/history.jsonl`)).toBe(false)
})

test('the thread run keeps its own full budget when the clean run was cheap; a failed thread run is reported with its cost', async () => {
  const { h, seen } = taskSetup((a, call) => (call.cwd === '/repo' ? { exitCode: 0, stdout: runJson(1000, { result: 'fine', total_cost_usd: 0.1 }) } : { exitCode: 0, stdout: runJson(1000, { subtype: 'error_max_budget_usd', is_error: false, result: 'partial', total_cost_usd: 1 }) }))
  const r = await taskMode(h.host, ROOT, 'proj', 'x', { maxUsd: 1 })
  const th = seen.find(s => s.cwd?.includes('/threads/t9'))!
  expect(th.args[th.args.indexOf('--max-budget-usd') + 1]).toBe('1')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('the thread run stopped: error_max_budget_usd') // a limit hit with is_error false is still a stop
  expect(r.text).toContain('cost so far $1.100')
})

test('a path in a failed run\'s error text never reaches the report: the project and home go first, then every other path is cut', async () => {
  const { h } = setup()
  h.claude.handler = (a: string[], call: any) => {
    if (a[0] === '--help') return { exitCode: 0, stdout: HELP }
    if (a[a.indexOf('-p') + 1] === '/context') return { exitCode: 0, stdout: ctx('') }
    if (call.cwd === '/h/lean-agent-desk') throw new Error('cannot start in /repo/sub/dir and /h/.claude/x and /work/acme/other')
    return { exitCode: 0, stdout: runJson(30000) }
  }
  await overhead(h.host, ROOT, 'proj')
  const md = h.files.get(`${L}/compare/2026-11-18-proj.md`)!
  expect(md).toContain('desk turn (cannot start in …/other') // (a path may hold spaces, so a run of paths and words collapses to its last component: over-cut, never under-cut)
  for (const bad of ['/repo', '/h/', '/work', 'acme', 'sub']) expect(md).not.toContain(bad)
})

test('the judge runs in a folder that exists (made before it), on haiku with no tools and its own small budget', async () => {
  const { h, seen } = taskSetup()
  const r = await taskMode(h.host, ROOT, 'proj', 'who owns retries?')
  expect(r.ok).toBe(true)
  const judgeAt = h.calls.findIndex(c => c.argv[0] === 'claude' && String(c.argv[c.argv.indexOf('-p') + 1]).startsWith('Two answers'))
  const mkAt = h.calls.findIndex(c => c.argv[0] === 'mkdir' && c.argv.includes(`${L}/compare`))
  expect(mkAt).toBeGreaterThanOrEqual(0)
  expect(mkAt).toBeLessThan(judgeAt)
  const j = seen.find(s => s.args[s.args.indexOf('-p') + 1]!.startsWith('Two answers'))!
  expect(j.cwd).toBe(`${L}/compare`)
  const at = (f: string) => j.args[j.args.indexOf(f) + 1]
  expect([at('--model'), at('--tools'), at('--max-budget-usd'), at('--max-turns')]).toEqual(['haiku', '', '0.1', '1'])
})

test('a task that starts with a slash is not a slash command in either run', async () => {
  const { h, seen } = taskSetup()
  await taskMode(h.host, ROOT, 'proj', '/context please')
  for (const s of seen.filter(x => x.cwd === '/repo' || x.cwd?.includes('/threads/t9'))) expect(s.args[s.args.indexOf('-p') + 1]!.startsWith('/')).toBe(false)
})
