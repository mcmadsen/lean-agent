// The two flows around a work item that a thread must not get wrong (1.0.31):
//   createCheck      an `ado-workitem-create` request: (a) the requesting thread already has a work item -> REFUSED (link it instead); (b) else the task's other threads' references
//                    (same PR, or a thread whose title says the same) -> shown; (c) else a READ-ONLY query of the user's active assigned work items (WIQL, the same bearer-token door
//                    as the other reads) -> the closest titles are shown in the request card. The create itself stays a user-approved write.
//   afterPrOpened    a thread's PR was opened (the desk's create) or reported (`set pr`): when the thread has a stored work item, the mod itself builds ONE request: link the PR to it
//                    and move it to Reviewing, one Approve, ONLY when the work item is assigned to the user and the PR was created by the user (owntask.ts); otherwise nothing, and one line why.
//                    Config workitems.afterPr: ask (default) | off; workitems.reviewState: "Reviewing".
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { setNotice } from './notices'
import { addActionRequest, readerOf } from './deskactions'
import { isRelaxed, moveAllowed, onlyOwn } from './owntask'
import { overlap, words } from './memory'
import { recentPrompts } from './humanprompts'
import { knownItems, ownersOf, prNumber } from './workitems'
import type { RefHolder } from './workitems'

const enc = encodeURIComponent
// the own-PR default (ownpr.ts registers itself here: deskactions.ts imports this file, so this file cannot import ownpr.ts -> deskwrites.ts before deskactions.ts has run)
type OwnRunner = (h: Host, id: string) => Promise<{ sent: boolean; line: string } | null>
let runOwn: OwnRunner | null = null
export const setOwnRunner = (f: OwnRunner | null): void => {
  runOwn = f
}
const NEW_WI = /\b(new|another|second|fresh)\s+(work\s?item|bug|task|ticket|user story)\b/i
export const REVIEW_STATE = 'Reviewing'

export async function wiConfig(h: Host): Promise<{ afterPr: 'ask' | 'off'; reviewState: string; onlyOwn: boolean }> {
  const home = await homeDir(h)
  const cfg = await readJson<any>(h, `${leanDir(home)}/config.json`, null).catch(() => null)
  const w = cfg && typeof cfg === 'object' && cfg.workitems && typeof cfg.workitems === 'object' ? cfg.workitems : {}
  const pick = (k: string) => w[k] ?? cfg?.[`workitems.${k}`]
  const st = pick('reviewState')
  return { afterPr: pick('afterPr') === 'off' ? 'off' : 'ask', reviewState: typeof st === 'string' && st.trim() && st.length <= 40 ? st.trim() : REVIEW_STATE, onlyOwn: await onlyOwn(h, home) }
}

// config workitems.lookup false: a create request does not read the user's active work items from the forge
const lookupOff = async (h: Host): Promise<boolean> => {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  return (cfg?.workitems && typeof cfg.workitems === 'object' ? cfg.workitems.lookup : undefined) === false || cfg?.['workitems.lookup'] === false
}

const rowOf = async (h: Host, home: string, id: string): Promise<(RefHolder & Record<string, unknown>) | null> => readJson<(RefHolder & Record<string, unknown>) | null>(h, `${threadsDir(home)}/${id}/thread.json`, null).catch(() => null)

export async function createCheck(h: Host, thread: string, p: Record<string, unknown>): Promise<{ refuse?: string; note?: string }> {
  const home = await homeDir(h)
  const t = await rowOf(h, home, thread)
  const title = typeof p.title === 'string' ? p.title : ''
  const typed = (await recentPrompts(h).catch(() => [])).some(x => NEW_WI.test(x.text))
  if (t?.workItem?.id) {
    if (typed) return { note: `${thread} has WI ${t.workItem.id}; the user asked for a new work item` }
    return { refuse: `this task already has WI ${t.workItem.id}: link it with ado-pr-workitem-link instead (only the user's own words, like "create a new work item", lift this)` }
  }
  // (b) the store: threads that hold the same PR, or whose title says the same
  const cands = new Map<number, string>()
  const n = t ? prNumber(t) : undefined
  if (n) for (const o of await ownersOf(h, home, 'pr', n)) {
    const r = o.id !== thread ? await rowOf(h, home, o.id) : null
    if (r?.workItem?.id) cands.set(r.workItem.id, `${o.id} has the same PR ${n}`)
  }
  const mine = words(title)
  if (mine.size >= 2) for (const k of await knownItems(h, home)) if (k.thread !== thread && overlap(mine, words(k.title)) >= 0.5) cands.set(k.wi, `${k.thread} "${k.title.slice(0, 40)}"`)
  if (cands.size) return { note: `a work item may be known for this task: ${[...cands].slice(0, 3).map(([wi, why]) => `WI ${wi} (${why})`).join(', ')}: link it instead of creating one` }
  // (c) the user's own active assigned work items, read-only (Azure DevOps WIQL); GitHub: skipped
  const org = typeof p.org === 'string' ? p.org : ''
  const project = typeof p.project === 'string' ? p.project : ''
  if (!org || !project || isRelaxed() || (await lookupOff(h))) return {}
  const rd = readerOf(h)
  const base = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/wit`
  const q = (await rd.az('POST', `${base}/wiql?$top=50&api-version=7.1`, { query: "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.TeamProject] = @project AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC" }).catch(() => null)) as { workItems?: { id?: unknown }[] } | null
  const ids = (q?.workItems ?? []).map(x => Number(x?.id)).filter(x => Number.isInteger(x) && x > 0).slice(0, 50)
  if (!q) return { note: 'no work item known for this task (your active work items could not be read)' }
  if (!ids.length) return { note: 'no work item known for this task; you have no active work item assigned in this project' }
  const g = (await rd.az('GET', `${base}/workitems?ids=${ids.join(',')}&fields=System.Title,System.State&api-version=7.1`).catch(() => null)) as { value?: { id?: number; fields?: Record<string, unknown> }[] } | null
  const want = words(`${title} ${typeof p.description === 'string' ? p.description.slice(0, 300) : ''}`)
  const best = (g?.value ?? [])
    .map(x => ({ id: x.id, title: String(x.fields?.['System.Title'] ?? ''), state: String(x.fields?.['System.State'] ?? ''), s: overlap(want, words(String(x.fields?.['System.Title'] ?? ''))) }))
    .filter(x => x.id && x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
  return { note: best.length ? `no work item known for this task; closest: ${best.map(b => `${b.id} '${b.title.slice(0, 50)}' (assigned to you, ${b.state})`).join(', ')}` : `no work item known for this task; none of your ${ids.length} active items looks like it` }
}

export type PrRefFull = { org: string; project: string; repo: string; number: number }
// -> the one line that was written (notice), or null when nothing applies
export async function afterPrOpened(h: Host, thread: string, pr: PrRefFull): Promise<string | null> {
  const cfg = await wiConfig(h)
  if (cfg.afterPr === 'off') return null
  const home = await homeDir(h)
  const t = await rowOf(h, home, thread)
  const wi = t?.workItem
  if (!t || !wi?.id || t.state === 'closed') return null // no stored work item: nothing
  if (t.afterPr === pr.number) return null // once per PR
  await writeJson(h, `${threadsDir(home)}/${thread}/thread.json`, { ...t, afterPr: pr.number })
  const org = wi.org ?? pr.org
  const project = wi.project ?? pr.project
  const say = async (line: string): Promise<string> => {
    await setNotice(h, `wipr:${thread}:${pr.number}`, line).catch(() => undefined)
    return line
  }
  const mv = await moveAllowed(h, home, { workItem: { org, project, id: wi.id }, pr })
  if (!mv.ok) return say(`${thread}: ${mv.why}`)
  const items = [
    { kind: 'ado-pr-workitem-link', params: { org, project, repo: pr.repo, pr: pr.number, workitem: wi.id } },
    { kind: 'ado-workitem-update', params: { org, project, id: wi.id, fields: { state: cfg.reviewState } } },
  ]
  const made = await addActionRequest(h, thread, { kind: 'batch', items, why: `PR ${pr.number} was opened: link it to WI ${wi.id} and move the work item to ${cfg.reviewState} (the mod builds this itself)` })
  if (!made.ok || !made.request) return say(`${thread}: WI ${wi.id} not linked to PR ${pr.number}: ${made.text}`)
  const sent = runOwn ? await runOwn(h, made.request.id).catch(() => null) : null // the own-PR default (ownpr.ts) may cover it; otherwise it waits for one Approve
  return say(sent?.sent ? `${thread}: PR ${pr.number} linked to WI ${wi.id} and moved to ${cfg.reviewState} (${sent.line})` : `${thread}: PR ${pr.number} was opened: Approve in the pane to link it to WI ${wi.id} and move it to ${cfg.reviewState}`)
}
