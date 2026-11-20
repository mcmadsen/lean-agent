// Thread kind `review`: `lean_thread new` with `review: {pr | branch | sha, base?}` starts a thread whose brief is built from
// templates/review-brief.md (it names the lean-agent:review skill: load it, prepare at level full, run the passes, record, report).
// The marker (the mod's store, key review.marker.tN) says the thread is a review thread; the sha it prepared last lives in the mod's
// store (a session cannot write it), and reviewevidence.ts holds the report to a lean_review record for that sha.
import type { Host } from './state'

export type ReviewTarget = { ref: string; label: string; base?: string }
export type ReviewMarker = { kind: 'review'; project: string; ref: string; base?: string; ts: number }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isInteger(v) ? String(v) : '')

// the `review` argument of lean_thread new: null = not a review thread, a string = what is wrong with it
export function reviewOf(i: unknown): ReviewTarget | string | null {
  const r = (i as { review?: unknown } | null)?.review
  if (r === undefined || r === null || r === false) return null
  if (typeof r !== 'object' || Array.isArray(r)) return 'review must be an object: {pr | branch | sha, base?}'
  const o = r as Record<string, unknown>
  const given = (['pr', 'branch', 'sha'] as const).filter(k => str(o[k]))
  if (given.length !== 1) return 'review needs exactly one of pr (a number or URL), branch or sha'
  const k = given[0]!
  const v = str(o[k]).slice(0, 300)
  if (/[\s\u0000-\u001f]/.test(v)) return `review.${k} must be one plain word (number, URL, branch or sha)`
  const base = str(o.base).slice(0, 200)
  if (base && /[\s\u0000-\u001f]/.test(base)) return 'review.base must be one plain branch name'
  return { ref: v, label: k === 'pr' ? (/^#?\d+$/.test(v) ? `PR #${v.replace('#', '')}` : `PR ${v}`) : k === 'sha' ? `commit ${v.slice(0, 10)}` : `branch ${v}`, ...(base ? { base } : {}) }
}

const FALLBACK = `Review {{label}} of project {{project}} (ref: {{ref}}{{baseNote}}) through the lean-agent:review skill, never by hand.
1. Load the skill lean-agent:review and read its "External review" section.
2. lean_review prepare with ref "{{ref}}"{{baseArg}}, level "full". Run the reviewer passes it asks for, exactly as it says.
3. lean_review record with mode "external" and the head sha prepare printed.
4. lean_report done: the verdict and the findings by severity. The mod appends the evidence from its store; a done report without a record for the reviewed sha is refused.
Read only: edit nothing, push nothing, comment nowhere unless the user asks.`

export async function reviewBrief(h: Host, root: string, t: ReviewTarget, project: string, extra: string): Promise<string> {
  const tpl = await h.fs.read(`${root}/templates/review-brief.md`).then(x => (typeof x === 'string' && x.trim() ? x : FALLBACK)).catch(() => FALLBACK)
  const vars: Record<string, string> = { label: t.label, project, ref: t.ref, baseNote: t.base ? `, base: ${t.base}` : '', baseArg: t.base ? ` and base "${t.base}"` : '' }
  const text = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '')
  return extra && extra !== t.label ? `${text.trimEnd()}\n\nFrom the user: ${extra}\n` : text
}

// `create`: threads.ts's own create, so the thread is made exactly like any other. A haiku (or no) model is raised to sonnet.
export async function newOrReview(h: Host, root: string, i: any, create: (i: any) => Promise<{ ok: boolean; text: string; data?: unknown }>): Promise<{ ok: boolean; text: string; data?: unknown }> {
  const t = reviewOf(i)
  if (t === null) return create(i)
  if (typeof t === 'string') return { ok: false, text: `new: ${t}` }
  const project = str(i.project)
  if (!project) return { ok: false, text: 'new with review needs project (a registered project: lean_thread projects; the reviewed repo)' }
  const raised = str(i.model) === 'haiku'
  const model = !str(i.model) || raised ? 'sonnet' : str(i.model)
  const title = str(i.title) || `Review ${t.label}`
  const r = await create({ ...i, title, project, model, effort: str(i.effort) || 'high', text: await reviewBrief(h, root, t, project, str(i.text)) })
  if (!r.ok) return r
  const id = (r.data as { id?: string } | undefined)?.id
  if (id) {
    const marker: ReviewMarker = { kind: 'review', project, ref: t.ref, ...(t.base ? { base: t.base } : {}), ts: await h.clock.now() }
    await h.store.set(`review.marker.${id}`, marker).catch(() => undefined) // the mod's store, not a file in the session's own folder
  }
  return { ...r, text: `${r.text}\n${id ?? 'the thread'} is a review thread for ${t.label}: it runs lean-agent:review at level full, records, and cannot report done without a lean_review record for the reviewed sha (the mod appends the evidence).${raised ? ' Review threads run on sonnet: haiku was raised to sonnet.' : ''}` }
}

export const markerOf = async (h: Host, thread: string): Promise<ReviewMarker | null> => {
  const m = (await h.store.get(`review.marker.${thread}`).catch(() => undefined)) as Partial<ReviewMarker> | undefined
  return m && typeof m === 'object' && m.kind === 'review' && typeof m.project === 'string' && m.project ? (m as ReviewMarker) : null
}

// the sha a thread last prepared: the mod's store, never a session's file
const key = (thread: string) => `review.thread.${thread}`
export async function noteReviewed(h: Host, thread: string, project: string, sha: string): Promise<void> {
  if (!/^t\d+$/.test(thread)) return
  await h.store.set(key(thread), { project, sha, ts: await h.clock.now() }).catch(() => undefined)
}
export async function reviewedBy(h: Host, thread: string): Promise<{ project: string; sha: string; ts: number } | null> {
  const v = (await h.store.get(key(thread)).catch(() => undefined)) as { project?: unknown; sha?: unknown; ts?: unknown } | undefined
  return v && typeof v.project === 'string' && typeof v.sha === 'string' ? { project: v.project, sha: v.sha, ts: typeof v.ts === 'number' ? v.ts : 0 } : null
}
