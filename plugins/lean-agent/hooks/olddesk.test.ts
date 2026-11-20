// "Restart desk" leaves the old desk open: the mod records it, names it in the new desk's first notice, and tries `claude rm` only for a
// background session that is certainly idle. Every branch below runs on canned `claude agents --json --all` output.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { restartDesk } from './deskcompact'
import { SEEN_MS, UNLISTED_MS, dismissOldDesk, oldDeskRows, oldDeskStep, readOldDesk, resetOldDesk } from './olddesk'

const L = '/h/.lean-agent'
const OLD = 'aaaa1111-2222-3333-4444-555555555555'
const NEW = 'bbbb1111-2222-3333-4444-555555555555'
const DESK = '/h/lean-agent-desk'
const NOTICE = `${L}/notices/old-desk.txt`
const row = (o: Record<string, unknown> = {}) => ({ sessionId: OLD, id: OLD.slice(0, 8), name: 'lean-agent desk', cwd: DESK, kind: 'desktop', status: 'idle', state: 'done', ...o })

// a world where `claude agents` answers `rows` (null = the call fails), `claude rm` is logged and removes the row when it succeeds
function world(rows: any[] | null, rmExit = 0) {
  resetOldDesk()
  const h = fakeHost(null)
  h.clock.t = 50_000_000
  const state = { rows, rmExit, calls: [] as string[][] }
  h.claude.handler = (a: string[]) => {
    state.calls.push(a)
    if (a[0] === 'agents') return state.rows ? { exitCode: 0, stdout: JSON.stringify(state.rows) } : { exitCode: 1, stdout: '', stderr: 'no service' }
    if (a[0] === 'rm') {
      if (state.rmExit === 0 && state.rows) state.rows = state.rows.filter(r => r.sessionId !== a[1])
      return state.rmExit === 0 ? { exitCode: 0, stdout: 'removed' } : { exitCode: 1, stdout: '', stderr: 'cannot remove' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const restart = (sid = OLD, open = async () => ({ ok: true, text: 'opened' })) => restartDesk(h.host, { recent: async () => [], sid: async () => sid, open })
  const rms = () => state.calls.filter(c => c[0] === 'rm')
  return { h, state, restart, rms }
}

test('Restart desk records the old desk (id and title from the listing) BEFORE the new desk opens, and the reply says to archive it', async () => {
  const w = world([row()])
  let at: any = 'not called'
  const r = await w.restart(OLD, async () => { at = await readOldDesk(w.h.host); return { ok: true, text: 'opened' } })
  expect(at).toMatchObject({ sid: OLD, title: 'lean-agent desk', restartedAt: 50_000_000 })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('New desk opened with the handover: close this one')
  expect(r.text).toContain('archive it in the Claude app (right-click, Archive)')
  expect(w.rms()).toEqual([]) // restarting never removes anything by itself
})

test('Restart desk: an unknown session id records nothing (no reminder follows); a failed open leaves no pending reminder', async () => {
  const a = world([row()])
  const r = await a.restart('')
  expect(r.text).toContain('no reminder follows')
  expect(await readOldDesk(a.h.host)).toBeNull()
  const b = world([row()])
  const f = await b.restart(OLD, async () => ({ ok: false, text: 'The Claude app is not running' }))
  expect(f.ok).toBe(false)
  expect(await oldDeskStep(b.h.host, NEW, 'start')).toBeNull() // nothing took over: nothing to archive
  expect(b.h.files.has(NOTICE)).toBe(false)
})

test('the new desk\'s first notice names the old session and says to archive it; the old desk itself hears nothing', async () => {
  const w = world([row()])
  await w.restart()
  expect(await oldDeskStep(w.h.host, OLD, 'start')).toBeNull() // the old desk reloading
  expect(w.h.files.has(NOTICE)).toBe(false)
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain("'lean-agent desk' (aaaa1111)")
  expect(said).toContain('archive it in the Claude app (right-click it in the session list, Archive)')
  expect(w.h.files.get(NOTICE)).toContain('archive it in the Claude app')
  expect((await readOldDesk(w.h.host))?.newSid).toBe(NEW)
})

test('the reminder comes once per new desk turn (not again for the first turn after the start) until the old id is no longer an active row', async () => {
  const w = world([row()])
  await w.restart()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toContain('still open in the Claude app')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // the first turn of the session that just heard it
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  expect((await readOldDesk(w.h.host))?.said).toBe(3)
  // the row is archived (listed as archived): the reminder ends and the notice goes
  w.state.rows = [row({ archived: true })]
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
  expect(w.h.files.has(NOTICE)).toBe(false)
  expect((await readOldDesk(w.h.host))?.done?.why).toContain('no longer an active row')
  w.state.rows = [row()]
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // settled: never again
  // a row that disappears from the listing is gone too
  const g = world([row()])
  await g.restart()
  await oldDeskStep(g.h.host, NEW, 'start')
  expect(await oldDeskStep(g.h.host, NEW, 'turn')).toBeNull() // (the turn after the start)
  g.state.rows = []
  expect(await oldDeskStep(g.h.host, NEW, 'turn')).toBeNull()
  expect((await readOldDesk(g.h.host))?.done).toBeTruthy()
})

test('a desk session the listing never shows: said plainly, once per turn, and it stops 24 h after the restart or on a dismiss', async () => {
  const w = world([])
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain('not in `claude agents`')
  expect(said).toContain('cannot tell whether it is archived')
  expect(said).toContain('24 h')
  expect(w.h.files.get(NOTICE)).toContain('cannot see whether you did')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // (the turn after the start)
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('not in `claude agents`')
  w.h.clock.t += UNLISTED_MS + 1
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // the window is over: it cannot repeat forever
  expect(w.h.files.has(NOTICE)).toBe(false)
  expect((await readOldDesk(w.h.host))?.done?.why).toContain('24 h')
  // a dismiss ends it earlier; the doctor names the old desk until then
  const d = world([])
  await d.restart()
  await oldDeskStep(d.h.host, NEW, 'start')
  const rows = await oldDeskRows(d.h.host)
  expect(rows[0]).toContain('note old desk session (aaaa1111)') // (the listing had no title for it)
  expect(rows[0]).toContain('archive it in the Claude app (right-click it in the session list, Archive)')
  expect(rows[0]).toContain('dismiss-old-desk')
  expect((await check(d.h.host, '/p')).join('\n')).toContain('old desk session')
  expect((await dismissOldDesk(d.h.host)).ok).toBe(true)
  expect(d.h.files.has(NOTICE)).toBe(false)
  expect(await oldDeskStep(d.h.host, NEW, 'turn')).toBeNull()
  expect(await oldDeskRows(d.h.host)).toEqual([])
  expect((await check(d.h.host, '/p')).join('\n')).not.toContain('old desk session')
  expect((await dismissOldDesk(world([]).h.host)).ok).toBe(false) // nothing recorded
})

test('a desk the listing keeps showing as active is reminded about for 7 days at most', async () => {
  const w = world([row()])
  await w.restart()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toContain('still open in the Claude app')
  await oldDeskStep(w.h.host, NEW, 'turn')
  w.h.clock.t += UNLISTED_MS + 1 // past the 24 h of an unlisted desk: a listed one is still reminded
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  w.h.clock.t += SEEN_MS
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
  expect((await readOldDesk(w.h.host))?.done?.why).toContain('7 days')
  expect(w.h.files.has(NOTICE)).toBe(false)
})

test('the listing and claude rm run with a timeout, so a hung service cannot hang a desk turn', async () => {
  const w = world([row({ kind: 'background' })])
  await w.restart()
  await oldDeskStep(w.h.host, NEW, 'start')
  const cc = w.h.calls.filter(c => c.argv[0] === 'claude')
  expect(cc.length).toBeGreaterThan(1)
  for (const c of cc) expect(c.timeoutMs, c.argv.join(' ')).toBeGreaterThan(0)
})

test('a failing listing concludes nothing, and a never-seen old desk still ends 24 h after the restart', async () => {
  const w = world(null)
  await w.restart()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toContain('archive it in the Claude app')
  expect(w.rms()).toEqual([])
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // (the turn after the start)
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('archive it in the Claude app')
  w.h.clock.t += UNLISTED_MS + 1
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
  expect((await readOldDesk(w.h.host))?.done).toBeTruthy()
})

// ---- claude rm ----------------------------------------------------------------------------------------------------
test('claude rm runs for a background session that is not working, with the exact id and no flag, and the result is logged', async () => {
  for (const kind of ['background', 'bg']) {
    const w = world([row({ kind })])
    await w.restart()
    const said = await oldDeskStep(w.h.host, NEW, 'start')
    expect(w.rms()).toEqual([['rm', OLD]]) // exactly `claude rm <id>`: no --discard-unpushed, no --force-remove-worktree
    expect(said).toContain('removed from the app\'s list with claude rm (its conversation is kept)')
    const rec = await readOldDesk(w.h.host)
    expect(rec?.rm).toMatchObject({ ok: true })
    expect(rec?.done?.why).toContain('claude rm removed it')
    expect(rec?.log?.join('\n')).toContain('claude rm aaaa1111: removed from the list')
    expect(w.h.files.has(NOTICE)).toBe(false)
  }
})

test('a claude rm that fails is logged, tried once, and the reminder to archive goes on', async () => {
  const w = world([row({ kind: 'background' })], 1)
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain('still open in the Claude app')
  const rec = await readOldDesk(w.h.host)
  expect(rec?.rm).toMatchObject({ ok: false, text: 'cannot remove' })
  expect(rec?.log?.join('\n')).toContain('claude rm aaaa1111: failed (cannot remove)')
  await oldDeskStep(w.h.host, NEW, 'turn')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(w.rms()).toHaveLength(1)
  expect((await oldDeskRows(w.h.host)).join('\n')).toContain('claude rm of the old desk')
})

test('claude rm is never run: a desktop (SDK) or unknown kind, a working or running session, a prompt, another folder, a partial id, the new desk', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['desktop kind', { kind: 'desktop' }],
    ['no kind', { kind: undefined }],
    ['working status', { kind: 'background', status: 'busy' }],
    ['working state', { kind: 'background', state: 'working' }],
    ['no status at all', { kind: 'background', status: undefined, state: undefined }],
    ['a live process', { kind: 'background', pid: 42 }],
    ['waiting on a prompt', { kind: 'background', waitingFor: 'a permission prompt' }],
    ['another folder', { kind: 'background', cwd: '/h/code/proj' }],
    ['no folder', { kind: 'background', cwd: undefined }],
    ['another session that only shares the short id', { kind: 'background', sessionId: 'cccc9999-0000-0000-0000-000000000000', id: OLD.slice(0, 8) }],
  ]
  for (const [name, o] of cases) {
    const w = world([row(o)])
    await w.restart()
    const said = await oldDeskStep(w.h.host, NEW, 'start')
    expect(w.rms(), name).toEqual([])
    expect(said, name).toContain('archive it in the Claude app')
  }
  // the new desk is never the target: a restart recorded from the very session that is now running
  const n = world([row({ sessionId: NEW, id: NEW.slice(0, 8), kind: 'background' })])
  await n.restart(NEW)
  await oldDeskStep(n.h.host, NEW, 'start')
  expect(n.rms()).toEqual([])
  // other rows in the listing are never touched
  const o = world([row({ kind: 'background', status: 'busy' }), row({ sessionId: NEW, id: NEW.slice(0, 8), kind: 'background' })])
  await o.restart()
  await oldDeskStep(o.h.host, NEW, 'start')
  expect(o.rms()).toEqual([])
})

test('the mod never stops a session, kills the app or restarts a service for the old desk', async () => {
  const w = world([row({ kind: 'background' })])
  await w.restart()
  await oldDeskStep(w.h.host, NEW, 'start')
  await oldDeskStep(w.h.host, NEW, 'turn')
  const argvs = w.h.calls.map(c => c.argv.join(' '))
  expect(argvs.filter(a => /claude stop|claude kill|respawn|launchctl|systemctl|pkill|killall|\bkill\b/.test(a))).toEqual([])
  expect(w.h.claudeCalls().every(a => a[0] === 'agents' || a[0] === 'rm')).toBe(true)
})
