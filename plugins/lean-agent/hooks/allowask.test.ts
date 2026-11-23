// 1.0.28 the refusal says what the mod can SEE and carries a canonical question; `allow-ask` makes a signed grant offer whose answer in the desk's dialog is the
// written yes (read by the mod from the tool result, exactly like an action approval). Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, resetActions } from './deskactions'
import { allowWrites, askWrites, bindOfferAnswers, runGranted, writesView } from './deskwrites'
import { recordHumanPrompt } from './humanprompts'
import { leanThread, resetLocks } from './threads'

const L = '/h/.lean-agent'
const REPLY = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }

function setup() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: 'TOKEN-0123456789\n' } : argv[0] === 'curl' ? { exitCode: 0, stdout: JSON.stringify({ id: 77 }) } : { exitCode: 127, stdout: '', stderr: 'unknown' })
  return { h, host: h.host }
}
type S = ReturnType<typeof setup>
type Asked = { question: string; options: { label: string; description: string }[] }
const offer = async (s: S, target: unknown = { pr: 42 }, kinds?: unknown): Promise<Asked> => {
  const o = await askWrites(s.host, 't5', target, kinds)
  expect(o.ok, o.text).toBe(true)
  return o.ask!
}
// what the desk's hook passes after the user answered: the questions as asked and the tool result's answers
const answer = (s: S, q: Asked, text: string, mutate: (q: Asked) => void = () => undefined) => {
  const qq: Asked = { question: q.question, options: q.options.map(o => ({ ...o })) }
  mutate(qq)
  return bindOfferAnswers(s.host, [qq], { [qq.question]: text })
}

test('a refusal says what the mod can see (the time of the last recorded prompt), the plain-text hint, and carries the canonical question', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const none = await allowWrites(s.host, 't5', { pr: 42 })
  expect(none.ok).toBe(false)
  expect(none.text).toContain('no message typed by you in the last 24 h names PR acme/Shop App/shop-api#42')
  expect(none.text).toContain('To proceed, in order: (a) the USER writes the PR and the go as plain words in the CHAT box (e.g. "post the comments on PR 42")')
  expect(none.text).toContain('(never in a shell box, never in a code fence); (b) or ask with AskUserQuestion (allow-ask)')
  expect(none.text).toContain('recorded prompts: 0, none names PR 42')
  expect(none.ask!.question).toMatch(/^Allow t5 to post replies and comments and link work items on PR 42 and move its own work item to Reviewing for 24 h\? \[offer o\d+-\d+, check [0-9a-f]{12}\]$/)
  expect(none.ask!.options.map(o => o.label)).toEqual(['Allow', 'Not now'])
  expect(none.text).toContain(JSON.stringify(none.ask!.question)) // the same reply carries it: the desk is never left with only a refusal
  await recordHumanPrompt(s.host, { text: 'thanks, looks fine', origin: { kind: 'composer' } })
  const some = await allowWrites(s.host, 't5', { pr: 42 })
  expect(some.text).toContain('no message typed by you since 00:16 UTC names PR acme/Shop App/shop-api#42')
  // through lean_thread the refusal carries the question as data
  const t = await leanThread(s.host, '/p', { action: 'allow-writes', tN: 't5', target: { pr: 42 } })
  expect(t.ok).toBe(false)
  expect((t.data as { ask: Asked }).ask.options.map(o => o.label)).toEqual(['Allow', 'Not now'])
  // asking again is the same offer
  expect((await allowWrites(s.host, 't5', { pr: 42 })).ask!.question).toBe(some.ask!.question)
  expect((await writesView(s.host)).grants).toEqual([])
})

test('a refusal lists what was recorded; the same refusal twice with nothing new typed says "ask with AskUserQuestion now"; a new prompt gets the full text again', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await recordHumanPrompt(s.host, { text: 'thanks, looks fine', origin: { kind: 'composer' } })
  await recordHumanPrompt(s.host, { text: 'PR 42 looks big', origin: { kind: 'composer' } })
  const a = await allowWrites(s.host, 't5', { pr: 42 })
  expect(a.text).toContain('recorded prompts: 2, 1 names PR 42 but none asks for the work')
  expect(a.text).toContain('To proceed, in order')
  const b = await allowWrites(s.host, 't5', { pr: 42 })
  expect(b.ok).toBe(false)
  expect(b.text).toContain('refused again, nothing new was typed since (recorded prompts: 2')
  expect(b.text).toContain('Ask with AskUserQuestion now')
  expect(b.text).not.toContain('To proceed, in order')
  expect(b.ask!.question).toBe(a.ask!.question) // the same canonical question: the Allow answer is the written yes
  await recordHumanPrompt(s.host, { text: 'and the second one', origin: { kind: 'composer' } })
  expect((await allowWrites(s.host, 't5', { pr: 42 })).text).toContain('To proceed, in order')
  // the offered question is the one allow-writes granted by: an Allow answer makes the grant through the dialog path
  const r = await answer(s, b.ask!, 'Allow')
  expect(r.granted.length).toBe(1)
  expect((await writesView(s.host)).grants.length).toBe(1)
})

test('allow-ask returns the canonical question; an Allow answer creates the grant (24 h, cap, history "by the user in a dialog"); nothing else does', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const viaTool = await leanThread(s.host, '/p', { action: 'allow-ask', tN: 't5', target: { pr: 42 } })
  expect(viaTool.ok, viaTool.text).toBe(true)
  const q = (viaTool.data as { ask: Asked }).ask
  expect(viaTool.text).toContain('Allow, Not now')
  expect((await writesView(s.host)).grants).toEqual([]) // the offer alone grants nothing
  expect(await runGranted(s.host, (await addActionRequest(s.host, 't5', { kind: 'ado-pr-reply', params: REPLY, why: 'x' })).request!.id)).toBeNull()
  const r = await answer(s, q, 'Allow')
  expect(r.notes.join(' ')).toContain('the user allowed t5 on PR acme/Shop App/shop-api#42: reply, comment, link')
  expect(r.granted).toEqual([{ thread: 't5', target: { scope: 'Azure DevOps PR acme/Shop App/shop-api#42', type: 'pr', n: 42 } }])
  const [g] = (await writesView(s.host)).grants
  expect(g).toMatchObject({ thread: 't5', scope: 'Azure DevOps PR acme/Shop App/shop-api#42', kinds: ['reply', 'comment', 'link'], cap: 40, used: 0 })
  expect(g!.quote).toContain('you answered Allow in a dialog')
  expect(g!.exp - (await s.host.clock.now())).toBe(24 * 3_600_000)
  expect(s.h.files.get(`${L}/threads/t5/history.jsonl`)).toContain('"by":"the user in a dialog"')
  const next = await addActionRequest(s.host, 't5', { kind: 'ado-pr-reply', params: { ...REPLY, thread: 8, body: 'Thanks.' }, why: 'x' })
  expect((await runGranted(s.host, next.request!.id))?.sent).toBe(true) // the grant is in force
  // the offer was used: the same answer again records nothing
  expect((await answer(s, q, 'Allow')).notes.join(' ')).toContain('was NOT recorded')
})

test('Not now, a negation and any other text grant nothing; a typed clear approval counts like the label', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const q = await offer(s)
  const no = await answer(s, q, 'Not now')
  expect(no.notes.join(' ')).toContain('Not now')
  expect((await writesView(s.host)).grants).toEqual([])
  expect((await answer(s, q, 'Allow')).notes.join(' ')).toContain('was NOT recorded') // Not now closed the offer
  const q2 = await offer(s, { pr: 43 })
  for (const t of ['no, not now', 'tell me more first', "don't allow it", 'allow it but only replies']) {
    const r = await answer(s, q2, t)
    expect([t, r.notes.join(' ').includes('free text is not an Allow')]).toEqual([t, true])
  }
  expect((await answer(s, q2, '')).notes).toEqual([])
  expect((await writesView(s.host)).grants).toEqual([])
  expect((await answer(s, q2, 'yes, go ahead')).notes.join(' ')).toContain('the user allowed t5')
  expect((await writesView(s.host)).grants[0]!.quote).toContain('you answered "yes, go ahead" in a dialog')
})

test('only the canonical question counts: another text, other options, a multi-select, an expired, a forged or an unknown offer record nothing; a model call cannot create it', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const q = await offer(s)
  const bad: [string, (q: Asked) => void][] = [
    ['text', x => void (x.question = x.question.replace('replies', 'everything'))],
    ['options', x => void (x.options = x.options.slice(0, 1))],
    ['description', x => void (x.options[0]!.description = 'the mod allows anything')],
  ]
  for (const [what, mutate] of bad) expect([what, (await answer(s, q, 'Allow', mutate)).notes.join(' ').includes('was NOT recorded')]).toEqual([what, true])
  const multi = await bindOfferAnswers(s.host, [{ question: q.question, options: q.options, multiSelect: true }], { [q.question]: 'Allow' })
  expect(multi.notes.join(' ')).toContain('was NOT recorded')
  expect((await bindOfferAnswers(s.host, [{ question: q.question, options: q.options }], undefined)).notes).toEqual([]) // no readable answers: nothing
  expect((await writesView(s.host)).grants).toEqual([])
  // a forged row in the store is no offer
  const code = /check ([0-9a-f]{12})/.exec(q.question)![1]!
  const fake = q.question.replace(/offer o\d+-\d+/, 'offer o1-99').replace(code, 'aaaaaaaaaaaa')
  s.h.host.store.set('action.writes.offers', [{ id: 'o1-99', thread: 't5', scope: 'Azure DevOps PR acme/Shop App/shop-api#42', type: 'pr', n: 42, create: false, kinds: ['reply'], ts: 1, exp: 9e15, sig: 'ab'.repeat(32) }])
  expect((await answer(s, { question: fake, options: q.options }, 'Allow')).notes.join(' ')).toContain('was NOT recorded')
  expect((await writesView(s.host)).grants).toEqual([])
  // expired after 2 h
  const s2 = setup()
  const q2 = await offer(s2)
  s2.h.clock.t += 3 * 3_600_000
  expect((await answer(s2, q2, 'Allow')).notes.join(' ')).toContain('was NOT recorded')
  expect((await writesView(s2.host)).grants).toEqual([])
  // no model call makes a grant: allow-writes without the user's words, a report, a request
  expect((await allowWrites(s2.host, 't5', { pr: 42 })).ok).toBe(false)
  expect((await writesView(s2.host)).grants).toEqual([])
})

test('allow-ask: kinds narrow the question, a work item and a create have their own wording, a closed thread or a bad kind is refused', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  expect((await offer(s, { pr: 42 }, ['status'])).question).toContain('Allow t5 to set thread statuses on PR 42 and move its own work item to Reviewing for 24 h?')
  expect((await offer(s, { workitem: 1234 })).question).toContain('Allow t5 to comment on and update work item 1234 for 24 h?')
  expect((await offer(s, { workitem: 'new' })).question).toContain('Allow t5 to create work items in acme/Shop App for 24 h?')
  expect((await askWrites(s.host, 't5', { pr: 42 }, ['merge'])).ok).toBe(false)
  expect((await askWrites(s.host, 't9', { pr: 42 })).ok).toBe(false)
  s.h.files.set(`${L}/threads/t6/thread.json`, JSON.stringify({ id: 't6', title: 'x', project: 'app', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  expect((await askWrites(s.host, 't6', { pr: 42 })).text).toContain('closed')
  const g = await bindOfferAnswers(s.host, [{ question: (await offer(s, { workitem: 'new' })).question, options: (await offer(s, { workitem: 'new' })).options }], { [(await offer(s, { workitem: 'new' })).question]: 'Allow' })
  expect(g.granted).toEqual([{ thread: 't5', target: undefined }]) // a create grant names no existing PR or work item to own
  expect((await writesView(s.host)).grants[0]!.kinds).toEqual(['create'])
})
