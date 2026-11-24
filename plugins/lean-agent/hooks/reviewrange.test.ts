import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { fetchExternal } from './reviewext'

// The range of a PR ref (1.0.31): the merge commit against its FIRST PARENT, never the old branch point. A synthetic origin: PR 7 has a source
// head S, a merge commit M (parents P1 = the target tip, S) and the default branch main at T (a commit weeks ahead of the branch point).
const L = '/h/.lean-agent'
const [S, M, P1, T] = ['5', 'a', '1', '7'].map(c => c.repeat(40))
function origin(merge: boolean) {
  const h = fakeHost(null)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  const refs = new Map<string, string>()
  const remote: Record<string, string> = { 'refs/pull/7/head': S!, 'refs/heads/main': T! , ...(merge ? { 'refs/pull/7/merge': M! } : {}) }
  const known = new Set([S, M, P1, T])
  h.git.handler = (a: string[]) => {
    const s = a.join(' ')
    const ok = (stdout = '') => ({ exitCode: 0, stdout })
    if (s.includes('remote get-url')) return ok('https://git.example/org/app.git\n')
    if (s.includes(' init ')) return ok()
    if (s.includes(' fetch ')) {
      const [src, dst] = a[a.length - 1]!.split(':')
      const v = remote[src!]
      if (!v) return { exitCode: 1, stdout: '' }
      refs.set(dst!, v)
      return ok()
    }
    if (s.includes('rev-list --parents')) return ok(a[a.length - 1] === M ? `${M} ${P1} ${S}\n` : `${a[a.length - 1]} ${P1}\n`)
    if (s.includes('rev-parse')) { const r = a[a.length - 1]!.replace('^{commit}', ''); const v = refs.get(r) ?? (known.has(r) ? r : ''); return v ? ok(v + '\n') : { exitCode: 1, stdout: '' } }
    return { exitCode: 1, stdout: '' }
  }
  return h
}

test('a PR whose head is a merge commit is read against its first parent, not the branch point', { timeoutMs: 20_000 }, async () => {
  const x = await fetchExternal(origin(true).host, 'app', '7')
  expect(typeof x).toBe('object')
  const r = x as Exclude<typeof x, string>
  expect(r.head).toBe(M!)
  expect(r.base).toBe(P1!) // not T (main) and not the old branch point
  expect(r.pr).toBe(7)
  expect(r.note).toContain('against its first parent')
})

test('a PR without a merge commit is read as the source head against the default branch', { timeoutMs: 20_000 }, async () => {
  const r = (await fetchExternal(origin(false).host, 'app', '7')) as Exclude<Awaited<ReturnType<typeof fetchExternal>>, string>
  expect(r.head).toBe(S!)
  expect(r.base).toBe(T!)
  expect(r.note).toBeUndefined()
})

test('base accepts parent1, merge-base and a commit sha of the scratch repository; a sha it cannot read says what was fetched', { timeoutMs: 20_000 }, async () => {
  const ok = (v: unknown) => v as Exclude<typeof v, string>
  expect(ok(await fetchExternal(origin(true).host, 'app', '7', 'parent1')).base).toBe(P1!)
  expect(ok(await fetchExternal(origin(true).host, 'app', '7', 'merge-base')).base).toBe(T!)
  const named = ok(await fetchExternal(origin(true).host, 'app', '7', P1))
  expect(named.base).toBe(P1!)
  expect(named.note).toContain('you named')
  expect(await fetchExternal(origin(false).host, 'app', '7', 'parent1')).toContain('is not a merge commit')
  const bad = await fetchExternal(origin(true).host, 'app', '7', 'f'.repeat(40))
  expect(bad).toContain(`cannot read base ${'f'.repeat(40)}: it is not in the scratch repository; fetched refs:`)
  expect(bad).toContain(`merge ${M!.slice(0, 8)}`)
})
