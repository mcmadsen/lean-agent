// Project profiles (profile.ts): name matching, what a thread is started with, the plugins switched off, the usage counter, learning a
// profile from usage, and the thread start / list / needs / desk `profile` action built on them.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { deferOutside, disabledPlugins, fillProfile, loadedLine, loadedText, nameMatches, names, noteToolUse, profileText, projectUsage, readLoaded, readProfile, resolveLoaded, serverOf, usageKey } from './profile'
import { leanThread, resetLocks } from './threads'
import { threadTool } from './delivery'

const L = '/h/.lean-agent'
const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}\n<!-- profile -->\nLoaded for you: {{loaded}}\n<!-- /profile -->\nrest')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' }, other: { path: '/r/other' } }))
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : { exitCode: 0, stdout: '[]' })
  const call = (i: any) => leanThread(h.host, ROOT, i)
  return { h, call }
}
// installed plugins: lean-agent itself, a skills-only one, one that brings an MCP server, one with hooks, one that registers its own tools
// (plugin.json `modules`), one whose folder cannot be read, one with no skills folder, and one the profile allows
function plugins(h: any) {
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'lean-agent@mk': [{ installPath: '/c/lean-agent' }], 'skillsonly@mk': [{ installPath: '/c/so' }], 'figma@mk': [{ installPath: '/c/figma' }], 'hooked@mk': [{ installPath: '/c/hooked' }], 'modded@mk': [{ installPath: '/c/modded' }], 'mystery@mk': [{ version: '1' }], 'nothing@mk': [{ installPath: '/c/nothing' }], 'keep@mk': [{ installPath: '/c/keep' }] } }))
  for (const p of ['so', 'keep', 'figma', 'hooked', 'modded']) h.files.set(`/c/${p}/skills/x/SKILL.md`, '# x')
  h.files.set('/c/so/.claude-plugin/plugin.json', '{"name":"so"}')
  h.files.set('/c/keep/.claude-plugin/plugin.json', '{"name":"keep"}')
  h.files.set('/c/figma/.claude-plugin/plugin.json', '{"name":"figma"}')
  h.files.set('/c/figma/.mcp.json', '{}')
  h.files.set('/c/hooked/.claude-plugin/plugin.json', '{"name":"hooked"}')
  h.files.set('/c/hooked/hooks/hooks.json', '{}')
  h.files.set('/c/modded/.claude-plugin/plugin.json', '{"name":"modded","modules":["./m.ts"]}')
  h.files.set('/c/nothing/.claude-plugin/plugin.json', '{"name":"nothing"}')
}
const profile = (h: any, project: string, p: unknown) => h.files.set(`${L}/${project}/profile.json`, JSON.stringify(p))

test('names: a server is matched by whole words of its tool-name spelling; lean-agent and non-MCP tools are never deferred', () => {
  expect(serverOf('mcp__azure-devops__list_prs')).toBe('azure-devops')
  expect(serverOf('mcp__plugin_figma_figma__get')).toBe('plugin_figma_figma')
  expect(serverOf('Bash')).toBe('')
  expect(nameMatches('azure-devops', 'azure-devops')).toBe(true)
  expect(nameMatches('figma', 'plugin_figma_figma')).toBe(true)
  expect(nameMatches('plugin:figma:figma', 'plugin_figma_figma')).toBe(true)
  expect(nameMatches('Sentry', 'sentry')).toBe(true)
  expect(nameMatches('fig', 'plugin_figma_figma')).toBe(false) // whole words only
  expect(nameMatches('', 'x')).toBe(false)
  expect(nameMatches('claude.ai Gmail', 'claude_ai_Gmail')).toBe(true) // a connector's display name
  expect(names(['a', 'a', ' b ', '', '../x', 5, '__proto__', 'plugin:x:y', 'claude.ai Gmail'])).toEqual(['a', 'b', 'plugin:x:y', 'claude.ai Gmail'])
  expect(deferOutside({ mcp: [], plugins: null, needs: [] }, 'mcp__plugin_lean-agent_lean-agent__lean_report')).toBe(false) // however lean-agent's server is spelled
  expect(names('a')).toBeUndefined()
  const l = { mcp: ['db', 'figma'], plugins: null, needs: [] }
  expect(deferOutside(l, 'mcp__sentry__issues')).toBe(true)
  expect(deferOutside(l, 'mcp__db__query')).toBe(false)
  expect(deferOutside(l, 'mcp__plugin_figma_figma__get')).toBe(false)
  expect(deferOutside(l, 'mcp__lean-agent__lean_thread')).toBe(false)
  expect(deferOutside(l, 'Bash')).toBe(false)
  expect(deferOutside({ mcp: null, plugins: null, needs: [] }, 'mcp__sentry__issues')).toBe(false) // no profile: nothing held back
  expect(deferOutside(null, 'mcp__sentry__issues')).toBe(false)
  expect(deferOutside({ mcp: [], plugins: null, needs: [] }, 'mcp__sentry__issues')).toBe(true) // an empty allow-list defers every server but lean-agent's
})

test('a thread is started with the project profile plus its needs; no profile (or a list left out of it) holds nothing back', async () => {
  const { h } = setup()
  expect(await resolveLoaded(h.host, '/h', 'app', ['x'])).toEqual({ mcp: null, plugins: null, needs: ['x'] })
  profile(h, 'app', { mcp: ['db'] })
  expect(await resolveLoaded(h.host, '/h', 'app', ['azure-devops'])).toEqual({ mcp: ['db', 'azure-devops'], plugins: null, needs: ['azure-devops'] })
  profile(h, 'app', { mcp: [], plugins: ['keep'] })
  const l = await resolveLoaded(h.host, '/h', 'app', [])
  expect(l).toEqual({ mcp: [], plugins: ['keep'], needs: [] })
  expect(loadedText(l)).toBe('mcp: none · plugins: keep')
  expect(loadedText({ mcp: ['a', 'b'], plugins: null, needs: [] })).toBe('mcp: a,b · plugins: all')
  expect(loadedLine(l)).toBe('MCP servers: none besides lean-agent; plugins: keep')
  profile(h, 'app', 'garbage')
  expect((await resolveLoaded(h.host, '/h', 'app', [])).mcp).toBeNull() // a damaged profile is no profile
  // a typo never becomes an empty allow-list (everything deferred) or a silently unrestricted list: the whole profile counts as damaged
  profile(h, 'app', { mcp: ['bad/name'], plugins: ['keep'] })
  expect(await readProfile(h.host, '/h', 'app')).toBeNull()
  profile(h, 'app', { mcp: 'azure' })
  expect(await readProfile(h.host, '/h', 'app')).toBeNull()
  profile(h, 'app', { mcp: ['claude.ai Gmail'] })
  expect((await readProfile(h.host, '/h', 'app'))!.mcp).toEqual(['claude.ai Gmail'])
  expect(await readProfile(h.host, '/h', '../x')).toBeNull()
})

test('plugins outside the allow-list are switched off, except lean-agent, a plugin with an MCP server (deferred instead) and one that cannot be read', async () => {
  const { h } = setup()
  plugins(h)
  expect(await disabledPlugins(h.host, ['keep'])).toEqual({ 'skillsonly@mk': false })
  expect(await disabledPlugins(h.host, [])).toEqual({ 'skillsonly@mk': false, 'keep@mk': false })
  expect(await disabledPlugins(h.host, ['keep@mk', 'skillsonly'])).toEqual({})
  expect(await disabledPlugins(h.host, null)).toEqual({}) // no allow-list
  h.files.delete('/h/.claude/plugins/installed_plugins.json')
  expect(await disabledPlugins(h.host, [])).toEqual({}) // no registry: nothing to switch off
})

test('the usage counter counts MCP servers and skills by name, never arguments; lean-agent\'s own tools and other tools count nothing', async () => {
  const { h } = setup()
  expect(usageKey('mcp__sentry__issues', {})).toEqual(['mcp', 'sentry'])
  expect(usageKey('mcp__lean-agent__lean_report', {})).toBeNull()
  expect(usageKey('Skill', { skill: 'figma:implement' })).toEqual(['skills', 'figma:implement'])
  expect(usageKey('Skill', {})).toBeNull()
  expect(usageKey('Bash', { command: 'ls' })).toBeNull()
  await Promise.all(Array.from({ length: 8 }, () => noteToolUse(h.host, 't1', 'mcp__sentry__issues', { secret: 'ARGUMENT' })))
  await noteToolUse(h.host, 't1', 'Skill', { skill: 'figma:implement', args: 'ARGUMENT' })
  expect(await noteToolUse(h.host, 't1', 'Bash', { command: 'ls' })).toBe(false)
  const text = h.files.get(`${L}/threads/t1/usage.json`)!
  expect(JSON.parse(text)).toEqual({ mcp: { sentry: 8 }, skills: { 'figma:implement': 1 } }) // eight parallel calls, none lost
  expect(text).not.toContain('ARGUMENT')
})

test('usage across the project\'s threads: calls and threads per name, plugins from skill prefixes and plugin servers; fill adds, never removes', async () => {
  const { h } = setup()
  plugins(h)
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'figma@mk': [{ installPath: '/c/figma' }], 'viz@mk': [{ installPath: '/c/viz' }], 'datadog@mk': [{ installPath: '/c/dd' }], 'fig@mk': [{ installPath: '/c/fig' }] } }))
  h.files.set('/c/viz/skills/dataviz/SKILL.md', '# dataviz') // a skill called by its bare name belongs to the plugin whose skills folder has it
  const th = (id: string, project: string, usage?: object) => {
    h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, project }))
    if (usage) h.files.set(`${L}/threads/${id}/usage.json`, JSON.stringify(usage))
  }
  th('t1', 'app', { mcp: { 'azure-devops': 30, plugin_figma_figma: 2 }, skills: { 'datadog:ddsetup': 1, dataviz: 4 } })
  th('t2', 'app', { mcp: { 'azure-devops': 11 }, skills: {} })
  th('t3', 'app') // started before the counter existed: not counted
  th('t4', 'other', { mcp: { sentry: 99 }, skills: {} })
  const u = await projectUsage(h.host, '/h', 'app')
  expect(u.threads).toBe(2)
  expect(u.mcp['azure-devops']).toEqual({ calls: 41, threads: 2 })
  expect(Object.keys(u.plugins).sort()).toEqual(['datadog', 'figma', 'viz']) // `plugin_figma_figma` is figma (not fig); dataviz is viz's
  expect(u.skills.dataviz).toEqual({ calls: 4, threads: 1 })
  const none = await fillProfile(h.host, '/h', 'other-none')
  expect(none.ok).toBe(false)
  expect(none.text).toContain('nothing to learn from')
  expect(await readProfile(h.host, '/h', 'other-none')).toBeNull() // a project with no usage gets no profile (it would lock everything out)
  profile(h, 'app', { mcp: ['kept-by-hand'] })
  const r = await fillProfile(h.host, '/h', 'app')
  expect(r.ok).toBe(true)
  const p = (await readProfile(h.host, '/h', 'app'))!
  expect(p.mcp).toEqual(['kept-by-hand', 'azure-devops', 'plugin_figma_figma'])
  expect(p.plugins).toBeUndefined() // a plugins list is never created from usage (a slash-run skill is not counted): the used ones are only reported
  expect(r.text).toContain('plugins whose skills were used: figma, datadog, viz')
  expect(p.source).toBe('usage')
  const t = await profileText(h.host, '/h', 'app')
  expect(t).toContain('azure-devops used 41 times in 2 threads (in the profile)')
  expect(t).toContain('usage from 2 thread(s)')
  expect(await profileText(h.host, '/h', 'other')).toContain('other has no profile')
})

test('fill writes only the lists it has evidence for: threads that called nothing never create an empty allow-list', async () => {
  const { h } = setup()
  plugins(h)
  const th = (id: string, usage: object) => {
    h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ id, project: 'app' }))
    h.files.set(`${L}/threads/${id}/usage.json`, JSON.stringify(usage))
  }
  th('t1', { mcp: {}, skills: {} }) // the learn thread: lean-agent's own tools only
  const none = await fillProfile(h.host, '/h', 'app')
  expect(none.ok).toBe(false)
  expect(none.text).toContain('called no MCP server yet')
  expect(await readProfile(h.host, '/h', 'app')).toBeNull() // no profile = everything loads
  // a profile that sets only mcp keeps its plugins unrestricted when no plugin was used
  profile(h, 'app', { mcp: ['db'] })
  th('t2', { mcp: { sentry: 2 }, skills: {} })
  expect((await fillProfile(h.host, '/h', 'app')).ok).toBe(true)
  expect(await readProfile(h.host, '/h', 'app')).toMatchObject({ mcp: ['db', 'sentry'] })
  expect((await readProfile(h.host, '/h', 'app'))!.plugins).toBeUndefined()
  expect((await resolveLoaded(h.host, '/h', 'app', [])).plugins).toBeNull()
  // a plugins list the profile already has grows with the used plugins; a name an entry already covers is not added twice
  profile(h, 'app', { mcp: ['db', 'figma'], plugins: ['a'] })
  th('t3', { mcp: { plugin_figma_figma: 1 }, skills: { 'keep:x': 1 } })
  const f = await fillProfile(h.host, '/h', 'app')
  expect(f.ok).toBe(true)
  expect(await readProfile(h.host, '/h', 'app')).toMatchObject({ mcp: ['db', 'figma', 'sentry'], plugins: ['a', 'figma', 'keep'] }) // sentry from t2; the mcp entry figma covers plugin_figma_figma; the figma plugin was used through its server
  // nothing new: the file is not rewritten (its source stays)
  const again = await fillProfile(h.host, '/h', 'app')
  expect(again.text).toContain('the profile is unchanged')
  profile(h, 'app', { mcp: ['db', 'figma', 'sentry'], plugins: ['a', 'figma', 'keep'], source: 'desk' })
  await fillProfile(h.host, '/h', 'app')
  expect(JSON.parse(h.files.get(`${L}/app/profile.json`)!).source).toBe('desk')
})

test('the thread folder is saved with model, effort and needs BEFORE the session starts (its mod reads thread.json at its first request)', async () => {
  const { h, call } = setup()
  let atStart = ''
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') {
      atStart = h.files.get(`${L}/threads/t1/thread.json`) ?? ''
      return { exitCode: 0, stdout: `started ${SID}\n` }
    }
    return { exitCode: 0, stdout: '[]' }
  }
  await call({ action: 'new', title: 'a', project: 'app', needs: ['x'], model: 'opus', effort: 'low' })
  expect(JSON.parse(atStart)).toMatchObject({ model: 'opus', effort: 'low', needs: ['x'] })
})

test('a thread of a project without a profile gets no profile text in its CLAUDE.md; lean_profile fill is limited to its own project', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', project: 'app' })
  expect(h.files.get(`${L}/threads/t1/CLAUDE.md`)).toBe('# t1 a\nrest')
  h.files.set(`${L}/threads/t1/usage.json`, JSON.stringify({ mcp: { sentry: 1 }, skills: {} }))
  const own = await threadTool(h.host, 't1', 'lean_profile', { action: 'fill' })
  expect(own.ok).toBe(true)
  const other = await threadTool(h.host, 't1', 'lean_profile', { action: 'fill', project: 'other' })
  expect(other.ok).toBe(false)
  expect(other.text).toContain('own project (app)')
  expect((await threadTool(h.host, 't1', 'lean_profile', { action: 'show', project: 'other' })).ok).toBe(true) // reading is fine
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', project: '' })) // a thread with no project fills nothing
  expect((await threadTool(h.host, 't2', 'lean_profile', { action: 'fill', project: 'app' })).text).toContain('this thread has none')
  h.files.set(`${L}/app/profile.json`, JSON.stringify({ mcp: ['bad/name'] }))
  expect((await threadTool(h.host, 't1', 'lean_profile', { action: 'show' })).text).toContain('damaged')
})

test('new without a profile is unchanged: no enabledPlugins, no suffix; loaded.json says everything loads and a usage counter starts', async () => {
  const { h, call } = setup()
  plugins(h)
  const r = await call({ action: 'new', title: 'a', text: 'brief', project: 'app' })
  expect(r.text).toBe(`t1 started (${SID}) · sonnet/high`) // model/effort only: no profile, no loaded suffix
  expect(JSON.parse(h.files.get(`${L}/threads/t1/.claude/settings.json`)!).enabledPlugins).toBeUndefined()
  expect(await readLoaded(h.host, '/h', 't1')).toEqual({ mcp: null, plugins: null, needs: [] })
  expect(JSON.parse(h.files.get(`${L}/threads/t1/usage.json`)!)).toEqual({ mcp: {}, skills: {} })
  expect(h.files.get(`${L}/threads/t1/CLAUDE.md`)).not.toContain('Loaded for you')
  expect((await call({ action: 'list' })).text).not.toContain('mcp:')
  // needs without a profile are kept but change nothing
  const n = await call({ action: 'new', title: 'b', project: 'app', needs: ['azure-devops'] })
  expect(n.text).toBe(`t2 started (${SID}) · sonnet/high`)
  expect(JSON.parse(h.files.get(`${L}/threads/t2/thread.json`)!).needs).toEqual(['azure-devops'])
})

test('new with a profile and needs: plugins off in the thread settings, the loaded set in the reply, list, loaded.json and the thread CLAUDE.md', async () => {
  const { h, call } = setup()
  plugins(h)
  profile(h, 'app', { mcp: ['db'], plugins: ['keep'] })
  const r = await call({ action: 'new', title: 'pr', text: 'brief', project: 'app', needs: ['azure-devops'] })
  expect(r.text).toBe(`t1 started (${SID}) · sonnet/high · mcp: db,azure-devops · plugins: keep,azure-devops`) // one line: model/effort, then the loaded set
  const s = JSON.parse(h.files.get(`${L}/threads/t1/.claude/settings.json`)!)
  expect(s.enabledPlugins).toEqual({ 'skillsonly@mk': false }) // not lean-agent, not figma (it brings a server), not keep
  expect(s.model).toBe('sonnet') // the other keys stay
  expect(await readLoaded(h.host, '/h', 't1')).toEqual({ mcp: ['db', 'azure-devops'], plugins: ['keep', 'azure-devops'], needs: ['azure-devops'] })
  expect(h.files.get(`${L}/threads/t1/CLAUDE.md`)).toContain('MCP servers: db, azure-devops; plugins: keep, azure-devops')
  expect((await call({ action: 'list' })).text).toContain('· mcp: db,azure-devops · plugins: keep,azure-devops')
  // another project without a profile in the same session is untouched
  const o = await call({ action: 'new', title: 'o', project: 'other' })
  expect(o.text).toBe(`t2 started (${SID}) · sonnet/high`)
  // the argv gained nothing: no --strict-mcp-config, no --mcp-config (the profile works through settings and the mod)
  const argv = h.claudeCalls().find(a => a[0] === '--bg')!
  expect(argv.some(a => a.startsWith('--strict-mcp') || a === '--mcp-config')).toBe(false)
})

test('start and a closed thread\'s reopen add needs (kept in thread.json); bad needs are refused before anything is created', async () => {
  const { h, call } = setup()
  plugins(h)
  profile(h, 'app', { mcp: ['db'], plugins: [] })
  const bad = await call({ action: 'new', title: 'x', project: 'app', needs: ['ok', '../etc'] })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('needs must be a list')
  expect(h.files.has(`${L}/threads/t1/thread.json`)).toBe(false)
  expect((await call({ action: 'new', title: 'x', project: 'app', needs: 'azure-devops' as any })).ok).toBe(false)
  await call({ action: 'new', title: 'a', project: 'app' })
  await call({ action: 'close', tN: 't1' })
  const re = await call({ action: 'reopen', tN: 't1', needs: ['sentry'] })
  expect(re.text).toContain('mcp: db,sentry · plugins: sentry')
  expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).needs).toEqual(['sentry'])
  expect(JSON.parse(h.files.get(`${L}/threads/t1/.claude/settings.json`)!).enabledPlugins).toEqual({ 'skillsonly@mk': false, 'keep@mk': false })
  // a parked thread's reopen is the same session: needs would not apply, and it says so
  await call({ action: 'park', tN: 't1' })
  expect((await call({ action: 'reopen', tN: 't1', needs: ['x'] })).text).toContain('needs apply to a new session only')
  // start adds to what the thread already asked for
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : { exitCode: 0, stdout: '[{"sessionId":"x","cwd":"x","status":"idle"}]' })
  const st = await call({ action: 'start', tN: 't1', needs: ['figma'] })
  expect(st.text).toContain('mcp: db,sentry,figma')
  expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).needs).toEqual(['sentry', 'figma'])
})

test('start with needs on a running thread changes nothing and says so', async () => {
  const { h, call } = setup()
  profile(h, 'app', { mcp: ['db'] })
  await call({ action: 'new', title: 'a', project: 'app' })
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : { exitCode: 0, stdout: JSON.stringify([{ sessionId: SID, cwd: 'x', status: 'busy' }]) })
  const r = await call({ action: 'start', tN: 't1', needs: ['figma'] })
  expect(r.text).toBe('t1 is already running (needs apply to a new session only: nothing was changed)')
  expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).needs).toBeUndefined()
})

test('lean_thread profile: show, set (a list left out stays), fill from usage, remove; unknown project and bad names are refused', async () => {
  const { h, call } = setup()
  expect((await call({ action: 'profile', project: 'nope' })).ok).toBe(false)
  expect((await call({ action: 'profile' })).ok).toBe(false)
  expect((await call({ action: 'profile', project: 'app' })).text).toContain('app has no profile')
  expect((await call({ action: 'profile', project: 'app', mcp: ['ok', 'a/b'] })).ok).toBe(false)
  const set = await call({ action: 'profile', project: 'app', mcp: ['db'] })
  expect(set.ok).toBe(true)
  expect(set.text).toContain('mcp: db · plugins: all (not restricted)')
  await call({ action: 'profile', project: 'app', plugins: ['keep'] })
  expect(await readProfile(h.host, '/h', 'app')).toMatchObject({ mcp: ['db'], plugins: ['keep'], source: 'desk' })
  expect((await call({ action: 'profile', project: 'app', fill: true })).ok).toBe(false) // no usage yet: nothing is learned, the profile stays
  expect(await readProfile(h.host, '/h', 'app')).toMatchObject({ mcp: ['db'], plugins: ['keep'] })
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'app' }))
  h.files.set(`${L}/threads/t1/usage.json`, JSON.stringify({ mcp: { sentry: 3 }, skills: {} }))
  const f = await call({ action: 'profile', project: 'app', fill: true })
  expect(f.ok).toBe(true)
  expect((await readProfile(h.host, '/h', 'app'))!.mcp).toEqual(['db', 'sentry'])
  expect((await call({ action: 'profile', project: 'app', on: false })).text).toContain('profile removed')
  expect(await readProfile(h.host, '/h', 'app')).toBeNull()
  expect((await call({ action: 'profile', project: 'app', on: false })).text).toContain('has no profile')
})
