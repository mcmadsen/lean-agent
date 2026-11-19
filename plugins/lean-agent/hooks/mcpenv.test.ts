import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check, tidyLegacy } from './doctor'
import { exportFeedback } from './feedbackexport'
import { leanThread, resetLocks } from './threads'
import { mcpNeeds, mcpRows, nameProblem, refsOf, setSettingsEnv, threadEnv, valueProblem, writeThreadSettings, looksSecret } from './mcpenv'
import { mcpOf, problemsOf, setupText } from './setup'
import { resetFolderLocks } from './folderlock'
import { resetViewCache } from './view'

const H = '/h'
const SETTINGS = '/h/.claude/settings.json'
const MCPENV = '/h/.lean-agent/mcp-env.json'
const SYNC = '/h/.claude/plugins/synced/b1'
const DD = { mcpServers: { mcp: { type: 'http', url: 'https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp', headers: { DD_API_KEY: '${DD_API_KEY:-}', DD_APPLICATION_KEY: '${DD_APPLICATION_KEY:-}', 'X-Toolsets': '${DD_MCP_TOOLSETS:-core,visualizations}' } } } }
// values the specs must never see in a report, a log line or a file they were not meant for
const S1 = 'sentinel-site-1q.example'
const S2 = 'sentinel-secret-2w'
const S3 = 'sentinel-command-3e'
const S4 = 'sentinel-new-4r.example'

function home() {
  resetFolderLocks()
  resetLocks()
  resetViewCache()
  const h = fakeHost(null)
  const j = (p: string, v: unknown) => h.files.set(p, typeof v === 'string' ? v : JSON.stringify(v))
  return { h, j }
}
// a plugin synced from claude.ai, laid out as Claude Code writes it: <bucket>/manifest.json lists the plugin by a uuid-like name,
// the folder is <name>~g<generation>, plugin.json names the MCP file
function synced(j: (p: string, v: unknown) => void, mcp: unknown = DD) {
  j(`${SYNC}/manifest.json`, { plugins: [{ name: '16a0', generation: 2 }] })
  j(`${SYNC}/16a0~g2/.claude-plugin/plugin.json`, { name: 'datadog', mcpServers: './.dd_claude-code_mcp.json' })
  j(`${SYNC}/16a0~g2/.dd_claude-code_mcp.json`, mcp)
}

// a user MCP server whose URL references the given variables (writing a name needs a config that uses it)
function uses(j: (p: string, v: unknown) => void, ...names: string[]) {
  j('/h/.claude.json', { mcpServers: { s: { url: `https://x.example.com/${names.map(n => '${' + n + ':-}').join('/')}` } } })
}

// ---- detect -------------------------------------------------------------------------------------------------------------
test('a synced plugin\'s ${DD_MCP_DOMAIN:-not-setup} is reported by name; empty and usable defaults are not', async () => {
  const { h, j } = home()
  synced(j)
  const rows = await mcpRows(h.host, H)
  expect(rows[0]).toBe("MCP  plugin:datadog:mcp needs DD_MCP_DOMAIN (unset: it falls back to 'not-setup', a placeholder, so the server cannot connect)")
  expect(rows.join('\n')).not.toMatch(/DD_API_KEY|DD_APPLICATION_KEY|DD_MCP_TOOLSETS/) // empty default / a default that works
  expect(rows[1]).toContain('lean_doctor mcp-env NAME VALUE')
  expect(rows).toHaveLength(2)
})

test('a variable the user settings env block sets (non-empty) is not reported; an empty one still is; the shell does not count', async () => {
  const { h, j } = home()
  synced(j)
  j(SETTINGS, { env: { DD_MCP_DOMAIN: '' } })
  expect(await mcpRows(h.host, H)).toHaveLength(2) // empty = unset (the default applies)
  j(SETTINGS, { permissions: { allow: ['Bash'] }, env: { DD_MCP_DOMAIN: S1 } })
  expect(await mcpRows(h.host, H)).toEqual([])
})

test('the desk folder\'s own settings env counts for the desk', async () => {
  const { h, j } = home()
  synced(j)
  j('/h/lean-agent-desk/.claude/settings.json', { env: { DD_MCP_DOMAIN: S1 } })
  expect(await mcpRows(h.host, H)).toEqual([])
})

test('installed plugins count only when enabled; a bare ${TOKEN} says the server will not start and that it looks secret', async () => {
  const { h, j } = home()
  j('/h/.claude/plugins/installed_plugins.json', { version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: '/ip/a' }], 'b@m': [{ scope: 'user', installPath: '/ip/b' }], 'c@m': [{ scope: 'project', installPath: '/ip/c' }] } })
  j(SETTINGS, { enabledPlugins: { 'a@m': true, 'b@m': false, 'c@m': true } })
  j('/ip/a/.claude-plugin/plugin.json', { name: 'alpha' })
  j('/ip/a/.mcp.json', { mcpServers: { srv: { command: 'x', args: ['${CLAUDE_PLUGIN_ROOT}/run', '${HOME}/y'], env: { API_TOKEN: '${ALPHA_API_TOKEN}' } } } })
  j('/ip/b/.mcp.json', { mcpServers: { off: { url: 'https://${B_HOST}/' } } })
  j('/ip/c/.mcp.json', { mcpServers: { other: { url: 'https://${C_HOST}/' } } })
  const n = await mcpNeeds(h.host, H)
  expect(n.map(x => x.server)).toEqual(['plugin:alpha:srv']) // b is off, c is project-scoped
  expect(n[0]!.vars[0]!.name).toBe('ALPHA_API_TOKEN') // CLAUDE_PLUGIN_ROOT and HOME are provided
  expect(n[0]!.vars[0]!.why).toContain('the server will not start')
  expect(n[0]!.vars[0]!.why).toContain('looks secret')
})

test('a synced plugin switched off in the user settings is skipped; a plugin.json path outside the plugin is ignored', async () => {
  const { h, j } = home()
  synced(j)
  j(SETTINGS, { enabledPlugins: { 'datadog@synced': false } })
  expect(await mcpRows(h.host, H)).toEqual([])
  j(SETTINGS, {})
  j(`${SYNC}/16a0~g2/.claude-plugin/plugin.json`, { name: 'datadog', mcpServers: ['../../../secret.json', '/etc/x.json'] })
  j('/h/.claude/plugins/secret.json', { mcpServers: { s: { url: 'https://${LEAK}/' } } })
  expect(await mcpRows(h.host, H)).toEqual([]) // neither path is read (and the default .mcp.json is absent)
})

test('user servers (~/.claude.json) and a registered project\'s .mcp.json; a bare host default is a placeholder, a real one is not', async () => {
  const { h, j } = home()
  j('/h/.claude.json', { mcpServers: { mine: { url: 'https://${MY_SITE:-local}/mcp' }, fine: { url: 'https://${REGION:-eu.example.com}/mcp' }, port: { url: 'http://${H2:-localhost}:1/x' } } })
  j('/h/.lean-agent/projects.json', { app: { path: '/r/app' } })
  j('/r/app/.mcp.json', { mcpServers: { db: { url: 'https://db.example.com/${DB_PATH}' } } })
  const n = await mcpNeeds(h.host, H)
  expect(n.map(x => `${x.server}:${x.vars.map(v => v.name)}`)).toEqual(['user:mine:MY_SITE', 'project:app:db:DB_PATH'])
  expect(n[0]!.vars[0]!.why).toContain("'local'")
})

test('refsOf: the same variable used with and without a default is required; names only', () => {
  const r = refsOf({ url: 'https://${A:-x.y}/${A}/${B:-}', args: ['${C:-todo}'] })
  expect(r.map(x => [x.name, x.dflt])).toEqual([['A', null], ['B', ''], ['C', 'todo']])
})

test('check: MCP rows are not FIX rows (not a setup problem); setupText lists them and still says set up', async () => {
  const { h, j } = home()
  synced(j)
  const lines = await check(h.host, '/plug')
  expect(lines.some(l => l.startsWith('MCP  plugin:datadog:mcp needs DD_MCP_DOMAIN'))).toBe(true)
  expect(problemsOf(lines).join('\n')).not.toContain('DD_MCP_DOMAIN')
  expect(mcpOf(lines)[0]).toContain('plugin:datadog:mcp needs DD_MCP_DOMAIN')
  const text = setupText({ fixed: [], checked: lines, problems: [], notes: [], mcp: mcpOf(lines) }, true)
  expect(text).toContain('lean-agent is set up.')
  expect(text).toContain('MCP servers that need a value')
  expect(text).toContain('plugin:datadog:mcp needs DD_MCP_DOMAIN')
  j(SETTINGS, { env: { DD_MCP_DOMAIN: S1 } })
  const after = await check(h.host, '/plug')
  expect(after).toContain('ok   no MCP server config references an unset variable')
  expect(after.join('\n')).not.toContain(S1)
})

// ---- fix: the settings env block -----------------------------------------------------------------------------------------
test('mcp-env writes the env block: merge, keep every user key, atomic, idempotent, the value is not echoed', async () => {
  const { h, j } = home()
  uses(j, 'DD_MCP_DOMAIN')
  j(SETTINGS, { permissions: { allow: ['Bash'] }, model: 'opus', env: { KEEP: '1' } })
  const r = await setSettingsEnv(h.host, H, 'DD_MCP_DOMAIN', S1)
  expect(r.ok).toBe(true)
  expect(r.text).not.toContain(S1)
  expect(JSON.parse(h.files.get(SETTINGS)!)).toEqual({ permissions: { allow: ['Bash'] }, model: 'opus', env: { KEEP: '1', DD_MCP_DOMAIN: S1 } })
  expect([...h.files.keys()].some(k => k.includes('.tmp-'))).toBe(false) // temp file moved over, none left
  expect(h.calls.some(c => c.argv[0] === 'mv' && c.argv[c.argv.length - 1] === SETTINGS)).toBe(true)
  const again = await setSettingsEnv(h.host, H, 'DD_MCP_DOMAIN', S1)
  expect(again.text).toContain('already set')
  expect(again.text).not.toContain(S1)
  const change = await setSettingsEnv(h.host, H, 'DD_MCP_DOMAIN', S4)
  expect(change.ok).toBe(true)
  expect(change.text).toContain('replaced') // the user's earlier value was overwritten: said, not hidden
  expect(change.text).not.toContain(S4)
  expect(JSON.parse(h.files.get(SETTINGS)!).env).toEqual({ KEEP: '1', DD_MCP_DOMAIN: S4 })
})

test('mcp-env creates ~/.claude/settings.json when there is none, and writes through a symlinked one', async () => {
  const a = home()
  uses(a.j, 'MY_SITE')
  expect((await setSettingsEnv(a.h.host, H, 'MY_SITE', 'x.example')).ok).toBe(true)
  expect(JSON.parse(a.h.files.get(SETTINGS)!)).toEqual({ env: { MY_SITE: 'x.example' } })
  const b = home()
  uses(b.j, 'MY_SITE')
  b.h.links.set(SETTINGS, '/dot/settings.json')
  b.j('/dot/settings.json', { theme: 'dark' })
  expect((await setSettingsEnv(b.h.host, H, 'MY_SITE', 'x.example')).ok).toBe(true)
  expect(b.h.links.get(SETTINGS)).toBe('/dot/settings.json') // the link survives
  expect(JSON.parse(b.h.files.get('/dot/settings.json')!)).toEqual({ theme: 'dark', env: { MY_SITE: 'x.example' } })
})

test('mcp-env refuses secret-looking names, reserved names, bad names and bad values; nothing is written', async () => {
  const { h, j } = home()
  j(SETTINGS, { env: { KEEP: '1' } })
  const secrets = ['DD_API_KEY', 'DD_APPLICATION_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AWS_CREDENTIALS', 'AUTH_HEADER', 'GH_PAT', 'github_pat', 'API_KEY_2', 'DD_PASSPHRASE', 'PASSCODE', 'AWS_CREDS', 'SESSION_ID', 'SLACK_WEBHOOK', 'SENTRY_DSN', 'DATABASE_URL', 'REDIS_URL', 'JWT', 'BEARER', 'COOKIE', 'GITHUBPAT', 'PAT1', 'CONNECTION_STRING', 'SIGNATURE']
  uses(j, ...secrets, 'MY_SITE', 'PIP_INDEX_URL', 'NODE_V8_COVERAGE', 'CLAUDE_CODE_DISABLE_1M_CONTEXT') // referenced by a config: the NAME is what refuses
  const before = h.files.get(SETTINGS)
  for (const n of secrets) {
    const r = await setSettingsEnv(h.host, H, n, 'v')
    expect([n, r.ok]).toEqual([n, false])
    expect(r.text).toContain('looks like a secret')
  }
  const reserved = ['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'HTTPS_PROXY', 'https_proxy', 'PIP_INDEX_URL', 'JAVA_TOOL_OPTIONS', 'PROMPT_COMMAND', 'ZDOTDIR', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'DISABLE_TELEMETRY', 'MCP_TIMEOUT', 'GOFLAGS']
  for (const n of reserved) expect([n, (await setSettingsEnv(h.host, H, n, 'v')).ok]).toEqual([n, false])
  for (const n of ['', '1ABC', 'A-B', 'A B', 'a'.repeat(65), 42, undefined]) expect((await setSettingsEnv(h.host, H, n, 'v')).ok).toBe(false)
  for (const v of ['', '   ', 'a\nb', 'a\x00b', 'x'.repeat(501), 5, undefined]) expect((await setSettingsEnv(h.host, H, 'MY_SITE', v)).ok).toBe(false)
  // a value that is a credential under an innocent name
  for (const v of ['postgres://u:p@h/db', 'https://user:pw@host.example', 'ghp_abcdefghijklmnop', 'sk-abc123', 'AKIAABCDEFGHIJKLMNOP', 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8']) {
    const r = await setSettingsEnv(h.host, H, 'MY_SITE', v)
    expect([v, r.ok, r.text.includes('looks like a credential'), r.text.includes(v)]).toEqual([v, false, true, false])
  }
  // an allowlist: a name no enabled MCP config references is not written, whatever it is called
  const none = await setSettingsEnv(h.host, H, 'SOME_SITE', 'x.example')
  expect(none.ok).toBe(false)
  expect(none.text).toContain('no enabled MCP server config references SOME_SITE')
  expect(h.files.get(SETTINGS)).toBe(before)
  expect(h.calls.some(c => c.argv[0] === 'mv')).toBe(false)
  expect([nameProblem('MY_SITE'), valueProblem('x.example'), looksSecret('DD_MCP_DOMAIN'), looksSecret('PATTERN')]).toEqual([null, null, false, false])
})

test('mcp-env leaves a settings.json that does not parse (or whose env is not an object) alone', async () => {
  const { h, j } = home()
  uses(j, 'MY_SITE')
  j(SETTINGS, '{ not json')
  const r = await setSettingsEnv(h.host, H, 'MY_SITE', 'x.example')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('does not parse')
  expect(h.files.get(SETTINGS)).toBe('{ not json')
  j(SETTINGS, { env: ['x'] })
  expect((await setSettingsEnv(h.host, H, 'MY_SITE', 'x.example')).text).toContain('not an object')
  expect(JSON.parse(h.files.get(SETTINGS)!)).toEqual({ env: ['x'] })
})

// ---- secrets: the command form, at thread start -----------------------------------------------------------------------------
function withKeyServer(j: (p: string, v: unknown) => void) {
  j('/h/.claude.json', { mcpServers: { dd: { url: 'https://${DD_MCP_DOMAIN:-x.example.com}/mcp', headers: { DD_API_KEY: '${DD_API_KEY:-}', Other: '${NOT_USED_NAME:-}' }, env: { T: '${CMD_TOKEN}' } } } })
}

test('threadEnv runs a stored command (string = fixed /bin/sh -c, list = argv, no shell), bounded, and returns the value; lines name names only', async () => {
  const { h, j } = home()
  withKeyServer(j)
  j(MCPENV, { DD_API_KEY: { command: 'pass show dd' }, CMD_TOKEN: { command: ['security', 'find-generic-password', '-w'] } })
  h.exec.handler = argv => (argv.join(' ') === '/bin/sh -c pass show dd' ? { exitCode: 0, stdout: `${S2}\n` } : argv[0] === 'security' ? { exitCode: 0, stdout: `${S3}\n` } : { exitCode: 1, stdout: '' })
  const t = await threadEnv(h.host, H)
  expect(t.env).toEqual({ DD_API_KEY: S2, CMD_TOKEN: S3 })
  const ran = h.calls.filter(c => c.argv[0] === '/bin/sh' || c.argv[0] === 'security')
  expect(ran.map(c => c.argv)).toEqual([['/bin/sh', '-c', 'pass show dd'], ['security', 'find-generic-password', '-w']])
  for (const c of ran) {
    expect(c.cwd).toBe(H)
    expect((c as any).env).toBeUndefined() // the mod's own environment is not rebuilt or extended
  }
  expect(t.lines).toEqual(['mcp env for this thread (names only): DD_API_KEY, CMD_TOKEN'])
  expect(JSON.stringify(t.lines)).not.toMatch(new RegExp(`${S2}|${S3}`))
})

test('threadEnv: a plain value works; a name the user settings env already sets is NOT run and NOT added (never shadows)', async () => {
  const { h, j } = home()
  withKeyServer(j)
  j(SETTINGS, { env: { DD_MCP_DOMAIN: S1, DD_API_KEY: 'user-has-it' } })
  j(MCPENV, { DD_MCP_DOMAIN: { value: 'other.example.com' }, CMD_TOKEN: { value: S2 }, DD_API_KEY: { command: 'false' } })
  let ran = 0
  h.exec.handler = () => {
    ran++
    return { exitCode: 0, stdout: 'x' }
  }
  const t = await threadEnv(h.host, H)
  expect(t.env).toEqual({ CMD_TOKEN: S2 })
  expect(ran).toBe(0) // DD_API_KEY is set by the user: its command never ran
})

test('threadEnv: a name no MCP config references, a reserved name and a bad command are skipped with a reason, never a value', async () => {
  const { h, j } = home()
  withKeyServer(j)
  j(MCPENV, { UNUSED_ONE: { value: S2 }, PATH: { value: '/evil' }, GIT_CONFIG_COUNT: { value: '9' }, DD_API_KEY: { command: 'exit 3' }, CMD_TOKEN: { command: 7 } })
  h.exec.handler = () => ({ exitCode: 3, stdout: S3, stderr: S3 })
  const t = await threadEnv(h.host, H)
  expect(t.env).toEqual({})
  expect(t.lines.join('\n')).toContain('UNUSED_ONE: no MCP server config uses it')
  expect(t.lines.join('\n')).toContain('DD_API_KEY: its command exited 3')
  expect(t.lines.join('\n')).toContain('CMD_TOKEN: command must be a string')
  expect(t.lines.join('\n')).not.toMatch(/PATH|GIT_CONFIG/)
  expect(t.lines.join('\n')).not.toMatch(new RegExp(`${S2}|${S3}`))
  h.exec.handler = () => ({ exitCode: 0, stdout: 'line1\nline2\n' })
  j(MCPENV, { DD_API_KEY: { command: 'echo' } })
  expect((await threadEnv(h.host, H)).lines.join('\n')).toContain('printed nothing usable')
  h.exec.handler = () => {
    throw new Error('timed out')
  }
  expect((await threadEnv(h.host, H)).lines.join('\n')).toContain('did not run or timed out')
})

test('threadEnv: a file somebody else owns is ignored (no command runs); a group-readable own file is tightened to 600 and used', async () => {
  const { h, j } = home()
  withKeyServer(j)
  j(MCPENV, { DD_API_KEY: { command: 'pass show dd' } })
  let ran = 0
  h.exec.handler = () => {
    ran++
    return { exitCode: 0, stdout: S2 }
  }
  h.perms.set(MCPENV, { uid: 0, mode: 0o600 })
  const a = await threadEnv(h.host, H)
  expect(a.env).toEqual({})
  expect(a.lines[0]).toContain('not your own user-only file')
  expect(ran).toBe(0)
  h.perms.set(MCPENV, { uid: 501, mode: 0o644 })
  const b = await threadEnv(h.host, H)
  expect(b.env).toEqual({ DD_API_KEY: S2 })
  expect(h.perms.get(MCPENV)!.mode).toBe(0o600)
  expect(h.calls.some(c => c.argv.join(' ') === `chmod 600 ${MCPENV}`)).toBe(true)
})

test('threadEnv: no mcp-env.json, or nothing in it, costs nothing and changes nothing', async () => {
  const { h, j } = home()
  withKeyServer(j)
  expect(await threadEnv(h.host, H)).toEqual({ env: {}, lines: [] })
  j(MCPENV, {})
  expect(await threadEnv(h.host, H)).toEqual({ env: {}, lines: [] })
  j(MCPENV, 'not json')
  expect(await threadEnv(h.host, H)).toEqual({ env: {}, lines: [] })
  expect(h.calls.some(c => c.argv[0] === 'stat' || c.argv[0] === '/bin/sh')).toBe(false)
})

test('writeThreadSettings with secrets: the file exists empty and user-only BEFORE the content is written', async () => {
  const { h } = home()
  const seen: unknown[] = []
  const host = { ...h.host, fs: { ...h.host.fs, write: async (p: string, t: string) => { seen.push([t === '' ? 'empty' : 'content', h.perms.get(p)?.mode]); return h.host.fs.write(p, t) } } }
  expect(await writeThreadSettings(host as any, '/h/t/.claude/settings.json', '{"env":{}}', true)).toBe(true)
  expect(seen).toEqual([['empty', undefined], ['content', 0o600]])
  expect(h.files.get('/h/t/.claude/settings.json')).toBe('{"env":{}}')
  const plain = home()
  await writeThreadSettings(plain.h.host, '/h/t/.claude/settings.json', '{}', false)
  expect(plain.h.calls.some(c => c.argv[0] === 'chmod')).toBe(false)
})

test('writeThreadSettings: a failing chmod, a throwing run, or a mode that stays loose never leave the secret in a loose file', async () => {
  const f = '/h/t/.claude/settings.json'
  const WITH = `{"env":{"X":"${S2}"}}`
  const PLAIN = '{"env":{}}'
  const failing = home()
  const a = { ...failing.h.host, process: { run: async (argv: string[], init?: any) => (argv[0] === 'chmod' ? { exitCode: 1, stdout: '', stderr: 'no' } : failing.h.host.process.run(argv, init)) } }
  expect(await writeThreadSettings(a as any, f, WITH, true, PLAIN)).toBe(false)
  expect(failing.h.files.get(f)).toBe(PLAIN)
  const throwing = home()
  const b = { ...throwing.h.host, process: { run: async (argv: string[], init?: any) => { if (argv[0] === 'chmod') throw new Error('boom'); return throwing.h.host.process.run(argv, init) } } }
  expect(await writeThreadSettings(b as any, f, WITH, true, PLAIN)).toBe(false)
  expect(throwing.h.files.get(f)).toBe(PLAIN)
  // an engine whose write replaces the file: the mode is lost after the content write, the second chmod restores it
  const replacing = home()
  const c = { ...replacing.h.host, fs: { ...replacing.h.host.fs, write: async (p: string, t: string) => { await replacing.h.host.fs.write(p, t); if (t !== '') replacing.h.perms.set(p, { uid: 501, mode: 0o644 }) } } }
  expect(await writeThreadSettings(c as any, f, WITH, true, PLAIN)).toBe(true)
  expect(replacing.h.perms.get(f)!.mode).toBe(0o600)
  expect(replacing.h.files.get(f)).toBe(WITH)
  // ... and when it stays loose whatever is done
  const loose = home()
  const d = { ...loose.h.host, process: { run: async (argv: string[], init?: any) => (argv[0] === 'chmod' ? { exitCode: 0, stdout: '', stderr: '' } : loose.h.host.process.run(argv, init)) }, fs: { ...loose.h.host.fs, write: async (p: string, t: string) => { await loose.h.host.fs.write(p, t); loose.h.perms.set(p, { uid: 501, mode: 0o644 }) } } }
  expect(await writeThreadSettings(d as any, f, WITH, true, PLAIN)).toBe(false)
  expect(loose.h.files.get(f)).toBe(PLAIN)
})

test('threadEnv judges a symlinked mcp-env.json by its target (stat -L), not by the link', async () => {
  const { h, j } = home()
  withKeyServer(j)
  j('/dot/mcp-env.json', { DD_API_KEY: { command: 'pass show dd' } })
  h.links.set(MCPENV, '/dot/mcp-env.json')
  h.perms.set('/dot/mcp-env.json', { uid: 0, mode: 0o666 }) // somebody else's, world-writable
  let ran = 0
  h.exec.handler = () => {
    ran++
    return { exitCode: 0, stdout: S2 }
  }
  const t = await threadEnv(h.host, H)
  expect(t.env).toEqual({})
  expect(ran).toBe(0)
  expect(h.calls.some(c => c.argv[0] === 'stat' && c.argv[1] === '-L')).toBe(true)
})

test('a part of a host is not a placeholder host; the whole host (with a port) is', async () => {
  const { h, j } = home()
  j('/h/.claude.json', { mcpServers: { a: { url: 'https://${SUB:-api}.example.com/x' }, b: { url: 'https://${HOSTV:-prod}:8443/x' } } })
  expect((await mcpNeeds(h.host, H)).map(n => n.server)).toEqual(['user:b'])
})

test('a synced plugin\'s generation that is not a plain word is never put into a path', async () => {
  const { h, j } = home()
  synced(j)
  j(`${SYNC}/manifest.json`, { plugins: [{ name: '16a0', generation: '../x' }] })
  expect(await mcpRows(h.host, H)).toEqual([])
  j(`${SYNC}/manifest.json`, { plugins: [{ name: '16a0', generation: { a: 1 } }] })
  expect(await mcpRows(h.host, H)).toEqual([])
})

test('a thread start whose settings file cannot be made user-only still starts, without the variables, and says so', async () => {
  const { h, j } = home()
  threads(j, h)
  withKeyServer(j)
  j(MCPENV, { DD_API_KEY: { command: 'pass show dd' } })
  h.exec.handler = () => ({ exitCode: 0, stdout: `${S2}\n` })
  const host = { ...h.host, process: { run: async (argv: string[], init?: any) => (argv[0] === 'chmod' && argv[1] === '600' && String(argv[2]).endsWith('.claude/settings.json') ? { exitCode: 1, stdout: '', stderr: 'no' } : h.host.process.run(argv, init)) } }
  const r = await leanThread(host as any, '/p', { action: 'new', title: 'x', text: 'do it' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('could not be made user-only')
  expect(r.text).not.toContain(S2)
  const f = '/h/.lean-agent/threads/t1/.claude/settings.json'
  expect(h.files.get(f)).not.toContain(S2)
  expect(Object.keys(JSON.parse(h.files.get(f)!).env).sort()).toEqual(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
})

const SID = '11111111-2222-3333-4444-555555555555'
function threads(j: (p: string, v: unknown) => void, h: any) {
  j('/p/templates/thread.md', '# {{id}} {{title}}')
  j('/p/templates/front-desk.md', 'desk {{lean}}')
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : { exitCode: 0, stdout: '[]' })
  return (i: any) => leanThread(h.host, '/p', i)
}

test('a thread start puts the command\'s value into THAT thread\'s settings env, merged with the git hooks env, user-only; the reply names names', async () => {
  const { h, j } = home()
  const call = threads(j, h)
  withKeyServer(j)
  j(MCPENV, { DD_API_KEY: { command: 'pass show dd' } })
  h.exec.handler = argv => (argv[0] === '/bin/sh' ? { exitCode: 0, stdout: `${S2}\n` } : { exitCode: 1, stdout: '' })
  const r = await call({ action: 'new', title: 'x', text: 'do it' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('mcp env for this thread (names only): DD_API_KEY')
  expect(r.text).not.toContain(S2)
  const f = '/h/.lean-agent/threads/t1/.claude/settings.json'
  const s = JSON.parse(h.files.get(f)!)
  expect(s.env).toEqual({ DD_API_KEY: S2, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/h/.lean-agent/githooks' })
  expect(h.perms.get(f)!.mode).toBe(0o600)
  expect(JSON.stringify(h.calls)).not.toContain(S2) // never in a process argument
  // no other file carries the value
  for (const [k, v] of h.files) if (k !== f) expect([k, v.includes(S2)]).toEqual([k, false])
})

test('a thread start with the name in the user settings env leaves it out of the thread settings; failures are lines, never a failed start', async () => {
  const { h, j } = home()
  const call = threads(j, h)
  withKeyServer(j)
  j(SETTINGS, { env: { DD_API_KEY: 'theirs' } })
  j(MCPENV, { DD_API_KEY: { command: 'pass show dd' }, CMD_TOKEN: { command: 'false' } })
  h.exec.handler = () => ({ exitCode: 1, stdout: '' })
  const r = await call({ action: 'new', title: 'x', text: 'do it' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('CMD_TOKEN: its command exited 1')
  const s = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/.claude/settings.json')!)
  expect(Object.keys(s.env).sort()).toEqual(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
})

// ---- migration: 0.45's mcp-env.json ------------------------------------------------------------------------------------------
test('0.45 import: plain non-secret values go into the settings env block once (names told); commands and secrets stay in mcp-env.json', async () => {
  const { h, j } = home()
  j(SETTINGS, { env: { OLD_THEIRS: 'mine' }, model: 'opus' })
  uses(j, 'SITE', 'OLD_THEIRS', 'LEG_SITE', 'API_KEY', 'GH')
  j(MCPENV, { SITE: { value: S1 }, OLD_THEIRS: { value: 'from-045' }, API_KEY: { value: S2 }, GH: { command: 'gh auth token' }, UNUSED_SITE: { value: 'u.example' }, TOKEN_LIKE: { value: 'ghp_abcdefghijklmnop' }, JUNK: 5 })
  j('/h/.lean-agent/legacy-0.45/mcp-env.json', { LEG_SITE: { value: S4 }, SITE: { value: 'old.example' } })
  const lines = await tidyLegacy(h.host)
  expect(JSON.parse(h.files.get(SETTINGS)!)).toEqual({ env: { OLD_THEIRS: 'mine', SITE: S1, LEG_SITE: S4 }, model: 'opus' }) // the user's own value kept, mcp-env.json wins over legacy
  const text = lines.join('\n')
  expect(text).toContain('moved into the env block of ~/.claude/settings.json (every session gets them): SITE, LEG_SITE')
  expect(text).toContain('kept in ~/.lean-agent/mcp-env.json (a secret, a command, or no MCP server config uses the name): API_KEY, GH, UNUSED_SITE, TOKEN_LIKE')
  expect(text).not.toMatch(new RegExp(`${S1}|${S2}|${S4}|from-045|gh auth|ghp_abc|u\\.example`))
  expect(JSON.parse(h.files.get(MCPENV)!).API_KEY).toEqual({ value: S2 }) // untouched
  expect(JSON.parse(h.files.get(MCPENV)!).GH).toEqual({ command: 'gh auth token' })
  expect(JSON.stringify(h.calls)).not.toMatch(new RegExp(`${S1}|${S2}|${S4}`))
  // once: the version gate holds, a second run does nothing
  expect(await tidyLegacy(h.host)).toEqual([])
  // the doctor says what happened, names only
  const note = (await check(h.host, '/plug')).find(l => l.includes('0.45 mcp-env.json'))!
  expect(note).toBe('ok   0.45 mcp-env.json: moved to settings env: SITE, LEG_SITE; kept in mcp-env.json: API_KEY, GH, UNUSED_SITE, TOKEN_LIKE')
})

test('0.45 import: nothing to import is silent; an unparsable settings.json keeps the import pending and says what to do', async () => {
  const quiet = home()
  expect(await tidyLegacy(quiet.h.host)).toEqual([])
  const { h, j } = home()
  uses(j, 'SITE')
  j(SETTINGS, '{ broken')
  j(MCPENV, { SITE: { value: S1 } })
  const lines = (await tidyLegacy(h.host)).join('\n')
  expect(lines).toContain('could not be updated')
  expect(lines).toContain('lean_doctor migrate')
  expect(h.files.get(SETTINGS)).toBe('{ broken')
  expect(h.store.get('tidy.v')).toBeUndefined() // tried again at the next start
  j(SETTINGS, {})
  expect((await tidyLegacy(h.host)).join('\n')).toContain('moved into the env block')
  expect(JSON.parse(h.files.get(SETTINGS)!).env.SITE).toBe(S1)
})

// ---- values never in logs, reports or the export ------------------------------------------------------------------------------
test('no value reaches a check, a report, the export, a log or a file it was not meant for', async () => {
  const { h, j } = home()
  const call = threads(j, h)
  j('/p/.claude-plugin/plugin.json', { version: '1.0.4' })
  j('/h/.claude.json', { mcpServers: { a: { url: 'https://${SITE_VAR}/x', headers: { T: '${SEC_TOKEN}', C: '${CMD_VAR}' } }, b: { url: 'https://${OTHER_VAR:-not-setup}/x' } } })
  j(SETTINGS, { env: { SITE_VAR: S1 } })
  j(MCPENV, { SEC_TOKEN: { value: S2 }, CMD_VAR: { command: 'print-it' } })
  h.exec.handler = argv => (argv[0] === '/bin/sh' ? { exitCode: 0, stdout: `${S3}\n` } : { exitCode: 1, stdout: '' })
  const out: string[] = []
  out.push(...(await mcpRows(h.host, H)), ...(await check(h.host, '/p')))
  out.push((await setSettingsEnv(h.host, H, 'OTHER_VAR', S4)).text, (await setSettingsEnv(h.host, H, 'NEW_TOKEN', S4)).text)
  out.push((await call({ action: 'new', title: 'x', text: 'do it' })).text)
  const ex = await exportFeedback(h.host, '/p', { version: '1.0.4', notes: 'n' })
  out.push(ex.text)
  const secrets = [S1, S2, S3, S4]
  for (const s of secrets) expect([s, out.join('\n').includes(s)]).toEqual([s, false])
  const meant = new Set([SETTINGS, MCPENV, '/h/.lean-agent/threads/t1/.claude/settings.json'])
  for (const [k, v] of h.files) if (!meant.has(k)) for (const s of secrets) expect([k, s, v.includes(s)]).toEqual([k, s, false])
  expect(JSON.stringify(h.calls)).not.toMatch(new RegExp(secrets.join('|')))
  expect(ex.ok).toBe(true)
})

// ---- the desk's tool ------------------------------------------------------------------------------------------------------------
const PLUGIN = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
async function desk($: any, on: any) {
  resetFolderLocks()
  resetLocks()
  resetViewCache()
  const h = fakeHost(on)
  const j = (p: string, v: unknown) => h.files.set(p, typeof v === 'string' ? v : JSON.stringify(v))
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', () => ({ value: { cancel() {} } }))
  j(`${PLUGIN}/templates/front-desk.md`, 'desk {{lean}}')
  j(`${PLUGIN}/templates/thread.md`, '# {{id}}')
  j(`${PLUGIN}/.claude-plugin/plugin.json`, { version: '1.0.4' })
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327' : a[0] === 'agents' ? '[]' : '' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  return { h, j }
}

test('lean_doctor mcp-env (desk): lists what needs a value; with name + value writes the env block, replies without the value; a secret name is an error', async ($, on) => {
  const { h, j } = await desk($, on)
  synced(j)
  const list: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'mcp-env' } as any)
  expect(list.result).toContain('plugin:datadog:mcp needs DD_MCP_DOMAIN')
  const ok: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'mcp-env', name: 'DD_MCP_DOMAIN', value: S1 } as any)
  expect(ok.isError).toBeUndefined()
  expect(ok.result).not.toContain(S1)
  expect(JSON.parse(h.files.get(SETTINGS)!).env).toEqual({ DD_MCP_DOMAIN: S1 })
  const after: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'mcp-env' } as any)
  expect(after.result).toBe('no MCP server config references an unset variable')
  const bad: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'mcp-env', name: 'DD_API_KEY', value: S2 } as any)
  expect(bad.isError).toBe(true)
  expect(bad.result).toContain('looks like a secret')
  expect(bad.result).not.toContain(S2)
  expect(JSON.parse(h.files.get(SETTINGS)!).env.DD_API_KEY).toBeUndefined()
})
