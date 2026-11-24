// 1.0.31: what a review puts on the PR together with its comments, decided by a script (never by the model): the vote / review state that goes LAST in the
// same request as the comments, and the severity word every review comment starts with. Pure functions; deskactions.ts checks and sends the items.
// the switches (config.json): `review.prChecks` (review side: severity, size) and `pr.checks` (create side: guide, size, draft, secrets, force); each is false (all
// off) or an object {name: false} (that one off); anything else, or unset: on
export type CheckName = 'severity' | 'size' | 'guide' | 'draft' | 'secrets' | 'force'
export const checkOn = (cfg: unknown, group: 'review' | 'pr', name: CheckName): boolean => {
  const g = (cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>)[group] : null) as Record<string, unknown> | null
  const v = g && typeof g === 'object' ? g[group === 'review' ? 'prChecks' : 'checks'] : undefined
  if (v === false) return false
  return !(v && typeof v === 'object' && (v as Record<string, unknown>)[name] === false)
}
export const SEVERITY_WORDS = ['blocking', 'major', 'minor', 'nit', 'question'] as const
export type SeverityWord = (typeof SEVERITY_WORDS)[number]
// the reviewer's own severities (blocker | major | minor | nit) and the words a reader sees
const WORD_OF: Record<string, SeverityWord> = { blocker: 'blocking', blocking: 'blocking', major: 'major', minor: 'minor', nit: 'nit', question: 'question' }
export const severityWord = (s: unknown): SeverityWord | null => (typeof s === 'string' ? WORD_OF[s.trim().toLowerCase()] ?? null : null)
const PREFIXED = /^\W{0,4}(blocking|blocker|major|minor|nit|question)\s*:/i
// the comment text with its severity word in front, unless it already starts with one
export const withSeverity = (body: string, severity: unknown): string => {
  const w = severityWord(severity)
  return !w || PREFIXED.test(body.trimStart()) ? body : `${w}: ${body.trimStart()}`
}

// a posted comment of severity blocking / major / minor asks the author to change something; a nit or a question alone does not
const ASKS = new Set<SeverityWord>(['blocking', 'major', 'minor'])
export type Advice = { vote: 'approve' | 'wait-for-author' | 'none'; summary: string; blocking: number; comments: number }
// severities: of the comments the review posts; green: the gate's verdict for the head; author: the user wrote this PR (it is never approved by the mod)
export function voteAdvice(severities: unknown[], green: boolean, author: boolean): Advice {
  const words = severities.map(severityWord)
  const comments = words.length
  const blocking = words.filter(w => w === 'blocking').length
  const asks = words.some(w => !!w && ASKS.has(w)) || words.some(w => !w) // a comment without a severity counts as one that asks
  const summary = `${comments} comment${comments === 1 ? '' : 's'}: ${blocking} blocking`
  if (asks || !green) return { vote: 'wait-for-author', summary, blocking, comments }
  // a green review with no comment that asks for a change proposes an approval (asked), or nothing for the author's own PR
  return { vote: author ? 'none' : 'approve', summary, blocking, comments }
}
// the line the review record prints for the thread: what the ONE last item of the comment request is
export function voteLine(a: Advice): string {
  if (a.vote === 'none') return 'PR vote: none (a green review of your own PR is never approved by the mod)'
  if (a.vote === 'approve') return 'PR vote: green with no comment that asks for a change: the request may carry ONE last item: Azure DevOps ado-pr-vote approve, GitHub gh-pr-review event approve (the user\'s Approve names it; never approve by yourself; no vote on a PR the user wrote)'
  return `PR vote: the comment request carries ONE extra last item: Azure DevOps ado-pr-vote vote wait-for-author, GitHub gh-pr-review event request-changes with body "${a.summary}" (the user's Approve covers all; the vote is sent after the comments)`
}
