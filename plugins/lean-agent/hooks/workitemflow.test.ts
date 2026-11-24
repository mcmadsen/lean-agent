// A thread's create of a work item is checked against what the task already has (stored work item -> refused; the store; the user's active assigned items, read-only), and a PR
// the desk opened for a thread with a stored work item builds ONE link + Reviewing request, for the user's own task only (workitemflow.ts). Canned az / curl JSON. Synthetic names.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, listActions, resetActions } from './deskactions'
import { resetOwnTask } from './owntask'
import { recordPushPr } from './ownpr'
import { readNotices as allNotices } from './notices'
import { resetLocks } from './threads'

const readNotices = async (h: any) => (await allNotices(h)).filter(n => !/ owns PR /.test(n)) // (the own-PR notice of 1.0.28 is not this feature's line)

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const ME = { id: 'aaaa-1111', providerDisplayName: 'Joe Example', properties: { Account: { $value: 'joe@example.test' } } }
const JOE = { id: 'aaaa-1111', displayName: 'Joe Example', uniqueName: 'joe@example.test' }
const ANN = { id: 'bbbb-2222', displayName: 'Ann Example', uniqueName: 'ann@example.test' }
const PRURL = 'https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4271'
const CREATE = { kind: 'ado-workitem-create', params: { org: 'acme', project: 'Shop App', type: 'Bug', title: 'Worker restart telemetry is missing' } }

function world(row: object = {}, cfg?: object, o: { assignee?: unknown; items?: [number, string, string][]; wiqlFails?: boolean } = {}) {
  resetLocks()
  resetActions()
  resetOwnTask()
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'telemetry', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...row }))
  if (cfg) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  const wrote: string[] = []
  const bodies: string[] = []
  const forge = { assignee: o.assignee === undefined ? JOE : o.assignee }
  h.exec.handler = (argv, c) => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] !== 'curl') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    const url = argv.at(-1)!
    const method = argv[argv.indexOf('-X') + 1]
    const j = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v) })
    if (url.includes('/_apis/connectionData')) return j({ authenticatedUser: ME })
    if (url.includes('/wit/wiql')) {
      bodies.push(c.stdin ?? '')
      return o.wiqlFails ? { exitCode: 22, stdout: '', stderr: 'HTTP 500' } : j({ workItems: (o.items ?? []).map(x => ({ id: x[0] })) })
    }
    if (method === 'GET' && url.includes('/wit/workitems?ids=')) return j({ value: (o.items ?? []).map(x => ({ id: x[0], fields: { 'System.Title': x[1], 'System.State': x[2] } })) })
    if (method === 'GET' && url.includes('/wit/workitems/')) return j({ id: 4210, fields: forge.assignee === null ? {} : { 'System.AssignedTo': forge.assignee } })
    if (method === 'GET' && url.includes('/pullrequests/')) return j({ createdBy: JOE })
    wrote.push(`${method} ${url}`)
    return j({ id: 1, url: 'https://dev.azure.com/acme/_apis/x/1' })
  }
  return { h, wrote, bodies, ask: (a: Record<string, unknown>) => addActionRequest(h.host, 't5', { ...a, why: 'the PR needs it' }) }
}

test('create with a stored work item is REFUSED: link it instead; only the user\'s own words lift it', async () => {
  const w = world({ workItem: { id: 4210, project: 'Shop App' } })
  const r = await w.ask(CREATE)
  expect(r.ok).toBe(false)
  expect(r.text).toBe('this task already has WI 4210: link it with ado-pr-workitem-link instead (only the user\'s own words, like "create a new work item", lift this)')
  expect(await listActions(w.h.host)).toHaveLength(0)
  w.h.store.set('desk.human.prompts', [{ text: 'ok, create a new work item for the backend part', ts: w.h.clock.t }])
  const again = await w.ask(CREATE)
  expect(again.ok).toBe(true)
  expect(again.request!.why).toContain('t5 has WI 4210; the user asked for a new work item')
})

test('create with no stored work item: the store\'s matches (same PR, same title) and the user\'s active assigned items (read-only WIQL) are shown in the card', async () => {
  // (b) another thread holds the same PR and has a work item
  const w = world({ pr: { number: 4271 } })
  w.h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'frontend fix', project: 'app', state: 'closed', workItem: { id: 4210 }, pr: { number: 4271 } }))
  w.h.files.set(`${L}/workitems.json`, JSON.stringify({ wi: { '4210': ['t2'] }, pr: { '4271': ['t2', 't5'] } }))
  const b = await w.ask(CREATE)
  expect(b.ok).toBe(true)
  expect(b.request!.why).toContain('a work item may be known for this task: WI 4210 (t2 has the same PR 4271): link it instead of creating one')
  expect(w.bodies).toHaveLength(0) // the store answered: no forge query
  // (c) the forge: closest titles of the user's own active items
  const f = world({}, undefined, { items: [[4210, 'Worker restart telemetry', 'Active'], [9811, 'Update the logo', 'New'], [9700, 'Telemetry for restart of workers', 'Active']] })
  const c = await f.ask(CREATE)
  expect(c.ok).toBe(true)
  expect(c.request!.why).toContain("no work item known for this task; closest: 4210 'Worker restart telemetry' (assigned to you, Active), 9700 'Telemetry for restart of workers' (assigned to you, Active)")
  expect(c.request!.why).not.toContain('logo')
  expect(f.bodies[0]).toContain('@Me') // the query is WIQL for the user's own items, a read
  expect(f.wrote).toEqual([]) // nothing was written
  // nothing like it / no items / the read failed: said in one line, the request still goes to the user
  expect((await world({}, undefined, { items: [[9811, 'Update the logo', 'New']] }).ask(CREATE)).request!.why).toContain('none of your 1 active items looks like it')
  expect((await world({}, undefined, { items: [] }).ask(CREATE)).request!.why).toContain('no active work item assigned')
  expect((await world({}, undefined, { wiqlFails: true }).ask(CREATE)).request!.why).toContain('your active work items could not be read')
})

test('config workitems.lookup false: a create request reads nothing from the forge', async () => {
  const w = world({}, { workitems: { lookup: false } }, { items: [[4210, 'Worker restart telemetry', 'Active']] })
  const r = await w.ask(CREATE)
  expect(r.ok).toBe(true)
  expect(r.request!.why).toBe('the PR needs it')
  expect(w.bodies).toHaveLength(0)
})

test('after a PR is opened: ONE request (link + Reviewing), once, only for the user\'s own task', async () => {
  const w = world({ workItem: { id: 4210, project: 'Shop App' } })
  await recordPushPr(w.h.host, 't5', PRURL)
  const open = await listActions(w.h.host)
  expect(open).toHaveLength(1)
  expect(open[0]).toMatchObject({ kind: 'batch', thread: 't5', state: 'pending', writes: 2 })
  expect(open[0]!.text).toContain('1/2')
  expect(open[0]!.text).toContain('2/2')
  expect(open[0]!.text).toContain('Reviewing')
  expect(open[0]!.why).toContain('PR 4271 was opened: link it to WI 4210')
  expect(await readNotices(w.h.host)).toContainEqual(expect.stringContaining('Approve in the pane to link it to WI 4210 and move it to Reviewing'))
  expect(w.wrote).toEqual([]) // nothing is sent without the Approve
  await recordPushPr(w.h.host, 't5', PRURL) // the same PR again: nothing new
  expect(await listActions(w.h.host)).toHaveLength(1)
  // the state name is configurable
  const c = world({ workItem: { id: 4210, project: 'Shop App' } }, { workitems: { reviewState: 'In Review' } })
  await recordPushPr(c.h.host, 't5', PRURL)
  expect((await listActions(c.h.host))[0]!.text).toContain('In Review')
})

test('after a PR is opened: config workitems.afterPr off, no stored work item, a work item that is not yours: nothing is built, one line says why', async () => {
  const off = world({ workItem: { id: 4210 } }, { workitems: { afterPr: 'off' } })
  await recordPushPr(off.h.host, 't5', PRURL)
  expect(await listActions(off.h.host)).toHaveLength(0)
  expect(await readNotices(off.h.host)).toEqual([])
  const none = world({})
  await recordPushPr(none.h.host, 't5', PRURL)
  expect(await listActions(none.h.host)).toHaveLength(0)
  expect(await readNotices(none.h.host)).toEqual([])
  const ann = world({ workItem: { id: 4210, project: 'Shop App' } }, undefined, { assignee: ANN })
  await recordPushPr(ann.h.host, 't5', PRURL)
  expect(await listActions(ann.h.host)).toHaveLength(0)
  expect(await readNotices(ann.h.host)).toContainEqual(expect.stringContaining('t5: WI 4210 is assigned to Ann Example, not you: not moving it'))
  const unassigned = world({ workItem: { id: 4210, project: 'Shop App' } }, undefined, { assignee: null })
  await recordPushPr(unassigned.h.host, 't5', PRURL)
  expect(await listActions(unassigned.h.host)).toHaveLength(0)
  expect(await readNotices(unassigned.h.host)).toContainEqual(expect.stringContaining('WI 4210 is unassigned: not moving it'))
  // the user says so: the work item is moved anyway
  const said = world({ workItem: { id: 4210, project: 'Shop App' } }, undefined, { assignee: ANN })
  said.h.store.set('desk.human.prompts', [{ text: 'move WI 4210 anyway', ts: said.h.clock.t }])
  await recordPushPr(said.h.host, 't5', PRURL)
  expect(await listActions(said.h.host)).toHaveLength(1)
})
