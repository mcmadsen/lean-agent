// The mod as the rule loader for threads (ruleload.ts): the engine loads a project's rules only beneath the session root, so a thread
// (root = its own folder, project read by absolute path) gets them from the store through the tool results.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { MAX_COMPILED, MAX_INJECT_RULE, compiledCount, gitReads, markNative, pathsOfCall, projectRule, resetContext, resetRuleLoader, ruleContext } from './ruleload'

const L = '/h/.lean-agent'
const rule = (paths: string[], body: string) => `${paths.length ? `---\npaths:\n${paths.map(p => `  - "${p}"`).join('\n')}\n---\n` : ''}${body}\n<!-- lean-agent: learned abc 2026-01-01 -->\n`
const who = { session: 'sid1', agent: '', thread: 't1' }

function setup(on: any = null) {
  resetRuleLoader()
  const h = fakeHost(on)
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${L}/proj/rules/billing.md`, rule(['services/billing/**'], '# billing\n- use LedgerRow'))
  h.files.set(`${L}/proj/rules/web.md`, rule(['apps/web/**/*.ts', 'apps/web/package.json'], '# web\n- pnpm --filter web test'))
  h.files.set(`${L}/proj/rules/_project.md`, '# project\n- build with pnpm\n')
  h.git.handler = a => (a[0] === 'worktree' ? { exitCode: 0, stdout: 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /wt/feat\nHEAD b\ndetached\n' } : { exitCode: 1, stdout: '' })
  return h
}
const logRows = (h: ReturnType<typeof setup>) => (h.files.get(`${L}/logs/rules-loaded.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

test('a Read of a file in the project from a session rooted elsewhere gets the matching rule and _project once, and logs each load', async () => {
  const h = setup()
  const t = await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })
  expect(t).toContain('rule proj/billing.md (for services/billing/**):\n# billing\n- use LedgerRow')
  expect(t).toContain('rule proj/_project.md')
  expect(t).not.toContain('# web')
  expect(t).not.toContain('lean-agent: learned') // the footer comment is not injected
  expect(logRows(h).map(r => [r.rule, r.project, r.session, r.thread, r.trigger, r.src])).toEqual([['_project.md', 'proj', 'sid1', 't1', 'Read', 'loader'], ['billing.md', 'proj', 'sid1', 't1', 'Read', 'loader']])
  expect(logRows(h)[0].ts).toBe(Math.floor(h.clock.t / 1000))
  // once per session: the same area again and another file of it give nothing
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/b.ts' })).toBeNull()
  expect(logRows(h)).toHaveLength(2)
  // another area adds only its own rule
  const w = await ruleContext(h.host, who, 'Read', { file_path: '/repo/apps/web/src/x.ts' })
  expect(w).toContain('rule proj/web.md')
  expect(w).not.toContain('billing')
  expect(w).not.toContain('_project')
  // a file no rule covers, and one outside every project: nothing
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/docs/readme.md' })).toBeNull()
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/elsewhere/services/billing/a.ts' })).toBeNull()
  // a tool the loader does not watch, a relative path
  expect(await ruleContext(h.host, who, 'WebFetch', { url: 'https://x' })).toBeNull()
  expect(await ruleContext(h.host, who, 'Read', { file_path: 'services/billing/a.ts' })).toBeNull()
})

test('a subagent has its own context: it gets the rules again (once), and its first tool call carries _project whatever it touches', async () => {
  const h = setup()
  await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' }, { threadProject: 'proj' })
  const sub = { ...who, agent: 'ag1' }
  const first = await ruleContext(h.host, sub, 'Bash', { command: 'git status' }, { threadProject: 'proj' }) // not a project path at all
  expect(first).toContain('rule proj/_project.md')
  expect(await ruleContext(h.host, sub, 'Bash', { command: 'git log' }, { threadProject: 'proj' })).toBeNull()
  const r = await ruleContext(h.host, sub, 'Read', { file_path: '/repo/services/billing/a.ts' }, { threadProject: 'proj' })
  expect(r).toContain('rule proj/billing.md')
  expect(r).not.toContain('_project') // it already has it
  expect(await ruleContext(h.host, sub, 'Read', { file_path: '/repo/services/billing/c.ts' }, { threadProject: 'proj' })).toBeNull()
  expect(logRows(h).filter(x => x.agent === 'ag1').map(x => x.rule)).toEqual(['_project.md', 'billing.md'])
})

test('built-in read-only shell commands and Grep/Glob of a folder inside a rule\'s area load it; a repo-wide search does not dump every rule', async () => {
  const h = setup()
  expect(await ruleContext(h.host, who, 'Bash', { command: 'cat /repo/services/billing/a.ts | head -20' })).toContain('billing.md')
  expect(await ruleContext(h.host, who, 'Bash', { command: 'rg "LedgerRow" /repo/apps/web' })).toContain('web.md') // a folder inside the area
  const h2 = setup()
  const repoWide = await ruleContext(h2.host, who, 'Bash', { command: 'rg TODO /repo' })
  expect(repoWide).toContain('_project.md')
  expect(repoWide).not.toContain('billing.md')
  expect(repoWide).not.toContain('web.md')
  expect(await ruleContext(h2.host, who, 'Grep', { pattern: 'x', path: '/repo/services/billing' })).toContain('billing.md')
  expect(await ruleContext(h2.host, who, 'Bash', { command: 'npm run build /repo/apps/web' })).toBeNull() // not a read-only reader
  expect(pathsOfCall('Read', { file_path: '/repo/../etc/passwd' }).paths).toEqual([]) // a `..` spelling is never placed inside a project
  expect(pathsOfCall('Bash', { command: 'cat /repo/x/../../etc/y' }).paths).toEqual([])
  expect(pathsOfCall('Bash', { command: 'ls "/repo/apps/web/*.ts" /tmp/x && cat /repo/a' }).paths).toEqual(['/repo/apps/web', '/tmp/x', '/repo/a'])
})

test('files of a worktree of the project (a plain git worktree add one too) get the rules; the engine\'s own load is never repeated', async () => {
  const h = setup()
  const t = await ruleContext(h.host, who, 'Read', { file_path: '/wt/feat/services/billing/a.ts' })
  expect(t).toContain('billing.md')
  const g = setup()
  g.files.set('/repo/.claude/rules/lean-agent/billing.md', g.files.get(`${L}/proj/rules/billing.md`)!) // the synced copy
  await markNative(g.host, '/repo/.claude/rules/lean-agent/billing.md') // InstructionsLoaded for it
  const r = await ruleContext(g.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })
  expect(r).not.toContain('billing.md') // the engine gave it: not injected twice
  expect(r).toContain('_project.md')
  // a session rooted in the checkout leaves its own files to the engine
  const e = setup()
  expect(await ruleContext(e.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' }, { engineRoot: '/repo' })).toBeNull()
  expect(await ruleContext(e.host, who, 'Read', { file_path: '/wt/feat/services/billing/a.ts' }, { engineRoot: '/repo' })).toContain('billing.md') // another checkout is not beneath the root
})

test('a rule changed in the store is given again (the key is rule + sha); a rule over the size cap is cut; a rule with no paths loads on the first touch', async () => {
  const h = setup()
  h.files.set(`${L}/proj/rules/always.md`, rule([], '# always\n- no paths here'))
  const a = await ruleContext(h.host, who, 'Read', { file_path: '/repo/docs/readme.md' })
  expect(a).toContain('always.md')
  h.files.set(`${L}/proj/rules/billing.md`, rule(['services/billing/**'], '# billing\n- ' + 'x'.repeat(MAX_INJECT_RULE + 500)))
  h.clock.t += 20_000 // past the rule cache
  const b = await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })
  expect(b).toContain('(cut: billing.md is over the size cap')
  expect(b!.length).toBeLessThan(MAX_INJECT_RULE + 700)
  h.files.set(`${L}/proj/rules/billing.md`, rule(['services/billing/**'], '# billing\n- new text'))
  h.clock.t += 20_000
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })).toContain('new text')
})

test('after a compaction the rules may be given again (the session\'s, or one subagent\'s), but _project.md stays: it is a prompt section', async () => {
  const h = setup()
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })).toContain('billing.md')
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/b.ts' })).toBeNull()
  await resetContext(h.host, '', 'proj')
  const again = await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/b.ts' })
  expect(again).toContain('billing.md')
  expect(again).not.toContain('_project') // still in its section
  // a subagent's own context is reset on its own, the session's is untouched
  const sub = { ...who, agent: 'ag1' }
  await ruleContext(h.host, sub, 'Read', { file_path: '/repo/services/billing/a.ts' })
  await resetContext(h.host, 'ag1')
  expect(await ruleContext(h.host, sub, 'Read', { file_path: '/repo/services/billing/a.ts' })).toContain('billing.md')
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/a.ts' })).toBeNull()
})

test('rules the size budget cuts are not marked given: a later call in the area delivers them', async () => {
  const h = setup()
  const big = (n: string) => rule(['big/**'], `# ${n}\n- ` + 'z'.repeat(3900)) // 3 of them do not fit MAX_INJECT_TOTAL (9000) with _project
  h.files.set(`${L}/proj/rules/big1.md`, big('one'))
  h.files.set(`${L}/proj/rules/big2.md`, big('two'))
  h.files.set(`${L}/proj/rules/big3.md`, big('three'))
  const a = await ruleContext(h.host, who, 'Read', { file_path: '/repo/big/x.ts' })
  expect(a).toContain('more rules matched')
  const first = (a!.match(/rule proj\/(big\d)/g) ?? []).length
  expect(first).toBeLessThan(3)
  expect(logRows(h).filter(r => /^big/.test(r.rule))).toHaveLength(first) // only what was delivered is logged
  const b = await ruleContext(h.host, who, 'Read', { file_path: '/repo/big/y.ts' })
  expect((b!.match(/rule proj\/(big\d)/g) ?? []).length + first).toBeGreaterThanOrEqual(3)
})

test('globs are compiled once per rule file and bounded; a pattern over the caps never matches (and no other pattern of the rule is lost)', async () => {
  const h = setup()
  const real = globalThis.RegExp
  let made = 0
  // count the regular expressions built for the globs of a read: the second read of the same files builds none
  const Counting: any = function (this: any, ...a: any[]) { made++; return new real(a[0], a[1]) }
  Counting.prototype = real.prototype
  await ruleContext(h.host, who, 'Read', { file_path: '/repo/services/billing/warm.ts' }) // reads the rule files (and compiles)
  ;(globalThis as any).RegExp = Counting
  try {
    for (let i = 0; i < 20; i++) await ruleContext(h.host, { ...who, agent: `a${i}` }, 'Read', { file_path: `/repo/apps/web/src/${i}.ts` })
  } finally {
    ;(globalThis as any).RegExp = real
  }
  expect(made).toBeLessThan(10) // uncached it is one per glob and call (20 calls, 3 globs): 60 and more
  // over the caps: 5 `**`, 300 characters, 5 brace groups, 17 commas; the rule's other, normal pattern still matches
  const bad = ['a/**/b/**/c/**/d/**/e/**/f', `x/${'y'.repeat(300)}/*.ts`, '{a,b}/{a,b}/{a,b}/{a,b}/{a,b}', 'k/{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r}/*']
  h.files.set(`${L}/proj/rules/odd.md`, rule([...bad, 'odd/*.ts'], '# odd\n- careful'))
  h.clock.t += 60_000 // past the rules' 15 s cache
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/a/1/b/2/c/3/d/4/e/5/f' })).toBeNull() // `**` x5 would have matched
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/a/b/c/d/e/x.ts' })).toBeNull()
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/k/a/z' })).toBeNull()
  expect(await ruleContext(h.host, who, 'Read', { file_path: '/repo/odd/x.ts' })).toContain('rule proj/odd.md')
  // loose (a folder named in a shell command) never counts an over-cap pattern's prefix either
  const bigPrefix = ['p/**/a/**/b/**/c/**/d/**/e']
  h.files.set(`${L}/proj/rules/pre.md`, rule(bigPrefix, '# pre'))
  h.clock.t += 60_000
  expect(await ruleContext(h.host, { ...who, agent: 'z' }, 'Bash', { command: 'ls /repo/p' })).not.toContain('proj/pre.md')
})

test('the compiled-glob map is bounded: past MAX_COMPILED rule files the oldest entry goes', async () => {
  const h = setup()
  for (let i = 0; i < MAX_COMPILED + 20; i++) h.files.set(`${L}/proj/rules/r${String(i).padStart(3, '0')}.md`, rule([`dir${i}/**`], `# r${i}`))
  await ruleContext(h.host, who, 'Read', { file_path: '/repo/dir1/x.ts' })
  expect(compiledCount()).toBeLessThanOrEqual(MAX_COMPILED)
  expect(compiledCount()).toBe(MAX_COMPILED)
})

test('projectRule: _project.md once per context, nothing for a project without one', async () => {
  const h = setup()
  expect(await projectRule(h.host, who, 'proj', 'session.start')).toContain('build with pnpm')
  expect(await projectRule(h.host, who, 'proj', 'session.start')).toBeNull()
  expect(await projectRule(h.host, who, 'nope', 'session.start')).toBeNull()
  expect(await projectRule(h.host, who, '../x', 'session.start')).toBeNull()
  expect(logRows(h).map(r => r.trigger)).toEqual(['session.start'])
})

// ---- through the real mod: a thread session ---------------------------------------------------------------------------
async function thread($: any, on: any, tool: (e: any) => any, more: (h: ReturnType<typeof setup>) => void = () => {}) {
  const h = setup(on)
  more(h)
  on('tool.call', (_: any, e: any) => tool(e))
  on('prompt.submit', (_: any, e: any) => e)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as any)
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('agent.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/h/.lean-agent/threads/t1' }))
  on('session.root', () => ({ value: '/h/.lean-agent/threads/t1' }))
  on('session.id', () => ({ value: 'sid-1' }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  // what the model gets before its first work: the session sections, and the first prompt's context
  const sections = async () => JSON.stringify(((await $.prompt.compose({ model: 'haiku', promptModel: 'haiku', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)) as any).sections)
  let first: string | undefined
  const firstPrompt = async () => (first ??= JSON.stringify(((await $.prompt.submit({ text: 'go' } as any)) as any).context ?? []))
  return { h, sections, firstPrompt }
}

test('a thread session: _project.md is in its first context, a Read of a project file returns the rule, the sync counts and logs it', async ($, on) => {
  const s = await thread($, on, () => ({ result: 'file text' }))
  expect(await s.sections()).toContain('build with pnpm') // _project.md: a session section from the start
  expect(s.h.files.get('/repo/.claude/rules/lean-agent/billing.md')).toContain('LedgerRow') // synced into the checkout
  const r: any = await $.tool.call({ tool: 'Read', file_path: '/repo/services/billing/a.ts' } as any)
  expect(JSON.stringify(r)).toContain('rule proj/billing.md')
  expect(JSON.stringify(r)).not.toContain('build with pnpm') // already given at the start
  const again: any = await $.tool.call({ tool: 'Read', file_path: '/repo/services/billing/b.ts' } as any)
  expect(JSON.stringify(again)).not.toContain('billing.md')
  const rows = (s.h.files.get('/h/.lean-agent/logs/rules-loaded.jsonl') ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(rows.map(x => `${x.rule}:${x.trigger}`)).toEqual(['_project.md:session.start', 'billing.md:Read'])
  expect(rows.every(x => x.session === 'sid-1' && x.thread === 't1' && x.project === 'proj')).toBe(true)
})

test('a thread session: a rule over the cap is named in the first context line and still copied, never silently dropped', async ($, on) => {
  const s = await thread($, on, () => ({ result: 'x' }), h => {
    h.files.set(`${L}/proj/rules/fat.md`, rule(['fat/**'], Array.from({ length: 12 }, () => '- ' + 'x'.repeat(190)).join('\n')))
    h.files.set('/repo/.claude/rules/lean-agent/old-only.md', 'a copy whose store file is gone')
  })
  const text = await s.firstPrompt() // `session.start` has no context: it is the first prompt's
  expect(text).toContain('rules: 0 skipped (over cap), 1 over the cap but loaded anyway (fat.md); run learn --trim or lean_rules check')
  expect(s.h.files.has('/repo/.claude/rules/lean-agent/fat.md')).toBe(true)
  expect(s.h.files.has('/repo/.claude/rules/lean-agent/old-only.md')).toBe(false)
})

// ---- read-only git commands: repo-relative paths ------------------------------------------------------------------------------------
test('gitReads: -C <repo> show|grep|diff|log -p|blame with <rev>:<path>, `--` paths and bare file names; the repo of a plain command is the cwd', () => {
  const g = (c: string, cwd?: string) => gitReads(c, cwd)
  expect(g('git -C /repo show abc123:services/billing/a.ts')).toEqual({ paths: ['/repo/services/billing/a.ts'], repos: ['/repo'] })
  expect(g('git -C /repo --no-pager grep -n LedgerRow -- services/billing apps/web').paths).toEqual(['/repo/services/billing', '/repo/apps/web'])
  expect(g('git -C /repo grep LedgerRow services/billing/a.ts').paths).toEqual(['/repo/services/billing/a.ts']) // the first argument is the pattern
  expect(g('git -C /repo diff main...HEAD -- apps/web/src/x.ts').paths).toEqual(['/repo/apps/web/src/x.ts'])
  expect(g('git -C /repo diff main...HEAD apps/web/src/x.ts').paths).toEqual(['/repo/apps/web/src/x.ts']) // a range is no path
  expect(g('git -C /repo log -p -- "services/billing/a.ts"').paths).toEqual(['/repo/services/billing/a.ts'])
  expect(g('git -C /repo blame -L1,5 services/billing/a.ts').paths).toEqual(['/repo/services/billing/a.ts'])
  expect(g('git show abc123:apps/web/package.json', '/repo')).toEqual({ paths: ['/repo/apps/web/package.json'], repos: ['/repo'] })
  expect(g('git show abc123:apps/web/package.json')).toEqual({ paths: [], repos: [] }) // no -C, no cwd: no repo to resolve against
  expect(g('cd /repo && git show HEAD:services/billing/a.ts | head').paths).toEqual(['/repo/services/billing/a.ts'])
  expect(g('git -C /repo -c core.pager=cat show HEAD:a/b.ts').paths).toEqual(['/repo/a/b.ts'])
  expect(g('git -C /repo/sub show HEAD:a/b.ts').paths).toEqual(['/repo/sub/a/b.ts'])
  // not reads, and `..` is never placed inside a project
  for (const c of ['git -C /repo status', 'git -C /repo commit -m x -- a/b.ts', 'git -C /repo push origin HEAD:main', 'git -C /repo add a/b.ts', 'echo git show a:b/c.ts']) expect(g(c).paths).toEqual([])
  expect(g('git -C /repo show HEAD:../etc/passwd').paths).toEqual([])
  expect(g('git -C /repo/../etc show HEAD:a/b.ts')).toEqual({ paths: [], repos: [] })
  expect(g('git -C ../x show HEAD:a/b.ts', '/repo').paths).toEqual([])
  expect(g(Array.from({ length: 12 }, (_, n) => `git -C /repo show HEAD:f${n}/a.ts`).join(' ; ')).paths.length).toBe(8) // capped like the absolute scan
  // the old absolute-path scan is unchanged for other commands
  expect(pathsOfCall('Bash', { command: 'cat /repo/a' }).paths).toEqual(['/repo/a'])
  expect(pathsOfCall('Bash', { command: 'echo /repo/a' })).toEqual({ paths: [], loose: true, repos: [] })
})

test('a git show / grep / diff / log -p of a project file loads the rules of its area once, a plain `git show` from the worktree too', async () => {
  const h = setup()
  const a = await ruleContext(h.host, who, 'Bash', { command: 'git -C /repo show abc123:services/billing/a.ts' })
  expect(a).toContain('rule proj/billing.md')
  expect(a).toContain('_project.md')
  expect(a).not.toContain('# web')
  expect(await ruleContext(h.host, who, 'Bash', { command: 'git -C /repo show def456:services/billing/b.ts' })).toBeNull() // once
  const w = await ruleContext(h.host, who, 'Bash', { command: 'git -C /repo grep -n x -- apps/web' }) // a folder of the area (loose)
  expect(w).toContain('rule proj/web.md')
  const h2 = setup()
  expect(await ruleContext(h2.host, who, 'Bash', { command: 'git -C /repo diff main...HEAD -- services/billing/a.ts' })).toContain('billing.md')
  const h3 = setup()
  expect(await ruleContext(h3.host, who, 'Bash', { command: 'git -C /repo log -p -- apps/web/src/x.ts' })).toContain('web.md')
  const h4 = setup()
  const plain = await ruleContext(h4.host, who, 'Bash', { command: 'git show abc123:services/billing/a.ts' }, { cwd: '/wt/feat' }) // in a worktree of the project
  expect(plain).toContain('billing.md')
  expect(logRows(h4).map(r => r.trigger)).toContain('Bash')
  // a worktree path is placed in its project by the checkouts list, the same as for a Read
  expect(await ruleContext(setup().host, who, 'Bash', { command: 'git show abc123:services/billing/a.ts' }, { cwd: '/elsewhere' })).toBeNull()
  expect(await ruleContext(setup().host, who, 'Bash', { command: 'git show abc123:services/billing/a.ts' })).toBeNull() // no cwd, no -C
})

test('git commands that are not reads, or that leave every project, load nothing', async () => {
  const h = setup()
  for (const command of ['git -C /repo status', 'git -C /repo commit -m x', 'git -C /repo push origin HEAD:services/billing', 'git -C /repo add services/billing/a.ts', 'git -C /elsewhere show abc:services/billing/a.ts', 'git -C /repo show HEAD:../services/billing/a.ts'])
    expect(await ruleContext(h.host, who, 'Bash', { command })).toBeNull()
})

test('the reviewer role: the checkout itself counts, so a path-less `git diff`/`git show` gets _project and the repo-wide rules once; others do not', async () => {
  const h = setup()
  h.files.set(`${L}/proj/rules/all.md`, rule(['**'], '# all\n- every change needs a changelog line'))
  const sub = { ...who, agent: 'rev1' }
  const t = await ruleContext(h.host, sub, 'Bash', { command: 'git -C /repo show abc123' }, { repoCounts: true })
  expect(t).toContain('rule proj/_project.md')
  expect(t).toContain('rule proj/all.md')
  expect(t).not.toContain('billing.md')
  expect(await ruleContext(h.host, sub, 'Bash', { command: 'git -C /repo log --oneline' }, { repoCounts: true })).toBeNull() // once per context
  // a path-scoped rule still needs its path
  expect(await ruleContext(h.host, sub, 'Bash', { command: 'git -C /repo diff main...HEAD -- services/billing/a.ts' }, { repoCounts: true })).toContain('billing.md')
  // not the reviewer: a `git show` with no path touches nothing (the repo is not counted)
  const o = setup()
  o.files.set(`${L}/proj/rules/all.md`, rule(['**'], '# all\n- x'))
  expect(await ruleContext(o.host, { ...who, agent: 'wk1' }, 'Bash', { command: 'git -C /repo show abc123' })).toBeNull()
  expect(await ruleContext(o.host, { ...who, agent: 'wk1' }, 'Bash', { command: 'git -C /repo log --oneline' })).toBeNull()
})
