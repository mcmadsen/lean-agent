import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addGap, checkStale, globRe, pathsIn, recordLearn, rulesStats, syncRules } from './rules'
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

test('rules over their line cap or past 40 files are skipped and reported', async () => {
  const h = setup()
  h.files.set(`${SRC}/rules/big.md`, rule(26))
  h.files.set(`${SRC}/rules/_project.md`, '# p\n' + Array.from({ length: 11 }, (_, i) => `- ${i}`).join('\n'))
  for (let i = 0; i < 41; i++) h.files.set(`${SRC}/rules/r${String(i).padStart(2, '0')}.md`, rule(2))
  const a = await syncRules(h.host, 'proj', '/repo')
  expect(a.skipped.some(s => s.startsWith('big.md'))).toBe(true)
  expect(a.skipped.some(s => s.startsWith('_project.md'))).toBe(true)
  expect(a.skipped.some(s => s.includes('40 rule files'))).toBe(true)
  expect(h.files.has('/repo/.claude/rules/lean-agent/big.md')).toBe(false)
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
  expect(await rulesStats(h.host, 'proj')).toEqual({ loaded: { 'billing.md': 2 }, never: ['api.md'] })
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
