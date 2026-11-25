// The desk pane's sections: Needs you, thread cards (state, branch, review verdict, cost), the widget glance, a narrow body, and every
// section empty. Everything is synthetic: thread titles, branches, shas and numbers are made up.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { cardWith, lines, openHeader, openToolbar, toolbarTitle, topLevel } from './panetools'
import { branchIn, claimsPushed, loadView, resetViewCache, shasIn, stateOf } from './view'
import type { ThreadRow } from './view'
import { writeReview } from './reviews'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const SHA = 'abcdef1' + '0'.repeat(33)
const SID = (n: number) => `0000000${n}-2222-3333-4444-555555555555`
const line = (o: unknown) => JSON.stringify(o) + '\n'
const thr = (h: any, id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `synthetic ${id}`, project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
const inbox = (h: any, ...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const withProps = (props: Record<string, unknown>, surface = 'desktop') => ({ ...PANE, surface, props: { ...PANE.props, ...props } }) as any

function world(on: any = null, agents: any[] = []) {
  opened.length = 0
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  // what the setup copies from the plugin: with these a press of "Set up lean-agent" finishes the setup (see setUp)
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(agents) } : { exitCode: 0, stdout: '' })
  if (on) {
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    // the mod's own store beneath the pane: the review key is the one the spec signs with (see `review`), nothing else is kept
    on('store.get', (_: any, e: any) => ({ value: e.key === 'review.key' ? KEY : undefined }))
    on('store.set', () => ({ value: undefined }))
    // the engine's answer to $.ui.open: placed; what a button opened is kept for the specs
    on('ui.open', (_: any, e: any) => {
      opened.push({ id: e.id, title: e.title })
      return { value: { isPlaced: true } }
    })
  }
  return h
}
const opened: { id: string; title?: string }[] = []
// the panes a button opened (the desk's own pane, opened at the session start, is not one of them)
const byButton = () => opened.filter(o => o.id !== 'lean-agent')
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
// 1.0.32: a tap on a card's title unfolds it; the fake home is not set up (a finding: Health is unfolded and counts it), one press makes Health quiet; Health is folded on startup
const openCard = async (ui: any, id: string) => {
  const b = await ui.find({ type: 'Button', key: `card-${id}` })
  if (b && String(b.text).startsWith('▸')) await ui.press({ key: `card-${id}` })
}
const setUp = async (ui: any) => {
  if (await ui.find({ type: 'Button', key: 'setup' })) await ui.press({ key: 'setup' })
}
const openHealth = async (ui: any) => {
  const b = await ui.find({ type: 'Button', key: 'sec-health' })
  if (b && String(b.text).startsWith('▸')) await ui.press({ key: 'sec-health' })
}
// A review record is signed with a key in the mod's own store. The pane runs in the engine's instance of the plugin (its own store, which
// `world` answers with KEY), the spec's host has another: the same key in both lets the spec write a record the pane verifies.
const KEY = 'k'.repeat(64)
async function review(h: any, r: { green: boolean; sha: string; project: string; branch?: string }) {
  await h.host.store.set('review.key', KEY)
  await writeReview(h.host, r)
}

// ---- what the pane reads out of the reports ----------------------------------------------------------------------------
test('branchIn and shasIn read what a report says; claimsPushed knows "not pushed"', () => {
  expect(branchIn('Done. Branch: feat/synthetic-x, worktree /w')).toBe('feat/synthetic-x')
  expect(branchIn('on branch `fix/thing.` and more')).toBe('fix/thing')
  expect(branchIn('the branch name is feat/y-2')).toBeUndefined()
  expect(branchIn('branch feat/a-b merged later')).toBe('feat/a-b')
  expect(branchIn('branch is ready, nothing else')).toBeUndefined()
  expect(shasIn('commit abcdef1 and 1234567890abcdef1234567890abcdef12345678')).toEqual(['abcdef1', '1234567890abcdef1234567890abcdef12345678'])
  expect(shasIn('deadbeef is a word of hex letters only')).toEqual([])
  expect(claimsPushed('pushed to origin')).toBe(true)
  expect(claimsPushed('not pushed yet')).toBe(false)
  expect(claimsPushed('unpushed commit')).toBe(false)
  expect(claimsPushed('pushed: no')).toBe(false)
  expect(claimsPushed('commit is local only')).toBe(false)
})

test('stateOf: one word per thread, the colour a theme key', () => {
  const t = (o: Partial<ThreadRow>): ThreadRow => ({ id: 't1', title: 'x', state: 'open', run: 'idle', last: '', resumable: false, working: false, done: false, asking: false, blocked: false, needsYou: false, lastReport: '', review: 'none', cost: 0, ready: false, recTs: 0, ...o })
  expect([t({ working: true, run: 'running' }), t({ done: true }), t({ blocked: true }), t({ asking: true }), t({ approval: 'x', blocked: true }), t({ needsYou: true, working: true }), t({ run: 'parked' }), t({ pausedUntil: 5 }), t({})].map(x => stateOf(x))).toEqual([
    { word: 'working', color: 'success' },
    { word: 'done', color: 'inactive' },
    { word: 'blocked', color: 'error' },
    { word: 'asking', color: 'warning' },
    { word: 'approval', color: 'warning' },
    { word: 'waiting', color: 'warning' },
    { word: 'parked', color: 'inactive' },
    { word: 'paused', color: 'warning' },
    { word: 'idle', color: 'inactive' },
  ])
})

test('view: a thread\'s branch, commit, review verdict, cost today and "ready to push" come from its reports, the review record and the ledger', async () => {
  const h = world()
  thr(h, 't1')
  thr(h, 't2')
  thr(h, 't3')
  inbox(
    h,
    { ts: 100, from: 't1', kind: 'report', text: `Done. Branch: feat/synthetic-x, commit ${SHA.slice(0, 7)}, not pushed.`, state: 'done' },
    { ts: 110, from: 't2', kind: 'report', text: `Done. branch feat/other-y commit ${'1234567'}, pushed to origin.`, state: 'done' },
    { ts: 120, from: 't3', kind: 'report', text: 'Working on it, no commit yet', state: 'working' },
  )
  await writeReview(h.host, { green: true, sha: SHA, project: 'proj', branch: 'feat/synthetic-x' })
  await writeReview(h.host, { green: false, sha: '1234567' + 'f'.repeat(33), project: 'proj', branch: 'feat/other-y' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 0.42 }) + line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 0.1 }))
  const v = await loadView(h.host)
  expect(v.errors).toEqual([])
  const row = (id: string) => v.threads.find(t => t.id === id)!
  expect([row('t1').branch, row('t1').sha, row('t1').review, row('t1').ready]).toEqual(['feat/synthetic-x', 'abcdef1', 'green', true])
  expect(Math.round(row('t1').cost * 100)).toBe(52)
  expect([row('t2').branch, row('t2').review, row('t2').ready]).toEqual(['feat/other-y', 'red', false]) // a record that is not green, and it says pushed
  expect([row('t3').branch, row('t3').sha, row('t3').review, row('t3').ready, row('t3').cost]).toEqual([undefined, undefined, 'none', false, 0])
  expect(v.needs.map(n => [n.kind, n.thread])).toEqual([['push', 't1']])
  expect(v.needs[0]!.text).toBe('t1 synthetic t1 is ready to push (abcdef1 on feat/synthetic-x, review green): ask the desk to push')
  expect(v.needs[0]!.notify).toBe(true)
})

test('view: the newest report that names a commit decides; an older commit\'s green verdict is never shown for a newer one', async () => {
  const h = world()
  thr(h, 't1')
  await writeReview(h.host, { green: true, sha: SHA, project: 'proj', branch: 'feat/old-line' })
  inbox(
    h,
    { ts: 100, from: 't1', kind: 'report', text: `Checked, commit ${SHA.slice(0, 7)}, not pushed.`, state: 'working' },
    { ts: 200, from: 't1', kind: 'report', text: 'Done. Branch: feat/new-line, commit 7654321, not pushed.', state: 'done' },
  )
  const row = (await loadView(h.host)).threads[0]!
  expect([row.review, row.sha, row.ready, row.branch]).toEqual(['none', undefined, false, 'feat/new-line']) // 7654321 has no record
})

test('view: a push the desk recorded in the thread\'s history ends "ready to push" (the desk inbox never hears of it)', async () => {
  const h = world()
  thr(h, 't1')
  await writeReview(h.host, { green: true, sha: SHA, project: 'proj', branch: 'feat/synthetic-x' })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Done. Branch: feat/synthetic-x, commit ${SHA.slice(0, 7)}, not pushed.`, state: 'done' })
  expect((await loadView(h.host)).needs.map(n => n.kind)).toEqual(['push'])
  h.files.set(`${L}/threads/t1/history.jsonl`, line({ ts: 5, kind: 'push', sha: SHA, ok: false }) + line({ ts: 6, kind: 'push', sha: SHA, ok: true }))
  const v = await loadView(h.host)
  expect(v.threads[0]!.ready).toBe(false)
  expect(v.needs).toEqual([])
  expect(v.threads[0]!.review).toBe('green') // the card still says what the review was
})

test('view: a failed push is still ready, a push of another commit changes nothing', async () => {
  const h = world()
  thr(h, 't1')
  await writeReview(h.host, { green: true, sha: SHA, project: 'proj' })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Done, commit ${SHA.slice(0, 7)}, not pushed.`, state: 'done' })
  h.files.set(`${L}/threads/t1/history.jsonl`, line({ ts: 5, kind: 'push', sha: SHA, ok: false }) + line({ ts: 6, kind: 'push', sha: '1234567' + '9'.repeat(33), ok: true }))
  expect((await loadView(h.host)).threads[0]!.ready).toBe(true)
})

test('view: a record whose signature does not verify is "not green", whatever it says', async () => {
  const h = world()
  thr(h, 't1')
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Done, commit ${SHA.slice(0, 7)}`, state: 'done' })
  await writeReview(h.host, { green: true, sha: SHA, project: 'proj' })
  const f = `${L}/proj/reviews/${SHA}.json`
  const forged = h.files.get(f)!.replace(/"sig":\s*"[0-9a-f]+"/, `"sig":"${'0'.repeat(64)}"`) // a copied or forged record
  expect(forged).not.toBe(h.files.get(f))
  h.files.set(f, forged)
  const v = await loadView(h.host)
  expect(v.threads[0]!.review).toBe('red')
  expect(v.threads[0]!.ready).toBe(false)
})

// ---- Needs you ---------------------------------------------------------------------------------------------------------
test('1.0.32 what waits for the user: nothing when nothing waits; otherwise approvals, questions, ready reports and blocked threads, each on its own thread card (one primary button collapsed, the details on a tap)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(4), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeFalsy()
  await ui.unmount()
  thr(h, 't1', { sid: SID(1) })
  thr(h, 't2')
  thr(h, 't3')
  thr(h, 't4', { sid: SID(4) })
  inbox(
    h,
    { ts: 100, from: 't1', kind: 'report', text: 'cannot run it', state: 'blocked', approval: 'git push origin synthetic-branch' },
    { ts: 110, from: 't3', kind: 'report', text: 'waiting for a credential', state: 'blocked' },
    { ts: 120, from: 't4', kind: 'report', text: `Done. Branch: feat/synthetic-x, commit ${SHA.slice(0, 7)}, not pushed.`, state: 'done' },
  )
  await review(h, { green: true, sha: SHA, project: 'proj', branch: 'feat/synthetic-x' })
  h.files.set(`${L}/questions.jsonl`, line({ ts: 130, from: 't2', question: 'which cache?' }))
  resetViewCache()
  ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect((await texts(ui)).some(t => /needs your yes|asks:|ready to push|is blocked/.test(t))).toBe(false) // folded: the cards say it with a chip and ONE button
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'open-t1' }))?.text).toBe('Open t1') // approval: Open (the session) is the primary button
  expect(await ui.find({ type: 'Button', key: 'view-t2' })).toBeTruthy() // question (needs you): Open
  expect(await ui.find({ type: 'Button', key: 'view-t3' })).toBeTruthy() // blocked: Open too (1.0.33: Open is at the right end of line 2 of every card; Restart is on the unfolded card)
  expect(await ui.find({ type: 'Button', key: 'restart-t3' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'view-t4' })).toBeTruthy() // a done row: Open
  for (const id of ['t1', 't2', 't3', 't4']) await openCard(ui, id)
  const all = await texts(ui)
  const at = (re: RegExp) => all.findIndex(t => re.test(t))
  expect([at(/t1 needs your yes in its own session: git push origin synthetic-branch/), at(/t2 asks: which cache\?/), at(/t4 synthetic t4 is ready to push \(abcdef1 on feat\/synthetic-x, review green\): ask the desk to push/), at(/t3 is blocked: waiting for a credential/)].every(i => i >= 0)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Open t1' })).toBeTruthy() // the approval's own button (the session, not the pane)
  for (const id of ['t2', 't3', 't4']) expect(await ui.find({ type: 'Button', key: `pane-${id}` })).toBeTruthy() // question, blocked, ready: the thread's pane
  expect((await ui.findAll({ type: 'Button', text: /^(confirm )?push/i })).length).toBe(0) // a ready report has no push button: the desk pushes
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /push/i.test(String(b.key))).length).toBe(0)
  await ui.press({ key: 'pane-t2' })
  expect(byButton()).toEqual([{ id: 'lean-agent-thread-t2', title: 't2 · synthetic t2' }]) // the question's Open button opens that thread's own pane
  expect(await ui.find({ type: 'Text', text: /t2 opened in its own pane/ })).toBeTruthy()
  await ui.unmount()
})

// ---- thread cards ------------------------------------------------------------------------------------------------------
test('1.0.32 an idle thread with no report: the chip "idle, no report N min" on its card, and a synthesised last line marked as such (display only)', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'idle', startedAt: 1, pid: 42 }])
  h.clock.t = 10_000_000
  const now = h.clock.t
  thr(h, 't1', { sid: SID(1), lastWake: now - 15 * 60_000 })
  h.files.set(`${L}/threads/t1/activity.json`, JSON.stringify({ at: now - 12 * 60_000, kind: 'tool' }))
  h.files.set(`${L}/threads/t1/synth-line.json`, JSON.stringify({ at: now - 11 * 60_000, text: 'lean_run: mv exited 0' }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  let all = await texts(ui)
  expect(all).toContain('[idle]')
  expect(all).toContain('[idle, no report 12 min]')
  await openCard(ui, 't1')
  all = await texts(ui)
  expect(all).toContain('lean_run: mv exited 0 (synthesised)')
  expect(all).not.toContain('no report yet')
  await ui.unmount()
})

test('1.0.32 a thread card: two lines collapsed (id and the whole title, state chip, cost, context bar, age); model, branch, verdict, the last report on one line and the buttons on a tap', { timeoutMs: 20_000 }, async ($, on) => {
  const title = 'Rename the synthetic widget registry across all four example modules, then update every example that mentions the old name'
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1), title, model: 'sonnet', effort: 'high' })
  thr(h, 't2', { state: 'open' })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Halfway. Branch: feat/synthetic-x, commit ${SHA.slice(0, 7)}.\nSecond line.`, state: 'working' })
  await review(h, { green: true, sha: SHA, project: 'proj', branch: 'feat/synthetic-x' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 0.42 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  let all = await texts(ui)
  const cut = String((await ui.find({ type: 'Button', key: 'card-t1' }))?.text)
  expect(cut.endsWith('…')).toBe(true) // 1.0.33: a long title is cut with an ellipsis on ONE line (the chips and Open keep line 2) ...
  expect(cut.length).toBeLessThanOrEqual(80 - 4 - '[working]'.length - 1)
  expect(all).not.toContain(title)
  // the two lines: a status chip, the cost, the context bar (none recorded here), the age
  for (const piece of ['[working]', 'today $0.42']) expect(all).toContain(piece)
  expect(all.some(t => /^(just now|\d+ min ago|\d+ h ago|\d+ d ago)$/.test(t))).toBe(true)
  expect(all.some(t => /^busy$|\[running\]/.test(t))).toBe(false)
  for (const piece of ['sonnet/high', 'feat/synthetic-x', 'review green', 'Halfway. Branch: feat/synthetic-x, commit abcdef1. Second line.']) expect(all).not.toContain(piece) // folded
  expect(all).toContain('[idle]') // t2: no report, no model recorded
  // collapsed: no button but the title; a quiet row (idle) has Open; "working" has none
  for (const k of ['resume-t1', 'restart-t1', 'close-t1', 'resume-t2', 'restart-t2', 'close-t2', 'start-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy()
  for (const k of ['card-t1', 'card-t2', 'view-t1', 'view-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy() // the title and Open on every card
  for (const id of ['t1', 't2']) expect(lines((await cardWith(ui, `card-${id}`))!)).toHaveLength(2) // exactly two lines, whatever the state
  await openCard(ui, 't1')
  await openCard(ui, 't2')
  all = await texts(ui)
  expect(all).toContain(title) // ... and the whole title is the first line of the unfolded card
  for (const piece of ['sonnet/high', 'feat/synthetic-x', 'review green', 'no review', 'Halfway. Branch: feat/synthetic-x, commit abcdef1. Second line.']) expect(all).toContain(piece) // the last report, one line
  for (const k of ['view-t1', 'view-t2', 'resume-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  for (const k of ['restart-t1', 'restart-t2', 'close-t2', 'start-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'close-t1' })).toBeFalsy() // working: no Close
  expect(await ui.find({ type: 'Button', key: 'resume-t1' })).toBeFalsy() // a running session is not resumed
  await ui.press({ key: 'view-t1' })
  expect(byButton().map(o => o.id)).toEqual(['lean-agent-thread-t1']) // Open on a card opens that thread's pane, not another
  expect(byButton()[0]!.title).toContain('t1 · ')
  expect(await ui.find({ type: 'Text', text: /t1 opened in its own pane/ })).toBeTruthy()
  await ui.unmount()
})

test('1.0.30: a thread that checkpointed itself is a quiet [restarting] chip, not a blocked card; a blocked thread has Restart as its one button', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [
    { sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 },
    { sessionId: SID(2), name: 'y', cwd: '/y', status: 'idle', state: 'done', startedAt: 1 },
  ])
  thr(h, 't1', { sid: SID(1) })
  thr(h, 't2', { sid: SID(2) })
  inbox(
    h,
    { ts: 100, from: 't1', kind: 'report', text: 'Context near the cap, asking the desk for a restart. Please restart t1', state: 'blocked' },
    { ts: 110, from: 't2', kind: 'report', text: 'cannot go on: the credential is missing', state: 'blocked' },
  )
  h.files.set(`${L}/threads/t1/checkpoint.json`, JSON.stringify({ reason: 'checkpoint', ts: 90, sid: SID(1), tokens: 100_000, next: 'carry on', source: 'report', notes: false }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  await openCard(ui, 't1')
  await openCard(ui, 't2')
  const all = await texts(ui)
  expect(all).toContain('[restarting]')
  expect(all).toContain('[blocked]')
  expect(all.filter(t => /^t1 is blocked/.test(t))).toHaveLength(0) // no need card for t1
  expect(all.filter(t => /^t2 is blocked/.test(t))).toHaveLength(1)
  await ui.press({ key: 'card-t1' }) // fold both again: the collapsed buttons
  await ui.press({ key: 'card-t2' })
  expect(await ui.find({ type: 'Button', key: 'view-t2' })).toBeTruthy() // blocked: Open on line 2 (Restart is on the unfolded card, first in its buttons)
  expect(await ui.find({ type: 'Button', key: 'restart-t2' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-t1' })).toBeFalsy() // restarting: nothing to press, the mod restarts it
  await ui.unmount()
})

test('1.0.32: a done thread is ONE row (title, chip, cost, age, Open); Resume, Restart, Close and Start are on its unfolded part', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1) })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Done. Branch: feat/synthetic-y, commit ${SHA.slice(0, 7)}.`, state: 'done' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 2.5 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  const all = await texts(ui)
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toBe('▸ t1 synthetic t1')
  expect(all).toContain('[done]')
  expect(all.some(t => /today \$2\.50/.test(t))).toBe(true)
  expect(all.some(t => /^(just now|\d+ min ago|\d+ h ago|\d+ d ago)$/.test(t))).toBe(true) // the age of its last activity
  expect(all.some(t => /^Done\. Branch/.test(t))).toBe(false) // the report line is not on the one-row form
  expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy()
  for (const k of ['resume-t1', 'restart-t1', 'close-t1', 'start-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy()
  await openCard(ui, 't1')
  for (const k of ['resume-t1', 'restart-t1', 'close-t1', 'start-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-t1', text: 'Restart from handover' })).toBeTruthy() // named by its effect
  await ui.unmount()
})

// ---- the widget --------------------------------------------------------------------------------------------------------
test('widget placement: a glance (running, blocked, needs you, desk context, budget today) and no button at all', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1) })
  thr(h, 't2')
  inbox(h, { ts: 100, from: 't2', kind: 'report', text: 'stuck', state: 'blocked' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'desk', model: 'x', in: 1, out: 1, usd: 1.5 }))
  await inDesk($)
  const ui = await $.ui.mount(withProps({ placement: 'widget', bodyColumns: 24 }))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0) // clicks may not reach a widget
  const all = await texts(ui)
  expect(all).toContain('1 running · 1 blocked')
  expect(all).toContain('1 needs you')
  expect(all).toContain('desk context n/a · today $1.50')
  expect(all.some(t => /Threads|Inbox|Goals/.test(t))).toBe(false) // a glance, not the pane
  await ui.unmount()
})

test('widget placement outside the desk says so and has no button', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount(withProps({ placement: 'widget' }))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /not the desk/ })).toBeTruthy()
  await ui.unmount()
})

// ---- narrow body, every section empty ------------------------------------------------------------------------------------
test('a narrow body (24 columns) draws the same tree with the short forms: buttons still there, the title whole', { timeoutMs: 20_000 }, async ($, on) => {
  const title = 'A long synthetic title that has to wrap on a narrow pane and never be cut'
  const h = world(on)
  thr(h, 't1', { title })
  inbox(h, { ts: h.clock.t - 1000, from: 't1', kind: 'report', text: 'x'.repeat(100) + ' TAIL', state: 'working' })
  await inDesk($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile']) {
    const ui = await $.ui.mount(withProps({ bodyColumns: 24, placement: 'inline' }, surface))
    const label = String((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).slice(2) // (the unfolded state is kept from the previous surface)
    expect(label.startsWith('t1 A long')).toBe(true) // 1.0.33: the title is cut with an ellipsis on ONE line, so the chips and Open keep line 2
    expect(label.endsWith('…')).toBe(true)
    expect(label.length + 2).toBeLessThanOrEqual(14)
    expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'repair' })).toBeTruthy()
    await ui.press({ key: 'new-t1' }) // the chip unfolds the card and its messages
    const row = await ui.find({ type: 'Button', key: 'row-0' })
    expect(String(row?.text).length).toBeLessThan(40) // an inbox row is cut shorter
    expect(await ui.find({ type: 'Button', text: /TAIL/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('1.0.32 every section empty: an empty-state line for the list, Health quiet and folded, More folded, the header, the sort chips and the footer actions', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  void h
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  const all = await texts(ui)
  expect(all.some(t => /Needs you|Inbox|Nothing from the threads/.test(t))).toBe(false)
  expect((await topLevel(ui)).loose).toEqual([]) // every block is a card
  expect(await ui.find({ type: 'Button', text: /Goals|Threads|Closed/ })).toBeFalsy()
  expect(all).toContain('No threads yet.')
  expect(await toolbarTitle(ui)).toContain('Sessions (0)')
  expect(await ui.find({ type: 'Button', key: 'sec-health', text: '▸ Health: all good' })).toBeTruthy() // folded, quiet
  expect(await ui.find({ type: 'Button', key: 'health-chip' })).toBeFalsy() // no fix: no chip
  for (const k of ['sort-active', 'sort-needs', 'sort-cost', 'sort-name']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy() // the chips are on the unfolded toolbar
  await openToolbar(ui)
  for (const k of ['sort-active', 'sort-needs', 'sort-cost', 'sort-name']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ More \(0 goals, 0 projects, 0 scripts\)/ })).toBeTruthy()
  expect(String((await ui.find({ type: 'Button', key: 'sec-header' }))?.text)).toMatch(/^▸ lean-agent · /) // the header card, folded: one line
  expect(all.some(t => /lean-agent 1\.0\.\d+ · refreshed/.test(t))).toBe(false)
  await openHeader(ui)
  expect((await texts(ui)).some(t => /lean-agent 1\.0\.\d+ · refreshed \d\d:\d\d:\d\d/.test(t))).toBe(true)
  for (const k of ['new-thread', 'feedback', 'repair', 'restart-desk']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy() // Restart desk is always in the header (1.0.33)
  expect(await ui.find({ type: 'Button', key: 'restart-desk-footer' })).toBeFalsy() // no footer copy of it
  await ui.unmount()
})

test('1.0.30: the rules cap and the old desk are ONE amber line each, never "error:"; a real failure stays "error:"', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  // (the notices are written after the session start: the start clears the rules-cap and old-desk ones it finds nothing behind)
  h.files.set(`${L}/notices/rules-cap.txt`, 'rules synthetic: 1 over the size cap, still loaded; learn synthetic --trim or lean_rules check\n')
  h.files.set(`${L}/notices/old-desk.txt`, `lean-agent: the old desk session synthetic-desk is not archived: ${'archive it in the app, '.repeat(12)}\n`)
  h.files.set(`${L}/notices/other.txt`, 'something is really broken\n')
  resetViewCache()
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect((await texts(ui)).some(t => /over the size cap/.test(t))).toBe(false) // in Health, which is folded
  expect((await ui.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: 3 findings') // highlighted (red: a real failure is among them)
  await openHealth(ui)
  const all = await texts(ui)
  const rules = all.filter(t => /over the size cap/.test(t))
  expect(rules).toHaveLength(1)
  expect(rules[0]).not.toMatch(/error/)
  const old = all.filter(t => /old desk session/.test(t))
  expect(old).toHaveLength(1) // one row for the old desk
  expect(old[0]).not.toMatch(/error/)
  expect(old[0]!.length).toBeLessThanOrEqual(160) // one line
  expect(all).toContain('error: something is really broken')
  await ui.unmount()
})

test('1.0.32 every part full: cards, closed rows, messages (on their cards and in Health), goals and More all draw, and the buttons of each work', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1) })
  thr(h, 't2')
  thr(h, 't3', { state: 'closed' })
  inbox(h, { ts: h.clock.t - 1000, from: 't1', kind: 'report', text: 'first', state: 'working' }, { ts: h.clock.t - 900, from: 't2', kind: 'ask', text: 'which db?' }, { ts: h.clock.t - 800, from: 'desk', kind: 'report', text: 'a notice with no card', state: 'working' })
  h.files.set(`${L}/questions.jsonl`, line({ ts: 130, from: 't2', question: 'which db?' }))
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship it', ts: h.clock.t } }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/w/p' } }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await setUp(ui)
  expect(await toolbarTitle(ui)).toMatch(/^▸ Sessions \(3\) · 3 unread · sorted by thread ↓$/)
  for (const re of [/^1 new$/, /^\[closed\]$/, /^▸ Health: 1 finding$/, /▸ More \(1 goals, 1 projects, 0 scripts\)/]) expect(await ui.find({ type: 'Button', text: re }) ?? (await ui.find({ type: 'Text', text: re }))).toBeTruthy()
  expect(await ui.findAll({ type: 'Button', text: /^1 new$/ })).toHaveLength(2) // t1 and t2; the desk's message has no card: it is the one finding in Health
  expect(await ui.find({ type: 'Button', key: 'reopen-t3' })).toBeFalsy() // folded
  await ui.press({ key: 'card-t3' })
  expect(await ui.find({ type: 'Button', key: 'reopen-t3' })).toBeTruthy()
  await ui.press({ key: 'sec-more' })
  expect(await ui.find({ type: 'Text', text: /proj · open/ })).toBeTruthy()
  await ui.press({ key: 'new-thread' })
  expect(byButton()).toEqual([{ id: 'lean-agent-new-thread', title: 'New thread' }]) // the footer button opens the form
  expect(await ui.find({ type: 'Text', text: /new thread form opened/ })).toBeTruthy()
  await ui.unmount()
})
