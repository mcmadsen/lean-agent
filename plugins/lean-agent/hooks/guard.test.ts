import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { REVIEW_EXEMPT, capKind, decide, isWorker, parseGrants, recordGrant, releaseGrant } from './guard'
import { writeReview, writeApproval, APPROVAL_TTL_MS } from './reviews'
import { leanThread } from './threads'

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
  ['gh status', { tool: 'Bash', command: 'gh pr status' }, true],
  ['gh view json', { tool: 'Bash', command: 'gh pr view 3 --json state,reviewDecision,statusCheckRollup,url' }, true],
  ['gh list head', { tool: 'Bash', command: 'gh pr list --head my-branch --json number,url,state' }, true],
  ['gh search prs', { tool: 'Bash', command: 'gh search prs --author someone --state open' }, true],
  ['gh search quoted', { tool: 'Bash', command: 'gh search prs "fix login" --limit 5' }, true],
  ['gh search code', { tool: 'Bash', command: 'gh search code foo' }, false],
  ['gh create', { tool: 'Bash', command: 'gh pr create --title x --body y' }, false],
  ['gh view web', { tool: 'Bash', command: 'gh pr view 3 --web' }, false],
  ['gh api comments', { tool: 'Bash', command: 'gh api repos/o/r/pulls/3/comments' }, false],
  ['gh pr diff', { tool: 'Bash', command: 'gh pr diff 3' }, false],
  ['gh leading flag', { tool: 'Bash', command: 'gh -R o/r pr view 3' }, false],
  ['gh pipe', { tool: 'Bash', command: 'gh pr list | head' }, false],
  ['gh var', { tool: 'Bash', command: 'gh pr view $N' }, false],
  ['az pr list', { tool: 'Bash', command: 'az repos pr list --source-branch my-branch --output json' }, true],
  ['az pr show', { tool: 'Bash', command: 'az repos pr show --id 3' }, true],
  ['az pr show query', { tool: 'Bash', command: "az repos pr show --id 3 --query 'status'" }, true],
  ['az pr create', { tool: 'Bash', command: 'az repos pr create --title x' }, false],
  ['az pr update', { tool: 'Bash', command: 'az repos pr update --id 3 --status abandoned' }, false],
  ['az pr reviewer', { tool: 'Bash', command: 'az repos pr reviewer add --id 3 --reviewers a' }, false],
  ['az @file', { tool: 'Bash', command: 'az repos pr show --id 3 --project @/etc/passwd' }, false],
  ['az @file eq', { tool: 'Bash', command: 'az repos pr show --id 3 --project=@/etc/passwd' }, false],
  ['az debug', { tool: 'Bash', command: 'az repos pr show --id 3 --debug' }, false],
  ['gh bundled web', { tool: 'Bash', command: 'gh pr view 3 -cw' }, false],
  ['gh author me', { tool: 'Bash', command: 'gh pr list --author @me --state all -L 5' }, true],
  ['gh author eq', { tool: 'Bash', command: 'gh pr list --author=@me' }, true],
  ['gh comments flag', { tool: 'Bash', command: 'gh pr view 3 -c' }, true],
  ['az output-file', { tool: 'Bash', command: 'az repos pr list --output-file /h/x' }, false],
  ['az other', { tool: 'Bash', command: 'az account list' }, false],
  ['az pipe', { tool: 'Bash', command: 'az repos pr list | head' }, false],
  ['git log', { tool: 'Bash', command: 'git -C /r/app log --oneline' }, true],
  ['git status', { tool: 'Bash', command: 'git -C /r/app status' }, true],
  ['git remote get-url', { tool: 'Bash', command: 'git -C /r/app remote get-url origin' }, true],
  ['git remote add', { tool: 'Bash', command: 'git -C /r/app remote add x https://example.com/r.git' }, false],
  ['git remote set-url', { tool: 'Bash', command: 'git -C /r/app remote set-url origin https://example.com/r.git' }, false],
  ['git remote get-url flag', { tool: 'Bash', command: 'git -C /r/app remote get-url --push --all' }, false],
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

test('push parsing is per git push segment: chained commands are neither over- nor under-matched', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = a => {
    if (a.includes('get-url')) return { exitCode: 0, stdout: 'git@github.com:o/r.git\n' }
    if (a.includes('symbolic-ref')) return { exitCode: 0, stdout: 'feature\n' }
    if (a.includes('--abbrev-ref') || a.includes('config')) return { exitCode: 1, stdout: '' }
    return { exitCode: 0, stdout: SHA + '\n' }
  }
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  const r = (command: string) => run(h, thread, { tool: 'Bash', command })
  expect(await r('git push -u origin HEAD && gh pr create --fill')).toBeNull()
  expect(await r('git push origin feature && gh pr create --base main')).toBeNull()
  expect(await r('git push origin feature && echo main')).toBeNull()
  expect(await r('echo "a; b" && git -C /r/app push origin feature')).toBeNull()
  expect(await r('echo push; git push origin main')).toContain('never pushes')
  expect(await r('echo x; git push origin main')).toContain('never pushes')
  expect(await r('git status && git push --force origin main')).toContain('protected')
  // redirections are not words; wrapper prefixes do not hide the push
  expect(await r('git push origin HEAD 2>&1')).toBeNull()
  expect(await r('git push origin feature 2>/dev/null >/tmp/o &')).toBeNull()
  expect(await r('git push 2>&1')).toBeNull()
  expect(await r('git push origin main 2>&1')).toContain('never pushes')
  expect(await r('timeout 5 git push -f origin main')).toContain('protected')
  expect(await r('xargs git push origin main')).toContain('never pushes')
  expect(await r('ssh h git push origin main')).toContain('never pushes')
  expect(await r('if true; then git push origin main; fi')).toContain('never pushes')
  expect(await r('while true; do git push origin main; done')).toContain('never pushes')
  expect(await r('! git push origin main')).toContain('never pushes')
  expect(await r('nice -n 5 /usr/bin/git push origin main')).toContain('never pushes')
  expect(await r('git push origin feature && echo main')).toBeNull()
  // a ref that does not resolve cannot be unlocked by any review
  h.git.handler = a => (a.includes('rev-parse') && a.includes('--verify') ? { exitCode: 1, stdout: '' } : a.includes('get-url') ? { exitCode: 0, stdout: 'git@github.com:o/r.git\n' } : a.includes('symbolic-ref') ? { exitCode: 0, stdout: 'feature\n' } : { exitCode: 1, stdout: '' })
  expect(await r('git push origin nosuch')).toContain('cannot resolve nosuch')
  expect(await r('git push origin nosuch 2>&1')).toContain('cannot resolve nosuch')
})

test('review records are HMAC-signed with a key only in the mod store: forged, copied or legacy-keyed records fail', async () => {
  const h = setup()
  const push = { tool: 'Bash', command: 'git push origin feature' }
  const file = `/h/.lean-agent/app/reviews/${SHA}.json`
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  expect(await run(h, thread, push)).toBeNull()
  expect(h.store.get('review.key')).toMatch(/^[0-9a-f]{64}$/)
  expect([...h.files.keys()].some(k => k.includes('review.key'))).toBe(false) // no file holds the key
  const good = JSON.parse(h.files.get(file)!)
  // copied to another project / another sha, or turned green by hand: the signature no longer matches
  h.files.set('/h/.lean-agent/app/reviews/' + 'f'.repeat(40) + '.json', JSON.stringify(good))
  h.files.set(file, JSON.stringify({ ...good, project: 'other' }))
  expect(await run(h, thread, push)).toBeNull() // project/sha come from the path, the sig still verifies
  h.git.handler = a => (a.includes('rev-parse') ? { exitCode: 0, stdout: 'f'.repeat(40) + '\n' } : { exitCode: 1, stdout: '' })
  expect(await run(h, thread, push)).toContain('no green review')
  h.git.handler = a => (a.includes('rev-parse') ? { exitCode: 0, stdout: SHA + '\n' } : { exitCode: 1, stdout: '' })
  h.files.set(file, JSON.stringify({ ...good, sig: good.sig.replace(/.$/, (c: string) => (c === '0' ? '1' : '0')) }))
  expect(await run(h, thread, push)).toContain('no green review')
  h.files.set(file, JSON.stringify({ green: false, sig: good.sig }))
  expect(await run(h, thread, push)).toContain('no green review')
  // a session that guesses a key cannot sign; a lost store key voids every record
  h.files.set(file, JSON.stringify(good))
  expect(await run(h, thread, push)).toBeNull()
  h.store.delete?.('review.key'); h.store.clear()
  expect(await run(h, thread, push)).toContain('no green review')
  // a legacy key file is deleted when the mod next writes a record
  h.files.set('/h/.lean-agent/review.key', 'x'.repeat(64) + '\n')
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' })
  expect(h.files.has('/h/.lean-agent/review.key')).toBe(false)
  expect(await run(h, thread, push)).toBeNull()
  // no path or glob guard remains: ordinary review*/rev* commands and Read/Write are not denied
  for (const e of [{ tool: 'Bash', command: 'ls docs/review*.md' }, { tool: 'Bash', command: 'cat reviewer*.md' }, { tool: 'Bash', command: 'cat ~/.lean-agent/memory/*.md' }, { tool: 'Bash', command: 'cd ~/.lean-agent && cat *.key' }, { tool: 'Read', file_path: '/h/.lean-agent/app/reviews/x.json' }])
    expect([JSON.stringify(e), await run(h, thread, e)]).toEqual([JSON.stringify(e), null])
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

test('an unlexable git push fails closed, in any repo', async () => {
  const h = setup()
  h.git.handler = a => (a.includes('--abbrev-ref') ? { exitCode: 0, stdout: 'feature\n' } : { exitCode: 0, stdout: SHA + '\n' })
  for (const command of ['git push origin "feature', "echo it's; git push origin feature"])
    for (const cwd of ['/r/app', '/elsewhere']) expect([command, cwd, await run(h, plain, { tool: 'Bash', command }, cwd)]).toEqual([command, cwd, expect.stringContaining('could not read this git push safely')])
})

// ported from 0.45 tests (test_push_guards): plain pushes to guarded branches are refused, shell level
test('guarded branches: a plain push to main/master/develop/release/* is refused; per-project guards.push-deny; local and override pass', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' }, loose: { path: '/r/loose', guards: { 'push-deny': ['prod-*'] } }, open: { path: '/r/open', guards: { 'push-deny': [] } } }))
  let branch = 'feature'
  let url = 'git@github.com:o/r.git'
  h.git.handler = a => {
    if (a.includes('get-url')) return { exitCode: 0, stdout: url + '\n' }
    if (a.includes('symbolic-ref')) return { exitCode: 0, stdout: branch + '\n' }
    if (a.includes('--abbrev-ref')) return { exitCode: 1, stdout: '' }
    if (a.includes('config')) return { exitCode: 1, stdout: '' }
    return { exitCode: 0, stdout: SHA + '\n' }
  }
  const go = (command: string, cwd = '/elsewhere') => run(h, plain, { tool: 'Bash', command }, cwd)
  for (const c of ['git push origin main', 'git push origin master', 'git push origin develop', 'git push origin release/1.0', 'git push origin HEAD:main', 'git push origin feature:refs/heads/main', 'git push origin HEAD:release/r-1', 'git push --all origin'])
    expect([c, await go(c)]).toEqual([c, expect.stringContaining('lean-agent')])
  expect(await go('git push origin main')).toContain('Push your own branch and open a pull request')
  expect(await go('git -C /r/app push origin main')).toContain('Push your own branch')
  expect(['git push origin bugfix/b-1', await go('git push origin bugfix/b-1')]).toEqual(['git push origin bugfix/b-1', null])
  expect(['git push origin HEAD', await go('git push origin HEAD')]).toEqual(['git push origin HEAD', null]) // current branch feature
  branch = 'main'
  expect(await go('git push')).toContain('main') // no refspec: the current branch
  expect(await go('git push origin HEAD')).toContain('main')
  branch = 'feature'
  // per-project list replaces the defaults, even an empty one
  expect(await go('git push origin main', '/r/loose')).toContain('no green review') // not guarded here: only the review gate answers
  expect(await go('git push origin prod-1', '/r/loose')).toContain('prod-1')
  expect(await go('git push origin main', '/r/open')).toContain('no green review') // not guarded here: only the review gate answers
  // a push to a local path / file:// URL is not checked (LEAN_AGENT_PUSH_GUARD_LOCAL=1 checks it anyway)
  url = '/srv/bare.git'
  expect(['git push origin main', await go('git push origin main')]).toEqual(['git push origin main', null])
  url = 'file:///srv/bare.git'
  expect(['git push origin main', await go('git push origin main')]).toEqual(['git push origin main', null])
  url = 'git@github.com:o/r.git'
  // the override variable of 0.45 (set in the session env, not by the command)
  h.host.env = { get: async (n: string) => (n === 'HOME' ? '/h' : n === 'LEAN_AGENT_PUSH_GUARD_OVERRIDE' ? '1' : undefined) }
  expect(['git push origin main', await go('git push origin main')]).toEqual(['git push origin main', null])
})

test('push gate: the review must be green for the pushed ref, not for HEAD', async () => {
  const h = setup()
  const OTHER = '9999999def5678abc1234def5678abc1234def56'
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'git@h:o/r.git\n' } : a.some(x => x.startsWith('topic')) ? { exitCode: 0, stdout: OTHER + '\n' } : { exitCode: 0, stdout: SHA + '\n' })
  await writeReview(h.host, { green: true, sha: SHA, project: 'app' }) // HEAD is green, topic is not
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin HEAD:feature' })).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin topic:feature' })).toContain('9999999')
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin HEAD:a topic:b' })).toContain('9999999')
  await writeReview(h.host, { green: true, sha: OTHER, project: 'app' })
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin HEAD:a topic:b' })).toBeNull()
})

test('threads never ask the user directly; neither do subagents', async () => {
  const h = setup()
  expect(await run(h, thread, { tool: 'AskUserQuestion' })).toContain('lean_ask')
  expect(await run(h, thread, { tool: 'AskUserQuestion' }, '/r', 'lean-agent:worker-sonnet')).toContain('never asks')
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
    'FOO=1 gh pr view 3 && gh pr merge 3', 'gh pr view 3; gh gist create f', 'gh workflow run x', 'gh secret set X', 'gh label create x', '$GH pr view 3', 'eval "gh pr merge 3"', 'echo "unbalanced gh',
    '$(echo gh) pr create', 'command $GH pr create', 'sudo $GH pr create', 'env $GH pr create', '"$GH" pr create', '${GH} pr create', 'command gh pr create --fill', 'sudo -u me gh pr merge 3', 'env FOO=1 gh pr merge 3', 'exec gh pr merge 3', 'timeout 5 gh pr merge 3', 'echo a | xargs gh pr close',
    'find . -exec gh pr merge 3 ;', 'if true; then gh pr merge 3; fi', "g''h pr merge 3", '\\gh pr merge 3', '/usr/bin/gh pr create', 'bash -c \'echo "x"; gh pr merge 3\'', 'echo ok <<< "$(gh pr merge 3)"',
    "cat <<EOF\n$(gh pr merge 3)\nEOF", "bash <<'EOF'\ngh pr merge 3\nEOF", 'echo "gh pr merge 3" | bash', 'bash <<< "gh pr merge 3"', 'git -C x push', 'git -c a=b push', 'echo "it\'s" > "$f"; gh pr merge 3',
    // whole-text check (quoted data included) and the ways to skip the pre-push backstop
    'gh pr create', 'FOO=1 git push', 'echo hi; git push', 'true && git push origin x', 'false || gh pr merge 3', 'cat f | git push', 'env -i git push', 'git push --no-verify',
 'git -c core.hooksPath=/dev/null commit -m x', 'GIT_CONFIG_COUNT=1 git status', 'export GIT_CONFIG_KEY_0=core.hooksPath',
    'lean-agent worktree push vault feature', 'lean-agent review vault --post']
  for (const command of denied)
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, expect.stringContaining('private project')])
  expect(await run(h, thread, { tool: 'Bash', command: 'git -C /r/secret push' }, '/r/app')).toContain('private project')
  for (const command of ['gh pr view 3', 'gh pr list', 'gh api repos/o/r/pulls/3/comments', 'gh api user --jq .login', 'gh api -X GET repos/o/r -f per_page=1',
    'git fetch origin', 'git pull', 'git log', 'git status', 'git ls-remote origin', 'git remote -v', 'az repos pr list', 'az repos show',
    'gh issue list --label release', 'gh pr list --search release', 'gh api repos/o/r', 'gh -R o/r pr view 3', 'gh auth status', 'gh run list', 'gh pr diff 3', 'az --only-show-errors repos pr list',
    'bash -c "gh pr view 3"', 'x=$(gh pr list)', 'which gh', 'command -v gh', 'command -v az', 'type az', 'gh --version', 'gh', 'az', 'az --version', 'gh help', 'gh pr', 'cd src/gh', 'ls gh az',
    'echo x > "$f"', 'echo x >> $f 2>&1', 'echo x &> "$f"', 'grep p <<< "$o"',
    'echo "unbalanced', 'echo it\'s', 'for f in gh az; do echo $f; done', 'echo $(date)', 'FOO=1 ls', 'sudo ls', '$HOME/bin/tool x', 'bash script.sh', 'eval "echo hi"', 'cat file | grep gh', 'ls src/az', 'gh pr view 3 --json title | jq .title',
    // quoted data / heredoc bodies / non-command positions are not commands
    'echo gh pr create', 'echo "gh pr create"', 'git commit -m "docs: gh pr create and git push"', "git commit -m 'run gh pr merge later'", "cat <<EOF\nit's fine, gh pr create\nEOF", "cat <<'EOF' > \"$f\"\ndon't gh pr merge\nEOF", 'grep -r "gh pr create" .',
    "git commit -m 'add push notifications'", 'git log --grep=push', 'ls src/gh && git merge main', 'git log --grep push --oneline', 'git diff main | grep merge', 'python3 -c "import os; os.system(\'git push\')"'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, null])
  for (const command of ['ssh h "git push origin x"', 'ssh h git push', 'timeout 60 git push', 'xargs git push', 'if true; then git push; fi', 'git push origin x 2>&1'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/secret')]).toEqual([command, expect.stringContaining('private project')])
  // non-private: no publishing denial
  for (const command of ['gh pr create --fill', 'gh release create v1', 'gh api -X POST x', 'git remote add x u'])
    expect([command, await run(h, thread, { tool: 'Bash', command }, '/r/app')]).toEqual([command, null])
})

test('workers: readers are read-only; unknown subagent types are readers; grants come from the Agent call', async () => {
  const h = setup()
  expect(parseGrants('do it\nallow-edit: /a/b, /c\nallow-cmd: git log, ls\n--allow-edit=rel')).toEqual({ edit: ['/a/b', '/c', ], cmds: ['git log', 'ls'], mcp: [], mcpWrite: [] })
  await recordGrant(h.host, thread, 'call1', 'lean-agent:reviewer', { cmds: ['git log', 'ls'] })
  await recordGrant(h.host, thread, 'call2', 'lean-agent:worker-sonnet', { edit: ['/h/.lean-agent/worktrees/app/t1'] })
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  expect(await run(h, thread, edit('/anything'), '/r', 'lean-agent:reviewer')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'unknown')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'general-purpose')).toContain('read-only')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log -5' }, '/r', 'lean-agent:reviewer', 'r1')).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'rm -rf x' }, '/r', 'lean-agent:reviewer', 'r1')).toContain('may run only')
  expect(await run(h, thread, { tool: 'Bash', command: 'ls; rm x' }, '/r', 'lean-agent:reviewer', 'r1')).toContain('may run only')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log' }, '/r', 'unknown', 'u1')).toContain('may run only')
  expect(await run(h, thread, { tool: 'Read', file_path: '/x' }, '/r', 'lean-agent:reviewer', 'r1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/../t2/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/etc/x'), '/r', 'lean-agent:worker-opus', 'w2')).toBeNull()
  expect(await run(h, plain, edit('/h/.lean-agent/worktrees/app/t1/a'), '/r', 'lean-agent:worker-opus', 'w3')).toBeNull() // no grants for plain
  expect(await run(h, thread, edit('/anything'), '/r')).toBeNull() // the thread's own main loop is not a worker
  await releaseGrant(h.host, thread, 'call2')
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w5')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull() // the same subagent resumed keeps its grant
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

test('the review skill grants the reviewer exactly the read-only git commands for the range', async () => {
  const h = setup()
  const g = parseGrants('Review it.\nallow-cmd: git diff main...abc1234, git log main..abc1234, git show abc1234, git merge-base main abc1234')
  await recordGrant(h.host, thread, 'c1', 'lean-agent:reviewer', g)
  const bash = (command: string) => run(h, thread, { tool: 'Bash', command }, '/r/app', 'lean-agent:reviewer', 'r1')
  expect(await bash('git diff main...abc1234 --stat')).toBeNull()
  expect(await bash('git log main..abc1234 --oneline')).toBeNull()
  expect(await bash('git show abc1234')).toBeNull()
  expect(await bash('git merge-base main abc1234')).toBeNull()
  expect(await bash('git diff main...abc1234 | sh')).toContain('may run only')
  expect(await bash('git diff main...abc1234 | head -5')).toBeNull() // a pipe between two built-in reads
  expect(await bash('git push origin x')).toContain('may run only')
  expect(await bash('git diff')).toBeNull() // built in for a reviewer
  expect(await bash('git merge-base main x')).toBeNull() // read-only, so built in for a reader and the reviewer (from 1.0.12)
})

test('the review grants its git commands as `git -C <worktree> ...`: the thread folder is not a repository; matching is word by word', async () => {
  const h = setup()
  const wt = '/h/.lean-agent/worktrees/app/fix-x'
  const cwd = '/h/.lean-agent/threads/t1'
  const g = parseGrants(`Review it.\nallow-cmd: git -C ${wt} diff main...abc1234, git -C ${wt} log main..abc1234, git -C ${wt} show abc1234, git -C ${wt} merge-base main abc1234`)
  expect(g.cmds).toHaveLength(4)
  await recordGrant(h.host, thread, 'c1', 'lean-agent:reviewer', g)
  const bash = (command: string, t = 'lean-agent:reviewer') => run(h, thread, { tool: 'Bash', command }, cwd, t, 'r1')
  expect(await bash(`git -C ${wt} diff main...abc1234 --stat`)).toBeNull()
  expect(await bash(`git -C ${wt} log main..abc1234 --oneline`)).toBeNull()
  expect(await bash(`git -C ${wt} show abc1234`)).toBeNull()
  expect(await bash(`git -C ${wt} merge-base main abc1234`)).toBeNull()
  // a grant is no grant for another checkout, and never carries a write or a redirect
  expect(await bash('git -C /elsewhere diff main...abc1234')).toContain('may run only') // outside the allowed folders
  expect(await bash(`git -C ${wt} push origin x`)).toContain('may run only')
  expect(await bash(`git -C ${wt} merge-base main abc1234 > /tmp/x`)).toContain('may run only')
})

test('the subagent cap (config.json agents.cap) counts a thread\'s subagents per session; the reviewer passes and the second-opinion reader do not count', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', sid: 'sess-1' }))
  const agent = (sub: string, prompt = 'do it') => run(h, thread, { tool: 'Agent', subagent_type: sub, prompt }, '/h/.lean-agent/threads/t1')
  // no cap configured: nothing is counted or refused
  for (let i = 0; i < 6; i++) expect(await agent('lean-agent:reader-haiku')).toBeNull()
  expect(h.files.has('/h/.lean-agent/threads/t1/subagents.json')).toBe(false)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ agents: { cap: 3 } }))
  for (let i = 0; i < 3; i++) expect(await agent('lean-agent:reader-haiku')).toBeNull() // traces: the cap is used up
  expect(await agent('lean-agent:worker-sonnet')).toContain('subagent cap reached: 3 subagents already started in this session (cap 3')
  expect(await agent('general-purpose')).toContain('subagent cap reached')
  // the review still runs: reviewer passes and the marked second-opinion reader are neither counted nor refused
  const second = 'Look for duplicates.\nallow-cmd: git -C /w log\nreview: second-opinion\n'
  expect(await agent('lean-agent:reader-haiku', second)).toBeNull()
  expect(await agent('lean-agent:reviewer', 'review the diff')).toBeNull()
  expect(await agent('lean-agent:reviewer', 'review the diff again')).toBeNull()
  expect(await agent('lean-agent:reviewer', 'third pass')).toBeNull()
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/subagents.json')!)).toEqual({ sid: 'sess-1', counted: 3, review: 3, second: 1 })
  expect(await agent('lean-agent:reader-haiku')).toContain('subagent cap reached') // an unmarked reader is work
  // the marker is no way round the cap: past 2 second-opinion readers a marked one counts (and is refused here); a bare or foreign type is never exempt
  expect(await agent('lean-agent:reader-sonnet', second)).toBeNull()
  expect(await agent('lean-agent:reader-haiku', second)).toContain('subagent cap reached')
  expect(await agent('reviewer', 'x')).toContain('subagent cap reached')
  expect(await agent('other:reviewer', 'x')).toContain('subagent cap reached')
  expect(await agent('lean-agent:worker-haiku', second)).toContain('subagent cap reached') // not a reader
  // more than REVIEW_EXEMPT reviewer calls in one session count like any other
  for (let i = 0; i < REVIEW_EXEMPT - 3; i++) expect(await agent('lean-agent:reviewer', 'x')).toBeNull()
  expect(await agent('lean-agent:reviewer', 'one too many')).toContain('subagent cap reached')
  // a new session of the thread starts again at zero
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', sid: 'sess-2' }))
  expect(await agent('lean-agent:worker-sonnet')).toBeNull()
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/subagents.json')!)).toEqual({ sid: 'sess-2', counted: 1, review: 0, second: 0 })
  // only a thread's own loop is capped: a subagent's own Agent call is not
  expect(await run(h, thread, { tool: 'Agent', subagent_type: 'lean-agent:worker-sonnet', prompt: 'x' }, '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(capKind({ tool: 'Agent', subagent_type: 'lean-agent:reviewer' } as any)).toBe('review')
})

test('the plugin-prefixed agent types: lean-agent:worker-* edits under a grant; reviewer, readers, foreign and bare types are read-only', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  await recordGrant(h.host, thread, 'c1', 'lean-agent:worker-sonnet', { edit: ['/h/.lean-agent/worktrees/app/t1'] })
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  const ok = '/h/.lean-agent/worktrees/app/t1/src/a.ts'
  expect(await run(h, thread, edit(ok), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/etc/x'), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit(ok), '/r', 'lean-agent:worker-opus', 'w9')).toBeNull() // no grant of its own
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer', 'lean-agent:auditor', 'lean-agent:auditor', 'other:worker-x', 'worker-x', 'lean-agent:lean-agent:worker-x'])
    expect(await run(h, thread, edit(ok), '/r', t, 'x1')).toContain('read-only')
  expect([isWorker('lean-agent:worker-opus'), isWorker('worker-opus'), isWorker('other:worker-opus'), isWorker(undefined)]).toEqual([true, false, false, false])
})

test('built-in read-only git: the explorer runs ls-files / log without a grant; refusals; readers run show; foreign, bare and worker types differ', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  const bash = (command: string, t: string) => run(h, thread, { tool: 'Bash', command }, '/r', t, 'e1')
  const ex = (c: string) => bash(c, 'lean-agent:auditor')
  expect(await ex('git ls-files src')).toBeNull()
  expect(await ex('git log --oneline -5 -- src')).toBeNull()
  expect(await ex('git log -3')).toBeNull()
  expect(await ex('rm x')).toContain('built-in')
  for (const c of ['git log --output=x', 'git log --out=x', 'git log -o x', 'git -c core.pager=sh log', 'git --exec-path=/x log', 'git ls-files > x', 'git diff --ext-diff', 'git log | sh', 'git log; rm x', 'git log $(id)', 'git log $HOME', 'GIT_PAGER=sh git log', 'git -C /etc log', 'git --config-env=a=b log', 'git push origin x'])
    expect(await bash(c, 'lean-agent:reviewer'), c).toContain('may run only')
  expect(await bash('git ls-files > x', 'lean-agent:auditor')).toContain('may run only')
  expect(await bash('git log --output=x', 'lean-agent:auditor')).toContain('may run only')
  expect(await bash('git -c core.pager=sh log', 'lean-agent:auditor')).toContain('may run only')
  expect(await bash('git log | sh', 'lean-agent:auditor')).toContain('may run only')
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer', 'lean-agent:reviewer']) {
    expect(await bash('git show HEAD:file', t)).toBeNull()
    expect(await bash('git diff --stat main...HEAD', t)).toBeNull()
    expect(await bash('git status --short', t)).toBeNull()
    expect(await bash('git rev-parse HEAD', t)).toBeNull()
    expect(await bash('git -C /h/.lean-agent/worktrees/app/t1 log -2', t)).toBeNull()
    expect(await bash('git -C /r/sub log -2', t)).toContain('may run only') // the session cwd alone is no root
  }
  expect(await bash('git diff --ext-diff', 'lean-agent:reviewer')).toContain('may run only')
  for (const c of ['git log --{output=/tmp/x,}', 'git log {--output=/tmp/x,}', 'git diff {--ext-diff,}', 'git -C ~ log', 'git -C sub/../.. log', 'git -C a -C b log', 'git diff --ext x', 'git log --exec=x', 'git diff --no-index a b', 'git log --help', 'git log -h', 'git log --$"output=x"', 'git ls-files *'])
    expect(await bash(c, 'lean-agent:reviewer'), c).toContain('may run only')
  for (const c of ['git ls-files --exclude-standard', 'git ls-files -o', 'git log --oneline --grep=x', 'git log -Sdone', 'git rev-parse --git-dir', 'git --no-pager log -2', 'git log --output-indicator-new=+'])
    expect(await bash(c, 'lean-agent:reviewer'), c).toBeNull()
  for (const t of ['other:explorer', 'explorer', 'other:reader-haiku', 'reader-haiku'])
    expect(await bash('git log -3', t), t).toContain('may run only')
  expect(await bash('git log -3', 'lean-agent:worker-sonnet')).toBeNull() // a worker is unchanged
  expect(await bash('git push origin x', 'lean-agent:worker-sonnet')).not.toContain('built-in')
})

test('an unresolved agent type is a reader with no grants and says so; a subagent with no type at all too', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  await recordGrant(h.host, thread, 'c1', undefined, { cmds: ['git log'], edit: ['/h/.lean-agent/worktrees/app/t1'] })
  for (const t of ['unresolved', undefined]) {
    const bash = await run(h, thread, { tool: 'Bash', command: 'git log -2' }, '/r', t as any, 'x1')
    expect(bash).toContain('type unresolved')
    expect(bash).not.toContain('unknown')
    expect(await run(h, thread, { tool: 'Bash', command: 'git ls-files src' }, '/r', t as any, 'x1')).toContain('type unresolved')
    expect(await run(h, thread, { tool: 'Edit', file_path: '/h/.lean-agent/worktrees/app/t1/a.ts' }, '/r', t as any, 'x1')).toContain('read-only')
  }
})

test('git -C reaches the session folder, ~/.lean-agent and registered projects only', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const thread = { kind: 'thread', id: 't1' } as any
  const bash = (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/.lean-agent/threads/t1', 'lean-agent:auditor', 'e1')
  expect(await bash('git -C /h/code/app ls-files src')).toBeNull()
  expect(await bash('git -C /h/.lean-agent/worktrees/app/t1 log -3')).toBeNull()
  expect(await bash('git -C /h/code/other ls-files')).toContain('may run only')
  expect(await bash('git -C /etc log')).toContain('may run only')
  expect(await bash('git -C sub log')).toContain('may run only') // relative: it would resolve against the agent's own cwd
  expect(await bash('git diff --no-ind a b')).toContain('may run only')
})

test('an unknown or root session cwd widens no git -C root; a desk subagent without a type is refused as unresolved', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  for (const cwd of ['', '/'])
    expect(await run(h, thread, { tool: 'Bash', command: 'git -C /h/other log' }, cwd, 'lean-agent:auditor', 'e1'), cwd).toContain('may run only')
  const desk = { kind: 'desk' } as any
  expect(await run(h, desk, { tool: 'Bash', command: 'git log' }, '/r', undefined as any, 'x1')).toContain('type unresolved')
})

test('approve-push: the desk approves one sha once, for 2 h; forged, wrong-sha and expired records fail; the refusal names it and the manual command', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  const push = { tool: 'Bash', command: 'git push origin feature' }
  const refusal = (await run(h, thread, push)) as string
  expect(refusal).toContain(`ready to push ${SHA}`) // a thread reports and stops: the desk pushes
  expect(refusal).toContain('a thread does not push')
  expect(refusal).toContain('git -C /r/app push origin feature')
  await writeApproval(h.host, { project: 'app', sha: 'c'.repeat(40), thread: 't1' }) // make sure the signing key exists: the signature is what fails below
  // a thread-written record carries no valid signature
  h.files.set(`/h/.lean-agent/app/approvals/${SHA}.json`, JSON.stringify({ project: 'app', sha: SHA, exp: h.clock.t + 1e6, sig: 'f'.repeat(64) }))
  expect(await run(h, thread, push)).toContain('no green review')
  expect((await leanThread(h.host, '/p', { action: 'approve-push', tN: 't1', sha: 'abc' })).ok).toBe(false) // a short sha
  expect((await leanThread(h.host, '/p', { action: 'approve-push', tN: 't1', sha: SHA, reason: 'user said yes' })).ok).toBe(true)
  expect(String(h.files.get('/h/.lean-agent/threads/t1/history.jsonl'))).toContain('approve-push')
  expect(await run(h, thread, push)).toBeNull() // accepted like a green review
  expect(await run(h, thread, push)).toContain('no green review') // single use
  // a thread restoring the consumed record (it may edit ~/.lean-agent) gains nothing: consumption lives in the mod's store
  const rec = JSON.parse(String(h.files.get(`/h/.lean-agent/app/approvals/${SHA}.json`)))
  h.files.set(`/h/.lean-agent/app/approvals/${SHA}.json`, JSON.stringify({ ...rec, used: false }))
  expect(await run(h, thread, push)).toContain('no green review')
  await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  h.clock.t += APPROVAL_TTL_MS + 1
  expect(await run(h, thread, push)).toContain('no green review') // expired
  await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't2' })
  expect(await run(h, thread, push)).toContain('no green review') // approved for t2: t1 cannot use it
  const t2 = { kind: 'thread', id: 't2' } as const
  const recT = JSON.parse(String(h.files.get(`/h/.lean-agent/app/approvals/${SHA}.json`)))
  h.files.set(`/h/.lean-agent/app/approvals/${SHA}.json`, JSON.stringify({ ...recT, exp: recT.exp + 3_600_000 }))
  expect(await run(h, t2, push)).toContain('no green review') // a record with an extended expiry fails its signature
})

test('a private project is never pushed, approval or not', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app', private: true } }))
  await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin feature' })).toContain('private project')
})

test('built-in search commands: rg, grep, find, ls, wc, head, tail, cat inside the roots; pipes only between proven read-only commands', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const thread = { kind: 'thread', id: 't1' } as any
  const as = (t: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/.lean-agent/worktrees/app/t1', t, 'x1')
  const ok = ['rg foo src', "rg 'a|b' src", 'rg -n --glob "*.ts" foo /h/code/app/src', 'rg foo', 'grep -rn foo src', "grep -rn '/api/v1' src", 'grep -rn foo /h/code/app', 'find . -name "*.ts"', 'find /h/code/app -type f -name x',
    'ls -la src', 'ls /h/code/app', 'wc -l src/a.ts', 'head -20 src/a.ts', 'tail -n 5 src/a.ts', 'cat src/a.ts', 'rg foo src | head -5', 'git log --oneline | grep fix | wc -l', 'git ls-files src | rg ts', 'cat /h/.lean-agent/memory/notes.jsonl']
  for (const t of ['lean-agent:auditor', 'lean-agent:reviewer', 'lean-agent:reviewer', 'lean-agent:auditor']) for (const c of ok) expect(await as(t)(c), `${t}: ${c}`).toBeNull()
  const bad = ['rg foo > out', 'rg foo >> out', 'cat a.ts > b', 'rg foo | sh', 'rg foo | tee x', 'rg foo || ls', 'ls; rm x', 'ls && rm x', 'rg foo &', 'cat < /etc/passwd', 'cat $(id)', 'cat `id`', 'cat "$HOME/x"', 'cat ~/x', 'cat {a,b}', 'rg foo ../../../../etc', 'cat /etc/passwd', 'ls /', 'ls ../../../..', 'rg -f /etc/passwd x', 'rg --file=/etc/passwd x', 'rg foo /etc', 'grep -r foo /h', 'cat /h/other/x',
    'find . -exec rm {} ;', 'find . -exec sh -c x ;', 'find . -execdir ls ;', 'find . -delete', 'find . -ok ls ;', 'find . -fprint x', 'find . -fprintf x y', 'find . -fls x', 'find . -fprint0 x', 'rg --pre cat foo', 'rg --pre=cat foo', 'rg -z foo', 'rg --search-zip foo', 'tail -f x', 'tail -F x', 'xargs ls', 'awk 1 x', 'env ls', 'sh -c ls', 'rg foo\nrm x', 'FOO=1 rg x']
  for (const c of bad) expect(await as('lean-agent:reviewer')(c), c).toContain('may run only')
  for (const c of ['rg foo > out', 'cat /etc/passwd', 'python3 x.py']) expect(await as('lean-agent:auditor')(c), `auditor: ${c}`).toContain('may run only') // read-only, never runs the script
  // foreign, bare and worker types get no search built in (a worker is not restricted by it either)
  for (const t of ['other:explorer', 'explorer', 'reader-haiku', 'other:auditor', 'auditor']) expect(await as(t)('rg foo src'), t).toContain('may run only')
  expect(await as('lean-agent:worker-sonnet')('rg foo src')).toBeNull()
})

test('readers and the reviewer also run sed -n, stat, file, diff, jq, tree; every write / exec / outside-root form is refused', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  for (const f of ['src/a.ts', 'src/b.ts', 'other/a.ts']) h.files.set(`/h/.lean-agent/worktrees/app/t1/${f}`, 'x')
  h.files.set('/h/code/app/b.ts', 'x')
  const thread = { kind: 'thread', id: 't1' } as any
  const as = (t: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/.lean-agent/worktrees/app/t1', t, 'x1')
  const ok = ["sed -n 1,20p src/a.ts", "sed -n '5p' src/a.ts", "sed -n '/foo/,/bar/p' src/a.ts", "sed -n '$p' src/a.ts", "sed -n -e '1p' -e '3p' src/a.ts", "sed -nE 's/a(b)/\\1/p' src/a.ts", "sed -n 's|a|b|gp' src/a.ts", "sed -n '2,+3p;10q' src/a.ts", "sed -n '/x/!p' src/a.ts", "sed -n '/[0-9]/p' src/a.ts", "sed -n 's/[[:alpha:]]/x/p' src/a.ts", "rg foo src | sed -n 1,5p", "sed --quiet 3p src/a.ts",
    'stat src/a.ts', 'stat -c %s src/a.ts', 'file src/a.ts', 'file -b --mime-type src/a.ts', 'diff src/a.ts src/b.ts', 'diff -u src/a.ts /h/code/app/b.ts', 'diff -U 5 src/a.ts src/b.ts', 'diff -q -w src/a.ts src/b.ts',
    'jq . src/a.json', "jq -r '.a.b[] | select(.x > 1)' src/a.json", "jq -c '.[0]' src/a.json src/b.json", 'cat src/a.json | jq .', "jq -n '1+1'", 'tree', 'tree src', 'tree -L 2 -I node_modules src', 'tree -a -d /h/code/app', 'ls src | head -3 | wc -l', 'find src -name "*.ts" | wc -l']
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer', 'lean-agent:reviewer']) for (const c of ok) expect(await as(t)(c), `${t}: ${c}`).toBeNull()
  const bad = ['find . -delete', 'find src -exec rm {} ;', 'find src -fprint out', 'sed -i s/a/b/ src/a.ts', "sed -i -n 1p src/a.ts", "sed -n 'w out' src/a.ts", "sed -n '1w out' src/a.ts", "sed -n 's/a/b/w out' src/a.ts", "sed -n 's/a/b/e' src/a.ts", "sed -n '1e ls' src/a.ts", "sed -n 'r /etc/passwd' src/a.ts", "sed -n 'R x' src/a.ts", "sed -n '1p;w out' src/a.ts", "sed -n '/x/{p;w out}' src/a.ts", "sed -n 'a hello' src/a.ts", "sed -n '1p' -f script.sed src/a.ts", "sed -n 's/[/]/x/p' src/a.ts", "sed -n 's/[[:alpha:]/]/;s/w /x/' src/a.ts", "sed -n '\\,x,p' src/a.ts", "sed 1p src/a.ts", "sed -n 1p /etc/passwd", "sed -n 1p ../../x", "sed -n s/a/b/ src/a.ts > out", 'sed -n 1p --in-place src/a.ts', 'sed -n -s -z 1p src/a.ts', "sed -n ''", 'sed -n',
    'stat /etc/passwd', 'stat -L src/a.ts', 'stat', 'file /etc/passwd', 'file -L src/a.ts', 'file -f list.txt', 'file', 'diff src/a.ts /etc/passwd', 'diff -r src /etc', 'diff src/a.ts', 'diff -X pats a b', 'diff --from-file=a b c', 'diff -l a b', 'diff -r a b', 'diff -N -u src other', 'diff src src/a.ts', 'diff src/a.ts src/missing.ts', 'stat -f /etc/shadow src/a.ts',
    'jq -f prog.jq src/a.json', 'jq --rawfile x /etc/passwd . src/a.json', 'jq --slurpfile x /etc/passwd . src/a.json', 'jq --arg a b . src/a.json', 'jq -n env', "jq -n '$ENV'", "jq -n 'env.HOME'", "jq 'import \"a\" as a; .' src/a.json", "jq -L /etc . x", 'jq . /etc/passwd', 'jq', 'jq -n --args . a b',
    'tree /etc', 'tree -o out', 'tree -l', 'tree --fromfile x', 'tree ../../..', 'tree > out',
    'ls src | tee out', 'cat src/a.ts | npm test', 'rg foo src | sed -n 1p > out', 'sed -n 1p src/a.ts | sh', 'npm test', 'cat src/a.ts && ls', 'ls || ls', 'ls ; ls', 'ls &', 'cat <<EOF', 'cat src/a.ts `id`', 'cat $(id)', 'ls $HOME']
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer']) for (const c of bad) expect(await as(t)(c), `${t}: ${c}`).toContain('may run only')
  // not for the explorer, the auditor, a bare or foreign type: those get no sed / stat / file / diff / jq / tree
  for (const t of ['reader-haiku', 'other:reader-haiku']) for (const c of ['sed -n 1p src/a.ts', 'stat src/a.ts', 'jq . src/a.json', 'diff a b', 'tree', 'file a']) expect(await as(t)(c), `${t}: ${c}`).toContain('may run only')
  expect(await as('lean-agent:worker-sonnet')('sed -n 1p src/a.ts')).toBeNull() // workers are not restricted by it
  // a path outside the roots: refused whatever the command
  const lean = (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/other', 'lean-agent:reviewer', 'x1')
  for (const c of ['stat a', 'sed -n 1p a', 'tree', 'jq . a']) expect(await lean(c), c).toContain('may run only')
})

test('a refusal names the refused program (first word only, no arguments), so the export shows what was asked for', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const thread = { kind: 'thread', id: 't1' } as any
  const as = (t: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/.lean-agent/worktrees/app/t1', t, 'x1') as Promise<string>
  const r = as('lean-agent:reviewer')
  expect(await r('npm test --secret=abc123')).toContain('refused: npm (not a built-in read-only command)')
  expect(await r('npm test --secret=abc123')).not.toContain('abc123')
  expect(await r('cat src/a.ts | npm test')).toContain('refused: npm (not a built-in read-only command)') // the stage that failed
  expect(await r('find src -delete')).toContain('refused: find (a flag that writes or runs a program, a path outside the allowed folders, or a missing operand / -n)')
  expect(await r('cat /etc/passwd')).toContain('refused: cat (a flag that writes')
  expect(await r('ls > out')).toContain('refused: ls (redirect, ;')
  expect(await r('FOO=secret1 ls')).toContain('refused: FOO ')
  expect(await r('FOO=secret1 ls')).not.toContain('secret1')
  expect(await r('$(id) x')).toContain('refused: ? ')
  expect(await r('git push origin x')).toContain('refused: git (a flag that writes')
  expect(await as('other:reader-haiku')('ls')).toContain('refused: ls (not a built-in read-only command)') // a foreign type has nothing built in
  expect(await as('other:reader-haiku')('ls')).toContain('built-in read-only commands (none)')
  expect(await r('npm test')).toContain('may run only its built-in read-only commands (git, rg, grep, find, ls, wc, head, tail, cat, sed -n, stat, file, diff, jq, tree, sort, uniq, cut, tr, nl)')
  expect(await as('lean-agent:auditor')('npm test')).toContain('(git, rg, grep, find, ls, wc, head, tail, cat, sed -n')
})

test('readers and the reviewer: globs inside the roots, 2>/dev/null, grep/rg with no path, sort/uniq/cut/tr/nl; every other form stays refused', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const wt = '/h/.lean-agent/worktrees/app/t1'
  for (const f of ['src/a.ts', 'src/b.ts', 'src/-x.ts', 'src/sub/c.ts', 'a.md', 'b.md', 'z/q.md']) h.files.set(`${wt}/${f}`, 'x')
  for (const f of ['one.ts', 'two.ts']) h.files.set(`/h/code/app/lib/${f}`, 'x')
  h.files.set('/h/.ssh/id_rsa', 'secret')
  h.files.set(`${wt}/dash/-x.md`, 'x') // a name that would read as a flag once a relative glob expands
  h.files.set(`${wt}/dash/y.md`, 'x')
  h.links.set(`${wt}/lnk/escape`, '/h/.ssh') // a link out of the roots, listed in its folder
  h.files.set(`${wt}/lnk/escape/.keep`, 'x')
  h.files.set('/h/.ssh/.keep', 'x') // what the link points at
  const thread = { kind: 'thread', id: 't1' } as any
  const as = (t: string, cwd = wt) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, cwd, t, 'x1')
  const ok = ['cat *.md', 'ls src/*.ts', 'wc -l src/*.ts', 'head -3 *.md', 'cat /h/code/app/lib/*.ts', 'ls /h/code/app/lib/t*.ts', 'cat src/s?b/c.ts', 'cat src/*/c.ts', 'cat src/[ab].ts', 'wc -l z/*', 'ls -d */', 'rg foo src/*.ts', 'grep -n foo *.md',
    'rg foo src 2>/dev/null', 'ls /h/code/app/nope 2>/dev/null', 'cat a.md 2>/dev/null | head -3', 'rg foo 2>/dev/null | sort | uniq -c | sort -rn', 'cat nothing/*.zzz', // a glob with no match stays a literal word
    'cat a.md | wc -l *.md', 'ls .gitignore*', "cat a.md | tr -d '\\n' | sort *.md", "sort '*.md'", // (a quoted * is a plain name)
    'rg foo', 'rg -n foo', 'rg foo | sort', 'grep foo', 'grep -rn foo', 'grep -c foo', 'rg -c foo 2>/dev/null',
    'sort a.md', 'sort -u a.md b.md', 'sort -rn -k2,2 a.md', 'sort -t, -k1 a.md', 'cat a.md | sort | uniq', 'uniq a.md', 'uniq -c a.md', 'cat a.md | uniq -d', 'sort *.md', 'cut -d, -f1 a.md', "cut -d ' ' -f 2- a.md", 'cat a.md | cut -c1-10', "cat a.md | tr -d '\\n'", 'cat a.md | tr a-z A-Z', "cat a.md | tr -s ' '", 'nl a.md', 'nl -ba a.md', 'nl *.md', 'cat a.md | nl -ba', 'rg -l foo src | sort | head -5', 'ls src/*.ts | wc -l']
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer', 'lean-agent:reviewer']) for (const c of ok) expect(await as(t)(c), `${t}: ${c}`).toBeNull()
  const bad = ['cat *.md > out', 'cat *.md >> out', 'rg foo 2>out', 'rg foo 2>/dev/nullx', 'rg foo 2>>/dev/null', 'rg foo >/dev/null', 'rg foo 2>&1', 'rg foo &>/dev/null', 'rg foo 2> /dev/null', 'cat a.md 3>/dev/null',
    'ls; ls', 'ls && ls', 'ls || ls', 'cat $(ls)', 'cat `ls`', 'cat "$(ls)"', 'cat ${HOME}/x', 'cat *.md; rm x', 'cat *.md && rm x', 'cat *.md &', 'cat < a.md',
    'cat /etc/*', 'cat /*', 'ls /h/*', 'cat /h/.ssh/*', 'cat ../*', 'cat src/../*', 'cat ../../etc/*', 'ls /h/code/*', 'cat /h/code/app/../*', 'cat /h/.lean-agent/../.ssh/*', 'cat lnk/*', 'cat lnk/esc*', 'cat l*/*', 'cat lnk/e*/.keep', 'cat */*', 'ls -d /h/.*', 'cat -*',
    'sort -o out a.md', 'sort -oout a.md', 'sort --output=out a.md', 'sort --output out a.md', 'sort -T /tmp a.md', 'sort --random-source=/etc/passwd -R a.md', 'sort --files0-from=x', 'sort --compress-program=sh a.md', 'sort /etc/passwd', 'sort ../x',
    'uniq *.md', 'cat a.md | uniq *.md', 'uniq a.m*', // (a glob that expands to two names would make the second one uniq's OUTPUT file)
    'cat .*', 'ls .*', 'ls .?', 'ls ..*', 'rg x .*/.*/.*/.*', 'ls src/.*', 'cat .*/x', // (older shells expand .* to . and .., which climbs out of the roots)
    'sort [!]]o a.md', 'cat []a]', 'cat [!]]', 'cat [[:alpha:]]', 'cat src/[]]', 'cat [a-z[:digit:]]', // (a bracket set that is sized differently by the shell)
    'rg foo | wc -l /etc/*', 'rg foo | sort *.md > out',
    "cat '[ab]'/*", 'cat "[ab]"/*', "cat '*'*", "cat a'?'*", // (a quoted glob character is literal to the shell, an unquoted one in the same word is not: the word is refused)
    'uniq a.md b.md', 'uniq /etc/passwd', 'uniq -c a.md out', 'cut -f1 /etc/passwd', 'tr', 'tr a b c', 'tr -d', 'tr a b /etc/passwd', 'tr a-z *', 'nl /etc/passwd', 'nl -h x --output=y a.md',
    'xargs ls', 'rg -l foo | xargs cat', 'cd src', 'cd /h && ls', 'awk 1 a.md', 'find . -name *.ts', 'sed -n 1p *.md', 'jq . *.json', 'stat *.md', 'diff *.md', 'git log *.ts', 'git -C /h/code/app diff -- *.ts', 'rg *.ts', 'rg foo -g *.ts src', 'grep -e *x src', 'rg -t * x']
  for (const t of ['lean-agent:reviewer', 'lean-agent:reviewer']) for (const c of bad) expect(await as(t)(c), `${t}: ${c}`).toContain('may run only')
  // a relative glob whose match would read as a flag (-x.md) is refused; the same glob next to a plain name is fine, and so is a pattern that starts with a folder
  expect(await as('lean-agent:reviewer', `${wt}/dash`)('cat *.md')).toContain('may run only')
  expect(await as('lean-agent:reviewer', `${wt}/dash`)('cat y*.md')).toBeNull()
  expect(await as('lean-agent:reviewer')('cat dash/*.md')).toBeNull()
  // no path operand needs a cwd inside the roots; a cwd outside them refuses it, and so does a glob there
  for (const cwd of ['/h', '/tmp', '/']) for (const c of ['rg foo', 'grep -rn foo', 'cat *.md', 'ls *', 'rg foo 2>/dev/null']) expect(await as('lean-agent:reviewer', cwd)(c), `${cwd}: ${c}`).toContain('may run only')
  expect(await as('lean-agent:reviewer', '/h/code/app/src')('rg foo 2>/dev/null')).toBeNull()
  expect(await as('lean-agent:reviewer', '/h/code/app/lib')('cat *.ts')).toBeNull()
  for (const t of ['reader-haiku', 'other:reader-haiku']) expect(await as(t)('cat *.md')).toContain('may run only')
  // the refusal says what is allowed, and what a worker's out-of-grant edit must do
  expect(await as('lean-agent:reviewer')('cat *.md > out')).toContain('2>/dev/null')
})

test('search commands refuse a relative path when the session cwd is unknown or root', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  for (const cwd of ['', '/']) {
    expect(await run(h, thread, { tool: 'Bash', command: 'cat src/a.ts' }, cwd, 'lean-agent:auditor', 'x1'), cwd).toContain('may run only')
    expect(await run(h, thread, { tool: 'Bash', command: 'rg foo' }, cwd, 'lean-agent:auditor', 'x1'), cwd).toContain('may run only')
  }
})

test('allow-edit / allow-cmd lines in an Agent call are accepted and ignored (never refused); allow-mcp lines still need a thread', async () => {
  const h = setup()
  const call = (role: any, prompt: string, agentId?: string) => run(h, role, { tool: 'Agent', prompt, subagent_type: 'lean-agent:reader-haiku' }, '/r', agentId ? 'lean-agent:worker-sonnet' : undefined, agentId)
  for (const role of [plain, thread]) expect(await call(role, 'Look.\nallow-cmd: git log\nallow-edit: /a/b\n')).not.toContain('cannot own grants')
  expect(await call(thread, 'Look.\nallow-edit: /a/b\n', 'w1')).toBeNull() // a subagent's call too
  expect(await call(plain, 'Look.\nallow-mcp: srv\n')).toContain('cannot own grants')
})

test('the desk may run read-only search under ~/.lean-agent only', async () => {
  const h = setup()
  const desk = { kind: 'desk' } as any
  const bash = (c: string) => run(h, desk, { tool: 'Bash', command: c }, '/h/lean-agent-desk')
  for (const c of ['rg stale /h/.lean-agent/projects.json', 'ls /h/.lean-agent/threads', 'cat /h/.lean-agent/threads/t1/brief.md | head -5']) expect(await bash(c), c).toBeNull()
  expect(await bash('ls /h/.lean-agent/threads')).toBeNull()
  expect(await bash('cat /h/.lean-agent/threads/t1/brief.md | head -5')).toBeNull()
  expect(await bash('rg foo /r/app')).toContain('route this to a thread')
  expect(await bash('rg foo')).toContain('route this to a thread') // the desk folder is outside the root
  expect(await bash('cat /h/.lean-agent/x > /tmp/y')).toContain('route this to a thread')
  expect(await bash('find /h/.lean-agent -delete')).toContain('route this to a thread')
})

test('approve-push: a push naming one sha twice, or two shas where one lacks approval, burns nothing; private projects cannot be approved', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin feature feature:other' })).toBeNull() // one sha, two refspecs
  await writeApproval(h.host, { project: 'app', sha: SHA, thread: 't1' })
  h.git.handler = a => (a.includes('rev-parse') ? { exitCode: 0, stdout: (a.join(' ').includes('other') ? 'f'.repeat(40) : SHA) + '\n' } : { exitCode: 1, stdout: '' })
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin feature other:x' })).toContain('no green review') // the second sha has none
  h.git.handler = a => (a.includes('rev-parse') ? { exitCode: 0, stdout: SHA + '\n' } : { exitCode: 1, stdout: '' })
  expect(await run(h, thread, { tool: 'Bash', command: 'git push origin feature' })).toBeNull() // the first approval was not spent
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app', private: true } }))
  const r = await leanThread(h.host, '/p', { action: 'approve-push', tN: 't1', sha: SHA })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('private project')
})

test('search: attached and clustered -e/-f, symlink-following flags, recursion without a path, tail abbreviations, a cwd outside every root', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const thread = { kind: 'thread', id: 't1' } as any
  const at = (cwd: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, cwd, 'lean-agent:reviewer', 'x1')
  const lean = at('/h/.lean-agent/worktrees/app/t1')
  for (const c of ['grep -rf /etc/passwd src', 'rg -nf/etc/shadow x', 'rg -nfpats x src', 'rg -L secret src', 'rg --follow secret src', 'grep -R x src', 'grep --dereference-recursive x src', 'find -L . -name x', 'find -H . -name x', 'find . -follow', "find . -exec ls '{}' ';'", "find . -execdir ls '{}' ';'", "find . -ok ls '{}' ';'", "find . -okdir ls '{}' ';'", 'tail --fo x', 'tail --ret x', 'tail --follow=name x'])
    expect(await lean(c), c).toContain('may run only')
  for (const c of ['grep -ePAT src', "grep -rn -e '/api' src", "rg -e 'a..b' src", "grep -rn 'foo\\|bar' src", 'grep -rn "\\bword\\b" src', 'git log HEAD~1', 'git diff @{u}', 'git log -3 --format="%h %s"', "rg 'x|y' src | head -3"])
    expect(await lean(c), c).toBeNull()
  for (const c of ['git log {a,b}', 'git log {1..3}', 'git log ~x', 'cat ~/x'])
    expect(await lean(c), c).toContain('may run only')
  for (const cwd of ['/h', '/tmp', '/h/.ssh', '/']) {
    expect(await at(cwd)('cat id_rsa'), cwd + ' cat').toContain('may run only')
    expect(await at(cwd)('rg -r x .'), cwd + ' rg').toContain('may run only')
    expect(await at(cwd)('grep -rn password'), cwd + ' grep').toContain('may run only')
  }
  expect(await at('/h/code/app/src')('rg foo')).toBeNull() // inside a registered project
})

test('search: separate-value options do not shift the pattern; rg --files; grep abbreviations; files0-from; a symlink in a root', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  h.links.set('/h/.lean-agent/worktrees/app/t1/link', '/h/.ssh')
  h.files.set('/h/.ssh/id_rsa', 'secret')
  h.files.set('/h/.lean-agent/worktrees/app/t1/src/a.ts', 'x')
  const thread = { kind: 'thread', id: 't1' } as any
  const at = (cwd: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, cwd, 'lean-agent:reviewer', 'x1')
  const out = at('/h/.ssh')
  for (const c of ["rg -m 1 '/h/.lean-agent/|'", "rg --hidden -m 1 '/h/.lean-agent/|'", "rg -g '*.ts' '/h/.lean-agent/x'", "rg -t ts -A 2 '/h/code/app/'", "rg --max-count 1 '/h/.lean-agent/'", "grep -r -A 1 '/h/.lean-agent/|'", "grep -rn -m 1 '/h/code/app|'", 'rg --files /etc', 'rg --files /', 'grep --rec password', 'grep --directories=recurse x', 'grep --dir=recurse x', 'grep --fil /etc/passwd x', 'grep --exclude-from /etc/x y', 'find /h/.lean-agent -files0-from /etc/x', 'wc --files0-from=-', 'wc --files0-from=/etc/x'])
    expect(await out(c), c).toContain('may run only')
  const lean = at('/h/.lean-agent/worktrees/app/t1')
  for (const c of ['cat link/id_rsa', 'ls link', 'rg x link', 'grep -rn x link', 'find link -name x', 'cat link/../x']) expect(await lean(c), c).toContain('may run only') // symlink to outside
  for (const c of ["rg -m 1 'x' src", "rg -g '*.ts' foo src", "grep -rn -A 2 -m 3 foo src", 'rg --files src', 'rg --files', "grep --include='*.ts' -rn foo src", 'grep --ignore-case foo src/a.ts', 'ls -la | head', 'rg foo | grep bar']) expect(await lean(c), c).toBeNull()
  // piped grep with no path reads stdin: fine even where the cwd is no root (the desk)
  const desk = { kind: 'desk' } as any
  expect(await run(h, desk, { tool: 'Bash', command: 'cat /h/.lean-agent/memory/notes.jsonl | grep foo' }, '/h/lean-agent-desk')).toBeNull()
  expect(await run(h, desk, { tool: 'Bash', command: 'grep foo' }, '/h/lean-agent-desk')).toContain('route this')
})

test('search: every flag must be on the command\'s own list (the reviewers\' bypass shapes)', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/h/code/app' } }))
  const thread = { kind: 'thread', id: 't1' } as any
  const at = (cwd: string) => (c: string) => run(h, thread, { tool: 'Bash', command: c }, cwd, 'lean-agent:reviewer', 'x1')
  const app = at('/h/code/app/src')
  for (const c of ['rg -v -- -x /etc/shadow', 'grep -rv -- -x /etc', 'grep -rv - /etc', 'rg -v - /etc', 'grep -r --color pat /etc', 'grep -r -5f /etc/passwd src', 'grep /etc -rn5e pat', 'ls -RL .', 'ls -L .', 'ls -H .', 'ls --dereference .', 'ls -I x', 'tail -5f x', 'rg --ignore-file /etc/x pat', 'rg -f /etc/x pat', 'grep -f /etc/x pat', 'rg --type-add x:y pat', 'rg -z pat', 'find . -newer /etc/passwd', 'find . -name', 'wc -c --files0-from=x', 'head --foo x', 'cat -f x', 'grep -d recurse x', 'rg --pat x'])
    expect(await app(c), c).toContain('may run only')
  const home = at('/h')
  for (const c of ['find -newer /h/code/app/a.ts -name x', 'grep --null-data x src', 'rg -vnA 2 .lean-agent', 'grep -rvnA 2 .lean-agent', 'find -name .lean-agent/x', 'ls -w 80', 'ls', 'rg -v pat', 'grep -r pat', 'grep pat']) expect(await home(c), c).toContain('may run only')
  for (const c of ['rg -- -x src', 'grep -rv -e -x src', 'grep -rn -A 2 -m 3 foo .', 'find . -newer a.ts -name x', 'find src -type f -mtime -1 -name "*.ts"', 'ls -RFh src', 'ls -1 src', 'head -n 5 a.ts', 'tail -c 20 a.ts', 'wc -lw a.ts', 'cat -n a.ts', 'rg -C3 foo', 'rg --max-count=2 -ni foo src']) expect(await app(c), c).toBeNull()
})

test('every refusal names the code that refused it (version skew); an allow stays null', async () => {
  const h = setup()
  const ctx = { role: desk, cwd: '/r/app', version: '1.0.3' }
  expect(await decide(h.host, ctx, { tool: 'Edit', file_path: '/h/x' })).toMatch(/^lean-agent.* \(lean-agent 1\.0\.3\)$/)
  expect(await decide(h.host, { ...ctx, role: plain, agentType: 'lean-agent:auditor', agentId: 'a1' }, { tool: 'Bash', command: 'make clean' })).toMatch(/\(lean-agent 1\.0\.3\)$/)
  expect(await decide(h.host, { ...ctx, role: plain, agentType: 'lean-agent:auditor', agentId: 'a1' }, { tool: 'Bash', command: 'git -C /r/app ls-files | head -3' })).toBeNull()
  expect(await decide(h.host, { ...ctx, role: plain }, { tool: 'Bash', command: 'git -C /r/app push --force origin main' })).toMatch(/\(lean-agent 1\.0\.3\)$/)
  expect(await decide(h.host, { role: desk, cwd: '/r/app' }, { tool: 'Edit', file_path: '/h/x' })).not.toContain('(lean-agent') // no version known (a spec, a helper): text unchanged
})

// ---- 1.0.18: workers may read and edit, readers read; a short never-list; the thread's own read-only git -------------------------
test('a reader runs any plain shell read (a pipe included); it writes no file outside a temp folder; the never-list holds', async () => {
  const h = setup()
  const reader = (c: string, t = 'lean-agent:reader-haiku') => run(h, thread, { tool: 'Bash', command: c }, '/r', t, 'r1')
  for (const c of ['git log --oneline | head -5', 'cat /r/app/a.ts | grep -n foo | wc -l', 'awk "{print $1}" /r/app/a.ts', 'npm ls --depth=0 2>/dev/null', 'python3 -c "print(1)"', 'ls -la /r/app && cat /r/app/a.ts', 'rg foo /r/app > /tmp/out.txt', 'cat /r/app/a.ts 2>&1 | head'])
    expect(await reader(c), c).toBeNull()
  for (const t of ['lean-agent:reader-sonnet', 'lean-agent:explorer']) expect(await reader('git log | head -3', t)).toBeNull()
  for (const c of ['rg foo > out.txt', 'cat a >> /r/app/b.ts', 'echo x | tee /r/app/a.ts', 'sed -i s/a/b/ /r/app/a.ts', 'rm -rf /r/app/src', 'git commit -am x', 'cat a > /tmp/../etc/x']) expect(await reader(c), c).toContain('a reader')
  for (const c of ['git push origin x', 'git -C /r/app push', 'git tag v1', 'git tag -d v1', 'gh pr create --title x', 'gh release create v1', 'az repos pr create', 'claude config set x y', 'cat x > /r/.claude/settings.json'])
    expect(await reader(c), c).not.toBeNull()
  expect(await reader('git tag -l')).toBeNull()
  expect(await reader('gh pr view 3')).toBeNull()
})

test('a worker runs any shell command except the never-list, and edits anywhere but lean-agent\'s own state', async () => {
  const h = setup()
  const worker = (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/r', 'lean-agent:worker-haiku', 'w1')
  for (const c of ['npm test && git add -A && git commit -m x', 'rm -rf /r/app/dist', 'sed -i s/a/b/ /r/app/a.ts', 'curl -s https://example.org | head', 'echo x > /r/app/a.txt', 'git tag -l']) expect(await worker(c), c).toBeNull()
  for (const c of ['git push origin x', 'git tag v1.0.0', 'gh pr merge 3', 'gh release create v1', 'az repos pr create', 'claude plugin install x', 'echo {} > ~/.claude/settings.json', 'echo x > /h/.lean-agent/config.json', 'rm /h/.lean-agent/projects.json'])
    expect(await worker(c), c).not.toBeNull()
  expect(await worker('cat /h/.lean-agent/config.json')).toBeNull() // reading is fine
  const edit = (p: string) => run(h, thread, { tool: 'Edit', file_path: p }, '/r', 'lean-agent:worker-haiku', 'w1')
  expect(await edit('/anywhere/else/a.ts')).toBeNull() // no grant line, no grant record
  expect(await edit('/h/.lean-agent/config.json')).toContain('own state')
  expect(await edit('/h/.lean-agent/threads/t9/thread.json')).toContain('own state')
  expect(await edit('/h/.lean-agent/worktrees/app/t1/a.ts')).toBeNull()
})

test('a thread runs its own read-only git and ls in its registered worktrees and project repos, never a write', async () => {
  const h = fakeHost(null, { orchestrate: true })
  h.git.handler = x => (x.includes('rev-parse') ? { exitCode: 0, stdout: SHA + '\n' } : { exitCode: 1, stdout: '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  const wt = '/h/.lean-agent/worktrees/app/t1'
  const own = (c: string, cwd = '/h/.lean-agent/threads/t1') => run(h, thread, { tool: 'Bash', command: c }, cwd)
  for (const c of [`git -C ${wt} status`, `git -C ${wt} diff`, `git -C ${wt} diff main...HEAD -- src`, `git -C ${wt} log --oneline -5`, `git -C ${wt} show HEAD`, `git -C ${wt} branch --show-current`, `git -C ${wt} branch -a`, `git -C ${wt} rev-parse HEAD`, `git -C ${wt} merge-base main HEAD`, `git -C ${wt} worktree list`, `git -C ${wt} ls-files src`, `ls ${wt}`, `git -C /r/app status`])
    expect(await own(c), c).toBeNull()
  for (const c of [`git -C ${wt} diff --output=/x`, `git -C ${wt} log | sh`, `cat ${wt}/a.ts`, `ls /etc`])
    expect(await own(c), c).not.toBeNull()
})
