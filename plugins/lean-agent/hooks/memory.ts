// ONE memory store (1.0.31): what the user told the agents to remember, kept by script, shown by script, never written to CLAUDE.md or a project's rule files.
//   file:   ~/.lean-agent/memory/items.json (the mod's private store, outside every repo; the guard keeps model writes out of ~/.lean-agent)
//   scopes: desk | global | project:<name> | thread:<tN> | task:<id>      kinds: rule | fact | decision | preference | correction
// The model only writes the text; scripts decide the scope (when they can), refuse secrets and long texts, merge near-duplicates, cap each scope and
// choose what is shown (memoryindex.ts: the index, the relevant reminders, the triggers). Old notes (memory/notes.jsonl, `lean_remember` before 1.0.31)
// are imported once, newest first, up to the cap per scope; the file itself stays.
import { leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { retireText } from './forgewrite'
import { recentPrompts } from './humanprompts'

export const KINDS = ['rule', 'fact', 'decision', 'preference', 'correction'] as const
export const TRIGGERS = ['after-commit', 'after-step', 'before-push', 'on-pr-open', 'keyword'] as const
export type Kind = (typeof KINDS)[number]
export type Source = 'user-typed' | 'desk' | 'thread' | 'script'
export type Status = 'active' | 'candidate' | 'retired'
export type Item = { id: string; scope: string; kind: Kind; text: string; created: number; source: Source; uses: number; lastUsed: number; status: Status; trigger?: string; output?: string; shown?: boolean; note?: string }
type Store = { next: number; items: Item[] }

export const TEXT_MAX = 200
export const MAX_PER_SCOPE = 12 // config memory.maxPerScope
export const INDEX_TOKENS = 400 // config memory.indexTokens
export const RELEVANT_TOKENS = 300 // config memory.relevantTokens
export const RETIRED_KEPT = 40
export const tok = (s: string): number => Math.ceil(s.length / 4)
export const INDEX_KINDS: readonly Kind[] = ['rule', 'preference', 'correction'] // what the index lists; facts and decisions are found by words (find) or by relevance

// who is asking: the user at the prompt, the desk, or a thread (a thread may only remember for itself, its project or a task)
export type Ctx = { role: 'desk' | 'thread'; id?: string; project?: string; tasks?: string[]; projects?: string[] }
export type Out = { ok: boolean; text: string; id?: string; ask?: boolean; item?: Item }

export type MemConfig = { maxPerScope: number; indexTokens: number; relevantTokens: number; autoCapture: boolean }
export async function memConfig(h: Host, home: string): Promise<MemConfig> {
  const m = ((await readConfig(h, home).catch(() => ({}))) as { memory?: Record<string, unknown> })?.memory ?? {}
  const n = (v: unknown, d: number, min: number) => (Number.isFinite(Number(v)) && Number(v) >= min ? Math.round(Number(v)) : d)
  return { maxPerScope: n(m.maxPerScope, MAX_PER_SCOPE, 1), indexTokens: n(m.indexTokens, INDEX_TOKENS, 50), relevantTokens: n(m.relevantTokens, RELEVANT_TOKENS, 50), autoCapture: m.autoCapture !== false }
}

// ---- the store -------------------------------------------------------------------------------------------------------------------
const file = (home: string) => `${leanDir(home)}/memory/items.json`
let chain: Promise<unknown> = Promise.resolve()
export const resetMemory = (): void => {
  chain = Promise.resolve()
}

async function load(h: Host, home: string): Promise<Store> {
  const s = await readJson<Store | null>(h, file(home), null)
  if (s && Array.isArray(s.items)) return { next: Number(s.next) > 0 ? Number(s.next) : s.items.length + 1, items: s.items.filter(x => x && typeof x.id === 'string' && typeof x.text === 'string') }
  // first use: the notes `lean_remember` kept before the single store (a thread's note stays that thread's; a project's note stays the project's)
  const cfg = await memConfig(h, home)
  const rows = (await readJsonl<{ ts?: number; from?: string; project?: string; text?: string }>(h, `${leanDir(home)}/memory/notes.jsonl`)).filter(n => n && typeof n.text === 'string' && n.text.trim())
  const out: Store = { next: 1, items: [] }
  const per = new Map<string, number>()
  for (const n of [...rows].reverse()) {
    const scope = n.project?.trim() ? `project:${n.project.trim()}` : /^t\d+$/.test(n.from ?? '') ? `thread:${n.from}` : ''
    const text = flat(retireText(n.text!))
    if (!scope || !validScope(scope) || text.length > TEXT_MAX || refuseText(text)) continue
    if ((per.get(scope) ?? 0) >= cfg.maxPerScope) continue
    per.set(scope, (per.get(scope) ?? 0) + 1)
    out.items.unshift({ id: '', scope, kind: 'fact', text, created: Number(n.ts) || 0, source: 'thread', uses: 0, lastUsed: 0, status: 'active' })
  }
  for (const it of out.items) it.id = `m${out.next++}`
  if (rows.length) await writeJson(h, file(home), out)
  return out
}

// one writer at a time (the desk and several threads share the file): read, change, write
export async function mutate<R>(h: Host, home: string, fn: (s: Store, now: number) => R | Promise<R>, write = true): Promise<R> {
  const run = async (): Promise<R> => {
    const s = await load(h, home)
    const r = await fn(s, await h.clock.now())
    if (write) {
      const live = s.items.filter(i => i.status !== 'retired')
      const dead = s.items.filter(i => i.status === 'retired').slice(-RETIRED_KEPT)
      s.items = [...live, ...dead].sort((a, b) => idNum(a.id) - idNum(b.id))
      await writeJson(h, file(home), s)
    }
    return r
  }
  const p = chain.then(run, run)
  chain = p.catch(() => undefined)
  return p
}
export const readItems = async (h: Host, home: string): Promise<Item[]> => (await load(h, home)).items
const idNum = (id: string): number => Number(id.slice(1)) || 0

// ---- text rules ------------------------------------------------------------------------------------------------------------------
export const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
const SECRET = [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{12,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\b(password|passwd|pwd|secret|token|api[_ -]?key|apikey|credential|client[_ -]?secret|bearer)s?\b\s*(is|are|=|:)\s*\S{4,}/i, /\b(?![0-9a-f]+\b)[A-Za-z0-9]{32,}\b/]
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/
const HOME_PATH = /(?:^|[\s"'`(=:])(?:\/home\/[^\s/]+|\/Users\/[^\s/]+|\/root\b|[A-Za-z]:\\Users\\[^\s\\]+)/
// null = fine; else why the text is refused (never echoes the match)
export function refuseText(text: string): string | null {
  if (!text.trim()) return 'nothing to remember: the text is empty'
  if (text.length > TEXT_MAX) return `${text.length} characters, the limit is ${TEXT_MAX}: shorten it`
  if (SECRET.some(r => r.test(text))) return 'looks like a secret (token, key, password): never stored; keep it out of memory'
  if (EMAIL.test(text)) return 'contains an email address: never stored (personal data)'
  if (HOME_PATH.test(text)) return 'contains a path in a home folder: never stored; write ~/... instead'
  return null
}

export const validScope = (s: string): boolean => /^(desk|global|project:[A-Za-z0-9._-]{1,60}|thread:t\d+|task:[A-Za-z0-9._#:-]{1,60})$/.test(s)
const STOP = new Set('the and for you your that this with from have has had are was were not but all any can will would should could into onto than then them they their there here what when where which while about after before over under also just only more most some such very been being does did done use used using make made get got let its our out one two per via too off its'.split(' '))
export function words(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().split(/[^a-z0-9_#~./-]+/)) {
    const t = w.replace(/^[./-]+|[./-]+$/g, '').replace(/(?<=[a-z]{3})s$/, '')
    if (t.length >= 3 && !STOP.has(t)) out.add(t)
  }
  return out
}
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n / Math.min(a.size, b.size)
}
const NEG = /\b(never|not|don'?t|do not|stop|no longer|avoid|without)\b/i

// A rule that would LOOSEN a safety rule (permissions, approvals, pushes, sends) is never captured on its own: it needs the user's explicit command.
export function loosensSafety(text: string): boolean {
  const t = text.toLowerCase()
  if (/\b(never|don'?t|do not|must not|shouldn'?t|not)\b.{0,50}\bwithout (asking|approval|permission|confirm\w*|review|checking|my ok)/.test(t)) return false // "never push without asking" tightens
  return [
    /\b(don'?t|do not|never|no need to|stop|quit)\s+(ask|asking|wait|waiting|confirm|confirming|check|checking)\b/,
    /\bwithout (asking|approval|permission|confirm\w*|review|checking|my ok)/,
    /\b(auto[- ]?(approve|merge|push|send|accept|allow)|always (approve|allow|accept|push|send|merge)|bypass|skip (the )?(review|approval|permission|check|guard|gate)|allow (all|everything)|full (access|permission)|dangerously|yolo|disable (the )?(guard|check|review|approval|permission))\b/,
    /\b(push|merge|send|post|reply|comment|deploy|delete|approve)\b.{0,40}\b(on your own|by yourself|yourself|automatically|whenever you like)\b/,
  ].some(r => r.test(t))
}

export function guessKind(text: string): Kind {
  const t = text.toLowerCase()
  if (/\b(no,? i said|i told you|that'?s wrong|that is wrong|not what i (asked|said|meant))\b/.test(t)) return 'correction'
  if (/\b(prefer|rather|i like|i want|i'd like|my style)\b/.test(t) && !/\b(always|never)\b/.test(t)) return 'preference'
  if (/\b(decided|we chose|we picked|chose to|because|the reason|instead of)\b/.test(t)) return 'decision'
  if (/\b(always|never|from now on|going forward|don'?t|do not|must|whenever|every time|after (a|an|every|each|the)|before (a|an|every|each|the)|when (a|an|the) )\b/.test(t)) return 'rule'
  return 'fact'
}
const HABIT = /\b(always|never|from now on|going forward|whenever|every time|don'?t|do not|after (a|an|every|each|the) |before (a|an|every|each|the) |when (a|an|the) )\b/i

export type ScopeGuess = { scope: string } | { ask: string }
export function guessScope(text: string, ctx: Ctx): ScopeGuess {
  const named = /\bthread (t\d+)\b|\b(t\d+)\b/i.exec(text)
  if (ctx.role === 'thread') return { scope: `thread:${ctx.id}` }
  if (named) return { scope: `thread:${(named[1] ?? named[2])!.toLowerCase()}` }
  const proj = (ctx.projects ?? []).find(p => new RegExp(`(^|[^a-z0-9])${p.replace(/[^a-z0-9]/gi, '.')}([^a-z0-9]|$)`, 'i').test(text))
  if (proj) return { scope: `project:${proj}` }
  if (HABIT.test(text)) return { scope: 'global' } // a user's habit sentence reaches every thread
  return { ask: 'for this thread, this project or always? Call again with scope: thread:<tN>, project:<name> or global (desk: the desk only)' }
}

const where = (scope: string, ctx: Ctx): string | null => {
  if (!validScope(scope)) return `scope "${scope.slice(0, 40)}" is not one of desk | global | project:<name> | thread:<tN> | task:<id>`
  if (ctx.role === 'thread') {
    if (scope === `thread:${ctx.id}` || scope.startsWith('task:') || (ctx.project && scope === `project:${ctx.project}`)) return null
    return `a thread remembers for itself (thread:${ctx.id}), its project or a task; for ${scope} ask the desk (the user's words decide what reaches every thread)`
  }
  return null
}
const tilde = (p: string, home: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)
export const ageText = (now: number, ts: number): string => {
  const d = Math.floor(Math.max(0, now - ts) / 86_400_000)
  return d < 1 ? 'today' : `${d}d`
}

// ---- add -------------------------------------------------------------------------------------------------------------------------
export type AddReq = { text: string; scope?: string; kind?: string; trigger?: string; output?: string; source: Source; status?: 'active' | 'candidate'; viaCommand?: boolean /* the user typed the remember command */; auto?: boolean /* captured by script from a typed prompt: a loosening text is only ever a candidate */ }
export async function addItem(h: Host, home: string, req: AddReq, ctx: Ctx): Promise<Out> {
  const text = flat(req.text ?? '')
  const bad = refuseText(text)
  if (bad) return { ok: false, text: `not remembered: ${bad}` }
  const kind = (req.kind ?? '') as Kind
  if (req.kind && !KINDS.includes(kind)) return { ok: false, text: `kind must be one of ${KINDS.join(', ')}` }
  const trig = (req.trigger ?? '').trim()
  if (trig && !TRIGGERS.includes(trig as (typeof TRIGGERS)[number]) && !/^keyword:[\w.-]{2,30}$/.test(trig)) return { ok: false, text: `trigger must be one of ${TRIGGERS.join(', ')} (keyword:<word> names the word)` }
  const output = req.output ? flat(tilde(req.output, home)) : ''
  if (output && (output.length > TEXT_MAX || SECRET.some(r => r.test(output)) || EMAIL.test(output) || HOME_PATH.test(output))) return { ok: false, text: 'not remembered: the output path is too long, or holds a secret, an email or a home-folder path (write ~/...)' }
  let scope = (req.scope ?? '').trim()
  if (!scope) {
    const g = guessScope(text, ctx)
    if ('ask' in g) return { ok: false, ask: true, text: g.ask }
    scope = g.scope
  }
  const wrong = where(scope, ctx)
  if (wrong) return { ok: false, text: `not remembered: ${wrong}` }
  if (scope.startsWith('thread:') && ctx.role !== 'thread' && !(await h.fs.exists(`${threadsDir(home)}/${scope.slice(7)}/thread.json`).catch(() => false))) return { ok: false, text: `not remembered: no thread ${scope.slice(7)}` }
  let status: 'active' | 'candidate' = req.status ?? 'active'
  if (loosensSafety(text)) {
    if (req.source === 'thread') return { ok: false, text: 'not remembered: it would loosen a safety rule (permissions, approvals, pushes, sends); a thread cannot add that: ask the user to say it with /lean-agent:remember' }
    if (!req.viaCommand && (req.auto || !(await userCommanded(h, text)))) {
      if (req.source !== 'script' && !req.auto) return { ok: false, text: 'not remembered: it would loosen a safety rule (permissions, approvals, pushes, sends). Only the user\'s own /lean-agent:remember <text> (typed in the chat box) keeps it' }
      status = 'candidate'
    }
  }
  const cfg = await memConfig(h, home)
  const k: Kind = kind || (trig ? 'rule' : guessKind(text))
  const mine = words(text)
  return mutate(h, home, (s, now) => {
    const here = s.items.filter(i => i.scope === scope && i.status !== 'retired')
    const dup = here.find(i => mine.size >= 2 && overlap(mine, words(i.text)) >= 0.7)
    if (dup) {
      dup.text = text
      if (req.kind) dup.kind = kind
      if (trig) dup.trigger = trig
      if (output) dup.output = output
      if (dup.status === 'candidate' && status === 'active') dup.status = 'active'
      return { ok: true, id: dup.id, item: dup, text: `already remembered as ${dup.id}: updated` } as Out
    }
    if (here.length >= cfg.maxPerScope) {
      const three = [...here].sort((a, b) => a.uses - b.uses || a.created - b.created).slice(0, 3)
      return { ok: false, text: `not remembered: ${scope} holds ${here.length} of ${cfg.maxPerScope} items. Retire one first (lean_memory retire <id>): ${three.map(i => `${i.id} "${i.text.slice(0, 50)}" (uses ${i.uses}, ${ageText(now, i.created)})`).join('; ')}` } as Out
    }
    const item: Item = { id: `m${s.next++}`, scope, kind: k, text, created: now, source: req.source, uses: 0, lastUsed: 0, status, ...(trig ? { trigger: trig } : {}), ...(output ? { output } : {}) }
    s.items.push(item)
    return { ok: true, id: item.id, item, text: status === 'candidate' ? `${item.id} kept as a candidate (${scope}): ${loosensSafety(text) ? 'it loosens a safety rule: only the user\'s /lean-agent:remember command activates it' : 'the user confirms or drops it'}` : `remembered as ${item.id} (${scope}, ${k}${trig ? `, ${trig}` : ''})` } as Out
  })
}

// the user's own typed words ask for this text to be remembered (a recent prompt that starts with the remember command, or says "remember", and overlaps the text)
async function userCommanded(h: Host, text: string): Promise<boolean> {
  const mine = words(text)
  return (await recentPrompts(h).catch(() => [])).some(p => /(^|\s)(\/(lean-agent:)?remember|remember)\b/i.test(p.text.slice(0, 80)) && overlap(mine, words(p.text)) >= 0.6)
}

// ---- retire / edit / confirm -----------------------------------------------------------------------------------------------------
const ID = /^m\d+$/
const canTouch = (i: Item, ctx: Ctx): boolean => ctx.role === 'desk' || i.scope === `thread:${ctx.id}` || i.scope.startsWith('task:') || (!!ctx.project && i.scope === `project:${ctx.project}`)
export async function retireItem(h: Host, home: string, id: string, ctx: Ctx): Promise<Out> {
  if (!ID.test(id)) return { ok: false, text: 'retire needs an id like m4' }
  return mutate(h, home, (s, now) => {
    const i = s.items.find(x => x.id === id)
    if (!i || i.status === 'retired') return { ok: false, text: `no active item ${id}` } as Out
    if (!canTouch(i, ctx)) return { ok: false, text: `${id} is not yours to retire` } as Out
    i.status = 'retired'
    i.note = `retired ${new Date(now).toISOString().slice(0, 10)}`
    return { ok: true, id, text: `retired ${id} (${i.scope}): "${i.text.slice(0, 60)}"` } as Out
  })
}
export async function editItem(h: Host, home: string, id: string, textIn: string, ctx: Ctx, source: Source = 'desk'): Promise<Out> {
  const text = flat(textIn ?? '')
  const bad = ID.test(id) ? refuseText(text) : 'edit needs an id like m4 and the new text'
  if (bad) return { ok: false, text: `not changed: ${bad}` }
  if (loosensSafety(text) && !(await userCommanded(h, text))) return { ok: false, text: 'not changed: the new text would loosen a safety rule; only the user\'s /lean-agent:remember <text> keeps that' }
  return mutate(h, home, s => {
    const i = s.items.find(x => x.id === id)
    if (!i || i.status === 'retired') return { ok: false, text: `no active item ${id}` } as Out
    if (!canTouch(i, ctx)) return { ok: false, text: `${id} is not yours to edit` } as Out
    i.text = text
    i.source = source === 'script' ? i.source : source
    return { ok: true, id, item: i, text: `${id} edited (${i.scope})` } as Out
  })
}
export async function confirmItem(h: Host, home: string, id: string): Promise<Out> {
  if (!ID.test(id)) return { ok: false, text: 'confirm needs an id like m4' }
  const first = (await readItems(h, home)).find(x => x.id === id)
  if (first && loosensSafety(first.text) && !(await namedByUser(h, id, first.text))) return { ok: false, text: `${id} would loosen a safety rule: it needs the user's own words ("confirm ${id}") or /lean-agent:remember with that text` }
  return mutate(h, home, s => {
    const i = s.items.find(x => x.id === id)
    if (!i || i.status !== 'candidate') return { ok: false, text: `${id} is not a candidate` } as Out
    i.status = 'active'
    return { ok: true, id, text: `${id} is active (${i.scope})` } as Out
  })
}
async function namedByUser(h: Host, id: string, text: string): Promise<boolean> {
  return (await userCommanded(h, text)) || (await recentPrompts(h).catch(() => [])).some(p => new RegExp(`\\b(confirm|yes|keep|activate)\\b[^.\\n]{0,20}\\b${id}\\b`, 'i').test(p.text))
}

// ---- read ------------------------------------------------------------------------------------------------------------------------
const order = (scope: string): number => (scope === 'desk' ? 0 : scope === 'global' ? 1 : scope.startsWith('project:') ? 2 : scope.startsWith('task:') ? 3 : 4)
export function itemLine(i: Item, now: number): string {
  return `${i.id} ${i.kind}${i.status === 'candidate' ? ' [candidate]' : ''}: ${i.text}${i.trigger ? ` · ${i.trigger}` : ''}${i.output ? ` → ${i.output}` : ''} · uses ${i.uses} · ${ageText(now, i.created)}`
}
export async function listItems(h: Host, home: string, scope = '', ctx: Ctx = { role: 'desk' }): Promise<string> {
  const now = await h.clock.now()
  const all = (await readItems(h, home)).filter(i => i.status !== 'retired' && (ctx.role === 'desk' || visible(i.scope, ctx)))
  const want = scope.trim()
  const pick = want && want !== 'all' ? all.filter(i => i.scope === want || i.scope.startsWith(`${want}:`) || (want === 'thread' && i.scope.startsWith('thread:'))) : all
  if (!pick.length) return want && want !== 'all' ? `nothing remembered for ${want}` : 'nothing remembered yet'
  const scopes = [...new Set(pick.map(i => i.scope))].sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { numeric: true }))
  return scopes.map(sc => `${sc} (${pick.filter(i => i.scope === sc).length})\n${pick.filter(i => i.scope === sc).map(i => `  ${itemLine(i, now)}`).join('\n')}`).join('\n')
}

// which scopes a session sees: the desk its own and the user's habits; a thread its own, its project's, its tasks' and the habits. Never another thread's.
export function visible(scope: string, ctx: Ctx): boolean {
  if (scope === 'global') return true
  if (ctx.role === 'desk') return scope === 'desk'
  return scope === `thread:${ctx.id}` || (!!ctx.project && scope === `project:${ctx.project}`) || (scope.startsWith('task:') && (ctx.tasks ?? []).includes(scope.slice(5)))
}
// the specificity rank: thread > task > project > global (the desk's own first on the desk)
export const rankOf = (scope: string): number => (scope === 'desk' || scope.startsWith('thread:') ? 0 : scope.startsWith('task:') ? 1 : scope.startsWith('project:') ? 2 : 3)

export async function findItems(h: Host, home: string, q: string, ctx: Ctx = { role: 'desk' }): Promise<string> {
  const w = words(q)
  if (!w.size) return 'find needs words'
  const now = await h.clock.now()
  const hits = (await readItems(h, home)).filter(i => i.status !== 'retired' && (ctx.role === 'desk' ? true : visible(i.scope, ctx)) && [...w].some(x => words(`${i.text} ${i.scope} ${i.kind}`).has(x)))
  if (!hits.length) return `nothing remembered matches "${q.slice(0, 60)}"`
  const top = hits.sort((a, b) => [...w].filter(x => words(b.text).has(x)).length - [...w].filter(x => words(a.text).has(x)).length || b.created - a.created).slice(0, 10)
  await touch(h, home, top.map(i => i.id))
  return top.map(i => `${i.scope} · ${itemLine(i, now)}`).join('\n')
}
export async function getItem(h: Host, home: string, id: string, ctx: Ctx = { role: 'desk' }): Promise<string> {
  const i = (await readItems(h, home)).find(x => x.id === id)
  if (!i || i.status === 'retired' || (ctx.role !== 'desk' && !visible(i.scope, ctx))) return `no item ${id}`
  await touch(h, home, [id])
  return `${i.id} · ${i.scope} · ${i.kind} · ${i.status} · source ${i.source} · uses ${i.uses + 1}\n${i.text}${i.trigger ? `\ntrigger: ${i.trigger}` : ''}${i.output ? `\noutput: ${i.output}` : ''}`
}
// a use: an item that was found, fetched, reminded or triggered (the index lists it without counting)
export async function touch(h: Host, home: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  await mutate(h, home, (s, now) => {
    for (const i of s.items) if (ids.includes(i.id)) {
      i.uses++
      i.lastUsed = now
    }
  }).catch(() => undefined)
}

// ---- prune: suggestions only -----------------------------------------------------------------------------------------------------
export const PRUNE_DAYS = 30
export async function pruneSuggestions(h: Host, home: string): Promise<string> {
  const now = await h.clock.now()
  const items = (await readItems(h, home)).filter(i => i.status !== 'retired')
  const out: string[] = []
  for (const i of items) {
    const idle = Math.floor((now - Math.max(i.lastUsed, i.created)) / 86_400_000)
    const newer = items.find(j => j !== i && j.scope === i.scope && j.created > i.created && j.status === 'active' && overlap(words(i.text), words(j.text)) >= 0.5 && NEG.test(i.text) !== NEG.test(j.text))
    let why = ''
    if (newer) why = `contradicted by the newer ${newer.id} ("${newer.text.slice(0, 50)}")`
    else if (i.status === 'candidate' && idle >= 7) why = `a candidate for ${idle} days nobody confirmed`
    else if (!INDEX_KINDS.includes(i.kind) && i.uses === 0 && idle >= PRUNE_DAYS) why = `a ${i.kind} never used in ${idle} days`
    else if (i.scope.startsWith('thread:') && (await readJson<{ state?: string } | null>(h, `${threadsDir(home)}/${i.scope.slice(7)}/thread.json`, null))?.state === 'closed') why = `its thread ${i.scope.slice(7)} is closed`
    if (why) out.push(`retire ${i.id} (${i.scope}): "${i.text.slice(0, 60)}": ${why}`)
  }
  return out.length ? `${out.length} to consider (nothing was changed; lean_memory retire <id> does it):\n${out.join('\n')}` : 'nothing to prune'
}
