// The checkpoint a thread makes itself (checkpoint.ts, 1.0.29): synthetic ids and names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { announcedNext, continueTick, noteTurnEnd } from './continuepending'
import { MIN_GAP_MS } from './autorestart'
import { warnLine } from './scratchnotes'
import { stopLine } from './contextstop'
import { announcesRestart, asksRestart, checkpointTick, requestCheckpoint, restartInstruction, savedText } from './checkpoint'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const json = (h: any, f: string) => JSON.parse(h.files.get(`${T1}/${f}`) ?? '{}')
const NEXT = 'run the parser specs for step 4, then open the draft PR'

function setup(o: { config?: unknown; files?: Record<string, string> } = {}) {
  resetActivity()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0 }))
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  for (const [k, v] of Object.entries(o.files ?? {})) h.files.set(k, v)
  return h
}
const ask = (h: any, o: Record<string, unknown> = {}) => requestCheckpoint(h.host, 't1', { sid: S1, next: NEXT, source: 'call', tokens: 104_000, ...o } as any)
const restarts = (calls: unknown[][], ok = true) => ({ agents: async () => [row()], restart: async (...a: unknown[]) => (calls.push(a), { ok, text: 'x', data: { fresh: ok } }) })

test('checkpoint with notes: marker, answer text, then the restart carries next as the last instruction and the desk gets one line', async () => {
  const h = setup({ files: { [`${T1}/scratch/notes.md`]: '## src/a.ts\nparser reads x' } })
  const r = await ask(h)
  expect(r).toEqual({ ok: true, text: savedText(NEXT) })
  expect(r.text).toBe(`checkpoint saved. End your turn now: you are restarted automatically and continue with: ${NEXT}`)
  expect(json(h, 'checkpoint.json')).toMatchObject({ reason: 'checkpoint', sid: S1, next: NEXT, tokens: 104_000, source: 'call', notes: true })
  expect(h.files.has(`${T1}/scratch/next.md`)).toBe(false) // the thread's own notes stand
  const calls: unknown[][] = []
  expect(await checkpointTick(h.host, restarts(calls))).toEqual([]) // not 10 s yet
  h.clock.t = T0 + 11_000
  const notes = await checkpointTick(h.host, restarts(calls))
  expect(calls.length).toBe(1)
  expect(calls[0]![0]).toBe('t1')
  expect(calls[0]![2]).toBe(false) // idle: no force
  expect(calls[0]![3]).toBe(restartInstruction(NEXT))
  expect(String(calls[0]![3]).endsWith(NEXT)).toBe(true)
  expect(notes).toEqual([{ id: 't1', text: 't1 restarted itself at 104k (checkpoint)' }])
  expect(json(h, 'checkpoint.json')).toEqual({})
  expect(json(h, 'autorestart.json').last).toMatchObject({ at: T0 + 11_000, oldSid: S1 })
})

test('checkpoint without notes (or notes older than the warn line) writes next.md itself; a working session is waited for until the grace', async () => {
  const h = setup()
  await ask(h)
  expect(h.files.get(`${T1}/scratch/next.md`)).toContain(`Next: ${NEXT}`)
  expect(json(h, 'checkpoint.json').notes).toBe(false)
  const h2 = setup({ files: { [`${T1}/scratch/notes.md`]: 'old notes', [`${T1}/warn-at.json`]: JSON.stringify({ sid: S1, at: T0 - 1000 }) } }) // (the fake host's mtime is 0: older than the warn line)
  await ask(h2)
  expect(h2.files.get(`${T1}/scratch/next.md`)).toContain(NEXT)
  const calls: unknown[][] = []
  h.clock.t = T0 + 30_000
  const dep = { agents: async () => [row({ state: 'working', status: 'busy' })], restart: async (...a: unknown[]) => (calls.push(a), { ok: true, text: 'x', data: { fresh: true } }) }
  await checkpointTick(h.host, dep as any)
  expect(calls.length).toBe(0) // still working inside the grace
  h.clock.t = T0 + 4 * 60_000
  await checkpointTick(h.host, dep as any)
  expect(calls.length).toBe(1)
  expect(calls[0]![2]).toBe(true) // forced
})

test('checkpoint loop guard: a fresh session that asks again within 10 minutes gets a notice, no marker; other sessions and empty next are refused', async () => {
  const h = setup({ files: { [`${T1}/autorestart.json`]: JSON.stringify({ last: { at: T0 - 5 * 60_000, oldSid: 'old' } }) } })
  const r = await ask(h)
  expect(r.ok).toBe(false)
  expect(r.text).toContain('restarted 5 min ago')
  expect(r.text).toContain('Never end your turn asking the desk or the user for a restart')
  expect(h.files.has(`${T1}/checkpoint.json`)).toBe(false)
  h.files.set(`${T1}/autorestart.json`, JSON.stringify({ last: { at: T0 - MIN_GAP_MS - 1, oldSid: 'old' } }))
  expect((await ask(h)).ok).toBe(true) // the guard is over
  expect((await ask(h, { sid: 'someone-else' })).ok).toBe(false)
  const h2 = setup()
  expect((await ask(h2, { next: '  ' })).text).toContain('give next')
  const h3 = setup({ config: { threads: { autoRestart: false } } })
  expect((await ask(h3)).text).toContain('automatic restarts are off')
})

test('a turn that announces a restart is a checkpoint restart, never "do the next step now" into the full session', async () => {
  const text = 'Notes written.\nNext: my context is near its cap, so a fresh session continues from scratch/notes.md. It starts step 4.5b-2 (the parser specs)'
  expect(announcedNext(text)).toContain('fresh session')
  const h = setup({ files: { [`${T1}/scratch/notes.md`]: 'notes' } })
  expect(await noteTurnEnd(h.host, 't1', { sid: S1, since: T0 - 60_000, lastText: text })).toBe('next')
  h.clock.t = T0 + 25_000
  const sent: string[] = []
  await continueTick(h.host, { agents: async () => [row()], send: async (id, t) => (sent.push(`${id}|${t}`), { ok: true, text: 'sent' }) })
  expect(sent).toEqual([]) // no "do the next step now"
  const cp = json(h, 'checkpoint.json')
  expect(cp).toMatchObject({ reason: 'checkpoint', source: 'announce', sid: S1 })
  expect(cp.next).toContain('fresh session continues from scratch/notes.md')
  expect(json(h, 'continue-pending.json')).toEqual({})
  // an ordinary step that mentions a restart of something else is still continued
  const h2 = setup()
  await noteTurnEnd(h2.host, 't1', { sid: S1, since: T0 - 60_000, lastText: 'Next: restart the dev server and re-run the login spec' })
  h2.clock.t = T0 + 25_000
  const sent2: string[] = []
  await continueTick(h2.host, { agents: async () => [row()], send: async (id, t) => (sent2.push(`${id}|${t}`), { ok: true, text: 'sent' }) })
  expect(sent2.length).toBe(1)
  expect(sent2[0]).toContain('Do the next step now: restart the dev server')
  expect(h2.files.has(`${T1}/checkpoint.json`)).toBe(false)
  // refused by the loop guard: the thread is told so (its context is near the cap: it keeps working)
  const h3 = setup({ files: { [`${T1}/autorestart.json`]: JSON.stringify({ last: { at: T0 - 60_000, oldSid: 'old' } }) } })
  await noteTurnEnd(h3.host, 't1', { sid: S1, since: T0 - 60_000, lastText: text })
  h3.clock.t = T0 + 25_000
  const sent3: string[] = []
  await continueTick(h3.host, { agents: async () => [row()], send: async (id, t) => (sent3.push(`${id}|${t}`), { ok: true, text: 'sent' }) })
  expect(sent3.length).toBe(1)
  expect(sent3[0]).toContain('checkpoint refused')
})

test('the phrases: a text asking for a fresh session / a restart of the thread, and a report asking the desk for one', () => {
  for (const s of ['please restart t85', 'Ask the desk to restart me', 'a fresh session continues from the notes', 'my context is near its cap', 'near the cap, the new session continues', 'I asked the desk for a restart', 'restart this thread please']) expect([s, asksRestart(s)]).toEqual([s, true])
  for (const s of ['restart the dev server', 'fixed the cap on the retry limit', 'all specs green']) expect([s, asksRestart(s)]).toEqual([s, false])
  for (const s of ['context limit reached soon', 'my context is near the cap', 'new session continues']) expect([s, announcesRestart(s)]).toEqual([s, true])
  expect(announcesRestart('restart the dev server')).toBe(false)
  expect(asksRestart(undefined)).toBe(false)
})

test('the warn line and the stop text point at the checkpoint call; the desk is told one thing', () => {
  expect(warnLine(104_000, 120_000)).toBe('ctx 104k of 120k: write what you learned to scratch/notes.md, then call lean_run checkpoint {next: <the next step>}: the mod restarts you at once and you continue with it. Never end your turn asking the desk or the user for a restart')
  expect(stopLine(121_000, 120_000)).toContain('lean_run checkpoint')
})
