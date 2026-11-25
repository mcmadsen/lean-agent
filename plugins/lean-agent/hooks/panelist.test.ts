// The pane's session list and Health card, without an engine: the order (last activity, needs you first, cost, name), the cap, the age text, the
// settings, what Health says when folded, and the level of the own-PR notice. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { DEFAULT_DIR, ageText, canHide, capItems, completed, effectiveDir, isHidden, itemsOf, modelChip, needsUser, paneConfig, readHidden, saveHidden, saveSort, saveSortDir, sortItems } from './panelist'

test('modelChip: model/effort with the effort abbreviated (low, med, high, xhigh, max), a leading "claude-" dropped, nothing when neither is recorded', () => {
  expect(modelChip('sonnet', 'high')).toBe('sonnet/high')
  expect(modelChip('haiku', 'low')).toBe('haiku/low')
  expect(modelChip('opus', 'medium')).toBe('opus/med')
  expect(modelChip('opus', 'med')).toBe('opus/med')
  expect(modelChip('opus', 'xhigh')).toBe('opus/xhigh')
  expect(modelChip('opus', 'MAX')).toBe('opus/max')
  expect(modelChip('claude-sonnet-5-5', 'high')).toBe('sonnet-5-5/high')
  expect(modelChip('sonnet')).toBe('sonnet')
  expect(modelChip(undefined, 'high')).toBe('high')
  expect(modelChip()).toBe('')
  expect(modelChip('', '')).toBe('')
  expect(modelChip('  ', undefined)).toBe('')
})
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

test('sort: needs you first puts what waits for the user on top, each group by last activity; usage: most usage tokens first ("cost" is its old name); name: A to Z', () => {
  const rows = [t('t1', { activity: 500 }), t('t2', { activity: 100, blocked: true }), t('t3', { activity: 300, asking: true, cost: 9 }), t('t4', { activity: 400, cost: 2 }), t('t5', { activity: 50, pending: 'waiting for your Approve: reply' }), t('t7', { activity: 10, title: 'alpha' })]
  const closed = [c('t6', { activity: 600, cost: 20, title: 'Zulu' })]
  const items = itemsOf(rows, closed, [{ thread: 't1' }])
  // t1 has a card with a need, t2 is blocked, t3 asks, t5 has a request waiting: all four on top (by activity), then the rest (the closed row among them)
  expect(ids(sortItems(items, 'needs'))).toEqual(['t1', 't3', 't2', 't5', 't6', 't4', 't7'])
  expect(ids(sortItems(items, 'usage'))).toEqual(['t6', 't3', 't4', 't1', 't2', 't5', 't7']) // usage tokens, then the last activity
  expect(ids(sortItems(items, 'usage' as never))).toEqual(ids(sortItems(items, 'usage'))) // the old name is an alias
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

test('sort: thread (the default) puts the highest thread number first (t90, t89, t7); an id without a number is last in BOTH directions; asc reverses', () => {
  const items = itemsOf([t('t7'), t('t89'), t('t90'), t('scratch')], [c('t20')])
  expect(ids(sortItems(items, 'thread'))).toEqual(['t90', 't89', 't20', 't7', 'scratch'])
  expect(ids(sortItems(items, 'thread', 'desc'))).toEqual(['t90', 't89', 't20', 't7', 'scratch'])
  expect(ids(sortItems(items, 'thread', 'asc'))).toEqual(['t7', 't20', 't89', 't90', 'scratch'])
  expect(DEFAULT_DIR).toEqual({ thread: 'desc', active: 'desc', needs: 'desc', usage: 'desc', name: 'asc' })
})

test('sort: every key has both directions, its own default first', () => {
  const items = itemsOf([t('t1', { activity: 500, cost: 1, title: 'bravo' }), t('t2', { activity: 300, cost: 9, title: 'Alpha' }), t('t3', { activity: 400, cost: 5, title: 'charlie' })], [])
  expect(ids(sortItems(items, 'active'))).toEqual(['t1', 't3', 't2'])
  expect(ids(sortItems(items, 'active', 'asc'))).toEqual(['t2', 't3', 't1'])
  expect(ids(sortItems(items, 'usage'))).toEqual(['t2', 't3', 't1'])
  expect(ids(sortItems(items, 'usage', 'asc'))).toEqual(['t1', 't3', 't2'])
  expect(ids(sortItems(items, 'name'))).toEqual(['t2', 't1', 't3'])
  expect(ids(sortItems(items, 'name', 'desc'))).toEqual(['t3', 't1', 't2'])
  expect(ids(sortItems(items, 'thread'))).toEqual(['t3', 't2', 't1'])
  expect(ids(sortItems(items, 'thread', 'asc'))).toEqual(['t1', 't2', 't3'])
})

test('sort: needs you first keeps its two groups whatever the direction; the direction applies inside each group (by last activity)', () => {
  const rows = [t('t1', { activity: 500 }), t('t2', { activity: 100, blocked: true }), t('t3', { activity: 300, asking: true }), t('t4', { activity: 400 }), t('t5', { activity: 50, blocked: true })]
  const items = itemsOf(rows, [])
  expect(ids(sortItems(items, 'needs'))).toEqual(['t3', 't2', 't5', 't1', 't4'])
  expect(ids(sortItems(items, 'needs', 'desc'))).toEqual(['t3', 't2', 't5', 't1', 't4'])
  expect(ids(sortItems(items, 'needs', 'asc'))).toEqual(['t5', 't2', 't3', 't4', 't1'])
})

test('direction: the effective one is the explicit choice, else the default of the sort; a press writes the store AND config pane.sortDir; the config key wins over the store', async () => {
  expect(effectiveDir({ sort: 'thread', sortDir: 'auto' })).toBe('desc')
  expect(effectiveDir({ sort: 'name', sortDir: 'auto' })).toBe('asc')
  expect(effectiveDir({ sort: 'name', sortDir: 'desc' })).toBe('desc')
  const h = fakeHost(null)
  await saveSortDir(h.host, 'asc')
  expect(await h.host.store.get('pane.sortDir')).toBe('asc')
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toMatchObject({ pane: { sortDir: 'asc' } })
  expect((await paneConfig(h.host)).sortDir).toBe('asc')
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sortDir: 'desc' } }))
  expect((await paneConfig(h.host)).sortDir).toBe('desc')
  h.files.delete(`${L}/config.json`)
  expect((await paneConfig(h.host)).sortDir).toBe('asc') // a store with no config still remembers the press
})

test('hide: only a completed session (done, or closed) can be hidden; it stays hidden only while nothing is newer, unread or waiting; the set lives in the mod store', async () => {
  const items = itemsOf([t('t1', { done: true, activity: 100 }), t('t2', { activity: 100 }), t('t3', { done: true, working: true, run: 'running' }), t('t4', { done: true, needsYou: true }), t('t6', { done: true, pending: 'waiting for your Approve: reply' })], [c('t5', { activity: 50 })], [{ thread: 't4' }])
  const by = Object.fromEntries(items.map(i => [i.id, i]))
  const free = { unread: false, held: false }
  expect(Object.fromEntries(items.map(i => [i.id, canHide(i, free)]))).toEqual({ t1: true, t2: false, t3: false, t4: false, t5: true, t6: false })
  expect(completed(by.t1!)).toBe(true)
  expect(completed(by.t5!)).toBe(true)
  expect(canHide(by.t1!, { unread: true, held: false })).toBe(false) // an unread message
  expect(canHide(by.t1!, { unread: false, held: true })).toBe(false) // a held send
  expect(isHidden(by.t1!, { t1: 100 }, free)).toBe(true)
  expect(isHidden(by.t1!, { t1: 99 }, free)).toBe(false) // something newer happened (a wake, a report, a message)
  expect(isHidden(by.t1!, {}, free)).toBe(false)
  expect(isHidden(by.t1!, { t1: 100 }, { unread: true, held: false })).toBe(false) // reappears with an unread message
  expect(isHidden(by.t2!, { t2: 100 }, free)).toBe(false) // not completed
  const h = fakeHost(null)
  await saveHidden(h.host, cur => ({ ...cur, t1: 100, t5: 50 }))
  await h.host.store.set('pane.hidden', { t1: 100, t5: 50, bad: 3, t9: 'x' })
  expect(await readHidden(h.host)).toEqual({ t1: 100, t5: 50 }) // junk is left out
  await saveHidden(h.host, cur => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 't1')))
  expect(await readHidden(h.host)).toEqual({ t5: 50 })
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

test('settings: pane.sort (config, else the mod store, else thread), pane.sortDir (auto | asc | desc), pane.maxSessions (5 to 500, default 30), pane.healthOpen (true or "open")', async () => {
  const h = fakeHost(null)
  expect(await paneConfig(h.host)).toEqual({ sort: 'thread', sortDir: 'auto', maxSessions: 30, healthOpen: false, foldAll: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'cost', maxSessions: 12, healthOpen: true } })) // the old name
  expect(await paneConfig(h.host)).toEqual({ sort: 'usage', sortDir: 'auto', maxSessions: 12, healthOpen: true, foldAll: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ 'pane.sort': 'name', 'pane.sortDir': 'desc', 'pane.maxSessions': 7, 'pane.healthOpen': 'open' })) // the flat spelling
  expect(await paneConfig(h.host)).toEqual({ sort: 'name', sortDir: 'desc', maxSessions: 7, healthOpen: true, foldAll: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'newest', sortDir: 'up', maxSessions: 2, healthOpen: 'yes' } })) // not valid: the defaults
  expect(await paneConfig(h.host)).toEqual({ sort: 'thread', sortDir: 'auto', maxSessions: 30, healthOpen: false, foldAll: true })
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { maxSessions: 9999 } }))
  expect((await paneConfig(h.host)).maxSessions).toBe(30)
  // the press that changes the order writes the mod's store AND config pane.sort
  h.files.delete(`${L}/config.json`)
  await saveSort(h.host, 'needs')
  expect(await h.host.store.get('pane.sort')).toBe('needs')
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toMatchObject({ pane: { sort: 'needs' } })
  expect((await paneConfig(h.host)).sort).toBe('needs')
  // the config key wins over the store (it is what the user wrote); a store with no config still remembers the press
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'usage' } }))
  expect((await paneConfig(h.host)).sort).toBe('usage')
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'cost' } }))
  expect((await paneConfig(h.host)).sort).toBe('usage') // the old name still reads
  h.files.delete(`${L}/config.json`)
  expect((await paneConfig(h.host)).sort).toBe('needs')
})

test('severity at the source: an own-PR / own-work-item / PR-link notice is information (never an error), whatever its thread; every other notice keeps its level', async () => {
  expect(noticeInfo('ownpr_t5_4321')).toEqual({ info: true, thread: 't5' }) // the file name: ':' became '_'
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
