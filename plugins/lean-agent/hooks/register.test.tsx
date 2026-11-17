import { expect, test } from 'claude-code/testing'
import { resetState } from './register'

const PANE = {
  plugin: 'lean-agent',
  component: 'Pane',
  requestId: 'lean-agent',
  props: {
    title: 'lean-agent',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DESK = { mode: 'auto', attached: false, active: 'hosted', label: 'desk: hosted (Remote Control)', pending: 0 }
const SNAP = {
  v: 1,
  ts: '2026-11-16T12:31:05',
  service: { up: true, version: '0.45.91' },
  desk: DESK,
  inbox: 2,
  goals: [
    { id: 'g1', ref: 'PR#12', thread: 't3', state: 'working', raw_state: 'active', quiet: '2m', next: 'review the diff' },
    { id: 'g2', ref: 'PR#13', thread: 't4', state: 'waiting', raw_state: 'waiting-user', quiet: '1h', next: 'answer: push' },
    { id: 'g3', ref: 'PR#14', thread: 't5', state: 'stuck', raw_state: 'stuck', quiet: '3h', next: 'chase' },
  ],
  answers: [
    { id: 'q7', q: 'how is the build?', a: 'green after the fix', thread: 't3', age: '4m', unread: true },
    { id: 'q5', q: 'which port?', a: '8080', thread: 'main', age: '2h', unread: false },
  ],
}
const DOWN = { v: 1, service: { up: false }, desk: DESK, goals: [], answers: [], inbox: 2 }

// A fake engine: answers `lean-agent` calls, records every argv.
function fake(on: any, opts: { snap?: unknown; role?: string; deskFolder?: boolean; ackFails?: boolean; ackThrows?: boolean; limit?: number; closeAfter?: number; noBin?: boolean; jsonFail?: string }) {
  resetState()
  const calls: string[][] = []
  const statuses: string[] = []
  const state = { snap: opts.snap ?? SNAP, panes: [] as { id: string }[], timers: [] as { ms: number }[], store: new Map<string, unknown>(), commands: [] as string[] }
  on('env.get', (_: any, e: any) => ({ value: e.name === 'PATH' ? '/usr/bin:/bin' : e.name === 'LEAN_AGENT_SESSION_ROLE' ? opts.role : e.name === 'LEAN_AGENT_DESK_FOLDER' && opts.deskFolder ? '1' : undefined }))
  on('ui.status', (_: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  on('command.register', (_: any, e: any) => { state.commands.push(e.name); return { value: { command: e.name } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: any, e: any) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === '/bin/sh' || e.argv[0].endsWith('sh') && e.argv[1] === '-lc') {
      return { value: { exitCode: opts.noBin ? 1 : 0, stdout: opts.noBin ? '' : 'lean-agent\n', stderr: '' } }
    }
    calls.push([...e.argv])
    if (a === 'lean-agent pane --json' && opts.jsonFail) return { value: { exitCode: 3, stdout: '', stderr: opts.jsonFail + '\nmore' } }
    if (a === 'lean-agent pane --json') return { value: { exitCode: 0, stdout: JSON.stringify(state.snap), stderr: '' } }
    if (opts.ackThrows && e.argv[1] === 'myq') throw new Error('spawn failed')
    if (opts.ackFails && e.argv[1] === 'myq') return { value: { exitCode: 2, stdout: '', stderr: 'spawn failed' } }
    return { value: { exitCode: 0, stdout: 'waiting: t1', stderr: '' } }
  })
  on('ui.open', (_: any, e: any) => {
    if (!state.panes.some(p => p.id === e.id)) state.panes.push({ id: e.id })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: any, e: any) => { state.panes = state.panes.filter(p => p.id !== e.id); return { value: undefined } })
  let seen = 0
  on('ui.panes', () => ({ value: (++seen > (opts.closeAfter ?? 1e9) ? [] : state.panes).map(p => ({ ...p, title: '', isShown: true, isFocused: false, isPlaced: true })) }))
  // A hook that answers resolves the timer at once; refusing it ends the loop.
  on('clock.after', (_: any, e: any) => {
    state.timers.push({ ms: e.ms })
    return state.timers.length > (opts.limit ?? 3) ? { deny: 'enough' } : { value: undefined }
  })
  return { calls, state, statuses }
}

const settle = async () => { for (let i = 0; i < 5000; i++) await Promise.resolve() }
const panes = (c: string[][]) => c.filter(a => a.join(' ') === 'lean-agent pane --json').length
const start = ($: any, surface = 'desktop') => $.session.start({ cwd: '/', surface, isInteractive: true })

test('the pane opens in a front desk, not elsewhere', async ($, on) => {
  const desk = fake(on, { role: 'main' })
  await start($)
  expect(desk.state.panes.map(p => p.id)).toEqual(['lean-agent'])
  expect(desk.calls.every(c => c[0] === 'lean-agent' && c[1] === 'pane')).toBe(true)
})

test('a thread session gets no pane', async ($, on) => {
  const t = fake(on, { role: 'thread' })
  await start($)
  expect(t.state.panes).toEqual([])
})

test('goals and answers render from a fixture, unread marked', async ($, on) => {
  fake(on, { role: 'main' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /service up · desk: hosted \(Remote Control\) · inbox 2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Goals \(3\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /g1 PR#12/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /review the diff/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /t4 · waiting · 1h/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Answers \(2, 1 unread\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /● NEW/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /q7 how is the build\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /→ green after the fix/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'ack-q7' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'ack-q5' })).toBeFalsy() // read: no button
  expect(await ui.find({ type: 'Text', text: /ok · last ok / })).toBeTruthy()
  await ui.unmount()
})

test('ack runs only myq ack qN, ack all runs myq ack --all', async ($, on) => {
  const f = fake(on, { role: 'main' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ack-q7' })
  expect(f.calls.some(c => c.join(' ') === 'lean-agent myq ack q7')).toBe(true)
  await ui.press({ key: 'ack-all' })
  expect(f.calls.some(c => c.join(' ') === 'lean-agent myq ack --all')).toBe(true)
  const others = f.calls.filter(c => c[1] !== 'pane' && c[1] !== 'myq')
  expect(others).toEqual([])
  expect(f.calls.filter(c => c[1] === 'myq').every(c => c[2] === 'ack' && (/^q\d+$/.test(c[3]) || c[3] === '--all'))).toBe(true)
  await ui.unmount()
})

test('a compact layout off the desktop, service down shows the state', async ($, on) => {
  fake(on, { role: 'main', snap: DOWN })
  await start($, 'terminal')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /service down/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No open goals/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /service not running/ })).toBeTruthy()
  await ui.unmount()
})

test('it polls every 5 s while up, and backs off to 30 s when down', async ($, on) => {
  const up = fake(on, { role: 'main' })
  await start($)
  await settle()
  expect(up.state.timers.map(t => t.ms)).toEqual([0, 5000, 5000, 5000])
})

test('it backs off to 30 s when the service is down', async ($, on) => {
  const down = fake(on, { role: 'main', snap: DOWN })
  await start($)
  await settle()
  expect(down.state.timers.map(t => t.ms)).toEqual([0, 30000, 30000, 30000])
})

test('polling stops when the pane is closed', async ($, on) => {
  const f = fake(on, { role: 'main', closeAfter: 0, limit: 20 })
  await start($)
  await settle()
  expect(f.state.timers.map(t => t.ms)).toEqual([0])
  expect(panes(f.calls)).toBe(1) // only the session check
})

test('lean-agent missing renders the diagnosis, not a blank pane', async ($, on) => {
  const f = fake(on, { role: 'main', noBin: true })
  await start($)
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /lean-agent not found on PATH \(\/usr\/bin:\/bin\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /last ok never/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Goals \(0\)/ })).toBeTruthy()
  await ui.unmount()
})

test('a json failure shows the exit code and the first stderr line', async ($, on) => {
  const f = fake(on, { role: 'main', jsonFail: 'boom: no socket' })
  await start($)
  expect(f.state.panes.length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /pane --json failed \(exit 3\): boom: no socket/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /more/ })).toBeFalsy()
  await ui.unmount()
})

test('/lean-agent opens the pane in a non-desk session; /live-map is the same pane, renamed', async ($, on) => {
  const f = fake(on, { role: 'thread' })
  await start($)
  expect(f.state.commands).toEqual(['lean-agent', 'live-map'])
  expect(f.state.panes).toEqual([])
  const r = await $.command.run({ command: 'live-map', args: '' } as any)
  expect(JSON.stringify(r)).toContain('renamed to /lean-agent')
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent'])
  await $.command.run({ command: 'lean-agent', args: '' } as any) // toggles: closes it again
  expect(f.state.panes).toEqual([])
})

test('the status line carries the state', async ($, on) => {
  const up = fake(on, { role: 'main' })
  await start($)
  expect(up.statuses).toContain('lean-agent: ok · desk: hosted (Remote Control)')
})

test('the status line says when lean-agent is missing', async ($, on) => {
  const miss = fake(on, { role: 'main', noBin: true })
  await start($)
  expect(miss.statuses.some(t => t.startsWith('lean-agent: lean-agent not found'))).toBe(true)
})

test('a session without a role gets no pane, even while the service is up; /lean-agent opens it', async ($, on) => {
  const f = fake(on, { role: undefined })
  await start($)
  expect(f.state.panes).toEqual([])
  await $.command.run({ command: 'lean-agent', args: '' } as any)
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent'])
})

test('the app desk (a session in the desk folder) gets the pane by itself', async ($, on) => {
  const f = fake(on, { role: undefined, deskFolder: true })
  await start($)
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent'])
})

test('a goals/answers error from pane --json is shown, not "No open goals."', async ($, on) => {
  fake(on, { role: 'main', snap: { ...SNAP, goals: [], answers: [], error: 'goals.json unreadable' } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /goals unavailable: goals.json unreadable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /answers unavailable: goals.json unreadable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No open goals/ })).toBeFalsy()
  await ui.unmount()
})

test('a failing ack shows the failure and refreshes the pane', async ($, on) => {
  const f = fake(on, { role: 'main', ackFails: true })
  await start($)
  const before = panes(f.calls)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ack-q7' })
  expect(panes(f.calls)).toBeGreaterThan(before)
  expect(await ui.find({ type: 'Text', text: /myq ack q7 failed \(exit 2\): spawn failed/ })).toBeTruthy()
  await ui.unmount()
})

test('an ack whose process rejects shows the failure (the catch branch) and refreshes the pane', async ($, on) => {
  const f = fake(on, { role: 'main', ackThrows: true })
  await start($)
  const before = panes(f.calls)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ack-q7' })
  expect(panes(f.calls)).toBeGreaterThan(before)
  expect(await ui.find({ type: 'Text', text: /myq ack q7 failed: / })).toBeTruthy()
  await ui.unmount()
})
