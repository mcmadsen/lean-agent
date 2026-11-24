// `lean_doctor memory`: per scope the items and their tokens, what the last session really got (index and reminders), and a flag where a scope or a
// session's view is over its budget, so the user SEES that the memory does not bloat the context. Read-only, no model.
import { leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { INDEX_KINDS, memConfig, readItems, tok, visible } from './memory'
import type { Ctx, Item } from './memory'
import { INDEX_HEAD, indexLine } from './memoryindex'
import { threadCtx } from './memorytool'

type Injected = { ts: number; indexItems: number; indexTokens: number; more: number; reminders: number; reminderTokens: number }
const order = (s: string): number => (s === 'desk' ? 0 : s === 'global' ? 1 : s.startsWith('project:') ? 2 : s.startsWith('task:') ? 3 : 4)

export async function memoryRows(h: Host, home: string): Promise<{ lines: string[]; over: string[]; items: number }> {
  const cfg = await memConfig(h, home)
  const live = (await readItems(h, home)).filter(i => i.status !== 'retired')
  const lines: string[] = []
  const over: string[] = []
  const scopes = [...new Set(live.map(i => i.scope))].sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { numeric: true }))
  const cell = (s: string, n: number) => s.padEnd(n)
  for (const sc of scopes) {
    const mine = live.filter(i => i.scope === sc)
    const idx = mine.filter(i => i.status === 'active' && INDEX_KINDS.includes(i.kind))
    const idxTok = idx.reduce((n, i) => n + tok(indexLine(i)) + 1, 0)
    const rest = mine.filter(i => !idx.includes(i)).reduce((n, i) => n + tok(i.text), 0)
    const cand = mine.filter(i => i.status === 'candidate').length
    const flags = [idxTok + tok(INDEX_HEAD) > cfg.indexTokens ? `OVER the index budget of ${cfg.indexTokens}: retire or shorten (lean_memory list ${sc})` : '', mine.length >= cfg.maxPerScope ? `full (${cfg.maxPerScope})` : '', cand ? `${cand} candidate${cand > 1 ? 's' : ''} wait` : ''].filter(Boolean)
    if (flags.some(f => f.startsWith('OVER'))) over.push(sc)
    lines.push(`  ${cell(sc, 18)} ${String(mine.length).padStart(2)} items  index ${String(idxTok).padStart(4)} tokens  on demand ${String(rest).padStart(4)} tokens${flags.length ? `  <- ${flags.join('; ')}` : ''}`)
  }
  return { lines, over, items: live.length }
}

async function viewOf(h: Host, home: string, ctx: Ctx, budget: number): Promise<{ need: number; cut: boolean }> {
  const idx = (await readItems(h, home)).filter(i => i.status === 'active' && INDEX_KINDS.includes(i.kind) && visible(i.scope, ctx))
  const need = tok(INDEX_HEAD) + idx.reduce((n, i: Item) => n + tok(indexLine(i)) + 1, 0)
  return { need, cut: need > budget }
}

export async function memoryDoctor(h: Host, home: string): Promise<string> {
  const cfg = await memConfig(h, home)
  const { lines, over, items } = await memoryRows(h, home)
  if (!items) return `memory: nothing remembered yet (budgets: index ${cfg.indexTokens} tokens, reminders ${cfg.relevantTokens}, ${cfg.maxPerScope} per scope). /lean-agent:remember <text> adds one.`
  const last = await readJson<Record<string, Injected>>(h, `${leanDir(home)}/memory/last.json`, {})
  const injected = Object.entries(last).sort((a, b) => b[1].ts - a[1].ts).slice(0, 6).map(([who, r]) => `  ${who.padEnd(6)} index ${r.indexTokens} tokens (${r.indexItems} line${r.indexItems === 1 ? '' : 's'}${r.more ? `, +${r.more} cut` : ''}), reminders ${r.reminders} (${r.reminderTokens} tokens) ${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')}Z`)
  // what each open session would see: the desk, then every open thread (only the ones over budget are said, with their count)
  const views: string[] = []
  const desk = await viewOf(h, home, { role: 'desk' }, cfg.indexTokens)
  if (desk.cut) views.push(`desk: its index needs ${desk.need} tokens, budget ${cfg.indexTokens}: the lowest-ranked lines are cut ("+N more")`)
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    /* no threads */
  }
  for (const e of ents.filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<{ state?: string } | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.state === 'closed') continue
    const v = await viewOf(h, home, await threadCtx(h, home, e.name), cfg.indexTokens)
    if (v.cut) views.push(`${e.name}: its index needs ${v.need} tokens, budget ${cfg.indexTokens}: the lowest-ranked lines are cut ("+N more")`)
  }
  return [
    `memory: ${items} items in ${lines.length} scope${lines.length === 1 ? '' : 's'} (budgets: index ${cfg.indexTokens} tokens, reminders ${cfg.relevantTokens}, ${cfg.maxPerScope} items per scope; chars / 4)`,
    ...lines,
    injected.length ? 'what the last sessions got (index + reminders):' : 'what the last sessions got: nothing recorded yet',
    ...injected,
    over.length || views.length ? `OVER BUDGET: ${[...over.map(s => `${s} alone`), ...views].join('; ')}` : 'within budget: no scope or session view is over its index budget',
    'lean_memory prune suggests what to retire; retire / edit change one item.',
  ].join('\n')
}

// one row for `lean_doctor check`: null when nothing is remembered
export async function memoryRow(h: Host, home: string): Promise<{ ok: boolean; text: string } | null> {
  const { over, items } = await memoryRows(h, home)
  if (!items) return null
  const cfg = await memConfig(h, home)
  return over.length ? { ok: false, text: `memory: ${over.join(', ')} over the index budget of ${cfg.indexTokens} tokens (lean_doctor memory shows each scope; retire or shorten)` } : { ok: true, text: `memory: ${items} items, each scope within the index budget of ${cfg.indexTokens} tokens` }
}
