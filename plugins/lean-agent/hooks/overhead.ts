// `lean_doctor overhead` (fixed cost, measure): the tokens a request carries before any work, per role, by script (no model):
//   template     the role's CLAUDE.md text (templates/front-desk.md, templates/thread.md; subagents: none here, the project's own CLAUDE.md is not lean-agent's)
//   agent        the agent definition (agents/<role>.md, whole file)
//   skills       the skills listing: `name: description` of the plugin's skills whose `roles:` include the role (subagents list none)
//   lean tools   lean-agent's own tool schemas (name + description + input schema), as the role registers them (a subagent's `tools:` allow-list has none)
// Tokens are estimated as characters / 4. From a session transcript (optional) the first request's usage is shown against the measured
// parts: the rest is the engine's system prompt plus the tool schemas of built-ins and MCP servers, which no file holds; the MCP share
// is what the transcript names (servers, tool names, their instructions text).
import { findTranscript, readRecords } from './contextstat'
import { readJson, threadsDir } from './state'
import type { Host } from './state'
import { baseLine, readBase } from './base'

export const ROLES = ['desk', 'thread', 'worker-haiku', 'reader-haiku', 'reader-sonnet', 'worker-sonnet', 'reviewer', 'auditor'] as const
export type RoleName = (typeof ROLES)[number]
export type Row = { role: string; template: number; agent: number; skills: number; tools: number; total: number }
export type Spec = { name?: string; description?: string; inputSchema?: unknown }
export type Tools = { desk?: Spec[]; thread?: Spec[] }

export const tokens = (chars: number): number => Math.ceil(chars / 4)
const read = async (h: Host, p: string): Promise<string> => {
  try {
    const t = await h.fs.read(p)
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}
const frontKey = (text: string, key: string): string => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')?.[1]?.trim() ?? ''

// the listing text of the plugin's skills for a role
export async function skillsListing(h: Host, root: string, role: 'desk' | 'thread'): Promise<string> {
  const dirs = (await h.fs.list(`${root}/skills`).catch(() => [] as { name: string; kind: string }[])).filter(d => d.kind === 'dir').map(d => d.name).sort()
  const out: string[] = []
  for (const d of dirs) {
    const t = await read(h, `${root}/skills/${d}/SKILL.md`)
    if (!t) continue
    const roles = frontKey(t, 'roles')
    if (roles && !roles.split(',').map(x => x.trim()).includes(role)) continue
    out.push(`- ${frontKey(t, 'name') || d}: ${frontKey(t, 'description')}`)
  }
  return out.join('\n')
}

const specChars = (l: Spec[] | undefined) => (l ?? []).reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }).length, 0)

export async function measure(h: Host, root: string, tools: Tools = {}): Promise<Row[]> {
  const rows: Row[] = []
  for (const role of ROLES) {
    const main = role === 'desk' || role === 'thread'
    const template = main ? (await read(h, `${root}/templates/${role === 'desk' ? 'front-desk' : 'thread'}.md`)).length : 0
    const agent = main ? 0 : (await read(h, `${root}/agents/${role}.md`)).length
    const skills = main ? (await skillsListing(h, root, role as 'desk' | 'thread')).length : 0
    const tl = role === 'desk' ? specChars(tools.desk) : role === 'thread' ? specChars(tools.thread) : 0
    const r = { role, template: tokens(template), agent: tokens(agent), skills: tokens(skills), tools: tokens(tl) }
    rows.push({ ...r, total: r.template + r.agent + r.skills + r.tools })
  }
  return rows
}

export function tableText(rows: Row[]): string {
  const w = Math.max(4, ...rows.map(r => r.role.length))
  const head = `${'role'.padEnd(w)}  ${['template', 'agent', 'skills', 'lean tools', 'total'].map(x => x.padStart(11)).join('')}`
  return [head, ...rows.map(r => `${r.role.padEnd(w)}  ${[r.template, r.agent, r.skills, r.tools, r.total].map(x => String(x).padStart(11)).join('')}`)].join('\n')
}

// ---- from a session transcript -------------------------------------------------------------------------------------
export type Share = { first: number; mcpServers: string[]; mcpTools: number; mcpNameTokens: number; mcpInstructions: number; builtinTools: number }
const serverOfTool = (t: string) => /^mcp__(.+?)__.+$/.exec(t)?.[1] ?? ''

export function transcriptShare(records: any[]): Share {
  const s: Share = { first: 0, mcpServers: [], mcpTools: 0, mcpNameTokens: 0, mcpInstructions: 0, builtinTools: 0 }
  const servers = new Set<string>()
  const mcp = new Set<string>()
  const builtin = new Set<string>()
  let instrChars = 0
  for (const r of records) {
    if (!s.first && r?.type === 'assistant' && r.message?.usage && !r.isSidechain) {
      const u = r.message.usage
      s.first = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0)
    }
    const a = r?.attachment
    if (a && typeof a === 'object') {
      const names: unknown[] = [...(Array.isArray(a.addedNames) ? a.addedNames : []), ...(Array.isArray(a.names) ? a.names : [])]
      for (const n of names) if (typeof n === 'string') (n.startsWith('mcp__') ? mcp : builtin).add(n)
      if (/mcp_instructions/.test(String(a.type))) {
        const t = typeof a.text === 'string' ? a.text : JSON.stringify(a.addedBlocks ?? a.blocks ?? '')
        instrChars += t.length
      }
    }
    if (Array.isArray(r?.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_use' && typeof b.name === 'string') (b.name.startsWith('mcp__') ? mcp : builtin).add(b.name)
  }
  for (const n of mcp) servers.add(serverOfTool(n))
  s.mcpServers = [...servers].filter(Boolean).sort()
  s.mcpTools = mcp.size
  s.mcpNameTokens = tokens([...mcp].reduce((n, x) => n + x.length + 1, 0))
  s.mcpInstructions = tokens(instrChars)
  s.builtinTools = builtin.size
  return s
}

export function shareText(s: Share, measured: number, role = 'desk'): string {
  if (!s.first) return 'transcript: no assistant request with usage in it'
  const rest = Math.max(0, s.first - measured)
  return [
    `REAL base: the first request carried ${s.first} tokens (input + cache read + cache creation of the first assistant record), against the text estimate above (${role} row) of ${measured}`,
    `  the engine's system prompt + built-in and MCP tool schemas: about ${rest} (no file holds them; the built-in tool schemas alone are most of it, config threads.tools cuts them for threads)`,
    `  MCP named by the transcript: ${s.mcpServers.length} server(s)${s.mcpServers.length ? ` (${s.mcpServers.join(', ')})` : ''}, ${s.mcpTools} tool name(s) (~${s.mcpNameTokens} tokens of names), instructions ~${s.mcpInstructions} tokens`,
    `  built-in tool names seen: ${s.builtinTools} (a schema is far larger than its name: remove what a role never uses, see README "Fixed overhead")`,
  ].join('\n')
}

export async function overheadReport(h: Host, root: string, o: { tools?: Tools; session?: string; home?: string; transcript?: any[] } = {}): Promise<string> {
  try {
    const rows = await measure(h, root, o.tools)
    const out = ['fixed overhead per role, tokens estimated as chars/4 (what a request carries before any work)', tableText(rows)]
    const by = Object.fromEntries(rows.map(r => [r.role, r]))
    out.push(`built-in tool schemas and the engine's system prompt are not in the table (no file holds them); tools: lists in agents/*.md keep a subagent to its few built-ins and no MCP tool${o.tools?.thread ? '' : '; thread tools not given'}`)
    let recs = o.transcript
    let thread = ''
    let session = o.session
    if (!recs && o.home && session && /^t\d+$/.test(session)) { // a thread id: its current session's transcript
      thread = session
      session = (await readJson<{ sid?: string }>(h, `${threadsDir(o.home)}/${thread}/thread.json`, {})).sid || undefined
    }
    if (!recs && o.home && o.session !== '') {
      const file = session ? await findTranscript(h, o.home, session) : null
      if (file) recs = await readRecords(h, file)
    }
    if (recs) out.push(shareText(transcriptShare(recs), (by[thread ? 'thread' : 'desk']?.total ?? 0), thread ? 'thread' : 'desk'))
    const real = await readBase(h).catch(() => null)
    if (real && !thread) out.push(`newest thread session measured by the mod: ${baseLine(real)} (${real.thread})`)
    return out.join('\n')
  } catch (err) {
    return `overhead failed: ${String((err as Error)?.message ?? err)}`
  }
}
