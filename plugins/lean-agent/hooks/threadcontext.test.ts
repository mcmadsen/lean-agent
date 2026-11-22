// Thread context limit ("restart at turn end"), keep mode, the pane/list text, the config keys and the atomic record (threadcontext.ts,
// threads.ts wake, finish.ts, threaddetail.ts, register.tsx session.measure). Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetFinish, sweepFinished } from './finish'
import { loadThreadDetail, resetThreadCache } from './threaddetail'
import { DEFAULT_LIMIT, DEFAULT_WARN, ctxText, ctxView, decide, levelOf, limitsOf, overText, readContext, recordContext, resumedText, threadLimits } from './threadcontext'

const SID = '11111111-2222-3333-4444-555555555555'
const OLD = '00000000-2222-3333-4444-555555555555'
const NEW = '99999999-8888-7777-6666-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const CTX = `${T1}/context.json`
const INBOX = `${L}/desk/inbox.jsonl`
const DONE = JSON.stringify({ ts: 5_000_000, from: 't1', kind: 'report', state: 'done', text: 'branch fix-x, last commit abc1234, not pushed' }) + '\n'
const QUEUED = JSON.stringify({ ts: 9_990_000, text: 'one more thing' }) + '\n'

type Opts = { thread?: Record<string, unknown>; ctx?: number | null; ctxSid?: string; done?: boolean; row?: Record<string, unknown>; config?: unknown; queued?: boolean }
// a thread t1 with an idle session (a process), a scripted `claude`, a recorded context size unless told otherwise, and one queued message
function setup(o: Opts = {}) {
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium', ...o.thread }))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n')
  if (o.queued !== false) h.files.set(`${T1}/inbox.jsonl`, QUEUED)
  if (o.done) h.files.set(INBOX, DONE)
  if (o.ctx !== null && o.ctx !== undefined) h.files.set(CTX, JSON.stringify({ tokens: o.ctx, at: 9_000_000, sid: o.ctxSid ?? SID }))
  if (o.config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(o.config))
  const st = { rows: [{ sessionId: SID, name: 't1 · fix login', cwd: T1, status: 'idle', startedAt: 1, pid: 42, id: 'abcd1234', ...o.row }] as any[] }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${NEW}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return { exitCode: 0, stdout: JSON.stringify(st.rows) }
    if (a[0] === 'stop') {
      for (const r of st.rows) r.pid = 0 // the process is gone after a stop
      return { exitCode: 0, stdout: '' }
    }
    return { exitCode: 0, stdout: '' }
  }
  const thread = () => JSON.parse(h.files.get(`${T1}/thread.json`)!)
  const starts = () => h.claudeCalls().filter(x => x[0] === '--bg' && !x.includes('--resume')) // new sessions
  const resumes = () => h.claudeCalls().filter(x => x[0] === '--bg' && x.includes('--resume'))
  return { h, st, run: (i: any) => leanThread(h.host, ROOT, i), thread, starts, resumes }
}

// ---- config ----
test('config: threadTokens defaults to 120000 and threadWarnTokens to 100000 (83% of the limit, to the nearest 1000)', () => {
  expect(limitsOf({})).toEqual({ limit: DEFAULT_LIMIT, warn: DEFAULT_WARN })
  expect(limitsOf(null)).toEqual({ limit: 120_000, warn: 100_000 })
  expect(limitsOf({ threadTokens: 200_000 })).toEqual({ limit: 200_000, warn: 166_000 }) // no warn key: 83% of the configured limit
  expect(limitsOf({ threadTokens: 150_000, threadWarnTokens: 90_000 })).toEqual({ limit: 150_000, warn: 90_000 })
  expect(limitsOf({ threadWarnTokens: 80_000 })).toEqual({ limit: 120_000, warn: 80_000 })
  expect(limitsOf({ threadTokens: 50_000, threadWarnTokens: 70_000 })).toEqual({ limit: 50_000, warn: 50_000 }) // a warn level never passes the limit
})

test('config: a value that is not a number (or too small, negative, NaN) is ignored: the default applies', () => {
  for (const bad of ['150000', '', null, undefined, {}, [], true, NaN, Infinity, -1, 0, 9_999]) {
    expect(limitsOf({ threadTokens: bad, threadWarnTokens: bad })).toEqual({ limit: 120_000, warn: 100_000 })
  }
  expect(limitsOf({ threadTokens: 150_000.9 }).limit).toBe(150_000) // whole tokens
})

test('config: threadLimits reads config.json; a damaged file gives the defaults', async () => {
  const a = fakeHost(null)
  expect(await threadLimits(a.host)).toEqual({ limit: 120_000, warn: 100_000 })
  a.files.set(`${L}/config.json`, JSON.stringify({ threadTokens: 60_000, threadWarnTokens: 40_000 }))
  expect(await threadLimits(a.host)).toEqual({ limit: 60_000, warn: 40_000 })
  a.files.set(`${L}/config.json`, '{ not json')
  expect(await threadLimits(a.host)).toEqual({ limit: 120_000, warn: 100_000 })
  a.files.set(`${L}/config.json`, JSON.stringify({ threadTokens: 'lots' }))
  expect(await threadLimits(a.host)).toEqual({ limit: 120_000, warn: 100_000 })
})

// ---- level and text ----
test('level: under the warn level, above it, at the limit (still fine), over it, unknown', () => {
  const l = { limit: 120_000, warn: 100_000 }
  expect(levelOf(50_000, l)).toBe('ok')
  expect(levelOf(100_000, l)).toBe('ok') // at the warn level: not yet above
  expect(levelOf(100_001, l)).toBe('warn')
  expect(levelOf(120_000, l)).toBe('warn') // at the limit: not over
  expect(levelOf(120_001, l)).toBe('over')
  expect(levelOf(null, l)).toBe('unknown')
  expect(levelOf(undefined, l)).toBe('unknown')
})

test('text: "ctx 108k/120k" (the card and the list), "ctx unknown" without a size; the view carries the level', () => {
  const l = { limit: 120_000, warn: 100_000 }
  expect(ctxText(108_000, l)).toBe('ctx 108k/120k')
  expect(ctxText(null, l)).toBe('ctx unknown')
  expect(ctxView({ tokens: 108_000, at: 1, sid: SID }, l)).toEqual({ text: 'ctx 108k/120k', level: 'warn', tokens: 108_000 })
  expect(ctxView({ tokens: 40_000, at: 1, sid: SID }, l).level).toBe('ok')
  expect(ctxView({ tokens: 130_000, at: 1, sid: SID }, l).level).toBe('over')
  expect(ctxView(null, l)).toEqual({ text: 'ctx unknown', level: 'unknown' })
  expect(overText(142_000, 120_000)).toBe('context was 142k (limit 120k): started a new session with the handover (old conversation kept read-only, not resumed)')
})

test('cost wording: the resume phrase says which rule applied and prices the cached re-read from the price table (estimate)', () => {
  expect(resumedText('keep', 85_000, 'opus')).toBe('resumed (keep mode): context 85k, cached re-read ~$0.04 (estimate)') // 85k x $0.5 / 1M
  expect(resumedText('', 85_000, 'sonnet')).toBe('resumed: context 85k, cached re-read ~$0.03 (estimate)') // 85k x $0.3 / 1M
  expect(resumedText('keep', null, 'opus')).toBe('resumed (keep mode): context size unknown')
})

// ---- the decision ----
test('decide: over / at / under the limit, done, keep and an unknown size', () => {
  const d = (done: boolean, keep: boolean, tokens: number | null) => decide({ done, keep, tokens, limit: 120_000 })
  expect(d(false, false, 130_000)).toEqual({ act: 'fresh', cause: 'context' })
  expect(d(false, false, 120_000)).toEqual({ act: 'resume', why: '' }) // at the limit
  expect(d(false, false, 119_000)).toEqual({ act: 'resume', why: '' })
  expect(d(true, false, 50_000)).toEqual({ act: 'fresh', cause: 'done' }) // done, no keep: a new session
  expect(d(true, true, 50_000)).toEqual({ act: 'resume', why: 'keep' }) // done + keep: resumed
  expect(d(true, true, 120_000)).toEqual({ act: 'resume', why: 'keep' })
  expect(d(true, true, 120_001)).toEqual({ act: 'fresh', cause: 'context' }) // over the limit beats keep
  expect(d(true, false, 130_000)).toEqual({ act: 'fresh', cause: 'context' })
  expect(d(false, false, null)).toEqual({ act: 'resume', why: '' }) // unknown: never restarted on a guess
  expect(d(false, true, null)).toEqual({ act: 'resume', why: '' })
  expect(d(true, true, null)).toEqual({ act: 'resume', why: 'keep' })
  expect(d(true, false, null)).toEqual({ act: 'fresh', cause: 'done' })
})

// ---- the record ----
test('record: written atomically (a temp file and a move), read back; bad sizes and ids write nothing', async () => {
  const h = fakeHost(null)
  h.clock.t = 7_000_000
  expect(await recordContext(h.host, 't1', SID, 142_345.4)).toBe(true)
  expect(JSON.parse(h.files.get(CTX)!)).toEqual({ tokens: 142_345, at: 7_000_000, sid: SID })
  expect([...h.files.keys()].filter(k => k.includes('.tmp-'))).toEqual([]) // the temp file was moved over the record, none is left
  expect(h.calls.some(c => c.argv[0] === 'mv' && c.argv.some(a => a.includes('context.json.tmp-')))).toBe(true)
  expect(await readContext(h.host, '/h', { id: 't1', sid: SID })).toEqual({ tokens: 142_345, at: 7_000_000, sid: SID })
  for (const bad of [0, -5, NaN, Infinity, '9000', null, undefined]) expect(await recordContext(h.host, 't1', SID, bad)).toBe(false)
  expect(await recordContext(h.host, 't1', '', 5000)).toBe(false)
  expect(await recordContext(h.host, '../x', SID, 5000)).toBe(false)
  expect(JSON.parse(h.files.get(CTX)!).tokens).toBe(142_345) // nothing above touched it
})

test('record: a failed move leaves the old record and no temp file, and says false', async () => {
  const h = fakeHost(null)
  await recordContext(h.host, 't1', SID, 50_000)
  const run = h.host.process.run
  h.host.process.run = async (argv: readonly string[], init?: any) => (argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'denied' } : run(argv, init))
  expect(await recordContext(h.host, 't1', SID, 90_000)).toBe(false)
  expect(JSON.parse(h.files.get(CTX)!).tokens).toBe(50_000)
  expect([...h.files.keys()].filter(k => k.includes('.tmp-'))).toEqual([])
})

test('record: a size from an old session id, a damaged file and a missing file are ignored (unknown)', async () => {
  const h = fakeHost(null)
  h.files.set(CTX, JSON.stringify({ tokens: 500_000, at: 1, sid: OLD }))
  expect(await readContext(h.host, '/h', { id: 't1', sid: SID })).toBeNull() // another session's record
  expect(await readContext(h.host, '/h', { id: 't1', sid: OLD })).not.toBeNull()
  expect(await readContext(h.host, '/h', { id: 't1', sid: '' })).toBeNull() // no session yet
  h.files.set(CTX, '{ torn')
  expect(await readContext(h.host, '/h', { id: 't1', sid: SID })).toBeNull()
  h.files.set(CTX, JSON.stringify({ tokens: 'many', at: 1, sid: SID }))
  expect(await readContext(h.host, '/h', { id: 't1', sid: SID })).toBeNull()
  h.files.delete(CTX)
  expect(await readContext(h.host, '/h', { id: 't1', sid: SID })).toBeNull()
})

// ---- wake: resume or fresh ----
test('idle session under the limit: a send resumes it and says what the cached re-read costs', async () => {
  const s = setup({ ctx: 85_000 })
  const r = await s.run({ action: 'send', tN: 't1', text: 'next' })
  expect(r.ok).toBe(true)
  expect(s.resumes().length).toBe(1)
  expect(s.starts().length).toBe(0)
  expect(r.text).toContain('resumed: context 85k, cached re-read ~$0.03 (estimate)') // 85k x $0.3 / 1M (sonnet)
})

test('idle session AT the limit is still resumed; one token over starts a new session with the handover', async () => {
  const at = setup({ ctx: 120_000 })
  expect((await at.run({ action: 'wake', tN: 't1' })).text).toContain('resumed: context 120k')
  expect(at.starts().length).toBe(0)
  const over = setup({ ctx: 120_001 })
  const r = await over.run({ action: 'wake', tN: 't1' })
  expect(over.resumes().length).toBe(0)
  expect(over.starts().length).toBe(1)
  expect(r.text).toContain('context was 120k (limit 120k): started a new session with the handover')
  expect(r.text).toContain("the old session's conversation is not resumed") // the cost phrase of the start
})

test('over the limit: the reply names the size, the limit and the handover cost; the queued message and brief go to the new session', async () => {
  const s = setup({ ctx: 142_000 })
  const r = await s.run({ action: 'send', tN: 't1', text: 'and the footer' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('context was 142k (limit 120k): started a new session with the handover (old conversation kept read-only, not resumed)')
  expect(r.text).toMatch(/handover about [\d.]+k? tokens \(~\$0\.\d\d first turn, estimate\)/)
  expect((r.data as any).resumed).toBe(false)
  const argv = s.starts()[0]!
  const prompt = argv[argv.length - 1]!
  expect(prompt).toContain('fix the login bug')
  expect(prompt).toContain('one more thing')
  expect(prompt).toContain('and the footer')
  expect(s.thread().sid).toBe(NEW)
  expect(s.thread().sids).toContain(SID)
  expect(s.h.claudeCalls().filter(a => a[0] === 'stop')).toEqual([['stop', 'abcd1234']]) // the idle process was stopped first
})

test('a working session is never touched, however large its recorded context: the message only queues', async () => {
  for (const row of [{ status: 'busy' }, { status: 'idle', state: 'working' }]) {
    const s = setup({ ctx: 500_000, row })
    const r = await s.run({ action: 'send', tN: 't1', text: 'next' })
    expect(r.text).toContain('is running')
    expect(s.starts().length).toBe(0)
    expect(s.resumes().length).toBe(0)
    expect(s.h.claudeCalls().some(a => a[0] === 'stop')).toBe(false)
    expect(s.thread().sid).toBe(SID)
  }
  const wake = setup({ ctx: 500_000, row: { status: 'busy' } }) // wake and resume do not replace a working session either
  expect((await wake.run({ action: 'wake', tN: 't1' })).text).toContain('is running')
  expect((await wake.run({ action: 'resume', tN: 't1' })).text).toContain('is running')
  expect(wake.starts().length + wake.resumes().length).toBe(0)
})

test('unknown size (no record, a record of another session, a damaged one) is treated as under the limit: resumed, no claim about the size', async () => {
  const none = setup({})
  const a = await none.run({ action: 'send', tN: 't1', text: 'x' })
  expect(none.resumes().length).toBe(1)
  expect(none.starts().length).toBe(0)
  expect(a.text).not.toContain('context')
  const old = setup({ ctx: 900_000, ctxSid: OLD }) // recorded by an older session id: ignored
  await old.run({ action: 'send', tN: 't1', text: 'x' })
  expect(old.resumes().length).toBe(1)
  expect(old.starts().length).toBe(0)
  const bad = setup({})
  bad.h.files.set(CTX, 'oops')
  await bad.run({ action: 'send', tN: 't1', text: 'x' })
  expect(bad.resumes().length).toBe(1)
})

test('done + keep: the next message RESUMES the session (keep mode), and a finished marker is cleared', async () => {
  const s = setup({ done: true, ctx: 85_000, thread: { keep: true } })
  const r = await s.run({ action: 'send', tN: 't1', text: 'follow-up' })
  expect(s.resumes().length).toBe(1)
  expect(s.starts().length).toBe(0)
  expect(r.text).toContain('resumed (keep mode): context 85k, cached re-read ~$0.03 (estimate)')
  const fin = setup({ ctx: 85_000, thread: { keep: true, finished: 1 } }) // keep switched on after a finish
  const w = await fin.run({ action: 'wake', tN: 't1' })
  expect(w.text).toContain('resumed (keep mode)')
  expect(fin.starts().length).toBe(0)
  expect(fin.thread().finished).toBeUndefined()
})

test('done + keep with no recorded size still resumes (size unknown: never restarted on a guess)', async () => {
  const s = setup({ done: true, thread: { keep: true } })
  const r = await s.run({ action: 'send', tN: 't1', text: 'follow-up' })
  expect(s.resumes().length).toBe(1)
  expect(r.text).toContain('resumed (keep mode): context size unknown')
})

test('done + no keep: the next message starts a NEW session and says it is not in keep mode', async () => {
  const s = setup({ done: true, ctx: 40_000 })
  const r = await s.run({ action: 'send', tN: 't1', text: 'follow-up' })
  expect(s.starts().length).toBe(1)
  expect(s.resumes().length).toBe(0)
  expect(r.text).toContain('finished earlier')
  expect(r.text).toContain('new session (not in keep mode)')
})

test('over the limit + done + keep: a NEW session (the turn-end restart beats keep mode), the reply says the context was the reason', async () => {
  const s = setup({ done: true, ctx: 131_000, thread: { keep: true } })
  const r = await s.run({ action: 'send', tN: 't1', text: 'follow-up' })
  expect(s.starts().length).toBe(1)
  expect(s.resumes().length).toBe(0)
  expect(r.text).toContain('context was 131k (limit 120k)')
  expect(r.text).not.toContain('not in keep mode')
})

test('the limit follows config.json threadTokens; a bad value falls back to 120000', async () => {
  const small = setup({ ctx: 60_000, config: { threadTokens: 50_000 } })
  expect((await small.run({ action: 'send', tN: 't1', text: 'x' })).text).toContain('context was 60k (limit 50k)')
  expect(small.starts().length).toBe(1)
  const bad = setup({ ctx: 60_000, config: { threadTokens: 'fifty thousand' } })
  expect((await bad.run({ action: 'send', tN: 't1', text: 'x' })).text).toContain('resumed: context 60k')
  expect(bad.starts().length).toBe(0)
})

test('a record under another id of the same session (a resume or reload, kept in sids) counts only when written since the last wake', async () => {
  const MOD = 'aaaaaaaa-2222-3333-4444-555555555555'
  const h = fakeHost(null)
  h.files.set(CTX, JSON.stringify({ tokens: 130_000, at: 9_000_000, sid: MOD }))
  const t = { id: 't1', sid: SID, sids: [MOD], lastWake: 8_000_000 }
  expect((await readContext(h.host, '/h', t))?.tokens).toBe(130_000)
  expect(await readContext(h.host, '/h', { ...t, lastWake: 9_500_000 })).toBeNull() // written before this session was started or woken
  expect(await readContext(h.host, '/h', { ...t, sids: [] })).toBeNull() // not an id the thread ever resolved as
  const s = setup({ ctx: 130_000, ctxSid: MOD, thread: { sids: [MOD], lastWake: 8_000_000 } })
  expect((await s.run({ action: 'send', tN: 't1', text: 'x' })).text).toContain('context was 130k (limit 120k)')
})

test('over the limit inside the 30 s wake gap the message still queues; a usage-limit resume skips the size check', async () => {
  const gap = setup({ ctx: 500_000, thread: { lastWake: 10_000_000 - 5_000 } })
  const r = await gap.run({ action: 'send', tN: 't1', text: 'x' })
  expect(r.text).toContain('was woken')
  expect(gap.starts().length + gap.resumes().length).toBe(0)
  // the desk's usage-limit resume: the session was blocked inside a turn, so its last turn-end size is not current
  const lim = setup({ ctx: 500_000 })
  lim.h.files.set(`${T1}/limit.json`, JSON.stringify({ resetAt: 9_900_000, seenAt: 9_000_000, source: 'mod', sid: SID, resumedFor: 9_900_000, resumedAt: 9_950_000 }))
  const l = await lim.run({ action: 'limit-resume', tN: 't1' })
  expect(l.ok).toBe(true)
  expect(lim.resumes().length).toBe(1)
  expect(lim.starts().length).toBe(0)
})

test('over the limit on a recorded opus that is not approved: no opus session is started (the replacement is held or runs on sonnet)', async () => {
  const s = setup({ ctx: 150_000, thread: { model: 'opus' } })
  const r = await s.run({ action: 'send', tN: 't1', text: 'x' })
  expect(r.ok).toBe(true)
  expect(s.resumes().length).toBe(0)
  const bg = s.starts()
  expect(bg.length).toBeLessThanOrEqual(1)
  for (const a of bg) expect(a).not.toContain('opus')
})

test('keep on a parked thread is stored; a closed thread refuses the new session but keeps the flag', async () => {
  const p = setup({ queued: false, thread: { state: 'parked' } })
  expect((await p.run({ action: 'keep', tN: 't1', on: true })).ok).toBe(true)
  expect(p.thread().keep).toBe(true)
  expect(p.thread().state).toBe('parked')
  const c = setup({ queued: false, thread: { state: 'closed' } })
  expect((await c.run({ action: 'keep', tN: 't1', on: true })).ok).toBe(true)
  expect(c.thread().keep).toBe(true)
  expect(c.thread().state).toBe('closed')
})

// ---- keep mode: storing and finishing ----
test('keep tN on|off is stored in thread.json; without on/off it says what is set', async () => {
  const s = setup({ queued: false })
  expect((await s.run({ action: 'keep', tN: 't1' })).text).toContain('keep mode off')
  const on = await s.run({ action: 'keep', tN: 't1', on: true })
  expect(on.ok).toBe(true)
  expect(on.text).toContain('keep mode on')
  expect(on.text).toContain('120k')
  expect(s.thread().keep).toBe(true)
  expect(s.thread().sid).toBe(SID) // the rest of the record is kept
  expect((await s.run({ action: 'keep', tN: 't1' })).text).toContain('keep mode on')
  const off = await s.run({ action: 'keep', tN: 't1', on: false })
  expect(off.text).toContain('keep mode off')
  expect(s.thread().keep).toBeUndefined()
  expect((await s.run({ action: 'keep', tN: 't9', on: true })).ok).toBe(false)
})

test('start with keep: true / false stores it, also when the session is already running', async () => {
  const s = setup({ queued: false })
  const r = await s.run({ action: 'start', tN: 't1', keep: true })
  expect(r.ok).toBe(true)
  expect(s.thread().keep).toBe(true)
  const run = setup({ queued: false, row: { status: 'busy' }, thread: { keep: true } })
  expect((await run.run({ action: 'start', tN: 't1', keep: false })).text).toContain('already running')
  expect(run.thread().keep).toBeUndefined()
  const on = setup({ queued: false, row: { status: 'busy' } })
  await on.run({ action: 'start', tN: 't1', keep: true })
  expect(on.thread().keep).toBe(true)
  expect(on.starts().length).toBe(0)
})

test('new with keep: true stores keep; the default is off', async () => {
  for (const keep of [true, undefined]) {
    resetLocks()
    const h = fakeHost(null)
    h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
    h.files.set(`${ROOT}/templates/front-desk.md`, 'desk')
    h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${NEW}\n` } : { exitCode: 0, stdout: '[]' })
    const r = await leanThread(h.host, ROOT, { action: 'new', title: 'a', text: 'brief', ...(keep ? { keep } : {}) })
    expect(r.ok).toBe(true)
    expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).keep).toBe(keep ? true : undefined)
  }
})

test('a keep thread that reported done is not finished (its session is kept); without keep it is', async () => {
  const keep = setup({ done: true, thread: { keep: true } })
  const r = await keep.run({ action: 'finish', tN: 't1' })
  expect(r.text).toContain('keep mode')
  expect((r.data as any).finished).toBe(false)
  expect(keep.h.claudeCalls().some(a => a[0] === 'stop')).toBe(false)
  expect(keep.thread().finished).toBeUndefined()
  const ran: string[] = []
  expect(await sweepFinished(keep.h.host, async id => (ran.push(id), keep.run({ action: 'finish', tN: id })))).toEqual([])
  expect(ran).toEqual([]) // the sweep does not even call it
  const plain = setup({ done: true })
  expect((await plain.run({ action: 'finish', tN: 't1' })).data).toEqual({ finished: true })
})

// ---- list and pane data ----
test('list: "ctx 108k/120k", "ctx unknown", the over-limit note and the keep marker', async () => {
  const s = setup({ ctx: 108_000, thread: { keep: true } })
  const mk = (id: string, t: Record<string, unknown>) => s.h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: id, project: '', state: 'open', sid: `${id}-sid`, created: 1, lastWake: 0, delivered: 0, ...t }))
  mk('t2', {}) // no record: unknown
  mk('t3', { sid: OLD }) // a record exists for another session id only
  s.h.files.set(`${L}/threads/t3/context.json`, JSON.stringify({ tokens: 900_000, at: 1, sid: 'someone-else' }))
  mk('t4', {})
  s.h.files.set(`${L}/threads/t4/context.json`, JSON.stringify({ tokens: 130_000, at: 1, sid: 't4-sid' }))
  mk('t5', { sid: '' }) // never started: nothing to say
  mk('t6', { state: 'closed' }) // closed: nothing to say
  const r = await s.run({ action: 'list' })
  const lines = r.text.split('\n')
  expect(lines[0]).toContain('ctx 108k/120k')
  expect(lines[0]).toContain(' · keep')
  expect(lines[1]).toContain('ctx unknown')
  expect(lines[2]).toContain('ctx unknown')
  expect(lines[3]).toContain('ctx 130k/120k (over the limit: the next message starts a new session)')
  expect(lines[4]).not.toContain('ctx')
  expect(lines[5]).not.toContain('ctx')
  const data = r.data as any[]
  expect(data[0]).toMatchObject({ ctx: 'ctx 108k/120k', ctxLevel: 'warn', ctxTokens: 108_000, keep: true })
  expect(data[1]).toMatchObject({ ctx: 'ctx unknown', ctxLevel: 'unknown' })
  expect(data[3]).toMatchObject({ ctxLevel: 'over' })
})

test('thread pane data: the context text and level, the keep flag; unknown says so', async () => {
  const s = setup({ ctx: 108_000, thread: { keep: true } })
  const d = await loadThreadDetail(s.h.host, 't1')
  expect(d?.ctx).toEqual({ text: 'ctx 108k/120k', level: 'warn', tokens: 108_000 })
  expect(d?.keep).toBe(true)
  s.h.files.set(CTX, JSON.stringify({ tokens: 130_000, at: 1, sid: SID }))
  expect((await loadThreadDetail(s.h.host, 't1'))?.ctx?.level).toBe('over')
  s.h.files.set(CTX, JSON.stringify({ tokens: 30_000, at: 1, sid: SID }))
  expect((await loadThreadDetail(s.h.host, 't1'))?.ctx?.level).toBe('ok')
  s.h.files.delete(CTX)
  const u = await loadThreadDetail(s.h.host, 't1')
  expect(u?.ctx).toEqual({ text: 'ctx unknown', level: 'unknown' })
})

// ---- the thread's own mod records the size at the end of a turn ----
test('session.measure in a thread session writes context.json for its session id', { timeoutMs: 20_000 }, async ($, on) => {
  const h = fakeHost(on)
  on('clock.after', () => new Promise(() => {}))
  resetLocks()
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: 'sess-x', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  const timers: number[] = []
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('clock.every', ((_: any, e: any) => { timers.push(e.ms); return { value: { cancel() {} } } }) as any) // (the engine's type says void; the mod keeps the handle to cancel it)
  on('session.cwd', () => ({ value: T1 }))
  on('session.root', () => ({ value: T1 }))
  on('session.id', () => ({ value: 'sess-x' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed })) // the engine's own answer, beneath the mod's hook
  await $.session.start({ cwd: T1, surface: 'desktop', isInteractive: true } as any)
  await $.session.measure({ context: { tokens: 142_000, window: 200_000, percent: 71 }, rateLimits: [], changed: ['context'] } as any)
  expect(JSON.parse(h.files.get(CTX) ?? 'null')).toMatchObject({ tokens: 142_000, sid: 'sess-x' })
})
