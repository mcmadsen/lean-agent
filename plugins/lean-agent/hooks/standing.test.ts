// 1.0.24 standing approval: a status change (never text) the user allowed once, by a human choice or a rule written by hand in config.json
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { STANDING_LABEL, actionListText, addActionRequest, answerAction, approveAction, bindAnswers, dropGrants, listActions, questionOf, resetActions, revokeGrant, runStanding, standingView } from './deskactions'
import { threadTool } from './delivery'
import { decide } from './guard'
import { orchReset } from './orchestrate'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const HOUR = 3_600_000
const STATUS = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, status: 'fixed' }
const REPLY = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
const RESOLVE = { repo: 'acme/shop-api', pr: 42, thread: 'PRRT_kwDOAbCdEf4' }
const SCOPE = 'Azure DevOps PR acme/Shop App/shop-api#42'

function setup() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  for (const t of ['t5', 't6']) h.files.set(`${L}/threads/${t}/thread.json`, JSON.stringify({ id: t, title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = argv =>
    argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) } : argv[0] === 'gh' ? { exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'x', isResolved: true } } } }) } : { exitCode: 127, stdout: '', stderr: 'unknown' }
  const told: { thread: string; text: string }[] = []
  const tell = async (thread: string, text: string) => {
    told.push({ thread, text })
  }
  const writers = () => h.calls.filter(c => ['curl', 'gh'].includes(c.argv[0]!))
  return { h, told, tell, writers, host: h.host }
}
type S = ReturnType<typeof setup>
const ask = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5') => {
  const r = await addActionRequest(s.host, thread, { kind, params, why: 'the PR needs it' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
const human = (s: S, v: Parameters<typeof questionOf>[0], label: string) => {
  const q = questionOf(v)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  return bindAnswers(s.host, [qq], { [qq.question]: label }, s.tell)
}
// a standing grant from the card choice of a status change, then sent by approve-action like any approval
async function granted(s: S, params: Record<string, unknown> = STATUS) {
  const v = await ask(s, 'ado-pr-thread-status', params)
  const notes = await human(s, v, STANDING_LABEL)
  expect(notes.join(' ')).toContain('allowed status changes')
  expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(true)
  return v
}
// a request made now, and whether the standing approval sent it at once
// (a request that is not covered waits for the user: denied here, so a thread never reaches its five open requests)
const tryNow = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5') => {
  const id = (await ask(s, kind, params, thread)).id
  const r = await runStanding(s.host, id)
  if (!r) await answerAction(s.host, id, 'deny', 'pane', s.tell)
  return r
}
const history = (s: S, t = 't5') => s.h.files.get(`${L}/threads/${t}/history.jsonl`) ?? ''

test('the third choice exists only for a status change (never for text); it is a human answer that stores the signed grant and logs it', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-thread-status', STATUS)
  expect(questionOf(v).options.map(o => o.label)).toEqual(['Approve', 'Deny', 'Edit first', STANDING_LABEL])
  expect(STANDING_LABEL).toBe('Approve, and allow status changes on this PR for 24 h')
  expect(questionOf(await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 8, status: 'wontFix' }, 't6')).options).toHaveLength(3) // not a low-risk status
  expect(questionOf(await ask(s, 'ado-pr-reply', REPLY)).options).toHaveLength(3)
  expect(questionOf(await ask(s, 'ado-pr-reply', { ...REPLY, thread: 9, status: 'fixed' })).options).toHaveLength(3) // a reply carries text, even with a status
  expect(questionOf(await ask(s, 'gh-pr-thread-resolve', RESOLVE, 't6')).options).toHaveLength(4)
  expect((await standingView(s.host)).grants).toEqual([])
  expect((await human(s, v, 'Approve')).join(' ')).not.toContain('allowed status changes') // plain Approve: no grant
  expect((await standingView(s.host)).grants).toEqual([])
  const v2 = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 11 })
  expect((await human(s, v2, STANDING_LABEL)).join(' ')).toContain('allowed status changes')
  const [g] = (await standingView(s.host)).grants
  expect(g).toMatchObject({ thread: 't5', scope: SCOPE, statuses: ['fixed', 'closed', 'active'] })
  expect(g!.exp - (await s.host.clock.now())).toBe(24 * HOUR)
  expect(history(s)).toContain('"kind":"standing-grant"')
  expect(history(s)).toContain('"by":"user, asked by the desk"')
})

test('with a grant, a status change of the same thread on the same PR is sent at once by the same executor: reported, shown as a line, logged; Revoke ends it', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await granted(s)
  expect(s.writers()).toHaveLength(1)
  const r = await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 8, status: 'closed' })
  expect(r).toEqual({ sent: true, line: 'sent under your standing approval: set thread 8 of PR 42 to closed' })
  expect(s.writers()).toHaveLength(2)
  const curl = s.writers()[1]!
  expect(curl.argv.slice(-1)[0]).toBe('https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/42/threads/8?api-version=7.1')
  expect(curl.argv).not.toContain(TOKEN)
  expect(curl.stdin).toContain(`Bearer ${TOKEN}`) // the token goes on stdin only
  expect(history(s)).toContain('"kind":"standing-sent"')
  expect(history(s)).toContain('"kind":"action-sent"')
  expect(history(s)).not.toContain(TOKEN)
  const view = await standingView(s.host)
  expect(view.sent).toHaveLength(1)
  expect(view.sent[0]).toMatchObject({ thread: 't5', text: 'sent under your standing approval: set thread 8 of PR 42 to closed', grant: view.grants[0]!.id })
  expect(await listActions(s.host)).toEqual([]) // nothing waits for the user
  expect(await actionListText(s.host)).toContain(view.grants[0]!.id)
  expect(await actionListText(s.host)).toContain('do not ask the user again')
  // through lean_report: the thread is told in the reply, the desk inbox row is a progress note, not a block
  const rep = await threadTool(s.host, 't5', 'lean_report', { state: 'blocked', text: 'thread 9 is fixed', action: { kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 9 } } })
  expect(rep.ok).toBe(true)
  expect(rep.text).toContain('sent under your standing approval: set thread 9 of PR 42 to fixed')
  expect(rep.text).not.toContain('waits for the user\'s yes')
  const row = JSON.parse((s.h.files.get(`${L}/desk/inbox.jsonl`) ?? '').trim().split('\n').pop()!)
  expect([row.state, row.action]).toEqual(['working', undefined])
  expect(s.writers()).toHaveLength(3)
  // revoke
  expect((await revokeGrant(s.host, 'g0-0')).ok).toBe(false)
  expect((await revokeGrant(s.host, view.grants[0]!.id)).ok).toBe(true)
  expect((await standingView(s.host)).grants).toEqual([])
  expect((await standingView(s.host)).sent[0]!.grant).toBeUndefined()
  expect(history(s)).toContain('"kind":"standing-revoked"')
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 10 })).toBeNull() // asked again
  expect(s.writers()).toHaveLength(3)
})

test('the pane\'s third press is the same human answer; a GitHub review thread resolve is covered the same way', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'gh-pr-thread-resolve', RESOLVE)
  expect((await answerAction(s.host, v.id, 'approve', 'pane', s.tell, true)).ok).toBe(true)
  expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(true)
  const r = await tryNow(s, 'gh-pr-thread-resolve', { ...RESOLVE, thread: 'PRRT_kwDOZzYyXx9' })
  expect(r?.sent).toBe(true)
  expect(r?.line).toBe('sent under your standing approval: resolve review thread PRRT_kwDOZzYyXx9 of PR acme/shop-api#42')
  expect(await tryNow(s, 'gh-pr-thread-resolve', { ...RESOLVE, pr: 43, thread: 'PRRT_kwDOQqWwEe5' })).toBeNull() // another PR
  expect(history(s)).toContain('"by":"user, in the pane"')
})

test('a grant covers only its thread, its PR, its kinds and statuses; text is never covered; a batch only when EVERY item is', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await granted(s)
  const n = () => s.writers().length
  const base = n()
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 21, pr: 43 })).toBeNull() // other PR
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 21, repo: 'other-repo' })).toBeNull() // other repo
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 21 }, 't6')).toBeNull() // other thread
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 21, status: 'wontFix' })).toBeNull() // not a low-risk status
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 21, status: 'pending' })).toBeNull()
  expect(await tryNow(s, 'ado-pr-comment', { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, body: 'hello' })).toBeNull() // other kind
  expect(await tryNow(s, 'ado-pr-reply', { ...REPLY, thread: 22, status: 'fixed' })).toBeNull() // a reply, even with a status
  expect(await tryNow(s, 'gh-pr-thread-resolve', RESOLVE)).toBeNull() // another kind (the grant is for Azure DevOps status changes)
  expect(n()).toBe(base)
  const withReply = await addActionRequest(s.host, 't5', { kind: 'batch', items: [{ kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 31 } }, { kind: 'ado-pr-reply', params: { ...REPLY, thread: 32 } }] })
  expect(withReply.ok, withReply.text).toBe(true)
  expect(await runStanding(s.host, withReply.request!.id)).toBeNull()
  const withOther = await addActionRequest(s.host, 't5', { kind: 'batch', items: [{ kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 33 } }, { kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 34, status: 'wontFix' } }] })
  expect(await runStanding(s.host, withOther.request!.id)).toBeNull()
  expect(n()).toBe(base)
  const all = await addActionRequest(s.host, 't5', { kind: 'batch', items: [{ kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 35 } }, { kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 36, status: 'closed' } }] })
  const r = await runStanding(s.host, all.request!.id)
  expect(r?.sent).toBe(true)
  expect(r?.line).toContain('set thread 35 of PR 42 to fixed; set thread 36 of PR 42 to closed')
  expect(n()).toBe(base + 2)
})

test('expiry: a grant ends after 24 h, and with its thread (close)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await granted(s)
  s.h.clock.t += 24 * HOUR - 1000
  expect((await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 40 }))?.sent).toBe(true) // still inside the 24 h
  s.h.clock.t += 2000
  expect((await standingView(s.host)).grants).toEqual([])
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 41 })).toBeNull()
  const s2 = setup()
  await granted(s2)
  await dropGrants(s2.host, 't5') // what closing the thread does (threads.ts close)
  expect(await tryNow(s2, 'ado-pr-thread-status', { ...STATUS, thread: 42 })).toBeNull()
})

test('a rule the user wrote in config.json actions.standing covers the named project, kind and statuses only', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  s.h.files.set(`${L}/config.json`, JSON.stringify({ actions: { standing: [{ project: 'Shop App', kinds: ['ado-pr-thread-status'], statuses: ['fixed'] }, { project: 'Loose', kinds: ['ado-pr-reply', 'ado-pr-thread-status'], statuses: ['wontFix', 'pending'] }] } }))
  expect((await tryNow(s, 'ado-pr-thread-status', STATUS))?.line).toBe('sent under your standing approval: set thread 7 of PR 42 to fixed')
  expect((await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 8 }, 't6'))?.sent).toBe(true) // a rule is not bound to a thread or a PR
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 9, status: 'closed' })).toBeNull() // status not in the rule
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 9, project: 'Other App' })).toBeNull() // another project
  expect(await tryNow(s, 'gh-pr-thread-resolve', RESOLVE)).toBeNull() // kind not in the rule
  expect(await tryNow(s, 'ado-pr-reply', REPLY)).toBeNull() // never text, whatever the rule says
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 9, project: 'Loose', status: 'wontFix' })).toBeNull() // only fixed, closed, active can be named
  expect(s.writers()).toHaveLength(2)
  expect(history(s)).toContain('your config.json rule')
  expect(await actionListText(s.host)).toContain('in config.json actions.standing')
  expect((await standingView(s.host)).grants).toEqual([]) // a rule is not a grant: no Revoke button
  // a batch of two covered statuses is covered; one with a comment is not
  s.h.files.set(`${L}/config.json`, JSON.stringify({ 'actions.standing': [{ project: 'Shop App', kinds: ['ado-pr-thread-status'], statuses: ['fixed', 'active'] }] })) // (the flat key works too)
  const ok = await addActionRequest(s.host, 't5', { kind: 'batch', items: [{ kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 51 } }, { kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 52, status: 'active' } }] })
  expect((await runStanding(s.host, ok.request!.id))?.sent).toBe(true)
  const bad = await addActionRequest(s.host, 't5', { kind: 'batch', items: [{ kind: 'ado-pr-thread-status', params: { ...STATUS, thread: 53 } }, { kind: 'ado-pr-comment', params: { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, body: 'x' } }] })
  expect(await runStanding(s.host, bad.request!.id)).toBeNull()
})

test('no tool creates a grant: no action kind, no report, no forged row, no standing answer for text or a deny', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const PARAMS: Record<string, Record<string, unknown>> = {
    'ado-pr-reply': REPLY,
    'ado-pr-comment': { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, body: 'hello' },
    'ado-workitem-comment': { org: 'acme', project: 'Shop App', id: 5, body: 'hello' },
    'ado-workitem-update': { org: 'acme', project: 'Shop App', id: 5, fields: { state: 'Done' } },
    'gh-pr-comment': { repo: 'acme/shop-api', pr: 42, body: 'hello' },
  }
  for (const [kind, params] of Object.entries(PARAMS)) {
    const r = await threadTool(s.host, 't5', 'lean_report', { state: 'blocked', text: 'x', action: { kind, params } })
    expect(r.ok, r.text).toBe(true)
    expect(r.text).toContain('waits for the user')
  }
  const rep = await ask(s, 'ado-pr-reply', { ...REPLY, thread: 70 }, 't6')
  expect((await answerAction(s.host, rep.id, 'approve', 'pane', s.tell, true)).text).toContain('cannot carry a standing approval')
  const st = await ask(s, 'ado-pr-thread-status', STATUS, 't6')
  expect((await answerAction(s.host, st.id, 'deny', 'pane', s.tell, true)).ok).toBe(false)
  expect((await standingView(s.host)).grants).toEqual([])
  // a grant row put into the store by anything but the mod's own signing is no grant
  const now = await s.host.clock.now()
  await s.host.store.set('action.grants', [{ id: 'g1-1', thread: 't6', scope: SCOPE, kinds: ['ado-pr-thread-status'], statuses: ['fixed'], ts: now, exp: now + HOUR, sig: 'a'.repeat(64) }])
  expect((await standingView(s.host)).grants).toEqual([])
  expect(await tryNow(s, 'ado-pr-thread-status', { ...STATUS, thread: 71 }, 't6')).toBeNull()
  expect(s.writers()).toHaveLength(0)
  // a model's free-text answer or an answer to a question without the third choice records nothing
  const v = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 72 }, 't6')
  const q = questionOf(v)
  const three = { question: q.question, options: q.options.slice(0, 3) }
  const fake = await bindAnswers(s.host, [three], { [q.question]: STANDING_LABEL }, s.tell)
  expect(fake.join(' ')).toContain('was NOT recorded')
  const free = await bindAnswers(s.host, [{ question: q.question, options: q.options }], { [q.question]: 'yes, allow it for a day' }, s.tell)
  expect(free).toEqual([])
  expect((await standingView(s.host)).grants).toEqual([])
})

test('a session cannot write config.json (where the user\'s rule lives): a thread and a worker are refused', { timeoutMs: 20_000 }, async () => {
  orchReset()
  const h = fakeHost(null, { orchestrate: true }) // (the execution model is off in specs unless one opts in)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  const run = (e: any, agentType?: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', agentType, agentId: agentType ? 'a1' : undefined }, e)
  const cfg = `${L}/config.json`
  const got: Record<string, string | null> = {
    'thread Write': await run({ tool: 'Write', file_path: cfg }),
    'thread Edit': await run({ tool: 'Edit', file_path: cfg }),
    'worker Edit': await run({ tool: 'Edit', file_path: cfg }, 'lean-agent:worker-haiku'),
    'worker redirect': await run({ tool: 'Bash', command: `echo '{"actions":{"standing":[]}}' > ${cfg}` }, 'lean-agent:worker-haiku'),
    'worker sed -i': await run({ tool: 'Bash', command: `sed -i s/a/b/ ${cfg}` }, 'lean-agent:worker-haiku'),
  }
  expect(Object.entries(got).filter(([, v]) => !v).map(([k]) => k)).toEqual([])
})
