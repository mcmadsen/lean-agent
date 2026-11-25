import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { ACTION_KINDS } from './deskactions'
import { forgeCommandWrite, forgeRefusal, isForgeWrite, kindsLine, retiredAtLoad, staleMemoryCount } from './forgewrite'
import { memorySection } from './extras'
import { check, fix } from './doctor'
import { orchConfig, orchDecide } from './orchestrate'
import { ruleOf } from './refusals'

const th = { kind: 'thread', home: '/h', threadDir: '/h/.lean-agent/threads/t1', cwd: '/r/app' } as const
const ADO = 'https://dev.azure.com/org-a/proj-a/_apis/git/repositories/repo-a/pullRequests/42/threads/7?api-version=7.1'

test('1.0.24: the detector names forge writes by script (curl / wget / az / gh) and leaves reads and plain work alone', () => {
  const yes = [
    `curl -X PATCH -H "Authorization: Bearer $T" -d '{"status":"fixed"}' "${ADO}"`,
    `curl -sS -XPOST --data-binary @b.json ${ADO}`,
    `wget --method=PATCH --body-data='{}' ${ADO}`,
    `TOKEN=$(az account get-access-token --query accessToken -o tsv) && curl -X PATCH ${ADO} -d '{}'`,
    `az rest --method patch --url ${ADO} --body '{}'`,
    'az repos pr create --title x',
    'az repos pr set-vote --id 3 --vote 10',
    'az boards work-item update --id 5 --state Done',
    'gh api -X POST repos/o/r/issues/3/comments -f body=hi',
    'gh api repos/o/r/issues/3/comments -f body=hi',
    'gh pr comment 3 --body hi',
    'gh pr create --fill', // (1.0.34: a thread never opens a PR by shell either: the desk pushes and opens it after the review)
    'gh -R o/r pr review 3 --approve',
    `bash -c 'curl -X DELETE https://api.github.com/repos/o/r/issues/comments/9'`,
  ]
  for (const c of yes) expect([c, isForgeWrite(c)]).toEqual([c, true])
  const no = [
    `curl -sS ${ADO}`,
    'curl -X POST https://example.org/hook -d x',
    'az repos pr list --status active',
    'az repos pr show --id 3',
    'az account get-access-token',
    'gh api repos/o/r/pulls/3',
    'gh api -X GET repos/o/r/pulls/3 -f per_page=5',
    'gh pr view 3',
    'npm test',
    'git commit -m "curl the dev.azure.com api"',
  ]
  for (const c of no) expect([c, isForgeWrite(c)]).toEqual([c, false])
})

test('1.0.24: the refusal text names the kinds FROM THE TABLE, stays under 60 words and has its own rule id', () => {
  const t = forgeRefusal()
  expect(t.split(/\s+/).length).toBeLessThan(60)
  for (const k of Object.keys(ACTION_KINDS).filter(k => k !== 'gh-issue-create')) expect(t).toContain(k) // (the desk's own kind is not in a thread's guide)
  expect(kindsLine()).toContain('ado-pr-reply (optional status)')
  expect(t).toContain('lean_report with action {kind:')
  expect(t).toContain('Reads: lean_run ci, or a reader.')
  expect(ruleOf(t + ' [tried: curl]')).toBe('forge-write')
})

test('1.0.24: a thread\'s curl PATCH is refused with the action kinds (not the lean_run line); a plain refused command keeps its old text', () => {
  const c = orchConfig({})
  const cmd = `curl -X PATCH -H "Authorization: Bearer $T" -d '{"status":"fixed"}' "${ADO}"`
  const r = String(orchDecide(c, th, { tool: 'Bash', command: cmd }))
  expect(r).toContain('forge writes go through the desk')
  expect(r).toContain('ado-pr-thread-status')
  expect(r).toContain('[tried: curl]')
  expect(r).not.toContain('worker-haiku')
  expect(String(orchDecide(c, th, { tool: 'Bash', command: 'curl -sS https://example.org/x' }))).toContain('run tests and builds with lean_run')
})

test('1.0.24: a remembered item that describes a forge write by script is retired at load (memory section and handover), counted, the others pass on; doctor shows the row and fix retires them with a backup', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  const old = `to set a PR thread to fixed: curl -X PATCH -H "Authorization: Bearer $(az account get-access-token --query accessToken -o tsv)" -d '{"status":"fixed"}' https://dev.azure.com/org-a/proj-a/_apis/git/repositories/repo-a/pullRequests/<pr>/threads/<id>`
  const rows = [{ ts: 1, from: 't1', text: old }, { ts: 2, from: 't1', text: 'the build uses pnpm' }, { ts: 3, from: 't2', text: 'use gh pr comment 3 --body x for notes' }]
  h.files.set('/h/.lean-agent/memory/notes.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'app' }))
  // 1.0.31: what a thread is given is its standing orders (memory.ts); an order that describes a forge write by script is retired as it is shown
  const item = (id: string, text: string) => ({ id, scope: 'thread:t1', kind: 'rule', text, created: 1, source: 'thread', uses: 0, lastUsed: 0, status: 'active' })
  h.files.set('/h/.lean-agent/memory/items.json', JSON.stringify({ next: 4, items: [item('m1', old.slice(0, 190)), item('m2', 'the build uses pnpm'), item('m3', 'use gh pr comment 3 --body x for notes')] }))
  const before = retiredAtLoad()
  const sec = String(await memorySection(h.host, { kind: 'thread', id: 't1' } as any))
  expect(sec).toContain('the build uses pnpm')
  expect(sec).toContain('(retired: forge writes go through action kinds)')
  expect(sec).not.toContain('curl')
  expect(sec).not.toContain('Bearer')
  expect(retiredAtLoad() - before).toBe(2)
  expect(await staleMemoryCount(h.host)).toBe(2)
  const rowsOut = (await check(h.host, '/plug')).join('\n')
  expect(rowsOut).toContain('FIX  2 remembered items describe forge writes by script')
  const fixed = (await fix(h.host, '/plug')).lines.join('\n')
  expect(fixed).toContain('retired 2 that described a forge write by script')
  const store = h.files.get('/h/.lean-agent/memory/notes.jsonl')!
  expect(store).not.toContain('curl')
  expect(store).toContain('the build uses pnpm')
  expect(store.split('(retired: forge writes go through action kinds)').length).toBe(3)
  const bak = [...h.files.keys()].find(k => k.startsWith('/h/.lean-agent/memory/notes.jsonl.bak-'))
  expect(h.files.get(bak!)).toContain('curl -X PATCH') // the backup keeps the original
  expect(h.files.get('/h/.lean-agent/logs/doctor.jsonl')).toContain('memory-retired')
  expect(await staleMemoryCount(h.host)).toBe(0)
  expect((await check(h.host, '/plug')).join('\n')).toContain('ok   0 remembered items describe forge writes by script')
})

test('1.0.24: a subagent\'s forge write by curl / az rest / gh api / gh pr create gets the same text (1.0.34: gh pr create too)', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  const run = (command: string, agentType: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', agentType, agentId: 'a1' }, { tool: 'Bash', command })
  for (const agent of ['lean-agent:worker-haiku', 'lean-agent:reader-haiku']) {
    for (const cmd of [`curl -X PATCH -d '{}' ${ADO}`, 'gh api -X POST repos/o/r/issues/3/comments -f body=hi', 'gh pr comment 3 --body x']) {
      const r = String(await run(cmd, agent))
      expect([cmd, r.startsWith('forge writes go through the desk')]).toEqual([cmd, true])
      expect(ruleOf(r)).toBe('forge-write')
    }
  }
  const pc = String(await run('gh pr create --fill', 'lean-agent:worker-haiku'))
  expect(pc.startsWith('forge writes go through the desk')).toBe(true)
  expect(pc).toContain('[tried: gh pr]')
})

// ---- 1.0.34: the READ allow-list for az / gh (and curl): a table of commands, each allowed or refused ------------------------------------------------------
const WI = 'https://dev.azure.com/acme/p1/_apis/wit/workitems/4210?api-version=7.1'
const ALLOWED = [
  // az reads (the verb at the end of the command path is list / show / query / get / download / diff / list-* / show-*)
  'az repos pr list --status active',
  'az repos pr show --id 4321',
  'az repos pr work-item list --id 4321',
  'az repos pr reviewer list --id 4321',
  'az repos pr policy list --id 4321',
  'az repos show --repository acme-app',
  'az repos list --project p1',
  'az repos ref list --repository acme-app',
  'az boards work-item show --id 4210',
  'az boards work-item relation list-type',
  'az boards query --wiql "select [System.Id] from workitems where [System.Title] contains \'create\'"',
  'az devops project list --top 1',
  'az devops project show --project p1',
  'az devops configure --list',
  'az pipelines runs list --branch main',
  'az pipelines show --name ci',
  'az artifacts universal download --feed f --name n --version 1.0.0 --path /tmp/x',
  'az --output json repos pr show --id 4321',
  'az -o table repos pr list',
  'az --only-show-errors repos pr show --id 4321',
  'az repos --org https://dev.azure.com/acme pr list',
  'FOO=1 az repos pr show --id 4321',
  '/usr/bin/az repos pr list',
  'az repos pr list --query "[?status==\'active\'].{id:pullRequestId}" --output tsv',
  'az repos pr show --id 4321 | jq .title',
  'az devops invoke --area git --resource pullRequests --route-parameters pullRequestId=4321',
  `az rest --method get --url "${WI}"`,
  'az account show',
  'az repos pr create --help',
  // gh reads
  'gh pr view 4321 --json state',
  'gh pr list --head fix-1',
  'gh pr diff 4321',
  'gh pr checks 4321',
  'gh pr status',
  'gh issue view 12',
  'gh issue list --label bug',
  'gh release view v1.0.0',
  'gh release list',
  'gh repo view acme/app',
  'gh run list',
  'gh -R acme/app pr view 4321',
  'gh api repos/acme/app/pulls/4321',
  'gh api -X GET repos/acme/app/pulls/4321 -f per_page=5',
  'gh --version',
  'gh auth status',
  // curl reads, and a curl that is not aimed at a forge
  `curl -sS "${WI}"`,
  'curl -X POST https://example.org/hook -d x',
  // plain work that only mentions the words
  'git log --oneline',
  'npm test',
]
const REFUSED = [
  // az writes
  'az repos pr work-item add --id 4321 --work-items 4210',
  'az repos pr work-item remove --id 4321 --work-items 4210',
  'az boards work-item create --title t --type Task',
  'az boards work-item update --id 4210 --state Active',
  'az boards work-item delete --id 4210',
  'az boards work-item relation add --id 4210 --relation-type parent --target-id 4200',
  'az repos pr update --id 4321 --status abandoned',
  'az repos pr set-vote --id 4321 --vote approve',
  'az repos pr create --title x --source-branch b',
  'az repos pr reviewer add --id 4321 --reviewers a@acme.example',
  'az repos pr set-auto-complete --id 4321 --auto-complete true',
  'az repos create --name x',
  'az repos delete --id r1 --yes',
  'az repos import create --git-source-url https://example.org/x.git --repository r',
  'az devops project create --name x',
  'az devops invoke --area git --resource pullRequestThreads --http-method POST --in-file b.json',
  'az devops configure --defaults organization=https://dev.azure.com/acme',
  'az pipelines run --name ci',
  'az pipelines build queue --definition-name ci',
  'az pipelines variable-group create --name g --variables a=b',
  'az artifacts universal publish --feed f --name n --version 1.0.0 --path /tmp/x',
  `az rest --method patch --url "${WI}" --body '{}'`,
  `az rest --method delete --url "${WI}"`,
  // variants: chained, quoted, env-prefixed, flags in front or in the middle, a path to the program, a shell, a script text
  'FOO=1 az repos pr work-item add --id 4321 --work-items 4210',
  'az --output json repos pr work-item add --id 4321 --work-items 4210',
  'az --only-show-errors repos pr work-item add --id 4321 --work-items 4210',
  'az repos --org https://dev.azure.com/acme pr work-item add --id 4321 --work-items 4210',
  'az repos pr --debug work-item add --id 4321 --work-items 4210',
  'az "repos" pr work-item add --id 4321 --work-items 4210',
  '/usr/bin/az repos pr work-item add --id 4321 --work-items 4210',
  'echo start && az repos pr work-item add --id 4321 --work-items 4210',
  'az repos pr list; az repos pr work-item add --id 4321 --work-items 4210',
  'az repos pr show --id 4321 | az repos pr update --status abandoned',
  'az repos pr list --title add && az repos pr update --id 4321 --title list',
  'x=$(az repos pr work-item add --id 4321 --work-items 4210)',
  'bash -c "az repos pr work-item add --id 4321 --work-items 4210"',
  "sh -c 'az boards work-item update --id 4210 --state Done'",
  'python3 -c "import subprocess; subprocess.run([\'az\', \'repos\', \'pr\', \'work-item\', \'add\', \'--id\', \'4321\', \'--work-items\', \'4210\'], check=True)"',
  'python3 -c "import os; os.system(\'az repos pr work-item add --id 4321 --work-items 4210\')"',
  'node -e "require(\'child_process\').execSync(\'az repos pr update --id 4321 --status abandoned\')"',
  "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['gh', 'pr', 'merge', '4321'])\nEOF",
  // gh writes
  'gh api -X POST repos/acme/app/issues/3/comments -f body=hi',
  'gh api --method DELETE repos/acme/app/issues/comments/9',
  'gh api repos/acme/app/issues/3/comments -f body=hi',
  'gh -R acme/app api -X PATCH repos/acme/app/pulls/4321',
  'gh pr create --fill',
  'gh pr merge 4321 --squash',
  'gh pr comment 4321 --body hi',
  'gh pr review 4321 --approve',
  'gh pr edit 4321 --title x',
  'gh pr close 4321',
  'gh pr --repo acme/app merge 4321',
  'gh issue create --title x',
  'gh issue comment 12 --body x',
  'gh issue close 12',
  'gh issue edit 12 --title x',
  'gh release create v1.0.0',
  'gh release delete v1.0.0',
  'gh release upload v1.0.0 a.zip',
  'gh repo delete acme/app --yes',
  'gh repo create acme/new',
  'gh workflow run ci.yml',
  'FOO=1 gh pr merge 4321',
  'bash -c "gh pr merge 4321"',
  // curl / wget to a forge host with a write method or a body
  `curl -X PATCH -H "Authorization: Bearer $T" -d '{}' "${WI}"`,
  `curl -XPUT "${WI}"`,
  `curl --request DELETE "${WI}"`,
  `curl -sS --data '{}' "${WI}"`,
  `curl -X POST https://api.github.com/repos/acme/app/issues -d '{}'`,
  `wget --method=DELETE ${WI}`,
]

test('1.0.34: the read allow-list for az / gh / curl: every allowed command passes, every other forge command is a write (a table of commands)', () => {
  expect(ALLOWED.length + REFUSED.length).toBeGreaterThanOrEqual(40)
  for (const c of ALLOWED) expect([c, forgeCommandWrite(c)]).toEqual([c, null])
  for (const c of REFUSED) expect([c, forgeCommandWrite(c) !== null]).toEqual([c, true])
  expect(forgeCommandWrite('az repos pr work-item add --id 4321 --work-items 4210')).toBe('az repos') // (the label never holds an argument)
  expect(forgeCommandWrite('gh pr merge 4321')).toBe('gh pr')
  // prose, a brief and a memory item are judged by the text scan: az / gh anywhere in it (every refused command is one; the data lines above are prose here too)
  for (const c of REFUSED) expect([c, isForgeWrite(c)]).toEqual([c, true])
})

test('1.0.34: a command that only MENTIONS az / gh (a commit message, an echo, a grep pattern, a heredoc note) is data, not a write', () => {
  const data = [
    'git commit -m "docs: gh pr create and az repos pr work-item add"',
    "git commit -m 'run gh pr merge later'",
    'echo gh pr create',
    'echo "az repos pr create --title x"',
    'grep -rn "az repos pr create" docs',
    'rg "gh pr merge" /r/app',
    "cat <<'EOF' > notes.md\nuse gh pr merge 4321 and az repos pr work-item add\nEOF",
    'git log --grep="gh release create"',
    'printf "%s\\n" "az boards work-item update"',
    'ls src/az src/gh',
    'which gh az',
    'command -v az',
    'gh pr view 4321 --json title --jq \'.title | test("gh pr create")\'',
  ]
  for (const c of data) expect([c, forgeCommandWrite(c)]).toEqual([c, null])
  // ... and the same words as a command, or fed to a shell / an interpreter, are writes
  for (const c of ['gh pr create', 'echo ok; gh pr create', 'echo "gh pr merge 4321" | bash', 'bash <<EOF\nz=1\naz repos pr work-item add --id 4321 --work-items 4210\nEOF', 'xargs gh pr close', 'find . -exec gh pr merge 4321 ;', 'ssh h gh pr merge 4321', 'X=gh; $X pr merge 4321'])
    expect([c, forgeCommandWrite(c) !== null]).toEqual([c, true])
})

test('1.0.34: a thread\'s own az / gh / curl write is refused, with orchestration on or off, in a private project or not, and says the closest action kind', { timeoutMs: 20_000 }, async () => {
  for (const orchOn of [true, false]) {
    const h = fakeHost(null)
    h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
    if (!orchOn) h.files.set('/h/.lean-agent/config.json', JSON.stringify({ 'lean.orchestrate': false }))
    const run = (command: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app' }, { tool: 'Bash', command })
    for (const cmd of REFUSED) {
      const r = String(await run(cmd))
      expect([orchOn, cmd, r.startsWith('forge writes go through the desk')]).toEqual([orchOn, cmd, true])
      expect(ruleOf(r)).toBe('forge-write')
    }
    const link = String(await run('az repos pr work-item add --id 4321 --work-items 4210'))
    expect(link).toContain('(closest kind: ado-pr-workitem-link)')
    expect(link).toContain('[tried: az repos]')
    expect(String(await run('az repos pr update --id 4321 --status abandoned'))).toContain('(closest kind: ado-pr-update)')
    expect(String(await run('az repos pr set-vote --id 4321 --vote approve'))).toContain('(closest kind: ado-pr-vote)')
    // the reads and a thread's own plain work still run
    for (const cmd of ['az repos pr list --status active', 'az repos pr show --id 4321', 'gh pr view 4321', 'az repos pr work-item list --id 4321']) expect([cmd, await run(cmd)]).toEqual([cmd, null])
  }
})

test('1.0.34: a private project keeps its own refusal line for a thread\'s forge write (the push gate speaks first)', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ vault: { path: '/r/vault', private: true } }))
  const r = String(await decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/vault' }, { tool: 'Bash', command: 'az repos pr work-item add --id 4321 --work-items 4210' }))
  expect(r).toContain('private project')
})

test('1.0.34: a subagent runs no az write (workers, readers, the reviewer), and its reads still run', { timeoutMs: 20_000 }, async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ app: { path: '/r/app' } }))
  let n = 0
  const run = (command: string, agentType: string) => decide(h.host, { role: { kind: 'thread', id: 't1' }, cwd: '/r/app', agentType, agentId: `a${++n}` }, { tool: 'Bash', command })
  for (const agent of ['lean-agent:worker-haiku', 'lean-agent:worker-sonnet', 'lean-agent:reader-haiku', 'lean-agent:reviewer']) {
    for (const cmd of ['az repos pr work-item add --id 4321 --work-items 4210', 'az boards work-item update --id 4210 --state Done', 'FOO=1 az repos pr update --id 4321 --status abandoned', 'bash -c "gh pr merge 4321"']) {
      const r = String(await run(cmd, agent))
      expect([agent, cmd, r.startsWith('forge writes go through the desk')]).toEqual([agent, cmd, true])
    }
    for (const cmd of ['az repos pr show --id 4321', 'az repos pr work-item list --id 4321', 'gh pr view 4321']) expect([agent, cmd, await run(cmd, agent)]).toEqual([agent, cmd, null])
  }
})
