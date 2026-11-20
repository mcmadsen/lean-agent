// Which lean-agent code a THREAD's session runs: its own mod records it, the desk shows "running X, installed Y" when they differ.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { recordRunning } from './role'
import { runningOf, skewedThreads, threadSkew } from './skew'
import { leanThread, resetLocks } from './threads'
import { VERSION } from './pane'

const ROOT = '/p'
const S1 = '11111111-2222-3333-4444-555555555555'
const S2 = '99999999-2222-3333-4444-555555555555'
const TJ = '/h/.lean-agent/threads/t1/thread.json'
const REG = '/h/.claude/plugins/installed_plugins.json'

function setup(installed = '1.0.11') {
  resetLocks()
  const h = fakeHost(null)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk')
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: installed }))
  const state = { rows: [] as any[], sids: [S1, S2], n: 0 }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${state.sids[state.n++ % 2]}\n` }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  return { h, state, call: (i: any) => leanThread(h.host, ROOT, i) }
}
const rec = (h: any) => JSON.parse(String(h.files.get(TJ)))

test('the thread\'s mod records the version it runs once per session; a desk save keeps it; a closed thread is left alone', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  expect(rec(h).running).toBeUndefined()
  expect(await recordRunning(h.host, 't1', S1, '1.0.9')).toBe(true)
  expect(rec(h).running).toEqual({ version: '1.0.9', sid: S1, at: h.clock.t })
  const writes = h.writes.length
  expect(await recordRunning(h.host, 't1', S1, '1.0.9')).toBe(true) // the same session, the same code: nothing written again
  expect(h.writes.length).toBe(writes)
  await call({ action: 'park', tN: 't1' }) // the desk loaded before and saves now
  expect(rec(h).running.version).toBe('1.0.9')
  expect(await recordRunning(h.host, 't1', S1, '')).toBe(false)
  expect(await recordRunning(h.host, 'x1', S1, '1.0.9')).toBe(false)
  await call({ action: 'close', tN: 't1' })
  expect(await recordRunning(h.host, 't1', S1, '1.0.10')).toBe(false)
  expect(rec(h).running.version).toBe('1.0.9')
})

test('runningOf counts only the record of the CURRENT session; threadSkew only a real difference', () => {
  expect(runningOf({ sid: S1, running: { version: '1.0.9', sid: S1, at: 1 } })).toBe('1.0.9')
  expect(runningOf({ sid: S2, running: { version: '1.0.9', sid: S1, at: 1 } })).toBe('') // the older session's record
  expect(runningOf({ sid: S1, running: { version: 'x', sid: S1, at: 1 } })).toBe('')
  expect(runningOf({ sid: '', running: { version: '1.0.9', sid: '', at: 1 } })).toBe('')
  expect(runningOf({ sid: S1 })).toBe('')
  expect(runningOf(null)).toBe('')
  expect(threadSkew('1.0.9', '1.0.11')).toBe('running 1.0.9, installed 1.0.11')
  expect(threadSkew('1.0.11', '1.0.11')).toBe('')
  expect(threadSkew('1.0.11', '1.0.11-rc.1')).toBe('')
  expect(threadSkew('', '1.0.11')).toBe('')
  expect(threadSkew('1.0.9', null)).toBe('')
})

test('threads lists "running X, installed Y" only when they differ; a restarted session\'s old record is ignored', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  expect((await call({ action: 'list' })).text).not.toContain('running 1.0')
  await recordRunning(h.host, 't1', S1, '1.0.9')
  const same = await call({ action: 'list' })
  expect(same.text).toContain('t1 · a')
  expect(same.text).toContain('running 1.0.9, installed 1.0.11')
  expect((same.data as any[])[0]).toMatchObject({ codeVersion: '1.0.9', skew: 'running 1.0.9, installed 1.0.11' })
  // the install registry is newer than this root: the higher one is "installed"
  h.files.set(REG, JSON.stringify({ plugins: { 'lean-agent@mk': [{ version: '1.0.12' }] } }))
  expect((await call({ action: 'list' })).text).toContain('running 1.0.9, installed 1.0.12')
  // running the installed version: no noise
  await recordRunning(h.host, 't1', S1, '1.0.12')
  expect((await call({ action: 'list' })).text).not.toContain('running 1.0')
  // a new session (restart): the old session's record says nothing until the new session reports
  await recordRunning(h.host, 't1', S1, '1.0.9')
  state.rows = []
  const r = await call({ action: 'restart', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(rec(h).sid).toBe(S2)
  expect((await call({ action: 'list' })).text).not.toContain('running 1.0')
  await recordRunning(h.host, 't1', S2, '1.0.11')
  expect((await call({ action: 'list' })).text).toContain('running 1.0.11, installed 1.0.12')
})

test('the start and restart reply says "running X, installed Y" when the new session\'s mod reports a different version in time; silent when the same or when it does not report', async () => {
  const { h, state, call } = setup()
  let reports: string | null = null // what the session's mod will write while the desk waits
  ;(h.host.clock as any).sleep = async () => {
    if (reports) await recordRunning(h.host, 't1', rec(h).sid, reports)
  }
  reports = '1.0.9'
  const a = await call({ action: 'new', title: 'a', text: 'brief' })
  expect(a.ok).toBe(true)
  expect(a.text).toContain(`t1 started (${S1}) ·`)
  expect(a.text).toContain('running 1.0.9, installed 1.0.11')
  expect(a.text).toContain('ask it for nothing the running version lacks') // the thread must not be asked for what its version lacks
  expect(rec(h).version).toBe('1.0.9') // what the desk believes it runs is what it really runs
  // a resume of a session that really runs older code starts a fresh one (the desk had recorded the installed version at the start)
  h.clock.t += 60_000
  state.rows = [{ sessionId: S1, id: S1.slice(0, 8), name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', startedAt: 1, status: 'idle', state: 'done' }]
  reports = '1.0.11'
  const resumed = await call({ action: 'resume', tN: 't1' })
  expect(resumed.text).toContain('new session instead of a resume')
  expect(resumed.text).toContain('1.0.9')
  // the fresh session runs the installed code: no skew words
  expect(resumed.text).not.toContain('running 1.0')
  expect(rec(h).version).toBe('1.0.11')
  // a session that never reports (no mod yet): the reply stays as it was, the list shows it later
  reports = null
  state.rows = []
  const r = await call({ action: 'restart', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(r.text).not.toContain('running 1.0')
})

test('a thread session records the version it runs at its start (through the engine)', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.files.set(TJ, JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-a', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('session.id', () => ({ value: 'sess-a' }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  expect(rec(h).running).toMatchObject({ version: VERSION, sid: 'sess-a' })
  expect(runningOf(rec(h))).toBe(VERSION)
})

test('the doctor names a thread that runs an older plugin than installed, the cause and what the user can do; a newer one is a note; a closed one is skipped', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  await call({ action: 'new', title: 'b', text: 'brief' })
  h.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ ...JSON.parse(String(h.files.get('/h/.lean-agent/threads/t2/thread.json'))), running: { version: '1.0.99', sid: S1, at: 1 }, sid: S1 }))
  await recordRunning(h.host, 't1', S1, '1.0.9')
  expect(await skewedThreads(h.host, ROOT)).toEqual([{ id: 't1', run: '1.0.9', installed: '1.0.11' }, { id: 't2', run: '1.0.99', installed: '1.0.11' }])
  const out = (await check(h.host, ROOT)).join('\n')
  expect(out).toContain('FIX  thread t1 running 1.0.9, installed 1.0.11: its session loaded the older plugin; do not ask it for what 1.0.11 added, and restart it once the cause below is fixed')
  expect(out).toContain('note thread t2 running 1.0.99, installed 1.0.11: a newer copy than the installed plugin')
  expect(out).toContain('lean-agent pins no version')
  expect(out).toContain('quit and reopen the Claude app')
  expect(out).toContain('lean-agent never restarts services itself')
  // closed, or the same version: nothing
  await call({ action: 'close', tN: 't1' })
  await recordRunning(h.host, 't2', S1, '1.0.11')
  const clean = (await check(h.host, ROOT)).join('\n')
  expect(clean).not.toContain('thread t1')
  expect(clean).not.toContain('thread t2')
  expect(clean).not.toContain('pins no version')
})
