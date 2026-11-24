// The pane's session list and Health card, without an engine: the order (last activity, needs you first, cost, name), the cap, the age text, the
// settings, what Health says when folded, and the level of the own-PR notice. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ageText, capItems, itemsOf, needsUser, paneConfig, saveSort, sortItems } from './panelist'
import { healthSummary } from './panehealth'
import { loadView, noticeInfo, resetViewCache } from './view'
import type { ClosedRow, ThreadRow } from './view'
import { ownLine } from './ownpr'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const MIN = 60_000
const t = (id: string, o: Partial<ThreadRow> = {}): ThreadRow => ({ id, title: `title ${id}`, state: 'open', run: 'idle', last: '', resumable: false, working: false, done: false, asking: false, blocked: false, needsYou: false, lastReport: '', review: 'none', cost: 0, ready: false, recTs: 0, ...o })
const c = (id: string, o: Partial<ClosedRow> = {}): ClosedRow => ({ id, title: `title ${id}`, last: '', activity: 0, cost: 0, ...o })
const ids = (l: { id: string }[]) => l.map(x => x.id)

test('sort: last active puts the newest first, open and closed threads in ONE list; ties go to the higher id', () => {
  const items = itemsOf([t('t1', { activity: 100 }), t('t2', { activity: 300 }), t('t5', { activity: 200 }), t('t6', { activity: 200 })], [c('t3', { activity: 250 }), c('t4', { activity: 50 })])
  expect(ids(sortItems(items, 'active'))).toEqual(['t2', 't3', 't6', 't5', 't1', 't4'])
  expect(sortItems(items, 'active').find(i => i.id === 't3')!.closed).toBe(true)
  expect(ids(sortItems(itemsOf([t('t1', { recTs: 500 }), t('t2', { recTs: 900 })], []), 'active'))).toEqual(['t2', 't1']) // no activity recorded: the last report
})

test('sort: needs you first puts what waits for the user on top, each group by last activity; cost: dearest first; name: A to Z', () => {
  const rows = [t('t1', { activity: 500 }), t('t2', { activity: 100, blocked: true }), t('t3', { activity: 300, asking: true, cost: 9 }), t('t4', { activity: 400, cost: 2 }), t('t5', { activity: 50, pending: 'waiting for your Approve: reply' }), t('t7', { activity: 10, title: 'alpha' })]
  const closed = [c('t6', { activity: 600, cost: 20, title: 'Zulu' })]
  const items = itemsOf(rows, closed, [{ thread: 't1' }])
  // t1 has a card with a need, t2 is blocked, t3 asks, t5 has a request waiting: all four on top (by activity), then the rest (the closed row among them)
  expect(ids(sortItems(items, 'needs'))).toEqual(['t1', 't3', 't2', 't5', 't6', 't4', 't7'])
  expect(ids(sortItems(items, 'cost'))).toEqual(['t6', 't3', 't4', 't1', 't2', 't5', 't7']) // cost, then the last activity
  expect(ids(sortItems(items, 'name')).slice(0, 2)).toEqual(['t7', 't1']) // alpha, title t1 ...
  expect(ids(sortItems(items, 'name')).at(-1)).toBe('t6') // Zulu last, whatever the case
  expect(needsUser(t('t8', { working: true, run: 'running' }))).toBe(false)
  expect(needsUser(t('t8', { approval: 'git push' }))).toBe(true)
})

test('cap: the first N rows, and every later row that has something unread or waits for the user; the rest is counted for "show more"', () => {
  const items = sortItems(itemsOf(Array.from({ length: 12 }, (_, n) => t(`t${n + 1}`, { activity: 1000 - n })), []), 'active')
  expect(capItems(items, 5, () => false)).toMatchObject({ hidden: 7 })
  expect(ids(capItems(items, 5, () => false).shown)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  const kept = capItems(items, 5, i => i.id === 't11')
  expect(ids(kept.shown)).toEqual(['t1', 't2', 't3', 't4', 't5', 't11'])
  expect(kept.hidden).toBe(6)
  expect(capItems(items, 30, () => false).hidden).toBe(0)
})

test('ageText: just now, minutes, hours, days; "no activity yet" when nothing is known', () => {
  const now = 10_000_000_000
  expect([ageText(now - 20_000, now), ageText(now - 5 * MIN, now), ageText(now - 3 * 60 * MIN, now), ageText(now - 47 * 60 * MIN, now), ageText(now - 3 * 24 * 60 * MIN, now), ageText(0, now), ageText(now + 5000, now)]).toEqual(['just now', '5 min ago', '3 h ago', '47 h ago', '3 d ago', 'no activity yet', 'just now'])
})

test('Health summary: quiet "all good" when nothing needs a fix; amber with the count when something does; red only for a real blocker', () => {
  expect(healthSummary({ fix: 0, standing: 2, info: 3, blocker: false })).toEqual({ label: 'Health: all good', tone: 'quiet', chip: '', extra: '2 standing approvals · 3 info lines' })
  expect(healthSummary({ fix: 0, standing: 0, info: 0, blocker: true }).tone).toBe('quiet') // a blocker is a fix by definition: without a fix item nothing is drawn loud
  expect(healthSummary({ fix: 1, standing: 1, info: 0, blocker: false })).toEqual({ label: 'Health: 1 finding', tone: 'warning', chip: '1 fix', extra: '1 standing approval' })
  expect(healthSummary({ fix: 2, standing: 0, info: 0, blocker: false })).toMatchObject({ label: 'Health: 2 findings', tone: 'warning', chip: '2 fixes' })
  expect(healthSummary({ fix: 2, standing: 0, info: 0, blocker: true }).tone).toBe('error')
})

test('settings: pane.sort (config, else the mod store, else last active), pane.maxSessions (5 to 500, default 30), pane.healthOpen (true or "open")', async () => {
  const h = fakeHost(null)
  expect(await paneConfig(h.host)).toEqual({ sort: 'active', maxSessions: 30, healthOpen: false })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'cost', maxSessions: 12, healthOpen: true } }))
  expect(await paneConfig(h.host)).toEqual({ sort: 'cost', maxSessions: 12, healthOpen: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ 'pane.sort': 'name', 'pane.maxSessions': 7, 'pane.healthOpen': 'open' })) // the flat spelling
  expect(await paneConfig(h.host)).toEqual({ sort: 'name', maxSessions: 7, healthOpen: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'newest', maxSessions: 2, healthOpen: 'yes' } })) // not valid: the defaults
  expect(await paneConfig(h.host)).toEqual({ sort: 'active', maxSessions: 30, healthOpen: false })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { maxSessions: 9999 } }))
  expect((await paneConfig(h.host)).maxSessions).toBe(30)
  // the press that changes the order writes the mod's store AND config pane.sort
  h.files.delete(`${L}/config.json`)
  await saveSort(h.host, 'needs')
  expect(await h.host.store.get('pane.sort')).toBe('needs')
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toMatchObject({ pane: { sort: 'needs' } })
  expect((await paneConfig(h.host)).sort).toBe('needs')
  // the config key wins over the store (it is what the user wrote); a store with no config still remembers the press
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'cost' } }))
  expect((await paneConfig(h.host)).sort).toBe('cost')
  h.files.delete(`${L}/config.json`)
  expect((await paneConfig(h.host)).sort).toBe('needs')
})

test('severity at the source: an own-PR / own-work-item / PR-link notice is information (never an error), whatever its thread; every other notice keeps its level', async () => {
  expect(noticeInfo('ownpr_t145_5706')).toEqual({ info: true, thread: 't145' }) // the file name: ':' became '_'
  expect(noticeInfo('ownpr:t5:wi9')).toEqual({ info: true, thread: 't5' })
  expect(noticeInfo('wipr_t5_4321')).toEqual({ info: true, thread: 't5' })
  for (const k of ['budget-t5', 'restart-t5', 'old-desk', 'githooks', 'rules-cap', 'grant-flag.g1', 'request-exit.a1', 'ownprx_t5_1', 'other']) expect(noticeInfo(k)).toEqual({})
  resetLocks()
  resetViewCache()
  const h = fakeHost(null)
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'synthetic', project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const line = ownLine('t5', { id: 4321, how: 'you passed pr' })
  expect(line).toContain("revoke: Revoke button or 'stop writes'") // the text that was shown as a red error in 1.0.31
  h.files.set(`${L}/notices/ownpr_t5_4321.txt`, line + '\n')
  h.files.set(`${L}/notices/other.txt`, 'something is really broken\n')
  const v = await loadView(h.host)
  const own = v.notices.find(n => n.key === 'ownpr_t5_4321')!
  expect([own.info, own.thread, own.warn, own.budget]).toEqual([true, 't5', undefined, undefined])
  expect(v.notices.find(n => n.key === 'other')!.info).toBeUndefined() // a real failure is not information
})

test('a CLOSED thread with an unread message is always a row of the list (the cap on closed rows never hides an unread message); the others are the newest 40', async () => {
  resetLocks()
  resetViewCache()
  const h = fakeHost(null)
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  for (let n = 1; n <= 45; n++) h.files.set(`${L}/threads/t${n}/thread.json`, JSON.stringify({ id: `t${n}`, title: `closed ${n}`, project: 'p', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0, closedAt: 1000 + n }))
  h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: 5, from: 't1', kind: 'report', text: 'still unread', state: 'working' }) + '\n')
  const v = await loadView(h.host)
  expect(v.closed).toHaveLength(41) // the newest 40 (t45 ... t6) and t1, which has an unread message
  expect(v.closed.some(x => x.id === 't1')).toBe(true)
  expect(v.closed.some(x => x.id === 't2')).toBe(false)
  expect(v.closed.find(x => x.id === 't45')!.activity).toBe(1045) // closedAt
})
