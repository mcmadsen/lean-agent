// A forge WRITE made by script (curl / wget / az rest / az repos|boards|devops|pipelines write subcommands / gh api with a write method /
// gh pr|issue comment|review|edit ...) against Azure DevOps or GitHub. A thread and a subagent never make one: the write is an action KIND the
// thread requests with lean_report (deskactions.ts), the user approves, the mod sends it. This module is the ONE detector (text based, so it also
// reads a command inside `bash -c`, a heredoc or a brief) used by the refusal (orchestrate.ts, guard.ts), the brief lint (thread tool) and the
// stale-memory retirement (memory load, doctor). The refusal text lists the kinds FROM THE TABLE, never by hand.
import { ACTION_KINDS } from './deskactions'
import { appendJsonl, atomicWrite, homeDir, leanDir } from './state'
import type { Host } from './state'

// the kinds as one line, from the action table: `ado-pr-reply (optional status) | ado-pr-thread-status | ... | batch`
export const kindsLine = (): string => Object.entries(ACTION_KINDS).map(([k, p]) => (/optional status/.test(p) ? `${k} (optional status)` : k)).join(' | ')
export const forgeRefusal = (): string => `forge writes go through the desk: lean_report with action {kind: ${kindsLine()}}; the user approves, the mod sends it. Reads: lean_run ci, or a reader.`
export const briefLintLine = (): string => `this brief asks for a forge write by script; a thread cannot: it must request an action kind (${kindsLine()})`
export const RETIRED_NOTE = '(retired: forge writes go through action kinds)'
// a remembered item (memory, handover) that describes a forge write by script is not passed on as it is: it becomes the retired note, counted
let retiredSeen = 0
export const retiredAtLoad = (): number => retiredSeen
export function retireText(text: string): string {
  if (!isForgeWrite(text)) return text
  retiredSeen++
  return RETIRED_NOTE
}
// the store (memory/notes.jsonl): how many items describe a forge write by script, and `lean_doctor fix` retiring them in place (a backup file is kept)
const notesFile = async (h: Host): Promise<string> => `${leanDir(await homeDir(h))}/memory/notes.jsonl`
const readNotes = async (h: Host): Promise<string> => {
  const r = await h.fs.read(await notesFile(h)).catch(() => '')
  return typeof r === 'string' ? r : ''
}
const forgeNote = (line: string): { row: Record<string, unknown> } | null => {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    return o && typeof o === 'object' && typeof o.text === 'string' && o.text !== RETIRED_NOTE && isForgeWrite(o.text) ? { row: o } : null
  } catch {
    return null
  }
}
export async function staleMemoryCount(h: Host): Promise<number> {
  return (await readNotes(h)).split('\n').filter(l => forgeNote(l)).length
}
export async function retireMemory(h: Host): Promise<string> {
  const file = await notesFile(h)
  const raw = await readNotes(h)
  let n = 0
  const lines = raw.split('\n').map(l => {
    const f = forgeNote(l)
    if (!f) return l
    n++
    return JSON.stringify({ ...f.row, text: RETIRED_NOTE })
  })
  if (!n) return 'remembered items: none describe a forge write by script'
  const ts = await h.clock.now()
  const backup = `${file}.bak-${ts}`
  await atomicWrite(h, backup, raw)
  await atomicWrite(h, file, lines.join('\n'))
  await appendJsonl(h, `${leanDir(await homeDir(h))}/logs/doctor.jsonl`, { ts, kind: 'memory-retired', items: n, backup })
  return `remembered items: retired ${n} that described a forge write by script (they now say "${RETIRED_NOTE}"; backup ${backup})`
}
export const FORGE_RULE = 'forge-write'
export const forgeRefusalHead = /^forge writes go through the desk/

const HOST = /dev\.azure\.com|\.visualstudio\.com|api\.github\.com|github\.com|\/_apis\/|\/pullRequests\/\S*\/threads/i // (a note that gives only the path `.../pullRequests/<pr>/threads/<id>` is the same write)
const METHOD = /(?:^|[\s'"])(?:-X|--request|--method|-m)[\s=]*['"]?(?:POST|PATCH|PUT|DELETE)\b/i
const GET_METHOD = /(?:^|[\s'"])(?:-X|--request|--method)[\s=]*['"]?GET\b/i
const DATA = /(?:^|\s)(?:(?:-d|-F|-T)(?=[\s='"@{]|$)|--(?:data(?:-binary|-raw|-urlencode|-ascii)?|json|form(?:-string)?|upload-file|post-data|post-file|body-data|body-file)(?=[\s=]|$))/
const GH_FIELD = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?=[\s='"]|$)/
const AZ_READ = /^(list|show|query|get|list-.*|show-.*)$/
const AZ_WRITE = /^(create|update|delete|add|remove|set|set-vote|set-auto-complete|abandon|complete|approve|reject|reactivate|reset|run|queue|invoke|import|restore|move|vote)$/
const PROG = (name: string): RegExp => new RegExp(`(?:^|[^\\w./-])${name}(?![\\w-])`)

export function isForgeWrite(command: string): boolean {
  const t = command.replace(/\\\r?\n/g, ' ')
  if ((PROG('curl').test(t) || PROG('wget').test(t)) && HOST.test(t) && (METHOD.test(t) || DATA.test(t))) return true
  if (/(?:^|[^\w./-])az\s+(?:-\S+\s+)*rest(?![\w-])/.test(t) && METHOD.test(t)) return true
  for (const m of t.matchAll(/(?:^|[^\w./-])az\s+(?:repos|boards|devops|pipelines)((?:\s+[a-z][a-z-]*){1,4})/g)) {
    const first = m[1]!.trim().split(/\s+/).find(w => AZ_READ.test(w) || AZ_WRITE.test(w))
    if (first && AZ_WRITE.test(first)) return true
  }
  if (/(?:^|[^\w./-])gh\s+(?:-\S+\s+)*api(?![\w-])/.test(t) && (METHOD.test(t) || (GH_FIELD.test(t) && !GET_METHOD.test(t)))) return true
  return /(?:^|[^\w./-])gh\s+(?:(?:-R|--repo)\s+\S+\s+)?(?:pr|issue)\s+(?:comment|review|edit|close|reopen|merge|ready|lock|unlock)(?![\w-])/.test(t)
}
