// The skill listing of the desk and of a thread, trimmed to lean-agent's own skills that the ROLE uses, and a record of what happened to it
// (names and counts only: no skill descriptions, no file contents). Pure helpers plus per-process state (one process = one session).
// A listing entry is a bullet line: a skill name (optionally `name (annotation)`, optionally plugin:name) followed by a colon or a dash before
// its description. A description may run over several lines, indented or not (1.0.26: an unindented continuation line used to end the
// filtering, so every skill after it, the other plugins', stayed in the listing); the entry ends at the next bullet or a blank line.
const NAME = /^\s{0,3}(?:[-*•])\s+[`*_]*([A-Za-z0-9][A-Za-z0-9_.@-]*(?::[A-Za-z0-9_.@-]+)*)[`*_]*(?:\s+\([^)]*\))?(?::\s|:$|\s+[-–—]\s|$)/
const BULLET = /^\s{0,3}(?:[-*•])\s+\S/
const OWN = 'lean-agent:'

// Where each lean-agent skill and command is offered to the model (the `roles:` field of its SKILL.md; commands are the desk's). The
// listing of a role holds the entries offered to it, nothing else of lean-agent's: a skill still runs by `/lean-agent:<name>` whatever the
// listing says. skills-contract.mjs checks this table against the front matter. A name not in the table is kept (a new skill is never hidden).
export type Role = 'desk' | 'thread'
export const SKILL_ROLES: Record<string, Role[]> = {
  allow: ['desk'], 'allow-edit': ['desk'], list: ['desk'], new: ['desk'], revoke: ['desk'], 'revoke-edit': ['desk'], threads: ['desk'], // commands/*.md
  branch: ['thread'], budget: ['desk', 'thread'], compare: ['desk', 'thread'], config: ['desk'], doctor: ['desk'], feedback: ['desk', 'thread'],
  find: ['desk', 'thread'], goals: ['desk', 'thread'], handover: ['desk', 'thread'], 'lean-mode': ['thread'], learn: ['thread'],
  pr: ['desk', 'thread'], remember: ['desk', 'thread'], review: ['desk', 'thread'], 'review-learn': ['desk', 'thread'], 'rules-pr': ['desk', 'thread'],
  scripts: ['desk', 'thread'], stats: ['desk', 'thread'], thread: ['desk'], todo: ['desk', 'thread'], worktree: ['thread'],
}
// does a lean-agent skill name (`lean-agent:review`) belong in the listing of this role
export function offeredTo(role: Role, name: string): boolean {
  if (!name.startsWith(OWN)) return false
  const r = SKILL_ROLES[name.slice(OWN.length)]
  return !r || r.includes(role)
}

export type Trim = { text: string | null; reason: string }

// A listing keeps its non-skill lines and the lean-agent skill entries `keep` accepts (default: all of them). text null = leave the engine's
// text untouched: no skill lines found (format not recognised), nothing of lean-agent's to keep, or nothing to drop.
export function trimListing(text: string, keep: (name: string) => boolean = n => n.startsWith(OWN)): Trim {
  const out: string[] = []
  let total = 0
  let kept = 0
  let dropping = false
  let block: 'before' | 'in' | 'after' = 'before' // only the contiguous listing is filtered; bullets after it are kept
  for (const l of text.split('\n')) {
    if (block === 'in' && !l.trim()) block = 'after' // a blank line ends the listing
    const m = block !== 'after' && BULLET.test(l) ? NAME.exec(l) : null
    if (m) {
      block = 'in'
      total++
      dropping = !(m[1]!.startsWith(OWN) && keep(m[1]!))
      if (!dropping) kept++
    } else if (block === 'in' && dropping) continue // the wrapped description of a dropped skill, whatever its indentation
    else dropping = false
    if (!dropping) out.push(l)
  }
  if (!total) return { text: null, reason: 'format not recognised (no skill lines)' }
  if (!kept) return { text: null, reason: `no lean-agent skill among ${total}: left untouched` }
  if (kept === total) return { text: null, reason: `already only lean-agent skills (${total})` }
  return { text: out.join('\n'), reason: `trimmed ${total} -> ${kept}` }
}

export const leanSkillsOnly = (text: string): string | null => trimListing(text).text

// ---- what this session saw ---------------------------------------------------------------------------------------
type Stat = { type: string; reason: string }
let last: Stat | null = null
const types = new Set<string>() // attachment type names only
const sections = new Set<string>() // prompt section ids only
export const skillsSeen = (type: string, reason: string) => void (last = { type, reason })
// The skills the model really reads (chars / 4 of the listing after the mod's rewrite). The engine's context breakdown counts the whole inventory of
// skills (built-in, synced, user, every plugin's), whatever the mod rewrote: ctxparts uses this figure instead (measured live: 54 skills / 7.5k
// counted, 17 listed to a thread / about 1k read).
let carried = 0
export const noteCarried = (text: string) => void (carried = Math.round(text.length / 4))
export const skillsCarried = (): number => carried
export const noteAttachment = (type: string) => void (types.size < 40 && types.add(type))
export const noteSection = (name: string) => void (sections.size < 40 && sections.add(name))
export const skillStat = (): string => (last ? `${last.reason} (${last.type})` : 'no skill_listing attachment seen')
export const seenNames = (): string => `attachments: ${[...types].join(', ') || 'none'}; sections: ${[...sections].join(', ') || 'none'}`
export const resetSkillStat = () => {
  last = null
  carried = 0
  types.clear()
  sections.clear()
}

// attachment types that carry a skill listing: the engine's name, or any name holding "skill" (a build may rename it)
export const isSkillAttachment = (type: string) => /^(available_)?skills?(_listing)?$/.test(type)
export const isMcpInstructions = (name: string) => /mcp.*instruction|instruction.*mcp/i.test(name)
