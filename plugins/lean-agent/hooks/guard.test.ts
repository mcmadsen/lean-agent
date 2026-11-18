import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, parseGrants, recordGrant, releaseGrant } from './guard'
import { writeReview } from './reviews'

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
const run = (h: any, role: any, e: any, cwd = '/r/app', agentType?: string, agentId = agentType ? 'a1' : undefined) => decide(h.host, { role, cwd, agentType, agentId }, e)

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
  ['Skill', { tool: 'Skill' }, true],
  ['WebSearch', { tool: 'WebSearch' }, false],
  ['foreign MCP', { tool: 'mcp__other__x' }, false],
  ['unknown tool', { tool: 'SomethingNew' }, false],
]
test('desk strict mode: table of allowed and denied calls', async () => {
  const h = setup()
  for (const [name, e, ok] of deskTable) expect([name, (await run(h, desk, e, '/h/lean-agent-desk')) === null]).toEqual([name, ok])
  expect(await run(h, desk, { tool: 'Edit', file_path: '/x' }, '/h/lean-agent-desk')).toContain('route this to a thread')
})

test('push gate: only a signed green review for HEAD unlocks that sha, and only registered projects are gated', async () => {
  const h = setup()
  const push = { tool: 'Bash', command: 'git push origin feature' }
  expect(await run(h, thread, push)).toContain('no green review')
  await writeReview(h.host, { green: false, sha: SHA, project: 'app' })
  expect(await run(h, thread, push)).toContain('no green review')
  // a record a thread wrote itself (no valid signature) is not trusted
  h.files.set(`/h/.lean-agent/app/reviews/${SHA}.json`, JSON.stringify({ green: true }))
  expect(await run(h, thread, push)).toContain('no green review')
  h.files.set(`/h/.lean-agent/app/reviews/${SHA}.json`, JSON.stringify({ green: true, sig: 'f'.repeat(64) }))
  expect(await run(h, thread, push)).toContain('no green review')
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  expect(await run(h, thread, push)).toBeNull()
  expect(await run(h, plain, { tool: 'Bash', command: 'cd /r/app && git push' })).toBeNull()
  h.git.handler = () => ({ exitCode: 0, stdout: 'ffff' + SHA.slice(4) + '\n' }) // HEAD moved on
  expect(await run(h, thread, push)).toContain('no green review')
  expect(await run(h, thread, { tool: 'Bash', command: 'git status' })).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'bash -c "git push"' })).toContain('no green review')
  // nothing else demands a review; an unregistered repo pushes as before
  expect(await run(h, plain, push, '/elsewhere')).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'git commit -m x' })).toBeNull()
})

test('review records and the key are the mod\'s alone', async () => {
  const h = setup()
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  for (const e of [
    { tool: 'Write', file_path: `/h/.lean-agent/app/reviews/${SHA}.json` },
    { tool: 'Edit', file_path: '/h/.lean-agent/app/reviews/x.json' },
    { tool: 'Read', file_path: '/h/.lean-agent/review.key' },
    { tool: 'Bash', command: `echo '{}' > ~/.lean-agent/app/reviews/${SHA}.json` },
    { tool: 'Bash', command: 'cat /h/.lean-agent/review.key' },
  ])
    for (const role of [thread, plain]) expect([e.tool, await run(h, role, e)]).toEqual([e.tool, expect.stringContaining('lean_review')])
  expect(await run(h, thread, { tool: 'Write', file_path: '/h/.lean-agent/app/notes.md' })).toBeNull()
  // a project's own folder named reviews is not the store
  for (const p of ['/h/.lean-agent/worktrees/app/t1/src/reviews/a.ts', '/h/.lean-agent/threads/t1/reviews/x'])
    expect([p, await run(h, thread, { tool: 'Write', file_path: p })]).toEqual([p, null])
  expect(await run(h, thread, { tool: 'Bash', command: 'ls /h/.lean-agent/worktrees/app/t1/src/reviews' })).toBeNull()
})

test('protected branches are never force-pushed or deleted, in any repo', async () => {
  const h = setup()
  h.git.handler = a => (a.includes('--abbrev-ref') ? { exitCode: 0, stdout: 'main\n' } : { exitCode: 0, stdout: SHA + '\n' })
  for (const command of ['git push --force origin main', 'git push -f', 'git push origin +master', 'git push --force-with-lease origin release/1.0', 'git push origin --delete main', 'git push --mirror'])
    for (const cwd of ['/r/app', '/elsewhere']) expect([command, cwd, await run(h, plain, { tool: 'Bash', command }, cwd)]).toEqual([command, cwd, expect.stringContaining('lean-agent')])
  h.git.handler = a => (a.includes('--abbrev-ref') ? { exitCode: 0, stdout: 'feature\n' } : { exitCode: 0, stdout: SHA + '\n' })
  expect(await run(h, plain, { tool: 'Bash', command: 'git push --force origin feature' }, '/elsewhere')).toBeNull()
  expect(await run(h, plain, { tool: 'Bash', command: 'git push --force' }, '/elsewhere')).toBeNull()
})

test('threads never ask the user directly; neither do subagents', async () => {
  const h = setup()
  expect(await run(h, thread, { tool: 'AskUserQuestion' })).toContain('lean_ask')
  expect(await run(h, thread, { tool: 'AskUserQuestion' }, '/r', 'worker-sonnet')).toContain('never asks')
  expect(await run(h, plain, { tool: 'AskUserQuestion' })).toBeNull()
})

test('private projects never push or publish, review or not', async () => {
  const h = setup()
  h.files.set(`/h/.lean-agent/secret/reviews/${SHA}.json`, JSON.stringify({ green: true }))
  const denied = ['git push', 'git -C /r/secret push origin x', 'git remote add x http://h/r', 'git remote set-url origin http://h/r',
    'gh pr create --fill', 'gh pr comment 3 -b hi', 'gh pr merge 3', 'gh pr edit 3 -t x', 'gh pr close 3', 'gh pr review 3 --approve',
    'gh issue create -t x', 'gh issue comment 4 -b hi', 'gh issue edit 4', 'gh issue close 4', 'gh release create v1', 'gh release delete v1',
    'gh repo create foo', 'gh repo edit', 'gh repo fork',
    'gh api -X POST repos/o/r/issues', 'gh api --method DELETE repos/o/r', 'gh api repos/o/r/issues -f title=x', 'gh api repos/o/r --input f.json',
    'az repos pr create --title x', 'az repos create --name x', 'az devops project create', 'az boards work-item create',
    'bash -c "gh api -X POST repos/o/r/issues"', "sh -c 'gh pr merge 3'", 'x=$(gh api -X POST repos/o/r/issues)', '(gh api repos/o/r -f a=b)', 'echo `gh pr merge 3`',
    'gh -R o/r api -X POST repos/o/r/issues', 'gh --repo o/r pr merge 3', 'az repos pr create --title list', 'az --only-show-errors repos pr create --title x',
    'FOO=1 gh pr view 3 && gh pr merge 3', 'gh pr view 3; gh gist create f', 'gh workflow run x', 'gh secret set X', 'gh label create x', '$GH pr view 3', 'eval "gh pr view 3"', 'echo "unbalanced',
    'lean-agent worktree push vault feature', 'lean-agent review vault --post']
  for (const command of denied)
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, expect.stringContaining('private project')])
  expect(await run(h, thread, { tool: 'Bash', command: 'git -C /r/secret push' }, '/r/app')).toContain('private project')
  for (const command of ['cat /h/.lean-agent/rev*/x.json', 'cat /h/.lean-agent/review.k?y', 'cat /h/.lean-agent/secret/reviews/*'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/app')]).toEqual([command, expect.stringContaining('review records')])
  for (const command of ['gh pr view 3', 'gh pr list', 'gh api repos/o/r/pulls/3/comments', 'gh api user --jq .login', 'gh api -X GET repos/o/r -f per_page=1',
    'git fetch origin', 'git pull', 'git log', 'git status', 'git ls-remote origin', 'git remote -v', 'az repos pr list', 'az repos show',
    'gh issue list --label release', 'gh pr list --search release', 'gh api repos/o/r', 'gh -R o/r pr view 3', 'gh auth status', 'gh run list', 'gh pr diff 3', 'az --only-show-errors repos pr list',
    'bash -c "gh pr view 3"', 'x=$(gh pr list)'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, null])
  // non-private: no publishing denial
  for (const command of ['gh pr create --fill', 'gh release create v1', 'gh api -X POST x', 'git remote add x u'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/app')]).toEqual([command, null])
})

test('workers: readers are read-only; unknown subagent types are readers; grants come from the Agent call', async () => {
  const h = setup()
  expect(parseGrants('do it\nallow-edit: /a/b, /c\nallow-cmd: git log, ls\n--allow-edit=rel')).toEqual({ edit: ['/a/b', '/c', ], cmds: ['git log', 'ls'] })
  await recordGrant(h.host, thread, 'call1', 'reader-sonnet', { cmds: ['git log', 'ls'] })
  await recordGrant(h.host, thread, 'call2', 'worker-sonnet', { edit: ['/h/.lean-agent/worktrees/app/t1'] })
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  expect(await run(h, thread, edit('/anything'), '/r', 'reader-haiku')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'unknown')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'general-purpose')).toContain('read-only')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log -5' }, '/r', 'reader-sonnet', 'r1')).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'rm -rf x' }, '/r', 'reader-sonnet', 'r1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Bash', command: 'ls; rm x' }, '/r', 'reader-sonnet', 'r1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log' }, '/r', 'unknown', 'u1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Read', file_path: '/x' }, '/r', 'reader-sonnet', 'r1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/../t2/a.ts'), '/r', 'worker-sonnet', 'w1')).toContain('outside')
  expect(await run(h, thread, edit('/etc/x'), '/r', 'worker-opus', 'w2')).toContain('outside')
  expect(await run(h, plain, edit('/h/.lean-agent/worktrees/app/t1/a'), '/r', 'worker-opus', 'w3')).toContain('outside') // no grants for plain
  expect(await run(h, thread, edit('/anything'), '/r')).toBeNull() // the thread's own main loop is not a worker
  await releaseGrant(h.host, thread, 'call2')
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'worker-sonnet', 'w1')).toContain('outside')
})

test('a throwing guard denies (fail closed)', async ($, on) => {
  const h = fakeHost(on)
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  h.git.handler = () => { throw new Error('boom') }
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as any)
  await $.session.start({ cwd: '/r/app', surface: 'desktop', isInteractive: true } as any)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push --force' } as any)
  expect(r.deny).toBeDefined()
})
