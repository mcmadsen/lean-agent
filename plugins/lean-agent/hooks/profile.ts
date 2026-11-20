// Project profiles: which MCP servers and plugins a project's threads load (an allow-list), learned from what threads really used.
//
//   ~/.lean-agent/<project>/profile.json   { mcp?: string[], plugins?: string[], at, source }   the project's allow-list
//   ~/.lean-agent/threads/tN/loaded.json   { mcp: string[]|null, plugins: string[]|null, needs: string[] }   what tN was started with
//   ~/.lean-agent/threads/tN/usage.json    { mcp: {server: calls}, skills: {skill: calls} }   a counter: names and counts, never arguments
//
// No profile (or a list left out of it) = today's behaviour: nothing is held back. A list in the profile is an allow-list:
//  - MCP servers outside it are DEFERRED (the thread's mod answers `tool.describe` with isDeferred: true): their names stay
//    findable through ToolSearch, so a thread that unexpectedly needs one still gets it. Nothing is removed. A server's tools
//    are matched by the server part of `mcp__<server>__<tool>`; lean-agent's own server is never touched.
//  - plugins outside it are switched off for the thread (`enabledPlugins` in the thread folder's settings), except lean-agent
//    itself and a plugin that brings an MCP server (switching it off would remove the server instead of deferring it).
// `needs` (lean_thread new/start/reopen) adds names to both lists for that thread only.
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { slugOk } from './rules'
import { leanNote, readLeanThreadCfg } from './threadlean'

export type Profile = { mcp?: string[]; plugins?: string[]; at?: number; source?: string }
export type Loaded = { mcp: string[] | null; plugins: string[] | null; needs: string[]; note?: string } // null = not restricted (everything loads)
export type Seen = { calls: number; threads: number }
export type Usage = { threads: number; mcp: Record<string, Seen>; skills: Record<string, Seen>; plugins: Record<string, Seen> }

export const OWN_SERVER = 'lean-agent'
// lean-agent's own server, however it is spelled (`lean-agent`, `plugin_lean-agent_lean-agent`): never deferred, counted or suggested away
export const isOwn = (server: string) => /(^|_)lean-agent(_|$)/.test(server)
// (a space is allowed: a connector's display name, as /context shows it, is a name too: `claude.ai Gmail` matches `claude_ai_Gmail`)
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@ -]{0,63}$/
const MAX_NAMES = 50
const BAD = new Set(['__proto__', 'constructor', 'prototype'])

export const profileFile = (home: string, project: string) => `${leanDir(home)}/${project}/profile.json`
export const loadedFile = (home: string, id: string) => `${threadsDir(home)}/${id}/loaded.json`
export const usageFile = (home: string, id: string) => `${threadsDir(home)}/${id}/usage.json`

const uniq = (l: string[]) => [...new Set(l)]
export const nameOk = (x: unknown): x is string => typeof x === 'string' && NAME.test(x.trim()) && !BAD.has(x.trim())
// a list of plain names (anything else is dropped), or undefined when it is no list
export function names(v: unknown, max = MAX_NAMES): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return uniq(v.filter(nameOk).map(x => x.trim())).slice(0, max)
}

// ---- name matching ------------------------------------------------------------------------------------------------
// `plugin:figma:figma` (how a server is written) and `plugin_figma_figma` (how a tool name spells it) are the same server
export const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '_')
// `figma` names the server `plugin_figma_figma`, `azure-devops` names `azure-devops`: the whole name, or whole `_` words of it
export function nameMatches(entry: string, server: string): boolean {
  const e = norm(entry)
  const s = norm(server)
  return !!e && (s === e || s.startsWith(`${e}_`) || s.endsWith(`_${e}`) || s.includes(`_${e}_`))
}
// the server part of an MCP tool name (`mcp__<server>__<tool>`), '' for any other tool
export function serverOf(tool: unknown): string {
  return typeof tool === 'string' ? (/^mcp__(.+?)__.+$/.exec(tool)?.[1] ?? '') : ''
}
// ---- the project's profile ----------------------------------------------------------------------------------------
// A list that is present but damaged (not a list, or an entry that is no name) makes the whole profile damaged = no profile: a typo must
// never turn into an empty allow-list that defers every server, nor into a silently unrestricted one.
export async function readProfile(h: Host, home: string, project: string): Promise<Profile | null> {
  if (!slugOk(project)) return null
  const v = await readJson<Record<string, unknown> | null>(h, profileFile(home, project), null)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  for (const k of ['mcp', 'plugins'] as const) if (v[k] !== undefined && (!Array.isArray(v[k]) || !(v[k] as unknown[]).every(nameOk))) return null
  const mcp = names(v.mcp)
  const plugins = names(v.plugins)
  if (!mcp && !plugins) return null
  return { ...(mcp ? { mcp } : {}), ...(plugins ? { plugins } : {}), at: typeof v.at === 'number' ? v.at : undefined, source: typeof v.source === 'string' ? v.source : undefined }
}
export async function writeProfile(h: Host, home: string, project: string, p: { mcp?: string[]; plugins?: string[] }, source: string): Promise<Profile> {
  const out: Profile = { ...(p.mcp ? { mcp: p.mcp } : {}), ...(p.plugins ? { plugins: p.plugins } : {}), at: await h.clock.now(), source }
  await writeJson(h, profileFile(home, project), out)
  return out
}
export async function removeProfile(h: Host, home: string, project: string): Promise<boolean> {
  if (!slugOk(project) || !(await h.fs.exists(profileFile(home, project)).catch(() => false))) return false
  return (await h.process.run(['rm', '-f', profileFile(home, project)])).exitCode === 0
}

// ---- what a thread is started with --------------------------------------------------------------------------------
export async function resolveLoaded(h: Host, home: string, project: string, needs: string[] = []): Promise<Loaded> {
  const prof = project ? await readProfile(h, home, project) : null
  const cfg = await readLeanThreadCfg(h, home).catch(() => null)
  const lean = cfg ?? { plugins: 'all' as const, skills: 'all' as const, mcp: 'all' as const }
  const add = (l: string[] | undefined) => (l ? uniq([...l, ...needs]) : null)
  // plugins: the lean default is lean-agent alone (+ config threads.plugins, + the project's profile, + the thread's needs); "all" = as before
  const plugins = lean.plugins === 'all' ? add(prof?.plugins) : uniq([...lean.plugins, ...(prof?.plugins ?? []), ...needs])
  // MCP: "all" (default) = the profile only; "project" = the project's own list too; "none" = the thread's needs only
  const projectMcp = lean.mcp === 'project' ? [...(prof?.mcp ?? []), ...(await projectMcpNames(h, home, project))] : []
  const mcp = lean.mcp === 'all' ? add(prof?.mcp) : uniq([...projectMcp, ...needs])
  return { mcp, plugins, needs, ...(cfg && (cfg.plugins !== 'all' || cfg.skills !== 'all' || cfg.mcp !== 'all') ? { note: leanNote(cfg) } : {}) }
}
// projects.json `<name>.mcp`: the servers a project says its threads use
async function projectMcpNames(h: Host, home: string, project: string): Promise<string[]> {
  if (!slugOk(project)) return []
  const all = await readJson<Record<string, any> | null>(h, `${leanDir(home)}/projects.json`, null)
  return names(all?.[project]?.mcp) ?? []
}
const list = (l: string[] | null) => (l === null ? 'all' : l.length ? l.join(',') : 'none')
// "mcp: a,b · plugins: x" (list, new, compare); `all` = nothing is held back
export const loadedText = (l: Loaded) => `mcp: ${list(l.mcp)} · plugins: ${list(l.plugins)}${l.note ? ` · ${l.note}` : ''}`
// the sentence in the thread's CLAUDE.md
export function loadedLine(l: Loaded | null): string {
  if (!l || (l.mcp === null && l.plugins === null)) return 'everything the user has set up (this project has no profile)'
  const part = (what: string, v: string[] | null) => (v === null ? `all ${what}` : `${what}: ${v.length ? v.join(', ') : 'none besides lean-agent'}`)
  return `${part('MCP servers', l.mcp)}; ${part('plugins', l.plugins)}`
}
export async function readLoaded(h: Host, home: string, id: string): Promise<Loaded | null> {
  const v = await readJson<Record<string, unknown> | null>(h, loadedFile(home, id), null)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const lst = (x: unknown) => (x === null ? null : (names(x, 2 * MAX_NAMES) ?? null)) // a profile list plus the thread's needs: up to 100
  return { mcp: lst(v.mcp), plugins: lst(v.plugins), needs: names(v.needs) ?? [] }
}
export const writeLoaded = (h: Host, home: string, id: string, l: Loaded) => writeJson(h, loadedFile(home, id), l)

// Is this MCP tool outside the thread's allow-list? (lean-agent's own server and every non-MCP tool: never.)
export function deferOutside(l: Loaded | null, tool: string): boolean {
  const server = serverOf(tool)
  if (!server || isOwn(server) || !l || l.mcp === null) return false
  return !l.mcp.some(n => nameMatches(n, server))
}

// ---- plugins ------------------------------------------------------------------------------------------------------
// `enabledPlugins` entries (false) for the installed plugins outside the allow-list, and ONLY the ones that are skills and nothing else:
// a plugin with an MCP server (it would be removed, not deferred), hooks, agents, commands or a tool of its own (a mod) stays on, and so
// does one whose folder cannot be read (unknown: left on). Skills have no deferral, so switching a skill-only plugin off is the one lever.
export type Installed = { key: string; name: string; installPath: string }
export async function installedPlugins(h: Host): Promise<Installed[]> {
  let reg: any
  try {
    reg = JSON.parse(String(await h.fs.read(`${await homeDir(h)}/.claude/plugins/installed_plugins.json`)))
  } catch {
    return []
  }
  const plugins = reg?.plugins && typeof reg.plugins === 'object' ? reg.plugins : reg
  const out: Installed[] = []
  for (const [key, v] of Object.entries(plugins && typeof plugins === 'object' ? plugins : {})) {
    const name = key.split('@')[0]!
    if (!name || BAD.has(key)) continue
    const rec: any = Array.isArray(v) ? v[v.length - 1] : v
    out.push({ key, name, installPath: typeof rec?.installPath === 'string' && rec.installPath.startsWith('/') ? rec.installPath : '' })
  }
  return out
}
const MORE = ['hooks', 'agents', 'commands', '.mcp.json', '.lsp.json']
const MORE_KEYS = ['mcpServers', 'hooks', 'agents', 'commands', 'lspServers', 'modules']
async function isSkillOnly(h: Host, p: Installed): Promise<boolean> {
  if (!p.installPath || !(await h.fs.exists(`${p.installPath}/skills`).catch(() => false))) return false
  for (const m of MORE) if (await h.fs.exists(`${p.installPath}/${m}`).catch(() => true)) return false
  const pj = await readJson<Record<string, unknown> | null>(h, `${p.installPath}/.claude-plugin/plugin.json`, null)
  return !!pj && !MORE_KEYS.some(k => pj[k] !== undefined)
}
// With the lean default (config threads.plugins not "all", 1.0.20) every installed plugin outside the allow-list is switched off except the ones
// that bring an MCP server (switching those off would remove the server instead of deferring it) and a plugin whose folder cannot be read; with
// threads.plugins "all" only the skill-only ones, as before (their hooks, agents and commands text stays in the base).
async function bringsMcp(h: Host, p: Installed): Promise<boolean> {
  if (!p.installPath) return true // unknown: left on
  if (await h.fs.exists(`${p.installPath}/.mcp.json`).catch(() => true)) return true
  const pj = await readJson<Record<string, unknown> | null>(h, `${p.installPath}/.claude-plugin/plugin.json`, null)
  return pj?.mcpServers !== undefined
}
export async function disabledPlugins(h: Host, allow: string[] | null): Promise<Record<string, false>> {
  if (allow === null) return {}
  const broad = (await readLeanThreadCfg(h, await homeDir(h)).catch(() => null))?.plugins !== 'all'
  const out: Record<string, false> = {}
  for (const p of await installedPlugins(h)) {
    if (p.name === OWN_SERVER || allow.some(a => a === p.key || norm(a) === norm(p.name))) continue
    if (broad ? !(await bringsMcp(h, p)) : await isSkillOnly(h, p)) out[p.key] = false
  }
  return out
}
// The plugin that provides a used server or skill: a `plugin:skill` name says it; a bare skill name is looked up in the installed
// plugins' skills folders; `plugin_<name>_<server>` is matched against the installed names (the longest wins). '' = none known.
async function pluginFor(h: Host, installed: Installed[], kind: 'mcp' | 'skills', name: string, cache: Map<string, string>): Promise<string> {
  const k = `${kind}\0${name}`
  const had = cache.get(k)
  if (had !== undefined) return had
  let found = ''
  if (kind === 'skills' && name.includes(':')) found = name.split(':')[0]!
  else if (kind === 'skills') {
    for (const p of installed) if (p.installPath && (await h.fs.exists(`${p.installPath}/skills/${name}`).catch(() => false))) found = p.name
  } else {
    const s = norm(name)
    for (const p of installed) if (s.startsWith(`plugin_${norm(p.name)}_`) && p.name.length > found.length) found = p.name
  }
  cache.set(k, found)
  return found
}

// ---- the usage counter --------------------------------------------------------------------------------------------
type Counts = { mcp: Record<string, number>; skills: Record<string, number> }
const chains = new Map<string, Promise<unknown>>()
const counts = (v: any): Record<string, number> => {
  const o: Record<string, number> = {}
  for (const [k, n] of Object.entries(v && typeof v === 'object' ? v : {})) if (!BAD.has(k) && typeof n === 'number' && Number.isFinite(n) && n > 0) o[k] = n
  return o
}
async function readCounts(h: Host, home: string, id: string): Promise<Counts> {
  const v = await readJson<any>(h, usageFile(home, id), {})
  return { mcp: counts(v?.mcp), skills: counts(v?.skills) }
}

// What a call counts as: [group, name] or null. A server's own name, a skill's own name: no arguments, nothing else.
export function usageKey(tool: string, input: unknown): ['mcp' | 'skills', string] | null {
  const server = serverOf(tool)
  if (server && !isOwn(server)) return ['mcp', server]
  const skill = tool === 'Skill' && input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined
  return typeof skill === 'string' && NAME.test(skill.trim()) ? ['skills', skill.trim()] : null
}

// +1 for the call of an MCP server's tool or a skill (one at a time per thread); a call that counts nothing writes nothing
export async function noteToolUse(h: Host, id: string, tool: string, input: unknown): Promise<boolean> {
  const key = usageKey(tool, input)
  if (!key) return false
  const home = await homeDir(h)
  const run = (chains.get(id) ?? Promise.resolve()).then(async () => {
    const c = await readCounts(h, home, id)
    c[key[0]][key[1]] = (c[key[0]][key[1]] ?? 0) + 1
    await writeJson(h, usageFile(home, id), c)
  })
  const tail = run.catch(() => undefined)
  chains.set(id, tail)
  try {
    await run
  } finally {
    if (chains.get(id) === tail) chains.delete(id) // nothing queued behind this call: the entry goes
  }
  return true
}
export async function startUsage(h: Host, home: string, id: string): Promise<void> {
  if (!(await h.fs.exists(usageFile(home, id)).catch(() => false))) await writeJson(h, usageFile(home, id), { mcp: {}, skills: {} } satisfies Counts)
}

// the project's threads that carry a usage counter (started with this version), summed: calls and the number of threads per name
export async function projectUsage(h: Host, home: string, project: string): Promise<Usage> {
  const out: Usage = { threads: 0, mcp: {}, skills: {}, plugins: {} }
  const installed = await installedPlugins(h)
  const cache = new Map<string, string>()
  const bump = (g: Record<string, Seen>, k: string, calls: number) => {
    const s = (g[k] ??= { calls: 0, threads: 0 })
    s.calls += calls
    s.threads++
  }
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<{ project?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.project !== project || !(await h.fs.exists(usageFile(home, e.name)).catch(() => false))) continue
    const c = await readCounts(h, home, e.name)
    out.threads++
    const plug: Record<string, number> = {}
    for (const [s, n] of Object.entries(c.mcp)) {
      bump(out.mcp, s, n)
      const p = await pluginFor(h, installed, 'mcp', s, cache)
      if (p && p !== OWN_SERVER) plug[p] = (plug[p] ?? 0) + n
    }
    for (const [s, n] of Object.entries(c.skills)) {
      bump(out.skills, s, n)
      const p = await pluginFor(h, installed, 'skills', s, cache)
      if (p && p !== OWN_SERVER) plug[p] = (plug[p] ?? 0) + n
    }
    for (const [p, n] of Object.entries(plug)) bump(out.plugins, p, n)
  }
  return out
}
// "used 41 times in 12 threads"
export const usedText = (s: Seen) => `used ${s.calls} time${s.calls === 1 ? '' : 's'} in ${s.threads} thread${s.threads === 1 ? '' : 's'}`

// what the project's threads used, set against its profile (lean_thread profile, lean_profile show)
export async function profileText(h: Host, home: string, project: string): Promise<string> {
  const prof = await readProfile(h, home, project)
  const use = await projectUsage(h, home, project)
  const out = [prof ? `${project} profile: mcp: ${prof.mcp ? list(prof.mcp) : 'all (not restricted)'} · plugins: ${prof.plugins ? list(prof.plugins) : 'all (not restricted)'}${prof.source ? ` (set by ${prof.source})` : ''}; everything outside it is deferred (MCP) or off (skill-only plugins)` : `${project} has no profile${(await h.fs.exists(profileFile(home, project)).catch(() => false)) ? ' (profile.json exists but is damaged, a list holds a name that is no name: it is ignored; set it again)' : ''}: every thread loads everything. lean_thread profile (fill: true) writes one from usage, or give mcp / plugins`]
  if (!use.threads) return [...out, 'usage: no thread of this project has a usage counter yet (threads started before this version have none)'].join('\n')
  const row = (g: Record<string, Seen>, inList: (k: string) => boolean | null) =>
    Object.entries(g)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 12)
      .map(([k, s]) => `${k} ${usedText(s)}${inList(k) === null ? '' : inList(k) ? ' (in the profile)' : ' (outside the profile: deferred)'}`)
  const inMcp = (k: string) => (!prof?.mcp ? null : prof.mcp.some(n => nameMatches(n, k)))
  const inPlug = (k: string) => (!prof?.plugins ? null : prof.plugins.some(n => norm(n) === norm(k)))
  out.push(`usage from ${use.threads} thread(s) with a counter:`)
  const m = row(use.mcp, inMcp)
  const p = row(use.plugins, inPlug)
  const s = row(use.skills, () => null)
  out.push(`  MCP servers: ${m.length ? m.join('; ') : 'none used'}`)
  out.push(`  plugins (by their skills and servers): ${p.length ? p.join('; ') : 'none used'}`)
  if (s.length) out.push(`  skills: ${s.join('; ')}`)
  return out.join('\n')
}

// Add what the project's threads used to its profile (never removes a name). A list is only written where there is evidence for it: a
// list the profile does not have stays absent (= not restricted) unless something was really used, so a project whose threads called
// no MCP server (the learn thread itself calls only lean-agent's tools) is never locked out by an empty allow-list.
// Plugins are different: a skill run by slash command is no tool call and is not counted, so a plugins list is never CREATED from usage
// (switching skill-only plugins off on that evidence could take away one the user relies on); only a list the profile already has grows.
// A name that an entry already covers (`figma` covers `plugin_figma_figma`) is not added twice; an unchanged profile is not rewritten.
export async function fillProfile(h: Host, home: string, project: string): Promise<{ ok: boolean; text: string }> {
  const use = await projectUsage(h, home, project)
  if (!use.threads) return { ok: false, text: `nothing to learn from: no thread of ${project} has a usage counter yet (threads started before this version have none). The profile stays as it is.` }
  const cur = await readProfile(h, home, project)
  const grow = (have: string[] | undefined, used: string[]) => {
    const fresh = used.filter(nameOk).filter(u => !(have ?? []).some(x => nameMatches(x, u) || nameMatches(u, x)))
    return have === undefined && !fresh.length ? undefined : uniq([...(have ?? []), ...fresh])
  }
  const mcp = grow(cur?.mcp, Object.keys(use.mcp))
  const plugins = cur?.plugins === undefined ? undefined : grow(cur.plugins, Object.keys(use.plugins))
  const usedPlugins = Object.keys(use.plugins).filter(nameOk)
  if (!mcp && !plugins) return { ok: false, text: `nothing to learn from: the ${use.threads} thread(s) of ${project} that have a usage counter called no MCP server yet. The profile stays as it is (no profile = everything loads).${usedPlugins.length ? ` Plugins whose skills were used: ${usedPlugins.join(', ')} (set plugins by hand if wanted)` : ''}` }
  const over = Math.max(0, (mcp?.length ?? 0) - MAX_NAMES) + Math.max(0, (plugins?.length ?? 0) - MAX_NAMES)
  const same = (a?: string[], b?: string[]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  if (cur && same(mcp, cur.mcp) && same(plugins, cur.plugins)) return { ok: true, text: `${await profileText(h, home, project)}\nnothing new was used: the profile is unchanged` }
  await writeProfile(h, home, project, { mcp: mcp?.slice(0, MAX_NAMES), plugins: plugins?.slice(0, MAX_NAMES) }, 'usage')
  const hint = cur?.plugins === undefined && usedPlugins.length ? `; plugins whose skills were used: ${usedPlugins.join(', ')} (the plugins list was left alone: a skill run by slash command is not counted; set it by hand if wanted)` : ''
  return { ok: true, text: `${await profileText(h, home, project)}\nfilled from ${use.threads} thread(s): servers outside the profile are deferred (still found by ToolSearch)${over ? `; ${over} name(s) did not fit (at most ${MAX_NAMES} per list)` : ''}${hint}` }
}
