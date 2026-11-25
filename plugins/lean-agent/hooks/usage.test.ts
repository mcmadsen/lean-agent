// Usage tokens (usage.ts, formatusage.ts): the one weighted function, the current-window scope (from the windows.json snapshot, else a rolling 5 h), the all-time scope (budget.since,
// the reset), the optional caps that hold new work, the words of the pane. Synthetic ledgers: input tokens only unless a row says otherwise.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { DEFAULT_WEIGHTS, WINDOW_MS, allTimeUsage, capReached, kindOf, parseSince, rawOfAgg, rawOfRow, rawOfUsage, splitRows, tokenCaps, usageTokens, weightsFrom, weightsOf, windowInfo, windowUsage } from './usage'
import { cardBadge, cardText, closedText, deskText, fmtTokens, foldedText, headerText, parseTokenCount } from './formatusage'
import { syncRollup } from './ledger'
import { agentWindowDenial, newWorkGate, reviewWindowGate, throttleLine, windowState } from './throttle'
import { configTool } from './configtool'
import { statsText } from './stats'
import { threadCostsToday } from './stats'
import { decide } from './guard'

const L = '/h/.lean-agent'
const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18, 12)
const row = (o: Record<string, unknown> = {}) => JSON.stringify({ ts: NOW - 60_000, role: 'thread', tN: 't1', agent: 'main', model: 'claude-sonnet-5-5', in: 1000, usd: 0.5, ...o })
const ledger = (h: ReturnType<typeof fakeHost>, rows: Record<string, unknown>[]) => h.files.set(`${L}/ledger.jsonl`, rows.map(r => row(r)).join('\n') + '\n')
const snap = (h: ReturnType<typeof fakeHost>, five: number, resetsAt: number, seven = 65) =>
  h.files.set(`${L}/desk/windows.json`, JSON.stringify({ v: 1, at: NOW, windows: [{ kind: 'five_hour', percentUsed: five, resetsAt }, { kind: 'seven_day', percentUsed: seven, resetsAt: NOW + 48 * HOUR }] }))
const cfg = (h: ReturnType<typeof fakeHost>, o: unknown) => h.files.set(`${L}/config.json`, JSON.stringify(o))
function home() {
  const h = fakeHost(null)
  h.clock.t = NOW
  for (const id of ['t1', 't2']) h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, state: 'open', sid: `s${id}`, model: 'sonnet', effort: 'medium', created: NOW - 30 * DAY }))
  return h
}

test('usageTokens: input + 1.25 x cache write + 0.1 x cache read + 5 x output, rounded; the raw sums stay as they are', () => {
  expect(DEFAULT_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 })
  expect(usageTokens({ input: 1000, cacheWrite: 1000, cacheRead: 10_000, output: 100 })).toBe(1000 + 1250 + 1000 + 500)
  expect(usageTokens({ output: 3 })).toBe(15)
  expect(usageTokens({ cacheRead: 5 })).toBe(1) // 0.5 rounds up
  expect(usageTokens({})).toBe(0)
  expect(usageTokens(null)).toBe(0)
  expect(usageTokens({ input: 100, output: 10 }, { input: 2, cacheWrite: 0, cacheRead: 0, output: 1 })).toBe(210) // config budget.weights
  // the three places the numbers come from read the same four counts
  expect(rawOfUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(rawOfRow({ in: 1, out: 2, cr: 3, cw: 4 })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(rawOfAgg([9, 1, 2, 3, 4, 7])).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
})

test('budget.weights: a missing or bad factor keeps its default; read from config.json', async () => {
  expect(weightsFrom({ output: 3 })).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 3 })
  expect(weightsFrom({ input: -1, cacheRead: 'x' })).toEqual(DEFAULT_WEIGHTS)
  expect(weightsFrom(null)).toEqual(DEFAULT_WEIGHTS)
  const h = home()
  expect(await weightsOf(h.host)).toEqual(DEFAULT_WEIGHTS)
  cfg(h, { budget: { weights: { cacheRead: 0 } } })
  expect(await weightsOf(h.host)).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0, output: 5 })
})

test('kindOf: the session itself, reviewers, workers, readers (explorer and auditor read only), the rest', () => {
  expect(kindOf('main')).toBe('main')
  expect(kindOf('')).toBe('main')
  expect(kindOf('lean-agent:reviewer')).toBe('reviewers')
  expect(kindOf('worker-haiku')).toBe('workers')
  expect(kindOf('reader-sonnet')).toBe('readers')
  expect(kindOf('lean-agent:explorer')).toBe('readers')
  expect(kindOf('auditor')).toBe('readers')
  expect(kindOf('Explore')).toBe('other')
})

test('the window scope from the snapshot: start = reset time - 5 h; rows before it are not in it; the engine\'s percentage and the 7 d percentage come along', async () => {
  const h = home()
  snap(h, 1, NOW + 2 * HOUR) // the window started at NOW - 3 h
  ledger(h, [
    { ts: NOW - 4 * HOUR, in: 9_000_000 }, // the window before this one
    { ts: NOW - 2 * HOUR, tN: 't1', in: 1000, out: 100 }, // 1500
    { ts: NOW - 1 * HOUR, tN: 't2', agent: 'reviewer', agentId: 'a1', in: 2000 },
    { ts: NOW - 30 * 60_000, role: 'desk', tN: undefined, in: 500, cache_read: 10_000 }, // 1500
  ])
  const info = await windowInfo(h.host)
  expect(info).toMatchObject({ start: NOW - 3 * HOUR, resetsAt: NOW + 2 * HOUR, pct: 1, weekPct: 65, rolling: false })
  const u = await windowUsage(h.host)
  expect(u.total.tokens).toBe(1500 + 2000 + 1500)
  expect(u.total.raw).toEqual({ input: 3500, output: 100, cacheRead: 10_000, cacheWrite: 0 })
  expect(u.total.requests).toBe(3)
  expect(u.byRole.desk!.tokens).toBe(1500)
  expect(u.byKind.reviewers!.tokens).toBe(2000)
  expect(u.byKind.main!.tokens).toBe(3000)
  expect(u.byThread.t1!.tokens).toBe(1500)
  expect(u.byThread.t2!.tokens).toBe(2000)
  expect(Object.keys(u.byThread).sort()).toEqual(['t1', 't2']) // the desk is no thread
  expect(headerText({ windowTokens: u.total.tokens, windowPct: u.pct, weekPct: u.weekPct })).toBe('window 5k tokens (1%) · 7d 65%')
})

test('the window scope falls back to a rolling 5 h when no window is known, or its reset has passed', async () => {
  const h = home()
  ledger(h, [{ ts: NOW - 6 * HOUR, in: 9_000_000 }, { ts: NOW - 4 * HOUR, in: 1000 }, { ts: NOW - 60_000, in: 2000 }])
  expect(await windowInfo(h.host)).toMatchObject({ start: NOW - WINDOW_MS, rolling: true, pct: null, resetsAt: 0 }) // no windows.json
  expect((await windowUsage(h.host)).total.tokens).toBe(3000)
  snap(h, 90, NOW - HOUR) // the reset time is past: the window the snapshot describes is over
  expect(await windowInfo(h.host)).toMatchObject({ rolling: true, pct: null, weekPct: 65 })
  expect((await windowUsage(h.host)).total.tokens).toBe(3000)
  expect(headerText({ windowTokens: 3000, windowPct: null, weekPct: 65, rolling: true })).toBe('last 5h 3k tokens · 7d 65%')
  expect(foldedText({ windowTokens: 3000, windowPct: null, weekPct: null, rolling: true })).toBe('last 5h 3k tokens')
})

test('the all-time scope: from the first usage by default; budget.since (a day, or a moment) moves it; "today" starts again and the rows before are not counted', async () => {
  const h = home()
  ledger(h, [
    { ts: NOW - 40 * DAY, in: 1000 },
    { ts: NOW - 10 * DAY, in: 2000, tN: 't2' },
    { ts: NOW - 2 * HOUR, in: 4000, role: 'desk', tN: undefined },
    { ts: NOW - 60_000, in: 8000 },
  ])
  const a = await allTimeUsage(h.host)
  expect(a.total.tokens).toBe(15_000)
  expect(a.fromConfig).toBe(false)
  expect(a.first).toBe('2026-10-09')
  expect(a.byRole.desk!.tokens).toBe(4000)
  expect(a.byThread.t1!.tokens).toBe(9000)
  cfg(h, { budget: { since: '2026-11-01' } })
  expect((await allTimeUsage(h.host)).total.tokens).toBe(14_000)
  cfg(h, { budget: { since: new Date(NOW - HOUR).toISOString() } }) // a moment inside today: only what came after
  const m = await allTimeUsage(h.host)
  expect(m.total.tokens).toBe(8000)
  expect(m.fromConfig).toBe(true)
  cfg(h, { budget: { since: 'garbage' } }) // not a date: the default
  expect((await allTimeUsage(h.host)).total.tokens).toBe(15_000)
  // lean_config set budget.since today (and the doctor action): a moment, now
  cfg(h, {})
  const r = await configTool(h.host, { action: 'set', key: 'budget.since', value: 'today' })
  expect(r.ok).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/config.json`)!).budget.since).toBe(new Date(NOW).toISOString().replace(/\.\d+Z$/, 'Z'))
  expect((await allTimeUsage(h.host)).total.tokens).toBe(0)
  ledger(h, [{ ts: NOW - 40 * DAY, in: 1000 }, { ts: NOW + 60_000, in: 500 }])
  h.clock.t = NOW + 120_000
  expect((await allTimeUsage(h.host)).total.tokens).toBe(500)
  expect(parseSince('2026-02-30')).toBeNull()
  expect(parseSince('2026-11-18T09:14:00Z')).toBe(Date.UTC(2026, 10, 18, 9, 14))
})

test('days past the rollup\'s 120 are folded into one total that all time still counts (the start on or before it); a later start leaves it out', async () => {
  const h = home()
  // 125 days with one request of 10 tokens each: the oldest 5 are past the 120 the rollup keeps per day
  ledger(h, Array.from({ length: 125 }, (_, i) => ({ ts: NOW - (124 - i) * DAY - 60_000, in: 10 })))
  const ro = await syncRollup(h.host, NOW)
  expect(ro.old).toMatchObject({ from: '2026-07-17', to: '2026-07-21' })
  expect(ro.old!.t[1]).toBe(50)
  expect(Object.keys(ro.days).length).toBe(120)
  const a = await allTimeUsage(h.host)
  expect(a.total.tokens).toBe(1250)
  expect(a.first).toBe('2026-07-17')
  cfg(h, { budget: { since: '2026-11-01' } })
  expect((await allTimeUsage(h.host)).total.tokens).toBe(180) // 18 days from the 1st: the folded block is left out
})

test('the optional caps: none by default; windowTokens and allTimeTokens are reached at their number', async () => {
  const h = home()
  snap(h, 20, NOW + 2 * HOUR)
  ledger(h, [{ ts: NOW - 40 * DAY, in: 500_000 }, { ts: NOW - HOUR, in: 400_000 }])
  expect(await tokenCaps(h.host)).toEqual([])
  expect(await capReached(h.host)).toBeNull()
  cfg(h, { budget: { windowTokens: 400_001, allTimeTokens: 2_000_000 } })
  expect((await tokenCaps(h.host)).map(c => `${c.scope} ${c.used}/${c.cap}`)).toEqual(['window 400000/400001', 'allTime 900000/2000000'])
  expect(await capReached(h.host)).toBeNull()
  cfg(h, { budget: { windowTokens: 400_000, allTimeTokens: 2_000_000 } })
  expect(await capReached(h.host)).toMatchObject({ scope: 'window', used: 400_000 })
  cfg(h, { budget: { windowTokens: 0, allTimeTokens: 900_000 } }) // 0 = none; the all-time cap is reached
  expect(await capReached(h.host)).toMatchObject({ scope: 'allTime', key: 'budget.allTimeTokens' })
})

test('a reached token cap holds new work like window.capFiveHourPct: the guard, the desk, the review prepare, the park tick; raising it lifts it; the % path is unchanged', async () => {
  const h = home()
  h.files.set('/plug/agents/worker-haiku.md', '---\nname: worker-haiku\nmodel: haiku\n---\nbody\n')
  snap(h, 20, NOW + 2 * HOUR)
  ledger(h, [{ ts: NOW - HOUR, in: 600_000 }])
  cfg(h, { budget: { windowTokens: 500_000 } })
  const s = await windowState(h.host)
  expect(s).toMatchObject({ level: 'capped', pct: 20, tokenCap: { scope: 'window', cap: 500_000, used: 600_000 } })
  const denial = await agentWindowDenial(h.host, 'haiku', true)
  expect(denial).toContain('your cap of 500k usage tokens (budget.windowTokens) is reached (600k used)')
  expect(denial).toContain('until the window resets')
  expect((await newWorkGate(h.host, 'urgent')).refuse).toContain('your cap of 500k usage tokens (budget.windowTokens)')
  expect((await reviewWindowGate(h.host, 't1')).stop).toContain('prepare: NOT started: your cap of 500k usage tokens')
  expect(await throttleLine(h.host)).toContain('all new work is held until the window resets')
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', root: '/plug' }, e)
  expect(await run({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x', description: 'd' })).toContain('budget.windowTokens')
  cfg(h, { budget: { windowTokens: 700_000 } })
  expect((await windowState(h.host)).level).toBe('ok')
  expect(await agentWindowDenial(h.host, 'sonnet', false)).toBeNull()
  // the all-time cap: held until it is raised or the start moves
  cfg(h, { budget: { allTimeTokens: 500_000 } })
  expect(await agentWindowDenial(h.host, 'haiku', true)).toContain('until you raise budget.allTimeTokens or start again (lean_config set budget.since today)')
  cfg(h, { budget: { allTimeTokens: 500_000, since: new Date(NOW).toISOString() } })
  expect((await windowState(h.host)).level).toBe('ok')
  // no snapshot: the cap still holds on the rolling 5 h
  h.files.delete(`${L}/desk/windows.json`)
  cfg(h, { budget: { windowTokens: 500_000 } })
  expect((await agentWindowDenial(h.host, 'haiku', true))).toContain('reset time unknown') // (no snapshot: no percentage and no reset time to quote)
})

test('formatusage: 950, 9.5k, 48k, 2.1M, 1.2G; headers, cards, the sort badge, typed amounts', () => {
  expect([0, 950, 1000, 9500, 48_000, 999_999, 1_000_000, 2_100_000, 12_300_000, 1_200_000_000].map(fmtTokens)).toEqual(['0', '950', '1k', '9.5k', '48k', '1M', '1M', '2.1M', '12.3M', '1.2G'])
  expect(fmtTokens(-5)).toBe('0')
  expect(fmtTokens(NaN)).toBe('0')
  expect(headerText({ windowTokens: 1_200_000, windowPct: 1, weekPct: 65 })).toBe('window 1.2M tokens (1%) · 7d 65%')
  expect(headerText({ windowTokens: 1_200_000, windowPct: null, weekPct: null })).toBe('window 1.2M tokens')
  expect(headerText(null)).toBe('usage n/a')
  expect(foldedText({ windowTokens: 1_200_000, windowPct: 1, weekPct: 65 })).toBe('1.2M tokens')
  expect(deskText({ windowTokens: 48_000, windowPct: 3, weekPct: 4 })).toBe('window 48k tokens')
  expect(cardBadge({ tokens: 48_000, over: false })).toBe('48k')
  expect(cardBadge({ tokens: 2_100_000, over: true })).toBe('2.1M!')
  expect(cardText({ tokens: 48_000 })).toBe('window 48k tokens')
  expect(cardText({ tokens: 48_000, reviews: 12_000, restarts: 3000 })).toBe('window 48k tokens (reviews 12k, restarts 3k)')
  expect(cardText({ tokens: 48_000, main: 20_000, workers: 16_000, reviews: 12_000, restarts: 3000 }, true)).toBe('window 48k tokens (main 20k · workers 16k · reviews 12k, restarts 3k)')
  expect(closedText(5000)).toBe('window 5k tokens')
  expect(['2m', '500k', '1.5M', '250000', '48 000', '2 m', '2m tokens', 'x', '', '-3'].map(parseTokenCount)).toEqual([2_000_000, 500_000, 1_500_000, 250_000, 48_000, 2_000_000, 2_000_000, null, null, null])
})

test('the cards: a thread\'s window usage with its reviews and restarts, "!" over its soft budget; nothing for a thread that used nothing; the desk is not a thread', async () => {
  const h = home()
  snap(h, 5, NOW + 3 * HOUR)
  ledger(h, [
    { tN: 't1', in: 30_000 },
    { tN: 't1', agent: 'reviewer', agentId: 'r1', in: 10_000 },
    { tN: 't1', fresh: true, in: 3000, ts: NOW - 30 * 60_000 }, // the first request of a restarted session
    { role: 'desk', tN: undefined, in: 5_000_000 },
  ])
  cfg(h, { threads: { softTokens: 40_000 } })
  const c = await threadCostsToday(h.host)
  expect(Object.keys(c)).toEqual(['t1'])
  expect(c.t1).toMatchObject({ id: 't1', tokens: 43_000, model: 'sonnet', effort: 'medium', over: true, reviews: 10_000, restarts: 3000, main: 33_000, workers: 0 })
  cfg(h, {})
  expect((await threadCostsToday(h.host)).t1!.over).toBe(false) // no budget by default
  expect(await threadCostsToday(fakeHost(null).host)).toEqual({}) // no ledger
})

test('lean_doctor stats: usage tokens (weighted, with the raw sums), the window with its percentage, all time, the kinds, the caps; no dollar figure unless stats.showUsd', async () => {
  const h = home()
  snap(h, 12, NOW + 2 * HOUR)
  ledger(h, [
    { tN: 't1', in: 1000, out: 100, cache_read: 10_000, cache_write: 1000, usd: 1.25 },
    { tN: 't2', agent: 'reviewer', agentId: 'r1', in: 2000, usd: 2.5 },
    { role: 'desk', tN: undefined, in: 500, usd: 0.75 },
  ])
  const text = await statsText(h.host, { days: 1 })
  expect(text).toContain('usage (weighted tokens): today 6.3k (3 req)')
  expect(text).toContain('window: 6.3k tokens (12% of the window), 3 req, since 09:00Z (resets 14:00Z) · raw in 3.5k out 100 cache r 10.0k w 1.0k')
  expect(text).toContain('window by kind: main 4.3k · reviewers 2k')
  expect(text).toContain('window by thread: t1 3.8k · t2 2k')
  expect(text).toContain('all time since 2026-11-18 (the first usage;')
  expect(text).toContain('token caps (optional; the window percentages are the main control): window 6.3k of none · all time 6.3k of none · per thread soft none, hard none')
  expect(text).not.toContain('$')
  expect(text).not.toContain('estimated cost')
  cfg(h, { stats: { showUsd: true }, budget: { windowTokens: 10_000 } })
  const withUsd = await statsText(h.host, { days: 1 })
  expect(withUsd).toContain('estimated cost (API list prices, not what a plan charges): today $4.50')
  expect(withUsd).toContain('window 6.3k of 10k')
  expect(withUsd.split('\n').filter(l => l.includes('$'))).toHaveLength(1) // the ONE dollar line
})

test('budget.weights moves the stats and the windows the same way', async () => {
  const h = home()
  snap(h, 12, NOW + 2 * HOUR)
  ledger(h, [{ tN: 't1', in: 1000, out: 100 }])
  expect((await windowUsage(h.host)).total.tokens).toBe(1500)
  cfg(h, { budget: { weights: { output: 1 } } })
  expect((await windowUsage(h.host)).total.tokens).toBe(1100)
  expect((await allTimeUsage(h.host)).total.tokens).toBe(1100)
})

test('splitRows: a desk or plain row never counts for a thread, whatever its tN says; a row from before the thread was created is an earlier holder\'s', () => {
  const rows = [
    { ts: 10, role: 'desk', tN: 't1', agent: 'main', model: 'm', in: 100, out: 0, cr: 0, cw: 0, usd: 0, legacy: false },
    { ts: 20, role: 'thread', tN: 't1', agent: 'main', model: 'm', in: 7, out: 0, cr: 0, cw: 0, usd: 0, legacy: false },
    { ts: 5, role: 'thread', tN: 't1', agent: 'main', model: 'm', in: 1000, out: 0, cr: 0, cw: 0, usd: 0, legacy: false },
  ]
  const s = splitRows(rows as any, DEFAULT_WEIGHTS, { t1: 8 })
  expect(s.byThread.t1!.tokens).toBe(7)
  expect(s.total.tokens).toBe(1107)
})
