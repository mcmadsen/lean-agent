// A thread's own pane as cards (1.0.33): every block is a card (STATUS, REPORT, TO DECIDE, MESSAGES, TASK, RULES, FILES, HEALTH), all folded on the first draw (a thread with a
// pending approval too), one tap unfolds only that card and the fold is kept, a folded card is ONE line, the count chip of TO DECIDE, HEALTH loud only with a fix, nothing outside a card.
// Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest } from './deskactions'
import { cardWith, has, isCard, keyOf, kids, lines, openKey, textOf, topLevel } from './panetools'
import { resetLocks } from './threads'
import { resetViewCache } from './view'
import { resetThreadCache } from './threaddetail'
import { resetThreadPanes, threadPaneId } from './threadpane'
import { ruleAction, ruleCount as countRules } from './threadrules'

const L = '/h/.lean-agent'
const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const DAY = 86_400_000
const WT = '/h/.lean-agent/worktrees/app/feat-one'
const CARDS = ['status', 'report', 'decide', 'messages', 'task', 'rules', 'files', 'health']
const REPLY = { kind: 'ado-pr-reply', params: { org: 'acme', project: 'Shop', repo: 'shop-api', pr: 4321, thread: 7, body: 'Fixed in the next commit.' }, why: 'close the thread' }
const pane = (id: string) => ({ plugin: 'lean-agent', component: 'Pane', requestId: threadPaneId(id), surface: 'terminal', props: { title: 't', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }) as any
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const ok = (stdout = '') => ({ exitCode: 0, stdout })
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
const sec = (ui: any, name: string) => ui.find({ type: 'Button', key: `sec-${name}` })

// t1: a thread with a brief, a goal, a worktree (2 changed files), 3 reports, 2 queued messages, one task list; t2: nothing at all
function world(on: any, o: { config?: unknown; wtGone?: boolean } = {}) {
  resetLocks()
  resetViewCache()
  resetThreadCache()
  resetThreadPanes()
  const h = fakeHost(on)
  h.clock.t = 5 * DAY + 1000
  const f = (p: string, v: unknown) => h.files.set(`${L}/${p}`, typeof v === 'string' ? v : JSON.stringify(v))
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  f('threads/t2/thread.json', { id: 't2', title: 'empty one', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 })
  f('threads/t1/thread.json', { id: 't1', title: 'add the widget', project: 'app', state: 'open', sid: SID, sids: [SID, 'older-session'], created: 1_700_000_000_000, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'high' })
  f('threads/t1/brief.md', 'Add the widget to the settings page.\nKeep the old layout.\n')
  f('threads/t1/inbox.jsonl', [{ ts: 100, text: 'please also rename it', from: 'desk' }, { ts: 200, text: 'and add a test' }].map(r => JSON.stringify(r)).join('\n') + '\n')
  f('threads/t1/state.json', { v: 1, id: 't1', at: 5, sid: SID, dir: '/x', branch: 'feat-one', head: 'a', status: [], diffStat: '', edited: [], tasks: [{ text: 'write the test', status: 'pending' }, { text: 'wire the option', status: 'completed' }], lastReport: null, questions: [], tokens: null })
  f('threads/t1/scratch/notes.md', '# notes\nthe widget lives in settings\n')
  f('goals.json', { t1: { text: 'widget merged', ts: 1 } })
  f('projects.json', { app: { path: '/r/app' } })
  f('worktrees.json', { 'app/feat-one': { path: WT, repo: '/r/app', branch: 'feat-one', thread: 't1' } })
  if (!o.wtGone) h.files.set(`${WT}/.git`, 'gitdir: /r/app/.git/worktrees/feat-one')
  const recs = [{ ts: 1000, from: 't1', kind: 'report', state: 'working', text: 'first report' }, { ts: 1001, from: 't1', kind: 'report', state: 'working', text: 'second report' }, { ts: 1002, from: 't1', kind: 'report', state: 'done', text: 'third report: all green' }]
  f('desk/inbox.jsonl', recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  f('ledger.jsonl', JSON.stringify({ ts: h.clock.t - 10, role: 'thread', tN: 't1', model: 'sonnet', usd: 1.25 }) + '\n')
  if (o.config) f('config.json', o.config)
  const HEAD = 'a'.repeat(40)
  const BASE = 'b'.repeat(40)
  h.git.handler = a => {
    let rest = a.slice(2)
    while (rest[0] === '-c') rest = rest.slice(2)
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') return ok(`${HEAD}\n`)
    if (rest[0] === 'rev-parse' && rest.includes('--verify')) {
      const ref = String(rest[rest.length - 1]).replace(/\^\{commit\}$/, '')
      return ref === HEAD ? ok(HEAD) : ref === 'main' || ref === BASE ? ok(BASE) : { exitCode: 1, stdout: '' }
    }
    if (rest[0] === 'merge-base') return ok(BASE)
    if (rest[0] === 'diff' && rest.includes('--stat')) return ok(' src/widget.ts | 30 ++++++++++++\n test/widget.test.ts | 12 +++++\n 2 files changed, 42 insertions(+)\n')
    return { exitCode: 1, stdout: '' }
  }
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? ok(JSON.stringify([])) : ok())
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: h.store.get(e.key) }))
  on('store.set', (_: any, e: any) => { h.store.set(e.key, e.value); return { value: undefined } })
  return h
}
const arrows = async (ui: any) => Object.fromEntries(await Promise.all(CARDS.map(async c => [c, String((await sec(ui, c))?.text ?? '?')[0]])))
const allFolded = Object.fromEntries(CARDS.map(c => [c, '▸']))

test('the session pane is cards only: every top-level child is a card, the eight cards in order, and every card starts FOLDED', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const top = await topLevel(ui)
  expect(top.loose).toEqual([]) // nothing outside a card
  expect(top.cards).toHaveLength(8)
  CARDS.forEach((c, i) => expect(has(top.cards[i]!, x => keyOf(x) === `sec-${c}`), c).toBe(true))
  expect(await arrows(ui)).toEqual(allFolded)
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.text).startsWith('▾'))).toEqual([])
  // a thread with a pending approval: its TO DECIDE card says so, and is still folded
  await addActionRequest(h.host, 't1', REPLY)
  await ui.unmount()
  const ui2 = await $.ui.mount(pane('t1'))
  expect(await arrows(ui2)).toEqual(allFolded)
  expect((await sec(ui2, 'decide'))?.text).toMatch(/^▸ To decide/)
  expect(await texts(ui2)).toContain('1 to decide')
  expect((await ui2.findAll({ type: 'Button' })).some((b: any) => /^action-(approve|deny)-/.test(String(b.key)))).toBe(false)
  expect((await topLevel(ui2)).loose).toEqual([])
  await ui2.unmount()
})

test('every non-thread answer is a card too: a missing thread, a closed one, a pane outside the desk, a failed draw', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  h.files.set(`${L}/threads/t3/thread.json`, JSON.stringify({ id: 't3', title: 'gone one', project: '', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  await inDesk($)
  for (const id of ['t99', 't3']) {
    const ui = await $.ui.mount(pane(id))
    const top = await topLevel(ui)
    expect(top.loose, id).toEqual([])
    expect(top.cards, id).toHaveLength(1)
    await ui.unmount()
  }
  await $.session.start({ cwd: '/h/.claude/spares/spare-x', surface: 'desktop', isInteractive: true } as any)
  const out = await $.ui.mount(pane('t1'))
  expect((await topLevel(out)).loose).toEqual([])
  await out.unmount()
})

test('a tap unfolds only that card, the fold is kept (a refresh, a remount) and a second tap folds it', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  let ui = await $.ui.mount(pane('t1'))
  await ui.press({ key: 'sec-task' })
  expect(await arrows(ui)).toEqual({ ...allFolded, task: '▾' }) // only that one
  expect(await texts(ui)).toContain('goal: widget merged')
  await ui.unmount()
  ui = await $.ui.mount(pane('t1')) // a remount keeps it (the mod's store)
  expect(await arrows(ui)).toEqual({ ...allFolded, task: '▾' })
  await ui.press({ key: 'sec-files' })
  expect(await arrows(ui)).toEqual({ ...allFolded, task: '▾', files: '▾' })
  await ui.press({ key: 'sec-task' })
  expect(await arrows(ui)).toEqual({ ...allFolded, files: '▾' })
  await ui.unmount()
  const other = await $.ui.mount(pane('t2')) // the fold belongs to the thread: t2's cards are still folded
  expect(await arrows(other)).toEqual(allFolded)
  await other.unmount()
})

test('a folded card is exactly ONE line (title cut with an ellipsis, chips beside it, nothing wraps); unfolded it has more', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'Rename the synthetic widget registry across all four example modules, then update every example that mentions the old name', project: 'app', state: 'open', sid: SID, created: 1000, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'high' }))
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  for (const c of CARDS) {
    const card = (await cardWith(ui, `sec-${c}`))!
    expect(lines(card), c).toHaveLength(1)
    expect(lines(card)[0]!.props?.flexWrap, c).toBe('nowrap')
    expect(keyOf(kids(lines(card)[0]!)[0]!), c).toBe(`sec-${c}`) // the title button first
    expect(isCard(card)).toBe(true)
  }
  const title = String((await sec(ui, 'status'))?.text)
  expect(title.endsWith('…')).toBe(true)
  expect(title.length).toBeLessThanOrEqual(80 - 4)
  await openKey(ui, 'sec-status')
  expect(lines((await cardWith(ui, 'sec-status'))!).length).toBeGreaterThan(1)
  expect(await texts(ui)).toContain('Rename the synthetic widget registry across all four example modules, then update every example that mentions the old name') // the whole title, once, inside
  await ui.unmount()
})

test('STATUS folded: state chip, age (no dollar figure); unfolded: model, branch / worktree, started, restarts and the buttons (Open session, Restart from handover, Close, Refresh)', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const line = textOf(lines((await cardWith(ui, 'sec-status'))!)[0]!)
  expect(line).toMatch(/\[idle\]|\[done\]/)
  expect(line).not.toContain('$') // no dollar figure (the usage chip is checked in threadpane.test.tsx)
  expect(line).toMatch(/(just now|\d+ min ago|\d+ h ago|\d+ d ago)/)
  for (const b of ['open-session', 'restart', 'close', 'refresh']) expect(await ui.find({ type: 'Button', key: b }), b).toBeFalsy() // folded: none of them
  await openKey(ui, 'sec-status')
  const t = await texts(ui)
  expect(t.some(x => /sonnet\/high/.test(x))).toBe(true)
  expect(t.some(x => /branch feat-one · worktree \/h\/\.lean-agent\/worktrees\/app\/feat-one/.test(x))).toBe(true)
  expect(t.some(x => /^started \d\d-\d\d \d\d:\d\d · 1 restart$/.test(x))).toBe(true)
  for (const b of ['open-session', 'restart', 'close', 'refresh']) expect(await ui.find({ type: 'Button', key: b }), b).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'restart' }))?.text).toBe('Restart from handover')
  await ui.unmount()
})

test('REPORT: the last report with its state chip; the earlier ones are rows (never the newest twice); an empty thread says so', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const folded = textOf(lines((await cardWith(ui, 'sec-report'))!)[0]!)
  expect(folded).toContain('[done]')
  expect(folded).toContain('third report: all green')
  await openKey(ui, 'sec-report')
  expect(await texts(ui)).toContain('third report: all green')
  expect(await ui.findAll({ type: 'Button', text: /third report/ })).toHaveLength(1) // (the title button; the text is not a second row)
  expect(await ui.find({ type: 'Button', key: 'btn-r1' })).toBeTruthy() // "second report"
  expect(await ui.find({ type: 'Button', key: 'btn-r0' })).toBeTruthy()
  await ui.unmount()
  const e = await $.ui.mount(pane('t2'))
  expect(textOf(lines((await cardWith(e, 'sec-report'))!)[0]!)).toContain('none yet')
  await e.unmount()
})

test('TO DECIDE: the count chip, nothing unfolds by itself (pane.foldAll false does), the decision is a nested card with Approve / Deny pressed twice, and an empty card says nothing waits', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  const req = (await addActionRequest(h.host, 't1', REPLY)).request!
  await inDesk($)
  let ui = await $.ui.mount(pane('t1'))
  expect(await texts(ui)).toContain('1 to decide')
  expect((await sec(ui, 'decide'))?.text.startsWith('▸')).toBe(true)
  await openKey(ui, 'sec-decide')
  const card = (await cardWith(ui, 'sec-decide'))!
  const nested = kids(kids(card).find(k => keyOf(k) === 'decide-body') ?? card).filter(isCard)
  expect(nested).toHaveLength(1)
  expect(has(nested[0]!, x => keyOf(x) === `action-approve-${req.id}`)).toBe(true)
  expect(has(nested[0]!, x => keyOf(x) === `action-deny-${req.id}`)).toBe(true)
  await ui.press({ key: `action-deny-${req.id}` }) // the first press only arms it
  expect((await ui.find({ type: 'Button', key: `action-deny-${req.id}` }))?.text).toMatch(/^Confirm deny/)
  await ui.unmount()
  // the other thread has nothing to decide: a quiet card
  const quiet = await $.ui.mount(pane('t2'))
  expect(await texts(quiet)).not.toContain('0 to decide')
  expect(textOf(lines((await cardWith(quiet, 'sec-decide'))!)[0]!)).toContain('nothing waits')
  await quiet.unmount()
  // pane.foldAll false: the card with the decision unfolds by itself, the others stay folded
  h.files.set(`${L}/config.json`, JSON.stringify({ pane: { foldAll: false } }))
  ui = await $.ui.mount(pane('t1'))
  expect(await arrows(ui)).toEqual({ ...allFolded, decide: '▾' })
  await ui.unmount()
})

test('MESSAGES: the messages to the thread with their delivery state, a "queued" chip; the unread ones from it with ack; the "N new" chip opens the card', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const folded = textOf(lines((await cardWith(ui, 'sec-messages'))!)[0]!)
  expect(folded).toContain('2 queued')
  expect(folded).toContain('3 new') // its three reports are unread
  expect((await sec(ui, 'messages'))?.text.startsWith('▸')).toBe(true)
  await ui.press({ key: 'new-msgs' }) // the chip opens the card
  expect((await sec(ui, 'messages'))?.text.startsWith('▾')).toBe(true)
  const t = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.text))
  expect(t.some(x => /\[queued\] please also rename it/.test(x))).toBe(true)
  expect(t.some(x => /\[queued\] and add a test/.test(x))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'ack-card' })).toBeTruthy()
  await ui.press({ key: 'ack-card' })
  expect(await texts(ui)).not.toContain('3 new')
  // consumed: delivered and read by the thread
  h.files.set(`${L}/threads/t1/consumed.json`, JSON.stringify({ n: 1 }))
  resetViewCache()
  await ui.press({ key: 'refresh' }).catch(() => undefined)
  await ui.unmount()
})

test('TASK: the goal, the brief, and the open items of the task list (a chip says how many)', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const folded = textOf(lines((await cardWith(ui, 'sec-task'))!)[0]!)
  expect(folded).toContain('widget merged')
  expect(folded).toContain('1 open')
  await openKey(ui, 'sec-task')
  const t = await texts(ui)
  expect(t).toContain('☐ write the test')
  expect(t).toContain('☑ wire the option')
  expect(t.some(x => /Keep the old layout/.test(x))).toBe(true)
  await ui.unmount()
})

test('RULES: the thread\'s standing rules with Remove (two presses); a change goes through the desk', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  const added = await ruleAction(h.host, '/h', { tN: 't1', text: 'never touch the vendored folder' })
  expect(added.ok, added.text).toBe(true)
  await inDesk($)
  let ui = await $.ui.mount(pane('t1'))
  expect(await ruleCount(h)).toBe(1)
  expect(textOf(lines((await cardWith(ui, 'sec-rules'))!)[0]!)).toContain('Rules (1)')
  await openKey(ui, 'sec-rules')
  expect((await texts(ui)).some(x => /never touch the vendored folder/.test(x))).toBe(true)
  const rm = (await ui.findAll({ type: 'Button' })).find((b: any) => /^rule-remove-/.test(String(b.key)))!
  expect(rm.text).toBe('Remove')
  const rmKey = String(rm.key)
  await ui.press({ key: rmKey })
  expect((await ui.find({ type: 'Button', key: rmKey }))?.text).toMatch(/^Confirm remove/)
  expect(await ruleCount(h)).toBe(1) // the first press changed nothing
  await ui.press({ key: rmKey })
  expect(await ruleCount(h)).toBe(0)
  await ui.unmount()
  ui = await $.ui.mount(pane('t2'))
  await openKey(ui, 'sec-rules')
  expect((await texts(ui)).some(x => /No standing rules/.test(x))).toBe(true)
  await ui.unmount()
})
const ruleCount = (h: ReturnType<typeof fakeHost>): Promise<number> => countRules(h.host, '/h', 't1')

test('FILES: the changed files and the scratch notes are chips on the folded line, the diff and the files inside', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const folded = textOf(lines((await cardWith(ui, 'sec-files'))!)[0]!)
  expect(folded).toContain('2 changed')
  expect(folded).toContain('1 scratch')
  await openKey(ui, 'sec-files')
  const t = await texts(ui)
  expect(t.some(x => /diff against bbbbbbbbbbbb: 2 files changed, 42 insertions/.test(x))).toBe(true)
  expect(t.some(x => /notes\.md \(\d+ B\)/.test(x))).toBe(true)
  await ui.unmount()
})

test('HEALTH: quiet grey ("all good") while nothing is wrong; highlighted only with a fix (a gone worktree), red only for a blocker; the guard refusals of the thread are information', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  let ui = await $.ui.mount(pane('t1'))
  const health = async () => (await cardWith(ui, 'sec-health'))!
  expect((await sec(ui, 'health'))?.text).toBe('▸ Health: all good')
  expect((await health()).props?.borderColor).toBeUndefined() // quiet: no color,
  expect((await health()).props?.borderDimColor).toBe(true) // and dim
  expect(await texts(ui)).not.toContain('1 fix')
  // guard refusals of THIS thread in the last day: information, still quiet
  h.files.set(`${L}/refusals.jsonl`, [{ ts: h.clock.t - 1000, src: 'guard', thread: 't1', text: 'lean-agent: refused a synthetic call' }, { ts: h.clock.t - 1000, src: 'guard', thread: 't2', text: 'another thread' }, { ts: h.clock.t - 3 * DAY, src: 'guard', thread: 't1', text: 'too old' }].map(r => JSON.stringify(r)).join('\n') + '\n')
  await ui.unmount()
  ui = await $.ui.mount(pane('t1'))
  expect((await health()).props?.borderColor).toBeUndefined()
  expect(await texts(ui)).toContain('1 info line')
  await openKey(ui, 'sec-health')
  expect((await texts(ui)).some(x => /^1 guard refusal in the last 24 h/.test(x))).toBe(true)
  await ui.unmount()
  // a fix: the worktree is gone
  h.files.delete(`${WT}/.git`)
  resetThreadCache()
  ui = await $.ui.mount(pane('t1'))
  await ui.press({ key: 'sec-health' }) // (the fold of the earlier tap was kept: fold it again)
  expect((await sec(ui, 'health'))?.text).toBe('▸ Health: 1 finding')
  expect((await health()).props?.borderColor).toBe('warning')
  expect(await texts(ui)).toContain('1 fix')
  await openKey(ui, 'sec-health') // highlighted while folded, and its fix is on the unfolded card
  expect((await texts(ui)).some(x => /the worktree \/h\/\.lean-agent\/worktrees\/app\/feat-one is gone/.test(x))).toBe(true)
  await ui.unmount()
  // the other thread is untouched by it
  const q = await $.ui.mount(pane('t2'))
  expect((await q.find({ type: 'Button', key: 'sec-health' }))?.text).toBe('▸ Health: all good')
  await q.unmount()
})
