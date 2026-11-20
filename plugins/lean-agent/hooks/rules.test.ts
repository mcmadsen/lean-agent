import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addGap, alwaysLoaded, checkRules, checkStale, dupLines, globRe, pathsIn, recordLearn, recordRule, rulesStats, rulesUpdateCheck, syncRules, unverifiedLine } from './rules'
import { setNotice, takeNotice } from './notices'
import { threadTool } from './delivery'

const SRC = '/h/.lean-agent/proj'
const rule = (n = 3) => `---\npaths:\n  - "services/billing/**"\n---\n# billing\n${Array.from({ length: n }, (_, i) => `- line ${i}`).join('\n')}\n<!-- lean-agent: learned abc 2026-01-01 sources: services/billing/** -->\n`
function setup() {
  const h = fakeHost(null)
  h.git.handler = a => (a[0] === 'rev-parse' ? { exitCode: 0, stdout: '/repo/.git\n' } : { exitCode: 1, stdout: '' })
  return h
}

test('globs: ** crosses folders, * does not', () => {
  expect(globRe('services/billing/**/*.ts').test('services/billing/a/b/c.ts')).toBe(true)
  expect(globRe('services/billing/**/*.ts').test('services/billing/c.ts')).toBe(true)
  expect(globRe('src/*.ts').test('src/a/b.ts')).toBe(false)
  expect(globRe('a.b').test('axb')).toBe(false)
})

test('sync COPIES rules as real files, excludes them in git, removes stale copies and is idempotent', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule())
  h.files.set(`${SRC}/rules/_project.md`, '# project\n- pnpm test\n')
  h.files.set('/repo/.claude/rules/lean-agent/old.md', 'stale')
  h.files.set('/repo/.claude/rules/mine.md', 'the team rule')
  const a = await syncRules(h.host, 'proj', '/repo')
  expect(h.files.get('/repo/.claude/rules/lean-agent/billing.md')).toBe(rule())
  expect(h.files.get('/repo/.claude/rules/lean-agent/_project.md')).toContain('pnpm test')
  expect(h.files.has('/repo/.claude/rules/lean-agent/old.md')).toBe(false)
  expect(h.files.get('/repo/.claude/rules/mine.md')).toBe('the team rule')
  expect(a.removed.length).toBe(1)
  expect(h.links.size).toBe(0) // never a symlink
  expect(h.files.get('/repo/.git/info/exclude')).toContain('.claude/rules/lean-agent/')
  const b = await syncRules(h.host, 'proj', '/repo')
  expect(b.copied).toEqual([])
  expect((h.files.get('/repo/.git/info/exclude')!.match(/rules\/lean-agent/g) ?? []).length).toBe(1)
  h.files.set(`${SRC}/rules/billing.md`, rule(4)) // the source changed: the next sync copies again
  expect((await syncRules(h.host, 'proj', '/repo')).copied.length).toBe(1)
})

test('sync into a worktree uses the shared exclude of the common git dir', async () => {
  const h = setup()
  h.git.handler = () => ({ exitCode: 0, stdout: '/main/.git\n' })
  h.files.set(`${SRC}/rules/billing.md`, rule())
  await syncRules(h.host, 'proj', '/wt')
  expect(h.files.has('/wt/.claude/rules/lean-agent/billing.md')).toBe(true)
  expect(h.files.get('/main/.git/info/exclude')).toContain('.claude/rules/lean-agent/')
})

test('rules far over their line cap (3x) or past 40 files are skipped and reported; one just over its cap is copied and reported; copies already there stay', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/big.md`, rule(80))
  h.files.set(`${SRC}/rules/_project.md`, '# p\n' + Array.from({ length: 40 }, (_, i) => `- ${i}`).join('\n'))
  h.files.set(`${SRC}/rules/near.md`, rule(26)) // 27 lines against 25: grandfathered
  h.files.set('/repo/.claude/rules/lean-agent/big.md', 'old good copy')
  for (let i = 0; i < 41; i++) h.files.set(`${SRC}/rules/r${String(i).padStart(2, '0')}.md`, rule(2))
  const a = await syncRules(h.host, 'proj', '/repo')
  expect(a.skipped.some(s => s.startsWith('big.md'))).toBe(true)
  expect(a.skipped.some(s => s.startsWith('_project.md'))).toBe(true)
  expect(a.skipped.some(s => s.includes('40 rule files'))).toBe(true)
  expect(h.files.get('/repo/.claude/rules/lean-agent/big.md')).toBe('old good copy') // a skipped rule never deletes its copy
  expect((a.over ?? []).some(s => s.startsWith('near.md'))).toBe(true)
  expect(h.files.has('/repo/.claude/rules/lean-agent/near.md')).toBe(true)
})

test('1.0.5 sync deleted copies when a store rule failed a cap: now the last good copy stays and an over-cap rule is copied', async () => {
  const h = setup()
  const fat = rule(26) // 27 body lines against the cap of 25, under three times it
  h.files.set(`${SRC}/rules/fat.md`, fat)
  h.files.set('/repo/.claude/rules/lean-agent/fat.md', 'copy synced by an older version')
  const a = await syncRules(h.host, 'proj', '/repo')
  expect(a.removed).toEqual([])
  expect(h.files.get('/repo/.claude/rules/lean-agent/fat.md')).toBe(fat)
  expect(a.over).toHaveLength(1)
})

test('recipes become lean-agent-<name> skills, stale ones are removed', async () => {
  const h = setup()
  h.files.set(`${SRC}/skills/deploy/SKILL.md`, '---\nname: deploy\n---\nsteps')
  h.files.set('/repo/.claude/skills/lean-agent-gone/SKILL.md', 'x')
  h.files.set('/repo/.claude/skills/lean-agent-gone/.lean-agent-managed', 'm')
  h.files.set('/repo/.claude/skills/lean-agent-mine/SKILL.md', 'the user wrote this') // no marker: not ours
  h.files.set('/repo/.claude/skills/own/SKILL.md', 'mine')
  await syncRules(h.host, 'proj', '/repo')
  expect(h.files.get('/repo/.claude/skills/lean-agent-deploy/SKILL.md')).toContain('steps')
  expect(h.files.has('/repo/.claude/skills/lean-agent-gone/SKILL.md')).toBe(false)
  expect(h.files.get('/repo/.claude/skills/lean-agent-mine/SKILL.md')).toBe('the user wrote this')
  expect(h.files.get('/repo/.claude/skills/own/SKILL.md')).toBe('mine')
  expect(h.files.get('/repo/.git/info/exclude')).toContain('.claude/skills/lean-agent-*/')
})

test('stale: many changed files or a changed manifest mark an area; untouched areas stay fresh', async () => {
  const h = setup()
  await recordLearn(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', lines: 5 })
  await recordLearn(h.host, 'proj', 'api', { globs: ['services/api/**'], sha: 'abc', lines: 5 })
  await recordLearn(h.host, 'proj', 'web', { globs: ['apps/web/**'], sha: 'abc', lines: 5 })
  const files = [...Array.from({ length: 16 }, (_, i) => `services/billing/f${i}.ts`), 'services/api/package.json', 'apps/web/x.ts']
  h.git.handler = a => (a[0] === 'diff' ? { exitCode: 0, stdout: files.join('\n') } : { exitCode: 1, stdout: '' })
  const lines = await checkStale(h.host, 'proj', '/repo')
  expect(lines).toEqual(['rules for billing are stale: re-learn when you touch it', 'rules for api are stale: re-learn when you touch it'])
  const learn = JSON.parse(h.files.get(`${SRC}/learn.json`)!)
  expect(learn.areas.api.stale).toContain('manifest')
  expect(learn.areas.web.stale).toBeUndefined()
  expect(h.calls.find(c => c.argv[0] === 'git' && c.argv[1] === 'diff')?.argv.slice(2)).toEqual(['--name-status', '--no-renames', 'abc..HEAD'])
})

test('gaps: the area is found by glob; pathsIn picks paths, not urls', async () => {
  const h = setup()
  await recordLearn(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', lines: 5 })
  expect(await addGap(h.host, 'proj', 'services/billing/x.ts', 'm')).toBe('billing')
  expect(await addGap(h.host, 'proj', 'other/y.ts')).toBeNull()
  expect(pathsIn('see https://a.b/c and src/x/y.ts, lib/z.go')).toEqual(['src/x/y.ts', 'lib/z.go'])
})

test('stats: counts loads of lean-agent rules from the hook log and lists rules that never loaded', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule())
  h.files.set(`${SRC}/rules/api.md`, rule())
  const ev = (f: string, ts = 1) => JSON.stringify({ ts, e: { file_path: f } })
  h.files.set('/h/.lean-agent/logs/rules-loaded.jsonl', [ev('/r/.claude/rules/lean-agent/billing.md'), ev('/r/.claude/rules/lean-agent/billing.md', 2)].join('\n') + '\n')
  expect(await rulesStats(h.host, 'proj')).toMatchObject({ loaded: { 'billing.md': 2 }, never: ['api.md'], neverConfirmed: ['api.md'], events: 2, verified: true, scriptCandidates: [] })
})

test('stats honesty: no log = loading unverified (nothing is "never loaded"); a rule written after the last recorded load is not confirmed never-loaded', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/billing.md`, rule())
  h.files.set(`${SRC}/rules/api.md`, rule())
  const a = await rulesStats(h.host, 'proj') // the log does not exist
  expect(a).toMatchObject({ verified: false, events: 0, logRows: 0, neverConfirmed: [] })
  expect(a.never.sort()).toEqual(['api.md', 'billing.md'])
  expect(unverifiedLine('proj', a)).toBe('no rule load has ever been recorded (log absent): loading unverified')
  // a log with another project's load only: still unverified for this one, and says so differently
  h.files.set('/h/.lean-agent/logs/rules-loaded.jsonl', JSON.stringify({ ts: 100, src: 'loader', rule: 'x.md', project: 'other', sha: 's' }) + '\n')
  const b = await rulesStats(h.host, 'proj')
  expect(b).toMatchObject({ verified: false, logRows: 1 })
  expect(unverifiedLine('proj', b)).toContain('for proj')
  // the mod loader's rows count per project; api.md was learned after the last load: not confirmed
  h.files.set('/h/.lean-agent/logs/rules-loaded.jsonl', JSON.stringify({ ts: 100, src: 'loader', rule: 'billing.md', project: 'proj', session: 's1', sha: 'a' }) + '\n')
  h.files.set(`${SRC}/learn.json`, JSON.stringify({ sha: '', areas: { api: { globs: ['api/**'], sha: 'x', lines: 1, at: 500_000 }, billing: { globs: ['b/**'], sha: 'x', lines: 1, at: 1000 } } }))
  const c = await rulesStats(h.host, 'proj')
  expect(c).toMatchObject({ loaded: { 'billing.md': 1 }, never: ['api.md'], neverConfirmed: [], events: 1, verified: true })
  h.files.set('/h/.lean-agent/logs/rules-loaded.jsonl', JSON.stringify({ ts: 900, src: 'loader', rule: 'billing.md', project: 'proj', session: 's1', sha: 'a' }) + '\n') // 900 s > the write at 500 s
  expect((await rulesStats(h.host, 'proj')).neverConfirmed).toEqual(['api.md'])
})

test('update check: once per version, over-cap rules are told to the desk, the 0.45 rules:off key is dropped (and only that key)', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ proj: { path: '/repo', rules: 'off', private: true }, other: { path: '/o' } }))
  h.files.set(`${SRC}/rules/fat.md`, rule(26)) // over the 25-line cap
  h.files.set(`${SRC}/rules/ok.md`, rule(2))
  const said = await rulesUpdateCheck(h.host, '1.0.6')
  expect(said.join('\n')).toContain('proj: the 0.45 "rules": "off" in projects.json was removed')
  expect(said.join('\n')).toContain('rules proj: 1 over the size cap, still loaded; learn proj --trim or lean_rules check')
  expect(JSON.parse(h.files.get('/h/.lean-agent/projects.json')!)).toEqual({ proj: { path: '/repo', private: true }, other: { path: '/o' } })
  expect(h.files.get('/h/.lean-agent/notices/rules-cap.txt')).toContain('over the size cap')
  expect(await rulesUpdateCheck(h.host, '1.0.6')).toEqual([]) // once per version
  expect((await rulesUpdateCheck(h.host, '1.0.7')).join('\n')).toContain('1 over the size cap') // and again after the next update
  expect(JSON.parse(h.files.get('/h/.lean-agent/projects.json')!).proj.rules).toBeUndefined()
})

test('takeNotice: the text once, then the notice is gone', async () => {
  const h = setup()
  await setNotice(h.host, 'ledger-rotation', 'ledger rotated: x')
  expect(await takeNotice(h.host, 'ledger-rotation')).toBe('ledger rotated: x')
  expect(await takeNotice(h.host, 'ledger-rotation')).toBeNull()
})

test('lean_rules tool: sync, record and stale through the thread tool; bad input is refused', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'proj' }))
  h.files.set(`${SRC}/rules/billing.md`, rule())
  const sync = await threadTool(h.host, 't1', 'lean_rules', { action: 'sync', repo: '/repo' })
  expect(sync.ok).toBe(true)
  expect(h.files.has('/repo/.claude/rules/lean-agent/billing.md')).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_rules', { action: 'record', area: 'billing', globs: ['a/**'], sha: 's', lines: 3 })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_rules', { action: 'sync', repo: 'relative' })).ok).toBe(false)
  expect((await threadTool(h.host, 't1', 'lean_rules', { action: 'sync', project: '../x', repo: '/repo' })).ok).toBe(false)
})

const TEAM = '# Build\n- Run `yarn test` before every commit, from the repo root.\n- Never edit the generated files under src/gen by hand.\n- Short line.\n'
const dupWorld = () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'proj' }))
  h.files.set('/repo/CLAUDE.md', TEAM)
  return h
}
const ruleOf = (...body: string[]) => `---\npaths:\n  - "services/billing/**"\n---\n# billing\n${body.join('\n')}\n<!-- lean-agent: learned abc 2026-01-01 -->\n`

test('always-loaded files: the repo CLAUDE.md (tracked or not), .claude/CLAUDE.md, CLAUDE.local.md and the user memory; lines compare by words', async () => {
  const h = dupWorld()
  h.files.set('/repo/.claude/CLAUDE.md', 'Use pnpm for installs, never npm.')
  h.files.set('/repo/CLAUDE.local.md', 'My local scratch note about the staging database.')
  h.files.set('/h/.claude/CLAUDE.md', '- Answer in plain words, no filler sentences.')
  expect((await alwaysLoaded(h.host, '/h', 'proj')).map(f => f.name)).toEqual(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '~/.claude/CLAUDE.md (user memory)'])
  expect((await alwaysLoaded(h.host, '/h', 'nope')).map(f => f.name)).toEqual(['~/.claude/CLAUDE.md (user memory)']) // an unregistered project: only the user's
  const files = await alwaysLoaded(h.host, '/h', 'proj')
  const d = dupLines(ruleOf('- Run `yarn test` before every commit, from the repo root.', '* never edit the GENERATED files under src/gen by hand', '1. Use pnpm for installs, never npm.', '- answer in plain words, no filler sentences', '- Short line.', '- The billing service rounds half up.'), files)
  expect(d.map(x => `${x.file}: ${x.line}`)).toEqual([
    'CLAUDE.md: - Run `yarn test` before every commit, from the repo root.',
    'CLAUDE.md: * never edit the GENERATED files under src/gen by hand',
    '.claude/CLAUDE.md: 1. Use pnpm for installs, never npm.',
    '~/.claude/CLAUDE.md (user memory): - answer in plain words, no filler sentences',
  ])
  // a heading, a comment, the frontmatter and short lines are never compared; a rule line that is only PART of a CLAUDE.md line counts
  expect(dupLines(ruleOf('Run `yarn test` before every commit'), files)).toHaveLength(1)
  expect(dupLines('---\npaths:\n  - "Run yarn test before every commit, from the repo root."\n---\n# Run yarn test before every commit, from the repo root.\n<!-- Run yarn test before every commit, from the repo root. -->\n', files)).toEqual([])
})

test('record refuses a rule that repeats an always-loaded file (nothing is recorded); other lines are fine; covered_by needs no file', async () => {
  const h = dupWorld()
  h.files.set(`${SRC}/rules/billing.md`, ruleOf('- Run `yarn test` before every commit, from the repo root.', '- The billing service rounds half up, never down.'))
  const r = await recordRule(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 's' })
  expect(r).toMatch(/^NOT recorded billing: 1 rule line\(s\) already appear in CLAUDE\.md, which every session loads/)
  expect(r).toContain('"- Run `yarn test` before every commit, from the repo root."')
  expect(r).toContain('A tracked CLAUDE.md is the team\'s: trimming it needs a PR in the repo')
  expect(h.files.has(`${SRC}/learn.json`)).toBe(false) // not recorded
  // through the tool: a refusal is not ok
  const t = await threadTool(h.host, 't1', 'lean_rules', { action: 'record', area: 'billing', globs: ['services/billing/**'], sha: 's' })
  expect(t.ok).toBe(false)
  expect(t.text).toContain('NOT recorded billing')
  // the thread removes the line: recorded
  h.files.set(`${SRC}/rules/billing.md`, ruleOf('- The billing service rounds half up, never down.'))
  const ok = await threadTool(h.host, 't1', 'lean_rules', { action: 'record', area: 'billing', globs: ['services/billing/**'], sha: 's' })
  expect(ok.ok).toBe(true)
  expect(ok.text).toContain('recorded billing: 2 lines')
  // every line repeats: the advice is covered_by
  h.files.set(`${SRC}/rules/all.md`, ruleOf('- Run `yarn test` before every commit, from the repo root.'))
  expect(await recordRule(h.host, 'proj', 'all', { globs: ['a/**'], sha: 's' })).toContain('record the area with covered_by')
  expect(await recordRule(h.host, 'proj', 'all', { globs: ['a/**'], sha: 's', coveredBy: 'CLAUDE.md' })).toContain('covered by CLAUDE.md')
  // a CLAUDE.md that is not there, or an unregistered project: nothing to repeat
  const h2 = setup()
  h2.files.set(`${SRC}/rules/billing.md`, ruleOf('- Run `yarn test` before every commit, from the repo root.'))
  expect(await recordRule(h2.host, 'proj', 'billing', { globs: ['a/**'], sha: 's' })).toContain('recorded billing')
})

test('lean_rules check reports rule lines that duplicate an always-loaded file', async () => {
  const h = dupWorld()
  h.files.set('/h/.claude/CLAUDE.md', 'Prefer small commits with clear messages always.')
  h.files.set(`${SRC}/rules/billing.md`, ruleOf('- Run `yarn test` before every commit, from the repo root.', '- Prefer small commits with clear messages always.', '- The billing service rounds half up, never down.'))
  h.files.set(`${SRC}/rules/web.md`, ruleOf('- The web app uses the design tokens of the shared package.'))
  const lines = (await checkRules(h.host, 'proj')).lines
  const billing = lines.find(l => l.startsWith('billing.md'))!
  expect(billing).toContain('WARN: 2 line(s) repeat CLAUDE.md, ~/.claude/CLAUDE.md (user memory) (loaded twice; remove them from the rule:')
  expect(billing).toContain('"- Run `yarn test` before every commit, from the r…"') // (the quoted lines are cut)
  expect(lines.find(l => l.startsWith('web.md'))).toMatch(/ ok$/)
  const viaTool = await threadTool(h.host, 't1', 'lean_rules', { action: 'check' })
  expect(viaTool.text).toContain('repeat CLAUDE.md')
})
