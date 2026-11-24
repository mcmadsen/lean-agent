// The report gate of a kind-review thread (reviewkind.ts): a `done` report is refused unless a lean_review record exists for the sha the
// thread prepared (a prepare WITH a ref; the record must be newer than it), at the full level with a reviewer verdict, and the mod
// appends the evidence from the store to the report itself (never from what the thread wrote).
// register.tsx calls reviewReport before threadTool's lean_report; other reports pass unchanged. A failure of the gate itself refuses.
import type { Host } from './state'
import { readReview } from './reviews'
import { prepareText, rangeWrong, requiredAreas, wasReset } from './reviewprepared'
import { scopeLine } from './reviewchange'
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
    // the LAST prepare of this ref is the only one that counts (reviewprepared.ts): an earlier prepare's areas never block
    const { areas: required, last } = await requiredAreas(h, thread, seen.project, seen.sha)
    if (last && rangeWrong(last)) return refuse(`the range of the last prepare looks wrong; prepare again (${prepareText(last)}, but the forge lists ${last.forgeN} files for the PR; base = the PR's target branch)`)
    if (!last && (await wasReset(h, thread, seen.sha))) return refuse('the prepared state of this PR was reset and no prepare ran since: prepare again for the real range')
    const rec = await readReview(h, seen.project, seen.sha)
    if (!rec) return refuse(`no lean_review record exists for the reviewed sha ${seen.sha.slice(0, 12)}`)
    if ((rec.ts ?? 0) < seen.ts) return refuse(`the record for ${seen.sha.slice(0, 12)} is older than your last prepare: record the review you just ran`)
    if (rec.level !== 'full') return refuse(`the record for ${seen.sha.slice(0, 12)} is ${rec.level === 'light' ? 'a light pass (one pass, a checkpoint)' : 'not a full-level review record (no reviewer result was recorded)'}: prepare again with level "full" and record the reviewer's JSON`)
    if (!rec.verdicts?.length) return refuse(`the record for ${seen.sha.slice(0, 12)} carries no reviewer verdict`)
    // a PR reviewed by area (reviewarea.ts): every area the prepare listed must have its record
    const left = required.filter(n => !rec.areas?.[n])
    if (left.length) return refuse(`the PR is reviewed by area and ${left.join(', ')} of the last prepare (${last ? `${last.id}, ${last.files} files` : 'an older one'}) ${left.length === 1 ? 'has' : 'have'} no record yet (lean_review prepare with scope, the reviewer pass, lean_review record with the same scope; if the range is wrong, prepare again with the right base or reset-prepare: never review files outside the PR to satisfy this)`)
    const counts = Object.entries(rec.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')
    const evidence = [
      '--- review evidence (appended by the mod from the review store) ---',
      `record sha: ${rec.sha}`,
      `level: ${rec.level}${rec.mode === 'external' ? ', external (not a push-gate record)' : rec.green ? ', green' : ', not green'}`,
      `passes: ${rec.passes ?? rec.verdicts.length}${rec.model ? `, model ${rec.model}` : ''}`,
      `verdicts: ${rec.verdicts.join(', ')}`,
      ...(last ? [`prepare checked: ${prepareText(last)}`] : []),
      ...(rec.areas ? [`areas: ${Object.entries(rec.areas).map(([n, a]) => `${n} ${a.verdict} (${a.open} open)`).join('; ')}`] : []),
      `findings: ${counts || (rec.findings?.length ? `${rec.findings.length} open` : 'none open')}`,
      ...(rec.scoped ? [scopeLine(rec.scoped)] : ['changed-code filter: this record has no filter summary (recorded by an older lean-agent)']), // (the mod's own count: what was reviewed, what was dropped)
    ].join('\n')
    return { ok: true, text: `${text.trimEnd()}\n\n${evidence}` }
  } catch (err) {
    return refuse(`the gate could not read the review store (${String((err as Error)?.message ?? err).slice(0, 120)})`)
  }
}
