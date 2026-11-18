// Output squeezing (design 35) and tool trimming (design 34). Pure helpers; register.tsx wires them.
import { homeDir, leanDir, mkdirp, atomicWrite } from './state'
import type { Host } from './state'
import { deskToolPossible } from './guard'

export type SqueezeOpts = { maxLines?: number; head?: number; tail?: number }
const ERR = /\b(error|errors|fail|failed|failure|fatal|panic|exception|traceback|warning|denied|cannot|not found)\b|^\s*at\s|^E\s/i

// Short form of a long output: first lines, every error-looking line (with its neighbours), last lines.
export function squeezeText(text: string, o: SqueezeOpts = {}): { text: string; squeezed: boolean } {
  const max = o.maxLines ?? 80
  const lines = text.split('\n')
  if (lines.length <= max) return { text, squeezed: false }
  const head = o.head ?? 15
  const tail = o.tail ?? 25
  const keep = new Set<number>()
  for (let i = 0; i < head; i++) keep.add(i)
  for (let i = lines.length - tail; i < lines.length; i++) keep.add(i)
  lines.forEach((l, i) => {
    if (ERR.test(l)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j)
  })
  const out: string[] = []
  let last = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push(`[... ${i - last - 1} lines squeezed ...]`)
    out.push(lines[i]!)
    last = i
  }
  return { text: out.join('\n'), squeezed: true }
}

const textOf = (r: any): string | null => (typeof r === 'string' ? r : Array.isArray(r) && r.every(b => b && b.type === 'text' && typeof b.text === 'string') ? r.map((b: any) => b.text).join('\n') : null)

// Squeeze a Bash tool result; the full text is saved under ~/.lean-agent/output/. Anything else passes unchanged.
export async function squeezeResult(h: Host, r: any, o: SqueezeOpts = {}): Promise<any> {
  if (!r || r.deny !== undefined) return r
  const t = textOf(r.result)
  if (t === null) return r
  const s = squeezeText(t, o)
  if (!s.squeezed) return r
  const dir = `${leanDir(await homeDir(h))}/output`
  const file = `${dir}/${await h.clock.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  try {
    await mkdirp(h, dir)
    await atomicWrite(h, file, t)
  } catch {
    return r // cannot save the full text: never drop it
  }
  return { ...r, result: `${s.text}\n[lean-agent: output squeezed from ${t.split('\n').length} lines; full text in ${file}]` }
}

// ---- tool trimming: config.json `tools: { desk|thread|plain: { drop: ["Glob", "mcp__x__*"] } }` -------------------
export type ToolsCfg = Partial<Record<'desk' | 'thread' | 'plain', { drop?: string[] }>>
const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')

export function trimTools<T extends { name: string }>(tools: T[], role: 'desk' | 'thread' | 'plain', cfg: ToolsCfg | undefined): T[] {
  // the desk's pool is only what strict mode can allow (guard.ts); the rest would be dead weight in every request
  if (role === 'desk') tools = tools.filter(t => deskToolPossible(t.name))
  const drops = (cfg?.[role]?.drop ?? []).map(globRe)
  if (!drops.length) return tools
  // lean-agent's own tools are never dropped
  return tools.filter(t => t.name.startsWith('mcp__lean-agent__') || !drops.some(re => re.test(t.name)))
}

// A skill listing keeps its non-skill lines and the `lean-agent:` skill lines; null when it names no lean-agent skill
// (then the engine's text stands untouched, so a format change never empties the list).
export function leanSkillsOnly(text: string): string | null {
  const isSkill = (l: string) => /^- \S/.test(l)
  const out: string[] = []
  let dropping = false
  let dropped = false
  let kept = false
  for (const l of text.split('\n')) {
    if (isSkill(l)) {
      dropping = !l.startsWith('- lean-agent:')
      if (dropping) dropped = true
      else kept = true
    } else if (dropping && /^\s+\S/.test(l)) continue // a wrapped description of a dropped skill
    else dropping = false
    if (!dropping) out.push(l)
  }
  return kept && dropped ? out.join('\n') : null
}
