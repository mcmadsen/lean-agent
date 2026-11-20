// The report gate of a kind-review thread (reviewkind.ts): a `done` report is refused unless a lean_review record exists for the sha the
// thread prepared (a prepare WITH a ref; the record must be newer than it), at the full level with a reviewer verdict, and the mod
// appends the evidence from the store to the report itself (never from what the thread wrote).
// register.tsx calls reviewReport before threadTool's lean_report; other reports pass unchanged. A failure of the gate itself refuses.
import type { Host } from './state'
import { readReview } from './reviews'
import { markerOf, reviewedBy } from './reviewkind'

export type Gate = { ok: true; text: string } | { ok: false; text: string }

export async function reviewReport(h: Host, thread: string, stateIn: string, text: string): Promise<Gate> {
  if (String(stateIn).trim() !== 'done') return { ok: true, text } // (threadTool trims the state too: the same word)
  const marker = await markerOf(h, thread).catch(() => null)
  if (!marker) return { ok: true, text }
  const refuse = (why: string): Gate => ({ ok: false, text: `lean_report refused: this is a review thread, and ${why}. Load lean-agent:review, lean_review prepare (ref, level "full"), run the passes, lean_review record (mode "external"), then report done again. Nothing was sent to the desk.` })
  try {
    const seen = await reviewedBy(h, thread)
    if (!seen || seen.project !== marker.project) return refuse('no lean_review prepare with a ref was run for it yet (the mod knows no reviewed sha)')
    const rec = await readReview(h, seen.project, seen.sha)
    if (!rec) return refuse(`no lean_review record exists for the reviewed sha ${seen.sha.slice(0, 12)}`)
    if ((rec.ts ?? 0) < seen.ts) return refuse(`the record for ${seen.sha.slice(0, 12)} is older than your last prepare: record the review you just ran`)
    if (rec.level !== 'full') return refuse(`the record for ${seen.sha.slice(0, 12)} is ${rec.level === 'light' ? 'a light pass (one pass, a checkpoint)' : 'not a full-level review record (no reviewer result was recorded)'}: prepare again with level "full" and record the reviewer's JSON`)
    if (!rec.verdicts?.length) return refuse(`the record for ${seen.sha.slice(0, 12)} carries no reviewer verdict`)
    const counts = Object.entries(rec.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')
    const evidence = [
      '--- review evidence (appended by the mod from the review store) ---',
      `record sha: ${rec.sha}`,
      `level: ${rec.level}${rec.mode === 'external' ? ', external (not a push-gate record)' : rec.green ? ', green' : ', not green'}`,
      `passes: ${rec.passes ?? rec.verdicts.length}${rec.model ? `, model ${rec.model}` : ''}`,
      `verdicts: ${rec.verdicts.join(', ')}`,
      `findings: ${counts || (rec.findings?.length ? `${rec.findings.length} open` : 'none open')}`,
    ].join('\n')
    return { ok: true, text: `${text.trimEnd()}\n\n${evidence}` }
  } catch (err) {
    return refuse(`the gate could not read the review store (${String((err as Error)?.message ?? err).slice(0, 120)})`)
  }
}
