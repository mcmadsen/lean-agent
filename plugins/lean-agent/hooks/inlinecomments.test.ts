// Inline review comments (deskactions.ts + anchor.ts): the Azure DevOps and GitHub renderings, the executors with canned JSON (token on stdin only), the anchor check at
// request time and at send time (allow / refuse / cannot verify), the 60-comment review batch with one bad anchor, the question and card, the text lint, the guide line.
// Synthetic names only; nothing leaves the process.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ANCHOR_NOTE, BATCH_MAX, COMMENT_BATCH_MAX, addActionRequest, approveAction, answerAction, bindAnswers, checkAction, listActions, questionOf, resetActions } from './deskactions'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const L = '/h/.lean-agent'
const PR = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }
const AZ = 'https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api'
const ado = (extra: Record<string, unknown> = {}) => ({ kind: 'ado-pr-comment', params: { ...PR, body: 'The value is not escaped before it is rendered.', file: 'src/a.ts', line: 45, ...extra } })
const gh = (extra: Record<string, unknown> = {}) => ({ kind: 'gh-pr-review-comment', params: { repo: 'acme/shop', pr: 7, body: 'This leaks the handle on the error path.', file: 'src/a.ts', line: 45, ...extra } })
const edit = (a: number, n: number, kind = 'edit') => ({ changeType: kind, modifiedLineNumberStart: a, modifiedLinesCount: n, originalLineNumberStart: a, originalLinesCount: n })

// what the "forge" answers; a spec changes it between the request and the approval (a push to the PR)
type World = { diffs: Record<string, unknown[] | null>; changes: unknown[]; ghFiles: unknown; ghPr: unknown; posts: { url: string; body: any; stdin: string }[]; ghPosts: { argv: string[]; stdin: string }[]; failPost: (n: number) => boolean }
function setup() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const w: World = {
    diffs: { '/src/a.ts': [edit(40, 13), edit(98, 13, 'add')], '/src/b.ts': [edit(1, 100)] },
    changes: [{ changeType: 'edit', item: { path: '/src/a.ts' } }, { changeType: 'edit', item: { path: '/src/b.ts' } }, { changeType: 'delete', item: { path: '/src/gone.ts' } }],
    ghFiles: [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -39,2 +40,14 @@\n x\n' + '+a\n'.repeat(12) + ' y', changes: 12 }],
    ghPr: { head: { sha: SHA } },
    posts: [],
    ghPosts: [],
    failPost: () => false,
  }
  const data = (stdin: string) => JSON.parse(/data-binary = "(.*)"/.exec(stdin)![1]!.replace(/\\(["\\nrt])/g, (_m, c: string) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' })[c]!))
  h.exec.handler = (argv, c) => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] === 'gh') {
      if (argv.includes('POST')) {
        w.ghPosts.push({ argv, stdin: c.stdin ?? '' })
        return { exitCode: 0, stdout: JSON.stringify({ id: 900 + w.ghPosts.length, html_url: `https://github.com/acme/shop/pull/7#discussion_r${w.ghPosts.length}` }) }
      }
      const path = argv.find(a => a.startsWith('repos/'))!
      const v = path.endsWith('/files?per_page=100') ? w.ghFiles : path === 'repos/acme/shop/pulls/7' ? w.ghPr : null
      return v == null ? { exitCode: 1, stdout: '', stderr: 'HTTP 404' } : { exitCode: 0, stdout: JSON.stringify(v) }
    }
    if (argv[0] === 'curl') {
      const url = argv[argv.length - 1]!
      const method = argv[argv.indexOf('-X') + 1]
      if (url === `${AZ}/pullRequests/42/iterations?api-version=7.1`) return { exitCode: 0, stdout: JSON.stringify({ value: [{ id: 3, sourceRefCommit: { commitId: 'sCommit' }, commonRefCommit: { commitId: 'cCommit' } }] }) }
      if (url.includes('/iterations/3/changes')) return { exitCode: 0, stdout: JSON.stringify({ changeEntries: w.changes }) }
      if (url.startsWith(`${AZ}/filediffs`)) {
        const d = w.diffs[data(c.stdin ?? '').fileDiffParams[0].path]
        return d ? { exitCode: 0, stdout: JSON.stringify({ value: [{ lineDiffBlocks: d }] }) } : { exitCode: 22, stdout: '', stderr: 'HTTP 500' }
      }
      if (method === 'POST' && url === `${AZ}/pullRequests/42/threads?api-version=7.1`) {
        const body = data(c.stdin ?? '')
        w.posts.push({ url, body, stdin: c.stdin ?? '' })
        return w.failPost(w.posts.length) ? { exitCode: 22, stdout: '', stderr: 'HTTP 403 forbidden' } : { exitCode: 0, stdout: JSON.stringify({ id: 700 + w.posts.length, url: `${AZ}/pullRequests/42/threads/${700 + w.posts.length}` }) }
      }
    }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const told: { thread: string; text: string }[] = []
  const tell = async (thread: string, text: string) => {
    told.push({ thread, text })
  }
  return { h, w, told, tell }
}
type S = ReturnType<typeof setup>
const ask = (s: S, action: Record<string, unknown>) => addActionRequest(s.h.host, 't5', { ...action, why: 'the review' })
const approve = async (s: S, action: Record<string, unknown>) => {
  const r = await ask(s, action)
  expect(r.ok, r.text).toBe(true)
  const q = questionOf(r.request!)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  const notes = await bindAnswers(s.h.host, [qq], { [qq.question]: 'Approve' }, s.tell)
  expect(notes.join(' ')).toContain('approved')
  return r.request!
}
const argvText = (s: S) => JSON.stringify(s.h.calls.map(c => c.argv))

// ---- renderings -------------------------------------------------------------------------------------------------------------------------------
test('ado-pr-comment with file + line: a NEW thread with threadContext on the right side; left side, endLine and the shown text', () => {
  const c = checkAction(ado())
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(c.plan.url).toBe(`${AZ}/pullRequests/42/threads?api-version=7.1`)
  expect(JSON.parse(c.plan.body)).toEqual({ comments: [{ parentCommentId: 0, content: 'The value is not escaped before it is rendered.', commentType: 1 }], status: 1, threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 45, offset: 1 }, rightFileEnd: { line: 45, offset: 1 } } })
  expect(c.plan.text).toBe('comment on src/a.ts:45 of PR 42: The value is not escaped before it is rendered.')
  expect(c.plan.headline).toContain('comment on src/a.ts:45 of PR 42')
  expect(c.params).toEqual({ ...PR, body: 'The value is not escaped before it is rendered.', file: 'src/a.ts', line: 45 })
  const r = checkAction(ado({ endLine: 48 }))
  expect(r.ok && JSON.parse(r.plan.body).threadContext).toEqual({ filePath: '/src/a.ts', rightFileStart: { line: 45, offset: 1 }, rightFileEnd: { line: 48, offset: 1 } })
  expect(r.ok && r.plan.text).toContain('src/a.ts:45-48')
  const l = checkAction(ado({ side: 'left' }))
  expect(l.ok && JSON.parse(l.plan.body).threadContext).toEqual({ filePath: '/src/a.ts', leftFileStart: { line: 45, offset: 1 }, leftFileEnd: { line: 45, offset: 1 } })
  expect(l.ok && l.plan.text).toContain('src/a.ts:45 (removed line)')
  // a comment without file stays the general comment it was
  const g = checkAction({ kind: 'ado-pr-comment', params: { ...PR, body: 'One more thing: rebase first.' } })
  expect(g.ok && JSON.parse(g.plan.body)).toEqual({ comments: [{ parentCommentId: 0, content: 'One more thing: rebase first.', commentType: 1 }], status: 1 })
})

test('inline params are checked: file is repo-relative, line a positive number, endLine not below line, side right or left; line needs file and the reverse', () => {
  for (const extra of [{ file: '/src/a.ts' }, { file: '../etc/x' }, { file: 'src/../a.ts' }, { file: 'src\\a.ts' }, { file: 'src//a.ts' }, { file: '' }, { line: 0 }, { line: -3 }, { line: 'x' }, { line: 1.5 }, { endLine: 40 }, { side: 'middle' }, { side: 3 }, { file: undefined }, { line: undefined }])
    expect([extra, checkAction(ado(extra)).ok]).toEqual([extra, false])
  expect(checkAction(ado({ side: 'RIGHT' })).ok).toBe(true)
  expect(checkAction(ado({ line: '45' })).ok).toBe(true)
  expect(checkAction({ kind: 'ado-pr-comment', params: { ...PR, body: 'x is wrong', endLine: 3 } }).ok).toBe(false) // endLine alone
  expect(checkAction({ kind: 'ado-pr-reply', params: { ...PR, thread: 7, body: 'ok', file: 'a.ts', line: 3 } }).ok).toBe(false) // a reply takes no place
  expect(checkAction({ kind: 'gh-pr-comment', params: { repo: 'acme/shop', pr: 7, body: 'x is wrong', file: 'a.ts', line: 3 } }).ok).toBe(false)
})

test('gh-pr-review-comment: pulls/<n>/comments with path, line, side and the head commit placeholder; the shown text names the anchor', () => {
  const c = checkAction(gh())
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(c.plan.url).toBe('https://api.github.com/repos/acme/shop/pulls/7/comments')
  expect(JSON.parse(c.plan.body)).toEqual({ body: 'This leaks the handle on the error path.', commit_id: '<PR head commit>', path: 'src/a.ts', line: 45, side: 'RIGHT' })
  expect(c.plan.text).toBe('comment on src/a.ts:45 of PR 7: This leaks the handle on the error path.')
  const m = checkAction(gh({ endLine: 48, side: 'left' }))
  expect(m.ok && JSON.parse(m.plan.body)).toMatchObject({ start_line: 45, line: 48, side: 'LEFT', start_side: 'LEFT' })
  for (const extra of [{ file: undefined }, { line: undefined }, { file: '/abs' }, { repo: 'nope' }, { pr: 0 }]) expect([extra, checkAction(gh(extra)).ok]).toEqual([extra, false])
})

test('the text lint: a pure disclaimer or LGTM is refused with the reason in every comment kind; replies are not linted', () => {
  for (const body of ['LGTM', 'Partial coverage.', 'No tests were run.', 'I could not verify this.', 'Not reviewed.']) {
    for (const a of [ado({ body }), gh({ body }), { kind: 'ado-pr-comment', params: { ...PR, body } }, { kind: 'gh-pr-comment', params: { repo: 'acme/shop', pr: 7, body } }]) {
      const c = checkAction(a)
      expect([body, a.kind, c.ok]).toEqual([body, a.kind, false])
      expect(!c.ok && c.text).toMatch(/only an approval phrase|only a disclaimer/)
    }
  }
  expect(checkAction({ kind: 'ado-pr-reply', params: { ...PR, thread: 7, body: 'LGTM' } }).ok).toBe(true)
  expect(checkAction(ado({ body: 'Off-by-one: the loop skips the last item. Partial coverage otherwise.' })).ok).toBe(true)
})

// ---- Azure DevOps: the check, the question, the executor ----------------------------------------------------------------------------------------
test('ado inline: a line the PR changes is shown with "anchors checked"; the exact refusal, a file not in the PR, and an unreadable diff are never shown to the user', async () => {
  const s = setup()
  const ok = await ask(s, ado())
  expect(ok.ok, ok.text).toBe(true)
  expect(ok.request!.text).toBe(`comment on src/a.ts:45 of PR 42: The value is not escaped before it is rendered.\n(${ANCHOR_NOTE})`)
  expect(ok.request!.anchors).toBe(1)
  expect(questionOf(ok.request!).question).toContain(`comment on src/a.ts:45 of PR 42`)
  expect(questionOf(ok.request!).question).toContain('anchors checked against the PR diff')
  const bad = await ask(s, ado({ line: 120, body: 'This line is also wrong.' }))
  expect(bad).toEqual({ ok: false, text: 't5 asked for src/a.ts:120: the PR does not change that line (changed ranges: 40-52, 98-110)' })
  expect((await ask(s, ado({ file: 'src/none.ts', body: 'Missing file' }))).text).toBe('t5 asked for src/none.ts:45: the PR does not change that file')
  s.w.diffs['/src/a.ts'] = null // the diff cannot be read
  const cant = await ask(s, ado({ line: 46, body: 'Another point on this line.' }))
  expect(cant).toEqual({ ok: false, text: 'could not verify the anchor: not sent' })
  expect((await listActions(s.h.host)).map(v => v.text)).toHaveLength(1) // only the one that passed is on the desk
  expect(argvText(s)).not.toContain(TOKEN)
})

test('ado inline: approve sends ONE new thread with the threadContext, returns its id, the token is on curl\'s stdin only', async () => {
  const s = setup()
  const v = await approve(s, ado({ endLine: 48 }))
  const out = await approveAction(s.h.host, v.id, s.tell)
  expect(out.ok, out.text).toBe(true)
  expect(out.text).toContain('id 701')
  expect(s.w.posts).toHaveLength(1)
  expect(s.w.posts[0]!.body.threadContext).toEqual({ filePath: '/src/a.ts', rightFileStart: { line: 45, offset: 1 }, rightFileEnd: { line: 48, offset: 1 } })
  expect(s.w.posts[0]!.body.comments[0].content).toBe('The value is not escaped before it is rendered.')
  expect(s.w.posts[0]!.stdin).toContain(TOKEN) // the config on stdin carries it
  expect(argvText(s)).not.toContain(TOKEN)
  expect(out.text + JSON.stringify([...s.h.files.values()]) + JSON.stringify(s.told)).not.toContain(TOKEN)
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('already used')
})

test('ado inline: the diff read again at send time; a push that moved the lines sends nothing, closes the request and tells the thread; an unreadable diff is retryable', async () => {
  const s = setup()
  const v = await approve(s, ado())
  s.w.diffs['/src/a.ts'] = [edit(100, 5)] // a push since the request: line 45 is no longer changed
  const out = await approveAction(s.h.host, v.id, s.tell)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('t5 asked for src/a.ts:45: the PR does not change that line (changed ranges: 100-104)')
  expect(s.w.posts).toHaveLength(0)
  expect(s.told.at(-1)!.text).toContain('NOT sent, nothing was written')
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('already used') // closed: it would fail again
  // cannot verify at send time: nothing written, the request stays approved and can be tried again
  const s2 = setup()
  const v2 = await approve(s2, ado())
  s2.w.diffs['/src/a.ts'] = null
  const o2 = await approveAction(s2.h.host, v2.id, s2.tell)
  expect(o2.ok).toBe(false)
  expect(o2.text).toContain('could not verify the anchor: not sent')
  expect(o2.text).toContain('stays approved')
  s2.w.diffs['/src/a.ts'] = [edit(40, 13)]
  expect((await approveAction(s2.h.host, v2.id, s2.tell)).ok).toBe(true)
  expect(s2.w.posts).toHaveLength(1)
})

// ---- GitHub -----------------------------------------------------------------------------------------------------------------------------------
test('gh inline: checked against pulls/<n>/files, sent through gh api with the head commit read at send time, the body on stdin and not in argv', async () => {
  const s = setup()
  expect((await ask(s, gh({ line: 120 }))).text).toBe('t5 asked for src/a.ts:120: the PR does not change that line (changed ranges: 41-52)')
  const v = await approve(s, gh())
  expect(v.text).toContain(ANCHOR_NOTE)
  s.w.ghPr = { head: { sha: 'b'.repeat(40) } } // a push between the request and the send: the NEW head is the commit named
  const out = await approveAction(s.h.host, v.id, s.tell)
  expect(out.ok, out.text).toBe(true)
  expect(s.w.ghPosts).toHaveLength(1)
  const p = s.w.ghPosts[0]!
  expect(p.argv.slice(0, 4)).toEqual(['gh', 'api', '--method', 'POST'])
  expect(p.argv).toContain('repos/acme/shop/pulls/7/comments')
  expect(p.argv.join(' ')).not.toContain('leaks the handle')
  expect(JSON.parse(p.stdin)).toEqual({ body: 'This leaks the handle on the error path.', commit_id: 'b'.repeat(40), path: 'src/a.ts', line: 45, side: 'RIGHT' })
})

test('gh inline: no files read, no head commit, or a patch GitHub left out is "could not verify" (nothing shown, nothing sent)', async () => {
  for (const patch of [{ ghFiles: null }, { ghPr: {} }, { ghFiles: [{ filename: 'src/a.ts', status: 'modified', changes: 4000 }] }]) {
    const s = setup()
    Object.assign(s.w, patch)
    expect([patch, (await ask(s, gh())).text]).toEqual([patch, 'could not verify the anchor: not sent'])
    expect(s.w.ghPosts).toHaveLength(0)
  }
})

test('gh inline: a comment text that contains the placeholder words is sent as written', async () => {
  const s = setup()
  const v = await approve(s, gh({ body: 'Pin the <PR head commit> in the cache key.' }))
  expect((await approveAction(s.h.host, v.id, s.tell)).ok).toBe(true)
  expect(JSON.parse(s.w.ghPosts[0]!.stdin)).toMatchObject({ body: 'Pin the <PR head commit> in the cache key.', commit_id: SHA })
})

// ---- the review batch -----------------------------------------------------------------------------------------------------------------------------
const review = (n: number, bodyOf = (i: number) => `Issue ${i}: the value is not escaped before it is rendered.`) => Array.from({ length: n }, (_, i) => ({ kind: 'ado-pr-comment', params: { ...PR, body: bodyOf(i + 1), file: (i + 1) % 3 === 0 ? 'src/b.ts' : 'src/a.ts', line: i + 1 } }))
const a100 = [edit(1, 100)] // lines 1-100 of a.ts

test('batch limits: up to 60 for ONLY PR comments of one PR, 10 for every other mix; the batch plan lists every item', () => {
  expect(BATCH_MAX).toBe(10)
  expect(COMMENT_BATCH_MAX).toBe(60)
  const gen = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'ado-pr-comment', params: { ...PR, body: `Point ${i + 1} is wrong.` } }))
  expect(checkAction({ kind: 'batch', items: gen(60) }).ok).toBe(true)
  const over = checkAction({ kind: 'batch', items: gen(61) })
  expect(!over.ok && over.text).toContain('at most 60 items (got 61')
  const mixed = checkAction({ kind: 'batch', items: [...gen(10), { kind: 'ado-pr-reply', params: { ...PR, thread: 7, body: 'Fixed.' } }] })
  expect(!mixed.ok && mixed.text).toContain('at most 10 items (got 11; only a batch of PR comments for one PR may hold up to 60)')
  const other = checkAction({ kind: 'batch', items: [...gen(5), { kind: 'ado-pr-comment', params: { ...PR, pr: 43, body: 'Another PR.' } }] })
  expect(!other.ok && other.text).toContain('another target')
  const c = checkAction({ kind: 'batch', items: gen(12) })
  expect(c.ok && c.plan.cont).toBe(true) // default for comments
  expect(c.ok && (c.params as any).continueOnError).toBe(true)
  const stop = checkAction({ kind: 'batch', items: gen(3), params: undefined, continueOnError: false })
  expect(stop.ok && stop.plan.cont).toBe(false)
  expect(checkAction({ kind: 'batch', items: gen(3), continueOnError: 'yes' }).ok).toBe(false)
  // non-comment batches keep stopping at the first failure
  const wi = checkAction({ kind: 'batch', items: [{ kind: 'ado-pr-reply', params: { ...PR, thread: 7, body: 'Fixed.' } }, { kind: 'ado-pr-thread-status', params: { ...PR, thread: 7, status: 'fixed' } }] })
  expect(wi.ok && wi.plan.cont).toBe(false)
  expect(wi.ok && 'continueOnError' in wi.params).toBe(false)
})

test('a text that fails the lint holds the whole batch (refused, naming the item)', () => {
  const items = review(5)
  items[2]!.params.body = 'LGTM'
  const c = checkAction({ kind: 'batch', items })
  expect(!c.ok && c.text).toContain('batch item 3: action ado-pr-comment: the comment is only an approval phrase')
})

test('60 inline comments, one request: refused at request time while any anchor does not stand (all bad ones named); then one Approve, in order, one bad anchor at send time fails only its item', async () => {
  const s = setup()
  s.w.diffs['/src/a.ts'] = a100
  s.w.diffs['/src/b.ts'] = [edit(1, 29), edit(31, 70)] // item 30 sits on line 30 of b.ts: not changed now
  const items = review(60)
  // request time: item 30 is on line 30 of b.ts, which this diff does not change; item 45 of a.ts-only lines is fine
  const bad = await ask(s, { kind: 'batch', items })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('batch item 30: t5 asked for src/b.ts:30: the PR does not change that line (changed ranges: 1-29, 31-100)')
  expect(bad.text).toContain('drop or fix this item')
  expect(await listActions(s.h.host)).toHaveLength(0)
  // the thread sends all 60 once the diff covers them; THEN a push removes line 30 before the send
  s.w.diffs['/src/b.ts'] = [edit(1, 100)]
  const v = await approve(s, { kind: 'batch', items })
  expect(v.writes).toBe(60)
  expect(v.items).toHaveLength(60)
  expect(v.cont).toBe(true)
  s.w.diffs['/src/b.ts'] = [edit(1, 29), edit(31, 70)]
  const out = await approveAction(s.h.host, v.id, s.tell)
  expect(out.ok).toBe(false) // partly done
  expect(out.text).toContain('partly done')
  expect(out.text).toContain('30: failed (t5 asked for src/b.ts:30: the PR does not change that line (changed ranges: 1-29, 31-100))')
  expect(out.text).toContain('1: done (id 701')
  expect(out.text).toContain('60: done (id 759')
  expect(s.w.posts).toHaveLength(59)
  expect(s.w.posts.map(p => p.body.comments[0].content.match(/^Issue (\d+)/)![1])).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)).filter(n => n !== '30')) // in order, the bad one skipped
  expect(s.told.at(-1)!.text).toContain('partly done')
  expect(argvText(s)).not.toContain(TOKEN)
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('already used')
})

test('continueOnError: a failing POST is reported and the rest run; with continueOnError false the batch stops at the first failure', async () => {
  const s = setup()
  s.w.failPost = n => n === 2
  const v = await approve(s, { kind: 'batch', items: review(5).map((x, i) => ({ ...x, params: { ...x.params, file: 'src/a.ts', line: 40 + i } })) })
  const out = await approveAction(s.h.host, v.id, s.tell)
  expect(out.text).toContain('2: failed (Azure DevOps refused')
  expect(s.w.posts).toHaveLength(5) // all five tried
  const t = setup()
  t.w.failPost = n => n === 2
  const v2 = await approve(t, { kind: 'batch', continueOnError: false, items: review(5).map((x, i) => ({ ...x, params: { ...x.params, file: 'src/a.ts', line: 40 + i } })) })
  const o2 = await approveAction(t.h.host, v2.id, t.tell)
  expect(o2.text).toContain('3: not run')
  expect(t.w.posts).toHaveLength(2)
})

test('the question and the card list a review numbered, grouped by file, each with its anchor; long texts are cut at 300 in the question, whole on the card', async () => {
  const s = setup()
  s.w.diffs['/src/a.ts'] = a100
  const long = `Long point: ${'x'.repeat(500)} end`
  const items = [...review(4, i => (i === 2 ? long : `Issue ${i}: the value is not escaped.`)), { kind: 'ado-pr-comment', params: { ...PR, body: 'Please add a changelog line for the new option.' } }]
  const r = await ask(s, { kind: 'batch', items })
  expect(r.ok, r.text).toBe(true)
  const v = r.request!
  const q = questionOf(v).question
  expect(q).toContain('src/a.ts (3)\n  1. src/a.ts:1: Issue 1')
  expect(q).toContain('  2. src/a.ts:2: Long point: ')
  expect(q).toContain('src/b.ts (1)\n  3. src/b.ts:3: Issue 3')
  expect(q).toContain('General comments (no file) (1)\n  5. PR comment: Please add a changelog line')
  expect(q.indexOf('src/a.ts (3)')).toBeLessThan(q.indexOf('src/b.ts (1)'))
  expect(q).not.toContain('x'.repeat(301))
  expect(q).toContain('…')
  expect(q).toContain('texts are cut at 300 characters')
  expect(q).toContain(ANCHOR_NOTE)
  expect(v.text).toContain('x'.repeat(500)) // the card: whole
  expect(v.text).toContain(`(${ANCHOR_NOTE})`)
  expect(q).toContain(`[request ${v.id}, check ${v.hash.slice(0, 12)}]`)
  expect(questionOf(v).options[0]!.description).toContain('a failing one is reported and the rest still run')
  // the answer binds only to exactly this question
  const bound = await bindAnswers(s.h.host, [{ question: q, options: questionOf(v).options }], { [q]: 'Approve' }, s.tell)
  expect(bound.join(' ')).toContain('approved')
})

test('the question of a batch the user answered with another text than the canonical one is not recorded (the list cannot be re-framed)', async () => {
  const s = setup()
  const r = await ask(s, { kind: 'batch', items: review(3).map(x => ({ ...x, params: { ...x.params, file: 'src/a.ts', line: 45 } })) })
  expect(r.ok, r.text).toBe(true)
  const q = questionOf(r.request!)
  const framed = q.question.replace('Issue 1', 'Issue one, as the desk words it')
  const notes = await bindAnswers(s.h.host, [{ question: framed, options: q.options }], { [framed]: 'Approve' }, s.tell)
  expect(notes.join(' ')).toContain('NOT recorded')
  expect((await answerAction(s.h.host, r.request!.id, 'deny', 'pane', s.tell)).ok).toBe(true)
})

// (the guide line in templates/thread.md and skills/thread/SKILL.md is pinned word for word by hooks/skills-contract.test.sh: a hooks module cannot read the plugin's files)
