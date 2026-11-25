// A reviewer that ended without a report is said so (1.0.35). Field: the lean-agent:reviewer subagent "hit its turn limit with no report" in every
// recent thread and the Agent call's result was empty, so the thread read silence as "no findings". The cause was the guard (the hand-back counted and
// refused past the budget, orchestrate.ts HANDBACK_TOOL); this is the net under it: by script, from the facts the mod saw at the subagent's end
// (tool calls counted, budget hit, last words), one synthesised line (synthline.ts style: marked, display only, never a verdict).
import { blockFrom } from './reviewsave'

export const NOT_DELIVERED = 'review not delivered'
export const SYNTH = 'synthesised'
export type ReviewEnd = { calls: number; budget: number; hit: boolean; last: string }
const ends = new Map<string, ReviewEnd>() // thread id -> the newest reviewer that ended in it
const MAX = 50
export const reviewDeliveryReset = (): void => ends.clear()
export function noteReviewerEnd(thread: string, e: ReviewEnd): void {
  if (!ends.has(thread) && ends.size >= MAX) ends.delete(ends.keys().next().value as string)
  ends.set(thread, e)
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
// a report = a `verdict:` line, a json block of a review result, or the path of the review file the reviewer wrote
export function hasReport(text: string): boolean {
  if (/^\s*`?verdict\s*:\s*(approve|changes-requested|needs-checks)\b/im.test(text)) return true
  if (blockFrom(text)) return true
  return /\breview-[\w.-]+\.(md|json)\b/.test(text)
}

// the line for an Agent result of the reviewer that has no report; null when it has one (or the run is unknown and the text says something)
export function notDeliveredLine(thread: string, text: string): string | null {
  if (hasReport(text)) return null
  const end = ends.get(thread)
  ends.delete(thread)
  const body = flat(text.split('\n').filter(l => !/^\s*`?LEAN-FEEDBACK\b/.test(l)).join('\n'))
  const used = end ? `${end.calls} tool calls of ${end.budget}, budget ${end.hit ? 'used' : 'not used'}` : 'budget unknown'
  const last = end?.last ? flat(end.last).slice(0, 100) : body.slice(0, 100)
  return `${NOT_DELIVERED} (${SYNTH}): the reviewer ended with no report after ${used}${last ? `; its last words: "${last}"` : ''}; ask again with a smaller area, do not read this as "no findings"`
}
