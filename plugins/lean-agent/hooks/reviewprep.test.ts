import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { analyzeDiff, defaultOf, paramList, prepText, prepare, resolveRange, symbolOf, testTitle } from './reviewprep'

const diff = (...parts: string[]) => parts.join('\n') + '\n'
const file = (path: string, ...hunks: string[]) => diff(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks)
const added = (path: string, ...body: string[]) => diff(`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map(b => `+${b}`))
const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? ''
const names = (xs: { name: string }[]) => xs.map(x => x.name).sort()

test('TS/JS: new exported symbols and a new file; an edited one is not new', async () => {
  const d = file('src/a.ts', '@@ -1 +1,3 @@', '-export function old(a: number) {', '+export function old(a: number, b = 2) {', '+export const useThing = () => 1', '+export class Cache {}') + added('src/b.ts', 'export function fresh() {}')
  const p = await analyzeDiff(d, reader({ 'src/a.ts': 'export function old(a: number) {\n' }), new Set(['src/b.ts']))
  expect(names(p.symbols)).toEqual(['Cache', 'fresh', 'useThing'])
  expect(p.files).toEqual(['src/b.ts'])
  expect(p.exports).toEqual([{ name: 'old', path: 'src/a.ts', line: 1, kind: 'changed' }])
  expect(p.params.map(x => `${x.name}=${x.default}`)).toEqual(['b=2'])
})

test('a symbol in a test file is never new; a removed export is removed, a moved one is moved', async () => {
  const d = added('src/a.test.ts', 'export function helper() {}') + file('src/old.ts', '@@ -3,2 +2,0 @@', '-export function gone() {}', '-export function moved() {}') + added('src/new.ts', 'export function moved() {}')
  const p = await analyzeDiff(d, reader({}), new Set(['src/a.test.ts', 'src/new.ts']))
  expect(names(p.symbols)).toEqual(['moved'])
  expect(p.files).toEqual(['src/new.ts'])
  expect(p.exports.map(e => `${e.name}:${e.kind}`).sort()).toEqual(['gone:removed', 'moved:moved'])
})

test('Python: new def and class, private names left out, a default that was already there is not new', async () => {
  const d = file('app/svc.py', '@@ -4,2 +4,4 @@', '-def run(a, b=1):', '+def run(a, b=1, retries: int = 3):', '+def helper(x):', '+def _private(x):', '+class Worker:', '+registry = {}', '+counter = 0')
  const p = await analyzeDiff(d, reader({ 'app/svc.py': 'def run(a, b=1):\n    pass\n' }))
  expect(names(p.symbols)).toEqual(['Worker', 'helper'])
  expect(p.params.map(x => `${x.name}=${x.default}`)).toEqual(['retries=3'])
  expect(names(p.state)).toEqual(['counter', 'registry'])
})

test('state that exists at the base is not new', async () => {
  const d = file('app/svc.py', '@@ -1 +1 @@', '-registry = {}', '+registry = {"a": 1}')
  expect((await analyzeDiff(d, reader({ 'app/svc.py': 'registry = {}\n' }))).state).toEqual([])
})

test('C#: new public types and methods, defaults in a signature, a static field', async () => {
  const d = added('src/Billing.cs', 'public class Invoicer', '{', '    private static Dictionary<string, int> cache = new();', '    public static decimal Total(int qty, decimal rate = 1.5m)', '    {', '    }', '    private void Hidden() {}', '}')
  const p = await analyzeDiff(d, reader({}), new Set(['src/Billing.cs']))
  expect(names(p.symbols)).toEqual(['Invoicer', 'Total'])
  expect(p.params).toEqual([{ name: 'rate', default: '1.5m', path: 'src/Billing.cs', line: 4 }])
  expect(names(p.state)).toEqual(['cache'])
})

test('Kotlin and Java: public fun/class/method are new, private is not; Java static field', async () => {
  const k = added('app/Repo.kt', 'class Repo {', '    fun load(id: Int, force: Boolean = false): Item = TODO()', '    private fun secret() {}', '}')
  const j = added('app/Store.java', 'public class Store {', '    private static int hits = 0;', '    public static final int MAX = 3;', '    public void save(Item i) {}', '}')
  const p = await analyzeDiff(k + j, reader({}), new Set(['app/Repo.kt', 'app/Store.java']))
  expect(names(p.symbols)).toEqual(['Repo', 'Store', 'load', 'save'])
  expect(p.params.map(x => `${x.name}=${x.default}`)).toEqual(['force=false'])
  expect(names(p.state)).toEqual(['hits'])
})

test('Swift: func and struct, a defaulted parameter with a label, top-level var', async () => {
  const d = added('Sources/Net.swift', 'struct Client {', '    func fetch(_ url: String, retries: Int = 2) {}', '}', 'var shared = Client()')
  const p = await analyzeDiff(d, reader({}), new Set(['Sources/Net.swift']))
  expect(names(p.symbols)).toEqual(['Client', 'fetch'])
  expect(p.params.map(x => `${x.name}=${x.default}`)).toEqual(['retries=2'])
  expect(names(p.state)).toEqual(['shared'])
})

test('Go and Rust symbols, TS arrow and method shorthand defaults', async () => {
  const d = added('x/a.go', 'func Parse(s string) int {', '}') + added('x/b.rs', 'pub fn load() {}', 'pub struct Conf;') + added('x/c.ts', 'const f = (a = 1, b) => a', 'class Kind {', '  run(n = 5) {', '  }', '}', 'const x = call(a = 1)')
  const p = await analyzeDiff(d, reader({}), new Set(['x/a.go', 'x/b.rs', 'x/c.ts']))
  expect(names(p.symbols)).toEqual(['Conf', 'Kind', 'Parse', 'load'])
  expect(p.params.map(x => x.name).sort()).toEqual(['a', 'n'])
})

test('tests: a flipped assertion maps to its test, a deleted test, a skipped one, a pure rename needs nothing', async () => {
  const base = ["describe('x', () => {", "  it('adds', () => {", '    expect(add(1,2)).toBe(3)', '  })', "  it('keeps old', () => {", '    expect(keep()).toBe(true)', '  })', '})'].join('\n')
  const d = file('src/a.test.ts', '@@ -3 +3 @@', '-    expect(add(1,2)).toBe(3)', '+    expect(add(1,2)).toBe(4)', '@@ -5,3 +4,0 @@', "-  it('keeps old', () => {", '-    expect(keep()).toBe(true)', '-  })') +
    file('src/b.test.ts', '@@ -2 +2 @@', "-  it('parses the header', () => {", "+  it('parses the header line', () => {", '@@ -9 +9 @@', "+  it.skip('later', () => {")
  const p = await analyzeDiff(d, reader({ 'src/a.test.ts': base, 'src/b.test.ts': "x\n  it('parses the header', () => {\n" }))
  expect(p.tests.map(t => `${t.test}|${t.why}`).sort()).toEqual(['adds|assertions changed', 'keeps old|renamed or removed', 'later|skipped'])
  expect(p.renamed).toEqual([{ path: 'src/b.test.ts', from: 'parses the header', to: 'parses the header line' }])
})

test('a rename whose assertion also changed still needs a coverage entry', async () => {
  const base = ["it('sums a list', () => {", '  const v = [1]', '  expect(sum(v)).toBe(1)', '})'].join('\n')
  const d = file('t/s.test.ts', '@@ -1 +1 @@', "-it('sums a list', () => {", "+it('sums a list fast', () => {", '@@ -3 +3 @@', '-  expect(sum(v)).toBe(1)', '+  expect(sum(v)).toBe(2)')
  const p = await analyzeDiff(d, reader({ 't/s.test.ts': base }))
  expect(p.tests.map(t => `${t.test}|${t.why}`)).toEqual(['sums a list|assertions changed'])
})

test('Python, Go, Java and Kotlin test titles; XCTest and C# attributes', () => {
  expect(testTitle('def test_adds(self):')).toBe('test_adds')
  expect(testTitle('func TestParse(t *testing.T) {')).toBe('TestParse')
  expect(testTitle('    fun `adds two numbers`() {')).toBe('adds two numbers')
  expect(testTitle('    func testFetch() {')).toBe('testFetch')
  expect(testTitle('    [Fact]')).toBeNull() // the attribute line has no name: the method line below it does
  expect(testTitle('    public void AddsTwoNumbers()')).toBe('AddsTwoNumbers')
  expect(testTitle('const x = 1')).toBeNull()
})

test('a deletion-only hunk marks its spot, context lines advance the line numbers, focused tests are listed', async () => {
  const d = file('src/a.ts', '@@ -5,2 +4,0 @@', '-  if (!x) return', '-  y()') +
    file('src/b.ts', '@@ -3,3 +3,3 @@', ' keep', '-old', '+export function after() {}', ' tail') +
    file('src/c.test.ts', '@@ -1 +1 @@', "+  it.only('just this', () => {")
  const p = await analyzeDiff(d, reader({}))
  expect(p.hunks['src/a.ts']).toEqual([[4, 5]])
  expect(p.symbols).toEqual([{ name: 'after', path: 'src/b.ts', line: 4 }])
  expect(p.tests).toEqual([{ path: 'src/c.test.ts', test: 'just this', why: 'focused' }])
})

test('Latest.kt is not a test but LatestTest.kt is; config files hold no module state; using( is not a default', async () => {
  const d = added('app/Latest.kt', 'fun fresh() {}') + added('app/LatestTest.kt', 'fun fresh2() {}') + added('conf/a.toml', 'items = [') +
    added('src/Util.cs', 'public class Util {', '  public void Run() {', '    using (var s = Open(a = 1)) {', '  }', '}')
  const p = await analyzeDiff(d, reader({}), new Set(['app/Latest.kt', 'app/LatestTest.kt', 'conf/a.toml', 'src/Util.cs']))
  expect(names(p.symbols)).toEqual(['Run', 'Util', 'fresh'])
  expect(p.state).toEqual([])
  expect(p.params).toEqual([])
})

test('parameter parsing', () => {
  expect(paramList('function f(a = 1, {b = 2}, ...c) {')).toEqual(['a = 1', ' {b = 2}', ' ...c'])
  expect(paramList('if (a = 1) {')).toEqual([])
  expect(paramList('return call(a = 1)')).toEqual([])
  expect(defaultOf(' x: number = 4')).toEqual({ name: 'x', default: '4' })
  expect(defaultOf('a == b')).toBeNull()
  expect(defaultOf('cb = () => 1')).toEqual({ name: 'cb', default: '() => 1' })
  expect(symbolOf('  export async function go() {}')).toBe('go')
})

test('prepText lists each group once and says so when nothing was found', async () => {
  expect(prepText(await analyzeDiff('', reader({})))).toContain('No new symbols')
  const p = await analyzeDiff(added('s/a.ts', 'export function fresh() {}'), reader({}), new Set(['s/a.ts']))
  const t = prepText(p)
  expect(t).toContain('new file s/a.ts')
  expect(t).toContain('fresh (s/a.ts:1)')
})

test('prepare runs git for the range: merge base, diff, added files, base content', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    if (s.includes('rev-parse --verify --end-of-options HEAD^{commit}')) return { exitCode: 0, stdout: 'h'.repeat(40) + '\n' }
    if (s.includes('rev-parse --verify --end-of-options main^{commit}')) return { exitCode: 0, stdout: 'b'.repeat(40) + '\n' }
    if (s.includes('merge-base')) return { exitCode: 0, stdout: 'm'.repeat(40) + '\n' }
    if (s.includes('--name-status')) return { exitCode: 0, stdout: 'A\tsrc/n.ts\nM\tsrc/o.ts\n' }
    if (s.includes(' diff ')) return { exitCode: 0, stdout: file('src/o.ts', '@@ -1 +1,2 @@', ' x', '+export function added() {}') + added('src/n.ts', 'export function brand() {}') }
    if (s.includes(' show ')) return { exitCode: 0, stdout: 'export function other() {}\n' }
    return { exitCode: 1, stdout: '' }
  }
  const r = await resolveRange(h.host, 'app', 'main', undefined)
  expect(typeof r).toBe('object')
  const { prep: p, diff: text } = await prepare(h.host, r as any)
  expect(text).toContain('export function brand')
  expect(p.hunks['src/o.ts']).toEqual([[1, 2]])
  expect(names(p.symbols)).toEqual(['added', 'brand'])
  expect(p.files).toEqual(['src/n.ts'])
  expect(p.changed).toEqual(['src/n.ts', 'src/o.ts'])
  expect(typeof (await resolveRange(h.host, 'app', '--evil', undefined))).toBe('string')
  expect(typeof (await resolveRange(h.host, 'nope', 'main', undefined))).toBe('string')
})
