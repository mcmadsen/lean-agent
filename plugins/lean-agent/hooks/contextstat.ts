// `lean_doctor context` (execution model, measure): what filled a session's context, from its transcript by script: tokens added by tool
// and by result size, the 10 largest single results, delegated (Agent results) against direct tokens, and the Haiku share of the model
// output. Tokens are estimated as characters / 4 (the transcript has no per-result count).
import type { Host } from './state'

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

export async function contextReport(h: Host, home: string, session?: string): Promise<string> {
  try {
    const file = await findTranscript(h, home, session)
    if (!file) return `context: no session transcript found under ${home}/.claude/projects${session ? ` for ${session}` : ''}`
    return contextText(contextStat(await readRecords(h, file)), `${file.split('/').pop()} `)
  } catch (err) {
    return `context failed: ${String((err as Error)?.message ?? err)}`
  }
}
