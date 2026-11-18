// LEAN-FEEDBACK: the last line of a worker's reply. `missing` goes to the project's gaps.jsonl (paths it names mark
// areas stale after three), `remember` to memory/notes.jsonl, the status to feedback.jsonl for `stats`.
import { addGap, pathsIn, slugOk } from './rules'
import { appendJsonl, homeDir, leanDir } from './state'
import type { Host } from './state'

export type Feedback = { status: string; used: string[]; unneeded: string[]; missing: string; remember: { type?: string; text: string }[] }
const STATUS = new Set(['done', 'partial', 'failed'])
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseFeedback(text: string): Feedback | null {
  const all = [...String(text ?? '').matchAll(/^\s*`?LEAN-FEEDBACK\s+(\{.*\})`?\s*$/gm)]
  const last = all[all.length - 1]
  if (!last) return null
  let o: any
  try {
    o = JSON.parse(last[1]!)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const remember = (Array.isArray(o.remember) ? o.remember : [])
    .map((r: any) => (typeof r === 'string' ? { text: r } : r && typeof r.text === 'string' ? { type: typeof r.type === 'string' ? r.type : undefined, text: r.text } : null))
    .filter((r: any) => r && r.text.trim())
  return { status: STATUS.has(o.status) ? o.status : 'partial', used: strs(o.used), unneeded: strs(o.unneeded), missing: typeof o.missing === 'string' ? o.missing.trim() : '', remember }
}

export type FbCtx = { thread?: string; project?: string; agent?: string }

export async function applyFeedback(h: Host, ctx: FbCtx, fb: Feedback): Promise<{ gaps: number; remembered: number }> {
  const home = await homeDir(h)
  const ts = await h.clock.now()
  await appendJsonl(h, `${leanDir(home)}/feedback.jsonl`, { ts, thread: ctx.thread, agent: ctx.agent?.replace(/^lean-agent:/, ''), project: ctx.project, status: fb.status, missing: !!fb.missing })
  let gaps = 0
  if (fb.missing) {
    const paths = pathsIn(fb.missing)
    if (slugOk(ctx.project)) {
      for (const p of paths.length ? paths : ['']) {
        await addGap(h, ctx.project, p, fb.missing)
        gaps++
      }
    } else {
      await appendJsonl(h, `${leanDir(home)}/gaps.jsonl`, { ts, path: paths[0] ?? '', area: null, text: fb.missing.slice(0, 300) })
      gaps++
    }
  }
  for (const r of fb.remember) await appendJsonl(h, `${leanDir(home)}/memory/notes.jsonl`, { ts, from: ctx.thread ?? 'worker', project: ctx.project ?? '', type: r.type, text: r.text })
  return { gaps, remembered: fb.remember.length }
}
