// 1.0.35 guard additions: interpreter script files (scriptfile.ts), one gh / az read list (shell.ts calls forgecli.ts), analyze once per command.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { scriptFiles, scriptForgeWrite, SCRIPT_MAX } from './scriptfile'
import { analyze, analyzeRuns } from './shell'
import { forgeCommandWrite } from './forgewrite'

const thread = { kind: 'thread', id: 't1' } as const
const WT = '/h/.lean-agent/worktrees/app-fix'
const SCRATCH = '/h/.lean-agent/threads/t1/scratch'

function world() {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'app/fix': { path: WT, repo: '/r/app', branch: 'fix', thread: 't1' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  return h
}
const run = (h: any, command: string, agentType?: string, cwd = WT) => decide(h.host, { role: thread, cwd, agentType, agentId: agentType ? 'a1' : undefined }, { tool: 'Bash', command })

test('scriptFiles: the file of python / python3 / node / bash / sh runs; -c / -e / -m code, stdin, variables and globs name no file', () => {
  const T: [string, string[]][] = [
    ['python3 tools/post.py', ['tools/post.py']], ['python post.py --x 1', ['post.py']], ['python3.12 /abs/p.py', ['/abs/p.py']], ['node run.js', ['run.js']], ['nodejs run.js a b', ['run.js']],
    ['bash run.sh', ['run.sh']], ['sh run.sh', ['run.sh']], ['/usr/bin/python3 -u -B p.py', ['p.py']], ['python3 -W ignore p.py', ['p.py']], ['node -r ts-node/register run.js', ['run.js']],
    ['bash -o pipefail run.sh', ['run.sh']], ['cd /x && python3 a.py && node b.js', ['a.py', 'b.js']], ['FOO=1 python3 p.py', ['p.py']], ['sudo -n python3 p.py', ['p.py']], ["python3 'my file.py'", ['my file.py']],
    ['python3 a.py | tee o', ['a.py']], ['python3 -c "print(1)"', []], ['node -e "1"', []], ['python3 -m http.server', []], ['bash -c "ls"', []], ['python3 - <<EOF\nprint(1)\nEOF', []],
    ['python3 $SCRIPT', []], ['python3 *.py', []], ['python3 ~/p.py', []], ['ls tools/post.py', []], ['cat run.sh', []], ['git commit -m "python3 x.py"', []], ['./run.sh', []],
  ]
  for (const [c, want] of T) expect([c, scriptFiles(c)]).toEqual([c, want])
})

const POST_AZ = "import subprocess\nsubprocess.run(['az', 'repos', 'pr', 'set-vote', '--id', '4321', '--vote', 'approve'])\n"
const POST_GH = "import os\nos.system('gh pr comment 4321 --body done')\n"
const POST_CURL = 'curl -X POST -d @b.json https://dev.azure.com/acme/proj/_apis/git/repositories/r/pullRequests/4321/threads?api-version=7.1\n'
const READ_ONLY = "import subprocess\nsubprocess.run(['az', 'repos', 'pr', 'show', '--id', '4321'])\nsubprocess.run(['gh', 'pr', 'view', '4321'])\n"

test('a script file with a forge write refuses the run (thread and worker), with the action-kind hint; reads, outside files, big and binary files and missing files are not read or refused', async () => {
  const h = world()
  h.files.set(`${WT}/tools/vote.py`, POST_AZ)
  h.files.set(`${WT}/tools/comment.py`, POST_GH)
  h.files.set(`${WT}/tools/post.sh`, POST_CURL)
  h.files.set(`${WT}/tools/read.py`, READ_ONLY)
  h.files.set(`${SCRATCH}/note.py`, POST_GH)
  h.files.set('/r/other/vote.py', POST_AZ) // not the thread's worktree
  h.files.set(`${WT}/big.py`, POST_GH + '#'.repeat(SCRIPT_MAX))
  h.files.set(`${WT}/bin.py`, POST_GH + '\u0000\u0001')
  h.files.set(`${WT}/notes.py`, '# the release step runs: gh pr create --title x\n// az repos pr create\nprint("hello")\n')
  for (const agent of [undefined, 'lean-agent:worker-sonnet']) {
    const why = (c: string) => run(h, c, agent)
    const vote = await why('python3 tools/vote.py')
    expect([agent, vote]).toEqual([agent, expect.stringContaining('forge writes go through the desk')])
    expect(vote).toContain('(closest kind: ado-pr-vote)')
    expect(vote).toContain('the script vote.py makes a forge write: az repos')
    expect(await why('python3 tools/comment.py')).toContain('gh pr')
    expect(await why('bash tools/post.sh')).toContain('curl')
    expect(await why(`python3 ${SCRATCH}/note.py`)).toContain('forge writes go through the desk')
    expect(await why(`python3 ${WT}/tools/../tools/vote.py`)).toContain('forge writes go through the desk')
    // nothing to refuse
    expect(String(await why('python3 tools/read.py'))).not.toContain('forge writes')
    expect(String(await why('python3 /r/other/vote.py'))).not.toContain('forge writes') // outside the worktree and scratch: not read
    expect(String(await why('python3 big.py'))).not.toContain('forge writes') // over 200 KB
    expect(String(await why('python3 bin.py'))).not.toContain('forge writes') // binary
    expect(String(await why('python3 missing.py'))).not.toContain('forge writes')
    expect(String(await why('python3 notes.py'))).not.toContain('forge writes') // a forge write in a whole-line comment is text
    expect(String(await why('python3 tools/'))).not.toContain('forge writes') // a folder
    expect(String(await why('python3 $F'))).not.toContain('forge writes')
  }
})

test('scriptForgeWrite: needs the thread; a path that climbs out of the folders is not read; the detector is the one of -c strings', async () => {
  const h = world()
  h.files.set(`${WT}/vote.py`, POST_AZ)
  h.files.set('/r/other/vote.py', POST_AZ)
  expect(await scriptForgeWrite(h.host, { thread: 't1', cwd: WT }, 'python3 vote.py')).toContain('az repos')
  expect(await scriptForgeWrite(h.host, { cwd: WT }, 'python3 vote.py')).toBeNull() // no thread: no folders known
  expect(await scriptForgeWrite(h.host, { thread: 't1', cwd: WT }, 'python3 ../../../../../r/other/vote.py')).toBeNull()
  expect(await scriptForgeWrite(h.host, { thread: 't2', cwd: WT }, 'python3 vote.py')).toBeNull() // another thread's worktrees only
  expect(forgeCommandWrite(`python3 -c "${POST_AZ.replace(/"/g, "'").replace(/\n/g, ';')}"`)).toBe('az repos') // the same text through -c is the same verdict
})

test('one gh / az read list: shell.ts judges the forge groups by forgecli.ts, everything outside them stays refused as before', () => {
  const WRITE = ['gh pr create --title x', 'gh pr merge 3', 'gh pr comment 3 -b x', 'gh issue create', 'gh api -X POST repos/o/r/issues', 'gh api repos/o/r/issues -f title=x', 'gh auth login', 'gh config set a b', 'gh browse', 'gh workflow run x.yml', 'gh secret set X', 'gh release create v1', 'gh repo delete o/r --yes', 'gh alias set a b',
    'az repos pr create', 'az repos pr set-vote --id 1 --vote approve', 'az boards work-item update --id 1', 'az login', 'az group delete -n x', 'az account set -s x', 'az aks get-credentials -n x -g y', 'az storage blob download -n x', 'az rest --method post --url https://x', 'az pipelines run --name p', 'az devops invoke --http-method POST --area git']
  const READ = ['gh pr view 3', 'gh pr list', 'gh pr diff 3', 'gh pr checks 3', 'gh pr status', 'gh pr', 'gh issue view 1', 'gh issue list', 'gh search prs x', 'gh repo view', 'gh run list', 'gh run view 1', 'gh release view v1', 'gh release list', 'gh auth status', 'gh --version',
    'az repos pr list', 'az repos pr show --id 1', 'az account show', 'az group list', 'az boards work-item show --id 1', 'az pipelines runs list', 'az version', 'az repos pr reviewer list --id 1',
    'gh workflow list', 'gh label list'] // (the last two: a read verb of a forge group is a read in every group now)
  for (const c of WRITE) expect([c, analyze(c).write]).toEqual([c, true])
  for (const c of READ) expect([c, analyze(c).write]).toEqual([c, false])
})

test('analyze scans a command once, however many guards ask; every caller gets its own copy', () => {
  const c = 'git push origin main && gh pr list # run-once-probe-1'
  const before = analyzeRuns()
  const a = analyze(c)
  const b = analyze(c)
  const d = analyze(c)
  expect(analyzeRuns() - before).toBe(1)
  expect(a).toEqual(b)
  expect(a.push).toBe(true)
  a.pushes[0]!.args.push('mutated')
  a.push = false
  expect(analyze(c).pushes[0]!.args).not.toContain('mutated')
  expect(analyze(c).push).toBe(true)
  expect(d.pushes).toHaveLength(1)
  expect(analyzeRuns() - before).toBe(1)
  analyze('echo another-probe')
  expect(analyzeRuns() - before).toBe(2)
})
