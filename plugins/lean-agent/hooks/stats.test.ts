// Stats computed by the mod: the rollup of the ledger (incremental, both schemas), rotation, the stats text, rule loads.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { dayOf, normalizeRow, rotateLedger, syncRollup } from './ledger'
import { logRuleLoad, recordRule, rulesStats } from './rules'
import { modelMismatches, spendLine, statsText } from './stats'
import { resetLocks } from './threads'
import { record, spentToday } from './budget'

const L = '/h/.lean-agent'
const NOON = Date.UTC(2026, 10, 18, 12)
const DAY = 86_400_000
const row = (ts: number, o: Record<string, unknown> = {}) => JSON.stringify({ ts, role: 'thread', tN: 't1', model: 'claude-sonnet-5-5', in: 1000, out: 100, cache_read: 5000, cache_write: 200, usd: 1, ...o }) + '\n'
const old = (iso: string, o: Record<string, unknown> = {}) => JSON.stringify({ id: 'r1', ts: iso, project: 'p', model: 'sonnet', role: 'reviewer', thread: 't9', task: 'x'.repeat(300), result_head: 'y'.repeat(600), usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }, cost_usd: 0.5, ...o }) + '\n'
function setup() {
  const h = fakeHost(null)
  h.clock.t = NOON
  return h
}

test('both row schemas normalise; a non-row is null', () => {
  expect(normalizeRow(JSON.parse(row(NOON)))).toMatchObject({ role: 'thread', tN: 't1', agent: 'main', usd: 1, in: 1000, cr: 5000, cw: 200, legacy: false })
  expect(normalizeRow({ ts: NOON, usd: 2, model: 'm', agent: 'lean-agent:worker-haiku' })).toMatchObject({ role: 'unknown', tN: '-', agent: 'worker-haiku', in: 0 }) // zero fields are left out of a row
  expect(normalizeRow(JSON.parse(old('2026-11-17T10:00:00')))).toMatchObject({ role: 'unknown', tN: 't9', agent: 'reviewer', usd: 0.5, in: 10, out: 40, cr: 30, cw: 20, legacy: true, ts: Date.UTC(2026, 10, 17, 10) })
  expect(normalizeRow(JSON.parse(old('2026-11-17T10:00:00', { cost_usd: null })))).toMatchObject({ usd: 0 })
  expect(normalizeRow({ hello: 1 })).toBeNull()
  expect(normalizeRow([1])).toBeNull()
  expect(normalizeRow({ ts: 'not a date', cost_usd: 1 })).toBeNull()
})

test('the rollup reads only new bytes, never twice, and survives a torn last line', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(NOON) + row(NOON, { role: 'desk', usd: 2 }))
  const a = await syncRollup(h.host)
  expect(a.days[dayOf(NOON)]!.t[0]).toBe(3)
  expect(a.days[dayOf(NOON)]!.role.desk![0]).toBe(2)
  expect(a.rows).toBe(2)
  const tails: string[] = []
  h.host.process.run = ((run: any) => async (argv: string[], init?: any) => { if (argv[0] === 'tail') tails.push(argv.join(' ')); return run(argv, init) })(h.host.process.run)
  let reads = 0
  const read = h.host.fs.read
  h.host.fs.read = async (p: string) => { if (p.endsWith('ledger.jsonl')) reads++; return read(p) }
  h.files.set(`${L}/ledger.jsonl`, h.files.get(`${L}/ledger.jsonl`)! + row(NOON, { usd: 4 }) + '{"ts":' ) // a torn line waits
  const b = await syncRollup(h.host)
  expect(b.days[dayOf(NOON)]!.t[0]).toBe(7)
  expect(reads).toBe(0) // the tail only
  expect(tails.length).toBe(1)
  h.files.set(`${L}/ledger.jsonl`, h.files.get(`${L}/ledger.jsonl`)!.replace(/\{"ts":$/, '') + row(NOON, { usd: 8 }))
  expect((await syncRollup(h.host)).days[dayOf(NOON)]!.t[0]).toBe(15)
  expect((await syncRollup(h.host)).rows).toBe(4) // nothing new: nothing folded
})

test('a day change starts a new day; the spend cap cache is rebuilt from the rollup, not by reading the ledger', async () => {
  const h = setup()
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host, 'desk')).toBe(3)
  let reads = 0
  const read = h.host.fs.read
  h.host.fs.read = async (p: string) => { if (p.endsWith('ledger.jsonl')) reads++; return read(p) }
  h.clock.t += DAY
  expect(await spentToday(h.host, 'desk')).toBe(0)
  await record(h.host, { role: 'desk' }, 'sonnet', { input_tokens: 1_000_000 })
  expect(await spentToday(h.host, 'desk')).toBe(3)
  expect(reads).toBe(0)
  const ro = await syncRollup(h.host) // the stats side folds the new rows in when asked
  expect(Object.keys(ro.days).sort()).toEqual([dayOf(NOON), dayOf(NOON + DAY)])
  expect(reads).toBe(0)
})

test('a shrunk ledger or a damaged rollup is rebuilt from the files', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(NOON) + row(NOON) + row(NOON))
  expect((await syncRollup(h.host)).rows).toBe(3)
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 10 })) // truncated by hand, shorter than the offset
  const r = await syncRollup(h.host)
  expect(r.rows).toBe(1)
  expect(r.days[dayOf(NOON)]!.t[0]).toBe(10)
  h.files.set(`${L}/rollup.json`, '{broken')
  expect((await syncRollup(h.host)).rows).toBe(1)
})

test('rotation: a file that starts with a 0.45 row moves to ledger-legacy.jsonl once; nothing is counted twice or lost; stats still read it', async () => {
  const h = setup()
  const mixed = old('2026-11-10T08:00:00') + old('2026-11-11T08:00:00') + row(NOON) + row(NOON, { usd: 2 })
  h.files.set(`${L}/ledger.jsonl`, mixed)
  const before = await statsText(h.host)
  expect((await rotateLedger(h.host))[0]).toContain('2 0.45 row(s) moved to ledger-legacy.jsonl, 2 1.0 row(s) kept in ledger.jsonl')
  // split by row format: today's 1.0 rows STAY in ledger.jsonl, the 0.45 rows are the legacy file
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON) + row(NOON, { usd: 2 }))
  expect(h.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-11-10T08:00:00') + old('2026-11-11T08:00:00'))
  const plain = (t: string) => t.replace(/^(period|WARNING|ledger):.*(\n|$)/gm, '')
  expect(plain(await statsText(h.host))).toBe(plain(before)) // the same spend and tables before and after
  expect(await rotateLedger(h.host)).toEqual([]) // nothing left to rotate
  // new rows go to a fresh ledger.jsonl; the sum is the old file plus the new row, each once
  await record(h.host, { role: 'thread', tN: 't2' }, 'sonnet', { input_tokens: 1_000_000 })
  const ro = await syncRollup(h.host)
  expect(ro.rows).toBe(5)
  expect(ro.legacy).toBe(2)
  expect(Math.round(ro.days[dayOf(NOON)]!.t[0] * 1e6) / 1e6).toBe(1 + 2 + 3)
  expect(ro.days['2026-11-10']!.t[0]).toBe(0.5)
  expect(Object.keys(ro.files).sort()).toEqual(['ledger-legacy.jsonl', 'ledger.jsonl'])
  // today's cap cache counts the 1.0 rows that moved with the legacy file, and not the 0.45 ones
  expect(Math.round((await spentToday(h.host, 'thread')) * 1e6) / 1e6).toBe(6)
  // a second legacy file never overwrites the first
  h.files.set(`${L}/ledger.jsonl`, old('2026-10-01T00:00:00'))
  await rotateLedger(h.host)
  expect(h.files.has(`${L}/ledger-legacy-2.jsonl`)).toBe(true)
})

test('repair: a legacy file that already holds 1.0 rows (what 1.0.5 produced) gives them back to ledger.jsonl; a row written meanwhile survives; stats period and files', async () => {
  const h = setup()
  h.files.set(`${L}/ledger-legacy.jsonl`, old('2026-11-10T08:00:00') + old('2026-11-11T08:00:00') + row(NOON - 5000, { usd: 5 }) + row(NOON - 4000, { usd: 6 }))
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 7 })) // what the desk wrote after the 1.0.5 rotation
  const lines = await rotateLedger(h.host)
  expect(lines.join('\n')).toContain('ledger repaired: 2 1.0 row(s) moved from ledger-legacy.jsonl back to ledger.jsonl, 2 0.45 row(s) stay')
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON, { usd: 7 }) + row(NOON - 5000, { usd: 5 }) + row(NOON - 4000, { usd: 6 })) // appended: the newer row is never rewritten
  expect(h.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-11-10T08:00:00') + old('2026-11-11T08:00:00'))
  expect(await rotateLedger(h.host)).toEqual([]) // idempotent
  const text = await statsText(h.host)
  expect(text).toContain('period: 2026-11-12 00:00Z to now; ledger files read: ledger-legacy.jsonl, ledger.jsonl (rows: 5)')
  expect(text).toContain('spend: today $18.00')
  // a file that changes while it is being split is left alone (nothing lost); a ledger.jsonl that starts inside the window warns
  const g = setup()
  g.files.set(`${L}/ledger-legacy.jsonl`, old('2026-11-10T08:00:00') + row(NOON - 5000))
  g.files.set(`${L}/ledger.jsonl`, row(NOON))
  const size = g.host.fs.stat
  let n = 0
  g.host.fs.stat = async (p: string, o?: any) => { const s = await size(p, o); return p.endsWith('ledger-legacy.jsonl') && ++n > 2 ? { ...s, size: (s.size ?? 0) + 1 } : s }
  expect(await rotateLedger(g.host)).toEqual([])
  expect(g.files.get(`${L}/ledger-legacy.jsonl`)).toContain(String(NOON - 5000))
  expect(await statsText(g.host)).toContain('WARNING: ledger.jsonl starts at')
  // the repair was NOT marked done (it was not safe): the next start tries again, and this time it works
  expect(await g.store.get('ledger-repair.v')).toBeUndefined()
  g.host.fs.stat = size
  expect((await rotateLedger(g.host)).join('\n')).toContain('ledger repaired: 1 1.0 row(s)')
  expect(g.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-11-10T08:00:00'))
  expect(await g.store.get('ledger-repair.v')).toBe(1)
})

test('a split sends the 1.0 rows of a past month to their own file: ledger.jsonl never starts in a past month, so the next start does not rotate it away again', async () => {
  const h = setup()
  const sep = Date.UTC(2026, 8, 20)
  h.files.set(`${L}/ledger.jsonl`, old('2026-09-01T08:00:00') + row(sep, { usd: 4 }) + row(NOON))
  expect((await rotateLedger(h.host)).length).toBeGreaterThan(0)
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON))
  expect(h.files.get(`${L}/ledger-2026-09.jsonl`)).toBe(row(sep, { usd: 4 }))
  expect(h.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-09-01T08:00:00'))
  expect(await rotateLedger(h.host)).toEqual([]) // the next start has nothing to do: today's rows stay where they are
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON))
  const ro = await syncRollup(h.host)
  expect(ro.rows).toBe(3)
  expect(ro.days['2026-09-20']!.t[0]).toBe(4)
  // the same split run again after a crash (rows already in both targets) writes nothing twice
  h.files.set(`${L}/ledger-legacy.jsonl`, old('2026-09-01T08:00:00') + row(sep, { usd: 4 }))
  await h.store.set('ledger-repair.v', undefined)
  await rotateLedger(h.host)
  expect(h.files.get(`${L}/ledger-2026-09.jsonl`)).toBe(row(sep, { usd: 4 }))
})

test('a split into an existing past-month file that ends in a torn line does not glue a row to it; a row whose ts is no date is damaged, never a throw', async () => {
  const h = setup()
  const sep = Date.UTC(2026, 8, 20)
  h.files.set(`${L}/ledger-2026-09.jsonl`, row(sep - 1000, { usd: 2 }) + '{"ts":1') // torn, no newline
  h.files.set(`${L}/ledger.jsonl`, old('2026-09-01T08:00:00') + row(sep, { usd: 4 }) + row(1e16, { usd: 9 }))
  await rotateLedger(h.host)
  expect(h.files.get(`${L}/ledger-2026-09.jsonl`)).toBe(row(sep - 1000, { usd: 2 }) + '{"ts":1\n' + row(sep, { usd: 4 }))
  expect(h.files.has(`${L}/ledger.jsonl`)).toBe(false) // nothing of this month: the next row creates it
  expect(h.files.has(`${L}/ledger-legacy.jsonl.rot`)).toBe(false) // no staging file is left behind
  expect(h.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-09-01T08:00:00') + row(1e16, { usd: 9 })) // the damaged row stays with the old ones
  expect((await syncRollup(h.host)).bad).toBeGreaterThan(0) // counted as bad, no exception
})

test('a rule-load log over 4 MiB is read from its tail, not reported as absent', async () => {
  const h = setup()
  const filler = JSON.stringify({ ts: 1_700_000_000, rule: 'x.md', project: 'other', session: 's'.repeat(40), agent: '' }) + '\n'
  const mine = JSON.stringify({ ts: 1_700_000_001, rule: 'api.md', project: 'p', session: 's1', agent: '' }) + '\n'
  h.files.set(`${L}/logs/rules-loaded.jsonl`, filler.repeat(40_000) + mine) // about 4.4 MB
  h.files.set(`${L}/p/rules/api.md`, '# api\n')
  const read = h.host.fs.read
  h.host.fs.read = async (path: string) => { if (path.endsWith('rules-loaded.jsonl')) throw new Error('too large'); return read(path) }
  const s = await rulesStats(h.host, 'p')
  expect(s.loaded['api.md']).toBe(1) // the newest rows come from the tail
  expect(s.verified).toBe(true)
  // a rule with no recorded load is NOT "never loaded" for sure: the part of the log that was not read may hold its loads
  h.files.set(`${L}/p/rules/old.md`, '# old\n')
  const t = await rulesStats(h.host, 'p')
  expect(t.never).toContain('old.md')
  expect(t.neverConfirmed).not.toContain('old.md')
  // a log that really is absent is still "unverified"
  const g = setup()
  g.files.set(`${L}/p/rules/api.md`, '# api\n')
  expect((await rulesStats(g.host, 'p')).events).toBe(0)
})

test('an interrupted split is retried without a duplicate: rows already in ledger.jsonl are not appended twice', async () => {
  const h = setup()
  // a crash after the 1.0 row was appended to ledger.jsonl and before the legacy file was rewritten
  h.files.set(`${L}/ledger-legacy.jsonl`, old('2026-11-10T08:00:00') + row(NOON - 5000, { usd: 5 }))
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { usd: 7 }) + row(NOON - 5000, { usd: 5 }))
  await rotateLedger(h.host)
  expect(h.files.get(`${L}/ledger.jsonl`)).toBe(row(NOON, { usd: 7 }) + row(NOON - 5000, { usd: 5 })) // not twice
  expect(h.files.get(`${L}/ledger-legacy.jsonl`)).toBe(old('2026-11-10T08:00:00'))
  const ro = await syncRollup(h.host)
  expect(ro.rows).toBe(3)
  expect(ro.days[dayOf(NOON)]!.t[0]).toBe(12)
})

test('a ledger over 4 MiB: fs.read rejects, the whole text still comes from tail -c +1 (a rebuilt rollup is not empty)', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(NOON) + row(NOON, { usd: 2 }))
  const read = h.host.fs.read
  h.host.fs.read = async (p: string) => { if (p.endsWith('ledger.jsonl')) throw new Error('too large'); return read(p) }
  const ro = await syncRollup(h.host)
  expect(ro.rows).toBe(2)
  expect(ro.days[dayOf(NOON)]!.t[0]).toBe(3)
})

test('rotation: a file that starts in a past month moves to ledger-YYYY-MM.jsonl; the current month stays', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(Date.UTC(2026, 9, 30)) + row(NOON))
  expect((await rotateLedger(h.host))[0]).toContain('ledger-2026-10.jsonl')
  expect(h.files.get(`${L}/ledger-2026-10.jsonl`)).toContain('"ts":' + Date.UTC(2026, 9, 30))
  h.files.set(`${L}/ledger.jsonl`, row(NOON))
  expect(await rotateLedger(h.host)).toEqual([])
  expect(h.files.has(`${L}/ledger.jsonl`)).toBe(true)
  expect((await syncRollup(h.host)).rows).toBe(3)
})

test('stats text: spend today and 7 days, caps, tables by model / role x model / role / agent / thread with top 10 + rest, ledger line', async () => {
  const h = setup()
  let ledger = ''
  for (let i = 0; i < 12; i++) ledger += row(NOON - 1000, { tN: `t${i}`, usd: i + 1 }) // 12 threads
  ledger += row(NOON, { role: 'desk', tN: undefined, model: 'claude-opus-5-5', usd: 20 })
  ledger += row(NOON - 3 * DAY, { agent: 'lean-agent:worker-haiku', model: 'claude-haiku-5-5', usd: 0.25 })
  ledger += row(NOON - 30 * DAY, { usd: 1000 }) // outside 7 days
  ledger += old('2026-11-16T09:00:00') + '{damaged\n'
  h.files.set(`${L}/ledger.jsonl`, ledger)
  h.files.set(`${L}/config.json`, JSON.stringify({ dailyCapUsd: { desk: 25, thread: 100 } }))
  const t = await statsText(h.host)
  expect(t.split('\n')[0]).toBe('lean-agent stats: last 7 day(s) to 2026-11-18')
  expect(t).toContain('spend: today $98.00 (13 req) · 7d $98.75 (15 req)')
  expect(t).toContain('caps today: desk $20.00 of $25.00 · thread $78.00 of $100.00 · plain $0.00 of no cap')
  expect(t).toContain('daily: 11-12 $0.00 · 11-13 $0.00 · 11-14 $0.00 · 11-15 $0.25 · 11-16 $0.50 · 11-17 $0.00 · 11-18 $98.00')
  expect(t).toContain('by model (7d):\n  claude-sonnet-5-5  $78.00  12 req  in 12.0k out 1.2k cache r 60.0k w 2.4k\n  claude-opus-5-5  $20.00  1 req')
  expect(t).toContain('  thread / claude-sonnet-5-5  $78.00')
  expect(t).toContain('  desk / claude-opus-5-5  $20.00')
  expect(t).toContain('by role (7d):')
  expect(t).toMatch(/  unknown {2}\$0\.50/) // the 0.45 row: role unknown
  expect(t).toContain('  worker-haiku  $0.25')
  expect(t).toContain('  t11  $12.00') // the biggest thread first
  expect(t).toContain('(+3 more)') // 13 thread keys (12 + "-" + t9 of the old row = 14 keys, 10 shown)
  expect(t).toContain('ledger: 16 row(s) in 1 file(s), 1 pre-1.0 (0.45: cost_usd, no role), 1 unparsable line(s) skipped')
  expect(t).toContain('worker feedback (feedback.jsonl): 0 row(s)')
  // a one-day window and a bad value
  expect((await statsText(h.host, { days: 1 })).split('\n')[0]).toBe('lean-agent stats: last 1 day(s) to 2026-11-18')
  expect((await statsText(h.host, { days: -3 })).split('\n')[0]).toContain('last 7 day(s)')
  expect(await spendLine(h.host)).toBe('$98.00 · 7d $98.75')
})

test('stats shows rule loads per project (_project.md counted), worker feedback and gaps from the 1.0 files, and 0.45 leftovers', async () => {
  const h = setup()
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  h.files.set(`${L}/proj/rules/billing.md`, '# b\n- x\n')
  h.files.set(`${L}/proj/rules/api.md`, '# a\n- x\n')
  h.files.set(`${L}/proj/rules/_project.md`, '# p\n- x\n')
  h.files.set(`${L}/logs/rules-loaded.jsonl`, [1, 2].map(ts => JSON.stringify({ ts, e: { file_path: '/repo/.claude/rules/lean-agent/_project.md', load_reason: 'session_start' } })).join('\n') + '\n' + JSON.stringify({ ts: 3, e: { file_path: '/repo/.claude/rules/lean-agent/billing.md', load_reason: 'path_glob_match' } }) + '\n')
  h.files.set(`${L}/feedback.jsonl`, JSON.stringify({ status: 'done', missing: true, refused: 2 }) + '\n' + JSON.stringify({ status: 'partial' }) + '\n')
  h.files.set(`${L}/gaps.jsonl`, '{}\n')
  h.files.set(`${L}/proj/gaps.jsonl`, '{}\n{}\n')
  h.files.set(`${L}/feedback/feedback.jsonl`, '{}\n')
  h.files.set(`${L}/work/r1/gaps.json`, '{}')
  const t = await statsText(h.host)
  expect(t).toContain('rules proj: 3 rule(s), 2 loaded at least once (3 loads); never loaded since they were written: api.md')
  expect(t).toContain('worker feedback (feedback.jsonl): 2 row(s) · done 1, partial 1 · 1 with missing context · 2 refused command(s)')
  expect(t).toContain('gaps (gaps.jsonl): 3 (proj 2)')
  expect(t).toContain('0.45 leftovers, not counted: feedback/')
  expect(await statsText(h.host, { project: 'proj' })).toContain('rules proj:')
})

test('rule loads: the shell hook and the mod handler log the same event once; both count; _project.md is listed', async () => {
  const h = setup()
  h.files.set(`${L}/proj/rules/billing.md`, '# b\n')
  h.files.set(`${L}/proj/rules/_project.md`, '# p\n')
  const ev = { file_path: '/r/.claude/rules/lean-agent/billing.md', load_reason: 'path_glob_match', trigger_file_path: '/r/a.ts' }
  expect(await logRuleLoad(h.host, ev)).toBe(true) // ts = seconds, as the shell hook writes it
  const sec = Math.floor(NOON / 1000)
  h.files.set(`${L}/logs/rules-loaded.jsonl`, h.files.get(`${L}/logs/rules-loaded.jsonl`)! + JSON.stringify({ ts: sec, e: ev }) + '\n') // the shell hook, same second
  expect(await logRuleLoad(h.host, { file_path: '/r/.claude/rules/mine.md' })).toBe(false)
  expect(await rulesStats(h.host, 'proj')).toMatchObject({ loaded: { 'billing.md': 1 }, never: ['_project.md'], events: 1, verified: true, scriptCandidates: [] })
})

test('the engine\'s InstructionsLoaded event is logged by the mod', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.clock.t = NOON
  on('classic.InstructionsLoaded', () => ({}))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  await $.session.start({ cwd: '/somewhere', surface: 'cli', isInteractive: true } as any)
  await $.classic.InstructionsLoaded({ file_path: '/r/.claude/rules/lean-agent/_project.md', load_reason: 'session_start', memory_type: 'Project' } as any)
  await $.classic.InstructionsLoaded({ file_path: '/r/CLAUDE.md', load_reason: 'session_start' } as any)
  const log = h.files.get(`${L}/logs/rules-loaded.jsonl`)!.trim().split('\n')
  expect(log.length).toBe(1)
  expect(JSON.parse(log[0]!).e).toMatchObject({ file_path: '/r/.claude/rules/lean-agent/_project.md', load_reason: 'session_start' })
})

test('lean_doctor stats answers from the desk, in one call, without a model reading the ledger', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.clock.t = NOON
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { role: 'desk', usd: 5 }) + old('2026-11-17T10:00:00'))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'stats', days: 2 } as any)
  const t = String(r?.result ?? r)
  expect(t).toContain('lean-agent stats: last 2 day(s)')
  expect(t).toContain('spend: today $5.00 (1 req) · 2d $5.50 (2 req)')
})

test('an expensive session on a model lean-agent did not configure is named (ledger and live listing)', async () => {
  const h = setup()
  h.files.set(`${L}/ledger.jsonl`, row(NOON, { role: 'desk', model: 'claude-opus-5-5', usd: 7 }) + row(NOON, { role: 'desk', model: 'claude-sonnet-5-5', usd: 1 }) + row(NOON, { role: 'thread', model: 'claude-opus-5-5', usd: 4 }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', model: 'sonnet', sid: 'S1' }))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: 'S1', status: 'busy', model: 'claude-opus-5-5', cwd: '/x' }, { sessionId: 'D', status: 'busy', model: 'claude-opus-5-5', cwd: '/h/lean-agent-desk' }]) } : { exitCode: 0, stdout: '' })
  const odd = await modelMismatches(h.host)
  expect(odd.some(l => l.startsWith('the desk spent $7.00 today on claude-opus-5-5, lean-agent pins sonnet'))).toBe(true)
  expect(odd.some(l => l.startsWith('threads spent $4.00 today on claude-opus-5-5'))).toBe(true)
  expect(odd).toContain('live session t1 runs claude-opus-5-5, lean-agent started it on sonnet')
  expect(odd).toContain('the live desk session runs claude-opus-5-5, lean-agent pins sonnet')
  const ok = setup()
  ok.files.set(`${L}/ledger.jsonl`, row(NOON, { role: 'desk', usd: 1 }))
  ok.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  expect(await modelMismatches(ok.host)).toEqual([])
})

test('a 50,000-row ledger folds within a time budget and the next sync reads nothing', async () => {
  const h = setup()
  const parts: string[] = []
  for (let i = 0; i < 50_000; i++) parts.push(row(NOON - (i % 5) * DAY, { tN: `t${i % 40}`, agent: i % 3 ? 'lean-agent:worker-haiku' : undefined, usd: 0.001 }))
  h.files.set(`${L}/ledger.jsonl`, parts.join(''))
  const t0 = Date.now()
  const ro = await syncRollup(h.host)
  const text = await statsText(h.host)
  const ms = Date.now() - t0
  expect(ro.rows).toBe(50_000)
  expect(text).toContain('(50000 req)')
  expect(ms).toBeLessThan(5000)
  const t1 = Date.now()
  await syncRollup(h.host)
  await statsText(h.host)
  expect(Date.now() - t1).toBeLessThan(1000)
})

test('a recorded row leaves out zero token counts and is still read', async () => {
  const h = setup()
  await record(h.host, { role: 'desk' }, 'sonnet', { output_tokens: 1000 })
  const line = h.files.get(`${L}/ledger.jsonl`)!.trim()
  expect(JSON.parse(line)).toEqual({ ts: NOON, role: 'desk', model: 'sonnet', out: 1000, usd: 0.015 })
  expect((await syncRollup(h.host)).days[dayOf(NOON)]!.t.slice(0, 3)).toEqual([0.015, 0, 1000])
})
