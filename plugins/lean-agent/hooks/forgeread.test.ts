// 1.0.26: forge READS (az / gh / curl / wget) pass for a reader, a worker, the reviewer and the thread; every write form is still refused with the
// write text. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { isForgeWrite } from './forgewrite'
import { forgeReadOk, forgeReadRefusal } from './forgeread'
import { orchConfig, orchDecide } from './orchestrate'
import { ruleOf } from './refusals'
import { analyze } from './shell'

const th = { kind: 'thread', home: '/h', threadDir: '/h/.lean-agent/threads/t1', cwd: '/r/app' } as const
const ADO = 'https://dev.azure.com/org-a/proj-a/_apis/git/repositories/repo-a/pullRequests/42/threads?api-version=7.1'
const GH = 'https://api.github.com/repos/o/r/pulls/3/comments'
const Q = `"${ADO}"` // (quoted, as a real command has it: an unquoted `?` is a glob, and the scanner calls such a command complex)

const READS = [
  'az repos pr show --id 42 --org https://dev.azure.com/org-a --output json',
  'az repos pr list --status active',
  'az repos pr policy list --id 42',
  'az repos pr reviewer list --id 42',
  'az repos pr work-item list --id 42',
  'az repos show --repository repo-a',
  'az repos list',
  'az repos ref list --repository repo-a',
  'az boards work-item show --id 5',
  'az boards query --wiql "select [System.Id] from workitems"',
  'az pipelines runs show --id 9',
  'az pipelines runs list --branch main',
  'az pipelines build show --id 9',
  'az pipelines build list',
  'az pipelines show --name ci',
  'az pipelines list',
  'az devops invoke --area git --resource pullRequestThreads --route-parameters project=proj-a repositoryId=repo-a pullRequestId=42',
  'az devops invoke --area git --resource pullRequestThreads --http-method GET --route-parameters pullRequestId=42',
  `az rest --method get --url ${Q}`,
  `az rest --method GET --url ${Q}`,
  `az rest --url ${Q}`,
  'az account show',
  'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798',
  'gh pr view 3',
  'gh pr list',
  'gh pr checks 3',
  'gh pr diff 3',
  'gh pr status',
  'gh run view 9',
  'gh run list',
  'gh issue view 3',
  'gh issue list',
  'gh repo view o/r',
  'gh release view v1',
  'gh release list',
  'gh api repos/o/r/pulls/3/comments',
  'gh api -X GET repos/o/r/pulls/3',
  "gh api graphql -f query='query { viewer { login } }'",
  "gh api graphql -f query='{ viewer { login } }'",
  `curl -sS ${Q}`,
  `curl -sS -f -H @- ${Q}`,
  `curl -X GET ${Q}`,
  `curl -sS -o /tmp/threads.json ${Q}`,
  `wget -qO- ${GH}`,
  `wget -O /tmp/c.json ${GH}`,
]
const WRITES = [
  `curl -X PATCH -H "Authorization: Bearer $T" -d '{"status":"fixed"}' "${ADO}"`,
  `curl -sS -d x=y ${Q}`,
  `curl -sS --data-binary @b.json ${Q}`,
  `az rest --method patch --url ${Q} --body '{}'`,
  'az devops invoke --area git --resource pullRequestThreads --http-method PATCH --in-file b.json',
  'az devops invoke --area git --resource pullRequestThreads --in-file b.json',
  'az repos pr create --title x',
  'az repos pr set-vote --id 3 --vote 10',
  'gh api -X POST repos/o/r/issues/3/comments -f body=hi',
  'gh api repos/o/r/issues/3/comments -f body=hi',
  "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
  'gh pr comment 3 --body hi',
]

test('1.0.26: the allow-list passes every read form, in the word check and the write detector', () => {
  for (const c of READS) {
    expect([c, isForgeWrite(c)]).toEqual([c, false])
    expect([c, analyze(c).write]).toEqual([c, false])
  }
  for (const c of WRITES) expect([c, isForgeWrite(c)]).toEqual([c, true])
  expect(forgeReadOk(['gh', 'api', '-f', 'x=y', 'repos/o/r'])).toBe(false)
  expect(forgeReadOk(['gh', 'api', '-X', 'POST', 'repos/o/r'])).toBe(false)
  expect(forgeReadOk(['az', 'rest', '--method', 'get', '--body', '{}', '--url', ADO])).toBe(false)
  expect(forgeReadOk(['curl', '-sS', '-o', '/home/x/out.json', ADO])).toBe(false)
  expect(forgeReadOk(['curl', '-sS', 'https://example.org/x'])).toBe(false)
  expect(forgeReadOk(['curl', '-sS', 'https://dev.azure.com.example.org/x'])).toBe(false)
  expect(forgeReadOk(['wget', ADO])).toBe(false) // wget saves a file unless -O says where
  expect(ruleOf(forgeReadRefusal())).toBe('forge-read')
})

test('1.0.26: a thread runs the read forms itself; a curl outside the list says the forge-read text, a write keeps the write text', () => {
  const c = orchConfig({})
  for (const cmd of READS) expect([cmd, orchDecide(c, th, { tool: 'Bash', command: cmd })]).toEqual([cmd, null])
  const own = `curl -sS -o /h/.lean-agent/threads/t1/scratch/t.json ${Q}`
  expect(orchDecide(c, th, { tool: 'Bash', command: own })).toBeNull()
  const out = String(orchDecide(c, th, { tool: 'Bash', command: `curl -sS -o /home/x/t.json ${Q}` }))
  expect(out).toContain('read it with lean_run get (forge reads by the mod), or one of: az repos pr show, az devops invoke (GET), gh pr view, gh api (GET)')
  expect(ruleOf(out)).toBe('forge-read')
  const w = String(orchDecide(c, th, { tool: 'Bash', command: `curl -sS -d x=y ${Q}` }))
  expect(w.startsWith('forge writes go through the desk')).toBe(true)
  expect(ruleOf(w)).toBe('forge-write')
})

test('1.0.26: a reader, a worker and the reviewer run the read forms; every write form is still refused with the write text', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  let n = 0 // (a fresh subagent id per call: a worker's step budget is per id)
  const run = (command: string, agentType: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', agentType, agentId: `a${++n}` }, { tool: 'Bash', command })
  for (const agent of ['lean-agent:reader-haiku', 'lean-agent:worker-haiku', 'lean-agent:reviewer']) {
    for (const cmd of READS) expect([agent, cmd, await run(cmd, agent)]).toEqual([agent, cmd, null])
    for (const cmd of WRITES) {
      const r = String(await run(cmd, agent))
      expect([agent, cmd, r.startsWith('forge writes go through the desk') || r.includes('a subagent makes no forge write')]).toEqual([agent, cmd, true])
    }
  }
  const outside = String(await run(`curl -sS -o /home/x/t.json ${Q}`, 'lean-agent:reader-haiku'))
  expect(outside).toContain('read it with lean_run get')
  expect(ruleOf(outside)).toBe('forge-read')
  expect(String(await run(`az rest --method get --body '{}' --url ${Q}`, 'lean-agent:worker-haiku'))).toContain('forge writes go through the desk') // (a body makes it a write, whatever the method says)
})
