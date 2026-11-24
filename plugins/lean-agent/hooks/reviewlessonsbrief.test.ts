import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { briefLessons, makeLesson, offeredLine } from './reviewlessons'
import { readReview } from './reviews'

// 1.0.31: the lessons come WITH prepare (inside the brief, per area), the record says which ids were offered, a skipped brief is a visible warning
const L = '/h/.lean-agent'
const H2 = 'c'.repeat(40)
const MB = 'm'.repeat(40)
const MOD = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,2 +10,3 @@', '-x', '-y', '+x1', '+y1', '+z1'].join('\n') + '\n'
const newFile = (path: string, n = 3) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n') + '\n'
const bigDiff = (n: number) => Array.from({ length: n }, (_, i) => newFile(`${['api', 'web', 'db', 'docs', 'tools'][i % 5]}/mod${i % 7}/file${i}.txt`, 4)).join('')

function setup(diff: string, lessons: { text: string; paths: string[] }[] = []) {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  h.files.set(`${L}/config.json`, JSON.stringify({ review: { lessonsFallback: 0 } })) // (the general slice has its own spec)
  if (lessons.length) h.files.set(`${L}/app/review-lessons.jsonl`, lessons.map((x, i) => JSON.stringify({ ...makeLesson(i + 1, 'review-checklist', x.text, { source: 't', added: '2026-01-01' }), paths: x.paths })).join('\n') + '\n')
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    const ok = (stdout: string) => ({ exitCode: 0, stdout })
    if (s.includes('rev-parse --verify')) { const r = a[a.length - 1]!.replace('^{commit}', ''); return /^[0-9a-f]{40}$/.test(r) ? ok(r + '\n') : r === 'HEAD' ? ok(H2 + '\n') : ok('b'.repeat(40) + '\n') }
    if (s.includes('show-ref')) return { exitCode: /refs\/heads\/main$/.test(s) ? 0 : 1, stdout: '' }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: 1, stdout: '' }
    if (s.includes('merge-base')) return ok(MB + '\n')
    if (s.includes('--name-status')) return ok(diff.split('\n').filter(l => l.startsWith('+++ b/')).map(l => `${diff.includes('new file') ? 'A' : 'M'}\t${l.slice(6)}`).join('\n') + '\n')
    if (s.includes(' diff ')) return ok(diff)
    return { exitCode: 1, stdout: '' }
  }
  return h
}
const tool = (h: any, input: Record<string, unknown>) => threadTool(h.host, 't1', 'lean_review', input)
const block = { verdict: 'changes-requested', goal: 'g', findings: [{ n: 1, severity: 'minor', category: 'correctness', path: 'src/a.ts', line: 11, text: 'problem in the code', fix: 'fix it' }], reuse: [], coverage: [] }

test('prepare puts the lessons of the changed files into the brief; the record and merge name the offered ids', { timeoutMs: 20_000 }, async () => {
  const h = setup(MOD, [{ text: 'Before changing the retry path check the backoff', paths: ['src/a.ts'] }, { text: 'Billing exports need the schema version bumped', paths: ['src/billing/**'] }])
  const p = await tool(h, { action: 'prepare', base: 'main', level: 'full' })
  expect(p.ok).toBe(true)
  expect(p.text).toContain('LESSONS (1 of 2, ids #1):')
  expect(p.text).toContain('Before changing the retry path check the backoff')
  expect(p.text).not.toContain('Billing exports need')
  expect(p.text).toContain('"lessons":1')
  const m = await tool(h, { action: 'merge', reviews: [block, { ...block, findings: [{ ...block.findings[0], text: 'problem in the code, again' }] }] })
  expect(m.ok).toBe(true)
  expect(m.text).toContain('lessons offered: #1 (1 of 2)')
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('lessons offered: #1 (1 of 2)')
  expect(r.text).not.toContain('not offered')
  expect((await readReview(h.host, 'app', H2))?.lessons).toBe('lessons offered: #1 (1 of 2)')
})

test('an empty or missing store, or a failing selector: the brief says "none offered" and why, never silent', { timeoutMs: 20_000 }, async () => {
  const h = setup(MOD)
  const p = await tool(h, { action: 'prepare', base: 'main', level: 'full' })
  expect(p.text).toContain('lessons: none offered (no learned lessons for this project yet)')
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block })
  expect(r.text).toContain('lessons: none offered (the store is missing or empty)')
  expect(r.text).not.toContain('WARNING')
  const bad = await briefLessons(h.host, 'app', null as any, '')
  expect(bad.text).toMatch(/^lessons: none offered \(the selector failed: /)
  expect(bad.offered.ids).toEqual([])
  const none = setup(MOD, [{ text: 'Billing exports need the schema version bumped', paths: ['src/billing/**'] }])
  expect((await tool(none, { action: 'prepare', base: 'main', level: 'full' })).text).toContain('lessons: none offered (none of the 1 learned lessons fit these 1 changed file(s))')
})

test('record and merge of a head whose prepare brief was never made say "lessons: not offered" as a warning', { timeoutMs: 20_000 }, async () => {
  const h = setup(MOD, [{ text: 'Before changing the retry path check the backoff', paths: ['src/a.ts'] }])
  const r = await tool(h, { sha: H2, base: 'main', level: 'full', review: block })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('[WARNING lessons: not offered]')
  expect(r.text).toContain('WARNING lessons: not offered (no prepare brief of this head carried the lessons block')
  expect((await readReview(h.host, 'app', H2))?.lessons).toContain('lessons: not offered')
  const m = await tool(h, { action: 'merge', reviews: [block, { ...block, findings: [{ ...block.findings[0], text: 'another problem' }] }] })
  expect(m.text).toContain('WARNING lessons: not offered')
})

test('a PR reviewed by area: each area pass gets the lessons of ITS files, and the record keeps the ids per area', { timeoutMs: 20_000 }, async () => {
  const combos = ['api', 'web', 'db', 'docs', 'tools'].flatMap(d => [0, 1, 2, 3, 4, 5, 6].map(k => `${d}/mod${k}`))
  const h = setup(bigDiff(320), combos.map(c => ({ text: `Check the ${c.replace('/', ' ')} contract before changing it`, paths: [`${c}/**`] })))
  const a1 = await tool(h, { action: 'prepare', base: 'main', level: 'full', scope: 'area-1' })
  const a2 = await tool(h, { action: 'prepare', base: 'main', level: 'full', scope: 'area-2' })
  const ids = (t: string) => /LESSONS \((\d+) of 35, ids ([#\d ]+)\):/.exec(t)
  expect(ids(a1.text)).toBeTruthy()
  expect(ids(a2.text)).toBeTruthy()
  expect(ids(a1.text)![2]).not.toBe(ids(a2.text)![2]) // (two areas hold other folders)
  const line = await offeredLine(h.host, 'app', H2)
  expect(line).toContain('[area-1] #')
  expect(line).toContain('[area-2] #')
  expect(await offeredLine(h.host, 'app', H2, 'area-3')).toContain('lessons: not offered')
})
