// 1.0.26: lean_run {get}: a forge READ by the mod (canned az / curl / gh answers; synthetic names). The token goes on curl's stdin only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { GET_MAX, runGet, selectFields } from './forgeget'

const TOKEN = 'tok-SECRET-9f3a'
const THREADS = {
  value: [
    { id: 7, status: 'active', comments: [{ content: 'Please rename this helper so it says what it does, the old name is misleading for readers of the module', author: { displayName: 'Ann' } }] },
    { id: 8, status: 'fixed', comments: [{ content: 'Nit:\n  trailing space' }, { content: 'second' }] },
    { id: 9, comments: [{ content: 'Policy status updated' }] },
  ],
}
const URL_T = 'https://dev.azure.com/org-a/Proj%20A/_apis/git/repositories/repo-a/pullRequests/42/threads?api-version=7.1'

function setup(curl: (stdin: string | undefined) => { exitCode: number; stdout: string; stderr?: string } = () => ({ exitCode: 0, stdout: JSON.stringify(THREADS) }), gh = '[]') {
  const h = fakeHost(null)
  h.exec.handler = (argv, c) => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] === 'curl') return curl(c.stdin)
    if (argv[0] === 'gh') return { exitCode: 0, stdout: gh }
    return { exitCode: 127, stdout: '', stderr: `unexpected ${argv.join(' ')}` }
  }
  const seen = () => h.calls.filter(c => ['az', 'curl', 'gh'].includes(c.argv[0]!))
  return { h, seen }
}
const ADO = { host: 'ado', org: 'org-a', project: 'Proj A' }

test('1.0.26: get threads: one line per thread (id, status, the first comment\'s first 80 characters); the token is on stdin, never in argv or the answer', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const r = await runGet(s.h.host, { ...ADO, repo: 'repo-a', pr: 42, threads: true })
  const lines = r.text.split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toBe(`7 · active · ${'Please rename this helper so it says what it does, the old name is misleading for readers'.slice(0, 80)}`)
  expect(lines[1]).toBe('8 · fixed · Nit: trailing space')
  expect(lines[2]).toBe('9 · none · Policy status updated')
  const curl = s.seen().find(c => c.argv[0] === 'curl')!
  expect(curl.argv).toEqual(['curl', '-sS', '-f', '-H', '@-', URL_T])
  expect(curl.stdin).toContain(`Authorization: Bearer ${TOKEN}`)
  for (const c of s.seen()) expect(c.argv.join(' ')).not.toContain(TOKEN)
  expect(r.text).not.toContain(TOKEN)
  expect(s.seen()[0]!.argv.slice(0, 3)).toEqual(['az', 'account', 'get-access-token'])
})

test('1.0.26: get with select keeps only the named fields; an Azure path and a GitHub path', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const r = await runGet(s.h.host, { ...ADO, path: 'git/repositories/repo-a/pullRequests/42/threads', query: { $top: 5 }, select: ['value.id', 'value.status'] })
  expect(r.text).toBe('{"value":[{"id":7,"status":"active"},{"id":8,"status":"fixed"},{"id":9}]}')
  expect(s.seen().find(c => c.argv[0] === 'curl')!.argv[5]).toBe('https://dev.azure.com/org-a/Proj%20A/_apis/git/repositories/repo-a/pullRequests/42/threads?%24top=5&api-version=7.1')
  expect(selectFields({ a: { b: 1, c: 2 }, d: 3 }, ['a.b', 'd'])).toEqual({ a: { b: 1 }, d: 3 })
  expect(selectFields({ a: 1 }, ['x.y'])).toBeNull()
  const g = setup(undefined, JSON.stringify([{ id: 1, body: 'x', user: { login: 'ann', id: 5 } }, { id: 2, body: 'y', user: { login: 'bob', id: 6 } }]))
  const gr = await runGet(g.h.host, { host: 'github', path: 'repos/o/r/pulls/3/comments', query: { per_page: 50 }, select: ['id', 'user.login'] })
  expect(gr.text).toBe('[{"id":1,"user":{"login":"ann"}},{"id":2,"user":{"login":"bob"}}]')
  expect(g.seen()).toHaveLength(1)
  expect(g.seen()[0]!.argv).toEqual(['gh', 'api', 'repos/o/r/pulls/3/comments?per_page=50', '-H', 'Accept: application/vnd.github+json'])
})

test('1.0.26: get is GET only, forge hosts only, no ".."; nothing is run for a refused request; an error never carries the token; a long answer is cut', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ ...ADO, path: 'git/repositories', method: 'POST' }, /GET only/],
    [{ host: 'gitlab', path: 'api/v4/projects' }, /host must be/],
    [{ ...ADO, path: 'git/../../other/threads' }, /\.\./],
    [{ ...ADO, path: 'git/%2e%2e/x' }, /\.\./],
    [{ host: 'github', path: 'repos/o/r/%2E%2E/x' }, /\.\./],
    [{ host: 'github', path: 'https://evil.example/x' }, /relative REST path/],
    [{ host: 'github', path: 'graphql' }, /GET only/],
    [{ ...ADO, path: 'git/repositories', body: '{}' }, /unknown field/],
  ]
  for (const [req, why] of bad) {
    const msg = await runGet(s.h.host, req).then(() => 'was not refused', (e: Error) => e.message)
    expect([JSON.stringify(req), why.test(msg)]).toEqual([JSON.stringify(req), true])
  }
  expect(s.seen()).toHaveLength(0)
  const f = setup(stdin => ({ exitCode: 22, stdout: '', stderr: `curl: (22) 401 for Bearer ${(stdin ?? '').split('Bearer ')[1]!.split('\n')[0]}` }))
  const err = await runGet(f.h.host, { ...ADO, path: 'git/repositories' }).then(() => '', (e: Error) => e.message)
  expect(err).toContain('401')
  expect(err).not.toContain(TOKEN)
  const big = setup(() => ({ exitCode: 0, stdout: JSON.stringify({ value: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `repo-${i}` })) }) }))
  const r = await runGet(big.h.host, { ...ADO, path: 'git/repositories' })
  expect(r.text.length).toBeLessThan(GET_MAX + 200)
  expect(r.text).toContain('cut at')
})
