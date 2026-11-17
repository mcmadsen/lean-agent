import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'lean-agent-map',
  component: 'Pane',
  requestId: 'lean-agent-live-map',
  props: {
    title: 'Live map',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SNAP = {
  v: 1,
  ts: '2026-11-16T12:31:05',
  service: { up: true, pid: 1, version: '0.45.73', socket_ms: 0.6, cpu_pct: 3.1, threads: 28, up_s: 7200 },
  paused: false,
  inbox: 2,
  nodes: [
    { id: 'service', kind: 'service', label: 'Service socket', state: 'active' },
    { id: 't192', kind: 'thread', label: 'E2E checks', state: 'active' },
  ],
  edges: [],
  moving: [
    { dir: 'to', node: 't192', text: 'message delivered', age_s: 0.4 },
    { dir: 'from', node: 't196', text: 'report to you', age_s: 10 },
  ],
}
const DOWN = { v: 1, service: { up: false }, nodes: [], edges: [], moving: [], inbox: 2 }
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="220"></svg>'

// A fake engine: answers `lean-agent` calls, records every argv.
function fake(on: any, opts: { snap?: unknown; role?: string; limit?: number; closeAfter?: number; noBin?: boolean; jsonFail?: string }) {
  const calls: string[][] = []
  const statuses: string[] = []
  const state = { snap: opts.snap ?? SNAP, panes: [] as { id: string }[], timers: [] as { ms: number }[], store: new Map<string, unknown>() }
  on('env.get', (_: any, e: any) => ({ value: e.name === 'PATH' ? '/usr/bin:/bin' : e.name === 'LEAN_AGENT_SESSION_ROLE' ? opts.role : undefined }))
  on('ui.status', (_: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'live-map' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: any, e: any) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === '/bin/sh' || e.argv[0].endsWith('sh') && e.argv[1] === '-lc') {
      return { value: { exitCode: opts.noBin ? 1 : 0, stdout: opts.noBin ? '' : 'lean-agent\n', stderr: '' } }
    }
    calls.push([...e.argv])
    if (a === 'lean-agent map --json' && opts.jsonFail) return { value: { exitCode: 3, stdout: '', stderr: opts.jsonFail + '\nmore' } }
    if (a === 'lean-agent map --json') return { value: { exitCode: 0, stdout: JSON.stringify(state.snap), stderr: '' } }
    if (a.startsWith('lean-agent map --svg')) return { value: { exitCode: 0, stdout: SVG, stderr: '' } }
    return { value: { exitCode: 0, stdout: 'waiting: t1', stderr: '' } }
  })
  on('ui.open', (_: any, e: any) => {
    if (!state.panes.some(p => p.id === e.id)) state.panes.push({ id: e.id })
    return { value: { isPlaced: true } }
  })
  let seen = 0
  on('ui.panes', () => ({ value: (++seen > (opts.closeAfter ?? 1e9) ? [] : state.panes).map(p => ({ ...p, title: '', isShown: true, isFocused: false, isPlaced: true })) }))
  // A hook that answers resolves the timer at once; refusing it ends the loop.
  on('clock.after', (_: any, e: any) => {
    state.timers.push({ ms: e.ms })
    return state.timers.length > (opts.limit ?? 3) ? { deny: 'enough' } : { value: undefined }
  })
  return { calls, state, statuses }
}

test('the pane opens in a front desk, not elsewhere', async ($, on) => {
  const desk = fake(on, { role: 'main' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(desk.state.panes.map(p => p.id)).toEqual(['lean-agent-live-map'])
  expect(desk.calls.every(c => c[0] === 'lean-agent' && c[1] === 'map')).toBe(true)
})

test('a thread session or a down service gets nothing', async ($, on) => {
  const f = fake(on, { role: 'thread' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(f.state.panes).toEqual([])
})

test('rows, pill and buttons render from a snapshot', async ($, on) => {
  const f = fake(on, { role: 'main' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Socket listening · 0.6 ms · CPU 3.1%/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Live$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Inbox 2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /message delivered/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg' })).toBeTruthy()
  await ui.press({ key: 'inbox' })
  const allowed = f.calls.every(c => c[0] === 'lean-agent' && ['map', 'waiting'].includes(c[1]))
  expect(allowed).toBe(true)
  expect(f.calls.some(c => c.join(' ') === 'lean-agent waiting')).toBe(true)
  await ui.press({ key: 'pause' })
  expect(await ui.find({ type: 'Text', text: /^Paused$/ })).toBeTruthy()
  await ui.unmount()
})

test('a plain summary off the desktop', async ($, on) => {
  fake(on, { role: 'main' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Inbox 2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.unmount()
})

test('service down shows the pill', async ($, on) => {
  fake(on, { role: 'main', snap: DOWN })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /service not running/ })).toBeTruthy()
  await ui.unmount()
})

// Let the timers the fake resolves run their callbacks.
const settle = async () => { for (let i = 0; i < 5000; i++) await Promise.resolve() }
const jsons = (c: string[][]) => c.filter(a => a.join(' ') === 'lean-agent map --json').length

test('it polls every 2 s while up, and backs off to 10 s when down', async ($, on) => {
  const up = fake(on, { role: 'main' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  expect(up.state.timers.map(t => t.ms)).toEqual([0, 2000, 2000, 2000])
  expect(jsons(up.calls)).toBeGreaterThan(2)
})

test('it backs off when the service is down', async ($, on) => {
  const down = fake(on, { role: 'main', snap: DOWN })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  expect(down.state.timers.map(t => t.ms)).toEqual([0, 10000, 10000, 10000])
  expect(down.calls.some(c => c.includes('--svg'))).toBe(false)
})

test('polling stops when the pane is closed', async ($, on) => {
  const f = fake(on, { role: 'main', closeAfter: 0, limit: 20 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  expect(f.state.timers.map(t => t.ms)).toEqual([0])
  expect(jsons(f.calls)).toBe(1) // only the session check
})

test('Pause stops polling', async ($, on) => {
  const f = fake(on, { role: 'main', limit: 2 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause' })
  await ui.unmount()
  const before = jsons(f.calls)
  // /live-map reopens the pane and restarts the loop: paused, it must not poll
  f.state.panes.length = 0
  f.state.timers.length = 0
  await $.command.run({ command: 'live-map', args: '' } as any)
  await settle()
  expect(f.state.timers.length).toBeGreaterThan(0)
  expect(jsons(f.calls)).toBe(before)
})

test('lean-agent missing renders the diagnosis, not a blank pane', async ($, on) => {
  const f = fake(on, { role: 'main', noBin: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent-live-map'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /lean-agent not found on PATH \(\/usr\/bin:\/bin\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /last ok never/ })).toBeTruthy()
  await ui.unmount()
})

test('a json failure shows the exit code and the first stderr line', async ($, on) => {
  fake(on, { role: 'main', jsonFail: 'boom: no socket' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /map --json failed \(exit 3\): boom: no socket/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /more/ })).toBeFalsy()
  await ui.unmount()
})

test('/live-map opens the pane in a session that is not the desk', async ($, on) => {
  const f = fake(on, { role: 'thread' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(f.state.panes).toEqual([])
  await $.command.run({ command: 'live-map', args: '' } as any)
  expect(f.state.panes.map(p => p.id)).toEqual(['lean-agent-live-map'])
})

test('the pane opens for the desk even when the first poll fails', async ($, on) => {
  const f = fake(on, { role: 'main', jsonFail: 'x' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(f.state.panes.length).toBe(1)
})

test('a surface without Svg gets the compact text version', async ($, on) => {
  const snap = {
    ...SNAP,
    nodes: [
      ...SNAP.nodes,
      { id: 't2', kind: 'thread', label: 'Docs', state: 'undelivered', activity: { now: 'Edit' } },
      { id: 'run:r1', kind: 'worker', parent: 't192', label: 'run 1', state: 'alive' },
    ],
    plan: { windows: [{ name: 'five_hour', label: '5h', pct: 42, resets_at: null }] },
  }
  fake(on, { role: 'main', snap })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /● E2E checks · 1 session$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✕ Docs · Edit · 0 sessions/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Plan 5h 42%/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /surface terminal/ })).toBeTruthy()
  await ui.unmount()
})

test('the status line carries the state', async ($, on) => {
  const up = fake(on, { role: 'main' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(up.statuses).toContain('lean-agent map: ok')
})

test('the status line says when lean-agent is missing', async ($, on) => {
  const miss = fake(on, { role: 'main', noBin: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(miss.statuses.some(t => t.startsWith('lean-agent map: lean-agent not found'))).toBe(true)
})
