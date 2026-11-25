// The Sessions toolbar card of the desk pane (1.0.33): the sort by thread number (the default, t90 before t89), the direction of every sort (asc / desc chip, a tap on the active chip,
// "sorted by thread ↓" in the folded title, kept in the mod's store and config pane.sortDir), and Hide / Unhide of completed sessions (the "N hidden" chip, Hide all completed, a hidden
// session comes back by itself when it is woken, has an unread message or something waits). Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest } from './deskactions'
import { openToolbar, toolbarTitle } from './panetools'
import { paneConfig } from './panelist'
import { resetViewCache } from './view'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const HOUR = 3_600_000
const SID = (n: number) => `0000000${n}-2222-3333-4444-555555555555`
const line = (o: unknown) => JSON.stringify(o) + '\n'
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const REPLY = { kind: 'ado-pr-reply', params: { org: 'acme', project: 'Shop', repo: 'shop-api', pr: 4321, thread: 7, body: 'Fixed in the next commit.' }, why: 'close the thread' }

function world(on: any, rows: any[] = []) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.clock.t = 1000 * HOUR
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(rows) } : { exitCode: 0, stdout: '' })
  const kv = new Map<string, unknown>()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const host = { ...h.host, store: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) }, clock: { now: async () => h.clock.t } } as any
  const thr = (id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `title ${id}`, project: 'p', state: 'open', sid: '', created: 1, lastWake: h.clock.t - HOUR, delivered: 0, ...o }))
  const report = (...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))
  return { h, kv, host, thr, report, rows }
}
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const setUp = async (ui: any) => {
  if (await ui.find({ type: 'Button', key: 'setup' })) await ui.press({ key: 'setup' })
}
const order = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key)).filter((k: string) => k.startsWith('card-')).map((k: string) => k.slice(5))
const keys = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key))
const btn = async (ui: any, key: string) => String((await ui.find({ type: 'Button', key }))?.text ?? '')
// (1.0.35: the session cards are inside the Sessions card, folded on startup: `mount` unfolds it, once, unless the spec is about the fold itself)
const mount = async ($: any, folded = false) => {
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  if (!folded) await openToolbar(ui)
  return ui
}

// t7, t89, t90 and an id with no number
function threeThreads(w: ReturnType<typeof world>) {
  w.thr('t7', { lastWake: w.h.clock.t - HOUR })
  w.thr('t89', { lastWake: w.h.clock.t - 5 * HOUR })
  w.thr('t90', { lastWake: w.h.clock.t - 3 * HOUR })
}

test('the default order is the thread number, the highest first (t90, t89, t7); the folded title says "sorted by thread ↓"', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  threeThreads(w)
  await inDesk($)
  const ui = await mount($, true)
  expect(await order(ui)).toEqual([]) // 1.0.35: the cards are inside the folded Sessions card
  expect(await toolbarTitle(ui)).toMatch(/^▸ Sessions \(3\) · sorted by thread ↓$/)
  expect((await paneConfig(w.host)).sort).toBe('thread')
  await openToolbar(ui)
  expect(await order(ui)).toEqual(['t90', 't89', 't7'])
  expect(await btn(ui, 'sort-thread')).toBe('● thread ↓')
  expect(await btn(ui, 'sort-dir')).toBe('↓ desc')
  await ui.unmount()
})

test('the direction chip flips the order (t7, t89, t90), the title and the chip follow, the choice is kept (a remount) and written to the store and config pane.sortDir; a tap on the active sort chip flips it back', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  threeThreads(w)
  await inDesk($)
  let ui = await mount($)
  await openToolbar(ui)
  await ui.press({ key: 'sort-dir' })
  expect(await order(ui)).toEqual(['t7', 't89', 't90'])
  expect(await toolbarTitle(ui)).toContain('sorted by thread ↑')
  expect(await btn(ui, 'sort-dir')).toBe('↑ asc')
  expect(await btn(ui, 'sort-thread')).toBe('● thread ↑')
  expect(w.kv.get('pane.sortDir')).toBe('asc')
  expect(JSON.parse(w.h.files.get(`${L}/config.json`)!)).toMatchObject({ pane: { sortDir: 'asc' } })
  await ui.unmount()
  ui = await mount($) // kept
  expect(await order(ui)).toEqual(['t7', 't89', 't90'])
  await ui.press({ key: 'sort-thread' }) // the active chip flips it
  expect(await order(ui)).toEqual(['t90', 't89', 't7'])
  expect(await toolbarTitle(ui)).toContain('sorted by thread ↓')
  await ui.unmount()
})

test('every sort key has both directions in the pane: last active, usage, name (A to Z by default), and "needs you first" keeps its group on top and flips inside each group', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const now = w.h.clock.t
  w.thr('t1', { title: 'mike', lastWake: now - HOUR })
  w.thr('t2', { title: 'alpha', lastWake: now - 5 * HOUR })
  w.thr('t3', { title: 'zulu', lastWake: now - 3 * HOUR })
  w.thr('t4', { title: 'bravo', lastWake: now - 4 * HOUR })
  w.report({ ts: now - 4 * HOUR, from: 't2', kind: 'report', text: 'cannot go on: the credential is missing', state: 'blocked' })
  w.h.files.set(`${L}/ledger.jsonl`, line({ ts: now, role: 'thread', tN: 't3', model: 'x', in: 4000, out: 1, usd: 4 }) + line({ ts: now, role: 'thread', tN: 't4', model: 'x', in: 2000, out: 1, usd: 2 }))
  await inDesk($)
  const ui = await mount($)
  await openToolbar(ui)
  await ui.press({ key: 'sort-active' })
  expect(await order(ui)).toEqual(['t1', 't3', 't4', 't2']) // newest first (the default of this sort)
  await ui.press({ key: 'sort-dir' })
  expect(await order(ui)).toEqual(['t2', 't4', 't3', 't1'])
  await ui.press({ key: 'sort-usage' }) // the direction is kept across the sort
  expect(await order(ui)).toEqual(['t2', 't1', 't4', 't3']) // least usage first (asc); ties by last activity, oldest first
  await ui.press({ key: 'sort-dir' })
  expect(await order(ui)).toEqual(['t3', 't4', 't1', 't2']) // most usage first
  await ui.press({ key: 'sort-name' })
  expect(await order(ui)).toEqual(['t3', 't1', 't4', 't2']) // desc: Z to A (the explicit choice stays desc)
  await ui.press({ key: 'sort-dir' })
  expect(await order(ui)).toEqual(['t2', 't4', 't1', 't3']) // asc: A to Z
  await ui.press({ key: 'sort-needs' })
  expect(await order(ui)).toEqual(['t2', 't4', 't3', 't1']) // t2 is blocked: on top, then the rest oldest first (asc)
  await ui.press({ key: 'sort-dir' })
  expect(await order(ui)).toEqual(['t2', 't1', 't3', 't4']) // desc: t2 still on top, the rest newest first
  await ui.unmount()
})

test('config pane.sortDir overrides the default direction of the sort (asc: t7 first); auto is the default; a bad value is auto', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  threeThreads(w)
  w.h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sortDir: 'asc' } }))
  await inDesk($)
  let ui = await mount($)
  expect(await order(ui)).toEqual(['t7', 't89', 't90'])
  expect(await toolbarTitle(ui)).toContain('sorted by thread ↑')
  await ui.unmount()
  w.h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sortDir: 'sideways' } }))
  ui = await mount($)
  expect(await order(ui)).toEqual(['t90', 't89', 't7'])
  await ui.unmount()
})

// a fixture of every state: t1 needs you (a question), t2 working, t3 done, t4 closed, t5 done with a pending approval, t6 done
function states(w: ReturnType<typeof world>) {
  w.thr('t1', { sid: SID(1) })
  w.thr('t2', { sid: SID(2), lastWake: w.h.clock.t - 5 * 60_000 })
  w.thr('t3', { sid: SID(3), lastWake: w.h.clock.t - 4 * HOUR }) // (woken before it reported: a thread whose report is older than its wake would be "no report")
  w.thr('t4', { state: 'closed', closedAt: w.h.clock.t - 3 * HOUR })
  w.thr('t5', { sid: SID(5), lastWake: w.h.clock.t - 4 * HOUR })
  w.thr('t6', { sid: SID(6), lastWake: w.h.clock.t - 4 * HOUR })
  w.rows.push({ sessionId: SID(2), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }, { sessionId: SID(3), name: 'y', cwd: '/y', status: 'idle', state: 'done', startedAt: 1 }, { sessionId: SID(6), name: 'z', cwd: '/z', status: 'idle', state: 'done', startedAt: 1 })
  w.report({ ts: w.h.clock.t - 60_000, from: 't2', kind: 'report', text: 'Halfway through the synthetic job', state: 'working' })
  w.report({ ts: w.h.clock.t - 2 * HOUR, from: 't3', kind: 'report', text: 'Done and merged', state: 'done' })
  w.report({ ts: w.h.clock.t - 2 * HOUR, from: 't5', kind: 'report', text: 'Done too', state: 'done' })
  w.report({ ts: w.h.clock.t - 2 * HOUR, from: 't6', kind: 'report', text: 'Done as well', state: 'done' })
  w.report({ ts: w.h.clock.t - 3 * HOUR, from: 't1', kind: 'ask', text: 'which cache?' })
}
// the unread rows are read, so a done thread is only "done" (acknowledge all: the reports of t3, t5, t6 are not news)
const ackAll = async (ui: any) => {
  if (await ui.find({ type: 'Button', key: 'ack-all' })) await ui.press({ key: 'ack-all' })
}

test('Hide is on a done and on a closed card only (folded line 2 and unfolded), never on a working, waiting or needs-you one, nor on a done one with something unread or pending', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  states(w)
  await addActionRequest(w.host, 't5', REPLY)
  await inDesk($)
  const ui = await mount($)
  await ackAll(ui)
  const k = await keys(ui)
  expect(k).toContain('hide-t3') // done
  expect(k).toContain('hide-t4') // closed
  expect(k).toContain('hide-t6')
  for (const id of ['t1', 't2', 't5']) expect(k, id).not.toContain(`hide-${id}`) // needs you, working, a decision pending
  expect(await btn(ui, 'hide-t3')).toBe('Hide')
  expect(k).not.toContain('hide-more-t3') // unfolded only
  await ui.press({ key: 'card-t3' })
  expect(await btn(ui, 'hide-more-t3')).toBe('Hide')
  expect(await btn(ui, 'view-t3')).toBe('Open') // (Open is still the primary button)
  await ui.unmount()
})

test('Hide takes the card out of the list and closes nothing; "N hidden" says how many; a tap shows them folded with Unhide instead of Hide; the choice is kept in the mod store and across a remount', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  states(w)
  await inDesk($)
  let ui = await mount($)
  await ackAll(ui)
  expect(await order(ui)).toContain('t3')
  await ui.press({ key: 'hide-t3' })
  expect(await order(ui)).not.toContain('t3')
  expect(await btn(ui, 'hidden-chip')).toBe('1 hidden')
  expect(Object.keys(w.kv.get('pane.hidden') as object)).toEqual(['t3'])
  expect(JSON.parse(w.h.files.get(`${L}/threads/t3/thread.json`)!).state).toBe('open') // nothing was closed or deleted
  expect(w.h.claudeCalls().some((a: string[]) => a[0] === 'stop' || a[0] === 'rm')).toBe(false)
  expect(await toolbarTitle(ui)).toContain('Sessions (5)') // the list without it
  await ui.press({ key: 'hide-t4' })
  expect(await btn(ui, 'hidden-chip')).toBe('2 hidden')
  await ui.unmount()
  ui = await mount($) // kept
  expect(await order(ui)).not.toContain('t3')
  expect(await btn(ui, 'hidden-chip')).toBe('2 hidden')
  await ui.press({ key: 'hidden-chip' }) // show them
  expect(await order(ui)).toEqual(expect.arrayContaining(['t3', 't4']))
  const k = await keys(ui)
  expect(k).toContain('unhide-t3')
  expect(k).not.toContain('hide-t3')
  expect((await ui.find({ type: 'Button', key: 'card-t3' }))?.text.startsWith('▸')).toBe(true) // folded
  await ui.press({ key: 'unhide-t3' })
  expect(Object.keys(w.kv.get('pane.hidden') as object)).toEqual(['t4'])
  await ui.press({ key: 'hidden-chip' }) // hide them again
  expect(await order(ui)).toContain('t3')
  expect(await order(ui)).not.toContain('t4')
  await ui.unmount()
})

test('a hidden session comes back by itself when it is woken, has an unread message, or something waits for the user (never hide away anything that needs the user)', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  states(w)
  await inDesk($)
  let ui = await mount($)
  await ackAll(ui)
  for (const id of ['t3', 't6', 't4']) await ui.press({ key: `hide-${id}` })
  expect(await btn(ui, 'hidden-chip')).toBe('3 hidden')
  await ui.unmount()
  // t3 is woken (its last wake moves: new activity)
  w.thr('t3', { sid: SID(3), lastWake: w.h.clock.t - 60_000 })
  // t6 gets an unread message from its thread
  w.report({ ts: w.h.clock.t - 30_000, from: 't6', kind: 'report', text: 'one more thing', state: 'done' })
  resetViewCache()
  ui = await mount($)
  expect(await order(ui)).toContain('t3')
  expect(await order(ui)).toContain('t6')
  expect(await order(ui)).not.toContain('t4') // still hidden
  expect(await btn(ui, 'hidden-chip')).toBe('1 hidden')
  await ui.unmount()
  // t4 (closed) has a request waiting for the user: back
  await addActionRequest(w.host, 't4', REPLY).catch(() => undefined)
  w.h.files.set(`${L}/threads/t4/thread.json`, JSON.stringify({ id: 't4', title: 'title t4', project: 'p', state: 'open', sid: SID(4), created: 1, lastWake: 0, delivered: 0 }))
  resetViewCache()
  ui = await mount($)
  expect(await order(ui)).toContain('t4') // reopened: no longer completed
  expect(await ui.find({ type: 'Button', key: 'hidden-chip' })).toBeFalsy()
  await ui.unmount()
})

test('a hidden done session with a pending decision comes back (and the decision count says so)', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  states(w)
  await inDesk($)
  let ui = await mount($)
  await ackAll(ui)
  await ui.press({ key: 'hide-t6' })
  expect(await order(ui)).not.toContain('t6')
  await ui.unmount()
  await addActionRequest(w.host, 't6', REPLY)
  resetViewCache()
  ui = await mount($)
  expect(await order(ui)).toContain('t6')
  expect(await keys(ui)).not.toContain('hide-t6') // nothing to hide away while it needs you
  expect((await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text))).toContain('1 to decide')
  await ui.unmount()
})

test('Hide all completed (on the unfolded toolbar) hides every done and closed session that has nothing unread or waiting, and only those', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  states(w)
  await addActionRequest(w.host, 't5', REPLY)
  await inDesk($)
  let ui = await mount($, true)
  expect(await ui.find({ type: 'Button', key: 'hide-completed' })).toBeFalsy() // the unfolded part only
  await openToolbar(ui)
  await ackAll(ui)
  expect(await btn(ui, 'hide-completed')).toBe('Hide all completed (3)') // t3, t4, t6 (not t5: a decision waits)
  await ui.press({ key: 'hide-completed' })
  expect(await order(ui)).toEqual(expect.arrayContaining(['t1', 't2', 't5']))
  for (const id of ['t3', 't4', 't6']) expect(await order(ui), id).not.toContain(id)
  expect(await btn(ui, 'hidden-chip')).toBe('3 hidden')
  expect(await ui.find({ type: 'Button', key: 'hide-completed' })).toBeFalsy() // nothing left to hide
  expect(Object.keys(w.kv.get('pane.hidden') as object).sort()).toEqual(['t3', 't4', 't6'])
  await ui.unmount()
  ui = await mount($) // persisted
  expect(await btn(ui, 'hidden-chip')).toBe('3 hidden')
  await ui.unmount()
})
