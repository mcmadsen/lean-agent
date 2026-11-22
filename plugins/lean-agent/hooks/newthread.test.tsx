// The new-thread form: it draws, says what is wrong inline before anything is created, and Start runs the lean_thread `new` code with
// the chosen fields (no model involved), then opens the new thread's detail pane.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { resetViewCache } from './view'
import { resetThreadCache } from './threaddetail'
import { resetThreadPanes } from './threadpane'
import { APPROVAL_NOTE, BRIEF_ROWS, DEFAULT, EFFORT_CHOICES, MODEL_CHOICES, NEW_THREAD_PANE, NO_PROJECT, openNewThread, resetNewThread, validate } from './newthread'
import { listRequests } from './expensive'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const PANE = { plugin: 'lean-agent', component: 'Pane', requestId: NEW_THREAD_PANE, surface: 'terminal', props: { title: 'New thread', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const text = async (ui: any, re: RegExp) => !!(await ui.find({ type: 'Text', text: re }))
const THREADS = '/h/.lean-agent/threads'

function world(on: any, projects: Record<string, unknown> = { app: { path: '/r/app' }, lib: { path: '/r/lib' } }) {
  resetLocks()
  resetViewCache()
  resetThreadCache()
  resetThreadPanes()
  resetNewThread()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify(projects))
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : a[0] === 'agents' ? { exitCode: 0, stdout: '[]' } : { exitCode: 0, stdout: '' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  // the engine's answer to $.ui.open: placed; what was opened is kept for the specs
  const opened: { id: string; title?: string }[] = []
  on('ui.open', (_: any, e: any) => { opened.push({ id: e.id, title: e.title }); return { value: { isPlaced: true } } })
  // the mod's own store beneath the pane (the model requests live in it): a map the specs can read
  const kv = new Map<string, unknown>()
  on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) }))
  on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  return Object.assign(h, { opened, kv })
}
const requestsIn = (kv: Map<string, unknown>) => listRequests({ store: { get: async (k: string) => kv.get(k), set: async () => undefined } } as any)
const threadsMade = (h: any) => [...h.files.keys()].filter((k: string) => /\/threads\/t\d+\/thread\.json$/.test(k))
const fill = async (ui: any, title: string, brief: string) => {
  await ui.input({ key: 'title', text: title, kind: 'change' })
  await ui.input({ key: 'brief', text: brief, kind: 'change' })
}

test('validate: empty or blank title and brief, a title or brief too long, an unknown model or effort', () => {
  expect(validate({ title: '', brief: '', model: 'sonnet', effort: 'high' })).toEqual(['Title is empty: give the thread a short title.', 'Brief is empty: say what the thread should do.'])
  expect(validate({ title: '   ', brief: ' \n ', model: 'sonnet', effort: 'high' })).toHaveLength(2)
  expect(validate({ title: 'x'.repeat(81), brief: 'y', model: 'sonnet', effort: 'high' })[0]).toContain('too long')
  expect(validate({ title: 'x', brief: 'y'.repeat(20_001), model: 'sonnet', effort: 'high' })[0]).toContain('too long')
  expect(validate({ title: 'x', brief: 'y', model: 'gpt', effort: 'max' })).toEqual(['Unknown model gpt.', 'Unknown effort max.'])
  expect(validate({ title: 'x', brief: 'y', model: 'opus', effort: 'low' })).toEqual(['Reason is empty: opus needs your approval, say why sonnet is not enough.']) // opus needs a reason (the Approve press follows in the pane)
  expect(validate({ title: 'x', brief: 'y', model: 'opus', effort: 'low', reason: 'a hard migration' })).toEqual([])
  expect(validate({ title: 'x', brief: 'y', model: 'haiku', effort: 'low' })).toEqual([])
})

test('the form draws: title, project (none + registered), model (sonnet default), effort (high default), a multi-line brief, Start', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  const title = await ui.find({ key: 'title' })
  expect(title?.type).toBe('Input')
  const brief = await ui.find({ key: 'brief' })
  expect(brief?.type).toBe('Input')
  expect(brief?.props.rows).toBe(BRIEF_ROWS) // the engine's Input is multi-line from rows: 2
  const optionsOf = async (key: string): Promise<{ value: string; label: string }[]> => ((await ui.find({ key }))?.props as any)?.options ?? []
  const opts = async (key: string) => (await optionsOf(key)).map(o => o.value)
  expect(await opts('project')).toEqual([NO_PROJECT, 'app', 'lib'])
  expect(await opts('model')).toEqual([DEFAULT, ...MODEL_CHOICES]) // "default" leaves the field out: the tool's default (or config.json) applies
  expect(await opts('effort')).toEqual([DEFAULT, ...EFFORT_CHOICES])
  expect((await ui.find({ key: 'project' }))?.props.value).toBe(NO_PROJECT)
  expect((await ui.find({ key: 'model' }))?.props.value).toBe(DEFAULT)
  expect((await ui.find({ key: 'effort' }))?.props.value).toBe(DEFAULT)
  expect((await optionsOf('model'))[0]!.label).toContain('sonnet')
  expect((await optionsOf('effort'))[0]!.label).toContain('high')
  expect(await ui.find({ type: 'Button', text: 'Start' })).toBeTruthy()
  await ui.unmount()
})

test('the form with no registered project offers only "none"', { timeoutMs: 20_000 }, async ($, on) => {
  world(on, {})
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect((((await ui.find({ key: 'project' }))?.props as any)?.options ?? []).map((o: any) => o.value)).toEqual([NO_PROJECT])
  expect((await ui.find({ key: 'project' }))?.props.label).toContain('none registered')
  await ui.unmount()
})

test('Start with an empty title and brief says both inline and creates nothing', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'start' })
  expect(await text(ui, /Title is empty/)).toBe(true)
  expect(await text(ui, /Brief is empty/)).toBe(true)
  expect(threadsMade(h)).toEqual([])
  expect(h.claudeCalls().some(a => a[0] === '--bg')).toBe(false)
  await ui.input({ key: 'title', text: 'a title', kind: 'change' })
  await ui.press({ key: 'start' })
  expect(await text(ui, /Title is empty/)).toBe(false) // the message follows the fields
  expect(await text(ui, /Brief is empty/)).toBe(true)
  expect(threadsMade(h)).toEqual([])
  await ui.unmount()
})

test('a project that was unregistered after the form drew is refused inline, before any folder exists', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await fill(ui, 'fix it', 'do the thing')
  await ui.select({ key: 'project', value: 'lib' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } })) // lib is gone
  await ui.press({ key: 'start' })
  expect(await text(ui, /unknown project lib: known projects: app/)).toBe(true)
  expect(threadsMade(h)).toEqual([])
  await ui.unmount()
})

test('Start: the lean_thread `new` path with the chosen project, model, effort and brief; then the thread\'s own pane opens and the form is empty again', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await fill(ui, '  add a widget  ', 'Add the widget.\nKeep it small.')
  await ui.select({ key: 'project', value: 'app' })
  await ui.select({ key: 'model', value: 'haiku' })
  await ui.select({ key: 'effort', value: 'medium' })
  await ui.press({ key: 'start' })
  expect(threadsMade(h)).toEqual([`${THREADS}/t1/thread.json`])
  const t = JSON.parse(h.files.get(`${THREADS}/t1/thread.json`)!)
  expect([t.title, t.project, t.model, t.effort, t.sid]).toEqual(['add a widget', 'app', 'haiku', 'medium', SID])
  expect(h.files.get(`${THREADS}/t1/brief.md`)).toBe('Add the widget.\nKeep it small.\n')
  const bg = h.claudeCalls().find(a => a[0] === '--bg')!
  expect(bg).toEqual(['--bg', '-n', 't1 · add a widget', '--model', 'haiku', '--effort', 'medium', '--', 'Add the widget.\nKeep it small.'])
  expect(h.opened.filter(p => p.id !== 'lean-agent')).toEqual([{ id: 'lean-agent-thread-t1', title: 't1 · add a widget' }]) // the new thread's own pane (the desk opened its own at the start)
  expect(await text(ui, /t1 started/)).toBe(true)
  expect((await ui.find({ key: 'title' }))?.props.value).toBe('')
  expect((await ui.find({ key: 'model' }))?.props.value).toBe(DEFAULT)
  await ui.unmount()
})

test('Start on "default" leaves model and effort out: config.json threads.model / threads.effort apply, as for the tool', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { model: 'haiku', effort: 'medium' } }))
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await fill(ui, 'cheap one', 'do it')
  await ui.press({ key: 'start' })
  const t = JSON.parse(h.files.get(`${THREADS}/t1/thread.json`)!)
  expect([t.model, t.effort]).toEqual(['haiku', 'medium'])
  expect(h.claudeCalls().find(a => a[0] === '--bg')!.slice(3, 7)).toEqual(['--model', 'haiku', '--effort', 'medium'])
  await fill(ui, 'pinned one', 'do it')
  await ui.select({ key: 'model', value: 'sonnet' }) // a choice made in the form beats the config
  await ui.press({ key: 'start' })
  const u = JSON.parse(h.files.get(`${THREADS}/t2/thread.json`)!)
  expect([u.model, u.effort]).toEqual(['sonnet', 'medium'])
  await ui.unmount()
})

test('two presses of Start at once make one thread; a project that is no longer listed becomes "none"', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await fill(ui, 'quick one', 'do it')
  await Promise.all([ui.press({ key: 'start' }), ui.press({ key: 'start' })])
  expect(threadsMade(h)).toHaveLength(1) // one thread, not two
  await ui.select({ key: 'project', value: 'lib' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  await ui.press({ key: 'start' }) // empty fields: the form redraws and the stale choice is dropped
  expect((await ui.find({ key: 'project' }))?.props.value).toBe(NO_PROJECT)
  await ui.unmount()
})

test('Start with the defaults and no project: sonnet / high, no project; a failing start is said inline and nothing is opened', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  await fill(ui, 'plain', 'just do it')
  await ui.press({ key: 'start' })
  const t = JSON.parse(h.files.get(`${THREADS}/t1/thread.json`)!)
  expect([t.project, t.model, t.effort]).toEqual(['', 'sonnet', 'high'])
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 1, stdout: '', stderr: 'no capacity' } : { exitCode: 0, stdout: '[]' })
  await fill(ui, 'second', 'again')
  await ui.press({ key: 'start' })
  expect(await text(ui, /claude --bg failed: no capacity/)).toBe(true)
  expect(h.opened.some(p => p.id === 'lean-agent-thread-t2')).toBe(false)
  expect((await ui.find({ key: 'title' }))?.props.value).toBe('second') // what was typed stays for another try
  await ui.unmount()
})

test('picking opus shows that it needs the Approve press and asks for a reason; Start files a request, creates the thread and starts NO session', { timeoutMs: 20_000 }, async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ key: 'reason' })).toBeFalsy() // sonnet (the default): nothing about approval
  expect(await text(ui, /needs your approval/)).toBe(false)
  const model = (await ui.find({ key: 'model' }))?.props as any
  expect(model.options.find((o: any) => o.value === 'opus').label).toContain('needs your Approve press')
  expect(model.options.find((o: any) => o.value === 'sonnet').label).toBe('sonnet')
  await fill(ui, 'migrate the store', 'Move the store to the new layout.')
  await ui.select({ key: 'model', value: 'opus' })
  expect(await text(ui, new RegExp(APPROVAL_NOTE.slice(0, 40)))).toBe(true) // the note says nothing runs on opus before the press
  expect(await ui.find({ key: 'reason' })).toBeTruthy()
  await ui.press({ key: 'start' })
  expect(await text(ui, /Reason is empty/)).toBe(true) // said inline, before anything is created
  expect(threadsMade(h)).toEqual([])
  await ui.input({ key: 'reason', text: 'a cross-module change that sonnet got wrong twice', kind: 'change' })
  await ui.press({ key: 'start' })
  expect(threadsMade(h)).toEqual([`${THREADS}/t1/thread.json`]) // the folder exists ...
  expect(h.claudeCalls().some(a => a[0] === '--bg')).toBe(false) // ... but no session was started
  expect(JSON.parse(h.files.get(`${THREADS}/t1/thread.json`)!).sid).toBe('')
  const reqs = await requestsIn(h.kv)
  expect(reqs).toHaveLength(1)
  expect(reqs[0]).toMatchObject({ thread: 't1', model: 'opus', family: 'opus', action: 'new', origin: 'tool', state: 'pending', asked: true, reason: 'a cross-module change that sonnet got wrong twice' })
  expect(await text(ui, /t1 NOT started on opus/)).toBe(true)
  await ui.unmount()
})

test('openNewThread opens lean-agent-new-thread (the thin host answers ui.open as the engine $ does); outside the desk the form says it belongs there', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  const seen: any[] = []
  const thin = { ...w.host, ui: { open: async (p: any) => { seen.push(p); return { isPlaced: true } } } } // what hostOf($) is
  expect(await openNewThread(thin, 'desktop')).toMatchObject({ ok: true, pane: 'lean-agent-new-thread' })
  expect(seen).toEqual([{ id: NEW_THREAD_PANE, title: 'New thread' }])
  expect(await openNewThread({ ...w.host, ui: { open: async () => { throw new Error('refused') } } }, undefined)).toMatchObject({ ok: false, text: expect.stringContaining('refused') })
  await $.session.start({ cwd: '/h/.claude/spares/spare-x', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount(PANE as any)
  expect(await text(ui, /started from the desk/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Start' })).toBeFalsy()
  expect(threadsMade(w)).toEqual([])
  await ui.unmount()
})
