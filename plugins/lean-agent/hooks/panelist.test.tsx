// The desk pane's session list and Health card as drawn (1.0.32): the order of the rows, the sort chips, closed rows with their age, folded and unfolded
// cards, the cap with "show more", Health folded / highlighted / quiet, the own-PR notice under Standing approvals. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { openHeader, openToolbar, toolbarTitle } from './panetools'
import { ownRevoked } from './deskwrites'
import { ownLine } from './ownpr'
import { paneConfig } from './panelist'
import { writeReview } from './reviews'
import { resetViewCache } from './view'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const HOUR = 3_600_000
const line = (o: unknown) => JSON.stringify(o) + '\n'

function world(on: any) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.clock.t = 1000 * HOUR // (the fake clock starts at 16 minutes past the epoch: ages in hours need room)
  // what the setup copies from the plugin: with these a press of "Set up lean-agent" finishes the setup (see setUp)
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  const kv = new Map<string, unknown>()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const thr = (id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `title ${id}`, project: 'p', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
  // the mod's store as the pane's engine instance sees it (the specs read what a press wrote)
  const host = { ...h.host, store: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) } } as any
  return { h, thr, kv, host }
}
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
// the rows of the list, top to bottom (the title button of each card)
const order = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key)).filter((k: string) => k.startsWith('card-')).map((k: string) => k.slice(5))
const setUp = async (ui: any) => {
  if (await ui.find({ type: 'Button', key: 'setup' })) await ui.press({ key: 'setup' })
}
const openHealth = async (ui: any) => {
  const b = await ui.find({ type: 'Button', key: 'sec-health' })
  if (b && String(b.text).startsWith('▸')) await ui.press({ key: 'sec-health' })
}

test('the list is ordered by thread number (the highest first) by default; the chip "last active" puts the newest first, open and closed threads together', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  const now = h.clock.t
  thr('t1', { lastWake: now - 3 * HOUR })
  thr('t2', { lastWake: now - 1 * HOUR })
  thr('t3', { lastWake: now - 2 * HOUR })
  thr('t4', { state: 'closed', closedAt: now - HOUR / 2 })
  thr('t5', { lastWake: now - 5 * HOUR })
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: now - 10 * 60_000, from: 't5', kind: 'report', text: 'a report 10 minutes ago', state: 'working' })) // a report is activity too
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await order(ui)).toEqual(['t5', 't4', 't3', 't2', 't1']) // the default: thread, t5 before t4
  expect(await toolbarTitle(ui)).toContain('sorted by thread ↓') // the sort and its direction are named in the folded title; the chips are on the unfolded toolbar
  expect(await ui.find({ type: 'Button', key: 'sort-active' })).toBeFalsy()
  await openToolbar(ui)
  expect((await ui.find({ type: 'Button', key: 'sort-thread' }))?.text).toBe('● thread ↓')
  await ui.press({ key: 'sort-active' })
  expect(await order(ui)).toEqual(['t5', 't4', 't2', 't3', 't1'])
  expect((await ui.find({ type: 'Button', key: 'sort-active' }))?.text).toBe('● last active ↓')
  expect((await ui.find({ type: 'Button', key: 'sort-name' }))?.text).toBe('name')
  expect(await texts(ui)).toContain('closed 30 min ago') // the closed row carries the age of its last activity
  expect(await texts(ui)).toContain('2 h ago') // t3
  await ui.unmount()
})

test('closed and done threads are one quiet row with their age ("closed 3 h ago"), an Open button and a state chip; the rest (Reopen, the last line) is on a tap', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  const now = h.clock.t
  thr('t1', { state: 'closed', closedAt: now - 3 * HOUR })
  thr('t2', { lastWake: now - 2 * HOUR })
  h.files.set(`${L}/threads/t1/notes.md`, 'the last note of t1\n')
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: now - 2 * HOUR, from: 't2', kind: 'report', text: 'merged', state: 'done' }))
  h.files.set(`${L}/ledger.jsonl`, line({ ts: now, role: 'thread', tN: 't1', model: 'x', in: 1250, usd: 0 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const all = await texts(ui)
  expect(all).toContain('[closed]')
  expect(all).toContain('closed 3 h ago')
  expect(all).toContain('[done]')
  expect(all).toContain('2 h ago')
  expect(all).toContain('window 1.3k tokens') // the usage of the closed row
  for (const k of ['view-t1', 'view-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy() // ONE row each: title, chip, cost, age, Open
  expect(await ui.find({ type: 'Button', key: 'reopen-t1' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /the last note of t1/ })).toBeFalsy()
  await ui.press({ key: 'card-t1' })
  expect(await ui.find({ type: 'Button', key: 'reopen-t1' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /the last note of t1/ })).toBeTruthy()
  await ui.press({ key: 'card-t1' }) // a second tap folds it again
  expect(await ui.find({ type: 'Button', key: 'reopen-t1' })).toBeFalsy()
  await ui.unmount()
})

test('the sort control: one tap changes the order, keeps it across a remount and writes config pane.sort and the mod store; needs you first puts the waiting thread on top', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr, kv } = world(on)
  const now = h.clock.t
  thr('t1', { title: 'mike', lastWake: now - HOUR })
  thr('t2', { title: 'alpha', lastWake: now - 5 * HOUR })
  thr('t3', { title: 'zulu', lastWake: now - 3 * HOUR })
  thr('t4', { title: 'bravo', state: 'closed', closedAt: now - 2 * HOUR })
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: now - 4 * HOUR, from: 't2', kind: 'report', text: 'cannot go on: the credential is missing', state: 'blocked' }))
  h.files.set(`${L}/ledger.jsonl`, line({ ts: now, role: 'thread', tN: 't3', model: 'x', in: 4000, usd: 0 }) + line({ ts: now, role: 'thread', tN: 't4', model: 'x', in: 2000, usd: 0 }))
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await order(ui)).toEqual(['t4', 't3', 't2', 't1']) // thread (the default)
  await openToolbar(ui)
  await ui.press({ key: 'sort-active' })
  expect(await order(ui)).toEqual(['t1', 't4', 't3', 't2']) // last active
  await ui.press({ key: 'sort-name' })
  expect(await toolbarTitle(ui)).toContain('sorted by name ↑')
  expect(await order(ui)).toEqual(['t2', 't4', 't1', 't3'])
  expect((await ui.find({ type: 'Button', key: 'sort-name' }))?.text).toBe('● name ↑')
  expect((await ui.find({ type: 'Button', key: 'sort-active' }))?.text).toBe('last active')
  await ui.press({ key: 'sort-usage' })
  expect(await order(ui)).toEqual(['t3', 't4', 't1', 't2']) // most usage tokens first, then the last activity
  await ui.press({ key: 'sort-needs' })
  expect(await order(ui)).toEqual(['t2', 't1', 't4', 't3']) // t2 is blocked: on top; the rest by last activity
  expect((await paneConfig(h.host)).sort).toBe('needs') // config pane.sort
  expect(kv.get('pane.sort')).toBe('needs') // and the mod's store
  expect(JSON.parse(h.files.get(`${L}/config.json`)!)).toMatchObject({ pane: { sort: 'needs' } })
  await ui.unmount()
  ui = await $.ui.mount(PANE as any) // a redraw keeps it
  expect(await order(ui)).toEqual(['t2', 't1', 't4', 't3'])
  await ui.press({ key: 'sort-active' })
  expect(await order(ui)).toEqual(['t1', 't4', 't3', 't2'])
  await ui.unmount()
})

test('a card is two lines collapsed: title, state chip, cost, age (the report line, the buttons and the messages are folded); one tap unfolds it', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  const now = h.clock.t
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify([{ sessionId: '00000001-2222-3333-4444-555555555555', name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }]) } : { exitCode: 0, stdout: '' })
  thr('t1', { sid: '00000001-2222-3333-4444-555555555555', lastWake: now - 5 * 60_000 })
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: now - 60_000, from: 't1', kind: 'report', text: 'Halfway through the synthetic job', state: 'working' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const all = await texts(ui)
  expect(all).toContain('[working]')
  expect(all).toContain('1 min ago')
  expect(all).not.toContain('Halfway through the synthetic job') // folded
  expect(await ui.find({ type: 'Button', key: 'new-t1' })).toBeTruthy() // the "N new" chip stays on the collapsed card
  for (const k of ['restart-t1', 'inbox-toggle-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy() // 1.0.33: Open is at the right end of line 2 of every card, folded
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toBe('▸ t1 title t1')
  await ui.press({ key: 'card-t1' })
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toBe('▾ t1 title t1')
  expect(await texts(ui)).toContain('Halfway through the synthetic job')
  for (const k of ['view-t1', 'restart-t1', 'inbox-toggle-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  expect(await ui.findAll({ type: 'Button', key: 'view-t1' })).toHaveLength(1) // (one Open, not one on the line and one in the buttons)
  await ui.unmount()
})

test('pane.maxSessions: the list stops at the cap with ONE "show more" row; a row with an unread message is always listed; show more / show fewer', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  const now = h.clock.t
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'active', maxSessions: 5 } }))
  for (let n = 1; n <= 12; n++) thr(`t${n}`, { lastWake: now - n * HOUR }) // t1 is the newest, t12 the oldest
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: now - 20 * HOUR, from: 't12', kind: 'report', text: 'an old unread report', state: 'working' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await order(ui)).toEqual(['t1', 't2', 't3', 't4', 't5', 't12']) // the cap, and t12 because it has an unread message
  expect(await ui.findAll({ type: 'Button', text: /^show more/ })).toHaveLength(1)
  expect((await ui.find({ type: 'Button', key: 'sessions-more' }))?.text).toBe('show more (6 older)')
  expect(await toolbarTitle(ui)).toContain('Sessions (12)')
  await ui.press({ key: 'sessions-more' })
  expect(await order(ui)).toHaveLength(12)
  expect(await ui.find({ type: 'Button', key: 'sessions-more' })).toBeFalsy()
  await ui.press({ key: 'sessions-less' })
  expect(await order(ui)).toHaveLength(6)
  await ui.unmount()
  h.files.delete(`${L}/config.json`) // the default is 30: all twelve
  const ui2 = await $.ui.mount(PANE as any)
  expect(await order(ui2)).toHaveLength(12)
  expect(await ui2.find({ type: 'Button', key: 'sessions-more' })).toBeFalsy()
  await ui2.unmount()
})

test('Health: folded on startup; quiet and grey ("Health: all good", no chip) when nothing needs a fix; amber with the count and a header chip when something does; red only for a real failure', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  thr('t1')
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const bordered = async (color: string) => (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderColor === color).length
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: all good') // folded, quiet
  expect(await ui.find({ type: 'Button', key: 'health-chip' })).toBeFalsy()
  expect(await bordered('warning')).toBe(0)
  expect(await bordered('error')).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'Needs a fix' })).toBeFalsy()
  await ui.unmount()
  // a heads-up that needs the user (the rules cap): amber, one finding, the chip says "1 fix"; still folded
  h.files.set(`${L}/notices/rules-cap.txt`, 'rules synthetic: 1 over the size cap, still loaded\n')
  resetViewCache()
  ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: 1 finding')
  expect((await ui.find({ type: 'Button', key: 'health-chip' }))?.text).toBe('1 fix')
  expect(await bordered('warning')).toBe(1)
  expect(await bordered('error')).toBe(0)
  expect(await ui.find({ type: 'Text', text: /over the size cap/ })).toBeFalsy() // folded
  await ui.press({ key: 'health-chip' }) // a tap on the chip opens it
  expect(await ui.find({ type: 'Text', text: 'Needs a fix' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /over the size cap/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'notice-dismiss-rules-cap' })).toBeTruthy() // its own Dismiss
  await ui.press({ key: 'notice-dismiss-rules-cap' }) // dismissed: quiet again
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toMatch(/^▾ Health: all good/)
  expect(await ui.find({ type: 'Button', key: 'health-chip' })).toBeFalsy()
  await ui.unmount()
  // a real failure: red
  h.files.set(`${L}/notices/other.txt`, 'something is really broken\n')
  resetViewCache()
  ui = await $.ui.mount(PANE as any)
  expect(await bordered('error')).toBe(1)
  expect(await bordered('warning')).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'error: something is really broken' })).toBeTruthy() // (Health stays unfolded: it was opened above)
  await ui.unmount()
})

test('a failed load is never hidden: Health is unfolded by itself and the red error line is on screen (the pane is never blank)', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  thr('t1')
  await inDesk($)
  h.claude.handler = () => ({ exitCode: 3, stdout: '' })
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toMatch(/^▾ Health: \d+ findings?/)
  expect((await ui.find({ type: 'Text', text: /^error: agents/ }))?.text).toContain('exited 3')
  await ui.unmount()
})

test('a done thread with a report ready to push is a card with an amber border and its Open button, not a quiet row; its need is on the unfolded card', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr, kv } = world(on)
  const sha = 'abcdef1' + '0'.repeat(33)
  const KEY = 'k'.repeat(64)
  kv.set('review.key', KEY) // the pane's engine instance signs and verifies with this key
  thr('t1', { lastWake: h.clock.t - HOUR })
  h.files.set(`${L}/desk/inbox.jsonl`, line({ ts: h.clock.t - 60_000, from: 't1', kind: 'report', text: `Done. Branch: feat/x, commit ${sha.slice(0, 7)}, not pushed.`, state: 'done' }))
  await h.host.store.set('review.key', KEY)
  await writeReview(h.host, { green: true, sha, project: 'p', branch: 'feat/x' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy()
  expect((await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderColor === 'warning').length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /is ready to push/ })).toBeFalsy()
  await ui.press({ key: 'card-t1' })
  expect(await ui.find({ type: 'Text', text: /is ready to push/ })).toBeTruthy()
  await ui.unmount()
})

test('"ack N" on a card reads only the rows the card shows (20 at most): an unread row that was never drawn stays unread', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  thr('t1')
  h.files.set(`${L}/desk/inbox.jsonl`, Array.from({ length: 25 }, (_, n) => line({ ts: h.clock.t - (30 - n) * 1000, from: 't1', kind: 'report', text: `report ${n}`, state: 'working' })).join(''))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await ui.press({ key: 'card-t1' })
  await ui.press({ key: 'ack-card-t1' })
  expect(await toolbarTitle(ui)).toContain('5 unread')
  expect(await ui.find({ type: 'Button', text: '5 new' })).toBeTruthy()
  await ui.unmount()
})

test('a PR-link notice (wipr) is information with Dismiss only; Revoke is for an own-PR line, and it clears every own-PR line of that thread', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  thr('t5', { pr: { host: 'azure', org: 'acme', project: 'Shop', repo: 'shop-api', id: 4321, number: 4321, url: '', since: 1, how: 'you passed pr' } })
  await inDesk($)
  h.files.set(`${L}/notices/ownpr_t5_4321.txt`, ownLine('t5', { id: 4321, how: 'you passed pr' }) + '\n')
  h.files.set(`${L}/notices/ownpr_t5_wi9.txt`, 't5 owns work item 9 (it created the work item): moving it to Reviewing goes out without a question\n')
  h.files.set(`${L}/notices/wipr_t5_4321.txt`, 't5 linked PR 4321 to work item 9\n')
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openHealth(ui)
  expect(await ui.find({ type: 'Button', key: 'own-revoke-wipr_t5_4321' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'notice-dismiss-wipr_t5_4321' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /t5 linked PR 4321/ })).toBeTruthy()
  await ui.press({ key: 'own-revoke-ownpr_t5_4321' })
  expect(h.files.has(`${L}/notices/ownpr_t5_4321.txt`)).toBe(false)
  expect(h.files.has(`${L}/notices/ownpr_t5_wi9.txt`)).toBe(false)
  expect(h.files.has(`${L}/notices/wipr_t5_4321.txt`)).toBe(true) // what already went out stays as information
  await ui.unmount()
})

test('pane.healthOpen starts Health unfolded; the pane remembers a fold after that',{ timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr } = world(on)
  thr('t1')
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { healthOpen: true } }))
  await inDesk($)
  h.files.set(`${L}/notices/rules-cap.txt`, 'rules synthetic: 1 over the size cap, still loaded\n') // (after the session start: it clears a rules-cap notice it finds nothing behind)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▾ Health: 1 finding')
  expect(await ui.find({ type: 'Text', text: /over the size cap/ })).toBeTruthy()
  await ui.press({ key: 'sec-health' })
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: 1 finding')
  await ui.unmount()
})

test('Health groups: a finding that needs a fix, the standing approvals and information; the own-PR line is information under Standing approvals, never red, with its thread, its PR and a Revoke button', { timeoutMs: 20_000 }, async ($, on) => {
  const { h, thr, host } = world(on)
  thr('t5', { pr: { host: 'azure', org: 'acme', project: 'Shop', repo: 'shop-api', id: 4321, number: 4321, url: '', since: 1, how: 'you passed pr' } })
  h.files.set(`${L}/notices/ownpr_t5_4321.txt`, ownLine('t5', { id: 4321, how: 'you passed pr' }) + '\n')
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  // information only: Health is quiet and says how many standing approvals it holds
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: all good')
  expect(await ui.find({ type: 'Text', text: '1 standing approval' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'health-chip' })).toBeFalsy()
  await openHealth(ui)
  const own = await ui.find({ type: 'Text', text: /t5 owns PR 4321/ })
  expect(own).toBeTruthy()
  expect(String(own?.text)).not.toMatch(/^error/) // 1.0.31 drew this line as "error: ..."
  expect(own?.props?.color).toBeUndefined() // not red, not amber: the normal text colour
  expect(await ui.find({ type: 'Text', text: 'Standing approvals' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Needs a fix' })).toBeFalsy()
  expect((await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderColor === 'error').length).toBe(0)
  // Revoke: the thread loses the own-PR default (deskwrites.ts revokeOwn) and the line goes
  expect(await ui.find({ type: 'Button', key: 'own-revoke-ownpr_t5_4321' })).toBeTruthy()
  await ui.press({ key: 'own-revoke-ownpr_t5_4321' })
  expect((await ownRevoked(host)).t5).toBeGreaterThan(0)
  expect(h.files.has(`${L}/notices/ownpr_t5_4321.txt`)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /t5 owns PR 4321/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /no longer sends its own PR replies/ })).toBeTruthy()
  await ui.unmount()
})
