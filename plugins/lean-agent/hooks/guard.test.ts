import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'

const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const desk = { kind: 'desk' } as const
const thread = { kind: 'thread', id: 't1' } as const
const plain = { kind: 'plain' } as const

function setup() {
  const h = fakeHost(null)
  h.git.handler = a => (a.includes('rev-parse') ? { exitCode: 0, stdout: SHA + '\n' } : { exitCode: 1, stdout: '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' }, secret: { path: '/r/secret', private: true } }))
  return h
}
const run = (h: any, role: any, e: any, cwd = '/r/app', agentType?: string) => decide(h.host, { role, cwd, agentType }, e)

const deskTable: [string, any, boolean][] = [
  ['Edit', { tool: 'Edit', file_path: '/h/x' }, false],
  ['Write', { tool: 'Write', file_path: '/h/x' }, false],
  ['NotebookEdit', { tool: 'NotebookEdit', notebook_path: '/h/x' }, false],
  ['Agent', { tool: 'Agent' }, false],
  ['WebFetch', { tool: 'WebFetch' }, false],
  ['Read lean', { tool: 'Read', file_path: '/h/.lean-agent/goals.json' }, true],
  ['Read outside', { tool: 'Read', file_path: '/etc/passwd' }, false],
  ['Read dotdot', { tool: 'Read', file_path: '/h/.lean-agent/../.ssh/id' }, false],
  ['Grep no path', { tool: 'Grep', pattern: 'x' }, false],
  ['Glob lean', { tool: 'Glob', pattern: '*', path: '/h/.lean-agent/threads' }, true],
  ['bg', { tool: 'Bash', command: 'claude --bg -n x "hi"' }, true],
  ['agents', { tool: 'Bash', command: 'claude agents --json' }, true],
  ['claude other', { tool: 'Bash', command: 'claude -p hi' }, false],
  ['gh view', { tool: 'Bash', command: 'gh pr view 3' }, true],
  ['gh merge', { tool: 'Bash', command: 'gh pr merge 3' }, false],
  ['git log', { tool: 'Bash', command: 'git -C /r/app log --oneline' }, true],
  ['git status', { tool: 'Bash', command: 'git -C /r/app status' }, true],
  ['git commit', { tool: 'Bash', command: 'git -C /r/app commit -m x' }, false],
  ['chained', { tool: 'Bash', command: 'gh pr view 3 && rm -rf /' }, false],
  ['subshell', { tool: 'Bash', command: 'git -C $(rm x) log' }, false],
  ['redirect', { tool: 'Bash', command: 'gh pr list > /h/x' }, false],
  ['ls', { tool: 'Bash', command: 'ls' }, false],
  ['lean_thread', { tool: 'mcp__lean-agent__lean_thread', action: 'list' }, true],
  ['TodoWrite', { tool: 'TodoWrite' }, true],
]
test('desk strict mode: table of allowed and denied calls', async () => {
  const h = setup()
  for (const [name, e, ok] of deskTable) expect([name, (await run(h, desk, e, '/h/lean-agent-desk')) === null]).toEqual([name, ok])
  expect(await run(h, desk, { tool: 'Edit', file_path: '/x' }, '/h/lean-agent-desk')).toContain('route this to a thread')
})

test('push gate: green review for HEAD unlocks that sha only', async () => {
  const h = setup()
  const push = { tool: 'Bash', command: 'git push origin feature' }
  expect(await run(h, thread, push)).toContain('no green review')
  h.files.set(`/h/.lean-agent/app/reviews/${SHA}.json`, JSON.stringify({ green: false }))
  expect(await run(h, thread, push)).toContain('no green review')
  h.files.set(`/h/.lean-agent/app/reviews/${SHA}.json`, JSON.stringify({ green: true }))
  expect(await run(h, thread, push)).toBeNull()
  expect(await run(h, plain, { tool: 'Bash', command: 'cd /r/app && git push' })).toBeNull()
  h.git.handler = () => ({ exitCode: 0, stdout: 'ffff' + SHA.slice(4) + '\n' }) // HEAD moved on
  expect(await run(h, thread, push)).toContain('no green review')
  expect(await run(h, thread, { tool: 'Bash', command: 'git status' })).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'bash -c "git push"' })).toContain('no green review')
  expect(await run(h, plain, push, '/elsewhere')).toContain('no lean-agent project')
})

test('private projects never push or publish, review or not', async () => {
  const h = setup()
  h.files.set(`/h/.lean-agent/secret/reviews/${SHA}.json`, JSON.stringify({ green: true }))
  for (const command of ['git push', 'git -C /r/secret push origin x', 'gh pr create --fill', 'gh pr comment 3 -b hi', 'gh issue comment 4 -b hi'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, expect.stringContaining('private project')])
  expect(await run(h, thread, { tool: 'Bash', command: 'git -C /r/secret push' }, '/r/app')).toContain('private project')
  expect(await run(h, thread, { tool: 'Bash', command: 'gh pr view 3' }, '/r/secret')).toBeNull()
})

test('workers: readers are read-only, allow-cmd and allow-edit grants', async () => {
  const h = setup()
  const grant = { edit: ['/h/.lean-agent/worktrees/app/t1'], cmds: ['git log', 'ls'] }
  h.files.set('/h/.lean-agent/threads/t1/grants.json', JSON.stringify(grant))
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  expect(await run(h, thread, edit('/anything'), '/r', 'reader-haiku')).toContain('read-only')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log -5' }, '/r', 'reader-sonnet')).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'rm -rf x' }, '/r', 'reader-sonnet')).toContain('granted')
  expect(await run(h, thread, { tool: 'Bash', command: 'ls; rm x' }, '/r', 'reader-sonnet')).toContain('granted')
  expect(await run(h, thread, { tool: 'Read', file_path: '/x' }, '/r', 'reader-sonnet')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'worker-sonnet')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/../t2/a.ts'), '/r', 'worker-sonnet')).toContain('outside')
  expect(await run(h, thread, edit('/etc/x'), '/r', 'worker-opus')).toContain('outside')
  expect(await run(h, plain, edit('/h/.lean-agent/worktrees/app/t1/a'), '/r', 'worker-opus')).toContain('outside') // no grants file for plain
  expect(await run(h, thread, edit('/anything'), '/r')).toBeNull() // the thread's own main loop is not a worker
})

test('a throwing guard denies (fail closed)', async ($, on) => {
  const h = fakeHost(on)
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  h.git.handler = () => { throw new Error('boom') }
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as any)
  await $.session.start({ cwd: '/r/app', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push' } as any)
  expect(r.deny).toBeDefined()
})
