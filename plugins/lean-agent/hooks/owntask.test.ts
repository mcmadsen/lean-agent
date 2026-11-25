// Only your own tasks are moved (owntask.ts): the work item must be assigned to the user AND the PR created by the user, read from the forge (canned JSON), at request time
// and again at send time; a failed read is never ok; a comment is not a move; the user's typed words lift it for one work item; config workitems.onlyOwn false. Synthetic names.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, answerAction, approveAction, listActions, resetActions } from './deskactions'
import { moveAllowed, ownTask, resetOwnTask } from './owntask'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const ME = { id: 'aaaa-1111', providerDisplayName: 'Joe Example', properties: { Account: { $value: 'joe@example.test' } } }
const JOE = { id: 'aaaa-1111', displayName: 'Joe Example', uniqueName: 'joe@example.test' }
const ANN = { id: 'bbbb-2222', displayName: 'Ann Example', uniqueName: 'ann@example.test' }
const BOB = { id: 'cccc-3333', displayName: 'Bob Example', uniqueName: 'bob@example.test' }
const T = { org: 'acme', project: 'Shop App', repo: 'shop-api' }
const LINK = { kind: 'ado-pr-workitem-link', params: { ...T, pr: 4271, workitem: 4210 } }
const STATE = { kind: 'ado-workitem-update', params: { org: 'acme', project: 'Shop App', id: 4210, fields: { state: 'Reviewing' } } }
const TITLE = { kind: 'ado-workitem-update', params: { org: 'acme', project: 'Shop App', id: 4210, fields: { title: 'A better title' } } }
const COMMENT = { kind: 'ado-workitem-comment', params: { org: 'acme', project: 'Shop App', id: 4210, body: 'Fixed in PR 4271.' } }

type Forge = { assignee: unknown; creator: unknown; fail: string[]; wiqlTitles: [number, string, string][] }
export function world(cfg?: object, f: Partial<Forge> = {}) {
  resetLocks()
  resetActions()
  resetOwnTask()
  const h = fakeHost(null)
  const forge: Forge = { assignee: JOE, creator: JOE, fail: [], wiqlTitles: [], ...f }
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  if (cfg) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  const reads: string[] = []
  const writes: string[] = []
  h.exec.handler = (argv, c) => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] !== 'curl') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    const url = argv.at(-1)!
    const method = argv[argv.indexOf('-X') + 1]
    const j = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v) })
    if (forge.fail.some(k => url.includes(k))) return { exitCode: 22, stdout: '', stderr: 'HTTP 500' }
    if (url.includes('/_apis/connectionData')) { reads.push('me'); return j({ authenticatedUser: ME }) }
    if (url.includes('/wit/wiql')) { reads.push('wiql'); return j({ workItems: forge.wiqlTitles.map(x => ({ id: x[0] })) }) }
    if (method === 'GET' && url.includes('/wit/workitems?ids=')) { reads.push('items'); return j({ value: forge.wiqlTitles.map(x => ({ id: x[0], fields: { 'System.Title': x[1], 'System.State': x[2] } })) }) }
    if (method === 'GET' && url.includes('/wit/workitems/')) { reads.push('wi'); return j({ id: 4210, fields: forge.assignee === null ? {} : { 'System.AssignedTo': forge.assignee } }) }
    if (method === 'GET' && url.includes('/pullrequests/')) { reads.push('pr'); return j({ createdBy: forge.creator }) }
    writes.push(`${method} ${url}`)
    return j({ id: 1, url: 'https://dev.azure.com/acme/_apis/x/1' })
  }
  const ask = (a: Record<string, unknown>) => addActionRequest(h.host, 't5', { ...a, why: 'the PR needs it' })
  return { h, forge, reads, writes, ask }
}
const target = { workItem: { org: 'acme', project: 'Shop App', id: 4210 }, pr: { ...T, number: 4271 } }

test('ownTask: ok only when the work item is assigned to the user AND the PR was created by the user (id or unique name)', async () => {
  const { h, reads } = world()
  expect(await ownTask(h.host, target)).toEqual({ ok: true, why: '' })
  const { h: h2 } = world(undefined, { assignee: { uniqueName: 'JOE@example.test', displayName: 'Joe' }, creator: { uniqueName: 'Joe@Example.test' } })
  expect((await ownTask(h2.host, target)).ok).toBe(true) // (the unique name alone, any case)
  expect(reads).toEqual(['me', 'wi', 'pr'])
  // the token is only ever on stdin
  expect(h.calls.filter(c => c.argv[0] === 'curl').every(c => !c.argv.join(' ').includes(TOKEN))).toBe(true)
})

test('ownTask: unassigned, assigned to someone else, a PR created by someone else: one line each, nothing moves', async () => {
  const a = world(undefined, { assignee: null })
  expect(await ownTask(a.h.host, target)).toEqual({ ok: false, why: 'WI 4210 is unassigned: not moving it' })
  const b = world(undefined, { assignee: ANN })
  expect(await ownTask(b.h.host, target)).toEqual({ ok: false, why: 'WI 4210 is assigned to Ann Example, not you: not moving it' })
  const c = world(undefined, { creator: BOB })
  expect(await ownTask(c.h.host, target)).toEqual({ ok: false, why: 'PR 4271 was created by Bob Example, not you: not linking it' })
  // only a work item (a state change): the PR is not read
  const d = world()
  expect((await ownTask(d.h.host, { workItem: target.workItem })).ok).toBe(true)
  expect(d.reads).toEqual(['me', 'wi'])
})

test('ownTask: a failed read is NEVER ok (identity, work item, PR, an answer with no creator, no token); the identity is read once per session', async () => {
  const CANT = 'could not verify the owner/assignee: not moving it'
  for (const fail of ['connectionData', '/wit/workitems/', '/pullrequests/']) {
    const w = world(undefined, { fail: [fail] })
    expect([fail, await ownTask(w.h.host, target)]).toEqual([fail, { ok: false, why: CANT }])
  }
  const noCreator = world(undefined, { creator: undefined })
  expect((await ownTask(noCreator.h.host, target)).why).toBe(CANT)
  const noToken = world()
  noToken.h.exec.handler = () => ({ exitCode: 1, stdout: '', stderr: 'no login' })
  expect((await ownTask(noToken.h.host, target)).ok).toBe(false)
  expect((await ownTask(noToken.h.host, {})).why).toBe(CANT)
  const once = world()
  await ownTask(once.h.host, target)
  await ownTask(once.h.host, target)
  expect(once.reads.filter(x => x === 'me')).toHaveLength(1)
})

test('request time: a link or a state change of a work item that is not yours is refused with exactly the why, no card; a title change and a comment are not moves', async () => {
  const w = world(undefined, { assignee: ANN })
  const r = await w.ask(LINK)
  // 1.0.34: a LINK request says what a link does ("not linking it", and how to allow it once); a state change keeps the "not moving it" wording
  const LINK_WHY = "linking this PR to WI 4210 changes a work item assigned to Ann Example, not you: not linking it (say 'link it anyway' in the chat to allow once)"
  expect(r).toMatchObject({ ok: false, text: LINK_WHY })
  expect((await w.ask(STATE)).text).toBe('WI 4210 is assigned to Ann Example, not you: not moving it')
  expect((await w.ask({ kind: 'batch', items: [LINK, STATE] })).text).toBe(LINK_WHY) // (the first item that is refused speaks)
  expect((await w.ask({ kind: 'batch', items: [STATE, LINK] })).text).toBe('WI 4210 is assigned to Ann Example, not you: not moving it')
  const unassigned = world(undefined, { assignee: null })
  expect((await unassigned.ask(LINK)).text).toBe("linking this PR to WI 4210 changes a work item that is unassigned, not yours: not linking it (say 'link it anyway' in the chat to allow once)")
  expect((await unassigned.ask(STATE)).text).toBe('WI 4210 is unassigned: not moving it')
  expect(await listActions(w.h.host)).toHaveLength(0)
  expect((await w.ask(COMMENT)).ok).toBe(true) // a comment is not a move
  expect((await w.ask(TITLE)).ok).toBe(true) // only the State (and the PR link) is guarded
  const own = world()
  expect((await own.ask(LINK)).ok).toBe(true)
  expect((await own.ask({ kind: 'batch', items: [STATE, LINK] })).ok).toBe(true) // a link and a state change of its work item are one batch
  const bob = world(undefined, { creator: BOB })
  expect((await bob.ask(LINK)).text).toBe('PR 4271 was created by Bob Example, not you: not linking it')
  const down = world(undefined, { fail: ['/wit/workitems/'] })
  expect((await down.ask(STATE)).text).toBe('could not verify the owner/assignee: not moving it')
})

test('send time: the assignee changed after the request: the approved request is NOT sent, nothing is written, the thread is told', async () => {
  const w = world()
  const made = await w.ask(LINK)
  expect(made.ok).toBe(true)
  await answerAction(w.h.host, made.request!.id, 'approve', 'pane')
  w.forge.assignee = ANN // reassigned in between
  const told: string[] = []
  const out = await approveAction(w.h.host, made.request!.id, async (_t, text) => void told.push(text))
  expect(out.ok).toBe(false)
  expect(out.text).toContain("not sent: linking this PR to WI 4210 changes a work item assigned to Ann Example, not you: not linking it (say 'link it anyway' in the chat to allow once)")
  expect(w.writes).toEqual([])
  expect(told.join('\n')).toContain('leave the work item as it is')
  // unchanged: it goes out
  const w2 = world()
  const m2 = await w2.ask(STATE)
  await answerAction(w2.h.host, m2.request!.id, 'approve', 'pane')
  expect((await approveAction(w2.h.host, m2.request!.id)).ok).toBe(true)
  expect(w2.writes).toHaveLength(1)
})

test('the user lifts it for ONE work item with their typed words; config workitems.onlyOwn false lifts it for all; a thread cannot', async () => {
  const w = world(undefined, { assignee: ANN })
  expect((await w.ask({ ...STATE, force: true, params: { ...STATE.params, force: true } })).ok).toBe(false) // nothing a thread passes lifts it
  w.h.store.set('desk.human.prompts', [{ text: 'move WI 1234 anyway', ts: w.h.clock.t }])
  expect((await w.ask(STATE)).ok).toBe(false) // another work item named
  w.h.store.set('desk.human.prompts', [{ text: 'please move WI 4210', ts: w.h.clock.t }])
  expect((await w.ask(STATE)).ok).toBe(false) // no "anyway"
  w.h.store.set('desk.human.prompts', [{ text: 'move WI 4210 anyway', ts: w.h.clock.t }])
  expect((await w.ask(STATE)).ok).toBe(true)
  // the words the link refusal names ("link it anyway") lift a LINK request once, never a state change; a failed read is still not lifted
  const lk = world(undefined, { assignee: ANN })
  lk.h.store.set('desk.human.prompts', [{ text: 'link it anyway', ts: lk.h.clock.t }])
  expect((await lk.ask(STATE)).ok).toBe(false)
  expect((await lk.ask(LINK)).ok).toBe(true)
  // a failed read is not lifted by words
  const down = world(undefined, { fail: ['/wit/workitems/'] })
  down.h.store.set('desk.human.prompts', [{ text: 'move WI 4210 anyway', ts: down.h.clock.t }])
  expect((await down.ask(STATE)).ok).toBe(false)
  const off = world({ workitems: { onlyOwn: false } }, { assignee: ANN, creator: BOB })
  expect((await off.ask(LINK)).ok).toBe(true)
  expect(off.reads).toEqual([]) // nothing is read
  expect((await moveAllowed(off.h.host, '/h', target)).ok).toBe(true)
  const flat = world({ 'workitems.onlyOwn': false }, { assignee: ANN })
  expect((await flat.ask(STATE)).ok).toBe(true)
})
