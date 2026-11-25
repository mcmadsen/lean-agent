// A restarted session must start working (firstturn.ts, 1.0.35): the first-turn watch, the one kick, the alert, the shared nudge cap, and the restarted session's messages
// being consumed once the model answered. Synthetic ids and names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { FIRST_TURN_SECONDS, alertText, firstTurnSeconds, firstTurnTick, kickedText, markFirstSeen, noteFirstTurn, recFile, seenFile } from './firstturn'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'
import { messageRecs } from './msgstate'
import { sessionWords } from './deliver-to-thread'
import { markConsumed, takeBatch, resetHanded, wakeMark, wakeUpTo } from './delivery'

const S1 = '11111111-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const TEXT = 'Continue now with: run the parser specs'
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any

function world(o: { thread?: Record<string, unknown>; config?: unknown; files?: Record<string, string> } = {}) {
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0, delivered: 0, ...o.thread }))
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  for (const [k, v] of Object.entries(o.files ?? {})) h.files.set(k, v)
  const sent: { id: string; text: string }[] = []
  const deps = (rows: any[] = [row()], ok = true) => ({ agents: async () => rows, send: async (id: string, text: string) => (sent.push({ id, text }), { ok, text: 'sent' }) })
  return { h, sent, deps }
}
const after = (h: any, s: number) => void (h.clock.t += s * 1000)

test('config: threads.firstTurnSeconds defaults to 90; a junk or too small value is ignored', async () => {
  expect(FIRST_TURN_SECONDS).toBe(90)
  const w = world()
  expect(await firstTurnSeconds(w.h.host, '/h')).toBe(90)
  for (const [v, want] of [[30, 30], [5, 90], ['x', 90], [-1, 90], [120.7, 120]] as const) {
    w.h.files.set(`${L}/config.json`, JSON.stringify({ threads: { firstTurnSeconds: v } }))
    expect([v, await firstTurnSeconds(w.h.host, '/h')]).toEqual([v, want])
  }
})

test('a restarted session that shows no sign of work: nothing before 90 s, then ONE kick with its instruction, then ONE alert with the reason line; never a loop', async () => {
  const w = world({ files: { [`${T1}/turn-reason.json`]: JSON.stringify({ at: T0, sid: S1, run: 1, line: 'no model call, ended at once', steps: 0, calls: 0, denied: 0, usage: false, ms: 5 }) } })
  await noteFirstTurn(w.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  expect(JSON.parse(w.h.files.get(recFile('/h', 't1'))!)).toMatchObject({ sid: S1, text: TEXT, why: 'checkpoint', at: T0 })
  expect(await firstTurnTick(w.h.host, w.deps())).toEqual([])
  after(w.h, 89)
  expect(await firstTurnTick(w.h.host, w.deps())).toEqual([]) // not yet
  after(w.h, 2)
  const kick = await firstTurnTick(w.h.host, w.deps())
  expect(w.sent).toEqual([{ id: 't1', text: TEXT }]) // a real prompt with the same instruction
  expect(kick).toEqual([{ id: 't1', text: kickedText('t1', 90) }])
  expect(JSON.parse(w.h.files.get(`${T1}/continue-state.json`)!)).toMatchObject({ nudgeRun: 1, nudgeSid: S1 }) // the shared counter
  after(w.h, 60)
  expect(await firstTurnTick(w.h.host, w.deps())).toEqual([]) // the same time must pass again
  after(w.h, 31)
  const alert = await firstTurnTick(w.h.host, w.deps())
  expect(alert).toHaveLength(1)
  expect(alert[0]!.text).toBe(alertText('t1', 3, 'no model call, ended at once'))
  expect(alert[0]!.text).toContain('Restart it again from the pane')
  expect(alert[0]!.text).toContain('only as a last resort open t1 and type "continue"')
  expect(w.h.files.get(`${L}/notices/firstturn-t1.json`) ?? JSON.stringify([...w.h.files.keys()])).toContain('firstturn')
  after(w.h, 600)
  expect(await firstTurnTick(w.h.host, w.deps())).toEqual([]) // one kick, one alert
  expect(w.sent).toHaveLength(1)
})

test('a sign of work (a model answer or a tool call, written by the session) ends the watch at once; another session, a parked, a closed or a finished thread are dropped and never kicked', async () => {
  const a = world()
  await noteFirstTurn(a.h.host, 't1', { sid: S1, text: TEXT, why: 'limit' })
  await markFirstSeen(a.h.host, 't1', S1)
  expect(JSON.parse(a.h.files.get(seenFile('/h', 't1'))!)).toMatchObject({ sid: S1 })
  after(a.h, 500)
  expect(await firstTurnTick(a.h.host, a.deps())).toEqual([])
  expect(a.sent).toEqual([])
  expect(JSON.parse(a.h.files.get(recFile('/h', 't1'))!)).toEqual({}) // dropped
  for (const thread of [{ state: 'closed' }, { state: 'parked' }, { finished: 5 }, { sid: NEW }]) {
    const w = world({ thread })
    await noteFirstTurn(w.h.host, 't1', { sid: S1, text: TEXT, why: 'limit' })
    after(w.h, 500)
    expect([JSON.stringify(thread), await firstTurnTick(w.h.host, w.deps())]).toEqual([JSON.stringify(thread), []])
    expect(w.sent).toEqual([])
  }
  // the session's own id differs from the one the start printed (role.ts keeps it in sids): its sign counts when it is newer than the restart
  const b = world({ thread: { sids: ['own-id'] } })
  await noteFirstTurn(b.h.host, 't1', { sid: S1, text: TEXT, why: 'limit' })
  after(b.h, 10)
  await markFirstSeen(b.h.host, 't1', 'own-id')
  after(b.h, 500)
  expect(await firstTurnTick(b.h.host, b.deps())).toEqual([])
  expect(b.sent).toEqual([])
})

test('a blocked session is kicked (it is not working); a session that works gets three times the time; an open prompt, a gone session and a failed listing are left alone', async () => {
  const blocked = world()
  await noteFirstTurn(blocked.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  after(blocked.h, 91)
  expect((await firstTurnTick(blocked.h.host, blocked.deps([row({ state: 'blocked' })]))).map(n => n.text)).toEqual([kickedText('t1', 90)])
  const working = world()
  await noteFirstTurn(working.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  after(working.h, 200)
  expect(await firstTurnTick(working.h.host, working.deps([row({ state: 'working', status: 'busy' })]))).toEqual([])
  after(working.h, 80)
  expect(await firstTurnTick(working.h.host, working.deps([row({ state: 'working', status: 'busy' })]))).toHaveLength(1)
  for (const rows of [[row({ waitingFor: 'a permission prompt' })], [], null]) {
    const w = world()
    await noteFirstTurn(w.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
    after(w.h, 500)
    expect(await firstTurnTick(w.h.host, { agents: async () => rows as any, send: w.deps().send })).toEqual([])
    expect(w.sent).toEqual([])
  }
})

test('the kick shares the nudge cap of 1.0.33: at 2 nudges since the last tool call there is no kick, only the alert after the same time; threads.firstTurnSeconds moves the time', async () => {
  const w = world({ config: { threads: { firstTurnSeconds: 30 } }, files: { [`${T1}/continue-state.json`]: JSON.stringify({ nudgeRun: 2, nudgeSid: S1 }) } })
  await noteFirstTurn(w.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  after(w.h, 31)
  expect(await firstTurnTick(w.h.host, w.deps())).toEqual([]) // the cap is used: no kick
  expect(w.sent).toEqual([])
  after(w.h, 31)
  const alert = await firstTurnTick(w.h.host, w.deps())
  expect(alert).toHaveLength(1)
  expect(alert[0]!.text).toContain('t1 did not start working after its restart')
  expect(alert[0]!.text).toContain('no turn record: the session made no model request') // no reason line recorded
  // the counter of ANOTHER session does not count
  const x = world({ files: { [`${T1}/continue-state.json`]: JSON.stringify({ nudgeRun: 2, nudgeSid: 'older-session' }) } })
  await noteFirstTurn(x.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  after(x.h, 91)
  expect(await firstTurnTick(x.h.host, x.deps())).toHaveLength(1)
  expect(x.sent).toHaveLength(1)
  // a kick that could not be sent says nothing and is not counted
  const f = world()
  await noteFirstTurn(f.h.host, 't1', { sid: S1, text: TEXT, why: 'checkpoint' })
  after(f.h, 91)
  expect(await firstTurnTick(f.h.host, f.deps([row()], false))).toEqual([])
  expect(f.h.files.get(`${T1}/continue-state.json`)).toBeUndefined()
})

test('through the engine: the thread session\'s first tool call writes the sign the desk watches for; a message sent to a blocked session does not say "running"', { timeoutMs: 20_000 }, async ($, on) => {
  resetLocks()
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {}))
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('clock.every', (() => ({ value: { cancel() {} } })) as any)
  on('session.cwd', () => ({ value: T1 }))
  on('session.root', () => ({ value: T1 }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.usage', () => ({ value: { context: { tokens: 10_000, window: 200_000, percent: 5 }, rateLimits: [] } }) as any)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ran' }) as any)
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  expect(h.files.get(seenFile('/h', 't1'))).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: `${T1}/brief.md`, limit: 10 } as any)
  expect(JSON.parse(h.files.get(seenFile('/h', 't1'))!)).toMatchObject({ sid: 'sess-x' })
  // (what the desk says of a session that is not running)
  expect(sessionWords(row({ state: 'blocked' }))).toBe('sent to its session, which is blocked, not running: it may not start a turn for it')
  expect(sessionWords(row({ state: 'idle' }))).toBe('delivered straight to its running session (idle)')
  expect(sessionWords(row({ state: 'working' }))).toBe('delivered straight to its running session (working)')
  expect(sessionWords(row({ state: '' }))).toBe('delivered straight to its running session (alive)')
})

// ---- the restart that starts the watch, and the messages the restarted session carries ----
const ROOT = '/p'
function restartWorld(msgs: string[]) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  resetHanded()
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${T1}/inbox.jsonl`, msgs.map((text, i) => JSON.stringify({ ts: 900_000 + i, from: 'desk', text }) + '\n').join(''))
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } }))
  const st = { rows: [{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  return h
}

test('a checkpoint / limit / stall restart starts the first-turn watch with its instruction (the continue text, or the task); another restart does not', async () => {
  const h = restartWorld([])
  const r = await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'Checkpoint at 85k.', text: TEXT })
  expect(r.text).toContain('restarted')
  expect(JSON.parse(h.files.get(recFile('/h', 't1'))!)).toMatchObject({ sid: NEW, text: TEXT, why: 'checkpoint' })
  const h2 = restartWorld([])
  await leanThread(h2.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'Its context was over the limit.' })
  expect(JSON.parse(h2.files.get(recFile('/h', 't1'))!)).toMatchObject({ sid: NEW, text: 'Continue with the task from your handover now.', why: 'limit' })
  const h3 = restartWorld([])
  await leanThread(h3.host, ROOT, { action: 'stall-restart', tN: 't1', reason: 'stalled', force: true })
  expect(JSON.parse(h3.files.get(recFile('/h', 't1'))!)).toMatchObject({ why: 'stall' })
  const h4 = restartWorld([])
  await leanThread(h4.host, ROOT, { action: 'restart', tN: 't1' }) // the user's own restart: the user is there to see it
  expect(h4.files.get(recFile('/h', 't1'))).toBeUndefined()
})

test('3 queued messages + a restart: all three are consumed after the first model request that carried them (the handover prompt carries the position mark)', async () => {
  const h = restartWorld(['one', 'two', 'three'])
  const r = await leanThread(h.host, ROOT, { action: 'auto-restart', tN: 't1', reason: 'Checkpoint at 85k.', text: TEXT })
  expect(r.ok).toBe(true)
  const starts = h.claudeCalls().filter(x => x[0] === '--bg')
  const prompt = starts[0]![starts[0]!.length - 1]!
  expect(prompt).toContain('one')
  expect(prompt).toContain(TEXT)
  expect(wakeUpTo(prompt)).toBe(4) // three queued + the continue text: positions 1..4
  const states = async () => (await messageRecs(h.host, '/h', 't1')).map(m => m.state)
  expect(await states()).toEqual(['delivered', 'delivered', 'delivered', 'delivered']) // handed over, not read back yet
  // what the new session's mod does: the prompt arrives (wakeAt = 4), the model answers the first request (takeWake -> markConsumed)
  await markConsumed(h.host, '/h', 't1', wakeUpTo(prompt)!)
  expect(await states()).toEqual(['consumed', 'consumed', 'consumed', 'consumed'])
})

test('messages queued while the session works are handed over at a tool call but consumed only after the model answered the request that carried them', async () => {
  const h = restartWorld(['one', 'two'])
  const wake: number[] = []
  const first = await takeBatch(h.host, 't1', { defer: n => void wake.push(n) })
  expect(first).toContain('message from desk: one')
  expect(first).toContain('message from desk: two')
  expect(wake).toEqual([2])
  expect((await messageRecs(h.host, '/h', 't1')).map(m => m.state)).toEqual(['queued', 'queued']) // not consumed by being handed out
  expect(await takeBatch(h.host, 't1', { defer: n => void wake.push(n) })).toBeNull() // handed out once
  h.files.set(`${T1}/inbox.jsonl`, (h.files.get(`${T1}/inbox.jsonl`) ?? '') + JSON.stringify({ ts: 950_000, from: 'desk', text: 'three' }) + '\n')
  const next = await takeBatch(h.host, 't1', { defer: n => void wake.push(n) })
  expect(next).toContain('three')
  expect(next).not.toContain('one')
  expect(wake).toEqual([2, 3])
  await markConsumed(h.host, '/h', 't1', 3) // the model answered the request that carried them
  expect((await messageRecs(h.host, '/h', 't1')).map(m => m.state)).toEqual(['consumed', 'consumed', 'consumed'])
  expect(wakeMark(4)).toBe('<!-- lean:n=4 -->')
})
