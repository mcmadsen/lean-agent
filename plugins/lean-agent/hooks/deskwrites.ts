// APPROVAL IN ADVANCE: the user's own written instruction to the desk ("fix the comments on PR 42") covers the remote writes a thread then asks for on
// that PR or work item, so the mod sends them WITHOUT a further question. No instruction: the desk asks with AskUserQuestion as before (deskactions.ts).
//
// What makes it the HUMAN's and model-proof:
//   * the words come from humanprompts.ts only: prompts the engine itself stamped as the person's (origin composer / bridge). Nothing a tool call,
//     a thread or a relayed report writes is there.
//   * the desk model may PROPOSE a scope (`lean_thread allow-writes`), the mod accepts it only when ONE recorded human prompt of the last 24 h
//     (a) names that exact target (the PR number as a whole token, or its URL, or the work item id) and (b) carries an instruction for that work from
//     the script table in writeinstr.ts. No model judges it.
//   * the grant is signed (the mod's key), names the exact target (resolved from the thread's project remote when only a number was written), the
//     kinds, an expiry (24 h, or the thread closes), a cap of writes (config actions.maxWritesPerGrant, default 40) and quotes the words it rests on.
//   * a request whose EVERY write is inside a live grant (same thread, same target, allowed kind) goes out through the SAME executor as an approved one
//     (deskactions.ts claimAndSend -> approveAction: signature, hash re-check, token on stdin). Anything else is asked.
//   * never covered: pushes, merges, deletes, permission or settings changes, kinds outside the table, a target the user did not name. A GitHub
//     review-thread resolve only when the mod verifies by a read (gh api graphql) that the thread belongs to the granted PR.
//   * only allowWrites (called by `lean_thread allow-writes`, the user's `/lean-agent:allow`) writes a grant; no lean_report action, thread text or tool
//     call creates or extends one. Revoking only takes power away.
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { macOf } from './reviews'
import { parseOrigin } from './prhost'
import type { PrHost } from './prhost'
import { listProjects } from './projects'
import { HUMAN_WI_STATES, STANDING_STATUSES, azureGet, claimAndSend, exclusive, hashOf, logHistory, revokeGrant, rows, setHumanGrantWriter, sound, standingLabelOf, standingView, targetOf, threadOk } from './deskactions'
import type { ActionKind, Params, Plan } from './deskactions'
import { recentPrompts, seenSince } from './humanprompts'
import { SOFT_WORDS, createIn, instructionIn, revokeIn, typedApproval } from './writeinstr'

export const WRITES_TTL_MS = 24 * 60 * 60 * 1000
export const WRITES_CAP = 40
export const PR_KINDS = ['reply', 'status', 'comment', 'link']
export const WI_KINDS = ['comment', 'update']
export const CREATE_KINDS = ['create'] // a NEW work item has no id: the grant's target is `{workitem: 'new'}` and rests on the user's words asking for it
// the table: which request kind a grant kind covers (a batch is never one kind: every item is looked at)
const GRANT_KIND: Partial<Record<ActionKind, string>> = { 'ado-pr-reply': 'reply', 'ado-pr-thread-status': 'status', 'ado-pr-comment': 'comment', 'ado-workitem-comment': 'comment', 'ado-workitem-update': 'update', 'ado-workitem-create': 'create', 'ado-pr-workitem-link': 'link', 'gh-pr-comment': 'comment', 'gh-pr-review-comment': 'comment', 'gh-pr-thread-resolve': 'status' }

// `statuses`: [] for the user's WORDS (any status of a covered kind); a grant of the dialog's fourth choice (writeHumanGrant) names the thread statuses (fixed,
// closed, active) or the work item states it covers, and a reply with a status needs the `status` kind as well
type WGrant = { id: string; thread: string; scope: string; kinds: string[]; statuses: string[]; quote: string; qts: number; cap: number; used: number; ts: number; exp: number; sig: string }
type WSent = { ts: number; thread: string; text: string; grant?: string; since?: number /* an own-PR default send (ownpr.ts): grant is `own:<tN>`, `since` when the thread took ownership */ }
// the own-PR default (ownpr.ts) is not a grant: the user takes it back by marking the thread (or all, '*') revoked from now on; owning a PR later (a newer `since`) is a new default
const OWN_REVOKED = 'action.ownpr.revoked'
export async function ownRevoked(h: Host): Promise<Record<string, number>> {
  const v = await h.store.get(OWN_REVOKED).catch(() => null)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
}
export const ownActive = (r: Record<string, number>, thread: string, since: number): boolean => (r[thread] ?? 0) < since && (r['*'] ?? 0) < since
async function markOwnRevoked(h: Host, who: string[], at: number): Promise<void> {
  const r = await ownRevoked(h)
  for (const w of who) r[w] = at
  await h.store.set(OWN_REVOKED, r)
}
// the open threads that own a PR (thread.json `pr`)
async function ownRows(h: Host): Promise<{ id: string; pr: number }[]> {
  const dir = threadsDir(await homeDir(h))
  const names = await h.fs.list(dir).then(l => l.map(e => e.name), () => [] as string[])
  const out: { id: string; pr: number }[] = []
  for (const n of names) {
    const pr = threadOk(n) ? (await readJson<{ pr?: { id?: unknown } } | null>(h, `${dir}/${n}/thread.json`, null).catch(() => null))?.pr : undefined
    if (pr) out.push({ id: n, pr: Number(pr.id) })
  }
  return out
}
const ownThreads = async (h: Host): Promise<string[]> => (await ownRows(h)).map(r => r.id)
const ownThreadsOf = async (h: Host, nums: string[]): Promise<string[]> => (await ownRows(h)).filter(r => nums.includes(`#${r.pr}`)).map(r => r.id)
export async function revokeOwn(h: Host, by: { thread?: string; all?: boolean }, who: string): Promise<number> {
  const now = await h.clock.now()
  const threads = by.all ? await ownThreads(h) : by.thread ? (await ownThreads(h)).filter(t => t === by.thread) : []
  if (!threads.length) return 0
  await markOwnRevoked(h, by.all ? ['*'] : threads, now)
  for (const t of threads) await logHistory(h, t, { kind: 'own-pr-revoked', by: who })
  return threads.length
}
const WGRANTS = 'action.writes.grants'
const WSENT = 'action.writes.sent'
const SENT_SHOWN_MS = 30 * 60 * 1000
const wText = (g: Omit<WGrant, 'sig'>) => `desk-writes\n${g.id}\n${g.thread}\n${g.scope}\n${g.kinds.join(',')}\n${g.statuses.join(',')}\n${JSON.stringify(g.quote)}\n${g.qts}\n${g.cap}\n${g.used}\n${g.ts}\n${g.exp}`
let wseq = 0
export const resetWrites = () => {
  wseq = 0
}
const lc = (s: string) => s.toLowerCase()

async function grantRows(h: Host, now: number): Promise<WGrant[]> {
  const v = await h.store.get(WGRANTS).catch(() => null)
  const out: WGrant[] = []
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.id !== 'string' || !threadOk(g.thread) || typeof g.scope !== 'string' || typeof g.quote !== 'string' || !Array.isArray(g.kinds) || !g.kinds.every((k: unknown) => typeof k === 'string') || !Array.isArray(g.statuses) || !g.statuses.every((k: unknown) => typeof k === 'string')) continue
    if (![g.qts, g.cap, g.used, g.ts, g.exp].every(Number.isFinite) || typeof g.sig !== 'string' || now > g.exp) continue
    const want = await macOf(h, wText(g), false)
    if (want && want.length === g.sig.length && want === g.sig) out.push(g)
  }
  return out
}
async function saveGrants(h: Host, all: WGrant[]): Promise<void> {
  await h.store.set(WGRANTS, all.slice(-20))
}
async function resign(h: Host, g: Omit<WGrant, 'sig'>): Promise<WGrant | null> {
  const sig = await macOf(h, wText(g), true)
  return sig ? { ...g, sig } : null
}

// ---- the target the user named ---------------------------------------------------------------------------------------------------------------
export type TargetIn = { pr?: unknown; workitem?: unknown }
type Target = { scope: string; type: 'pr' | 'workitem'; n: number; url?: boolean; create?: boolean }
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e9 ? n : null
}
// a URL of a PR or a work item: the number at its end names the target, the rest identifies the forge, org, project and repository (an Azure DevOps URL may
// carry the GUIDs of the project and the repository instead of their names: resolveRef reads them against the thread's own project remote)
export type ForgeRef = { host: 'github' | 'azure'; org: string; project: string; repo: string; type: 'pr' | 'workitem'; n: number }
export function parseForgeUrl(u: string): ForgeRef | null {
  const s = u.trim().replace(/[)>.,;]+$/, '')
  const tail = '(?:[/?#]\\S*)?$'
  let m = new RegExp(`^https?://(?:www\\.)?github\\.com/([^/\\s]+)/([^/\\s]+)/pull/(\\d{1,9})${tail}`, 'i').exec(s)
  if (m) return { host: 'github', org: m[1]!, project: '', repo: m[2]!, type: 'pr', n: Number(m[3]) }
  m = new RegExp(`^https?://(?:[^@/]+@)?dev\\.azure\\.com/([^/]+)/([^/]+)/_git/([^/]+)/pullrequest/(\\d{1,9})${tail}`, 'i').exec(s) ?? new RegExp(`^https?://([^./]+)\\.visualstudio\\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/]+)/pullrequest/(\\d{1,9})${tail}`, 'i').exec(s)
  if (m) return { host: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!), type: 'pr', n: Number(m[4]) }
  m = new RegExp(`^https?://(?:[^@/]+@)?dev\\.azure\\.com/([^/]+)/([^/]+)/_workitems/edit/(\\d{1,9})${tail}`, 'i').exec(s) ?? new RegExp(`^https?://([^./]+)\\.visualstudio\\.com/(?:DefaultCollection/)?([^/]+)/_workitems/edit/(\\d{1,9})${tail}`, 'i').exec(s)
  if (m) return { host: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: '', type: 'workitem', n: Number(m[3]) }
  return null
}
// the scope text of a reference (the same text targetOf makes)
export const scopeOfRef = (r: ForgeRef): string =>
  r.host === 'github' ? `GitHub PR ${r.org}/${r.repo}#${r.n}` : r.type === 'pr' ? `Azure DevOps PR ${r.org}/${r.project}/${r.repo}#${r.n}` : `Azure DevOps work item ${r.org}/${r.project}#${r.n}`
// a URL of a PR or a work item -> the scope it names AS WRITTEN (names, or GUIDs), or null
export function scopeOfUrl(u: string): Target | null {
  const r = parseForgeUrl(u)
  return r ? { scope: scopeOfRef(r), type: r.type, n: r.n, url: true } : null
}
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
// the thread's project remote (the registry's folder of its project, `git remote get-url origin`)
export async function remoteOf(h: Host, thread: string): Promise<PrHost | string> {
  const t = await readJson<{ project?: unknown; state?: unknown }>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, {}).catch(() => ({}) as { project?: unknown; state?: unknown })
  const project = typeof t.project === 'string' ? t.project : ''
  const row = project ? (await listProjects(h, true).catch(() => ({ rows: [] as { name: string; path: string }[] }))).rows.find(r => r.name === project) : undefined
  if (!row?.path) return `${thread} has no registered project folder to read the remote from: give the full URL of the PR or work item`
  const r = await h.process.run(['git', '-C', row.path, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  if (r.exitCode !== 0 || !String(r.stdout).trim()) return `the origin remote of ${project} could not be read: give the full URL of the PR or work item`
  const host = parseOrigin(String(r.stdout))
  return host.kind === 'other' ? `the host ${host.host} of ${project} is not supported (github.com and Azure DevOps are): give the full URL` : host
}
const repoScope = (host: PrHost, pr: number): string => (host.kind === 'github' ? `GitHub PR ${host.owner}/${host.repo}#${pr}` : host.kind === 'azure' ? `Azure DevOps PR ${host.org}/${host.project}/${host.repo}#${pr}` : '')
const itemScope = (host: PrHost, id: number): string | null => (host.kind === 'azure' ? `Azure DevOps work item ${host.org}/${host.project}#${id}` : null)

// A URL against the thread's own project remote: the forge and the org (and the project) must be the thread's, else the URL is refused with where it points.
// The GUIDs of an Azure DevOps URL (project, repository) are read once (a GET) and must name the thread's project; when they cannot be read the thread's own
// project / repository are taken, and the answer says so.
export async function resolveRef(h: Host, thread: string, ref: ForgeRef): Promise<{ ok: true; ref: ForgeRef; note?: string } | { ok: false; text: string }> {
  const host = await remoteOf(h, thread)
  if (typeof host === 'string') return { ok: false, text: `the project remote of ${thread} could not be read, so the URL cannot be checked against it (${host.replace(/: give the full URL.*$/, '')})` }
  const mine = host.kind === 'github' ? `${host.owner}/${host.repo}` : host.kind === 'azure' ? `${host.org}/${host.project}` : host.host
  const wrong = (theirs: string) => ({ ok: false as const, text: `this URL points at ${theirs}, not the project of ${thread} (${mine})` })
  if (ref.host === 'github') return host.kind === 'github' && lc(host.owner) === lc(ref.org) && lc(host.repo) === lc(ref.repo) ? { ok: true, ref } : wrong(`${ref.org}/${ref.repo}`)
  if (host.kind !== 'azure' || lc(host.org) !== lc(ref.org)) return wrong(`${ref.org}/${ref.project}`)
  let { project, repo } = ref
  let note = ''
  const base = `https://dev.azure.com/${encodeURIComponent(host.org)}`
  if (GUID.test(project)) {
    const p = await azureGet(h, `${base}/_apis/projects/${project}?api-version=7.1`)
    const name = typeof p?.name === 'string' ? p.name : ''
    if (name && lc(name) !== lc(host.project)) return wrong(`${ref.org}/${name}`)
    if (!name) note = `the ids in the URL could not be read, so they were taken as ${host.project}`
    project = host.project
  } else if (lc(project) !== lc(host.project)) return wrong(`${ref.org}/${project}`)
  if (ref.type === 'pr' && GUID.test(repo)) {
    const r = await azureGet(h, `${base}/${encodeURIComponent(host.project)}/_apis/git/repositories/${repo}?api-version=7.1`)
    const name = typeof r?.name === 'string' ? r.name : ''
    const pn = typeof (r?.project as { name?: unknown } | undefined)?.name === 'string' ? ((r!.project as { name: string }).name) : ''
    if (pn && lc(pn) !== lc(host.project)) return wrong(`${ref.org}/${pn}`)
    if (name) repo = name
    else {
      repo = host.repo
      note = note || `the ids in the URL could not be read, so they were taken as ${host.project}/${host.repo}`
    }
  }
  return { ok: true, ref: { ...ref, project, repo }, ...(note ? { note } : {}) }
}

// what the model proposed -> the exact target (never invented: a number alone is read against the thread's own project remote)
export async function resolveTarget(h: Host, thread: string, t: unknown): Promise<{ ok: true; target: Target; viaRemote: boolean; note?: string } | { ok: false; text: string }> {
  const x = t && typeof t === 'object' && !Array.isArray(t) ? (t as TargetIn) : null
  const keys = x ? Object.keys(x).filter(k => (x as Record<string, unknown>)[k] !== undefined && (x as Record<string, unknown>)[k] !== null && (x as Record<string, unknown>)[k] !== '') : []
  if (!x || keys.length !== 1 || (keys[0] !== 'pr' && keys[0] !== 'workitem')) return { ok: false, text: 'allow-writes needs target: {pr: <number or URL>} or {workitem: <id>} (exactly one)' }
  const type = keys[0] as 'pr' | 'workitem'
  const raw = x[type]
  if (type === 'workitem' && typeof raw === 'string' && raw.trim().toLowerCase() === 'new') {
    const host = await remoteOf(h, thread)
    if (typeof host === 'string') return { ok: false, text: host }
    if (host.kind !== 'azure') return { ok: false, text: `a work item can only be created on an Azure DevOps project (${thread}'s remote is GitHub)` }
    return { ok: true, target: { scope: `Azure DevOps work item ${host.org}/${host.project}#new`, type, n: 0, create: true }, viaRemote: true }
  }
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
    const ref = parseForgeUrl(raw)
    if (!ref || ref.type !== type) return { ok: false, text: `${raw.slice(0, 100)} is not the URL of a ${type === 'pr' ? 'GitHub or Azure DevOps PR' : 'Azure DevOps work item'} (like https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<n>, https://github.com/<owner>/<repo>/pull/<n> or https://dev.azure.com/<org>/<project>/_workitems/edit/<n>)` }
    const res = await resolveRef(h, thread, ref)
    if (!res.ok) return res
    return { ok: true, target: { scope: scopeOfRef(res.ref), type, n: ref.n, url: true }, viaRemote: false, ...(res.note ? { note: res.note } : {}) }
  }
  const n = num(raw)
  if (n === null) return { ok: false, text: `target.${type} must be a positive whole number or a URL` }
  const host = await remoteOf(h, thread)
  if (typeof host === 'string') return { ok: false, text: host }
  const scope = type === 'pr' ? repoScope(host, n) : itemScope(host, n)
  if (!scope) return { ok: false, text: `a work item can only be resolved on an Azure DevOps project (${thread}'s remote is GitHub): give the full URL` }
  return { ok: true, target: { scope, type, n }, viaRemote: true }
}

// does the user's text name this target? the number as a WHOLE token (never inside a longer number, 1,042 or 42.5 or 142), or a URL that parses to the same scope.
// A number written after the word of the OTHER kind ("work item 42" for a PR) is not the target.
const URLS = /https?:\/\/[^\s<>"']+/g
const tokenRe = (n: number) => new RegExp(`(?<!\\d)(?<!\\d[.,])${n}(?!\\d)(?![.,]\\d)`, 'g')
const OWN: Record<Target['type'], RegExp> = { pr: /(?:\bpr|\bpull(?:\s*request)?|!)\s*#?\s*$/i, workitem: /(?:work\s*item|\bwi|\bticket|\btask|\bbug|\bstory)\s*#?\s*$/i }
// `scopes`: the URLs of the text, each already resolved against the thread's remote (a GUID URL names the project by name only after that)
export function namesTarget(text: string, target: Target, remoteScope: string | null, scopes?: Map<string, string>): boolean {
  for (const u of text.match(URLS) ?? []) {
    const sc = scopes?.get(u) ?? scopeOfUrl(u)?.scope
    if (sc && lc(sc) === lc(target.scope)) return true
  }
  // a number alone names the target only when the target is the one of the thread's own project remote (a URL to another repo needs its own URL in the words)
  if (target.url && !(remoteScope && lc(remoteScope) === lc(target.scope))) return false
  const other = OWN[target.type === 'pr' ? 'workitem' : 'pr']
  const own = OWN[target.type]
  const re = tokenRe(target.n)
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 16), m.index)
    if (other.test(before) && !own.test(before)) continue
    return true
  }
  return false
}

// ---- the grant: allow-writes --------------------------------------------------------------------------------------------------------------------
async function capOf(h: Host): Promise<number> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const v = cfg && typeof cfg === 'object' ? (cfg.actions?.maxWritesPerGrant ?? cfg['actions.maxWritesPerGrant']) : undefined
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000 ? v : WRITES_CAP
}
const quoteOf = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200)

export async function allowWrites(h: Host, thread: string, target: unknown, kinds?: unknown): Promise<{ ok: boolean; text: string; target?: { scope: string; type: 'pr' | 'workitem'; n: number }; ask?: { question: string; options: { label: string; description: string }[] } }> {
  if (!threadOk(thread)) return { ok: false, text: 'allow-writes needs tN (the thread the writes are for)' }
  const t = await readJson<{ state?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, null).catch(() => null)
  if (!t) return { ok: false, text: `no thread ${thread}` }
  if (t.state === 'closed') return { ok: false, text: `${thread} is closed` }
  const res = await resolveTarget(h, thread, target)
  if (!res.ok) return { ok: false, text: res.text }
  const { target: tg } = res
  const allowed = tg.create ? CREATE_KINDS : tg.type === 'pr' ? PR_KINDS : WI_KINDS
  let want = allowed
  if (kinds !== undefined) {
    const k = Array.isArray(kinds) ? kinds.map(x => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : []
    const bad = k.filter(x => !allowed.includes(x))
    if (!k.length || bad.length) return { ok: false, text: `kinds for a ${tg.type === 'pr' ? 'PR' : 'work item'}: ${allowed.join(', ')} (got ${k.map(x => x || '?').join(', ').slice(0, 80) || 'none'}); a push, a merge, a delete or a settings change is never covered` }
    want = [...new Set(k)]
  }
  const label = tg.scope.replace(/^(Azure DevOps|GitHub) /, '')
  const remoteScope = res.viaRemote ? tg.scope : await remoteScopeOf(h, thread, tg)
  const prompts = await recentPrompts(h)
  // the URLs the user wrote that carry the number of this target: each resolved against the thread's remote (a GUID URL names its project by name only after that)
  const scopes = new Map<string, string>()
  for (const p of prompts.slice(-8)) {
    for (const u of (p.text.match(URLS) ?? []).slice(0, 4)) {
      const ref = parseForgeUrl(u)
      if (!ref || ref.n !== tg.n || ref.type !== tg.type || scopes.has(u)) continue
      const r = await resolveRef(h, thread, ref)
      if (r.ok) scopes.set(u, scopeOfRef(r.ref))
    }
  }
  const hit = [...prompts].reverse().find(p => (tg.create ? createIn(p.text) : namesTarget(p.text, tg, remoteScope, scopes) && instructionIn(p.text)))
  if (!hit) {
    const named = tg.create ? prompts.filter(p => createIn(p.text)).length : prompts.filter(p => namesTarget(p.text, tg, remoteScope, scopes)).length
    const r = await refusalText(h, thread, tg, label, prompts, kinds !== undefined ? want : offerKindsFor(tg), named)
    return { ok: false, text: r.text, ...(r.ask ? { ask: r.ask } : {}) }
  }
  const cap = await capOf(h)
  return exclusive(async () => {
    const now = await h.clock.now()
    const base = { id: `w${now}-${++wseq}`, thread, scope: tg.scope, kinds: want, statuses: [] as string[], quote: quoteOf(hit.text), qts: hit.ts, cap, used: 0, ts: now, exp: now + WRITES_TTL_MS }
    const g = await resign(h, base)
    if (!g) return { ok: false, text: 'no key to sign the grant with' }
    const keep = (await grantRows(h, now)).filter(x => !(x.thread === thread && lc(x.scope) === lc(tg.scope) && !x.statuses.length)) // (the words replace the words; a grant of the dialog's choice stays)
    await saveGrants(h, [...keep, g])
    await logHistory(h, thread, { kind: 'writes-granted', id: g.id, scope: g.scope, kinds: want, quote: g.quote, cap, hours: 24 })
    return { ok: true, ...(tg.create ? {} : { target: { scope: tg.scope, type: tg.type, n: tg.n } }), text: `allowed ${thread} on ${label}: ${want.join(', ')} (up to ${cap} writes, 24 h or until ${thread} closes), resting on your words "${g.quote}". Revoke: the pane's Revoke button, /lean-agent:revoke ${thread}, or say "stop writes".${res.note ? ` Note: ${res.note}.` : ''} Tell the user this in one line` }
  })
}
// the forms that count, said in the refusal (the field: nothing said which form counts or why one failed)
export const FORMS = (thread: string) => `/lean-agent:allow ${thread} <PR number or URL> (also without the slash: allow ${thread} <PR number or URL>); plain words that count: 'fix the comments on PR <n>' (or paste the PR URL with 'please handle this')`
const REFUSED = 'action.writes.refused'
const SOFT_IN = new RegExp(`(?<![\\w-])(${SOFT_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\\w-])`, 'i')
const COMMAND_TRY =/(?:^|[\s!])\/?(?:lean-agent:)?allow\b/i
async function refusalText(h: Host, thread: string, tg: Target, label: string, prompts: { text: string; ts: number }[], offerKinds: string[], named: number): Promise<{ text: string; ask?: Asked }> {
  const create = tg.create === true
  const last = prompts[prompts.length - 1]
  const tried = last && (/lean-agent:allow/i.test(last.text) || COMMAND_TRY.test(last.text.trim()) || instructionIn(last.text) || createIn(last.text) || SOFT_IN.test(last.text)) ? last.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const miss = tried ? `your last message '${tried}' did not name ${create ? 'a new work item to create' : 'a PR number or URL'} that matches ${label}${create ? '' : ' (a number counts as a whole word, after PR, or the PR / work item URL of this thread\'s project)'}: ` : ''
  // what the mod can SEE, and a ready-made canonical question (a signed offer) so the desk is never left with only a refusal
  const offer = await makeOffer(h, thread, tg, offerKinds).catch(() => null)
  const ask = offer ? offerQuestion(offer) : undefined
  const what = create ? 'a new work item' : `${tg.type === 'pr' ? 'PR' : 'work item'} ${tg.n}`
  const rec = `recorded prompts: ${prompts.length}, ${named ? `${named} name${named === 1 ? 's' : ''} ${what} but none asks for the work` : `none names ${what}`}`
  const q = ask ? JSON.stringify(ask.question) : `(none: lean_thread allow-ask ${thread} makes it)`
  const asked = `ask with AskUserQuestion (allow-ask), pasted exactly with exactly the options Allow, Not now; their Allow is the written yes: ${q}`
  // the same refusal again with nothing new typed since: no generic text, the next step only
  const key = `${thread}|${tg.scope.toLowerCase()}|${prompts.length}|${last ? last.ts : 0}`
  const prev = await h.store.get(REFUSED).catch(() => null)
  await h.store.set(REFUSED, key).catch(() => {})
  if (prev === key) return { text: `refused again, nothing new was typed since (${rec}): ${asked}. Do not call allow-writes or the allow skill again. Ask with AskUserQuestion now. Nothing was created`, ...(ask ? { ask } : {}) }
  return {
    text: `${miss}no message typed by you ${await seenSince(h)} names ${label} (${rec}; a line run in a shell box or by a Run button never reaches lean-agent, so it is not among them). To proceed, in order: (a) the USER writes ${create ? 'the new work item and the go' : 'the PR and the go'} as plain words in the CHAT box (e.g. ${create ? '"create the work items in this project"' : `"post the comments on PR ${tg.n}"`}), or types the slash command ${FORMS(thread)} in the CHAT box (never in a shell box, never in a code fence); (b) or ${asked}. Nothing was created`,
    ...(ask ? { ask } : {}),
  }
}

// ---- the grant OFFER: a dialog answer is the written yes ----------------------------------------------------------------------------------------
// `lean_thread allow-ask` (or a refused allow-writes) stores a SIGNED pending offer with the exact scope and kinds and returns its canonical question. The user's
// answer is read by the mod from the dialog result (bindOfferAnswers, only the desk's AskUserQuestion hook calls it), exactly like an action approval: the
// question text and option labels must be the canonical ones, and the typed-approval table (writeinstr.ts typedApproval) applies. An Allow creates the same
// grant as the user's words (same scope, 24 h, cap, Revoke), with the history line "by the user in a dialog". Nothing a model sends creates one.
const OFFERS = 'action.writes.offers'
export const OFFER_TTL_MS = 2 * 60 * 60 * 1000
export const OFFER_LABELS = ['Allow', 'Not now'] as const
type Offer = { id: string; thread: string; scope: string; type: 'pr' | 'workitem'; n: number; create: boolean; kinds: string[]; ts: number; exp: number; sig: string }
type Asked = { question: string; options: { label: string; description: string }[] }
const oText = (o: Omit<Offer, 'sig'>) => `desk-offer\n${o.id}\n${o.thread}\n${o.scope}\n${o.type}\n${o.n}\n${o.create}\n${o.kinds.join(',')}\n${o.ts}\n${o.exp}`
let oseq = 0
// what a grant of an offer covers, when nothing but the kinds the user is told
export const offerKindsFor = (tg: Target): string[] => (tg.create ? CREATE_KINDS : tg.type === 'pr' ? ['reply', 'comment', 'link'] : WI_KINDS)
const andList = (l: string[]): string => (l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`)
function whatOf(o: Pick<Offer, 'scope' | 'type' | 'n' | 'create' | 'kinds'>): string {
  if (o.create) return `create work items in ${o.scope.replace(/^Azure DevOps work item /, '').replace(/#new$/, '')}`
  const k = o.kinds
  if (o.type === 'workitem') return `${andList([...(k.includes('comment') ? ['comment on'] : []), ...(k.includes('update') ? ['update'] : [])])} work item ${o.n}`
  const post = ['reply', 'comment'].filter(x => k.includes(x)).map(x => (x === 'reply' ? 'replies' : 'comments'))
  const parts = [...(post.length ? [`post ${andList(post)}`] : []), ...(k.includes('status') ? ['set thread statuses'] : []), ...(k.includes('link') ? ['link work items'] : [])]
  return `${andList(parts)} on PR ${o.n} and move its own work item to Reviewing`
}
const offerCode = (o: Omit<Offer, 'sig'>): string => hashOf(oText(o)).slice(0, 12)
export function offerQuestion(o: Offer): Asked {
  return {
    question: `Allow ${o.thread} to ${whatOf(o)} for 24 h? [offer ${o.id}, check ${offerCode(o)}]`,
    options: [
      { label: 'Allow', description: `the mod makes a written approval for exactly this: ${o.scope.replace(/^(Azure DevOps|GitHub) /, '')}, ${o.kinds.join(', ')}, 24 h or until ${o.thread} closes, at most 40 writes; Revoke in the pane` },
      { label: 'Not now', description: `nothing is allowed; ${o.thread} asks for each write as before` },
    ],
  }
}
async function offerRows(h: Host, now: number): Promise<Offer[]> {
  const v = await h.store.get(OFFERS).catch(() => null)
  const out: Offer[] = []
  for (const o of Array.isArray(v) ? v : []) {
    if (!o || typeof o.id !== 'string' || !threadOk(o.thread) || typeof o.scope !== 'string' || (o.type !== 'pr' && o.type !== 'workitem') || !Array.isArray(o.kinds) || !o.kinds.every((k: unknown) => typeof k === 'string') || typeof o.create !== 'boolean') continue
    if (![o.n, o.ts, o.exp].every(Number.isFinite) || typeof o.sig !== 'string' || now > o.exp) continue
    const want = await macOf(h, oText(o), false)
    if (want && want.length === o.sig.length && want === o.sig) out.push(o)
  }
  return out
}
// the offer for this target and kinds: a pending identical one is the one that is there; at most 5 are kept
async function makeOffer(h: Host, thread: string, tg: Target, kinds: string[]): Promise<Offer | null> {
  return exclusive(async () => {
    const now = await h.clock.now()
    const all = await offerRows(h, now)
    const same = all.find(o => o.thread === thread && lc(o.scope) === lc(tg.scope) && o.kinds.join() === kinds.join())
    if (same) return same
    const base = { id: `o${now}-${++oseq}`, thread, scope: tg.scope, type: tg.type, n: tg.n, create: tg.create === true, kinds, ts: now, exp: now + OFFER_TTL_MS }
    const sig = await macOf(h, oText(base), true)
    if (!sig) return null
    const rec = { ...base, sig }
    await h.store.set(OFFERS, [...all, rec].slice(-5))
    return rec
  })
}
// `lean_thread allow-ask`: the model proposes the target, the user's dialog answer decides
export async function askWrites(h: Host, thread: string, target: unknown, kinds?: unknown): Promise<{ ok: boolean; text: string; ask?: Asked }> {
  if (!threadOk(thread)) return { ok: false, text: 'allow-ask needs tN (the thread the writes are for)' }
  const t = await readJson<{ state?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, null).catch(() => null)
  if (!t) return { ok: false, text: `no thread ${thread}` }
  if (t.state === 'closed') return { ok: false, text: `${thread} is closed` }
  const res = await resolveTarget(h, thread, target)
  if (!res.ok) return { ok: false, text: res.text }
  const tg = res.target
  let want = offerKindsFor(tg)
  if (kinds !== undefined) {
    const allowed = tg.create ? CREATE_KINDS : tg.type === 'pr' ? PR_KINDS : WI_KINDS
    const k = Array.isArray(kinds) ? kinds.map(x => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : []
    if (!k.length || k.some(x => !allowed.includes(x))) return { ok: false, text: `kinds for a ${tg.type === 'pr' ? 'PR' : 'work item'}: ${allowed.join(', ')}; a push, a merge, a delete or a settings change is never covered` }
    want = [...new Set(k)]
  }
  const offer = await makeOffer(h, thread, tg, want)
  if (!offer) return { ok: false, text: 'no key to sign the offer with' }
  const q = offerQuestion(offer)
  return { ok: true, ask: q, text: `ask the USER with AskUserQuestion, pasting this question exactly, with exactly the options Allow, Not now (${q.options.map(o => `${o.label}: ${o.description}`).join(' | ')}): ${JSON.stringify(q.question)}. The mod reads their answer itself: only an Allow they give makes the grant; never answer for them. Offer valid 2 h` }
}
type Q = { question?: unknown; options?: unknown; multiSelect?: unknown }
// The desk's AskUserQuestion, after the user answered it: an Allow (the label, or a typed clear approval) for the CANONICAL question of one live offer makes the grant.
export async function bindOfferAnswers(h: Host, questions: unknown, answers: unknown): Promise<{ notes: string[]; granted: { thread: string; target: { scope: string; type: 'pr' | 'workitem'; n: number } | undefined }[] }> {
  const qs: Q[] = Array.isArray(questions) ? (questions as Q[]) : []
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null
  const out = { notes: [] as string[], granted: [] as { thread: string; target: { scope: string; type: 'pr' | 'workitem'; n: number } | undefined }[] }
  for (const q of qs) {
    const text = typeof q?.question === 'string' ? q.question : ''
    const m = /\[offer (o\d+-\d+), check ([0-9a-f]{12})\]/.exec(text)
    if (!m || !given) continue
    const now = await h.clock.now()
    const o = (await offerRows(h, now)).find(x => x.id === m[1])
    if (!o) {
      out.notes.push(`the answer to the question about offer ${m[1]} was NOT recorded: no such offer, or it expired (2 h): call lean_thread allow-ask again`)
      continue
    }
    const canon = offerQuestion(o)
    const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
    if (text !== canon.question || opts.length !== canon.options.length || !canon.options.every((c, i) => opts[i]?.label === c.label && opts[i]?.description === c.description) || q.multiSelect === true) {
      out.notes.push(`the answer to the question about offer ${o.id} was NOT recorded: the question the user saw was not the canonical one (its text and the options Allow / Not now exactly). Ask again with the question from lean_thread allow-ask`)
      continue
    }
    const a = typeof given[text] === 'string' ? (given[text] as string).trim() : ''
    const yes = a === 'Allow' || (a !== 'Not now' && a !== '' && typedApproval(a).approve)
    if (!yes) {
      if (a === 'Not now') {
        await dropOffer(h, o.id)
        out.notes.push(`the user chose Not now for offer ${o.id}: nothing was allowed; ${o.thread} keeps asking per write`)
      } else if (a) out.notes.push(`the user typed '${a.replace(/\s+/g, ' ').slice(0, 80)}': free text is not an Allow for offer ${o.id}; ask again with the choices, or the user can type /lean-agent:allow ${o.thread} <PR number>`)
      continue
    }
    const g = await grantOfOffer(h, o, a)
    out.notes.push(g.text)
    if (g.ok) out.granted.push({ thread: o.thread, target: o.create ? undefined : { scope: o.scope, type: o.type, n: o.n } })
  }
  return out
}
async function dropOffer(h: Host, id: string): Promise<void> {
  await exclusive(async () => {
    const all = await offerRows(h, await h.clock.now())
    await h.store.set(OFFERS, all.filter(o => o.id !== id))
  })
}
async function grantOfOffer(h: Host, o: Offer, typed: string): Promise<{ ok: boolean; text: string }> {
  const t = await readJson<{ state?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${o.thread}/thread.json`, null).catch(() => null)
  if (!t || t.state === 'closed') return { ok: false, text: `${o.thread} is closed or gone: nothing was allowed` }
  const cap = await capOf(h)
  const g = await exclusive(async () => {
    const now = await h.clock.now()
    const base = { id: `w${now}-${++wseq}`, thread: o.thread, scope: o.scope, kinds: o.kinds, statuses: [] as string[], quote: `you answered ${typed && typed !== 'Allow' ? `"${typed.slice(0, 60)}"` : 'Allow'} in a dialog (offer ${o.id})`, qts: now, cap, used: 0, ts: now, exp: now + WRITES_TTL_MS }
    const signed = await resign(h, base)
    if (!signed) return null
    const keep = (await grantRows(h, now)).filter(x => !(x.thread === o.thread && lc(x.scope) === lc(o.scope) && !x.statuses.length))
    await saveGrants(h, [...keep, signed])
    await h.store.set(OFFERS, (await offerRows(h, now)).filter(x => x.id !== o.id))
    return signed
  })
  if (!g) return { ok: false, text: 'no key to sign the grant with' }
  await logHistory(h, o.thread, { kind: 'writes-granted', id: g.id, scope: g.scope, kinds: g.kinds, quote: g.quote, cap, hours: 24, by: 'the user in a dialog' })
  return { ok: true, text: `the user allowed ${o.thread} on ${o.scope.replace(/^(Azure DevOps|GitHub) /, '')}: ${g.kinds.join(', ')} (up to ${cap} writes, 24 h or until ${o.thread} closes) by their answer in the dialog. Revoke: the pane's Revoke button, /lean-agent:revoke ${o.thread}, or "stop writes". Tell the user this in one line` }
}
async function remoteScopeOf(h: Host, thread: string, tg: Target): Promise<string | null> {
  const host = await remoteOf(h, thread)
  if (typeof host === 'string') return null
  return tg.type === 'pr' ? repoScope(host, tg.n) : itemScope(host, tg.n)
}

// ---- execution under a grant ------------------------------------------------------------------------------------------------------------------
type Item = { kind: ActionKind; params: Params }
async function verifyThread(h: Host, repo: string, pr: number, thread: string): Promise<boolean> {
  const query = 'query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }'
  const r = await h.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`, '-f', `id=${thread}`], { timeoutMs: 30_000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  if (r.exitCode !== 0) return false
  try {
    const p = (JSON.parse(String(r.stdout)) as { data?: { node?: { pullRequest?: { number?: unknown; repository?: { nameWithOwner?: unknown } } } } }).data?.node?.pullRequest
    return !!p && p.number === pr && typeof p.repository?.nameWithOwner === 'string' && lc(p.repository.nameWithOwner) === lc(repo)
  } catch {
    return false
  }
}
const itemsOf = (kind: ActionKind, params: Params): Item[] | null => {
  const raw = kind !== 'batch' ? [{ kind, params }] : Array.isArray(params.items) ? (params.items as Item[]) : null
  return raw && raw.length ? raw : null
}

// the grant that covers EVERY write of this request, with the count of writes; null: not covered (the user is asked)
async function coverOf(h: Host, thread: string, kind: ActionKind, params: Params, plan: Plan, now: number): Promise<{ g: WGrant; writes: number } | null> {
  const items = itemsOf(kind, params)
  if (!items) return null
  const grants = (await grantRows(h, now)).filter(g => g.thread === thread)
  if (!grants.length) return null
  const first = items[0]!
  if (!GRANT_KIND[first.kind]) return null
  const writes = plan.steps?.length ?? 1
  for (const g of grants.filter(x => lc(x.scope) === lc(targetOf(first.kind, first.params)))) {
    let ok = g.used + writes <= g.cap
    for (const it of items) {
      if (!ok) break
      const gk = GRANT_KIND[it.kind]
      if (!gk || !g.kinds.includes(gk) || lc(targetOf(it.kind, it.params)) !== lc(g.scope)) ok = false // a push, a delete, any other kind or another target: always asked
      else if (g.statuses.length && !statusCovered(g, it)) ok = false
      else if (it.kind === 'gh-pr-thread-resolve' && !(await verifyThread(h, String(it.params.repo), Number(it.params.pr), String(it.params.thread)))) ok = false
    }
    if (ok) return { g, writes }
  }
  return null
}
// a grant of the dialog's choice (statuses named): a thread status needs its status in the list, a reply with a status needs the `status` kind too, a work item update its state
function statusCovered(g: WGrant, it: Item): boolean {
  const p = it.params
  if (it.kind === 'ado-pr-thread-status') return g.statuses.includes(String(p.status))
  if (it.kind === 'ado-pr-reply' && p.status !== undefined) return g.kinds.includes('status') && g.statuses.includes(String(p.status))
  if (it.kind === 'ado-workitem-update') {
    const f = p.fields && typeof p.fields === 'object' ? (p.fields as { state?: unknown }) : null
    return !!f && Object.keys(f).length === 1 && g.statuses.includes(lc(String(f.state ?? ''))) // only the state, never a title or an assignee
  }
  return true
}

// The dialog's fourth choice for every kind but a thread status (deskactions.ts answerAction calls this through setHumanGrantWriter, only after the human pressed it):
// a signed written approval of the request's own PR or work item, for exactly the kinds of the request, 24 h, at most 40 writes
async function writeHumanGrant(h: Host, r: { id: string; thread: string; kind: ActionKind; params: Params }, now: number): Promise<boolean> {
  const items = itemsOf(r.kind, r.params)
  if (!items) return false
  const kinds = new Set<string>()
  let statuses = [...STANDING_STATUSES]
  for (const it of items) {
    const gk = GRANT_KIND[it.kind]
    if (!gk) return false
    kinds.add(gk)
    if (it.kind === 'ado-pr-reply' && it.params.status !== undefined) kinds.add('status')
    if (it.kind === 'ado-workitem-update') statuses = HUMAN_WI_STATES.map(lc)
  }
  const scope = targetOf(items[0]!.kind, items[0]!.params)
  const cap = await capOf(h)
  // (called inside answerAction's gate: no `exclusive` here)
  const base = { id: `w${now}-${++wseq}`, thread: r.thread, scope, kinds: [...kinds], statuses, quote: `you pressed "${standingLabelOf(r.kind === 'batch' ? String(items[0]!.kind) : r.kind)}" on request ${r.id}`, qts: now, cap, used: 0, ts: now, exp: now + WRITES_TTL_MS }
  const g = await resign(h, base)
  if (!g) return false
  const keep = (await grantRows(h, now)).filter(x => !(x.thread === r.thread && lc(x.scope) === lc(scope) && x.statuses.length && x.kinds.join() === g.kinds.join()))
  await saveGrants(h, [...keep, g])
  return true
}
setHumanGrantWriter(writeHumanGrant)

// a request that was just made: when the user's written instruction covers it, the mod sends it at once (the same executor). null: the user is asked
export async function runGranted(h: Host, id: string): Promise<{ sent: boolean; line: string } | null> {
  const r = (await rows(h)).find(x => x.id === id)
  if (!r) return null
  const plan = await sound(h, r)
  if (!plan) return null
  const cover = await coverOf(h, r.thread, r.kind, r.params, plan, await h.clock.now())
  if (!cover) return null
  let taken: WGrant | null = null
  const out = await claimAndSend(h, id, `written instruction (grant ${cover.g.id})`, async () => {
    // inside the executor's gate: the write count is taken once, against the grant as it is NOW (a revoked or expired one sends nothing)
    const now = await h.clock.now()
    const all = await grantRows(h, now)
    const cur = all.find(x => x.id === cover.g.id)
    if (!cur || cur.used + cover.writes > cur.cap) return false
    const next = await resign(h, { ...cur, used: cur.used + cover.writes })
    if (!next) return false
    await saveGrants(h, all.map(x => (x.id === cur.id ? next : x)))
    taken = next
    return true
  })
  if (!out) return null
  if (out.held) return out.held // held by sendhold.ts (a newer instruction, or its hold window): the write count is taken when it really goes out
  const g: WGrant = taken ?? cover.g
  const what = `${out.plan.headline}: ${out.plan.text}`
  if (!out.sent) return { sent: false, line: `sent under your instruction '${g.quote}' FAILED: ${out.text}` }
  const line = `sent under your instruction '${g.quote}': ${what} (write ${g.used} of ${g.cap})`
  const now = await h.clock.now()
  const prev = await h.store.get(WSENT).catch(() => null)
  await h.store.set(WSENT, [...(Array.isArray(prev) ? prev : []), { ts: now, thread: r.thread, text: line, grant: g.id } satisfies WSent].slice(-10))
  await logHistory(h, r.thread, { kind: 'writes-sent', id, action: r.kind, grant: g.id, by: 'your written instruction', quote: g.quote, count: g.used, result: what.slice(0, 300) })
  return { sent: true, line }
}

// ---- what the pane and action-list show ---------------------------------------------------------------------------------------------------------
export type WritesView = { grants: { id: string; thread: string; scope: string; kinds: string[]; quote: string; used: number; cap: number; exp: number }[]; sent: { ts: number; thread: string; text: string; grant?: string }[] }
export async function writesView(h: Host): Promise<WritesView> {
  const now = await h.clock.now()
  const grants = await grantRows(h, now)
  const active = new Set(grants.map(g => g.id))
  const raw = await h.store.get(WSENT).catch(() => null)
  const rev = await ownRevoked(h)
  const live = (s: WSent) => !!s.grant && (active.has(s.grant) || (s.grant.startsWith('own:') && Number.isFinite(s.since) && ownActive(rev, String(s.thread), s.since!)))
  const sent = (Array.isArray(raw) ? (raw as WSent[]) : []).filter(s => s && typeof s.text === 'string' && Number.isFinite(s.ts) && now - s.ts <= SENT_SHOWN_MS).map(s => ({ ts: s.ts, thread: String(s.thread), text: s.text, ...(live(s) ? { grant: s.grant } : {}) }))
  return { grants: grants.map(g => ({ id: g.id, thread: g.thread, scope: g.scope, kinds: g.kinds, quote: g.quote, used: g.used, cap: g.cap, exp: g.exp })), sent }
}
// an own-PR default send (ownpr.ts) shown in the pane: the exact text, with the Revoke button of `own:<tN>`
export async function recordOwnSent(h: Host, rec: { ts: number; thread: string; text: string; since: number }): Promise<void> {
  const prev = await h.store.get(WSENT).catch(() => null)
  await h.store.set(WSENT, [...(Array.isArray(prev) ? prev : []), { ...rec, grant: `own:${rec.thread}` } satisfies WSent].slice(-10))
}
export async function writesListText(h: Host): Promise<string> {
  const v = await writesView(h)
  if (!v.grants.length) return ''
  return `\nthe user's written instructions (a request they cover is sent by the mod at once: do not ask the user again; anything else is asked):${v.grants.map(g => `\n  ${g.id} · ${g.thread} · ${g.scope} · ${g.kinds.join(', ')} · ${g.used}/${g.cap} writes · until ${new Date(g.exp).toISOString().slice(0, 16).replace('T', ' ')} UTC (or the thread closes) · "${g.quote.slice(0, 80)}"`).join('')}`
}

// ---- revoking only takes power away ----------------------------------------------------------------------------------------------------------------
export async function revokeWrites(h: Host, by: { id?: string; thread?: string; all?: boolean; scopeEnds?: string[] }, who = 'user, in the pane'): Promise<{ ok: boolean; text: string; n: number }> {
  if (by.id?.startsWith('own:')) {
    const thread = by.id.slice(4)
    const n = threadOk(thread) ? await revokeOwn(h, { thread }, who) : 0
    return n ? { ok: true, n, text: `revoked the own-PR default of ${thread}: its replies and work item moves are asked again` } : { ok: false, n: 0, text: `no own-PR default for ${by.id}` }
  }
  const hit = await exclusive(async () => {
    const all = await grantRows(h, await h.clock.now())
    const gone = all.filter(g => (by.id && g.id === by.id) || (by.thread && g.thread === by.thread) || by.all || (by.scopeEnds ?? []).some(e => g.scope.endsWith(e)))
    if (gone.length) await saveGrants(h, all.filter(g => !gone.includes(g)))
    return gone
  })
  for (const g of hit) await logHistory(h, g.thread, { kind: 'writes-revoked', id: g.id, scope: g.scope, by: who })
  return hit.length ? { ok: true, n: hit.length, text: `revoked ${hit.map(g => `${g.id} (${g.thread}, ${g.scope.replace(/^(Azure DevOps|GitHub) /, '')})`).join('; ')}: the writes of ${[...new Set(hit.map(g => g.thread))].join(', ')} are asked again` } : { ok: false, n: 0, text: by.id ? `no active written approval ${by.id}` : 'no active written approval for that' }
}
export const revokeButton = (h: Host, id: string) => revokeWrites(h, { id })
// a thread that closed keeps no written approval
export async function dropWriteGrants(h: Host, thread: string): Promise<void> {
  await revokeWrites(h, { thread }, 'thread closed').catch(() => undefined)
}
// the user typed "stop writes" / "revoke" (or /lean-agent:revoke): a thread named (tN) loses its grants, a PR or work item number named loses its, else all of them; the 1.0.24
// status-only grants of the same threads go with them. Called with a recorded HUMAN prompt only (register.tsx).
export async function revokeByWords(h: Host, text: string): Promise<number> {
  if (!revokeIn(text)) return 0
  const threads = [...new Set([...text.matchAll(/(?<![\w-])t\d{1,9}(?![\w-])/gi)].map(m => m[0].toLowerCase()))]
  const nums = [...new Set([...text.matchAll(/(?<!\d)(?<!\d[.,])(\d{1,9})(?!\d)(?![.,]\d)/g)].map(m => `#${m[1]}`))]
  const named = threads.length > 0 || nums.length > 0
  let n = 0
  if (!named) {
    n += (await revokeWrites(h, { all: true }, 'user, typed words')).n
    n += await revokeOwn(h, { all: true }, 'user, typed words')
  } else {
    for (const t of threads) {
      n += (await revokeWrites(h, { thread: t }, 'user, typed words')).n
      n += await revokeOwn(h, { thread: t }, 'user, typed words')
    }
    if (nums.length) for (const t of await ownThreadsOf(h, nums)) n += await revokeOwn(h, { thread: t }, 'user, typed words')
    if (nums.length) n += (await revokeWrites(h, { scopeEnds: nums }, 'user, typed words')).n
  }
  const st = await standingView(h).catch(() => null)
  for (const g of st?.grants ?? []) if (!named || threads.includes(g.thread) || nums.some(x => g.scope.endsWith(x))) if ((await revokeGrant(h, g.id)).ok) n++
  return n
}
