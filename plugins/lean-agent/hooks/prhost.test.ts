// The shared PR-comment fetch (prhost.ts): the host from the origin URL, one comment shape, what is dropped and counted, and the runner
// with canned gh / az / curl answers. All names, ids and URLs here are synthetic.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { AZURE_DEVOPS_RESOURCE, azureComments, fetchPrs, githubComments, isApproval, isTypo, keepLessons, lastFetchCounts, parseOrigin, renderFetched } from './prhost'
import { reviewTool } from './reviewtool'

test('the host comes from the origin URL: github, Azure DevOps in its four spellings, anything else is unsupported', () => {
  expect(parseOrigin('https://github.com/acme/widgets.git')).toEqual({ kind: 'github', owner: 'acme', repo: 'widgets' })
  expect(parseOrigin('git@github.com:acme/widgets.git\n')).toEqual({ kind: 'github', owner: 'acme', repo: 'widgets' })
  const az = { kind: 'azure', org: 'acme', project: 'Big Project', repo: 'widgets' }
  expect(parseOrigin('https://dev.azure.com/acme/Big%20Project/_git/widgets')).toEqual(az)
  expect(parseOrigin('https://acme@dev.azure.com/acme/Big%20Project/_git/widgets')).toEqual(az)
  expect(parseOrigin('git@ssh.dev.azure.com:v3/acme/Big%20Project/widgets')).toEqual(az)
  expect(parseOrigin('https://acme.visualstudio.com/DefaultCollection/Big%20Project/_git/widgets')).toEqual(az)
  expect(parseOrigin('https://acme.visualstudio.com/Big%20Project/_git/widgets')).toEqual(az)
  expect(parseOrigin('acme@vs-ssh.visualstudio.com:v3/acme/Big%20Project/widgets')).toEqual(az)
  expect(parseOrigin('https://gitlab.example.org/acme/widgets.git')).toEqual({ kind: 'other', host: 'gitlab.example.org' })
  expect(parseOrigin('https://github.com.evil.example/acme/widgets')).toEqual({ kind: 'other', host: 'github.com.evil.example' })
})

test('approvals and typo fixes are told by script', () => {
  for (const t of ['LGTM', 'looks good to me!', '+1', '👍', 'Approved.', 'Thanks, done', 'lgtm, ship it']) expect(isApproval(t)).toBe(true)
  for (const t of ['LGTM but please use the existing parse helper', 'looks good, however the retry loop never stops', 'why not reuse formatDate?']) expect(isApproval(t)).toBe(false)
  expect(isTypo('typo: recieve -> receive')).toBe(true)
  expect(isTypo('nit: spelling')).toBe(true)
  expect(isTypo('this duplicates the typo handling in the validator, which already retries; please call it instead of copying it into the new module so both stay in step when the rules change later on')).toBe(false) // long: a real remark
})

// an Azure DevOps threads answer, as the REST endpoint shapes it (trimmed)
const THREADS = {
  value: [
    { id: 1, status: 'active', properties: {}, threadContext: { filePath: '/src/api/client.ts', rightFileStart: { line: 42 } }, comments: [
      { id: 1, parentCommentId: 0, author: { displayName: 'Reviewer One', uniqueName: 'one@example.org' }, content: 'We already have fetchJson in src/api/http.ts; reuse it here.', commentType: 'text' },
      { id: 2, parentCommentId: 1, author: { displayName: 'Dev Owner', uniqueName: 'Owner@Example.org' }, content: 'Done, thanks for pointing it out', commentType: 'text' },
      { id: 3, parentCommentId: 1, author: { displayName: 'Reviewer Two', uniqueName: 'two@example.org' }, content: 'Also add a test for the empty case.', commentType: 'text' },
    ] },
    { id: 2, status: 'closed', properties: { CodeReviewThreadType: { $type: 'System.String', $value: 'VoteUpdate' } }, comments: [{ id: 1, author: { displayName: 'Reviewer One', uniqueName: 'one@example.org' }, content: 'Reviewer One voted 10', commentType: 'system' }] },
    { id: 3, status: 'active', properties: { CodeReviewThreadType: { $value: 'PolicyStatusUpdate' } }, comments: [{ id: 1, author: { displayName: 'Build', uniqueName: 'build@example.org' }, content: 'Policy Build: succeeded', commentType: 'text' }] },
    { id: 4, status: 'active', properties: { CodeReviewThreadType: { $value: 'RefUpdate' } }, comments: [{ id: 1, author: { uniqueName: 'dev@example.org' }, content: 'Pushed 2 commits', commentType: 'system' }] },
    { id: 5, status: 'fixed', isDeleted: true, comments: [{ id: 1, author: { uniqueName: 'two@example.org' }, content: 'a thread that was deleted', commentType: 'text' }] },
    { id: 6, status: 'wontFix', properties: {}, threadContext: { filePath: '/src/util.ts', leftFileStart: { line: 7 } }, comments: [
      { id: 1, author: { uniqueName: 'two@example.org' }, content: 'never log the whole request object', commentType: 'text' },
      { id: 2, parentCommentId: 1, author: { uniqueName: 'two@example.org' }, content: 'an edited-away remark', commentType: 'text', isDeleted: true },
    ] },
    { id: 7, status: 'active', properties: {}, comments: [{ id: 1, author: { uniqueName: 'one@example.org' }, content: 'LGTM', commentType: 'text' }, { id: 2, author: { uniqueName: 'one@example.org' }, content: 'typo: recieve', commentType: 'text' }] },
  ],
}

test('Azure threads: system threads (vote, policy, ref update), system and deleted comments are dropped and counted; thread status and file are noted; the owner is excluded case-insensitively', () => {
  const raw = azureComments(41, THREADS)
  const { kept, counts } = keepLessons(raw, 'owner@example.org')
  expect(counts).toEqual({ seen: 11, owner: 1, system: 3, deleted: 2, approvals: 1, typos: 1, kept: 3 })
  expect(kept.map(c => `${c.author}|${c.status}|${c.path}:${c.line}|${c.reply ? 'reply' : 'top'}|${c.body}`)).toEqual([
    'one@example.org|active|/src/api/client.ts:42|top|We already have fetchJson in src/api/http.ts; reuse it here.',
    'two@example.org|active|/src/api/client.ts:42|reply|Also add a test for the empty case.',
    'two@example.org|wontFix|/src/util.ts:7|top|never log the whole request object',
  ])
})

test('GitHub reviews, conversation and inline comments in one shape; an empty approving review is an approval; bots are kept', () => {
  const view = { reviews: [{ author: { login: 'rev1' }, body: '', state: 'APPROVED' }, { author: { login: 'rev2' }, body: 'Please reuse parseDate from lib/dates.ts.', state: 'CHANGES_REQUESTED' }, { author: { login: 'me' }, body: 'my own note', state: 'COMMENTED' }], comments: [{ author: { login: 'ci-helper[bot]' }, body: 'coverage dropped by 2%' }] }
  const inline = [{ user: { login: 'rev2', type: 'User' }, body: 'Use the shared logger', path: 'src/a.ts', line: 9 }, { user: { login: 'rev1' }, body: 'agreed', path: 'src/a.ts', original_line: 9, in_reply_to_id: 5 }]
  const { kept, counts } = keepLessons(githubComments(7, view, inline), 'me')
  expect(counts).toEqual({ seen: 6, owner: 1, system: 0, deleted: 0, approvals: 2, typos: 0, kept: 3 })
  expect(kept.map(c => [c.author, c.kind, c.bot ?? false, c.path ?? ''])).toEqual([['rev2', 'review', false, ''], ['ci-helper[bot]', 'conversation', true, ''], ['rev2', 'inline', false, 'src/a.ts']])
})

// ---- the runner, with canned gh / az / curl ----------------------------------------------------------------------------------
const TOKEN = 'tok-' + 'S3CR3T-value'
function azureRig(opts: { prsFor?: (argv: string[]) => any[]; curlFail?: boolean } = {}) {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ widgets: { path: '/r/widgets' } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://acme@dev.azure.com/acme/Big%20Project/_git/widgets\n' } : { exitCode: 1, stdout: '' })
  const seen: { argv: string[]; stdin?: string }[] = []
  h.exec.handler = (argv, c) => {
    seen.push({ argv, stdin: c.stdin })
    if (argv[0] === 'az' && argv[1] === 'account' && argv[2] === 'show') return { exitCode: 0, stdout: 'owner@example.org\n' }
    if (argv[0] === 'az' && argv[1] === 'account' && argv[2] === 'get-access-token') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] === 'az' && argv[1] === 'repos' && argv[3] === 'list') return { exitCode: 0, stdout: JSON.stringify((opts.prsFor ?? (() => []))(argv)) }
    if (argv[0] === 'curl') return opts.curlFail ? { exitCode: 22, stdout: '', stderr: `curl: (22) HTTP 401 for ${TOKEN}` } : { exitCode: 0, stdout: JSON.stringify(THREADS) }
    return { exitCode: 127, stdout: '', stderr: 'unknown ' + argv[0] }
  }
  return { h, seen }
}
const pr = (id: number, target = 'refs/heads/main') => ({ pullRequestId: id, title: `change ${id}`, targetRefName: target })

test('Azure: the owner is the signed-in az user; the last N completed PRs by target, then other targets; threads over REST with a bearer token that is never printed', async () => {
  const { h, seen } = azureRig({ prsFor: argv => (argv.includes('--target-branch') ? [pr(11), pr(12)] : [pr(11), pr(12), pr(20, 'refs/heads/release'), pr(21, 'refs/heads/release')]) })
  const r = await fetchPrs(h.host, 'widgets', { repo: '/r/widgets', last: 3, base: 'main' })
  expect(r.ok).toBe(true)
  const list = seen.filter(s => s.argv.slice(0, 4).join(' ') === 'az repos pr list')
  expect(list[0]!.argv).toEqual(['az', 'repos', 'pr', 'list', '--status', 'completed', '--top', '3', '--target-branch', 'main', '--output', 'json', '--organization', 'https://dev.azure.com/acme', '--project', 'Big Project', '--repository', 'widgets'])
  expect(list[1]!.argv).not.toContain('--target-branch') // fewer than asked: the other targets fill up
  expect(r.fetched!.prs.map(p => `${p.n}→${p.target}`)).toEqual(['11→main', '12→main', '20→release'])
  expect(r.fetched!.notes.join(' ')).toContain('only 2 completed PR(s) into main: 1 from other targets added')
  expect(r.fetched!.owner).toBe('owner@example.org')
  const tok = seen.find(s => s.argv[2] === 'get-access-token')!
  expect(tok.argv).toEqual(['az', 'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'])
  const curls = seen.filter(s => s.argv[0] === 'curl')
  expect(curls).toHaveLength(3)
  expect(curls[0]!.argv).toEqual(['curl', '-sS', '--fail-with-body', '-H', '@-', 'https://dev.azure.com/acme/Big%20Project/_apis/git/repositories/widgets/pullRequests/11/threads?api-version=7.1'])
  expect(curls[0]!.stdin).toContain(`Authorization: Bearer ${TOKEN}`) // the header goes on stdin
  for (const s of seen) expect(s.argv.join(' ')).not.toContain(TOKEN) // never in an argument list
  expect(r.text).not.toContain(TOKEN)
  // the digest: counts, thread status and file, nothing from system threads or the owner
  expect(r.text).toContain('LEAN-PR-COMMENTS {"host":"azure","owner":"owner@example.org","prs":[11,12,20],"counts":{"seen":33,')
  expect(r.text).toContain('excluded: the owner\'s own 3, system threads 9, deleted 6; dropped as approval 3, as typo fix 3')
  expect(r.text).toContain('[thread active · /src/api/client.ts:42] one@example.org: We already have fetchJson')
  expect(r.text).toContain('[thread wontFix · /src/util.ts:7] two@example.org: never log the whole request object')
  expect(r.text).not.toContain('voted 10')
  expect(r.text).not.toContain('Policy Build')
  expect(r.text).not.toContain('a thread that was deleted')
  // the counts are kept for learn's report
  expect((await lastFetchCounts(h.host, 'widgets'))!.counts.owner).toBe(3)
})

test('Azure: one PR by number; a failing REST call is a note with the token scrubbed; no az login is said as such', async () => {
  const one = azureRig()
  const base = one.h.exec.handler!
  one.h.exec.handler = (argv, c) => (argv[0] === 'az' && argv[1] === 'repos' && argv[3] === 'show' ?{ exitCode: 0, stdout: JSON.stringify(pr(55)) } : base(argv, c))
  const r = await fetchPrs(one.h.host, 'widgets', { repo: '/r/widgets', pr: 55 })
  expect(r.fetched!.prs.map(p => p.n)).toEqual([55])
  const bad = azureRig({ prsFor: () => [pr(1)], curlFail: true })
  const f = await fetchPrs(bad.h.host, 'widgets', { repo: '/r/widgets' })
  expect(f.ok).toBe(true)
  expect(f.text).toContain('#1: threads could not be read (curl: (22) HTTP 401 for ***)')
  expect(f.text).not.toContain(TOKEN)
  const none = azureRig()
  none.h.exec.handler = () => ({ exitCode: 1, stdout: '', stderr: 'Please run az login' })
  const n = await fetchPrs(none.h.host, 'widgets', { repo: '/r/widgets' })
  expect(n.ok).toBe(false)
  expect(n.text).toContain('az is not logged in or not installed')
})

test('GitHub: the owner is the gh login; the last N merged PRs into the base, then other bases; inline pages are joined', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ widgets: { path: '/r/widgets' } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'git@github.com:acme/widgets.git\n' } : { exitCode: 1, stdout: '' })
  const seen: string[][] = []
  h.exec.handler = argv => {
    seen.push(argv)
    const j = argv.join(' ')
    if (j === 'gh api user --jq .login') return { exitCode: 0, stdout: 'me\n' }
    if (j.startsWith('gh pr list') && j.includes('--base main')) return { exitCode: 0, stdout: JSON.stringify([{ number: 3, title: 't3', baseRefName: 'main', url: 'u3' }]) }
    if (j.startsWith('gh pr list')) return { exitCode: 0, stdout: JSON.stringify([{ number: 3, title: 't3', baseRefName: 'main', url: 'u3' }, { number: 4, title: 't4', baseRefName: 'dev', url: 'u4' }]) }
    if (j.startsWith('gh pr view 3 --json reviews')) return { exitCode: 0, stdout: JSON.stringify({ reviews: [{ author: { login: 'rev' }, body: 'Reuse formatDate from lib/dates.ts', state: 'COMMENTED' }], comments: [] }) }
    if (j.startsWith('gh pr view 4 --json reviews')) return { exitCode: 0, stdout: JSON.stringify({ reviews: [], comments: [{ author: { login: 'me' }, body: 'mine' }] }) }
    if (j.startsWith('gh api repos/acme/widgets/pulls/3/comments')) return { exitCode: 0, stdout: '[{"user":{"login":"rev"},"body":"first page","path":"a.ts","line":1}][{"user":{"login":"rev"},"body":"second page","path":"b.ts","line":2}]' }
    if (j.startsWith('gh api repos/acme/widgets/pulls/4/comments')) return { exitCode: 0, stdout: '[]' }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const r = await fetchPrs(h.host, 'widgets', { repo: '/r/widgets', last: 2, base: 'main' })
  expect(r.ok).toBe(true)
  expect(r.fetched!.prs.map(p => p.n)).toEqual([3, 4])
  expect(r.text).toContain('only 1 merged PR(s) into main: 1 from other targets added')
  expect(r.text).toContain('second page')
  expect(r.fetched!.counts).toMatchObject({ owner: 1, kept: 3 })
  expect(seen.some(a => a.includes('--state') && a.includes('merged'))).toBe(true)
})

test('an unsupported host, no origin, a relative repo and a bad base are refused with the reason; lean_review prs goes through the same fetch', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ widgets: { path: '/r/widgets' } }))
  h.git.handler = () => ({ exitCode: 0, stdout: 'https://gitlab.example.org/acme/widgets.git\n' })
  expect((await fetchPrs(h.host, 'widgets', { repo: '/r/widgets' })).text).toContain('gitlab.example.org is not supported')
  expect((await fetchPrs(h.host, 'widgets', { repo: 'widgets' })).text).toContain('absolute path')
  h.git.handler = () => ({ exitCode: 1, stdout: '', stderr: 'fatal: no such remote' })
  expect((await fetchPrs(h.host, 'widgets', { repo: '/r/widgets' })).text).toContain('no origin remote')
  const bad = azureRig()
  expect((await fetchPrs(bad.h.host, 'widgets', { repo: '/r/widgets', base: '--evil' })).text).toContain('plain branch name')
  const rig = azureRig({ prsFor: () => [pr(5)] })
  const t = await reviewTool(rig.h.host, 'widgets', { action: 'prs', last: 1 }) // the repo is the registered project's own
  expect(t.ok).toBe(true)
  expect(t.text).toContain('LEAN-PR-COMMENTS')
  expect(renderFetched({ host: { kind: 'other', host: 'x' }, owner: '', prs: [], comments: [], counts: { seen: 0, owner: 0, system: 0, deleted: 0, approvals: 0, typos: 0, kept: 0 }, notes: [] })).toContain('0 PR(s): none')
})
