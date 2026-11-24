import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { analyzeDiff } from './reviewprep'
import { changeScope, changedText, contextOf, droppedText, insideChange } from './reviewchange'

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

const f = (path: string, line: number, category = 'correctness', text = 'it breaks') => ({ n: 1, severity: 'major', category, path, line, text, fix: '' })

test('findings outside the changed lines (context 0) are dropped and counted; changed lines and deletions stay; context lines widen it', async () => {
  const prep = await analyzeDiff(DIFF, async () => '')
  const kept = [f('src/mod.ts', 11), f('src/mod.ts', 10), f('src/mod.ts', 12), f('src/new.ts', 3), f('src/gone.ts', 2), f('src/gone.ts', 0), f('src/new-name.ts', 1), f('src/cut.ts', 20), f('/r/app/src/mod.ts', 12)]
  const out = [f('src/mod.ts', 13), f('src/mod.ts', 9), f('src/new.ts', 9), f('src/other.ts', 3), f('lib/util.ts', 40), f('src/cut.ts', 30), f('./src/mod.ts', 0)]
  const r = changeScope([...kept, ...out], prep)
  expect(r.kept.map(x => `${x.path}:${x.line}`)).toEqual(kept.map(x => `${x.path}:${x.line}`))
  expect(r.dropped.n).toBe(7)
  expect(r.dropped.files).toEqual(['src/mod.ts', 'src/new.ts', 'src/other.ts', 'lib/util.ts', 'src/cut.ts', 'src/mod.ts (no line)'])
  expect(r.dropped.notInPr).toEqual(['src/other.ts', 'lib/util.ts'])
  expect(droppedText(r.dropped)).toBe('7 findings dropped: outside the change (files: src/mod.ts, src/new.ts, src/other.ts, lib/util.ts, src/cut.ts, src/mod.ts (no line))')
  expect(droppedText({ n: 0, files: [] })).toBe('')
  expect(droppedText({ n: 1, files: ['a.ts'] })).toBe('1 finding dropped: outside the change (files: a.ts)')
  expect(insideChange('src/mod.ts', 12, prep)).toBe(true)
  expect(insideChange('src/mod.ts', 13, prep)).toBe(false)
  expect(insideChange('src/mod.ts', 13, prep, 3)).toBe(true) // review.contextLines 3
  expect(insideChange('src/mod.ts', 16, prep, 3)).toBe(false)
  expect(changeScope([f('src/mod.ts', 15), f('src/mod.ts', 7)], prep, 3).kept.length).toBe(2)
  expect(changeScope([f('src/mod.ts', 15), f('src/mod.ts', 7)], prep).kept.length).toBe(0)
  expect(contextOf(undefined)).toBe(0)
  expect(contextOf(3)).toBe(3)
  expect(contextOf('3')).toBe(3)
  expect(contextOf(-1)).toBe(0)
  expect(contextOf(99)).toBe(0)
})

test('a finding with no file or no line, or about something absent, is dropped; a cross-file category is kept only when it names a changed file', async () => {
  const prep = await analyzeDiff(DIFF, async () => '')
  const nofile = changeScope([f('', 0, 'tests', 'no test for the empty case'), f('', 0, 'docs', 'the readme is not updated'), f('', 0, 'scope', 'siblings share it'), f('', 0, 'correctness', 'something somewhere')], prep)
  expect(nofile.kept).toEqual([])
  expect(nofile.dropped).toEqual({ n: 4, files: ['(no file)'], notInPr: [] })
  const open = changeScope([f('src/Program.cs', 0, 'security', 'the anonymous Open endpoint has no rate limiting'), f('src/Program.cs', 40, 'security', 'no rate limiting'), f('src/mod.ts', 0, 'correctness', 'it breaks'), f('src/mod.ts', 0, 'completeness', 'missing validation of the input')], prep)
  expect(open.kept).toEqual([])
  expect(open.dropped.notInPr).toEqual(['src/Program.cs'])
  expect(open.dropped.n).toBe(4)
  const cross = changeScope([f('src/mod.ts', 0, 'tests', 'the new branch is not covered'), f('src/new.ts', 0, 'docs', 'the readme does not mention it'), f('src/mod.ts', 0, 'scope', 'a sibling shares the problem'), f('README.md', 0, 'docs', 'readme not updated'), f('tests', 0, 'tests', 'coverage lost')], prep)
  expect(cross.kept.map(x => x.category)).toEqual(['tests', 'docs', 'scope'])
  expect(cross.kept[0]!.text).toContain('[cross-file: names src/mod.ts, no line]')
  expect(cross.crossFile).toBe(3)
  expect(cross.dropped.files).toEqual(['README.md', 'tests'])
})

test('the text prepare hands the reviewer names the changed files with their ranges and the rule, and the hunks within the budget', async () => {
  const prep = await analyzeDiff(DIFF, async () => '')
  const t = changedText(prep, { diff: DIFF })
  expect(t).toContain('CHANGED CODE ONLY (6 changed files')
  expect(t).toContain('src/mod.ts 10-12')
  expect(t).toContain('src/new.ts 1-5')
  expect(t).toContain('src/gone.ts (deleted or no line ranges: the whole file counts)')
  expect(t).toContain('Report only on lines in these ranges; read other files only to understand them, never to report on them; every finding is file:line of a listed range')
  expect(t).toContain('### src/mod.ts\n-: x\n-: y\n10: x1\n11: y1\n12: z1')
  expect(t).not.toContain('over the size budget')
  const big = changedText(prep, { diff: DIFF, budget: 20 })
  expect(big).toContain('over the size budget')
  expect(big).toContain('read only these ranges')
  expect(big).not.toContain('11: y1')
  expect(changedText(prep, { diff: DIFF, context: 3 })).toContain('(or within 3 lines of it)')
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
    expect(p.text).toContain('### src/a.ts\n-: x\n-: y\n10: x1\n11: y1\n12: z1') // the hunks with new-side line numbers
    expect(p.text).toContain('every finding is file:line of a listed range')
  }
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block([fin(1, 'src/a.ts', 11), fin(2, 'src/untouched.ts', 4), fin(3, 'src/a.ts', 90), fin(4, '', 0, { category: 'tests', text: 'no test for the empty case' })]) })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('3 findings dropped: outside the change (files: src/untouched.ts, src/a.ts, (no file))')
  expect(r.text).toContain('src/a.ts:11')
  expect(r.text).not.toContain('src/untouched.ts:4')
  const a = block([fin(1, 'src/a.ts', 11), fin(2, 'src/untouched.ts', 4)])
  const b = block([fin(1, 'src/a.ts', 12, { text: 'problem 1 in the code, again' }), fin(2, 'src/elsewhere.ts', 8)])
  const m = await tool(h, { action: 'merge', reviews: [a, b] })
  expect(m.ok).toBe(true)
  expect(m.text).toMatch(/2 findings dropped: outside the change \(files: src\/untouched\.ts, src\/elsewhere\.ts\)/)
  expect(m.text).toContain('top 1 of 1')
})

// ---- 1.0.31: never unfiltered; areas only from changed files ----------------------------------------------------------------
test('merge and record refuse, and write nothing, when the PR diff cannot be read', async () => {
  const h = setup()
  const good = h.git.handler
  h.git.handler = (a: string[]) => (a.join(' ').includes(' diff ') ? { exitCode: 1, stdout: '' } : good(a, {} as any))
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block([fin(1, 'src/a.ts', 11)]) })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('could not read the PR diff: review not recorded')
  expect([...h.files.keys()].some(k => k.includes('/reviews/'))).toBe(false)
  const m = await tool(h, { action: 'merge', reviews: [block([fin(1, 'src/a.ts', 11)]), block([fin(1, 'src/a.ts', 12, { text: 'another problem' })])] })
  expect(m.ok).toBe(false)
  expect(m.text).toContain('could not read the PR diff: review not recorded')
  // an external record without its prepare (no scratch repository to read) is refused the same way
  const e = await tool(h, { sha: H2, mode: 'external', review: block([fin(1, 'src/a.ts', 11)]) })
  expect(e.ok).toBe(false)
  expect(e.text).toContain('could not read the PR diff: review not recorded')
}, { timeoutMs: 20_000 })

test('the areas of a large PR are built from the changed files only, and say how many files and lines they hold', async () => {
  const { partition: part } = await import('./reviewarea')
  const { perFileStats } = await import('./reviewprep')
  const { bigText } = await import('./reviewarea')
  const prep = await analyzeDiff(DIFF, async () => '')
  const stats = perFileStats(DIFF)
  const areas = part(stats)
  const named = areas.flatMap(a => a.keys.map(k => k.key))
  expect(named.every(k => k === '.' || stats.some(s => s.path.startsWith(`${k}/`)))).toBe(true)
  expect(areas.reduce((n, a) => n + a.files, 0)).toBe(6)
  const t = bigText(stats, prep, areas)
  expect(t).toContain('6 changed files only')
  expect(t).toContain('changed files,')
  expect(t).toContain('are in no area and are not reviewed')
})
