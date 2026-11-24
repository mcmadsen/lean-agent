// A turn that ends with "next:" continues by script; the keep-going standing order (continuepending.ts, nextwords.ts): synthetic ids and names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { peekNotice } from './notices'
import { announcedNext, continueTick, noteTurnEnd } from './continuepending'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const pend = (h: any) => JSON.parse(h.files.get(`${T1}/continue-pending.json`) ?? '{}')
const cstate = (h: any) => JSON.parse(h.files.get(`${T1}/continue-state.json`) ?? '{}')

function setup(o: { thread?: Record<string, unknown>; config?: unknown } = {}) {
  resetActivity()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0, ...o.thread }))
  h.files.set(`${L}/config.json`, JSON.stringify(o.config ?? { threads: { keepGoing: false } })) // (keep-going is on by default since 1.0.31: these specs are about "next:")
  return h
}
const end = (h: any, lastText: string | null, since = T0 - 60_000) => noteTurnEnd(h.host, 't1', { sid: S1, since, lastText })
const tick = (h: any, sent: string[], rows: any[] = [row()], ok = true) => continueTick(h.host, { agents: async () => rows, send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok, text: 'sent' }) })

test('announcedNext: the last line or sentence announces a next action; questions and earlier lines do not', () => {
  expect(announcedNext('Report written.\nNext: run the full suite')).toBe('run the full suite')
  expect(announcedNext('All green.\n**Next step:** open the draft PR.')).toBe('open the draft PR')
  expect(announcedNext('Fixed the parser. I will now run the build.')).toBe('run the build')
  expect(announcedNext('Done with part one. Now I\'ll fix the lint errors!')).toBe('fix the lint errors')
  expect(announcedNext('Tests pass. Then I will ship it.')).toBe('ship it')
  expect(announcedNext('Going to split the module')).toBe('split the module')
  expect(announcedNext('Next: run the suite\nand that is all')).toBeNull() // not the last line
  expect(announcedNext('Next: run the suite?')).toBeNull() // a question
  expect(announcedNext('Which one? Next: tests')).toBe('tests')
  expect(announcedNext('All done, nothing left.')).toBeNull()
  expect(announcedNext(42)).toBeNull()
  expect((announcedNext(`next: ${'x'.repeat(500)}`) ?? '').length).toBe(200)
})

test('a turn end that announces a next action records continue-pending; every other turn end clears it', async () => {
  const h = setup()
  expect(await end(h, 'Report.\nNext: wire the timer')).toBe('next')
  expect(pend(h)).toEqual({ at: T0, sid: S1, kind: 'next', text: 'wire the timer' })
  expect(await end(h, 'Report.\nAll finished.')).toBe('none')
  expect(pend(h)).toEqual({})
  expect(await end(h, null)).toBe('none') // no text (a tool call came last, or unknown)
})

test('no record for a done, blocked or asking thread, a hard stop, an open question, a parked or finished thread, or threads.autoContinue false', async () => {
  const text = 'Next: run the suite'
  const inbox = (h: any, r: Record<string, unknown>) => h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: T0 - 1000, from: 't1', kind: 'report', text: 'x', ...r }) + '\n')
  for (const r of [{ state: 'done' }, { state: 'blocked' }, { kind: 'ask' }]) {
    const h = setup()
    inbox(h, r)
    expect(await end(h, text)).toBe('none')
  }
  let h = setup()
  h.files.set(`${T1}/contextstop.json`, JSON.stringify({ sid: S1, at: T0, tokens: 130_000, limit: 120_000, notices: 0, pending: [] }))
  expect(await end(h, text)).toBe('none')
  h = setup()
  h.files.set(`${T1}/waiting.json`, JSON.stringify({ since: T0 - 2000, text: 'which branch?' }))
  expect(await end(h, text)).toBe('none')
  expect(await end(setup({ thread: { state: 'parked' } }), text)).toBe('none')
  expect(await end(setup({ thread: { finished: T0 - 5 } }), text)).toBe('none')
  expect(await end(setup({ config: { threads: { autoContinue: false, keepGoing: false } } }), text)).toBe('none')
})

test('the desk timer delivers the continue after threads.continueSeconds, and only if nothing newer happened', async () => {
  const h = setup()
  await end(h, 'Next: wire the timer')
  const sent: string[] = []
  h.clock.t = T0 + 19_000
  await tick(h, sent)
  expect(sent).toEqual([])
  h.clock.t = T0 + 21_000
  await tick(h, sent)
  expect(sent).toEqual(['t1|Do the next step now: wire the timer. Do not report again before you have made progress.'])
  expect(pend(h)).toEqual({})
  expect(cstate(h)).toMatchObject({ consec: 1, sentAt: T0 + 21_000 })
  // a tool call after the record: not stalled, no continue
  const g = setup()
  await end(g, 'Next: wire the timer')
  g.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 + 5_000, kind: 'tool' }))
  g.clock.t = T0 + 30_000
  const s2: string[] = []
  await tick(g, s2)
  expect(s2).toEqual([])
  expect(pend(g)).toEqual({})
  // config threads.continueSeconds
  const c = setup({ config: { threads: { continueSeconds: 60, keepGoing: false } } })
  await end(c, 'Next: wire the timer')
  c.clock.t = T0 + 30_000
  const s3: string[] = []
  await tick(c, s3)
  expect(s3).toEqual([])
  c.clock.t = T0 + 61_000
  await tick(c, s3)
  expect(s3).toHaveLength(1)
})

test('at most 3 continues in a row without a tool call: then ONE notice and the halted state; a tool call lifts it', async () => {
  const h = setup()
  const sent: string[] = []
  const notes: string[] = []
  for (let i = 0; i < 5; i++) {
    h.clock.t = T0 + i * 100_000
    await end(h, 'Next: step ' + i)
    h.clock.t += 25_000
    notes.push(...(await tick(h, sent)).map(n => n.text))
  }
  expect(sent).toHaveLength(3)
  expect(notes).toEqual(["t1 keeps stopping after 'next:'"]) // once
  expect(cstate(h).halted).toBeGreaterThan(0)
  expect(await peekNotice(h.host, 'continue-t1')).toBe("t1 keeps stopping after 'next:'")
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: h.clock.t + 1_000, kind: 'tool' }))
  h.clock.t += 5_000
  await tick(h, sent)
  expect(cstate(h).halted).toBeUndefined()
  expect(cstate(h).consec).toBe(0)
})

test('keep-going: every plain turn end is continued ("Continue with the next step of your task."), a question is not, 30 per hour then ONE notice', async () => {
  const h = setup({ thread: { keepGoing: true } })
  expect(await end(h, 'Finished the module.')).toBe('keep')
  expect(await end(h, 'Which branch do you want?')).toBe('none')
  expect(await end(h, 'Finished the module.\nNext: tests')).toBe('next') // an announcement wins: its text is sent
  expect(await end(h, 'Finished the module.')).toBe('keep')
  const sent: string[] = []
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent).toEqual(['t1|Continue with the next step of your task.'])
  // 30 an hour
  const notes: string[] = []
  for (let i = 0; i < 32; i++) {
    h.clock.t += 30_000
    await end(h, 'ok')
    h.clock.t += 25_000
    notes.push(...(await tick(h, sent)).map(n => n.text))
  }
  expect(sent).toHaveLength(30)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('t1 (keep-going) was continued 30 times in the last hour')
  // switched off: the record is dropped
  const g = setup({ thread: { keepGoing: true } })
  await end(g, 'ok')
  const t = JSON.parse(g.files.get(`${T1}/thread.json`)!)
  t.keepGoing = false // `keep-going off` stores an explicit off (the default is on)
  g.files.set(`${T1}/thread.json`, JSON.stringify(t))
  g.clock.t = T0 + 25_000
  const s2: string[] = []
  await tick(g, s2)
  expect(s2).toEqual([])
})

test('the timer re-checks when it acts: parked, closed, another session, working, a prompt open, no listing', async () => {
  const mk = async (thread: Record<string, unknown> = {}) => {
    const h = setup()
    await end(h, 'Next: go on')
    h.files.set(`${T1}/thread.json`, JSON.stringify({ ...JSON.parse(h.files.get(`${T1}/thread.json`)!), ...thread }))
    h.clock.t = T0 + 30_000
    return h
  }
  for (const th of [{ state: 'parked' }, { state: 'closed' }, { sid: 'other' }, { finished: 5 }]) {
    const h = await mk(th)
    const sent: string[] = []
    await tick(h, sent)
    expect(sent).toEqual([])
    expect(pend(h)).toEqual({}) // dropped
  }
  for (const r of [row({ status: 'busy', state: 'working' }), row({ waitingFor: 'permission' })]) {
    const h = await mk()
    const sent: string[] = []
    await tick(h, sent, [r])
    expect(sent).toEqual([])
    expect(pend(h).kind).toBe('next') // re-checked
  }
  const h = await mk()
  const sent: string[] = []
  expect(await continueTick(h.host, { agents: async () => null, send: async () => (sent.push('x'), { ok: true, text: '' }) })).toEqual([])
  expect(sent).toEqual([])
  expect(pend(h).kind).toBe('next')
})
