// 1.0.28 new action kinds: `ado-workitem-create` and `ado-pr-workitem-link` (deskactions.ts), with canned curl output (no network). Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, answerAction, approveAction, checkAction, resetActions } from './deskactions'
import { allowWrites, runGranted } from './deskwrites'
import { recordHumanPrompt } from './humanprompts'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const PID = '11111111-2222-3333-4444-555555555555'
const RID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BASE = { org: 'acme', project: 'Shop App' }
const LINK = { ...BASE, repo: 'shop-api', pr: 42, workitem: 1234 }
const CREATE = { ...BASE, type: 'Task', title: 'Rerun the digest suite', description: 'Build 9981 failed on a flaky test.' }

function setup(over: { get?: (url: string) => { exitCode: number; stdout: string; stderr?: string } } = {}) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/config.json`, JSON.stringify({ actions: { holdSeconds: 0 } })) // (no hold window: sendhold.test.ts has its own specs)
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 9e12, delivered: 0 })) // (lastWake far ahead: no prompt counts as newer than the last delivery, sendhold.test.ts)
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] !== 'curl') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    const url = argv[argv.length - 1]!
    const method = argv[argv.indexOf('-X') + 1]
    if (method === 'GET') return over.get ? over.get(url) : { exitCode: 0, stdout: JSON.stringify({ id: url.includes('/_apis/projects/') ? PID : RID }) }
    if (url.includes('/workitems/$')) return { exitCode: 0, stdout: JSON.stringify({ id: 4321, url: 'https://dev.azure.com/acme/_apis/wit/workItems/4321' }) }
    return { exitCode: 0, stdout: JSON.stringify({ id: 1234, url: 'https://dev.azure.com/acme/_apis/wit/workItems/1234' }) }
  }
  const writes = () => h.calls.filter(c => c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] !== 'GET')
  return { h, host: h.host, writes }
}
type S = ReturnType<typeof setup>
const approved = async (s: S, kind: string, params: Record<string, unknown>) => {
  const made = await addActionRequest(s.host, 't5', { kind, params, why: 'the PR round needs it' })
  expect(made.ok, made.text).toBe(true)
  expect((await answerAction(s.host, made.request!.id, 'approve', 'pane')).ok).toBe(true)
  return approveAction(s.host, made.request!.id)
}
const stdinOf = (s: S, i: number) => String(s.h.calls.filter(c => c.argv[0] === 'curl')[i]?.stdin ?? '')

test('ado-pr-workitem-link renders the PATCH with placeholders; the send reads the two ids and writes the vstfs link (token on stdin, never in argv)', { timeoutMs: 20_000 }, async () => {
  const c = checkAction({ kind: 'ado-pr-workitem-link', params: LINK })
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect([c.plan.method, c.plan.url, c.plan.contentType]).toEqual(['PATCH', 'https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/1234?api-version=7.1', 'application/json-patch+json'])
  expect(c.plan.body).toContain('vstfs:///Git/PullRequestId/<project id>%2F<repository id>%2F42')
  expect(c.plan.headline).toContain('link PR 42 to work item 1234')
  const s = setup()
  const out = await approved(s, 'ado-pr-workitem-link', LINK)
  expect(out.ok, out.text).toBe(true)
  const calls = s.h.calls.filter(c => c.argv[0] === 'curl')
  expect(calls.map(c => `${c.argv[c.argv.indexOf('-X') + 1]} ${c.argv[c.argv.length - 1]}`)).toEqual([
    'GET https://dev.azure.com/acme/_apis/projects/Shop%20App?api-version=7.1',
    'GET https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api?api-version=7.1',
    'PATCH https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/1234?api-version=7.1',
  ])
  expect(JSON.parse(stdinOf(s, 2).match(/data-binary = (".*")/)![1]!)).toContain(`vstfs:///Git/PullRequestId/${PID}%2F${RID}%2F42`)
  expect(stdinOf(s, 2)).toContain(TOKEN) // on stdin only
  for (const c of calls) expect(c.argv.join(' ')).not.toContain(TOKEN)
  expect(out.text).not.toContain(TOKEN)
})

test('a link whose project or repository id cannot be read writes nothing and says so', { timeoutMs: 20_000 }, async () => {
  const s = setup({ get: () => ({ exitCode: 22, stdout: '', stderr: `curl: (22) 404 ${TOKEN}` }) })
  const out = await approved(s, 'ado-pr-workitem-link', LINK)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('nothing was written')
  expect(out.text).not.toContain(TOKEN)
  expect(s.writes()).toHaveLength(0)
  const s2 = setup({ get: () => ({ exitCode: 0, stdout: JSON.stringify({ id: 'not-a-guid' }) }) })
  expect((await approved(s2, 'ado-pr-workitem-link', LINK)).ok).toBe(false)
  expect(s2.writes()).toHaveLength(0)
})

test('ado-workitem-create renders the JSON patch (fields, parent) and returns the new id; the type is one of four', { timeoutMs: 20_000 }, async () => {
  const c = checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, area: 'Shop App\\Web', iteration: 'Shop App\\Sprint 4', assignedTo: 'dev@example.test', parent: 77 } })
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect([c.plan.method, c.plan.url]).toEqual(['POST', 'https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/$Task?api-version=7.1'])
  expect(JSON.parse(c.plan.body)).toEqual([
    { op: 'add', path: '/fields/System.Title', value: 'Rerun the digest suite' },
    { op: 'add', path: '/fields/System.Description', value: 'Build 9981 failed on a flaky test.' },
    { op: 'add', path: '/fields/System.AreaPath', value: 'Shop App\\Web' },
    { op: 'add', path: '/fields/System.IterationPath', value: 'Shop App\\Sprint 4' },
    { op: 'add', path: '/fields/System.AssignedTo', value: 'dev@example.test' },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/acme/_apis/wit/workItems/77' } },
  ])
  for (const type of ['Bug', 'User Story', 'Issue', 'task']) expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, type } }).ok).toBe(true)
  for (const type of ['Epic', '', 7]) expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, type } }).ok).toBe(false)
  expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, title: '' } }).ok).toBe(false)
  expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, command: 'rm' } }).ok).toBe(false)
  const s = setup()
  const out = await approved(s, 'ado-workitem-create', CREATE)
  expect(out.ok, out.text).toBe(true)
  expect(out.text).toContain('id 4321')
  expect(s.writes()).toHaveLength(1)
})

test('create with links: the new id is read from the create answer and the PR is linked to it, in the same approval (repo goes with links)', { timeoutMs: 20_000 }, async () => {
  expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, links: [{ pr: 42 }] } }).ok).toBe(false) // no repo
  expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, repo: 'shop-api' } }).ok).toBe(false) // repo without links
  expect(checkAction({ kind: 'ado-workitem-create', params: { ...CREATE, repo: 'shop-api', links: [{ pr: 42, x: 1 }] } }).ok).toBe(false)
  const s = setup()
  const out = await approved(s, 'ado-workitem-create', { ...CREATE, repo: 'shop-api', links: [{ pr: 42 }] })
  expect(out.ok, out.text).toBe(true)
  const urls = s.h.calls.filter(c => c.argv[0] === 'curl').map(c => c.argv[c.argv.length - 1]!)
  expect(urls[0]).toContain('/workitems/$Task')
  expect(urls[urls.length - 1]).toBe('https://dev.azure.com/acme/Shop%20App/_apis/wit/workitems/4321?api-version=7.1') // the id the create answered
  expect(out.text).toContain('create: done')
  expect(out.text).toContain('link PR 42: done')
})

test('a batch can hold a link next to replies of the same PR; a create is its own target', () => {
  const reply = { kind: 'ado-pr-reply', params: { ...BASE, repo: 'shop-api', pr: 42, thread: 7, body: 'Build: https://ci.example.test/run/9981' } }
  const b = checkAction({ kind: 'batch', items: [reply, { kind: 'ado-pr-workitem-link', params: LINK }] })
  expect(b.ok).toBe(true)
  expect(checkAction({ kind: 'batch', items: [reply, { kind: 'ado-workitem-create', params: CREATE }] }).ok).toBe(false)
})

test('a work item create is always asked unless the user asked for one in words (allow-writes target {workitem: "new"}) ', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const made = await addActionRequest(s.host, 't5', { kind: 'ado-workitem-create', params: CREATE, why: 'x' })
  expect(made.ok).toBe(true)
  expect(await runGranted(s.host, made.request!.id)).toBeNull() // no words: asked
  expect((await allowWrites(s.host, 't5', { workitem: 'new' })).ok).toBe(false) // no written instruction
  await recordHumanPrompt(s.host, { text: 'please fix the comments on PR 42', origin: { kind: 'composer' } })
  expect((await allowWrites(s.host, 't5', { workitem: 'new' })).ok).toBe(false) // words about a PR are no ask for a new item
  await recordHumanPrompt(s.host, { text: 'create a task for the flaky digest test', origin: { kind: 'composer' } })
  const g = await allowWrites(s.host, 't5', { workitem: 'new' })
  expect(g.ok, g.text).toBe(true)
  const r = await runGranted(s.host, made.request!.id)
  expect(r?.sent).toBe(true)
  const again = await addActionRequest(s.host, 't5', { kind: 'ado-workitem-create', params: { ...CREATE, title: 'Another one' }, why: 'x' })
  expect((await runGranted(s.host, again.request!.id))?.sent).toBe(true) // the grant covers creates of this project
  const other = await addActionRequest(s.host, 't5', { kind: 'ado-workitem-create', params: { ...CREATE, project: 'Other' }, why: 'x' })
  expect(await runGranted(s.host, other.request!.id)).toBeNull() // another project: asked
})
