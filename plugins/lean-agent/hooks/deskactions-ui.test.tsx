// The user's side of the typed desk actions (deskactions.ts): the Needs-you card with its exact text and two-press Approve / Deny, and the desk's
// AskUserQuestion hook that reads the user's answer from the tool's result. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, listActions, questionOf } from './deskactions'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const L = '/h/.lean-agent'
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
const has = async (ui: any, re: RegExp) => (await texts(ui)).some(t => re.test(t))
const TOKEN = 'SECRET-TOKEN-0123456789'
const BODY = 'Fixed in the next commit, thanks.'
const REPLY = { kind: 'ado-pr-reply', params: { org: 'acme', project: 'Shop', repo: 'shop-api', pr: 42, thread: 7, body: BODY }, why: 'close the thread' }

function world(on: any) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? { exitCode: 0, stdout: JSON.stringify({ id: 77 }) } : { exitCode: 127, stdout: '', stderr: 'unknown' })
  const kv = new Map<string, unknown>()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const host = { ...h.host, store: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) }, clock: { now: async () => h.clock.t } } as any
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'synthetic t5', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const ask = async () => (await addActionRequest(host, 't5', REPLY)).request!
  const curls = () => h.calls.filter(c => c.argv[0] === 'curl')
  return { h, kv, host, ask, curls }
}

test('a request is a Needs-you card with the exact text; Approve and Deny press twice; Approve sends once and the card goes', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const v = await w.ask()
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: "Button", key: "card-t5" }))?.text).toMatch(/^▾ t5/) // a decision to take is unfolded on its thread card (1.0.32: no Needs-you section)
  expect(await has(ui, new RegExp(`t5 wants to reply to PR thread 7 on PR 42 \\(acme/Shop/shop-api\\): ${BODY.replace('.', '\\.')}`))).toBe(true)
  for (const k of [`action-approve-${v.id}`, `action-deny-${v.id}`, 'pane-t5']) expect([k, !!(await ui.find({ type: 'Button', key: k }))]).toEqual([k, true])
  await ui.press({ key: `action-approve-${v.id}` })
  expect(await ui.find({ type: 'Button', key: `action-approve-${v.id}`, text: 'Confirm: send this text for t5' })).toBeTruthy()
  expect(w.curls()).toHaveLength(0) // armed only
  await ui.press({ key: `action-approve-${v.id}` })
  expect(w.curls()).toHaveLength(1)
  expect(w.curls()[0]!.argv.join(' ')).not.toContain(TOKEN)
  expect(await listActions(w.host)).toEqual([])
  expect(await has(ui, /sent ado-pr-reply for t5: id 77/)).toBe(true)
  expect(await has(ui, /Needs you/)).toBe(false)
  expect(w.h.files.get(`${L}/threads/t5/history.jsonl`)).toContain('user, in the pane')
  expect(w.h.files.get(`${L}/threads/t5/inbox.jsonl`)).toContain('the desk sent it') // the thread was told
  await ui.unmount()
})

test('Deny on the card tells the thread and sends nothing; the thread\'s own blocked row is not shown on top of the request', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const v = await w.ask()
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await has(ui, /t5 is blocked/)).toBe(false)
  await ui.press({ key: `action-deny-${v.id}` })
  expect(await ui.find({ type: 'Button', key: `action-deny-${v.id}`, text: 'Confirm deny for t5' })).toBeTruthy()
  expect((await listActions(w.host))[0]!.state).toBe('pending')
  await ui.press({ key: `action-deny-${v.id}` })
  expect(w.curls()).toHaveLength(0)
  expect(await listActions(w.host)).toEqual([])
  expect(w.h.files.get(`${L}/threads/t5/inbox.jsonl`)).toContain('denied')
  await ui.unmount()
})

// ---- the desk's AskUserQuestion: the answer is read from the tool's RESULT --------------------------------------------------------------
async function deskAsk($: any, on: any, result: (e: any) => unknown) {
  const w = world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: result(e) }) as any) // the engine's own tool, beneath the plugin
  await inDesk($)
  return w
}

test('the desk\'s AskUserQuestion: Approve in the result is recorded when the question named the request and its exact text', { timeoutMs: 20_000 }, async ($, on) => {
  let want = ''
  const w = await deskAsk($, on, e => ({ questions: e.questions, answers: { [e.questions[0].question]: want } }))
  const v = await w.ask()
  const q = questionOf(v)
  want = 'Approve'
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q.question, header: 'Send?', multiSelect: false, options: q.options }] } as any)
  expect(r.deny).toBeUndefined()
  expect(JSON.stringify(r.context ?? [])).toContain(`approve-action ${v.id}`)
  expect((await listActions(w.host))[0]!.state).toBe('approved')
  expect(w.curls()).toHaveLength(0) // approving only records the human's answer: the desk's approve-action sends
})

test('through the desk hook: text typed under "Other" is read from the result: a clear approval counts, anything else reaches the desk as one line (never dropped)', { timeoutMs: 20_000 }, async ($, on) => {
  let want = ''
  const w = await deskAsk($, on, e => ({ questions: e.questions, answers: { [e.questions[0].question]: want } }))
  const v = await w.ask()
  const q = questionOf(v)
  const ask = () => $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q.question, header: 'Send?', multiSelect: false, options: q.options }] } as any) as Promise<any>
  want = 'maybe later, I want to read it again'
  const free = await ask()
  expect(JSON.stringify(free.context ?? [])).toContain("the user typed 'maybe later, I want to read it again': free text is not an approval for this request; ask again with the choices, or the user can type /lean-agent:allow t5 42")
  expect((await listActions(w.host))[0]!.state).toBe('pending')
  want = 'ALWAYS APPROVE THIS!'
  const yes = await ask()
  expect(JSON.stringify(yes.context ?? [])).toContain(`approve-action ${v.id}`)
  expect((await listActions(w.host))[0]!.state).toBe('approved')
  expect(w.curls()).toHaveLength(0) // a typed approval, like a pressed one, only records the human's answer
})

test('a question that does not carry the exact text records nothing, and a model that fills in `answers` is refused before the dialog', { timeoutMs: 20_000 }, async ($, on) => {
  let asks = 0
  let readable = true
  const w = await deskAsk($, on, e => {
    asks++
    return readable ? { questions: e.questions, answers: { [e.questions[0].question]: 'Approve' } } : { questions: e.questions }
  })
  const v = await w.ask()
  const q = questionOf(v)
  const other = `Shall I post a short reply to the PR [request ${v.id}]?`
  const vague: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: other, header: 'Send?', multiSelect: false, options: q.options }] } as any)
  expect(vague.deny).toBeUndefined()
  expect(JSON.stringify(vague.context ?? [])).toContain('NOT recorded')
  expect((await listActions(w.host))[0]!.state).toBe('pending')
  // the model pre-fills the answer it wants: refused, the dialog never opens
  const before = asks
  const forged: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q.question, header: 'Send?', multiSelect: false, options: q.options }], answers: { [q.question]: 'Approve' } } as any)
  expect(forged.deny).toContain('answers belong to the user')
  expect(asks).toBe(before)
  expect((await listActions(w.host))[0]!.state).toBe('pending')
  // a result with no readable answers (the dialog was dismissed): nothing recorded, the pane is the other way
  readable = false
  const none: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q.question, header: 'Send?', multiSelect: false, options: q.options }] } as any)
  expect(JSON.stringify(none.context ?? [])).toContain('pane')
  expect((await listActions(w.host))[0]!.state).toBe('pending')
})

test('a thread\'s own AskUserQuestion is never an answer: the guard refuses it and nothing is recorded', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: 'Approve' } } }) as any)
  const v = await w.ask()
  const q = questionOf(v)
  w.h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  await $.session.start({ cwd: `${L}/threads/t5`, surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q.question, header: 'Send?', multiSelect: false, options: q.options }] } as any)
  expect(r.deny).toBeDefined()
  expect((await listActions(w.host))[0]!.state).toBe('pending')
})

test('a text the card cannot show in full has no Approve in the pane (the desk question shows all of it); Deny stays', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const long = await addActionRequest(w.host, 't5', { ...REPLY, params: { ...REPLY.params, body: `${BODY} ${'more words '.repeat(60)}` } })
  expect(long.ok, long.text).toBe(true)
  const v = long.request!
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: "Button", key: "card-t5" }))?.text).toMatch(/^▾ t5/) // a decision to take is unfolded on its thread card (1.0.32: no Needs-you section)
  expect(!!(await ui.find({ type: 'Button', key: `action-approve-${v.id}` }))).toBe(false)
  expect(!!(await ui.find({ type: 'Button', key: `action-deny-${v.id}` }))).toBe(true)
  // 1.0.30: the card says where it IS approved, and the full text is one tap away
  expect(await has(ui, /Approve in the desk question: this card cannot approve it \(\d+ characters/)).toBe(true)
  expect(await has(ui, /the pane shows only the start/)).toBe(false)
  const fullLen = (await texts(ui)).filter(t => t.includes('more words')).reduce((m, t) => Math.max(m, t.length), 0)
  await ui.press({ key: `action-full-${v.id}` })
  const fullLen2 = (await texts(ui)).filter(t => t.includes('more words')).reduce((m, t) => Math.max(m, t.length), 0)
  expect(fullLen2).toBeGreaterThan(fullLen) // the whole text is drawn after the tap
  expect(await ui.find({ type: 'Button', key: `action-full-${v.id}`, text: 'hide full text' })).toBeTruthy()
  await ui.unmount()
})

test('a review batch is numbered one-liners grouped by file (anchor + the first 120 characters); the buttons are on top; the full text is one tap away', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const PR = { org: 'acme', project: 'Shop', repo: 'shop-api', pr: 42 }
  const items = Array.from({ length: 12 }, (_, i) => ({ kind: 'ado-pr-comment', params: { ...PR, body: i === 3 ? `Point 4: ${'y'.repeat(200)} the-end` : `Point ${i + 1} is wrong.` } }))
  const r = await addActionRequest(w.host, 't5', { kind: 'batch', items, why: 'a review' } as any)
  expect(r.ok, r.text).toBe(true)
  const v = r.request!
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: "Button", key: "card-t5" }))?.text).toMatch(/^▾ t5/) // a decision to take is unfolded on its thread card (1.0.32: no Needs-you section)
  expect(await has(ui, /General comments \(no file\) \(12\)/)).toBe(true)
  expect(await has(ui, /^ {2}1\. PR comment: Point 1 is wrong\.$/)).toBe(true)
  const four = (await texts(ui)).find(t => /^ {2}4\. /.test(t))!
  expect(four.length).toBeLessThanOrEqual('  4. PR comment: '.length + 120)
  expect(four).not.toContain('the-end') // cut at 120 characters
  // too long for the card: no Approve, the hint, Deny and Open stay; the buttons come before the text
  expect(!!(await ui.find({ type: 'Button', key: `action-approve-${v.id}` }))).toBe(false)
  expect(await has(ui, /Approve in the desk question/)).toBe(true)
  for (const k of [`action-deny-${v.id}`, 'pane-t5', `action-full-${v.id}`]) expect([k, !!(await ui.find({ type: 'Button', key: k }))]).toEqual([k, true])
  const keys = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key))
  expect(keys.indexOf(`action-deny-${v.id}`)).toBeLessThan(keys.indexOf(`action-full-${v.id}`))
  await ui.press({ key: `action-full-${v.id}` })
  expect(await has(ui, /the-end/)).toBe(true) // the full text, after the tap
  await ui.unmount()
})
