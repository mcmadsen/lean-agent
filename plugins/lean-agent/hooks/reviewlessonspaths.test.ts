import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { checkPaths, derivePaths, globSyntax, makeLesson, readLessons } from './reviewlessons'

// 1.0.31: a lesson's paths are path GLOBS that the repo's own files can match; junk is rejected, the rest derived by script
const L = '/h/.lean-agent'
const TREE = ['src/vault/groups.ts', 'src/vault/members.ts', 'src/auth/sso.ts', 'src/auth/login.ts', 'src/lib/dates.ts', 'src/ui/Button.tsx', 'README.md']

function rig(tree: string[] | null = TREE) {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ project: 'proj' }))
  h.git.handler = a => {
    const s = a.join(' ')
    if (s.includes('ls-files')) return tree ? { exitCode: 0, stdout: tree.join('\n') + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('rev-parse')) return { exitCode: a.includes('HEAD^{commit}') ? 0 : 1, stdout: 'x\n' }
    return { exitCode: 1, stdout: '' }
  }
  return { h, tool: (i: any) => threadTool(h.host, 't1', 'lean_review', { project: 'proj', ...i }) }
}

test('globSyntax and checkPaths: globs and files pass; identifiers, phrases and words with no match are rejected with a reason and an example; a glob matching nothing is a warning', () => {
  for (const ok of ['src/auth/**', 'src/lib/dates.ts', '**/*.test.ts', 'docs/', 'README.md', 'a/b']) expect(globSyntax(ok)).toBe('')
  expect(globSyntax('vault Id/group')).toContain('has a space')
  expect(globSyntax('logger')).toContain('no / , * or file extension')
  expect(globSyntax('src//x')).toContain('empty')
  expect(globSyntax('src/a(b)')).toContain('characters')
  const c = checkPaths(['src/Auth/**', 'vaultId/groupId', 'fail-open/fail-closed', 'src/newarea/**', 'SRC/LIB/DATES.TS', 'two words'], TREE)
  expect(c.keep).toEqual(['src/Auth/**', 'src/newarea/**', 'SRC/LIB/DATES.TS']) // (case-insensitive against the tree)
  expect(c.notes.join('\n')).toContain('path "vaultId/groupId" rejected: matches no file in the repo and is no glob')
  expect(c.notes.join('\n')).toContain('e.g. src/auth/** or src/lib/dates.ts')
  expect(c.notes.join('\n')).toContain('warning: path "src/newarea/**" matches no file in the repo')
  expect(c.notes.join('\n')).toContain('has a space')
  // no repo: the syntax only
  expect(checkPaths(['vaultId/groupId', 'two words'], null).keep).toEqual(['vaultId/groupId'])
})

test('derivePaths: the finding\'s own file first, else the top 3 directories whose file names the words match', () => {
  expect(derivePaths('anything', TREE, 'src/lib/dates.ts')).toEqual({ paths: ['src/lib/dates.ts'], how: "the finding's own file" })
  expect(derivePaths('anything', TREE, 'src/auth/gone.ts').paths).toEqual(['src/auth/**'])
  const d = derivePaths('Check the vault group membership before changing the login', TREE)
  expect(d.paths[0]).toBe('src/vault/**')
  expect(d.paths.length).toBeLessThanOrEqual(3)
  expect(d.how).toContain('matched file names')
  expect(derivePaths('zzz qqq', TREE).paths).toEqual([])
})

test('learn checks paths: junk is dropped and derived, a glob with no file is a warning, no path = refused with the fix, broad: true stores paths [] (after "broad")', { timeoutMs: 20_000 }, async () => {
  const { h, tool } = rig()
  const r = await tool({ action: 'learn', checklist: [
    'Before adding a date parser, reuse src/lib/dates.ts',
    'When changing vaultId/groupId handling, check the vault group membership',
    'Decide fail-open/fail-closed explicitly in the auth sso check',
    'Phoneless/SSO users must not hit the SMS step',
    { text: 'Check the backoff of every retry loop', file: 'src/lib/dates.ts' },
    { text: 'Never ship a feature flag without an owner', broad: true },
    { text: 'Exports need the version bumped', paths: ['src/newarea/**'] },
  ] })
  expect(r.ok).toBe(true)
  const all = await readLessons(h.host, 'proj')
  const by = (s: string) => all.find(l => l.text.includes(s))!
  expect(by('date parser').paths).toEqual(['src/lib/dates.ts'])
  expect(by('vaultId').paths).toEqual(['src/vault/**'])
  expect(r.text).toContain('path "vaultId/groupId" rejected')
  expect(r.text).toContain('paths derived from the words of the line matched file names in src/vault')
  expect(by('fail-open').paths).toEqual(['src/auth/**'])
  expect(all.some(l => l.text.includes('Phoneless'))).toBe(false)
  expect(r.text).toContain('NOT added: no valid path for "Phoneless/SSO users')
  expect(r.text).toContain('{text, file: "src/x.ts"}')
  expect(r.text).toContain('{text, broad: true}')
  expect(by('backoff').paths).toEqual(['src/lib/dates.ts'])
  expect(r.text).toContain("paths derived from the finding's own file")
  expect(by('feature flag').paths).toEqual([])
  expect(by('feature flag').broad).toBe(true)
  expect(by('Exports').paths).toEqual(['src/newarea/**'])
  expect(r.text).toContain('warning: path "src/newarea/**" matches no file in the repo')
  // the learner can say it for the refused line too
  const again = await tool({ action: 'learn', checklist: [{ text: 'Phoneless/SSO users must not hit the SMS step', broad: true }] })
  expect(again.text).toContain('broad: true')
  expect((await readLessons(h.host, 'proj')).find(l => l.text.includes('Phoneless'))?.paths).toEqual([])
})

test('learn without a repo to read: the syntax is checked, the lesson is stored, and the answer says the paths were not checked against files', { timeoutMs: 20_000 }, async () => {
  const { h, tool } = rig(null)
  const r = await tool({ action: 'learn', checklist: ['Check the vault group membership before changing it'] })
  expect(r.ok).toBe(true)
  expect(r.text).toContain("paths were NOT checked against the repo's files")
  expect((await readLessons(h.host, 'proj'))).toHaveLength(1)
  expect(makeLesson(1, 'review-checklist', 'x', { source: 't', added: '2026-01-01' }).paths).toEqual([])
})
