// The desk's `push`: the push (and an optional pull request) runs where the user said yes, in the desk, never in a thread.
// A thread's own permission check judges `git push` in the context of ITS session, which never saw the user's yes (it was said
// to the desk), so a thread cannot push even after approve-push. The desk's lean_thread does it instead, after the same gates the
// thread's push gate applies. $.process.run runs git with the repo's hooks off: the checks below ARE the gate here.
// Order: sha is full -> thread has a project that is not private -> the thread's worktree, its branch and HEAD == sha -> the
// branch is neither protected nor guarded -> green review for the sha -> a valid, unused approval for (project, sha, thread);
// only then is the approval consumed and git push run (never --force, never a tag, never the default branch).
import { appendJsonl, leanDir, readJson, realPath, threadsDir } from './state'
import type { Host } from './state'
import { greenReview, hasApproval, takeApproval } from './reviews'
import { DEFAULT_PUSH_DENY, PROTECTED, guardedBy } from './guard'
import type { Inbox, Out, Thread } from './threads'
import { registerWorktree, takeoverCandidate, unregisteredAt, worktreeState } from './worktreereg'
import { recordPushPr } from './ownpr'
import { createChecks } from './prchecks'

export type PrInput = { title?: unknown; body?: unknown; base?: unknown; draft?: unknown }

const FULL = /^[0-9a-f]{40,64}$/
// a branch, remote or base name: no leading dash or dot-dot, no spaces, no refspec syntax
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/
const nameOk = (n: string) => NAME.test(n) && !n.includes('..') && !n.includes('//') && !n.endsWith('/') && !n.endsWith('.lock') && !n.startsWith('refs/')
const GH_PLACES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] // the app's PATH (a macOS GUI app) often lacks these
const AZ_PLACES = ['/opt/homebrew/bin/az', '/usr/local/bin/az', '/usr/bin/az']

const err = (text: string): Out => ({ ok: false, text })
// no credential or ssh prompt can wait on a terminal nobody is at; every spawn is bounded (the thread's lock is held meanwhile)
// (az uses the user's own `az login`; no token is ever passed or read here)
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', AZURE_CORE_NO_COLOR: 'true', AZURE_CORE_ONLY_SHOW_ERRORS: 'true' }
const NET_MS = 120_000
// text from a remote or gh goes to the thread as a quote, never as plain words
const quoted = (s: string) => JSON.stringify(s.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200))

// the first line that says what went wrong (the first line of the output when none does)
export function firstError(r: { stdout?: string; stderr?: string }): string {
  const lines = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').map(l => l.trim()).filter(Boolean)
  const hit = lines.find(l => /\b(error|fatal|rejected|denied|failed|not found|refused)\b/i.test(l)) ?? lines[0] ?? 'no output'
  return hit.replace(/\s+/g, ' ').slice(0, 200)
}

// the "create a pull request" link a host prints after a push (GitHub pull/new, GitLab merge_requests/new, Azure pullrequestcreate)
export function compareUrl(output: string): string | null {
  for (const line of output.split('\n')) {
    if (!/pull\/new\/|merge_requests\/new|pullrequestcreate|compare\//i.test(line)) continue
    const m = /https?:\/\/[^\s"'<>]+/.exec(line)
    if (m) return m[0]
  }
  return null
}

async function git(h: Host, dir: string, ...a: string[]): Promise<{ ok: boolean; out: string; first: string }> {
  try {
    const r = await h.process.run(['git', '-C', dir, ...a], { timeoutMs: 30_000, env: NO_PROMPT })
    return { ok: r.exitCode === 0, out: r.stdout.trim(), first: firstError(r) }
  } catch (e) {
    return { ok: false, out: '', first: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}

async function findCli(h: Host, name: string, places: string[]): Promise<string | null> {
  try {
    if ((await h.process.run([name, '--version'])).exitCode === 0) return name
  } catch {
    /* not on PATH */
  }
  for (const p of places) if (await h.fs.exists(p).catch(() => false)) return p
  return null
}

// ---- Azure DevOps ------------------------------------------------------------------------------------------------
// The PR host is picked from the push remote's URL, as the pr skill does: Azure DevOps (dev.azure.com, the old <org>.visualstudio.com,
// and their ssh forms) opens the PR with `az repos pr create`; every other host keeps `gh`.
export type Ado = { org: string; project: string; repo: string }
const ADO_ORG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const decoded = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}
// a project or repository name: decoded, one line, no path or URL syntax, never a flag (it travels as an argv element, never through a shell)
const adoName = (s: string | undefined): string | null => {
  const d = s === undefined ? null : decoded(s)
  return d !== null && d === d.trim() && /^[^\x00-\x1f\x7f\\/?#:*"<>|%@]{1,128}$/.test(d) && !d.startsWith('-') ? d : null
}
export function adoOf(url: string): Ado | null {
  const u = url.trim()
  const user = '(?:[A-Za-z0-9._~%+-]+@)?' // (no `#`, `?` or `/`: `https://evil.example#@dev.azure.com/..` is not Azure DevOps)
  let m: RegExpExecArray | null
  let org: string | undefined
  let project: string | undefined
  let repo: string | undefined
  if ((m = new RegExp(`^https?://${user}dev\\.azure\\.com/([^/\\s]+)/(?:([^/\\s]+)/)?_git/([^/\\s]+?)/?$`, 'i').exec(u))) [, org, project, repo] = m
  else if ((m = new RegExp(`^https?://${user}([A-Za-z0-9-]+)\\.visualstudio\\.com/(?:DefaultCollection/)?(?:([^/\\s]+)/)?_git/([^/\\s]+?)/?$`, 'i').exec(u))) [, org, project, repo] = m
  else if ((m = /^(?:ssh:\/\/)?[A-Za-z0-9._~%+-]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(u))) [, org, project, repo] = m
  if (!m || !org || !ADO_ORG.test(org)) return null
  const r = adoName(repo)
  const p = project === undefined ? r : adoName(project) // dev.azure.com/<org>/_git/<repo>: the project is named like the repository
  return r && p ? { org, project: p, repo: r } : null
}
const enc = encodeURIComponent
const adoRepoUrl = (a: Ado) => `https://dev.azure.com/${enc(a.org)}/${enc(a.project)}/_git/${enc(a.repo)}`
// the "create a pull request" page of the host, for when the CLI cannot do it
export const adoCreateLink = (a: Ado, branch: string, base: string) => `${adoRepoUrl(a)}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(base)}`

// the PR link out of `az repos pr create|list --output json` (an object, or an array whose first element counts)
export function adoPrUrl(out: string, a: Ado): string | null {
  let j: any = null
  for (const text of [out.trim(), out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1), out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)]) {
    try {
      j = JSON.parse(text)
      break
    } catch {
      /* try the next slice: az may print a notice before the JSON */
    }
  }
  const pr = Array.isArray(j) ? j[0] : j
  const id = pr && typeof pr === 'object' ? String(pr.pullRequestId ?? '') : ''
  if (!/^\d{1,12}$/.test(id)) return null
  const web = pr.repository?.webUrl
  return `${typeof web === 'string' && /^https:\/\/[^\s"'<>]+$/.test(web) ? web.replace(/\/+$/, '') : adoRepoUrl(a)}/pullrequest/${id}`
}

type AdoResult = { kind: 'created'; url: string } | { kind: 'open'; url: string } | { kind: 'missing' } | { kind: 'failed'; why: string }
async function adoPullRequest(h: Host, dir: string, a: Ado, pr: { title: string; body: string; draft: boolean }, branch: string, base: string): Promise<AdoResult> {
  const az = await findCli(h, 'az', AZ_PLACES)
  if (!az) return { kind: 'missing' }
  const scope = ['--org', `https://dev.azure.com/${a.org}`, '--project', a.project, '--repository', a.repo]
  const run = async (argv: string[]) => {
    try {
      return await h.process.run(argv, { cwd: dir, timeoutMs: NET_MS, env: NO_PROMPT })
    } catch (e) {
      return { exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }
    }
  }
  // az reads a file named by a value that STARTS with `@` (`--title=@~/.ssh/id_rsa` would publish it): a thread's text never starts with one
  const noAt = (s: string, pad: string) => (s.startsWith('@') ? pad + s : s)
  const created = await run([az, 'repos', 'pr', 'create', ...scope, '--source-branch', branch, '--target-branch', base, `--title=${noAt(pr.title, ' ')}`, ...(pr.body ? [`--description=${noAt(pr.body, '\n')}`] : []), ...(pr.draft ? ['--draft'] : []), '--output', 'json'])
  const url = adoPrUrl(created.stdout, a)
  if (created.exitCode === 0 && url) return { kind: 'created', url }
  const all = `${created.stderr}\n${created.stdout}`
  if (created.exitCode !== 0 && /TF401179|pull request[^\n]*already exists/i.test(all)) {
    // az does not name the open PR in that error: ask for it (read-only)
    const open = await run([az, 'repos', 'pr', 'list', ...scope, '--source-branch', branch, '--target-branch', base, '--status', 'active', '--output', 'json'])
    const found = open.exitCode === 0 ? adoPrUrl(open.stdout, a) : null
    if (found) return { kind: 'open', url: found }
  }
  return { kind: 'failed', why: created.exitCode === 0 ? 'az printed no pull request id' : firstError(created) }
}

// host, owner and repository of a plain `host/owner/repo` remote URL (https, ssh:// or scp-like git@host:owner/repo); null for anything else
// (a local path, a nested group, a URL with odd characters): the PR is then opened as before, from the branch name alone
export function repoOf(url: string): { host: string; owner: string; repo: string } | null {
  const part = '([A-Za-z0-9][A-Za-z0-9._-]*)'
  const u = url.trim()
  const m = new RegExp(`^[a-z][a-z+.-]*://(?:[^@/\\s]+@)?([A-Za-z0-9.-]+)(?::\\d+)?/${part}/${part}/?$`).exec(u) ?? new RegExp(`^[^@/\\s:]+@([A-Za-z0-9.-]+):${part}/${part}/?$`).exec(u)
  const name = m?.[3]?.replace(/\.git$/, '')
  return m && name ? { host: m[1]!.toLowerCase(), owner: m[2]!, repo: name } : null
}

// A branch pushed to a remote that is not the base repository (a fork: the push remote's repository differs from `upstream`, else from
// `origin`) is opened as `--head owner:branch` against `--repo` of the base; gh would otherwise look for the branch in the base repository.
async function headOf(h: Host, dir: string, branch: string, pushUrl: string): Promise<{ head: string; repo?: string; fork: boolean }> {
  const plain = { head: branch, fork: false }
  const pushed = repoOf(pushUrl)
  if (!pushed) return plain
  for (const name of ['upstream', 'origin']) {
    const u = await git(h, dir, 'remote', 'get-url', name)
    if (!u.ok) continue
    const base = repoOf(u.out)
    if (!base || base.host !== pushed.host) return plain
    if (base.owner.toLowerCase() === pushed.owner.toLowerCase() && base.repo.toLowerCase() === pushed.repo.toLowerCase()) return plain
    return { head: `${pushed.owner}:${branch}`, repo: `${base.host === 'github.com' ? '' : `${base.host}/`}${base.owner}/${base.repo}`, fork: true }
  }
  return plain
}

type Wt = { path?: unknown; branch?: unknown; thread?: unknown }

export async function deskPush(h: Host, home: string, t: Thread, i: { sha?: string; pr?: PrInput | null }): Promise<Out> {
  const id = t.id
  const sha = (i.sha ?? '').trim().toLowerCase()
  const short = sha.slice(0, 8)
  // a closed thread is over (its worktree may be gone, its approval and review belonged to work it no longer owns): reopen it first.
  // A parked one is only paused: its approved, reviewed commit may still go out.
  if (t.state === 'closed' || t.state === 'closing') return err(`${id} is ${t.state}: reopen ${id} first, then push`)
  if (!FULL.test(sha)) return err('push needs the full commit sha the user approved (git rev-parse <ref>)')
  // the PR, validated up front: a bad title must not cost the approval
  let pr: { title: string; body: string; base: string; draft: boolean; draftSet: boolean } | null = null
  if (i.pr !== undefined && i.pr !== null) {
    const p = i.pr
    if (typeof p !== 'object') return err('pr must be an object: { title, body?, base?, draft? }')
    const title = typeof p.title === 'string' ? p.title.trim() : ''
    if (!title || title.length > 256 || /[\r\n]/.test(title)) return err('pr needs a title: one line, at most 256 characters')
    if (p.body !== undefined && (typeof p.body !== 'string' || p.body.length > 20_000)) return err('pr.body must be text of at most 20000 characters')
    const base = p.base === undefined ? '' : typeof p.base === 'string' ? p.base.trim() : '?'
    if (base && !nameOk(base)) return err(`pr.base ${JSON.stringify(p.base)} is not a plain branch name`)
    if (p.draft !== undefined && typeof p.draft !== 'boolean') return err('pr.draft must be true or false')
    pr = { title, body: typeof p.body === 'string' ? p.body : '', base, draft: p.draft === true, draftSet: p.draft !== undefined }
  }
  // 1. the thread's project, never a private one
  if (!t.project) return err(`${id} has no project, so there is nothing to push`)
  const pj = (await readJson<Record<string, { private?: boolean; path?: string }>>(h, `${leanDir(home)}/projects.json`, {}))?.[t.project]
  if (pj?.private === true) return err(`${t.project} is a private project: it is never pushed. Give the user the manual push command instead`)
  if (typeof pj?.path !== 'string' || !pj.path.startsWith('/')) return err(`${t.project} is not a registered project with a folder, so the desk cannot tell which repository the worktree must belong to`)
  // worktrees.json and the folders under ~/.lean-agent/worktrees are writable by the thread: only a LINKED worktree of the project's own
  // repository counts (same git common dir, so the remotes and config pushed with are the project's, not a repo the thread made)
  const common = await git(h, pj.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common.ok || !common.out.startsWith('/')) return err(`not pushed: cannot read the git directory of project ${t.project} (${common.first})`)
  // 2. the thread's worktree: the registered one whose HEAD is the approved commit
  const reg = await readJson<Record<string, Wt>>(h, `${leanDir(home)}/worktrees.json`, {})
  const mine = Object.values(reg && typeof reg === 'object' ? reg : {}).filter((w): w is Wt & { path: string } => !!w && typeof w === 'object' && w.thread === id && typeof w.path === 'string' && w.path.startsWith('/'))
  let wt = null as (Wt & { path: string }) | null // (set inside pick: the cast keeps the compiler from narrowing it to null)
  let seen = ''
  // What makes a worktree the project's is its git common dir (below), not the folder it sits in: a plain `git worktree add ../x` lives
  // outside the project's folders and must keep working after it is registered. The main checkout itself is not a linked worktree.
  const projectReal = await realPath(h, pj.path)
  const pick = async (list: (Wt & { path: string })[]): Promise<Out | null> => {
    for (const w of [...list].reverse()) {
      if ((await realPath(h, w.path)) === projectReal) { seen = seen || `${w.path} is the main checkout of project ${t.project}, not a linked worktree`; continue }
      const wc = await git(h, w.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      if (!wc.ok || (await realPath(h, wc.out)) !== (await realPath(h, common.out))) { seen = seen || `${w.path} is not a worktree of the repository of project ${t.project}`; continue }
      const head = await git(h, w.path, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}')
      if (!head.ok || !FULL.test(head.out)) { seen = seen || `${w.path}: cannot read HEAD (${head.first})`; continue }
      if (head.out !== sha) { seen = seen || `HEAD of ${w.path} is ${head.out.slice(0, 8)}, not ${short}`; continue }
      wt = w
      break
    }
    return null
  }
  const refused = await pick(mine)
  if (refused) return refused
  // A worktree made with plain `git worktree add` was never registered. It is adopted when the thread has no live registered worktree
  // (one that merely moved past the sha is told, not replaced by somebody else's), and the candidate is a LINKED worktree of the
  // project's own repository (`git worktree list`), on a branch, with HEAD == the approved commit, that no registry entry (of any
  // thread) has: the facts the worktree skill's adopt checks. Every gate below still applies to it, and the registry is written only
  // once the review and the approval hold (just before the approval is consumed): a refused push changes nothing.
  let adopt: { path: string; branch: string } | null = null
  // The same checks decide a takeover: a worktree registered to another thread is the pushing thread's when every owner is closed (or its
  // thread folder gone); an open, parked or closing owner is named in the refusal. Written by registerWorktree at the same point as the adopt.
  let takeover: { path: string; branch: string; from: string } | null = null
  if (!wt) {
    let liveMine = 0
    for (const w of mine) if ((await worktreeState(h, w.path)) === 'live') liveMine++
    if (!liveMine) {
      const un = await unregisteredAt(h, home, pj.path, sha)
      if (un.why) seen = seen || un.why
      if (un.one) {
        const refused2 = await pick([{ path: un.one.path, branch: un.one.branch, thread: id }])
        if (refused2) return refused2
        if (wt) adopt = { path: un.one.path, branch: un.one.branch }
      } else if (!un.why) { // an ambiguity (several unregistered worktrees at the sha) is never settled by taking one over
        const tk = await takeoverCandidate(h, home, pj.path, sha, id)
        if (tk.one) {
          const refused3 = await pick([{ path: tk.one.path, branch: tk.one.branch, thread: id }])
          if (refused3) return refused3
          if (wt) takeover = { path: tk.one.path, branch: tk.one.branch, from: tk.one.from }
        } else if (tk.why && !seen) return err(`not pushed: ${tk.why}`)
      }
    }
  }
  if (!wt) {
    if (!mine.length && !seen) return err(`${id} has no registered worktree (worktrees.json) and no unregistered linked worktree of ${t.project} is at ${short}, so the desk does not know what to push: have ${id} register its worktree (lean_worktree register, worktree skill), then ask again`)
    return err(`not pushed: ${seen || `${id} has no registered worktree (worktrees.json)`}. Push exactly the commit the user approved: ask ${id} for the current sha`)
  }
  const dir = wt.path
  // 3. the branch: the one checked out, the one registered, never a protected, guarded or default branch
  const cur = await git(h, dir, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const branch = cur.ok ? cur.out : ''
  if (!branch) return err(`not pushed: ${dir} has no branch checked out (detached HEAD), so there is no branch to push`)
  if (typeof wt.branch === 'string' && wt.branch && wt.branch !== branch) return err(`not pushed: ${dir} is on ${branch} but worktrees.json says ${wt.branch}`)
  if (!nameOk(branch)) return err(`not pushed: ${JSON.stringify(branch)} is not a plain branch name`)
  if (PROTECTED.test(branch)) return err(`not pushed: ${branch} is a protected branch; the desk pushes a feature branch only`)
  // the project's own push-deny list (guard.ts patternsFor finds the project by folder, which an adopted worktree outside it would miss)
  const deny = (pj as { guards?: Record<string, unknown> }).guards?.['push-deny']
  const guard = guardedBy(branch, Array.isArray(deny) ? deny.filter((x): x is string => typeof x === 'string') : DEFAULT_PUSH_DENY)
  if (guard) return err(`not pushed: ${branch} matches the guard '${guard}' of project ${t.project}`)
  const bc = async (k: string) => (await git(h, dir, 'config', `branch.${branch}.${k}`)).out
  const remote = (await bc('pushRemote')) || (await bc('remote')) || 'origin'
  if (!nameOk(remote)) return err(`not pushed: the remote of ${branch} is ${JSON.stringify(remote)}, a name was expected (a URL or path is never pushed to)`)
  const pushTo = await git(h, dir, 'remote', 'get-url', '--push', remote)
  if (!pushTo.ok) return err(`not pushed: ${dir} has no remote ${remote}`)
  // the remote's default branch: the local remote HEAD, else asked of the remote (read-only); unknown = refused, never assumed
  const rh = await git(h, dir, 'symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`)
  let deflt = rh.ok && rh.out.startsWith(`${remote}/`) ? rh.out.slice(remote.length + 1) : ''
  let asked = ''
  if (!deflt) {
    const ls = await git(h, dir, 'ls-remote', '--symref', remote, 'HEAD')
    deflt = (ls.ok && /^ref:\s*refs\/heads\/(\S+)\s+HEAD\b/m.exec(ls.out)?.[1]) || ''
    asked = ls.ok ? 'it named no branch' : ls.first
  }
  if (!deflt || !nameOk(deflt)) return err(`not pushed: the default branch of ${remote} is unknown (no ${remote}/HEAD here, asking the remote: ${asked}); the user can run git remote set-head ${remote} -a`)
  if (branch === deflt) return err(`not pushed: ${branch} is the default branch of ${remote}`)
  // 4. a green review record for this very commit (what the thread's push gate checks first)
  if (!(await greenReview(h, t.project, sha))) return err(`not pushed: no green review record for ${short} (project ${t.project}): have ${id} run the review skill on this commit`)
  // 5. the user's approval for (project, sha, thread): valid, unused; consumed here, once, just before the push
  if (!(await hasApproval(h, t.project, sha, id))) return err(`not pushed: no valid approval for ${short} from ${id} (none, used, expired or for another thread). The user's yes goes through approve-push first (single use, 2 h)`)
  // 1.0.31: the PR text follows the repo's guidelines, the diff holds no secret, and a PR without a green test run is proposed as a draft (prchecks.ts; config pr.checks): refused before anything changes
  let prNotes: string[] = []
  if (pr) {
    const chk = await createChecks(h, { dir, project: t.project, thread: id, sha, remote, base: pr.base || deflt, title: pr.title, body: pr.body, draft: pr.draftSet ? pr.draft : undefined })
    if (!chk.ok) return err(`not pushed: ${chk.text}`)
    pr.draft = chk.draft
    prNotes = chk.notes
  }
  if (adopt) {
    const r = await registerWorktree(h, { project: t.project, path: adopt.path, repo: pj.path, branch: adopt.branch, thread: id, adopted: true })
    if (!r.ok) return err(`not pushed: ${r.text}; the approval is kept`)
  }
  let took = ''
  if (takeover) {
    const r = await registerWorktree(h, { project: t.project, path: takeover.path, repo: pj.path, branch: takeover.branch, thread: id, adopted: true })
    if (!r.ok) return err(`not pushed: ${r.text}; the approval is kept`)
    took = `took over the registration of ${takeover.path} from ${r.from ?? takeover.from}`
    try {
      await appendJsonl(h, `${threadsDir(home)}/${id}/history.jsonl`, { ts: await h.clock.now(), kind: 'takeover', project: t.project, path: takeover.path, branch: takeover.branch, from: r.from ?? takeover.from, text: took })
    } catch {
      /* the registry is the record; the reply says it too */
    }
  }
  if (!(await takeApproval(h, t.project, sha, id))) return err(`not pushed: the approval for ${short} was just used by another push${took ? `; ${took}` : ''}`)

  const where = `${remote}/${branch}`
  // from here on the approval is used: every outcome is recorded and the thread is told
  const finish = async (res0: Out, kind: string, extra: Record<string, unknown>, tell: string): Promise<Out> => {
    const res: Out = took ? { ...res0, text: `${res0.text}; ${took}` } : res0
    const notes: string[] = []
    try {
      await appendJsonl(h, `${threadsDir(home)}/${id}/history.jsonl`, { ts: await h.clock.now(), kind, sha, project: t.project, remote, branch, ok: res.ok, text: res.text.slice(0, 600), ...extra })
    } catch (e) {
      notes.push(`history not written (${String((e as Error)?.message ?? e).slice(0, 100)})`)
    }
    try {
      await appendJsonl(h, `${threadsDir(home)}/${id}/inbox.jsonl`, { ts: await h.clock.now(), text: tell, from: 'desk' } satisfies Inbox) // queued: the desk's 10 s sweep (delivery.ts sweep) wakes an idle thread with it, a running one reads it after its next tool call
    } catch (e) {
      notes.push(`thread not told (${String((e as Error)?.message ?? e).slice(0, 100)})`)
    }
    // the PR this push opened (or found open) is the thread's own: its replies need no question (ownpr.ts; the user gets a one-line notice in the pane)
    // (a PR that was already open was not opened by this push: not an ownership signal)
    if (res.ok && typeof extra.pr === 'string' && extra.pr && !/PR already open/.test(res.text)) await recordPushPr(h, id, extra.pr).catch(() => null)
    return notes.length ? { ...res, text: `${res.text}. ${notes.join('; ')}` } : res
  }

  let pushed: { stdout: string; stderr: string; exitCode: number }
  try {
    // the approved OBJECT is pushed, not whatever the branch points at by now (the thread's session may commit meanwhile); a tag
    // never rides along (push.followTags), nothing is forced. -u cannot name a bare sha, so the upstream is set afterwards.
    pushed = await h.process.run(['git', '-C', dir, '-c', 'push.followTags=false', 'push', '--no-follow-tags', remote, `${sha}:refs/heads/${branch}`], { timeoutMs: NET_MS, env: NO_PROMPT })
    if (pushed.exitCode === 0 && !(await git(h, dir, 'config', `branch.${branch}.remote`)).out) await git(h, dir, 'branch', `--set-upstream-to=${remote}/${branch}`, branch) // best effort
  } catch (e) {
    pushed = { exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }
  }
  if (pushed.exitCode !== 0) {
    const text = `push failed at git push (${short} to ${where}): ${firstError(pushed)}. Nothing was pushed${pr ? ' and no PR was created' : ''}; the approval is used: the user's yes is needed again (approve-push) to retry`
    return await finish(err(text), 'push', { step: 'git push' }, `the desk tried to push ${sha} to ${where} and git push failed (git said ${quoted(firstError(pushed))}). Nothing was pushed; the desk decides what happens next`)
  }
  // the PR host is the push remote's: Azure DevOps has a create-PR page we can always name (and `az`); everything else is gh as before
  const ado = adoOf(pushTo.out)
  const adoBase = pr?.base || deflt
  const compare = ado ? adoCreateLink(ado, branch, adoBase) : compareUrl(`${pushed.stderr}\n${pushed.stdout}`)
  const done = `pushed ${sha} to ${where}${prNotes.length ? ` (${prNotes.join('; ')})` : ''}`
  const data = { pushed: true, sha, remote, branch, ...(compare ? { compare } : {}) }
  if (!pr) {
    return await finish({ ok: true, text: `${done}${compare ? `; compare URL ${compare}` : ''}`, data }, 'push', { compare }, `the desk pushed ${sha} to ${where}; no PR${compare ? `, compare URL ${compare}` : ''}`)
  }
  if (ado) {
    const r = await adoPullRequest(h, dir, ado, pr, branch, adoBase)
    const need = 'az repos pr create needs az + az login (extension azure-devops)'
    if (r.kind === 'created') {
      // 1.0.31: the PR's last steps belong to the mod (workitemflow.ts afterPrOpened): ONE request to link the PR and move the work item to Reviewing, only for the user's own task; the thread asks for nothing
      const tj = await readJson<{ workItems?: unknown; briefItems?: unknown }>(h, `${threadsDir(home)}/${id}/thread.json`, {}).catch(() => ({}) as { workItems?: unknown; briefItems?: unknown })
      const ids = [...new Set([...(Array.isArray(tj.workItems) ? tj.workItems : []), ...(Array.isArray(tj.briefItems) ? tj.briefItems : [])].filter((n): n is number => Number.isInteger(n)))].slice(0, 3)
      const next = ids.length ? `; the mod itself asks the user for the one request that links the PR to work item ${ids.join(', ')} and sets Reviewing, only for the user's own task (do not request it yourself)` : ''
      return await finish({ ok: true, text: `${done}; PR ${r.url}`, data: { ...data, pr: r.url } }, 'push', { compare, pr: r.url }, `the desk pushed ${sha} to ${where}; PR ${r.url}${next}`)
    }
    if (r.kind === 'open') return await finish({ ok: true, text: `${done}; PR already open: ${r.url}`, data: { ...data, pr: r.url } }, 'push', { compare, pr: r.url }, `the desk pushed ${sha} to ${where}; PR ${r.url}`)
    if (r.kind === 'missing') {
      const text = `${done}; az was not found (PATH, ${AZ_PLACES.join(', ')}), so no PR was created: ${need}; open it from ${compare}`
      return await finish({ ok: true, text, data }, 'push', { compare, pr: null }, `the desk pushed ${sha} to ${where}; PR not created (no az), create-PR link ${compare}`)
    }
    const text = `${done}; the PR step failed at az repos pr create: ${r.why}. ${need}. The branch is pushed; open the PR from ${compare}`
    return await finish({ ok: false, text, data }, 'push', { step: 'az repos pr create', compare }, `the desk pushed ${sha} to ${where}; the PR was not created (az said ${quoted(r.why)}), create-PR link ${compare}`)
  }
  const gh = await findCli(h, 'gh', GH_PLACES)
  if (!gh) {
    const text = `${done}; gh was not found (PATH, ${GH_PLACES.join(', ')}), so no PR was created: ${compare ? `open it from ${compare}` : 'the push output had no compare URL, open the PR by hand'}`
    return await finish({ ok: true, text, data }, 'push', { compare, pr: null }, `the desk pushed ${sha} to ${where}; PR not created (no gh), ${compare ? `compare URL ${compare}` : 'no compare URL'}`)
  }
  // (the default branch above is the push remote's; for a fork the base repository's own default is left to gh)
  const route = await headOf(h, dir, branch, pushTo.out)
  const base = pr.base || (route.fork ? '' : deflt)
  let created: { stdout: string; stderr: string; exitCode: number }
  try {
    // the body goes in on stdin: no file at a path the thread could have planted a link at
    created = await h.process.run([gh, 'pr', 'create', '--head', route.head, ...(route.repo ? ['--repo', route.repo] : []), ...(base ? ['--base', base] : []), `--title=${pr.title}`, '--body-file=-', ...(pr.draft ? ['--draft'] : [])], { cwd: dir, stdin: pr.body, timeoutMs: NET_MS, env: NO_PROMPT })
  } catch (e) {
    created = { exitCode: 1, stdout: '', stderr: String((e as Error)?.message ?? e) }
  }
  const all = `${created.stdout}\n${created.stderr}`
  const url = [...all.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0]).pop() ?? null
  if (created.exitCode === 0 && url) return await finish({ ok: true, text: `${done}; PR ${url}`, data: { ...data, pr: url } }, 'push', { compare, pr: url }, `the desk pushed ${sha} to ${where}; PR ${url}`)
  if (created.exitCode !== 0 && url && /already exists/i.test(all)) return await finish({ ok: true, text: `${done}; PR already open: ${url}`, data: { ...data, pr: url } }, 'push', { compare, pr: url }, `the desk pushed ${sha} to ${where}; PR ${url}`)
  const why = created.exitCode === 0 ? 'gh printed no PR link' : firstError(created)
  const text = `${done}; the PR step failed at gh pr create: ${why}. The branch is pushed${compare ? `; open the PR from ${compare}` : ''}`
  return await finish({ ok: false, text, data }, 'push', { step: 'gh pr create', compare }, `the desk pushed ${sha} to ${where}; the PR was not created (gh said ${quoted(why)})${compare ? `, compare URL ${compare}` : ''}`)
}
