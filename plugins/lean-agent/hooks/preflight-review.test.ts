// The review pre-flight (preflight-review.ts): the forge's own file count against the prepared one, GitHub and Azure DevOps, before any reviewer starts.
// Synthetic names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { forgeCountStop, mismatch } from './preflight-review'
import type { Reader } from './anchor'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const ghFiles = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', patch: '@@ -1,1 +1,1 @@\n-a\n+b', changes: 2 }))
const ghReader = (n: number): Reader => ({ gh: async p => (p.endsWith('/files?per_page=100') ? ghFiles(n) : p === 'repos/acme/shop/pulls/7' ? { head: { sha: SHA } } : null), az: async () => null })
const AZ = 'https://dev.azure.com/acme/Shop/_apis/git/repositories/shop-api'
const azReader = (n: number): Reader => ({
  gh: async () => null,
  az: async (_m, url) => {
    if (url.startsWith(`${AZ}/pullRequests/42/iterations?`)) return { value: [{ id: 1, sourceRefCommit: { commitId: 's' }, commonRefCommit: { commitId: 'c' } }] }
    if (url.includes('/iterations/1/changes')) return { changeEntries: Array.from({ length: n }, (_, i) => ({ changeType: 'edit', item: { path: `/src/f${i}.ts` } })) }
    return null
  },
})
const thread = (h: ReturnType<typeof fakeHost>, pr: unknown) => h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ project: 'shop', pr }))

test('mismatch: prepared above max(20, 3 x forge) stops with the exact words; at the line it goes on', () => {
  expect(mismatch(380, 12, 20, 3)).toBe('prepared 380 files, the forge lists 12: wrong range; not starting reviewers')
  expect(mismatch(36, 12, 20, 3)).toBeNull()
  expect(mismatch(37, 12, 20, 3)).toContain('prepared 37 files')
  expect(mismatch(20, 1, 20, 3)).toBeNull()
  expect(mismatch(21, 1, 20, 3)).toContain('the forge lists 1')
})

test('GitHub: the thread own PR lists 12 files, 380 were prepared: stopped; 30 prepared: goes on', async () => {
  const h = fakeHost(null)
  thread(h, { host: 'github', org: 'acme', project: '', repo: 'shop', id: 7 })
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 380, ghReader(12))).toContain('prepared 380 files, the forge lists 12: wrong range; not starting reviewers')
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 30, ghReader(12))).toBeNull()
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 15, ghReader(1))).toBeNull() // under 20 files: the forge is not even asked
})

test('Azure DevOps: the iteration changes reader counts the files', async () => {
  const h = fakeHost(null)
  thread(h, { host: 'azure', org: 'acme', project: 'Shop', repo: 'shop-api', id: 42 })
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 300, azReader(9))).toContain('prepared 300 files, the forge lists 9')
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 25, azReader(9))).toBeNull()
})

test('no PR, an unreadable forge and the off switch never stop a review; config keys move the line', async () => {
  const h = fakeHost(null)
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 500, ghReader(1))).toBeNull() // no PR known (a plain branch)
  thread(h, { host: 'github', org: 'acme', project: '', repo: 'shop', id: 7 })
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 500, { gh: async () => null, az: async () => null })).toBeNull()
  expect(await forgeCountStop(h.host, 'shop', 't1', 'feature-x', 500, ghReader(1))).toBeNull() // a branch ref names no PR
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ review: { preflightRatio: 10, preflightMinFiles: 5 } }))
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 100, ghReader(12))).toBeNull() // 100 <= 10 x 12
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 130, ghReader(12))).toContain('prepared 130')
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ 'review.preflight': false }))
  expect(await forgeCountStop(h.host, 'shop', 't1', '', 500, ghReader(1))).toBeNull()
})
