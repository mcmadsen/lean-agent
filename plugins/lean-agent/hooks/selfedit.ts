// A GRANT THE USER GIVES IN WORDS (or by a click): "let t9 edit its worktree itself". With it the thread's OWN Edit / Write / NotebookEdit / Read / Grep /
// Glob work inside its registered worktrees (orchestrate.ts selfEditOk), never outside and never lean-agent's own state. It is the way out of a
// classifier denial of the editing worker (denial.ts): no permission prompt exists for that, so nobody can "press yes" there.
//
// Model-proof, like allow-writes (deskwrites.ts):
//   * the words come from humanprompts.ts only (prompts the engine stamped as the person's). The desk model may PROPOSE (`lean_thread allow-self-edit`),
//     the mod accepts only when ONE recorded human prompt of the last 24 h (a) names the thread (its id, or its branch / PR number / task title words as
//     a whole token) and (b) carries an instruction word from the table below. No model judges it.
//   * or a human answer: the pane's button, or the desk's AskUserQuestion with the canonical question and options (bindSelfEditAnswers reads the tool's
//     own RESULT, as bindAnswers does for the desk actions; a model cannot fill it in).
//   * the grant is signed (the mod's key), names the thread's registered worktrees, expires in 24 h or when the thread closes, quotes the words.
//   * only allowSelfEdit / grantByHuman write one; no lean_report action, thread text or tool call creates or extends one. Revoking only takes power away.
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { macOf } from './reviews'
import { readRegistry } from './worktreereg'
import { exclusive, logHistory, threadOk } from './deskactions'
import { PLAIN_HINT, recentPrompts, seenSince } from './humanprompts'
import { DISMISS_LABEL, RETRY_LABEL, selfEditLabel } from './denial'

export const SELF_EDIT_TTL_MS = 24 * 60 * 60 * 1000

// ---- THE SCRIPT TABLE: which written words count as the instruction. Edit here, nothing else decides. --------------------------------------------
export const GAP = 80
export const SELF_PHRASES = ['do it yourself', 'do it itself', 'edit it itself', 'edit itself', 'edit its worktree', 'edit the worktree', 'edit the code', 'edit it yourself', 'let it edit', 'let it do', 'let it code', 'let it work']
export const LEAD = ['edit', 'edits', 'let it', 'let them', 'allow', 'allowed', 'go ahead', 'do it yourself', 'yes', 'approve', 'approved', 'ok', 'okay', 'permit']
export const OBJECT = ['edit', 'edits', 'editing', 'worker', 'workers', 'code', 'worktree', 'itself', 'yourself']
export const COMMANDS = ['/lean-agent:allow-edit']
export const REVOKE_WORDS = ['stop editing', 'stop edits', 'stop the edits', 'no more edits', 'revoke edit', 'revoke the edit', 'cancel the edit']
export const REVOKE_COMMANDS = ['/lean-agent:revoke-edit']
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'task', 'fix', 'add', 'remove', 'update', 'thread', 'work', 'code', 'edit', 'worker'])
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+')
const alt = (l: string[]) => l.map(esc).join('|')
const PHRASE = new RegExp(`(?<![\\w-])(${alt(SELF_PHRASES)})(?![\\w-])`, 'i')
const PAIR = new RegExp(`(?<![\\w-])(${alt(LEAD)})(?![\\w-])[^.!?\\n]{0,${GAP}}?(?<![\\w-])(${alt(OBJECT)})(?![\\w-])`, 'gi')
const NEGATION = /(?<![\w-])(don'?t|do\s+not|dont|never|not|no|without|stop|cannot|can'?t)(?![\w-])/i
const negated = (t: string, at: number) => NEGATION.test(t.slice(Math.max(0, at - 24), at))
export function selfEditInstruction(text: string): string | null {
  const t = text.trim()
  const low = t.toLowerCase()
  if (COMMANDS.some(c => low === c || low.startsWith(`${c} `))) return t.split(/\s+/)[0]!
  const p = PHRASE.exec(t)
  if (p && !negated(t, p.index)) return p[0]
  PAIR.lastIndex = 0
  for (let m = PAIR.exec(t); m; m = PAIR.exec(t)) if (!negated(t, m.index)) return m[0]
  return null
}
export function selfEditRevokeIn(text: string): boolean {
  const low = text.trim().toLowerCase()
  if (REVOKE_COMMANDS.some(c => low === c || low.startsWith(`${c} `))) return true
  return new RegExp(`(?<![\\w-])(${alt(REVOKE_WORDS)})(?![\\w-])`, 'i').test(low)
}

// ---- what names a thread ---------------------------------------------------------------------------------------------------------------
type Who = { id: string; title: string; branches: string[]; roots: string[]; state: string }
async function whoIs(h: Host, thread: string): Promise<Who | null> {
  const home = await homeDir(h)
  const t = await readJson<{ title?: unknown; state?: unknown } | null>(h, `${threadsDir(home)}/${thread}/thread.json`, null).catch(() => null)
  if (!t) return null
  const { reg } = await readRegistry(h, home)
  const mine = Object.values(reg).filter(e => e && e.thread === thread && typeof e.path === 'string' && (e.path as string).startsWith('/'))
  return { id: thread, title: typeof t.title === 'string' ? t.title : '', branches: mine.map(e => String(e.branch ?? '')).filter(Boolean), roots: mine.map(e => String(e.path)), state: String(t.state ?? '') }
}
const tokenRe = (w: string) => new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i')
// the thread's id, or its branch / PR number / task title words as a whole token
export function namesThread(text: string, w: Pick<Who, 'id' | 'title' | 'branches'>): boolean {
  if (tokenRe(w.id).test(text)) return true
  const words = [...new Set([...w.title.split(/[^A-Za-z0-9]+/), ...w.branches.flatMap(b => b.split(/[^A-Za-z0-9]+/))].filter(x => (/^\d{2,9}$/.test(x) || (x.length >= 4 && !STOP.has(x.toLowerCase())))).map(x => x.toLowerCase()))]
  if (w.branches.some(b => b.length >= 3 && tokenRe(b).test(text))) return true
  return words.some(x => tokenRe(x).test(text))
}
const quoteOf = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200)

// the user's own recorded words that name a thread (newest first, the instruction ones first): offered to the thread through the desk's retry message
export async function userWordsFor(h: Host, thread: string): Promise<string> {
  const w = await whoIs(h, thread)
  if (!w) return ''
  const hits = [...(await recentPrompts(h))].reverse().filter(p => namesThread(p.text, w))
  const hit = hits.find(p => selfEditInstruction(p.text)) ?? hits[0]
  return hit ? quoteOf(hit.text) : ''
}

// ---- the grant -------------------------------------------------------------------------------------------------------------------------
type SGrant = { id: string; thread: string; roots: string[]; quote: string; qts: number; by: string; ts: number; exp: number; sig: string }
const KEY = 'selfedit.grants'
const sText = (g: Omit<SGrant, 'sig'>) => `self-edit\n${g.id}\n${g.thread}\n${g.roots.join(',')}\n${JSON.stringify(g.quote)}\n${g.qts}\n${g.by}\n${g.ts}\n${g.exp}`
let seq = 0
export const resetSelfEdit = () => {
  seq = 0
}
async function rowsOf(h: Host, now: number): Promise<SGrant[]> {
  const v = await h.store.get(KEY).catch(() => null)
  const out: SGrant[] = []
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.id !== 'string' || !threadOk(g.thread) || typeof g.quote !== 'string' || typeof g.by !== 'string' || !Array.isArray(g.roots) || !g.roots.every((r: unknown) => typeof r === 'string' && r.startsWith('/'))) continue
    if (![g.qts, g.ts, g.exp].every(Number.isFinite) || typeof g.sig !== 'string' || now > g.exp) continue
    const want = await macOf(h, sText(g), false)
    if (want && want.length === g.sig.length && want === g.sig) out.push(g)
  }
  return out
}
// The roots the user let this thread edit itself: verified (signature, expiry) at every call by the guard. A closed thread keeps nothing.
export async function selfEditRoots(h: Host, thread: string): Promise<string[]> {
  if (!threadOk(thread)) return []
  const raw = await h.store.get(KEY).catch(() => null)
  if (!Array.isArray(raw) || !raw.some(g => g && g.thread === thread)) return [] // (no store walk and no signature for a thread without a grant)
  const g = (await rowsOf(h, await h.clock.now())).filter(x => x.thread === thread)
  if (!g.length) return []
  const t = await readJson<{ state?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, null).catch(() => null)
  if (!t || t.state === 'closed') return []
  return [...new Set(g.flatMap(x => x.roots))]
}

async function make(h: Host, w: Who, quote: string, qts: number, by: string): Promise<{ ok: boolean; text: string }> {
  return exclusive(async () => {
    const now = await h.clock.now()
    const base = { id: `e${now}-${++seq}`, thread: w.id, roots: [...new Set(w.roots)], quote: quoteOf(quote), qts, by, ts: now, exp: now + SELF_EDIT_TTL_MS }
    const sig = await macOf(h, sText(base), true)
    if (!sig) return { ok: false, text: 'no key to sign the grant with' }
    const keep = (await rowsOf(h, now)).filter(x => x.thread !== w.id)
    await h.store.set(KEY, [...keep, { ...base, sig }].slice(-20))
    await logHistory(h, w.id, { kind: 'self-edit-granted', id: base.id, roots: base.roots, quote: base.quote, by, hours: 24 })
    return { ok: true, text: `${w.id} may edit its worktree itself (${base.roots.join(', ')}; 24 h or until it closes; never lean-agent's own state), resting on ${by === 'words' ? 'your words' : 'your choice'} "${base.quote}". Revoke: the pane's Revoke button, /lean-agent:revoke-edit ${w.id}, or say "stop editing". Tell the user this in one line, then tell ${w.id} to do the step itself` }
  })
}
async function usable(h: Host, thread: string): Promise<{ w: Who } | { text: string }> {
  if (!threadOk(thread)) return { text: 'allow-self-edit needs tN (the thread that may edit)' }
  const w = await whoIs(h, thread)
  if (!w) return { text: `no thread ${thread}` }
  if (w.state === 'closed') return { text: `${thread} is closed` }
  if (!w.roots.length) return { text: `${thread} has no registered worktree (lean_worktree register): nothing to allow it to edit` }
  return { w }
}

// `lean_thread allow-self-edit`: the model proposes, the recorded human words decide
export async function allowSelfEdit(h: Host, thread: string): Promise<{ ok: boolean; text: string }> {
  const u = await usable(h, thread)
  if (!('w' in u)) return { ok: false, text: u.text }
  const hit = [...(await recentPrompts(h))].reverse().find(p => namesThread(p.text, u.w) && selfEditInstruction(p.text))
  if (!hit) return { ok: false, text: `no message typed by you ${await seenSince(h)} names ${thread}. ${PLAIN_HINT}, or answer this question: ask with AskUserQuestion: '${selfEditQuestion(thread).question}' (the options must be exactly the ones lean_thread names). Nothing was created` }
  return make(h, u.w, hit.text, hit.ts, 'words')
}
// a human's press (the pane) or answer (the desk's question): the same grant
export async function grantByHuman(h: Host, thread: string, by: 'pane' | 'ask'): Promise<{ ok: boolean; text: string }> {
  const u = await usable(h, thread)
  if (!('w' in u)) return { ok: false, text: u.text }
  return make(h, u.w, `${selfEditLabel(thread)} (${by === 'pane' ? 'pressed in the pane' : 'chosen in the desk\'s question'})`, await h.clock.now(), by)
}

// ---- the canonical question and its verified answer ------------------------------------------------------------------------------------
export const SELF_DESC = 'The mod lets the thread\'s own Edit / Write / Read / Grep / Glob work inside its worktrees (24 h, never lean-agent\'s own state); revocable'
export const RETRY_DESC = 'The thread starts one small worker again: one file plus its spec, the exact change, one test command, your words as the authority'
export const DISMISS_DESC = 'Hide this card; nothing changes'
export function selfEditQuestion(thread: string): { question: string; options: { label: string; description: string }[] } {
  return { question: `Let ${thread} edit its worktree itself?`, options: [{ label: selfEditLabel(thread), description: SELF_DESC }, { label: RETRY_LABEL, description: RETRY_DESC }, { label: DISMISS_LABEL, description: DISMISS_DESC }] }
}
type Q = { question?: unknown; options?: unknown; multiSelect?: unknown }
// The desk's AskUserQuestion after the user answered it (the tool's own RESULT): a grant only for the canonical question of ONE open thread with its
// worktrees, and only when the label chosen is the first option. Returns lines for the desk. Retry: the desk is told to have the thread retry narrowly.
// Free text that is no option label (the user typed instead of picking) is sent to the thread by `tell` as the user's words and noted: no grant.
export async function bindSelfEditAnswers(h: Host, questions: unknown, answers: unknown, tell?: (thread: string, text: string) => Promise<void>): Promise<string[]> {
  const qs: Q[] = Array.isArray(questions) ? (questions as Q[]) : []
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null
  const notes: string[] = []
  for (const q of qs) {
    const text = typeof q?.question === 'string' ? q.question : ''
    const m = /^Let (t\d{1,9}) edit its worktree itself\?$/.exec(text)
    if (!m) continue
    const thread = m[1]!
    const canon = selfEditQuestion(thread)
    const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
    if (q.multiSelect === true || opts.length !== canon.options.length || !canon.options.every((c, i) => opts[i]?.label === c.label && opts[i]?.description === c.description)) {
      notes.push(`the answer to the question about ${thread} was NOT used: the options the user saw were not the ones lean_thread names. Ask again with exactly them`)
      continue
    }
    if (!given) {
      notes.push(`the answer to the question about ${thread} could not be read by the mod: ask the user to press "${selfEditLabel(thread)}" on its card in the pane`)
      continue
    }
    const a = typeof given[text] === 'string' ? (given[text] as string).trim() : ''
    if (a === selfEditLabel(thread)) notes.push((await grantByHuman(h, thread, 'ask')).text)
    else if (a === RETRY_LABEL) notes.push(`the user chose to retry ${thread}'s worker with a narrower brief: send ${thread} a message to do so (lean_thread send; the mod adds the user's recorded words)`)
    else if (a === DISMISS_LABEL) notes.push(`the user dismissed the question about ${thread}: nothing changes`)
    else if (a) { // free text typed instead of an option (1.0.33): never dropped, never a grant; the user's own words go to the thread by script
      const words = a.replace(/\s+/g, ' ').slice(0, 400)
      let sent = false
      if (tell) sent = await tell(thread, `The user answered the desk's question "may you edit your worktree yourself?" with their own words: "${words}". Follow what they wrote. It is no grant: your own edits stay refused unless the mod says they are allowed.`).then(() => true, () => false)
      notes.push(`the user typed an answer to the question about ${thread}, not one of the three options: "${words.slice(0, 120)}". It is not a grant. ${sent ? `The mod sent it to ${thread} as the user's words.` : `Send it to ${thread} yourself (lean_thread send), word for word.`}`)
    }
  }
  return notes
}

// ---- what the pane shows ---------------------------------------------------------------------------------------------------------------
export type SelfEditView = { grants: { id: string; thread: string; roots: string[]; quote: string; by: string; exp: number }[] }
export async function selfEditView(h: Host): Promise<SelfEditView> {
  return { grants: (await rowsOf(h, await h.clock.now())).map(g => ({ id: g.id, thread: g.thread, roots: g.roots, quote: g.quote, by: g.by, exp: g.exp })) }
}
export const paneLine = (g: { thread: string; quote: string }): string => `${g.thread} may edit its worktree itself (your words: '${g.quote.slice(0, 80)}')`

// ---- revoking only takes power away ----------------------------------------------------------------------------------------------------
export async function revokeSelfEdit(h: Host, by: { id?: string; thread?: string; all?: boolean }, who = 'user, in the pane'): Promise<{ ok: boolean; text: string; n: number }> {
  const hit = await exclusive(async () => {
    const all = await rowsOf(h, await h.clock.now())
    const gone = all.filter(g => (by.id && g.id === by.id) || (by.thread && g.thread === by.thread) || by.all)
    if (gone.length) await h.store.set(KEY, all.filter(g => !gone.includes(g)))
    return gone
  })
  for (const g of hit) await logHistory(h, g.thread, { kind: 'self-edit-revoked', id: g.id, by: who })
  return hit.length ? { ok: true, n: hit.length, text: `revoked: ${[...new Set(hit.map(g => g.thread))].join(', ')} may no longer edit its worktree itself (workers again)` } : { ok: false, n: 0, text: by.id ? `no active self-edit grant ${by.id}` : 'no active self-edit grant for that' }
}
export const dropSelfEditGrants = (h: Host, thread: string): Promise<unknown> => revokeSelfEdit(h, { thread }, 'thread closed').catch(() => undefined)
// the user typed "stop editing" / "revoke" (or /lean-agent:revoke-edit): the thread named loses its grant, else all. Called with a recorded HUMAN prompt only.
export async function revokeSelfEditByWords(h: Host, text: string): Promise<number> {
  if (!selfEditRevokeIn(text) && !/(?<![\w-])revoke(?![\w-])/i.test(text)) return 0
  const threads = [...new Set([...text.matchAll(/(?<![\w-])t\d{1,9}(?![\w-])/gi)].map(m => m[0].toLowerCase()))]
  if (!threads.length) return (await revokeSelfEdit(h, { all: true }, 'user, typed words')).n
  let n = 0
  for (const t of threads) n += (await revokeSelfEdit(h, { thread: t }, 'user, typed words')).n
  return n
}
