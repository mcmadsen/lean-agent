import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide, isWorker, parseGrants, recordGrant, releaseGrant } from './guard'
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
  expect(parseGrants('do it\nallow-edit: /a/b, /c\nallow-cmd: git log, ls\n--allow-edit=rel')).toEqual({ edit: ['/a/b', '/c', ], cmds: ['git log', 'ls'] })
  await recordGrant(h.host, thread, 'call1', 'lean-agent:reader-sonnet', { cmds: ['git log', 'ls'] })
  await recordGrant(h.host, thread, 'call2', 'lean-agent:worker-sonnet', { edit: ['/h/.lean-agent/worktrees/app/t1'] })
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  expect(await run(h, thread, edit('/anything'), '/r', 'lean-agent:reader-haiku')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'unknown')).toContain('read-only')
  expect(await run(h, thread, edit('/anything'), '/r', 'general-purpose')).toContain('read-only')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log -5' }, '/r', 'lean-agent:reader-sonnet', 'r1')).toBeNull()
  expect(await run(h, thread, { tool: 'Bash', command: 'rm -rf x' }, '/r', 'lean-agent:reader-sonnet', 'r1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Bash', command: 'ls; rm x' }, '/r', 'lean-agent:reader-sonnet', 'r1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Bash', command: 'git log' }, '/r', 'unknown', 'u1')).toContain('granted')
  expect(await run(h, thread, { tool: 'Read', file_path: '/x' }, '/r', 'lean-agent:reader-sonnet', 'r1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/../t2/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toContain('outside')
  expect(await run(h, thread, edit('/etc/x'), '/r', 'lean-agent:worker-opus', 'w2')).toContain('outside')
  expect(await run(h, plain, edit('/h/.lean-agent/worktrees/app/t1/a'), '/r', 'lean-agent:worker-opus', 'w3')).toContain('outside') // no grants for plain
  expect(await run(h, thread, edit('/anything'), '/r')).toBeNull() // the thread's own main loop is not a worker
  await releaseGrant(h.host, thread, 'call2')
  expect(await run(h, thread, edit('/h/.lean-agent/worktrees/app/t1/src/a.ts'), '/r', 'lean-agent:worker-sonnet', 'w1')).toContain('outside')
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
  expect(await bash('git diff main...abc1234 | cat')).toContain('granted')
  expect(await bash('git push origin x')).toContain('granted')
  expect(await bash('git diff')).toBeNull() // built in for a reviewer
  expect(await bash('git merge-base main x')).toContain('granted')
})

test('the plugin-prefixed agent types: lean-agent:worker-* edits under a grant; reviewer, readers, foreign and bare types are read-only', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  await recordGrant(h.host, thread, 'c1', 'lean-agent:worker-sonnet', { edit: ['/h/.lean-agent/worktrees/app/t1'] })
  const edit = (p: string) => ({ tool: 'Edit', file_path: p })
  const ok = '/h/.lean-agent/worktrees/app/t1/src/a.ts'
  expect(await run(h, thread, edit(ok), '/r', 'lean-agent:worker-sonnet', 'w1')).toBeNull()
  expect(await run(h, thread, edit('/etc/x'), '/r', 'lean-agent:worker-sonnet', 'w1')).toContain('outside')
  expect(await run(h, thread, edit(ok), '/r', 'lean-agent:worker-opus', 'w9')).toContain('outside') // no grant of its own
  for (const t of ['lean-agent:reviewer', 'lean-agent:reader-haiku', 'lean-agent:explorer', 'other:worker-x', 'worker-x', 'lean-agent:lean-agent:worker-x'])
    expect(await run(h, thread, edit(ok), '/r', t, 'x1')).toContain('read-only')
  expect([isWorker('lean-agent:worker-opus'), isWorker('worker-opus'), isWorker('other:worker-opus'), isWorker(undefined)]).toEqual([true, false, false, false])
})

test('built-in read-only git: the explorer runs ls-files / log without a grant; refusals; readers run show; foreign, bare and worker types differ', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  const bash = (command: string, t: string) => run(h, thread, { tool: 'Bash', command }, '/r', t, 'e1')
  const ex = (c: string) => bash(c, 'lean-agent:explorer')
  expect(await ex('git ls-files src')).toBeNull()
  expect(await ex('git log --oneline -5 -- src')).toBeNull()
  expect(await ex('git log -3')).toBeNull()
  expect(await ex('rm x')).toContain('built-in')
  expect(await ex('git show HEAD:file')).toContain('built-in') // explorer: only log / ls-files
  for (const c of ['git log --output=x', 'git log --out=x', 'git log -o x', 'git -c core.pager=sh log', 'git --exec-path=/x log', 'git ls-files > x', 'git diff --ext-diff', 'git log | sh', 'git log; rm x', 'git log $(id)', 'git log $HOME', 'GIT_PAGER=sh git log', 'git -C /etc log', 'git --config-env=a=b log', 'git push origin x'])
    expect(await bash(c, 'lean-agent:reviewer'), c).toContain('granted')
  expect(await bash('git ls-files > x', 'lean-agent:explorer')).toContain('granted')
  expect(await bash('git log --output=x', 'lean-agent:explorer')).toContain('granted')
  expect(await bash('git -c core.pager=sh log', 'lean-agent:explorer')).toContain('granted')
  expect(await bash('git log | sh', 'lean-agent:explorer')).toContain('granted')
  for (const t of ['lean-agent:reader-haiku', 'lean-agent:reader-sonnet', 'lean-agent:reviewer']) {
    expect(await bash('git show HEAD:file', t)).toBeNull()
    expect(await bash('git diff --stat main...HEAD', t)).toBeNull()
    expect(await bash('git status --short', t)).toBeNull()
    expect(await bash('git rev-parse HEAD', t)).toBeNull()
    expect(await bash('git -C /r/sub log -2', t)).toBeNull()
  }
  expect(await bash('git diff --ext-diff', 'lean-agent:reader-haiku')).toContain('granted')
  for (const c of ['git log --{output=/tmp/x,}', 'git log {--output=/tmp/x,}', 'git diff {--ext-diff,}', 'git -C ~ log', 'git -C sub/../.. log', 'git -C a -C b log', 'git diff --ext x', 'git log --exec=x', 'git diff --no-index a b', 'git log --help', 'git log -h', 'git log --$"output=x"', 'git ls-files *'])
    expect(await bash(c, 'lean-agent:reader-sonnet'), c).toContain('granted')
  for (const c of ['git ls-files --exclude-standard', 'git ls-files -o', 'git log --oneline --grep=x', 'git log -Sdone', 'git rev-parse --git-dir', 'git --no-pager log -2', 'git log --output-indicator-new=+'])
    expect(await bash(c, 'lean-agent:reader-sonnet'), c).toBeNull()
  for (const t of ['other:explorer', 'explorer', 'other:reader-haiku', 'reader-haiku'])
    expect(await bash('git log -3', t), t).toContain('granted')
  expect(await bash('git log -3', 'lean-agent:worker-sonnet')).toBeNull() // a worker is unchanged
  expect(await bash('git push origin x', 'lean-agent:worker-sonnet')).not.toContain('built-in')
})

test('a grant adds on top of the built-in git commands', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  await recordGrant(h.host, thread, 'c1', 'lean-agent:explorer', { cmds: ['ls'] })
  const bash = (command: string) => run(h, thread, { tool: 'Bash', command }, '/r', 'lean-agent:explorer', 'e1')
  expect(await bash('ls src')).toBeNull()
  expect(await bash('git ls-files src')).toBeNull()
})

test('a grant that names the agent bare binds to the prefixed type, and the other way round', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  await recordGrant(h.host, thread, 'c1', 'reviewer', { cmds: ['git log'] })
  expect(await run(h, thread, { tool: 'Bash', command: 'git log -2' }, '/r', 'lean-agent:reviewer', 'r1')).toBeNull()
  await recordGrant(h.host, thread, 'c2', 'lean-agent:reader-haiku', { cmds: ['ls'] })
  expect(await run(h, thread, { tool: 'Bash', command: 'ls' }, '/r', 'reader-haiku', 'r2')).toBeNull()
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
  const bash = (c: string) => run(h, thread, { tool: 'Bash', command: c }, '/h/.lean-agent/threads/t1', 'lean-agent:explorer', 'e1')
  expect(await bash('git -C /h/code/app ls-files src')).toBeNull()
  expect(await bash('git -C /h/.lean-agent/worktrees/app/t1 log -3')).toBeNull()
  expect(await bash('git -C /h/code/other ls-files')).toContain('granted')
  expect(await bash('git -C /etc log')).toContain('granted')
  expect(await bash('git -C sub log')).toContain('granted') // relative: it would resolve against the agent's own cwd
  expect(await bash('git diff --no-ind a b')).toContain('granted')
})

test('an unknown or root session cwd widens no git -C root; a desk subagent without a type is refused as unresolved', async () => {
  const h = fakeHost(null)
  const thread = { kind: 'thread', id: 't1' } as any
  for (const cwd of ['', '/'])
    expect(await run(h, thread, { tool: 'Bash', command: 'git -C /h/other log' }, cwd, 'lean-agent:explorer', 'e1'), cwd).toContain('granted')
  const desk = { kind: 'desk' } as any
  expect(await run(h, desk, { tool: 'Bash', command: 'git log' }, '/r', undefined as any, 'x1')).toContain('type unresolved')
})
