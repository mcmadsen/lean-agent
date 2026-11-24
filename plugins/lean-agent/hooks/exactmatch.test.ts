// 1.0.31 (safety): an answer maps to an option ONLY by its exact label; a plain Approve never makes a standing approval; every standing record says where the choice came
// from and is checked against the answer on record; an answer that is not recorded says exactly why (id, check code, text, state); a request leaves the pending list only by
// executed, denied, expired or withdrawn, each with its reason on the record and a line to the thread and the desk. Canned curl / gh output, synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { STANDING_LABEL, STANDING_LABEL_WI, addActionRequest, actionListText, answerAction, approveAction, bindAnswers, dropActions, flaggedGrants, listActions, questionOf, resetActions, standingView, sweepExpired, withdrawAction, withdrawByWords } from './deskactions'
import { auditStanding, revokeWrites, writesListText, writesView } from './deskwrites'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const HOUR = 3_600_000
const P = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }
const STATUS = { ...P, thread: 11, status: 'fixed' }
const LINK = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, workitem: 1234 }
const WI = (state: string, id = 1234) => ({ org: 'acme', project: 'Shop App', id, fields: { state } })
const OLD_GENERIC = "did not name that request's id, check code and exact text"

function setup(cfg: Record<string, unknown> = {}) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/config.json`, JSON.stringify({ actions: { holdSeconds: 0, ...cfg } }))
  for (const t of ['t5', 't6']) h.files.set(`${L}/threads/${t}/thread.json`, JSON.stringify({ id: t, title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: 'TOKEN-0123456789\n' }
    if (argv[0] === 'curl' && argv[argv.indexOf('-X') + 1] === 'GET') return { exitCode: 0, stdout: JSON.stringify({ id: argv[argv.length - 1]!.includes('/_apis/projects/') ? '11111111-2222-3333-4444-555555555555' : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) }
    if (argv[0] === 'curl') return { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const told: string[] = []
  const tell = async (_t: string, text: string) => void told.push(text)
  const writers = () => h.calls.filter(c => c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] !== 'GET')
  return { h, host: h.host, tell, told, writers }
}
type S = ReturnType<typeof setup>
const ask = async (s: S, kind: string, params: Record<string, unknown>, thread = 't5') => {
  const r = await addActionRequest(s.host, thread, { kind, params, why: 'x' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
type V = Parameters<typeof questionOf>[0]
const optsOf = (v: V) => questionOf(v).options.map(o => ({ label: o.label, description: o.description }))
const pressQ = (s: S, question: string, v: V, label: string) => bindAnswers(s.host, [{ question, options: optsOf(v) }], { [question]: label }, s.tell)
const press = (s: S, v: V, label: string) => pressQ(s, questionOf(v).question, v, label)
const record = async (s: S, id: string) => ((await s.host.store.get('action.requests')) as { id: string; exit?: { kind: string; reason: string; ts: number } }[]).find(r => r.id === id)
const notice = (s: S, id: string) => s.h.files.get(`${L}/notices/request-exit.${id}.txt`)
const stateOfId = async (s: S, id: string) => (await listActions(s.host, true)).find(x => x.id === id)?.state

test('1: a plain Approve is executed once and never makes a standing approval (status change, work item state, PR link)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  for (const [kind, params] of [['ado-pr-thread-status', STATUS], ['ado-workitem-update', WI('Active')], ['ado-pr-workitem-link', LINK]] as const) {
    const v = await ask(s, kind, params)
    const notes = await press(s, v, 'Approve')
    expect(notes.join(' ')).not.toContain('24 h')
    const before = s.writers().length
    expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(true)
    expect(s.writers().length).toBe(before + 1) // exactly once
    expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(false) // and not twice
  }
  expect((await standingView(s.host)).grants).toEqual([])
  expect((await writesView(s.host)).grants).toEqual([])
})

test('1: the standing option counts only by its EXACT label, and the record says it was the dialog option', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Active'))
  const notes = await press(s, v, STANDING_LABEL_WI)
  expect(notes.join(' ')).toContain('allowed this kind of write')
  const g = (await writesView(s.host)).grants[0]!
  expect(g.quote).toContain(`you chose "${STANDING_LABEL_WI}" in the desk's dialog on request ${v.id}`)
  const t = await ask(s, 'ado-pr-thread-status', STATUS)
  await press(s, t, STANDING_LABEL)
  expect((await standingView(s.host)).grants.length).toBe(1)
})

test('1: an answer that merely starts with Approve, or differs in case or length, never makes a standing approval', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  for (const [i, text] of ['Approve it please', 'Approve!', 'approve', 'Approve, send it once', '  Approve  '].entries()) {
    const v = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 20 + i })
    await press(s, v, text)
    expect([text, await stateOfId(s, v.id)]).toEqual([text, 'approved']) // (a clear approval, once)
  }
  expect((await standingView(s.host)).grants).toEqual([])
  expect((await writesView(s.host)).grants).toEqual([])
})

test('1: the standing label of the OTHER kind (work item label on a PR request) is not one of the options offered: not recorded, still pending', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-thread-status', STATUS)
  const notes = await press(s, v, STANDING_LABEL_WI)
  expect(notes.join(' ')).toContain('is not exactly one of the options offered')
  expect(await stateOfId(s, v.id)).toBe('pending')
  expect((await standingView(s.host)).grants).toEqual([])
})

test('1: typed words that clearly say "always" are the standing choice (1.0.28) and the record says typed words', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Active'))
  await press(s, v, 'always approve')
  expect((await writesView(s.host)).grants[0]!.quote).toContain(`you typed "always approve" in the desk's dialog on request ${v.id}`)
})

test('2: the pane button records where it came from, executes the request, and the grant is not flagged', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Active'))
  expect((await answerAction(s.host, v.id, 'approve', 'pane', s.tell, true)).ok).toBe(true)
  expect((await approveAction(s.host, v.id, s.tell)).ok).toBe(true)
  expect(s.writers().length).toBe(1) // the pane press sent the request itself
  const g = (await writesView(s.host)).grants[0]!
  expect(g.quote).toContain(`you pressed "${STANDING_LABEL_WI}" in the pane on request ${v.id}`)
  expect(g.used).toBe(0) // (the user's own approved send is not counted against the 40: 0/40 is right)
  expect(await auditStanding(s.host)).toEqual([])
  expect((await writesView(s.host)).grants.length).toBe(1)
  expect((await record(s, v.id))!.exit).toMatchObject({ kind: 'executed' })
})

test('2: a standing record with no matching press is flagged "recorded without your choice", revoked, and kept as evidence (work item grant and status grant)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const a = await ask(s, 'ado-workitem-update', WI('Active'))
  await answerAction(s.host, a.id, 'approve', 'pane', s.tell, true)
  const b = await ask(s, 'ado-pr-thread-status', STATUS)
  await answerAction(s.host, b.id, 'approve', 'ask', s.tell, true)
  expect((await writesView(s.host)).grants.length + (await standingView(s.host)).grants.length).toBe(2)
  s.h.store.delete(`action.answer.${a.id}`) // the answers the grants rest on are gone
  s.h.store.delete(`action.answer.${b.id}`)
  const flagged = await auditStanding(s.host)
  expect(flagged.length).toBe(2)
  expect((await writesView(s.host)).grants).toEqual([])
  expect((await standingView(s.host)).grants).toEqual([])
  const ev = await flaggedGrants(s.host)
  expect(ev.length).toBe(2)
  expect(ev[0]!.reason).toContain('no answer of yours is on record')
  expect(ev[0]!.quote).toContain('you pressed') // the evidence keeps the recorded words
  expect([...s.h.files.keys()].filter(k => k.includes('/notices/grant-flag.')).length).toBe(2)
  expect(String([...s.h.files.entries()].find(([k]) => k.includes('/notices/grant-flag.'))![1])).toContain('recorded without your choice')
  expect(await writesListText(s.host)).toContain('REVOKED because they were recorded without the user\'s choice')
})

test('2: a grant that says "pane" but whose answer came from the dialog is flagged too; a legacy quote with an Approve on record is not', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const a = await ask(s, 'ado-workitem-update', WI('Active'))
  await answerAction(s.host, a.id, 'approve', 'ask', s.tell, true) // the dialog's choice
  const g = (await writesView(s.host)).grants[0]!
  expect(g.quote).toContain("in the desk's dialog")
  expect(await auditStanding(s.host)).toEqual([])
  await revokeWrites(s.host, { id: g.id })
})

test('3: every refusal names its reason: no such request, resolved (executed / denied / expired / withdrawn), not pending, id, check code, text', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-thread-status', STATUS)
  const q = questionOf(v).question
  const reasons: Record<string, string> = {}
  const tryq = async (name: string, question: string, vv: V = v) => {
    const notes = await pressQ(s, question, vv, 'Approve')
    reasons[name] = notes.join(' ')
    expect(reasons[name], name).toContain('was NOT recorded')
    expect(reasons[name], name).not.toContain(OLD_GENERIC)
  }
  await tryq('none', q.replace(v.id, 'a999-9'))
  expect(reasons.none).toContain('no such request')
  const o = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 12 })
  await tryq('id', `${q}\n(see also ${o.id})`)
  expect(reasons.id).toContain('id mismatch')
  await tryq('code', q.replace(/check [0-9a-f]{12}/, 'check deadbeef0000'))
  expect(reasons.code).toMatch(/check code mismatch: the question says deadbeef0000, request \S+ has [0-9a-f]{12}/)
  await tryq('text', q.replace(`\n---\n${v.text}`, `\n---\n${v.text} EXTRA`))
  expect(reasons.text).toContain('text differs in the exact text to be sent, first at character')
  expect(reasons.text).toContain('EXTRA')
  await tryq('target', q.replace('Send exactly this?', 'Send it?'))
  expect(reasons.target).toContain('text differs in the target line')
  await tryq('head', q.replace('wants to', 'would like to'))
  expect(reasons.head).toContain('text differs in the heading line')
  expect(await stateOfId(s, v.id)).toBe('pending') // none of those moved it
  expect(reasons.code).toContain('still pending')
  // not pending (approved already), executed, denied, expired, withdrawn
  await press(s, v, 'Approve')
  await tryq('approved', q)
  expect(reasons.approved).toContain('not pending (already approved and waiting to be sent')
  await approveAction(s.host, v.id, s.tell)
  await tryq('executed', q)
  expect(reasons.executed).toContain('already resolved (executed: sent at')
  const d = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 13 })
  await answerAction(s.host, d.id, 'deny', 'pane', s.tell)
  await tryq('denied', questionOf(d).question, d)
  expect(reasons.denied).toContain('already resolved (denied)')
  const w = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 14 })
  await withdrawAction(s.host, w.id, 'you rejected it in chat', s.tell)
  await tryq('withdrawn', questionOf(w).question, w)
  expect(reasons.withdrawn).toContain('already resolved (withdrawn: you rejected it in chat)')
  const x = await ask(s, 'ado-pr-thread-status', { ...STATUS, thread: 15 })
  s.h.clock.t += 25 * HOUR
  await tryq('expired', questionOf(x).question, x)
  expect(reasons.expired).toContain('already resolved (expired after 24 h)')
})

test('3: a question with no request header, and several options changed, say so', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-thread-status', STATUS)
  const q = questionOf(v).question
  const a = await pressQ(s, q.replace(/\[request [^\]]*\]/, `(${v.id})`), v, 'Approve')
  expect(a.join(' ')).toContain('has no "[request <id>, check <code>]" part')
  const b = await bindAnswers(s.host, [{ question: q, options: optsOf(v).slice(0, 2) }], { [q]: 'Approve' }, s.tell)
  expect(b.join(' ')).toContain('the options differ')
  const c = await bindAnswers(s.host, [{ question: q, options: optsOf(v), multiSelect: true }], { [q]: 'Approve' }, s.tell)
  expect(c.join(' ')).toContain('multiSelect')
  expect(await stateOfId(s, v.id)).toBe('pending')
})

test('5: the report: a plain Approve with a pasted question that does not match is not executed, stays pending, says which part differs, and makes no standing approval', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const link = await ask(s, 'ado-pr-workitem-link', LINK)
  const upd = await ask(s, 'ado-workitem-update', WI('Resolved'))
  for (const v of [link, upd]) {
    const pasted = questionOf(v).question.replace(v.text, v.text.replace(/\s+/g, ' ')).replace('Send exactly this?', 'Send exactly this? ')
    const notes = await pressQ(s, pasted, v, 'Approve')
    expect(notes.join(' ')).toContain(`question about ${v.id} was NOT recorded: text differs in`)
    expect(notes.join(' ')).toContain('still pending')
    expect(await stateOfId(s, v.id)).toBe('pending')
  }
  expect(s.writers().length).toBe(0)
  expect((await standingView(s.host)).grants).toEqual([])
  expect((await writesView(s.host)).grants).toEqual([])
  expect((await listActions(s.host)).map(v => v.id).sort()).toEqual([link.id, upd.id].sort()) // neither left the list
  // and what the report was told next: Approve on the card in the pane executes it once
  expect((await answerAction(s.host, link.id, 'approve', 'pane', s.tell)).ok).toBe(true)
  expect((await approveAction(s.host, link.id, s.tell)).ok).toBe(true)
  expect(s.writers().length).toBe(1)
})

test('4: expiry (default 24 h, config actions.pendingHours): unsent, on the record with the reason and time, and the thread and the desk are told', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-thread-status', STATUS)
  expect(v.exp - v.ts).toBe(24 * HOUR)
  s.h.clock.t += 23 * HOUR
  expect(await sweepExpired(s.host, s.tell)).toEqual([])
  expect(await stateOfId(s, v.id)).toBe('pending')
  s.h.clock.t += 2 * HOUR
  const text = await actionListText(s.host, s.tell)
  expect(text).toContain(`request ${v.id} expired unsent: nobody decided in 24 h`)
  expect(s.told.join('\n')).toContain(`request ${v.id} expired unsent: nobody decided in 24 h`)
  expect(notice(s, v.id)).toContain(`request ${v.id} expired unsent: nobody decided in 24 h`) // the desk's line
  expect(await record(s, v.id)).toMatchObject({ exit: { kind: 'expired', reason: 'nobody decided in 24 h', ts: s.h.clock.t } })
  expect((await listActions(s.host)).length).toBe(0)
  expect(await actionListText(s.host, s.tell)).toContain(`${v.id} · t5 · ado-pr-thread-status · expired: nobody decided in 24 h`) // still visible in the list of recent exits
  expect(s.told.length).toBe(1) // told once
  const s2 = setup({ pendingHours: 2 })
  const w = await ask(s2, 'ado-pr-thread-status', STATUS)
  expect(w.exp - w.ts).toBe(2 * HOUR)
  const s3 = setup({ pendingHours: 'garbage' })
  expect((await ask(s3, 'ado-pr-thread-status', STATUS)).exp - (await s3.host.clock.now())).toBe(24 * HOUR)
})

test('4: withdraw needs a reason, ends the request unsent, tells the thread and the desk, and a later Approve cannot send it', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Active'))
  const none = await withdrawAction(s.host, v.id, '  ', s.tell)
  expect(none.ok).toBe(false)
  expect(await stateOfId(s, v.id)).toBe('pending')
  const out = await withdrawAction(s.host, v.id, 'you rejected it in chat', s.tell)
  expect(out.ok).toBe(true)
  expect(s.told.join('\n')).toContain(`request ${v.id} withdrawn unsent: you rejected it in chat`)
  expect(notice(s, v.id)).toContain('withdrawn unsent: you rejected it in chat')
  expect(await record(s, v.id)).toMatchObject({ exit: { kind: 'withdrawn', reason: 'you rejected it in chat' } })
  expect((await approveAction(s.host, v.id, s.tell)).text).toContain('was withdrawn')
  expect(s.writers().length).toBe(0)
  expect((await withdrawAction(s.host, v.id, 'again', s.tell)).text).toContain('already resolved (withdrawn')
  // an approved one that was not sent yet can be withdrawn too
  const a = await ask(s, 'ado-workitem-update', WI('Resolved'))
  await answerAction(s.host, a.id, 'approve', 'pane', s.tell)
  expect((await withdrawAction(s.host, a.id, 'changed my mind', s.tell)).ok).toBe(true)
  expect((await approveAction(s.host, a.id, s.tell)).ok).toBe(false)
  expect(s.writers().length).toBe(0)
})

test('4: typed words "withdraw <id>" (a recorded human prompt) withdraw that request; other words do nothing', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-workitem-update', WI('Active'))
  expect(await withdrawByWords(s.host, `please do not send ${v.id}`, s.tell)).toBe(0)
  expect(await withdrawByWords(s.host, 'withdraw everything', s.tell)).toBe(0)
  expect(await stateOfId(s, v.id)).toBe('pending')
  expect(await withdrawByWords(s.host, `withdraw ${v.id}: I do not want a work item for this`, s.tell)).toBe(1)
  expect(await stateOfId(s, v.id)).toBe('withdrawn')
  expect(s.told.join('\n')).toContain('withdrawn unsent: you said so')
})

test('4: a Deny and a closed thread are exits with a reason on the record; a failed send that sent nothing is NOT an exit (it can be retried)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const d = await ask(s, 'ado-workitem-update', WI('Active'))
  await answerAction(s.host, d.id, 'deny', 'pane', s.tell)
  expect(await record(s, d.id)).toMatchObject({ exit: { kind: 'denied', reason: 'you denied it' } })
  expect(notice(s, d.id)).toContain(`request ${d.id} denied`)
  const c = await ask(s, 'ado-workitem-update', WI('Resolved'), 't6')
  await dropActions(s.host, 't6')
  expect(await record(s, c.id)).toMatchObject({ exit: { kind: 'withdrawn', reason: 't6 was closed' } })
  expect(notice(s, c.id)).toContain('withdrawn unsent: t6 was closed')
  const f = await ask(s, 'ado-workitem-update', WI('Active', 99))
  await answerAction(s.host, f.id, 'approve', 'pane', s.tell)
  s.h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: 'TOKEN-0123456789\n' } : { exitCode: 22, stdout: '', stderr: 'HTTP 500' })
  expect((await approveAction(s.host, f.id, s.tell)).ok).toBe(false)
  expect((await record(s, f.id))!.exit).toBeUndefined()
  expect(await stateOfId(s, f.id)).toBe('approved') // still there, to try again
})

test('4: finished requests make room first; an open request is never dropped for room', { timeoutMs: 30_000 }, async () => {
  const s = setup()
  const first = await ask(s, 'ado-workitem-update', WI('Active', 1))
  for (let i = 2; i <= 45; i++) {
    const t = i % 2 ? 't5' : 't6'
    const v = await ask(s, 'ado-workitem-update', WI('Active', i), t)
    if (i > 6) await withdrawAction(s.host, v.id, 'test', s.tell)
    s.h.clock.t += 1000
  }
  expect(await stateOfId(s, first.id)).toBe('pending')
  expect(((await s.host.store.get('action.requests')) as unknown[]).length).toBeLessThanOrEqual(40)
})
