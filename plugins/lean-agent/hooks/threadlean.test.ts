// The lean defaults of a thread's base (threadlean.ts, profile.ts): plugins, skills listing, MCP mode, and the reply's note.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { disabledPlugins, loadedLine, loadedText, resolveLoaded } from './profile'
import { leanNote, leanThreadCfg, threadSkillsLean } from './threadlean'

const L = '/h/.lean-agent'
function host(cfg?: unknown) {
  const h = fakeHost(null)
  if (cfg !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app', mcp: ['db', 'bad/name'] }, bare: { path: '/r/bare' } }))
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'lean-agent@mk': [{ installPath: '/c/la' }], 'hooked@mk': [{ installPath: '/c/hooked' }], 'figma@mk': [{ installPath: '/c/figma' }], 'plain@mk': [{ installPath: '/c/plain' }], 'unknown@mk': [{ installPath: '' }] } }))
  h.files.set('/c/hooked/hooks/hooks.json', '{}')
  h.files.set('/c/hooked/.claude-plugin/plugin.json', '{"name":"hooked"}')
  h.files.set('/c/figma/.mcp.json', '{}')
  h.files.set('/c/plain/.claude-plugin/plugin.json', '{"name":"plain"}')
  return h
}

test('config: lean plugins and skills by default, MCP all; nested or dotted keys; bad values fall back', () => {
  expect(leanThreadCfg({})).toEqual({ plugins: [], skills: 'lean', mcp: 'all' })
  expect(leanThreadCfg({ threads: { plugins: ['figma', 'bad name!', 'figma'], skills: 'all', mcp: 'none' } })).toEqual({ plugins: ['figma'], skills: 'all', mcp: 'none' })
  expect(leanThreadCfg({ 'threads.plugins': 'all', 'threads.mcp': 'project' })).toEqual({ plugins: 'all', skills: 'lean', mcp: 'project' })
  expect(leanThreadCfg({ threads: { mcp: 'everything', plugins: 7 } })).toEqual({ plugins: [], skills: 'lean', mcp: 'all' })
})

test('a thread without a profile loads lean-agent only: plugins [] (restricted), MCP untouched, and the note says what is on', async () => {
  const h = host()
  const l = await resolveLoaded(h.host, '/h', 'bare', ['azure'])
  expect(l.mcp).toBeNull()
  expect(l.plugins).toEqual(['azure'])
  expect(loadedText(l)).toContain('plugins: azure')
  expect(loadedText(l)).toContain("lean base: plugins lean-agent only, skills lean-agent's only, MCP all available")
  expect(loadedText(l)).toContain('threads.plugins / skills / mcp')
  expect(loadedLine(await resolveLoaded(h.host, '/h', 'bare', []))).toContain('plugins: none besides lean-agent')
})

test('threads.plugins adds plugins, "all" is the old behaviour (nothing restricted, no note)', async () => {
  const more = await resolveLoaded(host({ threads: { plugins: ['plain'] } }).host, '/h', 'bare')
  expect(more.plugins).toEqual(['plain'])
  expect(loadedText(more)).toContain('plugins lean-agent + plain')
  const all = await resolveLoaded(host({ threads: { plugins: 'all', skills: 'all' } }).host, '/h', 'bare')
  expect(all).toEqual({ mcp: null, plugins: null, needs: [] })
})

test('every installed plugin outside the list is switched off, except lean-agent, one with an MCP server and one that cannot be read', async () => {
  const h = host()
  expect(await disabledPlugins(h.host, [])).toEqual({ 'hooked@mk': false, 'plain@mk': false })
  expect(await disabledPlugins(h.host, ['plain'])).toEqual({ 'hooked@mk': false })
  const old = host({ threads: { plugins: 'all' } })
  expect(await disabledPlugins(old.host, [])).toEqual({}) // "all": only skill-only plugins were switched off before, none here
})

test('threads.mcp: all = as before; project = the project\'s own list (projects.json mcp, valid names) plus needs; none = needs only', async () => {
  expect((await resolveLoaded(host().host, '/h', 'app', [])).mcp).toBeNull()
  expect((await resolveLoaded(host({ threads: { mcp: 'project' } }).host, '/h', 'app', ['sentry'])).mcp).toEqual(['db', 'sentry'])
  expect((await resolveLoaded(host({ threads: { mcp: 'project' } }).host, '/h', 'bare', [])).mcp).toEqual([])
  const none = await resolveLoaded(host({ threads: { mcp: 'none' } }).host, '/h', 'app', ['sentry'])
  expect(none.mcp).toEqual(['sentry'])
  expect(loadedText(none)).toContain('MCP all deferred')
  expect(leanNote({ plugins: [], skills: 'lean', mcp: 'project' })).toContain("MCP the project's")
})

test('the thread skills listing is trimmed to lean-agent\'s unless threads.skills is "all"; the desk has its own rule', async () => {
  expect(await threadSkillsLean(host().host, 'thread')).toBe(true)
  expect(await threadSkillsLean(host({ threads: { skills: 'all' } }).host, 'thread')).toBe(false)
  expect(await threadSkillsLean(host().host, 'desk')).toBe(false)
  expect(await threadSkillsLean(host().host, 'worker')).toBe(false)
})
