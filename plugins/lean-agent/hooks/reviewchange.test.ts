import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { analyzeDiff } from './reviewprep'
import { changeScope, changedText, droppedText, insideChange } from './reviewchange'

const L = '/h/.lean-agent'
const H2 = 'c'.repeat(40)
const MB = 'm'.repeat(40)
const lines = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`)
// a -U0 diff of the four kinds of change: added, modified, deleted, renamed (the tool reads it with --no-renames: a delete and an add)
const DIFF = [
  'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,5 @@', ...lines(5, '+n'),
  'diff --git a/src/mod.ts b/src/mod.ts', '--- a/src/mod.ts', '+++ b/src/mod.ts', '@@ -10,2 +10,3 @@', '-x', '-y', '+x1', '+y1', '+z1',
  'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,4 +0,0 @@', ...lines(4, '-g'),
  'diff --git a/src/old-name.ts b/src/old-name.ts', 'deleted file mode 100644', '--- a/src/old-name.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', ...lines(2, '-o'),
  'diff --git a/src/new-name.ts b/src/new-name.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new-name.ts', '@@ -0,0 +1,2 @@', ...lines(2, '+o'),
  'diff --git a/src/cut.ts b/src/cut.ts', '--- a/src/cut.ts', '+++ b/src/cut.ts', '@@ -20,3 +19,0 @@', ...lines(3, '-c'),
].join('\n') + '\n'

test('the hunk ranges are right for added, modified, deleted, renamed files and a deletion inside a file', async () => {
  const p = await analyzeDiff(DIFF, async () => '')
  expect(p.changed.sort()).toEqual(['src/cut.ts', 'src/gone.ts', 'src/mod.ts', 'src/new-name.ts', 'src/new.ts', 'src/old-name.ts'])
  expect(p.hunks['src/new.ts']).toEqual([[1, 5]]) // added: the whole file
  expect(p.hunks['src/mod.ts']).toEqual([[10, 12]]) // modified: the new side
  expect(p.hunks['src/gone.ts']).toBeUndefined() // deleted: no new-side lines
  expect(p.hunks['src/new-name.ts']).toEqual([[1, 2]]) // renamed: the old name is deleted, the new one added
  expect(p.hunks['src/cut.ts']).toEqual([[19, 20]]) // lines removed inside a file: the spot
})

test('findings in unchanged files and outside the hunks (+-3) are dropped and counted; changed lines, deletions and cross-file categories stay', async () => {
  const prep = await analyzeDiff(DIFF, async () => '')
  const f = (path: string, line: number, category = 'correctness', text = 'it breaks') => ({ n: 1, severity: 'major', category, path, line, text, fix: '' })
  const kept = [f('src/mod.ts', 11), f('src/mod.ts', 15), f('src/mod.ts', 7), f('src/new.ts', 3), f('src/gone.ts', 2), f('src/gone.ts', 0), f('src/new-name.ts', 1), f('src/cut.ts', 21), f('/r/app/src/mod.ts', 12), f('./src/mod.ts', 0)]
  const out = [f('src/mod.ts', 16), f('src/mod.ts', 6), f('src/new.ts', 9), f('src/other.ts', 3), f('lib/util.ts', 40), f('src/cut.ts', 30)]
  const r = changeScope([...kept, ...out], prep)
  expect(r.kept.map(x => `${x.path}:${x.line}`)).toEqual(kept.map(x => `${x.path}:${x.line}`))
  expect(r.dropped.n).toBe(6)
  expect(r.dropped.files).toEqual(['src/mod.ts', 'src/new.ts', 'src/other.ts', 'lib/util.ts', 'src/cut.ts'])
  expect(droppedText(r.dropped)).toBe('6 findings dropped: outside the change (files: src/mod.ts, src/new.ts, src/other.ts, lib/util.ts, src/cut.ts)')
  expect(droppedText({ n: 0, files: [] })).toBe('')
  expect(droppedText({ n: 1, files: ['a.ts'] })).toBe('1 finding dropped: outside the change (files: a.ts)')
  // no file: kept only in a cross-file category, and it says so
  const nofile = changeScope([f('', 0, 'tests', 'no test for the empty case'), f('', 0, 'docs', 'the readme is not updated'), f('', 0, 'scope', 'siblings share it'), f('', 0, 'correctness', 'something somewhere')], prep)
  expect(nofile.kept.map(x => x.category)).toEqual(['tests', 'docs', 'scope'])
  expect(nofile.kept[0]!.text).toContain('[cross-file: no file or line]')
  expect(nofile.crossFile).toBe(3)
  expect(nofile.dropped).toEqual({ n: 1, files: ['(no file)'] })
  expect(insideChange('src/mod.ts', 13, prep)).toBe(true)
  expect(insideChange('src/mod.ts', 16, prep)).toBe(false)
})

test('the text prepare hands the reviewer names the changed files with their ranges, and says to read them first', async () => {
  const prep = await analyzeDiff(DIFF, async () => '')
  const t = changedText(prep)
  expect(t).toContain('src/mod.ts 10-12')
  expect(t).toContain('src/new.ts 1-5')
  expect(t).toContain('src/gone.ts (deleted or no line ranges: the whole file counts)')
  expect(t).toContain('Read the changed files first, other files only to understand a caller or a definition used in the change')
})

// ---- through the tool: prepare (light too), merge and record ----------------------------------------------------------------
const MOD = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,2 +10,3 @@', '-x', '-y', '+x1', '+y1', '+z1'].join('\n') + '\n'
function setup() {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    const ok = (stdout: string) => ({ exitCode: 0, stdout })
    if (s.includes('rev-parse --verify')) { const r = a[a.length - 1]!.replace('^{commit}', ''); return /^[0-9a-f]{40}$/.test(r) ? ok(r + '\n') : r === 'HEAD' ? ok(H2 + '\n') : ok('b'.repeat(40) + '\n') }
    if (s.includes('show-ref')) return { exitCode: /refs\/heads\/main$/.test(s) ? 0 : 1, stdout: '' }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: 1, stdout: '' }
    if (s.includes('merge-base')) return ok(MB + '\n')
    if (s.includes('--name-status')) return ok('M\tsrc/a.ts\n')
    if (s.includes(' diff ')) return ok(MOD)
    return { exitCode: 1, stdout: '' }
  }
  return h
}
const tool = (h: any, input: Record<string, unknown>) => threadTool(h.host, 't1', 'lean_review', input)
const fin = (n: number, path: string, line: number, extra: Record<string, unknown> = {}) => ({ n, severity: 'minor', category: 'correctness', path, line, text: `problem ${n} in the code`, fix: 'fix it', ...extra })
const block = (findings: unknown[]) => ({ verdict: 'changes-requested', goal: 'g', findings, reuse: [], coverage: [] })

test('prepare (light and full) lists the changed files with their ranges; record and merge drop findings outside the change and say how many', async () => {
  const h = setup()
  for (const level of ['light', 'full']) {
    const p = await tool(h, { action: 'prepare', base: 'main', level })
    expect(p.text).toContain('CHANGED CODE ONLY')
    expect(p.text).toContain('src/a.ts 10-12')
  }
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block([fin(1, 'src/a.ts', 11), fin(2, 'src/untouched.ts', 4), fin(3, 'src/a.ts', 90), fin(4, '', 0, { category: 'tests', text: 'no test for the empty case' })]) })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('2 findings dropped: outside the change (files: src/untouched.ts, src/a.ts)')
  expect(r.text).toContain('src/a.ts:11')
  expect(r.text).not.toContain('src/untouched.ts:4')
  expect(r.text).toContain('[cross-file: no file or line]')
  const a = block([fin(1, 'src/a.ts', 11), fin(2, 'src/untouched.ts', 4)])
  const b = block([fin(1, 'src/a.ts', 12, { text: 'problem 1 in the code, again' }), fin(2, 'src/elsewhere.ts', 8)])
  const m = await tool(h, { action: 'merge', reviews: [a, b] })
  expect(m.ok).toBe(true)
  expect(m.text).toMatch(/2 findings dropped: outside the change \(files: src\/untouched\.ts, src\/elsewhere\.ts\)/)
  expect(m.text).toContain('top 1 of 1')
})
