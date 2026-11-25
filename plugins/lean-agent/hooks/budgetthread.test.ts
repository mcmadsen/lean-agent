// Per-thread context limit and the soft checkpoint size (threadcontext.ts, budgetthread.ts, budgettick.ts softCheckpointTick, the warn line), and later the per-thread
// soft budget. Synthetic numbers: an 85k thread against the 80k soft line, a limit override of 90k.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread } from './threads'
import { ctxText, limitsOf, threadLimitsFor } from './threadcontext'
import { budgetLine, budgetLevel, budgetOf, budgetText, hardOf, limitReply, parseBudget, parseTokens, threadTotals } from './budgetthread'
import { takeWarn, warnLine, warnReset } from './scratchnotes'
import { softBudgetTick, softCheckpointTick } from './budgettick'
import { decide } from './guard'
import { statsText } from './stats'

const L = '/h/.lean-agent'
const T = (id: string) => `${L}/threads/${id}`
const thread = (h: ReturnType<typeof fakeHost>, id: string, o: Record<string, unknown> = {}) =>
  h.files.set(`${T(id)}/thread.json`, JSON.stringify({ id, title: id, project: 'shop', state: 'open', sid: `s-${id}`, created: 1, lastWake: 1, delivered: 0, ...o }))

test('limitsOf: the soft line is 80% of the default 200k; a per-thread limit moves it with the same share; config keys move it; old threadWarnTokens wins', () => {
  expect(limitsOf(null)).toEqual({ limit: 200_000, warn: 160_000 })
  expect(limitsOf(null, 90_000)).toEqual({ limit: 90_000, warn: 72_000 })
  expect(limitsOf(null, 200_000)).toEqual({ limit: 200_000, warn: 160_000 })
  expect(limitsOf(null, 40_000)).toEqual({ limit: 40_000, warn: 32_000 })
  expect(limitsOf(null, 30_000)).toEqual({ limit: 200_000, warn: 160_000 }) // outside 40k-200k: ignored
  expect(limitsOf({ threads: { softCheckpointTokens: 60_000 } }, 90_000)).toEqual({ limit: 90_000, warn: 27_000 }) // an explicit soft size is scaled by the own limit's share (90k of 200k)
  expect(limitsOf({ threadWarnTokens: 100_000 })).toEqual({ limit: 200_000, warn: 100_000 })
})

test('parseTokens: 90000, 90k, off; outside 40k-200k and words are refused with the reason', () => {
  expect(parseTokens('90000')).toBe(90_000)
  expect(parseTokens('90k')).toBe(90_000)
  expect(parseTokens(' 150 K ')).toBe(150_000)
  expect(parseTokens('off')).toBeNull()
  expect(parseTokens('39999')).toContain('outside 40k-200k')
  expect(parseTokens('250000')).toContain('outside 40k-200k')
  expect(parseTokens('lots')).toContain('not a number of tokens')
  expect(parseTokens('')).toContain('needs the number of tokens')
})

test('lean_thread limit tN <tokens>: stored on the thread, survives a restart (thread.json), read by threadLimitsFor; off removes it; the list shows ctx against it', async () => {
  const h = fakeHost(null)
  thread(h, 't1')
  const r = await leanThread(h.host, '/plug', { action: 'limit', tN: 't1', text: '90k' })
  expect(r).toMatchObject({ ok: true })
  expect(r.text).toContain('own context limit 90k (hard)')
  expect(r.text).toContain('checkpoint at 72k (soft)')
  expect(JSON.parse(h.files.get(`${T('t1')}/thread.json`)!).tokenLimit).toBe(90_000)
  expect(await threadLimitsFor(h.host, 't1')).toEqual({ limit: 90_000, warn: 72_000 })
  expect(await threadLimitsFor(h.host, 't2')).toEqual({ limit: 200_000, warn: 160_000 }) // another thread: the shared limits
  expect((await leanThread(h.host, '/plug', { action: 'limit', tN: 't1', text: '300000' })).ok).toBe(false)
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 85_000, at: h.clock.t, sid: 's-t1' }))
  const list = await leanThread(h.host, '/plug', { action: 'list', verbose: true })
  expect(list.text).toContain('ctx 85k/90k · soft limit 72k')
  expect(limitReply('t1', null, {})).toContain('shared limit applies again')
  const off = await leanThread(h.host, '/plug', { action: 'limit', tN: 't1', text: 'off' })
  expect(off.ok).toBe(true)
  expect(JSON.parse(h.files.get(`${T('t1')}/thread.json`)!).tokenLimit).toBeUndefined()
  const back = (await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text
  expect(back).toContain('ctx 85k/200k') // the shared limit (1.0.35: 200k): 85k is under its 160k soft line
  expect(back).not.toContain('soft limit')
})

test('ctxText stays "ctx 85k/200k" (the card); the list adds "soft limit 160k" once the size is over it', async () => {
  expect(ctxText(85_000, { limit: 200_000, warn: 160_000 })).toBe('ctx 85k/200k')
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 150_000, at: h.clock.t, sid: 's-t1' }))
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).not.toContain('soft limit')
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 170_000, at: h.clock.t, sid: 's-t1' }))
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).toContain('ctx 170k/200k · soft limit 160k')
})

test('the warn line moves with the per-thread limit: told once at the soft size, "next natural boundary", the checkpoint call', () => {
  warnReset()
  const own = limitsOf(null, 90_000) // soft 72k
  expect(takeWarn('s1', 72_000, own)).toBeNull()
  const line = takeWarn('s1', 73_000, own)!
  expect(line).toBe(warnLine(73_000, 90_000, 72_000))
  expect(line).toContain('(soft limit 72k)')
  expect(line).toContain('at your next natural boundary')
  expect(line).toContain('lean_run checkpoint {next:')
  expect(takeWarn('s1', 74_000, own)).toBeNull() // once
  expect(takeWarn('s2', 159_000, limitsOf(null))).toBeNull() // the shared 160k line
  expect(takeWarn('s2', 165_000, limitsOf(null))).toContain('ctx 165k of 200k (soft limit 160k)')
})

test('softCheckpointTick: an idle thread with work left over its soft size is checkpointed by script once per session; working, waiting, under the line and an own bigger limit are left', async () => {
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, JSON.stringify({ threadTokens: 120_000 })) // (soft line 96k; the default 200k limit has no own limit above it any more)
  const ctx = (id: string, tokens: number, ago = 600_000) => h.files.set(`${T(id)}/context.json`, JSON.stringify({ tokens, at: h.clock.t - ago, sid: `s-${id}` }))
  thread(h, 't1'); ctx('t1', 100_000)
  thread(h, 't2'); ctx('t2', 100_000)
  thread(h, 't3'); ctx('t3', 70_000)
  thread(h, 't4', { tokenLimit: 200_000 }); ctx('t4', 100_000)
  thread(h, 't5'); ctx('t5', 100_000, 30_000) // its turn ended 30 s ago
  thread(h, 't6'); ctx('t6', 100_000)
  const rows = [t('t1', 'idle'), t('t2', 'working'), t('t3', 'idle'), t('t4', 'idle'), t('t5', 'idle'), t('t6', 'idle')]
  function t(id: string, state: string) { return { sid: `s-${id}`, name: id, cwd: '', status: state === 'working' ? 'busy' : 'idle', startedAt: 0, pid: state === 'working' ? 1 : 0, id: `a-${id}`, state, waitingFor: '' } }
  h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: h.clock.t - 400_000, from: 't6', kind: 'report', state: 'done', text: 'done' }) + '\n')
  const calls: { action: string; tN: string; reason?: string }[] = []
  const deps = { agents: async () => rows as any, thread: async (i: any) => (calls.push(i), { ok: true, text: 'restarted', data: { fresh: true } }) }
  const notes = await softCheckpointTick(h.host, deps)
  expect(calls.map(c => `${c.action} ${c.tN}`)).toEqual(['auto-restart t1'])
  expect(calls[0]!.reason).toContain('over the soft checkpoint size 96000')
  expect(notes).toEqual(['t1: context 100k passed the soft checkpoint size 96k while idle: checkpointed and restarted as a new session by script'])
  expect(await softCheckpointTick(h.host, deps)).toEqual([]) // once per session (and the 10 minute gap)
  expect(calls).toHaveLength(1)
})

// ---- the soft budget in usage tokens ----------------------------------------------------------------------------------------------------------
// A busy day: the desk 144 requests, one thread 530 requests, the other threads 636 requests. One request here is 1000 input tokens (usage token weight 1).
const row = (o: Record<string, unknown>) => JSON.stringify({ ts: 1_000_000, role: 'thread', model: 'claude-sonnet-5-5', in: 1000, usd: 0.01, ...o })
function busyDay(h: ReturnType<typeof fakeHost>) {
  const rows: string[] = []
  for (let i = 0; i < 144; i++) rows.push(row({ role: 'desk' }))
  for (let i = 0; i < 530; i++) rows.push(row({ tN: 't1' }))
  for (let i = 0; i < 636; i++) rows.push(row({ tN: i % 2 ? 't2' : 't3' }))
  h.files.set(`${L}/ledger.jsonl`, rows.join('\n') + '\n')
}

test('threadTotals / budgetOf / budgetLine on the busy day: the 530-request thread is over a 400k budget, the desk is in no thread, the others are not', async () => {
  const h = fakeHost(null)
  busyDay(h)
  thread(h, 't1'); thread(h, 't2'); thread(h, 't3', { budgetTokens: 0 })
  const totals = await threadTotals(h.host)
  expect(totals.t1).toBe(530_000)
  expect((totals.t2 ?? 0) + (totals.t3 ?? 0)).toBe(636_000) // the desk's 144k is in neither
  expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(1_166_000) // the three threads, not the 1.31M of the whole day
  expect(await budgetOf(h.host, {})).toBeNull() // default: none
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 400_000 } }))
  expect(await budgetOf(h.host, {})).toBe(400_000)
  expect(await budgetOf(h.host, { budgetTokens: 0 })).toBeNull() // 0 = none for this thread
  expect(await budgetOf(h.host, { budgetTokens: 125_000 })).toBe(125_000)
  expect(budgetText(530_000, 400_000)).toBe('530k/400k tokens')
  expect(budgetText(6400, 8000)).toBe('6.4k/8k tokens')
  expect(budgetLevel(6400, 8000)).toBe('near')
  expect(budgetLevel(6390, 8000)).toBe('ok')
  expect(budgetLevel(8000, 8000)).toBe('over')
  expect(await budgetLine(h.host)).toBe('thread budgets (80% or more used; threads.softTokens 400k): t1 530k/400k tokens!') // (t2 is at 79%: under 80%; t3 has budget 0 = none)
})

test('a thread\'s figure is ITS OWN: two threads and a desk in one store, a thread that just started shows about 0, a read-only thread started minutes ago cannot exceed its own usage', async () => {
  const h = fakeHost(null)
  const NOW = 10 * 86_400_000
  h.clock.t = NOW
  thread(h, 't1', { created: NOW - 3 * 86_400_000 }) // an old, busy thread
  thread(h, 't2', { created: NOW - 600_000 }) // a read-only diagnosing thread started 10 minutes ago
  thread(h, 't3', { created: NOW - 5_000 }) // started 5 seconds ago, has not made a request yet
  const rows = [
    ...Array.from({ length: 50 }, () => row({ ts: NOW - 86_400_000, role: 'desk', in: 1_000_000 })), // the desk used 50M today and yesterday
    ...Array.from({ length: 30 }, () => row({ ts: NOW - 3_600_000, tN: 't1', in: 100_000 })), // t1: 3M
    ...Array.from({ length: 5 }, () => row({ ts: NOW - 300_000, tN: 't2', agent: 'main', in: 4000, out: 200 })), // t2: 5 x (4000 + 5 x 200) = 25k
    row({ ts: NOW - 200_000, tN: 't2', agentId: 'a1', agent: 'reader-haiku', in: 2000 }), // its subagent: counts for t2
    row({ ts: NOW - 100_000, role: 'plain', in: 9_000_000 }), // a plain session
    row({ ts: NOW - 90_000, role: 'desk', tN: 't2', in: 7_000_000 }), // a desk row that carries a thread id by mistake: still the desk's, never t2's
    row({ ts: NOW - 80_000, role: 'plain', tN: 't1', in: 6_000_000 }),
  ]
  h.files.set(`${L}/ledger.jsonl`, rows.join('\n') + '\n')
  const totals = await threadTotals(h.host)
  expect(totals.t1).toBe(3_000_000) // never the desk's 50M, never t2's
  expect(totals.t2).toBe(5 * (4000 + 1000) + 2000) // its own requests and its subagent's: 27k
  expect(totals.t3).toBe(0) // just started: nothing
  expect(totals.t2!).toBeLessThan(100_000) // a thread started minutes ago cannot exceed what it used
  // the budgets read the same numbers: a 1M soft budget flags t1 only; t2 and t3 are far under, whatever the desk used
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 1_000_000, hardTokens: 2_000_000 } }))
  const sent: { action: string; tN: string; text?: string }[] = []
  const notes = await softBudgetTick(h.host, { thread: async (i: any) => (sent.push(i), { ok: true, text: 'queued' }) })
  expect(notes.map(n => n.split(':')[0]).sort()).toEqual(['t1', 't1']) // t1 passed the soft budget (3M of 1M) and the hard cap: nobody else
  expect(sent.every(s => s.tN === 't1')).toBe(true)
  const list = (await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text
  expect(list).toContain('3M/1M tokens!')
  expect(list).toMatch(/t2[^\n]*· 27k\/1M tokens\n/) // t2's own 27k, not the desk's 50M
  expect(list).toMatch(/t3[^\n]*· 0\/1M tokens/) // just started: 0
})

test('a thread number that was used before (a removed folder) does not bring the old thread\'s usage: only rows from its own creation count', async () => {
  const h = fakeHost(null)
  const NOW = 20 * 86_400_000
  h.clock.t = NOW
  thread(h, 't7', { created: NOW - 1_200_000 }) // created 20 minutes ago; an earlier t7 was removed
  h.files.set(`${L}/ledger.jsonl`, [
    ...Array.from({ length: 40 }, (_, i) => row({ ts: NOW - 5 * 86_400_000 + i, tN: 't7', in: 100_000 })), // the old t7, days ago: 4M
    ...Array.from({ length: 3 }, (_, i) => row({ ts: NOW - 1_300_000 + i * 1000, tN: 't7', in: 100_000 })), // the old t7 again, minutes BEFORE the new one was created
    row({ ts: NOW - 600_000, tN: 't7', in: 12_000 }), // the new t7
  ].join('\n') + '\n')
  expect((await threadTotals(h.host)).t7).toBe(12_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 100_000, hardTokens: 200_000 } }))
  const sent: unknown[] = []
  expect(await softBudgetTick(h.host, { thread: async (i: any) => (sent.push(i), { ok: true, text: '' }) })).toEqual([]) // not "over budget a few minutes after it started"
  expect(sent).toEqual([])
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't7' }, cwd: '/r/app', root: '/plug' }, e)
  expect(await run({ tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x' })).toBeNull()
})

test('softBudgetTick: ONE nudge at 80% and one desk notice; at 100% ONE desk notice (raise / park / continue) and the thread goes on, nothing is refused; once per budget value', async () => {
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 8000 } }))
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', in: 6400 }) + '\n') // 80% of 8k
  const sent: { action: string; tN: string; text?: string }[] = []
  const deps = { thread: async (i: any) => (sent.push(i), { ok: true, text: 'queued' }) }
  const a = await softBudgetTick(h.host, deps)
  expect(a).toEqual(['t1: 80% of its soft budget used (6.4k/8k tokens): nudged to take the cheapest path and report at the next natural point; it goes on'])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ action: 'send', tN: 't1' })
  expect(sent[0]!.text).toContain('You have used 80% of your soft budget (6.4k/8k tokens): this is a nudge, not a stop')
  expect(await softBudgetTick(h.host, deps)).toEqual([]) // once
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', root: '/plug' }, e)
  const agent = { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x' }
  expect(await run(agent)).toBeNull() // not over yet
  h.files.set(`${L}/ledger.jsonl`, [row({ tN: 't1', in: 6400 }), row({ tN: 't1', in: 6000, ts: 1_000_001 })].join('\n') + '\n') // 12.4k of 8k
  const b = await softBudgetTick(h.host, deps)
  expect(b).toEqual(['t1: soft budget 12k/8k tokens passed: the thread goes on. Raise it (budget t1 <tokens>), park it (thread park t1), or leave it (config threads.hardTokens sets a real stop)'])
  expect(sent).toHaveLength(1) // the thread is NOT told to stop: only the desk is told
  expect(await softBudgetTick(h.host, deps)).toEqual([]) // once
  expect(await run(agent)).toBeNull() // over the soft budget: nothing is refused
  expect(await run({ tool: 'Edit', file_path: '/r/app/a.ts' })).not.toContain('budget')
  // the user raises the soft budget: the levels are announced again for the new value
  const r = await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: '14k' })
  expect(r.text).toContain('t1: soft budget 14k usage tokens, used 12k/14k tokens')
  h.files.set(`${L}/ledger.jsonl`, [row({ tN: 't1', in: 11_300 })].join('\n') + '\n') // 80.7% of 14k
  expect((await softBudgetTick(h.host, deps))[0]).toContain('80% of its soft budget used (11k/14k tokens)')
})

test('threads.hardTokens is the only real stop (none by default): told to report and stop once, new Agent calls refused, raised or removed ends it', async () => {
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', in: 12_400 }) + '\n')
  const sent: { action: string; tN: string; text?: string }[] = []
  const deps = { thread: async (i: any) => (sent.push(i), { ok: true, text: 'queued' }) }
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', root: '/plug' }, e)
  const agent = { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x' }
  expect(await hardOf(h.host)).toBeNull() // default: none
  await softBudgetTick(h.host, deps) // no budget, no cap: nothing
  expect(sent).toHaveLength(0)
  expect(await run(agent)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardTokens: 12_000 } }))
  const a = await softBudgetTick(h.host, deps)
  expect(a).toEqual(['t1: hard cap 12k/12k tokens reached: told to report and stop; its new Agent calls are refused (raise threads.hardTokens, or remove it, to let it go on)'])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toContain('Your hard budget cap is reached (12k/12k tokens, config threads.hardTokens): report now with lean_report')
  expect(await softBudgetTick(h.host, deps)).toEqual([])
  expect(await run(agent)).toContain("this thread's hard cap of 12k usage tokens (config threads.hardTokens) is used: no new Agent call")
  expect(await run({ tool: 'Edit', file_path: '/r/app/a.ts' })).not.toContain('hard cap') // an edit in progress is never cut
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardTokens: 20_000 } })) // raised: the refusal ends
  await softBudgetTick(h.host, deps)
  expect(await run(agent)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardTokens: 12_000 } })) // set again below the usage: announced again
  expect((await softBudgetTick(h.host, deps))[0]).toContain('hard cap 12k/12k tokens reached')
  expect(await run(agent)).toContain('hard cap')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardTokens: 0 } })) // 0 = none: the refusal ends
  await softBudgetTick(h.host, deps)
  expect(await run(agent)).toBeNull()
  // a 1.0.33 budget.json with a USD cap is not enforced any more
  h.files.set(`${T('t1')}/budget.json`, JSON.stringify({ budget: 8, hard: 1, hardUsd: 12 }))
  expect(await run(agent)).toBeNull()
})

test('lean_thread budget: parse (2m, 500k, 0 = none, off = the shared one); the list shows usage and budget next to ctx; config threads.softTokens 0 turns it off; the old budgetUsd is ignored', async () => {
  expect(parseBudget('2m')).toBe(2_000_000)
  expect(parseBudget('500k')).toBe(500_000)
  expect(parseBudget('1.5M')).toBe(1_500_000)
  expect(parseBudget('250000')).toBe(250_000)
  expect(parseBudget('0')).toBe(0)
  expect(parseBudget('off')).toBeNull()
  expect(parseBudget('lots')).toContain('not an amount of usage tokens')
  expect(parseBudget('')).toContain('needs the amount')
  const h = fakeHost(null)
  thread(h, 't1', { budgetUsd: 1 }) // a 1.0.33 USD budget: not read
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', in: 6400 }) + '\n')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 8000 } }))
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 170_000, at: h.clock.t, sid: 's-t1' }))
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).toContain('ctx 170k/200k · soft limit 160k · 6.4k/8k tokens')
  expect((await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: '0' })).text).toContain('no soft budget')
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).not.toContain('6.4k/8k')
  await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: 'off' })
  expect(JSON.parse(h.files.get(`${T('t1')}/thread.json`)!).budgetUsd).toBeUndefined() // the USD figure is dropped when the budget is set again
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 0 } }))
  expect(await budgetOf(h.host, {})).toBeNull()
  expect(await softBudgetTick(h.host, { thread: async () => ({ ok: true, text: '' }) })).toEqual([])
  expect(await budgetLine(h.host)).toBe('')
})

test('lean_doctor stats shows the thread budgets line on the busy day', async () => {
  const h = fakeHost(null)
  busyDay(h)
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softTokens: 400_000 } }))
  thread(h, 't1'); thread(h, 't2', { budgetTokens: 0 }); thread(h, 't3', { budgetTokens: 0 })
  const text = await statsText(h.host, { days: 1 })
  expect(text).toContain('thread budgets (80% or more used; threads.softTokens 400k): t1 530k/400k tokens!')
})
