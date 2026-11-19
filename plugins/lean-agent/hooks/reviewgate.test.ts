import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { greenReview } from './reviews'
import { enforce, isDeclined, normalize } from './reviewgate'
import type { Context } from './reviewgate'
import type { Prep } from './reviewprep'
import { chooseModel, classifyRisk, wantSecondOpinion } from './reviewrisk'

const prep = (p: Partial<Prep> = {}): Prep => ({ files: [], symbols: [], tests: [], renamed: [], params: [], state: [], exports: [], changed: ['src/a.ts'], lines: 20, hunks: {}, ...p })
const ctx = (p: Partial<Prep> = {}, extra: Partial<Context> = {}): Context => ({ prep: prep(p), declines: [], ...extra })
const base = { verdict: 'approve', goal: 'g', findings: [], reuse: [], coverage: [] }
const finding = (o: Record<string, unknown>) => ({ n: 1, severity: 'major', category: 'correctness', path: 'src/a.ts', line: 3, text: 'it breaks on empty input', fix: 'guard it', ...o })
const run = (r: Record<string, unknown>, c: Context = ctx()) => enforce(normalize({ ...base, ...r }), c)
const sym = (name: string, path = 'src/a.ts') => ({ name, path, line: 1 })

test('a clean review of a small change is green', () => {
  const v = run({})
  expect(v.green).toBe(true)
  expect(v.reasons).toEqual([])
})

test('green is refused for a new symbol without a reuse entry, and allowed with one', () => {
  const c = ctx({ symbols: [sym('fetchAll'), sym('Cache')] })
  const v = run({ reuse: [{ symbol: 'fetchAll', candidate: '', verdict: 'justified-new', why: 'nothing else lists every page of the api' }] }, c)
  expect(v.green).toBe(false)
  expect(v.reasons.join('\n')).toContain('Cache (src/a.ts)')
  expect(v.reasons.join('\n')).not.toContain('fetchAll (')
  const ok = run({ reuse: [{ symbol: 'fetchAll', verdict: 'extends-existing', why: 'x' }, { symbol: 'Cache', candidate: 'src/c.ts:4 Store', verdict: 'wraps-existing', why: 'thin' }] }, c)
  expect(ok.green).toBe(true)
})

test('green is refused for an edited test without a coverage entry', () => {
  const c = ctx({ tests: [{ path: 'src/a.test.ts', test: 'adds two numbers', why: 'assertions changed' }] })
  expect(run({}, c).green).toBe(false)
  expect(run({}, c).reasons[0]).toContain("'adds two numbers'")
  expect(run({ coverage: [{ test: 'src/a.test.ts: adds two numbers', protected: 'sum', status: 'still-covered' }] }, c).green).toBe(true)
  const lost = run({ coverage: [{ test: 'adds two numbers', protected: 'sum of two', status: 'lost' }] }, c)
  expect(lost.green).toBe(false)
  expect(lost.open.some(f => f.category === 'tests' && f.severity === 'major')).toBe(true)
})

test('an open blocker or major refuses green; minor and nit do not', () => {
  expect(run({ findings: [finding({ severity: 'major' })] }).green).toBe(false)
  expect(run({ findings: [finding({ severity: 'blocker' })] }).green).toBe(false)
  const v = run({ findings: [finding({ severity: 'minor' }), finding({ severity: 'nit', n: 2 })] })
  expect(v.green).toBe(true)
  expect(v.open).toHaveLength(2)
})

test('duplication, scope and platform findings are at least major', () => {
  for (const category of ['duplication', 'scope', 'platform']) {
    const v = run({ findings: [finding({ severity: 'minor', category })] })
    expect(v.open[0]!.severity).toBe('major')
    expect(v.green).toBe(false)
  }
})

test('a duplicate verdict outside the change becomes a major duplication finding; inside the change it does not', () => {
  const c = ctx({ symbols: [sym('retryFetch')], hunks: { 'src/new.ts': [[1, 40]] } })
  const dup = run({ reuse: [{ symbol: 'retryFetch', candidate: 'src/net.ts:12 withRetry', verdict: 'duplicate', why: 'same loop' }] }, c)
  expect(dup.open.map(f => `${f.severity}/${f.category}`)).toEqual(['major/duplication'])
  const self = run({ reuse: [{ symbol: 'retryFetch', candidate: 'src/new.ts:10 retryFetch', verdict: 'duplicate', why: 'itself' }] }, c)
  expect(self.open).toEqual([])
})

test('unverified goes to checks, optional is minor', () => {
  const v = run({ findings: [finding({ text: 'I could not verify the caller, maybe it leaks' }), finding({ n: 2, text: 'rename it as a follow-up', fix: 'optional' })] })
  expect(v.green).toBe(true)
  expect(v.checks.some(c => c.what.startsWith('unverified'))).toBe(true)
  expect(v.open[0]!.severity).toBe('minor')
})

test('siblings, unintended changes, removed side effects and goal-blocking gaps are major findings', () => {
  const v = run({
    siblings: [{ checked: 'LoginDialog has the same reset bug', needs_fix: true }],
    user_facing: [{ what: 'error text', where: 'src/m.ts:9', before: 'a', after: 'b', intended: false }],
    removed_effects: [{ where: 'src/s.ts:3', effect: 'cache refresh', still_done: false, intended: false }],
    gaps: [{ what: 'no upload step', path: 'ci.yml', blocks_goal: true, scoped_out: '' }],
  })
  expect(v.open.map(f => f.category).sort()).toEqual(['compatibility', 'completeness', 'correctness', 'scope'])
  expect(v.green).toBe(false)
  const ok = run({ gaps: [{ what: 'docs later', path: 'README.md', blocks_goal: true, scoped_out: 'stated in the PR text' }], removed_effects: [{ where: 'a:1', effect: 'x', still_done: false, intended: true }], user_facing: [{ what: 'w', intended: true }] })
  expect(ok.green).toBe(true)
})

test('a needs-checks verdict, changes-requested without findings, and a missing verdict refuse green', () => {
  expect(run({ verdict: 'needs-checks', checks: [{ what: 'run the migration on a copy', why: 'x' }] }).green).toBe(false)
  expect(run({ verdict: 'changes-requested' }).green).toBe(false)
  expect(enforce(normalize({}), ctx()).green).toBe(false)
  expect(enforce(normalize(null), ctx()).reasons[0]).toContain('no verdict')
})

test('second-opinion candidates must be answered; a short justified-new does not reject one', () => {
  const second = [{ symbol: 'Registry', candidate: 'src/r.ts:2 Registry' }]
  const c = ctx({ symbols: [sym('Registry')] }, { second })
  expect(run({ reuse: [] }, c).reasons.join('\n')).toContain('second opinion')
  const short = run({ reuse: [{ symbol: 'Registry', candidate: 'src/r.ts:2', verdict: 'justified-new', why: 'different' }] }, c)
  expect(short.green).toBe(false)
  expect(short.reasons.join('\n')).toContain('without saying why')
  const good = run({ reuse: [{ symbol: 'Registry', candidate: 'src/r.ts:2', verdict: 'wraps-existing', why: 'calls it' }] }, c)
  expect(good.green).toBe(true)
})

test('declines drop a matching finding last and never flip a verdict by themselves', () => {
  const f = finding({ category: 'duplication', text: 'copies `retryFetch` from net.ts' })
  const c = ctx({}, { declines: [{ kind: 'duplication', symbol: 'retryFetch', all: true, why: 'separate ticket' }] })
  const v = run({ findings: [f] }, c)
  expect(v.green).toBe(true)
  expect(v.declined).toHaveLength(1)
  expect(v.notes.join()).toContain('declined')
  // another kind or symbol is still open
  expect(run({ findings: [finding({ category: 'correctness', text: 'retryFetch loops' })] }, ctx({}, { declines: [{ kind: 'duplication', symbol: 'retryFetch', why: 'x' }] })).green).toBe(false)
  // a reviewer that says changes-requested with only a declined finding is still reported as is
  expect(run({ verdict: 'changes-requested', findings: [f] }, c).green).toBe(true)
  expect(isDeclined(normalize({ findings: [{ severity: 'minor', category: 'style', path: 'a/b.ts', text: 'the label formatter repeats a pattern' }] }).findings[0]!, [{ path: 'x/b.ts', text: 'the label formatter repeats a pattern', why: 'ok' }])).toBe(true)
})

test('re-review: a new major about code unchanged since the last review is minor; an earlier open one and a changed line keep theirs', () => {
  const delta = prep({ hunks: { 'src/a.ts': [[10, 20]] } })
  const earlier = { open: [normalize({ findings: [finding({ text: 'empty input crashes the parser' })] }).findings[0]!], reuse: [], coverage: [] }
  const c = ctx({}, { delta, earlier })
  const v = run({ findings: [finding({ line: 99, text: 'a brand new complaint about unrelated code' }), finding({ n: 2, line: 12, text: 'changed line is wrong again' }), finding({ n: 3, line: 99, text: 'empty input crashes the parser still' })] }, c)
  expect(v.open.map(f => `${f.line}:${f.severity}`)).toEqual(['99:minor', '12:major', '99:major'])
  expect(v.notes.join()).toContain('did not change since the last review')
})

test('an earlier round\'s reuse and coverage entries still count', () => {
  const c = ctx({ symbols: [sym('Cache')], tests: [{ path: 't.test.ts', test: 'keeps entries', why: 'assertions changed' }] }, { earlier: { open: [], reuse: [{ symbol: 'Cache', candidate: '', verdict: 'justified-new', why: 'nothing else caches this' }], coverage: [{ test: 'keeps entries', protected: 'x', status: 'still-covered' }] } })
  expect(run({}, c).green).toBe(true)
})

test('risk: security words, schema paths and removed exports choose opus; docs-only and re-review sonnet; second opinion for new abstractions', () => {
  const diff = '+++ b/src/session.ts\n+  const token = signature(secret)\n'
  expect(chooseModel(prep({ changed: ['src/session.ts'] }), diff).model).toBe('opus')
  expect(classifyRisk(prep({ changed: ['db/migrations/001.sql'] }), '')).toContain('migration/schema/storage')
  expect(classifyRisk(prep({ exports: [{ name: 'publicFn', path: 'a.ts', line: 1, kind: 'removed' }] }), '')[0]).toContain('removes public symbols: publicFn')
  expect(chooseModel(prep({ lines: 900 }), '').why).toContain('large diff')
  expect(chooseModel(prep({ changed: ['README.md', 'docs/a.md'] }), '+secret\n').model).toBe('sonnet')
  expect(chooseModel(prep({ changed: ['src/a.ts'] }), diff, { rereview: true })).toEqual({ model: 'sonnet', why: 're-review' })
  expect(chooseModel(prep(), '', { config: 'fable' }).model).toBe('fable')
  expect(chooseModel(prep(), '').model).toBe('sonnet')
  expect(wantSecondOpinion(prep({ symbols: [sym('abc'), sym('def'), sym('ghi')] }))).toBe(true)
  expect(wantSecondOpinion(prep({ symbols: [sym('abc')] }))).toBe(false)
  expect(wantSecondOpinion(prep({ changed: Array.from({ length: 12 }, (_, i) => `f${i}.ts`) }))).toBe(false) // nothing new to look for
})

// ---- the lean_review tool, through a scripted git -------------------------------------------------------------------------
const L = '/h/.lean-agent'
const H1 = 'a'.repeat(40)
const H2 = 'c'.repeat(40)
const MB = 'm'.repeat(40)
const newFileDiff = (path: string, ...body: string[]) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map(b => `+${b}`)].join('\n') + '\n'
function setup(diffs: Record<string, string>, added: Record<string, string> = {}) {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    const ok = (stdout: string) => ({ exitCode: 0, stdout })
    if (s.includes('rev-parse --verify')) { const r = a[a.length - 1]!.replace('^{commit}', ''); return /^[0-9a-f]{40}$/.test(r) ? ok(r + '\n') : r === 'HEAD' ? ok(H2 + '\n') : ok('b'.repeat(40) + '\n') }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: a[a.length - 2] === H1 ? 0 : 1, stdout: '' }
    if (s.includes('merge-base')) return ok(MB + '\n')
    if (s.includes('--name-status')) return ok((added[a[a.length - 2]!] ?? added['*'] ?? '') )
    if (s.includes(' diff ')) return ok(diffs[a[a.length - 2]!] ?? diffs['*'] ?? '')
    return { exitCode: 1, stdout: '' }
  }
  return h
}
const tool = (h: any, input: Record<string, unknown>) => threadTool(h.host, 't1', 'lean_review', input)
const rec = (h: any, sha: string) => JSON.parse(h.files.get(`${L}/app/reviews/${sha}.json`)!)

test('lean_review record: green without the reviewer\'s JSON is refused and recorded not green; a plain not-green record is fine', async () => {
  const h = setup({})
  const r = await tool(h, { sha: H1, green: true, passes: 2 })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('green refused')
  expect(rec(h, H1).green).toBe(false)
  expect((await tool(h, { sha: H1, green: false, findings: ['x'] })).ok).toBe(true)
  expect((await tool(h, { sha: 'zz', green: true })).ok).toBe(false)
  expect(await greenReview(h.host, 'app', H1)).toBe(false)
})

test('lean_review record: a new symbol without a reuse entry refuses green, with one it is signed and the push gate sees it', async () => {
  const d = newFileDiff('src/cache.ts', 'export class Cache {}')
  const h = setup({ '*': d }, { '*': 'A\tsrc/cache.ts\n' })
  const bad = await tool(h, { sha: H2, base: 'main', green: true, review: { ...base } })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('Cache (src/cache.ts)')
  expect(await greenReview(h.host, 'app', H2)).toBe(false)
  const good = await tool(h, { sha: H2, base: 'main', green: true, review: { ...base, reuse: [{ symbol: 'Cache', candidate: '', verdict: 'justified-new', why: 'there is no other cache in this module at all' }], searches: [{ for: 'cache', found: 'nothing' }] } })
  expect(good.ok).toBe(true)
  expect(await greenReview(h.host, 'app', H2)).toBe(true)
  // the same result as a JSON string, as a thread may pass it
  expect((await tool(h, { sha: H2, base: 'main', green: true, review: JSON.stringify({ ...base, findings: [finding({})] }) })).ok).toBe(false)
  expect(await greenReview(h.host, 'app', H2)).toBe(false)
})

test('lean_review record: an unknown project or an unresolvable base is never green', async () => {
  const h = setup({})
  h.git.handler = () => ({ exitCode: 1, stdout: '' })
  const r = await tool(h, { sha: H1, base: 'main', green: true, review: { ...base } })
  expect(r.ok).toBe(false)
  expect(rec(h, H1).green).toBe(false)
  const u = await threadTool(h.host, 't1', 'lean_review', { project: 'nope', sha: H1, base: 'main', green: true, review: { ...base } })
  expect(u.ok).toBe(false)
})

test('lean_review prepare: lists from the diff, the model with its reason, the second opinion advice and the declines', async () => {
  const body = ['export function alpha1() {}', 'export function beta2() {}', 'export function gamma3() {}', 'const token = secret']
  const h = setup({ '*': newFileDiff('src/auth.ts', ...body) }, { '*': 'A\tsrc/auth.ts\n' })
  await tool(h, { action: 'decline', branch: 'feat', kind: 'duplication', symbol: 'alpha1', why: 'separate ticket' })
  const r = await tool(h, { action: 'prepare', base: 'main', branch: 'feat' })
  expect(r.ok).toBe(true)
  const meta = JSON.parse(r.text.split('\n')[0]!.replace('LEAN-REVIEW-PREP ', ''))
  expect(meta).toMatchObject({ model: 'opus', secondOpinion: true, rereview: false, newSymbols: 3, mb: MB })
  expect(r.text).toContain('reviewer model: opus (risk: security-sensitive')
  expect(r.text).toContain('alpha1 (src/auth.ts:1)')
  expect(r.text).toContain('Declined by the user')
  expect(r.text).toContain('duplication alpha1')
  // another branch does not see it
  expect((await tool(h, { action: 'prepare', base: 'main', branch: 'other' })).text).not.toContain('Declined by the user')
})

test('lean_review decline: needs why, a branch or all, and a symbol (a bare kind would silence a category)', async () => {
  const h = setup({})
  expect((await tool(h, { action: 'decline', branch: 'b', kind: 'scope', symbol: 'X' })).ok).toBe(false)
  expect((await tool(h, { action: 'decline', kind: 'scope', symbol: 'X', why: 'y' })).ok).toBe(false)
  expect((await tool(h, { action: 'decline', branch: 'b', kind: 'scope', why: 'y' })).ok).toBe(false)
  const ok = await tool(h, { action: 'decline', all: true, kind: 'scope', symbol: 'X', why: 'y' })
  expect(ok.ok).toBe(true)
  expect(h.files.get(`${L}/app/review-declines.jsonl`)).toContain('"all":true')
})

test('lean_review re-review: the second round gets the open findings and the delta; the first round\'s reuse entries still count; a decline lets green through', async () => {
  const first = newFileDiff('src/cache.ts', 'export class Cache {}')
  const delta = ['diff --git a/src/cache.ts b/src/cache.ts', '--- a/src/cache.ts', '+++ b/src/cache.ts', '@@ -1 +1,2 @@', ' export class Cache {}', '+// fixed'].join('\n') + '\n'
  const h = setup({ '*': first, [H1]: delta }, { '*': 'A\tsrc/cache.ts\n', [H1]: '' })
  const r1 = await tool(h, { sha: H1, base: 'main', branch: 'feat', green: true, review: { ...base, reuse: [{ symbol: 'Cache', candidate: '', verdict: 'justified-new', why: 'there is no other cache in this module at all' }], findings: [finding({ text: 'the cache never expires entries', category: 'correctness' })], verdict: 'changes-requested' } })
  expect(r1.ok).toBe(false)
  expect(r1.text).toContain('open major')
  const p = await tool(h, { action: 'prepare', base: 'main', branch: 'feat' })
  expect(p.text).toContain('RE-REVIEW')
  expect(p.text).toContain(`diff ${H1}...${H2}`)
  expect(p.text).toContain('the cache never expires entries')
  expect(JSON.parse(p.text.split('\n')[0]!.replace('LEAN-REVIEW-PREP ', ''))).toMatchObject({ rereview: true, since: H1, model: 'sonnet' })
  // round 2: no reuse entry in this round's JSON, the earlier one counts; the fixed finding is gone
  const r2 = await tool(h, { sha: H2, base: 'main', branch: 'feat', green: true, review: { ...base } })
  expect(r2.ok).toBe(true)
  expect(await greenReview(h.host, 'app', H2)).toBe(true)
  // a record file a session wrote by hand carries nothing: no earlier round is found for it
  h.files.set(`${L}/app/reviews/${'d'.repeat(40)}.json`, JSON.stringify({ project: 'app', sha: 'd'.repeat(40), green: false, open: [], reuse: [{ symbol: 'Cache' }] }))
  expect((await tool(h, { action: 'prepare', base: 'main', branch: 'feat', since: 'd'.repeat(40) })).text).not.toContain('the cache never expires')
})
