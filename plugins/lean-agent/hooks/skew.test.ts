// Version skew: the code a session loaded vs the plugin that is installed now.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { compareVersions, installedVersion, resetSkew, setRunning, skewNote, skewText } from './skew'
import { resetLocks } from './threads'
import { VERSION } from './pane'

test('compareVersions orders numerically', () => {
  expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
  expect(compareVersions('1.0.4', '1.0.4')).toBe(0)
  expect(compareVersions('1.0.4', '1.1.0')).toBe(-1)
  expect(skewText('1.0.3', '1.0.4')).toBe('lean-agent code 1.0.3 is running but 1.0.4 is installed: start a new session (threads: close and Start)')
})

test('the installed version is the highest of the plugin root manifest and the install registry; an unreadable one is null', async () => {
  const h = fakeHost(null)
  expect(await installedVersion(h.host, '/plug')).toBeNull()
  h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.3' }))
  expect(await installedVersion(h.host, '/plug')).toBe('1.0.3')
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'lean-agent@mk': [{ scope: 'user', version: '1.0.4' }], 'other@mk': [{ version: '9.9.9' }] } }))
  expect(await installedVersion(h.host, '/plug/')).toBe('1.0.4') // the update wrote the registry; this session's folder is the old one
  h.files.set('/plug/.claude-plugin/plugin.json', '{broken')
  expect(await installedVersion(h.host, '/plug')).toBe('1.0.4')
})

test('skewNote: only a difference is a note; unknown running version or manifest is silent; cached for a minute', async () => {
  const h = fakeHost(null)
  h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.4' }))
  resetSkew()
  expect(await skewNote(h.host, '/plug', '')).toBeNull()
  expect(await skewNote(h.host, '/plug', '1.0.4')).toBeNull()
  resetSkew()
  expect(await skewNote(h.host, '/plug', '1.0.3')).toBe(skewText('1.0.3', '1.0.4'))
  h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.5' }))
  expect(await skewNote(h.host, '/plug', '1.0.3')).toBe(skewText('1.0.3', '1.0.4')) // cached
  h.clock.t += 61_000
  expect(await skewNote(h.host, '/plug', '1.0.3')).toBe(skewText('1.0.3', '1.0.5'))
  resetSkew()
  h.files.delete('/plug/.claude-plugin/plugin.json')
  expect(await skewNote(h.host, '/plug', '1.0.3')).toBeNull()
})

test('a session that runs older code than is installed: status line, one prompt line, guard refusals and feedback carry the running version', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  const status: string[] = []
  on('ui.status', (_: any, e: any) => { status.push(String(e.text ?? e.line ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'lean-agent@mk': [{ version: '99.0.0' }] } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as any)
  on('tool.call', () => ({ result: 'did it\nLEAN-FEEDBACK {"status":"done","refused":[{"command":"rg x","text":"refused"}]}' }) as any)
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  expect(status.some(s => s.includes(`lean-agent code ${VERSION} is running but 99.0.0 is installed: start a new session (threads: close and Start)`))).toBe(true)
  const r: any = await $.prompt.compose({ model: 'haiku', promptModel: 'haiku', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  const sec = r.sections.find((x: any) => x.id === 'lean-agent:skew')
  expect(sec.text).toBe(`[lean-agent] lean-agent code ${VERSION} is running but 99.0.0 is installed: start a new session (threads: close and Start)`)
  const d: any = await $.tool.call({ tool: 'AskUserQuestion' } as any)
  expect(d.deny).toContain(`(lean-agent ${VERSION})`)
  await $.tool.call({ tool: 'Agent', prompt: 'x', subagent_type: 'lean-agent:explorer' } as any)
  expect(JSON.parse(h.files.get('/h/.lean-agent/feedback.jsonl')!.trim()).version).toBe(VERSION)
  expect(h.files.get('/h/.lean-agent/refusals.jsonl')).toContain(`"version":"${VERSION}"`)
})

test('same version: no status line and no prompt line', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  const status: string[] = []
  on('ui.status', (_: any, e: any) => { status.push(JSON.stringify(e)); return { value: undefined } })
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'lean-agent@mk': [{ version: VERSION }] } }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }) as any)
  await $.session.start({ cwd: '/somewhere', surface: 'cli', isInteractive: true } as any)
  const r: any = await $.prompt.compose({ model: 'haiku', promptModel: 'haiku', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.some((x: any) => x.id === 'lean-agent:skew')).toBe(false)
  expect(status.some(s => s.includes('is running but'))).toBe(false)
})
