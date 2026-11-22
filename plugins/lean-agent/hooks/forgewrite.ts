// A forge WRITE made by script (curl / wget / az rest / az repos|boards|devops|pipelines write subcommands / gh api with a write method /
// gh pr|issue comment|review|edit ...) against Azure DevOps or GitHub. A thread and a subagent never make one: the write is an action KIND the
// thread requests with lean_report (deskactions.ts), the user approves, the mod sends it. This module is the ONE detector (text based, so it also
// reads a command inside `bash -c`, a heredoc or a brief) used by the refusal (orchestrate.ts, guard.ts), the brief lint (thread tool) and the
// stale-memory retirement (memory load, doctor). The refusal text lists the kinds FROM THE TABLE, never by hand.
import { ACTION_KINDS } from './deskactions'

// the kinds as one line, from the action table: `ado-pr-reply (optional status) | ado-pr-thread-status | ... | batch`
export const kindsLine = (): string => Object.entries(ACTION_KINDS).map(([k, p]) => (/optional status/.test(p) ? `${k} (optional status)` : k)).join(' | ')
export const forgeRefusal = (): string => `forge writes go through the desk: lean_report with action {kind: ${kindsLine()}}; the user approves, the mod sends it. Reads: lean_run ci, or a reader.`
export const briefLintLine = (): string => `this brief asks for a forge write by script; a thread cannot: it must request an action kind (${kindsLine()})`
export const RETIRED_NOTE = '(retired: forge writes go through action kinds)'
export const FORGE_RULE = 'forge-write'
export const forgeRefusalHead = /^forge writes go through the desk/

const HOST = /dev\.azure\.com|\.visualstudio\.com|api\.github\.com|github\.com|\/_apis\//i
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
