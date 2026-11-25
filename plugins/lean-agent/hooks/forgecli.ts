// The READ allow-list for az / gh (1.0.34). Pure: no host, no I/O, no imports (shell.ts and forgewrite.ts both use it).
// az: under repos / boards / devops / pipelines / artifacts only a command whose LAST path word is a read verb runs; every other one (add, remove, create,
// update, delete, set-vote, reviewer add, abandon, complete, queue, run, invoke with a method, import ...) is a write. gh: under pr / issue / release / repo /
// workflow / run / secret / variable / label / gist / ruleset / project / org the verb (second word) must be a read verb; `gh api` is a write with a method
// but GET or a field / input. A new write verb is therefore refused until someone lists it as a read: nothing to forget in a deny-list.
// Two ways in: the WORDS of one command the shell scanner found at a program position (azWrite / ghWrite: quotes already resolved), and a TEXT scan
// (textForgeWrite: az / gh after a space, an operator or a quote) for prose, a brief, a memory item and the strings of python / node -c.
export const HOST = /dev\.azure\.com|\.visualstudio\.com|api\.github\.com|github\.com|\/_apis\/|\/pullRequests\/\S*\/threads/i // (a note that gives only the path `.../pullRequests/<pr>/threads/<id>` is the same write)
// a request method that is not GET / HEAD (a `$VAR` method counts: it cannot be read, so it is a write)
export const METHOD = /(?:^|[\s'"])(?:-X|--request|--method|--http-method)[\s=]*['"]?(?!(?:GET|HEAD)(?:$|[\s'"]))[^\s'"]/i
const GET_METHOD = /(?:^|[\s'"])(?:-X|--request|--method)[\s=]*['"]?GET\b/i
export const DATA = /(?:^|\s)(?:(?:-d|-F|-T)(?=[\s='"@{]|$)|--(?:data(?:-binary|-raw|-urlencode|-ascii)?|json|form(?:-string)?|upload-file|post-data|post-file|body-data|body-file)(?=[\s=]|$))/
const GH_FIELD = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?=[\s='"]|$)/
// `gh api graphql` that only READS: the one gh api in the text, a query text that starts with `query` or `{`, no mutation / subscription, no other method, no --input
const GQL_QUERY = /(?:^|\s)(?:-f|-F|--field|--raw-field)[\s=]*['"]?query=\s*['"]?\s*(?:query\b|\{)/
const AZ_GROUPS = new Set(['repos', 'boards', 'devops', 'pipelines', 'artifacts'])
const AZ_READ = /^(?:list|show|query|get|download|diff|search|(?:list|show|get)-[\w-]+)$/
const GH_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'workflow', 'run', 'secret', 'variable', 'label', 'gist', 'ruleset', 'project', 'org', 'cache', 'codespace', 'ssh-key', 'gpg-key', 'extension', 'attestation'])
const GH_READ = /^(?:(?:[a-z]+-)*(?:list|view|show|get)|diff|checks|status|watch|download|clone|checkout|ls)$/
// flags that take no value (so the word after them is still a path word); an unknown flag takes the next word that is no flag as its value
const NO_VALUE = new Set(['--debug', '--verbose', '--only-show-errors', '--help', '-h', '--no-wait', '--yes', '-y', '--web', '-w', '--draft', '--fill', '--squash', '--merge', '--rebase', '--admin', '--auto', '--delete-branch', '--approve', '--comment', '--request-changes', '--force', '--recursive'])
// the words of one command in a TEXT (up to the next `;`, `&`, `|`, newline, backtick or `)`), quotes and brackets of a python / js argv list stripped
const wordsOf = (rest: string): string[] => {
  const end = rest.search(/[;&|\n`)]/)
  // (a quoted value is one word: `--wiql "select [System.Id] from workitems"`; a quote the cut left open is plain text)
  return (((end < 0 ? rest : rest.slice(0, end)).match(/"[^"]*"|'[^']*'|\S+/g)) ?? []).map(x => x.replace(/^[\s'"`(\[{,]+|[\s'"`)\]},;]+$/g, '')).filter(Boolean)
}
// every `<prog> ...` in a text (after a space or an operator, quote, bracket; a path to the program counts: /usr/bin/az)
const callsOf = (t: string, prog: string): string[][] => [...t.matchAll(new RegExp(`(?:^|[\\s;&|(\`'"\\[])(?:[\\w.~-]*/)*${prog}(?=\\s)`, 'g'))].map(m => wordsOf(t.slice(m.index! + m[0].length)))
// the path words of a command (flags and their values skipped)
function pathOf(w: string[], from: number): string[] {
  const out: string[] = []
  for (let i = from; i < w.length; i++) {
    const x = w[i]!
    if (!x.startsWith('-')) { out.push(x); continue }
    if (x.includes('=') || NO_VALUE.has(x)) continue
    if (i + 1 < w.length && !w[i + 1]!.startsWith('-')) i++ // (the value of a flag)
  }
  return out
}
const hasHelp = (w: string[]): boolean => w.includes('--help') || w.includes('-h')
const flagValue = (w: string[], names: string[]): string | undefined => {
  let out: string | undefined
  w.forEach((x, i) => { for (const n of names) { if (x === n) out = w[i + 1] ?? ''; else if (x.startsWith(`${n}=`)) out = x.slice(n.length + 1) } })
  return out
}
const readMethod = (m: string | undefined): boolean => m === undefined || /^(get|head)$/i.test(m)

// The label of an az write (`az repos`, never an argument) or null. `w` = the words after `az`.
export function azWrite(w: string[]): string | null {
  const k = w.indexOf('rest')
  // `az [flags] rest`: only flags (and their values) before it. A GET without a body is the one read
  if (k >= 0 && w.slice(0, k).every((x, i) => x.startsWith('-') || (i > 0 && w[i - 1]!.startsWith('-')))) return !readMethod(flagValue(w, ['--method', '-m'])) || w.some(x => /^(--body|-b)(=|$)/.test(x)) ? 'az rest' : null
  const g = w.findIndex(x => AZ_GROUPS.has(x))
  if (g < 0) return null
  const label = `az ${w[g]}`
  // the command path is the words up to the first flag (`az repos pr work-item add --id 1`); when that is only the group's subgroup or verb (a flag sits in the
  // middle: `az repos pr --debug work-item add`), the flags and their values are skipped instead
  const after = w.slice(g + 1)
  const lead = after.findIndex(x => x.startsWith('-'))
  const first = lead < 0 ? after : after.slice(0, lead)
  const path = first.length === 1 && AZ_READ.test(first[0]!) ? first : first.length >= 2 ? first : pathOf(w, g + 1)
  if (hasHelp(w) || !path.length) return null
  if (w[g] === 'devops' && path[0] === 'invoke') return !readMethod(flagValue(w, ['--http-method'])) || w.some(x => /^--in-file(=|$)/.test(x)) ? label : null
  if (w[g] === 'devops' && path[0] === 'configure') return path.length === 1 && w.some(x => x === '--list' || x === '-l') ? null : label
  return AZ_READ.test(path[path.length - 1]!) ? null : label
}

const gqlRead = (t: string): boolean => callsOf(t, 'gh').filter(w => pathOf(w, 0)[0] === 'api').length === 1 && /\bapi\s+graphql\b/.test(t.replace(/(?:-R|--repo|--hostname)\s+\S+\s+/g, '')) && GQL_QUERY.test(t) && !/\b(mutation|subscription)\b/i.test(t) && !METHOD.test(t) && !/--input\b/.test(t)
// The label of a gh write (`gh pr`, `gh api`) or null. `w` = the words after `gh`; `t` = the text `gh api` is judged on (its flags are matched on text)
export function ghWrite(w: string[], t: string = `gh ${w.join(' ')}`): string | null {
  const lead = w.findIndex(x => x.startsWith('-'))
  const first = lead < 0 ? w : w.slice(0, lead)
  const path = first.length >= 2 ? first : pathOf(w, 0) // (a flag between the group and the verb: `gh pr --repo o/r merge 3`)
  const [group, verb] = path
  if (group === 'api') return !gqlRead(t) && (METHOD.test(t) || (GH_FIELD.test(t) && !GET_METHOD.test(t))) ? 'gh api' : null
  if (!group || !GH_GROUPS.has(group) || !verb || hasHelp(w)) return null // (`gh pr` alone is the help text)
  return GH_READ.test(verb) ? null : `gh ${group}`
}

// the az / gh part of the text scan: the label of the first write found anywhere in a text (also inside quotes, a heredoc, a python argv list), or null
export function textForgeWrite(command: string): string | null {
  const t = command.replace(/\\\r?\n/g, ' ').replace(/['"]\s*,\s*['"]/g, ' ') // (a python / js argv list ['az','repos','pr'] reads as the words)
  for (const w of callsOf(t, 'az')) { const r = azWrite(w); if (r) return r }
  for (const w of callsOf(t, 'gh')) { const r = ghWrite(w, t); if (r) return r }
  return null
}
