// threads.restartOlder (olderrestart.ts): ask / auto / off, each thread state, once per installed version, the first 2 minutes, closed never reopened, the notice.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { AFTER_UPDATE_MS, modeAdvice, olderCandidates, olderRowCount, olderTick, planOf, restartLabel, restartOlderMode, restartOlderNow } from './olderrestart'
import type { RestartDeps } from './olderrestart'
import { skewRow } from './skew'
import { check } from './doctor'
import type { AgentRow } from './threads'

const TD = '/h/.lean-agent/threads'
const row = (sid: string, state: string, extra: Partial<AgentRow> = {}): AgentRow => ({ sid, name: '', cwd: '', status: state, startedAt: 1, pid: state === 'idle' || state === 'working' ? 5 : 0, id: sid, state, waitingFor: '', ...extra })

function world(threads: Record<string, { state: string; sid?: string; run?: string; finished?: number }>, rows: AgentRow[], cfg: unknown = {}) {
  const h = fakeHost(null)
  h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.35' }))
  h.files.set('/h/.lean-agent/config.json', JSON.stringify(cfg))
  for (const [id, t] of Object.entries(threads)) {
    const sid = t.sid ?? `s-${id}`
    h.files.set(`${TD}/${id}/thread.json`, JSON.stringify({ id, title: id, project: 'acme', state: t.state, sid, created: 1, lastWake: 1, delivered: 0, ...(t.finished ? { finished: t.finished } : {}), ...(t.run ? { running: { version: t.run, sid, at: 1 } } : {}) }))
  }
  const calls: { id: string; parked: boolean; why: string }[] = []
  const deps: RestartDeps = { agents: async () => rows, restart: async (id, why, parked) => (calls.push({ id, parked, why }), { ok: true, text: `${id} restarted` }) }
  return { h, deps, calls }
}

const ALL = { t1: { state: 'open', run: '1.0.34' }, t2: { state: 'open', run: '1.0.34' }, t3: { state: 'open', run: '1.0.34' }, t4: { state: 'open', run: '1.0.34' }, t5: { state: 'parked', run: '1.0.34' }, t6: { state: 'closed', run: '1.0.34' }, t7: { state: 'open', run: '1.0.35' }, t8: { state: 'open', run: '1.0.34', finished: 5 } }
const ROWS = [row('s-t1', 'idle'), row('s-t2', 'working'), row('s-t3', 'blocked', { waitingFor: 'a prompt' }), row('s-t4', 'idle'), row('s-t5', 'idle'), row('s-t6', 'idle'), row('s-t7', 'idle')] // (t8 finished: its session is gone from the list)

test('the config key: ask by default, auto and off, anything else is ask', async () => {
  const w = world({}, [])
  expect(await restartOlderMode(w.h.host, '/h')).toBe('ask')
  for (const [v, want] of [['auto', 'auto'], ['off', 'off'], ['ask', 'ask'], ['sometimes', 'ask']]) {
    w.h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { restartOlder: v } }))
    expect(await restartOlderMode(w.h.host, '/h')).toBe(want)
  }
})

test('candidates: open and parked threads whose recorded session is older; closed, current and unrecorded ones never', async () => {
  const w = world({ ...ALL, t9: { state: 'open' } }, ROWS)
  expect((await olderCandidates(w.h.host, '/plug')).map(c => c.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't8'])
})

test('ask: the press restarts idle, parked-with-session and done-not-closed threads; a working one and one at an open prompt are listed and left; a closed one is never touched', async () => {
  const w = world(ALL, ROWS)
  const o = await restartOlderNow(w.h.host, '/plug', w.deps)
  expect(w.calls.map(c => c.id)).toEqual(['t1', 't4', 't5', 't8'])
  expect(w.calls.find(c => c.id === 't5')!.parked).toBe(true) // the restart that reopens a parked thread
  expect(w.calls.filter(c => c.id !== 't5').every(c => !c.parked)).toBe(true)
  expect(w.calls.some(c => c.id === 't6')).toBe(false)
  expect(w.calls[0]!.why).toContain('older plugin 1.0.34')
  expect(o.restarted).toEqual(['t1', 't4', 't5', 't8'])
  expect(o.text).toContain('restarted 4 older threads from their handovers: t1 (was 1.0.34), t4 (was 1.0.34), t5 (was 1.0.34), t8 (was 1.0.34)')
  expect(o.text).toContain('t2 is working: restarted when it goes idle')
  expect(o.text).toContain('t3 waits for you (an open prompt)')
  expect(o.text).not.toContain('t6')
})

test('ask: nothing older says so; off says it is off; a listing that fails restarts nothing', async () => {
  const none = world({ t1: { state: 'open', run: '1.0.35' } }, [])
  expect((await restartOlderNow(none.h.host, '/plug', none.deps)).text).toBe('no thread runs an older plugin than the installed one')
  const off = world(ALL, ROWS, { threads: { restartOlder: 'off' } })
  const o = await restartOlderNow(off.h.host, '/plug', off.deps)
  expect(o.text).toContain('threads.restartOlder is off')
  expect(off.calls).toEqual([])
  const bad = world(ALL, ROWS)
  const r = await restartOlderNow(bad.h.host, '/plug', { ...bad.deps, agents: async () => null })
  expect(r.ok).toBe(false)
  expect(bad.calls).toEqual([])
})

test('ask: a restart that fails is named, the others still go', async () => {
  const w = world({ t1: { state: 'open', run: '1.0.34' }, t4: { state: 'open', run: '1.0.34' } }, [row('s-t1', 'idle'), row('s-t4', 'idle')])
  const deps: RestartDeps = { ...w.deps, restart: async id => (id === 't1' ? { ok: false, text: 'cannot start' } : { ok: true, text: 'ok' }) }
  const o = await restartOlderNow(w.h.host, '/plug', deps)
  expect(o.restarted).toEqual(['t4'])
  expect(o.ok).toBe(false)
  expect(o.text).toContain('not restarted, t1: cannot start')
})

test('auto: nothing in the first 2 minutes after the installed version changed, then the idle open threads only (never a parked, working, blocked or closed one), ONE notice', async () => {
  const w = world(ALL, ROWS, { threads: { restartOlder: 'auto' } })
  expect(await olderTick(w.h.host, '/plug', w.deps)).toEqual([]) // the version is new to the desk: the clock starts
  w.h.clock.t += AFTER_UPDATE_MS - 1000
  expect(await olderTick(w.h.host, '/plug', w.deps)).toEqual([])
  expect(w.calls).toEqual([])
  w.h.clock.t += 2000
  const notes = await olderTick(w.h.host, '/plug', w.deps)
  expect(w.calls.map(c => c.id)).toEqual(['t1', 't4', 't8'])
  expect(w.calls.every(c => !c.parked)).toBe(true)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('restarted 3 threads that ran an older plugin than the installed 1.0.35: t1 (was 1.0.34), t4 (was 1.0.34), t8 (was 1.0.34) (new sessions from their handovers; threads.restartOlder auto)')
})

test('auto: at most once per thread per installed version; a thread that was working is restarted when it goes idle; a new version starts over', async () => {
  const rows = [...ROWS]
  const w = world({ t1: { state: 'open', run: '1.0.34' }, t2: { state: 'open', run: '1.0.34' } }, [row('s-t1', 'idle'), row('s-t2', 'working')], { threads: { restartOlder: 'auto' } })
  const deps: RestartDeps = { ...w.deps, agents: async () => [row('s-t1', 'idle'), rows.length ? row('s-t2', 'working') : row('s-t2', 'idle')] }
  await olderTick(w.h.host, '/plug', deps)
  w.h.clock.t += AFTER_UPDATE_MS + 1000
  await olderTick(w.h.host, '/plug', deps)
  expect(w.calls.map(c => c.id)).toEqual(['t1']) // t2 works: left alone
  w.h.clock.t += 30_000
  expect(await olderTick(w.h.host, '/plug', deps)).toEqual([]) // t1 still shows the old version (the service kept the plugin): not again for 1.0.35
  expect(w.calls.map(c => c.id)).toEqual(['t1'])
  rows.length = 0 // t2 is idle now
  const notes = await olderTick(w.h.host, '/plug', deps)
  expect(w.calls.map(c => c.id)).toEqual(['t1', 't2'])
  expect(notes[0]!.text).toContain('restarted 1 thread that ran an older plugin than the installed 1.0.35: t2 (was 1.0.34)')
  // a newer install: the clock and the once-per-version list start over
  w.h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.36' }))
  w.h.clock.t += 30_000
  expect(await olderTick(w.h.host, '/plug', deps)).toEqual([])
  w.h.clock.t += AFTER_UPDATE_MS + 1000
  await olderTick(w.h.host, '/plug', deps)
  expect(w.calls.map(c => c.id)).toEqual(['t1', 't2', 't1', 't2'])
})

test('auto vs ask vs off: the timer restarts only in auto; a failed restart is not tried again for the version (no loop)', async () => {
  for (const mode of ['ask', 'off']) {
    const w = world({ t1: { state: 'open', run: '1.0.34' } }, [row('s-t1', 'idle')], { threads: { restartOlder: mode } })
    await olderTick(w.h.host, '/plug', w.deps)
    w.h.clock.t += AFTER_UPDATE_MS + 1000
    expect(await olderTick(w.h.host, '/plug', w.deps)).toEqual([])
    expect(w.calls).toEqual([])
  }
  const w = world({ t1: { state: 'open', run: '1.0.34' } }, [row('s-t1', 'idle')], { threads: { restartOlder: 'auto' } })
  let n = 0
  const deps: RestartDeps = { ...w.deps, restart: async () => (n++, { ok: false, text: 'no' }) }
  await olderTick(w.h.host, '/plug', deps)
  w.h.clock.t += AFTER_UPDATE_MS + 1000
  expect(await olderTick(w.h.host, '/plug', deps)).toEqual([]) // nothing restarted: no notice
  await olderTick(w.h.host, '/plug', deps)
  expect(n).toBe(1)
})

test('a closed thread is never reopened: not a candidate even when its record says it runs an older plugin, and the real restart path refuses it', async () => {
  const w = world({ t6: { state: 'closed', run: '1.0.34' }, t7: { state: 'closing', run: '1.0.34' } }, [row('s-t6', 'idle'), row('s-t7', 'idle')], { threads: { restartOlder: 'auto' } })
  expect(await olderCandidates(w.h.host, '/plug')).toEqual([])
  expect(planOf([], [], { auto: true }).go).toEqual([])
})

test('lean_doctor check: the ONE FIX row of older threads carries the step of the mode (ask: the button / lean_doctor restart-older; auto: restarts by itself; off: the row only)', async () => {
  const rowOf = async (cfg: unknown) => {
    const w = world({ t1: { state: 'open', run: '1.0.34' }, t3: { state: 'open', run: '1.0.34' }, t7: { state: 'open', run: '1.0.35' } }, [], cfg)
    return (await check(w.h.host, '/plug')).filter(r => /older plugin than the installed/.test(r))
  }
  const ask = await rowOf({})
  expect(ask).toHaveLength(1)
  expect(ask[0]).toMatch(/^FIX +2 threads run an older plugin than the installed 1\.0\.35: t1 \(1\.0\.34\), t3 \(1\.0\.34\)/)
  expect(ask[0]).toContain('Restart 2 older threads: one press in the Health card, or lean_doctor restart-older')
  expect((await rowOf({ threads: { restartOlder: 'auto' } }))[0]).toContain('restarts them by itself when they are idle (threads.restartOlder auto)')
  const off = (await rowOf({ threads: { restartOlder: 'off' } }))[0]!
  expect(off).not.toContain('Restart 2 older')
  expect(off).not.toContain('threads.restartOlder')
})

test('the doctor row carries the step of the mode; the pane counts its threads', () => {
  const older = [{ id: 't1', run: '1.0.34', installed: '1.0.35' }, { id: 't3', run: '1.0.34', installed: '1.0.35' }]
  const ask = skewRow(older, modeAdvice('ask', 2))
  expect(ask).toContain('2 threads run an older plugin than the installed 1.0.35: t1 (1.0.34), t3 (1.0.34)')
  expect(ask).toContain('Restart 2 older threads: one press in the Health card, or lean_doctor restart-older')
  expect(skewRow(older, modeAdvice('auto', 2))).toContain('restarts them by itself when they are idle (threads.restartOlder auto)')
  expect(skewRow(older, modeAdvice('off', 2))).toBe(skewRow(older)) // off: only the row, as before
  expect(olderRowCount(ask)).toBe(2)
  expect(olderRowCount(skewRow([older[0]!], modeAdvice('ask', 1)))).toBe(1)
  expect(olderRowCount('2 other things')).toBe(0)
  expect(restartLabel(1)).toBe('Restart 1 older thread')
  expect(restartLabel(3)).toBe('Restart 3 older threads')
})
