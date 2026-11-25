// The user's side of the expensive-model rule: a request for opus is a card in the pane's "Needs you" with Approve and Deny (two presses
// each) and "Start on sonnet instead"; only a press there approves. Also the red row of a desk the mod could not switch off an expensive
// model. Everything is synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { openCard } from './panetools'
import { addRequest, listRequests, modelAllowed } from './expensive'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: 'lean-agent', surface: 'desktop', props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((x: any) => String(x.text))
const has = async (ui: any, re: RegExp) => (await texts(ui)).some(t => re.test(t))

// the mod's own store beneath the pane is a map the spec can read: the requests, the signing key and the approvals live in it
function world(on: any) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : a[0] === 'agents' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  const kv = new Map<string, unknown>()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const store = { store: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) }, clock: { now: async () => h.clock.t } } as any
  const thread = (id = 't1', o: Record<string, unknown> = {}) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, title: `synthetic ${id}`, project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...o }))
  const bg = () => h.claudeCalls().filter((a: string[]) => a[0] === '--bg')
  const ask = (o: Record<string, unknown> = {}) => addRequest(store, { thread: 't1', model: 'opus', effort: 'high', reason: 'a cross-module change', action: 'new', origin: 'tool', asked: true, ...o } as any)
  return { h, kv, store, thread, bg, ask }
}
const history = (h: any, id = 't1') => (h.files.get(`${L}/threads/${id}/history.jsonl`) ?? '').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

test('a request for opus is a card with Approve, Deny and Start on sonnet instead; the first Approve press only arms it, the second approves and starts the thread on opus', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.thread()
  const r = await w.ask()
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toMatch(/^▸ t1/) // 1.0.33: every card starts folded, a request too; the chip says it waits
  expect(await ui.find({ type: 'Text', text: '1 to decide' })).toBeTruthy()
  await openCard(ui, 't1')
  expect((await ui.find({ type: 'Button', key: 'card-t1' }))?.text).toMatch(/^▾ t1/)
  expect(await has(ui, /t1 asks to run on opus\/high \(opus is not sonnet or haiku, so it needs your approval\): a cross-module change/)).toBe(true)
  for (const k of [`model-approve-${r.id}`, `model-deny-${r.id}`, `model-sonnet-${r.id}`, 'pane-t1']) expect([k, !!(await ui.find({ type: 'Button', key: k }))]).toEqual([k, true])
  await ui.press({ key: `model-approve-${r.id}` })
  expect(await ui.find({ type: 'Button', key: `model-approve-${r.id}`, text: 'Confirm approve opus for t1' })).toBeTruthy()
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(false) // armed only
  expect(w.bg()).toHaveLength(0)
  await ui.press({ key: `model-approve-${r.id}` })
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(true)
  expect(await modelAllowed(w.store, 't2', 'opus')).toBe(false) // that thread only
  expect(await modelAllowed(w.store, 't1', 'fable')).toBe(false) // that family only
  expect(w.bg()).toHaveLength(1)
  expect(w.bg()[0]!.slice(3, 7)).toEqual(['--model', 'opus', '--effort', 'high']) // the request's model and effort
  expect(await listRequests(w.store)).toEqual([])
  expect(await has(ui, /t1 may use opus \(until it closes, at most 24 h\); t1 started/)).toBe(true)
  expect(await has(ui, /Needs you/)).toBe(false) // the card is gone
  const log = history(w.h)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ kind: 'approve-model', model: 'opus', family: 'opus', reason: 'a cross-module change', by: 'user, in the pane' })
  expect(log[0].exp - log[0].ts).toBeLessThanOrEqual(24 * 3_600_000)
  await ui.unmount()
})

test('Deny keeps the thread off opus: a denied card offers Start on sonnet instead and Dismiss; nothing is approved or started', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.thread()
  const r = await w.ask()
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await openCard(ui, 't1')
  await ui.press({ key: `model-deny-${r.id}` })
  expect(await ui.find({ type: 'Button', key: `model-deny-${r.id}`, text: 'Confirm deny opus' })).toBeTruthy()
  expect((await listRequests(w.store))[0]!.state).toBe('pending') // armed only
  await ui.press({ key: `model-deny-${r.id}` })
  expect((await listRequests(w.store))[0]!.state).toBe('denied')
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(false)
  expect(w.bg()).toHaveLength(0)
  expect(await has(ui, /t1: opus\/high was denied \(a cross-module change\); nothing runs on opus\. Start it on sonnet instead\?/)).toBe(true)
  expect(await ui.find({ type: 'Button', key: `model-approve-${r.id}` })).toBeFalsy() // a denied one is not approved by a stray press
  expect(await ui.find({ type: 'Button', key: `model-deny-${r.id}` })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: `model-dismiss-${r.id}` })).toBeTruthy()
  expect(history(w.h)[0]).toMatchObject({ kind: 'deny-model', model: 'opus' })
  // the same ask again stays denied (no new row, no new toast)
  const again = await w.ask()
  expect([again.id, again.state]).toEqual([r.id, 'denied'])
  // Start on sonnet instead: the thread starts on the default and the request is gone
  await ui.press({ key: `model-sonnet-${r.id}` })
  expect(w.bg()).toHaveLength(1)
  expect(w.bg()[0]!.slice(3, 7)).toEqual(['--model', 'sonnet', '--effort', 'high'])
  expect(await listRequests(w.store)).toEqual([])
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(false)
  await ui.unmount()
})

test('with no answer the card keeps offering Start on sonnet instead; Dismiss drops a denied card', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.thread()
  const r = await w.ask()
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await openCard(ui, 't1')
  expect(await ui.find({ type: 'Button', key: `model-sonnet-${r.id}`, text: 'Start on sonnet instead' })).toBeTruthy()
  await ui.press({ key: `model-deny-${r.id}` })
  await ui.press({ key: `model-deny-${r.id}` })
  await ui.press({ key: `model-dismiss-${r.id}` })
  expect(await listRequests(w.store)).toEqual([])
  expect(w.bg()).toHaveLength(0)
  await ui.unmount()
})

test('a request the guard made (a refused Agent call or claude command): Approve lets that thread retry and tells it so; it never starts anything itself; Deny tells it to go on without', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.thread()
  const r = await w.ask({ action: 'agent', origin: 'guard', reason: 'the worker-opus agent (rewrite the parser)' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await openCard(ui, 't1')
  expect(await has(ui, /t1 was refused opus and reported blocked: the worker-opus agent \(rewrite the parser\)\. Approve it to let t1 go on, or deny it\./)).toBe(true)
  expect(await ui.find({ type: 'Button', key: `model-sonnet-${r.id}` })).toBeFalsy() // nothing to start on sonnet: the thread is working
  await ui.press({ key: `model-approve-${r.id}` })
  await ui.press({ key: `model-approve-${r.id}` })
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(true)
  expect(w.bg()).toHaveLength(0)
  expect(w.h.files.get(`${T1}/inbox.jsonl`)).toContain('The user approved opus for this thread in the pane')
  expect(await has(ui, /t1 may use opus .*t1 was told it may retry/)).toBe(true)
  // a second request, denied (the pane draws again with it)
  await ui.unmount()
  const d = await w.ask({ action: 'bash', origin: 'guard', model: 'fable', reason: 'a shell command that starts claude on fable' })
  const ui2 = await $.ui.mount(PANE as any)
  await openCard(ui2, 't1')
  await ui2.press({ key: `model-deny-${d.id}` })
  await ui2.press({ key: `model-deny-${d.id}` })
  expect(w.h.files.get(`${T1}/inbox.jsonl`)).toContain('The user denied fable for this thread: do not retry it')
  expect(await modelAllowed(w.store, 't1', 'fable')).toBe(false)
  await ui2.unmount()
})

test('the desk\'s own request is for the desk scope; a request of a closed thread is not shown', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.thread('t1', { state: 'closed' })
  w.thread('t2')
  await w.ask({ thread: 't1' })
  const d = await w.ask({ thread: 'desk', action: 'agent', origin: 'guard', reason: 'the worker-opus agent' })
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await has(ui, /the desk was refused opus/)).toBe(true) // the desk has no thread card: its request is in Health
  expect(await has(ui, /t1 (asks to run|was refused)/)).toBe(false) // the closed thread's is not shown
  await ui.press({ key: `model-approve-${d.id}` })
  await ui.press({ key: `model-approve-${d.id}` })
  expect(await modelAllowed(w.store, 'desk', 'opus')).toBe(true)
  expect(await modelAllowed(w.store, 't1', 'opus')).toBe(false)
  expect((w.h.files.get(`${L}/desk/history.jsonl`) ?? '')).toContain('approve-model') // the desk's own approvals are logged in the desk's folder
  await ui.unmount()
})

test('a desk the app started on an expensive model that the mod could not switch is a RED "Needs you" row (not a header line); another mismatch stays a header line', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  w.h.files.set(`${L}/desk/model.json`, JSON.stringify({ running: 'claude-opus-5-5', pin: { model: 'sonnet', effort: 'high' }, at: w.h.clock.t }))
  await inDesk($)
  let ui = await $.ui.mount(PANE as any)
  const line = "the desk runs claude-opus-5-5; pick Sonnet in the app's model menu (lean-agent pins sonnet / high)"
  expect((await texts(ui)).filter(t => t === line)).toHaveLength(1) // once: in the Health row, not also at the top
  const red = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderColor === 'error')
  expect(red.length).toBeGreaterThan(0)
  await ui.unmount()
  // a desk on haiku (cheap, but not the pin): the old yellow header line, no row
  w.h.files.set(`${L}/desk/model.json`, JSON.stringify({ running: 'claude-haiku-5-5', pin: { model: 'sonnet', effort: 'high' }, at: w.h.clock.t }))
  resetViewCache()
  ui = await $.ui.mount(PANE as any)
  expect(await has(ui, /Needs you/)).toBe(false)
  expect((await texts(ui)).filter(t => t === "the desk runs claude-haiku-5-5; pick Sonnet in the app's model menu (lean-agent pins sonnet / high)")).toHaveLength(1)
  await ui.unmount()
})
