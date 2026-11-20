import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetViewCache } from './view'
import { resetLocks } from './threads'
import { newSessionLink, openDesk, openerArgv, platformOf } from './setup'

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

// the system opener's calls (a URL is opened with `open`, `xdg-open` or rundll32, never with `claude --desktop`, which refuses to run
// when its output is captured)
const opens = (h: any) => h.calls.filter((c: any) => ['open', 'xdg-open', 'rundll32'].includes(c.argv[0]))
const desktopCalls = (h: any) => h.calls.filter((c: any) => c.argv[0] === 'claude' && c.argv[1] === '--desktop')

test('Open desk opens the new-session deep link for the desk folder with the system opener, never when the Claude app is not running', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  h.app.running = false
  await ui.press({ key: 'open-desk' })
  expect(opens(h)).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /app is not running/ })).toBeTruthy()
  h.app.running = true
  await ui.press({ key: 'open-desk' })
  expect(opens(h).map((c: any) => c.argv)).toEqual([['open', 'claude://code/new?folder=%2Fh%2Flean-agent-desk']])
  expect(desktopCalls(h)).toHaveLength(0)
  await ui.unmount()
})

test('the opener per platform, as argv without a shell; the folder is the real path, percent-encoded (spaces, non-ASCII)', async ($, on) => {
  expect(newSessionLink('/Users/a b/lean-agent-desk')).toBe('claude://code/new?folder=%2FUsers%2Fa%20b%2Flean-agent-desk')
  expect(newSessionLink('/h/ü&x=1/d')).toBe('claude://code/new?folder=%2Fh%2F%C3%BC%26x%3D1%2Fd')
  const url = 'claude://code/new?folder=%2Fh%2Fd'
  expect(openerArgv('mac', url)).toEqual(['open', url])
  expect(openerArgv('linux', url)).toEqual(['xdg-open', url])
  expect(openerArgv('windows', url)).toEqual(['rundll32', 'url.dll,FileProtocolHandler', url])
  const { h } = fresh(on, '/h/lean-agent-desk')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  expect(await platformOf(h.host)).toBe('mac')
  h.os.name = 'Linux'
  expect(await platformOf(h.host)).toBe('linux')
  expect((await openDesk(h.host, 'desktop')).ok).toBe(true)
  expect(opens(h).pop().argv).toEqual(['xdg-open', 'claude://code/new?folder=%2Fh%2Flean-agent-desk'])
  h.os.name = 'MINGW64_NT-10.0'
  expect(await platformOf(h.host)).toBe('windows')
  expect((await openDesk(h.host)).ok).toBe(true) // (the app check is a macOS one)
  expect(opens(h).pop().argv).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/new?folder=%2Fh%2Flean-agent-desk'])
  // the desk folder behind a symlink: the link carries the real path
  h.os.name = 'Darwin'
  h.links.set('/h/lean-agent-desk', '/Volumes/data/my desk')
  h.files.set('/Volumes/data/my desk/CLAUDE.md', 'desk')
  expect((await openDesk(h.host, 'desktop')).ok).toBe(true)
  expect(opens(h).pop().argv).toEqual(['open', 'claude://code/new?folder=%2FVolumes%2Fdata%2Fmy%20desk'])
  expect(desktopCalls(h)).toHaveLength(0)
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
  expect(await ui.find({ type: 'Button', text: /Threads/ })).toBeTruthy() // a section header is a toggle button
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

test('an opener that fails says what to do instead (its first line, then the by-hand advice); claude --desktop is not tried', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  h.opener.handler = () => ({ exitCode: 1, stdout: '', stderr: '\nThe application cannot be opened\nsecond line' })
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  await ui.press({ key: 'open-desk' })
  expect(await ui.find({ type: 'Text', text: /Could not open the Claude app: The application cannot be opened; start a new session in ~\/lean-agent-desk by hand$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /second line/ })).toBeFalsy()
  expect(desktopCalls(h)).toHaveLength(0)
  // no output at all: the exit code says it
  h.opener.handler = () => ({ exitCode: 2, stdout: '' })
  await ui.press({ key: 'open-desk' })
  expect(await ui.find({ type: 'Text', text: /Could not open the Claude app: open exited 2; start a new session/ })).toBeTruthy()
  await ui.unmount()
})

test('an opener that cannot be started falls back to claude --desktop, and says both when both fail', async ($, on) => {
  const { h } = fresh(on, '/h/lean-agent-desk')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'desk')
  h.os.name = 'Linux'
  h.opener.handler = () => { throw new Error('spawn xdg-open ENOENT') }
  const r = await openDesk(h.host, 'desktop')
  expect(r.ok).toBe(true) // claude --desktop answered 0
  expect(desktopCalls(h).map((c: any) => c.cwd)).toEqual(['/h/lean-agent-desk'])
  h.claude.handler = (a: string[]) => (a[0] === '--desktop' ? { exitCode: 1, stdout: '', stderr: "--desktop opens the Claude Desktop app and can't run non-interactively" } : { exitCode: 0, stdout: '' })
  const bad = await openDesk(h.host, 'desktop')
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('Could not open the Claude app: spawn xdg-open ENOENT; claude --desktop: --desktop opens the Claude Desktop app')
  expect(bad.text).toContain('start a new session in ~/lean-agent-desk by hand')
  // an opener that started and then timed out is not retried with the CLI (a second window); a trailing period is dropped
  const before = desktopCalls(h).length
  h.opener.handler = () => { throw new Error('process timed out after 15000ms.') }
  const slow = await openDesk(h.host, 'desktop')
  expect(slow.text).toBe('Could not open the Claude app: process timed out after 15000ms; start a new session in ~/lean-agent-desk by hand')
  expect(desktopCalls(h)).toHaveLength(before)
  expect(opens(h).pop().timeoutMs).toBe(15_000)
})

test('Open desk from a pane on the desktop surface skips pgrep (the app is running)', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'setup' })
  h.app.running = false
  await ui.press({ key: 'open-desk' })
  expect(h.calls.filter((c: any) => c.argv[0].endsWith('pgrep'))).toHaveLength(0)
  expect(opens(h)).toHaveLength(1)
  await ui.unmount()
})

test('Open desk elsewhere: second pgrep form finds the app; a pgrep that errors still opens the link and shows the opener\'s real error', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  h.app.pgrep = (a: string[]) => (a[0] === '-f' ? { exitCode: 0, stdout: '1', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' })
  await ui.press({ key: 'open-desk' })
  expect(opens(h)).toHaveLength(1)
  h.app.pgrep = () => { throw new Error('spawn pgrep ENOENT') }
  h.opener.handler = () => ({ exitCode: 3, stdout: '', stderr: 'no app window' })
  await ui.press({ key: 'open-desk' })
  expect(opens(h)).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /no app window/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not running/ })).toBeFalsy()
  await ui.unmount()
})

test('a pgrep that fails with a code other than 1 is not "app not running": the link is still opened', async ($, on) => {
  const { h, start } = fresh(on, '/h/.claude/spares/spare-abc')
  await start($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'setup' })
  h.app.pgrep = () => ({ exitCode: 2, stdout: '', stderr: 'syntax error' })
  await ui.press({ key: 'open-desk' })
  expect(opens(h)).toHaveLength(1)
  await ui.unmount()
})

// an MCP server whose config references a variable the desk does not have (a plugin synced from claude.ai, as Claude Code lays it out)
function withUnsetServer(h: any) {
  const b = '/h/.claude/plugins/synced/b1'
  h.files.set(`${b}/manifest.json`, JSON.stringify({ plugins: [{ name: '16a0', generation: 2 }] }))
  h.files.set(`${b}/16a0~g2/.claude-plugin/plugin.json`, JSON.stringify({ name: 'datadog', mcpServers: './.dd_mcp.json' }))
  h.files.set(`${b}/16a0~g2/.dd_mcp.json`, JSON.stringify({ mcpServers: { mcp: { type: 'http', url: 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp' } } }))
}

test('the desk pane names an MCP server that needs a variable (no text field: the desk asks), and it is not a setup problem', async ($, on) => {
  const { h, start } = fresh(on, '/h/lean-agent-desk')
  withUnsetServer(h)
  await start($)
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /MCP servers that need a value/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /plugin:datadog:mcp needs DD_MCP_DOMAIN/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Tell the desk/ })).toBeTruthy()
  await ui.press({ key: 'repair' }) // after a setup run the rows are all that is left: no "not set up" heading, the MCP block stays
  expect(await ui.find({ type: 'Text', text: /lean-agent is not set up/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /plugin:datadog:mcp needs DD_MCP_DOMAIN/ })).toBeTruthy()
  await ui.unmount()
})

test('/lean-agent-setup lists the MCP servers that need a value and still says lean-agent is set up', async ($, on) => {
  const { h, start } = fresh(on, '/h/lean-agent-desk')
  await start($)
  await $.command.run({ command: 'lean-agent-setup' } as any) // everything else set up first
  withUnsetServer(h)
  const r: any = await $.command.run({ command: 'lean-agent-setup' } as any)
  expect(r.text).toContain('lean-agent is set up.')
  expect(r.text).toContain('MCP servers that need a value')
  expect(r.text).toContain("plugin:datadog:mcp needs DD_MCP_DOMAIN (unset: it falls back to 'not-setup'")
})
