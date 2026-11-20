// One PR-comment fetch for every skill that reads review comments (pr: comments, review-learn), so the two never drift: the host comes
// from the origin URL (github.com -> gh; dev.azure.com and *.visualstudio.com -> az plus the REST threads endpoint), the comments come
// back in ONE shape, and a script (not a model) drops what is never a lesson: the owner's own comments, system threads, deleted
// comments, pure approvals and typo fixes, each counted. Exposed as `lean_review` action `prs` (reviewtool.ts).
// The Azure REST call needs a bearer token: `az account get-access-token --resource <Azure DevOps app id>`, never a PAT. The token lives in
// this function's memory only: it goes to curl on STDIN (`-H @-`, never argv, so not in a process list) and is scrubbed from every error.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'

export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
export const MAX_PRS = 30
export const DEFAULT_PRS = 10
const MAX_BODY = 1200 // one comment, cut
const MAX_TEXT = 30_000 // the whole digest

// ---- the host, from the origin URL ------------------------------------------------------------------------------------
export type PrHost = { kind: 'github'; owner: string; repo: string } | { kind: 'azure'; org: string; project: string; repo: string } | { kind: 'other'; host: string }
const dec = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
export function parseOrigin(url: string): PrHost {
  const u = url.trim()
  let m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u)
  if (m) return { kind: 'github', owner: m[1]!, repo: m[2]! }
  // https://dev.azure.com/{org}/{project}/_git/{repo}, https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
  m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)\/?$/i.exec(u)
  if (m) return { kind: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}, ssh://git@ssh.dev.azure.com/v3/..., {org}@vs-ssh.visualstudio.com:v3/...
  m = /^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\/([^/\s]+?)\/?$/i.exec(u)
  if (m) return { kind: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)\/?$/i.exec(u)
  if (m) return { kind: 'azure', org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  return { kind: 'other', host: /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:\s]+)/i.exec(u)?.[1] ?? u.slice(0, 60) }
}
export const azureBase = (o: { org: string; project: string; repo: string }) => `https://dev.azure.com/${encodeURIComponent(o.org)}/${encodeURIComponent(o.project)}/_apis/git/repositories/${encodeURIComponent(o.repo)}`
export const azureFlags = (o: { org: string; project: string; repo: string }) => ['--organization', `https://dev.azure.com/${o.org}`, '--project', o.project, '--repository', o.repo]

// ---- one comment shape ---------------------------------------------------------------------------------------------------
export type PrComment = {
  pr: number
  author: string
  body: string
  kind: 'review' | 'conversation' | 'inline' | 'thread'
  path?: string
  line?: number
  status?: string // an Azure thread's status: active | fixed | wontFix | closed | byDesign | pending
  reply?: boolean
  bot?: boolean
}
export type Counts = { seen: number; owner: number; system: number; deleted: number; approvals: number; typos: number; kept: number }
export const noCounts = (): Counts => ({ seen: 0, owner: 0, system: 0, deleted: 0, approvals: 0, typos: 0, kept: 0 })
type Raw = { c: PrComment; system?: boolean; deleted?: boolean; approval?: boolean }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {})
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

// a script's call, not a model's: a comment that is only agreement, or only a spelling fix, is not a lesson
const APPROVAL = /^(?:(?:lgtm|looks good(?: to me)?|looks great|approved?|ship it|\+1|:\+1:|👍|nice|great|good|thanks?|thank you|ok(?:ay)?|done|fixed|sounds good|perfect|agreed?)\W*)+$/i
const TYPO = /\b(typo|typos|misspell(?:ed|ing)?|spelling|grammar)\b/i
export const isApproval = (body: string) => body.trim().length <= 60 && APPROVAL.test(body.trim())
export const isTypo = (body: string) => body.trim().length <= 160 && TYPO.test(body)

// GitHub: `gh pr view <n> --json reviews,comments` and `gh api repos/{o}/{r}/pulls/<n>/comments`
export function githubComments(n: number, view: unknown, inline: unknown): Raw[] {
  const out: Raw[] = []
  const who = (u: any) => str(obj(u).login) || 'unknown'
  const bot = (u: any) => /\[bot\]$/i.test(str(obj(u).login)) || str(obj(u).type) === 'Bot' || obj(u).is_bot === true
  for (const r of arr(obj(view).reviews)) {
    const body = str(r.body).trim()
    const approved = str(r.state).toUpperCase() === 'APPROVED'
    if (!body && !approved) continue
    out.push({ c: { pr: n, author: who(r.author), body, kind: 'review', bot: bot(r.author) }, approval: approved && !body })
  }
  for (const r of arr(obj(view).comments)) if (str(r.body).trim()) out.push({ c: { pr: n, author: who(r.author), body: str(r.body).trim(), kind: 'conversation', bot: bot(r.author) } })
  for (const r of arr(inline)) {
    if (!str(r.body).trim()) continue
    const line = typeof r.line === 'number' ? r.line : typeof r.original_line === 'number' ? r.original_line : undefined
    out.push({ c: { pr: n, author: who(r.user), body: str(r.body).trim(), kind: 'inline', path: str(r.path) || undefined, line, reply: r.in_reply_to_id != null, bot: bot(r.user) } })
  }
  return out
}

// Azure DevOps: GET .../pullRequests/<n>/threads. A thread is a conversation: {id, status, isDeleted, properties, threadContext, comments[]}.
// System threads (a vote, a policy result, a ref update, a reviewer change ...) carry the property CodeReviewThreadType and/or comments
// with commentType "system"; a deleted thread or comment is gone for the author too.
export function azureComments(n: number, threads: unknown): Raw[] {
  const out: Raw[] = []
  const list = Array.isArray(threads) ? threads : arr(obj(threads).value)
  for (const t of list) {
    const th = obj(t)
    const threadSystem = 'CodeReviewThreadType' in obj(th.properties)
    const status = str(th.status) || undefined
    const ctx = obj(th.threadContext)
    const path = str(ctx.filePath) || undefined
    const line = typeof obj(ctx.rightFileStart).line === 'number' ? obj(ctx.rightFileStart).line : typeof obj(ctx.leftFileStart).line === 'number' ? obj(ctx.leftFileStart).line : undefined
    for (const c of arr(th.comments)) {
      const cm = obj(c)
      const author = str(obj(cm.author).uniqueName) || str(obj(cm.author).displayName) || 'unknown'
      const body = str(cm.content).trim()
      const base: PrComment = { pr: n, author, body, kind: 'thread', path, line, status, reply: typeof cm.parentCommentId === 'number' && cm.parentCommentId > 0 }
      if (th.isDeleted === true || cm.isDeleted === true) out.push({ c: base, deleted: true })
      else if (threadSystem || (str(cm.commentType) && str(cm.commentType) !== 'text')) out.push({ c: base, system: true })
      else if (body) out.push({ c: base })
    }
  }
  return out
}

// Count every comment seen, then keep what is a lesson: not the owner's, not system, not deleted, not a bare approval, not a typo fix.
export function keepLessons(raw: Raw[], owner: string): { kept: PrComment[]; counts: Counts } {
  const counts = noCounts()
  const kept: PrComment[] = []
  const me = owner.trim().toLowerCase()
  for (const r of raw) {
    counts.seen++
    if (r.deleted) counts.deleted++
    else if (r.system) counts.system++
    else if (me && r.c.author.trim().toLowerCase() === me) counts.owner++
    else if (r.approval || isApproval(r.c.body)) counts.approvals++
    else if (isTypo(r.c.body)) counts.typos++
    else {
      counts.kept++
      kept.push(r.c)
    }
  }
  return { kept, counts }
}
export const addCounts = (a: Counts, b: Counts): Counts => ({ seen: a.seen + b.seen, owner: a.owner + b.owner, system: a.system + b.system, deleted: a.deleted + b.deleted, approvals: a.approvals + b.approvals, typos: a.typos + b.typos, kept: a.kept + b.kept })
export const countsLine = (c: Counts) => `comments seen ${c.seen}, kept ${c.kept}; excluded: the owner's own ${c.owner}, system threads ${c.system}, deleted ${c.deleted}; dropped as approval ${c.approvals}, as typo fix ${c.typos}`

// ---- the digest the model reads ------------------------------------------------------------------------------------------
export type PrRow = { n: number; title: string; target: string; url?: string }
export type Fetched = { host: PrHost; owner: string; prs: PrRow[]; comments: PrComment[]; counts: Counts; notes: string[] }
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
export function renderFetched(f: Fetched): string {
  const where = f.host.kind === 'github' ? `github ${f.host.owner}/${f.host.repo}` : f.host.kind === 'azure' ? `azure ${f.host.org}/${f.host.project}/${f.host.repo}` : `other (${f.host.host})`
  const head = `LEAN-PR-COMMENTS ${JSON.stringify({ host: f.host.kind, owner: f.owner || null, prs: f.prs.map(p => p.n), counts: f.counts })}`
  const lines = [head, `${where} · owner ${f.owner || 'unknown'} · ${f.prs.length} PR(s): ${f.prs.map(p => `#${p.n}${p.target ? `→${p.target}` : ''}`).join(' ') || 'none'}`, countsLine(f.counts), ...f.notes.map(x => `note: ${x}`)]
  for (const p of f.prs) {
    const mine = f.comments.filter(c => c.pr === p.n)
    lines.push('', `## #${p.n} ${cut(p.title, 100)}${p.url ? ` ${p.url}` : ''} (${mine.length} comment(s) kept)`)
    for (const c of mine) lines.push(`${c.reply ? '  ↳ ' : '- '}[${[c.kind === 'thread' ? `thread${c.status ? ` ${c.status}` : ''}` : c.kind, c.path && `${c.path}${c.line ? `:${c.line}` : ''}`, c.bot && 'bot'].filter(Boolean).join(' · ')}] ${c.author}: ${cut(c.body.replace(/\s+/g, ' '), MAX_BODY)}`)
  }
  const text = lines.join('\n')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(cut at ${MAX_TEXT} characters: ask for fewer PRs, or one with pr)` : text
}

// ---- the runner ------------------------------------------------------------------------------------------------------------
type R = { ok: boolean; out: string; err: string }
async function sh(h: Host, argv: string[], init?: Record<string, unknown>): Promise<R> {
  try {
    const r = await h.process.run(argv, { timeoutMs: 60_000, ...init })
    return { ok: r.exitCode === 0, out: r.stdout ?? '', err: (r.stderr || r.stdout || '').trim() }
  } catch (e) {
    return { ok: false, out: '', err: String((e as Error)?.message ?? e) }
  }
}
const json = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
const oneLine = (s: string, n = 200) => s.replace(/\s+/g, ' ').trim().slice(0, n)

// `gh api --paginate` prints one JSON array per page, back to back: joined by scanning (strings and escapes respected), never by a
// text replace, which would also rewrite a comment body such as "see a[1] [2]".
export function joinPages(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') {
      if (depth++ === 0) start = i
    } else if (ch === ']' && depth > 0 && --depth === 0) {
      const page = json(text.slice(start, i + 1))
      if (Array.isArray(page)) out.push(...page)
    }
  }
  return out
}

export type FetchIn = { repo: string; pr?: number; last?: number; base?: string }
// `project` only names where the last fetch's counts are kept (learn reports them next to its own result)
export async function fetchPrs(h: Host, project: string, i: FetchIn): Promise<{ ok: boolean; text: string; fetched?: Fetched }> {
  const repo = i.repo
  if (!repo.startsWith('/')) return { ok: false, text: 'prs needs repo (an absolute path of the checkout) or a registered project' }
  const url = await sh(h, ['git', '-C', repo, 'remote', 'get-url', 'origin'])
  if (!url.ok || !url.out.trim()) return { ok: false, text: `prs: ${repo} has no origin remote (${oneLine(url.err, 120) || 'git remote get-url origin failed'})` }
  let host = parseOrigin(url.out)
  if (host.kind === 'other') {
    // an Enterprise host (or a mirror) that gh itself is logged in to: gh knows the repo from the checkout
    const nwo = await sh(h, ['gh', 'repo', 'view', '--json', 'nameWithOwner'], { cwd: repo })
    const [o, r] = str(obj(json(nwo.out)).nameWithOwner).split('/')
    if (nwo.ok && o && r) host = { kind: 'github', owner: o, repo: r }
  }
  if (host.kind === 'other') return { ok: false, text: `prs: the host ${host.host} is not supported (github.com and Azure DevOps are); give the branch name instead` }
  const n = Number.isInteger(i.pr) && (i.pr as number) > 0 ? (i.pr as number) : 0
  const last = Math.max(1, Math.min(MAX_PRS, Number.isInteger(i.last) ? (i.last as number) : DEFAULT_PRS))
  const base = (i.base ?? '').trim()
  if (base && !/^[A-Za-z0-9_][\w./-]*$/.test(base)) return { ok: false, text: 'prs: base must be a plain branch name' }
  const notes: string[] = []
  const f = host.kind === 'github' ? await fromGithub(h, repo, host, n, last, base, notes) : await fromAzure(h, host, n, last, base, notes)
  if (typeof f === 'string') return { ok: false, text: f }
  // (only a fetch of the last N: learn reports it, and a look at one PR must not replace the numbers of the round it is learning from)
  if (!n) await writeJson(h, `${leanDir(await homeDir(h))}/${project}/pr-fetch.json`, { at: await h.clock.now(), host: host.kind, prs: f.prs.map(p => p.n), counts: f.counts }).catch(() => undefined) // (a note for learn's report, never a failed fetch)
  return { ok: true, text: renderFetched(f), fetched: f }
}

// the counts of the last fetch of a project, for `learn`'s report (at most 12 hours old)
export async function lastFetchCounts(h: Host, project: string): Promise<{ counts: Counts; prs: number[] } | null> {
  const r = await readJson<{ at?: number; counts?: Counts; prs?: number[] } | null>(h, `${leanDir(await homeDir(h))}/${project}/pr-fetch.json`, null)
  if (!r || typeof r.at !== 'number' || !r.counts || (await h.clock.now()) - r.at > 12 * 3_600_000) return null
  return { counts: { ...noCounts(), ...r.counts }, prs: Array.isArray(r.prs) ? r.prs : [] }
}

async function fromGithub(h: Host, repo: string, host: Extract<PrHost, { kind: 'github' }>, n: number, last: number, base: string, notes: string[]): Promise<Fetched | string> {
  const who = await sh(h, ['gh', 'api', 'user', '--jq', '.login'], { cwd: repo })
  if (!who.ok) return `prs: gh cannot tell who you are (${oneLine(who.err, 120)}): gh is not installed or not logged in (gh auth login)`
  const owner = who.out.trim()
  let prs: PrRow[] = []
  const row = (x: any): PrRow => ({ n: Number(x.number), title: str(x.title), target: str(x.baseRefName), url: str(x.url) || undefined })
  if (n) {
    const v = await sh(h, ['gh', 'pr', 'view', String(n), '--json', 'number,title,baseRefName,url'], { cwd: repo })
    const o = obj(json(v.out))
    if (!v.ok || !o.number) return `prs: gh pr view ${n} failed: ${oneLine(v.err, 160)}`
    prs = [row(o)]
  } else {
    const q = async (b: string) => arr(json((await sh(h, ['gh', 'pr', 'list', '--state', 'merged', '--limit', String(last), ...(b ? ['--base', b] : []), '--json', 'number,title,baseRefName,url'], { cwd: repo })).out)).map(row)
    prs = base ? await q(base) : await q('')
    if (base && prs.length < last) {
      const more = (await q('')).filter(p => !prs.some(x => x.n === p.n))
      if (more.length) notes.push(`only ${prs.length} merged PR(s) into ${base}: ${Math.min(more.length, last - prs.length)} from other targets added`)
      prs = [...prs, ...more].slice(0, last)
    }
  }
  let raw: Raw[] = []
  for (const p of prs) {
    const view = await sh(h, ['gh', 'pr', 'view', String(p.n), '--json', 'reviews,comments'], { cwd: repo })
    // ({owner}/{repo} are gh's own placeholders: it resolves them from the checkout, so a fork or an Enterprise host reads the repo its PRs are in)
    const inline = await sh(h, ['gh', 'api', `repos/{owner}/{repo}/pulls/${p.n}/comments`, '--paginate'], { cwd: repo })
    if (!view.ok) notes.push(`#${p.n}: reviews and comments could not be read (${oneLine(view.err, 80)})`)
    if (!inline.ok) notes.push(`#${p.n}: inline comments could not be read (${oneLine(inline.err, 80)})`)
    raw = raw.concat(githubComments(p.n, json(view.out), joinPages(inline.out)))
  }
  const { kept, counts } = keepLessons(raw, owner)
  return { host, owner, prs, comments: kept, counts, notes }
}

async function fromAzure(h: Host, host: Extract<PrHost, { kind: 'azure' }>, n: number, last: number, base: string, notes: string[]): Promise<Fetched | string> {
  const flags = azureFlags(host)
  const who = await sh(h, ['az', 'account', 'show', '--query', 'user.name', '--output', 'tsv'])
  if (!who.ok || !who.out.trim()) return `prs: az is not logged in or not installed (${oneLine(who.err, 120)}): az login`
  const owner = who.out.trim()
  const row = (x: any): PrRow => ({ n: Number(x.pullRequestId), title: str(x.title), target: str(x.targetRefName).replace(/^refs\/heads\//, ''), url: undefined })
  let prs: PrRow[] = []
  if (n) {
    const v = await sh(h, ['az', 'repos', 'pr', 'show', '--id', String(n), '--output', 'json', ...flags.slice(0, 2)])
    const o = obj(json(v.out))
    if (!v.ok || !o.pullRequestId) return `prs: az repos pr show --id ${n} failed: ${oneLine(v.err, 160)}`
    prs = [row(o)]
  } else {
    const q = async (b: string) => arr(json((await sh(h, ['az', 'repos', 'pr', 'list', '--status', 'completed', '--top', String(last), ...(b ? ['--target-branch', b] : []), '--output', 'json', ...flags])).out)).map(row)
    prs = base ? await q(base) : await q('')
    if (base && prs.length < last) {
      const more = (await q('')).filter(p => !prs.some(x => x.n === p.n))
      if (more.length) notes.push(`only ${prs.length} completed PR(s) into ${base}: ${Math.min(more.length, last - prs.length)} from other targets added`)
      prs = [...prs, ...more].slice(0, last)
    }
  }
  const tok = await sh(h, ['az', 'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'])
  const token = tok.out.trim()
  if (!tok.ok || !token) return `prs: az could not give an access token for Azure DevOps (${oneLine(tok.err, 120)}): az login`
  const scrub = (s: string) => s.split(token).join('***')
  let raw: Raw[] = []
  for (const p of prs) {
    const r = await sh(h, ['curl', '-sS', '-f', '-H', '@-', `${azureBase(host)}/pullRequests/${p.n}/threads?api-version=7.1`], { stdin: `Authorization: Bearer ${token}\nAccept: application/json\n` })
    const parsed = json(r.out)
    if (!r.ok || parsed === null) notes.push(`#${p.n}: threads could not be read (${scrub(oneLine(r.err, 100))})`)
    else raw = raw.concat(azureComments(p.n, parsed))
  }
  const { kept, counts } = keepLessons(raw, owner)
  return { host, owner, prs, comments: kept, counts, notes }
}
