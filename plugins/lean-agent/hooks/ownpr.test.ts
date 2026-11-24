// 1.0.28 the own-PR default (ownpr.ts): a thread that owns a PR replies on it and moves its own work item without a question; everything else is asked.
// Canned curl output, synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { relaxOwnTaskForSpecs } from './owntask'
relaxOwnTaskForSpecs() // these specs test the writes, not whose task it is (owntask.test.ts does)
import { addActionRequest, answerAction, approveAction, resetActions } from './deskactions'
import { revokeByWords, revokeWrites, writesView } from './deskwrites'
import { lintText, noteBrief, ownConfig, recordPassedPr, recordPushPr, runOwnPr } from './ownpr'
import { recordHumanPrompt } from './humanprompts'
import { leanThread, resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const PR = { host: 'azure', org: 'acme', project: 'Shop App', repo: 'shop-api', id: 4321, url: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4321', since: 500_000 }
const REPLY = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321, thread: 7, body: 'Fixed in the next commit. Build: https://dev.azure.com/acme/Shop%20App/_build/results?buildId=9981' }
const LINK = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321, workitem: 1234 }
const WI = (state: string, id = 1234) => ({ org: 'acme', project: 'Shop App', id, fields: { state } })

function setup(opts: { thread?: Record<string, unknown>; config?: unknown; remote?: string } = {}) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.clock.t = 1_000_000
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, pr: PR, workItems: [1234], ...opts.thread }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  const cfg = (opts.config ?? {}) as { actions?: Record<string, unknown> }
  h.files.set(`${L}/config.json`, JSON.stringify({ ...cfg, actions: { holdSeconds: 0, ...cfg.actions } })) // (no hold window: sendhold.test.ts has its own specs)
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: `${opts.remote ?? 'https://dev.azure.com/acme/Shop%20App/_git/shop-api'}\n` } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] === 'curl' && argv[argv.indexOf('-X') + 1] === 'GET') return { exitCode: 0, stdout: JSON.stringify({ id: argv[argv.length - 1]!.includes('/_apis/projects/') ? '11111111-2222-3333-4444-555555555555' : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) }
    if (argv[0] === 'curl') return { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) }
    if (argv[0] === 'gh') return { exitCode: 0, stdout: JSON.stringify({ id: 9, html_url: 'https://github.com/acme/shop-api/pull/42#issuecomment-9' }) }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const writes = () => h.calls.filter(c => (c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] !== 'GET') || (c.argv[0] === 'gh' && c.argv.includes('--method')))
  return { h, host: h.host, writes }
}
type S = ReturnType<typeof setup>
const history = (s: S) => s.h.files.get(`${L}/threads/t5/history.jsonl`) ?? ''
// a request, then whether the default sent it at once; a request that is not covered waits for the user: denied here so nothing stays open
const go = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5') => {
  const made = await addActionRequest(s.host, thread, kind === 'batch' ? { kind, items: params.items, why: 'the PR round' } : { kind, params, why: 'the PR round' })
  expect(made.ok, made.text).toBe(true)
  const r = await runOwnPr(s.host, made.request!.id)
  if (!r?.sent) await answerAction(s.host, made.request!.id, 'deny', 'pane')
  return r
}

test('a plain reply on the PR the thread owns is sent without a question: the exact text is a line in the pane with a Revoke button, and history says own-pr-default', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const r = await go(s, 'ado-pr-reply', REPLY)
  expect(r?.sent).toBe(true)
  expect(r?.line).toContain('sent under the own-PR default (t5 owns PR 4321)')
  expect(r?.line).toContain('Fixed in the next commit. Build: https://dev.azure.com/acme/Shop%20App/_build/results?buildId=9981')
  expect(s.writes()).toHaveLength(1)
  expect(s.writes()[0]!.argv.join(' ')).toContain('/pullRequests/4321/threads/7/comments')
  const v = await writesView(s.host)
  expect(v.sent.map(x => [x.thread, x.grant])).toEqual([['t5', 'own:t5']])
  expect(history(s)).toContain('"kind":"own-pr-default"')
  expect(history(s)).not.toContain(TOKEN)
  const gh = setup({ thread: { pr: { host: 'github', org: 'acme', project: '', repo: 'shop-api', id: 42, url: 'https://github.com/acme/shop-api/pull/42', since: 1 } } })
  expect((await go(gh, 'gh-pr-comment', { repo: 'acme/shop-api', pr: 42, body: 'Thanks, updated.' }))?.sent).toBe(true)
})

test('a reply WITH a status, a thread status change and a reply to another pull request are asked (and the same for another repo or the other forge)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  expect(await go(s, 'ado-pr-reply', { ...REPLY, status: 'fixed' })).toBeNull()
  expect(await go(s, 'ado-pr-thread-status', { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321, thread: 7, status: 'fixed' })).toBeNull()
  expect(await go(s, 'ado-pr-reply', { ...REPLY, pr: 5660 })).toBeNull() // another PR
  expect(await go(s, 'ado-pr-reply', { ...REPLY, repo: 'other-api' })).toBeNull()
  expect(await go(s, 'ado-pr-comment', { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 5660, body: 'a new top-level comment on another PR' })).toBeNull()
  expect(await go(s, 'gh-pr-comment', { repo: 'acme/shop-api', pr: 4321, body: 'x' })).toBeNull()
  expect(await go(s, 'ado-workitem-create', { org: 'acme', project: 'Shop App', type: 'Task', title: 'x' })).toBeNull()
  expect(await go(s, 'ado-workitem-comment', { org: 'acme', project: 'Shop App', id: 1234, body: 'x' })).toBeNull()
  expect(s.writes()).toHaveLength(0)
})

test('a thread that owns nothing, another thread, or a closed thread gets no default', { timeoutMs: 20_000 }, async () => {
  const none = setup({ thread: { pr: undefined } })
  expect(await go(none, 'ado-pr-reply', REPLY)).toBeNull()
  const closed = setup({ thread: { state: 'closed' } })
  expect(await go(closed, 'ado-pr-reply', REPLY)).toBeNull()
  const s = setup()
  s.h.files.set(`${L}/threads/t6/thread.json`, JSON.stringify({ id: 't6', title: 'y', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  expect(await go(s, 'ado-pr-reply', REPLY, 't6')).toBeNull() // t6 does not own PR 4321
  expect(s.writes()).toHaveLength(0)
})

test('the thread\'s own work item moves to Reviewing | Active | In Progress | Resolved; any other state, other field or other item is asked; a link of the owned PR to an owned item is covered', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  for (const st of ['Reviewing', 'active', 'In Progress', 'Resolved']) expect([st, (await go(s, 'ado-workitem-update', WI(st)))?.sent]).toEqual([st, true])
  expect(await go(s, 'ado-workitem-update', WI('Closed'))).toBeNull()
  expect(await go(s, 'ado-workitem-update', WI('Reviewing', 999))).toBeNull() // not its work item
  expect(await go(s, 'ado-workitem-update', { ...WI('Reviewing'), fields: { state: 'Reviewing', title: 'new title' } })).toBeNull()
  expect(await go(s, 'ado-workitem-update', { ...WI('Reviewing'), fields: { assignedTo: 'dev@example.test' } })).toBeNull()
  expect((await go(s, 'ado-pr-workitem-link', LINK))?.sent).toBe(true)
  expect(await go(s, 'ado-pr-workitem-link', { ...LINK, workitem: 999 })).toBeNull()
  expect(await go(s, 'ado-pr-workitem-link', { ...LINK, pr: 5660 })).toBeNull()
  // a PR round: reply + link of one PR are ONE request (a batch is covered only when EVERY item is), the state move another: no prompt for either
  const round = [
    { kind: 'ado-pr-reply', params: { ...REPLY, body: 'Build 9982 is green.' } },
    { kind: 'ado-pr-workitem-link', params: { ...LINK, workitem: 1234 } },
  ]
  const before = s.writes().length
  expect((await go(s, 'batch', { items: round }))?.sent).toBe(true)
  expect(s.writes().length - before).toBe(2) // reply and link (the link reads the project and repository ids first: two GETs, not counted)
  expect(await go(s, 'batch', { items: [...round, { kind: 'ado-pr-thread-status', params: { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321, thread: 7, status: 'fixed' } }] })).toBeNull() // one status in it: the whole batch is asked
})

test('the new top-level PR comment is covered for the owned PR (same lint, same cap), not for another PR', { timeoutMs: 20_000 }, async () => {
  const s = setup({ config: { actions: { ownPrMaxPerDay: 2 } } })
  const c = (body: string, pr = 4321) => ({ org: 'acme', project: 'Shop App', repo: 'shop-api', pr, body })
  expect((await go(s, 'ado-pr-comment', c('Build 9981 is green.')))?.sent).toBe(true)
  expect(await go(s, 'ado-pr-comment', c('See /home/dev/work/a.ts'))).toMatchObject({ sent: false }) // the text lint
  expect(await go(s, 'ado-pr-comment', c('Build 9982 is green too.', 5660))).toBeNull()
  expect((await go(s, 'ado-pr-comment', c('One more.')))?.sent).toBe(true)
  expect(await go(s, 'ado-pr-comment', c('Over the cap.'))).toMatchObject({ sent: false }) // the cap of 2
})

test('a work item is owned only by creation, by the brief\'s AB#N / "work item N" together with a branch token N, or by the user\'s grant: digits in a branch alone are nothing', { timeoutMs: 20_000 }, async () => {
  const s = setup({ thread: { workItems: undefined } })
  expect(await go(s, 'ado-workitem-update', WI('Active'))).toBeNull() // owns none
  s.h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { thread: 't5', branch: 'feature/1234-digest-flake', path: '/w/a' } }))
  expect(await go(s, 'ado-workitem-update', WI('Reviewing'))).toBeNull() // a number in the branch name alone is no signal
  // the brief says AB#1234 and the branch has the token 1234: owned
  const b = setup({ thread: { workItems: undefined } })
  expect(await noteBrief(b.host, 't5', 'Fix the flaky digest test, AB#1234.')).toBeNull()
  expect(await go(b, 'ado-workitem-update', WI('Reviewing'))).toBeNull() // the brief alone: no branch
  b.h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { thread: 't5', branch: 'feature/1234-digest-flake', path: '/w/a' } }))
  expect((await go(b, 'ado-workitem-update', WI('Resolved')))?.sent).toBe(true)
  for (const brief of ['Work item 1234 tracks it.', 'see https://dev.azure.com/acme/Shop%20App/_workitems/edit/1234']) {
    const w = setup({ thread: { workItems: undefined } })
    await noteBrief(w.host, 't5', brief)
    w.h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { thread: 't5', branch: 'fix/wi-1234', path: '/w/a' } }))
    expect([brief, (await go(w, 'ado-workitem-update', WI('Active')))?.sent]).toEqual([brief, true])
  }
  // a branch token that is only part of a longer number is not the token
  const part = setup({ thread: { workItems: undefined } })
  await noteBrief(part.host, 't5', 'AB#1234')
  part.h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { thread: 't5', branch: 'fix/12345-other', path: '/w/a' } }))
  expect(await go(part, 'ado-workitem-update', WI('Active'))).toBeNull()
  expect(await go(s, 'ado-workitem-update', WI('Reviewing', 55))).toBeNull()
  // a create the user approved makes the new item the thread's own
  const made = await addActionRequest(s.host, 't5', { kind: 'ado-workitem-create', params: { org: 'acme', project: 'Shop App', type: 'Task', title: 'Rerun' }, why: 'x' })
  await answerAction(s.host, made.request!.id, 'approve', 'pane')
  expect((await approveAction(s.host, made.request!.id)).ok).toBe(true)
  const t = JSON.parse(s.h.files.get(`${L}/threads/t5/thread.json`)!)
  expect(t.workItems).toEqual([77])
  expect((await go(s, 'ado-workitem-update', WI('Resolved', 77)))?.sent).toBe(true)
})

test('at most 20 writes per owned PR per day (config actions.ownPrMaxPerDay), counted per write of a batch; the next day starts again', { timeoutMs: 20_000 }, async () => {
  const s = setup({ config: { actions: { ownPrMaxPerDay: 3 } } })
  expect((await ownConfig(s.host)).max).toBe(3)
  for (let i = 0; i < 3; i++) expect((await go(s, 'ado-pr-reply', { ...REPLY, body: `reply ${i}` }))?.sent).toBe(true)
  const r = await go(s, 'ado-pr-reply', { ...REPLY, body: 'reply 4' })
  expect(r).toMatchObject({ sent: false })
  expect(r?.line).toContain('the limit is 3')
  expect(s.writes()).toHaveLength(3)
  s.h.clock.t += 24 * 3_600_000
  expect((await go(s, 'ado-pr-reply', { ...REPLY, body: 'reply 5' }))?.sent).toBe(true)
  const d = setup()
  expect((await ownConfig(d.host)).max).toBe(20)
})

test('the reply text is linted by script: an absolute path, an email address, a token-like string and over 2000 characters go to the user instead', { timeoutMs: 20_000 }, async () => {
  expect(lintText(REPLY.body)).toBeNull() // a build link is fine
  expect(lintText('see https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4321?_a=files for the diff')).toBeNull()
  expect(lintText('look at /home/dev/work/app/src/a.ts')).toContain('absolute path')
  expect(lintText('it is in C:\\Users\\dev\\app')).toContain('absolute path')
  expect(lintText('see ~/work/app')).toContain('absolute path')
  expect(lintText('ask dev@example.test')).toContain('email')
  expect(lintText('token ghp_abcdefghij0123456789')).toContain('token')
  expect(lintText('key 4f9d2c7a1b8e4f3a9c6d5e2b1a0f7c8d')).toContain('token')
  expect(lintText('Bearer abcdefghijklmnop123')).toContain('token')
  expect(lintText('see https://ci.example.test/run?token=abcdef123456')).toContain('token')
  expect(lintText('x'.repeat(2001))).toContain('2001 characters')
  expect(lintText('x '.repeat(1000))).toBeNull()
  const s = setup()
  const r = await go(s, 'ado-pr-reply', { ...REPLY, body: 'The file is /home/dev/work/app/a.ts' })
  expect(r).toMatchObject({ sent: false })
  expect(r?.line).toContain('absolute path')
  expect(s.writes()).toHaveLength(0)
  expect(history(s)).toContain('own-pr-asked')
})

test('Revoke (the pane\'s button, "stop writes", "stop writes t5") takes the default back; owning a PR again is a new default; config ownPrDefault false is the old behaviour', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  expect((await go(s, 'ado-pr-reply', { ...REPLY, body: 'one' }))?.sent).toBe(true)
  expect((await writesView(s.host)).sent[0]!.grant).toBe('own:t5')
  const out = await revokeWrites(s.host, { id: 'own:t5' })
  expect(out.ok, out.text).toBe(true)
  expect((await writesView(s.host)).sent[0]!.grant).toBeUndefined() // no Revoke button any more
  expect(await go(s, 'ado-pr-reply', { ...REPLY, body: 'two' })).toBeNull()
  // owning the next PR is a new default
  s.h.clock.t += 10
  expect(await recordPushPr(s.host, 't5', 'https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4272')).toContain('t5 owns PR 4272')
  s.h.clock.t += 10
  expect((await go(s, 'ado-pr-reply', { ...REPLY, pr: 4272, body: 'three' }))?.sent).toBe(true)
  // the user's words
  await recordHumanPrompt(s.host, { text: 'stop writes', origin: { kind: 'composer' } })
  expect(await revokeByWords(s.host, 'stop writes')).toBeGreaterThan(0)
  expect(await go(s, 'ado-pr-reply', { ...REPLY, pr: 4272, body: 'four' })).toBeNull()
  const named = setup()
  expect(await revokeByWords(named.host, 'stop writes t6')).toBe(0) // another thread
  expect(await revokeByWords(named.host, 'revoke t5')).toBe(1)
  expect(await go(named, 'ado-pr-reply', REPLY)).toBeNull()
  const byPr = setup()
  expect(await revokeByWords(byPr.host, 'stop writes on PR 4321')).toBe(1)
  expect(await go(byPr, 'ado-pr-reply', REPLY)).toBeNull()
  // off
  const off = setup({ config: { actions: { ownPrDefault: false } } })
  expect(await go(off, 'ado-pr-reply', REPLY)).toBeNull()
  expect(off.writes()).toHaveLength(0)
})

test('a PR is owned only by an explicit signal: the push that opened it, the pr param (number or URL, checked against the remote), a review thread\'s pr; a brief that mentions one owns nothing', { timeoutMs: 20_000 }, async () => {
  const s = setup({ thread: { pr: undefined, workItems: undefined } })
  const line = await recordPushPr(s.host, 't5', PR.url)
  expect(line).toBe("t5 owns PR 4321 (it opened the PR): its replies and moving its own work item to Reviewing go out without a question (revoke: Revoke button or 'stop writes'); resolving, votes and merges still ask")
  expect(JSON.parse(s.h.files.get(`${L}/threads/t5/thread.json`)!).pr).toMatchObject({ host: 'azure', org: 'acme', project: 'Shop App', repo: 'shop-api', id: 4321, url: PR.url })
  expect(await recordPushPr(s.host, 't5', PR.url)).toBeNull() // the same PR again: nothing new to tell
  expect((await go(s, 'ado-pr-reply', REPLY))?.sent).toBe(true)
  // a brief that mentions PRs owns nothing; the note is for exactly one
  const m = setup({ thread: { pr: undefined, workItems: undefined } })
  expect(await noteBrief(m.host, 't5', 'Review PR 4321 and answer the comments.')).toBe('brief mentions PR 4321: it is not owned; pass pr to let t5 reply without a question')
  expect(await noteBrief(m.host, 't5', `fix the comments on ${PR.url}`)).toContain('brief mentions PR 4321: it is not owned')
  expect(await noteBrief(m.host, 't5', 'compare PR 12 with PR 4321')).toBeNull()
  expect(await noteBrief(m.host, 't5', 'tidy the notes')).toBeNull()
  expect(JSON.parse(m.h.files.get(`${L}/threads/t5/thread.json`)!).pr).toBeUndefined()
  expect(await go(m, 'ado-pr-reply', REPLY)).toBeNull() // still asked
  // the pr param: a number is read against the project's remote, a URL is checked against it
  const p = setup({ thread: { pr: undefined, workItems: undefined } })
  expect((await recordPassedPr(p.host, 't5', 4321, 'you passed pr')).line).toContain('t5 owns PR 4321 (you passed pr)')
  expect((await go(p, 'ado-pr-reply', REPLY))?.sent).toBe(true)
  const u = setup({ thread: { pr: undefined, workItems: undefined } })
  expect((await recordPassedPr(u.host, 't5', PR.url, 'you started a review for it')).line).toContain('t5 owns PR 4321 (you started a review for it)')
  const other = setup({ thread: { pr: undefined, workItems: undefined } })
  const bad = await recordPassedPr(other.host, 't5', 'https://dev.azure.com/evil/Shop%20App/_git/shop-api/pullrequest/4321', 'you passed pr')
  expect(bad.line).toBeUndefined()
  expect(bad.note).toContain('this URL points at evil/Shop App')
  expect(JSON.parse(other.h.files.get(`${L}/threads/t5/thread.json`)!).pr).toBeUndefined()
  const off = setup({ thread: { pr: undefined, workItems: undefined }, config: { actions: { ownPrDefault: false } } })
  expect((await recordPassedPr(off.host, 't5', 4321, 'you passed pr')).line).toBeUndefined() // no line when the default is off
  const gh = setup({ thread: { pr: undefined, workItems: undefined }, remote: 'https://github.com/acme/shop-api.git' })
  expect((await recordPassedPr(gh.host, 't5', 42, 'you passed pr')).line).toContain('t5 owns PR 42')
  expect(JSON.parse(gh.h.files.get(`${L}/threads/t5/thread.json`)!).pr).toMatchObject({ host: 'github', org: 'acme', repo: 'shop-api', id: 42, how: 'you passed pr' })
})

test('through lean_thread: new with pr owns it and says how; a brief that mentions a PR says it is not owned; allow-writes owns the PR and the work item it names', { timeoutMs: 20_000 }, async () => {
  const SID = '11111111-2222-3333-4444-555555555555'
  const h = fakeHost(null)
  resetLocks()
  h.files.set('/p/templates/thread.md', '# {{id}} {{title}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 0, stdout: `started ${SID}\n` } : { exitCode: 0, stdout: a[0] === 'agents' ? '[]' : '' })
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  const said = await leanThread(h.host, '/p', { action: 'new', title: 'mention', text: 'look at PR 4321 for me', project: 'app' })
  expect(said.ok, said.text).toBe(true)
  expect(said.text).toContain('brief mentions PR 4321: it is not owned; pass pr to let t1 reply without a question')
  expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).pr).toEqual({ number: 4321 }) // 1.0.31: a reference of the task (workitems.ts), no ownership (no id / since)
  const passed = await leanThread(h.host, '/p', { action: 'new', title: 'for it', text: 'answer the comments', project: 'app', pr: 4321 } as any)
  expect(passed.ok, passed.text).toBe(true)
  expect(passed.text).toContain('t2 owns PR 4321 (you passed pr)')
  expect(JSON.parse(h.files.get(`${L}/threads/t2/thread.json`)!).pr).toMatchObject({ id: 4321, how: 'you passed pr' })
  const obj = await leanThread(h.host, '/p', { action: 'new', title: 'x', project: 'app', pr: { title: 'x' } } as any)
  expect(obj.ok).toBe(false)
  // the user's words name a PR and a work item: allow-writes owns them
  const say = (text: string) => recordHumanPrompt(h.host, { text, wait: false, origin: { kind: 'composer' } })
  await say('fix the comments on PR 4272')
  const g = await leanThread(h.host, '/p', { action: 'allow-writes', tN: 't1', target: { pr: 4272 } })
  expect(g.ok, g.text).toBe(true)
  expect(g.text).toContain('t1 owns PR 4272 (you allowed writes on it)')
  await say('please update work item 4321')
  const w = await leanThread(h.host, '/p', { action: 'allow-writes', tN: 't1', target: { workitem: 4321 } })
  expect(w.ok, w.text).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/threads/t1/thread.json`)!).workItems).toEqual([4321])
})
