import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { autoMigrate, check, fix, legacyIndex, migrate, plist, tidyLegacy, MIGRATE_NOTICE } from './doctor'
import { setRunning } from './skew'
import { readNotices, setNotice } from './notices'

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
  expect(JSON.parse(h.files.get(`${L}/answers.jsonl`)!.trim()).q).toBe(1) // migrated 'main' questions are closed
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

test('migrate on Linux disables and archives the 0.45 systemd unit; check says 1.0 needs macOS', async () => {
  const h = legacy()
  h.files.set('/h/.config/systemd/user/lean-agent.service', '[Unit]\n')
  const real = h.host.process.run
  h.host.process.run = async (argv: string[], init?: any) => (argv[0] === 'uname' ? { exitCode: 0, stdout: 'Linux\n', stderr: '' } : real(argv, init))
  const r = await migrate(h.host, '/plug')
  expect(h.calls.some(c => c.argv.join(' ') === 'systemctl --user disable --now lean-agent.service')).toBe(true)
  expect(h.files.has('/h/.config/systemd/user/lean-agent.service')).toBe(false)
  expect(r.lines.join('\n')).toContain('lean-agent.service')
  expect((await check(h.host, '/plug')).join('\n')).toContain('lean-agent 1.0 needs Claude Desktop (macOS)')
})

test('autoMigrate: leftover 0.45 service is unloaded FIRST (fake launchctl, tolerant), then migrate runs once; clean homes are untouched', async () => {
  const h = legacy()
  const order: string[] = []
  const run = h.host.process.run
  h.host.process.run = async (argv: readonly string[], init?: any) => {
    if (argv[0] === 'launchctl') { order.push('launchctl ' + argv[1]); return argv[1] === 'bootout' ? { exitCode: 3, stdout: '', stderr: 'not loaded' } : { exitCode: 0, stdout: '', stderr: '' } }
    if (argv[0] === 'mv' || argv[0] === 'rm') order.push(argv[0])
    return run(argv, init)
  }
  const r = await autoMigrate(h.host, '/plug')
  expect(r.found).toEqual(expect.arrayContaining(['launch agent', 'up.json', 'command shim']))
  expect(order[0]).toBe('launchctl bootout') // before anything is moved or removed
  expect(h.files.has(`${L}/migrated-1.0.json`)).toBe(true) // bootout failing did not stop the migration
  expect(await readNotices(h.host)).toEqual([])
  const log = h.files.get(`${L}/logs/migrate.jsonl`)!
  expect(JSON.parse(log.trim().split('\n')[0]!).found).toContain('launch agent')
  // second session: nothing left, nothing runs
  order.length = 0
  const again = await autoMigrate(h.host, '/plug')
  expect(again).toEqual({ found: [], lines: [] })
  expect(order).toEqual([])
  const clean = fakeHost(null)
  expect(await autoMigrate(clean.host, '/plug')).toEqual({ found: [], lines: [] })
  expect(clean.calls.length).toBe(0)
})

test('autoMigrate: a systemd unit is disabled; a failing migrate leaves the "run migrate in the desk" notice', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.config/systemd/user/lean-agent.service', '[Service]')
  const run = h.host.process.run
  const seen: string[] = []
  h.host.process.run = async (argv: readonly string[], init?: any) => {
    seen.push(argv.join(' '))
    if (argv[0] === 'mv' && argv[argv.length - 1]!.endsWith('migrated-1.0.json')) return { exitCode: 1, stdout: '', stderr: 'disk full' }
    return run(argv, init)
  }
  await autoMigrate(h.host, '/plug')
  expect(seen).toContain('systemctl --user disable --now lean-agent.service')
  expect(await readNotices(h.host)).toContain(MIGRATE_NOTICE)
})

test('the migrate notice is cleared by a manual migrate and by the early-return path', async () => {
  const h = fakeHost(null)
  await setNotice(h.host, 'migrate', MIGRATE_NOTICE)
  await migrate(h.host, '/plug')
  expect(await readNotices(h.host)).not.toContain(MIGRATE_NOTICE)
  await setNotice(h.host, 'migrate', MIGRATE_NOTICE)
  await autoMigrate(h.host, '/plug')
  expect(await readNotices(h.host)).not.toContain(MIGRATE_NOTICE)
})

test('tidy (also for users already on 1.0.x): 0.45 guide files and current-thread.json move to legacy-0.45; 1.0 files stay; doctor flags foreign ones', async () => {
  const h = fakeHost(null)
  const j = (p: string, v: string) => h.files.set(p, v)
  j(`${L}/migrated-1.0.json`, '{}') // already migrated
  j(`${L}/threads/CLAUDE.md`, '# threads\nuse the lean-agent CLI: lean-agent new ...')
  j(`${L}/CLAUDE.md`, '# old guide: run lean-agent new')
  j(`${L}/worktrees/CLAUDE.md`, '# my own notes about worktrees') // not about lean-agent: stays
  j(`${L}/legacy-0.45/threads__CLAUDE.md`, 'older backup')
  j(`${L}/current-thread.json`, '{"sessions":[1,2]}')
  j(`${L}/threads/t1/CLAUDE.md`, '<!-- generated by lean-agent for thread t1 -->\n# t1')
  j('/h/lean-agent-desk/CLAUDE.md', '<!-- generated by the lean-agent plugin: edits are overwritten at the next desk start -->\n# desk')
  j('/plug/opener/open-desk.sh', 'x')
  expect((await check(h.host, '/plug')).join('\n')).toContain(`FIX  CLAUDE.md that mentions lean-agent and 1.0 did not write`)
  const r = await autoMigrate(h.host, '/plug')
  expect(r.lines.join('\n')).toContain('moved to legacy-0.45')
  expect(h.files.has(`${L}/threads/CLAUDE.md`)).toBe(false)
  expect(h.files.has(`${L}/CLAUDE.md`)).toBe(false)
  expect(h.files.has(`${L}/current-thread.json`)).toBe(false)
  expect(h.files.get(`${L}/legacy-0.45/threads__CLAUDE.md`)).toBe('older backup') // never overwritten
  expect([...h.files.keys()].some(k => /legacy-0\.45\/threads__CLAUDE\.md\.\d+$/.test(k))).toBe(true)
  expect(h.files.has(`${L}/worktrees/CLAUDE.md`)).toBe(true)
  expect(h.files.has(`${L}/legacy-0.45/current-thread.json`)).toBe(true)
  expect(h.files.has(`${L}/threads/t1/CLAUDE.md`)).toBe(true)
  expect(h.files.has('/h/lean-agent-desk/CLAUDE.md')).toBe(true)
  expect((await check(h.host, '/plug')).join('\n')).not.toContain('did not write')
  const again = await autoMigrate(h.host, '/plug') // idempotent, and not scanned again at every start (version in the store)
  expect(again.lines).toEqual([])
  h.files.set(`${L}/CLAUDE.md`, 'lean-agent new again')
  expect((await autoMigrate(h.host, '/plug')).lines).toEqual([]) // done for this version
  expect((await migrate(h.host, '/plug')).lines.join('\n')).toContain('moved to legacy-0.45') // migrate forces it
})

test('check reports version skew as a FIX row, and "ok" when the code is the installed version', async () => {
  const h = fakeHost(null)
  h.files.set('/plug/.claude-plugin/plugin.json', JSON.stringify({ version: '1.0.4' }))
  setRunning('1.0.3')
  try {
    expect((await check(h.host, '/plug')).filter(l => /lean-agent code/.test(l))).toEqual(['FIX  lean-agent code 1.0.3 is running but 1.0.4 is installed: start a new session (threads: close and Start)'])
    setRunning('1.0.4')
    expect((await check(h.host, '/plug')).filter(l => /lean-agent code/.test(l))).toEqual(['ok   lean-agent code 1.0.4 = installed'])
    setRunning('')
    expect((await check(h.host, '/plug')).some(l => /lean-agent code/.test(l))).toBe(false)
  } finally {
    setRunning('')
  }
})

test('legacy index: one line per card (title, size, area guess); migrate and the versioned tidy write it; unchanged = no rewrite', async () => {
  const h = legacy()
  h.files.set(`${L}/a/cards/db.md`, '# Database access\nuse the pool in services/billing/db.ts\n')
  h.files.set(`${L}/a/cards/web.json`, JSON.stringify({ title: 'Web build', paths: ['apps/web/**'] }))
  const r = await migrate(h.host, '/plug')
  expect(r.lines.join('\n')).toContain('legacy cards indexed in legacy-0.45/index.md (3 card(s))')
  const idx = h.files.get(`${L}/legacy-0.45/index.md`)!
  expect(idx).toContain('## a')
  expect(idx).toContain('- db.md | Database access | 57 bytes | area? services')
  expect(idx).toContain('- web.json | Web build |')
  expect(idx).toContain('area? apps')
  expect(idx).toContain('- c1.md | card |')
  const n = h.calls.length
  await legacyIndex(h.host)
  expect(h.calls.length).toBe(n)
  // someone migrated by 1.0.4 (tidy v1 done): the next start indexes the cards that are already in legacy-0.45
  const g = fakeHost(null)
  g.files.set(`${L}/legacy-0.45/cards-p/x.md`, '# Card X\n')
  await g.store.set('tidy.v', 1)
  expect((await tidyLegacy(g.host)).join('\n')).toContain('indexed')
  expect(g.files.get(`${L}/legacy-0.45/index.md`)).toContain('x.md | Card X')
  await g.store.set('tidy.v', 2)
  g.files.delete(`${L}/legacy-0.45/index.md`)
  expect(await tidyLegacy(g.host)).toEqual([]) // done for this version
})
