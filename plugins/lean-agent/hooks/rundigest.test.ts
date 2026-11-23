// lean_run without noise (rundigest.ts): canned jest / tsc / pytest / go / cargo / eslint outputs, clean and failing; synthetic names and numbers.
import { expect, test } from 'claude-code/testing'
import { digest } from './rundigest'
import { runText } from './runjob'

const pass = Array.from({ length: 60 }, (_, i) => `PASS src/mod${i}.test.ts (1.${i} s)`)
const coverage = ['----------|---------|----------', 'File      | % Stmts | % Branch ', '----------|---------|----------', 'All files |   91.2  |   80.1   ']

test('jest clean: ONE line with the totals, no PASS lines, no coverage', () => {
  const log = [...pass, ...coverage, 'Test Suites: 60 passed, 60 total', 'Tests:       120 passed, 120 total', 'Snapshots:   0 total', 'Time:        12.3 s', 'Ran all test suites.'].join('\n')
  const d = digest(log, 0)
  expect(d).toEqual({ body: 'Tests:       120 passed, 120 total', one: true })
  const t = runText({ exit: 0, ...d, file: '/h/.lean-agent/runs/1.log' })
  expect(t.split('\n')).toHaveLength(1)
  expect(t).toBe('exit 0 · Tests:       120 passed, 120 total · full log: /h/.lean-agent/runs/1.log')
})

test('jest failing: totals, each failed test with at most 12 lines, no frames, no duplicate summary block, at most 5 then "(N more)"', () => {
  const fail = (n: number) => [
    `  ● widget ${n} › renders`,
    '',
    '    expect(received).toBe(expected)',
    '    Expected: 3',
    '    Received: 4',
    ...Array.from({ length: 20 }, (_, i) => `      detail line ${i}`),
    '      at Object.<anonymous> (src/widget.test.ts:12:5)',
    '      at node_modules/jest/run.js:9:9',
    '',
  ]
  const log = [...pass, 'FAIL src/w.test.ts', ...[1, 2, 3, 4, 5, 6, 7].flatMap(fail), 'Summary of all failing tests', ...fail(1), 'Test Suites: 1 failed, 59 passed, 60 total', 'Tests:       7 failed, 120 passed, 127 total', 'Time: 9 s'].join('\n')
  const d = digest(log, 1)
  expect(d.one).toBe(false)
  const lines = d.body.split('\n')
  expect(lines[0]).toBe('Tests:       7 failed, 120 passed, 127 total')
  expect(lines[1]).toBe('FAILED (7):')
  expect(d.body).not.toContain('●') // names are printed without the bullet
  expect(lines.filter(l => /^widget \d › renders$/.test(l))).toHaveLength(5)
  expect(d.body).toContain('(2 more)')
  expect(d.body).not.toContain('PASS')
  expect(d.body).not.toContain('at Object')
  expect(d.body).not.toContain('Time:')
  expect(lines.length).toBeLessThanOrEqual(2 + 5 * 12 + 1)
  expect(d.body).toContain('Expected: 3')
  const per = d.body.split('widget 1 › renders')[1]!.split('widget 2 › renders')[0]!.split('\n')
  expect(per.length - 1).toBeLessThanOrEqual(12) // the name line and its error lines
})

test('vitest failing: the FAIL > name header with its error lines', () => {
  const log = [' ✓ src/a.test.ts (3)', ' FAIL  src/b.test.ts > b adds', 'AssertionError: expected 2 to be 3', ' ❯ src/b.test.ts:5:3', '', ' Test Files  1 failed | 1 passed (2)', '      Tests  1 failed | 4 passed (5)', '   Duration  1.2s'].join('\n')
  const d = digest(log, 1)
  expect(d.body.split('\n')).toEqual(['Tests  1 failed | 4 passed (5)', 'FAILED (1):', 'src/b.test.ts > b adds', '  AssertionError: expected 2 to be 3'])
})

test('tsc: errors grouped by file, the first 8, then "(N more)"; clean (no output) is one line', () => {
  const errs = Array.from({ length: 11 }, (_, i) => `src/${i < 6 ? 'a' : 'b'}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number' (${i}).`)
  const d = digest([...errs, 'Found 11 errors in 2 files.'].join('\n'), 2)
  const lines = d.body.split('\n')
  expect(lines[0]).toBe('Found 11 errors in 2 files.')
  expect(lines.filter(l => /^src\/[ab]\.ts$/.test(l))).toEqual(['src/a.ts', 'src/b.ts'])
  expect(lines.filter(l => l.startsWith('  '))).toHaveLength(8)
  expect(lines).toContain('  1:5 TS2322 Type \'string\' is not assignable to type \'number\' (0).')
  expect(d.body).toContain('(3 more)')
  expect(digest('', 0)).toEqual({ body: 'no output', one: true })
})

test('eslint: problems grouped by file with the totals line', () => {
  const log = ['/r/src/a.ts', '  3:1  error  Unexpected any  no-explicit-any', '  9:7  warning  Unused variable  no-unused-vars', '', '/r/src/b.ts', '  1:1  error  Missing semicolon  semi', '', '✖ 3 problems (2 errors, 1 warning)'].join('\n')
  expect(digest(log, 1).body.split('\n')).toEqual(['✖ 3 problems (2 errors, 1 warning)', '/r/src/a.ts', '  3:1 error Unexpected any (no-explicit-any)', '  9:7 warning Unused variable (no-unused-vars)', '/r/src/b.ts', '  1:1 error Missing semicolon (semi)'])
})

test('pytest: totals, failed tests with their E lines; a clean run is one line without timing', () => {
  const log = ['..F.F.....  [100%]', '=================== FAILURES ===================', '_______________ test_add _______________', '    def test_add():', '>       assert add(1, 2) == 4', 'E       assert 3 == 4', 'E        +  where 3 = add(1, 2)', 'tests/t.py:7: AssertionError', '_______________ test_sub _______________', 'E       assert 0 == 1', '=========== short test summary info ===========', 'FAILED tests/t.py::test_add - assert 3 == 4', '========= 2 failed, 8 passed in 0.12s =========='].join('\n')
  expect(digest(log, 1).body.split('\n')).toEqual(['2 failed, 8 passed', 'FAILED (2):', 'test_add', '  E       assert 3 == 4', '  E        +  where 3 = add(1, 2)', '  tests/t.py:7: AssertionError', 'test_sub', '  E       assert 0 == 1'])
  expect(digest('..........  [100%]\n========= 10 passed in 0.30s =========', 0)).toEqual({ body: '10 passed', one: true })
})

test('go test and cargo test: package / result totals and the failed tests', () => {
  const go = ['ok  \tpkg/a\t0.011s', '--- FAIL: TestSum (0.00s)', '    sum_test.go:12: got 3, want 4', 'FAIL', 'FAIL\tpkg/b\t0.020s', 'ok  \tpkg/c\t(cached)'].join('\n')
  expect(digest(go, 1).body.split('\n')).toEqual(['go test: 2 package(s) ok, 1 FAILED', 'FAILED (1):', 'TestSum', '  sum_test.go:12: got 3, want 4'])
  const cargo = ['running 3 tests', 'test a ... ok', 'test b ... FAILED', '', 'failures:', '', '---- b stdout ----', "thread 'b' panicked at src/lib.rs:9:5:", 'assertion `left == right` failed', '', 'failures:', '    b', '', 'test result: FAILED. 2 passed; 1 failed; 0 ignored; finished in 0.01s'].join('\n')
  expect(digest(cargo, 101).body.split('\n')).toEqual(['FAILED. 2 passed; 1 failed; 0 ignored', 'FAILED (1):', 'b', "  thread 'b' panicked at src/lib.rs:9:5:", '  assertion `left == right` failed'])
})

test('mocha and node:test: totals and failures', () => {
  const mocha = ['  ✓ adds', '  2 passing (9ms)', '  1 failing', '', '  1) math', '       subtracts:', '     AssertionError: expected 1 to equal 2', '      at Context.<anonymous> (t.js:5:1)'].join('\n')
  expect(digest(mocha, 1).body.split('\n')).toEqual(['2 passing, 1 failing', 'FAILED (1):', 'math', '  subtracts:', '  AssertionError: expected 1 to equal 2'])
  const node = ['TAP version 13', 'ok 1 - adds', 'not ok 2 - subtracts', '  ---', '  error: expected 1 to equal 2', '  ...', '# tests 2', '# pass 1', '# fail 1'].join('\n')
  expect(digest(node, 1).body.split('\n')).toEqual(['tests 2, pass 1, fail 1', 'FAILED (1):', 'subtracts', '  ---', '  error: expected 1 to equal 2', '  ...'])
})

test('an unknown runner keeps the last 15 lines (progress and PASS lines dropped); a known runner that failed without a test to name keeps its last lines', () => {
  const log = [...Array.from({ length: 40 }, (_, i) => `step ${i} done`), '.....', 'PASS something', 'final line'].join('\n')
  const lines = digest(log, 2).body.split('\n')
  expect(lines).toHaveLength(15)
  expect(lines.at(-1)).toBe('final line')
  expect(digest(['Tests:       120 passed, 120 total', 'coverage threshold for lines (80%) not met'].join('\n'), 1).body).toBe('Tests:       120 passed, 120 total\ncoverage threshold for lines (80%) not met')
})
