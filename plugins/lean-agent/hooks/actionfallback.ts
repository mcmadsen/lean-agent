// A FALLBACK THE USER RUNS THEMSELVES (1.0.33). When one kind of desk action (ado-workitem-create, ado-pr-comment, gh-issue-create) failed twice for a
// thread, the desk used to say only "failed" and the user typed "use the az command like we always do": the thread refused (its guard forbids a forge
// write by az / gh / curl) and nothing documented a way out. Now the desk gets, by script, ONE copy-pasteable command for the USER's own shell, built from
// the request's own (already checked) params, plus the sentence why the thread cannot run it. Nothing here runs a command, and no thread gets a way to
// make a forge write: the rule stays, the command is only text for the person.
//
// Quoting: every value is POSIX single-quoted (a quote becomes '\''), so a quote, $, a backtick, a backslash or a newline in a title is a literal
// character in bash and zsh. Every flag is `--name=<quoted value>` so a value that starts with a dash is never read as an option. A JSON body is
// built with JSON.stringify first (newlines become \n: one line), then quoted. A value that looks like a secret is never printed: no command then.
import { COMMENT_TYPES, STATUS_CODES } from './deskactions'

export const shq = (s: string): string => `'${s.replace(/\0/g, '').replace(/'/g, `'\\''`)}'`
const flag = (name: string, v: string | number): string => `--${name}=${shq(String(v))}`
// what must never be printed into a command line: a token, a key, a password assignment (the request text could carry one by mistake)
const SECRET = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S{8,}/i
export const looksSecret = (s: string): boolean => SECRET.test(s)

type P = Record<string, unknown>
const s = (p: P, k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
const n = (p: P, k: string): number | undefined => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : undefined)

export const FALLBACK_KINDS = ['ado-workitem-create', 'ado-pr-comment', 'gh-issue-create'] as const
export const WHY_NOT_THREAD = 'Why not from the thread: a thread never makes a forge write (az, gh, curl); it asks for an action kind and the mod sends it after your Approve. That rule has no one-off exception, not even by your words, so the command is for your own shell.'
const AZ_ORG = (org: string) => `https://dev.azure.com/${encodeURIComponent(org)}`
const AZ_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798' // Azure DevOps' own application id, what `az rest` needs for a dev.azure.com URL

// the command, or null when the kind has none or a value looks like a secret
export function fallbackCommand(kind: string, p: P): string | null {
  const texts = Object.values(p).filter((v): v is string => typeof v === 'string')
  if (texts.some(looksSecret)) return null
  if (kind === 'gh-issue-create') {
    const repo = s(p, 'repo')
    if (!repo || !s(p, 'title')) return null
    return `gh issue create ${flag('repo', repo)} ${flag('title', s(p, 'title'))} ${flag('body', s(p, 'body'))}`
  }
  if (kind === 'ado-workitem-create') {
    const [org, project, type, title] = [s(p, 'org'), s(p, 'project'), s(p, 'type'), s(p, 'title')]
    if (!org || !project || !type || !title) return null
    const scope = `${flag('org', AZ_ORG(org))} ${flag('project', project)}`
    const opt = (key: string, name: string) => (s(p, key) ? ` ${flag(name, s(p, key))}` : '')
    const first = `az boards work-item create ${scope} ${flag('type', type)} ${flag('title', title)}${opt('description', 'description')}${opt('area', 'area')}${opt('iteration', 'iteration')}${opt('assignedTo', 'assigned-to')}`
    const parent = n(p, 'parent')
    const later: string[] = []
    if (parent !== undefined) later.push(`# then, with the new id it prints: az boards work-item relation add --id <new id> --relation-type parent --target-id ${parent} ${scope}`)
    const links = Array.isArray(p.links) ? (p.links as { pr?: unknown }[]).map(l => l?.pr).filter((x): x is number => typeof x === 'number') : []
    if (links.length) later.push(`# the PR link${links.length > 1 ? 's' : ''} (${links.join(', ')}): add ${links.length > 1 ? 'them' : 'it'} on the work item's page, or ask the thread for a NEW ado-pr-workitem-link request after the item exists`)
    return [first, ...later].join('\n')
  }
  if (kind === 'ado-pr-comment') {
    const [org, project, repo] = [s(p, 'org'), s(p, 'project'), s(p, 'repo')]
    const pr = n(p, 'pr')
    if (!org || !project || !repo || pr === undefined || !s(p, 'body')) return null
    const code = (v: unknown, table: Record<string, number>, dflt: number): number => (typeof v === 'number' ? v : typeof v === 'string' && v in table ? table[v]! : dflt)
    const thread: Record<string, unknown> = { comments: [{ parentCommentId: n(p, 'parentCommentId') ?? 0, content: s(p, 'body'), commentType: code(p.commentType, COMMENT_TYPES, 1) }], status: code(p.status, STATUS_CODES, 1) }
    const line = n(p, 'line')
    if (s(p, 'file') && line !== undefined) {
      const side = p.side === 'left' ? 'left' : 'right'
      const end = n(p, 'endLine') ?? n(p, 'lineEnd') ?? line
      thread.threadContext = { filePath: `/${s(p, 'file')}`, [`${side}FileStart`]: { line, offset: n(p, 'offset') ?? 1 }, [`${side}FileEnd`]: { line: end, offset: n(p, 'offsetEnd') ?? n(p, 'offset') ?? 1 } }
    }
    const url = `${AZ_ORG(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${pr}/threads?api-version=7.1`
    return `az rest --method=post ${flag('url', url)} ${flag('resource', AZ_RESOURCE)} ${flag('body', JSON.stringify(thread))}${thread.threadContext ? '\n# (the line is anchored to the PR\'s latest iteration by Azure DevOps; check it on the page)' : ''}`
  }
  return null
}

// the block the desk shows: the command, the shell it is for, and why the thread cannot do it. null when there is no command.
export function fallbackText(kind: string, p: P, failures: number): string | null {
  if (Object.values(p).some(v => typeof v === 'string' && looksSecret(v))) return `${kind} failed ${failures} times. No command is shown: the request text contains something that looks like a secret, and a secret never goes into a command line. Remove it from the text first.`
  const cmd = fallbackCommand(kind, p)
  if (!cmd) return null
  return `${kind} failed ${failures} times. To do it yourself, run this in YOUR OWN shell (bash or zsh, already signed in with az login / gh auth login; the values are quoted, no secret is in it):\n${cmd}\n${WHY_NOT_THREAD}`
}
