import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { applyFeedback } from './feedback'
import { EXPORT_CAP, exportFeedback, logRefusal, makeAnonymiser } from './feedbackexport'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

// sensitive-looking text built from pieces: this file holds no real-looking path, address or key
const USERS = `/${'Users'}`
const HOMES = `/${'home'}`
const EMAIL = `dev${'@'}example.org`
const AKIA = `AKIA${'ABCDEFGHIJKLMNOP'}`
const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`
const LONG = 'Zq'.repeat(20)
const T0 = Date.UTC(2026, 10, 18, 14, 7)
const EXP = '/h/.lean-agent/feedback-export'
const PRIVATE = '/h/.lean-agent/.private/projects.map.json'
const ROOT = '/p'

function setup(home = '/h') {
  const h = fakeHost(null, { home })
  h.clock.t = T0
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '' })
  h.files.set(`${home}/.lean-agent/projects.json`, JSON.stringify({ alpha: { path: '/r/alpha' }, beta: { path: '/r/beta' } }))
  return h
}
const lean = (h: any, p: string) => `${h.home}/.lean-agent/${p}`
const jl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const run = (h: any, o: { notes?: string; version?: string } = {}) => exportFeedback(h.host, ROOT, { version: '1.0.4', ...o })
const read = (h: any, r: { path?: string }) => h.files.get(r.path!)!

// ---- the anonymiser, rule by rule -------------------------------------------------------------------------------------------
test('the home dir and any user\'s home folder (macOS or Linux style) become ~', async () => {
  const h = setup()
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('see /h/.lean-agent/x and /h')).toBe('see ~/.lean-agent/x and ~')
  expect(a.anonymise(`${USERS}/someone/code/a.ts then ${HOMES}/other/b and ${HOMES}/other`)).toBe('~/code/a.ts then ~/b and ~')
  expect(a.anonymise(`${HOMES}/other/b/c`)).toBe('~/b/c')
  expect(a.anonymise('/hx/not-home')).toBe('/hx/not-home')
})

test('emails, URLs (only the lean-agent repo stays), azure organisations', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise(`mail ${EMAIL}.`)).toBe('mail <email>.')
  expect(a.anonymise('see https://github.com/mcmadsen/lean-agent/issues/12 and https://github.com/someone/else and http://x.example/a?b=1.')).toBe('see https://github.com/mcmadsen/lean-agent/issues/12 and <url> and <url>.')
  expect(a.anonymise('dev.azure.com/acme/widgets/_git/repo')).toBe('dev.azure.com/<org>/<org>/_git/repo')
  expect(a.anonymise('https://dev.azure.com/acme/widgets/_git/repo')).toBe('<url>')
  expect(a.anonymise('acme.visualstudio.com/widgets')).toBe('<org>.visualstudio.com/widgets')
})

test('project names become project-A, B ... through a stable local map that is never exported; a name inside a longer word is left', async () => {
  const h = setup()
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('alpha failed, beta ok, alpha-api and alpha/src, Alpha again, alphabet')).toBe('project-A failed, project-B ok, project-A-api and project-A/src, project-A again, alphabet')
  expect(JSON.parse(h.files.get(PRIVATE)!)).toEqual({ alpha: 'project-A', beta: 'project-B' })
  expect([...h.files.keys()].some(k => k.startsWith(`${EXP}/`))).toBe(false) // the real names are not next to the files a user sends
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ gamma: {}, beta: {}, alpha: {} })) // another order, one more
  const b = await makeAnonymiser(h.host)
  expect(b.anonymise('gamma alpha beta')).toBe('project-C project-A project-B') // the labels stay with their names
  h.files.set('/h/.lean-agent/threads/t3/thread.json', JSON.stringify({ id: 't3', project: 'delta' })) // a thread's project counts too
  expect((await makeAnonymiser(h.host)).anonymise('delta t3')).toBe('project-D t3')
})

test('review round: env-style credentials, scp remotes, IPs and hosts, a registered project\'s folder, case, short and numeric names', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ alpha: { path: '/r/alpha' }, ledgerx: { path: '/work/ledger-repo' }, '123': { path: '/w/n' }, delta: {}, ab: {} }))
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('DB_PASSWORD=hunter22hunter and MY_API_KEY: abcdefgh12345678 and {"token": "abcdefgh12345678"}')).toBe('DB_PASSWORD=<secret> and MY_API_KEY: <secret> and {"token": "<secret>"}')
  expect(a.missed('DB_PASSWORD=hunter22hunter')).toContain('token or key') // the check does not depend on the rule
  expect(a.anonymise('remote git@github.com:acme/repo.git and also dev@host.example.org:/srv/x')).toBe('remote <url> and also <url>')
  expect(a.anonymise('box 10.1.2.3, build.internal.corp, and https://github.com/mcmadsen/lean-agent plus github.com')).toBe('box <ip>, <host>, and https://github.com/mcmadsen/lean-agent plus github.com')
  expect(a.missed('box 10.1.2.3')).toContain('IP address')
  expect(a.missed('build.internal.corp')).toContain('host name')
  // labels follow the order the names were first seen (a JSON object lists "123" first): 123 = A, alpha = B, ledgerx = C, delta = D
  expect(a.anonymise('repo at /work/ledger-repo, dir ledger-repo, name ledgerx')).toBe('repo at project-C, dir project-C, name project-C')
  expect(a.anonymise('id 123 and delta, ab stays')).toBe('id project-A and project-D, ab stays') // a numeric name is fine; a 2-letter name is too short to mask
  expect(a.anonymise('Alpha ALPHA')).toBe('project-B project-B')
  const u = await makeAnonymiser(setup('/q/Zeldaquux').host)
  expect(u.anonymise('zeldaquux ZELDAQUUX')).toBe('<user> <user>')
  // a short, common user name is not a leak by itself: "tests" does not make the export refuse
  const t = await makeAnonymiser(setup('/q/test').host)
  expect(t.anonymise('the tests ran')).toBe('the tests ran')
  expect(t.missed('the tests ran')).toEqual([])
  const s = await makeAnonymiser(setup('/q/kimbo').host) // 5 letters, not generic: a word is a leak, a longer word is not
  expect(s.missed('kimbo is here')).toContain('user name')
  expect(s.missed('kimbos and kimboard')).toEqual([])
})

test('second review round: github paths, file names that look like hosts, build numbers, placeholder characters, common folder names', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ alpha: { path: '/work/repo' }, gamma: { path: '/work/lean-agent' }, kappa: { path: '/work/kappa-tools' } }))
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('see github.com/acme/private-repo and github.com/mcmadsen/lean-agent and https://github.com/mcmadsen/lean-agent/issues/9')).toBe('see github.com/<org>/<repo> and github.com/mcmadsen/lean-agent and https://github.com/mcmadsen/lean-agent/issues/9')
  expect(a.anonymise(a.anonymise('github.com/acme/x'))).toBe('github.com/<org>/<repo>') // twice: the same
  expect(a.missed('github.com/acme/x')).toContain('code-host path')
  expect(a.missed('github.com/mcmadsen/lean-agent')).toEqual([])
  expect(a.anonymise('edit settings.local.json and .claude/settings.json; build 10.0.19045.3693 on 2.1.327; srv.example.dev up')).toBe('edit settings.local.json and .claude/settings.json; build 10.0.19045.3693 on 2.1.327; <host> up')
  expect(a.anonymise('ip 192.168.1.20 and 999.1.1.1')).toBe('ip <ip> and 999.1.1.1')
  expect(a.anonymise('a\u0001b\u0002c alpha')).toBe('abc project-A') // the placeholder characters cannot come from the text
  // a common folder name is not masked as a project (the project itself still is); "lean-agent" is never a project name here
  expect(a.anonymise('in /work/repo and repo and kappa-tools and lean-agent running')).toBe('in project-A and repo and project-C and lean-agent running')
  const u = await makeAnonymiser(setup('/q/systemx').host)
  expect(u.anonymise('systemx and filesystemx')).toBe('<user> and file<user>')
})

test('thread ids stay; hashes, ticket and PR numbers, tokens and keys are replaced', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise('t12 and t3 reported')).toBe('t12 and t3 reported')
  expect(a.anonymise('commit abc1234def and 1234567 and 20261118')).toBe('commit <sha> and 1234567 and 20261118') // digits alone are not a hash
  expect(a.anonymise('PR #42, pull request 7, ticket 99, issue#5, #123, ABC-123, UTF-8, SHA-256')).toBe('PR #<id>, pull request <id>, ticket <id>, issue#<id>, #<id>, <id>, UTF-8, SHA-256')
  expect(a.anonymise(`key ${AKIA} and ${GH} and ${LONG}`)).toBe('key <secret> and <secret> and <secret>')
  expect(a.anonymise('token = "abcdefgh12345678" and password: hunter2hunter2 and Authorization: Bearer abcdef1234567890xyz')).toBe('token = "<secret>" and password: <secret> and Authorization: <secret>')
  expect(a.anonymise('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).toBe('<secret>')
})

test('ids after work item, PR, thread, --id and in quoted commands are masked; counts with units and thread tN stay', async () => {
  const a = await makeAnonymiser(setup().host)
  const m = (s: string) => a.anonymise(s)
  expect(m('Work item 4821 and work-item 4821 and work items 12 and Work Item #77')).toBe('Work item <id> and work-item <id> and work items <id> and Work Item #<id>')
  expect(m('blocked: work-item update --id 4821 --state Done')).toBe('blocked: work-item update --id <id> --state Done')
  expect(m('az boards work-item update --id=4821')).toBe('az boards work-item update --id=<id>')
  expect(m('reply on PR 31337, pullrequest 31337, pull request #31337, PR!31337')).toBe('reply on PR <id>, pullrequest <id>, pull request #<id>, PR!<id>')
  expect(m('az repos pr show --id 31337')).toBe('az repos pr show --id <id>')
  expect(m('comment thread 90210 and thread 5 resolved, issue 8812, ticket 8812')).toBe('comment thread <id> and thread <id> resolved, issue <id>, ticket <id>')
  expect(m('{"id": 60606, "pullRequestId": "60606", "thread_id":60606, "number": 60606}')).toBe('{"id": <id>, "pullRequestId": "<id>", "thread_id":<id>, "number": <id>}')
  // a bare 4+ digit number inside a quoted or backticked command
  expect(m('ran `gh pr comment 40404 --body x` and "az boards work-item show 40404" and \'curl x/40404/y\'')).toBe('ran `gh pr comment <id> --body x` and "az boards work-item show <id>" and \'curl x/<id>/y\'')
  // a count followed by its unit, thread tN, a number outside a command and short numbers stay
  expect(m('ran `rg x` saved 12000 chars, 5000 tokens, 3000 ms, 1500 lines, 4000 rows, 2000 files, 1200 tests, 90 %, 4500ms, 7k')).toBe('ran `rg x` saved 12000 chars, 5000 tokens, 3000 ms, 1500 lines, 4000 rows, 2000 files, 1200 tests, 90 %, 4500ms, 7k')
  expect(m('"saved 12000 chars in 40404 results" and "cmd 123"')).toBe('"saved 12000 chars in <id> results" and "cmd 123"')
  expect(m('--work-item-id 4821 --thread-id 9 --pull-request-id 12 PRs 12, 13 and issues 8 and 9, pull-request 7')).toBe('--work-item-id <id> --thread-id <id> --pull-request-id <id> PRs <id> and issues <id>, pull-request <id>')
  expect(m('{"ID": 5, "pull_request_id": 5, "work_item_id":5} Id=5')).toBe('{"ID": <id>, "pull_request_id": <id>, "work_item_id":<id>} Id=<id>')
  expect(m('valid: 5 and grid 12')).toBe('valid: 5 and grid 12')
  expect(m('t4 and t12 reported; waited 40404 seconds')).toBe('t4 and t12 reported; waited 40404 seconds')
  expect(m(m('work-item update --id 4821 `gh pr view 40404`'))).toBe('work-item update --id <id> `gh pr view <id>`') // twice: unchanged
  expect(a.missed('work item 4821')).toContain('work item, PR or thread id')
  expect(a.missed(m('work item 4821, PR 12, thread 9'))).toEqual([])
})

test('the blocked-thread lines of the export carry no work item, PR or comment thread id', async () => {
  const h = setup()
  h.files.set(lean(h, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'refused: work-item update --id 4821 --state Done (Work item 4821)' }, { ts: T0 - 900, from: 't2', kind: 'report', state: 'blocked', text: 'cannot reply on thread 90210 of PR 31337' }]))
  const r = await run(h)
  expect(r.ok).toBe(true)
  const t = read(h, r) as string
  expect(t).toContain('t1: refused: work-item update --id <id> --state Done (Work item <id>)')
  expect(t).toContain('t2: cannot reply on thread <id> of PR <id>')
  for (const n of ['4821', '90210', '31337']) expect(t).not.toContain(n)
})

test('the OS user name becomes <user> (as a word); running the anonymiser twice changes nothing', async () => {
  const h = setup('/q/zeldaquux')
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('zeldaquux-laptop and /q/zeldaquux/code')).toBe('<user>-laptop and ~/code')
  const all = `${USERS}/x/y alpha ${EMAIL} https://example.com PR #4 abc1234def ${AKIA} /q/zeldaquux zeldaquux t1`
  const once = a.anonymise(all)
  expect(a.anonymise(once)).toBe(once)
  const g = await makeAnonymiser(setup('/home/root').host) // a generic user name is not replaced as a word
  expect(g.anonymise('root cause')).toBe('root cause')
  const p = await makeAnonymiser((() => { const x = setup(); x.files.set('/h/.lean-agent/projects.json', JSON.stringify({ project: {} })); return x })().host)
  const once2 = p.anonymise('the project failed')
  expect(p.anonymise(once2)).toBe(once2) // a project called "project" does not eat its own label
})

// ---- branch names, first names, the OS build ---------------------------------------------------------------------------------
const withRegistry = (h: any) => h.files.set(lean(h, 'worktrees.json'), JSON.stringify({ 'alpha/feature/alpha-beta': { path: '/w/x', branch: 'feature/alpha-beta', thread: 't1' }, 'beta/infra/quebec-romeo~2': { path: '/w/y', branch: 'infra/quebec-romeo', thread: 't2' }, 'alpha/main': { path: '/w/z', branch: 'main' } }))

test('branch names after the word branch keep a type prefix and mask the rest; plain words after it stay', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise('Branch infra/zulu-yankee-xray is blocked')).toBe('Branch infra/<branch> is blocked')
  expect(a.anonymise('on branch `bugfix/zulu-1` now')).toBe('on branch `bugfix/<branch>` now')
  expect(a.anonymise('branch: zulu-yankee, and branch "feature/a.b/c"')).toBe('branch: <branch>, and branch "feature/<branch>"')
  expect(a.anonymise('on branch alice/zulu-fix')).toBe('on branch <branch>') // a first segment that is no branch type may be a person
  expect(a.anonymise('branches release/zulu9 and hotfix_q2')).toBe('branches release/<branch> and hotfix_q2') // only the name right after the word
  expect(a.anonymise('branch hotfix_q2')).toBe('branch <branch>')
  for (const same of ['the branch is ready', 'branch main', 'on branch master and branch develop', 'branch protection rules', 'branch names stay', 'a branch', 'branch-protection', 'branch Infra']) expect([same, a.anonymise(same)]).toEqual([same, same])
  const once = a.anonymise('Branch infra/zulu-yankee-xray, branch bugfix/q-1')
  expect(a.anonymise(once)).toBe(once)
  // a parenthesis before the name, and a comma list
  expect(a.anonymise('(branch (feature/zulu-1) was dropped)')).toBe('(branch (feature/<branch>) was dropped)')
  expect(a.anonymise('branches: infra/a-b, bugfix/c-d, main and e-f')).toBe('branches: infra/<branch>, bugfix/<branch>, main and e-f')
  expect(a.missed('branches: infra/a-b, c-d')).toContain('branch name')
  expect(a.missed('branches: infra/<branch>, <branch>')).toEqual([])
})

test('worktree folders and registry keys: the branch is masked, the type prefix and the project label stay', async () => {
  const h = setup()
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/feature-zulu-yankee is dirty')).toBe('~/.lean-agent/worktrees/zebra/feature-<branch> is dirty')
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/feature/zulu')).toBe('~/.lean-agent/worktrees/zebra/feature/<branch>')
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/zulu-yankee')).toBe('~/.lean-agent/worktrees/zebra/<branch>')
  expect(a.anonymise('/h/.lean-agent/worktrees/alpha/infra-zulu')).toBe('~/.lean-agent/worktrees/project-A/infra-<branch>')
  // a registry key of a project (its label stays) after the project rule ran
  expect(a.anonymise('worktrees.json has alpha/feature/zulu-yankee for t1')).toBe('worktrees.json has project-A/feature/<branch> for t1')
  expect(a.anonymise('the folder worktrees/ and src/main.ts')).toBe('the folder worktrees/ and src/main.ts')
  // what is inside the worktree stays: only the branch folder goes
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/fix-x/src/a.ts:12')).toBe('~/.lean-agent/worktrees/zebra/fix-<branch>/src/a.ts:12')
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/zulu-x/src/a.ts:12')).toBe('~/.lean-agent/worktrees/zebra/<branch>/src/a.ts:12')
  expect(a.anonymise('/h/.lean-agent/worktrees/zebra/feature/zulu/src/a.ts')).toBe('~/.lean-agent/worktrees/zebra/feature/<branch>/src/a.ts')
  const once = a.anonymise('/h/.lean-agent/worktrees/zebra/feature-zulu and alpha/bugfix/q-1')
  expect(a.anonymise(once)).toBe(once)
})

test('the branches the worktree registry knows are masked everywhere, even inside a name that holds a project name', async () => {
  const h = setup()
  withRegistry(h)
  const a = await makeAnonymiser(h.host)
  // feature/alpha-beta holds the project name "alpha": the branch is masked first, so it is the branch rule that speaks
  expect(a.anonymise('registry key alpha/feature/alpha-beta and beta/infra/quebec-romeo~2')).toBe('registry key project-A/feature/<branch> and project-B/infra/<branch>~2')
  expect(a.anonymise('pushed feature/alpha-beta, then infra/quebec-romeo.')).toBe('pushed feature/<branch>, then infra/<branch>.')
  expect(a.anonymise('/h/.lean-agent/worktrees/alpha/feature-alpha-beta')).toBe('~/.lean-agent/worktrees/project-A/feature-<branch>')
  expect(a.anonymise('quebec-romeo2 is another name and xinfra/quebec-romeo too')).toContain('quebec-romeo2') // a longer name is not the branch
  expect(a.anonymise('the main branch of alpha')).toBe('the main branch of project-A') // a default branch is no secret
  const once = a.anonymise('alpha/feature/alpha-beta infra/quebec-romeo')
  expect(a.anonymise(once)).toBe(once)
  // the final check sees a surviving one, and a masked one passes
  expect(a.missed('x feature/alpha-beta')).toContain('branch name')
  expect(a.missed('Branch infra/zulu-yankee')).toContain('branch name')
  expect(a.missed('/h/x/worktrees/zebra/zulu')).toContain('branch name')
  expect(a.missed('Branch infra/<branch> in project-A/feature/<branch> at ~/worktrees/zebra/feature-<branch>')).toEqual([])
  expect(a.missed('the branch is ready, branch main')).toEqual([])
})

test('the export refuses when a branch name survives; the blocked-thread lines keep the type prefix only', async () => {
  const h = setup()
  withRegistry(h)
  h.files.set(lean(h, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'Branch infra/quebec-romeo: did not post the reply to Zed (asked by Zed)' }]))
  const r = await run(h)
  expect(r.ok).toBe(true)
  const t = read(h, r) as string
  expect(t).toContain('t1: Branch infra/<branch>: did not post the reply to <name> (asked by <name>)')
  expect(t).not.toMatch(/quebec|Zed/)
  // a rule that regressed (the branch is no longer masked): the final check refuses and names the kind, never the branch
  const h2 = setup()
  withRegistry(h2)
  h2.files.set(lean(h2, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'Branch infra/quebec-romeo is blocked' }]))
  const faulty = (real: any) => ({ anonymise: (t: string) => real.anonymise(t).replace(/infra\/<branch>/g, 'infra/quebec-romeo'), name: real.name, missed: real.missed })
  const bad = await exportFeedback(h2.host, ROOT, { version: '1.0.4' }, { wrap: faulty })
  expect(['registry branch', bad.ok, bad.text]).toEqual(['registry branch', false, expect.stringContaining('branch name')])
  expect(bad.text).toContain('not written')
  expect(bad.text).not.toContain('quebec')
  expect(['files', [...h2.files.keys()].filter(k => k.includes('feedback-export/2'))]).toEqual(['files', []])
  // a branch NOT in the registry, written after the word branch, is caught by the generic rule and by the check
  const h3 = setup()
  h3.files.set(lean(h3, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'Branch infra/xray-whiskey is blocked' }]))
  const ok3 = await run(h3)
  expect(read(h3, ok3)).toContain('t1: Branch infra/<branch> is blocked')
  const h4 = setup() // (a fresh host: the first export above already took that report)
  h4.files.set(lean(h4, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'Branch infra/xray-whiskey is blocked' }]))
  const bad3 = await exportFeedback(h4.host, ROOT, { version: '1.0.4' }, { wrap: (real: any) => ({ anonymise: (t: string) => real.anonymise(t).replace(/infra\/<branch>/g, 'infra/xray-whiskey'), name: real.name, missed: real.missed }) })
  expect(['generic branch', bad3.ok, bad3.text]).toEqual(['generic branch', false, expect.stringContaining('branch name')])
})

test('a first name after "reply to", "asked by", "from" or "to" is masked unless it is a product or common word', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise('did not post the reply to Zed')).toBe('did not post the reply to <name>')
  expect(a.anonymise('Reply to Zed and replied to Yara')).toBe('Reply to <name> and replied to <name>')
  expect(a.anonymise('asked by Zed, a note from Yara, sent to Xena.')).toBe('asked by <name>, a note from <name>, sent to <name>.')
  expect(a.anonymise("from Zed's side")).toBe("from <name>'s side")
  for (const same of ['reply to Claude', 'switched from Sonnet to Opus', 'from GitHub to Azure DevOps', 'went from Monday to March', 'go to Settings', 'switched to Bash and from Read to Agent', 'moved from Grep to Task', 'back to The start', 'asked by Anthropic', 'from the desk', 'to zed', 'from a colleague', 'REPLY TO ZED', 'reply to Ab', 'to Zed-Marie']) expect([same, a.anonymise(same)]).toEqual([same, same])
  const once = a.anonymise('the reply to Zed, asked by Yara')
  expect(a.anonymise(once)).toBe(once)
  // the check flags the two person-specific phrases only (from / to are too common to judge)
  expect(a.missed('did not post the reply to Zed')).toContain('person name')
  expect(a.missed('asked by Zed')).toContain('person name')
  expect(a.missed('reply to Claude, asked by Anthropic, reply to <name>')).toEqual([])
  expect(a.missed('a note from Zed')).toEqual([])
})

test('the OS build goes, the OS family stays', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise('Darwin 25.6.0 arm64')).toBe('Darwin arm64')
  expect(a.anonymise('Linux 9.9.9-test x86_64 and Windows_NT 10.0.19045 and macOS 15.1')).toBe('Linux x86_64 and Windows_NT and macOS')
  expect(a.anonymise('Linux 6.1.2.3 beats it')).toBe('Linux beats it') // not read as an address
  for (const same of ['Darwin', 'on Linux', 'Windows is slow', 'OS family: macOS (Darwin)']) expect([same, a.anonymise(same)]).toEqual([same, same])
  expect(a.missed('Darwin 25.6.0')).toContain('OS build')
  expect(a.missed('Darwin arm64')).toEqual([])
  const h = setup()
  h.files.set(lean(h, 'desk/inbox.jsonl'), jl([{ ts: T0 - 1000, from: 't1', kind: 'report', state: 'blocked', text: 'uname says Darwin 25.6.0 and the build fails' }]))
  const r = await run(h)
  expect(read(h, r)).toContain('t1: uname says Darwin and the build fails')
  expect(read(h, r)).not.toContain('25.6.0')
})

// ---- the survival check -----------------------------------------------------------------------------------------------------
test('a private string the rules cannot catch makes the export refuse: nothing is written, no state changes, the rule is named, the string is not echoed', async () => {
  const h = setup('/q/zeldaquux')
  h.files.set('/q/zeldaquux/.lean-agent/feedback-drafts/2026-11-18-bug.md', '# bug\nthe laptop is called zeldaquuxbox and it hangs\n')
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('zeldaquuxbox')).toBe('<user>box') // a long name is masked inside longer words too
  expect(a.missed('zeldaquuxbox')).toEqual(['user name']) // and the check would still flag it
  expect(a.missed('fine ~/code <user> project-A <url> <email>')).toEqual([])
  // a rule that regressed (the user name is no longer masked): the final check refuses, whatever the rules did
  const faulty = (real: any) => ({ anonymise: (t: string) => real.anonymise(t).replace(/<user>/g, 'zeldaquux'), name: real.name, missed: real.missed })
  const r = await exportFeedback(h.host, ROOT, { version: '1.0.4' }, { wrap: faulty })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not written')
  expect(r.text).toContain('Nothing was posted')
  expect(r.text).toContain('user name')
  expect(r.text).not.toContain('zeldaquuxbox')
  expect([...h.files.keys()].some(k => k.includes('feedback-export/2'))).toBe(false)
  expect(h.files.has('/q/zeldaquux/.lean-agent/feedback-export/state.json')).toBe(false)
  expect(h.writes.some(w => w.endsWith('.md') && w.includes('feedback-export'))).toBe(false)
})

test('the check names each kind of miss', async () => {
  const h = setup('/q/zeldaquux')
  const a = await makeAnonymiser(h.host)
  expect(a.missed('/q/zeldaquux/code')).toContain('home directory')
  expect(a.missed(`${USERS}/x/y`)).toContain('/Users or /home path')
  expect(a.missed(`x ${EMAIL}`)).toContain('email address')
  expect(a.missed(`x ${AKIA}`)).toContain('token or key')
  expect(a.missed('https://example.com/a')).toContain('URL')
  expect(a.missed('dev.azure.com/acme/x')).toContain('azure organisation')
  expect(a.missed('the alpha repo')).toContain('project name')
})

// ---- the export -------------------------------------------------------------------------------------------------------------
test('the file has the environment, doctor problems and notes first; the path is returned; nothing is posted', async () => {
  const h = setup()
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.5' })) // installed newer than running
  const r = await run(h, { notes: `the desk froze in alpha, mail ${EMAIL}` })
  expect(r.ok).toBe(true)
  expect(r.path).toBe(`${EXP}/2026-11-18-1407.md`)
  expect(r.text).toContain(r.path!)
  expect(r.text).toContain('Nothing was posted')
  const t = read(h, r)
  expect(t.indexOf('## Notes')).toBeGreaterThan(-1)
  expect(t.indexOf('## Notes')).toBeLessThan(t.indexOf('## Environment'))
  expect(t).toContain('the desk froze in project-A, mail <email>')
  expect(t).toContain('lean-agent running: 1.0.4; installed: 1.0.5 (SKEW')
  expect(t).toContain('Claude Code: 2.1.327 (Claude Code)')
  expect(t).toContain('OS family: macOS (Darwin)')
  expect(t).toContain('## Doctor check: problems')
  expect(t).toMatch(/- desk folder/)
  expect(t).not.toContain('alpha')
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  expect(read(h, await run(h))).toContain('installed: 1.0.4')
  expect(read(h, await run(h))).not.toContain('SKEW')
})

test('LEAN-FEEDBACK since the last export: counts by status, texts grouped and de-duplicated with counts, most repeated first', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback.jsonl'), jl([
    { ts: 1, status: 'done' }, { ts: 2, status: 'done' }, { ts: 3, status: 'done', refused: 'git push was refused for t4' }, { ts: 4, status: 'partial', unverified: 'did not run the tests', unreached: 'the staging box' },
    { ts: 5, status: 'done', refused: 'Git push was  refused for t4' }, { ts: 6, kind: 'core-candidate', script: 'x' }, { ts: 7, status: 'failed', missing: true },
  ]))
  h.files.set(lean(h, 'gaps.jsonl'), jl([{ ts: 8, text: 'build flags for src/a.ts' }, { ts: 9, text: 'Build flags for src/a.ts ' }, { ts: 10, text: 'build  flags for SRC/A.ts' }, { ts: 11, text: 'which db does alpha use' }]))
  h.files.set(lean(h, 'alpha/gaps.jsonl'), jl([{ ts: 12, text: 'which db does alpha use' }]))
  const t = read(h, await run(h))
  expect(t).toContain('Reports: 6 (done 4, partial 1, failed 1)') // the core candidate row is not a report
  expect(t).toContain('done 4')
  expect(t).toContain('partial 1')
  expect(t).toContain('failed 1')
  expect(t).toContain('### missing')
  expect(t.indexOf('- (x3) build flags for src/a.ts')).toBeGreaterThan(-1)
  expect(t.indexOf('- (x3) build flags for src/a.ts')).toBeLessThan(t.indexOf('- (x2) which db does project-A use')) // most repeated first
  expect(t).toContain('### refused')
  expect(t).toContain('- (x2) git push was refused for t4')
  expect(t).toContain('### unverified\n\n- did not run the tests')
  expect(t).toContain('### unreached\n\n- the staging box')
})

test('the rows feedback.ts really writes (counts, claims, folders, worker refusals) reach the export; one refusal is not counted twice', async () => {
  const h = setup()
  const fb = { status: 'partial', used: [], unneeded: [], missing: '', remember: [], refused: [{ command: 'rg -n foo src', text: 'lean-agent: rg is not allowed here' }], unverified: ['the cache is rebuilt nightly'], unreached: ['vendor/'] }
  await applyFeedback(h.host, { thread: 't1', agent: 'lean-agent:explorer', version: '1.0.4' }, fb as any)
  await applyFeedback(h.host, { thread: 't1', agent: 'lean-agent:explorer', version: '1.0.4' }, { ...fb, refused: [], unverified: [], unreached: [] } as any)
  await logRefusal(h.host, { text: 'lean-agent: rg is not allowed here', agent: 'lean-agent:explorer', tool: 'Bash', thread: 't1', version: '1.0.4' }) // what the guard saw of the same call
  h.files.set(lean(h, 'feedback.jsonl'), h.files.get(lean(h, 'feedback.jsonl'))! + JSON.stringify({ ts: T0 + 5, kind: 'core-candidate', note: 'x', script: 's' }) + '\n') // no status: not a report
  const rows = await readJsonl<any>(h.host, lean(h, 'refusals.jsonl'))
  expect(rows.map(r => r.src)).toEqual(['worker', 'guard'])
  expect(rows[0]).toMatchObject({ command: 'rg -n foo src', agent: 'explorer', version: '1.0.4', thread: 't1' })
  const t = read(h, await run(h))
  expect(t).toContain('Reports: 2 (partial 2)')
  expect(t).toContain('### refused\n\n- rg -n foo src -> lean-agent: rg is not allowed here')
  expect(t).toContain('### unverified\n\n- the cache is rebuilt nightly')
  expect(t).toContain('### unreached\n\n- vendor/')
  expect(t).toContain('- (x1) [explorer] guard: lean-agent: rg is not allowed here (1.0.4)') // the guard section: one, the worker's report is not a second refusal
})

test('guard refusals: grouped by text and agent type with counts', async () => {
  const h = setup()
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:reader-haiku', tool: 'Edit', thread: 't1' })
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:reader-haiku', tool: 'Edit' })
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:worker-sonnet', tool: 'Edit' })
  await logRefusal(h.host, { text: 'strict mode: route this to a thread' })
  const rows = await readJsonl<any>(h.host, lean(h, 'refusals.jsonl')) // the one file (feedback.ts appendRefusal)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ src: 'guard', text: 'lean-agent: reader-haiku is read-only', agent: 'reader-haiku', tool: 'Edit', thread: 't1' })
  expect(h.files.has(lean(h, 'logs/refusals.jsonl'))).toBe(false)
  const t = read(h, await run(h))
  expect(t).toContain('## Guard refusals since the last export')
  expect(t).toContain('- (x2) [reader-haiku] guard: lean-agent: reader-haiku is read-only')
  expect(t).toContain('- (x1) [worker-sonnet] guard: lean-agent: reader-haiku is read-only')
  expect(t).toContain('- (x1) [session] guard: strict mode: route this to a thread')
})

test('drafts, core candidates and blocked reports go in once; the next export has only what is new', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-a.md'), '# draft a\nsteps in alpha\n')
  h.files.set(lean(h, 'scripts/candidates/ledger-total/meta.json'), JSON.stringify({ name: 'ledger-total', status: 'candidate', core: true, purpose: 'Total the cost ledger', run: 'python3 {script} <ledger.jsonl>', inputs: ['ledger.jsonl'], outputs: ['stdout'], sha256: 'x', file: 'a.py' }))
  h.files.set(lean(h, 'scripts/candidates/plain/meta.json'), JSON.stringify({ name: 'plain', status: 'candidate', purpose: 'x', run: 'python3 {script}', inputs: ['x'], outputs: ['stdout'], sha256: 'y', file: 'a.py' }))
  h.files.set(lean(h, 'desk/inbox.jsonl'), jl([
    { ts: 1, from: 't1', kind: 'report', state: 'blocked', text: 'cannot reach the repo\nsecond line' }, { ts: 2, from: 't2', kind: 'report', state: 'working', text: 'fine' },
    { ts: 3, from: 't3', kind: 'report', state: 'blocked', text: 'needs a decision about alpha' }, { ts: 4, from: 't4', kind: 'ask', state: 'blocked', text: 'a question' },
  ]))
  const first = read(h, await run(h))
  expect(first).toContain('### draft a\n\nsteps in project-A') // titled by its first heading, which is not said twice
  expect(first).not.toContain('# draft a\nsteps')
  expect(first).toContain('## Script candidates for lean-agent core')
  expect(first).toContain('ledger-total: Total the cost ledger')
  expect(first).not.toContain('- plain:')
  expect(first).toContain('- t3: needs a decision about project-A')
  expect(first).toContain('- t1: cannot reach the repo\n')
  expect(first).not.toContain('second line')
  expect(first).not.toContain('t2: fine')
  expect(first).not.toContain('a question')
  expect(JSON.parse(h.files.get(`${EXP}/state.json`)!)).toEqual({ at: T0, drafts: ['2026-11-18-a.md'], core: ['ledger-total'] })
  h.clock.t = T0 + 30_000 // the same minute: the file gets a suffix, nothing is overwritten
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-b.md'), '# draft b\n')
  h.files.set(lean(h, 'desk/inbox.jsonl'), h.files.get(lean(h, 'desk/inbox.jsonl'))! + jl([{ ts: T0 + 10_000, from: 't9', kind: 'report', state: 'blocked', text: 'new block' }]))
  const second = await run(h)
  expect(second.path).toBe(`${EXP}/2026-11-18-1407-2.md`)
  const t = read(h, second)
  expect(t).toContain('### draft b')
  expect(t).not.toContain('draft a')
  expect(t).toContain('## Script candidates for lean-agent core\n\nnone')
  expect(t).toContain('- t9: new block')
  expect(t).not.toContain('t1: cannot reach')
  expect(h.files.get(`${EXP}/2026-11-18-1407.md`)).toBe(first) // the first file is untouched
  expect(JSON.parse(h.files.get(`${EXP}/state.json`)!).drafts).toEqual(['2026-11-18-a.md', '2026-11-18-b.md'])
  // a third export with nothing new still works and says what it covers
  h.clock.t = T0 + 120_000
  const third = read(h, await run(h))
  expect(third).toContain('since the last export')
  expect(third).toContain('## Drafts not exported before\n\nnone')
  expect(third).not.toContain('draft b')
})

test('a size cap of 40 KB: the oldest and least repeated items are summarised, long drafts are cut', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-long.md'), `# long\n${'a long draft line about nothing in particular\n'.repeat(5000)}`)
  h.files.set(lean(h, 'gaps.jsonl'), jl(Array.from({ length: 800 }, (_, i) => ({ ts: 100 + i, text: `gap number ${i} with a fairly long description of the missing context ${'x'.repeat(60)}` }))))
  h.files.set(lean(h, 'gaps.jsonl'), h.files.get(lean(h, 'gaps.jsonl'))! + jl(Array.from({ length: 5 }, () => ({ ts: 5000, text: 'the one that repeats' }))))
  const r = await run(h)
  expect(r.ok).toBe(true)
  const t = read(h, r)
  expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(EXPORT_CAP)
  expect(t).toContain('(truncated at')
  expect(t).toMatch(/_\.\.\. \d+ more entries summarised \(oldest \/ least repeated\)\._/)
  expect(t).toContain('- (x5) the one that repeats') // the repeated one survives the cut
  expect(t).not.toContain('gap number 0 ') // an old single one does not
})

test('no network and no posting: the only processes are claude --version, uname and the file helpers', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/a.md'), '# x\n')
  await run(h, { notes: 'hello' })
  const used = new Set(h.calls.map(c => c.argv[0]))
  for (const bad of ['gh', 'curl', 'wget', 'git', 'ssh', 'nc', 'open']) expect(used.has(bad), bad).toBe(false)
  expect([...used].every(c => ['claude', 'uname', 'mkdir', 'mv', 'rm', 'tee', 'sleep'].includes(c!))).toBe(true)
  // (the doctor check the export runs lists live sessions for 1.0.6's model check: local, read-only)
  expect(h.calls.filter(c => c.argv[0] === 'claude').every(c => c.argv[1] === '--version' || (c.argv[1] === 'agents' && c.argv.includes('--json')))).toBe(true)
})

// ---- what the first real export showed (1.0.5) ---------------------------------------------------------------------------------
test('a draft is titled by its first heading; a long date-slug file name is never taken for a secret, and a draft without text shows its name as words', async () => {
  const h = setup()
  const slug = '2026-11-18-the-desk-did-not-open-the-export-file-from-the-app'
  expect(slug.length).toBeGreaterThan(40) // long enough for the secret rule
  h.files.set(lean(h, `feedback-drafts/${slug}.md`), '\n## Export file not openable in alpha\nSteps in alpha\n')
  h.files.set(lean(h, 'feedback-drafts/2026-11-19-the-alpha-opener-failed-after-a-restart-of-the-app-today.md'), '\n\n') // no text to take a title from
  h.files.set(lean(h, 'feedback-drafts/2026-11-20-plain-first-line.md'), 'no heading here, just a line\nmore\n')
  const t = read(h, await run(h))
  expect(t).not.toContain('<secret>')
  expect(t).toContain('### Export file not openable in project-A\n\nSteps in project-A') // the first heading is the title, not said twice
  expect(t).toContain('### the project-A opener failed after a restart of the app today\n\nnone') // the name rules (project) ran, the secret rule did not
  expect(t).toContain('### no heading here, just a line\n\nmore')
  expect(t).not.toContain(slug)
  expect(JSON.parse(h.files.get(`${EXP}/state.json`)!).drafts).toContain(`${slug}.md`) // the raw name is remembered, so it is exported once
})

test('a draft whose heading is not its first line keeps every other line; a long title is anonymised before it is cut', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/a.md'), 'Steps in alpha\n## The real title\nmore\n')
  h.files.set(lean(h, 'feedback-drafts/b.md'), `# ${'word '.repeat(22)}mail ${EMAIL}\nbody\n`) // the address would straddle a cut at 120 characters
  const t = read(h, await run(h))
  expect(t).toContain('### The real title\n\nSteps in project-A\nmore')
  expect(t).not.toContain('<emai\n') // a cut never leaves half a placeholder
  expect(t.match(/The real title/g)).toHaveLength(1)
  expect(t).not.toContain(EMAIL.slice(0, 6))
  expect(t).not.toContain('example') // no fragment of the address is left
  expect(t).toMatch(/### (word ){22}mail\s*\n/) // cut at 120 characters after anonymising: the address is gone, not half of it
})

test('a first line that is not a heading keeps its # so the id rule still masks it', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/x.md'), '#4821 login broken\nbody\n')
  const t = read(h, await run(h))
  expect(t).toContain('### #<id> login broken')
  expect(t).not.toContain('4821')
})

test('the same report in the old and the new feedback file counts once, whatever the key order or the unit of its time; identical rows inside one file stay separate', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback/feedback.jsonl'), jl([{ ts: 1_700_000_000, status: 'done', thread: 't1' }, { ts: 1_700_000_100, status: 'done', thread: 't2' }, { ts: 1_700_000_100, status: 'done', thread: 't2' }]))
  h.files.set(lean(h, 'feedback.jsonl'), jl([{ thread: 't1', status: 'done', ts: 1_700_000_000_000 }, { ts: 1_700_000_100_000, thread: 't2', status: 'done' }, { ts: 1_700_000_100_000, thread: 't2', status: 'done' }, { ts: 1_700_000_100_000, thread: 't2', status: 'done' }]))
  expect(read(h, await run(h))).toContain('Reports: 4 (done 4)') // t1 once; t2 three times (the larger count of the two files)
})

test('the name rules mask a project, the user and a home path in a file name and never the secret or hash rules', async () => {
  const h = setup('/q/zeldaquux')
  const a = await makeAnonymiser(h.host)
  const long = 'zeldaquux-alpha-deadbeefcafe-and-a-name-longer-than-thirty-two-characters'
  expect(a.name(long)).toBe('<user>-project-A-deadbeefcafe-and-a-name-longer-than-thirty-two-characters')
  expect(a.anonymise(long)).toContain('<secret>') // the whole-text rules would have masked it
  expect(a.name(`/q/zeldaquux/code/${long}`)).toMatch(/^~\/code\//)
})

test('every section is printed, "none" when empty, and the old feedback/feedback.jsonl is read with its old row shapes', async () => {
  const empty = setup()
  const e = read(empty, await run(empty))
  for (const s of ['## Notes\n\nnone', '## Drafts not exported before\n\nnone', 'Reports: none', 'Reports naming missing context: none', '### missing\n\nnone', '### refused\n\nnone', '### unverified\n\nnone', '### unreached\n\nnone', '## Guard refusals since the last export\n\nnone', '## Script candidates for lean-agent core\n\nnone', '## Threads blocked since the last export\n\nnone'])
    expect(e, s).toContain(s)
  expect(e).toContain('## Doctor check: problems')
  expect(e).toContain('Read: feedback.jsonl: not found; feedback/feedback.jsonl: not found')
  // 133 rows in the 0.45 place, with the old shapes: seconds and ISO dates as time, strings for `missing` and `refused`, no status on some
  const h = setup()
  const rows: unknown[] = []
  for (let i = 0; i < 100; i++) rows.push({ ts: 1_700_000_000 + i, status: 'done', missing: i % 10 === 0 ? 'no build command for alpha' : '' })
  for (let i = 0; i < 20; i++) rows.push({ ts: new Date(1_700_100_000_000 + i).toISOString(), status: 'partial', refused: i < 3 ? 'ls was refused' : undefined })
  for (let i = 0; i < 12; i++) rows.push({ status: 'failed', missing: true }) // no time at all
  rows.push({ ts: 1_700_200_000, note: 'no status' })
  h.files.set(lean(h, 'feedback/feedback.jsonl'), jl(rows))
  h.files.set(lean(h, 'feedback.jsonl'), jl([{ ts: T0 - 1000, status: 'done' }, rows[0]])) // the new place; a row in both is counted once
  const t = read(h, await run(h))
  expect(t).toContain('Read: feedback.jsonl: 2 row(s); feedback/feedback.jsonl: 133 row(s)')
  expect(t).toContain('Reports: 134 (done 101, partial 20, failed 12, unknown 1)')
  expect(t).toContain('Reports naming missing context: 22')
  expect(t).toContain('### missing\n\n- (x10) no build command for project-A')
  expect(t).toContain('### refused\n\n- (x3) ls was refused')
  expect(t).not.toContain('Reports: none')
  // only what is new at the next export (a row without a time was counted by the first)
  h.clock.t = T0 + 60_000
  expect(read(h, await run(h))).toContain('Reports: none')
})

test('the public repo path passes even when the OS user name is the repo owner; another repo, a longer name or the plain name does not', async () => {
  const h = setup('/q/mcmadsen')
  const a = await makeAnonymiser(h.host)
  for (const s of ['https://github.com/mcmadsen/lean-agent', 'github.com/mcmadsen/lean-agent', 'mcmadsen/lean-agent', 'see https://github.com/mcmadsen/lean-agent/issues/new.', 'gh issue create --repo mcmadsen/lean-agent --body-file x'])
    expect(a.anonymise(s), s).toBe(s)
  expect(a.anonymise('mcmadsen/lean-agent-extras')).toBe('<user>/lean-agent-extras')
  expect(a.anonymise('github.com/mcmadsen/other')).toBe('github.com/<org>/<repo>')
  expect(a.anonymise('mcmadsen and MCMADSEN-laptop')).toBe('<user> and <user>-laptop')
  const once = a.anonymise('repo mcmadsen/lean-agent, owner mcmadsen, /q/mcmadsen/code')
  expect(once).toBe('repo mcmadsen/lean-agent, owner <user>, ~/code')
  expect(a.anonymise(once)).toBe(once)
  expect(a.missed('https://github.com/mcmadsen/lean-agent and mcmadsen/lean-agent')).toEqual([])
  expect(a.missed('mcmadsen/lean-agent-extras')).toContain('user name')
  expect(a.missed('owner mcmadsen')).toContain('user name')
  const r = await run(h, { notes: 'see https://github.com/mcmadsen/lean-agent and github.com/mcmadsen/lean-agent, mcmadsen/lean-agent' })
  expect(r.ok).toBe(true)
  expect(read(h, r)).toContain('see https://github.com/mcmadsen/lean-agent and github.com/mcmadsen/lean-agent, mcmadsen/lean-agent')
})

// ---- wiring -----------------------------------------------------------------------------------------------------------------
const PLUGIN = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
async function session($: any, on: any, cwd: string) {
  const h = fakeHost(on)
  resetLocks()
  resetViewCache()
  h.clock.t = T0
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', () => ({ value: { cancel() {} } }))
  h.files.set(`${PLUGIN}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${PLUGIN}/templates/thread.md`, '# {{id}}')
  h.files.set(`${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327' : a[0] === 'agents' ? '[]' : '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ alpha: { path: '/r/alpha' } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return h
}

test('/lean-agent-feedback works in any session: writes the file, prints its path, takes the notes as the argument', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, '/h/.claude/spares/spare-abc') // a plain session
  const r: any = await $.command.run({ command: 'lean-agent-feedback', args: 'the opener failed in alpha' } as any)
  // what the user sees: plain words, no instruction to a model
  expect(r.text).toMatch(new RegExp(`^Feedback export written: ${EXP}/2026-11-18-1407\\.md \\(\\d+ KB, anonymised\\)\\. Nothing was posted\\. Paste it to the maintainers, or ask the desk to post it\\.$`))
  expect(r.text).not.toMatch(/show the path|the user |explicit yes|gh /i)
  const t = h.files.get(`${EXP}/2026-11-18-1407.md`)!
  expect(t).toContain('the opener failed in project-A')
  expect(t).not.toContain('alpha')
})

test('the desk\'s lean_doctor export writes the same file; a refusal is an error result', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, '/h/lean-agent-desk')
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'export', notes: 'from the desk' } as any)
  expect(r.isError).toBeUndefined()
  expect(r.result).toContain('Feedback export written')
  expect(h.files.get(`${EXP}/2026-11-18-1407.md`)).toContain('from the desk')
})

test('a refused guard decision is logged for the export', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, '/h/lean-agent-desk')
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/r/x.ts' } as any) // strict mode: the desk edits nothing
  expect(r.deny).toBeTruthy()
  const rows = await readJsonl<any>(h.host, '/h/.lean-agent/refusals.jsonl')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ src: 'guard', tool: 'Edit' })
  expect(typeof rows[0].version).toBe('string') // the running version (1.0.6's skew work)
  expect(rows[0].text).toContain('strict mode')
})
