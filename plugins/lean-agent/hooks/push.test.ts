import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { writeReview, writeApproval, APPROVAL_TTL_MS } from './reviews'
import { leanThread } from './threads'
import { compareUrl, firstError } from './push'

const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const WT = '/h/.lean-agent/worktrees/app/feat'
const PUSH_OUT = "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/feat\nTo github.com:o/r.git\n"

type Opts = { head?: string; branch?: string; defaultBranch?: string; remoteCfg?: string; pushResult?: { exitCode: number; stderr: string }; review?: boolean; approve?: boolean; ghFailure?: string; gh?: boolean; ghUrl?: string }

// a registered app project, thread t1 with its worktree, a green review and an approval for SHA: every gate open
async function setup(o: Opts = {}) {
  const h = fakeHost(null)
  const branch = o.branch ?? 'feat'
  const log: string[][] = []
  h.git.handler = a => {
    const s = a.join(' ')
    log.push(a)
    if (s.includes('rev-parse')) return { exitCode: 0, stdout: (o.head ?? SHA) + '\n' }
    if (s.includes('refs/remotes/origin/HEAD')) return o.defaultBranch === '' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `origin/${o.defaultBranch ?? 'main'}\n` }
    if (s.includes('symbolic-ref')) return branch ? { exitCode: 0, stdout: branch + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('config branch.')) return o.remoteCfg && s.endsWith('.remote') ? { exitCode: 0, stdout: o.remoteCfg + '\n' } : { exitCode: 1, stdout: '' }
    if (s.includes('remote get-url')) return { exitCode: 0, stdout: 'git@example.com:o/r.git\n' }
    if (a.includes('push')) return { exitCode: 0, stderr: PUSH_OUT, stdout: '', ...(o.pushResult ?? {}) }
    return { exitCode: 1, stdout: '' }
  }
  const ghCalls: { argv: string[]; cwd?: string; body: string }[] = []
  h.exec.handler = (argv, c) => {
    if (argv[1] === '--version') return { exitCode: o.gh === false ? 127 : 0, stdout: 'gh version 2\n' }
    const bodyArg = argv.find(x => x.startsWith('--body-file='))
    ghCalls.push({ argv, cwd: c.cwd, body: bodyArg ? String(h.files.get(bodyArg.slice(12)) ?? '<missing>') : '' })
    return o.ghFailure ? { exitCode: 1, stdout: '', stderr: o.ghFailure } : { exitCode: 0, stdout: (o.ghUrl ?? 'https://github.com/o/r/pull/7') + '\n' }
  }
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'app/feat': { path: WT, repo: '/r/app', branch, thread: 't1' } }))
  if (o.review !== false) await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  if (o.approve !== false) await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  const pushes = () => log.filter(a => a.includes('push'))
  const push = (extra: Record<string, unknown> = {}) => leanThread(h.host, '/p', { action: 'push', tN: 't1', sha: SHA, ...extra } as any)
  const history = () => String(h.files.get('/h/.lean-agent/threads/t1/history.jsonl') ?? '')
  const inbox = () => String(h.files.get('/h/.lean-agent/threads/t1/inbox.jsonl') ?? '')
  return { h, push, pushes, ghCalls, history, inbox }
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
    ['a worktree outside the project', {}, {}, 'does not belong to project app', s => void s.h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ x: { path: '/elsewhere/feat', branch: 'feat', thread: 't1' } }))],
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
  s.h.git.handler = ((old: any) => (a: string[], c: any) => (a.join(' ').includes('rev-parse') ? { exitCode: 0, stdout: SHA + '\n' } : old(a, c)))(s.h.git.handler)
  expect((await s.push()).ok).toBe(true)
})

test('push then PR: the desk pushes the exact branch, opens the PR with gh from the worktree, records it and tells the thread', async () => {
  const s = await setup()
  const r = await s.push({ pr: { title: 'Fix the thing', body: 'What changed.\n\nTested: yes.' } })
  expect(r.ok).toBe(true)
  expect(r.text).toBe(`pushed ${SHA} to origin/feat; PR https://github.com/o/r/pull/7`)
  expect(s.pushes()).toEqual([['-C', WT, 'push', '-u', 'origin', 'refs/heads/feat:refs/heads/feat']])
  expect(JSON.stringify(s.pushes())).not.toMatch(/--force|--tags|--delete|\+refs/)
  expect(s.ghCalls).toHaveLength(1)
  expect(s.ghCalls[0]!.argv.slice(0, 8)).toEqual(['gh', 'pr', 'create', '--head', 'feat', '--base', 'main', '--title=Fix the thing'])
  expect(s.ghCalls[0]!.argv).not.toContain('--draft')
  expect(s.ghCalls[0]!.cwd).toBe(WT)
  expect(s.ghCalls[0]!.body).toBe('What changed.\n\nTested: yes.') // the body file existed during the call ...
  expect([...s.h.files.keys()].filter(k => k.includes('/push/'))).toEqual([]) // ... and is gone
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
  expect(a.pushes()[0]).toEqual(['-C', WT, 'push', '-u', 'fork', 'refs/heads/feat:refs/heads/feat'])
  expect(a.ghCalls).toEqual([]) // no pr, no gh
  expect(JSON.parse(a.inbox().trim()).text).toBe(`the desk pushed ${SHA} to fork/feat; no PR, compare URL https://github.com/o/r/pull/new/feat`)
  const b = await setup({ defaultBranch: '' })
  await b.push({ pr: { title: 'T', base: 'develop', draft: true } })
  expect(b.ghCalls[0]!.argv).toEqual(['gh', 'pr', 'create', '--head', 'feat', '--base', 'develop', '--title=T', expect.stringMatching(/^--body-file=/), '--draft'])
  const c = await setup({ defaultBranch: '' }) // the remote's default is unknown: gh picks it
  await c.push({ pr: { title: 'T' } })
  expect(c.ghCalls[0]!.argv).not.toContain('--base')
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

test('compare URLs and first error lines are read from the output', () => {
  expect(compareUrl(PUSH_OUT)).toBe('https://github.com/o/r/pull/new/feat')
  expect(compareUrl('remote: Create a pull request for feat by visiting:\nremote:   https://gitlab.com/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat\n')).toContain('merge_requests/new')
  expect(compareUrl('remote: https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=feat')).toContain('pullrequestcreate')
  expect(compareUrl('Everything up-to-date')).toBeNull()
  expect(firstError({ stderr: 'hint: x\nfatal: could not read Username\nmore' })).toBe('fatal: could not read Username')
  expect(firstError({ stderr: '', stdout: '' })).toBe('no output')
})
