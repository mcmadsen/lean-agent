// The desk's skill listing, trimmed to lean-agent's own skills, and a record of what happened to it (names and counts
// only: no skill descriptions, no file contents). Pure helpers plus per-process state (one process = one session).
// a skill line: a bullet, then a lowercase skill name (optionally plugin:name) followed by a colon or a dash before its description
const NAME = /^\s{0,3}(?:[-*\u2022])\s+[`*_]*([a-z0-9][a-z0-9_.@-]*(?::[a-z0-9_.@-]+)*)[`*_]*(?::\s|\s+[-\u2013\u2014]\s|$)/
const OWN = 'lean-agent:'

export type Trim = { text: string | null; reason: string }

// A listing keeps its non-skill lines and the `lean-agent:` skill lines. text null = leave the engine's text untouched:
// no skill lines found (format not recognised), no lean-agent skill in it, or nothing of another plugin to drop.
export function trimListing(text: string): Trim {
  const out: string[] = []
  let total = 0
  let kept = 0
  let dropping = false
  let block: 'before' | 'in' | 'after' = 'before' // only the contiguous listing is filtered; bullets after it are kept
  for (const l of text.split('\n')) {
    const m = block === 'after' ? null : NAME.exec(l)
    if (block === 'in' && !m && !/^\s+\S/.test(l)) block = 'after'
    if (m) {
      block = 'in'
      total++
      dropping = !m[1]!.startsWith(OWN)
      if (!dropping) kept++
    } else if (dropping && /^\s+\S/.test(l)) continue // a wrapped description of a dropped skill
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
export const noteAttachment = (type: string) => void (types.size < 40 && types.add(type))
export const noteSection = (name: string) => void (sections.size < 40 && sections.add(name))
export const skillStat = (): string => (last ? `${last.reason} (${last.type})` : 'no skill_listing attachment seen')
export const seenNames = (): string => `attachments: ${[...types].join(', ') || 'none'}; sections: ${[...sections].join(', ') || 'none'}`
export const resetSkillStat = () => {
  last = null
  types.clear()
  sections.clear()
}

// attachment types that carry a skill listing: the engine's name, or any name holding "skill" (a build may rename it)
export const isSkillAttachment = (type: string) => /^(available_)?skills?(_listing)?$/.test(type)
export const isMcpInstructions = (name: string) => /mcp.*instruction|instruction.*mcp/i.test(name)
