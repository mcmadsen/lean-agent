import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { BIG_FILES, MAX_AREAS, inArea, partition, riskiest, tooLarge, topRows, countsText } from './reviewarea'
import { readReview } from './reviews'

const L = '/h/.lean-agent'
const H2 = 'c'.repeat(40)
const MB = 'm'.repeat(40)
const newFile = (path: string, n = 3) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n') + '\n'
const bigDiff = (n: number) => Array.from({ length: n }, (_, i) => newFile(`${['api', 'web', 'db', 'docs', 'tools'][i % 5]}/mod${i % 7}/file${i}.txt`, 4)).join('')

function setup(diff: string) {
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
    if (s.includes('--name-status')) return ok(diff.split('\n').filter(l => l.startsWith('+++ b/')).map(l => `A\t${l.slice(6)}`).join('\n') + '\n')
    if (s.includes(' diff ')) return ok(diff)
    return { exitCode: 1, stdout: '' }
  }
  return h
}
const tool = (h: any, input: Record<string, unknown>) => threadTool(h.host, 't1', 'lean_review', input)

test('partition: at most 6 areas, every file in exactly one, balanced by changed lines; thresholds 300 files / 20000 lines', () => {
  const stats = Array.from({ length: 400 }, (_, i) => ({ path: `${['api', 'web', 'db', 'docs'][i % 4]}/m${i % 9}/f${i}.ts`, add: 10 + (i % 5), del: 1 }))
  expect(tooLarge(stats)).toBe(true)
  expect(tooLarge(stats.slice(0, BIG_FILES))).toBe(false)
  expect(tooLarge([{ path: 'a.ts', add: 20_001, del: 0 }])).toBe(true)
  const areas = partition(stats)
  expect(areas.length).toBeLessThanOrEqual(MAX_AREAS)
  expect(areas.reduce((n, a) => n + a.files, 0)).toBe(400)
  for (const s of stats) expect(areas.filter(a => inArea(s.path, a, areas)).length).toBe(1)
  const lines = areas.map(a => a.lines)
  expect(Math.max(...lines)).toBeLessThanOrEqual(2 * (lines.reduce((n, x) => n + x, 0) / areas.length))
  // one huge folder is split by its subfolders, files directly in it are their own group
  const lop = [...Array.from({ length: 60 }, (_, i) => ({ path: `src/p${i % 6}/f${i}.ts`, add: 100, del: 0 })), { path: 'src/index.ts', add: 5, del: 0 }, { path: 'README.md', add: 1, del: 0 }]
  const a2 = partition(lop)
  expect(a2.length).toBeGreaterThan(1)
  for (const s of lop) expect(a2.filter(a => inArea(s.path, a, a2)).length).toBe(1)
})

test('riskiest: size, new symbols, export changes and risky names, ten at most; counts and top rows are short', () => {
  const stats = [...Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, add: i, del: 0 })), { path: 'src/auth/token.ts', add: 5, del: 1 }]
  const top = riskiest(stats, { symbols: [], exports: [{ name: 'x', path: 'src/f3.ts', line: 1, kind: 'changed' }] })
  expect(top).toHaveLength(10)
  expect(top[0]!.path).toBe('src/auth/token.ts')
  const rows = Array.from({ length: 25 }, (_, i) => ({ severity: i % 2 ? 'minor' : 'major', path: `p${i}.ts`, line: i + 1, text: 'x'.repeat(300) }))
  expect(countsText(rows)).toBe('13 major, 12 minor')
  expect(topRows(rows)).toHaveLength(10)
  expect(topRows(rows)[0]!.length).toBeLessThan(160)
})

test('prepare on a diff over 300 files: counts only, the areas, no file list; scope reviews one area; an unknown scope is refused', async () => {
  const h = setup(bigDiff(320))
  const asked = await tool(h, { action: 'prepare', base: 'main', level: 'full' }) // the fan-out (areas x passes) is over review.askAboveUsd: the user decides first
  expect(asked.ok).toBe(false)
  expect(asked.text).toContain('NOT started')
  expect(asked.text).toContain('areas x 1 pass ~ $')
  const r = await tool(h, { action: 'prepare', base: 'main', level: 'full', confirm: true })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('PR TOO LARGE: 320 changed files')
  expect(r.text).toContain('this PR is too large for one review: review it by area')
  expect(r.text).toContain('- area-1:')
  expect(r.text).not.toContain('allow-cmd') // no reviewer prompt: nothing to run yet
  expect(r.text.length).toBeLessThan(3500)
  expect((r.text.match(/file\d+\.txt/g) ?? []).length).toBeLessThanOrEqual(10) // only the 10 riskiest files are named
  const a1 = await tool(h, { action: 'prepare', base: 'main', level: 'full', scope: 'area-1' })
  expect(a1.ok).toBe(true)
  expect(a1.text).toContain('"scope":"area-1"')
  expect(a1.text).toContain('AREA REVIEW area-1 of ')
  expect(a1.text).toContain('Put everything below this line in the reviewer')
  const bad = await tool(h, { action: 'prepare', base: 'main', level: 'full', scope: 'area-9' })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('is not an area of this diff')
})

test('an area record is never green and joins the earlier ones of the sha; more than 10 open findings are counts, the top 10 and the record file', async () => {
  const h = setup(bigDiff(320))
  const prep = await tool(h, { action: 'prepare', base: 'main', level: 'full', confirm: true })
  const names = [...prep.text.matchAll(/^- (area-\d+):/gm)].map(m => m[1]!)
  expect(names.length).toBeGreaterThan(1)
  const finding = (n: number) => ({ n, severity: n % 2 ? 'major' : 'minor', category: 'correctness', path: `api/mod${(5 * n) % 7}/file${5 * n}.txt`, line: 1, /* a changed file of bigDiff: findings outside the change are dropped */ text: 'it breaks on empty input', fix: 'guard it' })
  const block = (verdict: string, k: number) => ({ verdict, goal: 'g', findings: Array.from({ length: k }, (_, i) => finding(i + 1)), reuse: [], coverage: [] })
  const one = await tool(h, { sha: H2, base: 'main', level: 'full', green: true, scope: names[0], review: block('changes-requested', 14) })
  expect(one.ok).toBe(true) // an area record asks nothing green
  expect(one.text).toContain('not green')
  expect(one.text).toContain(`area ${names[0]} recorded (1 of ${names.length} areas done; still to review:`)
  expect(one.text).toContain('open findings: 14')
  expect(one.text).toContain('top 10')
  expect((one.text.match(/^- major|^- minor/gm) ?? []).length).toBe(10)
  const two = await tool(h, { sha: H2, base: 'main', level: 'full', scope: names[1], review: block('approve', 0) })
  expect(two.text).toContain('2 of')
  const rec = await readReview(h.host, 'app', H2)
  expect(rec?.green).toBe(false)
  expect(Object.keys(rec?.areas ?? {})).toEqual([names[0], names[1]])
  expect(rec?.verdicts).toEqual([`${names[0]}: changes-requested`, `${names[1]}: approve`])
  expect(rec?.findings?.length).toBe(14) // the second area added none, the first one's stay
})
