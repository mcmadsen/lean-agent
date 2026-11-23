// What a session carries before any work: its tool schemas. Settings fragments that REMOVE what the desk / a thread never uses (a deny
// rule without a pattern takes the tool out of the model's tool list; a refusal at call time would still leave its schema in every request).
//
//   deskSettings()                the desk's folder settings.json fragment: every built-in tool strict mode cannot allow, the
//                                 claude.ai connectors, project MCP servers, and the engine's own extras (cron, bundled skills, git text)
//   threadSettings(opts?)         a thread's fragment: the built-ins lean-agent threads never call. Connectors and MCP servers are NEVER
//                                 removed here (a thread's profile only defers them, profile.ts, and a worker is granted one per job
//                                 with `allow-mcp:`): a server listed in the project's profile.mcp is also kept out of any deny rule
//   mergeSettings(base, fragment) the fragment merged into an existing settings object (deny lists united, env merged, nothing else touched)
//
// The thread settings writer lives in threads.ts: add `leanThreadSettings` there (see the README "Fixed overhead").
import { DESK_TOOLS } from './guard'
import { nameMatches, serverOf } from './profile'
import { atomicWrite, dirOf, mkdirp } from './state'
import type { Host } from './state'

export type ToolsSettings = { permissions: { deny: string[] }; env: Record<string, string>; enableAllProjectMcpServers?: boolean }

// every built-in tool name this plugin knows of (a deny rule for a name an engine does not have is harmless)
export const BUILTIN_TOOLS: readonly string[] = [
  'Agent', 'Task', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'SendMessage', 'ListAgents', 'SendUserFile', 'Workflow',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync', 'ListConnectors', 'ListPlugins', 'ListSkills', 'SearchMcpRegistry', 'SearchPlugins',
  'SearchSkills', 'SuggestConnectors', 'SuggestPluginInstall', 'SuggestSkills', 'ShowOnboardingRolePicker', 'ReportFindings', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'REPL',
]

// a lean-agent thread orchestrates: it reads, edits, runs, delegates and reports. These it never calls.
export const THREAD_NEVER: readonly string[] = [
  'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ShowOnboardingRolePicker', 'SuggestConnectors', 'SuggestPluginInstall', 'SuggestSkills',
  'SearchMcpRegistry', 'SearchPlugins', 'SearchSkills', 'ListConnectors', 'ListPlugins', 'ListSkills', 'DesignSync',
]

// env switches of the engine (settings.json `env`), found in the engine's binary: their effect on a live session is the engine's
const DESK_ENV: Record<string, string> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false', // the account's connectors: the desk calls none (its own server is a plugin's, not a connector)
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1', // the desk starts no subagent: no Explore / Plan entries
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', // the desk lists only lean-agent's skills (skilltrim.ts); the bundled ones are text it never reads
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', // the desk runs no commit or push
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
}
const THREAD_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1', // two long skill descriptions in every thread's skill listing
  CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', // a thread's memory is lean-agent's own (memory.ts)
}

const uniq = (l: string[]) => [...new Set(l)]

// the desk may call DESK_TOOLS (guard.ts) and lean-agent's own tools; everything else built in is removed
// SendMessage is the engine's gate for the mod's own `$.session.send` (deliver-to-thread.ts, desk -> thread): a session whose deny list removes the tool is refused with
// "this session has no SendMessage tool" (seen live), so the desk keeps it. The desk MODEL still never calls it (guard.ts deskDenial denies every tool outside DESK_TOOLS).
export const DESK_MOD_TOOLS: readonly string[] = ['SendMessage']
export function deskSettings(): ToolsSettings {
  return { permissions: { deny: BUILTIN_TOOLS.filter(t => !DESK_TOOLS.includes(t) && !DESK_MOD_TOOLS.includes(t)) }, env: { ...DESK_ENV }, enableAllProjectMcpServers: false }
}

// `mcp`: the project's profile.mcp (profile.ts), `extraDeny`: tools the user dropped (config.json tools.thread.drop style names)
export function threadSettings(opts: { mcp?: string[]; extraDeny?: string[] } = {}): ToolsSettings {
  const keep = (t: string) => {
    const s = serverOf(t)
    return !s || !(opts.mcp ?? []).some(x => nameMatches(x, s)) // a deny rule on a listed server's tool is never written
  }
  return { permissions: { deny: uniq([...THREAD_NEVER, ...(opts.extraDeny ?? [])]).filter(keep) }, env: { ...THREAD_ENV } }
}

// the fragment merged into a settings object: deny lists united, env merged (the existing value wins), nothing else touched
export function mergeSettings(base: any, f: ToolsSettings): any {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  const perm = b.permissions && typeof b.permissions === 'object' && !Array.isArray(b.permissions) ? b.permissions : {}
  const deny = uniq([...(Array.isArray(perm.deny) ? perm.deny.filter((x: unknown) => typeof x === 'string') : []), ...f.permissions.deny])
  const env = { ...f.env, ...(b.env && typeof b.env === 'object' && !Array.isArray(b.env) ? b.env : {}) }
  return { ...b, permissions: { ...perm, deny }, env, ...(f.enableAllProjectMcpServers === undefined || 'enableAllProjectMcpServers' in b ? {} : { enableAllProjectMcpServers: f.enableAllProjectMcpServers }) }
}

// the names the thread settings writer imports (threads.ts has its own threadSettings)
export const leanDeskSettings = deskSettings
export const leanThreadSettings = threadSettings

// the desk folder's settings.json with deskSettings() merged in (the doctor's fix step); false = the file does not parse, nothing written
export async function mergeDeskSettingsFile(h: Host, path: string): Promise<boolean> {
  let cur: unknown = {}
  if (await h.fs.exists(path)) {
    try {
      const t = String(await h.fs.read(path))
      cur = t.trim() ? JSON.parse(t) : {}
    } catch {
      return false
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return false
  }
  await mkdirp(h, dirOf(path))
  const merged = mergeSettings(cur, deskSettings())
  merged.permissions.deny = merged.permissions.deny.filter((x: string) => !DESK_MOD_TOOLS.includes(x)) // an older file denied SendMessage: the mod's direct delivery needs it
  await atomicWrite(h, path, JSON.stringify(merged, null, 2) + '\n')
  return true
}
