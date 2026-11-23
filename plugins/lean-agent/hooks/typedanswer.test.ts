// 1.0.28 free text in the desk's dialog is never silently dropped: a clear typed approval is the Approve press for exactly that request (and "always" / "allow" the
// fourth choice); anything else is said to the desk in one line. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, approveAction, bindAnswers, listActions, questionOf, resetActions } from './deskactions'
import { writesView } from './deskwrites'
import { typedApproval } from './writeinstr'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const P = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }
const REPLY = { ...P, thread: 7, body: 'Fixed in the next commit.' }

function setup() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: 'TOKEN-0123456789\n' } : argv[0] === 'curl' ? { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) } : { exitCode: 127, stdout: '', stderr: 'unknown' })
  const told: string[] = []
  return { h, host: h.host, told, tell: async (_t: string, x: string) => void told.push(x), writers: () => h.calls.filter(c => c.argv[0] === 'curl') }
}
type S = ReturnType<typeof setup>
const type = async (s: S, kind: string, params: Record<string, unknown>, text: string, mutate: (q: { question: string; options: { label: string; description: string }[] }) => void = () => undefined) => {
  const made = await addActionRequest(s.host, 't5', { kind, params, why: 'x' })
  expect(made.ok, made.text).toBe(true)
  const q = questionOf(made.request!)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  mutate(qq)
  const notes = await bindAnswers(s.host, [qq], { [qq.question]: text }, s.tell)
  return { id: made.request!.id, notes, state: (await listActions(s.host, true)).find(r => r.id === made.request!.id)?.state }
}

test('the script table: clear approvals count, any negation or wish to change refuses the whole text, "always" / "allow" is the fourth choice', () => {
  for (const t of ['approve', 'Approved', 'yes', 'OK', 'okay', 'go ahead', 'do it', 'always approve', 'allow', 'fine', 'Yes, go ahead', 'ALWAYS APPROVE THIS!', 'Always approve actions like this', 'ok, fine.']) expect([t, typedApproval(t).approve]).toEqual([t, true])
  for (const t of ['always approve', 'ALWAYS APPROVE THIS!', 'Always approve actions like this', 'allow', 'yes, allow it']) expect([t, typedApproval(t).always]).toEqual([t, true])
  for (const t of ['approve', 'yes', 'ok', 'go ahead', 'do it', 'fine']) expect([t, typedApproval(t).always]).toEqual([t, false])
  for (const t of ['not now', "don't", 'don’t approve', 'do not approve it', 'no', 'No, approve nothing', 'never', 'deny', 'reject', 'cancel', 'wait', 'stop', 'yes but change the text', 'ok, wait for the build', 'approve, do not send', 'I do not allow it', 'never approve']) expect([t, typedApproval(t).approve]).toEqual([t, false])
  for (const t of ['', '   ', 'tell me more', 'sounds interesting', 'disapprove', 'okayish', 'x'.repeat(130) + ' yes']) expect([t, typedApproval(t).approve]).toEqual([t, false])
})

test('a typed approval is the Approve press for exactly that request: it is sent by approve-action, logged, and nothing else is approved', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const r = await type(s, 'ado-pr-reply', REPLY, 'yes, go ahead')
  expect(r.notes.join(' ')).toContain(`the user approved ${r.id}`)
  expect(r.state).toBe('approved')
  expect((await writesView(s.host)).grants).toEqual([]) // plain approval: no grant
  expect((await approveAction(s.host, r.id, s.tell)).ok).toBe(true)
  expect(s.h.files.get(`${L}/threads/t5/history.jsonl`)).toContain('"kind":"typed-approval"')
  const other = await addActionRequest(s.host, 't5', { kind: 'ado-pr-reply', params: { ...REPLY, thread: 8, body: 'Another.' }, why: 'x' })
  expect((await listActions(s.host)).find(v => v.id === other.request!.id)?.state).toBe('pending') // a typed word never carries to the next request
})

test('"ALWAYS APPROVE THIS!" / "Always approve actions like this" is the fourth choice where the request carries it, else the plain Approve of this request, and says so', { timeoutMs: 20_000 }, async () => {
  for (const text of ['ALWAYS APPROVE THIS!', 'Always approve actions like this']) {
    const s = setup()
    const r = await type(s, 'ado-pr-reply', REPLY, text)
    expect(r.notes.join(' ')).toContain('allowed this kind of write')
    expect((await writesView(s.host)).grants).toHaveLength(1)
    expect((await approveAction(s.host, r.id, s.tell)).ok).toBe(true)
    // the next reply on that PR goes out without a question (the grant is in force)
  }
  const s = setup()
  const c = await type(s, 'ado-pr-comment', { ...P, body: 'A new top-level comment.' }, 'always approve')
  expect(c.state).toBe('approved')
  expect(c.notes.join(' ')).toContain('it cannot be allowed for 24 h, only this request was approved')
  expect((await writesView(s.host)).grants).toEqual([])
})

test('a negation or any other free text is no approval and is said, with the first 80 characters and the way out; nothing is dropped silently', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const a = await type(s, 'ado-pr-reply', REPLY, 'no, do not send that')
  expect(a.state).toBe('pending')
  expect(a.notes).toEqual([`the user typed 'no, do not send that': free text is not an approval for this request; ask again with the choices, or the user can type /lean-agent:allow t5 42`])
  const long = 'please reconsider the wording of the second sentence and mention the build number that fixed it, and also thank the reviewer properly'
  const b = await type(s, 'ado-pr-reply', { ...REPLY, thread: 8 }, long)
  expect(b.state).toBe('pending')
  expect(b.notes[0]).toContain(`the user typed '${long.slice(0, 80)}': free text is not an approval`)
  expect(b.notes[0]).not.toContain(long.slice(0, 81))
  expect(s.writers()).toHaveLength(0)
})

test('a typed answer to a question that is not the canonical one records nothing (the same check as a pressed label)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const r = await type(s, 'ado-pr-reply', REPLY, 'yes', q => {
    q.question = q.question.replace('Fixed in the next commit.', 'Something else.')
  })
  expect(r.notes.join(' ')).toContain('was NOT recorded')
  expect(r.state).toBe('pending')
  const o = await type(s, 'ado-pr-reply', { ...REPLY, thread: 9 }, 'yes', q => {
    q.options = q.options.slice(0, 2)
  })
  expect(o.notes.join(' ')).toContain('was NOT recorded')
})
