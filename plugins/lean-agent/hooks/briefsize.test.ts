// The desk lint of an oversized brief (briefsize.ts) on a synthetic project: sizes, fan-out words, the free context and the start reply's line.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { resetBase } from './base'
import { DEFAULT_BASE, briefLint, fanWords, freeOf, freeText, lintLine, lintRoots, pathWords, sourceBytes } from './briefsize'

const L = '/h/.lean-agent'
const APP = '/w/app'
const SID = '11111111-2222-3333-4444-555555555555'
const LIM = 120_000

function project() {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: APP } }))
  h.files.set(`${APP}/docs/living.md`, 'a'.repeat(40_000)) //  10k tokens
  h.files.set(`${APP}/docs/history.md`, 'b'.repeat(240_000)) //  60k tokens
  h.files.set(`${APP}/reports/r1.md`, 'c'.repeat(20_000)) // a folder of three: 15k tokens together
  h.files.set(`${APP}/reports/r2.md`, 'c'.repeat(20_000))
  h.files.set(`${APP}/reports/r3.md`, 'c'.repeat(20_000))
  h.files.set(`${APP}/reports/deep/x.md`, 'z'.repeat(99_000)) // not recursive
  h.files.set(`${APP}/src/a.ts`, 'x'.repeat(400))
  for (let i = 1; i <= 5; i++) h.files.set(`${APP}/a/${i}.md`, 'note\n')
  return h
}

test('the paths a brief names: files and folders, relative or absolute, never a URL; existing files only are summed (bytes / 4)', async () => {
  const text = 'read docs/living.md, ./docs/history.md and the folder reports/ plus https://example.org/docs/living.md and /w/app/src/a.ts, not nothere/ghost.md'
  expect(pathWords(text)).toEqual(['docs/living.md', './docs/history.md', 'reports/', '/w/app/src/a.ts', 'nothere/ghost.md'])
  const h = project()
  const s = await sourceBytes(h.host, pathWords(text), [APP], '/h')
  expect(s).toEqual({ bytes: 40_000 + 240_000 + 60_000 + 400, files: 6, found: 4 }) // the folder counts its 3 files, not the one beneath it
  expect(fanWords('all of it, every report, the full doc, each of them, overall')).toEqual(['all', 'every', 'full', 'each of'])
})

test('free context = the limit minus the FIXED base (unknown: 40k); the lint fires over half of it, with the numbers', async () => {
  const h = project()
  expect(freeOf(LIM, 28_200)).toBe(91_800)
  expect(freeOf(LIM, null)).toBe(120_000 - DEFAULT_BASE)
  const big = await briefLint(h.host, 'read docs/history.md and write a plan', [APP], { limit: LIM, fixed: 28_200 }) // 60k tokens > 45.9k
  expect(big?.line).toBe('this task reads about 60k tokens of sources into a thread with 92k free: split it: a READING thread that writes a summary file (one section per source) and a WRITING thread that reads only that file')
  expect(big?.line).toBe(lintLine(60_000, 91_800))
  expect(await briefLint(h.host, 'read docs/living.md and fix the typo', [APP], { limit: LIM, fixed: 28_200 })).toBeNull() // 10k of 92k free
  expect(await briefLint(h.host, 'read docs/living.md and reports/', [APP], { limit: LIM, fixed: 28_200 })).toBeNull() // 25k < 45.9k
  // against a fixed base of 90k (free 30k) the same 25k is over half
  expect(await briefLint(h.host, 'read docs/living.md and reports/', [APP], { limit: LIM, fixed: 90_000 })).not.toBeNull()
})

test('the count rule: five sources named, or two fan-out words with two sources, fire it even when they are small', async () => {
  const h = project()
  const five = await briefLint(h.host, 'compare a/1.md a/2.md a/3.md a/4.md a/5.md', [APP], { limit: LIM, fixed: 28_200 })
  expect(five?.line).toContain('(5 sources named)')
  expect(five?.line).toContain('reads about 1k tokens of sources into a thread with 92k free: split it')
  const fan = await briefLint(h.host, 'read all of src/a.ts and every note in reports/', [APP], { limit: LIM, fixed: 28_200 })
  expect(fan?.line).toContain('(2 sources named, fan-out words: all, every)')
  expect(await briefLint(h.host, 'fix all failing tests in src/a.ts', [APP], { limit: LIM, fixed: 28_200 })).toBeNull() // one fan word, one source
})

test('the roots: the project path and the thread\'s worktree; the start reply states the free context and the probe hint over a 40k base', async () => {
  const h = project()
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { path: '/w/wt', branch: 'b', thread: 't1' }, b: { path: '/w/other', thread: 't2' } }))
  expect(await lintRoots(h.host, 'app', 't1')).toEqual(['/w/wt', APP])
  expect(await lintRoots(h.host, 'nope')).toEqual([])
  expect(freeText(LIM, 28_200)).toBe('free context 92k (limit 120k, base 28k)')
  expect(freeText(LIM, null)).toBe('free context 80k (limit 120k, base ~40k assumed)')
  expect(freeText(LIM, 53_000)).toBe('free context 67k (limit 120k, base 53k); run lean_doctor overhead probe to see what the base is made of')
})

// ---- through lean_thread ------------------------------------------------------------------------------------------------------------
function threads() {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetBase()
  const h = project()
  h.clock.t = 10_000_000
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'plan', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${L}/threads/t1/context-parts.json`, JSON.stringify({ sid: SID, at: 1, first: { fixed: 28_200, full: true } }))
  const rows = [{ sessionId: SID, name: 't1 · plan', cwd: `${L}/threads/t1`, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }]
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'stop') for (const r of rows) r.pid = 0 // the process is gone after a stop
    return a[0] === '--bg' ? { exitCode: 0, stdout: 'started 99999999-8888-7777-6666-555555555555\n' } : a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(rows) } : { exitCode: 0, stdout: '' }
  }
  return h
}

test('lean_thread send: an oversized brief gets the line in the reply and in the message the thread receives; a small one nothing', async () => {
  const h = threads()
  const small = await leanThread(h.host, '/p', { action: 'send', tN: 't1', text: 'check docs/living.md' })
  expect(small.text).not.toContain('split it')
  const r = await leanThread(h.host, '/p', { action: 'send', tN: 't1', text: 'read docs/history.md and write a plan' })
  expect(r.text).toContain('this task reads about 60k tokens of sources into a thread with 92k free: split it')
  expect(h.files.get(`${L}/threads/t1/inbox.jsonl`)).toContain('a READING thread that writes a summary file')
})
