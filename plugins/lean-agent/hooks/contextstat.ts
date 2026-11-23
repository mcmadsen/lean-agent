// `lean_doctor context` (execution model, measure): what filled a session's context, from its transcript by script: tokens added by tool
// and by result size, the 10 largest single results, delegated (Agent results) against direct tokens, and the Haiku share of the model
// output. Tokens are estimated as characters / 4 (the transcript has no per-result count).
import { readJson, threadsDir } from './state'
import type { Host } from './state'
import { deskFile } from './delivery'

export type Top = { tool: string; tokens: number; at: number }
export type ContextStat = {
  byTool: Record<string, { calls: number; tokens: number }>
  buckets: Record<string, number>
  top: Top[]
  delegated: number
  direct: number
  haikuShare: number
}

const tokensOf = (chars: number) => Math.ceil(chars / 4)
export const bucketOf = (tokens: number): string => (tokens < 1000 ? '<1k' : tokens < 5000 ? '1-5k' : tokens < 20000 ? '5-20k' : '>20k')

// the text of a tool_result's content (a string, or text blocks)
function textLen(c: unknown): number {
  if (typeof c === 'string') return c.length
  if (Array.isArray(c)) return c.reduce((n: number, b: any) => n + (b && typeof b === 'object' && typeof b.text === 'string' ? b.text.length : 0), 0)
  return 0
}

export function contextStat(records: any[]): ContextStat {
  const names = new Map<string, string>() // tool_use id -> tool name
  const out: ContextStat = { byTool: {}, buckets: { '<1k': 0, '1-5k': 0, '5-20k': 0, '>20k': 0 }, top: [], delegated: 0, direct: 0, haikuShare: 0 }
  const models: Record<string, number> = {}
  let all = 0
  records.forEach((r, at) => {
    const m = r?.message
    if (!m || typeof m !== 'object') return
    if (r.type === 'assistant') {
      const u = m.usage
      if (u && typeof u === 'object') {
        const n = (Number(u.output_tokens) || 0) + (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
        const name = String(m.model ?? '')
        models[name] = (models[name] ?? 0) + n
        all += n
      }
    }
    if (!Array.isArray(m.content)) return
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_use' && typeof b.id === 'string') names.set(b.id, String(b.name ?? '?'))
      if (b.type === 'tool_result') {
        const tool = names.get(String(b.tool_use_id)) ?? '?'
        const tokens = tokensOf(textLen(b.content))
        const t = (out.byTool[tool] ??= { calls: 0, tokens: 0 })
        t.calls++
        t.tokens += tokens
        out.buckets[bucketOf(tokens)]!++
        if (tool === 'Agent' || tool === 'Task') out.delegated += tokens
        else out.direct += tokens
        out.top.push({ tool, tokens, at })
      }
    }
  })
  out.top.sort((a, b) => b.tokens - a.tokens)
  out.top = out.top.slice(0, 10)
  const haiku = Object.entries(models).reduce((n, [k, v]) => n + (/haiku/i.test(k) ? v : 0), 0)
  out.haikuShare = all > 0 ? haiku / all : 0
  return out
}

export function contextText(s: ContextStat, label = ''): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const tools = Object.entries(s.byTool).sort((a, b) => b[1].tokens - a[1].tokens)
  const total = s.delegated + s.direct
  return [
    `context ${label}(tokens estimated as chars/4)`,
    'by tool:',
    ...(tools.length ? tools.map(([n, v]) => `  ${n}: ${v.calls} result(s), ${k(v.tokens)}`) : ['  none']),
    `by result size: ${Object.entries(s.buckets).map(([b, n]) => `${b} ${n}`).join(' · ')}`,
    'top results:',
    ...(s.top.length ? s.top.map((t, i) => `  ${i + 1}. ${t.tool} ${k(t.tokens)} (record ${t.at})`) : ['  none']),
    `delegated (Agent results): ${k(s.delegated)} · direct: ${k(s.direct)}${total ? ` · delegated share ${Math.round((100 * s.delegated) / total)}%` : ''}`,
    `haiku share of model tokens: ${Math.round(s.haikuShare * 100)}%`,
  ].join('\n')
}

// The three biggest sources of a session's context, one suggested fix each (by script, from the stat: no model reads the transcript).
const FIX: [RegExp, string][] = [
  [/^(Agent|Task)$/, 'worker results are the biggest block: ask for the job schema only (job: lookup answers `path:line: fact`), one step per brief, and read less yourself'],
  [/^Bash$/, 'pipe long output through head / tail / grep, send tests and builds through lean_run (it keeps the output in a file), never cat a log'],
  [/^Read$/, 'read with offset and limit after a grep, or let a reader-haiku summarise the file; do not re-read a file already in context'],
  [/^(Grep|Glob)$/, 'narrow the pattern and path (or use -l / head_limit), a broad search result stays in context for the whole session'],
  [/^(Edit|Write|MultiEdit)$/, 'edits echo their text: give the edit to a worker-haiku and keep only its one-line result'],
  [/^mcp__/, 'an MCP result: ask a reader-mcp worker (allow-mcp) and keep its short answer, or request fewer fields'],
]
export const fixFor = (tool: string): string => FIX.find(([re]) => re.test(tool))?.[1] ?? 'keep this tool\'s results out of your own context: give the step to a small worker and take its short answer'
export function topSources(s: ContextStat, n = 3): { tool: string; tokens: number; calls: number; fix: string }[] {
  return Object.entries(s.byTool)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, n)
    .map(([tool, v]) => ({ tool, tokens: v.tokens, calls: v.calls, fix: fixFor(tool) }))
}
export function sourcesText(s: ContextStat): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const total = Object.values(s.byTool).reduce((n, v) => n + v.tokens, 0)
  const top = topSources(s)
  return ['top sources:', ...(top.length ? top.map((t, i) => `  ${i + 1}. ${t.tool}: ${k(t.tokens)} in ${t.calls} result(s)${total ? ` (${Math.round((100 * t.tokens) / total)}%)` : ''} - fix: ${t.fix}`) : ['  none'])].join('\n')
}

// the transcript: <home>/.claude/projects/<folder>/<session>.jsonl, the named session or the newest one
export async function findTranscript(h: Host, home: string, session?: string): Promise<string | null> {
  const root = `${home}/.claude/projects`
  const script = session ? `ls "${root}"/*/${session.replace(/[^\w-]/g, '')}.jsonl 2>/dev/null | head -1` : `ls -t "${root}"/*/*.jsonl 2>/dev/null | head -1`
  const r = await h.process.run(['bash', '-c', script])
  const p = r.stdout.trim().split('\n')[0]?.trim()
  return r.exitCode === 0 && p ? p : null
}

// the records of a transcript file (a damaged line is skipped)
export async function readRecords(h: Host, file: string): Promise<any[]> {
  const recs: any[] = []
  for (const l of String((await h.fs.read(file)) ?? '').split('\n')) {
    if (!l.trim()) continue
    try {
      recs.push(JSON.parse(l))
    } catch {
      /* a damaged line is skipped */
    }
  }
  return recs
}

// ---- the DESK's own conversation: what its Messages consist of ----------------------------------------------------------------
// The desk only routes, yet its conversation grows: every thread report that reaches it, every lean_thread / lean_doctor reply, the
// user's long pastes. Tokens by source (chars / 4), the ten largest single items by kind and time (never their text), growth per turn.
export type DeskItem = { kind: string; tokens: number; at: string }
export type DeskStat = { by: Record<string, { items: number; tokens: number }>; top: DeskItem[]; turns: number; total: number; perTurn: number; recentPerTurn: number; sizeFirst: number; sizeLast: number }
export const SRC_REPORTS = 'thread reports delivered'
export const SRC_USER = "the user's prompts"
export const SRC_DESK = "the desk's own answers"
export const SRC_OTHER = 'other tool results'

const blocksText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n') : '')
const REPORT_MARK = /^\s*\[lean-agent\]|<!--\s*lean:r=\d+:t\d+:(?:report|ask)\s*-->/

export function deskStat(records: any[]): DeskStat {
  const names = new Map<string, { tool: string; action: string }>() // tool_use id -> tool name and action
  const by: DeskStat['by'] = {}
  const items: DeskItem[] = []
  const turnTokens: number[] = []
  let size0 = 0
  let sizeN = 0
  const add = (kind: string, chars: number, at: string) => {
    const tokens = tokensOf(chars)
    if (tokens <= 0) return
    const s = (by[kind] ??= { items: 0, tokens: 0 })
    s.items++
    s.tokens += tokens
    items.push({ kind, tokens, at })
    if (turnTokens.length) turnTokens[turnTokens.length - 1]! += tokens
  }
  for (const r of records) {
    const m = r?.message
    if (!r || r.isSidechain === true) continue
    const at = typeof r.timestamp === 'string' ? r.timestamp : ''
    if (r.type === 'attachment') {
      const t = blocksText(r.attachment?.content ?? r.attachment?.text)
      if (REPORT_MARK.test(t)) add(SRC_REPORTS, t.length, at)
      continue
    }
    if (!m || typeof m !== 'object') continue
    if (r.type === 'assistant') {
      const n = contextTokensOf(m.usage)
      if (n > 0) {
        if (!size0) size0 = n
        sizeN = n
      }
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          const inp = b.input && typeof b.input === 'object' ? (b.input as any) : {}
          names.set(b.id, { tool: String(b.name ?? '?'), action: typeof inp.action === 'string' ? inp.action : '' })
        }
        if (b.type === 'text' && typeof b.text === 'string') add(SRC_DESK, b.text.length, at)
        else if (b.type === 'tool_use') add(SRC_DESK, JSON.stringify(b.input ?? {}).length + String(b.name ?? '').length, at)
      }
      continue
    }
    if (r.type !== 'user') continue
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    const results = parts.filter((b: any) => b?.type === 'tool_result')
    if (!results.length && parts.length) turnTokens.push(0) // a prompt (the user's or a delivered report) starts a turn
    for (const b of parts) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_result') {
        const n = names.get(String(b.tool_use_id))
        const t = n?.tool ?? '?'
        const kind = /lean_thread$/.test(t) ? `lean_thread ${n!.action || '?'} replies` : /lean_doctor$/.test(t) ? `lean_doctor ${n!.action || '?'} replies` : SRC_OTHER
        add(kind, textLen(b.content), at)
      } else if (b.type === 'text' && typeof b.text === 'string') add(REPORT_MARK.test(b.text) ? SRC_REPORTS : SRC_USER, b.text.length, at)
    }
  }
  const total = Object.values(by).reduce((n, v) => n + v.tokens, 0)
  const turns = turnTokens.length
  const recent = turnTokens.slice(-5)
  return {
    by,
    top: items.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    turns,
    total,
    perTurn: turns ? Math.round(total / turns) : 0,
    recentPerTurn: recent.length ? Math.round(recent.reduce((n, v) => n + v, 0) / recent.length) : 0,
    sizeFirst: size0,
    sizeLast: sizeN,
  }
}
const contextTokensOf = (u: any): number => (u && typeof u === 'object' ? (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) : 0)

export function deskText(s: DeskStat, label = ''): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const rows = Object.entries(s.by).sort((a, b) => b[1].tokens - a[1].tokens)
  const lt = rows.filter(([n]) => n.startsWith('lean_thread ')).reduce((n, [, v]) => n + v.tokens, 0)
  const ld = rows.filter(([n]) => n.startsWith('lean_doctor ')).reduce((n, [, v]) => n + v.tokens, 0)
  const pct = (n: number) => (s.total ? `${Math.round((100 * n) / s.total)}%` : '0%')
  return [
    `desk context ${label}(Messages ${k(s.total)} in ${s.turns} turn(s); tokens estimated as chars/4)`,
    'by source:',
    ...(rows.length ? rows.map(([n, v]) => `  ${n}: ${v.items} item(s), ${k(v.tokens)} (${pct(v.tokens)})`) : ['  none']),
    `lean_thread replies together ${k(lt)} (${pct(lt)}) · lean_doctor replies together ${k(ld)} (${pct(ld)})`,
    'ten largest items (kind, size, time):',
    ...(s.top.length ? s.top.map((t, i) => `  ${i + 1}. ${t.kind} ${k(t.tokens)}${t.at ? ` at ${t.at}` : ''}`) : ['  none']),
    `growth per turn: ${k(s.perTurn)} on average, ${k(s.recentPerTurn)} over the last 5${s.sizeLast ? ` · the engine's own count: ${k(s.sizeFirst)} at the first reply, ${k(s.sizeLast)} now` : ''}`,
  ].join('\n')
}

// `session` may be a thread id (tN): the transcript of that thread's current session, and the top three sources with a fix each.
// No session, or "desk": the DESK's conversation (desk.json names it; the newest transcript when none is recorded): deskStat.
export async function contextReport(h: Host, home: string, session?: string): Promise<string> {
  try {
    if (!session || session === 'desk') {
      const sid = String((await readJson<{ sid?: string }>(h, deskFile(home), {}))?.sid ?? '')
      const file = await findTranscript(h, home, /^[\w-]+$/.test(sid) ? sid : undefined)
      if (!file) return `context: no desk transcript found under ${home}/.claude/projects`
      return deskText(deskStat(await readRecords(h, file)), `${file.split('/').pop()} `)
    }
    const thread = session && /^t\d+$/.test(session) ? session : ''
    if (thread) session = (await readJson<{ sid?: string }>(h, `${threadsDir(home)}/${thread}/thread.json`, {})).sid || undefined
    if (thread && !session) return `context: ${thread} has no session yet`
    const file = await findTranscript(h, home, session)
    if (!file) return `context: no session transcript found under ${home}/.claude/projects${session ? ` for ${session}` : ''}`
    const stat = contextStat(await readRecords(h, file))
    return [contextText(stat, `${thread ? `${thread} ` : ''}${file.split('/').pop()} `), ...(thread ? [sourcesText(stat)] : [])].join('\n')
  } catch (err) {
    return `context failed: ${String((err as Error)?.message ?? err)}`
  }
}
