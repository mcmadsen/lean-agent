// The "lite" setup of a SMALL thread (1.0.32, config threads.liteSetup, default true). The first request of a thread carries about 12k tokens of
// fixed base even on the leanest defaults, 3.3k of them the thread guide (CLAUDE.md) and 4k the lean-agent tool schemas; a thread started as
// haiku / low with a one-step brief reviews nothing, opens no PR and touches no work item, so those guide sections and the tools only they
// need stay out of its first request. Measured by scripts/first-request.mjs (the table in README "Fixed overhead").
//   what is cut   the guide lines for reviews, pushes / PRs, work items and every forge write or read, memory and scripts: one line each
//                 saying "ask the desk" (liteGuide); the tools lean_review, lean_script, lean_goal and lean_remember are deferred
//                 (behind ToolSearch, never removed: LITE_DEFERRED_TOOLS)
//   what stays    everything else of the guide (the report rule among it), lean_report, lean_ask, lean_run, the worker agents, the skills
//                 (agent listing and skills listing are each under 1k tokens: not worth a behaviour change)
// A normal thread is untouched byte for byte: liteGuide is only called for a thread that is lite. No imports (node loads this file directly).

export const LITE_BRIEF_CHARS = 600
// a brief that asks for one thing: under 600 characters, at most one numbered / bulleted item or "step N", no "then" chain
export function oneStepBrief(text: unknown): boolean {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t || t.length >= LITE_BRIEF_CHARS) return false
  const items = t.split('\n').filter(l => /^\s*(?:\d+[.)]\s|[-*•]\s|step\s*\d+\b)/i.test(l)).length
  if (items > 1) return false
  return !/\b(?:then|afterwards|after that|and finally|finally)\b/i.test(t)
}

// work a one-step small thread has no use for: it never reviews, opens no PR, touches no work item (a brief that names one is not lite)
const BIG = /\b(?:pr|prs|pull request|work ?items?|review|reviews|reviewer|push|merge|azure|devops|ado|forge|github|gh|comment|release|tag)\b|lean-agent:review/i

export type LiteInput = { enabled: boolean; model?: string; effort?: string; brief?: unknown; review?: boolean; pr?: boolean; workitem?: boolean; continues?: boolean }
// haiku / low, one step, nothing a review thread, a PR or a work item needs; `enabled` is config threads.liteSetup
export function isLite(i: LiteInput): boolean {
  if (!i.enabled || i.review || i.pr || i.workitem || i.continues) return false
  if (!/haiku/i.test(i.model ?? '') || (i.effort ?? '') !== 'low') return false
  const brief = typeof i.brief === 'string' ? i.brief : ''
  return oneStepBrief(brief) && !BIG.test(brief)
}

// does a thread started lite (thread.json `lite`, decided once at `new`) still run haiku / low (a restart may name another model) with the config on
export const liteHolds = (t: { lite?: unknown; model?: unknown; effort?: unknown }, enabled: boolean): boolean => enabled && t.lite === true && /haiku/i.test(String(t.model ?? '')) && t.effort === 'low'

// tools a lite thread finds behind ToolSearch instead of on its first request (lean_report, lean_ask and lean_run stay loaded)
export const LITE_DEFERRED_TOOLS: readonly string[] = ['lean_review', 'lean_script', 'lean_goal', 'lean_remember']

// the guide lines (by their opening words in templates/thread.md) a lite thread does not get; scripts/first-request.mjs --check fails when one no longer matches exactly one template line
export const LITE_DROP: readonly string[] = [
  '- Data work',
  '- Reviews:',
  '- Subagent cap:',
  '- You never run `git push`',
  '- A remote write you may not make',
  '- Review comments:',
  '- Review writes',
  "- The task's work item and PR",
  '- Never curl / az / gh a forge write',
  '- Forge reads:',
  '- Memory (skill `remember`)',
]
// the lines that stand in for them, at the place of the first dropped line (a line the report rule is in is never dropped)
export const LITE_LINES: readonly string[] = [
  '- Reviews, pushes and releases: not in this small thread. You never run `git push` or `gh pr create`, never review by hand: ask the desk.',
  '- Pull requests, work items, comments, replies, votes and every forge read or write: never run them yourself (a guard refuses forge writes): ask the desk.',
  '- Memory and scripts (counting, diffing, validating): `lean_remember` and `lean_script` are behind ToolSearch; for anything beyond one step ask the desk.',
]
const TOOLS_OLD = ', `lean_goal`, `lean_remember`.'
const TOOLS_NEW = '; `lean_goal`, `lean_remember`, `lean_review`, `lean_script` are loaded on demand: ToolSearch first.'
export const REPORT_SENTENCE = 'ends with lean_report'

// the thread guide of a lite thread: the same text with LITE_DROP lines replaced by LITE_LINES
export function liteGuide(text: string): string {
  const out: string[] = []
  let put = false
  for (const l of text.split('\n')) {
    if (!l.includes(REPORT_SENTENCE) && LITE_DROP.some(p => l.startsWith(p))) {
      if (!put) out.push(...LITE_LINES)
      put = true
      continue
    }
    out.push(l.startsWith('- Tools: `lean_report`') ? l.replace(TOOLS_OLD, TOOLS_NEW) : l)
  }
  return out.join('\n')
}
