// Typed remote writes a thread needs and may not make itself, performed by the DESK-SIDE MOD after the HUMAN said yes.
//
// Why: Claude Code's own permission check (or the auto-mode classifier) denies a thread's remote write (a PR comment, a work item update),
// and no hook can carry a desk yes past that verdict (see the changelog of 1.0.14). So the pattern that already works for pushes is used:
// the thread asks, the user decides in the desk, and the mod itself runs the approved write (argv, never a shell, never a model, never the
// thread's Bash). No model ever bypasses a permission check, and nothing but the kinds below can be asked for (a `batch` of up to 10 of them for one PR or work item is one request, one approval).
//
// The flow, and what makes it model-proof:
//   1. The thread calls `lean_report` with `action: {kind, params, why}`. `addActionRequest` checks it against the fixed table (an unknown
//      kind is refused with the list), renders EXACTLY what will be sent (method, URL, body) and stores the request, signed (HMAC with the
//      mod's own key, like reviews.ts / expensive.ts), with a sha256 of that rendering.
//   2. The desk asks the user with AskUserQuestion (the question names the request id, the check code and the exact text; the options are
//      Approve / Deny / Edit first). `bindAnswers` reads the human's answer from the TOOL RESULT (`tool_response.answers` as the engine
//      types it), in the desk's own `tool.call` hook, and records it only when the question the human really saw named that request, its
//      check code and its exact text, and the answer is one of the three labels. The pane's Approve / Deny presses are the same decision
//      (`answerAction` with by: 'pane'). Nothing else writes an answer, and a spec reads the sources to keep it so.
//   3. The desk calls `lean_thread approve-action <id>`: refused unless a signed human Approve for THAT request id and rendering is on
//      record, the request is unexpired (2 h) and unused. The rendering is derived again from the params and its hash compared right before
//      sending. Single use: the request is used once the write went out. A failing executor leaves it unused and says why.
//   4. The mod sends, records the result (id / URL, never the token) in the thread's history.jsonl and tells the thread, so it goes on.
//
// Never grantable this way: pushes, tags, releases (the push gate), merges, deletes, permission or settings changes, anything outside the
// table. The token of Azure DevOps goes to curl on STDIN only (a curl config), never in an argument list, a log or an output.
import { appendJsonl, homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { macOf } from './reviews'
import { sha256 } from './sha'
import { azureToken, oneLine } from './prhost'
import { holdCovered } from './sendhold'

export const ACTION_TTL_MS = 2 * 60 * 60 * 1000
export const ACTIONS_MAX = 40 // requests kept in the store
export const PENDING_MAX = 5 // open requests one thread may have at a time
export const BODY_MAX = 10_000
export const FIELD_MAX = 200

// ---- the table: the ONLY kinds, with the params each takes ---------------------------------------------------------------------------
export type ActionKind = 'ado-pr-reply' | 'ado-pr-thread-status' | 'ado-pr-comment' | 'ado-workitem-comment' | 'ado-workitem-update' | 'gh-pr-comment' | 'gh-pr-thread-resolve' | 'batch'
export const BATCH_MAX = 10
// the thread statuses a PR thread may be set to: what the thread says -> the REST value of PATCH .../threads/<id>
export const THREAD_STATUS: Record<string, string> = { active: 'active', fixed: 'fixed', wontfix: 'wontFix', closed: 'closed', bydesign: 'byDesign', pending: 'pending' }
export const STATUS_NAMES = Object.values(THREAD_STATUS).join(', ')
export const ACTION_KINDS: Record<ActionKind, string> = {
  'ado-pr-reply': `org, project, repo, pr, thread, body, optional status (${STATUS_NAMES}: the desk then sets the thread's status, after the reply)`,
  'ado-pr-thread-status': `org, project, repo, pr, thread, status (${STATUS_NAMES})`,
  'ado-pr-comment': 'org, project, repo, pr, body',
  'ado-workitem-comment': 'org, project, id, body',
  'ado-workitem-update': 'org, project, id, fields (state, assignedTo, tags, title; strings)',
  'gh-pr-comment': 'repo (owner/name), pr, body',
  'gh-pr-thread-resolve': 'repo (owner/name), pr, thread (the review thread node id, like PRRT_...)',
  batch: `items: up to ${BATCH_MAX} {kind, params} of the kinds above (not batch) for ONE PR or ONE work item (same org, project, repo, pr, or the same work item); one approval covers the list, run in order, stopped at the first failure`,
}
const PARAM_KEYS: Record<ActionKind, string[]> = {
  'ado-pr-reply': ['org', 'project', 'repo', 'pr', 'thread', 'body', 'status'],
  'ado-pr-thread-status': ['org', 'project', 'repo', 'pr', 'thread', 'status'],
  'ado-pr-comment': ['org', 'project', 'repo', 'pr', 'body'],
  'ado-workitem-comment': ['org', 'project', 'id', 'body'],
  'ado-workitem-update': ['org', 'project', 'id', 'fields'],
  'gh-pr-comment': ['repo', 'pr', 'body'],
  'gh-pr-thread-resolve': ['repo', 'pr', 'thread'],
  'batch': ['items'],
}
export const isKind = (k: unknown): k is ActionKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ACTION_KINDS, k)
export const kindsText = (): string => Object.entries(ACTION_KINDS).map(([k, p]) => `${k} {${p}}`).join('; ')
export const FIELD_NAMES: Record<string, string> = { state: 'System.State', assignedTo: 'System.AssignedTo', tags: 'System.Tags', title: 'System.Title' }

// what is sent: tool 'azure' = curl with a bearer token, 'github' = gh api
// `steps` (a batch, or a reply with a status): the writes the mod makes in order, flat, each with its tag ("1", "2 reply", "2 status"); the hash covers all of them
export type Plan = { tool: 'azure' | 'github'; method: 'POST' | 'PATCH'; url: string; contentType: string; body: string; headline: string; text: string; tag?: string; steps?: Plan[] }
export type Params = Record<string, unknown>
type Checked = { ok: true; kind: ActionKind; params: Params; plan: Plan } | { ok: false; text: string }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/ // control, zero-width and bidi characters: what the user reads is what is sent
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/
const GH_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/
const GH_THREAD = /^[A-Za-z0-9_=-]{8,100}$/
const enc = encodeURIComponent
const refuse = (text: string): Checked => ({ ok: false, text })
const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const hashOf = (s: string): string => hex(sha256(new TextEncoder().encode(s)))
// the text the hash covers: everything that decides what is sent and where
export const renderingOf = (p: Pick<Plan, 'method' | 'url' | 'contentType' | 'body' | 'steps'>): string =>
  p.steps ? p.steps.map((s, i) => `#${i + 1}/${p.steps!.length}\n${renderingOf(s)}`).join('\n---\n') : `${p.method} ${p.url}\n${p.contentType}\n${p.body}`

const int = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e9 ? n : null
}

// the table's one door: a kind, exactly its params (no others), every value checked; the plan is what the mod will send
export function checkAction(a: unknown): Checked {
  const x = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : null
  const kind = typeof x?.kind === 'string' ? x.kind.trim() : ''
  if (!x || !isKind(kind)) return refuse(`action kind ${kind ? `"${kind.slice(0, 40)}" ` : ''}is not one the desk can send for a thread. The kinds: ${kindsText()}. Anything else (a push, a merge, a delete, a settings change, any command) is not asked for this way`)
  const k = kind
  if (k === 'batch') return checkBatch(x)
  const p = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? (x.params as Params) : null
  if (!p) return refuse(`action ${k} needs params {${ACTION_KINDS[k]}}`)
  for (const key of Object.keys(p)) if (!PARAM_KEYS[k].includes(key)) return refuse(`action ${k}: unknown param "${key.slice(0, 30)}" (params: ${ACTION_KINDS[k]})`)
  const name = (key: string): string | null => {
    const v = typeof p[key] === 'string' ? (p[key] as string).trim() : ''
    return NAME.test(v) ? v : null
  }
  const num = (key: string): number | null => int(p[key])
  const bodyOf = (): string | null => {
    const v = typeof p.body === 'string' ? p.body.replace(/\r\n?/g, '\n') : ''
    return v.trim() && v.length <= BODY_MAX && !CONTROL.test(v.replace(/[\n\t]/g, '')) ? v : null
  }
  const bad = (what: string): Checked => refuse(`action ${k}: ${what} (params: ${ACTION_KINDS[k]}; names are letters, digits, space . _ ( ) -; numbers are positive whole numbers; body is non-empty text of at most ${BODY_MAX} characters)`)
  const params: Params = {}
  const azure = (): { org: string; project: string; base: string } | null => {
    const org = name('org')
    const project = name('project')
    if (!org || !project) return null
    params.org = org
    params.project = project
    return { org, project, base: `https://dev.azure.com/${enc(org)}/${enc(project)}` }
  }
  const json = (v: unknown) => JSON.stringify(v)
  if (k === 'gh-pr-comment') {
    const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
    const pr = num('pr')
    const body = bodyOf()
    if (!GH_REPO.test(repo) || pr === null || body === null) return bad('repo must be owner/name, pr a number and body text')
    params.repo = repo
    params.pr = pr
    params.body = body
    return { ok: true, kind: k, params, plan: { tool: 'github', method: 'POST', url: `https://api.github.com/repos/${repo}/issues/${pr}/comments`, contentType: 'application/json', body: json({ body }), headline: `comment on GitHub PR ${repo}#${pr}`, text: body } }
  }
  if (k === 'gh-pr-thread-resolve') {
    const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
    const pr = num('pr')
    const thread = typeof p.thread === 'string' ? p.thread.trim() : ''
    if (!GH_REPO.test(repo) || pr === null || !GH_THREAD.test(thread)) return bad('repo must be owner/name, pr a number and thread the review thread node id (like PRRT_...)')
    params.repo = repo
    params.pr = pr
    params.thread = thread
    const text = `resolve review thread ${thread} of PR ${repo}#${pr}`
    const query = 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }'
    return { ok: true, kind: k, params, plan: { tool: 'github', method: 'POST', url: 'https://api.github.com/graphql', contentType: 'application/json', body: json({ query, variables: { id: thread } }), headline: `resolve a review thread on GitHub PR ${repo}#${pr}`, text } }
  }
  const az = azure()
  if (!az) return bad('org and project are required names')
  if (k === 'ado-workitem-comment' || k === 'ado-workitem-update') {
    const id = num('id')
    if (id === null) return bad('id must be a work item number')
    params.id = id
    if (k === 'ado-workitem-comment') {
      const body = bodyOf()
      if (body === null) return bad('body must be text')
      params.body = body
      return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'POST', url: `${az.base}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`, contentType: 'application/json', body: json({ text: body }), headline: `comment on work item ${id} (${az.org}/${az.project})`, text: body } }
    }
    const f = p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields) ? (p.fields as Record<string, unknown>) : null
    const names = f ? Object.keys(f) : []
    if (!f || !names.length) return bad(`fields must name at least one of ${Object.keys(FIELD_NAMES).join(', ')}`)
    const unknown = names.filter(n => !Object.prototype.hasOwnProperty.call(FIELD_NAMES, n))
    if (unknown.length) return refuse(`action ${k}: field "${unknown[0]!.slice(0, 30)}" is not allowed (only ${Object.keys(FIELD_NAMES).join(', ')})`)
    const fields: Record<string, string> = {}
    for (const n of Object.keys(FIELD_NAMES)) {
      if (!(n in f)) continue
      const v = typeof f[n] === 'string' ? (f[n] as string).trim() : ''
      if (!v || v.length > FIELD_MAX || CONTROL.test(v)) return bad(`field ${n} must be a non-empty string of at most ${FIELD_MAX} characters`)
      fields[n] = v
    }
    params.fields = fields
    const ops = Object.entries(fields).map(([n, value]) => ({ op: 'add', path: `/fields/${FIELD_NAMES[n]}`, value }))
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PATCH', url: `${az.base}/_apis/wit/workitems/${id}?api-version=7.1`, contentType: 'application/json-patch+json', body: json(ops), headline: `update work item ${id} (${az.org}/${az.project})`, text: Object.entries(fields).map(([n, v]) => `${n}: ${v}`).join('\n') } }
  }
  const repo = name('repo')
  const pr = num('pr')
  const body = k === 'ado-pr-thread-status' ? '' : bodyOf()
  if (!repo || pr === null || body === null) return bad('repo must be a repository name, pr a number and body text')
  params.repo = repo
  params.pr = pr
  const where = `${az.org}/${az.project}/${repo}`
  const prs = `${az.base}/_apis/git/repositories/${enc(repo)}/pullRequests/${pr}`
  if (k === 'ado-pr-reply' || k === 'ado-pr-thread-status') {
    const thread = num('thread')
    if (thread === null) return bad('thread must be a PR thread number')
    params.thread = thread
    const raw = typeof p.status === 'string' ? p.status.trim().toLowerCase() : p.status === undefined ? '' : null
    const status = raw ? THREAD_STATUS[raw] : undefined
    if (raw === null || (raw && !status) || (k === 'ado-pr-thread-status' && !status)) return bad(`status must be one of ${STATUS_NAMES}`)
    if (status) params.status = status
    const setStatus: Plan | null = status ? { tool: 'azure', method: 'PATCH', url: `${prs}/threads/${thread}?api-version=7.1`, contentType: 'application/json', body: json({ status }), headline: `set thread ${thread} of PR ${pr} to ${status} (${where})`, text: `set thread ${thread} of PR ${pr} to ${status}`, tag: 'status' } : null
    if (k === 'ado-pr-thread-status') return { ok: true, kind: k, params, plan: setStatus! }
    params.body = body
    const reply: Plan = { tool: 'azure', method: 'POST', url: `${prs}/threads/${thread}/comments?api-version=7.1`, contentType: 'application/json', body: json({ content: body, parentCommentId: 1, commentType: 1 }), headline: `reply to PR thread ${thread} on PR ${pr} (${where})`, text: body, tag: 'reply' }
    if (!setStatus) return { ok: true, kind: k, params, plan: reply }
    const steps = [reply, setStatus]
    return { ok: true, kind: k, params, plan: { ...reply, url: steps.map(s => s.url).join(' ; '), headline: `reply to PR thread ${thread} on PR ${pr} and then set the thread to ${status} (${where})`, text: `${body}\n\nthen set the thread to ${status}`, tag: undefined, steps } }
  }
  params.body = body
  return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'POST', url: `${prs}/threads?api-version=7.1`, contentType: 'application/json', body: json({ comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 }), headline: `post a new comment on PR ${pr} (${where})`, text: body } }
}

// a batch: up to BATCH_MAX checked items for ONE target; the plan holds every write flat and in order, numbered by item
export const targetOf = (kind: ActionKind, p: Params): string =>
  kind.startsWith('ado-workitem') ? `Azure DevOps work item ${p.org}/${p.project}#${p.id}` : kind.startsWith('ado-pr') ? `Azure DevOps PR ${p.org}/${p.project}/${p.repo}#${p.pr}` : `GitHub PR ${p.repo}#${p.pr}`
function checkBatch(x: Record<string, unknown>): Checked {
  const p = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? (x.params as Params) : null
  if (p) for (const key of Object.keys(p)) if (key !== 'items') return refuse(`action batch: unknown param "${key.slice(0, 30)}" (the batch takes items)`)
  const items = Array.isArray(x.items) ? x.items : p && Array.isArray(p.items) ? p.items : null
  if (!items || !items.length) return refuse(`action batch needs items: [{kind, params}, ...] (1 to ${BATCH_MAX}, of the other kinds: ${kindsText()})`)
  if (items.length > BATCH_MAX) return refuse(`action batch holds at most ${BATCH_MAX} items (got ${items.length}): split it in two requests`)
  const checked: Extract<Checked, { ok: true }>[] = []
  for (const [i, it] of items.entries()) {
    const kind = it && typeof it === 'object' ? (it as { kind?: unknown }).kind : undefined
    if (kind === 'batch') return refuse(`batch item ${i + 1}: a batch cannot hold a batch`)
    const c = checkAction(it)
    if (!c.ok) return refuse(`batch item ${i + 1}: ${c.text}`)
    checked.push(c)
  }
  const target = targetOf(checked[0]!.kind, checked[0]!.params)
  for (const [i, c] of checked.entries()) {
    const t = targetOf(c.kind, c.params)
    if (t !== target) return refuse(`batch item ${i + 1} is for another target (${t}; item 1 is ${target}): one batch is for ONE PR or ONE work item, make a second request`)
  }
  const steps: Plan[] = checked.flatMap((c, i) => (c.plan.steps ?? [c.plan]).map(s => ({ ...s, tag: c.plan.steps ? `${i + 1} ${s.tag}` : `${i + 1}` })))
  const n = checked.length
  const text = checked.map((c, i) => `${i + 1}/${n} ${c.plan.headline}\n${c.plan.text}\n→ ${(c.plan.steps ?? [c.plan]).map(s => `${s.method} ${s.url}`).join(' ; ')}`).join('\n\n')
  return {
    ok: true,
    kind: 'batch',
    params: { items: checked.map(c => ({ kind: c.kind, params: c.params })) },
    plan: { ...steps[0]!, url: steps.map(s => s.url).join(' ; '), headline: `do ${n} write${n === 1 ? '' : 's'} on ${target}, in this order`, text, tag: undefined, steps },
  }
}

// ---- the stored request ---------------------------------------------------------------------------------------------------------------
export type ActionRequest = { id: string; thread: string; kind: ActionKind; params: Params; why: string; hash: string; ts: number; exp: number; sig: string }
type Answer = { id: string; hash: string; answer: 'approve' | 'deny' | 'edit'; by: 'ask' | 'pane' | 'standing'; ts: number; sig: string }
export type ActionState = 'pending' | 'approved' | 'denied' | 'edit' | 'used' | 'expired'
// a request as the desk and the pane see it (never carries a signature)
export type ActionView = { id: string; thread: string; kind: ActionKind; why: string; headline: string; text: string; target: string; hash: string; ts: number; exp: number; state: ActionState; writes?: number /* a batch or a reply with a status: how many writes one Approve covers */; standing?: boolean /* a status change that may carry the third choice (standing approval for this PR) */ }

// ---- standing approval: ONLY a status change carries it (never text) ------------------------------------------------------------------------
// The kinds and statuses that can be covered: a thread status to fixed / closed / active, a GitHub review thread resolved. Never a reply, a comment, a
// work item update or any other status; a batch is covered only when EVERY item is one of these and covered.
// Only the Azure DevOps status change: its PR is part of the write's URL, so the scope a grant names is the scope that is written. A GitHub
// review-thread resolve carries only the thread's node id (the PR it names cannot be checked from the request), so it is always asked.
export const STANDING_KINDS: ActionKind[] = ['ado-pr-thread-status']
export const STANDING_STATUSES = ['fixed', 'closed', 'active']
export const STANDING_TTL_MS = 24 * 60 * 60 * 1000
export const STANDING_LABEL = 'Approve, and allow status changes on this PR for 24 h'
export const standingEligible = (kind: ActionKind, p: Params): boolean => kind === 'ado-pr-thread-status' && STANDING_STATUSES.includes(String(p.status))

const REQUESTS = 'action.requests'
export const answerKey = (id: string) => `action.answer.${id}`
const usedKey = (id: string) => `action.used.${id}`
const sigText = (r: Pick<ActionRequest, 'id' | 'thread' | 'kind' | 'hash' | 'ts' | 'exp'>) => `desk-action\n${r.id}\n${r.thread}\n${r.kind}\n${r.hash}\n${r.ts}\n${r.exp}`
export const answerText = (a: Pick<Answer, 'id' | 'hash' | 'answer' | 'ts'>) => `desk-action-answer\n${a.id}\n${a.hash}\n${a.answer}\n${a.ts}`
const idOk = (s: unknown): s is string => typeof s === 'string' && /^a\d{1,16}-\d{1,9}$/.test(s)
export const threadOk = (s: unknown): s is string => typeof s === 'string' && /^t\d{1,9}$/.test(s)
let seq = 0

let gate: Promise<unknown> = Promise.resolve()
export const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
  const r = gate.then(f, f)
  gate = r.catch(() => undefined)
  return r
}
const inflight = new Set<string>() // ids being sent right now (this process): a second approve-action never sends twice
export const resetActions = () => {
  inflight.clear()
  seq = 0
}

export async function rows(h: Host): Promise<ActionRequest[]> {
  const v = await h.store.get(REQUESTS).catch(() => null)
  return (Array.isArray(v) ? v : []).filter((r): r is ActionRequest => !!r && idOk(r.id) && threadOk(r.thread) && isKind(r.kind) && typeof r.hash === 'string' && typeof r.sig === 'string' && Number.isFinite(r.ts) && Number.isFinite(r.exp) && !!r.params && typeof r.params === 'object')
}
const save = (h: Host, all: ActionRequest[]) => h.store.set(REQUESTS, all.slice(-ACTIONS_MAX))

// the request's own checks: signed by this mod, and what it would send is still exactly what was hashed. A plan is returned only for a sound request.
export async function sound(h: Host, r: ActionRequest): Promise<Plan | null> {
  const want = await macOf(h, sigText(r), false)
  if (!want || want.length !== r.sig.length || want !== r.sig) return null
  const c = checkAction({ kind: r.kind, params: r.params })
  if (!c.ok || hashOf(renderingOf(c.plan)) !== r.hash) return null
  return c.plan
}
async function answerOf(h: Host, r: ActionRequest): Promise<Answer | null> {
  const a = (await h.store.get(answerKey(r.id)).catch(() => null)) as Answer | null
  if (!a || typeof a !== 'object' || a.id !== r.id || a.hash !== r.hash || !['approve', 'deny', 'edit'].includes(a.answer) || typeof a.sig !== 'string' || !Number.isFinite(a.ts)) return null
  const want = await macOf(h, answerText(a), false)
  return want && want.length === a.sig.length && want === a.sig && a.ts >= r.ts ? a : null
}
// used = the store holds the time it was sent; an unreadable store counts as used (never sent twice on a guess)
const usedOf = async (h: Host, id: string): Promise<boolean> => typeof (await h.store.get(usedKey(id)).catch(() => 1)) === 'number'

export async function stateOf(h: Host, r: ActionRequest, now: number): Promise<ActionState> {
  if (await usedOf(h, r.id)) return 'used'
  const a = await answerOf(h, r)
  if (a?.answer === 'deny') return 'denied'
  if (a?.answer === 'edit') return 'edit'
  if (now > r.exp) return 'expired'
  return a ? 'approved' : 'pending'
}

const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
export async function viewOf(h: Host, r: ActionRequest, now: number): Promise<ActionView | null> {
  const plan = await sound(h, r)
  if (!plan) return null
  return { id: r.id, thread: r.thread, kind: r.kind, why: r.why, headline: plan.headline, text: plan.text, target: plan.url, hash: r.hash, ts: r.ts, exp: r.exp, state: await stateOf(h, r, now), ...(plan.steps ? { writes: plan.steps.length } : {}), ...(standingEligible(r.kind, r.params) ? { standing: true } : {}) }
}
// the requests that are not finished (the desk's list and the pane): pending, approved but not sent yet, and expired ones until they are told
export async function listActions(h: Host, all = false): Promise<ActionView[]> {
  const now = await h.clock.now()
  const out: ActionView[] = []
  for (const r of await rows(h)) {
    const v = await viewOf(h, r, now)
    if (v && (all || v.state === 'pending' || v.state === 'approved')) out.push(v)
  }
  return out
}

// ---- what the user is asked, word for word -----------------------------------------------------------------------------------------------
export const OPTION_LABELS = ['Approve', 'Deny', 'Edit first'] as const
export const checkCode = (hash: string): string => hash.slice(0, 12)
export function questionOf(v: Pick<ActionView, 'id' | 'thread' | 'headline' | 'text' | 'target' | 'hash'> & { writes?: number; standing?: boolean }): { question: string; options: { label: string; description: string }[] } {
  const standing = v.standing ? [{ label: STANDING_LABEL, description: `the desk sends exactly this text, once; and ${v.thread}'s later status changes on this PR (fixed, closed, active) are sent without asking, for 24 h or until it closes (never a reply or any text)` }] : []
  return {
    question: `${v.thread} wants to ${v.headline} [request ${v.id}, check ${checkCode(v.hash)}]. The exact text that will be sent:\n---\n${v.text}\n---\nTarget: ${v.target}\nSend exactly this?`,
    options: [
      { label: 'Approve', description: v.writes && v.writes > 1 ? `the desk sends exactly these ${v.writes} writes, in this order, once; it stops at the first failure` : 'the desk sends exactly this text, once' },
      { label: 'Deny', description: `${v.thread} is told it was denied and goes on without it` },
      { label: 'Edit first', description: `nothing is sent; tell ${v.thread} what to change, it sends a NEW request` },
      ...standing,
    ],
  }
}

export const logHistory = async (h: Host, thread: string, rec: Record<string, unknown>): Promise<void> => {
  const home = await homeDir(h)
  await appendJsonl(h, `${threadsDir(home)}/${thread}/history.jsonl`, { ts: await h.clock.now(), ...rec }).catch(() => undefined)
}
export type Tell = (thread: string, text: string) => Promise<void>

// ---- a thread asks ---------------------------------------------------------------------------------------------------------------------------
export async function addActionRequest(h: Host, thread: string, a: { kind?: unknown; params?: unknown; items?: unknown; why?: unknown }): Promise<{ ok: boolean; text: string; request?: ActionView }> {
  if (!threadOk(thread)) return { ok: false, text: 'an action request comes from a thread (tN)' }
  const c = checkAction(a)
  if (!c.ok) return { ok: false, text: c.text }
  const hash = hashOf(renderingOf(c.plan))
  const why = (typeof a.why === 'string' ? a.why : '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return exclusive(async () => {
    const ts = await h.clock.now()
    const all = await rows(h)
    // the very same request again is the one that is there (a thread that reports twice); a denied or sent one is not asked a second time
    for (const r of all) {
      if (r.thread !== thread || r.hash !== hash || ts > r.exp) continue
      const st = await stateOf(h, r, ts)
      const v = await viewOf(h, r, ts)
      if (!v) continue
      if (st === 'pending' || st === 'approved') return { ok: true, text: `request ${r.id} is already waiting for the user (${st})`, request: v }
      if (st === 'denied') return { ok: false, text: `the user denied exactly this text (request ${r.id}): ${thread} goes on without it and reports blocked only if it cannot` }
      if (st === 'used') return { ok: false, text: `this exact text was already sent (request ${r.id})` }
    }
    let open = 0
    for (const r of all) if (r.thread === thread && ts <= r.exp && ['pending', 'approved'].includes(await stateOf(h, r, ts))) open++
    if (open >= PENDING_MAX) return { ok: false, text: `${thread} already has ${open} requests waiting for the user: wait for them` }
    const base = { id: `a${ts}-${++seq}`, thread, kind: c.kind, hash, ts, exp: ts + ACTION_TTL_MS }
    const sig = await macOf(h, sigText(base), true)
    if (!sig) return { ok: false, text: 'no key to sign the request with' }
    const rec: ActionRequest = { ...base, params: c.params, why, sig }
    await save(h, [...all, rec])
    await logHistory(h, thread, { kind: 'action-request', id: rec.id, action: rec.kind, hash: checkCode(hash), target: c.plan.url, why: why || undefined })
    const v = (await viewOf(h, rec, ts))!
    return { ok: true, text: `request ${rec.id} (${c.plan.headline}) is waiting for the user's yes at the desk`, request: v }
  })
}

// ---- the human's answer ---------------------------------------------------------------------------------------------------------------------
// ONLY bindAnswers (the desk's AskUserQuestion result) and answerAction (the pane's press) write an answer. First answer wins.
export async function answerAction(h: Host, id: string, answer: 'approve' | 'deny' | 'edit', by: 'ask' | 'pane', tell?: Tell, standing = false): Promise<{ ok: boolean; text: string }> {
  const rec = await exclusive(async () => {
    const r = (await rows(h)).find(x => x.id === id)
    if (!r) return { ok: false as const, text: `no request ${id}` }
    const now = await h.clock.now()
    if (!(await sound(h, r))) return { ok: false as const, text: `request ${id} does not verify (not signed by this mod, or its text changed): refused` }
    const st = await stateOf(h, r, now)
    if (st !== 'pending') return { ok: false as const, text: `request ${id} is ${st}: no answer recorded` }
    if (standing && (answer !== 'approve' || !standingEligible(r.kind, r.params))) return { ok: false as const, text: `request ${id} cannot carry a standing approval (only a thread status change to fixed, closed or active, or resolving a GitHub review thread): no answer recorded` }
    const base = { id: r.id, hash: r.hash, answer, by, ts: now }
    const sig = await macOf(h, answerText(base), true)
    if (!sig) return { ok: false as const, text: 'no key to sign the answer with' }
    await h.store.set(answerKey(r.id), { ...base, sig } satisfies Answer)
    if (standing && !(await writeGrant(h, r, now))) return { ok: true as const, r, noGrant: true }
    return { ok: true as const, r }
  })
  if (!rec.ok) return rec
  const { r } = rec
  await logHistory(h, r.thread, { kind: `action-${answer}`, id, action: r.kind, hash: checkCode(r.hash), by: by === 'pane' ? 'user, in the pane' : 'user, asked by the desk' })
  if (standing && !('noGrant' in rec)) await logHistory(h, r.thread, { kind: 'standing-grant', id, action: r.kind, scope: targetOf(r.kind, r.params), statuses: r.kind === 'gh-pr-thread-resolve' ? undefined : STANDING_STATUSES, by: by === 'pane' ? 'user, in the pane' : 'user, asked by the desk', hours: 24 })
  if (answer === 'deny' && tell) await tell(r.thread, `The user denied your request ${id} (${r.kind}): nothing was sent. Denied: report blocked if you cannot go on, or continue without it. Do not send the same text again.`).catch(() => undefined)
  return { ok: true, text: answer === 'approve' ? `the user approved ${id}${standing ? ` and allowed status changes of ${r.thread} on this PR for 24 h (or until it closes)` : ''}: call lean_thread approve-action ${id} to send it` : answer === 'deny' ? `the user denied ${id}; ${r.thread} was told` : `the user wants to edit ${id} first: nothing is sent; ask what to change, then tell ${r.thread} (send) to make a NEW request with the changed text` }
}

const LABEL: Record<string, 'approve' | 'deny' | 'edit' | 'approve-standing'> = { Approve: 'approve', Deny: 'deny', 'Edit first': 'edit', [STANDING_LABEL]: 'approve-standing' }
type Q = { question?: unknown; options?: unknown }
// The desk's AskUserQuestion, after the user answered it: `questions` is what was asked, `answers` the tool result's (question text -> the
// label chosen). An answer is recorded only for a question that names exactly ONE pending request, with its id, its check code and its exact
// text, and offers the three labels; the answer must be one of the labels. Returns the lines to hand to the desk (what to do next).
export async function bindAnswers(h: Host, questions: unknown, answers: unknown, tell?: Tell): Promise<string[]> {
  const qs: Q[] = Array.isArray(questions) ? (questions as Q[]) : []
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : null
  const notes: string[] = []
  const now = await h.clock.now()
  const all = await rows(h)
  for (const q of qs) {
    const text = typeof q?.question === 'string' ? q.question : ''
    const ids = [...new Set([...text.matchAll(/\ba\d{1,16}-\d{1,9}\b/g)].map(m => m[0]))].filter(id => all.some(r => r.id === id))
    if (ids.length !== 1) continue // not about a request, or about several: nothing is bound
    const r = all.find(x => x.id === ids[0])!
    if (!given) {
      notes.push(`the answer to the question about ${r.id} could not be read by the mod: ask the user to press Approve or Deny on its card in the pane`)
      continue
    }
    const a = typeof given[text] === 'string' ? (given[text] as string).trim() : ''
    const answer = Object.prototype.hasOwnProperty.call(LABEL, a) ? LABEL[a] : undefined
    if (!answer) continue // free text, no choice: nothing is decided by it
    const v = await viewOf(h, r, now)
    // the question must be the canonical one (questionOf): the desk model may not frame the text or the options differently
    const canon = v ? questionOf(v) : null
    const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
    const sameOptions = !!canon && opts.length === canon.options.length && canon.options.every((c, i) => opts[i]?.label === c.label && opts[i]?.description === c.description)
    if (!v || !canon || v.state !== 'pending' || text !== canon.question || !sameOptions || (q as { multiSelect?: unknown }).multiSelect === true) {
      notes.push(`the answer to the question about ${r.id} was NOT recorded: the question the user saw did not name that request's id, check code and exact text (or the request is no longer pending). Ask again with the question from lean_thread action-list`)
      continue
    }
    const o = await answerAction(h, r.id, answer === 'approve-standing' ? 'approve' : answer, 'ask', tell, answer === 'approve-standing') // (the third choice exists only in the canonical question of an eligible request, checked above)
    notes.push(o.text)
  }
  return notes
}

// ---- standing approval: the grant and the user's own rule ---------------------------------------------------------------------------------------
// A GRANT is signed (the mod's key) and written by writeGrant, which only answerAction calls: the pane's third press, or the third choice of the
// desk's question as the human answered it (bindAnswers reads the tool result). No lean_report, lean_thread action or message creates one, and
// writeGrant is not exported (a spec reads the sources to keep it so). A RULE is what the user wrote by hand in config.json `actions.standing`
// (a session cannot write that file: the guard refuses it). With either, a request of the two status kinds is sent by the mod at once, by the
// SAME executor (approveAction: signature, hash re-check, token on stdin). A batch is covered only when EVERY item is.
type Grant = { id: string; thread: string; scope: string; kinds: ActionKind[]; statuses: string[]; ts: number; exp: number; sig: string }
type SentRec = { ts: number; thread: string; text: string; grant?: string }
const GRANTS = 'action.grants'
const SENT = 'action.standing.sent'
const SENT_SHOWN_MS = 30 * 60 * 1000
const grantText = (g: Omit<Grant, 'sig'>) => `desk-standing\n${g.id}\n${g.thread}\n${g.scope}\n${g.kinds.join(',')}\n${g.statuses.join(',')}\n${g.ts}\n${g.exp}`
let gseq = 0

// the grants that verify and have not expired (a forged or edited row is not a grant)
async function grantRows(h: Host, now: number): Promise<Grant[]> {
  const v = await h.store.get(GRANTS).catch(() => null)
  const out: Grant[] = []
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.id !== 'string' || !threadOk(g.thread) || typeof g.scope !== 'string' || !Array.isArray(g.kinds) || !Array.isArray(g.statuses) || !Number.isFinite(g.ts) || !Number.isFinite(g.exp) || typeof g.sig !== 'string' || now > g.exp) continue
    if (![...g.kinds, ...g.statuses].every(x => typeof x === 'string')) continue
    const want = await macOf(h, grantText(g), false)
    if (want && want.length === g.sig.length && want === g.sig) out.push(g)
  }
  return out
}
async function writeGrant(h: Host, r: ActionRequest, now: number): Promise<boolean> {
  const scope = targetOf(r.kind, r.params)
  const base = { id: `g${now}-${++gseq}`, thread: r.thread, scope, kinds: [r.kind], statuses: r.kind === 'gh-pr-thread-resolve' ? [] : [...STANDING_STATUSES], ts: now, exp: now + STANDING_TTL_MS }
  const sig = await macOf(h, grantText(base), true)
  if (!sig) return false
  const all = (await grantRows(h, now)).filter(g => !(g.thread === r.thread && g.scope === scope && g.kinds.join() === base.kinds.join()))
  await h.store.set(GRANTS, [...all, { ...base, sig }].slice(-20))
  return true
}

type Rule = { project: string; kinds: ActionKind[]; statuses: string[] }
async function configRules(h: Host): Promise<Rule[]> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const raw = cfg && typeof cfg === 'object' ? (cfg.actions?.standing ?? cfg['actions.standing']) : null
  const rules: Rule[] = []
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== 'object' || typeof x.project !== 'string' || !x.project.trim() || !Array.isArray(x.kinds)) continue
    const kinds = x.kinds.filter((k: unknown): k is ActionKind => typeof k === 'string' && (STANDING_KINDS as string[]).includes(k))
    const statuses = (Array.isArray(x.statuses) ? x.statuses : []).map((s: unknown) => String(s).toLowerCase()).filter((s: string) => STANDING_STATUSES.includes(s))
    if (kinds.length) rules.push({ project: x.project.trim().toLowerCase(), kinds, statuses })
  }
  return rules
}

export type Cover = { label: string; grant?: string }
// does a grant or a rule of the user cover EVERY write of this request? null: no (the user is asked as usual)
export async function standingCover(h: Host, thread: string, kind: ActionKind, params: Params): Promise<Cover | null> {
  const items: { kind: unknown; params: Params }[] | null = kind !== 'batch' ? [{ kind, params }] : Array.isArray(params.items) && params.items.length ? (params.items as { kind: unknown; params: Params }[]) : null
  if (!items) return null
  const now = await h.clock.now()
  const grants = (await grantRows(h, now)).filter(g => g.thread === thread)
  const rules = await configRules(h)
  const tp = (await readJson<{ project?: unknown }>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, {}).catch(() => ({}) as { project?: unknown })).project
  const tproject = typeof tp === 'string' ? tp.toLowerCase() : ''
  let label = ''
  let grant: string | undefined
  for (const it of items) {
    const k = it?.kind
    const p = it?.params && typeof it.params === 'object' ? it.params : {}
    if (!isKind(k) || !STANDING_KINDS.includes(k) || !standingEligible(k, p)) return null // a reply, a comment, any other status: always asked
    const scope = targetOf(k, p)
    const g = grants.find(x => x.scope === scope && x.kinds.includes(k) && (k === 'gh-pr-thread-resolve' || x.statuses.includes(String(p.status))))
    if (g) {
      grant = grant ?? g.id
      label = label || `grant ${g.id}`
      continue
    }
    const named = k === 'gh-pr-thread-resolve' ? [String(p.repo ?? '').toLowerCase(), String(p.repo ?? '').toLowerCase().split('/')[1] ?? ''] : [String(p.project ?? '').toLowerCase()]
    const rule = rules.find(x => x.kinds.includes(k) && (named.includes(x.project) || tproject === x.project) && (k === 'gh-pr-thread-resolve' || x.statuses.includes(String(p.status))))
    if (!rule) return null
    label = label || 'your config.json rule'
  }
  return { label, ...(grant ? { grant } : {}) }
}

// a request that was just made: when the user's standing approval covers it, the mod answers (signed, by 'standing') and sends it at once.
// Returns null when it is not covered (the user is asked), else whether it went out and the line for the thread and the pane.
export async function runStanding(h: Host, id: string): Promise<{ sent: boolean; line: string } | null> {
  const r = (await rows(h)).find(x => x.id === id)
  if (!r) return null
  const plan = await sound(h, r)
  if (!plan) return null
  const cover = await standingCover(h, r.thread, r.kind, r.params)
  if (!cover) return null
  const held = await holdCovered(h, r, plan, cover.label); if (held) return held // sendhold.ts: not unseen, not against a newer instruction
  const now = await h.clock.now()
  const claimed = await exclusive(async () => {
    if ((await stateOf(h, r, now)) !== 'pending') return false
    const base = { id, hash: r.hash, answer: 'approve' as const, by: 'standing' as const, ts: now }
    const sig = await macOf(h, answerText(base), true)
    if (!sig) return false
    await h.store.set(answerKey(id), { ...base, sig } satisfies Answer)
    return true
  })
  if (!claimed) return null
  await logHistory(h, r.thread, { kind: 'action-approve', id, action: r.kind, hash: checkCode(r.hash), by: `standing approval (${cover.label})` })
  const out = await approveAction(h, id)
  const what = (plan.steps ?? [plan]).map(s => s.text).join('; ')
  if (!out.ok) return { sent: false, line: `sent under your standing approval FAILED: ${out.text}` }
  const line = `sent under your standing approval: ${what}`
  const prev = await h.store.get(SENT).catch(() => null)
  await h.store.set(SENT, [...(Array.isArray(prev) ? prev : []), { ts: now, thread: r.thread, text: line, ...(cover.grant ? { grant: cover.grant } : {}) } satisfies SentRec].slice(-10))
  await logHistory(h, r.thread, { kind: 'standing-sent', id, action: r.kind, by: cover.label, result: what.slice(0, 300) })
  return { sent: true, line }
}

// the user's WRITTEN instruction covers this request (deskwrites.ts decided): the mod records its own signed answer (by 'standing') and sends it through
// the SAME executor (approveAction: signature, hash re-check, token on stdin). `before` runs inside the claim (the grant's write count is taken there,
// and may refuse). Returns null when the request is no longer pending or `before` refused; else whether it went out.
export async function claimAndSend(h: Host, id: string, label: string, before?: (r: ActionRequest, plan: Plan) => Promise<boolean>): Promise<{ sent: boolean; text: string; plan: Plan; r: ActionRequest; held?: { sent: boolean; line: string } } | null> {
  const r = (await rows(h)).find(x => x.id === id)
  if (!r) return null
  const plan = await sound(h, r)
  if (!plan) return null
  const held = await holdCovered(h, r, plan, label); if (held) return { sent: false, text: held.line, plan, r, held } // sendhold.ts: not unseen, not against a newer instruction
  const now = await h.clock.now()
  const claimed = await exclusive(async () => {
    if ((await stateOf(h, r, now)) !== 'pending') return false
    if (before && !(await before(r, plan))) return false
    const base = { id, hash: r.hash, answer: 'approve' as const, by: 'standing' as const, ts: now }
    const sig = await macOf(h, answerText(base), true)
    if (!sig) return false
    await h.store.set(answerKey(id), { ...base, sig } satisfies Answer)
    return true
  })
  if (!claimed) return null
  await logHistory(h, r.thread, { kind: 'action-approve', id, action: r.kind, hash: checkCode(r.hash), by: label })
  const out = await approveAction(h, id)
  return { sent: out.ok, text: out.text, plan, r }
}

// what the pane and `action-list` show: the active grants, and the recent standing sends (each with its grant while that is still active)
export type StandingView = { grants: { id: string; thread: string; scope: string; statuses: string[]; exp: number }[]; sent: { ts: number; thread: string; text: string; grant?: string }[]; rules: number }
export async function standingView(h: Host): Promise<StandingView> {
  const now = await h.clock.now()
  const grants = await grantRows(h, now)
  const active = new Set(grants.map(g => g.id))
  const sentRaw = await h.store.get(SENT).catch(() => null)
  const sent = (Array.isArray(sentRaw) ? (sentRaw as SentRec[]) : []).filter(s => s && typeof s.text === 'string' && Number.isFinite(s.ts) && now - s.ts <= SENT_SHOWN_MS).map(s => ({ ts: s.ts, thread: String(s.thread), text: s.text, ...(s.grant && active.has(s.grant) ? { grant: s.grant } : {}) }))
  return { grants: grants.map(g => ({ id: g.id, thread: g.thread, scope: g.scope, statuses: g.statuses, exp: g.exp })), sent, rules: (await configRules(h)).length }
}
// revoking only ever takes power away: the pane's Revoke button
export async function revokeGrant(h: Host, id: string): Promise<{ ok: boolean; text: string }> {
  const g = await exclusive(async () => {
    const all = await grantRows(h, await h.clock.now())
    const hit = all.find(x => x.id === id)
    if (!hit) return null
    await h.store.set(GRANTS, all.filter(x => x.id !== id))
    return hit
  })
  if (!g) return { ok: false, text: `no active standing approval ${id}` }
  await logHistory(h, g.thread, { kind: 'standing-revoked', id, scope: g.scope, by: 'user, in the pane' })
  return { ok: true, text: `revoked the standing approval for ${g.thread} on ${g.scope}: its status changes are asked again` }
}
// a thread that closed keeps no standing approval
export async function dropGrants(h: Host, thread: string): Promise<void> {
  await exclusive(async () => {
    const all = await grantRows(h, await h.clock.now())
    if (all.some(g => g.thread === thread)) await h.store.set(GRANTS, all.filter(g => g.thread !== thread))
  })
}

// ---- the desk sends ---------------------------------------------------------------------------------------------------------------------------
const UNKNOWN_EXIT = new Set([28, 52, 55, 56]) // curl: timeout, empty reply, send / receive failure: the request may have arrived
type Sent = { ok: boolean; text: string; unknown?: boolean }

async function send(h: Host, plan: Plan): Promise<Sent> {
  if (plan.tool === 'github') {
    const r = await h.process.run(['gh', 'api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', plan.url.replace('https://api.github.com/', ''), '--input', '-'], { stdin: plan.body, timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
    if (r.exitCode !== 0) return { ok: false, text: `gh api failed: ${oneLine(r.stderr || r.stdout, 200) || `exit ${r.exitCode}`} (is gh installed and logged in: gh auth login)` }
    if (plan.url.endsWith('/graphql')) return /"isResolved"\s*:\s*true/.test(r.stdout) ? { ok: true, text: 'thread resolved' } : { ok: false, text: `GitHub answered but the thread is not reported resolved: ${oneLine(r.stdout, 200)}` }
    return { ok: true, text: resultOf(r.stdout, 'html_url') }
  }
  const tok = await azureToken(h)
  if ('error' in tok) return { ok: false, text: tok.error }
  const { token } = tok
  const scrub = (s: string) => s.split(token).join('***')
  // the token and the body go to curl as a config on STDIN (`-K -`): nothing secret is in an argument list or a process listing
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
  const config = [`header = ${q(`Authorization: Bearer ${token}`)}`, `header = ${q(`Content-Type: ${plan.contentType}`)}`, `header = ${q('Accept: application/json')}`, `data-binary = ${q(plan.body)}`, ''].join('\n')
  const r = await h.process.run(['curl', '-sS', '--fail-with-body', '--max-time', '60', '-X', plan.method, '-K', '-', plan.url], { stdin: config, timeoutMs: 70_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  if (r.exitCode !== 0) {
    const why = scrub(oneLine(r.stderr || r.stdout, 200)) || `curl exit ${r.exitCode}`
    return UNKNOWN_EXIT.has(r.exitCode) ? { ok: false, unknown: true, text: `the connection broke after the request may have been sent (${why}): outcome unknown, check the target before asking again` } : { ok: false, text: `Azure DevOps refused or could not be reached: ${why}` }
  }
  return { ok: true, text: scrub(resultOf(r.stdout, 'url')) }
}
// a batch or a reply with a status: the writes in order, stopped at the first failure, each reported (done / failed with the reason / not run)
type Ran = { sent: Sent; progress: boolean }
async function runSteps(h: Host, plan: Plan): Promise<Ran> {
  const steps = plan.steps!
  const parts: string[] = []
  let stopped = false
  let progress = false
  let unknown = false
  for (const s of steps) {
    const tag = s.tag ?? '?'
    if (stopped) {
      parts.push(`${tag}: not run`)
      continue
    }
    let one: Sent
    try {
      one = await send(h, s)
    } catch (e) {
      one = { ok: false, unknown: true, text: `sending failed after it may have started: ${oneLine(String((e as Error)?.message ?? e), 200)}` }
    }
    if (one.ok) {
      progress = true
      parts.push(`${tag}: done (${one.text})`)
    } else {
      stopped = true
      if (one.unknown) {
        progress = true
        unknown = true
      }
      parts.push(`${tag}: ${one.unknown ? 'outcome unknown' : 'failed'} (${one.text})`)
    }
  }
  return { sent: { ok: !stopped, ...(unknown ? { unknown: true } : {}), text: parts.join('; ') }, progress }
}
const resultOf = (out: string, urlField: string): string => {
  try {
    const o = JSON.parse(out) as Record<string, unknown>
    const id = typeof o.id === 'number' || typeof o.id === 'string' ? `id ${String(o.id).slice(0, 40)}` : ''
    const url = typeof o[urlField] === 'string' ? (o[urlField] as string).slice(0, 300) : ''
    return [id, url].filter(Boolean).join(' ') || 'sent'
  } catch {
    return 'sent'
  }
}

// `lean_thread approve-action <id>` (desk only). Every refusal says what is missing.
export async function approveAction(h: Host, id: string, tell?: Tell): Promise<{ ok: boolean; text: string }> {
  if (!idOk(id)) return { ok: false, text: 'approve-action needs the request id (like a1700000000000-1, from lean_thread action-list)' }
  const claim = await exclusive(async () => {
    const r = (await rows(h)).find(x => x.id === id)
    if (!r) return { ok: false as const, text: `no request ${id} (not made by a thread, already cleared, or never existed)` }
    const now = await h.clock.now()
    const plan = await sound(h, r)
    if (!plan) return { ok: false as const, text: `request ${id} does not verify (not signed by this mod, or the text to send no longer matches its check code): refused, nothing was sent` }
    const st = await stateOf(h, r, now)
    if (st === 'used') return { ok: false as const, text: `request ${id} was already used: one approval sends once` }
    if (st === 'expired') {
      await dropOne(h, id)
      if (tell) await tell(r.thread, `Your request ${id} (${r.kind}) expired unanswered (2 h): send it again if it is still needed, or continue without it.`).catch(() => undefined)
      return { ok: false as const, text: `request ${id} expired (2 h): ${r.thread} was told to send it again if still needed` }
    }
    if (st === 'denied') return { ok: false as const, text: `request ${id} was denied by the user: ${r.thread} was told (denied: report blocked / continue without it)` }
    if (st === 'edit') return { ok: false as const, text: `the user asked to edit request ${id} first: nothing is sent; tell ${r.thread} what to change, it sends a NEW request` }
    if (st !== 'approved') return { ok: false as const, text: `no human Approve is on record for request ${id} (ask the user with the question from lean_thread action-list, or they press Approve in the pane): refused` }
    if (inflight.has(id)) return { ok: false as const, text: `request ${id} is being sent right now` }
    inflight.add(id)
    return { ok: true as const, r, plan }
  })
  if (!claim.ok) return claim
  const { r, plan } = claim
  let sent: Sent
  let progress = false // a composite request that already wrote something is never retried as a whole (it would write twice)
  try {
    // the used mark is written BEFORE the send (a crash mid-send never allows a second one); only a definite failure clears it again
    await h.store.set(usedKey(id), await h.clock.now())
  } catch (e) {
    inflight.delete(id)
    return { ok: false, text: `not sent: the used mark could not be written (${oneLine(String((e as Error)?.message ?? e), 120)}); nothing was sent` }
  }
  try {
    // the check right before sending: what goes out is exactly what the user saw
    if (hashOf(renderingOf(plan)) !== r.hash) sent = { ok: false, text: 'the text to send no longer matches its check code: nothing was sent' }
    else if (plan.steps) {
      const ran = await runSteps(h, plan)
      sent = ran.sent
      progress = ran.progress
    } else sent = await send(h, plan)
  } catch (e) {
    sent = { ok: false, unknown: true, text: `sending failed after it may have started: ${oneLine(String((e as Error)?.message ?? e), 200)}` }
  }
  try {
    if (!sent.ok && !sent.unknown && !progress) await h.store.set(usedKey(id), null) // a definite failure that sent nothing is the only retry
  } finally {
    inflight.delete(id)
  }
  await logHistory(h, r.thread, { kind: sent.ok ? 'action-sent' : sent.unknown ? 'action-unknown' : 'action-failed', id, action: r.kind, hash: checkCode(r.hash), target: plan.url, result: sent.text.slice(0, 300) })
  if (sent.ok && tell) await tell(r.thread, `The user approved your request ${id} and the desk sent it (${r.kind}): ${sent.text}. Carry on.`).catch(() => undefined)
  if (sent.unknown && tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved and sent, but the outcome is unknown (${sent.text}). Check the target before asking again.`).catch(() => undefined)
  if (progress && !sent.ok && !sent.unknown) {
    // some writes went out, one failed, the rest did not run: the request is used (never repeated whole); the thread asks for the rest as a NEW request
    if (tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved but only partly done: ${sent.text}. Nothing is repeated: make a NEW request for what did not run, if it is still needed.`).catch(() => undefined)
    return { ok: false, text: `partly done: ${sent.text}. The request is marked used (never repeated whole); ${r.thread} was told to ask again for the rest` }
  }
  if (sent.ok) return { ok: true, text: `sent ${r.kind} for ${r.thread}: ${sent.text}; ${r.thread} was told` }
  return { ok: false, text: sent.unknown ? `${sent.text}. The request is marked used (never sent twice); ${r.thread} was told` : `not sent: ${sent.text}. The request stays approved and unused for its 2 h: try again, or tell ${r.thread}` }
}

async function dropOne(h: Host, id: string): Promise<void> {
  const all = await rows(h)
  if (all.some(r => r.id === id)) await save(h, all.filter(r => r.id !== id))
}
// a thread that closed keeps no open request
export async function dropActions(h: Host, thread: string): Promise<void> {
  await exclusive(async () => {
    const all = await rows(h)
    if (all.some(r => r.thread === thread)) await save(h, all.filter(r => r.thread !== thread))
  })
}

// the desk's `action-list`: what waits, each with the question to ask the user, word for word (and the expired ones, told to their thread)
export async function actionListText(h: Host, tell?: Tell): Promise<string> {
  const now = await h.clock.now()
  for (const r of await rows(h)) {
    if (now > r.exp && !(await usedOf(h, r.id))) {
      const a = await answerOf(h, r)
      if (!a) {
        await exclusive(() => dropOne(h, r.id))
        if (tell) await tell(r.thread, `Your request ${r.id} (${r.kind}) expired unanswered (2 h): send it again if it is still needed, or continue without it.`).catch(() => undefined)
      }
    }
  }
  const list = await listActions(h)
  const st = await standingView(h).catch(() => null)
  const stand = st && (st.grants.length || st.rules) ? `\nstanding approvals (a request they cover is sent by the mod at once: do not ask the user again):${st.grants.map(g => `\n  ${g.id} · ${g.thread} · ${g.scope} · status changes (${g.statuses.join(', ') || 'resolve'}) · until ${new Date(g.exp).toISOString().slice(0, 16).replace('T', ' ')} UTC (or the thread closes); the user revokes it in the pane`).join('')}${st.rules ? `\n  ${st.rules} rule${st.rules === 1 ? '' : 's'} in config.json actions.standing (written by the user)` : ''}` : ''
  if (!list.length) return `no request waits for the user${stand}`
  return `${list
    .map(v => {
      const head = `${v.id} · ${v.thread} · ${v.kind} · ${v.state}${v.why ? ` · why: ${cut(v.why, 160)}` : ''}`
      if (v.state === 'approved') return `${head}\n  the user approved it: call lean_thread approve-action ${v.id}`
      const q = questionOf(v)
      return `${head}\n  AskUserQuestion, question (paste it exactly): ${JSON.stringify(q.question)}\n  options (exactly these labels): ${q.options.map(o => `${o.label}: ${o.description}`).join(' | ')}`
    })
    .join('\n')}${stand}`
}
