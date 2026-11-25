// Automatic restart at the context limit (autorestart.ts, threads.ts auto-restart): the thread's mod checkpoints at the turn end, the
// desk's timer restarts by script once the session has been idle 20 s. Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { isRestarting, stopRecordText } from './contextstop'
import { stateOf } from './view'
import { IDLE_MS, MIN_GAP_MS, autoRestartTick, stopGraceMs, threadTurnEnd, workLeft } from './autorestart'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'

const S1 = '11111111-2222-3333-4444-555555555555'
const S0 = '00000000-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const INBOX = `${L}/desk/inbox.jsonl`
const MARK = `${T1}/autorestart.json`
const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
const marker = (h: any) => JSON.parse(h.files.get(MARK) ?? '{}')
const inbox = (h: any) => (h.files.get(INBOX) ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

function setup(o: { config?: unknown; row?: Record<string, unknown> } = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' }, ...((o.config as object | undefined) ?? {}) })) // (these specs read the full prompt; core is the default since 1.0.27)
  const st = { rows: [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  return { h, st }
}
const end = (h: any, o: Partial<{ sid: string; tokens: number | null; since: number }> = {}) => threadTurnEnd(h.host, 't1', { sid: S1, tokens: 205_000, since: 0, ...o })

test('turn end over the limit with work left: snapshot, a mod-authored inbox record, a pending marker', async () => {
  const { h } = setup()
  const out = await end(h)
  expect(out).toEqual({ snapshot: true, action: 'checkpoint', stop: { tokens: 205_000, limit: 120_000 } })
  expect(JSON.parse(h.files.get(`${T1}/state.json`)!).tokens).toBe(205_000)
  const r = inbox(h)
  expect(r).toHaveLength(1)
  expect(r[0]).toMatchObject({ from: 't1', kind: 'report', state: 'checkpoint', mod: true, restart: { tokens: 205_000, limit: 120_000, sid: S1 } })
  expect(r[0].text).toBe(stopRecordText(205_000, 120_000))
  expect(r[0].text).toMatch(/context 205k over the limit 120k: state saved, restart me/)
  expect(marker(h).pending).toMatchObject({ ts: 1_000_000, sid: S1, tokens: 205_000 })
  // the same session ending another turn does not write a second checkpoint
  expect((await end(h)).action).toBe('none')
  expect(inbox(h)).toHaveLength(1)
})

test('turn end: under the limit, or after done / blocked / a question, only the snapshot is written', async () => {
  const under = setup().h
  expect(await end(under, { tokens: 50_000 })).toEqual({ snapshot: true, action: 'none', stop: null })
  expect(inbox(under)).toHaveLength(0)
  for (const last of [{ kind: 'report', state: 'done' }, { kind: 'report', state: 'blocked' }, { kind: 'ask' }]) {
    const { h } = setup()
    h.files.set(INBOX, rec({ ts: 500, from: 't1', text: 'x', ...last }))
    expect((await end(h, { since: 400 })).action).toBe('none')
    expect(inbox(h)).toHaveLength(1) // only the report that was there
  }
  // a done report of an EARLIER turn does not count (the thread went on working)
  const { h } = setup()
  h.files.set(INBOX, rec({ ts: 100, from: 't1', kind: 'report', state: 'done', text: 'x' }))
  expect((await end(h, { since: 400 })).action).toBe('checkpoint')
  expect(workLeft([], 't1', 0)).toBe(true)
})

test('config threads.autoRestart false: the stop and its record stay, but nothing is marked for a restart', async () => {
  const { h } = setup({ config: { threads: { autoRestart: false } } })
  expect((await end(h)).action).toBe('checkpoint')
  expect(inbox(h)).toHaveLength(1)
  expect(marker(h).pending).toBeUndefined()
  expect(await autoRestartTick(h.host, { agents: async () => [], restart: async () => ({ ok: true, text: '' }) })).toEqual([])
})

test('a fresh session that starts over the limit stops and asks the user, once', async () => {
  const { h } = setup()
  h.files.set(MARK, JSON.stringify({ last: { at: 900_000, oldSid: S0 } }))
  expect((await end(h)).action).toBe('ask') // S1 is not the session that was restarted: its first turn end is over the limit
  const r = inbox(h)
  expect(r[0]).toMatchObject({ from: 't1', kind: 'ask', mod: true })
  expect(r[0].text).toContain('again over it')
  expect(marker(h).stopped).toBe(true)
  expect(marker(h).last.newSid).toBe(S1)
  const rec = (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l)) // the loop guard is a refusal record (feedback.ts), which the export lists
  expect(rec).toHaveLength(1)
  expect(rec[0]).toMatchObject({ role: 'thread', rule: 'auto-restart-loop', kind: 'refusal', thread: 't1' })
  expect((await end(h)).action).toBe('none') // stopped: no loop
  expect(inbox(h)).toHaveLength(1)
  // under the limit again: restarts are allowed again
  await end(h, { tokens: 10_000 })
  expect(marker(h).stopped).toBe(false)
  // a later overflow of the same session: stopped again, but never a second record for the same session
  expect((await end(h)).action).toBe('none')
  expect(inbox(h)).toHaveLength(1)
})

const rows = (state = 'idle') => async () => [{ sid: S1, name: '', cwd: T1, status: state, state, startedAt: 1, pid: 42, id: 'a', waitingFor: '' }] as any
const ok = { ok: true, text: 't1 started (x) · sonnet/medium · new session: handover about 3.2k usage tokens (first turn, estimate); the old session\'s conversation is not resumed', data: { fresh: true } }

test('desk tick: restarts after 20 s idle with a notice naming size and cost; never earlier; once', async () => {
  const { h } = setup()
  await end(h)
  const calls: string[] = []
  const deps = { agents: rows(), restart: async (id: string, why: string) => (calls.push(`${id}|${why}`), ok) }
  h.clock.t = 1_000_000 + IDLE_MS - 1
  expect(await autoRestartTick(h.host, deps)).toEqual([])
  expect(calls).toHaveLength(0)
  h.clock.t = 1_000_000 + IDLE_MS
  const notes = await autoRestartTick(h.host, deps)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('t1|Its context was 205000 tokens (limit 120000)')
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toMatch(/^t1: context .* was over the limit .*: restarted as a new session by script/)
  expect(notes[0]!.text).toContain('handover about 3.2k usage tokens (first turn, estimate)')
  expect(marker(h)).toMatchObject({ last: { at: h.clock.t, oldSid: S1 } })
  expect(marker(h).pending).toBeUndefined()
  expect(await autoRestartTick(h.host, deps)).toEqual([])
  expect(calls).toHaveLength(1)
})

test('desk tick: a hard-stopped session the engine labels blocked (no open prompt) is restarted after the grace minutes (it counts as still working); one with an open prompt is left alone', async () => {
  const { h } = setup()
  await end(h)
  const calls: string[] = []
  const restart = async (id: string, why: string) => (calls.push(`${id}|${why}`), ok)
  h.clock.t = 1_000_000 + 3 * 60_000 // threads.stopGraceMinutes (default 3): the engine's `blocked` label reads as a session that is not idle
  const row = (waitingFor: string) => async () => [{ sid: S1, name: '', cwd: T1, status: 'idle', state: 'blocked', startedAt: 1, pid: 42, id: 'a', waitingFor }] as any
  expect(await autoRestartTick(h.host, { agents: row('permission prompt'), restart })).toEqual([])
  expect(calls).toHaveLength(0)
  const notes = await autoRestartTick(h.host, { agents: row(''), restart })
  expect(calls).toHaveLength(1)
  expect(notes).toHaveLength(1)
})

test('desk tick: never mid-turn, one per 10 minutes, stale checkpoints are dropped, failures are retried then reported', async () => {
  // a working session is left alone, the checkpoint stays
  const a = setup().h
  await end(a)
  a.clock.t = 1_100_000
  let n = 0
  expect(await autoRestartTick(a.host, { agents: rows('working'), restart: async () => (n++, ok) })).toEqual([])
  expect(n).toBe(0)
  expect(marker(a).pending).toBeTruthy()
  // a session waiting on a prompt for the user is not restarted either
  expect(await autoRestartTick(a.host, { agents: async () => [{ sid: S1, name: '', cwd: T1, status: 'idle', state: 'blocked', startedAt: 1, pid: 42, id: 'a', waitingFor: 'permission' }] as any, restart: async () => (n++, ok) })).toEqual([])
  expect(n).toBe(0)
  // a restart within 10 minutes of the last one waits
  const b = setup().h
  b.files.set(MARK, JSON.stringify({ last: { at: 1_000_000 - 1000, oldSid: S0 }, pending: { ts: 1_000_000, sid: S1, tokens: 205_000, limit: 120_000 } }))
  b.clock.t = 1_000_000 + MIN_GAP_MS - 2000
  expect(await autoRestartTick(b.host, { agents: rows(), restart: async () => (n++, ok) })).toEqual([])
  expect(n).toBe(0)
  b.clock.t = 1_000_000 - 1000 + MIN_GAP_MS
  expect(await autoRestartTick(b.host, { agents: rows(), restart: async () => (n++, ok) })).toHaveLength(1)
  // a later turn ended since (context record newer than the checkpoint): dropped
  const c = setup().h
  await end(c)
  c.files.set(`${T1}/context.json`, JSON.stringify({ tokens: 30_000, at: 1_100_000, sid: S1 }))
  c.clock.t = 1_200_000
  expect(await autoRestartTick(c.host, { agents: rows(), restart: async () => (n++, ok) })).toEqual([])
  expect(marker(c).pending).toBeUndefined()
  // a parked thread, or another session id: dropped
  const d = setup().h
  await end(d)
  d.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', state: 'parked', sid: S1 }))
  d.clock.t = 1_200_000
  await autoRestartTick(d.host, { agents: rows(), restart: async () => (n++, ok) })
  expect(marker(d).pending).toBeUndefined()
  expect(n).toBe(1)
  // a failing restart: retried at every timer tick, ONE notice (reason, offers restart) after five tries, never silently dropped
  const e = setup().h
  await end(e)
  let tries = 0
  const bad = { agents: rows(), restart: async () => (tries++, { ok: false, text: 't1 is running: no new session started (stop it from the Claude app first)' }) }
  e.clock.t = 1_100_000
  for (let k = 1; k < 5; k++) {
    expect(await autoRestartTick(e.host, bad)).toEqual([])
    expect(tries).toBe(k)
    expect(marker(e).pending).toBeTruthy()
    e.clock.t += 30_000
  }
  const last = await autoRestartTick(e.host, bad)
  expect(tries).toBe(5)
  expect(last).toHaveLength(1)
  expect(last[0]!.text).toContain('automatic restart failed 5 times')
  expect(last[0]!.text).toContain('no new session started')
  expect(last[0]!.text).toContain('Say "restart t1"')
  expect(marker(e).pending).toBeUndefined()
  expect(await autoRestartTick(e.host, bad)).toEqual([]) // one notice, no sixth try
  expect(tries).toBe(5)
})

test('leanThread auto-restart: a new session with the handover (the old one stopped), never over a working session', async () => {
  const { h, st } = setup()
  await end(h)
  const r = await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'Its context was 205000 tokens (limit 120000): checkpointed.' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 restarted at the context limit as a new session')
  expect(r.text).toContain('new session: handover about')
  const starts = h.claudeCalls().filter(x => x[0] === '--bg')
  expect(starts).toHaveLength(1)
  const prompt = starts[0]![starts[0]!.length - 1]!
  expect(prompt).toContain('Resume the work now')
  expect(prompt).toContain('Its context was 205000 tokens')
  expect(prompt).toContain('## State at the end of the last turn (state.json)') // the handover carries the snapshot
  expect(st.rows[0]!.pid).toBe(0)
  // a working session is not touched
  const w = setup({ row: { status: 'busy', state: 'working' } })
  const r2 = await leanThread(w.h.host, ROOT, { action: 'auto-restart', tN: 't1' })
  expect(r2.text).toContain('is running: no new session started')
  expect(w.h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(0)
  // a parked thread is refused
  const p = setup()
  p.h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', state: 'parked', sid: S1 }))
  expect((await leanThread(p.h.host, ROOT, { action: 'auto-restart', tN: 't1' })).ok).toBe(false)
})

test('over-limit thread whose session still shows working: after the grace minutes the timer stops it and starts a fresh session', async () => {
  const { h, st } = setup({ row: { status: 'busy', state: 'working' } })
  await end(h)
  const deps = { agents: async () => st.rows.map(r => ({ sid: r.sessionId, name: '', cwd: r.cwd, status: r.status, state: r.state, startedAt: 1, pid: r.pid, id: r.id, waitingFor: '' })) as any, restart: (id: string, why: string, force: boolean) => leanThread(h.host, ROOT, { action: 'auto-restart', tN: id, reason: why, force }) }
  h.clock.t = 1_000_000 + 60_000 // inside the grace: left alone
  expect(await autoRestartTick(h.host, deps)).toEqual([])
  expect(h.claudeCalls().filter(x => x[0] === '--bg' || x[0] === 'stop')).toHaveLength(0)
  h.clock.t = 1_000_000 + 3 * 60_000 // grace over: the same path as the manual restart
  const notes = await autoRestartTick(h.host, deps)
  expect(h.claudeCalls().filter(x => x[0] === 'stop')).toHaveLength(1)
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(1)
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toContain('restarted as a new session by script')
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).sid).toBe(NEW)
  // without force (a direct call) a working session is still left alone
  const w = setup({ row: { status: 'busy', state: 'working' } })
  expect((await leanThread(w.h.host, ROOT, { action: 'auto-restart', tN: 't1' })).text).toContain('is running: no new session started')
})

test('desk tick: two overlapping ticks restart once (a restart can outlast the timer), and a finished thread is never restarted', async () => {
  const { h } = setup()
  await end(h)
  h.clock.t = 1_000_000 + IDLE_MS
  let n = 0
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const deps = { agents: rows(), restart: async () => (n++, await gate, ok) }
  const first = autoRestartTick(h.host, deps)
  for (let i = 0; i < 20; i++) await Promise.resolve() // let the first tick reach its restart
  expect(await autoRestartTick(h.host, deps)).toEqual([]) // overlaps the first: does nothing
  release()
  expect(await first).toHaveLength(1)
  expect(n).toBe(1)
  // finished (done report, session stopped): the checkpoint is dropped, nothing restarts
  const f = setup().h
  await end(f)
  const tj = JSON.parse(f.files.get(`${T1}/thread.json`) as string)
  f.files.set(`${T1}/thread.json`, JSON.stringify({ ...tj, finished: 999 }))
  f.clock.t = 1_000_000 + IDLE_MS
  let m = 0
  expect(await autoRestartTick(f.host, { agents: rows(), restart: async () => (m++, ok) })).toEqual([])
  expect(m).toBe(0)
})

test('desk tick: a session that still shows as working is restarted threads.stopGraceMinutes (default 3) after the record; idle sessions after 20 s; no restart while it waits for the user', async () => {
  const a = setup().h
  await end(a)
  let n = 0
  const dep = (state: string) => ({ agents: rows(state), restart: async () => (n++, ok) })
  a.clock.t = 1_000_000 + 180_000 - 1
  expect(await autoRestartTick(a.host, dep('working'))).toEqual([])
  expect(n).toBe(0)
  a.clock.t = 1_000_000 + 180_000
  expect(await autoRestartTick(a.host, dep('working'))).toHaveLength(1) // the stop refuses its tool calls by then: nothing is lost
  expect(n).toBe(1)
  // the minutes are configurable, and a session waiting on a prompt is never restarted
  const b = setup({ config: { threads: { stopGraceMinutes: 1 } } }).h
  await end(b)
  expect(await stopGraceMs(b.host, '/h')).toBe(60_000)
  b.clock.t = 1_000_000 + 60_000
  expect(await autoRestartTick(b.host, { agents: async () => [{ sid: S1, name: '', cwd: T1, status: 'working', state: 'blocked', startedAt: 1, pid: 42, id: 'a', waitingFor: 'permission' }] as any, restart: async () => (n++, ok) })).toEqual([])
  expect(n).toBe(1)
  expect(await autoRestartTick(b.host, dep('working'))).toHaveLength(1)
})

test('desk tick: a session that keeps taking turns over the limit is still restarted (a later turn end over the limit does not drop the record)', async () => {
  const { h } = setup()
  await end(h, { tokens: 123_000 })
  h.files.set(`${T1}/context.json`, JSON.stringify({ tokens: 130_000, at: 1_100_000, sid: S1 }))
  h.clock.t = 1_200_000
  expect(await autoRestartTick(h.host, { agents: rows('working'), restart: async () => ok })).toHaveLength(1)
})

// ---- 1.0.22: a hard-stopped thread is always restarted (except after done); a message never queues behind a hard-stopped session ----
const QUESTION = 'Use postgres or sqlite for the cache?'
const promptOf = (h: any) => {
  const s = h.claudeCalls().filter((x: string[]) => x[0] === '--bg')
  return s.length ? (s[s.length - 1]![s[s.length - 1]!.length - 1] as string) : ''
}

test('stopped while waiting (last report blocked / a question): marker, restart by the tick, a prompt that names the open question, the question stays open', async () => {
  for (const last of [{ kind: 'ask', text: QUESTION, options: ['postgres', 'sqlite'] }, { kind: 'report', state: 'blocked', text: QUESTION }]) {
    const { h } = setup()
    h.files.set(INBOX, rec({ ts: 500, from: 't1', ...last }))
    expect((await end(h, { since: 400 })).action).toBe('none') // no second record: the question is the open one
    expect(marker(h).pending).toMatchObject({ sid: S1, tokens: 205_000 })
    expect(JSON.parse(h.files.get(`${T1}/contextstop.json`)!).waiting).toBe(true)
    expect(inbox(h)).toHaveLength(1)
    const deps = { agents: rows(), restart: (id: string, why: string, force: boolean) => leanThread(h.host, ROOT, { action: 'auto-restart', tN: id, reason: why, force }) }
    h.clock.t = 1_000_000 + IDLE_MS + 1
    expect(await autoRestartTick(h.host, deps)).toHaveLength(1)
    expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).sid).toBe(NEW)
    const p = promptOf(h)
    expect(p).toContain(`You were waiting for the desk's answer to 500-t1-${last.kind}: ${QUESTION}. The desk has it open.`)
    expect(p).toContain('write ONE report with state `waiting`')
    expect(p).not.toContain('do nothing')
    expect(p).not.toContain('Resume the work now')
    expect(inbox(h)).toHaveLength(2) // the open item is put back to the desk by script (same id), not dropped
    expect(inbox(h)[0]).toMatchObject({ ts: 500, from: 't1', text: QUESTION })
    expect(inbox(h)[1]).toMatchObject({ from: 't1', kind: 'ask', mod: true, requeued: `500-t1-${last.kind}`, since: 500 })
    expect(JSON.parse(h.files.get(`${T1}/waiting.json`)!)).toMatchObject({ since: 500, restarted: expect.any(Number) })
  }
})

test('stopped after done: no restart marker (its next message starts a fresh session, as before)', async () => {
  const { h } = setup()
  h.files.set(INBOX, rec({ ts: 500, from: 't1', kind: 'report', state: 'done', text: 'all done' }))
  expect((await end(h, { since: 400 })).action).toBe('none')
  expect(marker(h).pending).toBeUndefined()
  expect(JSON.parse(h.files.get(`${T1}/contextstop.json`)!).waiting).toBeUndefined()
  expect(await autoRestartTick(h.host, { agents: rows(), restart: async () => ok })).toEqual([])
})

test('send to a hard-stopped session that still shows working: a fresh session with the message at once, no queueing', async () => {
  const { h, st } = setup({ row: { status: 'busy', state: 'working' } })
  await end(h)
  const r = await leanThread(h.host, ROOT, { action: 'send', tN: 't1', text: 'sqlite, please' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 was at its context limit: started a new session with your message')
  expect(h.claudeCalls().filter(x => x[0] === 'stop')).toHaveLength(1)
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(1)
  expect(promptOf(h)).toContain('sqlite, please')
  expect(JSON.parse(h.files.get(`${T1}/thread.json`)!).sid).toBe(NEW)
  expect(st.rows[0]!.pid).toBe(0)
})

test('an approval result (a send from the desk) to a thread stopped while waiting: fresh session with the answer under the waiting prompt', async () => {
  const { h } = setup({ row: { status: 'busy', state: 'blocked' } })
  h.files.set(INBOX, rec({ ts: 500, from: 't1', kind: 'report', state: 'blocked', text: QUESTION, approval: 'git push origin fix-1' }))
  await end(h, { since: 400 })
  const r = await leanThread(h.host, ROOT, { action: 'send', tN: 't1', text: 'approved: push of abc1234 is allowed' })
  expect(r.text).toContain('was at its context limit: started a new session with your message')
  const p = promptOf(h)
  expect(p).toContain("waiting for the desk's answer to 500-t1-report")
  expect(p).toContain('approved: push of abc1234 is allowed')
})

test('a send to a session that is NOT hard-stopped still queues behind a working one', async () => {
  const { h } = setup({ row: { status: 'busy', state: 'working' } })
  const r = await leanThread(h.host, ROOT, { action: 'send', tN: 't1', text: 'hello' })
  expect(r.text).toContain('is running')
  expect(h.claudeCalls().filter(x => x[0] === '--bg')).toHaveLength(0)
})

test('pane word: a hard-stopped thread with a pending restart is "restarting" (amber); after a give-up or the restart it is not', async () => {
  const { h } = setup()
  await end(h)
  const t = JSON.parse(h.files.get(`${T1}/thread.json`)!)
  expect(await isRestarting(h.host, '/h', t)).toBe(true)
  expect(stateOf({ run: 'idle', restarting: true, needsYou: true, blocked: true } as any)).toEqual({ word: 'restarting', color: 'warning' })
  h.files.set(MARK, JSON.stringify({})) // the tick gave up (5 tries): the marker's pending is dropped
  expect(await isRestarting(h.host, '/h', t)).toBe(false)
  expect(stateOf({ run: 'idle', blocked: true } as any).color).toBe('error')
})
