import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadSettings as leanThreadSettings } from './leantools'
import { leanThread, parseAgents, resetLocks, threadClaudeMd, trustFolder } from './threads'
import { PROMPT_MAX, olderVersion, reportHistory } from './handover'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'

function setup(on: any = null, orchestrate = false) {
  resetLocks()
  const h = fakeHost(on, orchestrate ? { orchestrate: true } : undefined)
  h.files.set('/h/.lean-agent/config.json', on && !orchestrate ? '{"lean":{"orchestrate":false},"handover":{"mode":"full"}}' : '{"handover":{"mode":"full"}}') // (these specs read the full prompt; core is the default since 1.0.27)
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
  const call = (i: any) => leanThread(h.host, ROOT, i.action === 'list' ? { verbose: true, ...i } : i) // (the long list form)
  return { h, state, call }
}

test('new records the sid, writes the folder, settings and trust', async () => {
  const { h, call } = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  const r = await call({ action: 'new', title: 'fix login', text: 'fix the login bug', project: 'app' })
  expect(r.ok).toBe(true)
  const t = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!)
  expect(t.sid).toBe(SID)
  expect(h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md')).toBe('# t1 fix login')
  const s = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/.claude/settings.json')!)
  expect(s.permissions.allow).toContain('Edit(//h/.lean-agent/**)')
  expect(s.permissions.deny).toEqual(leanThreadSettings().permissions.deny) // the built-ins a thread never calls are removed from its tool list (leantools.ts)
  expect(s.env).toEqual({ ...leanThreadSettings().env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/h/.lean-agent/githooks' })
  // thread start installs the chaining wrappers and the private list
  for (const n of ['pre-push', 'pre-commit', 'commit-msg', 'reference-transaction']) expect(h.files.get(`/h/.lean-agent/githooks/${n}`)).toContain('chain')
  expect(h.files.has('/h/.lean-agent/githooks/private.list')).toBe(true)
  expect(JSON.parse(h.files.get('/h/.claude.json')!).projects['/h/.lean-agent/threads/t1'].hasTrustDialogAccepted).toBe(true)
  const argv = h.claudeCalls().find(a => a[0] === '--bg')!
  expect(argv).toEqual(['--bg', '-n', 't1 · fix login', '--model', 'sonnet', '--effort', 'high', '--', 'fix the login bug'])
  expect(s.model).toBe('sonnet')
  expect(s.effortLevel).toBe('high')
  expect([t.model, t.effort]).toEqual(['sonnet', 'high'])
  expect(h.calls.find(c => c.argv[0] === 'claude' && c.argv[1] === '--bg')!.cwd).toBe('/h/.lean-agent/threads/t1')
  expect((await call({ action: 'new', title: 'second' })).ok).toBe(true)
  expect(h.files.has('/h/.lean-agent/threads/t2/thread.json')).toBe(true)
})

test('1.0.24 brief lint: a new / send text that asks for a forge write by script gets one warning line, in the reply and in the brief the thread receives', async () => {
  const { h, state, call } = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  const bad = `set the PR threads to fixed with curl -X PATCH https://dev.azure.com/org-a/proj-a/_apis/git/repositories/repo-a/pullRequests/42/threads/7 -d '{"status":"fixed"}'`
  const r = await call({ action: 'new', title: 'pr', text: bad, project: 'app' })
  const line = 'this brief asks for a forge write by script; a thread cannot: it must request an action kind (ado-pr-reply (optional status) | ado-pr-thread-status'
  expect(r.ok).toBe(true)
  expect(r.text).toContain(line)
  expect(r.text.split(line).length).toBe(2) // once
  expect(h.claudeCalls().find(a => a[0] === '--bg')!.at(-1)).toContain(line) // the brief the thread receives
  state.rows = [{ sessionId: SID, name: 't1 · pr', cwd: '/h/.lean-agent/threads/t1', status: 'busy', startedAt: 1 }]
  h.clock.t += 60_000
  const s = await call({ action: 'send', tN: 't1', text: 'then run gh api -X POST repos/o/r/issues/3/comments -f body=hi' })
  expect(s.text).toContain(line)
  expect(h.files.get('/h/.lean-agent/threads/t1/inbox.jsonl')).toContain('action kind (ado-pr-reply')
  const ok = await call({ action: 'send', tN: 't1', text: 'run the tests and report' })
  expect(ok.text).not.toContain('forge write by script')
  expect(h.files.get('/h/.lean-agent/threads/t1/inbox.jsonl')!.split('forge write by script').length).toBe(2) // only the flagged send carries it
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
  // the task first, then the queued message (a status check among them is a side effect, never the whole turn)
  expect(resumes[0]).toEqual(['--bg', '--resume', SID, '--', 'Resume the work now (task: brief). Answer status requests with a short lean_report as a side effect, never as the whole turn.\n\none\n\n<!-- lean:n=1 -->'])
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
  expect(h.claudeCalls()).toContainEqual(['stop', SID.slice(0, 8)])
  expect((await call({ action: 'list' })).text).toContain('closed')
})

test('close with a failing agents listing retries once, then stays closing and says how to stop it', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  let n = 0
  h.claude.handler = (a: string[]) => (a[0] === 'agents' && a[1] === '--json' ? (++n === 1 ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: JSON.stringify([{ sessionId: SID, name: 'x', cwd: 'x', status: 'busy', startedAt: 1 }]) }) : { exitCode: 0, stdout: '' })
  expect((await call({ action: 'close', tN: 't1' })).text).toBe("t1 closed; session stopped; the app keeps stopped sessions in its list") // (its folder is not the thread's: no rm)
  expect(h.claudeCalls()).toContainEqual(['stop', SID.slice(0, 8)])
  expect(h.claudeCalls().some(a => a[0] === 'rm')).toBe(false)
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
  expect(parseAgents(JSON.stringify([row]))).toEqual([{ sid: 'a', name: 'n', cwd: '/c', status: 'busy', startedAt: 5, pid: 0, id: '', state: '', waitingFor: '' }])
  expect(parseAgents(JSON.stringify({ sessions: [{ session_id: 'b', state: 'idle' }, null, 7, {}] }))).toEqual([{ sid: 'b', name: '', cwd: '', status: 'idle', startedAt: 0, pid: 0, id: '', state: 'idle', waitingFor: '' }])
  // the working state and a prompt the session waits on are read from the listing
  const w = parseAgents(JSON.stringify([{ sessionId: 'c', status: 'busy', state: 'working' }, { sessionId: 'd', status: 'busy', waitingFor: 'permission prompt' }, { sessionId: 'e', status: 'busy', waitingFor: { kind: 'permission', tool: 'Bash' } }]))
  expect(w.map(r => [r.state, r.waitingFor])).toEqual([['working', ''], ['', 'permission prompt'], ['', '{"kind":"permission","tool":"Bash"}']])
  expect(parseAgents('not json')).toEqual([])
  expect(parseAgents('')).toEqual([])
  expect(parseAgents('{"agents":5}')).toEqual([])
})

test('the desk gets lean_thread at session start, and the tool answers', { timeoutMs: 20_000 }, async ($, on) => {
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
    return { exitCode: 0, stdout: a[0] === 'agents' ? JSON.stringify(state.rows) : a[0] === '--bg' ? 'note: session is already running in the background, so this started a copy as aaaaaaaa\n' : '' }
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

test('the private list follows projects.json on every action (resume, wake, list); writes are chmod+rename, never in place', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const list = '/h/.lean-agent/githooks/private.list'
  expect(h.files.get(list)).not.toContain('/r/vault')
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ vault: { path: '/r/vault', private: true, remote: 'https://h/V.git' } }))
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'idle', startedAt: 1 }]
  await call({ action: 'list' })
  expect(h.files.get(list)).toContain('path /r/vault')
  expect(h.files.get(list)).toContain('url https://h/v')
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ vault: { path: '/r/vault2', private: true } }))
  h.clock.t += 60_000
  await call({ action: 'resume', tN: 't1' })
  expect(h.files.get(list)).toContain('path /r/vault2')
  expect(h.files.get(list)).not.toContain('/r/vault\n')
  // atomic: temp file -> chmod 755 (wrappers) -> mv; no temp left behind; direct writes only go to temp names
  const argvs = h.calls.map((c: any) => c.argv)
  expect(argvs.some((a: string[]) => a[0] === 'chmod' && a[1] === '755' && /githooks\/.*\.tmp-/.test(a[2]!))).toBe(true)
  expect(argvs.some((a: string[]) => a[0] === 'mv' && a[3] === list)).toBe(true)
  expect([...h.files.keys()].filter(k => k.includes('.tmp-') && k.includes('githooks'))).toEqual([])
})

test('a resume carries no flag besides --resume (any extra flag starts a copy)', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'done', startedAt: 1 }]
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  const r = h.claudeCalls().find(a => a.includes('--resume'))!
  expect(r.filter(x => x.startsWith('-') && x !== '--resume' && x !== '--bg' && x !== '--')).toEqual([])
  expect(r).not.toContain('-n')
})

test('"started a copy as <id>" in the resume output moves the thread to the copy and says so', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const COPY = 'cafe1234-2222-3333-4444-555555555555'
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'done', startedAt: 1 }]
  h.clock.t += 60_000
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify([...state.rows, { sessionId: COPY, name: 'other', cwd: 'y', status: 'busy', startedAt: 0 }]) }
    if (a.includes('--resume')) return { exitCode: 0, stdout: 'the flags you passed started a copy as cafe1234\n' }
    return { exitCode: 0, stdout: '' }
  }
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe(COPY)
  expect(JSON.stringify(r)).toContain('started a copy')
})

test('a copy id that is not listed is not stored as a bare prefix; the old sid stays and the result says so', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'done', startedAt: 1 }]
  h.clock.t += 60_000
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a.includes('--resume') ? { exitCode: 0, stdout: '', stderr: 'started a copy as CAFE1234' } : base(a, {} as any))
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe(SID)
  expect(JSON.stringify(r)).toContain('cafe1234')
})

test('close reports a failing claude stop', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 'x', cwd: 'x', status: 'busy', startedAt: 1 }]
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a[0] === 'stop' ? { exitCode: 1, stdout: '', stderr: 'no such session' } : base(a, {} as any))
  expect((await call({ action: 'close', tN: 't1' })).text).toContain('no such session')
})

test('the CLI\'s "woke session X with its saved options" line is not a copy: the sid stays', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', status: 'done', startedAt: 1 }]
  h.clock.t += 60_000
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a.includes('--resume') ? { exitCode: 0, stdout: `woke session ${SID.slice(0, 8)} with its saved options\n` } : base(a, {} as any))
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe(SID)
  expect(JSON.stringify(r)).not.toContain('copy')
})

// a scripted CLI where a finished session may still have its process (pid) until `claude stop`
function alive(state: any, h: any, row: any) {
  state.rows = [row]
  const calls: string[] = []
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(state.rows) }
    calls.push(a.slice(0, 2).join(' '))
    if (a[0] === 'stop') { delete state.rows[0].pid; state.rows[0].state = 'stopped'; delete state.rows[0].status; return { exitCode: 0, stdout: 'stopped' } }
    return { exitCode: 0, stdout: '' }
  }
  return calls
}
const ROW = { sessionId: SID, id: SID.slice(0, 8), name: 't1 · a', cwd: '/h/.lean-agent/threads/t1', startedAt: 1 }

test('a finished session whose process is still alive is stopped first, then resumed without flags', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, pid: 42, status: 'idle', state: 'done' })
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  expect(calls).toEqual(['stop 11111111', '--bg --resume'])
  expect(h.claudeCalls().find(a => a.includes('--resume'))!.filter(x => x.startsWith('-'))).toEqual(['--bg', '--resume', '--'])
})

test('a session whose process exited is resumed with no stop', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, state: 'done' })
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  expect(calls).toEqual(['--bg --resume'])
})

test('a working session (alive) is never stopped or resumed; the message stays queued', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, pid: 42, status: 'busy', state: 'working' })
  h.clock.t += 60_000
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(calls).toEqual([])
  expect(r.text).toContain('queued')
})

test('a stop that fails or does not end the process leaves the messages queued and resumes nothing', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, pid: 42, status: 'idle', state: 'done' })
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a[0] === 'stop' ? { exitCode: 1, stdout: '', stderr: 'nope' } : base(a, {} as any))
  h.clock.t += 60_000
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(r.ok).toBe(false)
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify(state.rows) } : { exitCode: 0, stdout: '' }) // stop "works" but the process stays
  const r2 = await call({ action: 'resume', tN: 't1' })
  expect(r2.ok).toBe(false)
  expect(r2.text).toContain('still running')
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
})

test('an ambiguous short copy id keeps the old sid and says it matches several sessions', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ ...ROW, state: 'done' }, { sessionId: 'cafe0001-0000-0000-0000-000000000000', name: 'x', cwd: 'y', status: 'busy', startedAt: 0 }, { sessionId: 'cafe0002-0000-0000-0000-000000000000', name: 'z', cwd: 'y', status: 'busy', startedAt: 0 }]
  h.clock.t += 60_000
  h.claude.handler = (a: string[]) => (a[0] === 'agents' ? { exitCode: 0, stdout: JSON.stringify(state.rows) } : a.includes('--resume') ? { exitCode: 0, stdout: 'started a copy as cafe00' } : { exitCode: 0, stdout: '' })
  const r = await call({ action: 'send', tN: 't1', text: 'one' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid).toBe(SID)
  expect(r.text).toContain('several sessions')
})

test('new and start pass --model/--effort (call > config.json > default), record them, and list shows them; resume passes none', async () => {
  const { h, state, call } = setup()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { model: 'haiku' } }))
  await call({ action: 'new', title: 'cheap', text: 'x' })
  expect(h.claudeCalls().find(a => a[0] === '--bg')!.slice(3, 7)).toEqual(['--model', 'haiku', '--effort', 'high']) // the default effort is high (specs run with lean.orchestrate off: the medium default is in the orchestrating specs below)
  await call({ action: 'new', title: 'hard', text: 'x', model: 'sonnet', effort: 'high' })
  expect(h.claudeCalls().filter(a => a[0] === '--bg')[1]!.slice(3, 7)).toEqual(['--model', 'sonnet', '--effort', 'high'])
  const t2 = JSON.parse(h.files.get('/h/.lean-agent/threads/t2/thread.json')!)
  expect([t2.model, t2.effort]).toEqual(['sonnet', 'high'])
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t2/.claude/settings.json')!)).toMatchObject({ model: 'sonnet', effortLevel: 'high' })
  expect((await call({ action: 'list' })).text).toContain('t2 · hard')
  expect((await call({ action: 'list' })).text).toContain('sonnet/high')
  // a bad value stops before any folder exists
  const bad = await call({ action: 'new', title: 'x', model: 'gpt' })
  expect(bad.ok).toBe(false)
  expect(h.files.has('/h/.lean-agent/threads/t3/thread.json')).toBe(false)
  // start with a lighter task overrides the recorded choice
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ ...JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!), sid: '' }))
  await call({ action: 'start', tN: 't1', effort: 'low' })
  expect(h.claudeCalls().filter(a => a[0] === '--bg').pop()!.slice(3, 7)).toEqual(['--model', 'haiku', '--effort', 'low'])
  // resume: saved options, no flags
  state.rows = [{ sessionId: SID, name: 'x', cwd: 'x', status: 'idle', startedAt: 1 }]
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't2', text: 'again' })
  const resumes = h.claudeCalls().filter(a => a.includes('--resume'))
  for (const r of resumes) expect(r.some(x => x === '--model' || x === '--effort')).toBe(false)
})

test('thread defaults are sonnet/medium while lean.orchestrate is on (high when off); config.json threads.effort and the call still override', async () => {
  const { h, call } = setup(null, true)
  await call({ action: 'new', title: 'plain', text: 'x' })
  expect(h.claudeCalls().filter(a => a[0] === '--bg')[0]!.slice(3, 7)).toEqual(['--model', 'sonnet', '--effort', 'medium'])
  expect((await call({ action: 'new', title: 'plain2', text: 'x' })).text).toContain('sonnet/medium') // the start reply names the effort
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ threads: { effort: 'low' } }))
  await call({ action: 'new', title: 'cfg', text: 'x' })
  expect(h.claudeCalls().filter(a => a[0] === '--bg')[2]!.slice(3, 7)).toEqual(['--model', 'sonnet', '--effort', 'low'])
  await call({ action: 'new', title: 'call', text: 'x', effort: 'high' })
  expect(h.claudeCalls().filter(a => a[0] === '--bg')[3]!.slice(3, 7)).toEqual(['--model', 'sonnet', '--effort', 'high'])
})

test('effort by role: a restart recomputes a recorded default, keeps an effort a call named, and lean.orchestrate off means high', async () => {
  const { h, call } = setup(null, true)
  const bg = () => h.claudeCalls().filter(a => a[0] === '--bg')
  await call({ action: 'new', title: 'plain', text: 'x' }) // t1: default
  await call({ action: 'new', title: 'design', text: 'x', effort: 'high' }) // t2: the desk named high (design / refactoring)
  expect(bg()[1]!.slice(5, 7)).toEqual(['--effort', 'high'])
  const rec = (id: string, over: any) => h.files.set(`/h/.lean-agent/threads/${id}/thread.json`, JSON.stringify({ ...JSON.parse(h.files.get(`/h/.lean-agent/threads/${id}/thread.json`)!), sid: '', ...over }))
  rec('t1', { effort: 'high' }) // a record from before 1.0.27: high only because it was the default
  await call({ action: 'start', tN: 't1' })
  await call({ action: 'start', tN: 't2' })
  expect(bg()[2]!.slice(5, 7)).toEqual(['--effort', 'medium']) // restart of the defaulted thread
  expect(bg()[3]!.slice(5, 7)).toEqual(['--effort', 'high']) // the named one keeps it
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ lean: { orchestrate: false } }))
  await call({ action: 'new', title: 'self', text: 'x' }) // a thread that edits itself keeps high
  expect(bg()[4]!.slice(5, 7)).toEqual(['--effort', 'high'])
})

test('a dead status with a lingering process is stopped and resumed, not left queued', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, pid: 42, status: 'failed', state: 'failed' })
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  expect(calls).toEqual(['stop 11111111', '--bg --resume'])
})

test('a row that vanishes after the stop, or a pid that clears on a later poll, still resumes', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ ...ROW, pid: 42, status: 'idle', state: 'done' }]
  let polls = 0
  const calls: string[] = []
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') { if (a[1] === '--json' && calls.includes('stop 11111111') && ++polls >= 3) state.rows = []; return { exitCode: 0, stdout: JSON.stringify(state.rows) } }
    calls.push(a.slice(0, 2).join(' '))
    return { exitCode: 0, stdout: '' }
  }
  h.clock.t += 60_000
  await call({ action: 'send', tN: 't1', text: 'one' })
  expect(calls).toEqual(['stop 11111111', '--bg --resume'])
})

test('close stops a finished session whose process is still alive, by the listed id', async () => {
  const { h, state, call } = setup()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const calls = alive(state, h, { ...ROW, id: 'abcd1234', pid: 42, status: 'idle', state: 'done' })
  const r = await call({ action: 'close', tN: 't1' })
  expect(calls).toEqual(['stop abcd1234', 'rm abcd1234']) // stopped, then taken out of the app's list
  expect(r.text).toBe("t1 closed; session stopped and removed from the app's list (its conversation is kept)")
})

test('close says what happened to the session: stopped, already stopped, not listed, never started; rm only for a session in the thread folder, never with discard flags', async () => {
  const { h, state, call } = setup()
  expect((await call({ action: 'new', title: 'never', text: 'b' })).ok).toBe(true)
  const t = (n: string) => JSON.parse(h.files.get(`/h/.lean-agent/threads/${n}/thread.json`)!)
  // never started: no sid
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ ...t('t1'), sid: '' }))
  expect((await call({ action: 'close', tN: 't1' })).text).toBe('t1 closed; no session was ever started')
  // a finished session without a process: nothing to stop, still taken out of the list
  await call({ action: 'new', title: 'b', text: 'b' })
  const orig = h.claude.handler // (prints the sid for --bg)
  const calls = alive(state, h, { ...ROW, name: 't2 · b', cwd: '/h/.lean-agent/threads/t2', id: 'abcd1234', status: 'idle', state: 'done' })
  const scripted = h.claude.handler
  h.claude.handler = (a: string[], x: any) => (a[0] === '--bg' ? orig(a, x) : scripted(a, x))
  expect((await call({ action: 'close', tN: 't2' })).text).toBe("t2 closed; no running session (already stopped) and removed from the app's list (its conversation is kept)")
  expect(calls).toEqual(['rm abcd1234']) // no `--discard-unpushed`, no `--force-remove-worktree`
  // rm refused: the reply says so and the thread is closed anyway
  await call({ action: 'new', title: 'c', text: 'b' })
  state.rows = [{ ...ROW, cwd: '/h/.lean-agent/threads/t3', id: 'abcd1234', status: 'idle', state: 'done' }]
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a[0] === 'rm' ? { exitCode: 1, stdout: '', stderr: 'has unpushed commits' } : base(a, {} as any))
  const r = await call({ action: 'close', tN: 't3' })
  expect(r.ok).toBe(true)
  expect(r.text).toBe('t3 closed; no running session (already stopped); the app keeps stopped sessions in its list (claude rm: has unpushed commits)')
  expect(t('t3').state).toBe('closed')
  // a session not in the list at all (already removed)
  await call({ action: 'new', title: 'd', text: 'b' })
  state.rows = []
  expect((await call({ action: 'close', tN: 't4' })).text).toBe('t4 closed; no session in the list (already removed)')
  // a session listed from another folder (a worktree session, say) is never removed
  await call({ action: 'new', title: 'e', text: 'b' })
  h.claude.handler = base
  state.rows = [{ ...ROW, cwd: '/somewhere/else', id: 'abcd1234', status: 'idle', state: 'done' }]
  expect((await call({ action: 'close', tN: 't5' })).text).toBe('t5 closed; no running session (already stopped); the app keeps stopped sessions in its list')
  expect(h.claudeCalls().filter(a => a[0] === 'rm')).toHaveLength(2) // t2 and t3 only
})

test('a failed claude stop runs no rm; a guide built without a choice (compare\'s folder) has no model line instead of a guessed one', async () => {
  const { h, state, call } = setup()
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}\nmodel: {{model}}, effort: {{effort}} (from thread.json)\nafter')
  await call({ action: 'new', title: 'a', text: 'brief' })
  state.rows = [{ sessionId: SID, id: SID.slice(0, 8), name: 'x', cwd: '/h/.lean-agent/threads/t1', status: 'busy', startedAt: 1 }]
  const base = h.claude.handler
  h.claude.handler = (a: string[]) => (a[0] === 'stop' ? { exitCode: 1, stdout: '', stderr: 'denied' } : base(a, {} as any))
  const r = await call({ action: 'close', tN: 't1' })
  expect(r.text).toContain('claude stop 11111111 failed: denied')
  expect(h.claudeCalls().some(a => a[0] === 'rm')).toBe(false)
  expect(await threadClaudeMd(h.host, ROOT, 't9', 'compare', '')).toBe('# t9\nafter')
  expect(await threadClaudeMd(h.host, ROOT, 't1', 'a', '', { model: 'opus', effort: 'low' })).toContain('model: opus, effort: low (from thread.json)')
})

test('start, new and reopen say the model and effort the session got; the thread guide carries the same line', async () => {
  const { h, state, call } = setup()
  h.files.set('/h/.lean-agent/config.json', '{"threads":{"plugins":"all","skills":"all"}}') // the pre-1.0.20 behaviour (the lean defaults: threadlean.test.ts)
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}}\nmodel: {{model}}, effort: {{effort}} (from thread.json)')
  const r = await call({ action: 'new', title: 'a', text: 'brief' })
  const FREE = 'free context 80k (limit 120k, base ~40k assumed)' // the start reply states the free context (briefsize.ts)
  expect(r.text).toBe(`t1 started (${SID}) · sonnet/high · ${FREE}`)
  expect(h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md')).toContain('model: sonnet, effort: high (from thread.json)')
  const o = await call({ action: 'new', title: 'b', text: 'brief', model: 'haiku', effort: 'low' })
  expect(o.text).toBe(`t2 started (${SID}) · haiku/low · ${FREE}`)
  expect(h.files.get('/h/.lean-agent/threads/t2/CLAUDE.md')).toContain('model: haiku, effort: low (from thread.json)')
  // start of a thread that has no running session, and a reopen with another choice (the guide is rewritten when lean-agent wrote it)
  h.files.set(`${ROOT}/templates/thread.md`, '<!-- generated by lean-agent for thread {{id}} -->\nmodel: {{model}}, effort: {{effort}} (from thread.json)')
  h.files.set('/h/.lean-agent/threads/t1/CLAUDE.md', '<!-- generated by lean-agent for thread t1 -->\nold')
  state.rows = []
  expect((await call({ action: 'start', tN: 't1' })).text).toMatch(new RegExp(`^t1 started \\(${SID}\\) · sonnet/high · free context [^·]+ · new session: handover about \\d+ tokens`)) // it replaces an earlier session: the cost line
  await call({ action: 'close', tN: 't1' })
  const re = await call({ action: 'reopen', tN: 't1', model: 'haiku' })
  expect(re.text).toContain(`t1 reopened as a new session (old conversation kept read-only). t1 started (${SID}) · haiku/high`)
  expect(h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md')).toContain('model: haiku, effort: high (from thread.json)')
})

test('list shows "agents 3/4" next to a thread when agents.cap is set (reviewer passes are not in the count), and nothing without a cap', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'one', text: 'y' })
  expect((await call({ action: 'list' })).text).not.toContain('agents')
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ agents: { cap: 4 } }))
  const sid = JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).sid
  h.files.set('/h/.lean-agent/threads/t1/subagents.json', JSON.stringify({ sid, counted: 3, review: 2, second: 0 }))
  const l = await call({ action: 'list' })
  expect(l.text).toContain(' · agents 3/4')
  expect((l.data as any[])[0].agents).toBe('agents 3/4')
  // a count of another session (a restart) starts again at 0
  h.files.set('/h/.lean-agent/threads/t1/subagents.json', JSON.stringify({ sid: 'old', counted: 3, review: 0, second: 0 }))
  expect((await call({ action: 'list' })).text).toContain(' · agents 0/4')
})

test('new refuses an unknown project with the known names and creates nothing; list shows the project', async () => {
  const { h, call } = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' }, vault: { path: '/r/vault', private: true } }))
  const bad = await call({ action: 'new', title: 'x', text: 'y', project: 'apps' })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('unknown project apps')
  expect(bad.text).toContain('app, vault')
  expect(h.files.has('/h/.lean-agent/threads/t1/thread.json')).toBe(false)
  expect(h.claudeCalls().some(a => a[0] === '--bg')).toBe(false)
  // the private switch hides a private project: its name is neither accepted nor leaked
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ private: 'off' }))
  const hid = await call({ action: 'new', title: 'x', text: 'y', project: 'vault' })
  expect(hid.ok).toBe(false)
  expect(hid.text).toContain('known projects: app.') // (the name asked for is echoed; the hidden one is not listed)
  h.files.delete('/h/.lean-agent/config.json')
  expect((await call({ action: 'new', title: 'ok', text: 'y', project: 'app' })).ok).toBe(true)
  expect((await call({ action: 'new', title: 'none', text: 'y' })).ok).toBe(true) // no project: fine
  const l = (await call({ action: 'list' })).text
  expect(l).toContain('t1 · ok · app [')
  expect(l).toContain('t2 · none [')
  h.files.set('/h/.lean-agent/projects.json', '{broken')
  expect((await call({ action: 'new', title: 'x', text: 'y', project: 'app' })).text).toContain('unreadable')
})

test('the desk sets and clears a thread goal through lean_thread; nothing else in goals.json changes', async () => {
  const { h, call } = setup()
  await call({ action: 'new', title: 'a', text: 'b' })
  h.files.set('/h/.lean-agent/goals.json', JSON.stringify({ t9: { text: 'other', ts: 5 } }))
  expect((await call({ action: 'goal-set', tN: 't1' })).ok).toBe(false)
  expect((await call({ action: 'goal-set', tN: 't7', text: 'x' })).ok).toBe(false) // no such thread
  expect((await call({ action: 'goal-set', tN: 't1', text: ' ship login ' })).ok).toBe(true)
  let g = JSON.parse(h.files.get('/h/.lean-agent/goals.json')!)
  expect(g.t1).toEqual({ text: 'ship login', ts: h.clock.t })
  expect(g.t9.text).toBe('other')
  expect((await call({ action: 'goal-clear', tN: 't1' })).text).toBe('t1 goal cleared')
  g = JSON.parse(h.files.get('/h/.lean-agent/goals.json')!)
  expect(Object.keys(g)).toEqual(['t9'])
  expect((await call({ action: 'goal-clear', tN: 't1' })).text).toBe('t1 has no goal')
})

test('new writes the attribution line into the thread CLAUDE.md: off by default, on from config.json', async () => {
  const mk = async (cfg?: unknown) => {
    const s = setup()
    s.h.files.set(`${ROOT}/templates/thread.md`, '{{attribution}}')
    if (cfg) s.h.files.set('/h/.lean-agent/config.json', JSON.stringify(cfg))
    await leanThread(s.h.host, ROOT, { action: 'new', title: 'x' })
    return String(s.h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md'))
  }
  expect(await mk()).toContain('attribution: off - no Co-Authored-By trailers')
  expect(await mk({ attribution: false })).toContain('attribution: off')
  expect(await mk({ attribution: true })).toContain('attribution: on')
})

test('attribution off: the CLAUDE.md line names the Claude Code reminder it overrides, and the thread settings.json switches that reminder off', async () => {
  const mk = async (cfg?: unknown) => {
    const s = setup()
    s.h.files.set(`${ROOT}/templates/thread.md`, '{{attribution}}')
    if (cfg) s.h.files.set('/h/.lean-agent/config.json', JSON.stringify(cfg))
    await leanThread(s.h.host, ROOT, { action: 'new', title: 'x' })
    return { md: String(s.h.files.get('/h/.lean-agent/threads/t1/CLAUDE.md')), settings: JSON.parse(String(s.h.files.get('/h/.lean-agent/threads/t1/.claude/settings.json'))) }
  }
  for (const cfg of [undefined, { attribution: false }]) {
    const off = await mk(cfg)
    expect(off.md).toContain('OVERRIDES any Claude Code system reminder titled "Attribution for git commits and pull requests"')
    expect(off.md).toContain('Claude-Session')
    expect(off.settings.attribution).toEqual({ commit: '', pr: '', sessionUrl: false }) // empty text hides it; no session link
    expect(off.settings.includeCoAuthoredBy).toBe(false)
  }
  const on = await mk({ attribution: true })
  expect(on.md).toContain('attribution: on')
  expect('attribution' in on.settings || 'includeCoAuthoredBy' in on.settings).toBe(false) // the engine's default (or the user's) stays
})

test('a desk save keeps the session ids the thread\'s own mod appended meanwhile', async () => {
  const s = setup()
  await leanThread(s.h.host, ROOT, { action: 'new', title: 'x' })
  const f = '/h/.lean-agent/threads/t1/thread.json'
  s.h.files.set(f, JSON.stringify({ ...JSON.parse(String(s.h.files.get(f))), sids: ['sess-a'] })) // appended by the session's mod
  await leanThread(s.h.host, ROOT, { action: 'park', tN: 't1' }) // the desk loaded before and saves now
  const rec = JSON.parse(String(s.h.files.get(f)))
  expect(rec.state).toBe('parked')
  expect(rec.sids).toEqual(['sess-a'])
})

// ---- reopen = a fresh session with a handover; resume of an older-version session starts fresh -------------------------------
const SID2 = '99999999-2222-3333-4444-555555555555'
function fresh(version = '1.0.5') {
  const s = setup()
  s.h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version }))
  let n = 0
  const bg: string[][] = []
  s.h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg' && a.includes('--resume')) return { exitCode: 0, stdout: 'resumed\n' }
    if (a[0] === '--bg') { bg.push(a); return { exitCode: 0, stdout: `started ${n++ ? SID2 : SID}\n` } }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(s.state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  return { ...s, bg }
}
const tfile = (h: any, f: string) => `/h/.lean-agent/threads/t1/${f}`
const jf = (h: any, p: string) => JSON.parse(String(h.files.get(p)))

test('close clears the thread goal (and says so); the folder and the reports stay', async () => {
  const { h, call } = fresh()
  await call({ action: 'new', title: 'a', text: 'brief' })
  h.files.set('/h/.lean-agent/goals.json', JSON.stringify({ t1: { text: 'ship it', ts: 1 }, t2: { text: 'other', ts: 2 } }))
  const r = await call({ action: 'close', tN: 't1' })
  expect(r.text).toBe('t1 closed, goal cleared; no session in the list (already removed)')
  expect(Object.keys(jf(h, '/h/.lean-agent/goals.json'))).toEqual(['t2'])
  expect(h.files.has(tfile(h, 'brief.md'))).toBe(true)
  expect((await call({ action: 'close', tN: 't1' })).text).toBe('t1 closed; no session in the list (already removed)') // nothing left to clear
})

test('reopen of a closed thread starts a NEW session (claude --bg, never --resume) with a handover; the old sid stays as history', async () => {
  const { h, state, bg, call } = fresh()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  await call({ action: 'new', title: 'fix login', text: 'fix the login bug in the api', project: 'app', model: 'haiku', effort: 'low' })
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'app/fix-login': { path: '/h/.lean-agent/worktrees/app/fix-login', repo: '/r/app', branch: 'fix-login', thread: 't1' }, 'app/other': { path: '/w/other', branch: 'other', thread: 't2' } }))
  h.files.set('/h/.lean-agent/goals.json', JSON.stringify({ t1: { text: 'login fixed and reviewed', ts: 1 } }))
  h.files.set(tfile(h, 'notes.md'), '# notes\nthe flaky part is the clock\n')
  h.files.set('/h/.lean-agent/memory/notes.jsonl', JSON.stringify({ from: 't1', text: 'api uses pnpm' }) + '\n' + JSON.stringify({ from: 't2', text: 'someone elses' }) + '\n')
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', [
    { ts: 1, from: 't1', kind: 'report', text: 'first look done', state: 'working' },
    { ts: 2, from: 't2', kind: 'report', text: 'unrelated thread', state: 'done' },
    { ts: 3, from: 't1', kind: 'report', text: 'branch fix-login, last commit abc1234, not pushed; next: open the PR', state: 'done' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  await call({ action: 'close', tN: 't1' })
  await call({ action: 'send', tN: 't1', text: 'also bump the changelog' }) // queued while closed
  state.rows = []
  const r = await call({ action: 'reopen', tN: 't1' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 reopened as a new session (old conversation kept read-only)')
  expect(h.claudeCalls().some(a => a.includes('--resume'))).toBe(false)
  expect(bg).toHaveLength(2) // the first start and the fresh one
  const argv = bg[1]!
  expect(argv.slice(0, 7)).toEqual(['--bg', '-n', 't1 · fix login (2)', '--model', 'haiku', '--effort', 'low']) // thread.json's model/effort; the second session
  const prompt = argv[argv.length - 1]!
  expect(prompt.startsWith('Resume the work now (task: login fixed and reviewed).')).toBe(true) // the goal is the task, first
  for (const need of ['NEW session', 'fix the login bug in the api', 'login fixed and reviewed', 'branch fix-login', 'worktrees/app/fix-login', 'the flaky part is the clock', 'api uses pnpm', 'also bump the changelog', 'first look done', 'last commit abc1234, not pushed']) expect(prompt).toContain(need)
  expect(prompt).not.toContain('unrelated thread')
  expect(prompt).not.toContain('someone elses')
  expect(prompt.indexOf('first look done')).toBeLessThan(prompt.indexOf('last commit abc1234')) // oldest first, newest last
  const t = jf(h, tfile(h, 'thread.json'))
  expect([t.state, t.sid, t.model, t.effort, t.version]).toEqual(['open', SID2, 'haiku', 'low', '1.0.5'])
  expect(t.sids).toContain(SID) // the old session id is history
  expect(t.delivered).toBe(1) // the queued message went into the handover
})

test('reopen refuses while the old session still runs, and a parked thread reopens as before (same session, use resume)', async () => {
  const { h, state, bg, call } = fresh()
  await call({ action: 'new', title: 'a', text: 'brief' })
  await call({ action: 'park', tN: 't1' })
  expect((await call({ action: 'reopen', tN: 't1' })).text).toBe('t1 reopened; use resume to wake it')
  expect(bg).toHaveLength(1) // no new session for a parked thread
  await call({ action: 'close', tN: 't1' })
  state.rows = [{ ...ROW, status: 'busy', pid: 7 }]
  const r = await call({ action: 'reopen', tN: 't1' })
  expect(r.text).toContain('running')
  expect(bg).toHaveLength(1)
  expect(jf(h, tfile(h, 'thread.json')).state).toBe('closed')
  // a failed start leaves it closed
  state.rows = []
  h.claude.handler = (a: string[]) => (a[0] === '--bg' ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: '[]' })
  const bad = await call({ action: 'reopen', tN: 't1' })
  expect(bad.ok).toBe(false)
  expect(jf(h, tfile(h, 'thread.json')).state).toBe('closed')
})

test('resume of an idle thread stays a resume when the recorded version is current or unknown; an older one starts fresh and says why', async () => {
  const { h, state, bg, call } = fresh('1.0.5')
  await call({ action: 'new', title: 'a', text: 'brief' })
  expect(jf(h, tfile(h, 'thread.json')).version).toBe('1.0.5')
  state.rows = [{ ...ROW, status: 'idle', state: 'done' }]
  h.clock.t += 60_000
  await call({ action: 'resume', tN: 't1' })
  expect(h.claudeCalls().filter(a => a.includes('--resume'))).toHaveLength(1) // same version: a resume
  expect(bg).toHaveLength(1)
  // no version recorded (a thread from before the field): unknown, so a resume
  const rec = jf(h, tfile(h, 'thread.json'))
  delete rec.version
  h.files.set(tfile(h, 'thread.json'), JSON.stringify(rec))
  h.clock.t += 60_000
  await call({ action: 'resume', tN: 't1' })
  expect(h.claudeCalls().filter(a => a.includes('--resume'))).toHaveLength(2)
  expect(jf(h, tfile(h, 'thread.json')).version).toBe('1.0.5') // a resume records the installed version
  // an older recorded version: fresh session with the handover, the old sid kept as history
  h.files.set(tfile(h, 'thread.json'), JSON.stringify({ ...jf(h, tfile(h, 'thread.json')), version: '1.0.4' }))
  h.clock.t += 60_000
  const r = await call({ action: 'resume', tN: 't1' })
  expect(r.text).toContain('new session instead of a resume')
  expect(r.text).toContain('1.0.4')
  expect(r.text).toContain('1.0.5')
  expect(h.claudeCalls().filter(a => a.includes('--resume'))).toHaveLength(2) // no third resume
  expect(bg).toHaveLength(2)
  expect(bg[1]![bg[1]!.length - 1]).toContain('instead of a resume')
  const t = jf(h, tfile(h, 'thread.json'))
  expect([t.sid, t.version]).toEqual([SID2, '1.0.5'])
  expect(t.sids).toContain(SID)
  // 1.0.10 is newer than 1.0.9 (numeric compare)
  expect(olderVersion('1.0.9', '1.0.10')).toBe(true)
  expect(olderVersion('1.0.10', '1.0.9')).toBe(false)
  expect(olderVersion(undefined, '1.0.5')).toBe(false)
})

test('a fresh session regenerates the thread CLAUDE.md only when lean-agent wrote it', async () => {
  const { h, state, call } = fresh()
  h.files.set(`${ROOT}/templates/thread.md`, '<!-- generated by lean-agent for thread {{id}} -->\nnew rules {{id}}')
  await call({ action: 'new', title: 'a', text: 'brief' })
  h.files.set(tfile(h, 'CLAUDE.md'), '<!-- generated by lean-agent for thread t1 -->\nold rules')
  await call({ action: 'close', tN: 't1' })
  state.rows = []
  await call({ action: 'reopen', tN: 't1' })
  expect(h.files.get(tfile(h, 'CLAUDE.md'))).toContain('new rules t1')
  // the user's own file is left alone
  await call({ action: 'close', tN: 't1' })
  h.files.set(tfile(h, 'CLAUDE.md'), 'my own notes')
  await call({ action: 'reopen', tN: 't1' })
  expect(h.files.get(tfile(h, 'CLAUDE.md'))).toBe('my own notes')
})

test('a huge report and queue cannot blow the handover past one argv string; a close with an empty goal text still says cleared', async () => {
  const { h, state, bg, call } = fresh()
  await call({ action: 'new', title: 'a', text: 'brief' })
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', JSON.stringify({ ts: 1, from: 't1', kind: 'report', text: 'Z'.repeat(200_000), state: 'done' }) + '\n')
  h.files.set('/h/.lean-agent/goals.json', JSON.stringify({ t1: { text: '', ts: 1 } }))
  expect((await call({ action: 'close', tN: 't1' })).text).toBe('t1 closed, goal cleared; no session in the list (already removed)')
  for (let n = 0; n < 40; n++) await call({ action: 'send', tN: 't1', text: 'q'.repeat(10_000) })
  state.rows = []
  expect((await call({ action: 'reopen', tN: 't1' })).ok).toBe(true)
  const prompt = bg[1]![bg[1]!.length - 1]!
  expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX + 200)
  expect(prompt).toContain('older messages omitted')
})

test('an older report cut in the handover names the file with its full text, written when the desk never made one', async () => {
  const { h, state, bg, call } = fresh()
  await call({ action: 'new', title: 'a', text: 'brief' })
  const long = 'L'.repeat(1200)
  const rows = [
    { ts: 10, from: 't1', kind: 'report', text: 'ancient', state: 'working' }, // older than the last 3: only counted
    { ts: 11, from: 't1', kind: 'report', text: `early ${long}`, state: 'working' }, // cut (200) and the desk never wrote a file: the handover does
    { ts: 12, from: 't1', kind: 'report', text: `middle ${long}`, state: 'working' }, // cut, the desk's own file already exists
    { ts: 13, from: 't1', kind: 'report', text: 'short one', state: 'working' }, // whole: no pointer
  ]
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  h.files.set('/h/.lean-agent/desk/reports/12-t1-report.md', 'the desk wrote this')
  await call({ action: 'close', tN: 't1' })
  state.rows = []
  await call({ action: 'reopen', tN: 't1' })
  const prompt = bg[1]![bg[1]!.length - 1]!
  expect(prompt).toContain('1 older reports: lean_thread report t1')
  expect(prompt).not.toContain('ancient')
  expect(prompt).toContain('(cut: full text in /h/.lean-agent/desk/reports/11-t1-report.md)')
  expect(prompt).toContain('(cut: full text in /h/.lean-agent/desk/reports/12-t1-report.md)')
  expect(h.files.get('/h/.lean-agent/desk/reports/11-t1-report.md')).toBe(`# Report from t1 (working)\n\nearly ${long}\n`)
  expect(h.files.get('/h/.lean-agent/desk/reports/12-t1-report.md')).toBe('the desk wrote this') // never overwritten
  expect(h.files.has('/h/.lean-agent/desk/reports/13-t1-report.md')).toBe(false) // a report that is whole needs no file
  expect(prompt.split('\n').find(l => l.includes('short one'))).not.toContain('cut:')
})

test('reportHistory names the full-text path of a cut line only when asked, and reports which were cut', () => {
  const recs = [{ ts: 1, from: 't1', kind: 'report' as const, text: 'x'.repeat(900), state: 'working' }, { ts: 2, from: 't1', kind: 'ask' as const, text: 'last?', state: undefined }]
  expect(reportHistory(recs).lines[0]).not.toContain('full text in')
  const r = reportHistory(recs, x => `/d/reports/${x.ts}.md`)
  expect(r.lines[0]).toContain('(cut: full text in /d/reports/1.md)')
  expect(r.cutRecs.map(x => x.ts)).toEqual([1])
})

test('1.0.27: the handover keeps the last 3 reports as 200-character digests and counts the older ones', () => {
  const recs = Array.from({ length: 40 }, (_, n) => ({ ts: n, from: 't1', kind: 'report' as const, text: `report ${n} ` + 'x'.repeat(900), state: 'working' }))
  recs.push({ ts: 99, from: 't1', kind: 'report', text: 'FINAL ' + 'y'.repeat(5000), state: 'done' })
  const { lines, omitted } = reportHistory(recs)
  expect(lines).toHaveLength(3)
  expect(lines[2]).toContain('[done] FINAL ')
  expect(lines[2]!.length).toBeLessThan(260)
  expect(omitted).toBe(38)
  expect(lines.some(l => l.includes('report 39'))).toBe(true)
  expect(lines.some(l => l.includes('report 0 '))).toBe(false)
  expect(reportHistory([]).lines).toEqual([])
})
