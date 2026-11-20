// `lean_doctor refusals`: the guard's own recorded refusals (the rows of ~/.lean-agent/refusals.jsonl that the feedback export lists under
// "Guard refusals"), grouped by PATTERN with a count and a one-line fix, so a block that keeps happening is seen once, with what removes it:
// a grant the brief should have given, a command the reader set lacks, a path a worker needs. No model reads anything: the pattern is
// decided by the shape of the refusal text, and nothing here ever allows anything (a fix is advice, never a rule that is added).
// The doctor shows a "top refusals" row when a pattern repeats (config.json `refusals.repeat`, default 3).
import { homeDir, leanDir, readJsonl } from './state'
import type { Host } from './state'
import { readConfig } from './budget'

export const REPEAT_DEFAULT = 3
export const DAYS_DEFAULT = 7
type Row = { ts?: number; text?: string; agent?: string; src?: string; command?: string; thread?: string }
export type Pattern = { key: string; label: string; fix: string }
export type Group = Pattern & { n: number; agents: string[] }

const VERSION_TAIL = /\s*\(lean-agent \d[\w.-]*\)\s*$/
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : p
}

// the shape of one refusal text -> its pattern. The texts are the guard's own (guard.ts); an unknown shape is its own pattern.
export function patternOf(rawText: string, agent: string): Pattern {
  const text = rawText.replace(VERSION_TAIL, '').replace(/\s+/g, ' ').trim()
  const who = agent || 'session'
  let m = /^lean-agent: refused: (\S+) \(([^)]*)\); (\S+) may run only/.exec(text)
  if (m) {
    const prog = m[1]!
    const why = m[2]!
    const kind = prog === 'cd' ? 'cd' : /redirect|substitution|glob|shell form/.test(why) ? 'shell' : /flag that writes|runs a program/.test(why) ? 'flag' : /outside the allowed/.test(why) ? 'path' : 'other'
    const fixes: Record<string, string> = {
      cd: 'a reader never cds: name absolute paths, or git -C <abs repo> ...',
      shell: 'one plain command per call: no ;, &&, ||, redirects, $(...) or a glob that leaves the allowed folders; a grant (allow-cmd) never covers a shell form',
      flag: 'that flag writes or runs a program: not grantable to a reader; have a worker (with allow-edit) or the thread do it',
      path: 'the path is outside the folders a reader may read: name one inside the worktree, or the thread grants that exact command with allow-cmd',
      other: `if \`${prog}\` is read-only and the work needs it, the thread grants it in the Agent prompt (allow-cmd: <the command>) or passes allowCmd on lean_thread new`,
    }
    return { key: `cmd:${who}:${prog}:${kind}`, label: `${who} refused \`${prog}\` (${why})`, fix: fixes[kind]! }
  }
  if (/may run only its built-in read-only git commands and the commands the thread granted/.test(text)) return { key: `cmd-old:${who}`, label: `${who} refused a command (older lean-agent wording: the program is not named)`, fix: 'update lean-agent: since 1.0.9 readers run the whole read-only set and the refusal names the program' }
  m = /^lean-agent: (\/\S+) is outside the paths the thread granted this worker/.exec(text)
  if (m) {
    const dir = dirOf(m[1]!)
    return { key: `edit:${dir}`, label: `a worker's edit outside allow-edit: ${dir}`, fix: `give it in the brief: allowEdit: ["${dir}"] on lean_thread new (a path outside the worktree, such as a repo's .claude/skills file, is the usual one), or the thread adds allow-edit: ${dir} to the worker's prompt` }
  }
  if (/strict mode: route this to a thread/.test(text)) return { key: 'desk-strict', label: 'the desk was refused a command or file (strict mode)', fix: 'the desk routes work to a thread (thread skill); it reads only under ~/.lean-agent and runs the read-only git / gh forms' }
  if (/subagent cap reached/.test(text)) return { key: 'cap', label: 'the subagent cap was reached', fix: 'raise agents.cap in config.json, or do the rest in the thread (reviewer passes never count)' }
  m = /^lean-agent: (\S+) needs the user's approval/.exec(text)
  if (m) return { key: `model:${m[1]}`, label: `${m[1]} was refused until the user approves it`, fix: 'approve it in the pane (Needs you) when it is worth it, otherwise start the work on sonnet' }
  if (/push gate/.test(text)) return { key: 'push-gate', label: 'a thread tried git push', fix: 'a thread never pushes: run the full review, then lean_report "ready to push <sha>"; the desk pushes after the user\'s yes' }
  if (/a thread never asks the user directly/.test(text)) return { key: 'thread-ask', label: 'a thread used AskUserQuestion', fix: 'a thread asks with lean_ask; the desk relays it' }
  if (/cannot own grants/.test(text)) return { key: 'grants-owner', label: 'an Agent call with allow-* lines outside a thread', fix: 'grants are written only by a thread\'s own session: remove the lines or run the call from a thread' }
  return { key: `other:${who}:${text.slice(0, 50)}`, label: `${who}: ${text.slice(0, 120)}`, fix: 'read the refusal text; it names what was refused and why' }
}

export async function groupRefusals(h: Host, days = DAYS_DEFAULT): Promise<{ groups: Group[]; total: number; since: number }> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const since = now - Math.max(1, days) * 86_400_000
  const groups = new Map<string, Group>()
  let total = 0
  // the guard's own rows only (a worker's own report of a refusal is counted in the export separately, never twice here)
  for (const r of await readJsonl<Row>(h, `${leanDir(home)}/refusals.jsonl`)) {
    if (!r || r.src === 'worker' || r.command !== undefined || typeof r.text !== 'string' || (typeof r.ts === 'number' && r.ts < since)) continue
    total++
    const agent = (r.agent ?? 'session').replace(/^lean-agent:/, '')
    const p = patternOf(r.text, agent)
    const g = groups.get(p.key)
    if (g) {
      g.n++
      if (!g.agents.includes(agent)) g.agents.push(agent)
    } else groups.set(p.key, { ...p, n: 1, agents: [agent] })
  }
  return { groups: [...groups.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)), total, since }
}

export async function repeatOf(h: Host): Promise<number> {
  const v = Number((await readConfig(h, await homeDir(h))).refusals?.repeat)
  return Number.isInteger(v) && v >= 2 ? v : REPEAT_DEFAULT
}

// the action's text: every pattern, most frequent first, each with its one-line fix
export async function refusalsText(h: Host, days = DAYS_DEFAULT): Promise<string> {
  const d = Number.isFinite(days) && days >= 1 ? Math.min(90, Math.floor(days)) : DAYS_DEFAULT
  const { groups, total } = await groupRefusals(h, d)
  if (!total) return `no guard refusal in the last ${d} day(s)`
  const repeat = await repeatOf(h)
  return [`${total} guard refusal(s) in the last ${d} day(s), ${groups.length} pattern(s) (the rows the feedback export lists under "Guard refusals"); a pattern that repeats ${repeat} times or more is a block to remove:`, ...groups.map(g => `- (x${g.n})${g.n >= repeat ? ' REPEATS' : ''} ${g.label}\n    fix: ${g.fix}`)].join('\n')
}

// the doctor's row: null when nothing repeats
export async function topRefusalsRow(h: Host): Promise<string | null> {
  const repeat = await repeatOf(h)
  const { groups } = await groupRefusals(h, DAYS_DEFAULT)
  const top = groups.filter(g => g.n >= repeat).slice(0, 3)
  if (!top.length) return null
  return `note top refusals (last ${DAYS_DEFAULT} days): ${top.map(g => `(x${g.n}) ${g.label}: ${g.fix}`).join(' | ')}. All of them: lean_doctor refusals`
}
