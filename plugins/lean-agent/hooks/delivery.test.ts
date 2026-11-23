import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { ASK_MAX, DIRECT_MAX, RELAY_GAP_MS, consumeWake, directLine, markDelivered, markRead, recordDeskSid, relayReports, renderReports, sweep, takeBatch, takeReports, threadTool, THREAD_TOOLS, unreadReports } from './delivery'
import { leanThread, resetLocks } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const T = '/h/.lean-agent/threads/t1'

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk')
  const state = { rows: [] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  return { h, state, call: (i: any) => leanThread(h.host, '/p', i) }
}
const running = (state: any) => (state.rows = [{ sessionId: SID, name: 't1 · a', cwd: T, status: 'busy', startedAt: 1 }])

test('a queued message is delivered exactly once to a busy thread', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  running(state)
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'also b' })
  const first = await takeBatch(h.host, 't1')
  expect(first).toContain('also b')
  expect(first).toContain('message from the desk')
  expect(await takeBatch(h.host, 't1')).toBeNull()
  await call({ action: 'send', tN: 't1', text: 'and c' })
  const second = await takeBatch(h.host, 't1')
  expect(second).toContain('and c')
  expect(second).not.toContain('also b')
})

test('a wake prompt carries its inbox mark: the prompt hook consumes it, the tool hook adds nothing', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: T, status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'wake me' })
  const argv = h.claudeCalls().find(a => a.includes('--resume'))!
  const prompt = argv[argv.length - 1]!
  expect(prompt).toContain('wake me')
  expect(await consumeWake(h.host, 't1', prompt)).toBe(true)
  expect(await takeBatch(h.host, 't1')).toBeNull()
  expect(await consumeWake(h.host, 't1', 'plain prompt')).toBe(false)
})

test('a message after the last tool call is delivered by the sweep, once', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  running(state)
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'late' }) // queued: running
  state.rows[0].status = 'idle' // the turn ended without reading it
  const woken: string[] = []
  expect(await sweep(h.host, async id => { woken.push(id); await call({ action: 'wake', tN: id }) })).toEqual(['t1'])
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(1)
  // the batch is now delivered: a second sweep finds nothing
  expect(await sweep(h.host, async id => woken.push(id))).toEqual([])
})

test('lean_report, lean_ask, lean_goal and lean_remember write; the desk reads each report once', async () => {
  const { h } = setup()
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'done with x', state: 'done' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_ask', { question: 'which db?', options: ['a', 'b'] })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_goal', { update: 'ship login' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_remember', { text: 'uses pnpm' })).ok).toBe(true)
  expect((await threadTool(h.host, 't1', 'lean_report', {})).ok).toBe(false)
  expect(JSON.parse(h.files.get('/h/.lean-agent/goals.json')!).t1.text).toBe('ship login')
  expect(h.files.get('/h/.lean-agent/questions.jsonl')).toContain('which db?')
  expect((await unreadReports(h.host)).recs.length).toBe(2)
  const text = await takeReports(h.host)
  expect(text).toContain('report from t1 (done): done with x')
  expect(text).toContain('question from t1')
  expect(text).toContain('a | b')
  expect(await takeReports(h.host)).toBeNull()
})

test('a delivered done report carries the close hint; progress, blocked and questions do not', () => {
  const t = renderReports([
    { ts: 1, from: 't1', kind: 'report', text: 'all merged', state: 'done' },
    { ts: 2, from: 't2', kind: 'report', text: 'halfway', state: 'working' },
    { ts: 3, from: 't3', kind: 'report', text: 'stuck', state: 'blocked' },
    { ts: 4, from: 't4', kind: 'ask', text: 'which db?' },
  ])
  expect(t).toContain('report from t1 (done): all merged (close t1 when nothing is left)')
  expect(t.match(/close t\d when nothing is left/g)).toHaveLength(1)
})

test('relay: one desk turn for a question or a done/blocked report; never for progress, never while busy, debounced, undone when refused', async () => {
  const { h } = setup()
  const sent: string[] = []
  const submit = async (t: string) => void sent.push(t)
  const relay = (o: { busy?: boolean; last?: number; submit?: (t: string) => Promise<unknown> } = {}) => relayReports(h.host, { busy: false, last: 0, submit, ...o })
  expect(await relay()).toBe(false) // nothing unread
  await threadTool(h.host, 't1', 'lean_report', { text: 'step 1 of 3', state: 'working' })
  expect(await relay()).toBe(false) // progress alone never starts a turn
  expect((await unreadReports(h.host)).recs).toHaveLength(1) // and it stays unread for the user's next message
  await threadTool(h.host, 't2', 'lean_ask', { question: 'which db?', options: ['a', 'b'] })
  expect(await relay({ busy: true })).toBe(false) // never over a running turn
  expect(await relay({ last: h.clock.t - RELAY_GAP_MS + 1 })).toBe(false) // debounced
  expect(sent).toEqual([])
  expect(await relay()).toBe(true)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('question from t2: which db? [options: a | b]')
  expect(sent[0]).toContain('report from t1 (working): step 1 of 3') // the progress rides along with the turn
  expect(await takeReports(h.host)).toBeNull() // marked read: the next prompt does not repeat them
  // done and blocked count too
  await threadTool(h.host, 't1', 'lean_report', { text: 'merged', state: 'done' })
  expect(await relay()).toBe(true)
  expect(sent[1]).toContain('(close t1 when nothing is left)')
  await threadTool(h.host, 't3', 'lean_report', { text: 'need creds', state: 'blocked' })
  expect(await relay()).toBe(true)
  // a refused submit puts the reports back
  await threadTool(h.host, 't1', 'lean_report', { text: 'again', state: 'done' })
  expect(await relay({ submit: () => Promise.reject(new Error('no')) })).toBe(true)
  for (let n = 0; n < 30; n++) await Promise.resolve() // the refused submit is undone in the background
  expect((await unreadReports(h.host)).recs.map(r => r.text)).toEqual(['again'])
  await takeReports(h.host) // 'again' (rewound above) is delivered
  // a refusal after the user's next prompt already took newer reports rewinds nothing (no repeats)
  await threadTool(h.host, 't1', 'lean_report', { text: 'mid', state: 'done' })
  let fail: (e: Error) => void = () => {}
  expect(await relay({ submit: () => new Promise((_, rej) => (fail = rej)) })).toBe(true)
  await threadTool(h.host, 't1', 'lean_report', { text: 'newer', state: 'working' })
  expect(await takeReports(h.host)).toContain('newer') // the user's prompt took it
  fail(new Error('no'))
  for (let n = 0; n < 30; n++) await Promise.resolve()
  expect(await takeReports(h.host)).toContain('mid') // handed over once more with the next delivery, not lost
  expect(await takeReports(h.host)).toBeNull()
})

test('a done report without handover fields gets a one-line reminder; a complete one and progress reports do not', async () => {
  const { h } = setup()
  const bare = await threadTool(h.host, 't1', 'lean_report', { text: 'all done, tests pass', state: 'done' })
  expect(bare.text).toContain('Reminder')
  for (const w of ['the branch', 'the worktree path', 'the last commit', 'pushed or not', 'the open items', 'the next step']) expect(bare.text).toContain(w)
  const full = await threadTool(h.host, 't1', 'lean_report', { text: 'branch fix-x in /h/.lean-agent/worktrees/app/fix-x, last commit abc1234, not pushed; open items: none; next: open the PR', state: 'done' })
  expect(full.text).not.toContain('Reminder')
  expect(full.text).toMatch(/^reported to the desk\./) // (a done report also says the session is over, see below)
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'halfway', state: 'working' })).text).toBe('reported to the desk')
  expect((await unreadReports(h.host)).recs).toHaveLength(3) // the report is written either way
})

test('direct send to the desk: done / blocked / questions (and important progress) go out with a row key; the inbox keeps every row; failures fall back and say so', async () => {
  const { h } = setup()
  const sent: { sid: string; text: string }[] = []
  const send = async (sid: string, text: string) => void sent.push({ sid, text })
  const tool = (name: string, i: any, s: any = send) => threadTool(h.host, 't1', name, i, s)
  // no desk session id known yet: inbox only, and the result says so
  const none = await tool('lean_report', { text: 'branch b, commit abc1234, pushed; open items none; next: pr', state: 'done' })
  expect(none.text).toContain('desk session id is not known')
  expect(sent).toEqual([])
  await recordDeskSid(h.host, 'desk-sid-1')
  expect(JSON.parse(h.files.get('/h/.lean-agent/desk.json')!).sid).toBe('desk-sid-1')
  const done = await tool('lean_report', { text: 'branch b, commit abc1234, pushed; open items none; next: pr', state: 'done' })
  expect(done.text).toContain('reported to the desk (also sent to the desk)')
  expect(sent[0]!.sid).toBe('desk-sid-1')
  expect(sent[0]!.text).toMatch(/^\[lean-agent\] t1 done: branch b, commit abc1234.* \(close t1 when nothing is left\) <!-- lean:r=\d+:t1:report -->$/)
  expect(sent[0]!.text).not.toContain('\n') // one compact line
  await tool('lean_report', { text: 'stuck on creds', state: 'blocked' })
  await tool('lean_ask', { question: 'which db?', options: ['a', 'b'] })
  expect(sent.map(s => /t1 (\w+):/.exec(s.text)![1])).toEqual(['done', 'blocked', 'asking'])
  expect(sent[2]!.text).toContain('[options: a | b]')
  const n = sent.length
  await tool('lean_report', { text: 'step 2 of 5', state: 'working' }) // progress alone is not sent
  expect(sent).toHaveLength(n)
  await tool('lean_report', { text: 'big finding', state: 'working', important: true })
  expect(sent).toHaveLength(n + 1)
  expect(await readJsonl<any>(h.host, '/h/.lean-agent/desk/inbox.jsonl')).toHaveLength(6) // the inbox has every one regardless
  // a refused or throwing send: the inbox alone
  const refused = await tool('lean_report', { text: 'x', state: 'blocked' }, async () => ({ isDelivered: false, reason: 'nobody by that name' }))
  expect(refused.ok && refused.text).toContain('refused: nobody by that name')
  const thrown = await tool('lean_ask', { question: 'y?' }, async () => { throw new Error('no socket') })
  expect(thrown.ok).toBe(true)
  expect(thrown.text).toContain('no socket')
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'z', state: 'done' })).text).not.toContain('sent') // no send function: today's behaviour
})

test('after a desk restart the refused send looks up the desk\'s live session, keeps that id for every thread and sends again; no live desk = the refusal stands', async () => {
  const { h, state } = setup()
  const OLD = 'aaaaaaaa-0000-0000-0000-000000000001'
  const NEW = 'bbbbbbbb-0000-0000-0000-000000000002'
  await recordDeskSid(h.host, OLD)
  const sent: string[] = []
  // the engine refuses the dead id and takes the live one
  const send = async (sid: string, _t: string) => {
    sent.push(sid)
    return sid === OLD ? { isDelivered: false, reason: `no live session on this machine has id ${OLD}` } : { isDelivered: true }
  }
  // a listing without a desk session (only a thread, and an ended old desk): nothing to find, the refusal stands
  state.rows = [{ sessionId: SID, cwd: T, status: 'busy', startedAt: 1 }, { sessionId: OLD, cwd: '/h/lean-agent-desk', status: 'stopped', startedAt: 1 }]
  const gone = await threadTool(h.host, 't1', 'lean_report', { text: 'done!', state: 'done' }, send)
  expect(gone.text).toContain(`refused: no live session on this machine has id ${OLD}`)
  expect(sent).toEqual([OLD]) // (one retry only when a different live id was found)
  expect(JSON.parse(h.files.get('/h/.lean-agent/desk.json')!).sid).toBe(OLD)
  // the restarted desk is listed (two desk sessions listed: the newer one wins)
  sent.length = 0
  state.rows = [{ sessionId: SID, cwd: T, status: 'busy', startedAt: 1 }, { sessionId: 'cccccccc-0000-0000-0000-000000000003', cwd: '/h/lean-agent-desk', status: 'idle', startedAt: 5 }, { sessionId: NEW, cwd: '/h/lean-agent-desk/', status: 'busy', startedAt: 9 }]
  const ok = await threadTool(h.host, 't1', 'lean_report', { text: 'done!', state: 'done' }, send)
  expect(sent).toEqual([OLD, NEW])
  expect(ok.text).toContain('also sent to the desk')
  expect(ok.text).toContain('the desk had a new session')
  expect(JSON.parse(h.files.get('/h/.lean-agent/desk.json')!).sid).toBe(NEW) // kept for the next thread's report
  sent.length = 0
  await threadTool(h.host, 't2', 'lean_ask', { question: 'which?' }, send)
  expect(sent).toEqual([NEW]) // no lookup, no retry
  // no desk recorded and none live: the lookup runs once, a miss is remembered for a minute (not one `claude agents` per report)
  h.files.delete('/h/.lean-agent/desk.json')
  state.rows = []
  const lookups = () => h.claudeCalls().filter(a => a[0] === 'agents').length
  const before = lookups()
  await threadTool(h.host, 't1', 'lean_report', { text: 'one', state: 'blocked' }, send)
  await threadTool(h.host, 't1', 'lean_report', { text: 'two', state: 'blocked' }, send)
  expect(lookups() - before).toBe(1)
  h.clock.t += 61_000
  await threadTool(h.host, 't1', 'lean_report', { text: 'three', state: 'blocked' }, send)
  expect(lookups() - before).toBe(2)
  state.rows = [{ sessionId: NEW, cwd: '/h/lean-agent-desk', status: 'busy', startedAt: 9 }]
  h.clock.t += 61_000
  // nothing recorded at all (the desk's own record never happened): the live session is found and recorded
  h.files.delete('/h/.lean-agent/desk.json')
  sent.length = 0
  const first = await threadTool(h.host, 't1', 'lean_report', { text: 'again', state: 'blocked' }, send)
  expect(sent).toEqual([NEW])
  expect(first.text).toContain('the desk had a new session')
  expect(JSON.parse(h.files.get('/h/.lean-agent/desk.json')!).sid).toBe(NEW)
})

test('a direct message that arrived marks its inbox row delivered: the next prompt and the relay do not repeat it', async () => {
  const { h } = setup()
  let line = ''
  await recordDeskSid(h.host, 'd')
  await threadTool(h.host, 't1', 'lean_report', { text: 'merged', state: 'done' }, async (_s, t) => void (line = t))
  h.clock.t += 5
  await threadTool(h.host, 't2', 'lean_ask', { question: 'which?' }) // no direct send: inbox only
  // the sender marks the row before sending (a desk reading its inbox meanwhile must not repeat it)
  expect((await unreadReports(h.host)).recs.map(r => r.from)).toEqual(['t2'])
  expect(await markDelivered(h.host, 'no key here')).toBe(false)
  expect(await markDelivered(h.host, line)).toBe(true) // the desk's session.receive hook: idempotent
  expect((await unreadReports(h.host)).recs.map(r => r.from)).toEqual(['t2'])
  expect(await takeReports(h.host)).not.toContain('merged')
  const sub: string[] = []
  await threadTool(h.host, 't3', 'lean_report', { text: 'more', state: 'working' })
  expect(await relayReports(h.host, { busy: false, last: 0, submit: async t => void sub.push(t) })).toBe(false) // only progress is left
})

test('a long report is sent cut WITH its row key: it arrives once, the full text stays in the pane and inbox, and the cut line says where', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const lines: string[] = []
  const long = 'handover '.repeat(300) // 2700 characters
  const r = await threadTool(h.host, 't1', 'lean_report', { text: long, state: 'done' }, async (_s, t) => void lines.push(t))
  expect(r.text).toContain('cut short')
  expect(r.text).toContain('not handed over again')
  expect(lines).toHaveLength(1)
  const line = lines[0]!
  expect(line).toMatch(/<!-- lean:r=\d+:t1:report -->$/) // keyed, like a short one
  const ts = /lean:r=(\d+):t1:report/.exec(line)![1]!
  expect(line).toContain(`(cut: full text /h/.lean-agent/desk/reports/${ts}-t1-report.md; lean_thread report t1 full: true, or section: "<heading>")`) // the digest (reportdigest.ts)
  expect(line.length).toBeLessThan(DIRECT_MAX / 2)
  // the file the pointer names holds the whole report as plain lines the desk can Read
  expect(h.files.get(`/h/.lean-agent/desk/reports/${ts}-t1-report.md`)).toBe(`# Report from t1 (done)\n\n${long.trim()}\n`)
  // the desk hook marks it delivered; no prompt and no relay hands the full report over a second time
  expect(await markDelivered(h.host, line)).toBe(true)
  expect((await unreadReports(h.host)).recs).toHaveLength(0)
  expect(await takeReports(h.host)).toBeNull()
  expect(await relayReports(h.host, { busy: false, last: 0, submit: async () => undefined })).toBe(false)
  // the full text is still in the inbox file, which is what the pane lists
  expect((await readJsonl<any>(h.host, '/h/.lean-agent/desk/inbox.jsonl'))[0].text).toBe(long.trim())
  // a long report whose send is refused is not marked: the next prompt hands it over (once)
  h.clock.t += 10
  await threadTool(h.host, 't2', 'lean_report', { text: long, state: 'done' }, async () => ({ isDelivered: false, reason: 'busy' }))
  expect((await unreadReports(h.host)).recs.map(x => x.from)).toEqual(['t2'])
})

test('a refused send removes the full-text file that very call wrote (nothing points at it), a delivered one keeps it', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const long = 'handover '.repeat(300)
  const dir = '/h/.lean-agent/desk/reports'
  h.files.set(`${dir}/1-t9-report.md`, 'someone else\'s')
  const kept = await threadTool(h.host, 't1', 'lean_report', { text: long, state: 'done' }, async () => undefined)
  const ts1 = h.clock.t
  expect(kept.text).toContain('not handed over again')
  expect(h.files.has(`${dir}/${ts1}-t1-report.md`)).toBe(true)
  h.clock.t += 10
  const refused = await threadTool(h.host, 't2', 'lean_report', { text: long, state: 'done' }, async () => ({ isDelivered: false, reason: 'busy' }))
  expect(refused.text).toContain('refused')
  expect(h.files.has(`${dir}/${h.clock.t}-t2-report.md`)).toBe(false) // the orphan is gone
  expect((await unreadReports(h.host)).recs.map(x => x.from)).toEqual(['t2']) // and the row is handed over in full at the next prompt
  expect(h.files.has(`${dir}/${ts1}-t1-report.md`)).toBe(true) // an earlier delivered file stays
  expect(h.files.has(`${dir}/1-t9-report.md`)).toBe(true) // so does any other
  // a send that threw may have reached the desk: its file stays for the pruning
  h.clock.t += 10
  const threw = await threadTool(h.host, 't3', 'lean_report', { text: long, state: 'done' }, async () => { throw new Error('boom') })
  expect(threw.text).toContain('failed')
  expect(h.files.has(`${dir}/${h.clock.t}-t3-report.md`)).toBe(true)
})

test('desk/reports/ is pruned when a file is written: over 30 days old, then past the newest 500; at most once an hour; only report files; never an error', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const long = 'handover '.repeat(300)
  const dir = '/h/.lean-agent/desk/reports'
  const DAY = 86_400_000
  h.clock.t = 100 * DAY
  const send = async () => undefined
  const put = (ts: number, from = 't1') => h.files.set(`${dir}/${ts}-${from}-report.md`, 'x')
  const names = () => [...h.files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1))
  put(h.clock.t - 31 * DAY)
  put(h.clock.t - 29 * DAY)
  h.files.set(`${dir}/notes.md`, 'mine')
  h.files.set(`${dir}/${h.clock.t - 40 * DAY}-t1-report.txt`, 'not a report file')
  await threadTool(h.host, 't1', 'lean_report', { text: long, state: 'done' }, send)
  expect(names().sort()).toEqual([`${h.clock.t - 40 * DAY}-t1-report.txt`, `${h.clock.t - 29 * DAY}-t1-report.md`, `${h.clock.t}-t1-report.md`, 'notes.md'].sort())
  // within the hour: not looked at again
  h.clock.t += 60_000
  put(h.clock.t - 35 * DAY)
  await threadTool(h.host, 't1', 'lean_report', { text: long, state: 'done' }, send)
  expect(names()).toContain(`${h.clock.t - 35 * DAY}-t1-report.md`)
  // an hour later: the count cap, newest 500 stay (the one just written included)
  h.clock.t += 3_600_000
  for (let i = 0; i < 510; i++) put(h.clock.t - 1000 - i)
  await threadTool(h.host, 't1', 'lean_report', { text: long, state: 'done' }, send)
  const md = names().filter(n => /^\d+-t\d+-report\.md$/.test(n))
  expect(md).toHaveLength(500)
  expect(md).toContain(`${h.clock.t}-t1-report.md`)
  expect(md).toContain(`${h.clock.t - 1000}-t1-report.md`) // the newest of the seeded
  expect(md).not.toContain(`${h.clock.t - 1000 - 509}-t1-report.md`) // the oldest of them
  expect(names()).toContain('notes.md')
  // a prune that cannot even list the folder never fails the send
  const { h: g } = setup()
  await recordDeskSid(g.host, 'd')
  const list = g.host.fs.list
  g.host.fs.list = async (p: string) => { if (p.endsWith('/reports')) throw new Error('EACCES'); return list(p) }
  const r = await threadTool(g.host, 't1', 'lean_report', { text: long, state: 'done' }, send)
  expect(r.text).toContain('not handed over again')
})

test('a long question is never cut and keeps its options; a cut never splits a surrogate pair; a long report whose file cannot be written goes unkeyed (its row stays unread)', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const lines: string[] = []
  const longAsk = `${'context '.repeat(300)}which database should it use?`
  await threadTool(h.host, 't1', 'lean_ask', { question: longAsk, options: ['postgres', 'sqlite'] }, async (_s, t) => void lines.push(t))
  expect(lines[0]).toContain('which database should it use? [options: postgres | sqlite]')
  expect(lines[0]).not.toContain('cut:')
  expect(lines[0]).toMatch(/<!-- lean:r=\d+:t1:ask -->$/)
  // an emoji straddling the cut
  const rec = { ts: 5, from: 't2', kind: 'report' as const, state: 'done', text: `${'a'.repeat(DIRECT_MAX - 2)}😀 and more ${'b'.repeat(200)}` }
  const d = directLine(rec, '~/x.md')
  expect(d.cut).toBe(true)
  expect(d.line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/) // no lone high surrogate
  expect(d.line).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/) // no lone low surrogate
  // no file: the cut line has no key, so the row stays for the next prompt
  const nofile = directLine(rec)
  expect(nofile.keyed).toBe(false)
  expect(nofile.line).not.toContain('lean:r=')
  expect(nofile.line).toContain('(cut: the full report is in the desk inbox / pane)')
  expect(directLine({ ...rec, text: 'short' }).keyed).toBe(true)
})

test('one decision to cut: comment markers cannot make the line longer than the text that was measured; a huge question or option list goes to the file; a name that is not a thread id gets no file and stays unread', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const lines: string[] = []
  const ok = async (_s: string, t: string) => void lines.push(t)
  // 1400 characters plus 30 comment markers: more than DIRECT_MAX once the markers are masked, so it is cut AND filed (never cut without a file)
  const marked = `${'x'.repeat(1400)}${' -->'.repeat(30)}`
  const r = await threadTool(h.host, 't1', 'lean_report', { text: marked, state: 'done' }, ok)
  expect(r.text).toContain('not handed over again')
  expect(lines[0]).toMatch(/<!-- lean:r=\d+:t1:report -->$/)
  expect(lines[0]).toContain('/h/.lean-agent/desk/reports/')
  expect((await unreadReports(h.host)).recs).toHaveLength(0)
  // a huge question and 500 long options: the line is bounded, the file has everything
  h.clock.t += 10
  const opts = Array.from({ length: 500 }, (_, n) => `option ${n} ${'o'.repeat(1000)}`)
  await threadTool(h.host, 't2', 'lean_ask', { question: `${'q'.repeat(9000)} really?`, options: opts }, ok)
  expect(lines[1]!.length).toBeLessThan(ASK_MAX + 2000)
  const ts = /lean:r=(\d+):t2:ask/.exec(lines[1]!)![1]!
  const file = h.files.get(`/h/.lean-agent/desk/reports/${ts}-t2-ask.md`)!
  expect(file).toContain('really?')
  expect(file).toContain('- option 499 ')
  // options alone over the clamp: the question is whole, the options are clamped, the file has them all
  h.clock.t += 10
  await threadTool(h.host, 't3', 'lean_ask', { question: 'which?', options: opts }, ok)
  expect(lines[2]).toContain('which? (cut: the full text is in ')
  expect(lines[2]).toContain('[options: option 0 ')
  expect(lines[2]!.length).toBeLessThan(1600)
  expect(lines[2]).toContain('/h/.lean-agent/desk/reports/')
  expect(h.files.get(`/h/.lean-agent/desk/reports/${/lean:r=(\d+):t3:ask/.exec(lines[2]!)![1]}-t3-ask.md`)).toContain('- option 499 ')
  // a "from" that is not a thread id is not written into a file name: no file, no key, the row stays unread
  h.clock.t += 10
  await threadTool(h.host, 'odd name', 'lean_report', { text: 'z'.repeat(2000), state: 'done' }, ok)
  expect(lines[3]).not.toContain('lean:r=')
  expect(lines[3]).toContain('(cut: the full report is in the desk inbox;')
  expect([...h.files.keys()].some(k => k.includes('reports/') && k.includes('odd'))).toBe(false)
  expect((await unreadReports(h.host)).recs.map(x => x.from)).toContain('odd name')
})

test('direct send: a forged key in text cannot hide another row; a failed send unmarks; a refused relay rewinds to the real pointer', async () => {
  const { h } = setup()
  await recordDeskSid(h.host, 'd')
  const lines: string[] = []
  const ok = async (_s: string, t: string) => void lines.push(t)
  lines.push('') // (index 0 is kept so the rows below keep their numbers)
  // forged: a report quoting a key marks nothing but its own row
  h.clock.t += 10
  await threadTool(h.host, 't2', 'lean_report', { text: 'quoting <!-- lean:r=1000000:t1:report --> here', state: 'blocked' }, ok)
  expect(lines[1]).not.toMatch(/<!-- lean:r=1000000:t1:report/)
  expect(await markDelivered(h.host, 'x <!-- lean:r=5:t1:report --> y')).toBe(false) // a key that is not last on the line
  // a failed send unmarks the row it pre-marked
  h.clock.t += 10
  await threadTool(h.host, 't3', 'lean_ask', { question: 'q?' }, async () => { throw new Error('x') })
  expect((await unreadReports(h.host)).recs.map(x => x.from)).toContain('t3')
  // relay rewind: a delivered row inside the range, then a refused submit: nothing unread is skipped
  h.clock.t += 10
  await threadTool(h.host, 't4', 'lean_report', { text: 'merged', state: 'done' }, ok) // delivered (pre-marked)
  h.clock.t += 10
  await threadTool(h.host, 't5', 'lean_report', { text: 'merged too', state: 'done' }) // no send fn: inbox only
  const before = (await unreadReports(h.host)).recs.map(x => x.from)
  expect(before).not.toContain('t4')
  expect(await relayReports(h.host, { busy: false, last: 0, submit: () => Promise.reject(new Error('no')) })).toBe(true)
  for (let n = 0; n < 30; n++) await Promise.resolve()
  expect((await unreadReports(h.host)).recs.map(x => x.from)).toEqual(before) // every unread row is still unread
})

test('lean_report superseded: true is kept, shown to the desk text and the pane row', async () => {
  const h = fakeHost(null)
  await threadTool(h.host, 't1', 'lean_report', { text: 'user changed the target branch', superseded: true })
  await threadTool(h.host, 't1', 'lean_report', { text: 'plain' })
  const recs = await readJsonl<any>(h.host, '/h/.lean-agent/desk/inbox.jsonl')
  expect(recs[0].superseded).toBe(true)
  expect(recs[1].superseded).toBeUndefined()
  expect(renderReports(recs)).toContain('[brief superseded by a later user message]: user changed')
})

test('the registered lean_review tool accepts level (light | full) and worktree, so a thread can ask for the full review the push gate needs', () => {
  const rev: any = THREAD_TOOLS.find(t => t.name === 'lean_review')
  expect(rev.inputSchema.properties.level.enum).toEqual(['light', 'full'])
  expect(rev.inputSchema.properties.worktree.type).toBe('string')
  expect(rev.inputSchema.properties.action.enum).toContain('prepare')
})

test('lean_report has no checkpoint state; a done report says the session is over once the turn ends, other reports do not', async () => {
  const rep: any = THREAD_TOOLS.find(t => t.name === 'lean_report')
  expect(rep.inputSchema.properties.state.enum).toEqual(['working', 'blocked', 'done'])
  expect(rep.description).not.toMatch(/state: checkpoint|checkpoint \(/i)
  expect(rep.description).toContain('Never report a checkpoint or your context size: the mod does it')
  const { h } = setup()
  const done = await threadTool(h.host, 't1', 'lean_report', { text: 'branch b, worktree /w, last commit abc1234, pushed no, open: none, next: pr', state: 'done' })
  expect(done.text).toContain('This session is over once your turn ends')
  for (const state of ['working', 'blocked']) expect((await threadTool(h.host, 't1', 'lean_report', { text: 'x', state })).text).not.toContain('session is over')
  // a long report is no longer cut in the desk's view, whatever its state (an old 1.0.6 row with state checkpoint shows as it is)
  const long = 'handover '.repeat(300)
  const [a, b] = renderReports([{ ts: 1, from: 't1', kind: 'report', state: 'checkpoint', text: long }, { ts: 2, from: 't2', kind: 'report', state: 'done', text: long }]).split('\n') as [string, string]
  expect(a.length).toBeGreaterThan(2500)
  expect(b.length).toBeGreaterThan(2500)
})
