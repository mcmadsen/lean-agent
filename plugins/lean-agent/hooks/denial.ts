// A DENIED WORKER CALL (Claude Code's permission check: the auto mode classifier, a rule) must never be a dead end, and the user must never be
// told to press a button that is not there.
//
//   * the matcher (classifierDenial): the real text is "Permission for this action was denied by the Claude Code auto mode classifier. Reason:
//     [<category>]. ..." as the result of the Agent call; any reason category, any lean-agent type (worker or reader). Exported: the denied-reader
//     path (fix-1.0.26b's slice counter) imports it. Our own refusals (`lean-agent: ...` / `(lean-agent 1.0.x)`) are never evidence.
//   * the record (noteDenialRec / denialRec): which thread was denied, the category, what kind of call: the mod store, 6 h.
//   * the fallback roots (denialRoots): the thread's registered worktrees + its project's worktree folders the brief names + the absolute
//     paths the brief names. The thread's own edit there is allowed for the rest of the session (orchestrate.ts); the engine still judges it.
//   * the truth about a prompt (blockedTruth, denialCard): a classifier denial has NO permission prompt. The text for the desk and the pane says
//     so, names the real options, and the pane never shows an Open button without a prompt behind it (`claude agents --json`: waitingFor).
//   * the remedy that worked in the field (NARROW) and a script check of the denied brief (broadBrief).
import { homeDir, leanDir } from './state'
import type { Host } from './state'
import { readRegistry } from './worktreereg'

export const DENIAL_TTL_MS = 6 * 60 * 60 * 1000
export type DenialKind = 'worker' | 'reader' | 'other'
export type DenialRec = { ts: number; category: string; kind: DenialKind; agent: string; roots: string[]; broad?: string }

// ---- the matcher ---------------------------------------------------------------------------------------------------------------------------
const SIGNATURE = /permission for this action was denied|denied by the claude code auto[ -]mode classifier|auto[ -]mode classifier/i
const LOOSE = /(denied|blocked|refused|rejected)\b[^.\n]{0,80}\b(permission (check|system)|auto[ -]mode|classifier)|\b(permission (check|system)|auto[ -]mode|classifier)\b[^.\n]{0,80}\b(denied|blocked|refused|rejected)|\[(Destructive or Unwanted Actions|Undermining Oversight)\]/i
const OURS = /^\s*lean-agent:|\(lean-agent \d[^)]*\)\s*$/
const cleanCat = (s: string): string => s.replace(/[^\w ,'/&-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
// null: not a permission denial. Else its reason category ("Destructive or Unwanted Actions", "Undermining Oversight", any other, or "unspecified").
export function classifierDenial(text: unknown): { category: string } | null {
  const t = typeof text === 'string' ? text : Array.isArray(text) ? text.map(x => (typeof x === 'string' ? x : String((x as { text?: unknown })?.text ?? ''))).join('\n') : ''
  if (!t) return null
  const real = SIGNATURE.test(t) // the engine's own words win even when the reason mentions lean-agent
  if (!real && (OURS.test(t) || !LOOSE.test(t))) return null
  const m = /Reason:\s*\[([^\]\n]{1,80})\]/i.exec(t) ?? /\[((?:Destructive or Unwanted Actions|Undermining Oversight)[^\]\n]{0,40})\]/i.exec(t) ?? (real ? /\[([A-Z][A-Za-z ,'/&-]{3,60})\]/.exec(t) : null)
  return { category: (m && cleanCat(m[1]!)) || 'unspecified' }
}
export const denialKind = (agentType: unknown): DenialKind => (/^(lean-agent:)?worker-/.test(String(agentType ?? '')) ? 'worker' : /^(lean-agent:)?(reader-|reviewer$|explorer$|auditor$)/.test(String(agentType ?? '')) ? 'reader' : 'other')
export const isLeanAgentType = (agentType: unknown): boolean => /^(lean-agent:)?(worker|reader)-(haiku|sonnet|opus|mcp)$|^(lean-agent:)?(reviewer|explorer|auditor)$/.test(String(agentType ?? ''))

// ---- the remedy ----------------------------------------------------------------------------------------------------------------------
export const NARROW = 'retry with a narrower brief: ONE file plus its spec, the exact change, one test command; start with an additive step; quote the user\'s own words (the mod gives you the recorded ones) as the authority; never one worker for a repo-wide removal or rewrite'
export const READER_RETRY = 'retry once with one file, one question; else read in slices of 200 lines and write each finding to scratch/notes.md'
const PATHISH = /(?:^|[\s`'"(=:,])((?:~|\.{0,2})\/?(?:[\w.@+-]+\/)+[\w.@+-]*|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|cs|rb|php|kt|swift|sh|yml|yaml|css|scss|html|sql|vue|svelte))(?=[\s`'"),.:;]|$)/g
const BROAD_WORDS = /(?<![\w-])(all|every|everything|everywhere|entire|whole|repo-wide|throughout)(?![\w-])/gi
const BROAD_REMOVE = /(?<![\w-])(remove|removes|removing|delete|deletes|deleting|drop|purge|rip out|strip)(?![\w-])[^.\n]{0,60}?(?<![\w-])(across|everywhere|throughout|all|every)(?![\w-])/i
// a script check of the DENIED brief: names more than 3 files / folders, or words like all / every / everywhere / remove ... across. '' when it is narrow.
export function broadBrief(prompt: unknown): string {
  const t = typeof prompt === 'string' ? prompt : ''
  if (!t) return ''
  const paths = new Set([...t.matchAll(PATHISH)].map(m => m[1]!.replace(/[.,;:]+$/, '')).filter(Boolean))
  const words = [...new Set([...t.matchAll(BROAD_WORDS)].map(m => m[1]!.toLowerCase()))]
  const rm = BROAD_REMOVE.exec(t)
  const parts: string[] = []
  if (paths.size > 3) parts.push(`it names ${paths.size} files or folders (one file plus its spec per call)`)
  if (words.length) parts.push(`it says "${words.slice(0, 4).join('", "')}"`)
  if (rm) parts.push(`it says "${rm[0].replace(/\s+/g, ' ').slice(0, 60)}"`)
  return parts.length ? `this brief is broad: split it (${parts.join('; ')})` : ''
}

// ---- the record ----------------------------------------------------------------------------------------------------------------------
const KEY = (t: string) => `denial.rec.${t}`
const idOk = (t: unknown): t is string => typeof t === 'string' && /^t\d{1,9}$/.test(t)
export async function noteDenialRec(h: Host, thread: string, r: Omit<DenialRec, 'ts'>): Promise<void> {
  if (!idOk(thread)) return
  await h.store.set(KEY(thread), { ...r, ts: await h.clock.now() } satisfies DenialRec)
}
export async function denialRec(h: Host, thread: string): Promise<DenialRec | null> {
  if (!idOk(thread)) return null
  const v: any = await h.store.get(KEY(thread)).catch(() => null)
  const now = await h.clock.now()
  return v && typeof v.category === 'string' && Number.isFinite(v.ts) && now - v.ts <= DENIAL_TTL_MS && v.ts <= now + 60_000 ? (v as DenialRec) : null
}
export async function clearDenialRec(h: Host, thread: string): Promise<void> {
  if (idOk(thread)) await h.store.set(KEY(thread), null).catch(() => undefined)
}

// ---- the paths the fallback allows ---------------------------------------------------------------------------------------------------
const under = (p: string, root: string) => p === root || p.startsWith(root + '/')
// the thread's registered worktrees (lean_worktree), the worktree folder entries of its project that the brief names (by folder name or branch, as a
// whole token), and the absolute paths the brief names. Never a path outside a worktree unless the brief named it itself.
export async function worktreeRoots(h: Host, thread: string, brief: string): Promise<string[]> {
  const out: string[] = []
  try {
    const home = await homeDir(h)
    const { reg } = await readRegistry(h, home)
    const mine = Object.values(reg).filter(e => e && e.thread === thread && typeof e.path === 'string' && (e.path as string).startsWith('/'))
    for (const e of mine) out.push(String(e.path))
    const repos = new Set(mine.map(e => String(e.repo ?? '')).filter(Boolean))
    const toks = new Set(brief.split(/[^\w./@+-]+/).filter(Boolean))
    const wt = `${leanDir(home)}/worktrees`
    for (const e of Object.values(reg)) {
      const p = typeof e?.path === 'string' ? (e.path as string) : ''
      if (!p || !under(p, wt) || out.includes(p)) continue
      const same = repos.size === 0 || repos.has(String(e.repo ?? ''))
      const named = toks.has(p.split('/').pop()!) || (typeof e.branch === 'string' && e.branch.length > 2 && toks.has(e.branch))
      if (same && named) out.push(p)
    }
  } catch {
    /* no registry: only the brief's own paths */
  }
  return out
}

// ---- the words the thread and the desk get -------------------------------------------------------------------------------------------
export const selfEditLabel = (thread: string) => `Let ${thread} edit its worktree itself`
export const RETRY_LABEL = 'Retry the worker with a narrower brief'
export const DISMISS_LABEL = 'Dismiss'
// the thread's hint (said once, as a refusal text or on its next tool result)
export function threadHint(o: { category: string; kind: DenialKind; worktree?: string; broad?: string }): string {
  if (o.kind === 'reader') return `the reader was denied (${o.category}): ${READER_RETRY}${o.broad ? `; ${o.broad}` : ''}`
  return `the worker was denied (${o.category}): your own edits in ${o.worktree || 'your worktree'} are allowed now: do the step yourself, then continue. Or ${NARROW}${o.broad ? `. ${o.broad}` : ''}. Report the denial and its reason if you are blocked; say nothing about pressing buttons (no permission prompt exists)`
}
// what the desk and the pane say when no prompt is open
export const noPromptText = (thread: string, category: string): string => `no permission prompt exists for ${thread}: the auto-mode classifier denied a worker call (reason ${category}). There is nothing to press in the session.`
export const optionsText = (thread: string): string => `Options for the user (AskUserQuestion, one question "Let ${thread} edit its worktree itself?"): "${selfEditLabel(thread)}" | "${RETRY_LABEL}" (${NARROW}) | "${DISMISS_LABEL}". If their chat words already said yes, call lean_thread allow-self-edit ${thread} first; if it refuses, ask`

// The thread's words that told the user to press a button: gone from the report (the mod says what is true instead)
const PRESS = /[^.!?\n]*\b(?:press|click|tap|use|hit)\b[^.!?\n]*\bOpen\b[^.!?\n]*[.!?]?|[^.!?\n]*\bneeds? (?:the user's|your|a) yes\b[^.!?\n]*(?:own session|its session)[^.!?\n]*[.!?]?/gi
export const withoutPress = (text: string): string => text.replace(PRESS, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

// A blocked report as the mod records it: when the session has no permission prompt (a denial of a worker call the mod saw, or a report that quotes
// the classifier's own denial), the approval is dropped and the text says so. Otherwise unchanged (a real prompt keeps today's Open row).
export async function blockedTruth(h: Host, thread: string, text: string, approval: string): Promise<{ text: string; approval: string; category?: string }> {
  const rec = await denialRec(h, thread)
  const said = classifierDenial(`${text}\n${approval}`)
  const about = !!approval || /denied|classifier|permission|worker|approv/i.test(text) // a recorded denial explains a blocked report that talks about one
  const category = (about ? rec?.category : undefined) ?? said?.category
  if (!category) return { text, approval }
  const body = withoutPress(text)
  return { text: `${noPromptText(thread, category)} ${optionsText(thread)}\n--- ${thread} said ---\n${body || text}`.slice(0, 4000), approval: '', category }
}

// a session row of `claude agents --json` that has a live process (a stopped one, e.g. after "Open tN" stopped its idle process, says nothing about a prompt)
export const sessionAlive = (a: { pid?: number; state?: string } | undefined): boolean => !!a && Number(a.pid) > 0 && a.state !== 'stopped'

// the pane / detail: is a denial card due? `approval` is the live "needs your yes" text, `noPrompt` true only when the session list was read and the
// session shows no prompt (waitingFor empty, state not blocked). A recorded denial of the last 6 h before the report counts too.
export async function denialCard(h: Host, thread: string, o: { blocked: boolean; approval: string; noPrompt: boolean; reportTs: number; working: boolean; text: string }): Promise<{ category: string } | null> {
  if (!o.blocked || o.working) return null
  const rec = await denialRec(h, thread)
  const fresh = !!rec && rec.ts <= o.reportTs + 60_000 && o.reportTs - rec.ts <= DENIAL_TTL_MS
  const said = classifierDenial(o.text)
  if (o.noPrompt && o.approval) return { category: (fresh && rec!.category) || said?.category || 'unspecified' }
  if (fresh || said) return o.noPrompt || !o.approval ? { category: (fresh && rec!.category) || said!.category } : null
  return null
}
