import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check, fix, migrate, plist } from './doctor'

const L = '/h/.lean-agent'
function legacy() {
  const h = fakeHost(null)
  h.clock.t = 5_000_000_000_000
  const j = (p: string, v: unknown) => h.files.set(p, typeof v === 'string' ? v : JSON.stringify(v))
  j('/plug/opener/open-desk.sh', '#!/bin/sh\necho opener\n')
  j(`${L}/projects.json`, { a: {} })
  j(`${L}/memory/m.md`, 'keep me')
  j(`${L}/goals.json`, { items: [{ id: 'g1', state: 'active', thread: '', ref: '#1', next: 'ship docs' }, { id: 'g2', state: 'active', thread: 't1', next: 'tied' }, { id: 'g3', state: 'done', thread: '', next: 'finished' }] })
  j(`${L}/my-questions.json`, { items: [{ id: 'u1', ts: 1700000000, text: 'which db?', target: 'main', status: 'open' }, { id: 'u2', ts: 1, text: 'old', target: 't1', status: 'open' }, { id: 'u3', ts: 1, text: 'done', target: 'main', status: 'answered' }] })
  j(`${L}/threads.json`, { threads: { main: { id: 'main' }, t1: { id: 't1', title: 'Login work', created: '2026-01-02T00:00:00', notes: ['half done'] } } })
  j(`${L}/recipes/a.json`, { build: { model: 'haiku', why: 'run the build', read_only: true, task: 'Run {cmd}.' } })
  j(`${L}/a/cards/c1.md`, 'card')
  for (const f of ['service.json', 'up.json', 'desk.json', 'windows.json', 'session-cap.json', 'x.lock']) j(`${L}/${f}`, '{}')
  j('/h/Library/LaunchAgents/com.lean-agent.up.plist', '<plist/>')
  j('/h/.local/bin/lean-agent', '#!/bin/sh\nexec python3 lean_agent.py "$@"\n')
  j('/h/.claude.json', { numStartups: 3, projects: { '/x': { hasTrustDialogAccepted: true } } })
  return h
}

test('migrate converts open goals and questions, closes every old thread, archives legacy files', async () => {
  const h = legacy()
  const r = await migrate(h.host, '/plug')
  expect(r.done).toBe(true)
  expect(JSON.parse(h.files.get(`${L}/goals.json`)!)).toEqual({ g1: { text: 'ship docs', ts: 5_000_000_000_000 } })
  expect(h.files.has(`${L}/legacy-0.45/goals.json`)).toBe(true)
  const q = h.files.get(`${L}/questions.jsonl`)!.trim().split('\n').map(x => JSON.parse(x))
  expect(q.map(x => x.question)).toEqual(['which db?'])
  expect(q[0].ts).toBe(1700000000000)
  expect(h.files.has(`${L}/threads.json`)).toBe(false)
  expect(h.files.get(`${L}/legacy-0.45/closed-threads.md`)).toContain('t1 Login work')
  expect([...h.files.keys()].some(k => k.startsWith(`${L}/threads/`))).toBe(false)
  for (const f of ['service.json', 'up.json', 'desk.json', 'windows.json', 'session-cap.json', 'x.lock']) {
    expect(h.files.has(`${L}/${f}`)).toBe(false)
    expect(h.files.has(`${L}/legacy-0.45/${f}`)).toBe(true)
  }
  expect(h.files.get(`${L}/memory/m.md`)).toBe('keep me')
  expect(h.files.has(`${L}/projects.json`)).toBe(true)
})

test('migrate turns recipes into skills and moves cards aside', async () => {
  const h = legacy()
  const r = await migrate(h.host, '/plug')
  const s = h.files.get(`${L}/a/skills/build/SKILL.md`)!
  expect(s).toContain('model: haiku')
  expect(s).toContain('allowed-tools: Read, Grep, Glob')
  expect(s).toContain('Run {cmd}.')
  expect(h.files.has(`${L}/a/cards/c1.md`)).toBe(false)
  expect(h.files.has(`${L}/legacy-0.45/cards-a/c1.md`)).toBe(true)
  expect(r.lines.join('\n')).toContain('learn skill for: a')
})

test('migrate unloads the old service, removes the old shim, installs the opener and trusts by real path', async () => {
  const h = legacy()
  const r = await migrate(h.host, '/plug')
  const cmds = h.calls.map(c => c.argv.join(' '))
  expect(cmds).toContain('launchctl bootout gui/501/com.lean-agent.up')
  expect(h.files.has('/h/Library/LaunchAgents/com.lean-agent.up.plist')).toBe(false)
  expect(h.files.has(`${L}/legacy-0.45/com.lean-agent.up.plist`)).toBe(true)
  expect(h.files.has('/h/.local/bin/lean-agent')).toBe(false)
  expect(r.lines.join('\n')).toContain('removed the old lean-agent command shim')
  expect(h.files.get(`${L}/bin/open-desk.sh`)).toContain('echo opener')
  expect(h.files.get('/h/Library/LaunchAgents/com.lean-agent.desk.plist')).toBe(plist())
  expect(cmds).toContain('launchctl bootstrap gui/501 /h/Library/LaunchAgents/com.lean-agent.desk.plist')
  const doc = JSON.parse(h.files.get('/h/.claude.json')!)
  expect(doc.numStartups).toBe(3)
  expect(doc.projects['/x'].hasTrustDialogAccepted).toBe(true)
  expect(doc.projects['/h/lean-agent-desk'].hasTrustDialogAccepted).toBe(true)
})

test('migrate is idempotent', async () => {
  const h = legacy()
  await migrate(h.host, '/plug')
  const snap = JSON.stringify([...h.files])
  const n = h.calls.length
  const again = await migrate(h.host, '/plug')
  expect(again.already).toBe(true)
  expect(JSON.stringify([...h.files])).toBe(snap)
  expect(h.calls.length).toBe(n)
})

test('migrate on a clean home does not touch an unrelated lean-agent file or fail', async () => {
  const h = fakeHost(null)
  h.files.set('/plug/opener/open-desk.sh', 'x')
  h.files.set('/h/.local/bin/lean-agent', 'a different tool')
  const r = await migrate(h.host, '/plug')
  expect(r.done).toBe(true)
  expect(h.files.has('/h/.local/bin/lean-agent')).toBe(true) // not ours: nothing in it points at lean-agent
})

test('fix is repeatable and never overwrites an unparsable ~/.claude.json', async () => {
  const h = fakeHost(null)
  h.files.set('/plug/opener/open-desk.sh', 'x')
  h.files.set('/h/.claude.json', '{broken')
  const a = await fix(h.host, '/plug')
  expect(a.lines.join('\n')).toContain('not trusted')
  expect(h.files.get('/h/.claude.json')).toBe('{broken')
  await fix(h.host, '/plug')
  expect(h.calls.filter(c => c.argv[1] === 'bootstrap').length).toBe(1)
})

test('check reports what to fix and the last opener line', async () => {
  const h = fakeHost(null)
  h.files.set('/plug/opener/open-desk.sh', 'x')
  h.claude.handler = () => ({ exitCode: 0, stdout: '2.1.327' })
  let out = (await check(h.host, '/plug')).join('\n')
  expect(out).toContain('FIX  opener script current')
  expect(out).toContain('last opener run: never')
  await fix(h.host, '/plug')
  h.files.set('/h/lean-agent-desk/CLAUDE.md', 'x') // the fake has no empty folders
  h.files.set(`${L}/logs/opener.log`, 'old\n2026-11-18 desk opened (exit 0)\n')
  out = (await check(h.host, '/plug')).join('\n')
  expect(out).not.toContain('FIX')
  expect(out).toContain('last opener run: 2026-11-18 desk opened (exit 0)')
})
