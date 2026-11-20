import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { writeReview, writeApproval, APPROVAL_TTL_MS } from './reviews'
import { leanThread } from './threads'
import { adoCreateLink, adoOf, adoPrUrl, compareUrl, firstError, repoOf } from './push'

const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const WT = '/h/.lean-agent/worktrees/app/feat'
const PUSH_OUT = "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/feat\nTo github.com:o/r.git\n"

type Opts = { head?: string; branch?: string; defaultBranch?: string; lsDefault?: string; lsFail?: boolean; wtCommon?: string; remoteCfg?: string; pushResult?: { exitCode: number; stderr: string }; review?: boolean; approve?: boolean; ghFailure?: string; gh?: boolean; ghUrl?: string; urls?: Record<string, string>; state?: string; az?: boolean; azFailure?: string; azOut?: string; azList?: string; wtList?: string; registry?: Record<string, unknown> }

// a registered app project, thread t1 with its worktree, a green review and an approval for SHA: every gate open
async function setup(o: Opts = {}) {
  const h = fakeHost(null)
  const branch = o.branch ?? 'feat'
  const log: string[][] = []
  h.git.handler = a => {
    const s = a.join(' ')
    log.push(a)
    if (s.includes('worktree list')) return o.wtList ? { exitCode: 0, stdout: o.wtList } : { exitCode: 1, stdout: '' }
    if (s.includes('--show-toplevel')) return { exitCode: 0, stdout: a[1] + '\n' }
    if (s.includes('--git-common-dir')) return { exitCode: 0, stdout: (o.wtCommon && s.includes(WT) ? o.wtCommon : '/r/app/.git') + '\n' }
    if (s.includes('ls-remote')) return o.lsFail ? { exitCode: 128, stdout: '', stderr: 'fatal: unable to access remote' } : { exitCode: 0, stdout: `ref: refs/heads/${o.lsDefault ?? 'main'}\tHEAD\n${SHA}\tHEAD\n` }
    if (s.includes('rev-parse')) return { exitCode: 0, stdout: (o.head ?? SHA) + '\n' }
    if (s.includes('refs/remotes/origin/HEAD')) return o.defaultBranch === '' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `origin/${o.defaultBranch ?? 'main'}\n` }
    if (s.includes('symbolic-ref')) return branch ? { exitCode: 0, stdout: branch + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('config branch.')) return o.remoteCfg && s.endsWith('.remote') ? { exitCode: 0, stdout: o.remoteCfg + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('remote get-url')) {
      const name = a[a.length - 1]!
      if (o.urls) return o.urls[name] ? { exitCode: 0, stdout: o.urls[name] + '\n' } : { exitCode: 2, stdout: '', stderr: `error: No such remote '${name}'` }
      return { exitCode: 0, stdout: 'git@example.com:o/r.git\n' }
    }
    if (a.includes('push')) return { exitCode: 0, stderr: PUSH_OUT, stdout: '', ...(o.pushResult ?? {}) }
    return { exitCode: 1, stdout: '' }
  }
  const ghCalls: { argv: string[]; cwd?: string; body: string; env?: Record<string, string>; timeoutMs?: number }[] = []
  h.exec.handler = (argv, c) => {
    const isAz = /(^|\/)az$/.test(argv[0]!)
    if (argv[1] === '--version') return { exitCode: (isAz ? o.az : o.gh) === false ? 127 : 0, stdout: 'version 2\n' }
    ghCalls.push({ argv, cwd: c.cwd, body: c.stdin ?? '<none>', env: c.env, timeoutMs: c.timeoutMs })
    if (isAz) {
      if (argv[3] === 'list') return { exitCode: 0, stdout: o.azList ?? '[]' }
      return o.azFailure ? { exitCode: 1, stdout: '', stderr: o.azFailure } : { exitCode: 0, stdout: o.azOut ?? JSON.stringify({ pullRequestId: 12, repository: { webUrl: 'https://dev.azure.com/org1/00000000-aaaa/_git/repo1' } }) }
    }
    return o.ghFailure ? { exitCode: 1, stdout: '', stderr: o.ghFailure } : { exitCode: 0, stdout: (o.ghUrl ?? 'https://github.com/o/r/pull/7') + '\n' }
  }
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: o.state ?? 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify(o.registry ?? { 'app/feat': { path: WT, repo: '/r/app', branch, thread: 't1' } }))
  if (o.review !== false) await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  if (o.approve !== false) await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  const pushes = () => log.filter(a => a.includes('push'))
  const pushCall = () => h.calls.find(c => c.argv.includes('push'))
  const push = (extra: Record<string, unknown> = {}) => leanThread(h.host, '/p', { action: 'push', tN: 't1', sha: SHA, ...extra } as any)
  const history = () => String(h.files.get('/h/.lean-agent/threads/t1/history.jsonl') ?? '')
  const inbox = () => String(h.files.get('/h/.lean-agent/threads/t1/inbox.jsonl') ?? '')
  return { h, push, pushes, pushCall, log, ghCalls, history, inbox }
}

test('push refuses with the precise reason before anything leaves the machine, and keeps the approval', async () => {
  const refused: [string, Opts, Record<string, unknown>, string, ((s: Awaited<ReturnType<typeof setup>>) => void | Promise<void>)?][] = [
    ['a short sha', {}, { sha: 'abc' }, 'full commit sha'],
    ['no title', {}, { pr: { body: 'x' } }, 'needs a title'],
    ['a multi-line title', {}, { pr: { title: 'a\nb' } }, 'needs a title'],
    ['a base that is a flag', {}, { pr: { title: 't', base: '--force' } }, 'plain branch name'],
    ['a draft that is not a boolean', {}, { pr: { title: 't', draft: 'yes' } }, 'true or false'],
    ['no worktree registered', {}, {}, 'no registered worktree', s => void s.h.files.set('/h/.lean-agent/worktrees.json', '{}')],
    ['a worktree of another thread', {}, {}, 'no registered worktree', s => void s.h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'app/feat': { path: WT, branch: 'feat', thread: 't2' } }))],
    ['a worktree of another repository, outside the project', {}, {}, 'is not a worktree of the repository of project app', s => { s.h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ x: { path: '/elsewhere/feat', branch: 'feat', thread: 't1' } })); const old = s.h.git.handler; s.h.git.handler = (a: string[], c: any) => (a.join(' ').includes('--git-common-dir') && a[1] === '/elsewhere/feat' ? { exitCode: 0, stdout: '/other/.git\n' } : old(a, c)) }],
    ['the main checkout registered as a worktree', {}, {}, 'is the main checkout of project app', s => void s.h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ x: { path: '/r/app', branch: 'feat', thread: 't1' } }))],
    ['a worktree of another repository (its config is the thread\'s own)', { wtCommon: '/h/.lean-agent/worktrees/app/feat/.git' }, {}, 'is not a worktree of the repository of project app'],
    ['a project without a folder', {}, {}, 'not a registered project with a folder', s => void s.h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: {} }))],
    ['the default branch of the remote is unknown', { defaultBranch: '', lsFail: true }, {}, 'default branch of origin is unknown'],
    ['HEAD is another commit', { head: 'f'.repeat(40) }, {}, `HEAD of ${WT} is ffffffff, not ${SHA.slice(0, 8)}`],
    ['a detached HEAD', { branch: '' }, {}, 'no branch checked out'],
    ['the registered branch differs', {}, {}, 'worktrees.json says other', s => void s.h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ x: { path: WT, branch: 'other', thread: 't1' } }))],
    ['a protected branch', { branch: 'main' }, {}, 'protected branch'],
    ['a release branch', { branch: 'release/1.0' }, {}, 'protected branch'],
    ['the remote default branch', { defaultBranch: 'feat' }, {}, 'default branch of origin'],
    ['a guarded branch', {}, {}, "guard 'feat*'", s => void s.h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app', guards: { 'push-deny': ['feat*'] } } }))],
    ['a remote that is a URL', { remoteCfg: 'https://example.com/o/r.git' }, {}, 'a URL or path is never pushed to'],
    ['no green review', { review: false }, {}, 'no green review record'],
    ['no approval', { approve: false }, {}, 'no valid approval'],
    ['an expired approval', {}, {}, 'no valid approval', s => void (s.h.clock.t += APPROVAL_TTL_MS + 1)],
    ['an approval of another thread', { approve: false }, {}, 'no valid approval', async s => void (await writeApproval(s.h.host, { project: 'app', sha: SHA, thread: 't2' }))],
    ['a private project', {}, {}, 'private project', s => void s.h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app', private: true } }))],
    ['no project on the thread', {}, {}, 'has no project', s => void s.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))],
  ]
  for (const [name, opts, input, want, mutate] of refused) {
    const s = await setup(opts)
    await mutate?.(s)
    const r = await s.push(input)
    expect([name, r.ok, r.text]).toEqual([name, false, expect.stringContaining(want)])
    expect([name, s.pushes()]).toEqual([name, []]) // nothing was pushed
    expect([name, s.ghCalls]).toEqual([name, []]) // and no PR
    expect([name, s.history()]).toEqual([name, '']) // a refusal is the reply only: nothing was consumed or recorded
  }
  const none = await setup()
  expect((await leanThread(none.h.host, '/p', { action: 'push', tN: 't9', sha: SHA })).text).toContain('no thread t9')
  expect((await leanThread(none.h.host, '/p', { action: 'push', sha: SHA })).text).toContain('needs tN')
  // a refusal before the push leaves the approval usable: fix the cause and the same approval pushes
  const s = await setup({ head: 'f'.repeat(40) })
  expect((await s.push()).ok).toBe(false)
  s.h.git.handler = ((old: any) => (a: string[], c: any) => (a.join(' ').includes('rev-parse') && !a.includes('--git-common-dir') ? { exitCode: 0, stdout: SHA + '\n' } : old(a, c)))(s.h.git.handler)
  expect((await s.push()).ok).toBe(true)
})

test('push then PR: the desk pushes the exact branch, opens the PR with gh from the worktree, records it and tells the thread', async () => {
  const s = await setup()
  const r = await s.push({ pr: { title: 'Fix the thing', body: 'What changed.\n\nTested: yes.' } })
  expect(r.ok).toBe(true)
  expect(r.text).toBe(`pushed ${SHA} to origin/feat; PR https://github.com/o/r/pull/7`)
  // the approved object goes out (not whatever the branch is at by then), no tag rides along, nothing is forced
  expect(s.pushes()).toEqual([['-C', WT, '-c', 'push.followTags=false', 'push', '--no-follow-tags', 'origin', `${SHA}:refs/heads/feat`]])
  expect(JSON.stringify(s.pushes())).not.toMatch(/--force|--tags|--delete|\+refs|--mirror|--all/)
  expect(s.pushCall()).toMatchObject({ timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } }) // bounded, never waits for a prompt
  expect(s.ghCalls[0]).toMatchObject({ timeoutMs: 120_000, env: { GH_PROMPT_DISABLED: '1' } })
  expect(s.log).toContainEqual(['-C', WT, 'branch', '--set-upstream-to=origin/feat', 'feat']) // what -u would have set
  expect(s.ghCalls).toHaveLength(1)
  expect(s.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'feat', '--base', 'main', '--title=Fix the thing', '--body-file=-'])
  expect(s.ghCalls[0]!.argv).not.toContain('--draft')
  expect(s.ghCalls[0]!.cwd).toBe(WT)
  expect(s.ghCalls[0]!.body).toBe('What changed.\n\nTested: yes.') // the body goes in on stdin: no file is written
  expect(s.h.writes.filter(w => !w.includes('.tmp-'))).not.toContainEqual(expect.stringMatching(/\.md$/))
  const hist = s.history().trim().split('\n').map(l => JSON.parse(l))
  expect(hist).toHaveLength(1)
  expect(hist[0]).toMatchObject({ kind: 'push', sha: SHA, project: 'app', remote: 'origin', branch: 'feat', ok: true, pr: 'https://github.com/o/r/pull/7', compare: 'https://github.com/o/r/pull/new/feat' })
  expect(hist[0].text).toContain('PR https://github.com/o/r/pull/7')
  const queued = JSON.parse(s.inbox().trim())
  expect(queued).toMatchObject({ from: 'desk', text: `the desk pushed ${SHA} to origin/feat; PR https://github.com/o/r/pull/7` })
  // single use: the approval went with that push
  const again = await s.push({ pr: { title: 'Fix the thing' } })
  expect(again.ok).toBe(false)
  expect(again.text).toContain('no valid approval')
  expect(s.pushes()).toHaveLength(1)
  expect(s.ghCalls).toHaveLength(1)
  // a re-approval (the user's new yes) is what allows the next one
  await writeApproval(s.h.host, { project: 'app', sha: SHA, thread: 't1' })
  expect((await s.push()).ok).toBe(true)
})

test('push without pr, an explicit base and a draft, a remote from the branch config', async () => {
  const a = await setup({ remoteCfg: 'fork' })
  const r = await a.push()
  expect(r).toMatchObject({ ok: true, text: `pushed ${SHA} to fork/feat; compare URL https://github.com/o/r/pull/new/feat` })
  expect(a.pushes()[0]).toEqual(['-C', WT, '-c', 'push.followTags=false', 'push', '--no-follow-tags', 'fork', `${SHA}:refs/heads/feat`])
  expect(JSON.stringify(a.log)).not.toContain('--set-upstream-to') // the branch already has an upstream
  expect(a.ghCalls).toEqual([]) // no pr, no gh
  expect(JSON.parse(a.inbox().trim()).text).toBe(`the desk pushed ${SHA} to fork/feat; no PR, compare URL https://github.com/o/r/pull/new/feat`)
  const b = await setup()
  await b.push({ pr: { title: 'T', base: 'develop', draft: true } })
  expect(b.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'feat', '--base', 'develop', '--title=T', '--body-file=-', '--draft'])
  // no remote HEAD here: the remote is asked (read-only), and its answer is the default branch (and the PR base)
  const c = await setup({ defaultBranch: '', lsDefault: 'trunk' })
  await c.push({ pr: { title: 'T' } })
  expect(c.log).toContainEqual(['-C', WT, 'ls-remote', '--symref', 'origin', 'HEAD'])
  expect(c.ghCalls[0]!.argv).toContain('trunk')
  const d = await setup({ defaultBranch: '', lsDefault: 'feat' }) // ... and it is refused when that is the branch itself
  expect((await d.push()).text).toContain('is the default branch of origin')
  expect(d.pushes()).toEqual([])
})

test('gh missing: the push still happens and the reply gives the compare URL; gh is found in the usual places', async () => {
  const s = await setup({ gh: false })
  const r = await s.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(true)
  expect(r.text).toContain(`pushed ${SHA} to origin/feat`)
  expect(r.text).toContain('gh was not found')
  expect(r.text).toContain('open it from https://github.com/o/r/pull/new/feat')
  expect(s.ghCalls).toEqual([])
  expect(JSON.parse(s.inbox().trim()).text).toContain('PR not created (no gh), compare URL https://github.com/o/r/pull/new/feat')
  // no compare URL in the push output either
  const t = await setup({ gh: false, pushResult: { exitCode: 0, stderr: '' } })
  expect((await t.push({ pr: { title: 'T' } })).text).toContain('no compare URL, open the PR by hand')
  // not on PATH, but at the Homebrew place
  const u = await setup({ gh: false })
  u.h.files.set('/opt/homebrew/bin/gh', '')
  const v = await u.push({ pr: { title: 'T' } })
  expect(v.text).toContain('PR https://github.com/o/r/pull/7')
  expect(u.ghCalls[0]!.argv[0]).toBe('/opt/homebrew/bin/gh')
})

test('a failed push creates no PR, says the step and the first error line, and tells the thread', async () => {
  const s = await setup({ pushResult: { exitCode: 1, stderr: "To github.com:o/r.git\n ! [rejected]        feat -> feat (non-fast-forward)\nerror: failed to push some refs to 'github.com:o/r.git'\n" } })
  const r = await s.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('push failed at git push')
  expect(r.text).toContain('[rejected]')
  expect(r.text).toContain('no PR was created')
  expect(s.ghCalls).toEqual([])
  expect(JSON.parse(s.history().trim())).toMatchObject({ kind: 'push', ok: false, step: 'git push', sha: SHA })
  expect(JSON.parse(s.inbox().trim()).text).toContain('git push failed')
  expect((await s.push()).text).toContain('no valid approval') // the approval was used by the attempt: the user's yes is needed again
  // a push that cannot even start
  const t = await setup()
  t.h.git.handler = ((old: any) => (a: string[], c: any) => { if (a.includes('push')) throw new Error('spawn git ENOENT'); return old(a, c) })(t.h.git.handler)
  const u = await t.push({ pr: { title: 'T' } })
  expect(u.ok).toBe(false)
  expect(u.text).toContain('spawn git ENOENT')
  expect(t.ghCalls).toEqual([])
})

test('a failing gh keeps the pushed state visible; an already open PR is reported as open', async () => {
  const s = await setup({ ghFailure: 'GraphQL: Resource not accessible by integration\nmore' })
  const r = await s.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(false)
  expect(r.text).toContain(`pushed ${SHA} to origin/feat`)
  expect(r.text).toContain('the PR step failed at gh pr create: GraphQL: Resource not accessible by integration')
  expect(r.text).toContain('open the PR from https://github.com/o/r/pull/new/feat')
  expect(JSON.parse(s.history().trim())).toMatchObject({ ok: false, step: 'gh pr create' })
  expect(JSON.parse(s.inbox().trim()).text).toContain('the desk pushed')
  const t = await setup({ ghFailure: 'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/o/r/pull/5' })
  const u = await t.push({ pr: { title: 'T' } })
  expect(u).toMatchObject({ ok: true, text: `pushed ${SHA} to origin/feat; PR already open: https://github.com/o/r/pull/5` })
})

test('a branch pushed to a fork is opened as owner:branch against the base repository', async () => {
  // origin is the fork the branch went to, upstream the base repository
  const a = await setup({ urls: { origin: 'git@github.com:me/r.git', upstream: 'https://github.com/o/r.git' } })
  const r = await a.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(true)
  expect(a.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'me:feat', '--repo', 'o/r', '--title=T', '--body-file=-']) // no --base: the base repository's own default
  // an explicit base is kept
  const b = await setup({ urls: { origin: 'git@github.com:me/r.git', upstream: 'https://github.com/o/r.git' } })
  await b.push({ pr: { title: 'T', base: 'develop' } })
  expect(b.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'me:feat', '--repo', 'o/r', '--base', 'develop', '--title=T', '--body-file=-'])
  // a remote named fork, no upstream: origin is the base
  const c = await setup({ remoteCfg: 'fork', urls: { fork: 'ssh://git@github.com/me/r', origin: 'https://github.com/o/r' } })
  await c.push({ pr: { title: 'T' } })
  expect(c.ghCalls[0]!.argv.slice(0, 6)).toEqual(['gh', 'pr', 'create', '--head', 'me:feat', '--repo'])
  expect(c.ghCalls[0]!.argv[6]).toBe('o/r')
  // another host than github.com is named in --repo
  const d = await setup({ urls: { origin: 'git@ghe.example.com:me/r.git', upstream: 'git@ghe.example.com:o/r.git' } })
  await d.push({ pr: { title: 'T' } })
  expect(d.ghCalls[0]!.argv).toContain('ghe.example.com/o/r')
  // the push remote IS the base repository (origin only, or upstream with the same url): the branch name alone, as before
  const e = await setup({ urls: { origin: 'git@github.com:o/r.git' } })
  await e.push({ pr: { title: 'T' } })
  expect(e.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'feat', '--base', 'main', '--title=T', '--body-file=-'])
  const f = await setup({ urls: { origin: 'https://github.com/O/R', upstream: 'git@github.com:o/r.git' } })
  await f.push({ pr: { title: 'T' } })
  expect(f.ghCalls[0]!.argv).toContain('feat')
  expect(f.ghCalls[0]!.argv).not.toContain('--repo')
  // urls that are not plain host/owner/repo (a local path) are never guessed at
  const g = await setup({ urls: { origin: '/srv/git/r.git', upstream: 'https://github.com/o/r.git' } })
  await g.push({ pr: { title: 'T' } })
  expect(g.ghCalls[0]!.argv).toContain('feat')
  expect(g.ghCalls[0]!.argv).not.toContain('--repo')
  // no PR asked: the fork logic is not consulted at all
  const n = await setup({ urls: { origin: 'git@github.com:me/r.git', upstream: 'https://github.com/o/r.git' } })
  await n.push()
  expect(n.log.filter(x => x.includes('get-url') && !x.includes('--push'))).toEqual([])
})

test('repoOf reads host, owner and repo of plain remote urls only', () => {
  expect(repoOf('git@github.com:o/r.git')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(repoOf('https://github.com/o/r')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(repoOf('https://user@github.com/o/r.git/')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  expect(repoOf('ssh://git@ghe.example.com:2222/o/r.git')).toEqual({ host: 'ghe.example.com', owner: 'o', repo: 'r' })
  for (const bad of ['/srv/git/r.git', 'a/b/c.git', 'https://h/g/sub/r.git', 'https://h/-x/r', 'git@h:o', '', 'git@h:o/r name']) expect([bad, repoOf(bad)]).toEqual([bad, null])
})

test('a closed thread cannot push (reopen first); a parked one only paused, so it can', async () => {
  for (const state of ['closed', 'closing']) {
    const s = await setup({ state })
    const r = await s.push({ pr: { title: 'T' } })
    expect(r).toMatchObject({ ok: false, text: `t1 is ${state}: reopen t1 first, then push` })
    expect(s.pushes()).toEqual([])
    expect(s.ghCalls).toEqual([])
    expect(s.history()).toBe('') // nothing consumed: the approval is still there for after the reopen
    expect(await (async () => { s.h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 })); return (await s.push()).ok })()).toBe(true)
  }
  const p = await setup({ state: 'parked' })
  expect((await p.push()).ok).toBe(true)
  expect(p.pushes()).toHaveLength(1)
})

test('compare URLs and first error lines are read from the output', () => {
  expect(compareUrl(PUSH_OUT)).toBe('https://github.com/o/r/pull/new/feat')
  expect(compareUrl('remote: Create a pull request for feat by visiting:\nremote:   https://gitlab.com/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat\n')).toContain('merge_requests/new')
  expect(compareUrl('remote: https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=feat')).toContain('pullrequestcreate')
  expect(compareUrl('Everything up-to-date')).toBeNull()
  expect(firstError({ stderr: 'hint: x\nfatal: could not read Username\nmore' })).toBe('fatal: could not read Username')
  expect(firstError({ stderr: '', stdout: '' })).toBe('no output')
})

const ADO_ORIGIN = 'https://dev.azure.com/org1/proj1/_git/repo1'
const ADO_LINK = 'https://dev.azure.com/org1/proj1/_git/repo1/pullrequestcreate?sourceRef=feat&targetRef=main'

test('adoOf reads org, project and repository from every Azure DevOps remote form, and nothing else', () => {
  const want = { org: 'org1', project: 'proj1', repo: 'repo1' }
  for (const url of [
    'https://dev.azure.com/org1/proj1/_git/repo1',
    'https://org1@dev.azure.com/org1/proj1/_git/repo1',
    'https://dev.azure.com/org1/proj1/_git/repo1/',
    'git@ssh.dev.azure.com:v3/org1/proj1/repo1',
    'ssh://git@ssh.dev.azure.com/v3/org1/proj1/repo1',
    'ssh://git@ssh.dev.azure.com:22/v3/org1/proj1/repo1',
    'https://org1.visualstudio.com/proj1/_git/repo1',
    'https://org1.visualstudio.com/DefaultCollection/proj1/_git/repo1',
    'https://org1@org1.visualstudio.com/proj1/_git/repo1',
    'org1@vs-ssh.visualstudio.com:v3/org1/proj1/repo1',
  ]) expect([url, adoOf(url)]).toEqual([url, want])
  // an encoded name is decoded; a project-less url names the project like the repository
  expect(adoOf('https://dev.azure.com/org1/My%20Proj/_git/my%20repo')).toEqual({ org: 'org1', project: 'My Proj', repo: 'my repo' })
  expect(adoOf('https://dev.azure.com/org1/_git/repo1')).toEqual({ org: 'org1', project: 'repo1', repo: 'repo1' })
  for (const bad of ['https://github.com/o/r', 'git@github.com:o/r.git', '/srv/git/r', '', 'https://dev.azure.com/org1/proj1', 'https://dev.azure.com/org1/proj1/_git/', 'https://dev.azure.com/-org/proj1/_git/repo1', 'https://dev.azure.com/org1/-p/_git/repo1', 'https://dev.azure.com/org1/p%0Aq/_git/repo1', 'https://dev.azure.com/org1/p%2Fq/_git/repo1', 'https://dev.azure.com/org1/p%40q/_git/repo1', 'https://evil.example#@dev.azure.com/org1/proj1/_git/repo1', 'https://evil.example?x=@dev.azure.com/org1/proj1/_git/repo1', 'x#y@ssh.dev.azure.com:v3/org1/proj1/repo1', 'https://example.com/dev.azure.com/org1/proj1/_git/repo1', 'git@ssh.dev.azure.com:v3/org1/proj1']) expect([bad, adoOf(bad)]).toEqual([bad, null])
})

test('the create-PR link is URL-encoded, and the PR link is read from az JSON', () => {
  const a = { org: 'org1', project: 'My Proj', repo: 'my repo' }
  expect(adoCreateLink(a, 'feature/a b&c', 'main')).toBe('https://dev.azure.com/org1/My%20Proj/_git/my%20repo/pullrequestcreate?sourceRef=feature%2Fa%20b%26c&targetRef=main')
  const b = { org: 'org1', project: 'proj1', repo: 'repo1' }
  expect(adoPrUrl('{"pullRequestId": 7, "repository": {"webUrl": "https://dev.azure.com/org1/guid/_git/repo1/"}}', b)).toBe('https://dev.azure.com/org1/guid/_git/repo1/pullrequest/7')
  expect(adoPrUrl('{"pullRequestId": 7}', b)).toBe('https://dev.azure.com/org1/proj1/_git/repo1/pullrequest/7') // no webUrl: built
  expect(adoPrUrl('WARNING: x\n[{"pullRequestId": 9}]', b)).toBe('https://dev.azure.com/org1/proj1/_git/repo1/pullrequest/9') // a notice first; a list
  expect(adoPrUrl('{"repository": {"webUrl": "https://x"}}', b)).toBeNull()
  expect(adoPrUrl('{"pullRequestId": "7; rm"}', b)).toBeNull()
  expect(adoPrUrl('not json', b)).toBeNull()
  expect(adoPrUrl('[]', b)).toBeNull()
})

test('Azure DevOps remote: push, then az repos pr create (argv, no shell, the user\'s az login), PR id read from its JSON', async () => {
  const s = await setup({ urls: { origin: ADO_ORIGIN } })
  const r = await s.push({ pr: { title: 'Fix the thing', body: 'What changed.\n\n- tested' } })
  expect(r).toMatchObject({ ok: true, text: `pushed ${SHA} to origin/feat; PR https://dev.azure.com/org1/00000000-aaaa/_git/repo1/pullrequest/12` })
  expect(s.ghCalls).toHaveLength(1)
  expect(s.ghCalls[0]!.argv).toEqual(['az', 'repos', 'pr', 'create', '--org', 'https://dev.azure.com/org1', '--project', 'proj1', '--repository', 'repo1', '--source-branch', 'feat', '--target-branch', 'main', '--title=Fix the thing', '--description=What changed.\n\n- tested', '--output', 'json'])
  expect(s.ghCalls[0]).toMatchObject({ cwd: WT, timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } })
  expect(JSON.stringify(s.ghCalls)).not.toMatch(/gh|token|--pat|AZURE_DEVOPS_EXT_PAT/)
  expect(s.h.calls.some(c => c.argv[0] === 'gh')).toBe(false) // gh is never looked for
  const hist = JSON.parse(s.history().trim())
  expect(hist).toMatchObject({ ok: true, pr: 'https://dev.azure.com/org1/00000000-aaaa/_git/repo1/pullrequest/12', compare: ADO_LINK })
  expect(JSON.parse(s.inbox().trim()).text).toBe(`the desk pushed ${SHA} to origin/feat; PR https://dev.azure.com/org1/00000000-aaaa/_git/repo1/pullrequest/12`)
  // draft, an explicit base, the ssh and the old url forms, no body: no --description
  const b = await setup({ urls: { origin: 'git@ssh.dev.azure.com:v3/org1/proj1/repo1' } })
  await b.push({ pr: { title: 'T', base: 'develop', draft: true } })
  expect(b.ghCalls[0]!.argv).toEqual(['az', 'repos', 'pr', 'create', '--org', 'https://dev.azure.com/org1', '--project', 'proj1', '--repository', 'repo1', '--source-branch', 'feat', '--target-branch', 'develop', '--title=T', '--draft', '--output', 'json'])
  const c = await setup({ urls: { origin: 'https://org1.visualstudio.com/proj1/_git/repo1' } })
  expect((await c.push({ pr: { title: 'T' } })).ok).toBe(true)
  expect(c.ghCalls[0]!.argv.slice(4, 10)).toEqual(['--org', 'https://dev.azure.com/org1', '--project', 'proj1', '--repository', 'repo1'])
  // the push itself is unchanged
  expect(s.pushes()).toEqual([['-C', WT, '-c', 'push.followTags=false', 'push', '--no-follow-tags', 'origin', `${SHA}:refs/heads/feat`]])
  // no PR asked: the reply names the create-PR link (the push output of Azure DevOps names none)
  const n = await setup({ urls: { origin: ADO_ORIGIN }, pushResult: { exitCode: 0, stderr: '' } })
  expect(await n.push()).toMatchObject({ ok: true, text: `pushed ${SHA} to origin/feat; compare URL ${ADO_LINK}` })
  expect(n.ghCalls).toEqual([])
})

test('Azure DevOps remote: a title or body that starts with @ never reaches az as a file reference', async () => {
  const s = await setup({ urls: { origin: ADO_ORIGIN } })
  await s.push({ pr: { title: '@~/.ssh/id_rsa', body: '@/etc/hosts\nmore' } })
  const argv = s.ghCalls[0]!.argv
  expect(argv).toContain('--title= @~/.ssh/id_rsa')
  expect(argv).toContain('--description=\n@/etc/hosts\nmore')
  expect(argv.filter(a => /^--(title|description)=@/.test(a))).toEqual([])
  // an @ later in the text is untouched
  const t = await setup({ urls: { origin: ADO_ORIGIN } })
  await t.push({ pr: { title: 'ping @team', body: 'a @b' } })
  expect(t.ghCalls[0]!.argv).toContain('--title=ping @team')
})

test('Azure DevOps remote: az is found in the usual places; missing az names az, never gh, and gives the create-PR link', async () => {
  const s = await setup({ urls: { origin: ADO_ORIGIN }, az: false })
  const r = await s.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(true)
  expect(r.text).toContain(`pushed ${SHA} to origin/feat`)
  expect(r.text).toContain('az was not found')
  expect(r.text).toContain('az repos pr create needs az + az login')
  expect(r.text).toContain(`open it from ${ADO_LINK}`)
  expect(r.text).not.toMatch(/\bgh\b/)
  expect(s.ghCalls).toEqual([])
  expect(JSON.parse(s.inbox().trim()).text).toBe(`the desk pushed ${SHA} to origin/feat; PR not created (no az), create-PR link ${ADO_LINK}`)
  expect(JSON.parse(s.history().trim())).toMatchObject({ ok: true, pr: null, compare: ADO_LINK })
  // a branch with a slash and a base are URL-encoded in the link
  const t = await setup({ urls: { origin: ADO_ORIGIN }, az: false, branch: 'feature/a-b' })
  expect((await t.push({ pr: { title: 'T', base: 'release-x' } })).text).toContain('pullrequestcreate?sourceRef=feature%2Fa-b&targetRef=release-x')
  // not on PATH, but at the Homebrew place
  const u = await setup({ urls: { origin: ADO_ORIGIN }, az: false })
  u.h.files.set('/opt/homebrew/bin/az', '')
  expect((await u.push({ pr: { title: 'T' } })).text).toContain('PR https://dev.azure.com/org1/00000000-aaaa/_git/repo1/pullrequest/12')
  expect(u.ghCalls[0]!.argv[0]).toBe('/opt/homebrew/bin/az')
})

test('Azure DevOps remote: a failing az keeps the pushed state visible, names az + az login and the link; an open PR is found', async () => {
  const s = await setup({ urls: { origin: ADO_ORIGIN }, azFailure: "ERROR: Please run 'az login' to setup account.\nmore" })
  const r = await s.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(false)
  expect(r.text).toContain(`pushed ${SHA} to origin/feat`)
  expect(r.text).toContain("the PR step failed at az repos pr create: ERROR: Please run 'az login' to setup account.")
  expect(r.text).toContain('az repos pr create needs az + az login')
  expect(r.text).toContain(`open the PR from ${ADO_LINK}`)
  expect(r.text).not.toMatch(/\bgh\b/)
  expect(JSON.parse(s.history().trim())).toMatchObject({ ok: false, step: 'az repos pr create', compare: ADO_LINK })
  // az exits 0 but prints no id
  const t = await setup({ urls: { origin: ADO_ORIGIN }, azOut: '{}' })
  expect((await t.push({ pr: { title: 'T' } })).text).toContain('az printed no pull request id')
  // a PR for that branch pair is already open: az does not name it, the list does
  const u = await setup({ urls: { origin: ADO_ORIGIN }, azFailure: 'ERROR: TF401179: An active pull request for the source and target branch already exists.', azList: '[{"pullRequestId": 5}]' })
  expect(await u.push({ pr: { title: 'T' } })).toMatchObject({ ok: true, text: `pushed ${SHA} to origin/feat; PR already open: https://dev.azure.com/org1/proj1/_git/repo1/pullrequest/5` })
  expect(u.ghCalls[1]!.argv).toEqual(['az', 'repos', 'pr', 'list', '--org', 'https://dev.azure.com/org1', '--project', 'proj1', '--repository', 'repo1', '--source-branch', 'feat', '--target-branch', 'main', '--status', 'active', '--output', 'json'])
  // ... and when the list finds none, it is the failure with the link
  const v = await setup({ urls: { origin: ADO_ORIGIN }, azFailure: 'ERROR: TF401179: An active pull request for the source and target branch already exists.' })
  expect((await v.push({ pr: { title: 'T' } })).ok).toBe(false)
  // a push that failed creates no PR for Azure DevOps either
  const w = await setup({ urls: { origin: ADO_ORIGIN }, pushResult: { exitCode: 1, stderr: 'fatal: nope' } })
  expect((await w.push({ pr: { title: 'T' } })).ok).toBe(false)
  expect(w.ghCalls).toEqual([])
})

const LIST = (...wts: [string, string, string][]) => ['worktree /r/app\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n', ...wts.map(([p, head, br]) => `worktree ${p}\nHEAD ${head}\n${br ? `branch refs/heads/${br}` : 'detached'}\n`)].join('\n')
const registry = (s: Awaited<ReturnType<typeof setup>>) => JSON.parse(String(s.h.files.get('/h/.lean-agent/worktrees.json')))

test('an unregistered linked worktree at the approved sha is adopted by the push; the other gates still apply', async () => {
  // made with plain `git worktree add`, outside the project's folders, never registered
  const a = await setup({ registry: {}, wtList: LIST(['/w/feat', SHA, 'feat']) })
  const r = await a.push({ pr: { title: 'T' } })
  expect(r.ok).toBe(true)
  expect(a.pushes()).toEqual([['-C', '/w/feat', '-c', 'push.followTags=false', 'push', '--no-follow-tags', 'origin', `${SHA}:refs/heads/feat`]])
  expect(registry(a)).toEqual({ 'app/feat': { path: '/w/feat', repo: '/r/app', branch: 'feat', thread: 't1', adopted: true } })
  // the project's own repository is asked, read-only
  expect(a.log).toContainEqual(['-C', '/r/app', 'worktree', 'list', '--porcelain'])
  // no review: adopted (it is registered for the thread), but nothing is pushed
  const b = await setup({ registry: {}, wtList: LIST(['/w/feat', SHA, 'feat']), review: false })
  expect((await b.push()).text).toContain('no green review record')
  expect(b.pushes()).toEqual([])
  expect(registry(b)).toEqual({}) // a refused push changes nothing: the registry is written only once the review and approval hold
  // the second push of that worktree (re-approved) finds it registered, though it lives outside the project's folders
  await writeApproval(a.h.host, { project: 'app', sha: SHA, thread: 't1' })
  const log2 = a.log.length
  expect((await a.push()).ok).toBe(true)
  expect(a.pushes()).toHaveLength(2)
  expect(a.log.slice(log2).filter(x => x.includes('worktree'))).toEqual([]) // registered: no search for another
  // a refused approval does not register either
  const e = await setup({ registry: {}, wtList: LIST(['/w/feat', SHA, 'feat']), approve: false })
  expect((await e.push()).text).toContain('no valid approval')
  expect(registry(e)).toEqual({})
  // the project's own guard list applies to an adopted worktree (it sits outside the project's folders)
  const g = await setup({ registry: {}, wtList: LIST(['/w/feat', SHA, 'feat']) })
  g.h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app', guards: { 'push-deny': ['feat*'] } } }))
  expect((await g.push()).text).toContain("guard 'feat*'")
  expect(g.pushes()).toEqual([])
  expect(registry(g)).toEqual({})
  // a protected branch is refused as for a registered worktree
  const c = await setup({ registry: {}, wtList: LIST(['/w/rel', SHA, 'release/1.0']), branch: 'release/1.0' })
  expect((await c.push()).text).toContain('protected branch')
  // registered worktrees keep working as before and are never searched for another
  const d = await setup()
  await d.push()
  expect(d.log.filter(x => x.includes('worktree'))).toEqual([])
})

test('an unregistered worktree is NOT adopted unless it is the one linked worktree at that sha on a branch', async () => {
  const none: [string, Opts, string][] = [
    ['HEAD is another commit', { wtList: LIST(['/w/feat', 'f'.repeat(40), 'feat']) }, 'no registered worktree'],
    ['detached', { wtList: LIST(['/w/feat', SHA, '']), branch: '' }, 'no registered worktree'],
    ['git cannot list', {}, 'no registered worktree'],
    ['only the main checkout is at the sha', { wtList: `worktree /r/app\nHEAD ${SHA}\nbranch refs/heads/feat\n` }, 'no registered worktree'],
    ['registered for another thread (never taken over)', { registry: { 'app/feat': { path: '/w/feat', branch: 'feat', thread: 't2' } }, wtList: LIST(['/w/feat', SHA, 'feat']) }, 'no registered worktree'],
    ['a prunable entry', { wtList: LIST(['/w/feat', SHA, 'feat']).replace('branch refs/heads/feat', 'branch refs/heads/feat\nprunable gitdir file points to non-existent location') }, 'no registered worktree'],
    ['two candidates (ambiguous, named)', { wtList: LIST(['/w/a', SHA, 'feat'], ['/w/b', SHA, 'feat2']) }, '2 unregistered worktrees are at'],
  ]
  for (const [name, opts, want] of none) {
    const s = await setup({ registry: {}, ...opts })
    const r = await s.push()
    expect([name, r.ok, r.text]).toEqual([name, false, expect.stringContaining(want)])
    expect([name, s.pushes()]).toEqual([name, []])
    expect([name, s.history()]).toEqual([name, '']) // nothing consumed
    if (name.startsWith('registered for another')) expect(registry(s)['app/feat'].thread).toBe('t2')
  }
})

test('a thread whose own registered worktree moved past the approved sha is told so, not given another thread\'s worktree', async () => {
  const s = await setup({ head: 'f'.repeat(40), wtList: LIST(['/w/other', SHA, 'feat2']) })
  s.h.files.set(`${WT}/.git`, 'x') // its own worktree is live, at another commit
  const old = s.h.git.handler
  s.h.git.handler = (a: string[], c: any) => (a[1] === '/w/other' && a.includes('rev-parse') && !a.includes('--git-common-dir') && !a.includes('--show-toplevel') ? { exitCode: 0, stdout: SHA + '\n' } : old(a, c))
  const r = await s.push()
  expect(r.ok).toBe(false)
  expect(r.text).toContain(`HEAD of ${WT} is ffffffff, not ${SHA.slice(0, 8)}`)
  expect(s.pushes()).toEqual([])
  expect(Object.keys(registry(s))).toEqual(['app/feat'])
  // its registered worktree is gone (removed): the unregistered one at the sha is adopted
  const t = await setup({ wtList: LIST(['/w/other', SHA, 'feat']) })
  const oldT = t.h.git.handler
  t.h.git.handler = (a: string[], c: any) => (a[1] === WT && a.includes('rev-parse') && !a.includes('--git-common-dir') ? { exitCode: 128, stdout: '', stderr: 'fatal: cannot change to the folder' } : oldT(a, c))
  const r2 = await t.push()
  expect(r2.ok).toBe(true)
  expect(t.pushes()[0]![1]).toBe('/w/other')
})

test('adopting under a key that another live worktree holds registers a suffixed key, never silently fails', async () => {
  const s = await setup({ registry: { 'app/feat': { path: '/w/other', branch: 'feat', thread: 't2' } }, wtList: LIST(['/w/feat', SHA, 'feat']) })
  s.h.files.set('/w/other/.git', 'gitdir: x') // the other worktree exists
  const r = await s.push()
  expect(r.ok).toBe(true)
  expect(registry(s)['app/feat'].path).toBe('/w/other')
  expect(registry(s)['app/feat~2']).toMatchObject({ path: '/w/feat', thread: 't1', adopted: true })
  // the recorded path is gone: the entry is replaced
  const t = await setup({ registry: { 'app/feat': { path: '/w/gone', branch: 'feat', thread: 't2' } }, wtList: LIST(['/w/feat', SHA, 'feat']) })
  expect((await t.push()).ok).toBe(true)
  expect(registry(t)['app/feat']).toMatchObject({ path: '/w/feat', thread: 't1' })
  expect(Object.keys(registry(t))).toEqual(['app/feat'])
})

test('a GitHub remote still uses gh, whatever the host is called', async () => {
  const s = await setup({ urls: { origin: 'https://github.com/o/r' } })
  await s.push({ pr: { title: 'T' } })
  expect(s.ghCalls[0]!.argv[0]).toBe('gh')
  const t = await setup({ urls: { origin: 'https://example.com/dev.azure.com/org1/proj1/_git/repo1' } })
  await t.push({ pr: { title: 'T' } })
  expect(t.ghCalls[0]!.argv[0]).toBe('gh')
})
