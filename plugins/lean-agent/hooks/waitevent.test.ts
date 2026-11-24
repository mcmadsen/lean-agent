// A thread that WAITS for an external event (the desk's push result, an action result, an answer, a CI run) is not continued and not "stuck"; one that says it waits
// while nothing will wake it gets a reminder (1.0.31). Synthetic ids, names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { resetLocks, leanThread, listLine } from './threads'
import { resetActions } from './deskactions'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { threadTool, sweep } from './delivery'
import { announcedNext, continueTick, isConditional, noteTurnEnd, REMIND_MAX, REMIND_TEXT } from './continuepending'
import { waitingOn, waitText } from './waitevent'
import { homeDir } from './state'
import { reportText } from './threadask'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const HOUR = 3_600_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const TASKS = [{ content: 'TODO 1', status: 'completed' }, { content: 'TODO 2', status: 'pending' }]
// the user's second example (field report)
const WAIT_TEXT = 'Next step: once the desk reports the push, I request one batched ado-pr-reply with status fixed for threads 50824 and 50827-50833. Each reply will say what changed, and the migration and missing-test caveats go in where they apply. No new commits go on the branch before then.'
const READY = { ts: T0 - 5_000, from: 't1', kind: 'report', state: 'working', text: 'ready to push 1a2b3c4 (feature/x, Fix the thing)' }

function setup(o: { thread?: Record<string, unknown>; config?: unknown } = {}) {
  resetActivity()
  resetLocks()
  resetActions()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: S1, created: 1, lastWake: T0 - 3_600_000, delivered: 0, ...o.thread }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  h.files.set(`${L}/config.json`, JSON.stringify(o.config ?? { threads: { keepGoing: false } }))
  return h
}
const inbox = (h: any, ...recs: Record<string, unknown>[]) => h.files.set(`${L}/desk/inbox.jsonl`, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
const hist = (h: any, ...recs: Record<string, unknown>[]) => h.files.set(`${T1}/history.jsonl`, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
const end = (h: any, lastText: string | null, tasks: unknown = TASKS) => noteTurnEnd(h.host, 't1', { sid: S1, since: T0 - 60_000, lastText, tasks })
const tick = (h: any, sent: string[], rows: any[] = [row()]) => continueTick(h.host, { agents: async () => rows, send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })
const pend = (h: any) => JSON.parse(h.files.get(`${T1}/continue-pending.json`) ?? '{}')
const wait = async (h: any) => waitingOn(h.host, await homeDir(h.host), 't1')

test('W1 waitingOn: push (ready to push / approve-push newer than the desk\'s push record, 24 h), nothing when pushed or old', async () => {
  const h = setup()
  expect(await wait(h)).toBeNull()
  inbox(h, READY)
  expect(await wait(h)).toEqual({ kind: 'push', since: T0 - 5_000, text: 'waiting for push' })
  hist(h, { ts: T0 - 1_000, kind: 'push', sha: '1a2b3c4', ok: true })
  expect(await wait(h)).toBeNull() // the desk pushed
  hist(h, { ts: T0 - 1_000, kind: 'push', sha: '1a2b3c4', ok: true }, { ts: T0 - 500, kind: 'approve-push', sha: '1a2b3c4' })
  expect((await wait(h))?.kind).toBe('push') // approved again, not pushed yet
  const old = setup()
  old.clock.t = T0 + 25 * HOUR
  inbox(old, READY)
  expect(await wait(old)).toBeNull()
  const other = setup()
  inbox(other, { ...READY, from: 't2' })
  expect(await wait(other)).toBeNull()
})

test('W1 waitingOn: an action request (pending or approved, not sent), an open question, waiting.json, a CI record, a `waiting` report', { timeoutMs: 20_000 }, async () => {
  const a = setup()
  a.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'desk-sid-1' }))
  const reply = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
  await threadTool(a.host, 't1', 'lean_report', { state: 'working', text: 'need a reply sent', action: { kind: 'ado-pr-reply', params: reply, why: 'close it' } }, async () => ({ isDelivered: true }))
  expect((await wait(a))?.kind).toBe('action')
  expect((await wait(a))?.text).toBe('waiting for an action result')
  const w = setup()
  w.files.set(`${T1}/waiting.json`, JSON.stringify({ since: T0 - 2_000, text: 'which branch?' }))
  expect((await wait(w))?.kind).toBe('answer')
  w.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 + 10_000, kind: 'tool' })) // it did something since
  expect(await wait(w)).toBeNull()
  const q = setup()
  q.files.set(`${L}/questions.jsonl`, JSON.stringify({ ts: T0 - 2_000, from: 't1', question: 'which branch?', answered: false }) + '\n')
  expect((await wait(q))?.kind).toBe('answer')
  q.files.set(`${L}/answers.jsonl`, JSON.stringify({ q: 1, ts: T0 }) + '\n')
  expect(await wait(q)).toBeNull()
  const ci = setup()
  ci.files.set(`${T1}/ci-wait.json`, JSON.stringify({ since: T0 - 60_000, text: 'run 17' }))
  expect((await wait(ci))?.kind).toBe('ci')
  ci.clock.t = T0 + 41 * 60_000
  expect(await wait(ci)).toBeNull()
  const d = setup()
  inbox(d, { ts: T0 - 3_000, from: 't1', kind: 'report', state: 'waiting', text: 'waiting for the restart handover' })
  expect((await wait(d))?.kind).toBe('desk')
  expect(waitText('ci')).toBe('waiting for CI')
})

test('W1 the open-TODO rule and keep-going never fire for a thread that waits by record; the user\'s second example is not continued', async () => {
  const h = setup({ config: { threads: { keepGoing: true } } })
  inbox(h, READY)
  expect(await end(h, WAIT_TEXT)).toBe('none') // open TODO 2, keep-going on, and still: it waits for the push
  expect(await end(h, 'Going on with the next item.')).toBe('none')
  expect(pend(h)).toEqual({})
  // the same text, the push has happened: nothing waits, the conditional text gets the reminder (W3), not "do it now"
  hist(h, { ts: T0 - 1_000, kind: 'push', sha: '1a2b3c4', ok: true })
  expect(await end(h, WAIT_TEXT)).toBe('remind')
  // the timer re-checks: a record that appeared meanwhile cancels it
  const g = setup()
  await end(g, WAIT_TEXT)
  inbox(g, READY)
  g.clock.t = T0 + 30_000
  const sent: string[] = []
  await tick(g, sent)
  expect(sent).toEqual([])
  expect(pend(g)).toEqual({})
})

const CONDITIONAL = [
  WAIT_TEXT,
  'Once the desk reports the push, I will request the reply.',
  'After the push I request the batched reply.',
  'When CI is green I merge the PR.',
  'As soon as you answer I continue with the migration.',
  'I will wait until the review comes back.',
  'Waiting for the desk to push.',
  'Next: after the desk pushes, I open the PR.',
  'Once the pipeline passes I will tag the release.',
  "I'll wait for your approval before touching the branch.",
  'The follow-up depends on the result of the push.',
  "Pending the reviewer's answer, nothing else changes.",
  'If you approve, I send the reply.',
]
test('W2 a last paragraph that is conditional on an external event is not a stall announcement (the exact example and 12 more)', () => {
  for (const text of CONDITIONAL) {
    expect(isConditional(text), text).toBe(true)
    expect(announcedNext(text), text).toBeNull()
    expect(announcedNext(text.toLowerCase()), text).toBeNull()
  }
  // not conditional: an announcement of the thread's own step, and a conditional sentence that is not in the LAST paragraph
  expect(isConditional("I'm continuing with TODO 2 in the next step.")).toBe(false)
  expect(announcedNext('Waiting for CI.\n\nNext: run the suite')).toBe('run the suite')
})

test('W3 a conditional last text with nothing that wakes the thread: ONE reminder after the grace (not "do it now"), once per turn end, max 2 per thread, then ONE desk notice', async () => {
  const h = setup()
  const sent: string[] = []
  const notes: string[] = []
  for (let i = 0; i < 4; i++) {
    h.clock.t = T0 + i * 100_000
    expect(await noteTurnEnd(h.host, 't1', { sid: S1, since: h.clock.t - 60_000, lastText: WAIT_TEXT, tasks: TASKS })).toBe('remind')
    h.clock.t += 25_000
    notes.push(...(await tick(h, sent)).map(n => n.text))
    await tick(h, sent) // (a second tick of the same turn end sends nothing)
    h.files.set(`${T1}/activity.json`, JSON.stringify({ at: h.clock.t - 1_000, kind: 'message' })) // (a message, not a tool call: the reminders are not reset)
  }
  expect(sent).toEqual([`t1|${REMIND_TEXT}`, `t1|${REMIND_TEXT}`])
  expect(REMIND_MAX).toBe(2)
  expect(REMIND_TEXT).toBe("Nothing is pending that wakes you: if you wait for the push, request it with lean_report ('ready to push <sha>'); if you wait for the user, ask with lean_ask; otherwise do the step now.")
  expect(notes.filter(n => n.includes('nothing will deliver'))).toEqual(['t1 ends its turns waiting for something nothing will deliver (reminded 2 times): it needs a message from you'])
  expect(JSON.parse(h.files.get(`${T1}/continue-log.jsonl`)!.split('\n')[0]!).text).toBe('reminded by the mod: nothing is pending that wakes it')
  // threads.autoContinue false: no reminder
  expect(await end(setup({ config: { threads: { keepGoing: false, autoContinue: false } } }), WAIT_TEXT)).toBe('none')
})

test('W4 the awaited event reaches a thread that ended its turn: the desk\'s push result is a queued line the 10 s sweep wakes it with; an answer or an action result goes through send', async () => {
  const h = setup()
  const woke: string[] = []
  expect(await sweep(h.host, async id => void woke.push(id))).toEqual([])
  // the line push.ts writes (finish): text from the desk
  h.files.set(`${T1}/inbox.jsonl`, JSON.stringify({ ts: T0, text: 'the desk pushed 1a2b3c4 to origin/feature/x; no PR', from: 'desk' }) + '\n')
  expect(await sweep(h.host, async id => void woke.push(id))).toEqual(['t1'])
  expect(woke).toEqual(['t1'])
  // consumed: nothing more
  h.files.set(`${T1}/thread.json`, JSON.stringify({ ...JSON.parse(h.files.get(`${T1}/thread.json`)!), delivered: 1 }))
  expect(await sweep(h.host, async id => void woke.push(id))).toEqual([])
})

test('W5 the list says what a thread waits for instead of "idle, no report yet"', { timeoutMs: 20_000 }, async () => {
  expect(listLine({ id: 't1', state: 'open', live: 'idle', waitsFor: 'waiting for push' })).toContain('t1 waiting for push')
  expect(listLine({ id: 't1', state: 'open', live: 'idle' })).toContain('t1 idle')
  const h = setup()
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: S1, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42 }]) } : { exitCode: 0, stdout: '' })
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).not.toContain('waiting for')
  inbox(h, READY)
  const text = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(text).toContain('t1 waiting for push')
  expect((await leanThread(h.host, '/p', { action: 'list', verbose: true })).text).toContain('[open, waiting for push]')
  hist(h, { ts: T0 - 1_000, kind: 'push', sha: '1a2b3c4', ok: true })
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).not.toContain('waiting for push')
  // the thread's report summary (lean_thread ask) says it too
  inbox(h, READY)
  hist(h, { ts: 1, kind: 'x' })
  const sum = await reportText(h.host, await homeDir(h.host), 't1')
  expect(sum.text).toContain('t1 (fix login): open · waiting for push · last report working')
})
