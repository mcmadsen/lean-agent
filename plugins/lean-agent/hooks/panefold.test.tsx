// The desk pane as cards (1.0.33): EVERY block is a card, everything is folded on startup (a session that needs you too), only the user's tap unfolds one and the
// fold is kept, a folded session card is exactly two lines, the header card is one line folded, the toolbar card shows its sort chips only unfolded.
// Everything is synthetic: names, titles and numbers are made up.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest } from './deskactions'
import { paneConfig } from './panelist'
import { bodyOf, cardByKey, cardWith, has, isCard, keyOf, kids, lines, openCard, openHeader, openSessions, openToolbar, textOf, toolbarLine, toolbarTitle, topLevel, walk } from './panetools'
import type { Node } from './panetools'
import { resetViewCache } from './view'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const HOUR = 3_600_000
const SID = (n: number) => `0000000${n}-2222-3333-4444-555555555555`
const line = (o: unknown) => JSON.stringify(o) + '\n'
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const REPLY = { kind: 'ado-pr-reply', params: { org: 'acme', project: 'Shop', repo: 'shop-api', pr: 4321, thread: 7, body: 'Fixed in the next commit.' }, why: 'close the thread' }

// the hook that feeds the desk a request with `n` tokens of context must be registered before the test first touches `$` (an engine rule): world() does it
function world(on: any, rows: any[] = []) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.clock.t = 1000 * HOUR
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  h.exec.handler = () => ({ exitCode: 127, stdout: '', stderr: 'unknown' })
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(rows) } : { exitCode: 0, stdout: '' })
  const kv = new Map<string, unknown>()
  let tokens = 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
  })
  const feed = async ($: any, n: number) => {
    tokens = n
    const st = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as any)
    for (;;) if ((await st.next()).done) break
  }
  const host = { ...h.host, store: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) }, clock: { now: async () => h.clock.t } } as any
  const thr = (id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `title ${id}`, project: 'p', state: 'open', sid: '', created: 1, lastWake: h.clock.t - HOUR, delivered: 0, ...o }))
  const report = (...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))
  return { h, kv, host, thr, report, feed, rows }
}
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const setUp = async (ui: any) => {
  if (await ui.find({ type: 'Button', key: 'setup' })) await ui.press({ key: 'setup' })
}
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
const buttons = async (ui: any): Promise<Array<{ key: string; text: string }>> => (await ui.findAll({ type: 'Button' })).map((b: any) => ({ key: String(b.key), text: String(b.text) }))
// a fixture of every state at once: needs you (t1: a question), working (t2, with something unread), done (t3), closed (t4), a pending approval (t5), and older ones for the cap
function everything(w: ReturnType<typeof world>) {
  w.thr('t1', { sid: SID(1) })
  w.thr('t2', { sid: SID(2), lastWake: w.h.clock.t - 5 * 60_000 })
  w.thr('t3', { sid: SID(3) })
  w.thr('t4', { state: 'closed', closedAt: w.h.clock.t - 3 * HOUR })
  w.thr('t5', { sid: SID(5) })
  for (let n = 6; n <= 9; n++) w.thr(`t${n}`, { lastWake: w.h.clock.t - (20 + n) * HOUR })
  w.rows.push({ sessionId: SID(2), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }, { sessionId: SID(3), name: 'y', cwd: '/y', status: 'idle', state: 'done', startedAt: 1 })
  w.report({ ts: w.h.clock.t - 60_000, from: 't2', kind: 'report', text: 'Halfway through the synthetic job', state: 'working' }, { ts: w.h.clock.t - 2 * HOUR, from: 't3', kind: 'report', text: 'Done and merged', state: 'done' })
  w.report({ ts: w.h.clock.t - 3 * HOUR, from: 't1', kind: 'ask', text: 'which cache?' })
  w.h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'active', maxSessions: 5 } }))
}

test('1.0.33 everything is folded on the first render (a needs-you thread and a thread with a pending approval too), and no element is outside a card', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  await addActionRequest(w.host, 't5', REPLY)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const top = await topLevel(ui)
  expect(top.loose).toEqual([]) // every top-level child of the pane body is a card
  // 1.0.35: exactly THREE cards, header, Health and Sessions, in this order, and nothing after Sessions (no More, no footer buttons, no "show more" card outside it)
  expect(top.cards.map(c => keyOf(c))).toEqual(['header', 'health', 'toolbar'])
  const body = await bodyOf(ui)
  expect(kids(body).map(c => keyOf(c))).toEqual(['header', 'health', 'toolbar']) // (nothing else is drawn: the notice card exists only while a press has an answer)
  for (const k of ['sec-more', 'new-thread', 'feedback', 'repair', 'sessions-cap', 'card-t1', 'card-t5', 'view-t1']) expect(await ui.find({ type: 'Button', key: k }), k).toBeFalsy()
  // nothing is unfolded: every foldable title starts with the closed arrow, and there is no open one anywhere
  const folded = await buttons(ui)
  expect(folded.filter(b => b.text.startsWith('▾'))).toEqual([])
  for (const k of ['sec-header', 'sec-health', 'sec-toolbar']) expect(folded.find(b => b.key === k)?.text.startsWith('▸'), k).toBe(true)
  // a thread that needs you is never invisible: the chip is on the Sessions line (text) and on the header (a button), the cards are not drawn
  expect(await toolbarLine(ui)).toMatch(/^▸ Sessions \(9\) · sorted by last active ↓ \d+ needs you/)
  expect(String((await ui.find({ type: 'Button', key: 'needs-chip' }))?.text)).toMatch(/^\d+ needs you$/)
  const needsSessions = Number(/(\d+) needs you/.exec(await toolbarLine(ui))?.[1])
  expect(needsSessions).toBeGreaterThan(0)
  expect(String((await ui.find({ type: 'Button', key: 'needs-chip' }))?.text)).toBe(`${needsSessions} needs you`) // the same count
  // the session cards are children of the Sessions card and exist only while it is unfolded
  await openSessions(ui)
  const sessions = (await cardByKey(ui, 'toolbar'))!
  expect(has(sessions, x => keyOf(x) === 'card-t1')).toBe(true)
  const top2 = await topLevel(ui)
  expect(top2.cards.map(c => keyOf(c))).toEqual(['header', 'health', 'toolbar']) // still three: the sessions are inside
  expect(has(top2.cards[0]!, x => /^card-t\d+$/.test(keyOf(x)))).toBe(false)
  expect(has(top2.cards[1]!, x => /^card-t\d+$/.test(keyOf(x)))).toBe(false)
  const all = await buttons(ui)
  for (const k of ['card-t1', 'card-t2', 'card-t3', 'card-t4', 'card-t5']) expect(all.find(b => b.key === k)?.text.startsWith('▸'), k).toBe(true) // every card inside starts folded too
  expect(all.filter(b => b.text.startsWith('▾')).map(b => b.key)).toEqual(['sec-toolbar']) // the only unfolded thing is the Sessions card the test opened
  // what matters is in the two lines: the state chip, "N new", "N to decide"; the decision itself is behind a tap
  const t = await texts(ui)
  for (const chip of ['[needs you]', '[working]', '[done]', '[closed]']) expect(t).toContain(chip)
  expect(t).toContain('1 to decide') // t5: the pending approval
  expect(all.find(b => b.key === 'new-t2')?.text).toBe('1 new')
  expect(all.some(b => /^action-(approve|deny)-/.test(b.key))).toBe(false)
  expect(t.some(x => /wants to reply to PR thread/.test(x))).toBe(false)
  expect(kids(await bodyOf(ui)).map(c => keyOf(c))).toEqual(['header', 'health', 'toolbar']) // and still nothing after the Sessions card, unfolded
  await ui.unmount()
})

test('1.0.35 the needs-you chip on the header: a tap unfolds the Sessions card (the unfold is kept); the folded Sessions line has the amber chip, "N unread" and "N hidden" only above 0', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await ui.find({ type: 'Button', key: 'card-t1' })).toBeFalsy()
  const chip = await ui.find({ type: 'Text', text: /^\d+ needs you$/ })
  expect(chip?.props?.color).toBe('warning') // amber
  expect(await ui.find({ type: 'Text', text: /^\d+ unread$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /hidden$/ })).toBeFalsy() // nothing hidden: no chip
  await ui.press({ key: 'needs-chip' }) // the header's chip
  expect(await toolbarTitle(ui)).toMatch(/^▾ Sessions/)
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toMatch(/^▸ t1/)
  await ui.press({ key: 'needs-chip' }) // a second tap does not fold it (it only unfolds)
  expect(await toolbarTitle(ui)).toMatch(/^▾ Sessions/)
  await ui.unmount()
  ui = await $.ui.mount(PANE as any) // unfolding persists across a refresh and a remount
  expect(await toolbarTitle(ui)).toMatch(/^▾ Sessions/)
  expect(await ui.find({ type: 'Button', key: 'card-t1' })).toBeTruthy()
  await ui.press({ key: 'sec-toolbar' }) // the title folds it again
  expect(await ui.find({ type: 'Button', key: 'card-t1' })).toBeFalsy()
  await ui.unmount()
  ui = await $.ui.mount(PANE as any)
  expect(await toolbarTitle(ui)).toMatch(/^▸ Sessions/)
  await ui.unmount()
})

test('1.0.35 a quiet pane: no chip for what is zero (no needs you, no unread), the Sessions line is the title only', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  w.thr('t1')
  w.report({ ts: w.h.clock.t - 60_000, from: 't1', kind: 'report', text: 'Done', state: 'done' })
  w.h.files.set(`${L}/desk/pane-ack.json`, JSON.stringify({ upTo: 1, ns: [] })) // the one row is read
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await toolbarLine(ui)).toBe('▸ Sessions (1) · sorted by thread ↓')
  expect(await ui.find({ type: 'Button', key: 'needs-chip' })).toBeFalsy()
  await ui.unmount()
})

test('1.0.35 New thread, Feedback export and Setup / repair are in the UNFOLDED header card (not after the sessions) and run the old handlers', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  w.thr('t1')
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  for (const k of ['new-thread', 'feedback', 'repair']) expect(await ui.find({ type: 'Button', key: k }), k).toBeFalsy() // folded header: none of them, anywhere
  await openHeader(ui)
  const header = (await cardWith(ui, 'sec-header'))!
  for (const k of ['new-thread', 'feedback', 'repair']) expect(has(header, x => x.type === 'Button' && keyOf(x) === k), k).toBe(true) // each a normal Button in the header card
  expect(String((await ui.find({ type: 'Button', key: 'feedback' }))?.text)).toMatch(/^Feedback export/)
  await ui.press({ key: 'new-thread' })
  expect(await ui.find({ type: 'Text', text: /new thread form opened/ })).toBeTruthy() // the same form as before (openNewThread)
  await ui.press({ key: 'feedback' })
  expect(await ui.find({ type: 'Text', text: /feedback|Feedback|exported|export/i })).toBeTruthy() // a notice card answers (the export function ran)
  await ui.press({ key: 'repair' })
  expect(w.h.files.get('/h/.lean-agent/bin/open-desk.sh')).toContain('echo open') // Setup / repair ran the setup
  expect(kids(await bodyOf(ui)).some(c => keyOf(c) === 'actions')).toBe(false) // no actions card after the sessions
  await ui.unmount()
})

test('1.0.33 a tap unfolds only that card and the fold is kept (a refresh, a remount); a second tap folds it; a decision is a nested card inside the unfolded card only', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  const req = (await addActionRequest(w.host, 't5', REPLY)).request!
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openSessions(ui)
  const arrows = async () => Object.fromEntries((await buttons(ui)).filter(b => /^card-t\d$/.test(b.key)).map(b => [b.key.slice(5), b.text[0]]))
  const folded = { t1: '▸', t2: '▸', t3: '▸', t4: '▸', t5: '▸' }
  expect(await arrows()).toMatchObject(folded)
  const foldedCard = (await cardWith(ui, 'card-t5'))!
  expect(has(foldedCard, x => x !== foldedCard && isCard(x))).toBe(false) // no nested card while folded
  await ui.press({ key: 'card-t5' })
  expect(await arrows()).toMatchObject({ ...folded, t5: '▾' }) // only that one
  const unfolded = (await cardWith(ui, 'card-t5'))!
  const nested = kids(unfolded).flatMap(k => (isCard(k) ? [k] : kids(k).filter(isCard)))
  expect(nested.length).toBe(1) // the decision card, inside the unfolded card
  expect(has(nested[0]!, x => keyOf(x) === `action-approve-${req.id}`)).toBe(true)
  await ui.unmount()
  ui = await $.ui.mount(PANE as any) // a refresh keeps it (the pane's store)
  expect(await arrows()).toMatchObject({ ...folded, t5: '▾' })
  await ui.press({ key: 'card-t5' })
  expect(await arrows()).toMatchObject(folded)
  await ui.press({ key: 'card-t1' })
  expect(await arrows()).toMatchObject({ ...folded, t1: '▾' })
  await ui.unmount()
})

test('1.0.33 pane.foldAll false brings the old auto-unfold of a card with a decision back; the default (true) never unfolds by itself', async () => {
  const h = fakeHost(null)
  expect((await paneConfig(h.host)).foldAll).toBe(true)
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { foldAll: false } }))
  expect((await paneConfig(h.host)).foldAll).toBe(false)
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { foldAll: true } }))
  expect((await paneConfig(h.host)).foldAll).toBe(true)
})

test('1.0.33 pane.foldAll false: the card with a pending approval is unfolded by itself, the others stay folded', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  w.h.files.set(`${L}/config.json`, JSON.stringify({ pane: { sort: 'active', maxSessions: 5, foldAll: false } }))
  await addActionRequest(w.host, 't5', REPLY)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await toolbarTitle(ui)).toMatch(/^▾ Sessions/) // the Sessions card is unfolded while something needs you (and ONLY there: nothing else is)
  expect((await ui.find({ type: 'Button', key: 'card-t5' }))?.text).toMatch(/^▾/)
  for (const id of ['t1', 't2', 't3', 't4']) expect((await ui.find({ type: 'Button', key: `card-${id}` }))?.text, id).toMatch(/^▸/)
  expect((await buttons(ui)).filter(b => b.text.startsWith('▾')).map(b => b.key).sort()).toEqual(['card-t5', 'sec-toolbar'])
  expect(kids(await bodyOf(ui)).map(c => keyOf(c))).toEqual(['header', 'health', 'toolbar'])
  await ui.unmount()
})

test('1.0.33 a folded session card is exactly two lines, the same for working / done / closed / needs-you: title and state chip, then "N new", cost, context bar, age and Open at the right end', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  w.h.files.set(`${L}/ledger.jsonl`, line({ ts: w.h.clock.t, role: 'thread', tN: 't2', model: 'x', in: 420, usd: 0 }) + line({ ts: w.h.clock.t, role: 'thread', tN: 't4', model: 'x', in: 1250, usd: 0 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openSessions(ui)
  const expectChip: Record<string, string> = { t1: '[needs you]', t2: '[working]', t3: '[done]', t4: '[closed]' }
  for (const [id, chip] of Object.entries(expectChip)) {
    const card = (await cardWith(ui, `card-${id}`))!
    const ls = lines(card)
    expect(ls, id).toHaveLength(2) // exactly two lines
    for (const l of ls) expect(l.props?.flexWrap, id).toBe('nowrap') // neither wraps
    const [l1, l2] = ls as [Node, Node]
    expect(keyOf(kids(l1)[0]!)).toBe(`card-${id}`) // line 1: the title button ...
    expect(textOf(l1)).toContain(chip) // ... and the state chip
    expect(has(l1, x => x.type === 'Button' && !String(x.props?.label).startsWith('▸'))).toBe(false) // nothing else clickable on line 1
    const last = kids(kids(l2).at(-1)!).at(-1)! // the right end of line 2: Hide (a completed one) and Open together
    expect(last.type, id).toBe('Button') // line 2 ends with Open
    expect(String(last.props?.label), id).toBe('Open')
    expect(textOf(l2), id).toMatch(/(just now|\d+ min ago|\d+ h ago|\d+ d ago)/) // the age ("closed 3 h ago" for a closed one)
    expect(textOf(l2), id).not.toMatch(/window|tokens|reviews|restarts|\(/) // 1.0.35: no breakdown text on line 2: the usage is one figure
  }
  const t4 = textOf((await cardWith(ui, 'card-t4'))!)
  expect(t4).toMatch(/closed \d+ h ago/)
  expect(t4).toContain('1.3k')
  expect(t4).not.toContain('window 1.3k tokens') // (that text is on the unfolded card)
  expect(textOf(lines((await cardWith(ui, 'card-t2'))!)[1]!)).toContain('1 new')
  // the unfolded card has more than the two lines, and still one Open
  await openCard(ui, 't2')
  expect(lines((await cardWith(ui, 'card-t2'))!).length).toBeGreaterThan(2)
  expect(await ui.findAll({ type: 'Button', key: 'view-t2' })).toHaveLength(1)
  await ui.unmount()
})

test('1.0.33 a long title is cut with an ellipsis on ONE line (the chips and Open keep line 2); the whole title is the first line of the unfolded card; a narrow body cuts it shorter', { timeoutMs: 20_000 }, async ($, on) => {
  const title = 'Rename the synthetic widget registry across all four example modules, then update every example that mentions the old name and the docs'
  const w = world(on, [])
  w.thr('t1', { title })
  w.report({ ts: w.h.clock.t - 60_000, from: 't1', kind: 'report', text: 'Done', state: 'done' })
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openSessions(ui)
  const label = async () => String((await ui.find({ type: 'Button', key: 'card-t1' }))?.text)
  expect((await label()).endsWith('…')).toBe(true)
  expect((await label()).length).toBeLessThanOrEqual(80 - 8 - '[done]'.length - 1) // (inside the Sessions card: 4 more cells of border and padding)
  const card = (await cardWith(ui, 'card-t1'))!
  expect(lines(card)).toHaveLength(2)
  expect(has(lines(card)[0]!, x => x.props?.flexWrap === 'wrap')).toBe(false) // line 1 never wraps
  expect(await texts(ui)).not.toContain(title)
  await openCard(ui, 't1')
  expect(await texts(ui)).toContain(title) // the whole title, once
  await ui.unmount()
  await $.ui.mount(PANE as any).then((u: any) => u.unmount())
  ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } } as any)
  expect((await label()).endsWith('…')).toBe(true)
  expect((await label()).length).toBeLessThanOrEqual(40 - 8 - '[done]'.length - 1)
  await ui.unmount()
})

test('1.0.33 the header card: ONE line folded ("lean-agent · 1.6k tokens · 5h 1% · desk 37k/60k") with the fix chip and Restart desk at its right end; unfolded it has the reset time, 7d, the snapshot age and the version line', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  w.thr('t1')
  w.h.files.set(`${L}/config.json`, JSON.stringify({ desk: { contextLimit: 60_000 } }))
  w.h.files.set(`${L}/ledger.jsonl`, line({ ts: w.h.clock.t, role: 'desk', model: 'x', in: 1500, out: 0, cache_read: 0, cache_write: 0, usd: 0 }))
  w.h.files.set(`${L}/desk/windows.json`, JSON.stringify({ at: w.h.clock.t - 60_000, windows: [{ kind: 'five_hour', percentUsed: 1, resetsAt: w.h.clock.t + 288 * 60_000 }, { kind: 'seven_day', percentUsed: 65, resetsAt: 0 }] }))
  await inDesk($)
  w.h.files.set(`${L}/notices/rules-cap.txt`, 'rules synthetic: 1 over the size cap, still loaded\n') // (after the session start, which clears one it finds nothing behind) one fix: the chip
  await w.feed($, 37_000)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const header = (await cardWith(ui, 'sec-header'))!
  expect(lines(header)).toHaveLength(1) // ONE line
  expect(lines(header)[0]!.props?.flexWrap).toBe('nowrap')
  expect((await ui.find({ type: 'Button', key: 'sec-header' }))?.text).toMatch(/^▸ lean-agent · [\d.]+[kM]? tokens · 5h 1% · desk 37k\/60k$/) // (the window's usage tokens, no dollars; the desk's own request counts too: not exactly 1.5k)
  expect(has(lines(header)[0]!, x => keyOf(x) === 'health-chip')).toBe(true) // the fix chip on the same line
  expect((await ui.find({ type: 'Button', key: 'health-chip' }))?.text).toMatch(/^\d+ fix(es)?$/)
  expect(has(lines(header)[0]!, x => keyOf(x) === 'restart-desk')).toBe(true) // and the Restart desk chip-button
  const folded = await texts(ui)
  expect(folded.some(x => /resets|7d|snapshot|refreshed/.test(x))).toBe(false) // the rest is unfolded only
  await openHeader(ui)
  const open = (await cardWith(ui, 'sec-header'))!
  expect(lines(open).length).toBeGreaterThan(1)
  const t = await texts(ui)
  expect(t.some(x => /resets .* \| 7d: 65% \(snapshot 1 min old\)/.test(x))).toBe(true) // the reset time, 7d and the snapshot age
  expect(t.some(x => /^window [\d.]+[kM]? tokens \(1%\) · 7d 65%$/.test(x))).toBe(true) // the unfolded header: the window's usage tokens with the engine's percentages
  expect(t.some(x => x.includes('$'))).toBe(false)
  expect(t.some(x => /^lean-agent 1\.0\.\d+ · refreshed \d\d:\d\d:\d\d/.test(x))).toBe(true) // the version line
  expect(t.some(x => /37k of 60k/.test(x))).toBe(true) // the desk context bar
  expect((await ui.find({ type: 'Button', key: 'restart-desk' }))?.text).toBe('Restart desk') // unfolded: a normal button
  await ui.unmount()
})

test('1.0.35 the Sessions card: folded it is ONE line, its title (the sort is named) with the chips "N needs you", "N unread"; the sort chips, ack all and Close all done are inside the unfolded card, with the session cards after them', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  everything(w)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const card = (await cardWith(ui, 'sec-toolbar'))!
  expect(lines(card)).toHaveLength(1)
  expect(await toolbarTitle(ui)).toMatch(/^▸ Sessions \(9\) · sorted by last active ↓$/)
  expect(await toolbarLine(ui)).toMatch(/^▸ Sessions \(9\) · sorted by last active ↓ \d+ needs you \d+ unread$/)
  expect(await ui.find({ type: 'Button', key: 'ack-all' })).toBeFalsy() // ack all is inside the unfolded card
  for (const k of ['sort-active', 'sort-needs', 'sort-usage', 'sort-name']) expect(await ui.find({ type: 'Button', key: k }), k).toBeFalsy()
  await openToolbar(ui)
  expect((await toolbarTitle(ui)).startsWith('▾')).toBe(true)
  for (const k of ['sort-active', 'sort-needs', 'sort-usage', 'sort-name', 'ack-all']) expect(await ui.find({ type: 'Button', key: k }), k).toBeTruthy()
  // in this order inside the card: the sort chips, the tools (Hide all completed, hidden chip, ack all), then the session cards, then "show more"
  const inside = kids((await cardByKey(ui, 'toolbar'))!).find(k => keyOf(k) === 'tb-more')!
  const order = kids(inside).map(k => (keyOf(k) === 'tb-tools' ? 'tools' : isCard(k) ? keyOf(k) : k.type))
  expect(order.indexOf('tools')).toBeGreaterThan(0)
  expect(order.findIndex(k => /^t-t\d$/.test(k))).toBeGreaterThan(order.indexOf('tools'))
  expect(order.at(-1)).toBe('sessions-cap')
  expect((await ui.find({ type: 'Button', key: 'sort-active' }))?.text).toBe('● last active ↓')
  await ui.press({ key: 'sort-usage' })
  expect(await toolbarTitle(ui)).toContain('sorted by usage') // the title names the current sort
  await ui.unmount()
})

test('1.0.33 an unfolded session card says one fact once: the waiting-for-you line is not repeated next to the decision that says it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1, waitingFor: 'permission prompt' }])
  w.thr('t1', { sid: SID(1) })
  w.report({ ts: w.h.clock.t - 60_000, from: 't1', kind: 'report', text: 'Halfway', state: 'working' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openCard(ui, 't1')
  const same = (await texts(ui)).filter(x => /waiting for you: open it in the app|report is stale|waits on a prompt in its own session/.test(x))
  expect(same).toHaveLength(1) // one line, not two that say nearly the same
  await ui.unmount()
})

test('1.0.33 a pane that is not the desk is cards too (setup, "not the desk", notice, footer); a restart\'s answer is a notice card with its Dismiss', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  w.thr('t1')
  await $.session.start({ cwd: '/h/elsewhere', surface: 'desktop', isInteractive: true } as any)
  let ui = await $.ui.mount(PANE as any)
  const top = await topLevel(ui)
  expect(top.loose).toEqual([])
  expect(top.cards.length).toBeGreaterThanOrEqual(2)
  await ui.unmount()
  await inDesk($)
  ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await ui.press({ key: 'restart-desk' })
  expect(await ui.find({ type: 'Button', key: 'notice-dismiss' })).toBeTruthy()
  const t2 = await topLevel(ui)
  expect(t2.loose).toEqual([]) // the answer is a card
  expect(t2.cards.some(c => has(c, x => keyOf(x) === 'notice-dismiss'))).toBe(true)
  await ui.press({ key: 'notice-dismiss' })
  expect(await ui.find({ type: 'Button', key: 'notice-dismiss' })).toBeFalsy()
  expect((await topLevel(ui)).loose).toEqual([])
  void walk
  await ui.unmount()
})

test('1.0.35 line 2 of a folded session card starts with the model chip (sonnet/high, haiku/low, effort abbreviated: medium is med); a thread with no model or effort has no chip; a closed card has one too; the unfolded card says both in full', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  w.thr('t1', { model: 'sonnet', effort: 'high' })
  w.thr('t2', { model: 'haiku', effort: 'low' })
  w.thr('t3', { model: 'opus', effort: 'medium' })
  w.thr('t4') // nothing recorded
  w.thr('t5', { state: 'closed', closedAt: w.h.clock.t - 3 * HOUR, model: 'sonnet', effort: 'xhigh' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openSessions(ui)
  const line2 = async (id: string) => lines((await cardWith(ui, `card-${id}`))!)[1]!
  const first = async (id: string) => {
    const left = kids(await line2(id))[0]! // the left box of line 2: the model chip is its first piece
    return textOf(kids(left)[0] ?? left)
  }
  expect(await first('t1')).toBe('sonnet/high')
  expect(await first('t2')).toBe('haiku/low')
  expect(await first('t3')).toBe('opus/med') // abbreviated
  expect(await first('t5')).toBe('sonnet/xhigh') // a closed card too
  expect(textOf(await line2('t4'))).not.toMatch(/sonnet|haiku|opus|unknown|not recorded|\//) // no chip, no "unknown"
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    const l2 = await line2(id)
    expect(kids(l2), id).toHaveLength(2) // line 2 is the left box and the right box (Hide, Open): no extra wrap element
    expect(l2.props?.flexWrap, id).toBe('nowrap')
    expect(has(l2, x => x.props?.flexWrap === 'wrap'), id).toBe(false)
  }
  expect((await texts(ui)).filter(x => x === 'opus/med')).toHaveLength(1)
  await openCard(ui, 't3')
  expect((await texts(ui)).filter(x => x === 'opus/medium')).toHaveLength(1) // in full in the unfolded card (the effort is not abbreviated there)
  await ui.unmount()
})

test('1.0.35 a narrow pane keeps line 2 on ONE line: the age moves to the unfolded card when it does not fit, the model chip, usage, Hide and Open stay', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  w.thr('t1', { sid: SID(1), model: 'sonnet', effort: 'high', lastWake: w.h.clock.t - 4 * HOUR }) // (woken before it reported, so it is done)
  w.report({ ts: w.h.clock.t - 2 * HOUR, from: 't1', kind: 'report', text: 'Done', state: 'done' })
  w.h.files.set(`${L}/desk/pane-ack.json`, JSON.stringify({ upTo: 1, ns: [] })) // read: the card can be hidden
  w.h.files.set(`${L}/ledger.jsonl`, line({ ts: w.h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 7_700_000, usd: 0 }))
  await inDesk($)
  const AGE = /\d+ h ago/
  let ui = await $.ui.mount(PANE as any) // 80 columns: everything fits
  await setUp(ui)
  await openSessions(ui)
  expect(textOf(lines((await cardWith(ui, 'card-t1'))!)[1]!)).toMatch(AGE)
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 36 } } as any)
  const l2 = lines((await cardWith(ui, 'card-t1'))!)[1]!
  const t2 = textOf(l2)
  expect(t2).toContain('sonnet/high')
  expect(t2).toMatch(/7\.7M/) // the usage as one figure
  expect(t2).not.toMatch(AGE) // the age is not on the line ...
  expect(kids(l2)).toHaveLength(2)
  expect(has(l2, x => x.props?.flexWrap === 'wrap')).toBe(false) // ... and nothing can wrap onto a third line
  expect(lines((await cardWith(ui, 'card-t1'))!)).toHaveLength(2)
  expect(has(l2, x => keyOf(x) === 'hide-t1')).toBe(true)
  expect(has(l2, x => keyOf(x) === 'view-t1')).toBe(true) // Hide and Open stay at the end
  await openCard(ui, 't1')
  expect((await texts(ui)).some(x => AGE.test(x))).toBe(true) // the age is in the unfolded card
  await ui.unmount()
})
