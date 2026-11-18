import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'

// A session the app pre-started in a spare folder, then moved into the user's folder.
async function start($: any, on: any, first: string) {
  const h = fakeHost(on)
  resetLocks()
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  const reg: string[] = []
  const timers: number[] = []
  let dir = first
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('clock.every', (_: any, e: any) => { timers.push(e.ms); return { value: { cancel() {} } } })
  on('session.cwd', () => ({ value: dir }))
  on('session.root', () => ({ value: dir }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('prompt.submit', (_: any, e: any) => e)
  await $.session.start({ cwd: first, surface: 'desktop', isInteractive: true } as any)
  const move = async (to: string) => {
    const old = dir
    dir = to
    await $.classic.CwdChanged({ old_cwd: old, new_cwd: to } as any)
  }
  return { h, reg, timers, move, set: (to: string) => { dir = to } }
}

const SPARE = '/h/.claude/spares/spare-abc'
const deskTools = (reg: string[]) => reg.filter(n => n === 'lean_doctor' || n === 'lean_thread').sort()

test('a session started in a spare folder gets the desk tools once it moves to the desk folder', async ($, on) => {
  const s = await start($, on, SPARE)
  expect(deskTools(s.reg)).toEqual([])
  expect(s.timers).toEqual([])
  await s.move('/h/lean-agent-desk')
  expect(deskTools(s.reg)).toEqual(['lean_doctor', 'lean_thread'])
  expect(s.timers.filter(m => m === 10_000 || m === 60_000 || m === 30_000).sort()).toEqual([10_000, 30_000, 60_000])
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).toContain('t1')
})

test('moving to the desk folder twice registers and starts everything once', async ($, on) => {
  const s = await start($, on, SPARE)
  await s.move('/h/lean-agent-desk')
  const tools = s.reg.length
  const timers = s.timers.length
  await s.move('/h/lean-agent-desk/sub')
  await s.move('/h/lean-agent-desk')
  expect(s.reg.length).toBe(tools)
  expect(s.timers.length).toBe(timers)
})

test('the lazy check at prompt.submit finds the new folder when the hook never came', async ($, on) => {
  const s = await start($, on, SPARE)
  s.set('/h/lean-agent-desk')
  await $.prompt.submit({ text: 'hi' } as any)
  expect(deskTools(s.reg)).toEqual(['lean_doctor', 'lean_thread'])
})

test('a session moved from a spare folder into a thread folder gets the thread tools', async ($, on) => {
  const s = await start($, on, SPARE)
  expect(s.reg).toEqual([])
  await s.move('/h/.lean-agent/threads/t1')
  expect(s.reg.length).toBeGreaterThan(0)
  expect(deskTools(s.reg)).toEqual([])
  const n = s.reg.length
  await s.move('/h/.lean-agent/threads/t1')
  expect(s.reg.length).toBe(n)
})

test('leaving the desk stops its timers and the desk tool refuses', async ($, on) => {
  const s = await start($, on, '/h/lean-agent-desk')
  expect(deskTools(s.reg)).toEqual(['lean_doctor', 'lean_thread'])
  await s.move(SPARE)
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).toContain('only the desk')
})

test('a failing migration does not stop the desk tools from registering', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.claude.handler = () => { throw new Error('boom') }
  const reg: string[] = []
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  expect(deskTools(reg)).toEqual(['lean_doctor', 'lean_thread'])
})
