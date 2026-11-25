// Alerts for the OPTIONAL token caps: 80% / 100% of budget.windowTokens (once per window) and budget.allTimeTokens (once per start), the toasts, the chaser's note.
// Nothing is alerted when no cap is set (the default). Synthetic usage: input tokens only, so one usage token is one input token.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { budgetEvents, checkBudget, expensiveNote } from './budgetalert'
import { CHASE_TEXT, chase } from './chaser'
import { notifyTick } from './notify'
import { readNotices } from './notices'

const L = '/h/.lean-agent'
const NOON = Date.UTC(2026, 10, 18, 12)
const HOUR = 3_600_000
const row = (o: Record<string, unknown> = {}) => JSON.stringify({ ts: NOON - 60_000, role: 'thread', tN: 't1', agent: 'main', model: 'claude-sonnet-5-5', in: 1000, usd: 1, ...o }) + '\n'
function setup(rows: Record<string, unknown>[] = []) {
  const h = fakeHost(null)
  h.clock.t = NOON
  for (const id of ['t1', 't2', 't3']) h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, state: 'open', sid: `s${id}`, created: NOON - 24 * HOUR }))
  h.files.set(`${L}/ledger.jsonl`, rows.map(r => row(r)).join(''))
  return h
}
const add = (h: ReturnType<typeof setup>, ...rows: Record<string, unknown>[]) => h.files.set(`${L}/ledger.jsonl`, (h.files.get(`${L}/ledger.jsonl`) ?? '') + rows.map(r => row(r)).join(''))
const config = (h: ReturnType<typeof setup>, c: unknown) => h.files.set(`${L}/config.json`, JSON.stringify(c))
const window5h = (h: ReturnType<typeof setup>, resetsAt: number) => h.files.set(`${L}/desk/windows.json`, JSON.stringify({ v: 1, at: NOON, windows: [{ kind: 'five_hour', percentUsed: 30, resetsAt }, { kind: 'seven_day', percentUsed: 65, resetsAt: NOON + 48 * HOUR }] }))

test('no cap set (the default): no alert, no notice, however much is used', async () => {
  const h = setup([{ in: 50_000_000 }])
  expect(await checkBudget(h.host)).toEqual([])
  expect(await readNotices(h.host)).toEqual([])
  expect(await checkBudget(fakeHost(null).host)).toEqual([]) // no ledger at all: nothing, no error
})

test('budget.windowTokens: a notice at 80% and another at 100%, once per window each, with the top threads', async () => {
  const h = setup([{ tN: 't1', in: 500_000 }, { tN: 't2', in: 350_000 }]) // 850k of 1M = 85%
  window5h(h, NOON + 2 * HOUR)
  config(h, { budget: { windowTokens: 1_000_000 } })
  expect(await checkBudget(h.host)).toEqual(['w80'])
  let notes = await readNotices(h.host)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('budget 80%')
  expect(notes[0]).toContain('850k of the 1M usage tokens cap of this 5 h window')
  expect(notes[0]).toContain('t1 500k, t2 350k')
  expect(await checkBudget(h.host)).toEqual([]) // not again, however often the tick runs
  add(h, { tN: 't2', in: 200_000 }) // 1.05M
  expect(await checkBudget(h.host)).toEqual(['w100'])
  notes = await readNotices(h.host)
  expect(notes).toHaveLength(1) // the 100% text replaced the 80% one
  expect(notes[0]).toContain('is used: new work is held until the window resets')
  expect(await checkBudget(h.host)).toEqual([])
  expect((await budgetEvents(h.host)).map(e => e.key.split(':')[1]!.replace(/@.*$/, ''))).toEqual(['w80', 'w100'])
})

test('one jump past both levels says the higher one only; under 80% says nothing', async () => {
  const h = setup([{ in: 700_000 }])
  window5h(h, NOON + 2 * HOUR)
  config(h, { budget: { windowTokens: 1_000_000 } })
  expect(await checkBudget(h.host)).toEqual([])
  add(h, { in: 400_000 })
  expect(await checkBudget(h.host)).toEqual(['w100'])
  expect((await budgetEvents(h.host)).map(e => e.key.split(':')[1]!.replace(/@.*$/, ''))).toEqual(['w100'])
  add(h, { in: 10_000 })
  expect(await checkBudget(h.host)).toEqual([]) // the 80% level was marked with it
})

test('a new window starts again: the old notice is cleared and the levels fire once more; the usage counts only the new window', async () => {
  const h = setup([{ in: 900_000 }])
  window5h(h, NOON + 2 * HOUR)
  config(h, { budget: { windowTokens: 1_000_000 } })
  expect(await checkBudget(h.host)).toEqual(['w80'])
  h.clock.t = NOON + 3 * HOUR // the window reset at NOON + 2 h; the next one resets 5 h later
  window5h(h, NOON + 7 * HOUR)
  add(h, { ts: NOON + 3 * HOUR - 1000, in: 100_000 })
  expect(await checkBudget(h.host)).toEqual([]) // 100k in the new window (the old 900k is before its start NOON + 2 h)
  expect(await readNotices(h.host)).toEqual([])
  add(h, { ts: NOON + 3 * HOUR - 500, in: 850_000 })
  expect(await checkBudget(h.host)).toEqual(['w80'])
  expect(await readNotices(h.host)).toHaveLength(1)
})

test('budget.allTimeTokens: 80% and 100% since budget.since; starting again (a later since) ends the notice', async () => {
  const h = setup([{ in: 850_000 }])
  config(h, { budget: { allTimeTokens: 1_000_000 } })
  expect(await checkBudget(h.host)).toEqual(['a80'])
  expect((await readNotices(h.host))[0]).toContain('850k of the 1M usage tokens cap since the all-time start')
  config(h, { budget: { allTimeTokens: 1_000_000, since: new Date(NOON).toISOString() } }) // "today": nothing counts from before this moment
  expect(await checkBudget(h.host)).toEqual([])
  expect(await readNotices(h.host)).toEqual([])
  config(h, {}) // the cap is removed: no notice stays
  expect(await checkBudget(h.host)).toEqual([])
})

test('the toasts: each alert is shown once through notifyTick, after the first run; toasts off keeps quiet', async () => {
  const h = setup([{ in: 100_000 }])
  window5h(h, NOON + 2 * HOUR)
  config(h, { budget: { windowTokens: 1_000_000 } })
  const shown: string[] = []
  const toast = (t: string) => void shown.push(t)
  const view: any = { needs: [], threads: [], errors: [] } // (nothing else is waiting: only the budget events)
  await notifyTick(h.host, toast, view) // the first run on a home records what is there
  add(h, { in: 750_000 }) // 850k of 1M
  await checkBudget(h.host)
  expect((await notifyTick(h.host, toast, view)).some(t => t.startsWith('budget 80%'))).toBe(true)
  expect(shown.filter(t => t.startsWith('budget 80%'))).toHaveLength(1)
  expect(await notifyTick(h.host, toast, view)).toEqual([]) // once
  add(h, { in: 300_000 })
  await checkBudget(h.host)
  expect((await notifyTick(h.host, toast, view)).some(t => t.startsWith('budget 100%'))).toBe(true)
  config(h, { budget: { windowTokens: 1_000_000 }, notify: { toast: false } })
  window5h(h, NOON + 2 * HOUR + 1) // another window: a new alert, but toasts are off
  add(h, { in: 2_000_000 })
  await checkBudget(h.host)
  expect(await notifyTick(h.host, toast, view)).toEqual([]) // switched off: nothing drawn
})

test('the chaser runs the budget check, and asks a stale thread that is over its soft budget what the usage bought', async () => {
  const h = setup([{ tN: 't1', in: 2_100_000 }])
  config(h, { threads: { softTokens: 2_000_000 } })
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'a', ts: 1 }, t2: { text: 'b', ts: 1 } }))
  const sent: [string, string][] = []
  expect(await chase(h.host, async (id, t) => void sent.push([id, t]))).toEqual(['t1', 't2'])
  expect(sent.find(s => s[0] === 't2')![1]).toBe(CHASE_TEXT) // an ordinary thread: the usual text
  const expensive = sent.find(s => s[0] === 't1')![1]
  expect(expensive.startsWith(CHASE_TEXT)).toBe(true)
  expect(expensive).toContain('You have used 2.1M usage tokens, over your soft budget of 2M')
  expect(await expensiveNote(h.host, 't2')).toBe('')
  config(h, {}) // no soft budget (the default): the usual text for everyone
  expect(await expensiveNote(h.host, 't1')).toBe('')
})
