import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetViewCache } from './view'
import { resetLocks } from './threads'

const PANE = {
  plugin: 'lean-agent',
  component: 'Pane',
  requestId: 'lean-agent',
  surface: 'terminal',
  props: { title: 'lean-agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// the plugin's own folder, as the mod sees it (`$.plugin.root`): the specs' fake file system gets its opener there
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')

// a fresh home: no desk folder, no opener, nothing trusted; the plugin ships its opener
function fresh(on: any, cwd: string) {
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/opener/open-desk.sh`, '#!/bin/sh\necho open\n')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}')
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.0.0' : a[0] === 'agents' ? '[]' : '' })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  return { h, start: ($: any) => $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any) }
}
const mkdirs = (h: any) => h.calls.filter((c: any) => c.argv[0] === 'mkdir').length
const fixes = (h: any) => h.writes.filter((w: string) => w.endsWith('/bin/open-desk.sh') || w.includes('open-desk.sh.tmp')).length

test('a plain session on a fresh home shows Set up; pressing it runs fix once, then "not the desk" and Open desk', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /not set up/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Set up lean-agent/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /desk folder/ })).toBeTruthy() // one line per problem
  await ui.press({ key: 'setup' })
  expect(h.files.get('/h/.lean-agent/bin/open-desk.sh')).toContain('echo open')
  const opener = h.writes.filter((w: string) => w.includes('open-desk.sh')).length
  expect(await ui.find({ type: 'Text', text: /This is not the desk/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Open desk/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Set up lean-agent/ })).toBeFalsy()
  expect(h.writes.filter((w: string) => w.includes('open-desk.sh')).length).toBe(opener) // nothing is written again
  await ui.unmount()
})

test('Open desk runs claude --desktop in the desk folder, never when the Claude app is not running', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  h.app.running = false
  await ui.press({ key: 'open-desk' })
  expect(h.claudeCalls().filter((a: string[]) => a[0] === '--desktop')).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /app is not running/ })).toBeTruthy()
  h.app.running = true
  await ui.press({ key: 'open-desk' })
  const opened = h.calls.filter((c: any) => c.argv[0] === 'claude' && c.argv[1] === '--desktop')
  expect(opened).toHaveLength(1)
  expect(opened[0]?.cwd).toBe('/h/lean-agent-desk')
  await ui.unmount()
})

test('/lean-agent-setup prints the fix lines in a session that is not the desk, and is repeatable', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const r: any = await $.command.run({ command: 'lean-agent-setup' } as any)
  expect(r.text).toContain('desk folder ready')
  expect(r.text).toContain('opener script installed')
  expect(r.text).toContain('not the desk')
  expect(r.text).toContain('~/lean-agent-desk')
  const again: any = await $.command.run({ command: 'lean-agent-setup' } as any)
  expect(again.text).toContain('desk folder ready')
  expect(mkdirs(h)).toBeGreaterThan(0)
  expect(fixes(h)).toBeLessThanOrEqual(2) // the opener is written once; the second run finds it current
})

test('the desk pane shows the Setup / repair button and the fix lines after pressing it', async ($, on) => {
  const { h, start } = fresh(on, '/h/lean-agent-desk')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Button', text: /Setup \/ repair/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Goals/ })).toBeTruthy()
  await ui.press({ key: 'repair' })
  expect(await ui.find({ type: 'Text', text: /desk folder ready/ })).toBeTruthy()
  expect(h.files.get('/h/.lean-agent/bin/open-desk.sh')).toContain('echo open')
  await ui.unmount()
})

test('a check no press can repair (not macOS) is shown without the Set up button; the pane still offers Open desk', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  h.os.name = 'Linux'
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  expect(await ui.find({ type: 'Text', text: /needs Claude Desktop/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Set up lean-agent/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /Open desk/ })).toBeTruthy()
  await ui.unmount()
})

test('two setup runs that overlap share one fix', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const [a, b]: any[] = await Promise.all([$.command.run({ command: 'lean-agent-setup' } as any), $.command.run({ command: 'lean-agent-setup' } as any)])
  expect(a.text).toContain('desk folder ready')
  expect(b.text).toContain('desk folder ready')
  expect(h.calls.filter((c: any) => c.argv[0] === 'mkdir' && c.argv.includes('/h/lean-agent-desk')).length).toBe(1)
})

test('claude --desktop failing says what to do instead', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  const base = h.claude.handler
  h.claude.handler = (a: string[], c: any) => (a[0] === '--desktop' ? { exitCode: 2, stdout: '' } : base(a, c))
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  await ui.press({ key: 'open-desk' })
  expect(await ui.find({ type: 'Text', text: /exited 2/ })).toBeTruthy()
  await ui.unmount()
})

test('Open desk from a pane on the desktop surface skips pgrep (the app is running)', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'setup' })
  h.app.running = false
  await ui.press({ key: 'open-desk' })
  expect(h.calls.filter((c: any) => c.argv[0].endsWith('pgrep'))).toHaveLength(0)
  expect(h.calls.filter((c: any) => c.argv[0] === 'claude' && c.argv[1] === '--desktop')).toHaveLength(1)
  await ui.unmount()
})

test('Open desk elsewhere: second pgrep form finds the app; a pgrep that errors still tries claude --desktop and shows its real error', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  h.app.pgrep = (a: string[]) => (a[0] === '-f' ? { exitCode: 0, stdout: '1', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' })
  await ui.press({ key: 'open-desk' })
  expect(h.calls.filter((c: any) => c.argv[0] === 'claude' && c.argv[1] === '--desktop')).toHaveLength(1)
  h.app.pgrep = () => { throw new Error('spawn pgrep ENOENT') }
  h.claude.handler = (a: string[]) => (a[0] === '--desktop' ? { exitCode: 3, stdout: '', stderr: 'no app window' } : { exitCode: 0, stdout: a[0] === 'agents' ? '[]' : '' })
  await ui.press({ key: 'open-desk' })
  expect(h.calls.filter((c: any) => c.argv[0] === 'claude' && c.argv[1] === '--desktop')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /no app window/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not running/ })).toBeFalsy()
  await ui.unmount()
})
