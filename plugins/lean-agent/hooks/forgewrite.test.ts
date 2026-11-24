import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { decide } from './guard'
import { ACTION_KINDS } from './deskactions'
import { forgeRefusal, isForgeWrite, kindsLine, retiredAtLoad, staleMemoryCount } from './forgewrite'
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
    'gh pr create --fill',
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
  const before = retiredAtLoad()
  const sec = String(await memorySection(h.host, { kind: 'thread', id: 't1' } as any))
  expect(sec).toContain('- the build uses pnpm')
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

test('1.0.24: a subagent\'s forge write by curl / az rest / gh api gets the same text; a gh pr create keeps the old subagent line', { timeoutMs: 20_000 }, async () => {
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
  expect(String(await run('gh pr create --fill', 'lean-agent:worker-haiku'))).toContain('a subagent makes no forge write')
})
