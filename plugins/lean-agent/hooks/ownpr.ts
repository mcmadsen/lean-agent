// THE OWN-PR DEFAULT (1.0.28): a thread that OWNS a pull request may reply on it, and move its own work item to Reviewing, WITHOUT a question.
// A decision the user made (it relaxes "anything that carries text is always asked", only for the low-risk kinds below), evaluated by SCRIPT at request
// time: no model, no stored grant (the pane's line and Revoke button are the user's way back).
//
// A thread OWNS a PR when it was started for it (the PR number or URL in its brief) or it opened it (a push with `pr`): thread.json `pr`
// {host, org, project, repo, id, url, since}, written by recordBriefPr / recordPushPr (scripts), never by a thread. Covered by default:
//   ado-pr-reply / gh-pr-comment on THAT PR, WITHOUT a status (the text is linted first)
//   ado-workitem-update that sets only `state`, of a work item the thread owns (its brief, its branch name, one it created, one linked to its PR),
//     to a state of `actions.ownWorkItemStates` (default Reviewing | Active | In Progress | Resolved)
//   ado-pr-workitem-link of the owned PR to an owned work item
// Never by default (asked, or covered by an explicit grant): a thread status (resolve / fixed / closed), a vote, a merge, a push, a delete, a create of a
// work item, any write to a PR or work item the thread does not own, a reply to a thread of ANOTHER PR. A batch is covered only when EVERY item is.
// Guard rails: at most `actions.ownPrMaxPerDay` (default 20) writes per owned PR per day; a text with an absolute path, an email address, a token-like string
// or over 2000 characters is refused to auto (the user is asked); every send is a line in the pane with the exact text and a Revoke button; `actions.ownPrDefault`
// false = the old behaviour. The same executor sends it (deskactions.ts claimAndSend -> approveAction: signature, hash re-check, token on stdin).
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { claimAndSend, logHistory, rows, sound, threadOk } from './deskactions'
import { setNotice } from './notices'
import type { ActionKind, Params } from './deskactions'
import { ownActive, ownRevoked, parseForgeUrl, recordOwnSent, remoteOf, resolveRef } from './deskwrites'
import type { ForgeRef } from './deskwrites'

export const OWN_MAX_DAY = 20
export const OWN_STATES = ['Reviewing', 'Active', 'In Progress', 'Resolved']
export const TEXT_MAX = 2000
export type OwnPr = { host: 'azure' | 'github'; org: string; project: string; repo: string; id: number; url: string; since: number }
type TJ = Record<string, unknown> & { state?: unknown; pr?: OwnPr; workItems?: number[] }
const lc = (s: unknown) => String(s ?? '').toLowerCase()
const tfile = async (h: Host, thread: string) => `${threadsDir(await homeDir(h))}/${thread}/thread.json`

export async function ownConfig(h: Host): Promise<{ on: boolean; max: number; states: string[] }> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const a = cfg && typeof cfg === 'object' ? (cfg.actions && typeof cfg.actions === 'object' ? cfg.actions : {}) : {}
  const pick = (k: string) => a[k] ?? cfg?.[`actions.${k}`]
  const max = pick('ownPrMaxPerDay')
  const states = pick('ownWorkItemStates')
  return {
    on: pick('ownPrDefault') !== false,
    max: typeof max === 'number' && Number.isInteger(max) && max > 0 && max <= 1000 ? max : OWN_MAX_DAY,
    states: Array.isArray(states) && states.length && states.every((s: unknown) => typeof s === 'string' && s.trim()) ? states.map((s: string) => s.trim()) : OWN_STATES,
  }
}
export const ownLine = (thread: string, pr: Pick<OwnPr, 'id'>): string =>
  `${thread} owns PR ${pr.id}: its replies and moving its own work item to Reviewing go out without a question (revoke: Revoke button or 'stop writes'); resolving, votes and merges still ask`

// ---- the text lint: what must not go out without the user reading it ----------------------------------------------------------------------------
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi
export function lintText(body: string): string | null {
  if (body.length > TEXT_MAX) return `the text is ${body.length} characters (the limit without a question is ${TEXT_MAX})`
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(body)) return 'the text contains an email address'
  const bare = body.replace(URL_RE, ' ')
  if (/(?:^|[\s("'`=:])(?:\/[\w.~@+-]+){2,}/.test(bare) || /(?:^|[\s("'`])[A-Za-z]:\\/.test(bare) || /(?:^|[\s("'`])~\//.test(bare)) return 'the text contains an absolute path'
  if (/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abp]|sk|pk|AKIA)[-_][A-Za-z0-9_-]{8,}/.test(bare) || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(bare) || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(bare)) return 'the text contains a token-like string'
  for (const w of bare.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) if (/[A-Za-z]/.test(w) && /\d/.test(w)) return 'the text contains a token-like string'
  for (const u of body.match(URL_RE) ?? []) if (/[?&](?:token|access_token|key|apikey|secret|password|sig|pat|auth)=[^&\s]{6,}/i.test(u)) return 'the text contains a link with a token in it'
  return null
}

// ---- who owns what: thread.json `pr` and `workItems`, written by scripts -------------------------------------------------------------------------
async function readT(h: Host, thread: string): Promise<TJ | null> {
  const t = await readJson<TJ | null>(h, await tfile(h, thread), null).catch(() => null)
  return t && typeof t === 'object' ? t : null
}
const sameRef = (a: Pick<OwnPr, 'host' | 'org' | 'project' | 'repo' | 'id'>, b: Pick<OwnPr, 'host' | 'org' | 'project' | 'repo' | 'id'>) => a.host === b.host && lc(a.org) === lc(b.org) && lc(a.project) === lc(b.project) && lc(a.repo) === lc(b.repo) && a.id === b.id
// the PR the thread owns: taking a PR that is not the recorded one starts a new default (a new `since`), the same PR again changes nothing
async function takePr(h: Host, thread: string, ref: Omit<OwnPr, 'since' | 'url'>, url: string): Promise<{ line: string } | null> {
  const t = await readT(h, thread)
  if (!t || t.state === 'closed') return null
  if (t.pr && sameRef(t.pr, ref)) return null
  const pr: OwnPr = { ...ref, url: url.slice(0, 300), since: await h.clock.now() }
  await writeJson(h, await tfile(h, thread), { ...t, pr })
  const cfg = await ownConfig(h)
  if (!cfg.on) return null
  const line = ownLine(thread, pr)
  await setNotice(h, `ownpr:${thread}:${pr.id}`, line).catch(() => undefined) // the user sees it in the pane at once, whoever reads the tool result
  return { line }
}
const asOwn = (r: ForgeRef): Omit<OwnPr, 'since' | 'url'> => ({ host: r.host, org: r.org, project: r.project, repo: r.repo, id: r.n })

// the PR opened by the thread's own push (the push result's PR link)
export async function recordPushPr(h: Host, thread: string, url: string): Promise<string | null> {
  const ref = parseForgeUrl(url)
  if (!ref || ref.type !== 'pr' || !threadOk(thread)) return null
  return (await takePr(h, thread, asOwn(ref), url).catch(() => null))?.line ?? null
}

// the PR (and the work items) the brief names: a PR URL (checked against the thread's project remote), or "PR 5659" / "pull request 5659" (read against
// that remote). Exactly ONE distinct PR counts: a brief that names several is ambiguous and owns none.
export async function recordBriefPr(h: Host, thread: string, brief: string): Promise<string | null> {
  if (!threadOk(thread)) return null
  const found = new Map<string, { ref: Omit<OwnPr, 'since' | 'url'>; url: string }>()
  const add = (ref: Omit<OwnPr, 'since' | 'url'>, url: string) => found.set(`${ref.host}/${lc(ref.org)}/${lc(ref.project)}/${lc(ref.repo)}#${ref.id}`, { ref, url })
  for (const u of (brief.match(/https?:\/\/[^\s<>"']+/g) ?? []).slice(0, 6)) {
    const ref = parseForgeUrl(u)
    if (!ref || ref.type !== 'pr') continue
    const r = await resolveRef(h, thread, ref)
    if (r.ok) add(asOwn(r.ref), u.replace(/[)>.,;]+$/, ''))
  }
  const nums = [...new Set([...brief.matchAll(/(?:\bpr|\bpull\s*request|\bpullrequest|!)\s*#?\s*(\d{1,9})(?![\d.]\d)\b/gi)].map(m => Number(m[1])))].slice(0, 4)
  if (nums.length) {
    const host = await remoteOf(h, thread)
    if (typeof host !== 'string' && host.kind !== 'other') {
      for (const n of nums) add(host.kind === 'github' ? { host: 'github', org: host.owner, project: '', repo: host.repo, id: n } : { host: 'azure', org: host.org, project: host.project, repo: host.repo, id: n }, host.kind === 'github' ? `https://github.com/${host.owner}/${host.repo}/pull/${n}` : `https://dev.azure.com/${encodeURIComponent(host.org)}/${encodeURIComponent(host.project)}/_git/${encodeURIComponent(host.repo)}/pullrequest/${n}`)
    }
  }
  const items = [...new Set([...brief.matchAll(/_workitems\/edit\/(\d{1,9})|\bAB#(\d{1,9})|\bwork\s*items?\s*#?(\d{1,9})|\bWI\s*#?(\d{1,9})/gi)].map(m => Number(m[1] ?? m[2] ?? m[3] ?? m[4])))].slice(0, 5)
  if (items.length) {
    const t = await readT(h, thread)
    if (t) {
      const have = Array.isArray(t.workItems) ? t.workItems : []
      const next = [...new Set([...have, ...items])].slice(-20)
      if (next.length !== have.length) await writeJson(h, await tfile(h, thread), { ...t, workItems: next })
    }
  }
  if (found.size !== 1) return null
  const [{ ref, url }] = [...found.values()] as [{ ref: Omit<OwnPr, 'since' | 'url'>; url: string }]
  return (await takePr(h, thread, ref, url).catch(() => null))?.line ?? null
}

// a branch like feature/1234-digest or fix-1234 names a work item (3 to 9 digits between separators)
async function branchItems(h: Host, thread: string): Promise<number[]> {
  const reg = await readJson<Record<string, { thread?: unknown; branch?: unknown }> | null>(h, `${leanDir(await homeDir(h))}/worktrees.json`, null).catch(() => null)
  const out: number[] = []
  for (const w of Object.values(reg && typeof reg === 'object' ? reg : {})) {
    if (!w || typeof w !== 'object' || w.thread !== thread || typeof w.branch !== 'string') continue
    for (const m of w.branch.matchAll(/(?:^|[/_-])(\d{3,9})(?=[/_-]|$)/g)) out.push(Number(m[1]))
  }
  return out
}

// ---- the evaluation --------------------------------------------------------------------------------------------------------------------------
type Item = { kind: ActionKind; params: Params }
type Why = { ok: true } | { ok: false; why: string; ask: boolean /* a covered kind refused by a guard rail (told to the thread), else simply not covered */ }
const ownsPr = (pr: OwnPr, p: Params): boolean =>
  pr.host === 'github' ? `${lc(pr.org)}/${lc(pr.repo)}` === lc(p.repo) && pr.id === Number(p.pr) : lc(pr.org) === lc(p.org) && lc(pr.project) === lc(p.project) && lc(pr.repo) === lc(p.repo) && pr.id === Number(p.pr)

function coveredItem(it: Item, pr: OwnPr, items: number[], states: string[]): Why {
  const no: Why = { ok: false, why: '', ask: false }
  const p = it.params
  if (it.kind === 'ado-pr-reply' || it.kind === 'gh-pr-comment') {
    if ((it.kind === 'ado-pr-reply') !== (pr.host === 'azure') || !ownsPr(pr, p) || p.status !== undefined) return no
    const bad = lintText(String(p.body ?? ''))
    return bad ? { ok: false, why: bad, ask: true } : { ok: true }
  }
  if (it.kind === 'ado-workitem-update') {
    if (pr.host !== 'azure' || lc(pr.org) !== lc(p.org) || lc(pr.project) !== lc(p.project) || !items.includes(Number(p.id))) return no
    const f = p.fields && typeof p.fields === 'object' ? (p.fields as Record<string, unknown>) : null
    if (!f || Object.keys(f).length !== 1 || typeof f.state !== 'string') return no
    return states.some(s => lc(s) === lc(f.state)) ? { ok: true } : no
  }
  if (it.kind === 'ado-pr-workitem-link') return pr.host === 'azure' && ownsPr(pr, p) && items.includes(Number(p.workitem)) ? { ok: true } : no
  return no
}

export async function ownCovers(h: Host, thread: string, kind: ActionKind, params: Params): Promise<{ ok: true; pr: OwnPr } | { ok: false; why?: string }> {
  const cfg = await ownConfig(h)
  if (!cfg.on) return { ok: false }
  const t = await readT(h, thread)
  const pr = t?.pr
  if (!t || t.state === 'closed' || !pr || typeof pr.id !== 'number' || !Number.isFinite(pr.since)) return { ok: false }
  if (!ownActive(await ownRevoked(h), thread, pr.since)) return { ok: false }
  const raw = kind === 'batch' ? (Array.isArray(params.items) ? (params.items as Item[]) : []) : [{ kind, params }]
  if (!raw.length) return { ok: false }
  const items = [...new Set([...(Array.isArray(t.workItems) ? t.workItems : []), ...(await branchItems(h, thread))])]
  for (const it of raw) {
    const c = coveredItem(it, pr, items, cfg.states)
    if (!c.ok) return c.ask ? { ok: false, why: c.why } : { ok: false }
  }
  return { ok: true, pr }
}

const COUNT = 'action.ownpr.count'
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const prKey = (pr: OwnPr, now: number) => `${pr.host}/${lc(pr.org)}/${lc(pr.project)}/${lc(pr.repo)}#${pr.id}@${dayOf(now)}`
async function counts(h: Host): Promise<Record<string, number>> {
  const v = await h.store.get(COUNT).catch(() => null)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
}

// a request that was just made: when the own-PR default covers EVERY write, the mod sends it at once (the same executor). null: not covered (the user is
// asked as usual). A covered request that a guard rail stops (the text lint, the day's cap) returns {sent: false, line}: the user is asked, and the line says why.
export async function runOwnPr(h: Host, id: string): Promise<{ sent: boolean; line: string } | null> {
  const r = (await rows(h)).find(x => x.id === id)
  if (!r) return null
  const plan = await sound(h, r)
  if (!plan) return null
  const c = await ownCovers(h, r.thread, r.kind, r.params)
  if (!c.ok) {
    if (c.why) {
      await logHistory(h, r.thread, { kind: 'own-pr-asked', id, why: c.why })
      return { sent: false, line: `not sent under the own-PR default: ${c.why}; the user is asked` }
    }
    return null
  }
  const { pr } = c
  const cfg = await ownConfig(h)
  const writes = plan.steps?.length ?? 1
  const now = await h.clock.now()
  const used0 = (await counts(h))[prKey(pr, now)] ?? 0
  if (used0 + writes > cfg.max) {
    await logHistory(h, r.thread, { kind: 'own-pr-asked', id, why: `cap ${cfg.max} writes per PR per day reached` })
    return { sent: false, line: `not sent under the own-PR default: ${used0} writes on PR ${pr.id} today (the limit is ${cfg.max}); the user is asked` }
  }
  let taken = 0
  const out = await claimAndSend(h, id, `own-pr-default (${r.thread} owns PR ${pr.id})`, async () => {
    const all = await counts(h)
    const key = prKey(pr, await h.clock.now())
    if ((all[key] ?? 0) + writes > cfg.max) return false
    taken = (all[key] ?? 0) + writes
    const keep = Object.fromEntries(Object.entries(all).filter(([k]) => k.endsWith(`@${dayOf(now)}`)))
    await h.store.set(COUNT, { ...keep, [key]: taken })
    return true
  })
  if (!out) return null
  const what = `${out.plan.headline}: ${(out.plan.steps ?? [out.plan]).map(s => s.text).join('; ')}`
  if (!out.sent) return { sent: false, line: `sent under the own-PR default FAILED: ${out.text}` }
  const line = `sent under the own-PR default (${r.thread} owns PR ${pr.id}): ${what} (write ${taken} of ${cfg.max} today)`
  await recordOwnSent(h, { ts: now, thread: r.thread, text: line, since: pr.since })
  await logHistory(h, r.thread, { kind: 'own-pr-default', id, action: r.kind, pr: pr.id, count: taken, result: what.slice(0, 300) })
  return { sent: true, line }
}
