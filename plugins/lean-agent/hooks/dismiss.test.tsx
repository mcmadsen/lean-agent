// Dismiss: every Needs-you card has a two-press Dismiss; a notice at the top hides on one press. One store (dismissstore.ts): who/when/what in the
// thread's history.jsonl (the desk's for a desk-level item); the view hides THAT item until a newer one of its kind arrives; the record behind it
// stays, and a dismissed question is not answered. `lean_thread dismiss` does the same on the user's word. Synthetic ids only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { dismissAction } from './dismiss'
import { dismissedTs } from './dismissstore'
import { leanThread, resetLocks } from './threads'
import { loadView, needsOf, resetViewCache } from './view'
import type { ThreadRow } from './view'

const L = '/h/.lean-agent'
const SID = (n: number) => `0000000${n}-2222-3333-4444-555555555555`
const line = (o: unknown) => JSON.stringify(o) + '\n'
const thr = (h: any, id: string, o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `synthetic ${id}`, project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
const inbox = (h: any, ...recs: unknown[]) => h.files.set(`${L}/desk/inbox.jsonl`, (h.files.get(`${L}/desk/inbox.jsonl`) ?? '') + recs.map(line).join(''))
const hist = (h: any, id: string) => (h.files.get(`${L}/threads/${id}/history.jsonl`) ?? '').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
const has = async (ui: any, re: RegExp) => (await texts(ui)).some(t => re.test(t))

function world(on: any = null, agents: any[] = []) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? { exitCode: 0, stdout: JSON.stringify(agents) } : { exitCode: 0, stdout: '' })
  if (on) {
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
  }
  return h
}
// the desk's items: t3 blocked, t5 needs its yes, t7 asks, t4 waits on a prompt, t8 blocked too (another thread's item stays when t3's goes)
function items(h: any) {
  thr(h, 't3')
  thr(h, 't4', { sid: SID(4) })
  thr(h, 't5')
  thr(h, 't7')
  thr(h, 't8')
  inbox(h, { ts: 110, from: 't3', kind: 'report', text: 'waiting for a credential', state: 'blocked' }, { ts: 111, from: 't5', kind: 'report', text: 'cannot run it', state: 'blocked', approval: 'git push origin synthetic-branch' }, { ts: 112, from: 't8', kind: 'report', text: 'stuck on a flag', state: 'blocked' })
  h.files.set(`${L}/questions.jsonl`, line({ ts: 130, from: 't7', question: 'Post it? Nothing is posted without your yes.' }))
}
const WAITING = [{ sessionId: SID(4), name: 'x', cwd: '/x', status: 'idle', state: 'blocked', waitingFor: 'a prompt', startedAt: 1 }]

test('every kind of card has a dk (thread or desk, kind, the item\'s own id); a model request and a script keep their own buttons', () => {
  const t = (o: Partial<ThreadRow>) => ({ id: 't1', title: '', state: 'open', run: 'idle', last: '', resumable: false, working: false, done: false, asking: false, blocked: false, needsYou: false, lastReport: 'x', review: 'none', cost: 0, ready: false, recTs: 5, unread: 0, ...o }) as ThreadRow
  const desk = { context: 0, limit: 0, model: '', effort: '', note: '' }
  const rows = needsOf({
    threads: [t({ id: 't1', approval: 'git push' }), t({ id: 't2', needsYou: true, waitId: 's:p' }), t({ id: 't3', blocked: true }), t({ id: 't4', live: 'stalled', stallId: '9', liveNote: 'no progress' }), t({ id: 't5', ready: true, sha: 'abc1234' })],
    openQuestions: [{ q: 3, from: 't6', question: 'which?' }, { q: 4, question: 'desk?' }],
    scripts: { candidates: 0, adopted: 0, needsUpdate: 0, waiting: [{ name: 'syn', project: 'p', why: 'w', sha: 'a'.repeat(64) } as any] },
    desk: { ...desk, limit: 100, context: 120 },
    modelRequests: [{ id: 'm1', thread: 't1', model: 'opus', family: 'opus', reason: 'r', state: 'pending', origin: 'tool', action: 'new' } as any],
    actionRequests: [{ id: 'a1', thread: 't1', state: 'pending', headline: 'reply', text: 'hello' } as any],
    deskModelRed: 'desk on opus',
  })
  expect(rows.map(r => `${r.dk?.thread}|${r.dk?.kind}|${r.dk?.id}`).sort()).toEqual(['desk|deskmodel|desk on opus', 'desk|question|4', 'desk|script|syn::aaaaaaaaaaaa', 't1|action|a1:pending', 't1|approval|5', 't1|model|m1:pending', 't2|prompt|s:p', 't3|blocked|5', 't4|stalled|9', 't5|ready|5', 't6|question|3'])
})

test('the tool: dismiss tN hides its current item, tN kind: that one, notice hides a line; the reply names it; nothing is answered; the record stays; a newer one shows again; another thread is untouched', async () => {
  const h = world(null, WAITING)
  items(h)
  const before = await loadView(h.host)
  expect(before.needs.map(n => n.dk!.thread + '|' + n.dk!.kind).sort()).toEqual(['t3|blocked', 't4|prompt', 't5|approval', 't7|question', 't8|blocked'])
  expect((await dismissAction(h.host, { tN: 'nope' })).ok).toBe(false)
  expect((await dismissAction(h.host, { tN: 't3', kind: 'bogus' })).ok).toBe(false)
  expect((await dismissAction(h.host, { tN: 't3', kind: 'question' })).text).toContain('nothing to dismiss')
  const r = await leanThread(h.host, '/root', { action: 'dismiss', tN: 't3' }) // the one dispatch line in threads.ts
  expect(r.ok).toBe(true)
  expect(r.text).toContain('hid the blocked report')
  expect(r.text).toContain('A newer blocked report will show again')
  expect(await dismissedTs(h.host, '/h', 't3')).toBe(110) // (what the blocked badge reads)
  expect(hist(h, 't3')[0]).toMatchObject({ kind: 'dismiss', by: 'user', what: 'blocked', id: '110' }) // who, when, what
  expect(typeof hist(h, 't3')[0].ts).toBe('number')
  resetViewCache()
  const v = await loadView(h.host)
  expect(v.threads.find(t => t.id === 't3')!.blocked).toBe(false)
  expect(v.needs.some(n => n.thread === 't3')).toBe(false)
  expect(v.needs.some(n => n.thread === 't8')).toBe(true) // another thread's item is untouched
  expect(v.dismissed.map(n => n.thread)).toEqual(['t3'])
  expect(h.files.get(`${L}/desk/inbox.jsonl`)).toContain('waiting for a credential') // the report stays
  expect((await dismissAction(h.host, { tN: 't3' })).text).toContain('already dismissed') // twice is harmless
  // a question: hidden, NOT answered (no answers.jsonl row, nothing sent to t7)
  const q = await dismissAction(h.host, { tN: 't7', kind: 'kind:question' })
  expect(q.text).toContain('hid the question')
  expect(h.files.get(`${L}/answers.jsonl`)).toBeUndefined()
  expect(h.files.get(`${L}/threads/t7/inbox.jsonl`)).toBeUndefined()
  expect(h.files.get(`${L}/questions.jsonl`)).toContain('Post it?') // the record stays
  // the prompt wait and the approval, by kind
  expect((await dismissAction(h.host, { tN: 't4', kind: 'prompt' })).ok).toBe(true)
  expect((await dismissAction(h.host, { tN: 't5', kind: 'approval' })).text).toContain('approval request')
  resetViewCache()
  expect((await loadView(h.host)).needs.map(n => n.thread)).toEqual(['t8'])
  // newer ones of the same kind show again: a newer blocked report, a newer question, a new prompt wait
  inbox(h, { ts: 200, from: 't3', kind: 'report', text: 'blocked again on the same credential', state: 'blocked' })
  h.files.set(`${L}/questions.jsonl`, (h.files.get(`${L}/questions.jsonl`) as string) + line({ ts: 210, from: 't7', question: 'And the title?' }))
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify([{ ...WAITING[0], waitingFor: 'another prompt' }]) } : { exitCode: 0, stdout: '' })
  resetViewCache()
  const again = await loadView(h.host)
  expect(again.needs.map(n => `${n.thread}|${n.dk!.kind}`).sort()).toEqual(['t3|blocked', 't4|prompt', 't7|question', 't8|blocked'])
  // the count: lean_thread list does not count dismissed items, and says how many are hidden
  const list = await leanThread(h.host, '/root', { action: 'list' })
  expect(list.text).toContain('Needs you: 4 (2 dismissed')
})

test('the tool: dismiss notice <id|all> hides a line until its text changes; a budget alert is bound to the day', async () => {
  const h = world()
  thr(h, 't1')
  h.files.set(`${L}/notices/budget-t5.txt`, 'budget: t5 has spent $12.34 today, over its $10.00 daily alert (sonnet/high). Ask what it is doing, or park it. (config budget.threadDaily)\n')
  h.files.set(`${L}/notices/githooks.txt`, 'lean-agent: git hooks not installed\n')
  const v = await loadView(h.host)
  expect(v.notices.map(n => n.key).sort()).toEqual(['budget-t5', 'githooks'])
  expect(v.notices.find(n => n.key === 'budget-t5')!.budget).toBe(true) // an alert, not an error
  expect(v.errors.some(e => /budget/.test(e))).toBe(false)
  expect((await dismissAction(h.host, { notice: 'budget-t5' })).text).toContain('A newer notice will show again')
  expect((await dismissAction(h.host, { notice: 'budget-t5' })).text).toContain('not shown')
  resetViewCache()
  const a = await loadView(h.host)
  expect(a.notices.map(n => n.key)).toEqual(['githooks'])
  expect(a.dismissedNotices.map(n => n.key)).toEqual(['budget-t5'])
  expect(h.files.get(`${L}/notices/budget-t5.txt`)).toContain('$12.34') // the notice file stays
  expect(h.files.get(`${L}/desk/history.jsonl`)).toContain('"what":"notice"') // the desk's history
  h.files.set(`${L}/notices/budget-t5.txt`, 'budget: t5 has spent $30.00 today, over its $10.00 daily alert\n') // the next occurrence
  resetViewCache()
  expect((await loadView(h.host)).notices.map(n => n.key).sort()).toEqual(['budget-t5', 'githooks'])
  expect((await dismissAction(h.host, { notice: 'all' })).text).toContain('budget: t5')
  resetViewCache()
  expect((await loadView(h.host)).notices).toEqual([])
  h.clock.t += 2 * 86_400_000 // the next day: the same text is a new alert (and the file's own text is gone with the old day in real use)
  resetViewCache()
  expect((await loadView(h.host)).notices.map(n => n.key)).toEqual(['budget-t5'])
})

test('a restart that gave up belongs to its thread: dismiss tN kind:restart', async () => {
  const h = world()
  thr(h, 't2')
  h.files.set(`${L}/notices/restart-t2.txt`, 't2: automatic restart failed 3 times (last reason: x)\n')
  expect((await loadView(h.host)).notices[0]!.dk).toMatchObject({ thread: 't2', kind: 'restart' })
  expect((await dismissAction(h.host, { tN: 't2', kind: 'restart' })).text).toContain('failed restart')
  expect(hist(h, 't2')[0]).toMatchObject({ what: 'restart' })
  resetViewCache()
  expect((await loadView(h.host)).notices).toEqual([])
})

test('the pane: each card has a two-press Dismiss that logs it; the count leaves it out; "N dismissed" and show bring it back; a notice hides on one press', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on, WAITING)
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  items(h)
  h.files.set(`${L}/notices/budget-t5.txt`, 'budget: t5 has spent $12.34 today, over its $10.00 daily alert\n')
  const ui = await $.ui.mount(PANE as any)
  const unfold = async (key: string) => {
    const b = await ui.find({ type: 'Button', key })
    if (b && String(b.text).startsWith('▸')) await ui.press({ key })
  }
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeFalsy() // 1.0.32: the cards are on their thread cards, folded
  expect(await ui.find({ type: 'Button', key: 'dismiss-t7-question' })).toBeFalsy()
  for (const id of ['t3', 't4', 't5', 't7', 't8']) await unfold(`card-${id}`)
  for (const k of ['t3-blocked', 't4-prompt', 't5-approval', 't7-question', 't8-blocked']) expect([k, !!(await ui.find({ type: 'Button', key: `dismiss-${k}` }))]).toEqual([k, true])
  await unfold('sec-health') // the notice is in Health
  expect(await has(ui, /^budget: t5 has spent/)).toBe(true) // an alert: "budget:", no "error:" in front
  expect(await has(ui, /error: budget/)).toBe(false)
  await ui.press({ key: 'dismiss-t7-question' })
  expect(await ui.find({ type: 'Button', text: /Confirm dismiss t7/ })).toBeTruthy() // armed, nothing recorded yet
  expect(hist(h, 't7')).toEqual([])
  await ui.press({ key: 'dismiss-t7-question' })
  expect(hist(h, 't7')[0]).toMatchObject({ kind: 'dismiss', what: 'question', id: '1' })
  expect(await ui.find({ type: 'Button', key: 'dismiss-t7-question' })).toBeFalsy() // gone from t7's card
  expect(await has(ui, /^t7 asks/)).toBe(false)
  expect(await has(ui, /t8 is blocked/)).toBe(true) // another thread's card stays
  expect(await has(ui, /^1 dismissed$/)).toBe(true)
  await ui.press({ key: 'dismissed-toggle' })
  expect(await has(ui, /^t7 asks: Post it\?.*\(dismissed: a newer one will show again\)/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'dismiss-t7-question' })).toBeFalsy() // shown dim, no buttons, still not an item that waits
  await ui.press({ key: 'dismissed-toggle' })
  expect(await has(ui, /^t7 asks/)).toBe(false)
  await ui.press({ key: 'notice-dismiss-budget-t5' }) // one press
  expect(await has(ui, /^budget: t5 has spent/)).toBe(false)
  expect(await has(ui, /^2 dismissed$/)).toBe(true)
  expect(h.files.get(`${L}/notices/budget-t5.txt`)).toContain('$12.34')
  await ui.unmount()
})
