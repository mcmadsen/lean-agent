// 1.0.35: a thread that reports it is ready to push gets the PR guide check (prguide.ts) on the intended title / description in the lean_report answer, with the template skeleton
// (sections of the repo's template, the thread's stored work item) when it fails, so the text is fixed BEFORE the push is refused. Script only: no model, nothing sent, never throws,
// never refuses a report. Must not import prchecks.ts (prchecks imports this file).
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { checkOn } from './prvote'
import { guideOf, lintPr, mentionsWorkItem, sectionFilled } from './prguide'
import type { Guide } from './prguide'

const intentKey = (thread: string) => `prguide.intent.${thread}`
const READY_WORDS = /\bready (to push|for (a |the )?(pr|pull request|push))\b/i

export function readyToPush(state: string, text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t || /^(blocked|waiting)$/i.test(state)) return false
  if (t.endsWith('?')) return false
  return state === 'ready' || READY_WORDS.test(t)
}

// "PR title: ..." / "PR description: ..." lines, or a fenced block in the report
export function intentFrom(text: string): { title: string; body: string } | null {
  const t = String(text ?? '').replace(/\r\n?/g, '\n')
  const title = /^[ \t>*-]*\**PR title:?\**:?[ \t]*(.+)$/im.exec(t)?.[1]?.replace(/^[`"']+|[`"'*]+$/g, '').trim() ?? ''
  let body = ''
  const d = /^[ \t>*-]*\**PR description:?\**:?[ \t]*([\s\S]*)$/im.exec(t)
  if (d) {
    const rest = d[1]!.trim()
    const f = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1/.exec(rest)
    body = (f ? f[2]! : rest.split(/\n\s*\n(?=[A-Z][\w ]*:)/)[0]!).trim()
  } else {
    const f = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1/m.exec(t.replace(/^[ \t]*PR title:.*$/im, ''))
    if (f && /^#{1,6}\s/m.test(f[2]!)) body = f[2]!.trim()
  }
  return title || body ? { title, body } : null
}

export async function storeIntent(h: Host, thread: string, title: string, body: string): Promise<void> {
  try {
    await h.store.set(intentKey(thread), { title, body, ts: await h.clock.now() })
  } catch {
    /* a note that cannot be stored never fails the lint */
  }
}
async function storedIntent(h: Host, thread: string): Promise<{ title: string; body: string } | null> {
  const v = (await h.store.get(intentKey(thread)).catch(() => null)) as { title?: unknown; body?: unknown } | null
  return v && (typeof v.title === 'string' || typeof v.body === 'string') ? { title: String(v.title ?? ''), body: String(v.body ?? '') } : null
}

// the folder of the thread's checkout: the given cwd, else the last worktree registered for it
export async function threadRepoDir(h: Host, home: string, thread: string, cwd?: unknown): Promise<string> {
  const dir = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : ''
  if (dir) return dir
  const reg = await readJson<Record<string, { path?: unknown; thread?: unknown }>>(h, `${leanDir(home)}/worktrees.json`, {}).catch(() => ({}))
  const mine = Object.values(reg ?? {}).filter(w => w && w.thread === thread && typeof w.path === 'string')
  return mine.length ? String(mine[mine.length - 1]!.path) : ''
}

export async function storedWorkItem(h: Host, home: string, thread: string): Promise<number | null> {
  const tj = await readJson<{ workItem?: { id?: unknown }; workItems?: unknown; briefItems?: unknown }>(h, `${threadsDir(home)}/${thread}/thread.json`, {}).catch(() => ({}) as { workItem?: { id?: unknown } })
  const id = Number(tj.workItem?.id)
  if (Number.isInteger(id) && id > 0) return id
  const more = [...(Array.isArray(tj.workItems) ? tj.workItems : []), ...(Array.isArray(tj.briefItems) ? tj.briefItems : [])].find((n): n is number => Number.isInteger(n))
  return more ?? null
}

export function skeletonOf(g: Guide, i: { title: string; body: string; workItem: number | null }): string {
  const title = i.title.trim() || (g.title.kind === 'none' ? '<fill in: a short title>' : `<fill in: a title like "${g.title.example}">`)
  const out = [`title: ${title}`, '---']
  for (const hd of g.headings) {
    const optional = !g.required.includes(hd)
    const mine = sectionFilled(i.body, hd) ? sectionBody(i.body, hd) : ''
    out.push(`## ${hd}`, mine || `<fill in: ${optional ? 'optional: ' : ''}${hd.replace(/\s*\(optional\)/i, '')}>`, '')
  }
  if (!g.headings.length) out.push(i.body.trim() || '<fill in: what changed, why and how it was tested>', '')
  const text = `${i.title}\n${i.body}`
  if (i.workItem !== null) {
    if (!mentionsWorkItem(text) || !new RegExp(`\\b(AB#|#)?${i.workItem}\\b`).test(text)) out.push(`Related work items: AB#${i.workItem}`)
  } else if (g.workitems && !mentionsWorkItem(text)) out.push('Related work items: <no work item is stored for this thread: ask the desk for the AB#<id>>')
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
function sectionBody(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const norm = (s: string) => s.replace(/[*_`:]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  const at = lines.findIndex(l => /^#{1,6}\s/.test(l) && norm(l.replace(/^#{1,6}\s+/, '').replace(/\s*#*\s*$/, '')) === norm(heading))
  if (at < 0) return ''
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(l)) break
    out.push(l)
  }
  return out.join('\n').trim()
}

// the note a ready report gets, or null (not a ready report, check off, nothing to say)
export async function readyCheck(h: Host, thread: string, r: { state: string; text: string; cwd?: unknown }): Promise<string | null> {
  try {
    if (!readyToPush(r.state, r.text)) return null
    const home = await homeDir(h)
    const cfg = await readJson<unknown>(h, `${leanDir(home)}/config.json`, null).catch(() => null)
    if (!checkOn(cfg, 'pr', 'guide')) return null
    const dir = await threadRepoDir(h, home, thread, r.cwd)
    if (!dir) return 'PR guide check skipped: no worktree is registered for this thread'
    const t = await readJson<{ project?: string }>(h, `${threadsDir(home)}/${thread}/thread.json`, {}).catch(() => ({}) as { project?: string })
    const { guide } = await guideOf(h, t.project || dir, dir)
    const given = intentFrom(r.text) ?? (await storedIntent(h, thread))
    const text = { title: given?.title ?? '', body: given?.body ?? '' }
    const missing = lintPr(guide, text)
    if (!missing.length) return given ? 'PR guide check: the intended title and description follow the repo guidelines (OK)' : null
    const skeleton = skeletonOf(guide, { ...text, workItem: await storedWorkItem(h, home, thread) })
    return `PR guide check: the intended PR text would be refused at push:\n- ${missing.join('\n- ')}\nFix it before you push; a skeleton from the repo's template (fill in the <fill in: ...> parts):\n${skeleton}`
  } catch {
    return null
  }
}
