import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { greenReview } from './reviews'
import { parseExt } from './reviewext'
import { newOrReview, reviewOf } from './reviewkind'
import { reviewReport } from './reviewevidence'

const L = '/h/.lean-agent'
const HEAD = 'e'.repeat(40)
const BASE = 'b'.repeat(40)
const SCRATCH = `${L}/scratch/ext-app`
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n'
const ok = (stdout = '') => ({ exitCode: 0, stdout })
const approve = { verdict: 'approve', goal: 'g', findings: [], reuse: [], coverage: [] }

function setup(thread = 't1', marker = true) {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/threads/${thread}/thread.json`, JSON.stringify({ id: thread, project: 'app' }))
  if (marker) h.store.set(`review.marker.${thread}`, { kind: 'review', project: 'app', ref: '12', ts: 1 })
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    if (s.includes('remote get-url')) return ok('https://git.example/org/app.git\n')
    if (s.includes(' init ') || s.includes(' fetch ')) return ok()
    if (s.includes('rev-parse')) { const r = a[a.length - 1]!.replace('^{commit}', ''); return ok((r.startsWith('refs/ext/head') ? HEAD : r.startsWith('refs/ext/base') ? BASE : r) + '\n') }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: 1, stdout: '' }
    if (s.includes('merge-base')) return ok(BASE + '\n')
    if (s.includes('--name-status')) return ok('M\tsrc/a.ts\n')
    if (s.includes(' diff ')) return ok(DIFF)
    return { exitCode: 1, stdout: '' }
  }
  return h
}
const tool = (h: any, input: Record<string, unknown>, thread = 't1') => threadTool(h.host, thread, 'lean_review', input)

test('reviewOf: exactly one of pr, branch, sha; plain words only', () => {
  expect(reviewOf({})).toBeNull()
  expect(reviewOf({ review: { pr: 12 } })).toEqual({ ref: '12', label: 'PR #12' })
  expect(reviewOf({ review: { branch: 'feat/x', base: 'main' } })).toEqual({ ref: 'feat/x', label: 'branch feat/x', base: 'main' })
  expect(reviewOf({ review: { sha: HEAD } })).toMatchObject({ label: `commit ${HEAD.slice(0, 10)}` })
  expect(typeof reviewOf({ review: {} })).toBe('string')
  expect(typeof reviewOf({ review: { pr: 1, branch: 'x' } })).toBe('string')
  expect(typeof reviewOf({ review: { branch: 'a b' } })).toBe('string')
  expect(typeof reviewOf({ review: 'x' })).toBe('string')
})

test('new with review: the brief comes from the template and names the skill; haiku is raised to sonnet; a marker is written; a plain new is untouched', async () => {
  const h = fakeHost(null)
  h.files.set('/root/templates/review-brief.md', 'Review {{label}} of {{project}} via lean-agent:review ({{ref}}{{baseArg}})')
  let seen: any
  const create = async (x: any) => { seen = x; return { ok: true, text: 't4 started', data: { id: 't4' } } }
  const r = await newOrReview(h.host, '/root', { action: 'new', project: 'app', model: 'haiku', text: 'be quick', review: { pr: 12, base: 'main' } }, create)
  expect(seen).toMatchObject({ model: 'sonnet', effort: 'high', title: 'Review PR #12', project: 'app' })
  expect(seen.text).toContain('Review PR #12 of app via lean-agent:review (12 and base "main")')
  expect(seen.text).toContain('From the user: be quick')
  expect(r.text).toContain('haiku was raised to sonnet')
  expect(h.store.get('review.marker.t4')).toMatchObject({ kind: 'review', project: 'app', ref: '12', base: 'main' })
  seen = undefined
  await newOrReview(h.host, '/root', { action: 'new', title: 'x', project: 'app' }, create)
  expect(seen).toEqual({ action: 'new', title: 'x', project: 'app' })
  expect((await newOrReview(h.host, '/root', { action: 'new', review: { pr: 1 } }, create)).ok).toBe(false) // no project
  expect((await newOrReview(h.host, '/root', { action: 'new', project: 'app', review: {} }, create)).ok).toBe(false)
})

test('external prepare reads a PR into a scratch repo (never the project tree) and the record is never green', async () => {
  const h = setup()
  const p = await tool(h, { action: 'prepare', ref: '12', base: 'main', level: 'full' })
  expect(p.ok).toBe(true)
  expect(p.text).toContain('EXTERNAL REVIEW of PR #12')
  expect(p.text).toContain(SCRATCH)
  expect(p.text).toContain(HEAD)
  const git = h.calls.filter(c => c.argv[0] === 'git').map(c => c.argv.join(' '))
  expect(git.some(c => c.includes(`-C ${SCRATCH} fetch`) && c.includes('-- https://git.example/org/app.git refs/pull/12/head:refs/ext/head'))).toBe(true)
  expect(git.filter(c => c.includes('-C /r/app'))).toEqual(['git -C /r/app remote get-url origin']) // the project's own checkout is asked its origin, nothing else
  expect(git.some(c => /worktree|checkout|reset|\bpush\b/.test(c))).toBe(false)
  const r = await tool(h, { sha: HEAD, mode: 'external', green: true, base: 'main', passes: 2, review: approve })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('never counts for the push gate')
  expect(r.text).toContain('PR vote:') // 1.0.31: the record says what the comment request ends with
  expect(await greenReview(h.host, 'app', HEAD)).toBe(false)
  const rec = JSON.parse(h.files.get(`${L}/app/reviews/${HEAD}.json`)!)
  expect(rec).toMatchObject({ green: false, mode: 'external', level: 'full', verdicts: ['approve'], passes: 2 })
  // no prepare for this sha: nothing to read
  const lost = await tool(h, { sha: 'f'.repeat(40), mode: 'external', review: approve })
  expect(lost.text).toContain('needs lean_review prepare with ref')
})

test('prepare warns about a large PR (over 400 changed lines or 15 files), refuses nothing, and the switch review.prChecks turns it off', async () => {
  const big = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,451 @@\n-x\n${'+y\n'.repeat(450)}`
  const h = setup()
  const old = h.git.handler
  h.git.handler = (a: string[], c: any) => (a.join(' ').includes(' diff ') && !a.join(' ').includes('--name-status') ? ok(big) : old(a, c))
  const p = await tool(h, { action: 'prepare', ref: '12', base: 'main', level: 'full' })
  expect(p.ok).toBe(true)
  expect(p.text).toContain('large PR: consider splitting; 1 files / 451 lines')
  const small = await tool(setup(), { action: 'prepare', ref: '12', base: 'main', level: 'full' })
  expect(small.text).not.toContain('large PR')
  const off = setup()
  off.files.set(`${L}/config.json`, JSON.stringify({ review: { prChecks: { size: false } } }))
  const o2 = off.git.handler
  off.git.handler = (a: string[], c: any) => (a.join(' ').includes(' diff ') && !a.join(' ').includes('--name-status') ? ok(big) : o2(a, c))
  expect((await tool(off, { action: 'prepare', ref: '12', base: 'main', level: 'full' })).text).not.toContain('large PR')
})

test('external: an unreadable ref or a URL of another repo is refused before anything is computed', async () => {
  const h = setup()
  h.git.handler = (a: string[]) => (a.join(' ').includes('remote get-url') ? ok('git@host:org/app.git\n') : a.join(' ').includes(' init ') ? ok() : { exitCode: 1, stdout: '' })
  const gone = await tool(h, { action: 'prepare', ref: 'nope', level: 'full' })
  expect(gone.ok).toBe(false)
  expect(gone.text).toContain('cannot read branch nope')
  const other = await tool(h, { action: 'prepare', ref: 'https://git.example/org/else/pull/3', level: 'full' })
  expect(other.text).toContain('is for else')
  expect(parseExt('#5')).toEqual({ pr: 5 })
  expect(parseExt('https://dev.azure.com/o/p/_git/app/pullrequest/9')).toEqual({ pr: 9, repo: 'app' })
  expect(typeof parseExt('https://x.test/nothing')).toBe('string')
  expect(typeof parseExt('a..b')).toBe('string')
})

test('report gate: a review thread cannot report done without a record for the reviewed sha; the evidence is appended from the store', async () => {
  const h = setup()
  expect((await reviewReport(h.host, 't1', 'working', 'halfway')).text).toBe('halfway')
  const none = await reviewReport(h.host, 't1', 'done', 'looks fine')
  expect(none.ok).toBe(false)
  expect(none.text).toContain('no lean_review prepare')
  expect((await reviewReport(h.host, 't1', ' done\n', 'looks fine')).ok).toBe(false) // a padded state is the same word (threadTool trims it)
  await tool(h, { action: 'prepare', ref: '12', base: 'main', level: 'full' })
  const noRec = await reviewReport(h.host, 't1', 'done', 'looks fine')
  expect(noRec.ok).toBe(false)
  expect(noRec.text).toContain('no lean_review record exists')
  // a record file a session wrote by hand (no valid signature) is no record
  h.files.set(`${L}/app/reviews/${HEAD}.json`, JSON.stringify({ project: 'app', sha: HEAD, green: true, level: 'full', sig: 'x' }))
  expect((await reviewReport(h.host, 't1', 'done', 'looks fine')).ok).toBe(false)
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', passes: 3 }) // a bare record (no reviewer result) is no review
  const bare = await reviewReport(h.host, 't1', 'done', 'looks fine')
  expect(bare.ok).toBe(false)
  expect(bare.text).toContain('not a full-level review record')
  await tool(h, { sha: HEAD, mode: 'external', base: 'main', passes: 1, review: { ...approve, findings: [{ n: 1, severity: 'minor', category: 'style', path: 'src/a.ts', line: 1, text: 'naming', fix: 'rename' }] } })
  const done = await reviewReport(h.host, 't1', 'done', 'looks fine')
  expect(done.ok).toBe(true)
  expect(done.text).toContain('looks fine')
  expect(done.text).toContain(`record sha: ${HEAD}`)
  expect(done.text).toContain('level: full, external')
  expect(done.text).toContain('verdicts: approve')
  expect(done.text).toContain('1 minor')
})

test('report gate: a light record is not enough, and a thread that is not a review thread is never gated', async () => {
  const h = setup()
  await tool(h, { action: 'prepare', ref: '12', base: 'main', level: 'light' })
  await tool(h, { sha: HEAD, mode: 'external', level: 'light', base: 'main', review: approve })
  const r = await reviewReport(h.host, 't1', 'done', 'x')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('light pass')
  const plain = setup('t2', false)
  expect(await reviewReport(plain.host, 't2', 'done', 'x')).toEqual({ ok: true, text: 'x' })
})
