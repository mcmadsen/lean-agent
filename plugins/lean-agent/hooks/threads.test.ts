import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, parseAgents, resetLocks, trustFolder } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'

function setup(on: any = null) {
  resetLocks()
  const h = fakeHost(on)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  // a scripted `claude`: --bg prints the sid; `agents --json` answers from `rows`
  const state = { rows: [] as any[] }
  h.claude.handler = (a: string[]) => {
    const [a0, a1] = a
    if (a0 === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a0 === 'agents' && a1 === '--json') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i)
  return { h, state, call }
}

test('new records the sid, writes the folder, settings and trust', async () => {
  const { h, call } = setup()
  const r = await call({ action: 'new', title: 'fix login', text: 'fix the login bug', project: 'app' })
  expect(r.ok).toBe(true)
  const t = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!)
  expect(t.sid).toBe(SID)
  expect(h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md')).toBe('# t1 fix login')
  const s = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/.claude/settings.json')!)
  expect(s.permissions.allow).toContain('Edit(//h/.lean-agent/**)')
  expect(JSON.parse(h.files.get('/h/.claude.json')!).projects['/h/.lean-agent/threads/t1'].hasTrustDialogAccepted).toBe(true)
  const argv = h.claudeCalls().find(a => a[0] === '--bg')!
  expect(argv).toEqual(['--bg', '-n', 't1 · fix login', '--', 'fix the login bug'])
  expect(h.calls.find(c => c.argv[0] === 'claude' && c.argv[1] === '--bg')!.cwd).toBe('/h/.lean-agent/threads/t1')
  expect((await call({ action: 'new', title: 'second' })).ok).toBe(true)
  expect(h.files.has('/h/.lean-agent/threads/t2/thread.json')).toBe(true)
})

test('send to a running thread is queued only, never resumed', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'busy', startedAt: 1 }]
  h.clock.t += 60_000
  const r = await call({ action: 'send', tN: 't1', text: 'also do b' })
  expect(r.text).toContain('queued')
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(0)
  expect(h.files.get('/h/.lean-agent/threads/t1/inbox.jsonl')).toContain('also do b')
  // an unknown status counts as running too
  state.rows[0].status = 'weird'
  await call({ action: 'wake', tN: 't1' })
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(0)
})

test('send to an idle thread resumes exactly once with the batch', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  const resumes = h.claudeCalls().filter(a => a.includes('--resume'))
  expect(resumes.length).toBe(1)
  expect(resumes[0]).toEqual(['--bg', '--resume', SID, '-n', 't1 · a', '--', 'one\n\n<!-- lean:n=1 -->'])
})

test('two sends within 30 s make one wake; the second waits queued', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 'x', cwd: 'x', status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  await Promise.all([call({ action: 'send', tN: 't1', text: 'one' }), call({ action: 'send', tN: 't1', text: 'two' })])
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(1)
  h.clock.t += 10_000
  await call({ action: 'send', tN: 't1', text: 'three' })
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(1)
  h.clock.t += 31_000
  await call({ action: 'wake', tN: 't1' })
  const resumes = h.claudeCalls().filter(a => a.includes('--resume'))
  expect(resumes.length).toBe(2)
  expect(resumes[1]![resumes[1]!.length - 1]).toContain('three')
  expect(resumes[1]![resumes[1]!.length - 1]).toContain('two') // the first wake took only what was queued then
})

test('park and close only queue; close stops a running session', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  await call({ action: 'park', tN: 't1' })
  h.clock.t += 60_000
  expect((await call({ action: 'send', tN: 't1', text: 'x' })).text).toContain('parked')
  await call({ action: 'reopen', tN: 't1' })
  state.rows = [{ sessionId: SID, name: 'x', cwd: 'x', status: 'busy', startedAt: 1 }]
  await call({ action: 'close', tN: 't1' })
  expect(h.claudeCalls()).toContainEqual(['agents', 'stop', SID])
  expect((await call({ action: 'list' })).text).toContain('closed')
})

test('close with a failing agents listing retries once, then stays closing and says how to stop it', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  let n = 0
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? (++n === 1 ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: JSON.stringify([{ sessionId: SID, name: 'x', cwd: 'x', status: 'busy', startedAt: 1 }]) }) : { exitCode: 0, stdout: '' })
  expect((await call({ action: 'close', tN: 't1' })).text).toBe('t1 closed')
  expect(h.claudeCalls()).toContainEqual(['agents', 'stop', SID])
  await call({ action: 'reopen', tN: 't1' })
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '' })
  const r = await call({ action: 'close', tN: 't1' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('Stop it from the Claude app')
  expect((await call({ action: 'list' })).text).toContain('closing')
})

test('trust writer keeps every other key and survives a damaged file', async () => {
  const { h } = setup()
  h.files.set('/h/.claude.json', JSON.stringify({ theme: 'dark', projects: { '/other': { allowedTools: ['x'], hasTrustDialogAccepted: false }, '/h/f': { mcp: 1 } } }))
  expect(await trustFolder(h.host, '/h/f')).toBe(true)
  const d = JSON.parse(h.files.get('/h/.claude.json')!)
  expect(d.theme).toBe('dark')
  expect(d.projects['/other']).toEqual({ allowedTools: ['x'], hasTrustDialogAccepted: false })
  expect(d.projects['/h/f']).toEqual({ mcp: 1, hasTrustDialogAccepted: true })
  h.files.set('/h/.claude.json', '{broken')
  expect(await trustFolder(h.host, '/h/g')).toBe(false)
  expect(h.files.get('/h/.claude.json')).toBe('{broken') // never clobbered
})

test('agents JSON parser is tolerant', () => {
  const row = { sessionId: 'a', name: 'n', cwd: '/c', status: 'Busy', startedAt: 5, extra: { z: 1 } }
  expect(parseAgents(JSON.stringify([row]))).toEqual([{ sid: 'a', name: 'n', cwd: '/c', status: 'busy', startedAt: 5 }])
  expect(parseAgents(JSON.stringify({ sessions: [{ session_id: 'b', state: 'idle' }, null, 7, {}] }))).toEqual([{ sid: 'b', name: '', cwd: '', status: 'idle', startedAt: 0 }])
  expect(parseAgents('not json')).toEqual([])
  expect(parseAgents('')).toEqual([])
  expect(parseAgents('{"agents":5}')).toEqual([])
})

test('the desk gets lean_thread at session start, and the tool answers', async ($, on) => {
  const h = fakeHost(on)
  resetLocks()
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_thread', action: 'list' } as any)
  expect(JSON.stringify(r)).toContain('no threads')
})

test('a failed agents listing is not "idle": no resume, messages stay queued', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  h.clock.t += 60_000
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '' })
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(r.ok).toBe(false)
  expect(h.claudeCalls().filter(a => a.includes('--resume')).length).toBe(0)
})

test('a resume that forks follows the new session id', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') state.rows.push({ sessionId: 'aaaaaaaa-2222-3333-4444-555555555555', name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'busy', startedAt: 99 })
    return { exitCode: 0, stdout: a[0] === 'agents' ? JSON.stringify(state.rows) : '' }
  }
  await call({ action: 'send', tN: 't1', text: 'one' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe('aaaaaaaa-2222-3333-4444-555555555555')
})

test('trust writer refuses an unreadable or non-object ~/.claude.json and never overwrites it', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.claude.json', '{"projects": [broken')
  expect(await trustFolder(h.host, '/x')).toBe(false)
  expect(h.files.get('/h/.claude.json')).toBe('{"projects": [broken')
  h.host.fs.read = async () => { throw new Error('EACCES') }
  expect(await trustFolder(h.host, '/x')).toBe(false)
  expect(h.files.get('/h/.claude.json')).toBe('{"projects": [broken')
})
