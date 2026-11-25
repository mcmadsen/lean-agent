// Coaching tips (never blocks, never a model): what a user asks the desk in words, matched against this table by regex, and the direct
// command that does it. tips.ts decides whether the desk says so (once per command per day, not for a week after the user used the
// command directly, desk only, one per turn, config `tips`). The TABLE decides: no model ever picks a tip.
export type Intent = { id: string; re: RegExp; command: string; example: string }

// order matters: the first allowed match of a turn wins
export const INTENTS: Intent[] = [
  { id: 'review', re: /\b(review|look over|code[- ]review)\b[^.?!\n]{0,60}\b(pr|pull request|pull-request|branch|commit|sha|merge request|#\d+)\b|\breview\s+(#?\d+\b|https?:\/\/\S+\/(pull|pullrequest)\/\d+)/i, command: '/lean-agent:review', example: '/lean-agent:review <pr>' },
  { id: 'review-learn', re: /\blearn(ing)?\s+from\s+(the\s+)?(pr|pull request|review)s?\b|\breview[- ]learn\b/i, command: '/lean-agent:review-learn', example: '/lean-agent:review-learn <project> [PR number]' },
  { id: 'rules-pr', re: /\brules[- ]?pr\b|\bupstream\s+(the\s+)?(learned\s+)?rules\b|\bpropose\s+a\s+rules\b/i, command: '/lean-agent:rules-pr', example: '/lean-agent:rules-pr <project>' },
  { id: 'pr', re: /\b(open|create|make|raise|file)\s+(me\s+)?(a\s+|the\s+)?(draft\s+)?(pr|pull request)\b|\bpr status\b|\bstatus of (the\s+)?(pr|pull request)\b/i, command: '/lean-agent:pr', example: '/lean-agent:pr create | status [tN]' },
  { id: 'handover', re: /\bhand[- ]?over\b|\bhand[- ]?off note\b|\bwrite (up )?(a )?handoff\b/i, command: '/lean-agent:handover', example: '/lean-agent:handover <tN>' },
  { id: 'goals', re: /\b(thread|everyone|everybody)'?s?\s+goals?\b|\bgoals? (of|for) (the )?threads?\b|\bwhat is everyone working on\b|\bset (the )?goal\b/i, command: '/lean-agent:goals', example: '/lean-agent:goals list | set <tN> <text>' },
  { id: 'list', re: /\b(list|show|which|what)\b[^.?!\n]{0,20}\bthreads?\b|\bthreads? (overview|list|status)\b/i, command: '/lean-agent:list', example: '/lean-agent:list' },
  { id: 'budget', re: /\b(budget|daily cap|spend cap|remaining budget)\b/i, command: '/lean-agent:budget', example: '/lean-agent:budget [show | cap <tokens>]' },
  { id: 'stats', re: /\b(how much|what)\b[^.?!\n]{0,30}\b(spent|spend|cost|costs)\b|\bstats\b|\busage (so far|today|this week)\b/i, command: '/lean-agent:stats', example: '/lean-agent:stats [days] [project]' },
  { id: 'doctor', re: /\bdoctor\b|\bnot set up\b|\bdesk did not open\b|\bfix (the )?(install|setup)\b/i, command: '/lean-agent:doctor', example: '/lean-agent:doctor [check | fix | migrate]' },
  { id: 'feedback', re: /\b(send|file|write|draft)\s+(some\s+)?(feedback|a bug report|a bug|a feature request)\b|\bexport feedback\b/i, command: '/lean-agent:feedback', example: '/lean-agent:feedback <what happened>' },
  { id: 'new', re: /\b(start|spawn|open|create|kick off)\s+(me\s+)?(a\s+)?new\s+thread\b/i, command: '/lean-agent:new', example: '/lean-agent:new <title> -- <brief>' },
]

export const intentOf = (text: string, skip: (id: string) => boolean = () => false): Intent | null => {
  const t = text.slice(0, 600)
  for (const it of INTENTS) if (!skip(it.id) && it.re.test(t)) return it
  return null
}

// a prompt that already is a direct call: `/lean-agent:review ...` (also as the expanded `<command-name>` form); the old `threads` is `list`
export function directUse(text: string): string | null {
  const m = /^\s*(?:<command-name>\s*)?\/?lean-agent:([a-z][a-z-]*)/i.exec(text)
  if (!m) return null
  const n = m[1]!.toLowerCase()
  return n === 'threads' ? 'list' : INTENTS.some(i => i.id === n) ? n : null
}
