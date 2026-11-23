// Budget alerts by default: 50% / 80% of budget.daily, a per-thread daily alert, the live cost per thread, the chaser's note, the toasts.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { budgetLimits, limitOf } from './budget'
import { budgetEvents, checkBudget, expensiveNote } from './budgetalert'
import { CHASE_TEXT, chase } from './chaser'
import { notifyTick } from './notify'
import { readNotices } from './notices'
import { costBadge, threadCostsToday } from './stats'
import { dayOf } from './ledger'

const L = '/h/.lean-agent'
const NOON = Date.UTC(2026, 10, 18, 12)
const DAY = 86_400_000
const row = (o: Record<string, unknown> = {}) => JSON.stringify({ ts: NOON, role: 'thread', tN: 't1', model: 'claude-sonnet-5-5', usd: 1, ...o }) + '\n'
function setup(rows: Record<string, unknown>[] = []) {
  const h = fakeHost(null)
  h.clock.t = NOON
  for (const [id, model, effort] of [['t1', 'sonnet', 'high'], ['t2', 'sonnet', 'medium'], ['t3', 'opus', 'high'], ['t4', 'haiku', 'low']]) h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, state: 'open', sid: `s${id}`, model, effort }))
  h.files.set(`${L}/ledger.jsonl`, rows.map(r => row(r)).join(''))
  return h
}
const add = (h: ReturnType<typeof setup>, ...rows: Record<string, unknown>[]) => h.files.set(`${L}/ledger.jsonl`, (h.files.get(`${L}/ledger.jsonl`) ?? '') + rows.map(r => row(r)).join(''))
const config = (h: ReturnType<typeof setup>, c: unknown) => h.files.set(`${L}/config.json`, JSON.stringify(c))

test('limitOf: a number, a numeric string, off, and the default for junk', () => {
  expect(limitOf(undefined, 25)).toBe(25)
  expect(limitOf(40, 25)).toBe(40)
  expect(limitOf('12.5', 25)).toBe(12.5)
  for (const off of ['off', 'OFF', ' none ', false, 0, -3, 'false']) expect(limitOf(off, 25), String(off)).toBeNull()
  for (const junk of ['abc', {}, [], NaN, '']) expect(limitOf(junk, 25), String(junk)).toBe(25)
})

test('budgetLimits: 25 and 15 USD by default, from config.json budget, "off" allowed', async () => {
  const h = setup()
  expect(await budgetLimits(h.host)).toEqual({ daily: 25, thread: 15 })
  config(h, { budget: { daily: 10, threadDaily: 'off' } })
  expect(await budgetLimits(h.host)).toEqual({ daily: 10, thread: null })
  config(h, { budget: { daily: 'off' } })
  expect(await budgetLimits(h.host)).toEqual({ daily: null, thread: 15 })
})

test('a notice at 50% and another at 80% of the daily budget, once per day per level, with today\'s spend, the top 3 threads and their models', async () => {
  const h = setup([{ tN: 't1', usd: 6 }, { tN: 't2', usd: 4 }, { tN: 't3', usd: 2 }, { tN: 't4', usd: 1 }]) // $13 of 25: 52%
  expect(await checkBudget(h.host)).toEqual(['d50'])
  let notes = await readNotices(h.host)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('budget 50%')
  expect(notes[0]).toContain('$13.00 of the $25.00')
  expect(notes[0]).toContain('t1 $6.00 sonnet/high, t2 $4.00 sonnet/medium, t3 $2.00 opus/high')
  expect(notes[0]).not.toContain('t4') // the top 3 only
  expect(notes[0]!.length).toBeLessThan(300)
  // not again at the same level, however often the tick runs
  expect(await checkBudget(h.host)).toEqual([])
  add(h, { tN: 't1', usd: 1 })
  expect(await checkBudget(h.host)).toEqual([])
  // 80% of 25 = 20
  add(h, { tN: 't2', usd: 6.5 })
  expect(await checkBudget(h.host)).toEqual(['d80'])
  notes = await readNotices(h.host)
  expect(notes).toHaveLength(1) // the 80% text replaced the 50% one
  expect(notes[0]).toContain('budget 80%')
  expect(notes[0]).toContain('$20.50 of the $25.00')
  expect(await checkBudget(h.host)).toEqual([])
  expect((await budgetEvents(h.host)).map(e => e.key)).toEqual([`budget:d50:${dayOf(NOON)}`, `budget:d80:${dayOf(NOON)}`])
})

test('one jump past both levels says the higher one only; under 50% says nothing', async () => {
  const h = setup([{ tN: 't1', usd: 12 }])
  expect(await checkBudget(h.host)).toEqual([])
  expect(await readNotices(h.host)).toEqual([])
  add(h, { tN: 't2', usd: 9 })
  expect(await checkBudget(h.host)).toEqual(['d80'])
  expect((await budgetEvents(h.host)).map(e => e.key)).toEqual([`budget:d80:${dayOf(NOON)}`])
  add(h, { tN: 't2', usd: 1 })
  expect(await checkBudget(h.host)).toEqual([]) // the 50% level was marked with it
})

test('a new day starts again: yesterday\'s notices are cleared and the levels fire once more', async () => {
  const h = setup([{ tN: 't1', usd: 14 }])
  expect(await checkBudget(h.host)).toEqual(['d50'])
  expect(await readNotices(h.host)).toHaveLength(1)
  h.clock.t = NOON + DAY
  add(h, { ts: NOON + DAY, tN: 't2', usd: 2 })
  expect(await checkBudget(h.host)).toEqual([]) // $2 today
  expect(await readNotices(h.host)).toEqual([])
  expect(await budgetEvents(h.host)).toEqual([])
  add(h, { ts: NOON + DAY, tN: 't2', usd: 11 })
  expect(await checkBudget(h.host)).toEqual(['d50'])
  expect((await budgetEvents(h.host))[0]!.key).toBe(`budget:d50:${dayOf(NOON + DAY)}`)
})

test('budget.daily "off" and a custom number', async () => {
  const h = setup([{ tN: 't1', usd: 15 }])
  config(h, { budget: { daily: 'off', threadDaily: 'off' } })
  expect(await checkBudget(h.host)).toEqual([])
  expect(await readNotices(h.host)).toEqual([])
  config(h, { budget: { daily: 20, threadDaily: 'off' } }) // 15 of 20 = 75%
  expect(await checkBudget(h.host)).toEqual(['d50'])
  expect((await readNotices(h.host))[0]).toContain('$15.00 of the $20.00')
  // no ledger at all: nothing, no error
  expect(await checkBudget(fakeHost(null).host)).toEqual([])
})

test('a thread over budget.threadDaily is one notice and one toast event, once per day; the others are not flagged', async () => {
  const h = setup([{ tN: 't3', usd: 21 }, { tN: 't1', usd: 1 }])
  config(h, { budget: { daily: 'off' } })
  expect(await checkBudget(h.host)).toEqual(['t3'])
  const notes = await readNotices(h.host)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('t3 has spent $21.00 today, over its $15.00 daily alert (opus/high)')
  expect(await checkBudget(h.host)).toEqual([])
  add(h, { tN: 't3', usd: 5 }, { tN: 't1', usd: 19 }) // t1 reaches $20
  expect(await checkBudget(h.host)).toEqual(['t1'])
  expect(await readNotices(h.host)).toHaveLength(2)
  config(h, { budget: { daily: 'off', threadDaily: 100 } })
  const other = setup([{ tN: 't3', usd: 21 }])
  config(other, { budget: { daily: 'off', threadDaily: 100 } })
  expect(await checkBudget(other.host)).toEqual([])
})

test('the toasts: each alert is shown once through notifyTick, after the first run; toasts off keeps quiet', async () => {
  const h = setup([{ tN: 't1', usd: 3 }])
  const shown: string[] = []
  const toast = (t: string) => void shown.push(t)
  const view: any = { needs: [], threads: [], errors: [] } // (nothing else is waiting: only the budget events)
  await notifyTick(h.host, toast, view) // the first run on a home records what is there
  add(h, { tN: 't1', usd: 11 }) // $14 of 25
  await checkBudget(h.host)
  expect((await notifyTick(h.host, toast, view)).some(t => t.startsWith('budget 50%'))).toBe(true)
  expect(shown.filter(t => t.startsWith('budget 50%'))).toHaveLength(1)
  expect(await notifyTick(h.host, toast, view)).toEqual([]) // once
  add(h, { tN: 't3', usd: 22 })
  await checkBudget(h.host)
  const second = await notifyTick(h.host, toast, view)
  expect(second.some(t => t.startsWith('budget 80%'))).toBe(true)
  expect(second.some(t => t.includes('t3 has spent'))).toBe(true)
  config(h, { notify: { toast: false } })
  add(h, { tN: 't1', usd: 30 })
  await checkBudget(h.host)
  expect(await notifyTick(h.host, toast, view)).toEqual([]) // switched off: nothing drawn
})

test('threadCostsToday: the live cost per thread for the pane cards, with its model and whether it is over the alert', async () => {
  const h = setup([{ tN: 't1', usd: 2.5 }, { tN: 't1', usd: 0.5 }, { tN: 't3', usd: 25 }, { ts: NOON - DAY, tN: 't2', usd: 9 }, { role: 'desk', tN: undefined, usd: 4 }])
  const c = await threadCostsToday(h.host)
  expect(Object.keys(c).sort()).toEqual(['t1', 't3']) // t2 spent nothing today, the desk is not a thread
  expect(c.t1).toEqual({ id: 't1', usd: 3, model: 'sonnet', effort: 'high', over: false, main: 3, workers: 0 })
  expect(c.t3).toEqual({ id: 't3', usd: 25, model: 'opus', effort: 'high', over: true, main: 25, workers: 0 })
  expect(costBadge(c.t1!)).toBe('$3.00')
  expect(costBadge(c.t3!)).toBe('$25.00!')
  config(h, { budget: { threadDaily: 'off' } })
  expect((await threadCostsToday(h.host)).t3!.over).toBe(false)
  expect(await threadCostsToday(fakeHost(null).host)).toEqual({}) // no ledger
})

test('the chaser runs the budget check, and asks a stale thread that is over its daily alert what the spend bought', async () => {
  const h = setup([{ tN: 't1', usd: 21 }])
  h.clock.t = NOON
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'a', ts: 1 }, t2: { text: 'b', ts: 1 } }))
  const sent: [string, string][] = []
  expect(await chase(h.host, async (id, t) => void sent.push([id, t]))).toEqual(['t1', 't2'])
  expect(sent.find(s => s[0] === 't2')![1]).toBe(CHASE_TEXT) // an ordinary thread: the usual text
  const expensive = sent.find(s => s[0] === 't1')![1]
  expect(expensive.startsWith(CHASE_TEXT)).toBe(true)
  expect(expensive).toContain('You have spent $21.00 today, over the daily alert')
  expect((await readNotices(h.host)).some(n => n.includes('t1 has spent $21.00'))).toBe(true) // the same tick raised the alert
  expect(await expensiveNote(h.host, 't2')).toBe('')
})
