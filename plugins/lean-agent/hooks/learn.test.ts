// 1.0.6 learn flow: size budget, check (dry run), record, relies-on, covered-by, verify, stale scaling, sync all.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { MAX_PROJECT_CHARS, MAX_RULE_CHARS, checkRules, checkStale, globRe, parseRelies, pathsOf, recordRule, ruleMetrics, ruleProblems, staleLimit, syncAll, tokensOf, verifyRules, withRelies } from './rules'
import { addGap } from './rules'
import { threadTool } from './delivery'

const SRC = '/h/.lean-agent/proj'
const fm = (paths = 'services/billing/**') => `---\npaths:\n  - "${paths}"\n---\n`
const rule = (body: string, footer = '<!-- lean-agent: learned abc 2026-01-01 sources: services/billing/** -->\n') => `${fm()}# billing\n${body}\n${footer}`
const lines = (n: number, w = 10) => Array.from({ length: n }, (_, i) => `- ${String(i).padStart(w - 2, 'x')}`).join('\n')
function setup() {
  const h = fakeHost(null)
  h.git.handler = a => (a[0] === 'rev-parse' ? { exitCode: 0, stdout: '/repo/.git\n' } : { exitCode: 1, stdout: '' })
  return h
}

test('metrics count non-empty body lines and chars; frontmatter, footer and blank lines are free', () => {
  const m = ruleMetrics(rule('- a\n\n- bb\n'))
  expect(m.lines).toBe(3) // the heading and two bullets
  expect(m.chars).toBe('# billing\n- a\n- bb'.length)
  expect(ruleMetrics('---\npaths:\n  - x\n---\n<!-- c -->\n').lines).toBe(0)
})

test('size budget: chars per rule, chars for _project, line width', () => {
  expect(ruleProblems('a.md', rule(lines(10, 10)))).toEqual([])
  const fat = rule(Array.from({ length: 12 }, () => '- ' + 'x'.repeat(190)).join('\n'))
  expect(ruleMetrics(fat).chars).toBeGreaterThan(MAX_RULE_CHARS)
  expect(ruleProblems('a.md', fat).some(p => p.includes(`more than ${MAX_RULE_CHARS} characters`))).toBe(true)
  expect(ruleProblems('_project.md', '# p\n' + Array.from({ length: 6 }, () => '- ' + 'y'.repeat(110)).join('\n')).some(p => p.includes(`more than ${MAX_PROJECT_CHARS} characters`))).toBe(true)
  expect(ruleProblems('a.md', rule('- ' + 'z'.repeat(250))).some(p => p.includes('characters wide'))).toBe(true)
})

test('sync skips a rule over the char cap or with a wide line and says why', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/fat.md`, rule(Array.from({ length: 12 }, () => '- ' + 'x'.repeat(190)).join('\n')))
  h.files.set(`${SRC}/rules/wide.md`, rule('- ' + 'z'.repeat(250)))
  h.files.set(`${SRC}/rules/ok.md`, rule('- fine'))
  const r = await syncAll(h.host, 'proj', '/repo', false)
  expect(h.files.has('/repo/.claude/rules/lean-agent/ok.md')).toBe(true)
  expect(h.files.has('/repo/.claude/rules/lean-agent/fat.md')).toBe(false)
  expect(r.lines.join('\n')).toContain('fat.md: more than 2000 characters')
  expect(r.lines.join('\n')).toContain('wide.md: a line is 252 characters wide')
})

test('check is a dry run: lines and chars per rule, violations, no paths warning, covered and missing areas; nothing is copied', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/big.md`, rule(lines(26)))
  h.files.set(`${SRC}/rules/ok.md`, rule(lines(3)))
  h.files.set(`${SRC}/rules/loose.md`, '# loose\n- x\n')
  h.files.set(`${SRC}/rules/_project.md`, '# p\n- pnpm test\n')
  await recordRule(h.host, 'proj', 'docs-area', { globs: ['docs/**'], sha: 's', coveredBy: 'docs/README.md' })
  await recordRule(h.host, 'proj', 'ghost', { globs: ['g/**'], sha: 's' })
  const c = await checkRules(h.host, 'proj', 3)
  const t = c.lines.join('\n')
  expect(c.over).toBe(1)
  expect(t).toContain('limits: rule <= 25 lines / 2000 chars, _project <= 10 lines / 600 chars')
  expect(t).toContain('<= 3 explorers')
  expect(t).toMatch(/big\.md: 27\/25 lines, \d+\/2000 chars, widest \d+ OVER: more than 25 lines \(27\)/)
  expect(t).toMatch(/ok\.md: 4\/25 lines.* ok/)
  expect(t).toContain('loose.md: 2/25 lines, 11/2000 chars, widest 7 WARN: no paths')
  expect(t).toContain('_project.md: 2/10 lines')
  expect(t).toContain('docs-area: covered by docs/README.md (no rule)')
  expect(t).toContain('ghost: recorded but rules/ghost.md is missing')
  expect([...h.files.keys()].some(k => k.startsWith('/repo/'))).toBe(false)
})

test('record counts lines from the file, reports a differing caller value, writes relies-on into the footer', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule(lines(4)))
  const msg = await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abcdef1234', lines: 99, relies: ['services/billing/db.ts', 'LedgerRow'] })
  expect(msg).toContain('5 lines')
  expect(msg).toContain('caller said 99, the file has 5')
  expect(msg).toContain('relies-on 2')
  const learn = JSON.parse(h.files.get(`${SRC}/learn.json`)!)
  expect(learn.areas.billing.lines).toBe(5)
  expect(learn.areas.billing.relies).toEqual(['services/billing/db.ts', 'LedgerRow'])
  const file = h.files.get(`${SRC}/rules/billing.md`)!
  expect(parseRelies(file)).toEqual(['services/billing/db.ts', 'LedgerRow'])
  expect(file).toContain('sources: services/billing/** relies-on: services/billing/db.ts, LedgerRow -->')
  // a second record replaces the list, not appends
  await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'x', relies: ['Other'] })
  expect(parseRelies(h.files.get(`${SRC}/rules/billing.md`)!)).toEqual(['Other'])
  // no relies given: the footer's list is read back
  await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'y' })
  expect(JSON.parse(h.files.get(`${SRC}/learn.json`)!).areas.billing.relies).toEqual(['Other'])
})

test('record: over-cap warns, a missing file warns, a footer is made when there is none, covered areas have no file', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/big.md`, rule(lines(30)))
  expect(await recordRule(h.host, 'proj', 'big', { globs: ['a/**'], sha: 's' })).toContain('WARNING over the cap, sync will skip it: more than 25 lines')
  expect(await recordRule(h.host, 'proj', 'none', { globs: ['a/**'], sha: 's' })).toContain('rules/none.md does not exist')
  h.files.set(`${SRC}/rules/bare.md`, '# bare\n- x\n')
  await recordRule(h.host, 'proj', 'bare', { globs: ['a/**'], sha: 'deadbeef00', relies: ['a/x.ts'] })
  expect(h.files.get(`${SRC}/rules/bare.md`)).toContain('<!-- lean-agent: learned deadbeef')
  expect(await recordRule(h.host, 'proj', 'api', { globs: ['api/**'], sha: 's', coveredBy: 'api/CLAUDE.md' })).toContain('covered by api/CLAUDE.md')
  expect(JSON.parse(h.files.get(`${SRC}/learn.json`)!).areas.api).toMatchObject({ coveredBy: 'api/CLAUDE.md', lines: 0 })
  expect(h.files.has(`${SRC}/rules/api.md`)).toBe(false)
})

test('withRelies/parseRelies keep the footer one comment and relies-on last', () => {
  const t = withRelies(rule('- a'), ['x/y.ts', 'Sym'], 'abc', '2026-01-01')
  expect(t.match(/<!--/g)!.length).toBe(1)
  expect(parseRelies(t)).toEqual(['x/y.ts', 'Sym'])
  expect(parseRelies(withRelies(t, [], 'abc', '2026-01-01'))).toEqual([])
})

test('lean_rules tool: check, record (lines from the file, covered_by) and sync all return text', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'proj' }))
  h.files.set(`${SRC}/rules/billing.md`, rule(lines(2)))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ learn: { maxExplorers: 2 } }))
  const call = (i: any) => threadTool(h.host, 't1', 'lean_rules', i)
  expect((await call({ action: 'check' })).text).toContain('<= 2 explorers')
  const rec = await call({ action: 'record', area: 'billing', globs: ['services/billing/**'], sha: 'abc', lines: 1 })
  expect(rec.ok && rec.text).toContain('caller said 1')
  expect((await call({ action: 'record', area: 'api', globs: ['api/**'], sha: 'abc', covered_by: 'api/CLAUDE.md' })).text).toContain('covered by api/CLAUDE.md')
  expect((await call({ action: 'record', area: '../x', globs: ['a'], sha: 's' })).ok).toBe(false)
  expect((await call({ action: 'verify' })).ok).toBe(false) // needs repo
  const s = await call({ action: 'sync', repo: '/repo', all: true })
  expect(s.text).toBe('/repo: copied 1, removed 0, skipped 0, exclude ok')
})

test('globs: braces expand, several globs in one rule match any of them', () => {
  expect(globRe('src/**/*.{ts,tsx}').test('src/a/b.tsx')).toBe(true)
  expect(globRe('src/**/*.{ts,tsx}').test('src/a/b.js')).toBe(false)
  expect(pathsOf(rule('- x').replace('  - "services/billing/**"', '  - "services/billing/**"\n  - "services/api/client/**"'))).toEqual(['services/billing/**', 'services/api/client/**'])
})

// ---- stale ---------------------------------------------------------------------------------------------------------
const ST = (names: Record<string, string>) => ({ exitCode: 0, stdout: Object.entries(names).map(([p, s]) => `${s}\t${p}`).join('\n') })

test('stale: a relied-on file that changed or vanished marks the area, a relied-on symbol does not, a few other changes do not', async () => {
  const h = setup()
  await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', relies: ['services/billing/db.ts', 'LedgerRow'] }) // no rule file: recorded with a warning, relies kept
  await recordRule(h.host, 'proj', 'api', { globs: ['services/api/**'], sha: 'abc', relies: ['services/api/gone.ts'] })
  await recordRule(h.host, 'proj', 'web', { globs: ['apps/web/**'], sha: 'abc', relies: ['apps/web/x.ts', 'Thing'] })
  h.git.handler = a => (a[0] === 'diff' ? ST({ 'services/billing/db.ts': 'M', 'services/api/gone.ts': 'D', 'apps/web/other.ts': 'M' }) : { exitCode: 1, stdout: '' })
  const out = await checkStale(h.host, 'proj', '/repo')
  expect(out).toEqual(['rules for billing are stale: re-learn when you touch it', 'rules for api are stale: re-learn when you touch it'])
  const l = JSON.parse(h.files.get(`${SRC}/learn.json`)!)
  expect(l.areas.billing.stale).toBe('relied-on file changed: services/billing/db.ts')
  expect(l.areas.api.stale).toBe('relied-on file gone: services/api/gone.ts')
  expect(l.areas.web.stale).toBeUndefined()
})

test('stale limit scales with the area: max(15, 10% of its files)', async () => {
  expect(staleLimit(40)).toBe(15)
  expect(staleLimit(400)).toBe(40)
  const h = setup()
  await recordRule(h.host, 'proj', 'big', { globs: ['pkg/**'], sha: 'abc' })
  const tracked = Array.from({ length: 400 }, (_, i) => `pkg/f${i}.ts`).join('\n')
  const changed = (n: number) => ST(Object.fromEntries(Array.from({ length: n }, (_, i) => [`pkg/f${i}.ts`, 'M'])))
  h.git.handler = a => (a[0] === 'diff' ? changed(30) : a[0] === 'ls-files' ? { exitCode: 0, stdout: tracked } : { exitCode: 1, stdout: '' })
  expect(await checkStale(h.host, 'proj', '/repo')).toEqual([]) // 30 <= 40
  h.git.handler = a => (a[0] === 'diff' ? changed(41) : a[0] === 'ls-files' ? { exitCode: 0, stdout: tracked } : { exitCode: 1, stdout: '' })
  expect(await checkStale(h.host, 'proj', '/repo')).toEqual(['rules for big are stale: re-learn when you touch it'])
  expect(JSON.parse(h.files.get(`${SRC}/learn.json`)!).areas.big.stale).toBe('41 files changed (limit 40)')
})

test('areas covered by repo docs are never stale, not even by gaps', async () => {
  const h = setup()
  await recordRule(h.host, 'proj', 'api', { globs: ['api/**'], sha: 'abc', coveredBy: 'api/CLAUDE.md' })
  h.git.handler = a => (a[0] === 'diff' ? ST({ 'api/package.json': 'M' }) : { exitCode: 1, stdout: '' })
  expect(await checkStale(h.host, 'proj', '/repo')).toEqual([])
  for (let i = 0; i < 4; i++) await addGap(h.host, 'proj', `api/x${i}.ts`, 'm')
  expect(await checkStale(h.host, 'proj', '/repo')).toEqual([])
  expect(JSON.parse(h.files.get(`${SRC}/learn.json`)!).areas.api.stale).toBeUndefined()
})

// ---- verify --------------------------------------------------------------------------------------------------------
test('tokensOf: backticked paths, numbers and symbols; commands only by their path words; flags, placeholders, URLs, fences never', () => {
  const body = ['- Test: `pnpm --filter billing test -- <file>`, run `scripts/run.sh --fast` from `services/billing/`',
    '- Retries: `30000` ms in `RETRY_MS`, class `LedgerRow`, call `Ledger.load()` and `package.json`; ignore `-x`, `$HOME`, `https://a.b/c`, `7`, `git`',
    '```\n`inside fence`\n```'].join('\n')
  expect(tokensOf(body).map(t => `${t.kind}:${t.text}`)).toEqual([
    'path:scripts/run.sh', 'path:services/billing/', 'number:30000', 'symbol:RETRY_MS', 'symbol:LedgerRow', 'path:Ledger.load', 'path:package.json',
  ])
})

test('tokensOf never turns a path outside the repo or a pathspec magic into a check', () => {
  expect(tokensOf('`../../etc/passwd` and `a/../b.ts` and `:(top)x/y`').map(t => t.text)).toEqual([])
})

test('verify reports names that no longer exist, per rule; relies-on counts; read-only git only', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule('- Class `LedgerRow` in `services/billing/db.ts`, retry `RETRY_MS`, old `GoneThing`, dir `services/billing/old/`'))
  h.files.set(`${SRC}/rules/api.md`, rule('- Uses `Client`'))
  h.files.set('/repo/services/billing/db.ts', 'x')
  await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', relies: ['services/billing/db.ts', 'RelyGone'] })
  const present = new Set(['LedgerRow', 'RETRY_MS', 'Client'])
  h.git.handler = a => {
    if (a[0] === 'grep') return present.has(a[a.indexOf('-e') + 1]!) ? { exitCode: 0, stdout: '' } : { exitCode: 1, stdout: '' }
    if (a[0] === 'ls-files') return { exitCode: 0, stdout: '' }
    if (a[0] === 'diff') return ST({ 'services/billing/db.ts': 'D' })
    return { exitCode: 1, stdout: '' }
  }
  const v = await verifyRules(h.host, 'proj', '/repo')
  const t = v.lines.join('\n')
  expect(v.missing).toBe(3)
  expect(t).toContain('billing.md: 6 checked, missing: `RelyGone`, `GoneThing`, `services/billing/old/`; relied-on file gone: services/billing/db.ts')
  expect(t).toContain('api.md: 1 checked, all found')
  expect(h.calls.filter(c => c.argv[0] === 'git').every(c => ['grep', 'ls-files', 'diff'].includes(c.argv[1]!))).toBe(true)
  expect(h.calls.some(c => c.argv[0] === 'git' && c.argv[1] === 'grep' && c.argv.includes('-F') && c.argv.includes('-w') && c.argv.includes('-q') && c.argv.includes(':(exclude).claude/rules/lean-agent'))).toBe(true) // whole words, never the synced copies
  // only one rule
  expect((await verifyRules(h.host, 'proj', '/repo', 'api')).lines.join('\n')).not.toContain('billing.md')
})

test('verify is bounded: names past the per-rule limit are reported as not checked', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/many.md`, rule(Array.from({ length: 60 }, (_, i) => `- \`Name${i}\``).join('\n')))
  h.git.handler = () => ({ exitCode: 0, stdout: '' })
  const v = await verifyRules(h.host, 'proj', '/repo')
  expect(v.lines.join('\n')).toContain('many.md: 40 checked, all found; 20 not checked (limit)')
  expect(h.calls.filter(c => c.argv[1] === 'grep').length).toBe(40)
})

// ---- sync all ------------------------------------------------------------------------------------------------------
test('sync all: every worktree (git worktree list + worktrees.json) gets one summary line; verbose gives the paths', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule('- a'))
  h.files.set(`${SRC}/rules/big.md`, rule(lines(30)))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'proj/feat': { path: '/h/.lean-agent/worktrees/proj/feat', repo: '/repo' }, 'other/x': { path: '/o/x' }, 'proj/gone': { path: '/h/.lean-agent/worktrees/proj/gone' } }))
  h.files.set('/h/.lean-agent/worktrees/proj/feat/.git', 'gitdir: x')
  h.files.set('/wt2/.git', 'gitdir: y')
  h.git.handler = a => {
    if (a[0] === 'rev-parse') return { exitCode: 0, stdout: '/repo/.git\n' }
    if (a[0] === 'worktree') return { exitCode: 0, stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt2\nHEAD def\ndetached\n\nworktree /old\nHEAD 1\nprunable gitdir file points to non-existent location\n' }
    return { exitCode: 1, stdout: '' }
  }
  const r = await syncAll(h.host, 'proj', '/repo', true)
  expect(r.lines).toEqual([
    '/repo: copied 1, removed 0, skipped 1, exclude ok',
    '/wt2: copied 1, removed 0, skipped 1, exclude ok',
    '/h/.lean-agent/worktrees/proj/feat: copied 1, removed 0, skipped 1, exclude ok',
    '/h/.lean-agent/worktrees/proj/gone: missing, skipped',
    'not synced (shorten these): big.md: more than 25 lines (31)',
  ])
  expect(h.files.has('/wt2/.claude/rules/lean-agent/billing.md')).toBe(true)
  expect(r.detail.find(d => d.path === '/wt2')!.out!.copied).toEqual(['/wt2/.claude/rules/lean-agent/billing.md'])
  // without all: just the repo
  expect((await syncAll(h.host, 'proj', '/repo', false)).lines[0]).toBe('/repo: copied 0, removed 0, skipped 1, exclude ok')
  // through the tool: verbose = JSON with the paths
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'proj' }))
  const v = await threadTool(h.host, 't1', 'lean_rules', { action: 'sync', repo: '/repo', all: true, verbose: true })
  expect(JSON.parse(v.text).map((d: any) => d.path)).toContain('/wt2')
})

test('sync summary says exclude n/a when there is nothing to copy', async () => {
  const h = setup()
  expect((await syncAll(h.host, 'proj', '/repo', false)).lines).toEqual(['/repo: copied 0, removed 0, skipped 0, exclude n/a'])
})

test('relies-on entries with $ patterns, commas or ./ survive the footer rewrite', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule('- a') + 'TAIL\n')
  await recordRule(h.host, 'proj', 'billing', { globs: ['a/**'], sha: 'abcdef12', relies: ["$$store", "$'", "$&x", 'foo(a, b)'] })
  const t = h.files.get(`${SRC}/rules/billing.md`)!
  expect(parseRelies(t)).toEqual(['$$store', "$'", '$&x', 'foo(a  b)'])
  expect(t.match(/TAIL/g)!.length).toBe(1) // nothing spliced into the footer
})

test('relied-on folders (trailing /) and ./ paths count as changed or gone', async () => {
  const h = setup()
  await recordRule(h.host, 'proj', 'a', { globs: ['a/**'], sha: 'abc', relies: ['a/core/'] })
  await recordRule(h.host, 'proj', 'b', { globs: ['b/**'], sha: 'abc', relies: ['./b/x.ts'] })
  h.git.handler = x => (x[0] === 'diff' ? ST({ 'a/core/m.ts': 'D', 'b/x.ts': 'M' }) : { exitCode: 1, stdout: '' })
  expect(await checkStale(h.host, 'proj', '/repo')).toHaveLength(2)
  const l = JSON.parse(h.files.get(`${SRC}/learn.json`)!)
  expect(l.areas.a.stale).toBe('relied-on file gone: a/core/m.ts')
  expect(l.areas.b.stale).toBe('relied-on file changed: b/x.ts')
})

test('inline paths with braces, single-alternative braces; verify says NOT CHECKED when the budget ran out', async () => {
  expect(pathsOf('---\npaths: src/**/*.{ts,tsx}, lib/**\n---\nx')).toEqual(['src/**/*.{ts,tsx}', 'lib/**'])
  expect(globRe('a/{b}.ts').test('a/b.ts')).toBe(true)
  const h = setup()
  for (let i = 0; i < 4; i++) h.files.set(`${SRC}/rules/r${i}.md`, rule(Array.from({ length: 40 }, (_, j) => `- \`N${i}x${j}\``).join('\n')))
  h.git.handler = () => ({ exitCode: 0, stdout: '' })
  const t = (await verifyRules(h.host, 'proj', '/repo')).lines.join('\n')
  expect(t).toContain('r3.md: 30 checked') // 150 names in all
  expect(t).not.toContain('NOT CHECKED (limit reached), all found')
  h.files.set(`${SRC}/rules/r4.md`, rule(Array.from({ length: 5 }, (_, j) => `- \`M${j}x\``).join('\n')))
  h.files.set(`${SRC}/rules/r5.md`, rule('- prose only'))
  const u = (await verifyRules(h.host, 'proj', '/repo')).lines.join('\n')
  expect(u).toContain('r4.md: NOT CHECKED (limit reached); 5 not checked (limit)')
  expect(u).toContain('r5.md: nothing to check')
})

test('paths: zero-indent and flow lists parse; relies folders without a slash, and globs, match changes; relies are verified first', async () => {
  expect(pathsOf('---\npaths:\n- "a/**"\n- b/**\n---\n')).toEqual(['a/**', 'b/**'])
  expect(pathsOf('---\npaths: ["a/**", "b/**"]\n---\n')).toEqual(['a/**', 'b/**'])
  const h = setup()
  await recordRule(h.host, 'proj', 'a', { globs: ['a/**'], sha: 'abc', relies: ['a/core'] })
  await recordRule(h.host, 'proj', 'b', { globs: ['b/**'], sha: 'abc', relies: ['b/*.cfg'] })
  h.git.handler = x => (x[0] === 'diff' ? ST({ 'a/core/m.ts': 'M', 'b/x.cfg': 'M' }) : { exitCode: 1, stdout: '' })
  expect(await checkStale(h.host, 'proj', '/repo')).toHaveLength(2)
})
