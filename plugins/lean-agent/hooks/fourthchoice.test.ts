// 1.0.28 the dialog's fourth choice: "Approve, and allow this kind on this PR for 24 h" for every kind of the own-PR default's table and for replies with a status
// (a signed written approval of the request's own PR or work item: 24 h, at most 40 writes, Revoke). Canned curl / gh output, synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { STANDING_LABEL, STANDING_LABEL_WI, addActionRequest, answerAction, approveAction, bindAnswers, questionOf, resetActions } from './deskactions'
import { revokeWrites, runGranted, writesView } from './deskwrites'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const HOUR = 3_600_000
const P = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }
const REPLY = { ...P, thread: 7, body: 'Fixed in the next commit.' }
const WI = (state: string, id = 1234) => ({ org: 'acme', project: 'Shop App', id, fields: { state } })

function setup() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/config.json`, JSON.stringify({ actions: { holdSeconds: 0 } })) // (no hold window: sendhold.test.ts has its own specs)
  for (const t of ['t5', 't6']) h.files.set(`${L}/threads/${t}/thread.json`, JSON.stringify({ id: t, title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: 'TOKEN-0123456789\n' }
    if (argv[0] === 'curl' && argv[argv.indexOf('-X') + 1] === 'GET') return { exitCode: 0, stdout: JSON.stringify({ id: argv[argv.length - 1]!.includes('/_apis/projects/') ? '11111111-2222-3333-4444-555555555555' : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) }
    if (argv[0] === 'curl') return { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) }
    if (argv[0] === 'gh' && argv.includes('--method')) return { exitCode: 0, stdout: JSON.stringify({ id: 9, html_url: 'https://github.com/acme/shop-api/pull/42#issuecomment-9', data: { resolveReviewThread: { thread: { id: 'x', isResolved: true } } } }) }
    if (argv[0] === 'gh') return { exitCode: 0, stdout: JSON.stringify({ data: { node: { pullRequest: { number: 42, repository: { nameWithOwner: 'acme/shop-api' } } } } }) }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const told: string[] = []
  const tell = async (_t: string, text: string) => void told.push(text)
  const writers = () => h.calls.filter(c => (c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] !== 'GET') || (c.argv[0] === 'gh' && c.argv.includes('--method')))
  return { h, host: h.host, tell, told, writers }
}
type S = ReturnType<typeof setup>
const ask = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5', items?: unknown) => {
  const r = await addActionRequest(s.host, thread, items ? { kind, items, why: 'x' } : { kind, params, why: 'x' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
const press = (s: S, v: Parameters<typeof questionOf>[0], label: string) => {
  const q = questionOf(v)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  return bindAnswers(s.host, [qq], { [qq.question]: label }, s.tell)
}
// the user presses the fourth choice, then the desk sends the approved request
async function allowed(s: S, kind: string, params: Record<string, unknown>, label = STANDING_LABEL, items?: unknown) {
  const v = await ask(s, kind, params, 't5', items)
  expect(questionOf(v).options.map(o => o.label)).toEqual(['Approve', 'Deny', 'Edit first', label])
  const notes = await press(s, v, label)
  expect(notes.join(' ')).toContain('allowed this kind of write')
  expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(true)
  return v
}
// a request made now and whether the written approval sent it at once (not covered: denied, so nothing stays open)
const sentNow = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5') => {
  const v = await ask(s, kind, params, thread)
  const sent = (await runGranted(s.host, v.id))?.sent === true
  if (!sent) await answerAction(s.host, v.id, 'deny', 'pane')
  return sent
}

test('a plain reply: the fourth choice allows replies (not a status) on THIS PR for this thread, 24 h, at most 40, and Revoke ends it', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await allowed(s, 'ado-pr-reply', REPLY)
  const g = (await writesView(s.host)).grants[0]!
  expect(g).toMatchObject({ thread: 't5', scope: 'Azure DevOps PR acme/Shop App/shop-api#42', kinds: ['reply'], cap: 40, used: 0 })
  expect(g.exp - (await s.host.clock.now())).toBe(24 * HOUR)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 8, body: 'Thanks.' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 9, body: 'Done.', status: 'fixed' })).toBe(false) // a status was not allowed
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, pr: 43, thread: 8, body: 'Thanks.' })).toBe(false) // another PR
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 8, body: 'Thanks again.' }, 't6')).toBe(false) // another thread
  expect(await sentNow(s, 'ado-pr-comment', { ...P, body: 'new comment' })).toBe(false) // another kind
  expect((await writesView(s.host)).grants[0]!.used).toBe(1) // (the first send was the user's own Approve: only the one under the grant counts)
  const out = await revokeWrites(s.host, { id: g.id })
  expect(out.ok).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 12, body: 'After the revoke.' })).toBe(false)
})

test('a reply WITH a status: replies and the statuses fixed / closed / active are allowed on that PR, no other status; a thread status change keeps its own grant', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await allowed(s, 'ado-pr-reply', { ...REPLY, status: 'fixed' })
  const g = (await writesView(s.host)).grants[0]!
  expect(g.kinds.sort()).toEqual(['reply', 'status'])
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 8, body: 'Done.', status: 'closed' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 9, body: 'Plain.' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 10, body: 'Not now.', status: 'wontFix' })).toBe(false)
  expect(await sentNow(s, 'ado-pr-thread-status', { ...P, thread: 11, status: 'fixed' })).toBe(true) // the status kind is in the grant too
  expect(await sentNow(s, 'ado-pr-thread-status', { ...P, thread: 11, status: 'pending' })).toBe(false)
})

test('a work item state, a PR link, a GitHub comment and a GitHub thread resolve: each its own scope and kind', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Resolved'))
  expect(questionOf(v).options[3]!.label).toBe(STANDING_LABEL_WI)
  await allowed(s, 'ado-workitem-update', WI('Active'), STANDING_LABEL_WI)
  const g = (await writesView(s.host)).grants[0]!
  expect([g.scope, g.kinds]).toEqual(['Azure DevOps work item acme/Shop App#1234', ['update']])
  expect(await sentNow(s, 'ado-workitem-update', WI('Resolved'))).toBe(true)
  expect(await sentNow(s, 'ado-workitem-update', WI('Closed'))).toBe(false) // a state outside the list
  expect(await sentNow(s, 'ado-workitem-update', WI('Resolved', 999))).toBe(false) // another work item
  expect(await sentNow(s, 'ado-workitem-update', { ...WI('Resolved'), fields: { state: 'Resolved', title: 'x' } })).toBe(false)
  expect(questionOf(await ask(s, 'ado-workitem-update', WI('Done'))).options).toHaveLength(3) // no fourth choice for a risky state
  const l = setup()
  await allowed(l, 'ado-pr-workitem-link', { ...P, workitem: 1234 })
  expect(await sentNow(l, 'ado-pr-workitem-link', { ...P, workitem: 1300 })).toBe(true)
  expect(await sentNow(l, 'ado-pr-reply', { ...REPLY, thread: 8, body: 'x' })).toBe(false)
  const gh = setup()
  await allowed(gh, 'gh-pr-comment', { repo: 'acme/shop-api', pr: 42, body: 'Thanks, updated.' })
  expect(await sentNow(gh, 'gh-pr-comment', { repo: 'acme/shop-api', pr: 42, body: 'One more.' })).toBe(true)
  expect(await sentNow(gh, 'gh-pr-comment', { repo: 'acme/shop-api', pr: 43, body: 'Another PR.' })).toBe(false)
  const rs = setup()
  await allowed(rs, 'gh-pr-thread-resolve', { repo: 'acme/shop-api', pr: 42, thread: 'PRRT_kwDOAbCdEf4' })
  expect(await sentNow(rs, 'gh-pr-thread-resolve', { repo: 'acme/shop-api', pr: 42, thread: 'PRRT_kwDOZzYyXx9' })).toBe(true)
})

test('a batch of eligible items carries the choice (the kinds of every item); a batch with one item outside it does not', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const items = [
    { kind: 'ado-pr-reply', params: { ...REPLY, body: 'Build 9981 is green.' } },
    { kind: 'ado-pr-workitem-link', params: { ...P, workitem: 1234 } },
  ]
  await allowed(s, 'batch', {}, STANDING_LABEL, items)
  expect((await writesView(s.host)).grants[0]!.kinds.sort()).toEqual(['link', 'reply'])
  const bad = await ask(s, 'batch', {}, 't5', [...items, { kind: 'ado-pr-comment', params: { ...P, body: 'x' } }])
  expect(questionOf(bad).options).toHaveLength(3)
})

test('at most 40 writes under one grant (counted per write), then the user is asked again', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  s.h.files.set(`${L}/config.json`, JSON.stringify({ actions: { maxWritesPerGrant: 3, holdSeconds: 0 } }))
  await allowed(s, 'ado-pr-reply', REPLY)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 8, body: 'one' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 9, body: 'two' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 10, body: 'three' })).toBe(true)
  expect(await sentNow(s, 'ado-pr-reply', { ...REPLY, thread: 11, body: 'four' })).toBe(false) // the cap is reached
  expect((await writesView(s.host)).grants[0]!.cap).toBe(3)
})

test('a request outside the choice (a note, another status, another kind) has three options and a pressed fourth label records nothing', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-comment', { ...P, body: 'hello' })
  expect(questionOf(v).options).toHaveLength(3)
  const forged = questionOf({ ...v, standing: true })
  const notes = await bindAnswers(s.host, [{ question: forged.question, options: forged.options }], { [forged.question]: STANDING_LABEL }, s.tell)
  expect(notes.join(' ')).toContain('was NOT recorded')
  expect((await writesView(s.host)).grants).toEqual([])
})
