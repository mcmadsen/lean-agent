// The anchor check (anchor.ts): unified-diff hunks, the allow / refuse / cannot-verify decisions over synthetic PR diffs, the readers for GitHub and Azure DevOps with
// canned JSON, and the lint of review-comment text. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { CANNOT_VERIFY, checkAnchor, fileFromGithub, formatRanges, lintReviewText, parsePatch, prKey, verifyAnchors } from './anchor'
import type { Anchor, PrFile, Reader } from './anchor'

const PATCH = ['@@ -10,4 +10,5 @@ fn a()', ' c1', '-old', '+new1', '+new2', ' c2', ' c3', '@@ -40,2 +41,3 @@', ' ctx', '+added', ' ctx', '\\ No newline at end of file'].join('\n')

test('parsePatch: added / changed lines are the right ranges, removed lines the left ones, hunks end by their counts', () => {
  expect(parsePatch(PATCH)).toEqual({ right: [[11, 12], [42, 42]], left: [[11, 11]] })
  // a removed line that reads "-- x" and an added "++ y" are lines, not headers
  expect(parsePatch('@@ -5,1 +5,1 @@\n--- x\n+++ y')).toEqual({ right: [[5, 5]], left: [[5, 5]] })
  // the file headers before the first hunk are skipped; a count-less header is one line; adjacent additions merge
  expect(parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,3 @@\n+a\n+b\n+c')).toEqual({ right: [[1, 3]], left: [] })
  expect(parsePatch('@@ -7 +7 @@\n-a\n+b')).toEqual({ right: [[7, 7]], left: [[7, 7]] })
  expect(parsePatch('')).toEqual({ right: [], left: [] })
  expect(formatRanges([[40, 52], [98, 110], [120, 120]])).toBe('40-52, 98-110, 120')
  expect(formatRanges([])).toBe('none')
})

const gh = (o: Record<string, unknown>) => fileFromGithub(o)!
const files = (...f: PrFile[]) => new Map(f.map(x => [x.path, x]))
const A = (o: Partial<Anchor> = {}): Anchor => ({ host: 'github', org: '', project: '', repo: 'acme/shop', pr: 7, file: 'src/a.ts', line: 120, side: 'right', ...o })

test('fileFromGithub: added, modified, renamed, deleted, binary and a patch GitHub left out', () => {
  expect(gh({ filename: 'src/a.ts', status: 'modified', patch: PATCH, changes: 4 })).toMatchObject({ status: 'modified', right: [[11, 12], [42, 42]] })
  expect(gh({ filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+a\n+b', changes: 2 })).toMatchObject({ status: 'added', right: [[1, 2]] })
  expect(gh({ filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/o.ts', patch: '@@ -1,1 +1,1 @@\n-x\n+y', changes: 2 })).toMatchObject({ status: 'renamed', right: [[1, 1]], left: [[1, 1]] })
  expect(gh({ filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b', changes: 2 })).toMatchObject({ status: 'deleted', right: [], left: [[1, 2]] })
  expect(gh({ filename: 'logo.png', status: 'modified', changes: 0 })).toMatchObject({ status: 'binary' })
  expect(gh({ filename: 'src/c.ts', status: 'renamed', changes: 0 })).toMatchObject({ status: 'renamed', right: [] })
  expect(gh({ filename: 'big.sql', status: 'modified', changes: 9000 })).toMatchObject({ status: 'unknown' })
  expect(fileFromGithub({ status: 'added' })).toBeNull()
})

test('checkAnchor: an added or changed line stands, anything else is refused with the exact words', () => {
  const f = files(gh({ filename: 'src/a.ts', status: 'modified', patch: '@@ -39,2 +40,14 @@\n x\n' + '+a\n'.repeat(12) + ' y', changes: 12 }))
  expect(checkAnchor('t103', f, { file: 'src/a.ts', line: 41, side: 'right' })).toBeNull()
  expect(checkAnchor('t103', f, { file: 'src/a.ts', line: 41, endLine: 52, side: 'right' })).toBeNull()
  expect(checkAnchor('t103', f, { file: 'src/a.ts', line: 41, endLine: 60, side: 'right' })).toContain('src/a.ts:41-60')
  const two = files(gh({ filename: 'src/a.ts', status: 'modified', patch: '@@ -39,2 +40,14 @@\n x\n' + '+a\n'.repeat(12) + ' y\n@@ -95,2 +98,14 @@\n x\n' + '+b\n'.repeat(12) + ' y', changes: 24 }))
  expect(checkAnchor('t103', two, { file: 'src/a.ts', line: 120, side: 'right' })).toBe('t103 asked for src/a.ts:120: the PR does not change that line (changed ranges: 41-52, 99-110)')
  expect(checkAnchor('t103', two, { file: 'src/z.ts', line: 3, side: 'right' })).toBe('t103 asked for src/z.ts:3: the PR does not change that file')
  // a context line is not a changed line; a removed line only with side left
  const g = files(gh({ filename: 'src/g.ts', status: 'modified', patch: '@@ -1,3 +1,3 @@\n c\n-old\n+new\n d', changes: 2 }))
  expect(checkAnchor('t1', g, { file: 'src/g.ts', line: 1, side: 'right' })).toContain('changed ranges: 2')
  expect(checkAnchor('t1', g, { file: 'src/g.ts', line: 2, side: 'right' })).toBeNull()
  expect(checkAnchor('t1', g, { file: 'src/g.ts', line: 2, side: 'left' })).toBeNull()
  expect(checkAnchor('t1', g, { file: 'src/g.ts', line: 3, side: 'left' })).toBe('t1 asked for src/g.ts:3: the PR does not remove that line (removed ranges: 2)')
})

test('checkAnchor: a deleted file allows only side left; a binary file and an unreadable patch allow nothing', () => {
  const f = files(gh({ filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,3 +0,0 @@\n-a\n-b\n-c', changes: 3 }), gh({ filename: 'logo.png', status: 'modified', changes: 0 }), gh({ filename: 'big.sql', status: 'modified', changes: 9000 }), gh({ filename: 'src/n.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+a\n+b', changes: 2 }))
  expect(checkAnchor('t5', f, { file: 'src/gone.ts', line: 2, side: 'left' })).toBeNull()
  expect(checkAnchor('t5', f, { file: 'src/gone.ts', line: 2, side: 'right' })).toContain('the PR deletes that file')
  expect(checkAnchor('t5', f, { file: 'logo.png', line: 1, side: 'right' })).toContain('no text lines')
  expect(checkAnchor('t5', f, { file: 'big.sql', line: 1, side: 'right' })).toBe(CANNOT_VERIFY)
  expect(checkAnchor('t5', f, { file: 'src/n.ts', line: 2, side: 'right' })).toBeNull() // an added file: every line is new
  expect(checkAnchor('t5', f, { file: 'src/n.ts', line: 1, side: 'left' })).toContain('removed ranges: none')
  expect(CANNOT_VERIFY).toBe('could not verify the anchor: not sent')
})

// ---- the readers, canned -----------------------------------------------------------------------------------------------------------------------
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
function ghReader(over: Record<string, unknown> = {}): { r: Reader; calls: string[] } {
  const calls: string[] = []
  const canned: Record<string, unknown> = {
    'repos/acme/shop/pulls/7/files?per_page=100': [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -39,2 +40,14 @@\n x\n' + '+a\n'.repeat(12) + ' y', changes: 12 }],
    'repos/acme/shop/pulls/7': { head: { sha: SHA } },
    ...over,
  }
  return { calls, r: { gh: async p => (calls.push(p), canned[p] ?? null), az: async () => null } }
}

test('verifyAnchors (GitHub): reads files and the head once per PR, refuses by anchor, returns the head commit', async () => {
  const { r, calls } = ghReader()
  const out = await verifyAnchors(r, 't103', [A({ line: 45 }), A({ line: 120 }), A({ file: 'src/other.ts', line: 1 })])
  expect(out.refusals[0]).toBeNull()
  expect(out.refusals[1]).toBe('t103 asked for src/a.ts:120: the PR does not change that line (changed ranges: 41-52)')
  expect(out.refusals[2]).toBe('t103 asked for src/other.ts:1: the PR does not change that file')
  expect(out.heads[prKey(A())]).toBe(SHA)
  expect(calls).toEqual(['repos/acme/shop/pulls/7/files?per_page=100', 'repos/acme/shop/pulls/7'])
})

test('verifyAnchors (GitHub): a failed read, or no head commit, refuses as cannot verify', async () => {
  const bad = ghReader({ 'repos/acme/shop/pulls/7/files?per_page=100': null })
  expect((await verifyAnchors(bad.r, 't103', [A({ line: 45 })])).refusals).toEqual([CANNOT_VERIFY])
  const nohead = ghReader({ 'repos/acme/shop/pulls/7': {} })
  expect((await verifyAnchors(nohead.r, 't103', [A({ line: 45 })])).refusals).toEqual([CANNOT_VERIFY])
  const throws: Reader = { gh: async () => { throw new Error('boom') }, az: async () => null }
  expect((await verifyAnchors(throws, 't103', [A({ line: 45 })])).refusals).toEqual([CANNOT_VERIFY])
})

const AZ = 'https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api'
const AZA = (o: Partial<Anchor> = {}): Anchor => A({ host: 'azure', org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, ...o })
function azReader(diff: unknown, entries: unknown[] = [{ changeType: 'edit', item: { path: '/src/a.ts' } }, { changeType: 'delete', item: { path: '/src/gone.ts' } }, { changeType: 'edit, rename', item: { path: '/src/b.ts' }, originalPath: '/src/old.ts' }, { changeType: 'edit', item: { path: '/src', isFolder: true } }], extra: Record<string, unknown> = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const r: Reader = {
    gh: async () => null,
    az: async (method, url, body) => {
      calls.push({ method, url, body })
      if (url.startsWith(`${AZ}/pullRequests/42/iterations?`)) return { value: [{ id: 1, sourceRefCommit: { commitId: 's1' }, commonRefCommit: { commitId: 'c1' } }, { id: 2, sourceRefCommit: { commitId: 'sCommit' }, commonRefCommit: { commitId: 'cCommit' } }] }
      if (url.includes('/iterations/2/changes')) return { changeEntries: entries, ...extra }
      if (url.startsWith(`${AZ}/filediffs`)) return diff
      return null
    },
  }
  return { r, calls }
}
const BLOCKS = { value: [{ path: '/src/a.ts', lineDiffBlocks: [{ changeType: 'none', modifiedLineNumberStart: 1, modifiedLinesCount: 39, originalLineNumberStart: 1, originalLinesCount: 39 }, { changeType: 'edit', modifiedLineNumberStart: 40, modifiedLinesCount: 13, originalLineNumberStart: 40, originalLinesCount: 2 }, { changeType: 'add', modifiedLineNumberStart: 98, modifiedLinesCount: 13, originalLineNumberStart: 0, originalLinesCount: 0 }, { changeType: 'delete', modifiedLineNumberStart: 0, modifiedLinesCount: 0, originalLineNumberStart: 70, originalLinesCount: 3 }] }] }

test('verifyAnchors (Azure DevOps): the last iteration, its changes and the file diff; changed ranges and the exact refusal', async () => {
  const { r, calls } = azReader(BLOCKS)
  const out = await verifyAnchors(r, 't103', [AZA({ line: 45 }), AZA({ line: 120 }), AZA({ line: 71, side: 'left' }), AZA({ line: 100, endLine: 104 })])
  expect(out.refusals).toEqual([null, 't103 asked for src/a.ts:120: the PR does not change that line (changed ranges: 40-52, 98-110)', null, null])
  expect(calls[0]!.url).toBe(`${AZ}/pullRequests/42/iterations?api-version=7.1`)
  expect(calls[1]!.url).toBe(`${AZ}/pullRequests/42/iterations/2/changes?$top=2000&api-version=7.1`)
  const d = calls.filter(c => c.method === 'POST')
  expect(d).toHaveLength(1) // one diff per file, read once
  expect(d[0]!.body).toEqual({ fileDiffParams: [{ path: '/src/a.ts', originalPath: '/src/a.ts' }], baseVersionCommit: 'cCommit', targetVersionCommit: 'sCommit' })
})

test('verifyAnchors (Azure DevOps): not in the PR, deleted file, renamed file, numeric block types, unreadable diff, cut-short listing', async () => {
  const del = { value: [{ lineDiffBlocks: [{ changeType: 2, originalLineNumberStart: 1, originalLinesCount: 5 }] }] }
  const a = azReader(del)
  expect((await verifyAnchors(a.r, 't103', [AZA({ file: 'src/none.ts', line: 1 })])).refusals[0]).toBe('t103 asked for src/none.ts:1: the PR does not change that file')
  expect((await verifyAnchors(a.r, 't103', [AZA({ file: 'src/gone.ts', line: 3, side: 'left' })])).refusals[0]).toBeNull()
  expect((await verifyAnchors(a.r, 't103', [AZA({ file: 'src/gone.ts', line: 3 })])).refusals[0]).toContain('the PR deletes that file')
  const ren = azReader({ value: [{ lineDiffBlocks: [{ changeType: 1, modifiedLineNumberStart: 4, modifiedLinesCount: 2 }] }] })
  expect((await verifyAnchors(ren.r, 't103', [AZA({ file: 'src/b.ts', line: 5 })])).refusals[0]).toBeNull()
  expect(ren.calls.find(c => c.method === 'POST')!.body).toMatchObject({ fileDiffParams: [{ path: '/src/b.ts', originalPath: '/src/old.ts' }] })
  const none = azReader(null)
  expect((await verifyAnchors(none.r, 't103', [AZA({ line: 45 })])).refusals).toEqual([CANNOT_VERIFY])
  const cut = azReader(BLOCKS, undefined, { nextSkip: 2000 })
  expect((await verifyAnchors(cut.r, 't103', [AZA({ file: 'src/none.ts', line: 1 })])).refusals).toEqual([CANNOT_VERIFY])
  const nothing: Reader = { gh: async () => null, az: async () => null }
  expect((await verifyAnchors(nothing, 't103', [AZA({ line: 45 })])).refusals).toEqual([CANNOT_VERIFY])
})

test('lintReviewText: a pure disclaimer or a lone LGTM is refused with the reason; a real finding passes, with or without a disclaimer next to it', () => {
  for (const t of ['LGTM', 'lgtm!', 'Looks good to me.', 'Partial coverage.', 'No tests were run.', 'I could not verify this.', 'Not reviewed.', 'This review is partial. I did not run the tests.', '**Note:** partial coverage; no tests run'])
    expect([t, lintReviewText(t) !== null]).toEqual([t, true])
  expect(lintReviewText('LGTM')).toContain('approval phrase')
  expect(lintReviewText('Partial coverage.')).toContain('disclaimer')
  for (const t of ['The handler did not check for null input before reading `req.user`.', 'Off-by-one: the loop skips the last item. Partial coverage otherwise.', 'This could not be verified without the helper, but the lock is released twice.', 'Use `await` here: the promise is dropped and the error is lost.', '']) expect([t, lintReviewText(t)]).toEqual([t, null])
})
