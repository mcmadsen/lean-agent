import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { REVIEW_READONLY, gitCalls, reviewGitDenial } from './reviewguard'

const refused = (c: string) => expect(reviewGitDenial(c), c).toBe(REVIEW_READONLY)
const allowed = (c: string) => expect(reviewGitDenial(c), c).toBeNull()

test('a review refuses every git command that changes the PR checkout, in every spelling', () => {
  for (const c of [
    'git pull', 'git pull origin main', 'git merge origin/main', 'git rebase origin/main', 'git reset --hard origin/main', 'git cherry-pick abc123',
    'git commit -am x', 'git push origin HEAD', 'git checkout main', 'git switch main', 'git stash', 'git apply fix.patch', 'git am 0001.patch',
    'git -C /r/app pull', 'git -C /r/app -c core.editor=true merge origin/main', 'git --no-pager -C /r/app rebase main', '/usr/bin/git merge x',
    "sh -c 'git pull --rebase'", 'bash -c "cd /r/app && git merge origin/main"', 'echo ok && git reset --hard', 'git diff | cat; git pull', 'x=$(git merge origin/main)',
    'git -c alias.up=!git-pull up', 'git fetch origin main:main', 'git fetch origin +refs/heads/main:refs/heads/main', 'git fetch --update-head-ok origin',
  ]) refused(c)
})

test('the read-only forms stay allowed: diff, log, show, merge-base, status, rev-parse, ls-tree, cat-file, worktree list, fetch into scratch refs', () => {
  for (const c of [
    'git diff main...HEAD', 'git -C /r/app diff abc...def -- src/a.ts', 'git log --oneline abc..def', 'git show abc:src/a.ts', 'git merge-base main HEAD', 'git status --short',
    'git rev-parse HEAD', 'git ls-tree -r HEAD', 'git cat-file -p abc', 'git worktree list', 'git worktree add --detach /tmp/pr abc123', 'git fetch origin', 'git fetch origin refs/pull/7/merge:refs/ext/head-1',
    'git -C /r/app diff --stat abc...def | head -20', 'git blame src/a.ts', 'git grep -n foo', 'git ls-files', 'ls -la', 'grep merge README.md',
  ]) allowed(c)
  refused('echo "git pull is not run here"') // (a quoted command text is read like a command: never guess)
  expect(gitCalls("sh -c 'git -C /r/app -c a=b pull origin'")).toEqual([{ opts: ['-C', '/r/app', '-c', 'a=b'], sub: 'pull', args: ['origin'] }])
})

test('the guard applies it to a review thread (its marker) and its subagents, not to other threads', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', '{"lean":{"orchestrate":false}}')
  await h.host.store.set('review.marker.t1', { kind: 'review', project: 'app', ref: '7', ts: 1 })
  const call = { tool: 'Bash', command: 'git -C /r/app merge origin/main' }
  const review = await decide(h.host, { role: { kind: 'thread', id: 't1' } as any, cwd: '/r/app' }, call)
  expect(review).toContain(REVIEW_READONLY)
  const sub = await decide(h.host, { role: { kind: 'thread', id: 't1' } as any, cwd: '/r/app', agentType: 'lean-agent:worker-sonnet', agentId: 'w1' }, call)
  expect(sub).toContain(REVIEW_READONLY)
  const other = await decide(h.host, { role: { kind: 'thread', id: 't2' } as any, cwd: '/r/app' }, call)
  expect(other ?? '').not.toContain(REVIEW_READONLY)
  expect(await decide(h.host, { role: { kind: 'thread', id: 't1' } as any, cwd: '/r/app' }, { tool: 'Bash', command: 'git -C /r/app diff main...HEAD' })).not.toContain(REVIEW_READONLY)
})
