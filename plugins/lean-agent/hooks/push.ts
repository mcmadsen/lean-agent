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
import { PROTECTED, guardedBy, patternsFor, projectOf } from './guard'
import type { Inbox, Out, Thread } from './threads'

export type PrInput = { title?: unknown; body?: unknown; base?: unknown; draft?: unknown }

const FULL = /^[0-9a-f]{40,64}$/
// a branch, remote or base name: no leading dash or dot-dot, no spaces, no refspec syntax
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/
const nameOk = (n: string) => NAME.test(n) && !n.includes('..') && !n.includes('//') && !n.endsWith('/') && !n.endsWith('.lock') && !n.startsWith('refs/')
const GH_PLACES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] // the app's PATH (a macOS GUI app) often lacks these

const err = (text: string): Out => ({ ok: false, text })
// no credential or ssh prompt can wait on a terminal nobody is at; every spawn is bounded (the thread's lock is held meanwhile)
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
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

async function findGh(h: Host): Promise<string | null> {
  try {
    if ((await h.process.run(['gh', '--version'])).exitCode === 0) return 'gh'
  } catch {
    /* not on PATH */
  }
  for (const p of GH_PLACES) if (await h.fs.exists(p).catch(() => false)) return p
  return null
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
  let pr: { title: string; body: string; base: string; draft: boolean } | null = null
  if (i.pr !== undefined && i.pr !== null) {
    const p = i.pr
    if (typeof p !== 'object') return err('pr must be an object: { title, body?, base?, draft? }')
    const title = typeof p.title === 'string' ? p.title.trim() : ''
    if (!title || title.length > 256 || /[\r\n]/.test(title)) return err('pr needs a title: one line, at most 256 characters')
    if (p.body !== undefined && (typeof p.body !== 'string' || p.body.length > 20_000)) return err('pr.body must be text of at most 20000 characters')
    const base = p.base === undefined ? '' : typeof p.base === 'string' ? p.base.trim() : '?'
    if (base && !nameOk(base)) return err(`pr.base ${JSON.stringify(p.base)} is not a plain branch name`)
    if (p.draft !== undefined && typeof p.draft !== 'boolean') return err('pr.draft must be true or false')
    pr = { title, body: typeof p.body === 'string' ? p.body : '', base, draft: p.draft === true }
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
  if (!mine.length) return err(`${id} has no registered worktree (worktrees.json), so the desk does not know what to push: have ${id} register its worktree (worktree skill, adopt), then ask again`)
  let wt: (Wt & { path: string }) | null = null
  let seen = ''
  for (const w of [...mine].reverse()) {
    const p = await projectOf(h, w.path)
    if (!p || p.slug !== t.project) { seen = seen || `${w.path} does not belong to project ${t.project}`; continue }
    if (p.private) return err(`${p.slug} is a private project: it is never pushed. Give the user the manual push command instead`)
    const wc = await git(h, w.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if (!wc.ok || (await realPath(h, wc.out)) !== (await realPath(h, common.out))) { seen = seen || `${w.path} is not a worktree of the repository of project ${t.project}`; continue }
    const head = await git(h, w.path, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}')
    if (!head.ok || !FULL.test(head.out)) { seen = seen || `${w.path}: cannot read HEAD (${head.first})`; continue }
    if (head.out !== sha) { seen = seen || `HEAD of ${w.path} is ${head.out.slice(0, 8)}, not ${short}`; continue }
    wt = w
    break
  }
  if (!wt) return err(`not pushed: ${seen}. Push exactly the commit the user approved: ask ${id} for the current sha`)
  const dir = wt.path
  // 3. the branch: the one checked out, the one registered, never a protected, guarded or default branch
  const cur = await git(h, dir, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const branch = cur.ok ? cur.out : ''
  if (!branch) return err(`not pushed: ${dir} has no branch checked out (detached HEAD), so there is no branch to push`)
  if (typeof wt.branch === 'string' && wt.branch && wt.branch !== branch) return err(`not pushed: ${dir} is on ${branch} but worktrees.json says ${wt.branch}`)
  if (!nameOk(branch)) return err(`not pushed: ${JSON.stringify(branch)} is not a plain branch name`)
  if (PROTECTED.test(branch)) return err(`not pushed: ${branch} is a protected branch; the desk pushes a feature branch only`)
  const guard = guardedBy(branch, await patternsFor(h, dir))
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
  if (!(await takeApproval(h, t.project, sha, id))) return err(`not pushed: the approval for ${short} was just used by another push`)

  const where = `${remote}/${branch}`
  // from here on the approval is used: every outcome is recorded and the thread is told
  const finish = async (res: Out, kind: string, extra: Record<string, unknown>, tell: string): Promise<Out> => {
    const notes: string[] = []
    try {
      await appendJsonl(h, `${threadsDir(home)}/${id}/history.jsonl`, { ts: await h.clock.now(), kind, sha, project: t.project, remote, branch, ok: res.ok, text: res.text.slice(0, 600), ...extra })
    } catch (e) {
      notes.push(`history not written (${String((e as Error)?.message ?? e).slice(0, 100)})`)
    }
    try {
      await appendJsonl(h, `${threadsDir(home)}/${id}/inbox.jsonl`, { ts: await h.clock.now(), text: tell, from: 'desk' } satisfies Inbox) // queued, nothing is woken: its next session reads it
    } catch (e) {
      notes.push(`thread not told (${String((e as Error)?.message ?? e).slice(0, 100)})`)
    }
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
  const compare = compareUrl(`${pushed.stderr}\n${pushed.stdout}`)
  const done = `pushed ${sha} to ${where}`
  const data = { pushed: true, sha, remote, branch, ...(compare ? { compare } : {}) }
  if (!pr) {
    return await finish({ ok: true, text: `${done}${compare ? `; compare URL ${compare}` : ''}`, data }, 'push', { compare }, `the desk pushed ${sha} to ${where}; no PR${compare ? `, compare URL ${compare}` : ''}`)
  }
  const gh = await findGh(h)
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
