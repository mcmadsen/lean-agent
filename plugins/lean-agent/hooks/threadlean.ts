// The lean defaults of a thread's base (1.0.20), each with a config switch (config.json, `threads.<key>`, nested or dotted):
//   threads.plugins  (default: none) a thread loads ONLY the lean-agent plugin; an array of plugin names adds those; "all" = every plugin of the user
//   threads.skills   "lean" (default) the thread's skills listing keeps lean-agent's skills only (the mod trims it, as on the desk); "all" = everything
//   threads.mcp      "all" (default, as before: connectors available, `allow-mcp:` jobs work) | "project" (only the servers the project lists in
//                    projects.json <name>.mcp or its profile, plus the thread's `needs`) | "none" (only `needs`). A server outside the list is
//                    DEFERRED (profile.ts), never removed: ToolSearch still finds it.
// Pure helpers; the one reader takes a host.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'

export type McpMode = 'all' | 'project' | 'none'
export type LeanThreadCfg = { plugins: 'all' | string[]; skills: 'lean' | 'all'; mcp: McpMode }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/
const pick = (cfg: any, key: string): unknown => cfg?.threads?.[key] ?? cfg?.[`threads.${key}`]

export function leanThreadCfg(cfg: any): LeanThreadCfg {
  const p = pick(cfg, 'plugins')
  const s = pick(cfg, 'skills')
  const m = pick(cfg, 'mcp')
  return {
    plugins: p === 'all' ? 'all' : Array.isArray(p) ? [...new Set(p.filter((x: unknown): x is string => typeof x === 'string' && NAME.test(x)))] : [],
    skills: s === 'all' ? 'all' : 'lean',
    mcp: m === 'project' || m === 'none' ? m : 'all',
  }
}
export async function readLeanThreadCfg(h: Host, home: string): Promise<LeanThreadCfg> {
  return leanThreadCfg(await readJson<any>(h, `${leanDir(home)}/config.json`, {}))
}

// the clause the start / restart reply carries after "mcp: … · plugins: …": the lean defaults in force, and the config keys that change them
export function leanNote(c: LeanThreadCfg): string {
  const plugins = c.plugins === 'all' ? 'all plugins' : `lean-agent${c.plugins.length ? ` + ${c.plugins.join(', ')}` : ' only'}`
  return `lean base: plugins ${plugins}, skills ${c.skills === 'all' ? 'all listed' : "lean-agent's only"}, MCP ${c.mcp === 'all' ? 'all available' : c.mcp === 'project' ? "the project's, the rest deferred" : 'all deferred'} (config threads.plugins / skills / mcp)`
}

// a thread's skills listing is trimmed to lean-agent's skills (config threads.skills "all" turns it off); the desk always is
export async function threadSkillsLean(h: Host, kind: string): Promise<boolean> {
  if (kind !== 'thread') return false
  try {
    return (await readLeanThreadCfg(h, await homeDir(h))).skills === 'lean'
  } catch {
    return false
  }
}
