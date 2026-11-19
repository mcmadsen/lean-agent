// Field bug: "posix_spawn 'mkdir' ENOENT" on lean_report. $.process.run defaults its cwd to the SESSION's folder; a thread that cd'ed into a
// worktree that was then removed made every spawn fail before the command started. Every process the mod runs gets an existing cwd.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { safeRun } from './host'
import { appendJsonl } from './state'
import { lastReportFailure, threadTool } from './delivery'
import { check } from './doctor'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ENOENT = "spawn failed: posix_spawn 'mkdir' ENOENT"

test('safeRun: no cwd means the home folder; a cwd that was given is checked first and a missing one says "folder <x> is gone"', async () => {
  const seen: any[] = []
  const run = async (argv: readonly string[], init?: any) => {
    seen.push([argv[0], init?.cwd, init?.stdin])
    return { exitCode: 0, stdout: 'ran', stderr: '' }
  }
  const dirs = new Set(['/repo'])
  const safe = safeRun(run, async () => '/h', async p => dirs.has(p))
  await safe(['mkdir', '-p', '/x'])
  await safe(['tee', '-a', '/f'], { stdin: 'rec' })
  await safe(['git', 'status'], { cwd: '/repo' })
  expect(seen).toEqual([['mkdir', '/h', undefined], ['tee', '/h', 'rec'], ['git', '/repo', undefined]])
  seen.length = 0
  const gone = await safe(['git', 'status'], { cwd: '/removed/worktree' })
  expect(gone).toEqual({ exitCode: 1, stdout: '', stderr: 'folder /removed/worktree is gone' })
  expect(seen).toEqual([]) // nothing was spawned
  // a failing existence check lets the spawn decide; a missing HOME leaves the call as it was
  const odd = safeRun(run, async () => undefined, async () => { throw new Error('no fs') })
  await odd(['ls'], { cwd: '/anywhere' })
  await odd(['ls'])
  expect(seen).toEqual([['ls', '/anywhere', undefined], ['ls', undefined, undefined]])
})

test('the fake host reproduces the field bug: with the session folder gone a plain spawn rejects naming the command', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/x`, '1')
  h.strict.on = true
  h.strict.sessionGone = true
  await expect(appendJsonl(h.host, `${L}/desk/inbox.jsonl`, { a: 1 })).rejects.toThrow("posix_spawn 'mkdir' ENOENT")
  await expect(h.host.process.run(['git', 'log'], { cwd: '/removed' })).rejects.toThrow('ENOENT')
  expect((await h.host.process.run(['mkdir', '-p', '/h/ok'], { cwd: '/h' })).exitCode).toBe(0)
})

async function threadSession($: any, on: any, h0: { gone: boolean }) {
  const h = fakeHost(on)
  resetLocks()
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('clock.after', () => new Promise(() => {}))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: null }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  await $.session.start({ cwd: `${L}/threads/t1`, surface: 'desktop', isInteractive: true } as any)
  h.strict.on = true
  h.strict.sessionGone = h0.gone // the thread's own folder vanished: a spawn without a cwd fails
  return h
}

test('through the engine: lean_report reaches the desk even when the session folder is gone', async ($, on) => {
  const h = await threadSession($, on, { gone: true })
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_report', state: 'working', text: 'halfway there' } as any)
  expect(JSON.stringify(r)).toContain('reported to the desk')
  expect(h.files.get(`${L}/desk/inbox.jsonl`)).toContain('halfway there')
  // every spawn of that report ran in the home folder
  expect(h.calls.filter(c => c.argv[0] === 'mkdir' || c.argv[0] === 'tee').every(c => c.cwd === '/h')).toBe(true)
})

test('through the engine: a cwd that was given and is gone is answered "folder <x> is gone", not a spawn error', async ($, on) => {
  const h = await threadSession($, on, { gone: false })
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_rules', action: 'stale', project: 'app', repo: '/removed/checkout' } as any)
  expect(JSON.stringify(r)).not.toContain('posix_spawn')
})

// a host whose spawns fail the way the field's did (a rejection naming mkdir)
function failing(h: ReturnType<typeof fakeHost>, when: (init: any) => boolean) {
  const real = h.host.process.run
  h.host.process.run = async (argv: string[], init?: any) => {
    if (when(init)) throw new Error(ENOENT)
    return real(argv, init)
  }
}

test('lean_report: a failed write is tried once more with the home folder as cwd', async () => {
  const h = fakeHost(null)
  h.clock.t = 5_000_000
  failing(h, init => init?.cwd !== '/h') // only a spawn that names the home folder works
  const r = await threadTool(h.host, 't1', 'lean_report', { text: 'done with x', state: 'working' })
  expect(r.ok).toBe(true)
  expect(h.files.get(`${L}/desk/inbox.jsonl`)).toContain('done with x')
  expect(await lastReportFailure(h.host)).toBeNull()
})

test('lean_report never loses a report: when the write fails twice the thread gets the text and the exact error, and the doctor shows it until that thread reports again', async () => {
  const h = fakeHost(null)
  h.clock.t = 5_000_000
  failing(h, () => true)
  const text = 'branch fix-x, worktree /w, last commit abc1234, not pushed, open: none, next: open the PR'
  const r = await threadTool(h.host, 't7', 'lean_report', { text, state: 'done' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('lean_report FAILED')
  expect(r.text).toContain(ENOENT)
  expect(r.text).toContain(text) // the whole report, to paste
  expect(r.text).toContain('Paste the text below')
  const f = await lastReportFailure(h.host)
  expect([f?.thread, f?.error.includes(ENOENT), f?.text]).toEqual(['t7', true, text])
  // the doctor says so (the check itself runs with working spawns)
  const g = fakeHost(null)
  for (const [k, v] of h.files) g.files.set(k, v)
  g.files.set('/plug/opener/open-desk.sh', 'x')
  g.claude.handler = () => ({ exitCode: 0, stdout: '2.1.327' })
  expect((await check(g.host, '/plug')).join('\n')).toMatch(/FIX {2}a lean_report from t7 could not be written .*posix_spawn 'mkdir' ENOENT/)
  // the same thread reports again and it works: the record is cleared
  h.host.process.run = g.host.process.run
  for (const [k, v] of h.files) g.files.set(k, v)
  const ok = await threadTool(g.host, 't7', 'lean_report', { text: 'back', state: 'working' })
  expect(ok.ok).toBe(true)
  expect(await lastReportFailure(g.host)).toBeNull()
  expect((await check(g.host, '/plug')).join('\n')).not.toContain('a lean_report from')
})

test('a report of another thread does not clear the record of a failed one', async () => {
  const h = fakeHost(null)
  failing(h, () => true)
  await threadTool(h.host, 't7', 'lean_report', { text: 'lost', state: 'working' })
  const g = fakeHost(null)
  for (const [k, v] of h.files) g.files.set(k, v)
  await threadTool(g.host, 't2', 'lean_report', { text: 'fine', state: 'working' })
  expect((await lastReportFailure(g.host))?.thread).toBe('t7')
})
