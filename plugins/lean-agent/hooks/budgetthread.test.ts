// Per-thread context limit and the soft checkpoint size (threadcontext.ts, budgetthread.ts, budgettick.ts softCheckpointTick, the warn line), and later the per-thread
// soft budget. Synthetic numbers: an 85k thread against the 80k soft line, a limit override of 90k.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread } from './threads'
import { ctxText, limitsOf, threadLimitsFor } from './threadcontext'
import { budgetLine, budgetLevel, budgetOf, budgetText, hardOf, limitReply, parseTokens, parseUsd, threadTotals } from './budgetthread'
import { takeWarn, warnLine, warnReset } from './scratchnotes'
import { softBudgetTick, softCheckpointTick } from './budgettick'
import { decide } from './guard'
import { statsText } from './stats'

const L = '/h/.lean-agent'
const T = (id: string) => `${L}/threads/${id}`
const thread = (h: ReturnType<typeof fakeHost>, id: string, o: Record<string, unknown> = {}) =>
  h.files.set(`${T(id)}/thread.json`, JSON.stringify({ id, title: id, project: 'shop', state: 'open', sid: `s-${id}`, created: 1, lastWake: 1, delivered: 0, ...o }))

test('limitsOf: the soft line is 80k of the default 120k; a per-thread limit moves it with the same share; config keys move it; old threadWarnTokens wins', () => {
  expect(limitsOf(null)).toEqual({ limit: 120_000, warn: 80_000 })
  expect(limitsOf(null, 90_000)).toEqual({ limit: 90_000, warn: 60_000 })
  expect(limitsOf(null, 200_000)).toEqual({ limit: 200_000, warn: 133_000 })
  expect(limitsOf(null, 40_000)).toEqual({ limit: 40_000, warn: 27_000 })
  expect(limitsOf(null, 30_000)).toEqual({ limit: 120_000, warn: 80_000 }) // outside 40k-200k: ignored
  expect(limitsOf({ threads: { softCheckpointTokens: 60_000 } }, 90_000)).toEqual({ limit: 90_000, warn: 45_000 })
  expect(limitsOf({ threadWarnTokens: 100_000 })).toEqual({ limit: 120_000, warn: 100_000 })
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
  expect(r.text).toContain('checkpoint at 60k (soft)')
  expect(JSON.parse(h.files.get(`${T('t1')}/thread.json`)!).tokenLimit).toBe(90_000)
  expect(await threadLimitsFor(h.host, 't1')).toEqual({ limit: 90_000, warn: 60_000 })
  expect(await threadLimitsFor(h.host, 't2')).toEqual({ limit: 120_000, warn: 80_000 }) // another thread: the shared limits
  expect((await leanThread(h.host, '/plug', { action: 'limit', tN: 't1', text: '300000' })).ok).toBe(false)
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 85_000, at: h.clock.t, sid: 's-t1' }))
  const list = await leanThread(h.host, '/plug', { action: 'list', verbose: true })
  expect(list.text).toContain('ctx 85k/90k · soft limit 60k')
  expect(limitReply('t1', null, {})).toContain('shared limit applies again')
  const off = await leanThread(h.host, '/plug', { action: 'limit', tN: 't1', text: 'off' })
  expect(off.ok).toBe(true)
  expect(JSON.parse(h.files.get(`${T('t1')}/thread.json`)!).tokenLimit).toBeUndefined()
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).toContain('ctx 85k/120k · soft limit 80k')
})

test('ctxText stays "ctx 85k/120k" (the card); the list adds "soft limit 80k" once the size is over it', async () => {
  expect(ctxText(85_000, { limit: 120_000, warn: 80_000 })).toBe('ctx 85k/120k')
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 70_000, at: h.clock.t, sid: 's-t1' }))
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).not.toContain('soft limit')
})

test('the warn line moves with the per-thread limit: told once at the soft size, "next natural boundary", the checkpoint call', () => {
  warnReset()
  const own = limitsOf(null, 90_000) // soft 60k
  expect(takeWarn('s1', 60_000, own)).toBeNull()
  const line = takeWarn('s1', 61_000, own)!
  expect(line).toBe(warnLine(61_000, 90_000, 60_000))
  expect(line).toContain('(soft limit 60k)')
  expect(line).toContain('at your next natural boundary')
  expect(line).toContain('lean_run checkpoint {next:')
  expect(takeWarn('s1', 62_000, own)).toBeNull() // once
  expect(takeWarn('s2', 79_000, limitsOf(null))).toBeNull() // the shared 80k line
  expect(takeWarn('s2', 85_000, limitsOf(null))).toContain('ctx 85k of 120k (soft limit 80k)')
})

test('softCheckpointTick: an idle thread with work left over its soft size is checkpointed by script once per session; working, waiting, under the line and an own bigger limit are left', async () => {
  const h = fakeHost(null)
  const ctx = (id: string, tokens: number, ago = 600_000) => h.files.set(`${T(id)}/context.json`, JSON.stringify({ tokens, at: h.clock.t - ago, sid: `s-${id}` }))
  thread(h, 't1'); ctx('t1', 85_000)
  thread(h, 't2'); ctx('t2', 85_000)
  thread(h, 't3'); ctx('t3', 70_000)
  thread(h, 't4', { tokenLimit: 200_000 }); ctx('t4', 85_000)
  thread(h, 't5'); ctx('t5', 85_000, 30_000) // its turn ended 30 s ago
  thread(h, 't6'); ctx('t6', 85_000)
  const rows = [t('t1', 'idle'), t('t2', 'working'), t('t3', 'idle'), t('t4', 'idle'), t('t5', 'idle'), t('t6', 'idle')]
  function t(id: string, state: string) { return { sid: `s-${id}`, name: id, cwd: '', status: state === 'working' ? 'busy' : 'idle', startedAt: 0, pid: state === 'working' ? 1 : 0, id: `a-${id}`, state, waitingFor: '' } }
  h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: h.clock.t - 400_000, from: 't6', kind: 'report', state: 'done', text: 'done' }) + '\n')
  const calls: { action: string; tN: string; reason?: string }[] = []
  const deps = { agents: async () => rows as any, thread: async (i: any) => (calls.push(i), { ok: true, text: 'restarted', data: { fresh: true } }) }
  const notes = await softCheckpointTick(h.host, deps)
  expect(calls.map(c => `${c.action} ${c.tN}`)).toEqual(['auto-restart t1'])
  expect(calls[0]!.reason).toContain('over the soft checkpoint size 80000')
  expect(notes).toEqual(['t1: context 85k passed the soft checkpoint size 80k while idle: checkpointed and restarted as a new session by script'])
  expect(await softCheckpointTick(h.host, deps)).toEqual([]) // once per session (and the 10 minute gap)
  expect(calls).toHaveLength(1)
})

// ---- the soft budget in USD ------------------------------------------------------------------------------------------------------------------
// A sonnet-heavy day of the field report: 1310 requests, $44.69; the desk $4.74 over 144 requests, one thread 530 requests at $21.00, the other thread requests $18.94 and haiku $0
const row = (o: Record<string, unknown>) => JSON.stringify({ ts: 1_000_000, role: 'thread', model: 'claude-sonnet-5-5', in: 1, out: 1, cache_read: 1, cache_write: 1, usd: 0.01, ...o })
function sonnetDay(h: ReturnType<typeof fakeHost>) {
  const rows: string[] = []
  for (let i = 0; i < 144; i++) rows.push(row({ role: 'desk', usd: 4.74 / 144 }))
  for (let i = 0; i < 530; i++) rows.push(row({ tN: 't1', usd: 21 / 530 }))
  for (let i = 0; i < 636; i++) rows.push(row({ tN: i % 2 ? 't2' : 't3', usd: 18.94 / 636 }))
  h.files.set(`${L}/ledger.jsonl`, rows.join('\n') + '\n')
}

test('threadTotals / budgetOf / budgetLine on the sonnet-heavy day: the 530-request thread is over the default $8, the others are not', async () => {
  const h = fakeHost(null)
  sonnetDay(h)
  thread(h, 't1'); thread(h, 't2'); thread(h, 't3', { budgetUsd: 0 })
  const totals = await threadTotals(h.host)
  expect(Math.round((totals.t1 ?? 0) * 100) / 100).toBe(21)
  expect(Math.round(((totals.t2 ?? 0) + (totals.t3 ?? 0)) * 100) / 100).toBe(18.94)
  expect(await budgetOf(h.host, {})).toBe(8)
  expect(await budgetOf(h.host, { budgetUsd: 0 })).toBeNull() // 0 = none for this thread
  expect(await budgetOf(h.host, { budgetUsd: 12.5 })).toBe(12.5)
  expect(budgetText(21, 8)).toBe('$21.00/$8')
  expect(budgetText(6.4, 8.5)).toBe('$6.40/$8.50')
  expect(budgetLevel(6.4, 8)).toBe('near')
  expect(budgetLevel(6.39, 8)).toBe('ok')
  expect(budgetLevel(8, 8)).toBe('over')
  expect(await budgetLine(h.host)).toBe('thread budgets (80% or more used; threads.softUsd 8): t1 $21.00/$8!, t2 $9.47/$8!') // (t3 has budget 0 = none)
})

test('softBudgetTick: ONE nudge at 80% and one desk notice; at 100% ONE desk notice (raise / park / continue) and the thread goes on, nothing is refused; once per budget value', async () => {
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', usd: 6.4 }) + '\n') // 80% of $8
  const sent: { action: string; tN: string; text?: string }[] = []
  const deps = { thread: async (i: any) => (sent.push(i), { ok: true, text: 'queued' }) }
  const a = await softBudgetTick(h.host, deps)
  expect(a).toEqual(['t1: 80% of its soft budget used ($6.40/$8): nudged to take the cheapest path and report at the next natural point; it goes on'])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ action: 'send', tN: 't1' })
  expect(sent[0]!.text).toContain('You have used 80% of your soft budget ($6.40/$8): this is a nudge, not a stop')
  expect(await softBudgetTick(h.host, deps)).toEqual([]) // once
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', root: '/plug' }, e)
  const agent = { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x' }
  expect(await run(agent)).toBeNull() // not over yet
  h.files.set(`${L}/ledger.jsonl`, [row({ tN: 't1', usd: 6.4 }), row({ tN: 't1', usd: 6, ts: 1_000_001 })].join('\n') + '\n') // $12.40 of $8 (a thread of the field report)
  const b = await softBudgetTick(h.host, deps)
  expect(b).toEqual(['t1: soft budget $12.40/$8 passed: the thread goes on. Raise it (budget t1 <usd>), park it (thread park t1), or leave it (config threads.hardUsd sets a real stop)'])
  expect(sent).toHaveLength(1) // the thread is NOT told to stop: only the desk is told
  expect(await softBudgetTick(h.host, deps)).toEqual([]) // once
  expect(await run(agent)).toBeNull() // over the soft budget: nothing is refused
  expect(await run({ tool: 'Edit', file_path: '/r/app/a.ts' })).not.toContain('budget')
  // the user raises the soft budget: the levels are announced again for the new value
  const r = await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: '14' })
  expect(r.text).toContain('t1: soft budget $14, spent $12.40/$14')
  h.files.set(`${L}/ledger.jsonl`, [row({ tN: 't1', usd: 11.3 })].join('\n') + '\n') // 80.7% of $14
  expect((await softBudgetTick(h.host, deps))[0]).toContain('80% of its soft budget used ($11.30/$14)')
})

test('threads.hardUsd is the only real stop (none by default): told to report and stop once, new Agent calls refused, raised or removed ends it', async () => {
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', usd: 12.4 }) + '\n')
  const sent: { action: string; tN: string; text?: string }[] = []
  const deps = { thread: async (i: any) => (sent.push(i), { ok: true, text: 'queued' }) }
  const run = (e: any) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', root: '/plug' }, e)
  const agent = { tool: 'Agent', subagent_type: 'lean-agent:worker-haiku', model: 'haiku', prompt: 'x' }
  expect(await hardOf(h.host)).toBeNull() // default: none
  await softBudgetTick(h.host, deps) // the soft notice only
  expect(sent).toHaveLength(0)
  expect(await run(agent)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardUsd: 12 } }))
  const a = await softBudgetTick(h.host, deps)
  expect(a).toEqual(['t1: hard cap $12.40/$12 reached: told to report and stop; its new Agent calls are refused (raise threads.hardUsd, or remove it, to let it go on)'])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toContain('Your hard budget cap is reached ($12.40/$12, config threads.hardUsd): report now with lean_report')
  expect(await softBudgetTick(h.host, deps)).toEqual([])
  expect(await run(agent)).toContain("this thread's hard cap of $12 (config threads.hardUsd) is used: no new Agent call")
  expect(await run({ tool: 'Edit', file_path: '/r/app/a.ts' })).not.toContain('hard cap') // an edit in progress is never cut
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardUsd: 20 } })) // raised: the refusal ends
  await softBudgetTick(h.host, deps)
  expect(await run(agent)).toBeNull()
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardUsd: 12 } })) // set again below the spend: announced again
  expect((await softBudgetTick(h.host, deps))[0]).toContain('hard cap $12.40/$12 reached')
  expect(await run(agent)).toContain('hard cap')
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { hardUsd: 0 } })) // 0 = none: the refusal ends
  await softBudgetTick(h.host, deps)
  expect(await run(agent)).toBeNull()
})

test('lean_thread budget: parse, 0 = none, off = the shared one; the list shows spend and budget next to ctx; config threads.softUsd 0 turns it off', async () => {
  expect(parseUsd('6.5')).toBe(6.5)
  expect(parseUsd('$10')).toBe(10)
  expect(parseUsd('0')).toBe(0)
  expect(parseUsd('off')).toBeNull()
  expect(parseUsd('lots')).toContain('not an amount in USD')
  expect(parseUsd('')).toContain('needs the amount')
  const h = fakeHost(null)
  thread(h, 't1')
  h.files.set(`${L}/ledger.jsonl`, row({ tN: 't1', usd: 6.4 }) + '\n')
  h.files.set(`${T('t1')}/context.json`, JSON.stringify({ tokens: 85_000, at: h.clock.t, sid: 's-t1' }))
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).toContain('ctx 85k/120k · soft limit 80k · $6.40/$8')
  expect((await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: '0' })).text).toContain('no soft budget')
  expect((await leanThread(h.host, '/plug', { action: 'list', verbose: true })).text).not.toContain('$6.40/')
  await leanThread(h.host, '/plug', { action: 'budget', tN: 't1', text: 'off' })
  h.files.set(`${L}/config.json`, JSON.stringify({ threads: { softUsd: 0 } }))
  expect(await budgetOf(h.host, {})).toBeNull()
  expect(await softBudgetTick(h.host, { thread: async () => ({ ok: true, text: '' }) })).toEqual([])
  expect(await budgetLine(h.host)).toBe('')
})

test('lean_doctor stats shows the thread budgets line on the sonnet-heavy day', async () => {
  const h = fakeHost(null)
  sonnetDay(h)
  thread(h, 't1'); thread(h, 't2', { budgetUsd: 0 }); thread(h, 't3', { budgetUsd: 0 })
  const text = await statsText(h.host, { days: 1 })
  expect(text).toContain('thread budgets (80% or more used; threads.softUsd 8): t1 $21.00/$8!')
})
