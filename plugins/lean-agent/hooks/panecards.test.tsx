// The desk pane's sections: Needs you, thread cards (state, branch, review verdict, cost), the widget glance, a narrow body, and every
// section empty. Everything is synthetic: thread titles, branches, shas and numbers are made up.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { branchIn, claimsPushed, loadView, resetViewCache, shasIn, stateOf } from './view'
import type { ThreadRow } from './view'
import { writeReview } from './reviews'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
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
test('Needs you: absent when nothing waits; otherwise approvals, questions, ready reports, blocked threads and scripts, each with its button on its card', { timeoutMs: 20_000 }, async ($, on) => {
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
  const all = await texts(ui)
  expect(await ui.find({ type: 'Text', text: /Needs you \(4\)/ })).toBeTruthy()
  const at = (re: RegExp) => all.findIndex(t => re.test(t))
  // the order: approvals, questions, ready reports, blocked
  expect([at(/t1 needs your yes in its own session: git push origin synthetic-branch/), at(/t2 asks: which cache\?/), at(/t4 synthetic t4 is ready to push \(abcdef1 on feat\/synthetic-x, review green\): ask the desk to push/), at(/t3 is blocked: waiting for a credential/)].every(i => i >= 0)).toBe(true)
  expect(at(/t1 needs your yes/)).toBeLessThan(at(/t2 asks/))
  expect(at(/t2 asks/)).toBeLessThan(at(/is ready to push/))
  expect(at(/is ready to push/)).toBeLessThan(at(/t3 is blocked/))
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
test('a thread card: id and the whole title, one state word, model, branch, verdict, cost, the last report on one line, its buttons', { timeoutMs: 20_000 }, async ($, on) => {
  const title = 'Rename the synthetic widget registry across all four example modules, then update every example that mentions the old name'
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'busy', state: 'working', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1), title, model: 'sonnet', effort: 'high' })
  thr(h, 't2', { state: 'open' })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Halfway. Branch: feat/synthetic-x, commit ${SHA.slice(0, 7)}.\nSecond line.`, state: 'working' })
  await review(h, { green: true, sha: SHA, project: 'proj', branch: 'feat/synthetic-x' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 0.42 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  const all = await texts(ui)
  expect(all).toContain(`t1 ${title}`) // not cut
  // 1.0.30: the meta line is split: a status chip, the model, the cost, the branch, the verdict (each its own piece)
  for (const piece of ['[working]', 'sonnet/high', 'today $0.42', 'feat/synthetic-x', 'review green']) expect(all).toContain(piece)
  expect(all.some(t => /^busy$|\[running\]/.test(t))).toBe(false)
  expect(all).toContain('Halfway. Branch: feat/synthetic-x, commit abcdef1. Second line.') // the last report, one line
  expect(all).toContain('[idle]') // t2: no report, no model recorded
  expect(all).toContain('no review')
  // one primary button per state: working = Open; idle = Open | Resume; the rest behind "more"
  for (const k of ['view-t1', 'more-t1', 'view-t2', 'resume-t2', 'more-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  for (const k of ['restart-t1', 'close-t1', 'resume-t1', 'restart-t2', 'close-t2', 'start-t2']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy()
  await ui.press({ key: 'more-t1' })
  await ui.press({ key: 'more-t2' })
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
  const all = await texts(ui)
  expect(all).toContain('[restarting]')
  expect(all).toContain('[blocked]')
  expect(all.filter(t => /^t1 is blocked/.test(t))).toHaveLength(0) // no card for t1
  expect(all.filter(t => /^t2 is blocked/.test(t))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-t2' })).toBeTruthy() // blocked: Restart is the one button on the card
  expect(await ui.find({ type: 'Button', key: 'view-t2' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy() // restarting: Open only
  expect(await ui.find({ type: 'Button', key: 'restart-t1' })).toBeFalsy()
  await ui.unmount()
})

test('1.0.30: a done thread is ONE row (title, chip, cost, Open | Resume, more); "review not green" is red only on a done thread, dim on a working one', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1) })
  inbox(h, { ts: 100, from: 't1', kind: 'report', text: `Done. Branch: feat/synthetic-y, commit ${SHA.slice(0, 7)}.`, state: 'done' })
  h.files.set(`${L}/ledger.jsonl`, line({ ts: h.clock.t, role: 'thread', tN: 't1', model: 'x', in: 1, out: 1, usd: 2.5 }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  const all = await texts(ui)
  expect(all).toContain('t1 synthetic t1')
  expect(all).toContain('[done]')
  expect(all.some(t => /today \$2\.50/.test(t))).toBe(true)
  expect(all.some(t => /^Done\. Branch/.test(t))).toBe(false) // the report line is not on the one-row form
  for (const k of ['view-t1', 'resume-t1', 'more-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  for (const k of ['restart-t1', 'close-t1', 'start-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeFalsy()
  await ui.press({ key: 'more-t1' })
  for (const k of ['restart-t1', 'close-t1', 'start-t1']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
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
    expect(await texts(ui)).toContain(`t1 ${title}`)
    expect(await ui.find({ type: 'Button', key: 'view-t1' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'repair' })).toBeTruthy()
    const row = await ui.find({ type: 'Button', key: 'row-0' })
    expect(String(row?.text).length).toBeLessThan(40) // an inbox row is cut shorter
    expect(await ui.find({ type: 'Button', text: /TAIL/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('every section empty: no Needs you, no Goals, an empty-state line for threads and inbox, Closed and More folded, the header and the footer actions', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  void h
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  const all = await texts(ui)
  expect(all.some(t => /Needs you/.test(t))).toBe(false)
  expect(await ui.find({ type: 'Button', text: /Goals/ })).toBeFalsy()
  expect(all).toContain('No open threads.')
  expect(all).toContain('Nothing from the threads yet.')
  expect(await ui.find({ type: 'Button', text: /▾ Threads \(0\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▾ Inbox \(all read\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ Closed \(0\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /▸ More \(0 projects, 0 scripts\)/ })).toBeTruthy()
  expect(all.some(t => /^lean-agent$/.test(t))).toBe(true)
  expect(all.some(t => /lean-agent 1\.0\.\d+ · refreshed \d\d:\d\d:\d\d/.test(t))).toBe(true)
  for (const k of ['new-thread', 'feedback', 'repair', 'restart-desk-footer']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'restart-desk' })).toBeFalsy() // under 80 %: not beside the bar (the footer button is permanent)
  await ui.unmount()
})

test('1.0.30: the rules cap and the old desk are ONE amber line each, never "error:"; a real failure stays "error:"', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  h.files.set(`${L}/notices/rules-cap.txt`, 'rules synthetic: 1 over the size cap, still loaded; learn synthetic --trim or lean_rules check\n')
  h.files.set(`${L}/notices/old-desk.txt`, `lean-agent: the old desk session synthetic-desk is not archived: ${'archive it in the app, '.repeat(12)}\n`)
  h.files.set(`${L}/notices/other.txt`, 'something is really broken\n')
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
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

test('every section full: needs, cards, inbox, goals, closed and More all draw, and the buttons of each work', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, [{ sessionId: SID(1), name: 'x', cwd: '/x', status: 'idle', state: 'done', startedAt: 1 }])
  thr(h, 't1', { sid: SID(1) })
  thr(h, 't2')
  thr(h, 't3', { state: 'closed' })
  inbox(h, { ts: h.clock.t - 1000, from: 't1', kind: 'report', text: 'first', state: 'working' }, { ts: h.clock.t - 900, from: 't2', kind: 'ask', text: 'which db?' })
  h.files.set(`${L}/questions.jsonl`, line({ ts: 130, from: 't2', question: 'which db?' }))
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship it', ts: h.clock.t } }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ proj: { path: '/w/p' } }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  for (const re of [/Needs you \(1\)/, /▾ Threads \(2\)/, /▾ Inbox \(2 unread\)/, /▾ Goals \(1\)/, /▸ Closed \(1\)/, /▸ More \(1 projects, 0 scripts\)/]) expect(await ui.find({ type: 'Button', text: re }) ?? (await ui.find({ type: 'Text', text: re }))).toBeTruthy()
  await ui.press({ key: 'sec-closed' })
  expect(await ui.find({ type: 'Button', key: 'reopen-t3' })).toBeTruthy()
  await ui.press({ key: 'sec-more' })
  expect(await ui.find({ type: 'Text', text: /proj · open/ })).toBeTruthy()
  await ui.press({ key: 'new-thread' })
  expect(byButton()).toEqual([{ id: 'lean-agent-new-thread', title: 'New thread' }]) // the footer button opens the form
  expect(await ui.find({ type: 'Text', text: /new thread form opened/ })).toBeTruthy()
  await ui.unmount()
})
