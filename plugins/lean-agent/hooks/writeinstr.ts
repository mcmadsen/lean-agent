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
// the command typed to the DESK's prompt; with the slash or without it (`lean-agent:allow t8 4321`, `allow t8 4321`) it is the command itself
export const COMMANDS = ['/lean-agent:allow', 'lean-agent:allow', '/allow', 'allow']
// SOFT: a word that asks for the work when the user pasted the URL of the PR or work item and no verb of the table is there ("please get this done <url>")
export const SOFT_WORDS = ['please', 'pls', 'get this done', 'get it done', 'get that done', 'lets get this done', "let's get this done", 'go ahead', 'go on', 'handle', 'handle it', 'finish', 'finish it', 'finish this', 'take it from here', 'carry on', 'proceed', 'do it', 'sort it']
const FORGE_URL = /https?:\/\/[^\s<>"']*\/(?:pullrequest|pull|_workitems\/edit)\/\d{1,9}/i
// A TYPED answer in the desk's dialog ("Other": the user's own words to that exact question, read from the tool result): a clear approval counts as the Approve
// press for that request id. The text is refused as a whole when it carries any REFUSE word (a negation, a wish to change or wait) or is longer than TYPED_MAX;
// "always" / "allow" in it is the fourth choice (allow this kind on this PR for 24 h). Anything else is free text: not an approval, and said so to the desk.
export const APPROVE_WORDS = ['approve', 'approved', 'yes', 'yep', 'yeah', 'ok', 'okay', 'go ahead', 'do it', 'always approve', 'allow', 'allowed', 'fine', 'sure']
export const ALWAYS_WORDS = ['always', 'allow']
export const REFUSE_WORDS = ['not', "don't", 'dont', 'do not', "doesn't", "won't", "can't", 'cannot', 'no', 'never', 'deny', 'denied', 'reject', 'cancel', 'wait', 'stop', 'but', 'however', 'instead', 'except', 'change', 'edit', 'rewrite']
export const TYPED_MAX = 120
export function typedApproval(text: string): { approve: boolean; always: boolean } {
  const t = text.replace(/[‘’]/g, "'").trim()
  const no = { approve: false, always: false }
  if (!t || t.length > TYPED_MAX) return no
  if (new RegExp(`(?<![\\w'-])(${alt(REFUSE_WORDS)})(?![\\w'-])`, 'i').test(t)) return no
  if (!new RegExp(`(?<![\\w-])(${alt(APPROVE_WORDS)})(?![\\w-])`, 'i').test(t)) return no
  return { approve: true, always: new RegExp(`(?<![\\w-])(${alt(ALWAYS_WORDS)})(?![\\w-])`, 'i').test(t) }
}

// the user's own words that take a grant back (deskwrites.ts revokeByWords): "stop writes", "revoke", "revoke tN", "no more writes"
export const REVOKE_WORDS = ['stop writes', 'stop the writes', 'stop writing', 'revoke', 'no more writes', 'no more replies', 'cancel the writes']
export const REVOKE_COMMANDS = ['/lean-agent:revoke']

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+')
const alt = (l: string[]) => l.map(esc).join('|')
const WORK = new RegExp(`(?<![\\w-])(${alt(VERBS)})(?![\\w-])[^.!?\\n]{0,${WORK_GAP}}?(?<![\\w-])(${alt(OBJECTS)})(?![\\w-])`, 'gi')
const EXPLICIT = new RegExp(`(?<![\\w-])(${alt(EXPLICIT_LEAD)})(?![\\w-])[^.!?\\n]{0,${WORK_GAP}}?(?<![\\w-])(${alt(EXPLICIT_OBJECT)})(?![\\w-])`, 'gi')
const SOFT = new RegExp(`(?<![\\w-])(${alt(SOFT_WORDS)})(?![\\w-])`, 'gi')
const NEGATION =/(?<![\w-])(don'?t|do\s+not|dont|never|not|no|without|stop|cannot|can'?t)(?![\w-])/i

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
  if (FORGE_URL.test(t) && !NEGATION.test(t)) {
    SOFT.lastIndex = 0
    for (let m = SOFT.exec(t); m; m = SOFT.exec(t)) if (!negated(t, m.index)) return m[0]
  }
  return null
}

// the user asks for a NEW work item ("create a bug for the flaky test", "open a task for it"): the words a work item CREATE rests on (no id exists to name)
export const CREATE_VERBS = ['create', 'creating', 'open', 'file', 'raise', 'add', 'make', 'log', 'write up']
export const CREATE_OBJECTS = ['work item', 'workitem', 'work items', 'ticket', 'bug', 'task', 'user story', 'story', 'issue']
const CREATE = new RegExp(`(?<![\\w-])(${alt(CREATE_VERBS)})(?![\\w-])[^.!?\\n]{0,${WORK_GAP}}?(?<![\\w-])(${alt(CREATE_OBJECTS)})(?![\\w-])`, 'gi')
export function createIn(text: string): string | null {
  CREATE.lastIndex = 0
  for (let m = CREATE.exec(text); m; m = CREATE.exec(text)) if (!negated(text, m.index)) return m[0]
  return null
}

export function revokeIn(text: string): boolean {
  const low = text.trim().toLowerCase()
  if (REVOKE_COMMANDS.some(c => low === c || low.startsWith(`${c} `))) return true
  return new RegExp(`(?<![\\w-])(${alt(REVOKE_WORDS)})(?![\\w-])`, 'i').test(low)
}
