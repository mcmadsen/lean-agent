// The report gate of a kind-review thread (reviewkind.ts): a `done` report is refused unless a lean_review record exists for the sha the
// thread prepared, and the mod appends the evidence from the store to the report itself (never from what the thread wrote).
// register.tsx calls reviewReport before threadTool's lean_report; other reports pass unchanged.
import type { Host } from './state'
import { readReview } from './reviews'
import { markerOf, reviewedBy } from './reviewkind'

export type Gate = { ok: true; text: string } | { ok: false; text: string }

export async function reviewReport(h: Host, thread: string, state: string, text: string): Promise<Gate> {
  if (state !== 'done') return { ok: true, text }
  const marker = await markerOf(h, thread).catch(() => null)
  if (!marker) return { ok: true, text }
  const seen = await reviewedBy(h, thread)
  const refuse = (why: string): Gate => ({ ok: false, text: `lean_report refused: this is a review thread, and ${why}. Load lean-agent:review, lean_review prepare (ref, level "full"), run the passes, lean_review record (mode "external"), then report done again. Nothing was sent to the desk.` })
  if (!seen || seen.project !== marker.project) return refuse('no lean_review prepare was run for it yet (the mod knows no reviewed sha)')
  const rec = await readReview(h, seen.project, seen.sha)
  if (!rec) return refuse(`no lean_review record exists for the reviewed sha ${seen.sha.slice(0, 12)}`)
  if (rec.level === 'light') return refuse(`the record for ${seen.sha.slice(0, 12)} is a light pass (one pass, a checkpoint): prepare again with level "full"`)
  const counts = Object.entries(rec.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')
  const evidence = [
    '--- review evidence (appended by the mod from the review store) ---',
    `record sha: ${rec.sha}`,
    `level: ${rec.level ?? 'unknown'}${rec.mode === 'external' ? ', external (not a push-gate record)' : rec.green ? ', green' : ', not green'}`,
    `passes: ${rec.passes ?? (rec.verdicts?.length ?? 'unknown')}${rec.model ? `, model ${rec.model}` : ''}`,
    `verdicts: ${rec.verdicts?.length ? rec.verdicts.join(', ') : 'none recorded'}`,
    `findings: ${counts || (rec.findings?.length ? `${rec.findings.length} open` : 'none open')}`,
  ].join('\n')
  return { ok: true, text: `${text.trimEnd()}\n\n${evidence}` }
}
