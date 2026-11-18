import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, listAgents, resetLocks } from './threads'
import { LIMIT_PROMPT, MAX_TRIES, RESUME_DELAY_MS, findLimitLine, fmtUntil, limitFromUsage, limitTick, parseResetText, readLimit, resetLimitCache, writeLimit } from './limits'
import { loadView, resetViewCache } from './view'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0) // 2026-11-18 15:00 UTC
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const DUE = NOW + 3_600_000 + RESUME_DELAY_MS // the 16:00 reset of the scripted log line, plus the two minutes

test('reset text: clock times with a zone, dates, relative; the next occurrence after the seen moment', () => {
  const p = (s: string, seen = NOW) => iso(parseResetText(s, seen))
  expect(p('4pm (UTC)')).toBe('2026-11-18T16:00:00.000Z')
  expect(p('4:30pm (UTC)')).toBe('2026-11-18T16:30:00.000Z')
  expect(p('16:00 (UTC)')).toBe('2026-11-18T16:00:00.000Z')
  expect(p('4pm (UTC).')).toBe('2026-11-18T16:00:00.000Z')
  expect(p('at 4pm (UTC)')).toBe('2026-11-18T16:00:00.000Z')
  expect(p('4pm (UTC)', Date.UTC(2026, 10, 18, 17, 0))).toBe('2026-11-19T16:00:00.000Z') // already past: tomorrow
  expect(p('12am (UTC)')).toBe('2026-11-19T00:00:00.000Z')
  expect(p('12pm (UTC)')).toBe('2026-11-19T12:00:00.000Z')
  expect(p('6:30pm (GMT+2)')).toBe('2026-11-18T16:30:00.000Z')
  expect(p('9:00 (UTC-05:00)')).toBe('2026-11-19T14:00:00.000Z')
  expect(p('4pm (Europe/Berlin)', Date.UTC(2026, 10, 18, 12, 0))).toBe('2026-11-18T15:00:00.000Z') // CET
  expect(p('4pm (Europe/Berlin)')).toBe('2026-11-19T15:00:00.000Z') // 16:00 in Berlin is the very second of the seen moment: the next one
  expect(p('4pm (Europe/Berlin)', Date.UTC(2026, 6, 1, 10, 0))).toBe('2026-07-01T14:00:00.000Z') // CEST
  expect(p('Nov 20, 4pm (UTC)')).toBe('2026-11-20T16:00:00.000Z')
  expect(p('Nov 20 at 4pm (UTC)')).toBe('2026-11-20T16:00:00.000Z')
  expect(p('Nov 20, 2026 4:15pm (UTC)')).toBe('2026-11-20T16:15:00.000Z')
  expect(p('20 Nov 16:00 (UTC)')).toBe('2026-11-20T16:00:00.000Z')
  expect(p('Jan 2, 4pm (UTC)', Date.UTC(2026, 11, 29, 10, 0))).toBe('2027-01-02T16:00:00.000Z') // over the new year
  expect(p('in 2h 30m')).toBe('2026-11-18T17:30:00.000Z')
  expect(p('in 45 minutes')).toBe('2026-11-18T15:45:00.000Z')
  // no zone: the desk machine's own
  expect(parseResetText('4pm', new Date(2026, 10, 18, 15, 0).getTime())).toBe(new Date(2026, 10, 18, 16, 0).getTime())
  expect(parseResetText('16:00', new Date(2026, 10, 18, 17, 0).getTime())).toBe(new Date(2026, 10, 19, 16, 0).getTime())
})

test('reset text it does not understand is no answer, never a guess', () => {
  for (const s of ['', 'soon', 'tomorrow', '4 (UTC)', '4pm (Mars/Base)', '25:00 (UTC)', '13pm (UTC)', '4:75pm (UTC)', 'Feb 31, 4pm (UTC)', 'Thu 4pm (UTC)', 'Nov 30, 4pm (UTC)', 'in 0m', 'in 300h', '4pm (../../etc)'])
    expect([s, parseResetText(s, NOW)]).toEqual([s, null])
})

test('the limit line in `claude logs` output: ANSI and boxes stripped, the last one wins, other text ignored', () => {
  const out = ['working...', "\x1b[31mYou've hit your session limit · resets 2pm (UTC)\x1b[0m", 'more output', "│ You've hit your weekly limit · resets Nov 20, 4pm (UTC) │", 'tail'].join('\n')
  expect(findLimitLine(out)).toEqual({ line: "You've hit your weekly limit · resets Nov 20, 4pm (UTC)", resets: 'Nov 20, 4pm (UTC)', count: 2 })
  expect(findLimitLine("Claude usage limit reached. Your limit will reset at 16:00 (UTC)")?.resets).toBe('16:00 (UTC)')
  expect(findLimitLine("You've hit your limit")).toBeNull()
  expect(findLimitLine('all fine\nlimit of 3 retries')).toBeNull()
  expect(findLimitLine('')).toBeNull()
})

test('the exhausted rate-limit windows give the reset: the later one, nothing when none is spent or the time is absurd', () => {
  const w = (percentUsed: number, at: number | string) => ({ kind: 'five_hour', percentUsed, resetsAt: typeof at === 'number' ? new Date(at).toISOString() : at })
  expect(limitFromUsage({ rateLimits: [w(100, NOW + 3_600_000), w(100, NOW + 86_400_000), w(40, NOW + 9_000_000)] }, NOW)).toBe(NOW + 86_400_000)
  expect(limitFromUsage({ rateLimits: [w(99.9, NOW + 3_600_000)] }, NOW)).toBeNull()
  expect(limitFromUsage({ rateLimits: [w(100, 'garbage')] }, NOW)).toBeNull()
  expect(limitFromUsage({ rateLimits: [w(100, NOW + 30 * 86_400_000)] }, NOW)).toBeNull()
  expect(limitFromUsage({ rateLimits: [] }, NOW)).toBeNull()
  expect(limitFromUsage(null, NOW)).toBeNull()
})

test('fmtUntil: the time today, with the date on another day', () => {
  const at = new Date(2026, 10, 18, 16, 0).getTime()
  expect(fmtUntil(at, new Date(2026, 10, 18, 9, 0).getTime())).toBe('16:00')
  expect(fmtUntil(at, new Date(2026, 10, 17, 9, 0).getTime())).toBe('Nov 18 16:00')
})

// ---- the tick, with a scripted claude ----------------------------------------------------------------------------------------
const ROW = { sessionId: SID, id: '11111111', name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', state: 'blocked', pid: 42, startedAt: 1 }
const LINE = "You've hit your session limit · resets 4pm (UTC)"

function setup() {
  resetLocks()
  resetLimitCache()
  resetViewCache()
  const h = fakeHost(null)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  const s = { rows: [] as any[], log: LINE, calls: [] as string[], resumeExit: 0 }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg' && !a.includes('--resume')) return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(s.rows) }
    s.calls.push(a[0] === '--bg' ? '--bg --resume' : a.slice(0, 2).join(' '))
    if (a[0] === 'stop') s.rows = s.rows.map(r => ({ ...r, pid: 0 }))
    if (a[0] === 'logs') return { exitCode: 0, stdout: s.log }
    if (a[0] === '--bg' && s.resumeExit) return { exitCode: s.resumeExit, stdout: '', stderr: 'no' }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i)
  const tick = () =>
    limitTick(h.host, {
      agents: async () => (await listAgents(h.host)) as any,
      logs: async row => {
        const r = await h.host.process.run(['claude', 'logs', row.id])
        return r.exitCode === 0 ? r.stdout : null
      },
      resume: id => leanThread(h.host, ROOT, { action: 'limit-resume', tN: id }),
    })
  const setState = (state: string) => {
    const f = '/h/.lean-agent/threads/t1/thread.json'
    h.files.set(f, JSON.stringify({ ...JSON.parse(h.files.get(f)!), state }))
  }
  return { h, s, call, tick, setState }
}
async function blocked(x: ReturnType<typeof setup>, row: any = {}) {
  await x.call({ action: 'new', title: 'a', text: 'brief' })
  x.h.clock.t = NOW
  x.s.rows = [{ ...ROW, ...row }]
  x.s.calls.length = 0
}
const resumes = (x: ReturnType<typeof setup>) => x.h.claudeCalls().filter(a => a[0] === '--bg' && a.includes('--resume'))

test('a thread blocked by the limit: seen, held until the reset + 2 min, then stopped and resumed once with the one prompt', async () => {
  const x = setup()
  await blocked(x)
  expect(await x.tick()).toEqual([`t1: usage limit until 2026-11-18T16:00:00.000Z`])
  expect(JSON.parse(x.h.files.get('/h/.lean-agent/threads/t1/limit.json')!)).toMatchObject({ resetAt: NOW + 3_600_000, source: 'logs', sid: SID, line: LINE })
  expect(x.s.calls).toEqual(['logs 11111111'])
  x.h.clock.t = NOW + 3_600_000 + RESUME_DELAY_MS - 1000 // not yet
  expect(await x.tick()).toEqual([])
  expect(resumes(x)).toHaveLength(0)
  x.h.clock.t = NOW + 3_600_000 + RESUME_DELAY_MS
  expect(await x.tick()).toEqual(['t1: resumed after the usage limit'])
  expect(x.s.calls).toEqual(['logs 11111111', 'stop 11111111', '--bg --resume'])
  const argv = resumes(x)[0]!
  expect(argv.slice(0, 3)).toEqual(['--bg', '--resume', SID]) // no other flag
  expect(argv[3]).toBe('--')
  expect(argv[4]!.startsWith(LIMIT_PROMPT)).toBe(true)
  expect(argv).toHaveLength(5)
  expect(x.h.calls.find(c => c.argv.includes('--resume'))!.cwd).toBe('/h/.lean-agent/threads/t1')
  expect((await readLimit(x.h.host, '/h', 't1'))!.resumedFor).toBe(NOW + 3_600_000)
})

test('never twice for one reset: the old line still in the log and a still-blocked row resume nothing', async () => {
  const x = setup()
  await blocked(x)
  await x.tick()
  x.h.clock.t = DUE
  await x.tick()
  expect(resumes(x)).toHaveLength(1)
  x.s.rows = [{ ...ROW }] // blocked again (the process is back), the same line in the log
  for (let n = 0; n < 4; n++) {
    x.h.clock.t += 6 * 60_000
    expect(await x.tick()).toEqual([])
  }
  expect(resumes(x)).toHaveLength(1)
})

test('a new limit (another reset) is handled again, once', async () => {
  const x = setup()
  await blocked(x)
  await x.tick()
  x.h.clock.t = DUE
  await x.tick()
  x.s.rows = [{ ...ROW }]
  x.s.log = LINE + '\nworking\n' + "You've hit your weekly limit · resets Nov 19, 9am (UTC)"
  x.h.clock.t += 6 * 60_000
  expect((await x.tick())[0]).toBe('t1: usage limit until 2026-11-19T09:00:00.000Z')
  x.h.clock.t = Date.UTC(2026, 10, 19, 9, 2)
  expect(await x.tick()).toEqual(['t1: resumed after the usage limit'])
  expect(resumes(x)).toHaveLength(2)
  x.s.rows = [{ ...ROW }]
  x.h.clock.t += 60_000
  expect(await x.tick()).toEqual([])
  expect(resumes(x)).toHaveLength(2)
})

test('a parked or closed thread is never resumed, and a later reopen does not revive the old pause', async () => {
  for (const state of ['parked', 'closed', 'closing']) {
    const x = setup()
    await blocked(x)
    await x.tick() // seen while open
    x.setState(state)
    x.h.clock.t = DUE
    x.s.calls.length = 0
    expect(await x.tick()).toEqual([])
    expect(x.s.calls).toEqual([])
    expect((await readLimit(x.h.host, '/h', 't1'))!.cancelled).toBe(state)
    x.setState('open') // reopened after the reset
    x.h.clock.t += 120_000
    expect(await x.tick()).toEqual([])
    expect(resumes(x)).toHaveLength(0)
    // and the action itself refuses a thread that is not open
    x.setState(state)
    expect((await x.call({ action: 'limit-resume', tN: 't1' })).ok).toBe(false)
  }
})

test('a session waiting on a permission prompt, a working one and one with no limit line are left alone', async () => {
  const x = setup()
  await blocked(x, { waitingFor: 'permission' })
  expect(await x.tick()).toEqual([])
  expect(x.s.calls).toEqual([]) // not even the log is read
  x.s.rows = [{ ...ROW, state: 'working', status: 'busy' }]
  expect(await x.tick()).toEqual([])
  expect(x.s.calls).toEqual([])
  x.s.rows = [{ ...ROW }]
  x.s.log = 'blocked for some other reason'
  expect(await x.tick()).toEqual([])
  expect(x.s.calls).toEqual(['logs 11111111'])
  x.h.clock.t += 60_000
  await x.tick() // not asked again for five minutes
  expect(x.s.calls).toEqual(['logs 11111111'])
  x.h.clock.t += 5 * 60_000
  await x.tick()
  expect(x.s.calls).toEqual(['logs 11111111', 'logs 11111111'])
  expect(resumes(x)).toHaveLength(0)
  expect(x.h.files.has('/h/.lean-agent/threads/t1/limit.json')).toBe(false)
})

test('a limit line whose time is not understood resumes nothing and says so', async () => {
  const x = setup()
  await blocked(x)
  x.s.log = "You've hit your limit · resets whenever"
  expect(await x.tick()).toEqual(['t1: limit line seen, reset time not understood'])
  expect(x.h.files.has('/h/.lean-agent/threads/t1/limit.json')).toBe(false)
})

test('desk.autoResume: false switches it off; the thread mod\'s own record is used without reading the log', async () => {
  const x = setup()
  await blocked(x)
  x.h.files.set('/h/.lean-agent/config.json', JSON.stringify({ desk: { autoResume: false } }))
  expect(await x.tick()).toEqual([])
  expect(x.s.calls).toEqual([])
  x.h.files.set('/h/.lean-agent/config.json', '{}')
  await writeLimit(x.h.host, '/h', 't1', { resetAt: NOW + 600_000, seenAt: NOW, source: 'mod', sid: SID })
  x.h.clock.t = NOW + 600_000 + RESUME_DELAY_MS
  expect(await x.tick()).toEqual(['t1: resumed after the usage limit'])
  expect(x.s.calls).toEqual(['stop 11111111', '--bg --resume']) // no logs call
})

test('a record for another session, or a reset long past, is not used', async () => {
  const x = setup()
  await blocked(x)
  x.s.log = 'nothing here'
  await writeLimit(x.h.host, '/h', 't1', { resetAt: NOW + 600_000, seenAt: NOW, source: 'mod', sid: 'another-session' })
  x.h.clock.t = NOW + 3_600_000
  await x.tick()
  expect(resumes(x)).toHaveLength(0)
  await writeLimit(x.h.host, '/h', 't1', { resetAt: NOW - 7 * 3_600_000, seenAt: NOW - 8 * 3_600_000, source: 'mod', sid: SID })
  x.h.clock.t += 6 * 60_000
  await x.tick()
  expect(resumes(x)).toHaveLength(0)
})

test('a resume that does not start gives the mark back and counts a try; after three it stops', async () => {
  const x = setup()
  await blocked(x)
  await x.tick()
  x.h.clock.t = DUE
  x.s.resumeExit = 1
  for (let n = 1; n <= MAX_TRIES; n++) {
    x.s.rows = [{ ...ROW }]
    const out = await x.tick()
    expect(out[0]).toContain(`resume after the usage limit failed (${n}/${MAX_TRIES})`)
    const rec = (await readLimit(x.h.host, '/h', 't1'))!
    expect([rec.resumedFor, rec.tries]).toEqual([undefined, n])
    x.h.clock.t += 60_000
  }
  x.s.rows = [{ ...ROW }]
  expect(await x.tick()).toEqual([])
  expect(resumes(x)).toHaveLength(MAX_TRIES)
})

test('limit-resume never stops or resumes a session that is working again', async () => {
  const x = setup()
  await blocked(x)
  await x.tick()
  x.h.clock.t = DUE
  x.s.rows = [{ ...ROW, state: 'working', status: 'busy' }]
  const r = await x.call({ action: 'limit-resume', tN: 't1' })
  expect(r.ok).toBe(true)
  expect((r.data as any).resumed).toBe(false)
  expect(x.s.calls.filter(c => c.startsWith('stop') || c.startsWith('--bg'))).toEqual([])
})

test('queued desk messages ride along with the resume and are marked delivered once', async () => {
  const x = setup()
  await blocked(x)
  await x.tick()
  x.h.files.set('/h/.lean-agent/threads/t1/inbox.jsonl', JSON.stringify({ ts: 1, text: 'also update the notes' }) + '\n')
  x.h.clock.t = DUE
  await x.tick()
  const prompt = resumes(x)[0]![4]!
  expect(prompt).toContain(LIMIT_PROMPT)
  expect(prompt).toContain('also update the notes')
  expect(prompt).toContain('<!-- lean:n=1 -->')
})

test('the pane view: paused until the reset, then needs you again once the one resume was spent', async () => {
  const x = setup()
  await blocked(x)
  const row = async () => (await loadView(x.h.host)).threads[0]!
  resetViewCache()
  let r = await row()
  expect([r.needsYou, r.pausedUntil]).toEqual([true, undefined]) // not seen by the desk's tick yet
  await x.tick()
  resetViewCache()
  r = await row()
  expect([r.needsYou, r.working, r.pausedUntil]).toEqual([false, false, NOW + 3_600_000])
  x.h.clock.t = DUE
  await x.tick()
  x.s.rows = [{ ...ROW }] // blocked again with the same reset: the resume is spent
  resetViewCache()
  r = await row()
  expect([r.needsYou, r.pausedUntil]).toEqual([true, undefined])
})
