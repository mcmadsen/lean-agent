// Thread status, reply + status, the GitHub thread resolve and the batch request (deskactions.ts): every path with canned az / curl / gh output.
// Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { BATCH_MAX, THREAD_STATUS, addActionRequest, answerAction, approveAction, bindAnswers, checkAction, listActions, questionOf, resetActions } from './deskactions'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const PR = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }
const REPLY = { kind: 'ado-pr-reply', params: { ...PR, thread: 7, body: 'Fixed in the next commit.' } }
const STATUS = { kind: 'ado-pr-thread-status', params: { ...PR, thread: 7, status: 'fixed' } }
const COMMENT = { kind: 'ado-pr-comment', params: { ...PR, body: 'One more thing: rebase first.' } }
const NODE = 'PRRT_kwDOAbCdEf4AbCd'

type Curl = (n: number, stdin: string) => { exitCode: number; stdout: string; stderr?: string }
function setup(curl: Curl = () => ({ exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) }), gh = { exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: NODE, isResolved: true } } } }) }) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  let n = 0
  h.exec.handler = (argv, c) => (argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? curl(++n, c.stdin ?? '') : argv[0] === 'gh' ? gh : { exitCode: 127, stdout: '', stderr: 'unknown' })
  const told: { thread: string; text: string }[] = []
  const tell = async (thread: string, text: string) => {
    told.push({ thread, text })
  }
  const writers = () => h.calls.filter(c => ['curl', 'gh'].includes(c.argv[0]!))
  return { h, told, tell, writers }
}
type S = ReturnType<typeof setup>

const ask = async (s: S, action: Record<string, unknown>) => {
  const r = await addActionRequest(s.h.host, 't5', { ...action, why: 'the PR needs it' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
const human = (s: S, v: Parameters<typeof questionOf>[0], label: string) => {
  const q = questionOf(v)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  return bindAnswers(s.h.host, [qq], { [qq.question]: label }, s.tell)
}
const approved = async (s: S, action: Record<string, unknown>) => {
  const v = await ask(s, action)
  await human(s, v, 'Approve')
  return v
}
// the JSON a curl config carries as its data-binary
const bodyOf = (stdin: string) => JSON.parse(/data-binary = "(.*)"/.exec(stdin)![1]!.replace(/\\(["\\nrt])/g, (_m, c: string) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' })[c]!))
const fail22: Curl = (n, stdin) => (n === 2 ? { exitCode: 22, stdout: '', stderr: 'HTTP 403 forbidden' } : { exitCode: 0, stdout: JSON.stringify({ id: n, url: `https://dev.azure.com/acme/_apis/x/${n}` }) })

// ---- 1a: the thread status alone -----------------------------------------------------------------------------------------------
test('ado-pr-thread-status: the fixed status list maps to the REST values and the rendering says what is set', () => {
  expect(Object.values(THREAD_STATUS).sort()).toEqual(['active', 'byDesign', 'closed', 'fixed', 'pending', 'wontFix'])
  for (const [given, rest] of [['active', 'active'], ['fixed', 'fixed'], ['wontFix', 'wontFix'], ['WONTFIX', 'wontFix'], ['closed', 'closed'], ['byDesign', 'byDesign'], ['pending', 'pending']]) {
    const c = checkAction({ kind: 'ado-pr-thread-status', params: { ...STATUS.params, status: given } })
    expect([given, c.ok]).toEqual([given, true])
    if (!c.ok) continue
    expect(c.plan.method).toBe('PATCH')
    expect(c.plan.url).toBe('https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/42/threads/7?api-version=7.1')
    expect(JSON.parse(c.plan.body)).toEqual({ status: rest })
    expect(c.plan.text).toBe(`set thread 7 of PR 42 to ${rest}`)
  }
  for (const status of ['resolved', 'unknown', '', 5, null, undefined]) expect(checkAction({ kind: 'ado-pr-thread-status', params: { ...STATUS.params, status } }).ok).toBe(false)
  expect(checkAction({ kind: 'ado-pr-thread-status', params: { ...STATUS.params, body: 'x' } }).ok).toBe(false) // no body: it sets a status only
  expect(checkAction({ kind: 'ado-pr-thread-status', params: { ...STATUS.params, thread: 'abc' } }).ok).toBe(false)
})

test('ado-pr-thread-status alone: one approval, one PATCH with the token on stdin only', async () => {
  const s = setup()
  const v = await approved(s, STATUS)
  expect(v.text).toBe('set thread 7 of PR 42 to fixed')
  expect(v.headline).toContain('set thread 7 of PR 42 to fixed')
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok, o.text).toBe(true)
  const [w] = s.writers()
  expect(s.writers()).toHaveLength(1)
  expect(w!.argv).toEqual(['curl', '-sS', '--fail-with-body', '--max-time', '60', '-X', 'PATCH', '-K', '-', 'https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/42/threads/7?api-version=7.1'])
  expect(bodyOf(w!.stdin!)).toEqual({ status: 'fixed' })
  for (const c of s.h.calls) expect(c.argv.join(' ')).not.toContain(TOKEN)
  expect(JSON.stringify([o.text, s.told, [...s.h.files.values()]])).not.toContain(TOKEN)
})

// ---- 1b: reply + status ---------------------------------------------------------------------------------------------------------
test('ado-pr-reply with a status: ONE request, one approval, the rendering shows the text AND the status; the mod posts then sets', async () => {
  const s2 = setup()
  expect(checkAction({ kind: 'ado-pr-reply', params: { ...REPLY.params, status: 'wontfix' } }).ok).toBe(true)
  const v = await approved(s2,{ kind: 'ado-pr-reply', params: { ...REPLY.params, status: 'fixed' } })
  expect(v.text).toBe('Fixed in the next commit.\n\nthen set the thread to fixed')
  expect(v.headline).toContain('then set the thread to fixed')
  expect(questionOf(v).question).toContain('then set the thread to fixed')
  expect(questionOf(v).options[0]!.description).toContain('2 writes')
  expect(await listActions(s2.h.host)).toHaveLength(1)
  const o = await approveAction(s2.h.host, v.id, s2.tell)
  expect(o.ok, o.text).toBe(true)
  const w = s2.writers()
  expect(w).toHaveLength(2)
  expect(w[0]!.argv).toContain('POST')
  expect(w[0]!.argv.at(-1)).toContain('/threads/7/comments?')
  expect(bodyOf(w[0]!.stdin!)).toEqual({ content: 'Fixed in the next commit.', parentCommentId: 1, commentType: 1 })
  expect(w[1]!.argv).toContain('PATCH')
  expect(w[1]!.argv.at(-1)).toContain('/threads/7?api-version=7.1')
  expect(bodyOf(w[1]!.stdin!)).toEqual({ status: 'fixed' })
  expect(o.text).toContain('reply: done')
  expect(o.text).toContain('status: done')
})

test('reply + status: the reply fails -> the status is NOT set, the result says so, nothing was written so the request stays retryable', async () => {
  let ok = false
  const s = setup((n, stdin) => (!ok ? { exitCode: 22, stdout: '', stderr: 'HTTP 403 forbidden' } : { exitCode: 0, stdout: JSON.stringify({ id: n }) }))
  const v = await approved(s, { kind: 'ado-pr-reply', params: { ...REPLY.params, status: 'fixed' } })
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('reply: failed')
  expect(o.text).toContain('status: not run')
  expect(s.writers()).toHaveLength(1) // the PATCH was never tried
  expect(o.text).toContain('stays approved and unused')
  ok = true
  const again = await approveAction(s.h.host, v.id, s.tell)
  expect(again.ok, again.text).toBe(true)
  expect(s.writers()).toHaveLength(3)
})

test('reply + status: the reply is posted but the status fails -> partly done, never repeated whole, the thread is told what is left', async () => {
  const s = setup(fail22)
  const v = await approved(s, { kind: 'ado-pr-reply', params: { ...REPLY.params, status: 'fixed' } })
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('partly done')
  expect(o.text).toContain('reply: done')
  expect(o.text).toContain('status: failed')
  expect(s.told.find(t => t.thread === 't5')!.text).toContain('only partly done')
  const again = await approveAction(s.h.host, v.id, s.tell)
  expect(again.ok).toBe(false)
  expect(again.text).toContain('already used')
  expect(s.writers()).toHaveLength(2) // the reply is not posted twice
})

test('a reply without a status is unchanged: one POST, and a bad status refuses the request', async () => {
  const s = setup()
  const v = await approved(s, REPLY)
  expect(v.text).toBe('Fixed in the next commit.')
  expect(v.writes).toBeUndefined()
  expect((await approveAction(s.h.host, v.id, s.tell)).ok).toBe(true)
  expect(s.writers()).toHaveLength(1)
  expect(checkAction({ kind: 'ado-pr-reply', params: { ...REPLY.params, status: 'resolved' } }).ok).toBe(false)
  expect(checkAction({ kind: 'ado-pr-reply', params: { ...REPLY.params, status: 3 } }).ok).toBe(false)
})

// ---- 1c: the GitHub twin --------------------------------------------------------------------------------------------------------
test('gh-pr-thread-resolve: gh api graphql with argv only, a GraphQL mutation with the thread as a variable', async () => {
  const p = { repo: 'acme/shop-api', pr: 42, thread: NODE }
  for (const bad of [{ thread: 'x' }, { thread: 'PRRT_a; rm -rf /' }, { repo: 'nope' }, { pr: 0 }, { body: 'x' }]) expect(checkAction({ kind: 'gh-pr-thread-resolve', params: { ...p, ...bad } }).ok).toBe(false)
  const s = setup()
  const v = await approved(s, { kind: 'gh-pr-thread-resolve', params: p })
  expect(v.text).toBe(`resolve review thread ${NODE} of PR acme/shop-api#42`)
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok, o.text).toBe(true)
  expect(o.text).toContain('thread resolved')
  const [w] = s.writers()
  expect(w!.argv).toEqual(['gh', 'api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', 'graphql', '--input', '-'])
  const body = JSON.parse(w!.stdin!)
  expect(body.variables).toEqual({ id: NODE })
  expect(body.query).toContain('resolveReviewThread')
  expect(body.query).not.toContain(NODE)
  expect(s.h.calls.some(c => c.argv[0] === 'az')).toBe(false)
})

test('gh-pr-thread-resolve: an answer that does not report the thread resolved is a failure, retryable', async () => {
  const s = setup(undefined, { exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: NODE, isResolved: false } } } }) })
  const v = await approved(s, { kind: 'gh-pr-thread-resolve', params: { repo: 'acme/shop-api', pr: 42, thread: NODE } })
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('not reported resolved')
})

// ---- 2: the batch ---------------------------------------------------------------------------------------------------------------
const BATCH = { kind: 'batch', items: [{ ...REPLY, params: { ...REPLY.params, status: 'fixed' } }, COMMENT, { kind: 'ado-pr-thread-status', params: { ...PR, thread: 9, status: 'closed' } }] }

test('a batch is one request: every item numbered in the question, in order, one Approve; the mod writes them in order', async () => {
  const s = setup()
  const v = await ask(s, BATCH)
  expect(v.kind).toBe('batch')
  expect(v.writes).toBe(4) // the reply, its status, the comment, the other thread's status
  expect(v.text.indexOf('1/3 ')).toBeLessThan(v.text.indexOf('2/3 '))
  expect(v.text.indexOf('2/3 ')).toBeLessThan(v.text.indexOf('3/3 '))
  expect(v.text).toContain('Fixed in the next commit.\n\nthen set the thread to fixed')
  expect(v.text).toContain('One more thing: rebase first.')
  expect(v.text).toContain('set thread 9 of PR 42 to closed')
  const q = questionOf(v)
  expect(q.question).toContain(v.text)
  expect(q.options[0]!.description).toContain('4 writes, in this order')
  expect((await human(s, v, 'Approve')).join(' ')).toContain('approve-action')
  expect(s.writers()).toHaveLength(0)
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok, o.text).toBe(true)
  const w = s.writers()
  expect(w).toHaveLength(4)
  expect(w.map(c => c.argv.at(-1)!.replace(/^.*pullRequests\/42/, '').replace(/\?.*/, ''))).toEqual(['/threads/7/comments', '/threads/7', '/threads', '/threads/9'])
  expect(w.map(c => c.argv[c.argv.indexOf('-X') + 1])).toEqual(['POST', 'PATCH', 'POST', 'PATCH'])
  for (const t of ['1 reply: done', '1 status: done', '2: done', '3: done']) expect(o.text).toContain(t)
  expect(s.h.calls.filter(c => c.argv[0] === 'az')).toHaveLength(4) // a token each write, never in argv
  for (const c of s.h.calls) expect(c.argv.join(' ')).not.toContain(TOKEN)
  expect(s.told.some(t => t.thread === 't5' && t.text.includes('Carry on'))).toBe(true)
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('already used') // one approval covers exactly this list, once
  expect(s.writers()).toHaveLength(4)
})

test('a batch of a work item and one of GitHub use the same door', async () => {
  const wi = { org: 'acme', project: 'Shop App', id: 1234 }
  const s = setup()
  const v = await approved(s, { kind: 'batch', items: [{ kind: 'ado-workitem-comment', params: { ...wi, body: 'Root cause found.' } }, { kind: 'ado-workitem-update', params: { ...wi, fields: { state: 'Resolved' } } }] })
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok, o.text).toBe(true)
  expect(s.writers().map(c => c.argv[c.argv.indexOf('-X') + 1])).toEqual(['POST', 'PATCH'])
  const g = setup()
  const gv = await approved(g, { kind: 'batch', items: [{ kind: 'gh-pr-comment', params: { repo: 'acme/shop-api', pr: 42, body: 'Thanks.' } }, { kind: 'gh-pr-thread-resolve', params: { repo: 'acme/shop-api', pr: 42, thread: NODE } }] })
  expect((await approveAction(g.h.host, gv.id, g.tell)).ok).toBe(true)
  expect(g.writers().map(c => c.argv.at(-3))).toEqual(['repos/acme/shop-api/issues/42/comments', 'graphql'])
})

test('batch deny and edit first send nothing and tell the thread', async () => {
  const s = setup()
  const v = await ask(s, BATCH)
  expect((await human(s, v, 'Deny')).join(' ')).toContain('denied')
  expect(s.told.find(t => t.thread === 't5')!.text).toContain('denied')
  expect((await approveAction(s.h.host, v.id, s.tell)).ok).toBe(false)
  expect(s.writers()).toHaveLength(0)
  const s2 = setup()
  const v2 = await ask(s2, BATCH)
  expect((await human(s2, v2, 'Edit first')).join(' ')).toContain('edit')
  expect((await approveAction(s2.h.host, v2.id, s2.tell)).ok).toBe(false)
  expect(s2.writers()).toHaveLength(0)
})

test('a batch the user did not see in full is not approved: a question that drops an item is not recorded', async () => {
  const s = setup()
  const v = await ask(s, BATCH)
  const q = questionOf(v)
  const short = q.question.replace(/2\/3[\s\S]*?(?=3\/3)/, '')
  expect(short).not.toBe(q.question)
  const notes = await bindAnswers(s.h.host, [{ question: short, options: q.options }], { [short]: 'Approve' }, s.tell)
  expect(notes.join(' ')).toContain('NOT recorded')
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('no human Approve is on record')
  expect(s.writers()).toHaveLength(0)
})

test('batch hash mismatch: an item changed after the approval is refused, nothing is sent', async () => {
  const s = setup()
  const v = await approved(s, BATCH)
  const rows = (await s.h.host.store.get('action.requests')) as any[]
  const items = rows[0].params.items.map((i: any) => ({ ...i, params: { ...i.params } }))
  items[1].params.body = 'A different comment that the user never saw.'
  rows[0].params = { items }
  await s.h.host.store.set('action.requests', rows)
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('does not verify')
  expect(s.writers()).toHaveLength(0)
  // an item added or dropped changes the hash too
  rows[0].params = { items: items.slice(0, 2) }
  await s.h.host.store.set('action.requests', rows)
  expect((await approveAction(s.h.host, v.id, s.tell)).ok).toBe(false)
  expect((await answerAction(s.h.host, v.id, 'approve', 'pane')).ok).toBe(false)
  expect(s.writers()).toHaveLength(0)
})

test('batch: the first failure stops it; the result says done / failed with the reason / not run per item; it is not repeated whole', async () => {
  const s = setup((n) => (n === 2 ? { exitCode: 22, stdout: '', stderr: 'HTTP 409 conflict' } : { exitCode: 0, stdout: JSON.stringify({ id: n }) }))
  const v = await approved(s, { kind: 'batch', items: [COMMENT, { ...REPLY }, { kind: 'ado-pr-thread-status', params: { ...PR, thread: 9, status: 'closed' } }] })
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('1: done')
  expect(o.text).toMatch(/2: failed \(.*409 conflict/)
  expect(o.text).toContain('3: not run')
  expect(s.writers()).toHaveLength(2)
  expect(s.told.find(t => t.thread === 't5')!.text).toContain('3: not run')
  expect((await approveAction(s.h.host, v.id, s.tell)).text).toContain('already used')
  expect(s.writers()).toHaveLength(2)
  expect(s.h.files.get(`${L}/threads/t5/history.jsonl`)).toContain('action-failed')
})

test('batch: a first item that fails writes nothing and the request stays retryable', async () => {
  let up = false
  const s = setup((n) => (up ? { exitCode: 0, stdout: JSON.stringify({ id: n }) } : { exitCode: 22, stdout: '', stderr: 'HTTP 503' }))
  const v = await approved(s, BATCH)
  const o = await approveAction(s.h.host, v.id, s.tell)
  expect(o.ok).toBe(false)
  expect(o.text).toContain('1 reply: failed')
  expect(o.text).toContain('3: not run')
  expect(o.text).toContain('unused')
  up = true
  expect((await approveAction(s.h.host, v.id, s.tell)).ok).toBe(true)
})

test('batch: another target, a nested batch, a bad item, an empty list and more than ten items are refused with the reason', () => {
  const other = (over: Record<string, unknown>, kind = 'ado-pr-comment') => checkAction({ kind: 'batch', items: [COMMENT, { kind, params: { ...COMMENT.params, ...over } }] })
  for (const over of [{ pr: 43 }, { repo: 'shop-web' }, { project: 'Other' }, { org: 'other' }]) {
    const c = other(over)
    expect([JSON.stringify(over), c.ok]).toEqual([JSON.stringify(over), false])
    if (!c.ok) expect(c.text).toContain('another target')
  }
  const wi = checkAction({ kind: 'batch', items: [COMMENT, { kind: 'ado-workitem-comment', params: { org: 'acme', project: 'Shop App', id: 5, body: 'x' } }] })
  expect(wi.ok).toBe(false)
  const wi2 = checkAction({ kind: 'batch', items: [{ kind: 'ado-workitem-comment', params: { org: 'acme', project: 'Shop App', id: 5, body: 'x' } }, { kind: 'ado-workitem-comment', params: { org: 'acme', project: 'Shop App', id: 6, body: 'x' } }] })
  expect(wi2.ok).toBe(false)
  const gh = checkAction({ kind: 'batch', items: [{ kind: 'gh-pr-comment', params: { repo: 'acme/a', pr: 1, body: 'x' } }, { kind: 'gh-pr-comment', params: { repo: 'acme/b', pr: 1, body: 'x' } }] })
  expect(gh.ok).toBe(false)
  const nested = checkAction({ kind: 'batch', items: [COMMENT, { kind: 'batch', items: [COMMENT] }] })
  expect(nested.ok).toBe(false)
  if (!nested.ok) expect(nested.text).toContain('cannot hold a batch')
  const bad = checkAction({ kind: 'batch', items: [COMMENT, { kind: 'push', params: {} }] })
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.text).toContain('batch item 2')
  const badParam = checkAction({ kind: 'batch', items: [{ ...COMMENT, params: { ...COMMENT.params, command: 'x' } }] })
  expect(badParam.ok).toBe(false)
  expect(checkAction({ kind: 'batch', items: [] }).ok).toBe(false)
  expect(checkAction({ kind: 'batch' }).ok).toBe(false)
  expect(checkAction({ kind: 'batch', items: 'x' }).ok).toBe(false)
  expect(checkAction({ kind: 'batch', items: [COMMENT], params: { items: [COMMENT], other: 1 } }).ok).toBe(false)
  // (1.0.29: a batch of ONLY PR comments may hold up to 60; every other mix stays at ten)
  const ten = Array.from({ length: BATCH_MAX }, (_v, i) => ({ kind: 'ado-pr-reply', params: { ...COMMENT.params, thread: i + 1, body: `note ${i}` } }))
  const okTen = checkAction({ kind: 'batch', items: ten })
  expect(okTen.ok).toBe(true)
  const eleven = checkAction({ kind: 'batch', items: [...ten, ten[0]] })
  expect(eleven.ok).toBe(false)
  if (!eleven.ok) expect(eleven.text).toContain('at most 10')
  const elevenComments = Array.from({ length: BATCH_MAX + 1 }, (_v, i) => ({ kind: 'ado-pr-comment', params: { ...COMMENT.params, body: `note ${i}` } }))
  expect(checkAction({ kind: 'batch', items: elevenComments }).ok).toBe(true)
})

test('a batch request refused by the door reports nothing; a good one through addActionRequest is signed and listed', async () => {
  const s = setup()
  const r = await addActionRequest(s.h.host, 't5', { kind: 'batch', items: [COMMENT, { kind: 'ado-pr-comment', params: { ...COMMENT.params, pr: 99 } }] })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('another target')
  expect(await listActions(s.h.host)).toHaveLength(0)
  const v = await ask(s, BATCH)
  expect((await listActions(s.h.host)).map(x => x.id)).toEqual([v.id])
  // the same batch again is the one that waits
  const again = await addActionRequest(s.h.host, 't5', { ...BATCH })
  expect(again.text).toContain('already waiting')
  // params.items is accepted too (the stored shape)
  const viaParams = checkAction({ kind: 'batch', params: { items: BATCH.items } })
  expect(viaParams.ok).toBe(true)
})
