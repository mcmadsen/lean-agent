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
import { claimAndSend, exclusive, logHistory, revokeGrant, rows, sound, standingView, targetOf, threadOk } from './deskactions'
import type { ActionKind, Params, Plan } from './deskactions'
import { recentPrompts } from './humanprompts'
import { instructionIn, revokeIn } from './writeinstr'

export const WRITES_TTL_MS = 24 * 60 * 60 * 1000
export const WRITES_CAP = 40
export const PR_KINDS = ['reply', 'status', 'comment']
export const WI_KINDS = ['comment', 'update']
// the table: which request kind a grant kind covers (a batch is never one kind: every item is looked at)
const GRANT_KIND: Partial<Record<ActionKind, string>> = { 'ado-pr-reply': 'reply', 'ado-pr-thread-status': 'status', 'ado-pr-comment': 'comment', 'ado-workitem-comment': 'comment', 'ado-workitem-update': 'update', 'gh-pr-comment': 'comment', 'gh-pr-thread-resolve': 'status' }

type WGrant = { id: string; thread: string; scope: string; kinds: string[]; quote: string; qts: number; cap: number; used: number; ts: number; exp: number; sig: string }
type WSent = { ts: number; thread: string; text: string; grant?: string }
const WGRANTS = 'action.writes.grants'
const WSENT = 'action.writes.sent'
const SENT_SHOWN_MS = 30 * 60 * 1000
const wText = (g: Omit<WGrant, 'sig'>) => `desk-writes\n${g.id}\n${g.thread}\n${g.scope}\n${g.kinds.join(',')}\n${JSON.stringify(g.quote)}\n${g.qts}\n${g.cap}\n${g.used}\n${g.ts}\n${g.exp}`
let wseq = 0
export const resetWrites = () => {
  wseq = 0
}
const lc = (s: string) => s.toLowerCase()

async function grantRows(h: Host, now: number): Promise<WGrant[]> {
  const v = await h.store.get(WGRANTS).catch(() => null)
  const out: WGrant[] = []
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.id !== 'string' || !threadOk(g.thread) || typeof g.scope !== 'string' || typeof g.quote !== 'string' || !Array.isArray(g.kinds) || !g.kinds.every((k: unknown) => typeof k === 'string')) continue
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
type Target = { scope: string; type: 'pr' | 'workitem'; n: number; url?: boolean }
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e9 ? n : null
}
// a URL of a PR or a work item -> the scope it names (the same text targetOf makes), or null
export function scopeOfUrl(u: string): Target | null {
  const s = u.trim().replace(/[)>.,;]+$/, '')
  let m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(s)
  if (m) return { scope: `GitHub PR ${m[1]}/${m[2]}#${m[3]}`, type: 'pr', n: Number(m[3]), url: true }
  m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(s)
  if (m) return { scope: `Azure DevOps PR ${dec(m[1]!)}/${dec(m[2]!)}/${dec(m[3]!)}#${m[4]}`, type: 'pr', n: Number(m[4]), url: true }
  m = /^https?:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(s)
  if (m) return { scope: `Azure DevOps PR ${dec(m[1]!)}/${dec(m[2]!)}/${dec(m[3]!)}#${m[4]}`, type: 'pr', n: Number(m[4]), url: true }
  m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(s)
  if (m) return { scope: `Azure DevOps work item ${dec(m[1]!)}/${dec(m[2]!)}#${m[3]}`, type: 'workitem', n: Number(m[3]), url: true }
  m = /^https?:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_workitems\/edit\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(s)
  if (m) return { scope: `Azure DevOps work item ${dec(m[1]!)}/${dec(m[2]!)}#${m[3]}`, type: 'workitem', n: Number(m[3]), url: true }
  return null
}
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
// the thread's project remote (the registry's folder of its project, `git remote get-url origin`)
async function remoteOf(h: Host, thread: string): Promise<PrHost | string> {
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

// what the model proposed -> the exact target (never invented: a number alone is read against the thread's own project remote)
export async function resolveTarget(h: Host, thread: string, t: unknown): Promise<{ ok: true; target: Target; viaRemote: boolean } | { ok: false; text: string }> {
  const x = t && typeof t === 'object' && !Array.isArray(t) ? (t as TargetIn) : null
  const keys = x ? Object.keys(x).filter(k => (x as Record<string, unknown>)[k] !== undefined && (x as Record<string, unknown>)[k] !== null && (x as Record<string, unknown>)[k] !== '') : []
  if (!x || keys.length !== 1 || (keys[0] !== 'pr' && keys[0] !== 'workitem')) return { ok: false, text: 'allow-writes needs target: {pr: <number or URL>} or {workitem: <id>} (exactly one)' }
  const type = keys[0] as 'pr' | 'workitem'
  const raw = x[type]
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
    const u = scopeOfUrl(raw)
    if (!u || u.type !== type) return { ok: false, text: `${raw.slice(0, 100)} is not the URL of a ${type === 'pr' ? 'GitHub or Azure DevOps PR' : 'Azure DevOps work item'}` }
    return { ok: true, target: u, viaRemote: false }
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
const tokenRe = (n: number) => new RegExp(`(?<!\\d)(?<!\\d[.,])${n}(?!\\d)(?![.,]\\d)`, 'g')
const OWN: Record<Target['type'], RegExp> = { pr: /(?:\bpr|\bpull(?:\s*request)?|!)\s*#?\s*$/i, workitem: /(?:work\s*item|\bwi|\bticket|\btask|\bbug|\bstory)\s*#?\s*$/i }
export function namesTarget(text: string, target: Target, remoteScope: string | null): boolean {
  for (const u of text.match(/https?:\/\/[^\s<>"']+/g) ?? []) if (scopeOfUrl(u) && lc(scopeOfUrl(u)!.scope) === lc(target.scope)) return true
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

export async function allowWrites(h: Host, thread: string, target: unknown, kinds?: unknown): Promise<{ ok: boolean; text: string }> {
  if (!threadOk(thread)) return { ok: false, text: 'allow-writes needs tN (the thread the writes are for)' }
  const t = await readJson<{ state?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, null).catch(() => null)
  if (!t) return { ok: false, text: `no thread ${thread}` }
  if (t.state === 'closed') return { ok: false, text: `${thread} is closed` }
  const res = await resolveTarget(h, thread, target)
  if (!res.ok) return { ok: false, text: res.text }
  const { target: tg } = res
  const allowed = tg.type === 'pr' ? PR_KINDS : WI_KINDS
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
  const hit = [...prompts].reverse().find(p => namesTarget(p.text, tg, remoteScope) && instructionIn(p.text))
  if (!hit) return { ok: false, text: `no written instruction from the user covers ${label}: ask with AskUserQuestion (the user's own typed words of the last 24 h must name the PR or work item and ask for the work, like "fix the comments on PR 42"), or ask the user to type /lean-agent:allow ${thread} <PR or work item>. Nothing was created` }
  const cap = await capOf(h)
  return exclusive(async () => {
    const now = await h.clock.now()
    const base = { id: `w${now}-${++wseq}`, thread, scope: tg.scope, kinds: want, quote: quoteOf(hit.text), qts: hit.ts, cap, used: 0, ts: now, exp: now + WRITES_TTL_MS }
    const g = await resign(h, base)
    if (!g) return { ok: false, text: 'no key to sign the grant with' }
    const keep = (await grantRows(h, now)).filter(x => !(x.thread === thread && lc(x.scope) === lc(tg.scope)))
    await saveGrants(h, [...keep, g])
    await logHistory(h, thread, { kind: 'writes-granted', id: g.id, scope: g.scope, kinds: want, quote: g.quote, cap, hours: 24 })
    return { ok: true, text: `allowed ${thread} on ${label}: ${want.join(', ')} (up to ${cap} writes, 24 h or until ${thread} closes), resting on your words "${g.quote}". Revoke: the pane's Revoke button, /lean-agent:revoke ${thread}, or say "stop writes". Tell the user this in one line` }
  })
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
  const g = grants.find(x => lc(x.scope) === lc(targetOf(first.kind, first.params)))
  if (!g) return null
  for (const it of items) {
    const gk = GRANT_KIND[it.kind]
    if (!gk || !g.kinds.includes(gk) || lc(targetOf(it.kind, it.params)) !== lc(g.scope)) return null // a push, a delete, any other kind or another target: always asked
    if (it.kind === 'gh-pr-thread-resolve' && !(await verifyThread(h, String(it.params.repo), Number(it.params.pr), String(it.params.thread)))) return null
  }
  const writes = plan.steps?.length ?? 1
  return g.used + writes <= g.cap ? { g, writes } : null
}

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
  const sent = (Array.isArray(raw) ? (raw as WSent[]) : []).filter(s => s && typeof s.text === 'string' && Number.isFinite(s.ts) && now - s.ts <= SENT_SHOWN_MS).map(s => ({ ts: s.ts, thread: String(s.thread), text: s.text, ...(s.grant && active.has(s.grant) ? { grant: s.grant } : {}) }))
  return { grants: grants.map(g => ({ id: g.id, thread: g.thread, scope: g.scope, kinds: g.kinds, quote: g.quote, used: g.used, cap: g.cap, exp: g.exp })), sent }
}
export async function writesListText(h: Host): Promise<string> {
  const v = await writesView(h)
  if (!v.grants.length) return ''
  return `\nthe user's written instructions (a request they cover is sent by the mod at once: do not ask the user again; anything else is asked):${v.grants.map(g => `\n  ${g.id} · ${g.thread} · ${g.scope} · ${g.kinds.join(', ')} · ${g.used}/${g.cap} writes · until ${new Date(g.exp).toISOString().slice(0, 16).replace('T', ' ')} UTC (or the thread closes) · "${g.quote.slice(0, 80)}"`).join('')}`
}

// ---- revoking only takes power away ----------------------------------------------------------------------------------------------------------------
export async function revokeWrites(h: Host, by: { id?: string; thread?: string; all?: boolean; scopeEnds?: string[] }, who = 'user, in the pane'): Promise<{ ok: boolean; text: string; n: number }> {
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
  if (!named) n += (await revokeWrites(h, { all: true }, 'user, typed words')).n
  else {
    for (const t of threads) n += (await revokeWrites(h, { thread: t }, 'user, typed words')).n
    if (nums.length) n += (await revokeWrites(h, { scopeEnds: nums }, 'user, typed words')).n
  }
  const st = await standingView(h).catch(() => null)
  for (const g of st?.grants ?? []) if (!named || threads.includes(g.thread) || nums.some(x => g.scope.endsWith(x))) if ((await revokeGrant(h, g.id)).ok) n++
  return n
}
