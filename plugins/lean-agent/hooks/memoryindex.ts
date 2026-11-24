// RETRIEVAL WITHOUT BLOAT (1.0.31): what of the memory reaches a session, all by script, no model call.
//   index     one line per active rule / preference / correction in scope, ranked thread > task > project > global, cut to config memory.indexTokens (400):
//             the lowest-ranked lines are dropped and the last line says "+N more: lean_memory find". Given at session start (prompt section, which stays after a
//             compaction) and in the restart handover. Facts and decisions are NOT in it: they are found by words or reminded by relevance.
//   relevant  on each prompt / task brief: a word match (token overlap) picks at most 3 items that are not in the index, at most config memory.relevantTokens (300),
//             one "memory: ..." line; an item is reminded once per session; nothing when nothing matches.
//   triggers  a rule with a trigger gets one line at that event (a commit, a finished step, a push, a PR opened) with its output path; at most one line per turn.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'
import type { Role } from './role'
import { retireText } from './forgewrite'
import { INDEX_KINDS, flat, memConfig, rankOf, readItems, tok, touch, visible, words } from './memory'
import type { Ctx, Item } from './memory'
import { deskCtx, threadCtx } from './memorytool'

export const INDEX_HEAD = "Standing orders from the user (always in force; the newest word wins; the most specific first):"
const tag = (scope: string): string => (scope.includes(':') ? scope.split(':')[0]! : scope)
const recency = (i: Item): number => Math.max(i.lastUsed, i.created)
const cmp = (a: Item, b: Item): number => rankOf(a.scope) - rankOf(b.scope) || recency(b) - recency(a) || b.uses - a.uses || Number(a.id.slice(1)) - Number(b.id.slice(1))
export const indexLine = (i: Item): string => `- ${i.id} (${tag(i.scope)}) ${flat(retireText(i.text))}${i.trigger || i.output ? ` [${[i.trigger, i.output ? `-> ${i.output}` : ''].filter(Boolean).join(' ')}]` : ''}`

export type Index = { text: string; shown: string[]; more: number; other: number; tokens: number }
export async function memoryIndex(h: Host, home: string, ctx: Ctx, o: { budget?: number } = {}): Promise<Index> {
  const budget = o.budget ?? (await memConfig(h, home)).indexTokens
  const all = (await readItems(h, home)).filter(i => i.status === 'active' && visible(i.scope, ctx))
  const idx = all.filter(i => INDEX_KINDS.includes(i.kind)).sort(cmp)
  const other = all.length - idx.length
  if (!all.length) return { text: '', shown: [], more: 0, other: 0, tokens: 0 }
  const pull = ctx.role === 'desk' ? 'lean_memory find <words>' : 'lean_run {pull: "memory", section: "<words>"}'
  const footer = (hidden: number): string => (hidden > 0 || other > 0 ? `\n${[hidden > 0 ? `+${hidden} more` : '', other > 0 ? `${hidden > 0 ? 'and ' : ''}${other} facts and decisions` : ''].filter(Boolean).join(' ')}: ${pull}` : '')
  const lines: string[] = []
  const shown: string[] = []
  for (const i of idx) {
    const l = indexLine(i)
    if (tok(`${INDEX_HEAD}\n${[...lines, l].join('\n')}${footer(idx.length - lines.length - 1)}`) > budget) break
    lines.push(l)
    shown.push(i.id)
  }
  const more = idx.length - shown.length
  if (!shown.length && !more && !other) return { text: '', shown, more, other, tokens: 0 }
  const text = `${INDEX_HEAD}${lines.length ? `\n${lines.join('\n')}` : ''}${footer(more)}`
  return { text, shown, more, other, tokens: tok(text) }
}

// ---- what the last session really got (lean_doctor memory) ------------------------------------------------------------------------
type Injected = { ts: number; indexItems: number; indexTokens: number; more: number; reminders: number; reminderTokens: number }
const lastFile = (home: string) => `${leanDir(home)}/memory/last.json`
const who = (role: Role): string => (role.kind === 'thread' ? role.id : 'desk')
const sig = new Map<string, string>()
export const resetMemorySession = (): void => {
  sig.clear()
  seen.clear()
  firedTurn = false
}
async function note(h: Host, home: string, key: string, fn: (r: Injected) => Injected): Promise<void> {
  const all = await readJson<Record<string, Injected>>(h, lastFile(home), {})
  const cur = all[key] ?? { ts: 0, indexItems: 0, indexTokens: 0, more: 0, reminders: 0, reminderTokens: 0 }
  const next = fn(cur)
  const keep = Object.fromEntries(Object.entries({ ...all, [key]: next }).sort((a, b) => b[1].ts - a[1].ts).slice(0, 30))
  await writeJson(h, lastFile(home), keep)
}

// the prompt section of a session (desk and thread): the index; null = nothing to say
export async function sessionIndex(h: Host, role: Role): Promise<string | null> {
  if (role.kind !== 'desk' && role.kind !== 'thread') return null
  const home = await homeDir(h)
  const ctx = role.kind === 'thread' ? await threadCtx(h, home, role.id) : await deskCtx(h, home)
  const ix = await memoryIndex(h, home, ctx)
  const key = who(role)
  const s = `${ix.shown.join(',')}|${ix.more}|${ix.tokens}`
  if (sig.get(key) !== s) {
    sig.set(key, s)
    const ts = await h.clock.now()
    await note(h, home, key, r => ({ ...r, ts, indexItems: ix.shown.length, indexTokens: ix.tokens, more: ix.more })).catch(() => undefined)
  }
  return ix.text || null
}

// ---- relevant reminders ------------------------------------------------------------------------------------------------------------
const seen = new Set<string>() // item ids reminded in this session (the process): once each
export async function relevantLine(h: Host, home: string, ctx: Ctx, text: string, key = 'desk'): Promise<string | null> {
  const pw = words(text)
  if (!pw.size) return null
  const cfg = await memConfig(h, home)
  const all = (await readItems(h, home)).filter(i => i.status === 'active' && visible(i.scope, ctx))
  if (!all.length) return null
  const inIndex = new Set((await memoryIndex(h, home, ctx)).shown)
  const scored = all
    .filter(i => !inIndex.has(i.id) && !seen.has(i.id))
    .map(i => {
      const iw = words(i.text)
      let n = 0
      for (const w of iw) if (pw.has(w)) n++
      return { i, n, ok: n >= 2 || (n >= 1 && iw.size <= 3) }
    })
    .filter(x => x.ok)
    .sort((a, b) => b.n - a.n || cmp(a.i, b.i))
    .slice(0, 3)
  if (!scored.length) return null
  const lineOf = (ps: Item[]): string => `memory: ${ps.map(p => `${p.id} (${tag(p.scope)}) ${flat(retireText(p.text))}`).join(' | ')}`
  const parts: Item[] = []
  for (const { i } of scored) {
    if (parts.length && tok(lineOf([...parts, i])) > cfg.relevantTokens) break
    parts.push(i)
  }
  for (const p of parts) seen.add(p.id)
  await touch(h, home, parts.map(p => p.id))
  const line = lineOf(parts)
  const ts = await h.clock.now()
  await note(h, home, key, r => ({ ...r, ts, reminders: r.reminders + 1, reminderTokens: r.reminderTokens + tok(line) })).catch(() => undefined)
  return line
}

// ---- triggers -------------------------------------------------------------------------------------------------------------------------
let firedTurn = false
export const resetTurn = (): void => {
  firedTurn = false
}
// which trigger event a finished tool call is (null = none)
export function eventOf(tool: string, e: Record<string, unknown>): string | null {
  const t = tool.replace(/^mcp__lean-agent__/, '')
  if (t === 'Bash') {
    const c = String(e.command ?? '')
    if (/\b(gh\s+pr\s+create|az\s+repos\s+pr\s+create)\b/.test(c)) return 'on-pr-open'
    if (/\bgit\b[^|;&\n]*\bcommit\b/.test(c)) return 'after-commit'
    if (/\bgit\b[^|;&\n]*\bpush\b/.test(c)) return 'before-push'
    return null
  }
  if (t === 'TaskUpdate' && e.status === 'completed') return 'after-step'
  if (t === 'lean_run' && e.checkpoint) return 'after-step'
  if (t === 'lean_review' && e.level === 'full') return 'before-push' // the review a push needs
  if (t === 'lean_thread' && (e.action === 'push' || e.action === 'approve-push')) return e.action === 'push' && e.pr ? 'on-pr-open' : 'before-push'
  return null
}
export async function triggerLine(h: Host, home: string, ctx: Ctx, event: string, text = ''): Promise<string | null> {
  if (firedTurn) return null // one line per turn
  const cfg = await memConfig(h, home)
  const tw = words(text)
  const hit = (await readItems(h, home)).filter(i => {
    if (i.status !== 'active' || !i.trigger || !visible(i.scope, ctx)) return false
    if (event !== 'keyword') return i.trigger === event
    if (i.trigger.startsWith('keyword:')) return text.toLowerCase().includes(i.trigger.slice(8).toLowerCase())
    return i.trigger === 'keyword' && [...words(i.text)].filter(w => tw.has(w)).length >= 2
  })
  if (!hit.length) return null
  const out: string[] = []
  for (const i of hit.sort(cmp).slice(0, 3)) {
    const piece = `${i.id} ${flat(retireText(i.text))}${i.output ? ` -> update ${i.output}` : ''}`
    if (out.length && tok(`memory trigger (${event}): ${[...out, piece].join(' | ')}`) > cfg.relevantTokens) break
    out.push(piece)
  }
  firedTurn = true
  await touch(h, home, hit.slice(0, out.length).map(i => i.id))
  return `memory trigger (${event}): ${out.join(' | ')}`
}

// the index text of a thread, for its restart handover (handover.ts) and of the desk, for the desk's own (deskcompact.ts)
export async function indexText(h: Host, home: string, id: string): Promise<string> {
  return (await memoryIndex(h, home, id === 'desk' ? await deskCtx(h, home) : await threadCtx(h, home, id))).text
}

// what a prompt and a finished tool call ask of the memory (register.tsx calls these two)
export async function relevantOnPrompt(h: Host, role: Role, text: string): Promise<string | null> {
  if (role.kind !== 'desk' && role.kind !== 'thread') return null
  const home = await homeDir(h)
  const ctx = role.kind === 'thread' ? await threadCtx(h, home, role.id) : await deskCtx(h, home)
  const kw =await triggerLine(h, home, ctx, 'keyword', text) // (a keyword trigger fires on the prompt that names it)
  const rel = await relevantLine(h, home, ctx, text, who(role))
  return [kw, rel].filter(Boolean).join('\n') || null
}
export async function triggerOnTool(h: Host, role: Role, tool: string, e: Record<string, unknown>): Promise<string | null> {
  if (role.kind !== 'desk' && role.kind !== 'thread') return null
  const ev = eventOf(tool, e)
  if (!ev) return null
  const home = await homeDir(h)
  return triggerLine(h, home, role.kind === 'thread' ? await threadCtx(h, home, role.id) : await deskCtx(h, home), ev)
}
