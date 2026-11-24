// Work items and PRs belong to the TASK (1.0.31). A thread row (thread.json) carries `workItem: {id, org?, project?}` and `pr: {number, repo?, host?}`: set by `lean_thread new`
// (workitem / pr, or taken by script from the brief and the user's typed prompt, unambiguous forms only), by `continues: tN` (inherited), or corrected with `set tN workitem|pr <value>`.
// A reference is NOT ownership: the own-PR default (ownpr.ts) still needs its own signals (a `pr` with `id` and `since` in the same field is the ownership record).
// The reference is in every handover (a "work item: 9840 (project-A), PR: 5687" line), in the memory `task` scope (one fact, source script), in `list`, and in the WI -> threads
// map `~/.lean-agent/workitems.json` that `find` and the one-thread-per-work-item rule read. Scripts only; no model decides any of it.
import { leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { addItem } from './memory'
import { deskCtx } from './memorytool'
import { recentPrompts } from './humanprompts'

export type WorkItemRef = { id: number; org?: string; project?: string }
export type PrRef = { number: number; repo?: string; host?: string; org?: string; project?: string }
export type Refs = { workItem?: WorkItemRef; pr?: PrRef }
// what a thread row holds (thread.json). `pr` may also hold the ownership record of ownpr.ts (id, since, url, how): only `number` is read here
export type RefHolder = { id?: string; state?: string; title?: string; finished?: number; workItem?: WorkItemRef; pr?: Record<string, unknown>; task?: string }

const N = (s: string | undefined): number | null => {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null
}
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const ADO_WI = /https?:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_workitems\/edit\/(\d{1,9})\b/gi
const ADO_PR = /https?:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+)\/pullrequest\/(\d{1,9})\b/gi
const GH_PR = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,9})\b/gi
const WI_WORD = /\b(?:WI|work\s?items?)\s*#?\s*(\d{1,9})\b/gi
const PR_WORD = /\b(?:PR|pull\s?requests?)\s*#?\s*(\d{1,9})\b/gi

// The references a text names, in the unambiguous forms only: the Azure DevOps / GitHub URLs, "WI 9840", "work item 9840", "workitem #9840", "PR 5687", "pull request 5687".
// A bare "#123" is never taken. Two different work items (or two PRs) in one text: neither is taken, and a note says so.
export function extractRefs(text: string): Refs & { notes: string[] } {
  const wis = new Map<number, WorkItemRef>()
  const prs = new Map<number, PrRef>()
  for (const m of text.matchAll(ADO_WI)) {
    const id = N(m[3])
    if (id) wis.set(id, { id, org: dec(m[1]!), project: dec(m[2]!) })
  }
  for (const m of text.matchAll(WI_WORD)) {
    const id = N(m[1])
    if (id && !wis.has(id)) wis.set(id, { id })
  }
  for (const m of text.matchAll(ADO_PR)) {
    const number = N(m[4])
    if (number) prs.set(number, { number, host: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) })
  }
  for (const m of text.matchAll(GH_PR)) {
    const number = N(m[3])
    if (number) prs.set(number, { number, host: 'github', repo: `${dec(m[1]!)}/${dec(m[2]!)}` })
  }
  for (const m of text.matchAll(PR_WORD)) {
    const number = N(m[1])
    if (number && !prs.has(number)) prs.set(number, { number })
  }
  const notes: string[] = []
  if (wis.size > 1) notes.push(`several work items are named (${[...wis.keys()].join(', ')}): none was linked`)
  if (prs.size > 1) notes.push(`several PRs are named (${[...prs.keys()].join(', ')}): none was linked`)
  return { ...(wis.size === 1 ? { workItem: [...wis.values()][0]! } : {}), ...(prs.size === 1 ? { pr: [...prs.values()][0]! } : {}), notes }
}

// a value given by the desk: a number, "9840", "#9840", "WI 9840" or a URL; a string is the error text
export function parseWorkItem(v: unknown): WorkItemRef | string {
  if (typeof v === 'number') return N(String(v)) ? { id: v } : 'workitem must be a work item number or its URL'
  if (typeof v !== 'string') return 'workitem must be a work item number or its URL'
  const s = v.trim()
  if (/^#?\d{1,9}$/.test(s)) return N(s.replace('#', '')) ? { id: Number(s.replace('#', '')) } : 'workitem must be a work item number or its URL'
  return extractRefs(s).workItem ?? `workitem "${s.slice(0, 60)}" is not a work item number or an Azure DevOps work item URL`
}
export function parsePr(v: unknown): PrRef | string {
  if (typeof v === 'number') return N(String(v)) ? { number: v } : 'pr must be a PR number or its URL'
  if (typeof v !== 'string') return 'pr must be a PR number or its URL'
  const s = v.trim()
  if (/^#?\d{1,9}$/.test(s)) return N(s.replace('#', '')) ? { number: Number(s.replace('#', '')) } : 'pr must be a PR number or its URL'
  return extractRefs(s).pr ?? `pr "${s.slice(0, 60)}" is not a PR number or an Azure DevOps / GitHub PR URL`
}
export const isNone = (v: unknown): boolean => typeof v === 'string' && /^(none|clear|off|-)$/i.test(v.trim())

// ---- how a thread's references read ------------------------------------------------------------------------------------------------------------
export const prNumber = (t: RefHolder): number | undefined => {
  const p = t.pr
  const n = typeof p?.number === 'number' ? p.number : typeof p?.id === 'number' ? p.id : undefined // (an ownership record of 1.0.28 has `id`)
  return n && n > 0 ? n : undefined
}
export const refsShort = (t: RefHolder): string => [t.workItem?.id ? `WI ${t.workItem.id}` : '', prNumber(t) ? `PR ${prNumber(t)}` : ''].filter(Boolean).join(' · ')
// the handover line: always in the core prompt and in the full one
export function refsLine(t: RefHolder): string {
  const wi = t.workItem?.id ? `work item: ${t.workItem.id}${t.workItem.project ? ` (${t.workItem.project})` : ''}` : ''
  const pr = prNumber(t) ? `PR: ${prNumber(t)}` : ''
  if (!wi && !pr) return ''
  return `${[wi, pr].filter(Boolean).join(', ')}${wi ? ' (this is the task\'s work item: link the PR to it, never create a second one)' : ''}`
}

// ---- storing -----------------------------------------------------------------------------------------------------------------------------------
const mapFile = (home: string) => `${leanDir(home)}/workitems.json`
type WiMap = { wi: Record<string, string[]>; pr: Record<string, string[]> }
async function readMap(h: Host, home: string): Promise<WiMap | null> {
  const m = await readJson<Partial<WiMap> | null>(h, mapFile(home), null).catch(() => null)
  return m && typeof m === 'object' ? { wi: m.wi && typeof m.wi === 'object' ? m.wi : {}, pr: m.pr && typeof m.pr === 'object' ? m.pr : {} } : null
}
const tfile = (home: string, id: string) => `${threadsDir(home)}/${id}/thread.json`

// Sets or clears (null) the references on the thread row IN MEMORY: the caller saves the row. A PR that is already the thread's (even an owned one) stays as it is.
export function applyRefs(t: RefHolder, r: { workItem?: WorkItemRef | null; pr?: PrRef | null }): void {
  if (r.workItem === null) {
    delete t.workItem
    if (t.task?.startsWith('wi-')) delete t.task
  } else if (r.workItem) {
    t.workItem = { id: r.workItem.id, ...(r.workItem.org ? { org: r.workItem.org } : {}), ...(r.workItem.project ? { project: r.workItem.project } : {}) }
    t.task = `wi-${r.workItem.id}`
  }
  if (r.pr === null) delete t.pr
  else if (r.pr) {
    if (t.pr && prNumber(t) === r.pr.number) t.pr = { ...t.pr, number: r.pr.number, ...(r.pr.repo && !t.pr.repo ? { repo: r.pr.repo } : {}), ...(r.pr.host && !t.pr.host ? { host: r.pr.host } : {}) }
    else t.pr = { ...r.pr }
  }
  if (!t.workItem && prNumber(t) && !t.task) t.task = `pr-${prNumber(t)}`
  if (t.workItem && t.task?.startsWith('pr-')) t.task = `wi-${t.workItem.id}`
}

// After the row was saved: the WI -> threads map (file), and the task's one memory item (fact, source script). `was`: the numbers the row had before.
export async function afterRefs(h: Host, home: string, t: RefHolder & { id: string }, was: { wi?: number; pr?: number } = {}): Promise<void> {
  const now = { wi: t.workItem?.id, pr: prNumber(t) }
  if (was.wi !== now.wi || was.pr !== now.pr) {
    const m = (await readMap(h, home)) ?? (await rebuildMap(h, home))
    for (const [kind, before, after] of [['wi', was.wi, now.wi], ['pr', was.pr, now.pr]] as const) {
      if (before !== undefined && before !== after) m[kind][String(before)] = (m[kind][String(before)] ?? []).filter(x => x !== t.id)
      if (before !== undefined && !m[kind][String(before)]?.length) delete m[kind][String(before)]
      if (after !== undefined && !(m[kind][String(after)] ?? []).includes(t.id)) m[kind][String(after)] = [...(m[kind][String(after)] ?? []), t.id]
    }
    await writeJson(h, mapFile(home), m).catch(() => undefined)
  }
  if (t.task && (t.workItem || prNumber(t))) {
    const text = t.workItem
      ? `This task is work item ${t.workItem.id}${t.workItem.project ? ` (${t.workItem.project})` : ''}${prNumber(t) ? `, PR ${prNumber(t)}` : ''}: link every PR to it and do not create a second work item for it.`
      : `This task's pull request is ${prNumber(t)}${t.pr?.repo ? ` (${t.pr.repo})` : ''}: work on that PR and do not open another one for the same work.`
    await addItem(h, home, { text, scope: `task:${t.task}`, kind: 'fact', source: 'script' }, await deskCtx(h, home)).catch(() => undefined) // (a same-meaning item is updated in place: created once)
  }
}
// the map is rebuilt from the thread rows when the file is missing (a first use, or the user deleted it)
async function rebuildMap(h: Host, home: string): Promise<WiMap> {
  const m: WiMap = { wi: {}, pr: {} }
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<RefHolder | null>(h, tfile(home, e.name), null).catch(() => null)
    if (!t) continue
    if (t.workItem?.id) (m.wi[String(t.workItem.id)] ??= []).push(e.name)
    if (prNumber(t)) (m.pr[String(prNumber(t))] ??= []).push(e.name)
  }
  return m
}

// `set tN workitem|pr <value>` (value "none" clears): the desk's or the user's correction of what a script took
export async function setRefAction(h: Host, home: string, id: string, i: { workitem?: unknown; pr?: unknown }, save: (t: RefHolder & { id: string }) => Promise<void>, t: RefHolder & { id: string }): Promise<{ ok: boolean; text: string }> {
  if (i.workitem === undefined && i.pr === undefined) return { ok: false, text: 'set needs workitem and/or pr (a number or URL; "none" clears it)' }
  const was = { wi: t.workItem?.id, pr: prNumber(t) }
  const patch: { workItem?: WorkItemRef | null; pr?: PrRef | null } = {}
  if (i.workitem !== undefined) {
    const w = isNone(i.workitem) ? null : parseWorkItem(i.workitem)
    if (typeof w === 'string') return { ok: false, text: w }
    patch.workItem = w
  }
  if (i.pr !== undefined) {
    if (typeof i.pr === 'object' && i.pr !== null) return { ok: false, text: 'set: pr is a PR number or URL' }
    const p = isNone(i.pr) ? null : parsePr(i.pr)
    if (typeof p === 'string') return { ok: false, text: p }
    patch.pr = p
  }
  applyRefs(t, patch)
  await save(t)
  await afterRefs(h, home, t, was)
  return { ok: true, text: `${id} now has ${refsShort(t) || 'no work item or PR'}` }
}

// ---- who owns a work item / PR ---------------------------------------------------------------------------------------------------------------
export type Owner = { id: string; title: string; state: string }
// the state word of a thread for these messages: open | parked | done (finished) | closed
export const stateWord = (t: RefHolder): string => (t.state === 'closed' || t.state === 'closing' ? 'closed' : t.state === 'parked' ? 'parked' : t.finished ? 'done' : 'open')
export async function ownersOf(h: Host, home: string, kind: 'wi' | 'pr', n: number): Promise<Owner[]> {
  const m = (await readMap(h, home)) ?? (await rebuildMap(h, home))
  const out: Owner[] = []
  for (const id of m[kind][String(n)] ?? []) {
    const t = await readJson<RefHolder | null>(h, tfile(home, id), null).catch(() => null)
    if (!t || (kind === 'wi' ? t.workItem?.id : prNumber(t)) !== n) continue // a stale map row is dropped here
    out.push({ id, title: t.title ?? '', state: stateWord(t) })
  }
  return out
}
// the thread to send a follow-up to: a live one first, else the newest
export const pickOwner = (o: Owner[]): Owner | undefined => o.find(x => x.state === 'open') ?? o.find(x => x.state !== 'closed') ?? o[o.length - 1]
export const ownersText = (kind: 'wi' | 'pr', n: number, o: Owner[]): string => `${kind === 'wi' ? 'WI' : 'PR'} ${n}: ${o.map(x => `${x.id} "${x.title.slice(0, 50)}" (${x.state})`).join(', ')}`

// ---- `new` ------------------------------------------------------------------------------------------------------------------------------------
const NEW_WORDS = /\b(new|separate|fresh|another|different|second)\s+thread\b/i
export const userSaidNewThread = async (h: Host): Promise<boolean> => (await recentPrompts(h).catch(() => [])).some(p => NEW_WORDS.test(p.text))

export type Prepared = { refs: Refs; from?: string; how: string[]; notes: string[] }
// before a thread is created (an error stops `new` before any folder exists): the references from workitem / pr, the thread it continues, the brief and the user's last typed
// prompt; and the one-thread-per-work-item rule (a work item that has a thread is answered with that thread, unless `force` with the user's own words)
export async function prepareRefs(h: Host, home: string, i: { workitem?: unknown; pr?: unknown; continues?: unknown; force?: unknown; text?: string; title?: string }): Promise<Prepared | string> {
  const refs: Refs = {}
  const how: string[] = []
  const notes: string[] = []
  const exp = typeof i.pr === 'object' && i.pr !== null ? undefined : i.pr // (an object pr is the push option)
  if (i.workitem !== undefined && i.workitem !== null && i.workitem !== '') {
    const w = parseWorkItem(i.workitem)
    if (typeof w === 'string') return `new: ${w}. No thread was created`
    refs.workItem = w
  }
  if (exp !== undefined) {
    const p = parsePr(exp)
    if (typeof p !== 'string') refs.pr = p // (a bad `pr` is the own-PR code's refusal: threads.ts create)
  }
  let from: string | undefined
  if (i.continues !== undefined && i.continues !== null && i.continues !== '') {
    from = typeof i.continues === 'string' ? i.continues.trim() : ''
    if (!/^t\d+$/.test(from)) return 'new: continues names the thread this one follows (continues: "t3"). No thread was created'
    const src = await readJson<RefHolder | null>(h, tfile(home, from), null).catch(() => null)
    if (!src) return `new: continues: no thread ${from}. No thread was created`
    const got: string[] = []
    if (!refs.workItem && src.workItem?.id) {
      refs.workItem = src.workItem
      got.push(`WI ${src.workItem.id}`)
    }
    if (!refs.pr && prNumber(src)) {
      refs.pr = { number: prNumber(src)!, ...(typeof src.pr?.repo === 'string' ? { repo: src.pr.repo } : {}), ...(typeof src.pr?.host === 'string' ? { host: src.pr.host } : {}), ...(typeof src.pr?.org === 'string' ? { org: src.pr.org } : {}), ...(typeof src.pr?.project === 'string' ? { project: src.pr.project } : {}) }
      got.push(`PR ${prNumber(src)}`)
    }
    if (got.length) how.push(`${got.join(' and ')} inherited from ${from}`)
  }
  if (!refs.workItem || !refs.pr) {
    // by script, from the brief first and then from the user's last typed prompt (the one that started the task)
    const last = (await recentPrompts(h).catch(() => [])).slice(-1)[0]?.text ?? ''
    let ambWi = false // a brief that names two work items (or PRs) is ambiguous: the prompt does not settle it
    let ambPr = false
    for (const [src, label] of [[`${i.text ?? ''}`, 'the brief'], [last, "the user's prompt"]] as const) {
      if (!src) continue
      const x = extractRefs(src)
      const got: string[] = []
      if (!refs.workItem && !ambWi && x.workItem) {
        refs.workItem = x.workItem
        got.push(`WI ${x.workItem.id}`)
      }
      if (!refs.pr && !ambPr && x.pr) {
        refs.pr = x.pr
        got.push(`PR ${x.pr.number}`)
      }
      if (got.length) how.push(`${got.join(' and ')} taken from ${label}`)
      ambWi = ambWi || x.notes.some(n => n.includes('work items'))
      ambPr = ambPr || x.notes.some(n => n.includes('PRs'))
      notes.push(...x.notes.filter(n => !notes.includes(n)))
    }
  }
  const wi = refs.workItem?.id
  if (wi && i.force !== true) {
    const owners = await ownersOf(h, home, 'wi', wi)
    const mine = from && owners.some(o => o.id === from)
    if (owners.length && !mine) {
      const o = pickOwner(owners)!
      return `${o.id} already owns WI ${wi} (${o.state}): send it a follow-up (lean_thread send ${o.id}: ${o.state === 'open' ? 'it reads it' : 'it restarts with its handover'}), start a follow-on with continues: "${o.id}", or pass force: true when the user said new thread. No thread was created${owners.length > 1 ? `\n${ownersText('wi', wi, owners)}` : ''}`
    }
  }
  if (wi && i.force === true) {
    const owners = await ownersOf(h, home, 'wi', wi)
    if (owners.length && !(from && owners.some(o => o.id === from))) {
      if (!(await userSaidNewThread(h))) return `new: force needs the user's own words ("new thread", "separate thread"): none recorded in the last 24 h. ${pickOwner(owners)!.id} owns WI ${wi}: send it the follow-up, or ask the user. No thread was created`
      how.push(`WI ${wi} also belongs to ${owners.map(o => o.id).join(', ')} (the user asked for a new thread)`)
    }
  }
  return { refs, ...(from ? { from } : {}), how, notes }
}

// the line of the `new` reply
export function newLine(id: string, p: Prepared, t: RefHolder): string {
  const shown = refsShort(t)
  const taken = p.how.some(x => / taken from /.test(x))
  return [shown && p.how.length ? `linked to ${shown.replace(/ · /g, ', ')} (${p.how.join('; ')})${taken ? `: say if wrong (lean_thread set ${id} workitem|pr <number|url|none>)` : ''}` : '', ...p.notes].filter(Boolean).join('; ')
}
