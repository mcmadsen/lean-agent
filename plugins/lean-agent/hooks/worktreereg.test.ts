import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { isWorktree, linkedWorktrees, pruneStale, readRegistry, registerOwn, registerWorktree, staleEntries, unregisteredAt } from './worktreereg'

const FILE = '/h/.lean-agent/worktrees.json'
const SHA = 'abc1234def5678abc1234def5678abc1234def56'

type Opts = { registry?: unknown; notWt?: string[]; foreign?: string[]; branch?: Record<string, string>; list?: string }
// project app at /r/app; worktrees "exist" when a file sits inside them
function setup(o: Opts = {}) {
  const h = fakeHost(null)
  h.git.handler = a => {
    const s = a.join(' ')
    const dir = a[1]!
    if (s.includes('--show-toplevel')) return (o.notWt ?? []).includes(dir) ? { exitCode: 0, stdout: '/somewhere/else\n' } : { exitCode: 0, stdout: dir + '\n' }
    if (s.includes('--git-common-dir')) return { exitCode: 0, stdout: ((o.foreign ?? []).includes(dir) ? '/other/.git' : '/r/app/.git') + '\n' }
    if (s.includes('symbolic-ref')) return o.branch?.[dir] ? { exitCode: 0, stdout: o.branch[dir] + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('worktree list')) return o.list ? { exitCode: 0, stdout: o.list } : { exitCode: 1, stdout: '' }
    return { exitCode: 1, stdout: '' }
  }
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  if (o.registry !== undefined) h.files.set(FILE, typeof o.registry === 'string' ? o.registry : JSON.stringify(o.registry))
  const live = (p: string) => void h.files.set(`${p}/.git`, 'gitdir: x')
  const reg = () => JSON.parse(String(h.files.get(FILE)))
  return { h, live, reg }
}
const input = (path: string, extra: Record<string, unknown> = {}) => ({ project: 'app', path, repo: '/r/app', branch: 'feat', thread: 't1', ...extra })

test('register adds a fresh entry with its fields and keeps the others', async () => {
  const s = setup({ registry: { 'app/other': { path: '/w/o', branch: 'other', thread: 't2' } } })
  const r = await registerWorktree(s.h.host, input('/w/feat', { adopted: true }))
  expect(r).toEqual({ ok: true, key: 'app/feat', text: 'registered app/feat -> /w/feat' })
  expect(s.reg()).toEqual({ 'app/other': { path: '/w/o', branch: 'other', thread: 't2' }, 'app/feat': { path: '/w/feat', repo: '/r/app', branch: 'feat', thread: 't1', adopted: true } })
  // a missing registry file is an empty one
  const t = setup()
  expect((await registerWorktree(t.h.host, input('/w/feat'))).ok).toBe(true)
  expect(Object.keys(t.reg())).toEqual(['app/feat'])
})

test('a key held by a worktree that is gone, or not a worktree any more, is replaced', async () => {
  const gone = setup({ registry: { 'app/feat': { path: '/w/gone', branch: 'feat', thread: 't2' } } })
  const r = await registerWorktree(gone.h.host, input('/w/feat'))
  expect(r.ok).toBe(true)
  expect(r.text).toContain('replaced the stale entry app/feat (/w/gone is gone or no longer a worktree)')
  expect(gone.reg()).toEqual({ 'app/feat': { path: '/w/feat', repo: '/r/app', branch: 'feat', thread: 't1' } })
  // the folder exists but is not a worktree (its top level is another folder)
  const plain = setup({ registry: { 'app/feat': { path: '/w/plain', branch: 'feat', thread: 't2' } }, notWt: ['/w/plain'] })
  plain.live('/w/plain')
  expect((await registerWorktree(plain.h.host, input('/w/feat'))).text).toContain('replaced the stale entry')
  expect(plain.reg()['app/feat'].path).toBe('/w/feat')
  // an entry without a usable path
  const bad = setup({ registry: { 'app/feat': { branch: 'feat' } } })
  expect((await registerWorktree(bad.h.host, input('/w/feat'))).text).toContain('no usable path')
  expect(bad.reg()['app/feat'].path).toBe('/w/feat')
})

test('a key held by a LIVE worktree gets a suffixed key; the live entry is untouched; it never fails silently', async () => {
  const s = setup({ registry: { 'app/feat': { path: '/w/a', branch: 'feat', thread: 't2' } } })
  s.live('/w/a')
  const r = await registerWorktree(s.h.host, input('/w/b'))
  expect(r.ok).toBe(true)
  expect(r.key).toBe('app/feat~2')
  expect(r.text).toContain('app/feat already points to the live worktree /w/a')
  expect(r.text).toContain('registered under app/feat~2')
  expect(s.reg()['app/feat'].path).toBe('/w/a')
  expect(s.reg()['app/feat~2']).toMatchObject({ path: '/w/b', thread: 't1' })
  // a third one
  s.live('/w/b')
  expect((await registerWorktree(s.h.host, input('/w/c'))).key).toBe('app/feat~3')
  // the same worktree again: a refresh under the key it has, not a new suffix
  const again = await registerWorktree(s.h.host, input('/w/b'))
  expect(again.key).toBe('app/feat~2')
  expect(Object.keys(s.reg())).toEqual(['app/feat', 'app/feat~2', 'app/feat~3'])
  // the suffixed keys are still the project's (readers match `<project>/`)
  expect(Object.keys(s.reg()).every(k => k.startsWith('app/'))).toBe(true)
})

test('the same worktree of another thread is refused with the reason, unless it is shared', async () => {
  const s = setup({ registry: { 'app/feat': { path: '/w/a', branch: 'feat', thread: 't2' } } })
  s.live('/w/a')
  const r = await registerWorktree(s.h.host, input('/w/a'))
  expect(r.ok).toBe(false)
  expect(r.text).toContain("worktree NOT registered: /w/a is t2's (app/feat, not shared)")
  expect(s.reg()['app/feat'].thread).toBe('t2')
  const sh = setup({ registry: { 'app/feat': { path: '/w/a', branch: 'feat', thread: 't2', shared: true } } })
  sh.live('/w/a')
  const r2 = await registerWorktree(sh.h.host, input('/w/a'))
  expect(r2).toMatchObject({ ok: true, key: 'app/feat~2' })
  // the owner keeps its entry (and can still push); the newcomer has one of its own
  expect(sh.reg()['app/feat']).toEqual({ path: '/w/a', branch: 'feat', thread: 't2', shared: true })
  expect(sh.reg()['app/feat~2']).toMatchObject({ path: '/w/a', thread: 't1', shared: true })
  // the same thread again: its own entry is refreshed, no third key
  expect((await registerWorktree(sh.h.host, input('/w/a'))).key).toBe('app/feat~2')
  expect(Object.keys(sh.reg())).toEqual(['app/feat', 'app/feat~2'])
  // another thread's worktree is never taken over under a NEW key either (its branch may have changed since it was registered)
  const moved = setup({ registry: { 'app/old-name': { path: '/w/a', branch: 'old-name', thread: 't2' } } })
  moved.live('/w/a')
  const mr = await registerWorktree(moved.h.host, input('/w/a', { branch: 'new-name' }))
  expect(mr.ok).toBe(false)
  expect(mr.text).toContain("/w/a is t2's (app/old-name, not shared)")
  expect(Object.keys(moved.reg())).toEqual(['app/old-name'])
})

test('prune drops only the entries it saw stale: one replaced meanwhile (same key, another path) stays', async () => {
  const s = setup({ registry: { 'app/gone': { path: '/w/gone', branch: 'gone', thread: 't1' } } })
  const old = s.h.host.fs.exists
  // between the staleness check and the write, another process replaced the entry with a live worktree
  let swapped = false
  s.h.host.fs.exists = async (p: string) => {
    const r = await old(p)
    if (!swapped && p === '/w/gone') { swapped = true; s.live('/w/new'); s.h.files.set(FILE, JSON.stringify({ 'app/gone': { path: '/w/new', branch: 'gone', thread: 't1' } })) }
    return r
  }
  expect(await pruneStale(s.h.host)).toEqual([])
  expect(s.reg()['app/gone'].path).toBe('/w/new')
})

test('a damaged registry is never overwritten; a registry that cannot be written says so', async () => {
  const d = setup({ registry: '{ not json' })
  const r = await registerWorktree(d.h.host, input('/w/feat'))
  expect(r.ok).toBe(false)
  expect(r.text).toContain('worktree NOT registered')
  expect(r.text).toContain('damaged')
  expect(d.h.files.get(FILE)).toBe('{ not json')
  const arr = setup({ registry: '[]' })
  expect((await registerWorktree(arr.h.host, input('/w/feat'))).ok).toBe(false)
  const w = setup({ registry: {} })
  w.h.host.fs.write = async () => { throw new Error('disk full') }
  const wr = await registerWorktree(w.h.host, input('/w/feat'))
  expect(wr.ok).toBe(false)
  expect(wr.text).toContain('could not be written')
})

test('every suffix taken by live worktrees is a refusal that says what to do', async () => {
  const reg: Record<string, unknown> = {}
  const s = setup({ registry: reg })
  for (let n = 1; n <= 20; n++) {
    reg[n === 1 ? 'app/feat' : `app/feat~${n}`] = { path: `/w/${n}`, branch: 'feat', thread: 't2' }
    s.live(`/w/${n}`)
  }
  s.h.files.set(FILE, JSON.stringify(reg))
  const r = await registerWorktree(s.h.host, input('/w/new'))
  expect(r.ok).toBe(false)
  expect(r.text).toContain('are all taken by live worktrees')
})

test('stale entries are listed and pruned; the others stay', async () => {
  const s = setup({ registry: { 'app/live': { path: '/w/live', branch: 'live', thread: 't1' }, 'app/gone': { path: '/w/gone', branch: 'gone', thread: 't1' }, 'app/plain': { path: '/w/plain', branch: 'p', thread: 't1' }, 'app/nopath': { branch: 'n' } }, notWt: ['/w/plain'] })
  s.live('/w/live')
  s.live('/w/plain')
  const stale = await staleEntries(s.h.host)
  expect(stale).toEqual([
    { key: 'app/gone', path: '/w/gone', why: 'the folder is gone' },
    { key: 'app/plain', path: '/w/plain', why: 'not a git worktree any more' },
    { key: 'app/nopath', path: '', why: 'no usable path' },
  ])
  expect((await pruneStale(s.h.host)).map(x => x.key)).toEqual(['app/gone', 'app/plain', 'app/nopath'])
  expect(Object.keys(s.reg())).toEqual(['app/live'])
  expect(await pruneStale(s.h.host)).toEqual([])
  // a damaged file is left alone
  const d = setup({ registry: 'oops' })
  expect(await pruneStale(d.h.host)).toEqual([])
  expect(d.h.files.get(FILE)).toBe('oops')
})

test('a git that does not answer never makes an entry stale: nothing is replaced or pruned on a guess', async () => {
  const s = setup({ registry: { 'app/feat': { path: '/w/a', branch: 'feat', thread: 't2' } } })
  s.live('/w/a')
  s.h.git.handler = () => ({ exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership' })
  expect(await staleEntries(s.h.host)).toEqual([])
  expect(await pruneStale(s.h.host)).toEqual([])
  expect((await registerWorktree(s.h.host, input('/w/b'))).key).toBe('app/feat~2') // the unknown one is treated as live
  expect(s.reg()['app/feat'].path).toBe('/w/a')
  s.live('/w/b')
  // git itself says "not a git repository": the folder is no worktree any more
  s.h.git.handler = () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' })
  expect((await staleEntries(s.h.host)).map(x => `${x.key}: ${x.why}`)).toEqual(['app/feat: not a git worktree any more', 'app/feat~2: not a git worktree any more'])
  // git cannot even be started
  s.h.git.handler = () => { throw new Error('spawn git ENOENT') }
  expect(await staleEntries(s.h.host)).toEqual([])
})

test('registerOwn: a thread registers its worktree (made by plain git worktree add) only when it is a linked worktree of the project', async () => {
  const ok = setup({ branch: { '/w/feat': 'feat' } })
  ok.live('/w/feat')
  const r = await registerOwn(ok.h.host, '/h', { project: 'app', path: '/w/feat', thread: 't1' })
  expect(r).toMatchObject({ ok: true, key: 'app/feat' })
  expect(ok.reg()['app/feat']).toEqual({ path: '/w/feat', repo: '/r/app', branch: 'feat', thread: 't1', adopted: true })
  // one under ~/.lean-agent/worktrees (made by the skill) is not marked adopted
  const own = setup({ branch: { '/h/.lean-agent/worktrees/app/feat': 'feat' } })
  own.live('/h/.lean-agent/worktrees/app/feat')
  await registerOwn(own.h.host, '/h', { project: 'app', path: '/h/.lean-agent/worktrees/app/feat', thread: 't1' })
  expect(own.reg()['app/feat'].adopted).toBeUndefined()
  const no: [string, Opts, { project?: string; path: string }, string][] = [
    ['a relative path', {}, { path: 'w/feat' }, 'path must be absolute'],
    ['an unregistered project', {}, { project: 'nope', path: '/w/feat' }, 'nope is not a registered project'],
    ['not a worktree', { notWt: ['/w/feat'], branch: { '/w/feat': 'feat' } }, { path: '/w/feat' }, 'is not the top folder of a git worktree'],
    ['another repository', { foreign: ['/w/feat'], branch: { '/w/feat': 'feat' } }, { path: '/w/feat' }, 'is not a worktree of the repository of project app'],
    ['the main checkout', { branch: { '/r/app': 'main' } }, { path: '/r/app' }, 'is the main checkout of app'],
    ['a detached HEAD', {}, { path: '/w/feat' }, 'no branch checked out'],
  ]
  for (const [name, opts, i, want] of no) {
    const s = setup({ registry: {}, ...opts })
    s.live('/w/feat')
    s.live('/r/app')
    const x = await registerOwn(s.h.host, '/h', { project: 'app', thread: 't1', ...i })
    expect([name, x.ok, x.text]).toEqual([name, false, expect.stringContaining(want)])
    expect([name, s.reg()]).toEqual([name, {}])
  }
})

test('linkedWorktrees leaves out the main checkout, bare and prunable entries; unregisteredAt names the one candidate', async () => {
  const list = `worktree /r/app\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\nworktree /w/a\nHEAD ${SHA}\nbranch refs/heads/feat\n\nworktree /w/b\nHEAD ${SHA}\ndetached\n\nworktree /w/c\nHEAD ${SHA}\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n`
  const s = setup({ list, registry: {} })
  expect(await linkedWorktrees(s.h.host, '/r/app')).toEqual([{ path: '/w/a', head: SHA, branch: 'feat' }, { path: '/w/b', head: SHA, branch: '' }])
  expect(await unregisteredAt(s.h.host, '/h', '/r/app', SHA)).toEqual({ one: { path: '/w/a', head: SHA, branch: 'feat' } })
  s.h.files.set(FILE, JSON.stringify({ x: { path: '/w/a', thread: 't9' } }))
  expect(await unregisteredAt(s.h.host, '/h', '/r/app', SHA)).toEqual({}) // registered (to anyone): not unregistered
  expect(await unregisteredAt(s.h.host, '/h', '/r/app', 'f'.repeat(40))).toEqual({})
  expect((await linkedWorktrees(setup().h.host, '/r/app'))).toEqual([])
  expect(await isWorktree(s.h.host, 'relative')).toBe(false)
})

test('the lean_worktree tool registers and lists for the thread, and says why it refuses', async () => {
  const s = setup({ registry: { 'app/gone': { path: '/w/gone', branch: 'gone', thread: 't2' } }, branch: { '/w/feat': 'feat' } })
  s.live('/w/feat')
  const r = await threadTool(s.h.host, 't1', 'lean_worktree', { action: 'register', path: '/w/feat' })
  expect(r).toEqual({ ok: true, text: 'registered app/feat -> /w/feat' })
  const l = await threadTool(s.h.host, 't1', 'lean_worktree', { action: 'list' })
  expect(l.ok).toBe(true)
  expect(l.text).toContain('app/gone | /w/gone | t2 | STALE: the folder is gone')
  expect(l.text).toContain('app/feat | /w/feat | t1 | ok')
  const bad = await threadTool(s.h.host, 't1', 'lean_worktree', { action: 'register', path: '/w/none' })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('worktree NOT registered')
  expect((await threadTool(s.h.host, 't1', 'lean_worktree', { action: 'zap' })).ok).toBe(false)
  expect((await readRegistry(s.h.host, '/h')).damaged).toBe(false)
})
