// A reviewer's JSON block is saved by script the moment the reviewer answers (1.0.31): scratch/review-<area>-<pass>.json of the calling thread.
// A thread that restarts (context cap) before it records would lose the block and have to ask the reviewer again; the restart prompt lists these
// files (handover.ts) and merge / record take the block from them. Data only; never throws.
import type { Host } from './state'
import { atomicWrite, homeDir, threadsDir } from './state'

// the last fenced json block of the answer, else the last balanced top-level object; only an object that looks like a review result counts
export function blockFrom(text: string): Record<string, unknown> | null {
  const cands: string[] = []
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) cands.push(m[1]!.trim())
  const open = text.lastIndexOf('{')
  if (!cands.length && open >= 0) {
    const start = text.indexOf('{')
    cands.push(text.slice(start, text.lastIndexOf('}') + 1))
  }
  for (const c of cands.reverse()) {
    try {
      const v = JSON.parse(c)
      if (v && typeof v === 'object' && !Array.isArray(v) && ('findings' in v || 'verdict' in v)) return v as Record<string, unknown>
    } catch { /* not json */ }
  }
  return null
}

// "AREA REVIEW area-4 of 6 ..." in the reviewer's prompt names the area; no area = the whole review
export const areaIn = (prompt: string): string => /\bAREA REVIEW (area-\d+)\b/.exec(prompt)?.[1] ?? 'full'

export async function saveReviewerBlock(h: Host, thread: string, prompt: string, answer: string): Promise<string | null> {
  try {
    if (!/^t\d+$/.test(thread)) return null
    const block = blockFrom(answer)
    if (!block) return null
    const dir = `${threadsDir(await homeDir(h))}/${thread}/scratch`
    const area = areaIn(prompt)
    const used = (await h.fs.list(dir).catch(() => [])).map(r => new RegExp(`^review-${area}-(\\d+)\\.json$`).exec(r?.name ?? '')?.[1]).filter(Boolean).map(Number)
    const path = `${dir}/review-${area}-${(used.length ? Math.max(...used) : 0) + 1}.json`
    await atomicWrite(h, path, JSON.stringify(block))
    return path
  } catch {
    return null
  }
}
