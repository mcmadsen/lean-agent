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
// the old desk as a `claude --bg` session: listed with a live process, idle
const bg = (o: Record<string, unknown> = {}) => row({ kind: 'background', pid: 4242, state: 'idle', ...o })

// a world where `claude agents` answers `rows` (null = the call fails), `claude rm` is logged and removes the row when it succeeds
function world(rows: any[] | null, rmExit = 0, closeOld?: string) {
  resetOldDesk()
  const h = fakeHost(null)
  h.clock.t = 50_000_000
  if (closeOld) h.files.set(`${L}/config.json`, JSON.stringify({ desk: { closeOld } }))
  const state = { rows, rmExit, stopExit: 0, dropOnStop: false, calls: [] as string[][] }
  h.claude.handler = (a: string[]) => {
    state.calls.push(a)
    if (a[0] === 'agents') return state.rows ? { exitCode: 0, stdout: JSON.stringify(state.rows) } : { exitCode: 1, stdout: '', stderr: 'no service' }
    if (a[0] === 'stop') {
      if (state.stopExit !== 0) return { exitCode: 1, stdout: '', stderr: 'cannot stop' }
      // a stopped background session stays listed (no pid) unless the spec says the listing drops it
      if (state.rows) state.rows = state.dropOnStop ? state.rows.filter(r => r.sessionId !== a[1]) : state.rows.map(r => (r.sessionId === a[1] ? { ...r, pid: 0, state: 'stopped', status: 'stopped' } : r))
      return { exitCode: 0, stdout: 'stopped' }
    }
    if (a[0] === 'rm') {
      if (state.rmExit === 0 && state.rows) state.rows = state.rows.filter(r => r.sessionId !== a[1])
      return state.rmExit === 0 ? { exitCode: 0, stdout: 'removed' } : { exitCode: 1, stdout: '', stderr: 'cannot remove' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const restart = (sid = OLD, open = async () => ({ ok: true, text: 'opened' })) => restartDesk(h.host, { recent: async () => [], sid: async () => sid, open })
  const rms = () => state.calls.filter(c => c[0] === 'rm')
  const stops = () => state.calls.filter(c => c[0] === 'stop')
  return { h, state, restart, rms, stops }
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

test('the listing, claude stop and claude rm run with a timeout, so a hung service cannot hang a desk turn', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 0, 'remove')
  await w.restart()
  await oldDeskStep(w.h.host, NEW, 'start')
  const cc = w.h.calls.filter(c => c.argv[0] === 'claude')
  expect(cc.map(c => c.argv[1])).toEqual(expect.arrayContaining(['agents', 'stop', 'rm']))
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

// ---- desk.closeOld: claude stop / claude rm ------------------------------------------------------------------------
const QUIET = 'stopped; archive it in the app when you like'

test('desk.closeOld stop (the default): a background old desk is stopped by id at the new desk\'s start, once; the row stays listed, so ONE quiet line follows and ends after the first desk turn', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()])
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(w.stops()).toEqual([['stop', OLD]]) // exactly `claude stop <id>`: no flag
  expect(w.rms()).toEqual([]) // stop keeps the app's row: nothing is removed
  expect(said).toContain(QUIET)
  expect(said).not.toContain('right-click')
  expect(w.h.files.get(NOTICE)).toContain(QUIET)
  const rec = await readOldDesk(w.h.host)
  expect(rec).toMatchObject({ how: 'stop', newSid: NEW })
  expect(typeof rec?.closedAt).toBe('number')
  expect(rec?.log?.join('\n')).toContain('claude stop aaaa1111: stopped')
  // the first desk turn after it was shown ends it: not every turn
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
  expect(w.h.files.has(NOTICE)).toBe(false)
  expect((await readOldDesk(w.h.host))?.done?.why).toContain('stopped by desk.closeOld')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toBeNull()
  expect(w.stops()).toHaveLength(1)
  // the doctor says what happened (an info row, not a FIX row)
  const rows = await oldDeskRows(w.h.host)
  expect(rows).toEqual(['note old desk: stopped (desk.closeOld stop)'])
  const doc = (await check(w.h.host, '/p')).filter(l => l.includes('old desk'))
  expect(doc).toContain('note old desk: stopped (desk.closeOld stop)')
  expect(doc.every(l => !l.startsWith('FIX'))).toBe(true)
})

test('a stopped old desk that the listing no longer shows is not mentioned at all: no text, no notice', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()])
  w.state.dropOnStop = true
  await w.restart()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toBeNull()
  expect(w.stops()).toEqual([['stop', OLD]])
  expect(w.h.files.has(NOTICE)).toBe(false)
  const rec = await readOldDesk(w.h.host)
  expect(rec?.done?.why).toContain('stopped')
  expect(rec?.closedAt).toBeTruthy()
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
})

test('desk.closeOld remove: stop first, then claude rm by id once the row shows no pid; nothing is said afterwards', { timeoutMs: 20_000 }, async () => {
  for (const kind of ['background', 'bg']) {
    const w = world([bg({ kind })], 0, 'remove')
    await w.restart()
    const said = await oldDeskStep(w.h.host, NEW, 'start')
    expect(w.h.claudeCalls().filter(a => a[0] !== 'agents')).toEqual([['stop', OLD], ['rm', OLD]]) // in that order, no --discard-unpushed, no --force-remove-worktree
    expect(said).toBeNull()
    expect(w.h.files.has(NOTICE)).toBe(false)
    const rec = await readOldDesk(w.h.host)
    expect(rec).toMatchObject({ how: 'remove', rm: { ok: true } })
    expect(rec?.done?.why).toContain('stopped and removed')
    expect(rec?.log?.join('\n')).toContain('claude rm aaaa1111: removed from the list')
    expect(await oldDeskRows(w.h.host)).toEqual(['note old desk: removed (desk.closeOld remove)'])
    expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull()
    expect(w.rms()).toHaveLength(1)
  }
  // the flat spelling of the key counts too
  const f = world([bg()])
  f.h.files.set(`${L}/config.json`, JSON.stringify({ 'desk.closeOld': 'remove' }))
  await f.restart()
  await oldDeskStep(f.h.host, NEW, 'start')
  expect(f.rms()).toEqual([['rm', OLD]])
})

test('a claude rm that fails after the stop is logged, tried once, and the old desk is the quiet stopped line', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 1, 'remove')
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain(QUIET)
  const rec = await readOldDesk(w.h.host)
  expect(rec).toMatchObject({ how: 'stop', rm: { ok: false, text: 'cannot remove' } })
  expect(rec?.log?.join('\n')).toContain('claude rm aaaa1111: failed (cannot remove)')
  await oldDeskStep(w.h.host, NEW, 'turn')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(w.rms()).toHaveLength(1)
  expect(w.stops()).toHaveLength(1)
  const rows = (await oldDeskRows(w.h.host)).join('\n')
  expect(rows).toContain('note old desk: stopped (desk.closeOld stop)')
  expect(rows).toContain('claude rm of the old desk')
})

test('desk.closeOld off: nothing is stopped or removed, the reminder is today\'s; an unknown value is the default (stop)', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 0, 'off')
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain('still open in the Claude app')
  expect(said).toContain('archive it in the Claude app (right-click it in the session list, Archive)')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  expect(w.stops()).toEqual([])
  expect(w.rms()).toEqual([])
  expect((await readOldDesk(w.h.host))?.closedAt).toBeUndefined()
  const u = world([bg()], 0, 'sometimes')
  await u.restart()
  await oldDeskStep(u.h.host, NEW, 'start')
  expect(u.stops()).toHaveLength(1)
})

test('a working old desk is never stopped: it is tried again on the next desk turns, 3 tries in all, then the reminder stays', { timeoutMs: 20_000 }, async () => {
  const w = world([bg({ state: 'working', status: 'busy' })])
  await w.restart()
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toContain('still open in the Claude app') // try 1: working
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toBeNull() // the first turn: no repeated reminder, but the retry runs (try 2)
  expect((await readOldDesk(w.h.host))?.tries).toBe(2)
  expect(w.stops()).toEqual([])
  w.state.rows = [bg({ state: 'working', status: 'busy' })]
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app') // try 3
  expect((await readOldDesk(w.h.host))?.tries).toBe(3)
  // the old desk goes idle, but the 3 tries are used up: the reminder stays, nothing is stopped
  w.state.rows = [bg()]
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  expect(w.stops()).toEqual([])
  expect(w.rms()).toEqual([])
  expect((await readOldDesk(w.h.host))?.log?.join('\n')).toContain('the old desk is working, not stopped (try 3 of 3)')
  // a desk that goes idle in time is stopped on the retry
  const g = world([bg({ state: 'working', status: 'busy' })])
  await g.restart()
  await oldDeskStep(g.h.host, NEW, 'start')
  expect(g.stops()).toEqual([])
  g.state.rows = [bg()]
  expect(await oldDeskStep(g.h.host, NEW, 'turn')).toBeNull() // the first turn retries by script and stops it
  expect(g.stops()).toEqual([['stop', OLD]])
  expect((await readOldDesk(g.h.host))?.how).toBe('stop')
  expect(g.h.files.get(NOTICE)).toContain(QUIET)
  // a session waiting on a prompt is not stopped either
  const p = world([bg({ waitingFor: 'a permission prompt' })])
  await p.restart()
  await oldDeskStep(p.h.host, NEW, 'start')
  expect(p.stops()).toEqual([])
})

test('only the recorded old desk id is ever stopped or removed: not another row, a partial id, another folder, a desktop row, the new desk', { timeoutMs: 20_000 }, async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['desktop kind', { kind: 'desktop', pid: 4242 }],
    ['no kind', { kind: undefined }],
    ['another folder', { cwd: '/h/code/proj' }],
    ['no folder', { cwd: undefined }],
    ['another session that only shares the short id', { sessionId: 'cccc9999-0000-0000-0000-000000000000', id: OLD.slice(0, 8) }],
    ['a thread session', { sessionId: 'dddd9999-0000-0000-0000-000000000000', id: 'dddd9999', name: 't3 · parser', cwd: '/h/.lean-agent/threads/t3' }],
  ]
  for (const mode of ['stop', 'remove']) {
    for (const [name, o] of cases) {
      const w = world([bg(o)], 0, mode)
      await w.restart()
      const said = await oldDeskStep(w.h.host, NEW, 'start')
      expect(w.stops(), name).toEqual([])
      expect(w.rms(), name).toEqual([])
      expect(said, name).toContain('archive it in the Claude app')
    }
    // the new desk is never the target: a restart recorded from the very session that is now running
    const n = world([bg({ sessionId: NEW, id: NEW.slice(0, 8) })], 0, mode)
    await n.restart(NEW)
    await oldDeskStep(n.h.host, NEW, 'start')
    expect(n.stops()).toEqual([])
    expect(n.rms()).toEqual([])
    // the other rows of the listing are left alone: only the recorded id is stopped
    const o = world([bg(), bg({ sessionId: NEW, id: NEW.slice(0, 8), pid: 4343 }), bg({ sessionId: 'eeee1111-0000-0000-0000-000000000000', id: 'eeee1111', name: 't1 · other', cwd: '/h/.lean-agent/threads/t1', pid: 4444 })], 0, mode)
    await o.restart()
    await oldDeskStep(o.h.host, NEW, 'start')
    expect(o.stops()).toEqual([['stop', OLD]])
    expect(o.rms().every(c => c[1] === OLD)).toBe(true)
  }
})

test('nothing is stopped before the handover is saved and the new desk runs: a record without the handover mark, the old desk itself, a session that is not the new desk', { timeoutMs: 20_000 }, async () => {
  // a record the restart did not write (no handover mark)
  const w = world([bg()])
  w.h.files.set(`${L}/desk/old-desk.json`, JSON.stringify({ sid: OLD, title: '', restartedAt: 50_000_000 }))
  expect(await oldDeskStep(w.h.host, NEW, 'start')).toContain('still open in the Claude app')
  expect(w.stops()).toEqual([])
  // the old desk reloading never stops itself
  const o = world([bg()])
  await o.restart()
  expect(await oldDeskStep(o.h.host, OLD, 'start')).toBeNull()
  expect(await oldDeskStep(o.h.host, OLD, 'turn')).toBeNull()
  expect(o.stops()).toEqual([])
  // a restart whose handover could not be written records nothing, so nothing is stopped
  const f = world([bg()])
  const realWrite = f.h.host.fs.write.bind(f.h.host.fs)
  f.h.host.fs.write = async (p: string, t: string) => {
    if (p.includes('handover.md')) throw new Error('disk full')
    return realWrite(p, t)
  }
  const failed = await f.restart()
  expect(failed.ok).toBe(false)
  expect(await readOldDesk(f.h.host)).toBeNull()
  await oldDeskStep(f.h.host, NEW, 'start')
  expect(f.stops()).toEqual([])
  // a restart whose new desk did not open is dismissed: no stop
  const d = world([bg()])
  await d.restart(OLD, async () => ({ ok: false, text: 'The Claude app is not running' }))
  await oldDeskStep(d.h.host, NEW, 'start')
  expect(d.stops()).toEqual([])
})

test('a failed claude stop never throws: it is logged, the reminder stays, and it is tried on the next turns (3 tries in all)', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 0, 'remove')
  w.state.stopExit = 1
  await w.restart()
  const said = await oldDeskStep(w.h.host, NEW, 'start')
  expect(said).toContain('still open in the Claude app')
  expect(w.h.files.get(NOTICE)).toContain('is not archived')
  expect((await readOldDesk(w.h.host))?.log?.join('\n')).toContain('claude stop aaaa1111 failed (cannot stop) (try 1 of 3)')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('still open in the Claude app')
  await oldDeskStep(w.h.host, NEW, 'turn')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(w.stops()).toHaveLength(3)
  expect(w.rms()).toEqual([]) // no rm without a stop
  expect((await readOldDesk(w.h.host))?.closedAt).toBeUndefined()
  // a stop that cannot even start, and one that leaves the process running, are failures too
  const n = world([bg()])
  n.h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify([bg()]) }
    throw new Error('spawn claude ENOENT')
  }
  await n.restart()
  expect(await oldDeskStep(n.h.host, NEW, 'start')).toContain('still open in the Claude app')
  const k = world([bg()])
  k.h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([bg()]) } : { exitCode: 0, stdout: '' }) // "stopped", but the row keeps its pid
  await k.restart()
  expect(await oldDeskStep(k.h.host, NEW, 'start')).toContain('still open in the Claude app')
  expect((await readOldDesk(k.h.host))?.log?.join('\n')).toContain('still running after claude stop aaaa1111')
  expect((await readOldDesk(k.h.host))?.closedAt).toBeUndefined()
})

test('the close is recorded once: a later session start or turn never stops or removes it again', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 0, 'remove')
  w.state.dropOnStop = false
  await w.restart()
  await oldDeskStep(w.h.host, NEW, 'start')
  const closedAt = (await readOldDesk(w.h.host))?.closedAt
  expect(closedAt).toBeTruthy()
  w.h.clock.t += 60_000
  // the app lists the old desk again (a stopped row is not a running one): the record is done, nothing runs again
  w.state.rows = [bg({ pid: 0, state: 'stopped' })]
  await oldDeskStep(w.h.host, NEW, 'start')
  await oldDeskStep(w.h.host, NEW, 'turn')
  await oldDeskStep(w.h.host, NEW, 'turn')
  expect(w.stops()).toHaveLength(1)
  expect(w.rms()).toHaveLength(1)
  expect((await readOldDesk(w.h.host))?.closedAt).toBe(closedAt)
  // an unsettled close (stop done, still listed) is not repeated by the next start either
  const q = world([bg()])
  await q.restart()
  await oldDeskStep(q.h.host, NEW, 'start')
  await oldDeskStep(q.h.host, NEW, 'start')
  expect(q.stops()).toHaveLength(1)
})

test('a desktop desk the mod cannot see or close keeps today\'s reminder unchanged (and the doctor says so as an info row)', { timeoutMs: 20_000 }, async () => {
  for (const rows of [[], [row()]]) {
    const w = world(rows)
    await w.restart()
    const said = await oldDeskStep(w.h.host, NEW, 'start')
    expect(w.stops()).toEqual([])
    expect(w.rms()).toEqual([])
    expect(said).toContain('archive it in the Claude app (right-click it in the session list, Archive)')
    expect(said).not.toContain(QUIET)
    await oldDeskStep(w.h.host, NEW, 'turn')
    expect(await oldDeskStep(w.h.host, NEW, 'turn')).toContain('archive it in the Claude app (right-click it in the session list, Archive)')
    expect((await readOldDesk(w.h.host))?.closedAt).toBeUndefined()
  }
  const d = world([])
  await d.restart()
  await oldDeskStep(d.h.host, NEW, 'start')
  const rows = await oldDeskRows(d.h.host)
  expect(rows).toContain('note old desk: desktop session, archive it in the app')
  expect(rows.join('\n')).toContain('note old desk session (aaaa1111)') // today's row is still there
  const doc = (await check(d.h.host, '/p')).filter(l => l.includes('old desk'))
  expect(doc.every(l => !l.startsWith('FIX'))).toBe(true)
  expect(doc).toContain('note old desk: desktop session, archive it in the app')
})

test('the mod never kills the app or restarts a service for the old desk, and never uses a flag with stop or rm', { timeoutMs: 20_000 }, async () => {
  const w = world([bg()], 0, 'remove')
  await w.restart()
  await oldDeskStep(w.h.host, NEW, 'start')
  await oldDeskStep(w.h.host, NEW, 'turn')
  const argvs = w.h.calls.map(c => c.argv.join(' '))
  expect(argvs.filter(a => /claude kill|respawn|launchctl|systemctl|pkill|killall|\bkill\b/.test(a))).toEqual([])
  expect(w.h.claudeCalls().every(a => a[0] === 'agents' || ((a[0] === 'stop' || a[0] === 'rm') && a.length === 2 && a[1] === OLD))).toBe(true)
})
