// Standing rules of ONE thread (1.0.31): the desk's `lean_thread rule tN <text> [on|off]` and the `rules: [..]` of `new` store scope thread:<tN> items (kind
// rule) in the one memory store (memory.ts). The thread has them in its standing orders (the index: rank 1) at its first prompt and at every restart; they are
// listed (a count in `list` and the pane), edited and retired with lean_memory edit / retire; they never reach another thread or project and never touch
// CLAUDE.md or a project's rule files. A follow-on thread inherits them ONLY when the user said so (the desk's `inherit`, checked against the user's words).
import { threadsDir } from './state'
import type { Host } from './state'
import { addItem, flat, memConfig, overlap, readItems, refuseText, retireItem, words } from './memory'
import { deskCtx } from './memorytool'
import { recentPrompts } from './humanprompts'

export type R = { ok: boolean; text: string }
const ID = /^t\d+$/
const exists = (h: Host, home: string, id: string): Promise<boolean> => h.fs.exists(`${threadsDir(home)}/${id}/thread.json`).catch(() => false)

export async function ruleCount(h: Host, home: string, id: string): Promise<number> {
  return (await readItems(h, home).catch(() => [])).filter(i => i.scope === `thread:${id}` && i.kind === 'rule' && i.status === 'active').length
}

// `rule tN <text> [on|off]`: on (default) adds, off retires the rule that says that (an id like m4, or the text), or all of the thread's rules when no text is given
export async function ruleAction(h: Host, home: string, i: { tN?: string; text?: string; on?: boolean; trigger?: string; output?: string }): Promise<R> {
  const id = (i.tN ?? '').trim()
  if (!ID.test(id)) return { ok: false, text: 'rule needs tN (like t3) and the rule text' }
  if (!(await exists(h, home, id))) return { ok: false, text: `no thread ${id}` }
  const text = flat(i.text ?? '')
  const mine = (await readItems(h, home)).filter(x => x.scope === `thread:${id}` && x.kind === 'rule' && x.status !== 'retired')
  if (i.on === false) {
    const pick = !text ? mine : /^m\d+$/.test(text) ? mine.filter(x => x.id === text) : mine.filter(x => overlap(words(text), words(x.text)) >= 0.7)
    if (!pick.length) return { ok: false, text: text ? `${id} has no rule that says "${text.slice(0, 60)}" (lean_memory list thread:${id})` : `${id} has no standing rule` }
    for (const x of pick) await retireItem(h, home, x.id, { role: 'desk' })
    return { ok: true, text: `${id}: ${pick.length} standing rule${pick.length > 1 ? 's' : ''} off (${pick.map(x => x.id).join(', ')})` }
  }
  if (!text) return { ok: false, text: 'rule needs the rule text (on: false with no text turns every rule of the thread off)' }
  const o = await addItem(h, home, { text, scope: `thread:${id}`, kind: 'rule', trigger: i.trigger, output: i.output, source: 'desk' }, await deskCtx(h, home))
  if (!o.ok) return { ok: false, text: o.text }
  const n = await ruleCount(h, home, id)
  return { ok: true, text: `${o.text}; ${id} has ${n} standing rule${n === 1 ? '' : 's'}: it gets them at its first prompt and at every restart (a running thread from its next turn); lean_memory edit / retire change one` }
}

// before a thread is created: the rules to store (an error stops `new` before any folder exists)
export type Prepared = { rules: string[]; from?: string }
export async function prepareRules(h: Host, home: string, i: { rules?: unknown; inherit?: unknown; tN?: string }): Promise<Prepared | string> {
  const raw = i.rules
  if (raw !== undefined && (!Array.isArray(raw) || raw.some(r => typeof r !== 'string'))) return 'new: rules is a list of texts (200 characters each)'
  const rules = ((raw ?? []) as string[]).map(flat).filter(Boolean)
  const cfg = await memConfig(h, home)
  if (rules.length > cfg.maxPerScope) return `new: ${rules.length} rules, at most ${cfg.maxPerScope} per thread (memory.maxPerScope)`
  for (const r of rules) {
    const bad = refuseText(r)
    if (bad) return `new: rule "${r.slice(0, 40)}": ${bad}. No thread was created`
  }
  let from: string | undefined
  if (i.inherit !== undefined && i.inherit !== false) {
    from = typeof i.inherit === 'string' ? i.inherit.trim() : (i.tN ?? '').trim()
    if (!ID.test(from)) return 'new: inherit names the thread whose rules the new one carries (inherit: "t3", or inherit: true with tN). No thread was created'
    if (!(await exists(h, home, from))) return `new: inherit: no thread ${from}. No thread was created`
    if (!(await userSaidInherit(h))) return `new: inherit needs the user's own words (for example "same rules as ${from}", "carry the rules over"): none recorded in the last 24 h. Ask the user, or leave inherit out: thread rules never reach another thread on their own. No thread was created`
  }
  return { rules, from }
}
// the user's own typed words ask for the rules to carry over
async function userSaidInherit(h: Host): Promise<boolean> {
  return (await recentPrompts(h).catch(() => [])).some(p => /\brules?\b/i.test(p.text) && /\b(inherit\w*|carry\w*|same|keep|copy|continue\w*|as before|too)\b/i.test(p.text))
}

// after the thread exists: its own rules, then (inherit) the rules of the thread it follows
export async function storeRules(h: Host, home: string, id: string, p: Prepared): Promise<string> {
  const ctx = await deskCtx(h, home)
  const bad: string[] = []
  let n = 0
  for (const r of p.rules) {
    const o = await addItem(h, home, { text: r, scope: `thread:${id}`, kind: 'rule', source: 'desk' }, ctx)
    if (o.ok) n++
    else bad.push(o.text)
  }
  let inherited = 0
  if (p.from) {
    const src = (await readItems(h, home)).filter(x => x.scope === `thread:${p.from}` && x.kind === 'rule' && x.status === 'active')
    for (const x of src) {
      const o = await addItem(h, home, { text: x.text, scope: `thread:${id}`, kind: 'rule', trigger: x.trigger, output: x.output, source: 'desk', viaCommand: true }, ctx)
      if (o.ok) inherited++
    }
  }
  return [n ? `${n} standing rule${n > 1 ? 's' : ''} stored for ${id}` : '', inherited ? `${inherited} inherited from ${p.from} (the user asked)` : '', ...bad.map(b => `rule not stored: ${b}`)].filter(Boolean).join('; ')
}
