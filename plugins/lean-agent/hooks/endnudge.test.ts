// The report rule and its enforcement (endnudge.ts, continuepending.ts kind 'end', stall.ts alert, the list wording, lean_doctor row). Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActivity } from './threadstate'
import { continueTick, noteTurnEnd } from './continuepending'
import { stallTick } from './stall'
import { leanThread, resetLocks } from './threads'
import { resetThreadCache } from './threaddetail'
import { resetFinish } from './finish'
import { HINT_KEY, NUDGE_TEXT, REPORT_RULE, REPORT_RULE_SENTENCE, UNVERIFIED_PHRASES, alertText, doctorRow, endedCount, hasUnverifiedClaim, singleAction, withReportRule } from './endnudge'
import { noteSynthAtTurnEnd, noteToolResult, readSynth, resetSynth, synthDisplay } from './synthline'
import { loadView, resetViewCache } from './view'
import { itemsOf, needsUser, sortItems } from './panelist'

const S1 = '11111111-2222-3333-4444-555555555555'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const T0 = 10_000_000
const MIN = 60_000
const row = (o: Record<string, unknown> = {}) => ({ sid: S1, name: '', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', waitingFor: '', ...o }) as any
const EXAMPLE = 'The move was done by a worker, since I cannot run shell file steps. Its report says mv exited 0 and ls on the source failed with "No such file or directory". I have not re-checked that myself.'
const json = (h: any, f: string) => JSON.parse(h.files.get(f) ?? '{}')
const pend = (h: any) => json(h, `${T1}/continue-pending.json`)
const ended = (h: any) => json(h, `${T1}/ended-noreport.json`)

function setup(o: { thread?: Record<string, unknown>; config?: unknown; activityMinAgo?: number } = {}) {
  resetActivity()
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = T0
  h.files.set(`/p/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'move the files', project: 'acme', state: 'open', sid: S1, created: 1, lastWake: T0 - 60 * MIN, delivered: 0, model: 'sonnet', effort: 'medium', ...o.thread }))
  h.files.set(`${T1}/brief.md`, '1. move the files\n2. update the index\n') // (several steps: threads.requireReport has its own spec)
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 - (o.activityMinAgo ?? 1) * MIN, kind: 'tool' }))
  h.files.set(`${L}/config.json`, JSON.stringify(o.config ?? { threads: { keepGoing: false } }))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: S1, name: 't1 · move', cwd: T1, status: 'idle', state: 'idle', startedAt: 1, pid: 42, id: 'abcd1234' }]) } : { exitCode: 0, stdout: '' })
  return h
}
const end = (h: any, lastText: string | null, since = T0 - 2 * MIN) => noteTurnEnd(h.host, 't1', { sid: S1, since, lastText })
const tick = (h: any, sent: string[], rows: any[] = [row()]) => continueTick(h.host, { agents: async () => rows, send: async (id: string, text: string) => (sent.push(`${id}|${text}`), { ok: true, text: 'sent' }) })
const inbox = (h: any, ...recs: object[]) => h.files.set(`${L}/desk/inbox.jsonl`, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
const deps = { agents: async () => [row()], restart: async () => ({ ok: true, text: '' }) as any }

// ---- A. the rule ------------------------------------------------------------------------------------------------------------------
test('the rule is one fixed text of at most 4 lines; its first sentence is the one the agent files and templates carry', () => {
  expect(REPORT_RULE.split('\n').length).toBeLessThanOrEqual(4)
  expect(REPORT_RULE.startsWith(REPORT_RULE_SENTENCE)).toBe(true)
  expect(REPORT_RULE).toBe(
    'Every turn of yours ends with lean_report (done, blocked or question) or, for a worker, with its answer to the thread.\n' +
      'Never end a turn with a plain summary, a status, a hedge or a promise of a next step.\n' +
      'A result you did not verify yourself is reported as unverified, with what is missing.\n' +
      'Silence is a failure, the desk cannot see it.',
  )
})

test('prompt.compose: a thread session gets the rule as its FIRST section (once); a desk, a result without sections and a non-thread are left alone', () => {
  const base = { sections: [{ id: 'lean-agent:memory', text: 'm', scope: 'session' }, { id: 'lean-agent:rules', text: 'r', scope: 'session' }] }
  const r = withReportRule(base, 'thread')
  expect(r.sections[0]).toEqual({ id: 'lean-agent:report-rule', text: REPORT_RULE, scope: 'shared' }) // (the engine wants every shared section before the session ones)
  expect(r.sections.map(s => s.id)).toEqual(['lean-agent:report-rule', 'lean-agent:memory', 'lean-agent:rules'])
  expect(withReportRule(r, 'thread').sections.filter(s => s.id === 'lean-agent:report-rule')).toHaveLength(1)
  expect(withReportRule(base, 'desk')).toBe(base)
  expect(withReportRule({ x: 1 }, 'thread')).toEqual({ x: 1 })
  expect(withReportRule(null, 'thread')).toBeNull()
  // a huge memory section does not push it down or cut it
  const big = withReportRule({ sections: [{ id: 'lean-agent:memory', text: 'x'.repeat(50_000), scope: 'session' }] }, 'thread')
  expect(big.sections[0]!.text).toBe(REPORT_RULE)
})

// (the agent files, the thread guide template and the review brief carry the rule: hooks/skills-contract.test.sh, which reads the real files)

// ---- unverified claims --------------------------------------------------------------------------------------------------------------
test('UNVERIFIED_PHRASES: a hedge or a handed-over claim matches; a plain finished text does not', () => {
  expect(UNVERIFIED_PHRASES.length).toBeGreaterThan(3)
  for (const t of [EXAMPLE, "I haven't re-checked it.", 'I didn’t verify the result.', 'Not verified yet.', 'The result is unverified.', 'The worker reports that the build passed.', 'worker says the file is gone', 'I did not verify this']) expect(hasUnverifiedClaim(t)).toBe(true)
  for (const t of ['All done, tests pass (42 of 42).', 'Verified with ls: the folder is gone.', '', null, 42, 'The workers branch is merged.']) expect(hasUnverifiedClaim(t)).toBe(false)
})

// ---- B(3). the nudge ----------------------------------------------------------------------------------------------------------------
test('the example (a summary handing over a worker claim, "I have not re-checked", no report) is nudged ONCE with the verify hint; a second tick sends nothing', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  expect(await end(h, EXAMPLE)).toBe('end')
  expect(pend(h)).toEqual({ at: T0, sid: S1, kind: 'end', text: HINT_KEY })
  expect(ended(h)).toEqual({ at: T0, first: T0, sid: S1, hint: true })
  const sent: string[] = []
  h.clock.t = T0 + 10_000
  await tick(h, sent)
  expect(sent).toEqual([]) // not before threads.continueSeconds
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent).toEqual([`t1|${NUDGE_TEXT(true)}`])
  expect(sent[0]).toContain('verify it first')
  expect(sent[0]).toContain('done (unverified)')
  expect(sent[0]).toContain('lean_report')
  h.clock.t = T0 + 60_000
  await tick(h, sent)
  expect(sent).toHaveLength(1) // one nudge per ended turn
  expect(pend(h)).toEqual({})
  expect(json(h, `${T1}/continue-state.json`).endHour).toEqual([T0 + 25_000])
  expect(h.files.get(`${T1}/continue-log.jsonl`)).toContain('nudged by the mod: its turn ended without a report')
})

test('a plain unreported ending gets the nudge without the hint; the hint text is the only difference', async () => {
  const h = setup()
  expect(await end(h, 'Moved the files to /data/new and updated the index.')).toBe('end')
  expect(pend(h).text).toBe('')
  const sent: string[] = []
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent).toEqual([`t1|${NUDGE_TEXT(false)}`])
  expect(NUDGE_TEXT(false)).not.toContain('done (unverified)')
  expect(NUDGE_TEXT(false)).toContain('verify it first')
})

test('a turn with a final report (done, blocked, a question) is not nudged and clears the record; so does the second turn after an unreported one', async () => {
  const h = setup()
  await end(h, EXAMPLE)
  expect(ended(h).first).toBe(T0)
  h.clock.t = T0 + 5 * MIN
  inbox(h, { ts: T0 + 4 * MIN, from: 't1', kind: 'report', state: 'done', text: 'verified with ls: moved' })
  expect(await end(h, 'Done.', T0 + 3 * MIN)).toBe('none')
  expect(pend(h)).toEqual({})
  expect(ended(h)).toEqual({})
  for (const r of [{ kind: 'report', state: 'blocked' }, { kind: 'ask' }]) {
    const g = setup()
    inbox(g, { ts: T0 - 1000, from: 't1', text: 'x', ...r })
    expect(await end(g, EXAMPLE)).toBe('none')
    expect(ended(g)).toEqual({})
  }
})

test('a thread that really waits (ready to push, no push yet) is NOT nudged; a "once the desk reports ..." ending with no record is reminded, not nudged', async () => {
  const a = setup()
  inbox(a, { ts: T0 - 1000, from: 't1', kind: 'report', state: 'working', text: 'ready to push 1a2b3c4 (feature/x, Move the files)' })
  expect(await end(a, 'Waiting for the push result; I have not re-checked the branch.')).toBe('none')
  expect(pend(a)).toEqual({})
  expect(ended(a)).toEqual({})
  const b = setup()
  expect(await end(b, 'Branch is ready.\nOnce the desk reports the push, I will clean up the worktree.')).toBe('remind')
  expect(ended(b)).toEqual({})
})

test('an open task or an announced next step is continued as before, not nudged', async () => {
  const a = setup({ config: { threads: { keepGoing: false } } })
  expect(await noteTurnEnd(a.host, 't1', { sid: S1, since: T0 - 2 * MIN, lastText: EXAMPLE, tasks: [{ content: 'verify', status: 'pending' }] })).toBe('todo')
  expect(ended(a)).toEqual({})
  const b = setup()
  expect(await end(b, 'Moved the files.\nNext: update the index')).toBe('next')
  expect(ended(b)).toEqual({})
})

test('closed, finished, hard-stopped or parked: no nudge, and a pending nudge of a thread that was closed meanwhile is dropped (never reopens)', async () => {
  const h = setup()
  await end(h, EXAMPLE)
  h.files.set(`${T1}/thread.json`, JSON.stringify({ ...json(h, `${T1}/thread.json`), state: 'closed' }))
  h.clock.t = T0 + 25_000
  const sent: string[] = []
  await tick(h, sent)
  expect(sent).toEqual([])
  expect(pend(h)).toEqual({})
  expect(await end(h, EXAMPLE)).toBe('none')
  const f = setup({ thread: { finished: true } })
  expect(await end(f, EXAMPLE)).toBe('none')
  const p = setup()
  p.files.set(`${T1}/thread.json`, JSON.stringify({ ...json(p, `${T1}/thread.json`), state: 'parked' }))
  expect(await end(p, EXAMPLE)).toBe('none')
})

test('max 2 nudges an hour a thread: the third ended turn is not nudged (the record stays for the desk alert); an hour later it is again', async () => {
  const h = setup()
  const sent: string[] = []
  for (let i = 0; i < 2; i++) {
    expect(await end(h, EXAMPLE)).toBe('end')
    h.clock.t += 25_000
    await tick(h, sent)
    h.clock.t += 60_000
  }
  expect(sent).toHaveLength(2)
  expect(await end(h, EXAMPLE)).toBe('none') // keepGoing is off in this setup: nothing else continues it
  expect(ended(h).sid).toBe(S1)
  expect(ended(h).first).toBe(T0) // the first unreported end of the spell
  h.clock.t += 25_000
  await tick(h, sent)
  expect(sent).toHaveLength(2)
  // the desk side holds the cap as well (a record written by an older turn end)
  h.files.set(`${T1}/continue-pending.json`, JSON.stringify({ at: h.clock.t, sid: S1, kind: 'end', text: '' }))
  h.clock.t += 25_000
  await tick(h, sent)
  expect(sent).toHaveLength(2)
  h.clock.t = T0 + 70 * MIN
  expect(await end(h, EXAMPLE)).toBe('end')
})

test('with keep-going on the nudge replaces the bare "Continue"; over the cap keep-going is what it was', async () => {
  const h = setup({ config: { threads: { keepGoing: true } } })
  expect(await end(h, 'Finished the move.')).toBe('end')
  const sent: string[] = []
  h.clock.t = T0 + 25_000
  await tick(h, sent)
  expect(sent[0]).toBe(`t1|${NUDGE_TEXT(false)}`)
  h.clock.t += 5_000
  expect(await end(h, 'Finished the move.')).toBe('end')
  h.clock.t += 25_000
  await tick(h, sent)
  h.clock.t += 5_000
  expect(await end(h, 'Finished the move.')).toBe('keep') // 2 nudges used
})

test('threads.endNudge false: no nudge, no record (the 1.0.31 behaviour)', async () => {
  const h = setup({ config: { threads: { keepGoing: false, endNudge: false } } })
  expect(await end(h, EXAMPLE)).toBe('none')
  expect(ended(h)).toEqual({})
  const g = setup({ config: { threads: { keepGoing: true, endNudge: false } } })
  expect(await end(g, EXAMPLE)).toBe('keep')
  // a record that is pending when the switch goes off is dropped
  const k = setup()
  await end(k, EXAMPLE)
  k.files.set(`${L}/config.json`, JSON.stringify({ threads: { endNudge: false } }))
  k.clock.t = T0 + 25_000
  const sent: string[] = []
  await tick(k, sent)
  expect(sent).toEqual([])
})

// ---- B(3). enforcement: the desk alert ----------------------------------------------------------------------------------------------
test('still no report idleAlertMinutes after the turn end: ONE desk alert (not before, not twice); an earlier report of the session and keep-going no longer hide it', { timeoutMs: 20_000 }, async () => {
  const h = setup({ thread: { keepGoing: true }, activityMinAgo: 0 })
  inbox(h, { ts: T0 - 30 * MIN, from: 't1', kind: 'ask', text: 'which folder?' }) // answered long ago: an old report of this session
  expect(await end(h, EXAMPLE, T0 - 2 * MIN)).toBe('end')
  h.clock.t = T0 + 5 * MIN
  expect(await stallTick(h.host, deps)).toEqual([]) // not yet
  h.clock.t = T0 + 11 * MIN
  const n = await stallTick(h.host, deps)
  expect(n).toHaveLength(1)
  expect(n[0]!.id).toBe('t1')
  expect(n[0]!.text).toBe(`${alertText('t1', 11 * MIN, 'move the files')}; its last text handed over a result it did not verify itself`)
  expect(n[0]!.text).toContain('ended its turn without a report')
  h.clock.t = T0 + 30 * MIN
  expect(await stallTick(h.host, deps)).toEqual([]) // told once
  expect(ended(h).alerted).toBe(T0 + 11 * MIN)
})

test('no alert when it reported meanwhile, when it waits for something, when it works, when the alert is off or threads.endNudge is false', { timeoutMs: 20_000 }, async () => {
  const mk = async (cfg?: unknown) => {
    const h = setup(cfg ? { config: cfg } : {})
    await end(h, 'Moved the files.')
    h.clock.t = T0 + 12 * MIN
    return h
  }
  const a = await mk()
  inbox(a, { ts: T0 + 6 * MIN, from: 't1', kind: 'report', state: 'done', text: 'done' })
  expect(await stallTick(a.host, deps)).toEqual([])
  const b = await mk()
  inbox(b, { ts: T0 + 6 * MIN, from: 't1', kind: 'report', state: 'working', text: 'ready to push 1a2b3c4 (feature/x, Move the files)' })
  expect((await stallTick(b.host, deps)).filter(x => x.text.includes('ended its turn'))).toEqual([])
  const c = await mk()
  c.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0 + 11 * MIN, kind: 'tool' }))
  expect(await stallTick(c.host, { ...deps, agents: async () => [row({ status: 'busy', state: 'working' })] })).toEqual([]) // working again
  const d = await mk({ threads: { keepGoing: false, idleAlertMinutes: 0 } })
  expect(await stallTick(d.host, deps)).toEqual([])
  const e = await mk()
  e.files.set(`${L}/config.json`, JSON.stringify({ threads: { endNudge: false } }))
  expect((await stallTick(e.host, deps)).filter(x => x.text.includes('ended its turn'))).toEqual([])
  const f = await mk({ threads: { keepGoing: false, idleAlertMinutes: 20 } })
  expect(await stallTick(f.host, deps)).toEqual([]) // 12 min < 20
})

test('lean_thread list says "ended without a report, N min" once it is due', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  await end(h, EXAMPLE)
  h.clock.t = T0 + 4 * MIN
  expect((await leanThread(h.host, '/p', { action: 'list' })).text).not.toContain('ended without a report')
  h.clock.t = T0 + 12 * MIN
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0, kind: 'tool' }))
  const text = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(text).toContain('ended without a report, 12 min')
  expect(text).not.toContain('idle 12 min, no report') // (replaces the plain idle line)
})

// ---- C. lean_doctor ------------------------------------------------------------------------------------------------------------------
test('lean_doctor row: report rule injected, N turns ended without a report in 7 days (older ones are not counted)', async () => {
  const h = setup()
  expect(await doctorRow(h.host)).toBe('ok   report rule: injected (threads), 0 turns ended without a report in 7 days')
  await end(h, EXAMPLE)
  h.clock.t += 25_000
  await end(h, 'Moved the files.')
  h.files.set(`${L}/threads/t2/end-log.jsonl`, JSON.stringify({ at: T0 - 8 * 86_400_000 }) + '\n' + JSON.stringify({ at: T0 + 1 }) + '\n')
  expect(await endedCount(h.host)).toBe(3)
  expect(await doctorRow(h.host)).toBe('ok   report rule: injected (threads), 3 turns ended without a report in 7 days')
})

// ---- the synthesised last line (synthline.ts) -------------------------------------------------------------------------------------------
test('a turn that ends on a tool result with no text: a short synthesised line (tool + 100 chars), shown in the list while idle; a turn end WITH text clears it; never a report', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  resetSynth()
  noteToolResult('mcp__lean-agent__lean_run', `exit 0\n${'x'.repeat(300)}`, T0 - 60_000)
  await noteSynthAtTurnEnd(h.host, '/h', 't1',{ lastText: null, since: T0 - 2 * MIN })
  const f = json(h, `${T1}/synth-line.json`)
  expect(f.text).toBe(`lean_run: exit 0 ${'x'.repeat(100 - 'exit 0 '.length)}`)
  expect(f.text.length).toBe('lean_run: '.length + 100)
  expect(await readSynth(h.host, '/h', 't1',{ idle: true, lastReportTs: 0 })).toBe(f.text)
  expect(await readSynth(h.host, '/h', 't1',{ idle: false, lastReportTs: 0 })).toBeNull() // it works again: nothing stale
  expect(await readSynth(h.host, '/h', 't1',{ idle: true, lastReportTs: T0 })).toBeNull() // a newer report wins
  h.clock.t = T0 + 4 * MIN
  h.files.set(`${T1}/activity.json`, JSON.stringify({ at: T0, kind: 'tool' }))
  const text = (await leanThread(h.host, '/p', { action: 'list' })).text
  expect(text).toContain('lean_run: exit 0')
  expect(text).toContain('(synthesised)')
  // not a report: the idle alert still fires after idleAlertMinutes (no record reached the desk inbox)
  expect(h.files.get(`${L}/desk/inbox.jsonl`)).toBeUndefined()
  h.clock.t = T0 + 12 * MIN
  expect((await stallTick(h.host, deps)).filter(n => n.text.includes('t1 idle for'))).toHaveLength(1)
  // a turn end with text, or one from before this turn's tool result: cleared
  await noteSynthAtTurnEnd(h.host, '/h', 't1',{ lastText: 'Done.', since: T0 - 2 * MIN })
  expect(json(h, `${T1}/synth-line.json`)).toEqual({})
  await noteSynthAtTurnEnd(h.host, '/h', 't1',{ lastText: null, since: T0 })
  expect(json(h, `${T1}/synth-line.json`)).toEqual({})
  expect(synthDisplay('lean_run: ok')).toBe('lean_run: ok (synthesised)')
})

// ---- the pane flag ---------------------------------------------------------------------------------------------------------------------
test('the pane: a thread idle with no report gets the chip "idle, no report N min" and counts as needs-you in the sort; a thread that reported or waits does not; a synthesised line is marked and is not a report', { timeoutMs: 20_000 }, async () => {
  const h = setup({ activityMinAgo: 12 })
  resetViewCache()
  h.files.set(`${T1}/synth-line.json`, JSON.stringify({ at: T0 - 11 * MIN, text: 'lean_run: mv exited 0' }))
  const v = await loadView(h.host)
  const t = v.threads.find(x => x.id === 't1')!
  expect(t.noReport).toBe('idle, no report 12 min')
  expect(t.lastReport).toBe('lean_run: mv exited 0 (synthesised)')
  expect(t.synth).toBe(true)
  expect(needsUser(t)).toBe(true)
  const items = itemsOf([{ ...t, id: 't2', noReport: undefined, activity: T0 }, t], [])
  expect(sortItems(items, 'needs').map(i => i.id)).toEqual(['t1', 't2'])
  // after a final report: no chip, no needs-you, no synthesised line
  h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: T0 - 6 * MIN, from: 't1', kind: 'report', state: 'done', text: 'verified: moved' }) + '\n')
  resetViewCache()
  const v2 = await loadView(h.host)
  const t2 = v2.threads.find(x => x.id === 't1')!
  expect(t2.noReport).toBeUndefined()
  expect(t2.synth).toBeUndefined()
  expect(needsUser(t2)).toBe(false)
  // idle for less than idleAlertMinutes: no chip
  const g = setup({ activityMinAgo: 3 })
  resetViewCache()
  expect((await loadView(g.host)).threads.find(x => x.id === 't1')!.noReport).toBeUndefined()
})

// ---- threads.requireReport ------------------------------------------------------------------------------------------------------------------
test('singleAction: a short brief for ONE action is one; several steps, a list, sequencing words or a long brief are not', () => {
  for (const b of ['Move /data/old to /data/new.', 'Rename the function parseDate to parseIsoDate in src/date.ts.', 'Find where the retry limit is set and say the file:line.']) expect(singleAction(b)).toBe(true)
  for (const b of ['1. Move the folder\n2. Update the index', 'Move the folder, then update the index.', '- a\n- b', 'x'.repeat(600), '', null, 'Fix the bug. Next, add a test.']) expect(singleAction(b)).toBe(false)
})

test('threads.requireReport: a single-action thread that ends without a report is nudged at the next tick with the whole rule; other briefs and requireReport false keep the normal wait', async () => {
  const h = setup()
  h.files.set(`${T1}/brief.md`, 'Move /data/old to /data/new.\n')
  expect(await end(h, EXAMPLE)).toBe('end')
  expect(pend(h).req).toBe(true)
  const sent: string[] = []
  h.clock.t = T0 + 11_000 // 10 s tick, well under continueSeconds (20)
  await tick(h, sent)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toBe(`t1|${NUDGE_TEXT(true, true)}`)
  expect(sent[0]).toContain(REPORT_RULE)
  expect(sent[0]).toContain('Refused')
  // a multi-step brief: the usual 20 s
  const m = setup()
  m.files.set(`${T1}/brief.md`, '1. Move the folder\n2. Update the index\n')
  await end(m, EXAMPLE)
  expect(pend(m).req).toBeUndefined()
  m.clock.t = T0 + 11_000
  const s2: string[] = []
  await tick(m, s2)
  expect(s2).toEqual([])
  // switched off
  const o = setup({ config: { threads: { keepGoing: false, requireReport: false } } })
  o.files.set(`${T1}/brief.md`, 'Move /data/old to /data/new.\n')
  await end(o, EXAMPLE)
  expect(pend(o).req).toBeUndefined()
  expect(NUDGE_TEXT(false)).not.toContain('Refused')
})
