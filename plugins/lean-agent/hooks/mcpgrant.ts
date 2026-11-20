// MCP access is opt-in per job: a worker or reader of lean-agent has no MCP tools by default (agents/*.md `tools:`), and a thread grants a
// server for ONE job with brief lines `allow-mcp: <server>[, <server>]` (read-only tools) and, for a write tool, `allow-mcp-write: <server>`.
// The guard records the lines like allow-cmd (guard.ts parseGrants) and answers here for every MCP tool call of a lean-agent subagent.
// `reader-mcp` (agents/reader-mcp.md) is the one definition whose tool list can carry MCP tools; this guard restricts it to the granted servers.
import { isOwn, nameMatches, serverOf } from './profile'

export type McpGrants = { mcp?: string[]; mcpWrite?: string[] }

const WRITE_FIRST = new Set(['create', 'update', 'delete', 'remove', 'upsert', 'edit', 'write', 'put', 'post', 'patch', 'set', 'run', 'trigger', 'execute', 'send', 'mute', 'unmute', 'cancel', 'schedule', 'submit', 'merge', 'deploy', 'restart', 'kill', 'stop', 'start', 'add', 'assign', 'resolve', 'close', 'reopen', 'archive', 'invite', 'revoke', 'grant', 'apply', 'rollback', 'import', 'publish', 'move', 'rename', 'reset', 'clear', 'enable', 'disable', 'toggle', 'approve', 'reject', 'dismiss', 'acknowledge', 'snooze', 'notify', 'comment', 'reply', 'upload', 'insert', 'replace', 'truncate', 'drop', 'purge', 'destroy', 'commit', 'push'])
const WRITE_ANY = new Set(['write', 'delete', 'destroy', 'upsert', 'create', 'update', 'remove', 'trigger', 'execute']) // anywhere in the name

// the tool's own name without `mcp__<server>__`, in snake_case (`createMonitor` -> `create_monitor`)
export const toolPart = (tool: string): string => tool.replace(/^mcp__.+?__/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_')
// a name that writes. The engine's own hint (a tool the server marks readOnly or not) is not part of a tool.call, so the name decides.
export function isWriteTool(tool: string): boolean {
  const seg = toolPart(tool).split('_').filter(Boolean)
  return seg.length > 0 && (WRITE_FIRST.has(seg[0]!) || seg.some(s => WRITE_ANY.has(s)))
}

export const isMcpTool = (tool: unknown): tool is string => typeof tool === 'string' && tool.startsWith('mcp__')
const granted = (list: string[] | undefined, server: string) => (list ?? []).some(x => nameMatches(x, server))

// null = allow; else the refusal. lean-agent's own server is not judged here.
export function mcpDecision(g: McpGrants, tool: string): string | null {
  const server = serverOf(tool)
  if (!server || isOwn(server)) return null
  const list = g.mcp ?? []
  if (!list.length && !(g.mcpWrite ?? []).length) return `lean-agent: ${tool} refused: this brief has no allow-mcp line (MCP is opt-in per job). The thread adds \`allow-mcp: <server>\` to the brief and sends it again; report blocked to the thread`
  if (!granted(list, server) && !granted(g.mcpWrite, server)) return `lean-agent: ${tool} refused: server ${server} is not granted for this job (allow-mcp: ${list.join(', ') || 'none'}); use only those, or report blocked so the thread grants it`
  if (isWriteTool(tool)) {
    return granted(g.mcpWrite, server)
      ? `lean-agent: ${tool} writes, and allow-mcp-write is not honoured by a worker alone: it needs the user's approval through the desk (the thread reports it with lean_report); stop and report blocked`
      : `lean-agent: ${tool} looks like a write tool: a worker has read-only MCP access. A write needs \`allow-mcp-write: ${server}\` plus the user's approval through the desk; stop and report blocked`
  }
  return null
}
