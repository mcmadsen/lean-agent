// THE SCRIPT TABLE of the advance accept (deskwrites.ts): which written words of the user count as an instruction for the work on a PR or work
// item. One data file; no model judges it. English plus a few obvious variants. Edit here, nothing else decides.
//
// An instruction is ONE of:
//   WORK:     a verb of VERBS, then (within WORK_GAP characters, same sentence) an object of OBJECTS      "fix the comments on PR 42"
//   EXPLICIT: a word of EXPLICIT_LEAD, then (within the gap) a word of EXPLICIT_OBJECT                    "go ahead with the replies" / "allow writes"
//   COMMAND:  the prompt starts with a command of COMMANDS (the user typed `/lean-agent:allow t3 42`: the command is the explicit way)
// A verb right after a negation (NEGATION, up to NEG_GAP characters before it) does not count ("don't fix the comments").
export const WORK_GAP = 80
export const NEG_GAP = 24
export const VERBS = ['fix', 'fixes', 'fixing', 'resolve', 'resolves', 'resolving', 'address', 'addresses', 'addressing', 'answer', 'answers', 'answering', 'reply to', 'reply on', 'reply', 'replies to', 'handle', 'handles', 'handling', 'respond to', 'responding to', 'respond', 'close', 'closing', 'update', 'updating', 'deal with', 'dealing with', 'take care of', 'sort out', 'work through', 'go through']
export const OBJECTS = ['comment', 'comments', 'thread', 'threads', 'review', 'reviews', 'feedback', 'pr', 'prs', 'pull request', 'pull requests', 'work item', 'workitem', 'work items', 'ticket', 'task']
export const EXPLICIT_LEAD = ['approve', 'approved', 'allow', 'allowed', 'go ahead', 'yes', 'ok', 'okay', 'permit']
export const EXPLICIT_OBJECT = ['write', 'writes', 'reply', 'replies', 'comment', 'comments']
export const COMMANDS = ['/lean-agent:allow', '/allow']
// the user's own words that take a grant back (deskwrites.ts revokeByWords): "stop writes", "revoke", "revoke tN", "no more writes"
export const REVOKE_WORDS = ['stop writes', 'stop the writes', 'stop writing', 'revoke', 'no more writes', 'no more replies', 'cancel the writes']
export const REVOKE_COMMANDS = ['/lean-agent:revoke']

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+')
const alt = (l: string[]) => l.map(esc).join('|')
const WORK = new RegExp(`(?<![\\w-])(${alt(VERBS)})(?![\\w-])[^.!?\\n]{0,${WORK_GAP}}?(?<![\\w-])(${alt(OBJECTS)})(?![\\w-])`, 'gi')
const EXPLICIT = new RegExp(`(?<![\\w-])(${alt(EXPLICIT_LEAD)})(?![\\w-])[^.!?\\n]{0,${WORK_GAP}}?(?<![\\w-])(${alt(EXPLICIT_OBJECT)})(?![\\w-])`, 'gi')
const NEGATION = /(?<![\w-])(don'?t|do\s+not|dont|never|not|no|without|stop|cannot|can'?t)(?![\w-])/i

const negated = (text: string, at: number): boolean => NEGATION.test(text.slice(Math.max(0, at - NEG_GAP), at))

// does the text carry an instruction for the work (see above)? Returns the matched words, or null
export function instructionIn(text: string): string | null {
  const t = text.trim()
  const low = t.toLowerCase()
  if (COMMANDS.some(c => low === c || low.startsWith(`${c} `))) return t.split(/\s+/)[0]!
  for (const re of [WORK, EXPLICIT]) {
    re.lastIndex = 0
    for (let m = re.exec(t); m; m = re.exec(t)) if (!negated(t, m.index)) return m[0]
  }
  return null
}

export function revokeIn(text: string): boolean {
  const low = text.trim().toLowerCase()
  if (REVOKE_COMMANDS.some(c => low === c || low.startsWith(`${c} `))) return true
  return new RegExp(`(?<![\\w-])(${alt(REVOKE_WORDS)})(?![\\w-])`, 'i').test(low)
}
