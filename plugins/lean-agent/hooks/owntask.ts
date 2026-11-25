// ONLY YOUR OWN TASKS ARE MOVED (1.0.31). The mod links a PR to a work item and moves the work item's state (Reviewing) ONLY when the work item is ASSIGNED TO THE USER
// and the PR was CREATED BY THE USER, read from the forge itself (never from what a thread says). Otherwise it does nothing and says one line why.
// READS only, the same door as the other Azure DevOps reads (deskactions.ts readerOf: bearer token on curl's stdin, never in an argument list or an output):
//   identity of the token   GET {org}/_apis/connectionData                      (cached per org for the session)
//   PR creator              GET {org}/{project}/_apis/git/repositories/{repo}/pullrequests/{n}  -> createdBy
//   work item assignee      GET {org}/{project}/_apis/wit/workitems/{id}?fields=System.AssignedTo
// A failed read is NEVER ok. `ownTask` is pure about policy (no config, no override): the config `workitems.onlyOwn` and the user's own words are `moveAllowed`.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { readerOf } from './deskactions'
import { recentPrompts } from './humanprompts'

// `link`: the request is a LINK of the PR to the work item (ado-pr-workitem-link), so its refusal says "not linking it" (a state move says "not moving it")
export type OwnTarget = { pr?: { org: string; project: string; repo: string; number: number }; workItem?: { org: string; project: string; id: number }; link?: boolean }
export type OwnResult = { ok: boolean; why: string }
type Who = { id?: string; unique?: string; name: string }
const enc = encodeURIComponent
const lc = (s: unknown) => String(s ?? '').trim().toLowerCase()

const me = new Map<string, Promise<Who | null>>()
export const resetOwnTask = (): void => me.clear()

const whoOf = (v: unknown): Who | null => {
  if (typeof v === 'string') return v.trim() ? { unique: lc(v), name: v.trim() } : null // (an older shape: "Name <mail>")
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? lc(o.id) : undefined
  const unique = typeof o.uniqueName === 'string' && o.uniqueName ? lc(o.uniqueName) : undefined
  const name = typeof o.displayName === 'string' && o.displayName ? o.displayName : unique ?? ''
  return id || unique ? { id, unique, name: name || 'someone else' } : null
}
const same = (a: Who, b: Who): boolean => (!!a.id && a.id === b.id) || (!!a.unique && a.unique === b.unique) || (!!a.unique && !!b.name && a.unique === lc(b.name))

function identity(h: Host, org: string): Promise<Who | null> {
  let p = me.get(org)
  if (!p) {
    p = readerOf(h)
      .az('GET', `https://dev.azure.com/${enc(org)}/_apis/connectionData?api-version=7.1-preview.1`)
      .then(g => {
        const u = (g as { authenticatedUser?: { id?: unknown; providerDisplayName?: unknown; properties?: { Account?: { $value?: unknown } } } } | null)?.authenticatedUser
        if (!u) return null
        const unique = typeof u.properties?.Account?.$value === 'string' ? lc(u.properties.Account.$value) : undefined
        const id = typeof u.id === 'string' && u.id ? lc(u.id) : undefined
        return id || unique ? { id, unique, name: typeof u.providerDisplayName === 'string' ? u.providerDisplayName : 'you' } : null
      })
      .catch(() => null)
    me.set(org, p)
    p.then(v => v ?? me.delete(org)) // a failed read is not kept
  }
  return p
}

export const CANT = 'could not verify the owner/assignee: not moving it'
const SAY_LINK = "(say 'link it anyway' in the chat to allow once)" // (userSaidAnyway accepts these words for a link request)
export async function ownTask(h: Host, t: OwnTarget): Promise<OwnResult> {
  const org = t.workItem?.org ?? t.pr?.org
  if (!org || (!t.workItem && !t.pr)) return { ok: false, why: CANT }
  const who = await identity(h, org)
  if (!who) return { ok: false, why: CANT }
  const rd = readerOf(h)
  if (t.workItem) {
    const w = t.workItem
    const g = (await rd.az('GET', `https://dev.azure.com/${enc(w.org)}/${enc(w.project)}/_apis/wit/workitems/${w.id}?fields=System.AssignedTo&api-version=7.1`).catch(() => null)) as { fields?: Record<string, unknown> } | null
    if (!g || typeof g !== 'object' || !g.fields || typeof g.fields !== 'object') return { ok: false, why: CANT }
    const a = whoOf(g.fields['System.AssignedTo'])
    if (!a) return { ok: false, why: t.link ? `linking this PR to WI ${w.id} changes a work item that is unassigned, not yours: not linking it ${SAY_LINK}` : `WI ${w.id} is unassigned: not moving it` }
    if (!same(who, a)) return { ok: false, why: t.link ? `linking this PR to WI ${w.id} changes a work item assigned to ${a.name}, not you: not linking it ${SAY_LINK}` : `WI ${w.id} is assigned to ${a.name}, not you: not moving it` }
  }
  if (t.pr) {
    const p = t.pr
    const g = (await rd.az('GET', `https://dev.azure.com/${enc(p.org)}/${enc(p.project)}/_apis/git/repositories/${enc(p.repo)}/pullrequests/${p.number}?api-version=7.1`).catch(() => null)) as { createdBy?: unknown } | null
    const c = g && typeof g === 'object' ? whoOf(g.createdBy) : null
    if (!c) return { ok: false, why: CANT }
    if (!same(who, c)) return { ok: false, why: `PR ${p.number} was created by ${c.name}, not you: not linking it` }
  }
  return { ok: true, why: '' }
}

// ---- the typed actions that MOVE a work item for a PR flow ---------------------------------------------------------------------------------------
// ado-pr-workitem-link (PR and work item) and ado-workitem-update that sets the State (the work item); a batch is checked item by item. A comment on a work item is not a
// move. null = fine (or not a guarded kind); else the refusal text: exactly the why. Called at REQUEST time (nothing is shown to the user when it refuses) and again at SEND time.
type Req = { kind: string; params: Record<string, unknown> }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))
export async function checkMove(h: Host, kind: string, params: Record<string, unknown>): Promise<string | null> {
  const items: Req[] = kind === 'batch' ? (Array.isArray(params.items) ? (params.items as Req[]) : []) : [{ kind, params }]
  const home = await homeDir(h)
  for (const it of items) {
    const p = it?.params ?? {}
    let target: OwnTarget | null = null
    if (it?.kind === 'ado-pr-workitem-link') target = { link: true, workItem: { org: str(p.org), project: str(p.project), id: num(p.workitem) }, pr: { org: str(p.org), project: str(p.project), repo: str(p.repo), number: num(p.pr) } }
    else if (it?.kind === 'ado-workitem-update' && p.fields && typeof p.fields === 'object' && 'state' in (p.fields as object)) target = { workItem: { org: str(p.org), project: str(p.project), id: num(p.id) } }
    if (!target || !(target.workItem!.id > 0)) continue // (a work item a create step of the same batch is making has no number yet: the user approves that whole batch)
    const r = await moveAllowed(h, home, target)
    if (!r.ok) return r.why
  }
  return null
}

// ---- the user's override and the config ---------------------------------------------------------------------------------------------------------
export async function onlyOwn(h: Host, home: string): Promise<boolean> {
  const cfg = await readJson<any>(h, `${leanDir(home)}/config.json`, null).catch(() => null)
  const v = cfg && typeof cfg === 'object' ? (cfg.workitems && typeof cfg.workitems === 'object' ? cfg.workitems.onlyOwn : undefined) ?? cfg['workitems.onlyOwn'] : undefined
  return v !== false
}
// the user's OWN typed words lift the rule for the one work item they name ("move WI 4210 anyway"); a thread cannot pass anything that does
export async function userSaidAnyway(h: Host, wi: number, link = false): Promise<boolean> {
  const named = new RegExp(`(?:\\bWI|work\\s?items?|_workitems/edit/|#)\\s*${wi}\\b`, 'i')
  return (await recentPrompts(h).catch(() => [])).some(p => (named.test(p.text) && /\banyway\b|\bregardless\b|\beven though\b/i.test(p.text)) || (link && /\blink it anyway\b/i.test(p.text))) // (a link refusal says "say 'link it anyway'": those words count for a link request)
}
// the check the typed actions and the after-PR batch use: config off or the user's words -> allowed; else ownTask
// the specs of the executor (deskactions, standing, ownpr ...) test the writes, not the owner: they call this once at the top of the file (a spec file runs in its own process)
let relaxed = false
export const relaxOwnTaskForSpecs = (): void => {
  relaxed = true
}
export const isRelaxed = (): boolean => relaxed
export async function moveAllowed(h: Host, home: string, t: OwnTarget): Promise<OwnResult> {
  if (relaxed || !(await onlyOwn(h, home))) return { ok: true, why: '' }
  const r = await ownTask(h, t)
  if (r.ok) return r
  if (t.workItem && r.why !== CANT && (await userSaidAnyway(h, t.workItem.id, t.link === true))) return { ok: true, why: '' } // (a failed read is never lifted: the words do not make the read succeed)
  return r // (the refusal is exactly the why: nothing is added to it)
}
