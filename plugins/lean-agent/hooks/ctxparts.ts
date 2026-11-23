// The real breakdown of a thread's context (1.0.26), the same categories as the app's context view (`$.session.usage({ breakdown })`).
// The first request of a session (base.ts) is the fixed parts PLUS the first prompt (brief / handover / preflight) and whatever the first turn
// loaded, so "base" was the wrong word for it. The thread's own mod records the breakdown at its first turn end (`full`: the token-count API
// per tool and memory file, once per session) and at every later turn end (`summary`: local estimates, no request) into
// <thread folder>/context-parts.json: { sid, at, request?, first?, last? }. Fixed = every used category but Messages. Observes only.
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'

export type Parts = {
  system: number // the engine's system prompt
  tools: number // built-in tool schemas
  mcp: number // MCP tool schemas (lean-agent's own among them)
  skills: number // the skills listing
  memory: number // CLAUDE.md files and rules
  agents: number // custom agents the Agent tool lists
  mcpInstr: number // MCP server instructions
  other: number // any other used row (slash commands ...)
  messages: number
  fixed: number
  total: number
  full: boolean // counted with the token-count API (first turn end) | estimated locally
  skillsListed?: { total: number; included: number; bySource: Record<string, { n: number; tokens: number }> }
  mcpServers?: Record<string, number> // tokens by server
  memoryFiles?: { type: string; tokens: number }[] // the largest, no path
}
export type PartsRec = { sid: string; at: number; request?: number; first?: Parts; last?: Parts }
export const partsFile = (home: string, id: string) => `${threadsDir(home)}/${id}/context-parts.json`

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
// one breakdown row -> the part it belongs to (by the row's label: the engine says what a row is only as used / free / buffer / deferred)
export function partOf(name: string): keyof Pick<Parts, 'system' | 'tools' | 'mcp' | 'skills' | 'memory' | 'agents' | 'mcpInstr' | 'other' | 'messages'> {
  const s = name.toLowerCase()
  if (/mcp/.test(s) && /instruction/.test(s)) return 'mcpInstr'
  if (/^mcp/.test(s)) return 'mcp'
  if (/system prompt/.test(s)) return 'system'
  if (/^(system )?tools?\b|built-?in tools/.test(s)) return 'tools'
  if (/skill/.test(s)) return 'skills'
  if (/memory/.test(s)) return 'memory'
  if (/agent/.test(s)) return 'agents'
  if (/^messages?\b/.test(s)) return 'messages'
  return 'other'
}

// the breakdown of `$.session.usage({ breakdown }).context.breakdown` (pure); null = nothing usable
export function partsOf(b: any, full: boolean): Parts | null {
  const cats = Array.isArray(b?.categories) ? b.categories : null
  if (!cats) return null
  const p: Parts = { system: 0, tools: 0, mcp: 0, skills: 0, memory: 0, agents: 0, mcpInstr: 0, other: 0, messages: 0, fixed: 0, total: 0, full }
  for (const c of cats) {
    if (!c || c.kind !== 'used' || c.isDeferred) continue // free space, the compaction buffer and deferred schemas are not in the window
    p[partOf(String(c.name ?? ''))] += n(c.tokens)
  }
  p.fixed = p.system + p.tools + p.mcp + p.skills + p.memory + p.agents + p.mcpInstr + p.other
  p.total = p.fixed + p.messages
  if (p.total <= 0) return null
  const sk = b?.skills
  if (sk && Array.isArray(sk.skillFrontmatter)) {
    const bySource: Record<string, { n: number; tokens: number }> = {}
    for (const s of sk.skillFrontmatter) {
      const k = s?.source === 'plugin' && s?.pluginName ? `plugin ${String(s.pluginName).slice(0, 40)}` : String(s?.source ?? '?').slice(0, 30)
      const e = (bySource[k] ??= { n: 0, tokens: 0 })
      e.n++
      e.tokens += n(s?.tokens)
    }
    p.skillsListed = { total: n(sk.totalSkills), included: n(sk.includedSkills), bySource }
  }
  if (Array.isArray(b?.mcpTools) && b.mcpTools.length) {
    const by: Record<string, number> = {}
    for (const t of b.mcpTools) if (t?.isLoaded !== false) by[String(t?.serverName ?? '?').slice(0, 40)] = (by[String(t?.serverName ?? '?').slice(0, 40)] ?? 0) + n(t?.tokens)
    p.mcpServers = by
  }
  if (Array.isArray(b?.memoryFiles) && b.memoryFiles.length) p.memoryFiles = b.memoryFiles.map((m: any) => ({ type: String(m?.type ?? '?').slice(0, 20), tokens: n(m?.tokens) })).sort((a: any, b2: any) => b2.tokens - a.tokens).slice(0, 8)
  return p
}

export async function readParts(h: Host, home: string, id: string): Promise<PartsRec | null> {
  const r = await readJson<Partial<PartsRec> | null>(h, partsFile(home, id), null)
  return r && typeof r === 'object' && typeof r.sid === 'string' ? { sid: r.sid, at: Number(r.at) || 0, ...(typeof r.request === 'number' ? { request: r.request } : {}), ...(r.first ? { first: r.first } : {}), ...(r.last ? { last: r.last } : {}) } : null
}
// merged into the record of the same session (a new session starts a fresh record); false = nothing written, never throws
export async function recordParts(h: Host, id: string, sid: string, o: { request?: number; parts?: Parts }): Promise<boolean> {
  if (!/^t\d+$/.test(id) || !sid) return false
  try {
    const home = await homeDir(h)
    const old = await readParts(h, home, id)
    const cur: PartsRec = old && old.sid === sid ? old : { sid, at: 0 }
    if (typeof o.request === 'number' && o.request > 0) cur.request = Math.round(o.request)
    if (o.parts) {
      if (!cur.first || (o.parts.full && !cur.first.full)) cur.first = o.parts // the first turn end's (counted) breakdown stays the session's fixed base
      cur.last = o.parts
    }
    cur.at = await h.clock.now()
    await writeJson(h, partsFile(home, id), cur)
    return true
  } catch {
    return false
  }
}

// ---- text ------------------------------------------------------------------------------------------------------------------------
const k = (x: number) => `${Math.round(x / 100) / 10}k`
const LABEL: [keyof Parts, string][] = [['tools', 'tools'], ['mcp', 'MCP tools'], ['skills', 'skills'], ['memory', 'memory'], ['system', 'system prompt'], ['agents', 'agents'], ['mcpInstr', 'MCP instructions'], ['other', 'other']]
// "fixed base 28.2k (MCP tools 7.8k, skills 7.9k, ...)": the parts that matter, largest first
export function fixedParts(p: Parts): string {
  return LABEL.map(([key, name]) => [name, Number(p[key]) || 0] as const).filter(([, v]) => v >= 100).sort((a, b) => b[1] - a[1]).map(([name, v]) => `${name} ${k(v)}`).join(', ')
}
// What the start / restart reply and the doctor say about a session's first request. With a breakdown: the fixed base by part plus the first prompt
// (request - fixed). Without one: the number is called what it is, the first request.
export function requestText(request: number, p?: Parts | null, tools = ''): string {
  const t = tools ? `built-in tools: ${tools}` : 'full built-in tool set; config threads.tools can cut it'
  if (p && p.fixed > 0 && request >= p.fixed * 0.5) {
    const prompt = Math.max(0, request - p.fixed)
    return `fixed base ${k(p.fixed)} (${fixedParts(p)}) + first prompt ${k(prompt)} = first request ${k(request)} (${t})`
  }
  return `first request ${k(request)} tokens (fixed parts + the first prompt; no breakdown recorded yet) (${t})`
}
// the free context a thread has for work: the limit minus its FIXED base (the first prompt is work that was asked for), null = unknown
export const freeContext = (limit: number, p?: Parts | null): number | null => (p && p.fixed > 0 ? Math.max(0, limit - p.fixed) : null)

export const FIX: Record<string, string> = {
  tools: 'config threads.tools (the built-in tool list of a thread session)',
  mcp: 'config threads.mcp project|none defers other servers; lean-agent registers only the tools a thread uses (lean_doctor overhead lists its schemas)',
  skills: 'config threads.skills lean (default) + threads.plugins; the listing keeps only the lean-agent skills a thread uses (skilltrim.ts)',
  memory: 'CLAUDE.md files and learned rules: shorten them (rules-pr skill), claudeMdExcludes in settings for files a thread does not need',
  system: "the engine's own system prompt: not configurable",
  agents: 'custom agents the Agent tool lists: threads.plugins keeps other plugins\' agents out',
  mcpInstr: 'MCP server instructions: config threads.mcp project|none',
  other: 'slash commands and the like: threads.plugins',
  messages: 'the conversation: readers write findings to scratch/ files (workers.answerChars), notes.md replaces re-reading',
}
// the table `lean_doctor overhead tN` prints, largest first, each with the one line that shrinks it
export function partsTable(r: PartsRec, limit?: number): string {
  const p = r.last ?? r.first
  if (!p) return ''
  const first = r.first ?? p
  const rows = ([...LABEL.map(([key, name]) => [key as string, name, Number(first[key]) || 0] as const), ['messages', 'messages (now)', p.messages] as const] as const).filter(x => x[2] > 0).sort((a, b) => b[2] - a[2])
  const out = [`context of this session by part (${first.full ? 'counted at its first turn end' : 'estimated'}; messages as of the latest turn end), tokens:`]
  for (const [key, name, v] of rows) out.push(`  ${String(v).padStart(7)}  ${name}: ${FIX[key] ?? ''}`)
  out.push(`  fixed ${first.fixed} + messages ${p.messages} = ${first.fixed + p.messages}${typeof r.request === 'number' ? ` · first request ${r.request} (first prompt ${Math.max(0, r.request - first.fixed)})` : ''}${typeof limit === 'number' ? ` · free for work ${Math.max(0, limit - first.fixed)} of ${limit}` : ''}`)
  const sl = first.skillsListed
  if (sl) out.push(`  skills listed: ${sl.included} of ${sl.total}; by source: ${Object.entries(sl.bySource).sort((a, b) => b[1].tokens - a[1].tokens).map(([s, v]) => `${s} ${v.n} (${v.tokens})`).join(', ')}`)
  if (first.mcpServers) out.push(`  MCP tools by server: ${Object.entries(first.mcpServers).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${v}`).join(', ')}`)
  return out.join('\n')
}
