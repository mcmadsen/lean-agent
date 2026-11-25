import { expect, test } from 'claude-code/testing'
import { enforce, fixedNumber, normalize } from './reviewgate'
import type { Context, Finding } from './reviewgate'
import { analyzeDiff } from './reviewprep'
import type { Prep } from './reviewprep'
import { prefillText } from './reviewprefill'

const prep = (p: Partial<Prep> = {}): Prep => ({ files: [], symbols: [], tests: [], renamed: [], params: [], state: [], exports: [], changed: ['src/a.ts'], lines: 20, hunks: {}, ...p })
const earlier = (n: number, text: string): Finding => ({ n, severity: 'major', category: 'correctness', path: 'src/a.ts', line: 7, text, fix: 'f' })

test('fixedNumber reads every spelling of a finding number', () => {
  for (const v of [3, '3', '#3', 'F3', 'f3', 'finding 3', { n: 3 }, { id: '3' }, { number: 3 }, { finding: '#3' }]) expect(fixedNumber(v)).toBe(3)
  for (const v of [0, -1, 1.5, 'x', null, {}, [3]]) expect(fixedNumber(v)).toBe(null)
  expect(normalize({ fixed: [1, '#2', 'F3', { n: 4 }, 'no'] }).fixed).toEqual([1, 2, 3, 4])
})

test('the prefill carries the formats and a JSON of the earlier findings', () => {
  const t = prefillText([earlier(2, 'it breaks on empty input')], [])
  expect(t).toContain('"fixed"')
  expect(t).toContain('#2 major src/a.ts:7 it breaks on empty input')
  expect(t).toContain('"fixed":[2]')
  expect(prefillText([], [])).toBe('')
})

test('the gate returns the unlisted earlier findings and the uncovered tests', () => {
  const c: Context = { prep: prep({ tests: [{ path: 'a.test.ts', test: 'adds', why: 'renamed or removed' }] }), declines: [], earlier: { open: [earlier(2, 'it breaks on empty input')], reuse: [], coverage: [] } }
  const v = enforce(normalize({ verdict: 'approve', goal: 'g' }), c)
  expect(v.green).toBe(false)
  expect(v.unlisted?.map(f => f.n)).toEqual([2])
  expect(v.uncovered?.length).toBe(1)
  const text = prefillText(v.unlisted ?? [], v.uncovered ?? [])
  const json = JSON.parse(text.split('\n').pop()!)
  expect(json.fixed).toEqual([2])
  expect(json.coverage[0]).toMatchObject({ test: 'a.test.ts: adds', status: 'intentional' })
  // the prefilled JSON answers both refusals
  const again = enforce(normalize({ verdict: 'approve', goal: 'g', ...json }), c)
  expect(again.green).toBe(true)
})

test('a deleted test file and a removed it( block each get an entry', { timeoutMs: 20_000 }, async () => {
  const diff = [
    'diff --git a/src/gone.test.ts b/src/gone.test.ts', 'deleted file mode 100644', 'index 1..0', '--- a/src/gone.test.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-const x = 1', '-run(x)',
    'diff --git a/src/b.test.ts b/src/b.test.ts', 'index 1..2', '--- a/src/b.test.ts', '+++ b/src/b.test.ts', '@@ -3,3 +3,0 @@', "-it('parses the header', () => {", '-  expect(1).toBe(1)', '-})',
  ].join('\n')
  const p = await analyzeDiff(diff, async () => '')
  expect(p.tests.map(t => `${t.path}|${t.test}|${t.why}`)).toEqual(['src/b.test.ts|parses the header|renamed or removed', 'src/gone.test.ts|gone.test.ts|file deleted'])
  const text = prefillText([], p.tests)
  expect(text).toContain('"status":"intentional"')
  expect(text).toContain('src/gone.test.ts: gone.test.ts')
  expect(text.length).toBeLessThan(1500)
})

test('the prefill is capped at 20 entries and counts the rest', () => {
  const tests = Array.from({ length: 25 }, (_, i) => ({ path: 'a.test.ts', test: `t${i}`, why: 'skipped' }))
  const text = prefillText([], tests)
  expect(text).toContain('+5 more edited tests')
  expect(JSON.parse(text.split('\n').pop()!).coverage).toHaveLength(20)
  expect(text).toContain('"status":"lost"')
})
