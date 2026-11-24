import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
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
    if (s.includes('remote get-url')) return ok('https://github.com/org/app.git\n')
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

// a prepare of PR 7 whose git range holds `n` files (a range from the wrong base) while its own commits touch two files
function bigPr(n: number) {
  const h = origin(true)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  const diff = Array.from({ length: n }, (_, i) => [`diff --git a/f${i}.ts b/f${i}.ts`, 'new file mode 100644', '--- /dev/null', `+++ b/f${i}.ts`, '@@ -0,0 +1 @@', '+x']).flat().join('\n') + '\n'
  const base = h.git.handler
  h.git.handler = (a: string[], c: any) => {
    const s = a.join(' ')
    if (s.includes('rev-list --count')) return { exitCode: 0, stdout: '3\n' }
    if (s.includes(' log ')) return { exitCode: 0, stdout: 'f0.ts\nf1.ts\n' }
    if (s.includes('merge-base --is-ancestor')) return { exitCode: 1, stdout: '' }
    if (s.includes('merge-base')) return { exitCode: 0, stdout: `${P1}\n` }
    if (s.includes('--name-status')) return { exitCode: 0, stdout: Array.from({ length: n }, (_, i) => `A\tf${i}.ts`).join('\n') + '\n' }
    if (s.includes(' diff ')) return { exitCode: 0, stdout: diff }
    return base(a, c)
  }
  return h
}
const prep = (h: any, extra: Record<string, unknown> = {}) => threadTool(h.host, 't1', 'lean_review', { action: 'prepare', ref: '7', level: 'full', ...extra })

test('a range far larger than the PR is refused until the user confirms; the forge list wins over the git range', { timeoutMs: 20_000 }, async () => {
  const h = bigPr(200)
  const refused = await prep(h)
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('range looks wrong: 200 files / 200 lines for a PR of 3 commits (the forge list was not read)')
  expect(refused.text).toContain('Pass base')
  expect(refused.text).toContain('confirm: true')
  const go = await prep(h, { confirm: true })
  expect(go.ok, go.text).toBe(true)
  expect(go.text).toContain(`reviewing ${M!.slice(0, 8)} against merge base ${P1!.slice(0, 8)} (target not merged)`)
  expect(go.text).toContain('against its first parent')
  // the forge lists two files: the range is cut to them, and the sanity check no longer fires
  h.exec.handler = (a: string[]) => (a[0] === 'gh' && a.join(' ').includes('pulls/7/files') ? { exitCode: 0, stdout: 'f0.ts\nf1.ts\n' } : { exitCode: 127, stdout: '' })
  const cut = await prep(h)
  expect(cut.ok, cut.text).toBe(true)
  expect(cut.text).toContain("range corrected to the PR's own files (forge: 2 files; git range: 200)")
  expect(cut.text).toContain('f1.ts')
  expect(cut.text).not.toContain('f150.ts')
  // a small range is never asked about
  const small = await prep(bigPr(5))
  expect(small.ok, small.text).toBe(true)
})

test('base accepts parent1, merge-base and a commit sha of the scratch repository; a sha it cannot read says what was fetched', { timeoutMs: 20_000 }, async () => {
  const ok = (v: Awaited<ReturnType<typeof fetchExternal>>) => v as Exclude<typeof v, string>
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
