import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks } from './threads'
import { resetProjectsQueue } from './projects'
import { loadView } from './view'

const L = '/h/.lean-agent'
function setup() {
  resetLocks()
  resetProjectsQueue()
  const h = fakeHost(null)
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/w/app/README', 'x') // a folder
  h.files.set('/w/secret/README', 'x')
  h.files.set(`${L}/projects.json`, JSON.stringify({
    app: { path: '/w/app', guards: { 'push-deny': ['main'] } },
    secret: { path: '/w/secret', private: true },
  }))
  h.files.set(`${L}/app/learn.json`, JSON.stringify({ sha: 'a', areas: { api: { globs: ['src/**'], sha: 'a', lines: 5, at: 1_700_000_000_000 }, ui: { globs: ['ui/**'], sha: 'a', lines: 5, stale: '20 files changed' } } }))
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const call = (i: any) => leanThread(h.host, '/p', i)
  const projects = () => JSON.parse(h.files.get(`${L}/projects.json`)!)
  return { h, call, projects }
}

test('projects lists name, path, private, guards, rules (areas, stale) and open threads', async () => {
  const { call } = setup()
  const r: any = await call({ action: 'projects' })
  expect(r.ok).toBe(true)
  expect(r.data.map((x: any) => x.name)).toEqual(['app', 'secret'])
  const app = r.data[0]
  expect(app).toMatchObject({ path: '/w/app', private: false, guards: 'main', areas: 2, stale: 1, threads: 1, learned: '2023-11-14' })
  expect(r.data[1]).toMatchObject({ private: true, guards: 'default', areas: 0, learned: 'never', threads: 0 })
  expect(r.text).toContain('2 area(s)')
})

test('private projects are left out while the private switch is off, unless all: true', async () => {
  const { h, call } = setup()
  h.files.set(`${L}/config.json`, JSON.stringify({ private: 'off' }))
  const r: any = await call({ action: 'projects' })
  expect(r.data.map((x: any) => x.name)).toEqual(['app'])
  expect(r.text).toContain('1 private project(s) hidden')
  expect(r.text).not.toContain('secret ·')
  const all: any = await call({ action: 'projects', all: true })
  expect(all.data.map((x: any) => x.name)).toEqual(['app', 'secret'])
  const v = await loadView(h.host)
  expect(v.projects.map(p => p.name)).toEqual(['app']) // the pane never shows hidden ones
})

test('project-add resolves an existing folder, refuses a missing one, a duplicate path and another path for a name', async () => {
  const { h, call, projects } = setup()
  h.files.set('/w/new/README', 'x')
  expect((await call({ action: 'project-add', project: 'new', path: '/w/new' })).ok).toBe(true)
  expect(projects().new).toEqual({ path: '/w/new' })
  expect(projects().app.guards).toEqual({ 'push-deny': ['main'] }) // others untouched
  expect((await call({ action: 'project-add', project: 'x', path: '/w/nope' })).ok).toBe(false)
  expect((await call({ action: 'project-add', project: 'dup', path: '/w/app' })).text).toContain('already registered as app')
  expect((await call({ action: 'project-add', project: 'app', path: '/w/new' })).ok).toBe(false)
  expect((await call({ action: 'project-add', project: 'bad name', path: '/w/new' })).ok).toBe(false)
  expect((await call({ action: 'project-add', project: 'rel', path: 'w/new' })).ok).toBe(false)
  expect((await call({ action: 'project-add', project: 'app', path: '/w/app' })).ok).toBe(true) // again: fine, keeps its fields
  expect(projects().app.guards).toEqual({ 'push-deny': ['main'] })
})

test('project-remove only unregisters, and refuses while a thread that is not closed uses it', async () => {
  const { h, call, projects } = setup()
  const no = await call({ action: 'project-remove', project: 'app' })
  expect(no.ok).toBe(false)
  expect(no.text).toContain('t1')
  expect(projects().app).toBeTruthy()
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  expect((await call({ action: 'project-remove', project: 'app' })).ok).toBe(true)
  expect(projects().app).toBeUndefined()
  expect(h.files.has('/w/app/README')).toBe(true) // nothing deleted
  expect(h.files.has(`${L}/app/learn.json`)).toBe(true)
  expect((await call({ action: 'project-remove', project: 'ghost' })).ok).toBe(false)
})

test('project-private flips the flag and refreshes the private list; it needs on', async () => {
  const { h, call, projects } = setup()
  expect((await call({ action: 'project-private', project: 'app' })).ok).toBe(false)
  expect((await call({ action: 'project-private', project: 'app', on: true })).ok).toBe(true)
  expect(projects().app).toMatchObject({ private: true, path: '/w/app' })
  expect(h.files.get(`${L}/githooks/private.list`)).toContain('path /w/app')
  await call({ action: 'project-private', project: 'app', on: false, confirm: true })
  expect(projects().app.private).toBe(false)
})

test('a damaged projects.json is never overwritten', async () => {
  const { h, call } = setup()
  h.files.set(`${L}/projects.json`, '{"app": [broken')
  h.files.set('/w/new/README', 'x')
  const r = await call({ action: 'project-add', project: 'new', path: '/w/new' })
  expect(r.ok).toBe(false)
  expect(h.files.get(`${L}/projects.json`)).toBe('{"app": [broken')
})

test('an empty registry says how to add one', async () => {
  const { h, call } = setup()
  h.files.delete(`${L}/projects.json`)
  expect((await call({ action: 'projects' })).text).toContain('project-add')
})

test('project-remove refuses a private project; turning private off needs confirm', async () => {
  const { call, projects } = setup()
  const rm = await call({ action: 'project-remove', project: 'secret' })
  expect(rm.ok).toBe(false)
  expect(rm.text).toContain('private')
  expect(projects().secret.private).toBe(true)
  const off = await call({ action: 'project-private', project: 'secret', on: false })
  expect(off.ok).toBe(false)
  expect(projects().secret.private).toBe(true)
  expect((await call({ action: 'project-private', project: 'secret', on: false, confirm: true })).ok).toBe(true)
  expect(projects().secret.private).toBe(false)
})

test('__proto__ and friends are not project names', async () => {
  const { h, call } = setup()
  h.files.set('/w/new/README', 'x')
  for (const n of ['__proto__', 'constructor', 'prototype']) expect((await call({ action: 'project-add', project: n, path: '/w/new' })).ok).toBe(false)
})

test('parallel project actions do not lose each other\'s update', async () => {
  const { h, call, projects } = setup()
  h.files.set('/w/new/README', 'x')
  await Promise.all([call({ action: 'project-add', project: 'new', path: '/w/new' }), call({ action: 'project-private', project: 'app', on: true })])
  expect(projects().new).toBeTruthy()
  expect(projects().app.private).toBe(true)
})

test('a hidden private project is neither named nor reachable without all: true', async () => {
  const { h, call, projects } = setup()
  h.files.set(`${L}/config.json`, JSON.stringify({ private: 'off' }))
  h.files.set('/w/dup/README', 'x')
  const dup = await call({ action: 'project-add', project: 'copy', path: '/w/secret' })
  expect(dup.ok).toBe(false)
  expect(dup.text).not.toContain('as secret')
  expect((await call({ action: 'project-private', project: 'secret', on: false, confirm: true })).ok).toBe(false)
  expect(projects().secret.private).toBe(true)
})

test('a damaged projects.json is reported by projects, not shown as empty', async () => {
  const { h, call } = setup()
  h.files.set(`${L}/projects.json`, '{"app": [broken')
  const r = await call({ action: 'projects' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('unreadable')
})
