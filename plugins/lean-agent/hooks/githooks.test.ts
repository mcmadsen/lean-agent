import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ensureGitHooks, privateList, HOOK_NAMES, HOOK } from './githooks'
import { threadSettings } from './threads'
import { readNotices } from './notices'

test('ensureGitHooks re-applies chmod 755 to every wrapper on every call, even when the content is unchanged', async () => {
  const h = fakeHost(null)
  await ensureGitHooks(h.host)
  expect(h.files.get('/h/.lean-agent/githooks/pre-push')).toBe(HOOK)
  h.calls.length = 0
  await ensureGitHooks(h.host) // nothing changed: no rewrite, but chmod again (one that lost +x is skipped by git silently)
  const ch = h.calls.map(c => c.argv).filter(a => a[0] === 'chmod' && a[1] === '755' && !a[2]!.includes('.tmp-'))
  expect(ch.length).toBe(1)
  for (const n of HOOK_NAMES) expect(ch[0]).toContain(`/h/.lean-agent/githooks/${n}`)
})

test('a failing ensureGitHooks leaves a notice, and the thread settings then carry no core.hooksPath env', async () => {
  const h = fakeHost(null)
  const run = h.host.process.run
  h.host.process.run = async (argv: readonly string[], init?: any) => (argv[0] === 'chmod' ? { exitCode: 1, stdout: '', stderr: 'denied' } : run(argv, init))
  await expect(ensureGitHooks(h.host)).rejects.toThrow('chmod')
  expect((await readNotices(h.host)).join('\n')).toContain('git hooks not installed')
  expect(await threadSettings(h.host, 't1', false)).not.toContain('GIT_CONFIG')
  expect(await threadSettings(h.host, 't1')).toContain('core.hooksPath')
  h.host.process.run = run
  await ensureGitHooks(h.host)
  expect(await readNotices(h.host)).toEqual([])
})

test('private.list is one entry per line: private paths and urls, own guards.push-deny as own/deny lines', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ vault: { path: '/r/vault', private: true, remote: 'https://H/V.git/' }, loose: { path: '/r/loose', guards: { 'push-deny': ['prod-*'] } }, none: { path: '/r/none', guards: { 'push-deny': [] } }, open: { path: '/r/open' } }))
  const t = await privateList(h.host, '/h')
  const lines = t.trim().split('\n')
  expect(lines).toContain('path /r/vault')
  expect(lines).toContain('url https://h/v')
  expect(lines).toContain('own /r/loose')
  expect(lines).toContain('deny /r/loose|prod-*')
  expect(lines).toContain('own /r/none')
  expect(lines.some(l => l.startsWith('deny /r/none'))).toBe(false)
  expect(lines.some(l => l.includes('/r/open'))).toBe(false)
})
