// Field bug: "posix_spawn 'mkdir' ENOENT" on lean_report. $.process.run defaults its cwd to the SESSION's folder; a thread that cd'ed into a
// worktree that was then removed made every spawn fail before the command started. Every process the mod runs gets an existing cwd.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { safeRun } from './host'
import { appendJsonl } from './state'
import { FAILURE_KEEP_MS, reportFailures, threadTool } from './delivery'
import { check } from './doctor'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ENOENT = "spawn failed: posix_spawn 'mkdir' ENOENT"

test('safeRun: no cwd means the home folder; a spawn with a given cwd that is refused with ENOENT and whose folder is gone rejects "folder <x> is gone"', async () => {
  const seen: any[] = []
  const dirs = new Set(['/repo', '/h'])
  const run = async (argv: readonly string[], init?: any) => {
    seen.push([argv[0], init?.cwd, init?.stdin])
    if (init?.cwd && !dirs.has(init.cwd)) throw new Error(`spawn failed: posix_spawn '${argv[0]}' ENOENT`)
    return { exitCode: 0, stdout: 'ran', stderr: '' }
  }
  const safe = safeRun(run, async () => '/h', async p => dirs.has(p))
  await safe(['mkdir', '-p', '/x'])
  await safe(['tee', '-a', '/f'], { stdin: 'rec' })
  await safe(['git', 'status'], { cwd: '/repo' })
  expect(seen).toEqual([['mkdir', '/h', undefined], ['tee', '/h', 'rec'], ['git', '/repo', undefined]])
  // a rejection, as the spawn error was: callers' catch blocks read it as "could not run", never as a command's own exit code
  await expect(safe(['git', 'status'], { cwd: '/removed/worktree' })).rejects.toThrow('folder /removed/worktree is gone')
  // an ENOENT that is not about the folder (the command is missing, the folder exists), or any other error, is rethrown as it was
  const noCmd = safeRun(async () => { throw new Error("posix_spawn 'nope' ENOENT") }, async () => '/h', async () => true)
  await expect(noCmd(['nope'], { cwd: '/repo' })).rejects.toThrow("posix_spawn 'nope' ENOENT")
  const other = safeRun(async () => { throw new Error('EACCES') }, async () => '/h', async () => false)
  await expect(other(['ls'], { cwd: '/repo' })).rejects.toThrow('EACCES')
  // a failing existence check leaves the original error; a missing HOME leaves the call as it was
  const odd = safeRun(async () => { throw new Error("posix_spawn 'ls' ENOENT") }, async () => undefined, async () => { throw new Error('no fs') })
  await expect(odd(['ls'], { cwd: '/anywhere' })).rejects.toThrow("posix_spawn 'ls' ENOENT")
  seen.length = 0
  await safeRun(run, async () => undefined, async () => true)(['ls'])
  expect(seen).toEqual([['ls', undefined, undefined]])
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
  expect(await reportFailures(h.host)).toEqual([])
})

test('lean_report: an error that is not a refused spawn is not retried (the line may have been written)', async () => {
  const h = fakeHost(null)
  let tries = 0
  h.host.process.run = async (argv: string[], init?: any) => {
    if (argv[0] === 'tee') {
      tries++
      throw new Error('tee timed out')
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const r = await threadTool(h.host, 't1', 'lean_report', { text: 'x', state: 'working' })
  expect([r.ok, tries]).toEqual([false, 1])
  expect(r.text).toContain('tee timed out')
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
  const [f] = await reportFailures(h.host)
  expect([f?.thread, f?.error.includes(ENOENT), f?.text]).toEqual(['t7', true, text])
  // the doctor says so (the check itself runs with working spawns)
  const g = fakeHost(null)
  for (const [k, v] of h.files) g.files.set(k, v)
  g.files.set('/plug/opener/open-desk.sh', 'x')
  g.claude.handler = () => ({ exitCode: 0, stdout: '2.1.327' })
  expect((await check(g.host, '/plug')).join('\n')).toMatch(/FIX {2}a lean_report from t7 could not be written .*posix_spawn 'mkdir' ENOENT/)
  // the same thread reports again and it works: the record is cleared
  for (const [k, v] of h.files) g.files.set(k, v)
  const ok = await threadTool(g.host, 't7', 'lean_report', { text: 'back', state: 'working' })
  expect(ok.ok).toBe(true)
  expect(await reportFailures(g.host)).toEqual([])
  expect((await check(g.host, '/plug')).join('\n')).not.toContain('a lean_report from')
})

test('a report of another thread does not clear the record of a failed one', async () => {
  const h = fakeHost(null)
  failing(h, () => true)
  await threadTool(h.host, 't7', 'lean_report', { text: 'lost', state: 'working' })
  const g = fakeHost(null)
  for (const [k, v] of h.files) g.files.set(k, v)
  await threadTool(g.host, 't2', 'lean_report', { text: 'fine', state: 'working' })
  expect((await reportFailures(g.host)).map(f => f.thread)).toEqual(['t7'])
})

test('one record per thread: two failed threads are both shown, one clearing leaves the other, and a record is dropped after 24 h', async () => {
  const h = fakeHost(null)
  h.clock.t = 5_000_000
  failing(h, () => true)
  await threadTool(h.host, 't7', 'lean_report', { text: 'lost seven', state: 'working' })
  h.clock.t += 1000
  await threadTool(h.host, 't8', 'lean_report', { text: 'lost eight', state: 'working' })
  expect((await reportFailures(h.host)).map(f => f.thread)).toEqual(['t7', 't8'])
  const g = fakeHost(null)
  for (const [k, v] of h.files) g.files.set(k, v)
  g.clock.t = h.clock.t
  await threadTool(g.host, 't8', 'lean_report', { text: 'fine again', state: 'working' })
  expect((await reportFailures(g.host)).map(f => f.thread)).toEqual(['t7']) // t8 cleared, t7 stays
  g.clock.t += FAILURE_KEEP_MS
  expect(await reportFailures(g.host)).toEqual([]) // a thread that never reported again does not stay a FIX row forever
})
