// Feedback export, done by the mod (no model, no network, nothing is ever posted): ONE markdown file,
// ~/.lean-agent/feedback-export/<YYYY-MM-DD-HHMM>.md, with the environment, the doctor's problem lines, the drafts not exported
// before, the LEAN-FEEDBACK texts and guard refusals since the last export (grouped, de-duplicated, with counts), the script
// candidates for lean-agent core and the blocked thread reports. Everything is anonymised by code first (home dir, user and project
// names, emails, URLs, shas, ticket numbers, secrets) and the file is NOT written when a known private string survived.
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { check } from './doctor'
import { allScripts } from './scripts'
import { copyToFolder, feedbackConfig, offerPost, wantsFolder, wantsGithub } from './feedbackdest'

export const EXPORT_CAP = 40 * 1024
const exportDir = (home: string) => `${leanDir(home)}/feedback-export`
const privateDir = (home: string) => `${leanDir(home)}/.private` // real project names live here, never next to the files a user sends
export const REPO_URL = /^https:\/\/github\.com\/mcmadsen\/lean-agent(?:[/?#].*)?$/
// user names too common to be identifying (replacing them would only mangle prose)
const GENERIC_USERS = new Set(['root', 'user', 'users', 'admin', 'home', 'ubuntu', 'runner', 'claude', 'test', 'tests', 'build', 'builder', 'code', 'data', 'guest', 'work', 'node', 'docker', 'deploy', 'jenkins', 'github', 'vagrant', 'ec2-user', 'app', 'www', 'system', 'master', 'server', 'python', 'public', 'default', 'shared', 'service', 'support', 'office', 'student', 'default', 'developer', 'shared'])
// folder names too common to mask as "a project" (a project's folder basename is masked as the project; these would mangle prose)
const COMMON_FOLDERS = new Set(['repo', 'repos', 'src', 'app', 'apps', 'code', 'main', 'work', 'tmp', 'git', 'project', 'projects', 'lean-agent', 'source', 'sources', 'dev', 'web', 'api', 'lib', 'docs'])
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- anonymisation ------------------------------------------------------------------------------------------------------------
// credential and key shapes (the bare long-token rule runs last, after hashes)
const SECRET_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // DB_PASSWORD=..., MY_API_KEY: ..., "token": "..." (an underscore before the word does not hide it)
  /(?<![A-Za-z0-9])((?:password|passwd|secret|token|api[_-]?key)\w*["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi,
]
// a credential assignment still carrying its value (alphanumerics): checked on the OUTPUT, independent of the rules above
const CRED_LEFT = /(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[_-]?key)\w*["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{8,}/i
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g
const URL_RE = /(?:https?|ssh|git|ftp):\/\/[^\s)>\]"'`]+/g
const SCP_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:]+/g // git@host:org/repo.git
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IP_RE = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.])`, 'g') // a real address, not a 10.0.19045.3693 build number
// a host name: a known TLD, not followed by more name (settings.local.json is a file, not a host)
const HOST_RE = /(?<![A-Za-z0-9@/.-])(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|local|internal|corp|lan)\b(?![\w-]|\.\w)/g
const HOST_OK = /^(?:github\.com|dev\.azure\.com)$/i
// github.com/<org>/<repo>: only the lean-agent repo is kept
const GH_PATH = /(?<![A-Za-z0-9])github\.com\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/g
const ghKept = (org: string, repo?: string) => org.toLowerCase() === 'mcmadsen' && (repo ?? '').toLowerCase() === 'lean-agent'
// the public repo path (with or without github.com/): it passes the user-name and project rules untouched, because the OS user name
// may be the same as the public repo owner's. Only the exact path: another repo of the owner, or a longer name, is not let through.
const PUBLIC_REPO = 'mcmadsen/lean-agent'
const PUBLIC_REPO_RE = /(?<![A-Za-z0-9._-])mcmadsen\/lean-agent(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9])/gi
const KEEP = '\u0003' // stands for PUBLIC_REPO while the name rules run (control character: no name can match it)
const HEX_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g
// an id after the word that names what it identifies: PR 12, pull request #12, pullrequest 12, work item 12, work-item 12, thread 12,
// issue / ticket / story 12, `--id 12`, `--id=12` (a work item, PR or comment thread id from a command's arguments or a result)
// (plurals and lists too: `PRs 12, 13`, `issues 8 and 9`; `--work-item-id 12`, `--thread-id 9`)
const ID_WORD_RE = /(?<![A-Za-z0-9])(PRs?|pull[ -]?requests?|work[ -]?items?|threads?|issues?|tickets?|stor(?:y|ies)|--[a-z-]*id)(\s*[#!=:]\s*|\s*)\d+(?:\s*(?:,|and|&)\s*\d+)*\b/gi
// `"id": 123`, `"ID": 5`, `pullRequestId=123`, `thread_id: 123`, `pull_request_id: 5`, `number: 123`: a result's id field
const ID_FIELD_RE = /(?<![A-Za-z0-9_])((?:(?:[A-Za-z0-9]+_)*(?:[iI][dD]|number)|[A-Za-z]+I[dD])["']?\s*[:=]\s*["']?)\d+\b/g
// a bare number of 4+ digits inside a quoted or backticked command (a PR, work item or comment id nobody put a word before); a count
// followed by its unit (4500 chars, 12000 tokens, 3000 ms, 1500 lines ...) is not an id
const QUOTED_RE = /`[^`\n]*`|"[^"\n]*"|'[^'\n]*'/g
const BARE_ID_RE = /(?<![\w.])\d{4,}\b(?!\s*(?:%|(?:chars?|tokens?|k|ms|s|lines?|rows?|files?|tests?)\b))/g
const ID_KEY_RE = /\b(?!(?:UTF|SHA|ISO|MD|AES|RSA|TLS|SSL|HTTP|ECMA|RFC|GPT|TCP|UDP|IPV)-)[A-Z][A-Z0-9]{1,9}-\d+\b/g // a tracker key like ABC-123, not UTF-8
const LABEL_RE = /(project-(?:[A-Z]|\d+)\b)/
const AZURE_PATH = /dev\.azure\.com\/[^/\s]+(?:\/[^/\s]+)?/g
const AZURE_HOST = /\b([A-Za-z0-9-]+)\.visualstudio\.com/g
const USER_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+(\/|(?![A-Za-z0-9._-]))/g

// ---- branch names, first names, the OS build -----------------------------------------------------------------------------------
// A branch name is work-specific text (it often carries a ticket's words). The first path segment is kept when it is a branch TYPE
// (bugfix/, feature/ ...: it says what kind of work, not which), the rest is masked; any other first segment may be a person's name.
const BRANCH_TYPES = new Set(['bugfix', 'bug', 'feature', 'feat', 'fix', 'hotfix', 'chore', 'infra', 'release', 'refactor', 'docs', 'test', 'ci', 'build', 'perf', 'task', 'story', 'wip', 'dev'])
const GENERIC_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'head'])
// `feature/alpha-beta` -> `feature/<branch>`, `alpha-beta` and `alice/x` -> `<branch>`
const maskBranch = (b: string): string => {
  const i = b.indexOf('/')
  return i > 0 && BRANCH_TYPES.has(b.slice(0, i).toLowerCase()) ? `${b.slice(0, i)}/<branch>` : '<branch>'
}
// the same for a worktree folder, where slashes became dashes (`feature-alpha-beta`) or stayed (`feature/alpha`)
const maskBranchDir = (d: string): string => {
  if (d.includes('<')) return d // already masked
  if (d.includes('/')) return maskBranch(d)
  const m = /^([A-Za-z]+)-/.exec(d)
  return m && BRANCH_TYPES.has(m[1]!.toLowerCase()) ? `${m[1]}-<branch>` : '<branch>'
}
// a name that looks like a branch (a plain word does not: it may just be a word) and is no default branch
const branchLike = (b: string) => b.length >= 4 && !GENERIC_BRANCHES.has(b.toLowerCase()) && (/[/_.-]/.test(b) || /\d/.test(b)) && !b.includes('<')
// the word `branch`, then a branch-like name: "Branch infra/alpha-beta", "branch `x/y`", "branch: x-1"
// (also "branch (x/y)", and a comma list: "branches: a-b, c-d")
const BRANCH_NAME = '[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]'
const AFTER_BRANCH_RE = new RegExp(`\\b(branch(?:es)?\\b\\s*[:=]?\\s*[\`'"(]?)(${BRANCH_NAME}(?:\\s*,\\s*(?!branch(?:es)?\\b)${BRANCH_NAME})*)`, 'gi')
// every branch-like name of a matched list, masked
const maskList = (list: string) => list.replace(new RegExp(BRANCH_NAME, 'g'), n => (branchLike(n) ? maskBranch(n) : n))
// <label>/<type>/<rest>: a registry key (project/branch) after the project rule ran
const LABEL_BRANCH_RE = new RegExp(`(project-(?:[A-Z]|\\d+)/(?:${[...BRANCH_TYPES].join('|')})/)[A-Za-z0-9][A-Za-z0-9._/~-]*[A-Za-z0-9]`, 'g')
// .../worktrees/<project>/<branch folder>
// (one folder, or a branch type and the folder after it: `feature/alpha`; whatever follows, a file inside the worktree, stays)
const WORKTREE_PATH_RE = new RegExp(`(\\/worktrees\\/[^/\\s\`'"<>]+\\/)((?:(?:${[...BRANCH_TYPES].join('|')})\\/)?[^/\\s\`'"),;:]+)`, 'g')
// a first name after the words that introduce a person; a product or common word is no name
const NAME_AFTER_RE = /(?<![A-Za-z0-9])((?:[Rr]eply to|[Rr]eplied to|[Aa]sked by|[Ff]rom|[Tt]o))(\s+)([A-Z][a-z]{2,14})(?![A-Za-z0-9_-])/g
const NOT_A_NAME = new Set(
  ('claude opus sonnet haiku fable anthropic github gitlab bitbucket azure devops desk mac macos darwin linux windows homebrew node bun git docker desktop code doctor thread threads pane stats budget review learn compare worktree plugin plugins skill skills settings config json markdown python typescript javascript yarn npm pnpm jira slack google microsoft apple openai notion ' +
    'the this that these those it its an your you each every all any none one some main master origin upstream remote now here there then when where what which once after before both either neither my our their his her them today tomorrow yesterday true false null step phase version section line file folder page chapter item list table row column ' +
    'read write edit bash grep glob agent task notebookedit webfetch websearch todowrite askuserquestion ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december').split(' '),
)
const nameAfter = (t: string) => t.replace(NAME_AFTER_RE, (m, trig: string, sp: string, name: string) => (NOT_A_NAME.has(name.toLowerCase()) ? m : `${trig}${sp}<name>`))
// the OS build ("Darwin 25.6.0", "Linux 6.18.44-x", "Windows_NT 10.0.19045") says which machine; the family stays
const OS_BUILD_RE = /\b(Darwin|Linux|Windows_NT|Windows|macOS)\s+\d[\w.+~-]*/g

// anonymise: the whole rule set; name: only the home / user / project / path rules, for a file name (a date-slug draft name is long
// and looks like a secret, but it is not one: the secret and hash rules never see it); missed: the final check
export type Anonymiser = { anonymise: (t: string) => string; name: (t: string) => string; missed: (t: string) => string[] }

const label = (n: number) => (n < 26 ? `project-${String.fromCharCode(65 + n)}` : `project-${n + 1}`)

// project names -> project-A, project-B ... through a stable map kept locally (~/.lean-agent/.private/projects.map.json: it holds the
// real names, so it is not in the export folder). A name under 3 characters, or "global", is too short or too common to mask.
// A registered project's folder and the folder's name are masked as the same project. Returns [text, label] pairs, longest first.
async function projectNames(h: Host, home: string): Promise<[string, string][]> {
  const names: string[] = []
  const extra: [string, string][] = [] // alias -> project name
  const ok = (n: unknown): n is string => typeof n === 'string' && n.trim().length >= 3 && n.trim() !== 'global' && n.trim().toLowerCase() !== 'lean-agent'
  const add = (n: unknown) => {
    if (ok(n) && !names.includes(n.trim())) names.push(n.trim())
  }
  const projs = (await readJson<Record<string, { path?: unknown } | null>>(h, `${leanDir(home)}/projects.json`, {})) ?? {}
  for (const [k, v] of Object.entries(projs)) {
    add(k)
    const p = typeof v?.path === 'string' ? v.path.replace(/\/+$/, '') : ''
    // the folder (whole path, and its last name unless that is a common word) is masked as the same project
    if (ok(k) && p) for (const a of [p, p.split('/').pop() ?? '']) if (ok(a) && a !== k && !COMMON_FOLDERS.has(a.toLowerCase())) extra.push([a.trim(), k.trim()])
  }
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [])) add((await readJson<{ project?: string }>(h, `${threadsDir(home)}/${e.name}/thread.json`, {})).project)
  const file = `${privateDir(home)}/projects.map.json`
  const map = await readJson<Record<string, string>>(h, file, {})
  let changed = false
  for (const n of names) {
    if (!map[n]) {
      map[n] = label(Object.keys(map).length)
      changed = true
    }
  }
  if (changed) await writeJson(h, file, map)
  const pairs: [string, string][] = [...Object.entries(map), ...extra.filter(([, p]) => map[p]).map(([a, p]): [string, string] => [a, map[p]!])]
  return pairs.filter(([n]) => n.length >= 3).sort((a, b) => b[0].length - a[0].length)
}

// The branch names the machine knows: the worktree registry (keys `<project>/<branch>`, a key's `~2` suffix cut, and each entry's
// `branch`) and the thread records. [verbatim, masked] pairs, longest first; the folder form (slashes as dashes) is masked too.
async function branchNames(h: Host, home: string): Promise<[string, string][]> {
  const seen = new Map<string, string>()
  const add = (b: unknown) => {
    const x = typeof b === 'string' ? b.trim().replace(/~\d+$/, '') : ''
    if (!branchLike(x)) return
    seen.set(x, maskBranch(x))
    const dir = x.replace(/\//g, '-')
    if (dir !== x) seen.set(dir, maskBranchDir(dir))
  }
  const reg = await readJson<Record<string, { branch?: unknown } | null>>(h, `${leanDir(home)}/worktrees.json`, {})
  for (const [k, v] of Object.entries(reg && typeof reg === 'object' && !Array.isArray(reg) ? reg : {})) {
    add(v?.branch)
    const i = k.indexOf('/')
    if (i > 0) add(k.slice(i + 1))
  }
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [])) add((await readJson<{ branch?: unknown }>(h, `${threadsDir(home)}/${e.name}/thread.json`, {}))?.branch)
  return [...seen].sort((a, b) => b[0].length - a[0].length)
}

export async function makeAnonymiser(h: Host): Promise<Anonymiser> {
  const home = await homeDir(h)
  const projects = await projectNames(h, home)
  const branches = await branchNames(h, home)
  // a branch name as a word (a `/` before it is fine: registry keys and worktree paths), never inside a longer name
  const branchRe = (b: string) => new RegExp(`(?<![A-Za-z0-9._-])${esc(b)}(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`, 'g')
  const user = home.split('/').pop() ?? ''
  const userOk = user.length >= 4 && !GENERIC_USERS.has(user.toLowerCase())
  const homeRe = home.length > 1 ? new RegExp(`${esc(home)}(?![A-Za-z0-9._-])`, 'g') : null
  const nameRe = (n: string) => new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'gi') // a name as a word (my-proj-api and proj/x match, projection does not)
  const hidden = (t: string) => t.replace(/project-(?:[A-Z]|\d+)\b/g, '') // our own labels are not leaks

  // the home, user-name and project rules (shared by a whole text and a file name); the public repo path goes through untouched
  const names = (input: string): string => {
    let t = input.replace(/[\u0001\u0002\u0003]/g, '') // our placeholder characters can never come from the text
    if (homeRe) t = t.replace(homeRe, '~')
    t = t.replace(USER_PATH, '~$1')
    t = t.replace(PUBLIC_REPO_RE, KEEP)
    // the user name: a word when short; a long one (6+ letters) also inside longer words (a host name like <name>box)
    if (userOk) t = t.replace(new RegExp(user.length < 6 ? `(?<![A-Za-z0-9])${esc(user)}(?![A-Za-z0-9])` : esc(user), 'gi'), '<user>')
    // projects: names become a private token first, then their labels, so a label is never re-matched by a name (labels already in
    // the text are left alone: running this twice changes nothing). The token is control characters only: no name can match it.
    t = t
      .split(LABEL_RE)
      .map((part, k) => {
        if (k % 2) return part
        let p = part
        projects.forEach(([n], i) => {
          p = p.replace(nameRe(n), `${'\u0001'.repeat(i + 1)}\u0002`)
        })
        return p.replace(/(\u0001+)\u0002/g, (_, c: string) => projects[c.length - 1]![1])
      })
      .join('')
    return t
  }
  const restore = (t: string) => t.split(KEEP).join(PUBLIC_REPO)

  const anonymise = (input: string): string => {
    let t = input.replace(/[\u0001\u0002\u0003]/g, '')
    for (const re of SECRET_RES) t = t.replace(re, (m, g1) => (typeof g1 === 'string' ? `${g1}<secret>` : '<secret>'))
    t = t.replace(OS_BUILD_RE, '$1')
    t = maskMcp(t)
    t = t.replace(URL_RE, u => {
      const core = u.replace(/[.,;:!?]+$/, '') // sentence punctuation after a URL is not part of it
      return (REPO_URL.test(core) ? core : '<url>') + u.slice(core.length)
    })
    // what is left of azure hosts (written without a scheme): the organisation and project segments go
    t = t.replace(AZURE_PATH, 'dev.azure.com/<org>/<org>').replace(AZURE_HOST, '<org>.visualstudio.com')
    t = t.replace(SCP_RE, '<url>').replace(EMAIL_RE, '<email>')
    t = t.replace(IP_RE, '<ip>').replace(HOST_RE, m => (HOST_OK.test(m) ? m : '<host>'))
    t = t.replace(GH_PATH, (m, org: string, repo?: string) => (ghKept(org, repo) ? m : 'github.com/<org>/<repo>'))
    // branch names: the ones the machine knows first (before the project rule can change a name that holds a project's), then a worktree
    // folder, then whatever follows the word "branch"
    for (const [b, m] of branches) t = t.replace(branchRe(b), m)
    t = t.replace(WORKTREE_PATH_RE, (_m, p: string, rest: string) => p + maskBranchDir(rest))
    t = t.replace(AFTER_BRANCH_RE, (_m, lead: string, list: string) => lead + maskList(list))
    t = names(t)
    t = t.replace(LABEL_BRANCH_RE, '$1<branch>')
    t = nameAfter(t)
    t = t.replace(ID_WORD_RE, '$1$2<id>').replace(ID_FIELD_RE, '$1<id>').replace(/#\d+\b/g, '#<id>').replace(ID_KEY_RE, '<id>')
    t = t.replace(QUOTED_RE, q => q.replace(BARE_ID_RE, '<id>'))
    t = t.replace(HEX_RE, '<sha>')
    t = t.replace(LONG_TOKEN, '<secret>')
    return restore(t)
  }
  const name = (input: string): string => restore(names(input))

  // the final check: names the rules that missed. Stricter than the rules on purpose (a user name inside a longer word, say).
  const missed = (text: string): string[] => {
    const t = hidden(text)
    const tn = t.replace(PUBLIC_REPO_RE, '') // the exact public repo path is no leak of a user or project name that equals its owner
    const out: string[] = []
    if (homeRe && new RegExp(homeRe.source).test(t)) out.push('home directory')
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(t)) out.push('/Users or /home path')
    // the user name: a substring for a long one (it may sit inside a host name), a word for a short one (so "tests" is not a leak)
    if (userOk && new RegExp(user.length < 6 ? `(?<![A-Za-z0-9])${esc(user)}(?![A-Za-z0-9])` : esc(user), 'i').test(tn)) out.push('user name')
    if (projects.some(([n]) => nameRe(n).test(tn))) out.push('project name')
    if (new RegExp(EMAIL_RE.source).test(t) || new RegExp(SCP_RE.source).test(t)) out.push('email address')
    if (new RegExp(IP_RE.source).test(t)) out.push('IP address')
    if ((t.match(HOST_RE) ?? []).some(m => !HOST_OK.test(m))) out.push('host name')
    if (Array.from(t.matchAll(GH_PATH)).some(m => !ghKept(m[1]!, m[2]))) out.push('code-host path')
    if (CRED_LEFT.test(t) || SECRET_RES.some(re => { const hit = new RegExp(re.source, re.flags.replace('g', '')).exec(t); return !!hit && !/<secret>$/.test(hit[0]) })) out.push('token or key')
    if (/dev\.azure\.com\/(?!<org>)[^/\s]/.test(t) || /\b(?!<org>)[A-Za-z0-9-]+\.visualstudio\.com/.test(t)) out.push('azure organisation')
    if ((t.match(URL_RE) ?? []).some(u => !REPO_URL.test(u.replace(/[.,;:!?]+$/, '')))) out.push('URL')
    if (new RegExp(ID_WORD_RE.source, 'i').test(t)) out.push('work item, PR or thread id')
    // a branch name that survived: one the machine knows, one after the word "branch", or an unmasked worktree folder
    if (branches.some(([b]) => branchRe(b).test(tn)) || Array.from(t.matchAll(AFTER_BRANCH_RE)).some(m => (m[2]!.match(new RegExp(BRANCH_NAME, 'g')) ?? []).some(branchLike)) || Array.from(t.matchAll(WORKTREE_PATH_RE)).some(m => !m[2]!.includes('<'))) out.push('branch name')
    if (Array.from(t.matchAll(NAME_AFTER_RE)).some(m => /^(?:reply|replied|asked)/i.test(m[1]!) && !NOT_A_NAME.has(m[3]!.toLowerCase()))) out.push('person name')
    if (/\b(?:Darwin|Linux|Windows_NT)\s+\d+\.\d+/.test(t)) out.push('OS build')
    return [...new Set(out)]
  }
  return { anonymise, name, missed }
}

// ---- sources ------------------------------------------------------------------------------------------------------------------
type Group = { text: string; n: number; first: number }
const key = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()
function group(items: { text: string; ts: number }[]): Group[] {
  const m = new Map<string, Group>()
  for (const { text, ts } of items) {
    const t = text.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const g = m.get(key(t))
    if (g) {
      g.n++
      g.first = Math.min(g.first, ts)
    } else m.set(key(t), { text: t.slice(0, 300), n: 1, first: ts })
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.first - a.first) // most repeated first; among equals the newest
}
const FB_FIELDS = ['missing', 'refused', 'unverified', 'unreached'] as const
// A row's time in ms: a number (seconds from 0.45 are scaled), a numeric string or an ISO date; 0 when it has none. A row without a
// readable time is still counted by the FIRST export (nothing read it before) and by no later one.
const tsOf = (r: Record<string, unknown> | null | undefined): number => {
  const v = r?.ts
  const ms = (n: number) => (Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0)
  if (typeof v === 'number') return ms(v)
  if (typeof v === 'string' && v.trim()) return Number.isFinite(Number(v)) ? ms(Number(v)) : ms(Date.parse(v))
  return 0
}
const isNew = (r: Record<string, unknown> | null | undefined, st: { at: number }) => st.at === 0 || tsOf(r) > st.at
// the worker feedback rows: 1.0.x writes ~/.lean-agent/feedback.jsonl, 0.45 wrote ~/.lean-agent/feedback/feedback.jsonl; both are read
// (a row present in both is counted once)
const feedbackFiles = (lean: string) => [`${lean}/feedback.jsonl`, `${lean}/feedback/feedback.jsonl`]
// a draft's title: its first Markdown heading, else its first line; `at` is the line it came from (the body is the draft without that
// line, so the title is not said twice and no other line is lost); no line = no text. The title is cut AFTER anonymising, never before.
const draftTitle = (raw: string): { text: string; at: number } => {
  const lines = raw.split('\n').map(l => l.trim())
  let at = lines.findIndex(l => /^#{1,6}\s+\S/.test(l))
  if (at < 0) at = lines.findIndex(l => l.length)
  return at < 0 ? { text: '', at } : { text: lines[at]!.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim(), at }
}
// one row as a comparable key: sorted keys, the time normalised (a row copied between the two files may differ in both)
const rowKey = (r: Record<string, unknown>) => JSON.stringify(Object.keys(r).sort().map(k => [k, k === 'ts' ? tsOf(r) : r[k]]))
// what a draft shows when it has no text to take a title from: its file name as words (no extension, no leading date)
const nameWords = (file: string) => file.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '').replace(/[-_]+/g, ' ').trim()

type State = { at: number; drafts: string[]; core: string[] }
const emptyState = (): State => ({ at: 0, drafts: [], core: [] })

// a refusal the guard just made (register.tsx): the one writer is feedback.ts logRefusal / logMissingTool (the one file ~/.lean-agent/refusals.jsonl)
export { logRefusal, logMissingTool } from './feedback'

type Collected = {
  notes: string
  env: string[]
  problems: string[]
  drafts: { raw: string; title: string; text: string }[]
  sources: string[] // "feedback.jsonl: 120 rows" ...: what was read, so an empty section can be told from a file that was not found
  statuses: [string, number][]
  missingReports: number // reports that name missing context (the texts come from the gap logs and from older rows that carry them)
  fields: Record<(typeof FB_FIELDS)[number], Group[]>
  refusals: { text: string; agent: string; n: number; rule?: string; version?: string }[]
  missingTools: { text: string; n: number }[] // rows of kind missing-tool: role, tool or server, job type (counts)
  core: { name: string; line: string }[]
  blocked: string[]
}

async function collect(h: Host, root: string, o: { notes?: string; version: string }, st: State, an: Anonymiser): Promise<Collected> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const A = an.anonymise
  const run = async (argv: string[]) => {
    const r = await h.process.run(argv).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : ''
  }
  const installed = (await readJson<{ version?: string }>(h, `${root}/.claude-plugin/plugin.json`, {})).version ?? 'unknown'
  const uname = await run(['uname', '-s'])
  const env = [
    `- lean-agent running: ${o.version}; installed: ${installed}${installed !== 'unknown' && installed !== o.version ? ' (SKEW: the running mod is not the installed version, restart the session)' : ''}`,
    `- Claude Code: ${(await run(['claude', '--version'])) || 'not found'}`,
    `- OS family: ${uname === 'Darwin' ? 'macOS (Darwin)' : uname === 'Linux' ? 'Linux' : uname || 'unknown'}`,
  ]
  const problems = ((await check(h, root).catch(() => ['FIX  the doctor check failed to run'])) as string[]).filter(l => l.startsWith('FIX')).map(l => A(l.replace(/^FIX\s+/, '')))
  const drafts: Collected['drafts'] = []
  for (const f of (await h.fs.list(`${lean}/feedback-drafts`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name)))
    if (!st.drafts.includes(f.name)) {
      const raw = String(await h.fs.read(`${lean}/feedback-drafts/${f.name}`).catch(() => ''))
      const t = draftTitle(raw)
      const body = t.at >= 0 ? raw.split('\n').filter((_, i) => i !== t.at).join('\n') : raw // exactly the title's line is dropped
      // the title is the draft's own first heading (anonymised as text, then cut); a draft without text falls back to its file name as
      // words, which only the name rules see: a long date-slug name is not a secret
      drafts.push({ raw: f.name, title: t.text ? A(t.text).slice(0, 120).replace(/<[a-z]*$/, '') : an.name(nameWords(f.name)) || 'untitled draft', text: A(body) })
    }
  // worker feedback rows from both places (and the file that was not there is said, not skipped)
  // (a row that sits in an earlier file too is counted once; identical rows inside ONE file are separate reports)
  const earlier = new Map<string, number>()
  const fb: Record<string, unknown>[] = []
  const sources: string[] = []
  for (const file of feedbackFiles(lean)) {
    const rows = (await readJsonl<Record<string, unknown>>(h, file)).filter(r => r && typeof r === 'object' && !Array.isArray(r))
    sources.push(`${file.slice(lean.length + 1)}: ${(await h.fs.exists(file).catch(() => false)) ? `${rows.length} row(s)` : 'not found'}`)
    const here = new Map<string, number>()
    for (const r of rows) {
      const k = rowKey(r)
      here.set(k, (here.get(k) ?? 0) + 1)
      if ((earlier.get(k) ?? 0) >= here.get(k)!) continue // the same row, already read from an earlier file
      if (r.kind !== 'core-candidate' && isNew(r, st)) fb.push(r)
    }
    for (const [k, n] of here) earlier.set(k, Math.max(earlier.get(k) ?? 0, n))
  }
  const counts = new Map<string, number>()
  for (const r of fb) counts.set(String(r.status ?? 'unknown'), (counts.get(String(r.status ?? 'unknown')) ?? 0) + 1)
  const texts: Record<string, { text: string; ts: number }[]> = { missing: [], refused: [], unverified: [], unreached: [] }
  // The feedback rows of feedback.ts hold counts (`refused`, `unverified`, `unreached` numbers; `missing` a flag) and the texts in
  // `unverifiedClaims` / `unreachedFolders`; the refused commands are in refusals.jsonl (worker rows, below). A string value is the
  // older shape and is taken as the text itself.
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  let missingReports = 0
  for (const r of fb) {
    if (r.missing === true || (typeof r.missing === 'string' && r.missing.trim())) missingReports++
    for (const f of FB_FIELDS) if (typeof r[f] === 'string') texts[f]!.push({ text: A(String(r[f])), ts: tsOf(r) })
    for (const t of arr(r.unverifiedClaims)) texts.unverified!.push({ text: A(t), ts: tsOf(r) })
    for (const t of arr(r.unreachedFolders)) texts.unreached!.push({ text: A(t), ts: tsOf(r) })
  }
  const refRows = await readJsonl<{ ts?: number; text?: string; agent?: string; command?: string; src?: string; kind?: string; role?: string; rule?: string; version?: string; tool?: string; job?: string; what?: string; calls?: number; budget?: number; chars?: number; run?: string }>(h, `${lean}/refusals.jsonl`)
  const steps = new Map<string, { runs: Set<string>; rows: number; chars: number[]; calls: number[]; budget: number }>() // worker-step-budget rows by job: one run keeps calling and writes a row per refused call
  // a refusal a worker reported: its command and the refusal text, as the worker quoted them
  for (const r of refRows) if (r?.src === 'worker' && typeof r.command === 'string' && isNew(r, st)) texts.refused!.push({ text: A(`${r.command}${r.text ? ` -> ${r.text}` : ''}`), ts: tsOf(r) })
  // `missing` also comes from the gap logs (one line per gap a worker reported)
  const gapFiles = [`${lean}/gaps.jsonl`]
  for (const d of await h.fs.list(lean).catch(() => [])) if (d.kind === 'dir') gapFiles.push(`${lean}/${d.name}/gaps.jsonl`)
  for (const f of gapFiles) for (const g of await readJsonl<{ ts?: number; text?: string }>(h, f)) if (typeof g?.text === 'string' && isNew(g, st)) texts.missing!.push({ text: A(g.text), ts: tsOf(g) })
  const fields = Object.fromEntries(FB_FIELDS.map(f => [f, group(texts[f]!)])) as Collected['fields']
  const ref = new Map<string, { text: string; agent: string; n: number; rule?: string; version?: string }>()
  const miss = new Map<string, { text: string; n: number }>()
  for (const r of refRows) {
    if (r?.kind === 'missing-tool' && isNew(r, st)) {
      const t = A(`[${r.role ?? 'session'}] ${r.tool ?? '?'}${r.job ? ` (job ${r.job})` : ''}`).replace(/\s+/g, ' ').trim()
      const m = miss.get(t)
      if (m) m.n++
      else miss.set(t, { text: t, n: 1 })
      continue
    }
    if (typeof r?.text !== 'string' || !isNew(r, st) || r.src === 'worker' || r.command !== undefined || r.rule === 'answer-too-long') continue // the guard's own rows only (answer-too-long rows of 1.0.31 are not refusals: a counter now, answers.ts)
    const agent = (r.agent ?? r.role ?? 'session').replace(/^lean-agent:/, '')
    if (r.rule === 'worker-step-budget' && typeof r.job === 'string' && typeof r.calls === 'number') {
      const s = steps.get(r.job) ?? steps.set(r.job, { runs: new Set(), rows: 0, chars: [], calls: [], budget: 0 }).get(r.job)!
      s.rows++
      s.runs.add(r.run ?? `${agent}${s.rows}`)
      if (typeof r.chars === 'number') s.chars.push(r.chars)
      s.calls.push(r.calls)
      s.budget = Math.max(s.budget, Number(r.budget) || 0)
    }
    const what = typeof r.what === 'string' && r.what ? A(r.what).replace(/\s+/g, ' ').trim() : '' // what was tried (a program and subcommand, or a tool and a path's kind): the export groups by it
    const t0 = A(r.text).replace(/\s+/g, ' ').trim()
    const t = what && !t0.includes(`[tried: ${what}]`) ? `${t0} [tried: ${what}]` : t0
    const k = `${agent}\u0000${r.rule ?? ''}\u0000${what}\u0000${key(t0)}`
    const cur = ref.get(k)
    if (cur) cur.n++
    else ref.set(k, { text: t, agent, n: 1, ...(r.rule ? { rule: r.rule } : {}), ...(r.version ? { version: r.version } : {}) })
  }
  // one line per job type: how many RUNS used their step budget (n), against how many refused calls, with the calls and brief sizes: a budget too small for the job shows as calls just past the budget with small briefs, a brief too big as large briefs
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : 0)
  for (const [job, s] of steps) {
    const text = `step budget used by ${s.runs.size} ${job} run(s) (${s.rows} refused calls; budget ${s.budget} tool calls; median ${med(s.calls)} calls made${s.chars.length ? `; brief characters: median ${med(s.chars)}, largest ${Math.max(...s.chars)}` : '; brief size unknown'})`
    ref.set(`steps\u0000${job}`, { text, agent: 'worker', n: s.runs.size, rule: 'worker-step-budget-runs' })
  }
  const core = (await allScripts(h).catch(() => [])).filter(x => x.meta.core && !st.core.includes(x.meta.name)).map(x => ({ name: x.meta.name, line: A(`${x.meta.name}: ${x.meta.purpose} (run: ${x.meta.run}; inputs: ${x.meta.inputs.join('; ')}; ${x.meta.status})`) }))
  const blocked = (await readJsonl<{ ts?: number; from?: string; kind?: string; state?: string; text?: string }>(h, `${lean}/desk/inbox.jsonl`))
    .filter(r => r?.kind === 'report' && r.state === 'blocked' && isNew(r, st))
    .map(r => `${r.from ?? '?'}: ${A(String(r.text ?? '').split('\n')[0]!.trim().slice(0, 200))}`)
  return { notes: A(o.notes ?? '').trim(), env, problems, drafts, sources, statuses: [...counts], missingReports, fields, refusals: [...ref.values()].sort((a, b) => b.n - a.n), missingTools: [...miss.values()].sort((a, b) => b.n - a.n), core, blocked }
}

// ---- rendering with the size cap ------------------------------------------------------------------------------------------------
type Limits = { draft: number; top: number }
function render(c: Collected, at: number, lim: Limits): string {
  const out: string[] = ['# lean-agent feedback export', '', `Anonymised by the mod (no model, nothing posted). Covers ${at ? `everything since the last export (${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : 'everything so far (no earlier export)'}.`, '']
  const more = (n: number, what: string) => (n > 0 ? [`_... ${n} more ${what} summarised (oldest / least repeated)._`] : [])
  const top = <T,>(xs: T[]): [T[], number] => [xs.slice(0, lim.top), Math.max(0, xs.length - lim.top)]
  // every section is always printed, "none" when it is empty: a section that is missing from the file can never hide a bug
  const none = ['none', '']
  out.push('## Notes', '', ...(c.notes ? [c.notes, ''] : none))
  out.push('## Environment', '', ...c.env, '')
  out.push('## Doctor check: problems', '', ...(c.problems.length ? [...c.problems.map(p => `- ${p}`), ''] : none))
  out.push('## Drafts not exported before', '')
  if (!c.drafts.length) out.push(...none)
  for (const d of c.drafts) out.push(`### ${d.title}`, '', d.text.length > lim.draft ? `${d.text.slice(0, lim.draft)}\n\n_(truncated at ${lim.draft} characters)_` : d.text.trim() || 'none', '')
  const fbTotal = c.statuses.reduce((n, [, k]) => n + k, 0)
  out.push('## LEAN-FEEDBACK since the last export', '', `Read: ${c.sources.join('; ')}`, '', fbTotal ? `Reports: ${fbTotal} (${c.statuses.map(([s, k]) => `${s} ${k}`).join(', ')})` : 'Reports: none', '', `Reports naming missing context: ${c.missingReports || 'none'}`, '')
  for (const f of FB_FIELDS) {
    const [shown, rest] = top(c.fields[f])
    out.push(`### ${f}`, '', ...(shown.length ? [...shown.map(g => `- ${g.n > 1 ? `(x${g.n}) ` : ''}${g.text}`), ...more(rest, 'entries'), ''] : none))
  }
  const [rShown, rRest] = top(c.refusals)
  out.push('## Guard refusals since the last export', '', ...(rShown.length ? [...rShown.map(r => `- (x${r.n}) [${r.agent}] ${r.rule ? `${r.rule}: ` : ''}${r.text}${r.version ? ` (${r.version})` : ''}`), ...more(rRest, 'refusals'), ''] : none))
  const [mShown, mRest] = top(c.missingTools)
  out.push('## Missing tools since the last export', '', ...(mShown.length ? [...mShown.map(r => `- (x${r.n}) ${r.text}`), ...more(mRest, 'missing tools'), ''] : none))
  const [cShown, cRest] = top(c.core)
  out.push('## Script candidates for lean-agent core', '', ...(cShown.length ? [...cShown.map(x => `- ${x.line}`), ...more(cRest, 'candidates'), ''] : none))
  const [bShown, bRest] = top(c.blocked.slice().reverse())
  out.push('## Threads blocked since the last export', '', ...(bShown.length ? [...bShown.map(b => `- ${b}`), ...more(bRest, 'reports'), ''] : none))
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
const bytes = (s: string) => new TextEncoder().encode(s).length
// MCP server names can be company names: a server outside the well-known public ones is masked wherever a refusal or missing-tool row names it
const MCP_PUBLIC = new Set(['azure-devops', 'github', 'sentry', 'datadog', 'linear', 'slack', 'atlassian', 'notion', 'lean-agent', 'claude-in-chrome'])
const mcpName = (n: string) => (MCP_PUBLIC.has(n.toLowerCase()) ? n : '<server>')
export const maskMcp = (t: string): string =>
  t
    .replace(/\bmcp__([A-Za-z0-9-]+)__([A-Za-z0-9_-]*)/g, (m, s: string, tool: string) => (MCP_PUBLIC.has(s.toLowerCase()) ? m : `mcp__<server>__${tool ? '<tool>' : ''}`))
    .replace(/\bmcp (?!server|servers|tool|tools|<)([A-Za-z0-9._-]{2,})/gi, (_m, n: string) => `mcp ${mcpName(n)}`)
    .replace(/\bserver ([A-Za-z0-9._-]{2,}) is not granted/g, (_m, n: string) => `server ${mcpName(n)} is not granted`)
    .replace(/(allow-mcp(?:-write)?: )([^)\n]*)/g, (_m, lead: string, list: string) => lead + list.split(/\s*,\s*/).map(x => (x === 'none' ? x : mcpName(x))).join(', '))

export function fit(c: Collected, at: number, cap = EXPORT_CAP): string {
  for (const lim of [{ draft: 1e9, top: 1e9 }, { draft: 6000, top: 20 }, { draft: 3000, top: 8 }, { draft: 1200, top: 3 }]) {
    const t = render(c, at, lim)
    if (bytes(t) <= cap) return t
  }
  const t = render(c, at, { draft: 600, top: 3 })
  let cut = t.slice(0, Math.max(0, cap - 200))
  while (bytes(cut) > cap - 200 && cut.length) cut = cut.slice(0, Math.floor(cut.length * 0.9)) // by bytes, not characters
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n\n_... the rest was cut to keep the file under ${Math.round(cap / 1024)} KB._\n`
}

// ---- the export ---------------------------------------------------------------------------------------------------------------
// `deps.wrap` lets a spec hand in a faulty anonymiser (a rule that regressed) to prove the final check refuses
export async function exportFeedback(h: Host, root: string, o: { notes?: string; version: string }, deps: { wrap?: (a: Anonymiser) => Anonymiser } = {}): Promise<{ ok: boolean; text: string; path?: string; copy?: string }> {
  try {
    const home = await homeDir(h)
    const dir = exportDir(home)
    const st = { ...emptyState(), ...(await readJson<Partial<State>>(h, `${dir}/state.json`, {})) } as State
    const startedAt = await h.clock.now() // taken BEFORE collecting: what is written meanwhile belongs to the next export
    const real = await makeAnonymiser(h)
    const an = deps.wrap ? deps.wrap(real) : real
    const c = await collect(h, root, o, st, an)
    const body = an.anonymise(fit(c, st.at)) // once more over the whole file: nothing reaches it unscrubbed
    const miss = an.missed(body)
    if (miss.length) return { ok: false, text: `Feedback export not written: a private string survived anonymising (rule that missed: ${miss.join(', ')}). Nothing was posted. Please report this to the maintainers without pasting the text.` }
    const now = await h.clock.now()
    const stamp = new Date(now).toISOString().slice(0, 16).replace('T', '-').replace(':', '')
    let path = `${dir}/${stamp}.md`
    for (let n = 2; await h.fs.exists(path).catch(() => false); n++) path = `${dir}/${stamp}-${n}.md`
    await mkdirp(h, dir)
    await atomicWrite(h, path, body)
    await writeJson(h, `${dir}/state.json`, { at: startedAt, drafts: [...st.drafts, ...c.drafts.map(d => d.raw)], core: [...st.core, ...c.core.map(x => x.name)] } satisfies State)
    const written = `Feedback export written: ${path} (${Math.ceil(bytes(body) / 1024)} KB, anonymised).`
    const cfg = await feedbackConfig(h, home)
    if (cfg.dest === 'local' && !cfg.problems.length) return { ok: true, path, text: `${written} Nothing was posted. Paste it to the maintainers, or ask the desk to post it.` }
    // config.json feedback.destination (feedbackdest.ts): only the text written above (already anonymised and checked) is copied or offered for posting
    const parts: string[] = [written]
    let copy: string | undefined
    if (wantsFolder(cfg.dest)) {
      const r = await copyToFolder(h, home, cfg.folder, path, `lean-agent-feedback-${stamp}.md`)
      if ('path' in r) {
        copy = r.path
        parts.push(`Copied to ${r.path}.`)
      } else parts.push(`${r.why}: written to ${path}.`)
    }
    for (const p of cfg.problems) parts.push(`(${p})`)
    parts.push('Nothing was posted.')
    if (wantsGithub(cfg.dest)) {
      const o2 = await offerPost(h, { title: c.drafts[0]?.title ?? '', body, fallbackTitle: `Feedback ${o.version} ${stamp}` })
      parts.push(o2.ok ? `To post it as a public issue on mcmadsen/lean-agent: request ${o2.id} waits for the user's Approve (nothing is posted until then): in the pane press Approve on its card; at the desk call lean_thread action-list, ask the user its question word for word, then approve-action ${o2.id}.` : `Not offered for posting: ${o2.why}. The export stays where it was written.`)
    }
    return { ok: true, path, ...(copy ? { copy } : {}), text: parts.join(' ') }
  } catch (e) {
    return { ok: false, text: `Feedback export failed: ${String((e as Error)?.message ?? e).slice(0, 200)}. Nothing was posted.` }
  }
}
