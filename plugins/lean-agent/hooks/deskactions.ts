// Typed remote writes a thread needs and may not make itself, performed by the DESK-SIDE MOD after the HUMAN said yes.
//
// Why: Claude Code's own permission check (or the auto-mode classifier) denies a thread's remote write (a PR comment, a work item update),
// and no hook can carry a desk yes past that verdict (see the changelog of 1.0.14). So the pattern that already works for pushes is used:
// the thread asks, the user decides in the desk, and the mod itself runs the approved write (argv, never a shell, never a model, never the
// thread's Bash). No model ever bypasses a permission check, and nothing but the kinds below can be asked for (a `batch` of up to 10 of them for one PR or work item is one request, one approval; up to 60 when all are PR comments, a review).
// Inline review comments (1.0.29): the line is checked against the PR's own diff by script (anchor.ts) before the request is shown and again before it is sent.
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
//      record, the request is unexpired (24 h, config actions.pendingHours) and unused. The rendering is derived again from the params and its hash compared right before
//      sending. Single use: the request is used once the write went out. A failing executor leaves it unused and says why.
//   4. The mod sends, records the result (id / URL, never the token) in the thread's history.jsonl and tells the thread, so it goes on.
//
// Never grantable this way: pushes, tags, releases (the push gate), merges, deletes, permission or settings changes, anything outside the
// table. The token of Azure DevOps goes to curl on STDIN only (a curl config), never in an argument list, a log or an output.
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { macOf } from './reviews'
import { sha256 } from './sha'
import { azureToken, joinPages, oneLine } from './prhost'
import { typedApproval } from './writeinstr'
import { setNotice } from './notices'
import { holdCovered } from './sendhold'
import { CANNOT_VERIFY, changesTable, lintReviewText, prKey, verifyAnchors } from './anchor'
import type { Anchor, AnchorInfo, Reader } from './anchor'
import { checkOn, severityWord, withSeverity } from './prvote'
import { checkMove } from './owntask'
import { createCheck } from './workitemflow'
import { FALLBACK_KINDS, fallbackText } from './actionfallback'

export const ACTION_TTL_MS = 24 * 60 * 60 * 1000 // the default wait (config actions.pendingHours; was 2 h before 1.0.31)
export const ACTIONS_MAX = 40 // requests kept in the store
export const PENDING_MAX = 5 // open requests one thread may have at a time
export const BODY_MAX = 10_000
export const FIELD_MAX = 200
export const FEEDBACK_REPO = 'mcmadsen/lean-agent' // the ONLY repo a feedback issue goes to (feedbackexport.ts REPO_URL names the same repo)
export const ISSUE_BODY_MAX = 45_000 // the export is capped at 40 KB
export const DESK_THREAD = 't0' // the desk's own requests (the feedback export): no thread, so nobody is "told" and no history folder is made
export const DESK_ONLY_KINDS: string[] = ['gh-issue-create'] // never asked for by a thread (lean_report); the mod makes them

// ---- the table: the ONLY kinds, with the params each takes ---------------------------------------------------------------------------
export type ActionKind = 'ado-pr-reply' | 'ado-pr-thread-status' | 'ado-pr-comment' | 'ado-workitem-comment' | 'ado-workitem-update' | 'ado-workitem-create' | 'ado-pr-workitem-link' | 'gh-pr-comment' | 'gh-pr-review-comment' | 'gh-pr-thread-resolve' | 'ado-pr-vote' | 'ado-pr-update' | 'ado-pr-reviewer' | 'ado-pr-policy-queue' | 'ado-pr-workitem-unlink' | 'ado-pr-label' | 'gh-issue-create' | 'gh-pr-review' | 'batch'
export const BATCH_MAX = 10
export const COMMENT_BATCH_MAX = 60 // a batch of ONLY PR comments (inline or general) for ONE PR: a review is one request
export const COMMENT_KINDS: string[] = ['ado-pr-comment', 'gh-pr-comment', 'gh-pr-review-comment']
export const VOTE_KINDS: string[] = ['ado-pr-vote', 'gh-pr-review'] // 1.0.31: a batch of PR comments may end with exactly ONE of these for the same PR (comments first, then the vote)
export const GH_EVENTS: Record<string, string> = { comment: 'COMMENT', 'request-changes': 'REQUEST_CHANGES', approve: 'APPROVE' }
export const PH_HEAD = '<PR head commit>' // the commit an inline GitHub comment names: read by a GET right before it is sent (the user sees the placeholder)
export const PH_ITER = '<latest iteration>' // an inline Azure DevOps comment follows ONE iteration: the latest one, read right before it is sent, unless `iteration` is given
export const PH_CHANGE = '<change id>' // the file's changeTrackingId in that iteration, read then too, unless `changeTrackingId` is given
export const STATUS_CODES: Record<string, number> = { active: 1, fixed: 2, wontFix: 3, closed: 4, byDesign: 5, pending: 6 } // the REST values of a thread's status at creation
export const COMMENT_TYPES: Record<string, number> = { text: 1, codechange: 2 }
export const ANCHOR_NOTE = 'anchors checked against the PR diff'
export const QUESTION_TEXT_MAX = 300 // a comment's text in the desk's question of a review batch (the card shows all of it)
export const WI_TYPES = ['Bug', 'Task', 'User Story', 'Issue']
// the review writes of 1.0.30 (vote, update, reviewer, policy queue, work item unlink, label): the REST value of each vote of `az repos pr set-vote`
export const VOTES: Record<string, number> = { approve: 10, 'approve-with-suggestions': 5, reject: -10, reset: 0, 'wait-for-author': -5 }
// the line a vote item adds to the card and the question of a comment batch ("then: ...")
export const VOTE_THEN: Record<string, string> = { 'wait-for-author': 'set the PR to Waiting for author', approve: 'approve the PR', 'approve-with-suggestions': 'approve the PR with suggestions', reject: 'reject the PR', reset: 'reset your vote on the PR', comment: 'submit your comments as a review (no state)', 'request-changes': 'request changes on the PR (GitHub review)' }
export const PH_INDEX ='<link index>' // the position of the PR's link in the work item's relations: read by a GET of the work item right before an unlink is sent
export const PH_ME ='<your reviewer id>' // the identity the token belongs to: read by a GET of connectionData right before it is sent (the user sees the placeholder)
export const PH_PROJECT = '<project id>' // placeholders in a PR link's body: the mod reads the two ids by a GET right before it sends (the user sees the placeholders)
export const PH_REPO = '<repository id>'
export const PH_NEW = '<new id>' // the id of the work item a create step just made
// the thread statuses a PR thread may be set to: what the thread says -> the REST value of PATCH .../threads/<id>
export const THREAD_STATUS: Record<string, string> = { active: 'active', fixed: 'fixed', wontfix: 'wontFix', closed: 'closed', bydesign: 'byDesign', pending: 'pending' }
export const STATUS_NAMES = Object.values(THREAD_STATUS).join(', ')
export const ACTION_KINDS: Record<ActionKind, string> = {
  'ado-pr-reply': `org, project, repo, pr, thread, body, optional status (${STATUS_NAMES}: the desk then sets the thread's status, after the reply)`,
  'ado-pr-thread-status': `org, project, repo, pr, thread, status (${STATUS_NAMES})`,
  'ado-pr-comment': `org, project, repo, pr, body, optional file + line (+ endLine or lineEnd, offset, offsetEnd, side right|left, iteration, changeTrackingId): an inline comment on that line of the PR; optional status (${STATUS_NAMES}), commentType text|codeChange, parentCommentId, severity (blocker|major|minor|nit|question: the text starts with that word)`,
  'ado-workitem-comment': 'org, project, id, body',
  'ado-workitem-update': 'org, project, id, fields (state, assignedTo, tags, title; strings)',
  'ado-workitem-create': `org, project, type (${WI_TYPES.join(' | ')}), title, description?, area?, iteration?, assignedTo?, parent? (id), links? [{pr}] with repo`,
  'ado-pr-workitem-link': 'org, project, repo, pr, workitem (id)',
  'gh-pr-comment': 'repo (owner/name), pr, body',
  'gh-pr-review-comment': 'repo (owner/name), pr, file, line, body, optional endLine, side right|left, severity (blocker|major|minor|nit|question: the text starts with that word): an inline comment on that line of the PR',
  'gh-pr-thread-resolve': 'repo (owner/name), pr, thread (the review thread node id, like PRRT_...)',
  'ado-pr-vote': `org, project, repo, pr, vote (${Object.keys(VOTES).join(' | ')}): the vote of the identity the token belongs to`,
  'ado-pr-update': 'org, project, repo, pr, title?, description?, draft? (true | false), status? (active | abandoned); never completing, auto-complete, merge options, bypass: the user does that by hand',
  'ado-pr-reviewer': 'org, project, repo, pr, op (add | remove), reviewer (the id, or the unique email or display name the API takes), required? (true | false, add only)',
  'ado-pr-policy-queue': 'org, project, repo, pr, evaluationId (the GUID of the policy evaluation to queue again)',
  'ado-pr-workitem-unlink': 'org, project, repo, pr, workitem (id): removes the link of the PR from that work item',
  'ado-pr-label': 'org, project, repo, pr, op (add | remove), label (text of at most 40 characters)',
  'gh-issue-create': `${FEEDBACK_REPO} only: title, body (the anonymised feedback export). Made by the mod for the desk's feedback export (config.json feedback.destination github), never by a thread`,
  'gh-pr-review': `repo (owner/name), pr, event (${Object.keys(GH_EVENTS).join(' | ')}), optional body: the review state of the PR; sent after the comments of the same request`,
  batch: `items: up to ${BATCH_MAX} {kind, params} of the kinds above (not batch) for ONE PR or ONE work item (same org, project, repo, pr, or the same work item), up to ${COMMENT_BATCH_MAX} when ALL are PR comments of one PR (plus ONE last vote item: ado-pr-vote or gh-pr-review); one approval covers the list, run in order, stopped at the first failure (continueOnError: a failing item is reported and the rest run; the default for PR comments)`,
}
const PARAM_KEYS: Record<ActionKind, string[]> = {
  'ado-pr-reply': ['org', 'project', 'repo', 'pr', 'thread', 'body', 'status'],
  'ado-pr-thread-status': ['org', 'project', 'repo', 'pr', 'thread', 'status'],
  'ado-pr-comment': ['org', 'project', 'repo', 'pr', 'body', 'file', 'line', 'endLine', 'lineEnd', 'offset', 'offsetEnd', 'side', 'status', 'commentType', 'parentCommentId', 'iteration', 'changeTrackingId'],
  'ado-workitem-comment': ['org', 'project', 'id', 'body'],
  'ado-workitem-update': ['org', 'project', 'id', 'fields'],
  'ado-workitem-create': ['org', 'project', 'type', 'title', 'description', 'area', 'iteration', 'assignedTo', 'parent', 'links', 'repo'],
  'ado-pr-workitem-link': ['org', 'project', 'repo', 'pr', 'workitem'],
  'gh-pr-comment': ['repo', 'pr', 'body'],
  'gh-pr-review-comment': ['repo', 'pr', 'file', 'line', 'body', 'endLine', 'side'],
  'gh-pr-thread-resolve': ['repo', 'pr', 'thread'],
  'ado-pr-vote': ['org', 'project', 'repo', 'pr', 'vote'],
  'ado-pr-update': ['org', 'project', 'repo', 'pr', 'title', 'description', 'draft', 'status'],
  'ado-pr-reviewer': ['org', 'project', 'repo', 'pr', 'op', 'reviewer', 'required'],
  'ado-pr-policy-queue': ['org', 'project', 'repo', 'pr', 'evaluationId'],
  'ado-pr-workitem-unlink': ['org', 'project', 'repo', 'pr', 'workitem', 'workItem'],
  'ado-pr-label': ['org', 'project', 'repo', 'pr', 'op', 'label'],
  'gh-issue-create': ['repo', 'title', 'body'],
  'gh-pr-review': ['repo', 'pr', 'event', 'body'],
  'batch': ['items', 'continueOnError'],
}
export const isKind = (k: unknown): k is ActionKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ACTION_KINDS, k)
export const THREAD_KINDS = (): string[] => Object.keys(ACTION_KINDS).filter(k => !DESK_ONLY_KINDS.includes(k)) // what a thread may ask for
export const kindsText = (): string => Object.entries(ACTION_KINDS).filter(([k]) => !DESK_ONLY_KINDS.includes(k)).map(([k, p]) => `${k} {${p}}`).join('; ')
export const FIELD_NAMES: Record<string, string> = { state: 'System.State', assignedTo: 'System.AssignedTo', tags: 'System.Tags', title: 'System.Title' }

// what is sent: tool 'azure' = curl with a bearer token, 'github' = gh api
// `steps` (a batch, or a reply with a status): the writes the mod makes in order, flat, each with its tag ("1", "2 reply", "2 status"); the hash covers all of them
// `link`: a PR link (PATCH of a work item with a vstfs artifact link): the ids of the project and the repository are read by two GETs right before it is sent
// `anchor`: an inline review comment: the mod reads the PR's diff and checks the line before it is shown and again before it is sent (anchor.ts)
// `items`: a batch of PR comments, numbered, for the card and the question; `cont`: a failing item is reported and the rest still run
export type ReviewItem = { n: number; file: string; where: string; text: string }
// `me`: the write names the identity the token belongs to (PH_ME in the URL): read by a GET of connectionData right before it is sent
export type Plan = { tool: 'azure' | 'github'; issue?: { repo: string; title: string; body: string } /* gh-issue-create: `gh issue create` by argv, not the REST call */; method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; contentType: string; body: string; headline: string; text: string; tag?: string; steps?: Plan[]; link?: { org: string; project: string; repo: string; pr: number; unlink?: number /* the work item the PR's link is REMOVED from */ }; me?: { org: string }; anchor?: Anchor; items?: ReviewItem[]; cont?: boolean; vote?: boolean /* the vote / review item that ends a comment batch: sent only when a comment went out */; ghReview?: { repo: string; pr: number; event: string } /* a GitHub review: the head commit is read right before it is sent, an APPROVE of the user's own PR is refused */; then?: string /* the card / question line for that last item */ }
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
export const renderingOf = (p: Pick<Plan, 'method' | 'url' | 'contentType' | 'body' | 'steps' | 'cont'>): string =>
  p.steps ? (p.cont ? 'continue on error\n' : '') + p.steps.map((s, i) => `#${i + 1}/${p.steps!.length}\n${renderingOf(s)}`).join('\n---\n') : `${p.method} ${p.url}\n${p.contentType}\n${p.body}`

const int = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e9 ? n : null
}

// a PR linked to a work item (REST: an ArtifactLink on the work item); `wi` is the work item's number, or PH_NEW inside a create
const linkPlan = (base: string, org: string, project: string, repo: string, pr: number, wi: string): Plan => ({
  tool: 'azure',
  method: 'PATCH',
  url: `${base}/_apis/wit/workitems/${wi}?api-version=7.1`,
  contentType: 'application/json-patch+json',
  body: JSON.stringify([{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PH_PROJECT}%2F${PH_REPO}%2F${pr}`, attributes: { name: 'Pull Request' } } }]),
  headline: `link PR ${pr} to work item ${wi === PH_NEW ? 'it made' : wi} (${org}/${project}/${repo})`,
  text: `link PR ${pr} of ${repo} to work item ${wi === PH_NEW ? 'the new one' : wi}`,
  link: { org, project, repo, pr },
})

// where an inline comment sits, as the renderings, the card and the question show it
export const whereOf = (a: { file: string; line: number; endLine?: number; side: 'right' | 'left' }): string => `${a.file}:${a.line}${a.endLine !== undefined && a.endLine !== a.line ? `-${a.endLine}` : ''}${a.side === 'left' ? ' (removed line)' : ''}`

// the review writes on ONE Azure DevOps PR (vote ...): repo + pr are common; each kind adds its own params. `bad` is the caller's refusal.
const REVIEW_KINDS: ActionKind[] = ['ado-pr-vote', 'ado-pr-update', 'ado-pr-reviewer', 'ado-pr-policy-queue', 'ado-pr-workitem-unlink', 'ado-pr-label']
// what a thread never does to a PR (the user does it by hand): completing, auto-complete, squash / merge options, bypassing policy, deleting the source branch
const BY_HAND = /complet|squash|merge|bypass|deletesource|sourcebranch/
const byHand = (what: string): Checked => refuse(`action ado-pr-update: ${what} is not something a thread does: the user does this by hand (completing the PR, auto-complete, squash / merge options, bypassing policy, deleting the source branch). A thread may change the title, the description, draft, and set the status to active or abandoned`)
function checkReview(k: ActionKind, p: Params, az: { org: string; project: string; base: string }, params: Params, bad: (what: string) => Checked): Checked {
  const repo = typeof p.repo === 'string' && NAME.test(p.repo.trim()) ? p.repo.trim() : null
  const pr = int(p.pr)
  if (!repo || pr === null) return bad('repo must be a repository name and pr a number')
  Object.assign(params, { repo, pr })
  const where = `${az.org}/${az.project}/${repo}`
  const prs = `${az.base}/_apis/git/repositories/${enc(repo)}/pullRequests/${pr}`
  if (k === 'ado-pr-vote') {
    const word = typeof p.vote === 'string' ? p.vote.trim().toLowerCase().replace(/[\s_]+/g, '-') : ''
    if (!Object.prototype.hasOwnProperty.call(VOTES, word)) return bad(`vote must be one of ${Object.keys(VOTES).join(', ')}`)
    params.vote = word
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PUT', url: `${prs}/reviewers/${enc(PH_ME)}?api-version=7.1`, contentType: 'application/json', body: JSON.stringify({ vote: VOTES[word] }), headline: `vote "${word}" on PR ${pr} (${where})`, text: `vote "${word}" (${VOTES[word]}) on PR ${pr} of ${repo}, as the identity the desk's Azure DevOps login belongs to`, me: { org: az.org }, vote: true, then: VOTE_THEN[word] ?? `vote "${word}"` } }
  }
  if (k === 'ado-pr-update') {
    const str = (key: string, max: number): string | null | undefined => {
      if (p[key] === undefined) return undefined
      const v = typeof p[key] === 'string' ? (p[key] as string).replace(/\r\n?/g, '\n').trim() : ''
      return v && v.length <= max && !CONTROL.test(v.replace(/[\n\t]/g, '')) ? v : null
    }
    const title = str('title', 400)
    const description = str('description', 4000)
    const draft = p.draft === undefined ? undefined : typeof p.draft === 'boolean' ? p.draft : null
    const status = p.status === undefined ? undefined : typeof p.status === 'string' ? p.status.trim().toLowerCase() : null
    if (title === null || description === null || draft === null || status === null || (status !== undefined && status !== 'active' && status !== 'abandoned')) return bad('title is non-empty text of at most 400 characters, description non-empty text of at most 4000, draft true or false, status active or abandoned')
    const body: Record<string, unknown> = {}
    const lines: string[] = []
    if (title !== undefined) (body.title = title), lines.push(`title: ${title}`)
    if (description !== undefined) (body.description = description), lines.push(`description: ${description}`)
    if (draft !== undefined) (body.isDraft = draft), lines.push(`draft: ${draft}`)
    if (status !== undefined) (body.status = status), lines.push(`status: ${status}`)
    if (!lines.length) return bad('give at least one of title, description, draft, status')
    for (const [key, v] of Object.entries({ title, description, draft, status })) if (v !== undefined) params[key] = v
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PATCH', url: `${prs}?api-version=7.1`, contentType: 'application/json', body: JSON.stringify(body), headline: `update PR ${pr} (${where})`, text: lines.join('\n') } }
  }
  if (k === 'ado-pr-reviewer') {
    const op = typeof p.op === 'string' ? p.op.trim().toLowerCase() : ''
    const reviewer = typeof p.reviewer === 'string' ? p.reviewer.trim() : ''
    const required = p.required === undefined ? undefined : typeof p.required === 'boolean' ? p.required : null
    if ((op !== 'add' && op !== 'remove') || !reviewer || reviewer.length > FIELD_MAX || CONTROL.test(reviewer) || /^\.+$/.test(reviewer) || required === null) return bad('op must be add or remove, reviewer the id (or the unique email or display name) of the reviewer, required true or false')
    if (op === 'remove' && required !== undefined) return bad('required goes with add only')
    Object.assign(params, { op, reviewer, ...(required !== undefined ? { required } : {}) })
    const url = `${prs}/reviewers/${enc(reviewer)}?api-version=7.1`
    if (op === 'remove') return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'DELETE', url, contentType: '', body: '', headline: `remove reviewer ${reviewer} from PR ${pr} (${where})`, text: `remove reviewer ${reviewer} from PR ${pr} of ${repo}` } }
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PUT', url, contentType: 'application/json', body: JSON.stringify({ id: reviewer, isRequired: required ?? false }), headline: `add reviewer ${reviewer} to PR ${pr} (${where})`, text: `add reviewer ${reviewer} (${required ? 'required' : 'optional'}) to PR ${pr} of ${repo}` } }
  }
  if (k === 'ado-pr-policy-queue') {
    // queue a policy evaluation of the PR again (REST: PATCH policy/evaluations/<id>, the project in the path; the PR is named for the card and the batch target)
    const ev = typeof p.evaluationId === 'string' ? p.evaluationId.trim().toLowerCase() : ''
    if (!GUID.test(ev)) return bad('evaluationId must be the GUID of a policy evaluation of the PR')
    params.evaluationId = ev
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PATCH', url: `${az.base}/_apis/policy/evaluations/${ev}?api-version=7.1-preview.1`, contentType: 'application/json', body: '{}', headline: `queue policy evaluation ${ev} of PR ${pr} again (${where})`, text: `queue policy evaluation ${ev} of PR ${pr} of ${repo} again` } }
  }
  if (k === 'ado-pr-workitem-unlink') {
    // `workItem` is the same field as `workitem` (the link kind's spelling)
    const a = p.workitem === undefined ? undefined : int(p.workitem)
    const b = p.workItem === undefined ? undefined : int(p.workItem)
    const wi = a === undefined ? b : a
    if (wi === undefined || wi === null || (b !== undefined && a !== undefined && a !== b)) return bad('workitem must be a work item number')
    params.workitem = wi
    // the work item's relation is removed by its POSITION, read right before it is sent; a test op on the link's url guards the position (nothing else is removed)
    const url = `vstfs:///Git/PullRequestId/${PH_PROJECT}%2F${PH_REPO}%2F${pr}`
    const ops = [{ op: 'test', path: `/relations/${PH_INDEX}/url`, value: url }, { op: 'remove', path: `/relations/${PH_INDEX}` }]
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'PATCH', url: `${az.base}/_apis/wit/workitems/${wi}?api-version=7.1`, contentType: 'application/json-patch+json', body: JSON.stringify(ops), headline: `unlink PR ${pr} from work item ${wi} (${where})`, text: `remove the link of PR ${pr} of ${repo} from work item ${wi}`, link: { org: az.org, project: az.project, repo, pr, unlink: wi } } }
  }
  if (k === 'ado-pr-label') {
    const op = typeof p.op === 'string' ? p.op.trim().toLowerCase() : ''
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    if ((op !== 'add' && op !== 'remove') || !label || label.length > 40 || CONTROL.test(label) || /[/\\]/.test(label) || /^\.+$/.test(label)) return bad('op must be add or remove and label text of at most 40 characters (no / or \\)')
    Object.assign(params, { op, label })
    const labels = `${prs}/labels`
    if (op === 'remove') return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'DELETE', url: `${labels}/${enc(label)}?api-version=7.1`, contentType: '', body: '', headline: `remove label "${label}" from PR ${pr} (${where})`, text: `remove label "${label}" from PR ${pr} of ${repo}` } }
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'POST', url: `${labels}?api-version=7.1`, contentType: 'application/json', body: JSON.stringify({ name: label }), headline: `add label "${label}" to PR ${pr} (${where})`, text: `add label "${label}" to PR ${pr} of ${repo}` } }
  }
  return bad('not a review write')
}

// the table's one door: a kind, exactly its params (no others), every value checked; the plan is what the mod will send
export type CheckOpts = { severity?: boolean } // severity: false = config review.prChecks off: a comment's severity param is dropped, the text is not prefixed
// 1.0.31: a review comment may name its severity (blocker | major | minor | nit | question): the text then starts with that word, added here by script when it is missing
const severed = (k: string, p: Params, on: boolean): Params | string => {
  if (!COMMENT_KINDS.includes(k) || p.severity === undefined) return p
  const { severity, ...rest } = p
  if (severityWord(severity) === null) return `action ${k}: severity must be one of blocker, major, minor, nit, question`
  return on && typeof rest.body === 'string' ? { ...rest, body: withSeverity(rest.body, severity) } : rest
}
export function checkAction(a: unknown, opts: CheckOpts = {}): Checked {
  const x = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : null
  const kind = typeof x?.kind === 'string' ? x.kind.trim() : ''
  if (!x || !isKind(kind)) return refuse(`action kind ${kind ? `"${kind.slice(0, 40)}" ` : ''}is not one the desk can send for a thread. The kinds: ${kindsText()}. Anything else (a push, a merge, a delete, a settings change, any command) is not asked for this way`)
  const k = kind
  if (k === 'batch') return checkBatch(x, opts)
  const p0 = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? (x.params as Params) : null
  if (!p0) return refuse(`action ${k} needs params {${ACTION_KINDS[k]}}`)
  const sv = severed(k, p0, opts.severity !== false)
  if (typeof sv === 'string') return refuse(sv)
  const p = sv
  if (k === 'ado-pr-update') {
    const key = Object.keys(p).find(x => BY_HAND.test(x.toLowerCase()))
    if (key) return byHand(`"${key.slice(0, 30)}"`)
    const st = typeof p.status === 'string' ? p.status.trim().toLowerCase() : ''
    if (BY_HAND.test(st)) return byHand(`status "${st.slice(0, 20)}"`)
  }
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
  // an inline comment's place: file (repo-relative), line (in the PR's NEW version; the old one with side left), endLine?, side?. undefined: none given; null: not valid
  const inlineOf = (): { file: string; line: number; endLine?: number; side: 'right' | 'left' } | null | undefined => {
    if (['file', 'line', 'endLine', 'lineEnd', 'side'].every(key => p[key] === undefined)) return undefined
    const file = typeof p.file === 'string' ? p.file.trim() : ''
    const line = num('line')
    const endLine = p.endLine === undefined && p.lineEnd === undefined ? undefined : num(p.endLine === undefined ? 'lineEnd' : 'endLine') // lineEnd is the same field as endLine
    if (p.endLine !== undefined && p.lineEnd !== undefined && int(p.endLine) !== int(p.lineEnd)) return null
    const sideRaw = p.side === undefined ? 'right' : typeof p.side === 'string' ? p.side.trim().toLowerCase() : ''
    if (!file || file.length > 300 || CONTROL.test(file) || file.includes('\\') || file.split('/').some(s => !s || s === '..') || line === null || endLine === null || (endLine !== undefined && endLine < line) || (sideRaw !== 'right' && sideRaw !== 'left')) return null
    params.file = file
    params.line = line
    if (endLine !== undefined) params.endLine = endLine
    if (sideRaw === 'left') params.side = 'left'
    return { file, line, ...(endLine !== undefined ? { endLine } : {}), side: sideRaw }
  }
  const BAD_INLINE = 'file must be a repo-relative path (no leading /, no ..), line a positive number (the line in the PR\'s new version), endLine a number not below line, side right or left'
  const tooEmpty = (b: string): string | null => {
    const bad = lintReviewText(b)
    return bad ? `action ${k}: ${bad}` : null
  }
  if (k === 'gh-pr-comment' || k === 'gh-pr-review-comment') {
    const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
    const pr = num('pr')
    const body = bodyOf()
    const place = k === 'gh-pr-review-comment' ? inlineOf() : undefined
    if (!GH_REPO.test(repo) || pr === null || body === null) return bad('repo must be owner/name, pr a number and body text')
    if (k === 'gh-pr-review-comment' && !place) return bad(BAD_INLINE)
    const empty = tooEmpty(body)
    if (empty) return refuse(empty)
    params.repo = repo
    params.pr = pr
    params.body = body
    if (place) {
      const anchor: Anchor = { host: 'github', org: '', project: '', repo, pr, ...place }
      const where = whereOf(place)
      const side = place.side === 'left' ? 'LEFT' : 'RIGHT'
      const rest = place.endLine !== undefined && place.endLine !== place.line ? { line: place.endLine, side, start_line: place.line, start_side: side } : { line: place.line, side }
      return { ok: true, kind: k, params, plan: { tool: 'github', method: 'POST', url: `https://api.github.com/repos/${repo}/pulls/${pr}/comments`, contentType: 'application/json', body: json({ body, commit_id: PH_HEAD, path: place.file, ...rest }), headline: `comment on ${where} of GitHub PR ${repo}#${pr}`, text: `comment on ${where} of PR ${pr}: ${body}`, anchor } }
    }
    return { ok: true, kind: k, params, plan: { tool: 'github', method: 'POST', url: `https://api.github.com/repos/${repo}/issues/${pr}/comments`, contentType: 'application/json', body: json({ body }), headline: `comment on GitHub PR ${repo}#${pr}`, text: body } }
  }
  if (k === 'gh-issue-create') {
    // a PUBLIC issue on the lean-agent repo and no other (exactly FEEDBACK_REPO: the repo REPO_URL of feedbackexport.ts lets through the anonymiser; a spec pins both)
    const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
    const title = typeof p.title === 'string' ? p.title.replace(/\s+/g, ' ').trim() : ''
    const text = typeof p.body === 'string' ? p.body.replace(/\r\n?/g, '\n') : ''
    if (repo !== FEEDBACK_REPO) return refuse(`action ${k}: a feedback issue goes to ${FEEDBACK_REPO} only (got ${JSON.stringify(repo.slice(0, 60))}): refused, nothing is posted anywhere else`)
    if (!title || title.length > 120 || !/^[A-Za-z0-9]/.test(title) || CONTROL.test(title)) return refuse(`action ${k}: title is 1 to 120 characters, starting with a letter or digit, no control characters`)
    if (!text.trim() || text.length > ISSUE_BODY_MAX || CONTROL.test(text.replace(/[\n\t]/g, ''))) return refuse(`action ${k}: body is non-empty text of at most ${ISSUE_BODY_MAX} characters`)
    params.repo = repo
    params.title = title
    params.body = text
    return { ok: true, kind: k, params, plan: { tool: 'github', issue: { repo, title, body: text }, method: 'POST', url: `https://github.com/${repo}/issues`, contentType: 'text/markdown', body: JSON.stringify({ title, body: text }), headline: `post a public issue on ${repo}: ${JSON.stringify(title)}`, text: `Title: ${title}\n\n${text}` } }
  }
  if (k === 'gh-pr-review') {
    const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
    const pr = num('pr')
    const word = typeof p.event === 'string' ? p.event.trim().toLowerCase().replace(/[\s_]+/g, '-') : ''
    const body = p.body === undefined ? undefined : bodyOf()
    if (!GH_REPO.test(repo) || pr === null || !Object.prototype.hasOwnProperty.call(GH_EVENTS, word) || body === null) return bad(`repo must be owner/name, pr a number, event one of ${Object.keys(GH_EVENTS).join(', ')} and body text`)
    if (!body && word !== 'approve') return bad(`event ${word} needs a body (one line: what the review found)`)
    Object.assign(params, { repo, pr, event: word })
    if (body) params.body = body
    const event = GH_EVENTS[word]!
    const reply = JSON.stringify({ event, commit_id: PH_HEAD, ...(body ? { body } : {}) })
    return { ok: true, kind: k, params, plan: { tool: 'github', method: 'POST', url: `https://api.github.com/repos/${repo}/pulls/${pr}/reviews`, contentType: 'application/json', body: reply, headline: `submit a ${word} review on GitHub PR ${repo}#${pr}`, text: `review ${event} on PR ${pr} of ${repo}${body ? `: ${body}` : ''}`, ghReview: { repo, pr, event }, vote: true, then: VOTE_THEN[word]! } }
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
  const where0 = `${az.org}/${az.project}`
  if (REVIEW_KINDS.includes(k)) return checkReview(k, p, az, params, bad)
  if (k === 'ado-pr-workitem-link') {
    const repo = name('repo')
    const pr = num('pr')
    const wi = num('workitem')
    if (!repo || pr === null || wi === null) return bad('repo must be a repository name, pr a number and workitem a work item number')
    Object.assign(params, { repo, pr, workitem: wi })
    return { ok: true, kind: k, params, plan: linkPlan(az.base, az.org, az.project, repo, pr, String(wi)) }
  }
  if (k === 'ado-workitem-create') {
    const type = typeof p.type === 'string' ? WI_TYPES.find(t => t.toLowerCase() === (p.type as string).trim().toLowerCase()) : undefined
    const str = (key: string, max: number): string | null | undefined => {
      if (p[key] === undefined) return undefined
      const v = typeof p[key] === 'string' ? (p[key] as string).replace(/\r\n?/g, '\n').trim() : ''
      return v && v.length <= max && !CONTROL.test(v.replace(/[\n\t]/g, '')) ? v : null
    }
    const title = str('title', 255)
    if (!type || !title) return bad(`type must be one of ${WI_TYPES.join(', ')} and title non-empty text of at most 255 characters`)
    params.type = type
    params.title = title
    const ops: { op: string; path: string; value: unknown }[] = [{ op: 'add', path: '/fields/System.Title', value: title }]
    const lines = [`${type}: ${title}`]
    for (const [key, field, max] of [['description', 'System.Description', BODY_MAX], ['area', 'System.AreaPath', FIELD_MAX], ['iteration', 'System.IterationPath', FIELD_MAX], ['assignedTo', 'System.AssignedTo', FIELD_MAX]] as const) {
      const v = str(key, max)
      if (v === null) return bad(`${key} must be non-empty text of at most ${max} characters`)
      if (v === undefined) continue
      params[key] = v
      ops.push({ op: 'add', path: `/fields/${field}`, value: v })
      lines.push(`${key}: ${v}`)
    }
    const parent = p.parent === undefined ? undefined : num('parent')
    if (parent === null) return bad('parent must be a work item number')
    if (parent !== undefined) {
      params.parent = parent
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${enc(az.org)}/_apis/wit/workItems/${parent}` } })
      lines.push(`parent: work item ${parent}`)
    }
    const prs: number[] = []
    if (p.links !== undefined) {
      const list = Array.isArray(p.links) ? p.links : null
      for (const l of list ?? []) {
        const keys = l && typeof l === 'object' ? Object.keys(l) : []
        const n = keys.length === 1 && keys[0] === 'pr' ? int((l as { pr?: unknown }).pr) : null
        if (n === null) return bad('links must be a list of {pr: <number>}')
        prs.push(n)
      }
      if (!list || !prs.length || prs.length > 3) return bad('links must be one to three {pr: <number>}')
      params.links = prs.map(pr => ({ pr }))
    }
    const repo = p.repo === undefined ? undefined : name('repo')
    if (repo === null || (prs.length && !repo) || (repo && !prs.length)) return bad('repo (a repository name) goes with links, and only with them')
    if (repo) params.repo = repo
    const create: Plan = { tool: 'azure', method: 'POST', url: `${az.base}/_apis/wit/workitems/$${enc(type)}?api-version=7.1`, contentType: 'application/json-patch+json', body: json(ops), headline: `create a ${type} work item (${where0})`, text: lines.join('\n'), tag: 'create' }
    if (!prs.length) return { ok: true, kind: k, params, plan: create }
    const steps = [create, ...prs.map(pr => ({ ...linkPlan(az.base, az.org, az.project, repo!, pr, PH_NEW), tag: `link PR ${pr}` }))]
    return { ok: true, kind: k, params, plan: { ...create, url: steps.map(s => s.url).join(' ; '), headline: `create a ${type} work item and link it to PR ${prs.join(', ')} (${where0}/${repo})`, text: `${create.text}\nthen link it to PR ${prs.join(', ')} of ${repo}`, tag: undefined, steps } }
  }
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
  const place = inlineOf()
  if (place === null) return bad(BAD_INLINE)
  const empty = tooEmpty(body)
  if (empty) return refuse(empty)
  params.body = body
  // the thread's own fields (Azure DevOps 7.1): status at creation (1..6), the comment type (1 text, 2 codeChange), the parent comment (0 = a new comment)
  const statusRaw = p.status === undefined ? undefined : typeof p.status === 'string' ? p.status.trim().toLowerCase() : null
  const statusName = statusRaw ? THREAD_STATUS[statusRaw] : undefined
  const typeRaw = p.commentType === undefined ? undefined : typeof p.commentType === 'string' ? COMMENT_TYPES[p.commentType.trim().toLowerCase()] : p.commentType === 1 || p.commentType === 2 ? p.commentType : undefined
  const parent = p.parentCommentId === undefined ? undefined : typeof p.parentCommentId === 'number' && Number.isInteger(p.parentCommentId) && p.parentCommentId >= 0 && p.parentCommentId < 1e9 ? p.parentCommentId : null
  const offset = p.offset === undefined ? undefined : num('offset')
  const offsetEnd = p.offsetEnd === undefined ? undefined : num('offsetEnd')
  const iteration = p.iteration === undefined ? undefined : num('iteration')
  const changeId = p.changeTrackingId === undefined ? undefined : num('changeTrackingId')
  if (statusRaw === null || (statusRaw && !statusName) || (p.commentType !== undefined && typeRaw === undefined) || parent === null || offset === null || offsetEnd === null || iteration === null || changeId === null) return bad(`status must be one of ${STATUS_NAMES}, commentType text or codeChange, parentCommentId a number (0 = new), offset and offsetEnd positive numbers, iteration and changeTrackingId positive numbers`)
  if (!place && (offset !== undefined || offsetEnd !== undefined || iteration !== undefined || changeId !== undefined)) return bad('offset, offsetEnd, iteration and changeTrackingId go with file and line (an inline comment)')
  if (changeId !== undefined && iteration === undefined) return bad('changeTrackingId goes with iteration')
  if (statusName) params.status = statusName
  if (typeRaw !== undefined) params.commentType = typeRaw === 2 ? 'codeChange' : 'text'
  if (parent !== undefined) params.parentCommentId = parent
  if (offset !== undefined) params.offset = offset
  if (offsetEnd !== undefined) params.offsetEnd = offsetEnd
  if (iteration !== undefined) params.iteration = iteration
  if (changeId !== undefined) params.changeTrackingId = changeId
  const comments = [{ parentCommentId: parent ?? 0, content: body, commentType: typeRaw ?? 1 }]
  const statusNum = statusName ? STATUS_CODES[statusName]! : 1
  if (place) {
    // an inline comment: a NEW thread whose threadContext names the file and the line (the old version's with side left), and whose pullRequestThreadContext names the
    // iteration it follows (the latest, read at send time, unless iteration is given) and the file's changeTrackingId in it (read then too, unless given)
    const at = { line: place.line, offset: offset ?? 1 }
    const end = { line: place.endLine ?? place.line, offset: offsetEnd ?? 1 }
    const threadContext = { filePath: `/${place.file}`, ...(place.side === 'left' ? { leftFileStart: at, leftFileEnd: end } : { rightFileStart: at, rightFileEnd: end }) }
    const pullRequestThreadContext = { iterationContext: { firstComparingIteration: iteration ?? PH_ITER, secondComparingIteration: iteration ?? PH_ITER }, changeTrackingId: changeId ?? PH_CHANGE }
    const anchor: Anchor = { host: 'azure', org: az.org, project: az.project, repo, pr, ...place, ...(iteration !== undefined ? { iteration } : {}) }
    const w = whereOf(place)
    return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'POST', url: `${prs}/threads?api-version=7.1`, contentType: 'application/json', body: json({ comments, status: statusNum, threadContext, pullRequestThreadContext }), headline: `comment on ${w} of PR ${pr} (${where})`, text: `comment on ${w} of PR ${pr}${statusName && statusName !== 'active' ? ` (thread ${statusName})` : ''}: ${body}`, anchor } }
  }
  return { ok: true, kind: k, params, plan: { tool: 'azure', method: 'POST', url: `${prs}/threads?api-version=7.1`, contentType: 'application/json', body: json({ comments, status: statusNum }), headline: `post a new comment on PR ${pr} (${where})`, text: statusName && statusName !== 'active' ? `${body}\n\n(thread created as ${statusName})` : body } }
}

// a batch: up to BATCH_MAX checked items for ONE target; the plan holds every write flat and in order, numbered by item
export const targetOf = (kind: ActionKind, p: Params): string =>
  kind === 'gh-issue-create' ? `a public issue on ${p.repo}` : kind === 'ado-workitem-create' ? `Azure DevOps work item ${p.org}/${p.project}#new` : kind.startsWith('ado-workitem') ? `Azure DevOps work item ${p.org}/${p.project}#${p.id}` : kind.startsWith('ado-pr') ? `Azure DevOps PR ${p.org}/${p.project}/${p.repo}#${p.pr}` : `GitHub PR ${p.repo}#${p.pr}`
function checkBatch(x: Record<string, unknown>, opts: CheckOpts = {}): Checked {
  const p = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? (x.params as Params) : null
  if (p) for (const key of Object.keys(p)) if (!PARAM_KEYS.batch.includes(key)) return refuse(`action batch: unknown param "${key.slice(0, 30)}" (the batch takes items and continueOnError)`)
  const items = Array.isArray(x.items) ? x.items : p && Array.isArray(p.items) ? p.items : null
  if (!items || !items.length) return refuse(`action batch needs items: [{kind, params}, ...] (1 to ${BATCH_MAX}, of the other kinds: ${kindsText()})`)
  // a batch of ONLY PR comments (one PR, checked below) is a review: up to COMMENT_BATCH_MAX; every other mix stays at BATCH_MAX
  const kindOf = (it: unknown): string => (it && typeof it === 'object' && typeof (it as { kind?: unknown }).kind === 'string' ? ((it as { kind: string }).kind).trim() : '')
  const isComment = (it: unknown): boolean => COMMENT_KINDS.includes(kindOf(it))
  // 1.0.31: PR comments may end with exactly ONE vote / review item for the same PR (comments first, then the vote): up to COMMENT_BATCH_MAX + 1 items
  const withVote = items.length > 1 && VOTE_KINDS.includes(kindOf(items[items.length - 1])) && items.slice(0, -1).every(isComment)
  const commentsOnly = withVote || items.every(isComment)
  const limit = withVote ? COMMENT_BATCH_MAX + 1 : commentsOnly ? COMMENT_BATCH_MAX : BATCH_MAX
  if (items.length > limit) return refuse(`action batch holds at most ${limit} items (got ${items.length}${commentsOnly ? '' : `; only a batch of PR comments for one PR may hold up to ${COMMENT_BATCH_MAX}`})${!commentsOnly && items.some(it => VOTE_KINDS.includes(kindOf(it))) ? ` (such a batch may end with ONE vote item, ${VOTE_KINDS.join(' or ')}, as the LAST item)` : ''}: split it in two requests`)
  const co = x.continueOnError ?? p?.continueOnError
  if (co !== undefined && typeof co !== 'boolean') return refuse('action batch: continueOnError must be true or false')
  const cont = co ?? commentsOnly
  const checked: Extract<Checked, { ok: true }>[] = []
  for (const [i, it] of items.entries()) {
    const kind = it && typeof it === 'object' ? (it as { kind?: unknown }).kind : undefined
    if (kind === 'batch') return refuse(`batch item ${i + 1}: a batch cannot hold a batch`)
    if (typeof kind === 'string' && DESK_ONLY_KINDS.includes(kind.trim())) return refuse(`batch item ${i + 1}: ${kind.trim()} is its own request, never part of a batch`)
    const c = checkAction(it, opts)
    if (!c.ok) return refuse(`batch item ${i + 1}: ${c.text}`)
    checked.push(c)
  }
  // (a PR <-> work item link belongs to both its PR and its work item: it can share a batch with a state change of that work item)
  const keys = (c: Extract<Checked, { ok: true }>): string[] => (c.kind === 'ado-pr-workitem-link' ? [targetOf(c.kind, c.params), targetOf('ado-workitem-update', { org: c.params.org, project: c.params.project, id: c.params.workitem })] : [targetOf(c.kind, c.params)])
  const first = keys(checked[0]!)
  const target = first[0]!
  for (const [i, c] of checked.entries()) {
    const t = keys(c)[0]!
    if (!keys(c).some(k => first.includes(k))) return refuse(`batch item ${i + 1} is for another target (${t}; item 1 is ${target}): one batch is for ONE PR or ONE work item, make a second request`)
  }
  const steps: Plan[] = checked.flatMap((c, i) => (c.plan.steps ?? [c.plan]).map(s => ({ ...s, tag: c.plan.steps ? `${i + 1} ${s.tag}` : `${i + 1}`, vote: withVote && i === checked.length - 1 ? true : undefined })))
  const n = checked.length
  // a review (some inline comment, or more than BATCH_MAX): numbered, grouped by file, each with its anchor and text; every other batch keeps the write-by-write text
  const review = commentsOnly && (withVote || n > BATCH_MAX || checked.some(c => c.plan.anchor))
  const then = withVote ? checked[n - 1]!.plan.then : undefined // the vote item is listed last: "then: set the PR to Waiting for author"
  const nc = withVote ? n - 1 : n
  const list: ReviewItem[] = review ? checked.slice(0, nc).map((c, i) => ({ n: i + 1, file: c.plan.anchor?.file ?? '', where: c.plan.anchor ? whereOf(c.plan.anchor) : 'PR comment', text: String(c.params.body) })) : []
  const text = review ? `${reviewListing(list)}${then ? `\nthen: ${then}` : ''}` : checked.map((c, i) => `${i + 1}/${n} ${c.plan.headline}\n${c.plan.text}\n→ ${(c.plan.steps ?? [c.plan]).map(s => `${s.method} ${s.url}`).join(' ; ')}`).join('\n\n')
  return {
    ok: true,
    kind: 'batch',
    params: { items: checked.map(c => ({ kind: c.kind, params: c.params })), ...(co !== undefined || commentsOnly ? { continueOnError: cont } : {}) },
    plan: { ...steps[0]!, url: review ? [...new Set(steps.map(s => s.url))].join(' ; ') : steps.map(s => s.url).join(' ; '), headline: `${review ? `post ${nc} review comment${nc === 1 ? '' : 's'}${then ? `, then ${then}` : ''}` : `do ${n} write${n === 1 ? '' : 's'}`} on ${target}, in this order`, text, tag: undefined, steps, cont, ...(review ? { items: list } : {}), ...(then ? { then } : {}), anchor: undefined },
  }
}
// the numbered list of a review batch, grouped by file (first appearance), `cutAt` shortens each text for the question (the card shows all of it)
export function reviewListing(items: ReviewItem[], cutAt?: number): string {
  const groups = new Map<string, ReviewItem[]>()
  for (const it of items) groups.set(it.file, [...(groups.get(it.file) ?? []), it])
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  return [...groups].map(([file, list]) => `${file || 'General comments (no file)'} (${list.length})\n${list.map(it => `  ${it.n}. ${it.where}: ${cutAt ? cut(flat(it.text), cutAt) : flat(it.text)}`).join('\n')}`).join('\n')
}

// ---- the stored request ---------------------------------------------------------------------------------------------------------------
// `exit` (1.0.31): how and why the request left the pending list (set once, never removed: the record stays as evidence)
// 1.0.33 'failed': the server answered the send with an error status (HTTP 400 ...) and nothing was written: "failed (HTTP 400): <short body>", never approved-and-waiting again; the thread asks with a NEW request
export type RequestExit = { kind: 'executed' | 'denied' | 'expired' | 'withdrawn' | 'edit' | 'failed'; reason: string; ts: number }
export type ActionRequest = { id: string; thread: string; kind: ActionKind; params: Params; why: string; hash: string; ts: number; exp: number; sig: string; exit?: RequestExit }
// `via` (1.0.31): where the answer came from when it was not the plain press of an option: the user's typed words in the dialog
export type Answer = { id: string; hash: string; answer: 'approve' | 'deny' | 'edit'; by: 'ask' | 'pane' | 'standing'; ts: number; sig: string; via?: 'typed' }
export type ActionState = 'pending' | 'approved' | 'denied' | 'edit' | 'used' | 'expired' | 'withdrawn' | 'failed'
// a request as the desk and the pane see it (never carries a signature)
export type ActionView = { id: string; thread: string; kind: ActionKind; why: string; headline: string; text: string; target: string; hash: string; ts: number; exp: number; state: ActionState; writes?: number /* a batch or a reply with a status: how many writes one Approve covers */; standing?: boolean /* a status change that may carry the third choice (standing approval for this PR) */; anchors?: number /* inline comments whose line was checked against the PR diff */; items?: ReviewItem[] /* a review batch: its comments */; cont?: boolean /* a failing item does not stop the rest */; then?: string /* a review batch ending with a vote: what it does after the comments */; fallback?: string /* this kind failed twice: a command for the user's own shell and why the thread cannot run it (actionfallback.ts) */ }

// ---- standing approval: ONLY a status change carries it (never text) ------------------------------------------------------------------------
// The kinds and statuses that can be covered: a thread status to fixed / closed / active, a GitHub review thread resolved. Never a reply, a comment, a
// work item update or any other status; a batch is covered only when EVERY item is one of these and covered.
// Only the Azure DevOps status change: its PR is part of the write's URL, so the scope a grant names is the scope that is written. A GitHub
// review-thread resolve carries only the thread's node id (the PR it names cannot be checked from the request), so it is always asked.
export const STANDING_KINDS: ActionKind[] = ['ado-pr-thread-status']
export const STANDING_STATUSES = ['fixed', 'closed', 'active']
export const STANDING_TTL_MS = 24 * 60 * 60 * 1000
// 1.0.28 (the dialog's fourth choice): the same choice for every kind of the own-PR default's table (reply, GitHub comment, link of a PR, state of a work item) and for
// the status kinds, as a HUMAN choice: replies WITH a status (fixed / closed / active) and a GitHub review thread resolve too. A thread status change keeps its
// 1.0.24 grant (below); every other kind is a written approval of the same signed machinery as the user's words (deskwrites.ts writeHumanGrant: 24 h, the request's
// own PR or work item, at most 40 writes, Revoke in the pane), made by the hook `setHumanGrantWriter` registered there.
export const STANDING_LABEL = 'Approve, and allow this kind on this PR for 24 h'
export const STANDING_LABEL_WI = 'Approve, and allow this kind on this work item for 24 h'
export const standingLabelOf = (kind: string): string => (kind.startsWith('ado-workitem') ? STANDING_LABEL_WI : STANDING_LABEL)
export const HUMAN_WI_STATES = ['Reviewing', 'Active', 'In Progress', 'Resolved']
export const statusStanding = (kind: ActionKind, p: Params): boolean => kind === 'ado-pr-thread-status' && STANDING_STATUSES.includes(String(p.status))
const itemEligible = (kind: unknown, p: Params): boolean => {
  if (kind === 'ado-pr-thread-status') return statusStanding(kind, p)
  if (kind === 'ado-pr-reply') return p.status === undefined || STANDING_STATUSES.includes(String(p.status))
  if (kind === 'gh-pr-comment' || kind === 'ado-pr-workitem-link' || kind === 'gh-pr-thread-resolve') return true
  if (kind === 'ado-workitem-update') {
    const f = p.fields && typeof p.fields === 'object' ? (p.fields as Record<string, unknown>) : null
    return !!f && Object.keys(f).length === 1 && typeof f.state === 'string' && HUMAN_WI_STATES.some(s => s.toLowerCase() === (f.state as string).toLowerCase())
  }
  return false
}
export const standingEligible = (kind: ActionKind, p: Params): boolean => {
  if (kind !== 'batch') return itemEligible(kind, p)
  const items = Array.isArray(p.items) ? (p.items as { kind?: unknown; params?: Params }[]) : []
  return items.length > 0 && items.every(it => itemEligible(it?.kind, it?.params ?? {}))
}
// where a standing choice came from, written into the grant's own record (1.0.31): the pane's button, the dialog's fourth option, or the user's typed words
export type Via = { how: 'pane' | 'dialog' | 'typed'; words?: string }
let humanGrant: null | ((h: Host, r: ActionRequest, now: number, via: Via) => Promise<boolean>) = null
export const setHumanGrantWriter = (f: typeof humanGrant): void => {
  humanGrant = f
}

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
// Room is made by dropping the OLDEST FINISHED requests (one with an exit); an open request is never dropped for room (1.0.31)
function pruned(all: ActionRequest[]): ActionRequest[] {
  let extra = all.length - ACTIONS_MAX
  if (extra <= 0) return all
  return all.filter(r => {
    if (extra > 0 && r.exit) {
      extra--
      return false
    }
    return true
  })
}
const save = (h: Host, all: ActionRequest[]) => h.store.set(REQUESTS, pruned(all))

// ---- how a request leaves the pending list (1.0.31): executed, denied, expired or withdrawn, each written to its record with the reason and the time ----------------------------
// A non-executed exit says so in one line to the thread AND to the desk (a notice: the pane lists it, the desk reads it); markExit runs inside the gate, announceExit after it.
export const exitLine = (r: Pick<ActionRequest, 'id'>, e: Pick<RequestExit, 'kind' | 'reason'>): string =>
  e.kind === 'executed' ? `request ${r.id} executed: ${e.reason}` : e.kind === 'denied' ? `request ${r.id} denied: nothing was sent` : e.kind === 'expired' ? `request ${r.id} expired unsent: ${e.reason}` : e.kind === 'edit' ? `request ${r.id} not sent: ${e.reason}` : e.kind === 'failed' ? `request ${r.id} failed (${e.reason})` : `request ${r.id} withdrawn unsent: ${e.reason}`
async function markExit(h: Host, id: string, exit: RequestExit): Promise<ActionRequest | null> {
  const all = await rows(h)
  const r = all.find(x => x.id === id)
  if (!r || r.exit) return null
  await save(h, all.map(x => (x.id === id ? { ...x, exit } : x)))
  return { ...r, exit }
}
async function announceExit(h: Host, r: ActionRequest, tell?: Tell, toThread = true): Promise<void> {
  const e = r.exit!
  await logHistory(h, r.thread, { kind: 'action-exit', id: r.id, action: r.kind, exit: e.kind, reason: e.reason.slice(0, 200) })
  if (e.kind === 'executed') return
  const line = exitLine(r, e)
  await setNotice(h, `request-exit.${r.id}`, `${r.thread}: ${line}`)
  if (e.kind === 'failed' && (await failuresOf(h, r.thread, r.kind)).n >= FALLBACK_AFTER && (await fallbackOf(h, r).catch(() => null))) await setNotice(h, `request-fallback.${r.thread}.${r.kind}`, `${r.thread}: ${r.kind} failed twice. A command to run in your own shell is in the desk's action list (lean_thread action-list) and on the next request card of that kind`)
  if (toThread && tell) await tell(r.thread, `Your ${line}.${e.kind === 'expired' || e.kind === 'withdrawn' ? ' Send it again as a NEW request if it is still needed, or continue without it.' : e.kind === 'failed' ? ' Nothing was written. If it is still needed make a NEW request (the reason above says what the server did not accept: fix that field first), or continue without it.' : ''}`).catch(() => undefined)
}
// the config key actions.pendingHours (default 24): how long a request waits for the user's decision, fixed when it is made
export async function pendingMsOf(h: Host): Promise<number> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const raw = cfg && typeof cfg === 'object' ? (cfg.actions?.pendingHours ?? cfg['actions.pendingHours']) : undefined
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return (Number.isFinite(n) && n >= 0.05 && n <= 720 ? n : 24) * 3_600_000
}
// every request whose time ran out without being sent leaves the list as expired, with its reason, and the thread and the desk are told. Returns the lines.
export async function sweepExpired(h: Host, tell?: Tell): Promise<string[]> {
  const now = await h.clock.now()
  const done: ActionRequest[] = []
  await exclusive(async () => {
    for (const r of await rows(h)) {
      if (r.exit || now <= r.exp || (await usedOf(h, r.id))) continue
      const a = await answerOf(h, r)
      if (a && a.answer !== 'approve') continue
      const reason = a ? `approved, but never sent within ${hoursOf(r)} h` : `nobody decided in ${hoursOf(r)} h`
      const m = await markExit(h, r.id, { kind: 'expired', reason, ts: now })
      if (m) done.push(m)
    }
  })
  for (const r of done) await announceExit(h, r, tell)
  return done.map(r => exitLine(r, r.exit!))
}
// withdraw a request that is still waiting (the desk's withdraw-action, or the user's typed words): it leaves unsent, with the reason, and the thread is told
export async function withdrawAction(h: Host, id: string, reason: string, tell?: Tell): Promise<{ ok: boolean; text: string }> {
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!idOk(id)) return { ok: false, text: 'withdraw-action needs the request id (like a1700000000000-1, from lean_thread action-list)' }
  if (!why) return { ok: false, text: `withdraw-action needs a reason (the user's words, for example "you rejected it in chat"): request ${id} stays as it is` }
  const res = await exclusive(async () => {
    const r = (await rows(h)).find(x => x.id === id)
    if (!r) return { ok: false as const, text: `no request ${id} (never made, or already cleared): nothing to withdraw` }
    const now = await h.clock.now()
    const st = await stateOf(h, r, now)
    if (st !== 'pending' && st !== 'approved') return { ok: false as const, text: `request ${id} is ${stateWhy(r, st)}: nothing to withdraw` }
    const m = await markExit(h, id, { kind: 'withdrawn', reason: why, ts: now })
    return m ? { ok: true as const, r: m } : { ok: false as const, text: `request ${id} already left the list: nothing to withdraw` }
  })
  if (!res.ok) return res
  await announceExit(h, res.r, tell)
  return { ok: true, text: `withdrew ${id} (${res.r.kind}) unsent: ${why}; ${res.r.thread} was told` }
}
// the user's own typed words ("withdraw a1700000000000-1 ..."), from a recorded human prompt only: the named request that is still waiting is withdrawn, the words are the reason
export async function withdrawByWords(h: Host, text: string, tell?: Tell): Promise<number> {
  if (!/(?<![\w-])(withdraw|withdrawn|retract)(?![\w-])/i.test(text)) return 0
  let n = 0
  for (const id of new Set([...text.matchAll(/(?<![\w-])a\d{1,16}-\d{1,9}(?![\w-])/g)].map(m => m[0]))) {
    if ((await withdrawAction(h, id, `you said so: "${text.replace(/\s+/g, ' ').trim().slice(0, 100)}"`, tell)).ok) n++
  }
  return n
}

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
  if (r.exit?.kind === 'failed') return 'failed'
  if (await usedOf(h, r.id)) return 'used'
  if (r.exit?.kind === 'withdrawn') return 'withdrawn'
  const a = await answerOf(h, r)
  if (a?.answer === 'deny') return 'denied'
  if (a?.answer === 'edit') return 'edit'
  if (now > r.exp) return 'expired'
  return a ? 'approved' : 'pending'
}

// why an answer cannot be recorded for a request in this state (the reason code of a refusal, 1.0.31)
export const stateWhy = (r: ActionRequest, st: ActionState): string =>
  st === 'used' ? `already resolved (executed${r.exit?.kind === 'executed' ? `: ${r.exit.reason}` : ''})`
  : st === 'denied' ? 'already resolved (denied)'
  : st === 'expired' ? `already resolved (expired after ${hoursOf(r)} h)`
  : st === 'withdrawn' ? `already resolved (withdrawn: ${r.exit?.reason ?? 'no reason given'})`
  : st === 'failed' ? `already resolved (failed: ${r.exit?.reason ?? 'the send failed'}; the thread sends a NEW request)`
  : st === 'edit' ? 'already resolved (the user asked to edit it first: the thread sends a NEW request)'
  : st === 'approved' ? 'not pending (already approved and waiting to be sent: lean_thread approve-action sends it)'
  : st
const hoursOf = (r: Pick<ActionRequest, 'ts' | 'exp'>): number => Math.round(((r.exp - r.ts) / 3_600_000) * 10) / 10
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
export async function viewOf(h: Host, r: ActionRequest, now: number): Promise<ActionView | null> {
  const plan = await sound(h, r)
  if (!plan) return null
  // an inline comment's line was read against the PR's diff before this request existed (addActionRequest): the card and the question say so
  const anchors = (plan.steps ?? [plan]).filter(s => s.anchor).length
  return { id: r.id, thread: r.thread, kind: r.kind, why: r.why, headline: plan.headline, text: anchors ? `${plan.text}\n(${ANCHOR_NOTE})` : plan.text, target: plan.url, hash: r.hash, ts: r.ts, exp: r.exp, state: await stateOf(h, r, now), ...(plan.steps ? { writes: plan.steps.length } : {}), ...(standingEligible(r.kind, r.params) ? { standing: true } : {}), ...(anchors ? { anchors } : {}), ...(plan.items ? { items: plan.items } : {}), ...(plan.then ? { then: plan.then } : {}), ...(plan.cont ? { cont: true } : {}), ...(await fallbackOf(h, r).then(f => (f ? { fallback: f } : {}), () => ({}))) }
}
// A kind that failed twice for a thread (1.0.33, actionfallback.ts): the requests of that thread and kind that closed as failed in the last 24 h, plus the failed send attempts of an
// approved request that is still open (its history says action-failed). The desk's own requests (gh-issue-create, thread t0) have no history folder: only their closed rows count.
export const FALLBACK_AFTER = 2
export async function failuresOf(h: Host, thread: string, kind: string): Promise<{ n: number; last?: ActionRequest }> {
  if (!(FALLBACK_KINDS as readonly string[]).includes(kind)) return { n: 0 }
  const now = await h.clock.now()
  const mine = (await rows(h)).filter(r => r.thread === thread && r.kind === kind)
  const hist = thread === DESK_THREAD ? [] : await readJsonl<{ kind?: string; id?: string }>(h, `${threadsDir(await homeDir(h))}/${thread}/history.jsonl`).catch(() => [] as { kind?: string; id?: string }[])
  let n = 0
  let last: ActionRequest | undefined
  for (const r of mine) {
    const k = r.exit ? (r.exit.kind === 'failed' && now - r.exit.ts <= 24 * 3_600_000 ? 1 : 0) : hist.filter(x => x && x.id === r.id && x.kind === 'action-failed').length
    if (k) {
      n += k
      last = r
    }
  }
  return { n, ...(last ? { last } : {}) }
}
// the fallback block for this request (null: the kind has none, it did not fail twice, or a value looks like a secret)
export async function fallbackOf(h: Host, r: ActionRequest): Promise<string | null> {
  const f = await failuresOf(h, r.thread, r.kind)
  return f.n >= FALLBACK_AFTER ? fallbackText(r.kind, r.params as Record<string, unknown>, f.n) : null
}
// the requests that are not finished (the desk's list and the pane): pending, approved but not sent yet, and expired ones until they are told
export async function listActions(h: Host, all = false): Promise<ActionView[]> {
  await reconcileFailed(h) // an approved request an older version left after an HTTP failure is shown (and closed) as failed
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
export function questionOf(v: Pick<ActionView, 'id' | 'thread' | 'headline' | 'text' | 'target' | 'hash'> & { writes?: number; standing?: boolean; kind?: string; anchors?: number; items?: ReviewItem[]; cont?: boolean; then?: string }):{ question: string; options: { label: string; description: string }[] } {
  // a review batch: numbered, grouped by file, each text cut at QUESTION_TEXT_MAX here (the card shows all of it)
  const shown = v.items ? `${reviewListing(v.items, QUESTION_TEXT_MAX)}${v.items.some(i => i.text.replace(/\s+/g, ' ').trim().length > QUESTION_TEXT_MAX) ? `\n(texts are cut at ${QUESTION_TEXT_MAX} characters here: the full text of each is on the card in the pane)` : ''}${v.then ? `\nthen: ${v.then}` : ''}${v.anchors ? `\n(${ANCHOR_NOTE})` : ''}` : v.text
  const standing = v.standing ? [{ label: standingLabelOf(v.kind ?? ''), description: `the desk sends exactly this text, once; and ${v.thread}'s later writes of this kind on this ${(v.kind ?? '').startsWith('ado-workitem') ? 'work item' : 'PR'} (statuses only fixed, closed, active) are sent without asking, for 24 h, at most 40, or until it closes (Revoke in the pane)` }] : []
  return {
    question: `${v.thread === DESK_THREAD ? 'the desk' : v.thread} wants to ${v.headline} [request ${v.id}, check ${checkCode(v.hash)}]. The exact text that will be sent:\n---\n${shown}\n---\nTarget: ${v.target}\nSend exactly this?`,
    options: [
      { label: 'Approve', description: v.writes && v.writes > 1 ? `the desk sends exactly these ${v.writes} writes, in this order, once; ${v.cont ? 'a failing one is reported and the rest still run' : 'it stops at the first failure'}` : 'the desk sends exactly this text, once' },
      v.thread === DESK_THREAD ? { label: 'Deny', description: 'nothing is posted; the export stays where it was written' } : { label: 'Deny', description: `${v.thread} is told it was denied and goes on without it` },
      v.thread === DESK_THREAD ? { label: 'Edit first', description: 'nothing is posted; say what to change, then export again' } : { label: 'Edit first', description: `nothing is sent; tell ${v.thread} what to change, it sends a NEW request` },
      ...standing,
    ],
  }
}

export const logHistory = async (h: Host, thread: string, rec: Record<string, unknown>): Promise<void> => {
  if (thread === DESK_THREAD) return // the desk's own requests have no thread folder
  const home = await homeDir(h)
  await appendJsonl(h, `${threadsDir(home)}/${thread}/history.jsonl`, { ts: await h.clock.now(), ...rec }).catch(() => undefined)
}
export type Tell = (thread: string, text: string) => Promise<void>

// an approval (ado-pr-vote approve | approve-with-suggestions, gh-pr-review approve) of the PR the thread itself opened: the refusal text, or null
async function ownApproval(h: Host, thread: string, kind: ActionKind, params: Params): Promise<string | null> {
  const raw = kind === 'batch' ? (Array.isArray(params.items) ? (params.items as { kind?: unknown; params?: Params }[]) : []) : [{ kind, params }]
  const approving = raw.filter(it => (it.kind === 'ado-pr-vote' && String(it.params?.vote).startsWith('approve')) || (it.kind === 'gh-pr-review' && it.params?.event === 'approve'))
  if (!approving.length) return null
  const t = await readJson<{ pr?: { host?: string; org?: string; project?: string; repo?: string; id?: number; url?: string } }>(h, `${threadsDir(await homeDir(h))}/${thread}/thread.json`, {}).catch(() => ({}) as { pr?: undefined })
  const pr = t?.pr
  if (!pr || typeof pr.id !== 'number') return null
  const lc = (s: unknown) => String(s ?? '').toLowerCase()
  const own = approving.some(it => {
    const p = it.params ?? {}
    return it.kind === 'ado-pr-vote' ? pr.host === 'azure' && lc(pr.org) === lc(p.org) && lc(pr.project) === lc(p.project) && lc(pr.repo) === lc(p.repo) && pr.id === p.pr : lc(pr.url).includes(`${lc(p.repo)}/pull/${String(p.pr)}`)
  })
  return own ? `${thread} opened this PR for the user: the mod never approves it (no approve vote on your own PR); report the review result to the user instead` : null
}

// ---- a thread asks ---------------------------------------------------------------------------------------------------------------------------
export async function addActionRequest(h: Host, thread: string, a: { kind?: unknown; params?: unknown; items?: unknown; why?: unknown }): Promise<{ ok: boolean; text: string; request?: ActionView }> {
  if (!threadOk(thread)) return { ok: false, text: 'an action request comes from a thread (tN)' }
  // the desk's own kinds (a public issue) are made by the mod for the desk only; a thread asking for one, or the desk asking for a thread's kind, is refused
  if (DESK_ONLY_KINDS.includes(typeof a.kind === 'string' ? a.kind.trim() : '') !== (thread === DESK_THREAD)) return { ok: false, text: thread === DESK_THREAD ? 'the desk makes only its own request kinds this way' : `${typeof a.kind === 'string' ? a.kind.trim().slice(0, 40) : 'that kind'} is not one a thread may ask for` }
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const c = checkAction(a, { severity: checkOn(cfg, 'review', 'severity') })
  if (!c.ok) return { ok: false, text: c.text }
  // 1.0.31: the PR this thread opened is the user's work: the mod never approves it (nor completes it: that kind does not exist)
  const mine = await ownApproval(h, thread, c.kind, c.params)
  if (mine) return { ok: false, text: mine }
  // an inline comment is shown to the user only after its line was read against the PR's diff now (checked again right before it is sent)
  const anchored = anchorsOf(c.plan)
  if (anchored.length) {
    const seen = await verifyAnchors(readerOf(h), thread, anchored.map(s => s.anchor!))
    const bad = anchored.map((s, i) => ({ tag: s.tag, text: seen.refusals[i] })).filter(b => b.text)
    if (bad.length) return { ok: false, text: c.plan.steps ? `${bad.map(b => `batch item ${b.tag}: ${b.text}`).join('\n')}\nnothing was sent and nothing was shown to the user: drop or fix ${bad.length === 1 ? 'this item' : `these ${bad.length} items`}, then send the batch again` : bad[0]!.text! }
  }
  // only YOUR tasks are moved (owntask.ts, reads from the forge): a PR link / state change of a work item that is not assigned to the user, or for a PR the user did not create,
  // is refused here with exactly the reason, and nothing is shown to the user
  const notMine = await checkMove(h, c.kind, c.params).catch(() => 'could not verify the owner/assignee: not moving it')
  if (notMine) return { ok: false, text: notMine }
  // a create is checked against what the task already has (workitemflow.ts): a stored work item refuses it; the closest known items are shown to the user in the card
  const dup = c.kind === 'ado-workitem-create' ? await createCheck(h, thread, c.params).catch(() => null) : null
  if (dup?.refuse) return { ok: false, text: dup.refuse }
  const hash = hashOf(renderingOf(c.plan))
  const why = [dup?.note, typeof a.why === 'string' ? a.why : ''].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim().slice(0, 400)
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
    const base = { id: `a${ts}-${++seq}`, thread, kind: c.kind, hash, ts, exp: ts + (await pendingMsOf(h)) }
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
export async function answerAction(h: Host, id: string, answer: 'approve' | 'deny' | 'edit', by: 'ask' | 'pane', tell?: Tell, standing = false, via?: Via): Promise<{ ok: boolean; text: string }> {
  const rec = await exclusive(async () => {
    const r = (await rows(h)).find(x => x.id === id)
    if (!r) return { ok: false as const, text: `no request ${id}: never made, or already cleared` }
    const now = await h.clock.now()
    if (!(await sound(h, r))) return { ok: false as const, text: `request ${id} does not verify (not signed by this mod, or its text changed): refused` }
    const st = await stateOf(h, r, now)
    if (st !== 'pending') return { ok: false as const, text: `request ${id} is ${stateWhy(r, st)}: no answer recorded` }
    if (standing && (answer !== 'approve' || !standingEligible(r.kind, r.params))) return { ok: false as const, text: `request ${id} cannot carry a standing approval (only a reply, a GitHub comment, a PR link, a thread status of fixed, closed or active, a GitHub thread resolve or a work item state of Reviewing, Active, In Progress or Resolved, or a batch of those): no answer recorded` }
    const src: Via = via ?? { how: by === 'pane' ? 'pane' : 'dialog' }
    const base = { id: r.id, hash: r.hash, answer, by, ts: now }
    const sig = await macOf(h, answerText(base), true)
    if (!sig) return { ok: false as const, text: 'no key to sign the answer with' }
    await h.store.set(answerKey(r.id), { ...base, sig, ...(src.how === 'typed' ? { via: 'typed' as const } : {}) } satisfies Answer)
    // a Deny and an Edit first end the request here, with the reason on its record (an Approve ends it when it is sent: approveAction)
    const left = answer === 'deny' ? await markExit(h, r.id, { kind: 'denied', reason: 'you denied it', ts: now }) : answer === 'edit' ? await markExit(h, r.id, { kind: 'edit', reason: 'you asked to edit it first: the thread sends a NEW request', ts: now }) : null
    if (standing && !(statusStanding(r.kind, r.params) ? await writeGrant(h, r, now, src) : humanGrant ? await humanGrant(h, r, now, src) : false)) return { ok: true as const, r, left, noGrant: true }
    return { ok: true as const, r, left }
  })
  if (!rec.ok) return rec
  const { r, left } = rec
  if (left) await announceExit(h, left, tell, answer === 'edit') // (a Deny already tells the thread below, in its own words)
  await logHistory(h, r.thread, { kind: `action-${answer}`, id, action: r.kind, hash: checkCode(r.hash), by: by === 'pane' ? 'user, in the pane' : 'user, asked by the desk' })
  if (standing && !('noGrant' in rec)) await logHistory(h, r.thread, { kind: 'standing-grant', id, action: r.kind, scope: targetOf(r.kind, r.params), statuses: r.kind === 'gh-pr-thread-resolve' ? undefined : STANDING_STATUSES, by: by === 'pane' ? 'user, in the pane' : 'user, asked by the desk', hours: 24 })
  if (answer === 'deny' && tell) await tell(r.thread, `The user denied your request ${id} (${r.kind}): nothing was sent. Denied: report blocked if you cannot go on, or continue without it. Do not send the same text again.`).catch(() => undefined)
  return { ok: true, text: answer === 'approve' ? `the user approved ${id}${standing ? ` and allowed ${statusStanding(r.kind, r.params) ? 'status changes' : 'this kind of write'} of ${r.thread} on this ${r.kind.startsWith('ado-workitem') ? 'work item' : 'PR'} for 24 h (or until it closes)` : ''}: call lean_thread approve-action ${id} to send it` : answer === 'deny' ? `the user denied ${id}; ${r.thread} was told` : `the user wants to edit ${id} first: nothing is sent; ask what to change, then tell ${r.thread} (send) to make a NEW request with the changed text` }
}

const LABEL: Record<string, 'approve' | 'deny' | 'edit' | 'approve-standing'> = { Approve: 'approve', Deny: 'deny', 'Edit first': 'edit', [STANDING_LABEL]: 'approve-standing', [STANDING_LABEL_WI]: 'approve-standing' }
type Q = { question?: unknown; options?: unknown }
const HEADER = /\[request (a\d{1,16}-\d{1,9}), check ([0-9a-f]{12})\]/
const firstDiff = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
const snip = (s: string, i: number): string => JSON.stringify(s.slice(Math.max(0, i - 6), i + 24))
const STILL = 'The request is still pending: nothing was approved, nothing was sent, no standing approval was made. Paste the question from lean_thread action-list exactly as it is, or the user presses Approve on the request\'s card in the pane'
// Why the user's answer to a question about request r cannot be recorded (1.0.31): null when it can. Names the first thing that is wrong: the request's state, then the
// id, the check code, the text (and which part of it), the options, the multi-select flag, and the label chosen not being one of the options offered.
export function unrecorded(r: ActionRequest, v: ActionView | null, canon: { question: string; options: { label: string; description: string }[] } | null, text: string, opts: { label?: unknown; description?: unknown }[], multi: boolean, label: string | null): string | null {
  if (!v || !canon) return `request ${r.id} does not verify (not signed by this mod, or its text changed since it was made): refused, nothing was approved or sent`
  if (v.state !== 'pending') return `request ${r.id} is ${stateWhy(r, v.state)}: nothing was changed`
  const m = HEADER.exec(text)
  if (!m) return `the question has no "[request <id>, check <code>]" part. ${STILL}`
  if (m[1] !== r.id) return `id mismatch: the question's header names request ${m[1]}, the request it was matched to is ${r.id}. ${STILL}`
  if (m[2] !== checkCode(v.hash)) return `check code mismatch: the question says ${m[2]}, request ${r.id} has ${checkCode(v.hash)}. ${STILL}`
  if (text !== canon.question) {
    const i = firstDiff(text, canon.question)
    const bodyAt = canon.question.indexOf('\n---\n') + 5
    const endAt = canon.question.lastIndexOf('\n---\nTarget:')
    const part = i < bodyAt ? 'the heading line' : i <= endAt ? 'the exact text to be sent' : 'the target line'
    return `text differs in ${part}, first at character ${i + 1}: the question shown has ${snip(text, i)}, request ${r.id} has ${snip(canon.question, i)}. ${STILL}`
  }
  const same = opts.length === canon.options.length && canon.options.every((c, k) => opts[k]?.label === c.label && opts[k]?.description === c.description)
  if (!same) return `the options differ: expected exactly ${canon.options.map(o => `"${o.label}"`).join(' | ')} with their descriptions, got ${opts.map(o => JSON.stringify(typeof o?.label === 'string' ? o.label : '?')).join(' | ') || 'none'}. ${STILL}`
  if (multi) return `the question allowed several answers (multiSelect): one choice is needed. ${STILL}`
  if (label !== null && !canon.options.some(o => o.label === label)) return `the answer ${JSON.stringify(label.slice(0, 80))} is not exactly one of the options offered (${canon.options.map(o => `"${o.label}"`).join(' | ')}). ${STILL}`
  return null
}
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
    const hm = HEADER.exec(text)
    if (hm && !all.some(x => x.id === hm[1])) {
      // the question names a request that is not there: say so (only for a question the user actually answered)
      if (given && typeof given[text] === 'string' && (given[text] as string).trim()) notes.push(`the answer to the question about ${hm[1]} was NOT recorded: no such request (never made, or already cleared). Nothing was approved or sent. Ask again with a question from lean_thread action-list`)
      continue
    }
    const ids = [...new Set([...text.matchAll(/\ba\d{1,16}-\d{1,9}\b/g)].map(m => m[0]))].filter(id => all.some(r => r.id === id))
    if (ids.length === 0) continue // not about a request: nothing is bound
    if (ids.length > 1) {
      // about several: nothing is bound, and an answered question says so
      if (given && typeof given[text] === 'string' && (given[text] as string).trim()) notes.push(`the answer to the question naming ${ids.join(' and ')} was NOT recorded: id mismatch, a question must name exactly one request (id, check code and text). Those requests are still pending: ask one question per request, as lean_thread action-list gives them`)
      continue
    }
    const r = all.find(x => x.id === ids[0])!
    if (!given) {
      notes.push(`the answer to the question about ${r.id} could not be read by the mod: ask the user to press Approve or Deny on its card in the pane`)
      continue
    }
    const a = typeof given[text] === 'string' ? (given[text] as string).trim() : ''
    let answer = Object.prototype.hasOwnProperty.call(LABEL, a) ? LABEL[a] : undefined
    let typed = false
    if (!answer && a) {
      // free text is never dropped silently (1.0.28): a clear approval by the script table counts as the Approve press for exactly THIS request (the user's own words to
      // this exact question; the canonical-question check below still applies), "always" / "allow" in it as the fourth choice; any other text is said to the desk
      const t = typedApproval(a)
      if (t.approve) {
        answer = t.always ? 'approve-standing' : 'approve'
        typed = true
      } else {
        const pr = r.params.pr ?? r.params.workitem ?? r.params.id
        notes.push(`the user typed '${a.replace(/\s+/g, ' ').slice(0, 80)}': free text is not an approval for this request; ask again with the choices, or the user can type /lean-agent:allow ${r.thread} ${typeof pr === 'number' ? pr : '<PR number>'}`)
        continue
      }
    }
    if (!answer) continue // nothing was chosen or typed
    const v = await viewOf(h, r, now)
    // the question must be the canonical one (questionOf): the desk model may not frame the text or the options differently
    const canon = v ? questionOf(v) : null
    const opts = Array.isArray(q.options) ? (q.options as { label?: unknown; description?: unknown }[]) : []
    const why = unrecorded(r, v, canon, text, opts, (q as { multiSelect?: unknown }).multiSelect === true, typed ? null : a)
    if (why) {
      notes.push(`the answer to the question about ${r.id} was NOT recorded: ${why}`)
      continue
    }
    // a typed "always" counts as the fourth choice only where the request carries it; else it is the plain Approve of this one request (and says so).
    // A press of the option counts only by its EXACT label (LABEL above: never a prefix, a part of a label or a position): the plain Approve is never a standing one
    const standing = answer === 'approve-standing' && (!typed || !!v!.standing)
    const o = await answerAction(h, r.id, answer === 'approve-standing' ? 'approve' : answer, 'ask', tell, standing, typed ? { how: 'typed', words: a.replace(/\s+/g, ' ') } : { how: 'dialog' }) // (the fourth choice exists only in the canonical question of an eligible request, checked above)
    notes.push(typed && answer === 'approve-standing' && !standing ? `${o.text} (the user typed '${a.slice(0, 80)}': it cannot be allowed for 24 h, only this request was approved)` : o.text)
    if (typed && o.ok) await logHistory(h, r.thread, { kind: 'typed-approval', id: r.id, text: a.replace(/\s+/g, ' ').slice(0, 80), standing })
  }
  return notes
}

// ---- standing approval: the grant and the user's own rule ---------------------------------------------------------------------------------------
// A GRANT is signed (the mod's key) and written by writeGrant, which only answerAction calls: the pane's third press, or the third choice of the
// desk's question as the human answered it (bindAnswers reads the tool result). No lean_report, lean_thread action or message creates one, and
// writeGrant is not exported (a spec reads the sources to keep it so). A RULE is what the user wrote by hand in config.json `actions.standing`
// (a session cannot write that file: the guard refuses it). With either, a request of the two status kinds is sent by the mod at once, by the
// SAME executor (approveAction: signature, hash re-check, token on stdin). A batch is covered only when EVERY item is.
// `req` + `src` (1.0.31, signed when present): the request whose fourth choice made it, and where the choice came from (the pane's button, the dialog's option, typed words)
type Grant = { id: string; thread: string; scope: string; kinds: ActionKind[]; statuses: string[]; ts: number; exp: number; sig: string; req?: string; src?: string }
type SentRec = { ts: number; thread: string; text: string; grant?: string }
const GRANTS = 'action.grants'
const SENT = 'action.standing.sent'
const SENT_SHOWN_MS = 30 * 60 * 1000
const grantText = (g: Omit<Grant, 'sig'>) => `desk-standing\n${g.id}\n${g.thread}\n${g.scope}\n${g.kinds.join(',')}\n${g.statuses.join(',')}\n${g.ts}\n${g.exp}${g.req ? `\n${g.req}\n${g.src ?? ''}` : ''}`
let gseq = 0

// the grants that verify and have not expired (a forged or edited row is not a grant)
async function grantRows(h: Host, now: number): Promise<Grant[]> {
  const v = await h.store.get(GRANTS).catch(() => null)
  const out: Grant[] = []
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.id !== 'string' || !threadOk(g.thread) || typeof g.scope !== 'string' || !Array.isArray(g.kinds) || !Array.isArray(g.statuses) || !Number.isFinite(g.ts) || !Number.isFinite(g.exp) || typeof g.sig !== 'string' || now > g.exp) continue
    if ((g.req !== undefined && typeof g.req !== 'string') || (g.src !== undefined && typeof g.src !== 'string')) continue
    if (![...g.kinds, ...g.statuses].every(x => typeof x === 'string')) continue
    const want = await macOf(h, grantText(g), false)
    if (want && want.length === g.sig.length && want === g.sig) out.push(g)
  }
  return out
}
async function writeGrant(h: Host, r: ActionRequest, now: number, via: Via): Promise<boolean> {
  const scope = targetOf(r.kind, r.params)
  const src = via.how === 'pane' ? `the pane's button "${standingLabelOf(r.kind)}"` : via.how === 'dialog' ? `the dialog's option "${standingLabelOf(r.kind)}"` : `typed words "${(via.words ?? '').slice(0, 60)}"`
  const base = { id: `g${now}-${++gseq}`, thread: r.thread, scope, kinds: [r.kind], statuses: r.kind === 'gh-pr-thread-resolve' ? [] : [...STANDING_STATUSES], ts: now, exp: now + STANDING_TTL_MS, req: r.id, src }
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
export async function revokeGrant(h: Host, id: string, by = 'user, in the pane'): Promise<{ ok: boolean; text: string }> {
  const g = await exclusive(async () => {
    const all = await grantRows(h, await h.clock.now())
    const hit = all.find(x => x.id === id)
    if (!hit) return null
    await h.store.set(GRANTS, all.filter(x => x.id !== id))
    return hit
  })
  if (!g) return { ok: false, text: `no active standing approval ${id}` }
  await logHistory(h, g.thread, { kind: 'standing-revoked', id, scope: g.scope, by })
  return { ok: true, text: `revoked the standing approval for ${g.thread} on ${g.scope}: its status changes are asked again` }
}

// ---- a standing record must rest on the user's own choice (1.0.31) -------------------------------------------------------------------------------
// The signed answer on record for a request (the request's own row may be gone by now): null when none verifies
export async function answerRecord(h: Host, id: string): Promise<Answer | null> {
  const a = (await h.store.get(answerKey(id)).catch(() => null)) as Answer | null
  if (!a || typeof a !== 'object' || a.id !== id || !['approve', 'deny', 'edit'].includes(a.answer) || typeof a.sig !== 'string' || !Number.isFinite(a.ts)) return null
  const want = await macOf(h, answerText(a), false)
  return want && want.length === a.sig.length && want === a.sig ? a : null
}
// what a standing record says it rests on, against the answer on record: null when they agree. `from`: where the record says the choice was made (null: it does not say)
export function choiceProblem(a: Answer | null, from: 'pane' | 'option' | 'typed' | null): string | null {
  if (!a) return 'no answer of yours is on record for the request it names'
  if (a.answer !== 'approve') return `the answer on record for the request it names is ${a.answer}, not Approve`
  if (from === 'pane' && a.by !== 'pane') return 'it says you pressed the pane\'s button, but the answer on record did not come from the pane'
  if ((from === 'option' || from === 'typed') && a.by !== 'ask') return 'it says you chose it in the desk\'s dialog, but the answer on record did not come from the dialog'
  if (from === 'option' && a.via === 'typed') return 'it says you pressed the dialog\'s option, but the answer on record is typed words'
  if (from === 'typed' && a.via !== 'typed') return 'it says you typed words, but the answer on record is a press of an option'
  return null
}
export type FlaggedGrant = { id: string; thread: string; scope: string; quote: string; reason: string; ts: number; revoked: number }
const FLAGGED = 'action.grants.flagged'
// Evidence is kept: the record of the revoked grant, with the reason and the time, stays in the store (and its history line); the user is told in a notice (the FIX row)
export async function flagGrant(h: Host, f: Omit<FlaggedGrant, 'ts' | 'revoked'>): Promise<void> {
  const now = await h.clock.now()
  const prev = await h.store.get(FLAGGED).catch(() => null)
  await h.store.set(FLAGGED, [...(Array.isArray(prev) ? prev : []), { ...f, ts: now, revoked: now } satisfies FlaggedGrant].slice(-20))
  await logHistory(h, f.thread, { kind: 'standing-flagged', id: f.id, scope: f.scope, quote: f.quote.slice(0, 200), reason: f.reason, by: 'the mod (recorded without your choice: revoked)' })
  await setNotice(h, `grant-flag.${f.id}`, `FIX: standing approval ${f.id} of ${f.thread} on ${f.scope.replace(/^(Azure DevOps|GitHub) /, '')} was recorded without your choice (${f.reason}). It was revoked and kept as evidence; press the 24 h choice again if you want it`)
}
export async function flaggedGrants(h: Host): Promise<FlaggedGrant[]> {
  const v = await h.store.get(FLAGGED).catch(() => null)
  return (Array.isArray(v) ? v : []).filter((x): x is FlaggedGrant => !!x && typeof x.id === 'string' && typeof x.reason === 'string')
}
// the thread-status grants (this file): one whose record names no matching press of the 24 h choice is flagged and revoked. A grant made before 1.0.31 names no request: not judged
export async function auditStatusGrants(h: Host): Promise<FlaggedGrant[]> {
  const out: FlaggedGrant[] = []
  for (const g of await grantRows(h, await h.clock.now())) {
    if (!g.req) continue
    const from = g.src?.startsWith("the pane's") ? 'pane' : g.src?.startsWith("the dialog's") ? 'option' : g.src?.startsWith('typed words') ? 'typed' : null
    const why = choiceProblem(await answerRecord(h, g.req), from)
    if (!why) continue
    if (!(await revokeGrant(h, g.id, 'the mod: recorded without your choice')).ok) continue
    await flagGrant(h, { id: g.id, thread: g.thread, scope: g.scope, quote: g.src ?? '', reason: why })
    out.push({ id: g.id, thread: g.thread, scope: g.scope, quote: g.src ?? '', reason: why, ts: 0, revoked: 0 })
  }
  return out
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
type Sent = { ok: boolean; text: string; unknown?: boolean; id?: string; refused?: boolean /* an anchor that does not stand: nothing was written */; http?: { status: number; short: string } /* the server answered with an error status: "HTTP 400" and its message, cut */ }
// An HTTP failure of a send (1.0.33; field: ado-workitem-create "fails with HTTP 400 on every send" and the text said only that: curl's stderr line hid the response body). The status is read from
// curl's "returned error: 400" or gh's "HTTP 422"; the short body is the JSON message the service gave (Azure DevOps: {"message": "TF401320: Rule Error for field ..."}, GitHub: {"message": ...}), else its text.
export function httpFailure(stderr: string, stdout: string): { status: number; short: string } | null {
  const m = /returned error:\s*(\d{3})\b/.exec(stderr) ?? /\bHTTP\s*(\d{3})\b/i.exec(`${stderr}\n${stdout}`)
  if (!m) return null
  let msg = ''
  const body = stdout.trim()
  try {
    const o = JSON.parse(body) as { message?: unknown; error?: unknown; errors?: unknown }
    const e = o.error && typeof o.error === 'object' ? (o.error as { message?: unknown }).message : o.error
    msg = [o.message, e].find(x => typeof x === 'string' && x.trim()) as string | undefined ?? ''
    if (!msg && Array.isArray(o.errors)) msg = o.errors.map(x => (x && typeof x === 'object' ? String((x as { message?: unknown }).message ?? '') : String(x))).filter(Boolean).join('; ')
  } catch {
    msg = body.startsWith('<') ? '' : body // (an HTML error page says nothing useful)
  }
  return { status: Number(m[1]), short: oneLine(msg, 160) }
}
export const httpText = (f: { status: number; short: string }): string => `HTTP ${f.status}${f.short ? `: ${f.short}` : ''}`
// a client error (4xx: the service refused THIS request: bad field, no right, a conflict) is final: the request is closed as failed and the thread asks again with a NEW one. A server
// error (5xx), a timeout (408) or a rate limit (429) is transient: nothing was written, the request stays approved and can be sent again
export const httpFinal = (f: { status: number } | undefined): boolean => !!f && f.status >= 400 && f.status < 500 && f.status !== 408 && f.status !== 429
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idIn = (out: string): string | undefined => {
  try {
    const id = (JSON.parse(out) as { id?: unknown }).id
    return typeof id === 'number' || typeof id === 'string' ? String(id).slice(0, 40) : undefined
  } catch {
    return undefined
  }
}

// a GitHub review (1.0.31): the head commit is read now (commit_id), and an APPROVE is refused on a PR the user wrote (or when that cannot be told): the mod never approves the user's own work.
// Nothing is written when a read fails. Returns the body to send, or the refusal.
async function reviewBody(h: Host, plan: Plan): Promise<{ body: string } | { text: string; refused?: boolean }> {
  const { repo, pr, event } = plan.ghReview!
  const rd = readerOf(h)
  const info = (await rd.gh(`repos/${repo}/pulls/${pr}`)) as { head?: { sha?: unknown }; user?: { login?: unknown } } | null
  const head = info?.head?.sha
  if (typeof head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(head)) return { text: `could not read the head commit of PR ${pr} (no login, no network, or no such PR): nothing was written` }
  if (event === 'APPROVE') {
    const me = ((await rd.gh('user')) as { login?: unknown } | null)?.login
    const author = info?.user?.login
    if (typeof me !== 'string' || !me || typeof author !== 'string' || !author) return { text: `could not tell who wrote PR ${pr} and who the gh login is: an approval is not sent without knowing it is not your own PR` }
    if (me.toLowerCase() === author.toLowerCase()) return { text: `PR ${pr} is yours (${author}): the mod never approves your own PR; nothing was written`, refused: true }
  }
  return { body: JSON.stringify({ ...(JSON.parse(plan.body) as Record<string, unknown>), commit_id: head }) }
}
async function send(h: Host, plan: Plan): Promise<Sent> {
  if (plan.issue) {
    // gh-issue-create: `gh issue create` by argv (no shell), the repo fixed by the check, the body read from a file the mod writes and removes
    const { repo, title, body } = plan.issue
    if (repo !== FEEDBACK_REPO) return { ok: false, text: `a feedback issue goes to ${FEEDBACK_REPO} only: nothing was posted` }
    const home = await homeDir(h)
    const file = `${leanDir(home)}/feedback-export/.issue-body-${await h.clock.now()}.md`
    try {
      await atomicWrite(h, file, body)
      const r = await h.process.run(['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body-file', file], { timeoutMs: 60_000 }).then(x => x, (e: unknown) => ({ exitCode: -1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
      if (r.exitCode === -1) return { ok: false, unknown: true, text: `gh did not answer (${oneLine(r.stderr, 160)}): the issue may or may not exist` }
      if (r.exitCode !== 0) return { ok: false, text: `gh issue create failed: ${oneLine(r.stderr || r.stdout, 200) || `exit ${r.exitCode}`} (is gh installed and logged in: gh auth login). The export is still on disk` }
      return { ok: true, text: r.stdout.split('\n').map(l => l.trim()).filter(l => /^https:\/\/github\.com\//.test(l)).pop() ?? oneLine(r.stdout, 200) }
    } finally {
      await h.process.run(['rm', '-f', file], { timeoutMs: 10_000 }).catch(() => undefined)
    }
  }
  if (plan.tool === 'github') {
    let stdin = plan.body
    if (plan.ghReview) {
      const rb = await reviewBody(h, plan)
      if ('text' in rb) return { ok: false, text: rb.text, ...(rb.refused ? { refused: true } : {}) }
      stdin = rb.body
    }
    const r = await h.process.run(['gh', 'api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', plan.url.replace('https://api.github.com/', ''), '--input', '-'], { stdin, timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
    if (r.exitCode !== 0) {
      const http = httpFailure(r.stderr ?? '', r.stdout ?? '')
      if (http) return { ok: false, http, text: http.short ? `GitHub refused it (${httpText(http)})` : `gh api failed: ${oneLine(r.stderr || r.stdout, 200) || `exit ${r.exitCode}`} (is gh installed and logged in: gh auth login)` }
      return { ok: false, text: `gh api failed: ${oneLine(r.stderr || r.stdout, 200) || `exit ${r.exitCode}`} (is gh installed and logged in: gh auth login)` }
    }
    if (plan.url.endsWith('/graphql')) return /"isResolved"\s*:\s*true/.test(r.stdout) ? { ok: true, text: 'thread resolved' } : { ok: false, text: `GitHub answered but the thread is not reported resolved: ${oneLine(r.stdout, 200)}` }
    return { ok: true, text: resultOf(r.stdout, 'html_url') }
  }
  const tok = await azureToken(h)
  if ('error' in tok) return { ok: false, text: tok.error }
  const { token } = tok
  const scrub = (s: string) => s.split(token).join('***')
  // the token and the body go to curl as a config on STDIN (`-K -`): nothing secret is in an argument list or a process listing
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
  const call = async (method: string, url: string, contentType: string, body: string | null) => {
    const config = [`header = ${q(`Authorization: Bearer ${token}`)}`, ...(body === null ? [] : [`header = ${q(`Content-Type: ${contentType}`)}`]), `header = ${q('Accept: application/json')}`, ...(body === null ? [] : [`data-binary = ${q(body)}`]), ''].join('\n')
    return h.process.run(['curl', '-sS', '--fail-with-body', '--max-time', '60', '-X', method, '-K', '-', url], { stdin: config, timeoutMs: 70_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  }
  let body = plan.body
  let url = plan.url
  if (plan.me) {
    // a vote names the reviewer by id: the identity the token belongs to, read by a GET of connectionData (nothing is written yet, so a failure is a plain refusal)
    const g = await call('GET', `https://dev.azure.com/${enc(plan.me.org)}/_apis/connectionData?api-version=7.1-preview.1`, '', null)
    let me = ''
    try {
      const id = (JSON.parse(g.exitCode === 0 ? g.stdout : '{}') as { authenticatedUser?: { id?: unknown } }).authenticatedUser?.id
      me = typeof id === 'string' ? id : ''
    } catch {
      me = ''
    }
    if (!GUID.test(me)) return { ok: false, text: `could not read who the login is${g.exitCode === 0 ? '' : ` (${scrub(oneLine(g.stderr || g.stdout, 120))})`}: nothing was written` }
    url = url.split(enc(PH_ME)).join(me)
  }
  if (plan.link) {
    // a PR link names the project and the repository by id: two reads (nothing is written yet, so a failure here is a plain refusal)
    const { org, project, repo } = plan.link
    const get = async (url: string, what: string): Promise<{ id: string } | string> => {
      const g = await call('GET', url, '', null)
      const id = g.exitCode === 0 ? idIn(g.stdout) : undefined
      return id && GUID.test(id) ? { id } : `could not read the id of ${what}${g.exitCode === 0 ? '' : ` (${scrub(oneLine(g.stderr || g.stdout, 120))})`}: nothing was written`
    }
    const pid = await get(`https://dev.azure.com/${enc(org)}/_apis/projects/${enc(project)}?api-version=7.1`, `project ${project}`)
    if (typeof pid === 'string') return { ok: false, text: pid }
    const rid = await get(`https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/git/repositories/${enc(repo)}?api-version=7.1`, `repository ${repo}`)
    if (typeof rid === 'string') return { ok: false, text: rid }
    body = body.split(PH_PROJECT).join(pid.id).split(PH_REPO).join(rid.id)
    if (plan.link.unlink !== undefined) {
      // an unlink: the work item's relations are read now, the PR's link is found by its url and removed by position (the test op in the body fails the whole patch if it moved)
      const wi = plan.link.unlink
      const w = await call('GET', `https://dev.azure.com/${enc(org)}/_apis/wit/workitems/${wi}?$expand=relations&api-version=7.1`, '', null)
      let rels: { rel?: unknown; url?: unknown }[] | null = null
      try {
        const o = JSON.parse(w.exitCode === 0 ? w.stdout : '') as { relations?: unknown }
        rels = Array.isArray(o.relations) ? (o.relations as { rel?: unknown; url?: unknown }[]) : []
      } catch {
        rels = null
      }
      if (!rels) return { ok: false, text: `could not read work item ${wi}${w.exitCode === 0 ? '' : ` (${scrub(oneLine(w.stderr || w.stdout, 120))})`}: nothing was written` }
      const want = `vstfs:///git/pullrequestid/${pid.id}/${rid.id}/${plan.link.pr}`.toLowerCase()
      const plain = (u: string): string => {
        try {
          return decodeURIComponent(u).toLowerCase()
        } catch {
          return u.toLowerCase()
        }
      }
      const at = rels.findIndex(x => x && x.rel === 'ArtifactLink' && typeof x.url === 'string' && plain(x.url) === want)
      if (at < 0) return { ok: false, text: `work item ${wi} has no link to PR ${plan.link.pr} (nothing to remove): nothing was written` }
      const ops = JSON.parse(body) as { op: string; path: string; value?: unknown }[]
      ops[0]!.path = ops[0]!.path.split(PH_INDEX).join(String(at))
      ops[0]!.value = rels[at]!.url
      ops[1]!.path = ops[1]!.path.split(PH_INDEX).join(String(at))
      body = JSON.stringify(ops)
    }
  }
  const r = await call(plan.method, url, plan.contentType, body === '' ? null : body)
  if (r.exitCode !== 0) {
    const http = httpFailure(r.stderr ?? '', r.stdout ?? '')
    const why = scrub(oneLine(r.stderr || r.stdout, 200)) || `curl exit ${r.exitCode}`
    if (http) {
      const f = { status: http.status, short: scrub(http.short) }
      return { ok: false, http: f, text: f.short ? `Azure DevOps refused it (${httpText(f)})` : `Azure DevOps refused or could not be reached: ${why}` }
    }
    return UNKNOWN_EXIT.has(r.exitCode) ? { ok: false, unknown: true, text: `the connection broke after the request may have been sent (${why}): outcome unknown, check the target before asking again` } : { ok: false, text: `Azure DevOps refused or could not be reached: ${why}` }
  }
  return { ok: true, text: scrub(resultOf(r.stdout, 'url')), id: idIn(r.stdout) }
}
// a READ of Azure DevOps (a GET, the token on curl's stdin like every write): the JSON object it answered, or null (no token, no network, an error status)
export async function azureGet(h: Host, url: string): Promise<Record<string, unknown> | null> {
  const tok = await azureToken(h)
  if ('error' in tok) return null
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const config = [`header = ${q(`Authorization: Bearer ${tok.token}`)}`, `header = ${q('Accept: application/json')}`, ''].join('\n')
  const r = await h.process.run(['curl', '-sS', '--fail-with-body', '--max-time', '30', '-X', 'GET', '-K', '-', url], { stdin: config, timeoutMs: 40_000 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  if (r.exitCode !== 0) return null
  try {
    const o = JSON.parse(String(r.stdout)) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---- reading a PR's diff for the anchor check (anchor.ts): GETs only, the token on curl's stdin like every write, never in an argument list or an output ----
const curlQ = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
export function readerOf(h: Host): Reader {
  let tok: Promise<{ token: string } | { error: string }> | null = null
  const parse = (out: unknown): unknown | null => {
    try {
      return JSON.parse(String(out)) as unknown
    } catch {
      return null
    }
  }
  return {
    gh: async (path, paginate) => {
      const r = await h.process.run(['gh', 'api', ...(paginate ? ['--paginate'] : []), '-H', 'Accept: application/vnd.github+json', path], { timeoutMs: 60_000 }).catch(() => null)
      if (!r || r.exitCode !== 0) return null
      return paginate ? joinPages(String(r.stdout)) : parse(r.stdout)
    },
    az: async (method, url, body) => {
      const t = await (tok ??= azureToken(h))
      if ('error' in t) return null
      const config = [`header = ${curlQ(`Authorization: Bearer ${t.token}`)}`, ...(body === undefined ? [] : [`header = ${curlQ('Content-Type: application/json')}`]), `header = ${curlQ('Accept: application/json')}`, ...(body === undefined ? [] : [`data-binary = ${curlQ(JSON.stringify(body))}`]), ''].join('\n')
      const r = await h.process.run(['curl', '-sS', '--fail-with-body', '--max-time', '30', '-X', method, '-K', '-', url], { stdin: config, timeoutMs: 40_000 }).catch(() => null)
      return !r || r.exitCode !== 0 ? null : parse(r.stdout)
    },
  }
}
// `lean_run {pr-changes: {forge, org, project, repo, pr, iteration?}}`: a READ for a thread (script, no model, no checkout, no git ref): the changed files of the PR with the
// added / modified line ranges of the new side and the removed ones of the old side, the same reading the anchor check uses. Cut to PR_CHANGES_MAX characters; the whole
// table is written to the thread's scratch folder.
export const PR_CHANGES_MAX = 6000
export async function runPrChanges(h: Host, thread: string, req: unknown): Promise<string> {
  const g = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : null
  if (!g) throw new Error('pr-changes is an object {forge: "ado" | "github", org, project, repo, pr, iteration?}')
  for (const key of Object.keys(g)) if (!['forge', 'org', 'project', 'repo', 'pr', 'iteration'].includes(key)) throw new Error(`pr-changes: unknown field "${key.slice(0, 30)}" (forge, org, project, repo, pr, iteration)`)
  const forge = g.forge === 'ado' || g.forge === 'github' ? g.forge : null
  if (!forge) throw new Error('pr-changes.forge must be "ado" or "github"')
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const pr = int(g.pr)
  if (pr === null) throw new Error('pr-changes.pr must be a PR number')
  const iteration = g.iteration === undefined ? undefined : int(g.iteration)
  if (iteration === null) throw new Error('pr-changes.iteration must be an iteration number')
  if (forge === 'github' && (iteration !== undefined || g.org !== undefined || g.project !== undefined)) throw new Error('pr-changes forge github takes repo (owner/name) and pr only')
  const repo = str(g.repo)
  const org = str(g.org)
  const project = str(g.project)
  if (forge === 'github' ? !GH_REPO.test(repo) : !NAME.test(org) || !NAME.test(project) || !NAME.test(repo)) throw new Error(forge === 'github' ? 'pr-changes forge github needs repo as owner/name' : 'pr-changes forge ado needs org, project and repo (names)')
  const table = await changesTable(readerOf(h), { host: forge === 'github' ? 'github' : 'azure', org, project, repo, pr, ...(iteration !== undefined ? { iteration } : {}) })
  if (!table) throw new Error(`could not read the changes of PR ${pr}${iteration !== undefined ? ` iteration ${iteration}` : ''} (no login, no network, or no such PR${iteration !== undefined ? ' or iteration' : ''}): nothing is guessed`)
  const file = `${threadsDir(await homeDir(h))}/${thread}/scratch/pr-changes-${pr}${iteration !== undefined ? `-it${iteration}` : ''}.txt`
  await atomicWrite(h, file, `${table}\n`).catch(() => undefined)
  if (table.length <= PR_CHANGES_MAX) return table
  const head = table.slice(0, PR_CHANGES_MAX)
  return `${head.slice(0, head.lastIndexOf('\n'))}\n... cut at ${PR_CHANGES_MAX} characters: the whole table is in ${file}`
}
// the anchors of a plan's writes (a batch holds many), checked against the PR diff read now: refusals line up with `list`
const anchorsOf = (plan: Plan): Plan[] => (plan.steps ?? [plan]).filter(s => s.anchor)
// (the commit goes into the JSON's commit_id by parsing it, never by a text replace: a comment may itself contain the placeholder's words)
// An Azure DevOps comment gets the iteration it was CHECKED against (the same one) and the file's changeTrackingId in it, unless the thread named them.
const withHead = (s: Plan, heads: Record<string, string>, info: AnchorInfo = {}): Plan => {
  if (!s.anchor) return s
  const o = JSON.parse(s.body) as Record<string, any>
  if (s.tool === 'github') return heads[prKey(s.anchor)] ? { ...s, body: JSON.stringify({ ...o, commit_id: heads[prKey(s.anchor)] }) } : s
  const c = o.pullRequestThreadContext
  if (!c) return s
  const it = c.iterationContext.firstComparingIteration === PH_ITER ? info.iteration : c.iterationContext.firstComparingIteration
  const ch = c.changeTrackingId === PH_CHANGE ? info.changeTrackingId : c.changeTrackingId
  return { ...s, body: JSON.stringify({ ...o, pullRequestThreadContext: { iterationContext: { firstComparingIteration: it ?? PH_ITER, secondComparingIteration: it ?? PH_ITER }, changeTrackingId: ch ?? PH_CHANGE } }) }
}
const noHead = (s: Plan): boolean => {
  if (!s.anchor) return false
  const o = JSON.parse(s.body) as Record<string, any>
  return s.tool === 'github' ? o.commit_id === PH_HEAD : o.pullRequestThreadContext?.iterationContext?.firstComparingIteration === PH_ITER || o.pullRequestThreadContext?.changeTrackingId === PH_CHANGE
}

// a batch or a reply with a status: the writes in order, each reported (done / failed with the reason / not run). Stopped at the first failure, unless the plan says
// `cont` (a review: a failing item is reported and the rest still run; an outcome that is unknown always stops). The anchor of an inline comment is checked
// against the PR diff right before it goes out: an anchor that does not stand fails ITS item only.
type Ran = { sent: Sent; progress: boolean; refused?: boolean }
async function runSteps(h: Host, thread: string, plan: Plan): Promise<Ran> {
  const steps = plan.steps!
  const parts: string[] = []
  let stopped = false
  let progress = false
  let unknown = false
  let failed = 0
  let refusals = 0
  let firstHttp: { status: number; short: string } | undefined
  let made: string | undefined // the id of the work item a create step made: the link steps after it name it
  const anchored = steps.filter(s => s.anchor)
  const seen = anchored.length ? await verifyAnchors(readerOf(h), thread, anchored.map(s => s.anchor!)) : null
  for (const s0 of steps) {
    const tag = s0.tag ?? '?'
    if (stopped) {
      parts.push(`${tag}: not run`)
      continue
    }
    if (s0.vote && !progress) {
      // 1.0.31: the vote ends a comment batch: when every comment failed, the PR is not set to anything (the author was told nothing)
      failed++
      if (refusals === failed - 1) refusals++
      parts.push(`${tag}: not run (no comment of this request was posted, so the vote was not sent)`)
      continue
    }
    const ai = anchored.indexOf(s0)
    const refusal = seen && ai >= 0 ? seen.refusals[ai] ?? null : null
    const s1 = seen && ai >= 0 ? withHead(s0, seen.heads, seen.infos[ai]) : s0
    const s = s1.url.includes(PH_NEW) ? { ...s1, url: made ? s1.url.split(PH_NEW).join(made) : s1.url } : s1
    let one: Sent
    try {
      one = refusal ? { ok: false, text: refusal, refused: refusal !== CANNOT_VERIFY } : noHead(s) ? { ok: false, text: CANNOT_VERIFY } : s.url.includes(PH_NEW) ? { ok: false, text: 'the work item it should link has no id (the create step reported none)' } : await send(h, s)
      if (one.ok && /(^|\s)create$/.test(s0.tag ?? '')) made = one.id // a batch tags it "2 create"
    } catch (e) {
      one = { ok: false, unknown: true, text: `sending failed after it may have started: ${oneLine(String((e as Error)?.message ?? e), 200)}` }
    }
    if (one.ok) {
      progress = true
      parts.push(`${tag}: done (${one.text})`)
    } else {
      failed++
      if (one.refused) refusals++
      if (one.http && !firstHttp) firstHttp = one.http // (the batch fails as a whole with it only when nothing before it was written)
      if (!plan.cont || one.unknown) stopped = true
      if (one.unknown) {
        progress = true
        unknown = true
      }
      parts.push(`${tag}: ${one.unknown ? 'outcome unknown' : 'failed'} (${one.text})`)
    }
  }
  return { sent: { ok: failed === 0, ...(unknown ? { unknown: true } : {}), ...(!progress && firstHttp ? { http: firstHttp } : {}), text: parts.join('; ') }, progress, ...(!progress && failed > 0 && refusals === failed ? { refused: true } : {}) }
}
// ONE inline comment: its anchor is checked against the PR diff right before it goes out; an anchor that does not stand writes nothing
async function sendAnchored(h: Host, thread: string, plan: Plan): Promise<Sent> {
  const seen = await verifyAnchors(readerOf(h), thread, [plan.anchor!])
  const bad = seen.refusals[0]
  if (bad) return { ok: false, text: bad, refused: bad !== CANNOT_VERIFY }
  const s = withHead(plan, seen.heads, seen.infos[0])
  return noHead(s) ? { ok: false, text: CANNOT_VERIFY } : send(h, s)
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
    if (st === 'failed') return { ok: false as const, text: `request ${id} failed (${r.exit?.reason ?? 'the server refused it'}) and is closed: it is never sent again under this id; ${r.thread} sends a NEW request (the retry asks again)` }
    if (st === 'used') return { ok: false as const, text: `request ${id} was already used: one approval sends once` }
    if (st === 'expired') {
      const a = await answerOf(h, r)
      const m = await markExit(h, id, { kind: 'expired', reason: a ? `approved, but never sent within ${hoursOf(r)} h` : `nobody decided in ${hoursOf(r)} h`, ts: now })
      if (m) await announceExit(h, m, tell)
      return { ok: false as const, text: `request ${id} expired unsent (${hoursOf(r)} h): ${r.thread} was told to send it again if still needed` }
    }
    if (st === 'withdrawn') return { ok: false as const, text: `request ${id} was withdrawn (${r.exit?.reason ?? 'no reason given'}): nothing was sent` }
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
    const notMine = hashOf(renderingOf(plan)) === r.hash ? await checkMove(h, r.kind, r.params, r.id).catch(() => 'could not verify the owner/assignee: not moving it') : null // (again right before the send: the assignee may have changed)
    if (notMine) sent = { ok: false, text: notMine, refused: true }
    else if (hashOf(renderingOf(plan)) !== r.hash) sent = { ok: false, text: 'the text to send no longer matches its check code: nothing was sent' }
    else if (plan.steps) {
      const ran = await runSteps(h, r.thread, plan)
      sent = ran.sent
      progress = ran.progress
      if (ran.refused) sent.refused = true
    } else sent = plan.anchor ? await sendAnchored(h, r.thread, plan) : await send(h, plan)
  } catch (e) {
    sent = { ok: false, unknown: true, text: `sending failed after it may have started: ${oneLine(String((e as Error)?.message ?? e), 200)}` }
  }
  try {
    if (!sent.ok && !sent.unknown && !progress && !sent.refused && !httpFinal(sent.http)) await h.store.set(usedKey(id), null) // a definite failure that sent nothing (no token, no network, a 5xx) is the only retry; a 4xx answer is final (below) (not an anchor that does not stand: it would fail again)
  } finally {
    inflight.delete(id)
  }
  await logHistory(h, r.thread, { kind: sent.ok ? 'action-sent' : sent.unknown ? 'action-unknown' : 'action-failed', id, action: r.kind, hash: checkCode(r.hash), target: plan.url, result: sent.text.slice(0, 300) })
  // the exit is on the record: sent (or sent with an unknown outcome, or partly done) = executed; an anchor that does not stand = withdrawn unsent (the thread is told below, in its own words)
  const now2 = await h.clock.now()
  // (a definite failure that sent nothing leaves it approved and unused for a retry: no exit yet)
  const exit: RequestExit | null = sent.ok ? { kind: 'executed', reason: `sent at ${new Date(now2).toISOString().slice(0, 16).replace('T', ' ')} UTC`, ts: now2 } : sent.unknown ? { kind: 'executed', reason: 'sent, outcome unknown', ts: now2 } : progress ? { kind: 'executed', reason: 'partly done', ts: now2 } : sent.refused ? { kind: 'withdrawn', reason: 'its anchor does not stand: nothing was written', ts: now2 } : httpFinal(sent.http) && !progress ? { kind: 'failed', reason: httpText(sent.http!), ts: now2 } : null
  const exited = exit ? await exclusive(() => markExit(h, id, exit)).catch(() => null) : null
  if (exited) await announceExit(h, exited, tell, exit!.kind === 'executed') // (an executed one announces nothing; a refused one was told below in its own words)
  if (sent.ok || progress) await noteOwnItems(h, r, sent.text).catch(() => undefined)
  const fb = !sent.ok && !sent.unknown && !progress && !sent.refused ? await fallbackOf(h, r).catch(() => null) : null // failed twice: the command for the user's own shell rides on the desk's answer (actionfallback.ts)
  if (sent.ok && tell) await tell(r.thread, `The user approved your request ${id} and the desk sent it (${r.kind}): ${sent.text}. Carry on.`).catch(() => undefined)
  if (sent.unknown && tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved and sent, but the outcome is unknown (${sent.text}). Check the target before asking again.`).catch(() => undefined)
  if (progress && !sent.ok && !sent.unknown) {
    // some writes went out, one failed, the rest did not run: the request is used (never repeated whole); the thread asks for the rest as a NEW request
    if (tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved but only partly done: ${sent.text}. Nothing is repeated: make a NEW request for what failed or did not run, if it is still needed.`).catch(() => undefined)
    return { ok: false, text: `partly done: ${sent.text}. The request is marked used (never repeated whole); ${r.thread} was told to ask again for the rest` }
  }
  if (sent.refused && /: not (moving|linking) it(?: \(say 'link WI \d+ anyway'[^)]*\))?$/.test(sent.text)) { // (the link wording ends with how to allow it once)
    if (tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved but NOT sent, nothing was written: ${sent.text}. Only the user's own tasks are moved: leave the work item as it is.`).catch(() => undefined)
    return { ok: false, text: `not sent: ${sent.text}. Nothing was written; the request is closed, ${r.thread} was told` }
  }
  if (sent.refused) {
    // the PR's diff no longer has the line (a push since the request, or a wrong line): nothing was written; the request is closed and the thread corrects the anchor
    if (tell) await tell(r.thread, `Your request ${id} (${r.kind}) was approved but NOT sent, nothing was written: ${sent.text}. Make a NEW request with an anchor on a line the PR changes.`).catch(() => undefined)
    return { ok: false, text: `not sent: ${sent.text}. Nothing was written; the request is closed because the anchor does not stand, ${r.thread} was told to send a new one` }
  }
  if (httpFinal(sent.http) && !progress && !sent.ok && !sent.unknown) {
    // the server refused it (HTTP 4xx / 5xx): nothing was written; the request is closed as failed (one approval sends once: no duplicate); the thread is told here and asks again with a NEW request
    if (tell && r.thread !== DESK_THREAD) await tell(r.thread, `Your request ${id} (${r.kind}) was approved but the server refused it (${httpText(sent.http!)}). Nothing was written. If it is still needed make a NEW request (the reason says what the server did not accept: fix that field first), or continue without it.`).catch(() => undefined)
    return { ok: false, text: `failed (${httpText(sent.http!)}): ${plan.steps ? `${sent.text}; ` : ''}nothing was written. The request is closed as failed, not approved-and-waiting: ${r.thread === DESK_THREAD ? 'make it again' : `${r.thread} was told to send a NEW request`} if it is still needed${fb ? `\n${fb}` : ''}` }
  }
  if (sent.ok && r.thread === DESK_THREAD) return { ok: true, text: `posted: ${sent.text}` }
  if (sent.ok) return { ok: true, text: `sent ${r.kind} for ${r.thread}: ${sent.text}; ${r.thread} was told` }
  return { ok: false, text: sent.unknown ? `${sent.text}. The request is marked used (never sent twice); ${r.thread} was told` : `not sent: ${sent.text}. The request stays approved and unused until it expires (${hoursOf(r)} h after it was made): try again, or tell ${r.thread}${fb ? `\n${fb}` : ''}` }
}

// The work items a thread OWNS (thread.json `workItems`): the ones it created through `ado-workitem-create`, and the ones its own PR was linked to
// (ownpr.ts adds the ones its brief names). Written by the mod after a send that went out, never by a thread.
export async function addOwnWorkItems(h: Host, thread: string, ids: number[]): Promise<void> {
  if (!ids.length) return
  const path = `${threadsDir(await homeDir(h))}/${thread}/thread.json`
  const t = await readJson<Record<string, unknown> | null>(h, path, null)
  if (!t || typeof t !== 'object') return
  const have = Array.isArray(t.workItems) ? (t.workItems as unknown[]).filter((x): x is number => typeof x === 'number') : []
  const next = [...new Set([...have, ...ids])].slice(-20)
  if (next.length !== have.length) await writeJson(h, path, { ...t, workItems: next })
}
async function noteOwnItems(h: Host, r: ActionRequest, sentText: string): Promise<void> {
  const items = r.kind === 'batch' ? (Array.isArray(r.params.items) ? (r.params.items as { kind: string; params: Params }[]) : []) : [{ kind: r.kind as string, params: r.params }]
  const ids: number[] = []
  for (const it of items) {
    if (it.kind === 'ado-workitem-create') {
      const m = /(?:create: done \(|^)id (\d{1,9})\b/.exec(sentText) ?? /\bid (\d{1,9})\b/.exec(sentText)
      if (m) ids.push(Number(m[1]))
    }
  }
  // (only a work item the thread CREATED becomes its own here; a link to a PR, a brief or a branch name is no ownership signal)
  await addOwnWorkItems(h, r.thread, ids)
  for (const id of ids) await setNotice(h, `ownpr:${r.thread}:wi${id}`, `${r.thread} owns work item ${id} (it created the work item): moving it to Reviewing goes out without a question when ${r.thread} owns a PR (revoke: Revoke button or 'stop writes'); other changes still ask`).catch(() => undefined)
}

// a thread that closed keeps no open request: each one that was still waiting leaves as withdrawn (the thread is gone: the desk is told, in a notice); its record stays
export async function dropActions(h: Host, thread: string): Promise<void> {
  const gone: ActionRequest[] = []
  await exclusive(async () => {
    const now = await h.clock.now()
    for (const r of await rows(h)) {
      if (r.thread !== thread || r.exit || (await usedOf(h, r.id))) continue
      const m = await markExit(h, r.id, { kind: 'withdrawn', reason: `${thread} was closed`, ts: now })
      if (m) gone.push(m)
    }
  })
  for (const r of gone) await announceExit(h, r, undefined, false)
}

// A request that an OLDER version (1.0.32 and before) left "approved, unused" after a send that failed with an HTTP error: its thread's history says "action-failed" with the
// HTTP status. It is closed as failed now (the reason from that line), so the list stops offering it for approve-action (no second creation). Returns the ids closed. Never throws.
export async function reconcileFailed(h: Host): Promise<string[]> {
  const done: string[] = []
  try {
    const home = await homeDir(h)
    const now = await h.clock.now()
    for (const r of await rows(h)) {
      if (r.exit || r.thread === DESK_THREAD || (await usedOf(h, r.id))) continue
      if ((await stateOf(h, r, now)) !== 'approved') continue
      const hist = await readJsonl<{ kind?: string; id?: string; result?: string }>(h, `${threadsDir(home)}/${r.thread}/history.jsonl`).catch(() => [] as { kind?: string; id?: string; result?: string }[])
      const mine = hist.filter(x => x && x.id === r.id && (x.kind === 'action-failed' || x.kind === 'action-sent'))
      const last = mine[mine.length - 1]
      if (!last || last.kind !== 'action-failed') continue
      const http = httpFailure(String(last.result ?? ''), '')
      if (!http || !httpFinal(http)) continue // not an HTTP answer (no token, no network) or a transient one (5xx, 408, 429): it stays approved, to try again
      const m = await exclusive(() => markExit(h, r.id, { kind: 'failed', reason: http.short ? httpText(http) : `HTTP ${http.status} (sent by an older version: the answer's message was not kept)`, ts: now }))
      if (m) {
        done.push(r.id)
        await announceExit(h, m, undefined, false).catch(() => undefined) // the pane's notice line: "t5: request a1-1 failed (HTTP 400: ...)"
      }
    }
  } catch {
    /* the list is read anyway */
  }
  return done
}
// the desk's `action-list`: what waits, each with the question to ask the user, word for word (and the expired ones, told to their thread)
export async function actionListText(h: Host, tell?: Tell): Promise<string> {
  await reconcileFailed(h)
  const now = await h.clock.now()
  const swept = await sweepExpired(h, tell) // a request nobody decided in time leaves unsent, on the record, and the thread and the desk are told
  const left = (await rows(h)).filter(r => r.exit && now - r.exit.ts <= 24 * 3_600_000 && !swept.includes(exitLine(r, r.exit))).slice(-8)
  const fbOf = new Map<string, string>() // a closed request of a kind that failed twice: the command for the user's own shell (actionfallback.ts)
  for (const r of left) if (r.exit!.kind === 'failed') fbOf.set(r.id, (await fallbackOf(h, r).catch(() => null)) ?? '')
  const exits = `${swept.length ? `\njust left the list: ${swept.join('; ')}` : ''}${left.length ? `\nleft the list in the last 24 h (a request leaves only executed, denied, expired or withdrawn; the thread was told of each that was not sent):${left.map(r => `\n  ${r.id} · ${r.thread} · ${r.kind} · ${r.exit!.kind}: ${r.exit!.reason}${fbOf.get(r.id) ? `\n    ${fbOf.get(r.id)!.split('\n').join('\n    ')}` : ''}`).join('')}` : ''}`
  const list = await listActions(h)
  const st = await standingView(h).catch(() => null)
  const stand = st && (st.grants.length || st.rules) ? `\nstanding approvals (a request they cover is sent by the mod at once: do not ask the user again):${st.grants.map(g => `\n  ${g.id} · ${g.thread} · ${g.scope} · status changes (${g.statuses.join(', ') || 'resolve'}) · until ${new Date(g.exp).toISOString().slice(0, 16).replace('T', ' ')} UTC (or the thread closes); the user revokes it in the pane`).join('')}${st.rules ? `\n  ${st.rules} rule${st.rules === 1 ? '' : 's'} in config.json actions.standing (written by the user)` : ''}` : ''
  if (!list.length) return `no request waits for the user${exits}${stand}`
  return `${list
    .map(v => {
      const head = `${v.id} · ${v.thread} · ${v.kind} · ${v.state}${v.why ? ` · why: ${cut(v.why, 160)}` : ''}`
      const fb = v.fallback ? `\n  ${v.fallback.split('\n').join('\n  ')}` : ''
      if (v.state === 'approved') return `${head}\n  the user approved it: call lean_thread approve-action ${v.id}${fb}`
      const q = questionOf(v)
      return `${head}\n  AskUserQuestion, question (paste it exactly): ${JSON.stringify(q.question)}\n  options (exactly these labels): ${q.options.map(o => `${o.label}: ${o.description}`).join(' | ')}${fb}`
    })
    .join('\n')}${exits}${stand}`
}
