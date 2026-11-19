// MCP servers that need a variable (a site, a domain, a token). A plugin's MCP config can say `https://${DD_MCP_DOMAIN:-not-setup}/..`:
// Claude Code fills `${VAR}` from the session's environment, and the desk (started by the Claude app) and every thread are NOT started
// from the user's shell, so a variable exported in ~/.zshrc never reaches them. What a session does get is the `env` block of
// ~/.claude/settings.json (user settings), which Claude Code puts into its environment for every session: app, terminal, desk, threads.
//
// This module is the whole feature, all of it plain code (no model reads configs or values):
//   detect   mcpRows        which enabled plugin / user / project MCP servers reference an unset ${VAR} (names only, never values)
//   fix      setSettingsEnv a NON-secret value into the user settings env block (merge, atomic; secret-looking names refused)
//   secrets  threadEnv      ~/.lean-agent/mcp-env.json `{"NAME": {"command": ...}}` (0.45's form): at THREAD start the command runs
//                           (bounded) and the value goes into that thread's own settings env, never into a shared file
//   migrate  importMcpEnv   0.45's plain non-secret values move into the settings env block once
// Verified live (Claude Code 2.1.328, a user-scope http server whose URL host is ${VAR:-default}): a variable in the user settings env
// resolves it; a variable in a project's .claude/settings.json env resolves it too when the user block lacks it; with both set the USER
// value wins. So a thread's env fills gaps and never shadows the user's, and threadEnv skips names the user block already sets.
import { atomicWrite, dirOf, deskDir, leanDir, mkdirp, readJson, realPath, writeJson } from './state'
import type { Host } from './state'
import { withFolderLock } from './folderlock'

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const MAX_FILE = 8 * 1024 * 1024 // ~/.claude.json can be large; a config bigger than this is not read
const claudeDir = (home: string) => `${home}/.claude`
export const userSettingsPath = (home: string) => `${claudeDir(home)}/settings.json`
export const mcpEnvPath = (home: string) => `${leanDir(home)}/mcp-env.json`
const LEGACY_ENV = (home: string) => `${leanDir(home)}/legacy-0.45/mcp-env.json`

// ---- names and values ------------------------------------------------------------------------------------------------
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
// a name that looks like a credential: never written to a settings file (settings.json is plain text, often synced or committed)
const SECRET_RE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|(^|_)(PAT|PWD|PASS|PRIVATE)(_|$)/i
export const looksSecret = (name: string) => SECRET_RE.test(name)
// names that change how every session runs (search path, runtime, git, proxies, Claude's own): never written by this feature
const RESERVED = /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TERM|LANG|LANGUAGE|LC_[A-Z_]+|IFS|ENV|BASH_ENV|PS[1-4]|SHLVL|EDITOR|VISUAL|PAGER|NODE_[A-Z_]+|NPM_[A-Z_]*|LD_[A-Z_]+|DYLD_[A-Z_]+|PYTHON[A-Z_]*|RUBY[A-Z_]*|PERL[A-Z_0-9]*|GIT_[A-Z_0-9]+|ANTHROPIC_[A-Z_]+|CLAUDE[A-Z_]*|(?:HTTPS?|ALL|NO|FTP)_PROXY|SSL_CERT_[A-Z]+|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|OPENSSL_[A-Z_]+)$/i
// variables a session always has (or Claude Code itself fills in a plugin config): never reported as missing
const PROVIDED = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'PWD', 'TMPDIR', 'LANG', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR'])

export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'a variable name is letters, digits and underscores (at most 64), not starting with a digit'
  if (RESERVED.test(name)) return `${name} is reserved (it changes how every session runs): not written`
  return null
}
export function valueProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'the value is empty'
  if (value.length > 500) return 'the value is longer than 500 characters'
  if (/[\x00-\x1f\x7f]/.test(value)) return 'the value has a line break or control character'
  return null
}

// ---- reading configs ---------------------------------------------------------------------------------------------------
async function readObj(h: Host, path: string): Promise<Record<string, any> | null> {
  try {
    const st = await h.fs.stat(path)
    if (Number(st?.size) > MAX_FILE) return null
    const t = await h.fs.read(path)
    if (typeof t !== 'string' || !t.trim()) return null
    const v = JSON.parse(t)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}
const envBlock = (doc: Record<string, any> | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (isObj(doc?.env)) for (const [k, v] of Object.entries(doc!.env)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  return out
}
// the variables a desk session has: the user settings env block plus the desk folder's own (project settings). NOT the shell.
async function setNames(h: Host, home: string, files: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const f of files) for (const [k, v] of Object.entries(envBlock(await readObj(h, f)))) if (v !== '') out.add(k) // an empty value falls back to the default, like unset
  return out
}

// ---- finding the servers -----------------------------------------------------------------------------------------------
type Ref = { name: string; dflt: string | null; host: boolean } // dflt: null = no default (`${VAR}`); host: sits in the URL's host part
export type Server = { id: string; refs: Ref[] }
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1)
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out, depth + 1)
  return out
}
export function refsOf(cfg: unknown): Ref[] {
  const hostPart = isObj(cfg) && typeof cfg.url === 'string' ? (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(cfg.url)?.[1] ?? '') : ''
  const byName = new Map<string, Ref>()
  for (const s of strings(cfg))
    for (const m of s.matchAll(REF_RE)) {
      const name = m[1]!
      if (PROVIDED.has(name)) continue
      const inHost = hostPart.includes(m[0])
      const prev = byName.get(name)
      const dflt = m[2] ?? null
      if (!prev) byName.set(name, { name, dflt, host: inHost })
      else byName.set(name, { name, dflt: prev.dflt === null || dflt === null ? null : prev.dflt || dflt, host: prev.host || inHost }) // one use without a default makes it required
    }
  return [...byName.values()]
}

type Plugin = { id: string; name: string; root: string }
// enabled plugins: installed ones switched on in the user settings, and plugins synced from claude.ai (on unless switched off)
async function enabledPlugins(h: Host, home: string): Promise<Plugin[]> {
  const settings = (await readObj(h, userSettingsPath(home))) ?? {}
  const sw = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const out: Plugin[] = []
  const inst = await readObj(h, `${claudeDir(home)}/plugins/installed_plugins.json`)
  for (const [id, recs] of Object.entries(isObj(inst?.plugins) ? inst!.plugins : {})) {
    if (sw[id] !== true) continue
    for (const rec of Array.isArray(recs) ? recs : [recs]) {
      if (!isObj(rec) || typeof rec.installPath !== 'string' || !rec.installPath || (rec.scope && rec.scope !== 'user')) continue
      const named = (await readObj(h, `${rec.installPath}/.claude-plugin/plugin.json`))?.name // Claude Code names its servers by the manifest's name
      out.push({ id, name: typeof named === 'string' && named ? named : (id.split('@')[0] ?? id), root: rec.installPath })
      break
    }
  }
  const syncedDir = `${claudeDir(home)}/plugins/synced`
  for (const b of await h.fs.list(syncedDir).catch(() => [] as { name: string; kind: string }[])) {
    if (b.kind !== 'dir') continue
    const man = await readObj(h, `${syncedDir}/${b.name}/manifest.json`)
    for (const rec of Array.isArray(man?.plugins) ? man!.plugins : []) {
      if (!isObj(rec) || typeof rec.name !== 'string' || !rec.name || /[/\\]|\.\./.test(rec.name)) continue
      // a synced plugin lives in <bucket>/<name>~g<generation> (older layouts: <bucket>/<name>)
      const dirs = [...(rec.generation !== undefined ? [`${rec.name}~g${rec.generation}`] : []), rec.name]
      let root = ''
      for (const d of dirs) if (!root && (await h.fs.exists(`${syncedDir}/${b.name}/${d}`).catch(() => false))) root = `${syncedDir}/${b.name}/${d}`
      if (!root) continue
      const name = (await readObj(h, `${root}/.claude-plugin/plugin.json`))?.name
      const pname = typeof name === 'string' && name ? name : rec.name
      if (sw[`${pname}@synced`] === false) continue
      out.push({ id: `${pname}@synced`, name: pname, root })
    }
  }
  return out
}

// the MCP servers a plugin declares: plugin.json `mcpServers` (a path inside the plugin, an inline map, or a list of those) and the
// default .mcp.json at the plugin's root
async function pluginServers(h: Host, p: Plugin): Promise<Record<string, any>> {
  const manifest = (await readObj(h, `${p.root}/.claude-plugin/plugin.json`)) ?? {}
  const decl: unknown[] = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers !== undefined ? [manifest.mcpServers] : []
  const items: unknown[] = [...decl, './.mcp.json']
  const out: Record<string, any> = {}
  for (let item of items) {
    if (typeof item === 'string') {
      const rel = item.replace(/^\.\//, '')
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue // only a file inside the plugin
      item = await readObj(h, `${p.root}/${rel}`)
    }
    if (!isObj(item)) continue
    const map = isObj(item.mcpServers) ? item.mcpServers : item
    for (const [k, v] of Object.entries(map)) if (isObj(v) && !(k in out)) out[k] = v
  }
  return out
}

export async function scanServers(h: Host, home: string): Promise<Server[]> {
  const out: Server[] = []
  const add = (id: string, cfg: unknown) => {
    const refs = refsOf(cfg)
    if (refs.length) out.push({ id, refs })
  }
  for (const p of await enabledPlugins(h, home)) for (const [name, cfg] of Object.entries(await pluginServers(h, p))) add(`plugin:${p.name}:${name}`, cfg)
  const doc = await readObj(h, `${home}/.claude.json`)
  if (isObj(doc?.mcpServers)) for (const [name, cfg] of Object.entries(doc!.mcpServers)) add(`user:${name}`, cfg)
  const projects = await readJson<Record<string, any>>(h, `${leanDir(home)}/projects.json`, {})
  for (const [pname, v] of Object.entries(isObj(projects) ? projects : {})) {
    if (!isObj(v) || typeof v.path !== 'string' || !v.path.startsWith('/')) continue
    const mj = await readObj(h, `${v.path}/.mcp.json`)
    if (isObj(mj?.mcpServers)) for (const [name, cfg] of Object.entries(mj!.mcpServers)) add(`project:${pname}:${name}`, cfg)
  }
  return out
}

// ---- detect ------------------------------------------------------------------------------------------------------------
// a default that cannot be a real value: a placeholder word, or a bare host (no dot) in a URL's host part
const PLACEHOLDER = /^(?:not[-_ ]?set(?:[-_ ]?up)?|unset|none|changeme|change[-_]me|placeholder|replace[-_]?me|todo|tbd|example|your[-_\w.]*|x{3,}|<.*>)$/i
const bareHost = (d: string) => !d.includes('.') && !d.includes(':') && !/^localhost$/i.test(d) && !/^\d+$/.test(d)
export type Need = { server: string; vars: { name: string; why: string }[] }

async function fileNames(h: Host, home: string): Promise<Set<string>> {
  const f = await readJson<Record<string, unknown>>(h, mcpEnvPath(home), {})
  return new Set(Object.keys(isObj(f) ? f : {}))
}

export async function mcpNeeds(h: Host, home: string): Promise<Need[]> {
  const have = await setNames(h, home, [userSettingsPath(home), `${deskDir(home)}/.claude/settings.json`])
  const inFile = await fileNames(h, home)
  const out: Need[] = []
  for (const s of await scanServers(h, home)) {
    const vars: Need['vars'] = []
    for (const r of s.refs) {
      if (have.has(r.name)) continue
      const tail = inFile.has(r.name) ? '; threads get it from mcp-env.json, the desk and the app do not' : ''
      if (r.dflt === null) {
        vars.push({ name: r.name, why: `unset: the server will not start${looksSecret(r.name) ? '; it looks secret, so sign in through the server (OAuth) or use a command in mcp-env.json, never settings.json' : ''}${tail}` })
      } else if (r.dflt !== '' && (PLACEHOLDER.test(r.dflt) || (r.host && bareHost(r.dflt)))) {
        vars.push({ name: r.name, why: `unset: it falls back to ${/^[\w.-]{1,40}$/.test(r.dflt) ? `'${r.dflt}', ` : ''}a placeholder, so the server cannot connect${tail}` })
      }
      // an empty default or a usable default needs nothing
    }
    if (vars.length) out.push({ server: s.id, vars })
  }
  return out
}

export const HOW = 'set a non-secret value with lean_doctor mcp-env NAME VALUE (it goes into the env block of ~/.claude/settings.json: every new session gets it); never a secret there (README: MCP servers that need a variable)'
// the doctor's `MCP ` rows (not FIX rows: nothing in lean-agent is broken, a server is not configured)
export async function mcpRows(h: Host, home: string): Promise<string[]> {
  const needs = await mcpNeeds(h, home)
  if (!needs.length) return []
  return [...needs.map(n => `MCP  ${n.server} needs ${n.vars.map(v => `${v.name} (${v.why})`).join(', ')}`), `MCP  ${HOW}`]
}

// ---- fix: a non-secret value into the user settings env block -------------------------------------------------------------
export async function setSettingsEnv(h: Host, home: string, name: unknown, value: unknown): Promise<{ ok: boolean; text: string }> {
  const bad = nameProblem(name) ?? valueProblem(value)
  if (bad) return { ok: false, text: `mcp-env: ${bad}` }
  const n = name as string
  if (looksSecret(n)) return { ok: false, text: `mcp-env: ${n} looks like a secret (key, token, password...) and settings.json is plain text: not written. Sign in through the server (OAuth), or keep it out of files with a command in ~/.lean-agent/mcp-env.json (README: MCP servers that need a variable).` }
  const file = userSettingsPath(home)
  const lock = `${leanDir(home)}/.settings-lock`
  try {
    return await withFolderLock(h, lock, async () => {
      const real = await realPath(h, file) // a settings.json that is a symlink (dotfiles) is written through, never replaced
      let cur: Record<string, any> = {}
      if (await h.fs.exists(real)) {
        let t: unknown
        try {
          t = await h.fs.read(real)
        } catch {
          return { ok: false, text: 'mcp-env: ~/.claude/settings.json cannot be read: nothing written' }
        }
        if (typeof t !== 'string') return { ok: false, text: 'mcp-env: ~/.claude/settings.json is not text: nothing written' }
        if (t.trim()) {
          try {
            const v = JSON.parse(t)
            if (!isObj(v)) throw new Error('not an object')
            cur = v
          } catch {
            return { ok: false, text: 'mcp-env: ~/.claude/settings.json does not parse: fix the file by hand, nothing written' }
          }
        }
      }
      if (cur.env !== undefined && !isObj(cur.env)) return { ok: false, text: 'mcp-env: the "env" key of ~/.claude/settings.json is not an object: fix it by hand, nothing written' }
      const env = isObj(cur.env) ? cur.env : {}
      if (env[n] === value) return { ok: true, text: `${n} is already set in the env block of ~/.claude/settings.json (value not shown).` }
      const next = { ...cur, env: { ...env, [n]: value } }
      await mkdirp(h, dirOf(real))
      await atomicWrite(h, real, JSON.stringify(next, null, 2) + '\n')
      return { ok: true, text: `${n} set in the env block of ~/.claude/settings.json (value not shown). Sessions started from now on get it; a session already running keeps its old environment, so the desk needs a new session before its MCP server uses it.` }
    })
  } catch (e) {
    return { ok: false, text: `mcp-env failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
  }
}

// ---- who owns a file (mcp-env.json holds commands and secrets: only the user's own, user-only file is used) --------------------
async function facts(h: Host, path: string): Promise<{ uid: number; mode: number } | null> {
  const tries = [['stat', '-c', '%u %a', path], ['stat', '-f', '%u %Lp', path]] // GNU, then BSD (macOS)
  for (const argv of tries) {
    const r = await h.process.run(argv).catch(() => null)
    const m = r && r.exitCode === 0 ? /^(\d+) ([0-7]+)\s*$/.exec(r.stdout) : null
    if (m) return { uid: Number(m[1]), mode: parseInt(m[2]!, 8) }
  }
  return null
}
// true when the file is the user's own; a group/other-accessible file is tightened to 600 first
async function userOnly(h: Host, path: string): Promise<boolean> {
  const f = await facts(h, path)
  if (!f) return false
  const me = await h.process.run(['id', '-u']).catch(() => null)
  if (!me || me.exitCode !== 0 || Number(me.stdout.trim()) !== f.uid) return false
  if (f.mode & 0o077) return (await h.process.run(['chmod', '600', path]).catch(() => ({ exitCode: 1 }))).exitCode === 0
  return true
}

// ---- thread start: the values for a thread's own settings env ---------------------------------------------------------------
export type ThreadEnv = { env: Record<string, string>; lines: string[] }
const MAX_COMMANDS = 8
const COMMAND_MS = 15_000
const MAX_VALUE = 4096

// What mcp-env.json adds to a thread's settings env. Only names an MCP server config references, only names the user settings env
// does not already set (the user's value wins in Claude Code and must never be shadowed), only a file that is the user's own.
// `command` is a string (run as `/bin/sh -c <string>`: the user wrote it, no value is ever put into it) or an argv list (no shell).
// The output is the value (one line); it is never logged: the lines returned name names and say what happened, nothing else.
export async function threadEnv(h: Host, home: string): Promise<ThreadEnv> {
  const none: ThreadEnv = { env: {}, lines: [] }
  const file = mcpEnvPath(home)
  if (!(await h.fs.exists(file).catch(() => false))) return none
  const doc = await readJson<Record<string, any>>(h, file, {})
  const entries = Object.entries(isObj(doc) ? doc : {}).filter(([, v]) => isObj(v) && (typeof v.value === 'string' || v.command !== undefined))
  if (!entries.length) return none
  if (!(await userOnly(h, file))) return { env: {}, lines: ['mcp-env.json is not your own user-only file (owner or permissions): ignored, chmod 600 it'] }
  const userSet = await setNames(h, home, [userSettingsPath(home)])
  const referenced = new Set((await scanServers(h, home)).flatMap(s => s.refs.map(r => r.name)))
  const env: Record<string, string> = {}
  const lines: string[] = []
  let ran = 0
  for (const [name, rec] of entries) {
    if (nameProblem(name) || userSet.has(name)) continue
    if (!referenced.has(name)) {
      lines.push(`mcp-env.json ${name}: no MCP server config uses it, skipped`)
      continue
    }
    if (typeof rec.value === 'string') {
      const bad = valueProblem(rec.value)
      if (bad) lines.push(`mcp-env.json ${name}: ${bad}, skipped`)
      else env[name] = rec.value
      continue
    }
    const argv = commandArgv(rec.command)
    if (!argv) {
      lines.push(`mcp-env.json ${name}: command must be a string or a list of strings, skipped`)
      continue
    }
    if (++ran > MAX_COMMANDS) {
      lines.push(`mcp-env.json ${name}: more than ${MAX_COMMANDS} commands, skipped`)
      continue
    }
    const r = await h.process.run(argv, { cwd: home, timeoutMs: COMMAND_MS, stdin: '' }).catch(() => null)
    const out = r && r.exitCode === 0 ? String(r.stdout ?? '').trim() : ''
    if (!out || out.length > MAX_VALUE || /[\x00-\x1f\x7f]/.test(out)) lines.push(`mcp-env.json ${name}: its command ${r ? (r.exitCode === 0 ? 'printed nothing usable (one line expected)' : `exited ${r.exitCode}`) : 'did not run or timed out'}, skipped`)
    else env[name] = out
  }
  const names = Object.keys(env)
  if (names.length) lines.unshift(`mcp env for this thread (names only): ${names.join(', ')}`)
  return { env, lines }
}

function commandArgv(c: unknown): string[] | null {
  if (typeof c === 'string') return c.trim() && c.length <= 1000 && !/[\x00\r\n]/.test(c) ? ['/bin/sh', '-c', c] : null
  if (Array.isArray(c) && c.length > 0 && c.length <= 20 && c.every(x => typeof x === 'string' && !x.includes('\x00')) && c[0]) return c as string[]
  return null
}

// A thread's settings file: with secrets in it the file is created empty, tightened to user-only, and only then filled.
export async function writeThreadSettings(h: Host, path: string, text: string, secret: boolean): Promise<void> {
  if (!secret) return h.fs.write(path, text)
  await h.fs.write(path, '')
  await h.process.run(['chmod', '600', path])
  await h.fs.write(path, text)
}

// ---- migration: 0.45's mcp-env.json ------------------------------------------------------------------------------------------
// Plain non-secret values go into the settings env block once (a name the block already sets is left alone). Command entries and
// anything secret-looking stay in mcp-env.json (made user-only). Returns the lines to tell the user (names only) and whether to retry.
export async function importMcpEnv(h: Host, home: string): Promise<{ lines: string[]; retry: boolean }> {
  const main = await readJson<Record<string, any>>(h, mcpEnvPath(home), {})
  const old = await readJson<Record<string, any>>(h, LEGACY_ENV(home), {})
  const all: Record<string, any> = { ...(isObj(main) ? main : {}) } // the live file first; the archived one only adds names it lacks
  for (const [k, v] of Object.entries(isObj(old) ? old : {})) if (!(k in all)) all[k] = v
  const names = Object.keys(all).filter(k => isObj(all[k]))
  if (!names.length) return { lines: [], retry: false }
  if (await h.fs.exists(mcpEnvPath(home)).catch(() => false)) await userOnly(h, mcpEnvPath(home))
  const have = await setNames(h, home, [userSettingsPath(home)])
  const imported: string[] = []
  const kept: string[] = []
  let retry = false
  for (const name of names) {
    const rec = all[name]
    const plain = typeof rec.value === 'string' && rec.value !== ''
    if (!plain || looksSecret(name) || nameProblem(name) || valueProblem(rec.value)) {
      kept.push(name)
      continue
    }
    if (have.has(name)) continue // the user already set it: theirs wins, nothing to do
    const r = await setSettingsEnv(h, home, name, rec.value)
    if (r.ok) imported.push(name)
    else {
      retry = true
      kept.push(name)
    }
  }
  const lines: string[] = []
  if (imported.length) lines.push(`0.45 mcp-env.json: moved into the env block of ~/.claude/settings.json (every session gets them): ${imported.join(', ')}`)
  if (kept.length) lines.push(`0.45 mcp-env.json: kept in ~/.lean-agent/mcp-env.json (secret, a command, or not writable): ${kept.join(', ')}; threads read them at start`)
  if (retry) lines.push('0.45 mcp-env.json: ~/.claude/settings.json could not be updated (does not parse?): fix it, then run lean_doctor migrate')
  if (imported.length || kept.length) await writeJson(h, `${leanDir(home)}/mcp-env-import.json`, { imported, kept }).catch(() => undefined)
  return { lines, retry }
}

// the doctor's one line about what the import did (names only)
export async function importNote(h: Host, home: string): Promise<string | null> {
  const r = await readJson<{ imported?: string[]; kept?: string[] }>(h, `${leanDir(home)}/mcp-env-import.json`, {})
  const i = Array.isArray(r.imported) ? r.imported : []
  const k = Array.isArray(r.kept) ? r.kept : []
  if (!i.length && !k.length) return null
  return `0.45 mcp-env.json: ${i.length ? `moved to settings env: ${i.join(', ')}` : 'nothing moved to settings env'}${k.length ? `; kept in mcp-env.json: ${k.join(', ')}` : ''}`
}
