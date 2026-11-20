// The expensive-model rule (the user's own: "opus or higher needs my approval").
//
// Expensive = any model that is not haiku or sonnet (opus, fable, a family nobody has heard of, a name that cannot be read): a
// deny-by-default test, not a list of names to block. A session never decides to use one.
//
// An approval comes ONLY from the user pressing a button in the desk pane (pane.tsx calls grantModelApproval; nothing else does, and a
// spec reads the sources to keep it so): no lean_thread / lean_doctor / lean_script action, no config.json value (a session can write the
// lean-agent folder) and no message creates one. It is signed (HMAC, the review key in the mod's own store: reviews.ts macOf), scoped to
// ONE thread (or `desk`) and ONE model family, expires after at most 24 h, ends when the thread closes, and is logged in the thread's
// history.jsonl with the time and what was approved.
//
// What is asked for waits as a request (the mod's store, never a file a session can edit) until the user presses Approve or Deny in
// "Needs you". A request made by a tool call carries what to run again on Approve; one made by the guard (an Agent call, a `claude
// --model` in Bash) does not: the thread reports blocked and retries when the user says it is approved.
import { appendJsonl, homeDir, leanDir, threadsDir } from './state'
import type { Host } from './state'
import { macOf } from './reviews'

export const APPROVAL_MAX_MS = 24 * 60 * 60 * 1000
export const REQUESTS_MAX = 40

// ---- which model is expensive ----------------------------------------------------------------------------------------------
// haiku and sonnet (an alias, a full name, a Bedrock/Vertex style name with a prefix, an old `claude-3-5-sonnet-...` name) are cheap; a name
// that also says opus or fable is not
const CHEAP = /^(?:[a-z0-9.]*\.)?(?:claude-)?(?:\d+(?:[-.]\d+)*-)?(haiku|sonnet)(?![a-z])/
export function isExpensiveModel(model: unknown): boolean {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (!m) return false // no model named: the session's own default, nothing was chosen
  return !(CHEAP.test(m) && !/opus|fable/.test(m))
}
// the family an approval is for: opus, fable, haiku, sonnet, else the first word of the name ('unknown' when it has none, e.g. `$MODEL`)
export function familyOf(model: string): string {
  const m = String(model ?? '').trim().toLowerCase()
  if (/opus/.test(m)) return 'opus'
  if (/fable/.test(m)) return 'fable'
  if (/haiku/.test(m)) return 'haiku'
  if (/sonnet/.test(m)) return 'sonnet'
  return /^[a-z][a-z0-9]*/.exec(m)?.[0]?.slice(0, 24) ?? 'unknown'
}

// one sentence for a refusal inside a session (the guard) and for the model of a session: it reports and stops
export const needsApprovalText = (family: string, what: string): string =>
  `${family} needs the user's approval: report it and stop. ${what}. Report this to the desk (lean_report state blocked: "needs your approval for ${family}: ${what}"); the user approves it in the desk pane (Needs you, Approve). Do not work around it: no other model, command or route.`

// ---- approvals -----------------------------------------------------------------------------------------------------------------
export type ModelApproval = { scope: string; family: string; model: string; reason: string; ts: number; exp: number; sig: string }
export const scopeOk = (s: unknown): s is string => typeof s === 'string' && /^(t\d{1,9}|desk)$/.test(s)
const approvalsKey = (scope: string) => `model.approvals.${scope}`
const signText = (a: { scope: string; family: string; ts: number; exp: number }) => `approve-model\n${a.scope}\n${a.family}\n${a.ts}\n${a.exp}`
const okFamily = (f: unknown): f is string => typeof f === 'string' && /^[a-z][a-z0-9]{0,23}$|^unknown$/.test(f)

let gate: Promise<unknown> = Promise.resolve()
const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
  const r = gate.then(f, f)
  gate = r.catch(() => undefined)
  return r
}

const blobOf = async (h: Host, scope: string): Promise<Record<string, ModelApproval>> => {
  const v = await h.store.get(approvalsKey(scope)).catch(() => null)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ModelApproval>) : {}
}

// the history line (the thread's history.jsonl; the desk's own file for `desk`); a failure to log never undoes the decision
async function logHistory(h: Host, scope: string, rec: Record<string, unknown>): Promise<void> {
  const home = await homeDir(h)
  const file = scope === 'desk' ? `${leanDir(home)}/desk/history.jsonl` : `${threadsDir(home)}/${scope}/history.jsonl`
  await appendJsonl(h, file, rec).catch(() => undefined)
}

// ONLY pane.tsx calls this (the user's press). `ttlMs` is cut to APPROVAL_MAX_MS.
export async function grantModelApproval(h: Host, a: { scope: string; model: string; reason?: string; ttlMs?: number }): Promise<ModelApproval> {
  if (!scopeOk(a.scope)) throw new Error('an approval needs a thread id (tN) or desk')
  if (!isExpensiveModel(a.model)) throw new Error(`${a.model} needs no approval`)
  const family = familyOf(a.model)
  const ts = await h.clock.now()
  const exp = ts + Math.max(60_000, Math.min(APPROVAL_MAX_MS, Number.isFinite(a.ttlMs) ? (a.ttlMs as number) : APPROVAL_MAX_MS))
  const sig = await macOf(h, signText({ scope: a.scope, family, ts, exp }), true)
  if (!sig) throw new Error('no key to sign the approval with')
  const rec: ModelApproval = { scope: a.scope, family, model: String(a.model).slice(0, 80), reason: String(a.reason ?? '').slice(0, 200), ts, exp, sig }
  await exclusive(async () => {
    await h.store.set(approvalsKey(a.scope), { ...(await blobOf(h, a.scope)), [family]: rec })
  })
  await logHistory(h, a.scope, { ts, kind: 'approve-model', model: rec.model, family, exp, reason: rec.reason || undefined, by: 'user, in the pane' })
  return rec
}

// true when `model` needs no approval, or an unexpired, correctly signed approval for this scope and family exists
export async function modelAllowed(h: Host, scope: string, model: string): Promise<boolean> {
  if (!isExpensiveModel(model)) return true
  if (!scopeOk(scope)) return false
  const family = familyOf(model)
  const rec = (await blobOf(h, scope))[family]
  if (!rec || typeof rec !== 'object' || rec.scope !== scope || rec.family !== family || !okFamily(rec.family) || !Number.isFinite(rec.ts) || !Number.isFinite(rec.exp) || typeof rec.sig !== 'string' || !rec.sig) return false
  const now = await h.clock.now()
  if (now > rec.exp || rec.exp - rec.ts > APPROVAL_MAX_MS) return false
  const want = await macOf(h, signText(rec), false)
  return !!want && want.length === rec.sig.length && want === rec.sig
}

// a closed thread keeps no approval (and no open request): the next one is asked for again
export async function revokeModelApprovals(h: Host, scope: string): Promise<void> {
  if (!scopeOk(scope)) return
  await exclusive(async () => {
    await h.store.set(approvalsKey(scope), null)
  })
  await dropRequests(h, scope)
}

// ---- requests -----------------------------------------------------------------------------------------------------------------
// origin: tool = lean_thread asked (retry = `action`), guard = a session's Agent / Bash call was refused, review = review.model asked
export type ModelRequest = {
  id: string
  thread: string // tN, or desk
  model: string
  family: string
  effort?: string
  reason: string
  action: string // new | start | reopen | restart | resume (tool); agent | bash | review (the others)
  origin: 'tool' | 'guard' | 'review'
  asked: boolean // the model was named by the call (so the retry names it too), not the thread's recorded one
  state: 'pending' | 'denied'
  ts: number
}
const REQUESTS = 'model.requests'
let seq = 0

const cleanReq = (v: unknown): ModelRequest | null => {
  const r = v as Partial<ModelRequest> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !scopeOk(r.thread) || typeof r.model !== 'string' || typeof r.reason !== 'string') return null
  return {
    id: r.id.slice(0, 40),
    thread: r.thread,
    model: r.model.slice(0, 80),
    family: familyOf(r.model),
    ...(typeof r.effort === 'string' && r.effort ? { effort: r.effort.slice(0, 12) } : {}),
    reason: r.reason.slice(0, 300),
    action: typeof r.action === 'string' ? r.action.slice(0, 20) : '',
    origin: r.origin === 'guard' || r.origin === 'review' ? r.origin : 'tool',
    asked: r.asked === true,
    state: r.state === 'denied' ? 'denied' : 'pending',
    ts: Number(r.ts) || 0,
  }
}
export async function listRequests(h: Host): Promise<ModelRequest[]> {
  const v = await h.store.get(REQUESTS).catch(() => null)
  return (Array.isArray(v) ? v : []).map(cleanReq).filter((x): x is ModelRequest => !!x)
}
const saveRequests = (h: Host, rows: ModelRequest[]) => h.store.set(REQUESTS, rows.slice(-REQUESTS_MAX))

// one request per thread, family and origin. The very same request again (a tick that wakes the thread again, a thread that retries) is the
// one that is there, answered or not: no new row, no new toast, and a denied one stays denied. A different ask replaces it.
export async function addRequest(h: Host, r: Omit<ModelRequest, 'id' | 'ts' | 'state' | 'family'>): Promise<ModelRequest> {
  return exclusive(async () => {
    const family = familyOf(r.model)
    const ts = await h.clock.now()
    const rec: ModelRequest = { ...r, family, reason: r.reason.replace(/\s+/g, ' ').trim().slice(0, 300), id: `m${ts}-${++seq}`, ts, state: 'pending' }
    const all = await listRequests(h)
    const prev = all.find(x => x.thread === rec.thread && x.family === family && x.origin === rec.origin)
    if (prev && prev.model === rec.model && prev.action === rec.action && prev.reason === rec.reason && prev.asked === rec.asked && prev.effort === rec.effort) return prev
    await saveRequests(h, [...all.filter(x => x !== prev), rec])
    return rec
  })
}
export async function removeRequest(h: Host, id: string): Promise<ModelRequest | null> {
  return exclusive(async () => {
    const rows = await listRequests(h)
    const hit = rows.find(x => x.id === id) ?? null
    if (hit) await saveRequests(h, rows.filter(x => x.id !== id))
    return hit
  })
}
export async function denyRequest(h: Host, id: string): Promise<ModelRequest | null> {
  const hit = await exclusive(async () => {
    const rows = await listRequests(h)
    const r = rows.find(x => x.id === id) ?? null
    if (r) await saveRequests(h, rows.map(x => (x.id === id ? { ...x, state: 'denied' as const } : x)))
    return r
  })
  if (hit) await logHistory(h, hit.thread, { ts: await h.clock.now(), kind: 'deny-model', model: hit.model, family: hit.family, reason: hit.reason || undefined, by: 'user, in the pane' })
  return hit
}
export async function dropRequests(h: Host, thread: string, origin?: ModelRequest['origin']): Promise<void> {
  const mine = (x: ModelRequest) => x.thread === thread && (!origin || x.origin === origin)
  await exclusive(async () => {
    const rows = await listRequests(h)
    if (rows.some(mine)) await saveRequests(h, rows.filter(x => !mine(x)))
  })
}

// ---- the model an agent type runs on (its frontmatter `model:`) ---------------------------------------------------------------
// `lean-agent:<name>` is read from the plugin's own agents folder; any other type from the user's or the project's agents folder. null =
// not found or it names none (the agent inherits the session's model, which is not a choice of this call)
const frontModel = (text: string): string | null => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = m ? /^model:\s*['"]?([^\s'"#]+)/im.exec(m[1]!) : null
  const v = line?.[1] ?? null
  return v && v !== 'inherit' ? v : null
}
export async function agentModel(h: Host, root: string, cwd: string, type: string): Promise<string | null> {
  const t = String(type ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,80}$/.test(t)) return null
  const files: string[] = []
  if (t.startsWith('lean-agent:')) {
    if (root) files.push(`${root}/agents/${t.slice('lean-agent:'.length)}.md`)
  } else if (!t.includes(':')) {
    const home = await homeDir(h).catch(() => '')
    if (cwd) files.push(`${cwd.replace(/\/$/, '')}/.claude/agents/${t}.md`)
    if (home) files.push(`${home}/.claude/agents/${t}.md`)
  }
  for (const f of files) {
    try {
      const body = await h.fs.read(f)
      if (typeof body === 'string') return frontModel(body)
    } catch {
      /* not there: the next place */
    }
  }
  return null
}

// ---- a `claude ... --model <x>` (or -m) in a shell command ---------------------------------------------------------------------
// The model the command starts claude on, or null (no claude, no flag). Looks through quotes (bash -c "...") like the push guard does; a
// value that cannot be read ($MODEL, a substitution) comes back as it is, which counts as expensive.
const CLAUDE_FLAG = /(?:^|[\s/"'`(;&|=])claude(?=[\s"'`)]|$)[^;&|\n]*?\s(?:--model|-m)(?:=|\s+)["']?([^\s"'`;&|)]+)/i
const CLAUDE_ENV = /\bANTHROPIC_MODEL=(?:["']?)([^\s"'`;&|)]+)[^;&|\n]*\bclaude\b/i
export function claudeModelIn(command: string): string | null {
  const c = String(command ?? '')
  return CLAUDE_FLAG.exec(c)?.[1] ?? CLAUDE_ENV.exec(c)?.[1] ?? null
}

// the shared test of the guards and the tool: a model name that needs an approval and has none for this scope
export async function needsApproval(h: Host, scope: string, model: string): Promise<boolean> {
  return isExpensiveModel(model) && !(await modelAllowed(h, scope, model))
}
