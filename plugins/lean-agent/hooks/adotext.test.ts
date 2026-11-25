// 1.0.35 Azure DevOps text rules (adotext.ts): every token class with and without code spans, mentions, hashes (warn only: not documented), the description limit, GitHub untouched,
// the request card / action-list / question text, the commit hint. Synthetic names and numbers only (acme, PR 4271, WI 4210).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { relaxOwnTaskForSpecs } from './owntask'
relaxOwnTaskForSpecs()
import { ADO_GUIDE_LINE, PR_DESCRIPTION_MAX, checkActionText, checkAdoText, checkPrText, commitHint, commitMessages, findingLines, isAdoUrl } from './adotext'
import { actionListText, addActionRequest, listActions, questionOf, resetActions } from './deskactions'
import { recordHumanPrompt } from './humanprompts'
import { resetLocks } from './threads'

const L = '/h/.lean-agent'
const tokens = (t: string, o: Parameters<typeof checkAdoText>[1] = { kind: 'pr-comment' }) => checkAdoText(t, o).findings.map(f => f.token)

test('#<id>: a known PR is converted to !<id> only in convert mode; warn mode only says so; an unknown number only warns and is never changed', () => {
  const t = 'Follows up #4271 and the work item #4210.'
  const w = checkAdoText(t, { kind: 'pr-description', knownPrs: [4271] })
  expect(w.text).toBe(t)
  expect(w.findings.map(f => f.token)).toEqual(['#4271', '#4210'])
  expect(w.findings[0]!.what).toContain('write !4271')
  expect(w.findings[0]!.did).toBe('warned')
  expect(w.findings[1]!.what).toContain('#4210 is a work item on Azure DevOps: write !4210 for a pull request, or keep # only if you mean the work item')
  const c = checkAdoText(t, { kind: 'pr-description', knownPrs: [4271], mode: 'convert' })
  expect(c.text).toBe('Follows up !4271 and the work item #4210.')
  expect(c.findings[0]).toMatchObject({ token: '#4271', did: 'converted' })
  expect(c.findings[0]!.what).toContain('#4271 -> !4271 (PR)')
  expect(c.findings[1]!.did).toBe('warned') // an unknown number is never changed
  expect(checkAdoText(t, { kind: 'pr-description', mode: 'off', knownPrs: [4271] })).toEqual({ text: t, findings: [] })
})

test('#<id> is left alone inside code spans, code blocks, URLs, AB#<id>, HTML entities, escaped hashes and !<id>', () => {
  const t = ['`#4271` and ```#4271``` here', '```', '#4271 in a block', '```', 'see https://dev.azure.com/acme/Shop/_git/api/pullrequest/42#4271 and AB#4210, &#4271; \\#4271 and !4271, no#4271'].join('\n')
  expect(checkAdoText(t, { kind: 'pr-comment', knownPrs: [4271], mode: 'convert' })).toEqual({ text: t, findings: [] })
  expect(tokens('a #4271 b', { kind: 'pr-comment' })).toEqual(['#4271'])
  expect(tokens('(#4271)', { kind: 'pr-title' })).toEqual(['#4271'])
})

test('@mentions: warned with the count, ignored in code, e-mail addresses and URLs, allowed when the user wrote them, put in backticks in convert mode', () => {
  const t = 'Thanks @alice and @bob.smith, ping @9a1c4f20-1b2c-4d3e-8f90-123456789abc.'
  const w = checkAdoText(t, { kind: 'pr-comment' })
  expect(w.text).toBe(t)
  expect(w.findings).toHaveLength(1)
  expect(w.findings[0]!.what).toContain('this mentions 3 people who may get a notification')
  expect(w.findings[0]!.did).toBe('warned')
  const c = checkAdoText(t, { kind: 'pr-comment', mode: 'convert' })
  expect(c.text).toBe('Thanks `@alice` and `@bob.smith`, ping `@9a1c4f20-1b2c-4d3e-8f90-123456789abc`.')
  expect(c.findings[0]!.did).toBe('converted')
  expect(tokens('mail dev@example.test, `@alice`, https://example.test/@alice and ```\n@bob\n```')).toEqual([])
  expect(tokens('hello @alice', { kind: 'pr-comment', userText: 'please thank @Alice in the PR' })).toEqual([]) // the user's own words
  expect(tokens('hello @alice @carol', { kind: 'pr-comment', userText: 'thank @alice' })).toEqual(['@carol'])
  expect(checkAdoText('Fixes it @alice', { kind: 'commit' }).findings).toEqual([]) // a commit message mentions nobody
})

test('commit hashes: only a warning (not documented), never rewritten; not in code, URLs, words or plain numbers; not in commit messages', () => {
  const t = 'Broken since 3f9a1c2 and 0123456789abcdef0123456789abcdef01234567.'
  const r = checkAdoText(t, { kind: 'pr-comment', mode: 'convert' })
  expect(r.text).toBe(t)
  expect(r.findings.map(f => f.token)).toEqual(['3f9a1c2', '0123456789a…'])
  expect(r.findings[0]!.what).toContain('may render as a link or stay plain text')
  expect(tokens('see `3f9a1c2`, https://dev.azure.com/acme/p/_git/r/commit/3f9a1c2, defaced, 1234567, abcdefa, in a commit/3f9a1c2 path')).toEqual([])
  expect(checkAdoText('Reverts 3f9a1c2', { kind: 'commit' }).findings).toEqual([])
})

test('emoji shortcodes, HTML tags, headings, single newlines and non-http links are found (and not in code)', () => {
  expect(tokens('great :tada: work, at 10:30:45 sharp')).toEqual([':tada:'])
  expect(tokens('`:tada:` and ```\n:tada:\n```')).toEqual([])
  expect(tokens('line one<br>line two and <details>x</details>')).toEqual(['<br>', '<details>'])
  expect(tokens('use `<br>` here')).toEqual([])
  expect(tokens('# Title\ntext', { kind: 'workitem-comment' })).toContain('# Title')
  expect(tokens('## Summary\n\nbody', { kind: 'pr-description' })).toEqual([]) // a description's headings are its template
  expect(tokens('first line\nsecond line\n\nnext paragraph')).toEqual(['1 line break'])
  expect(tokens('first line  \nsecond line\n\n- a\n- b\n\n```\ncode\nmore\n```')).toEqual([])
  expect(tokens('click [here](javascript:alert(1)) or [there](https://example.test) or [mail](mailto:a@b.test)')).toEqual(['](javascript:…)'])
  expect(tokens('a\nb', { kind: 'commit' })).toEqual([]) // a commit body is plain text
})

test('length: a PR description over 90% of the documented 4000 characters warns, over 4000 says it is refused or cut; comments have no documented maximum', () => {
  expect(PR_DESCRIPTION_MAX).toBe(4000)
  expect(tokens('x'.repeat(3600), { kind: 'pr-description' })).toEqual([])
  expect(checkAdoText('x'.repeat(3601), { kind: 'pr-description' }).findings[0]!.what).toContain('over 90% of the documented 4000')
  expect(checkAdoText('x'.repeat(4001), { kind: 'pr-description' }).findings[0]!.what).toContain('documents up to 4000')
  expect(tokens('x'.repeat(9000), { kind: 'pr-comment' })).toEqual([])
  expect(tokens('x'.repeat(9000), { kind: 'workitem-comment' })).toEqual([])
})

function setup(cfg: Record<string, unknown> = {}) {
  resetLocks()
  resetActions()
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, JSON.stringify({ actions: { holdSeconds: 0 }, ...cfg }))
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, pr: { number: 4271, host: 'azure' } }))
  return h
}
const P = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42 }

test('a request: the findings are kept with it and shown in the question, action-list and the view BEFORE the user approves; the text is unchanged in warn mode', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  const r = await addActionRequest(h.host, 't5', { kind: 'ado-pr-comment', params: { ...P, body: 'Replaces #4271, cc @dana. See 3f9a1c2.' }, why: 'x' })
  expect(r.ok, r.text).toBe(true)
  const v = r.request!
  expect(v.text).toContain('Replaces #4271, cc @dana.') // as the thread wrote it
  expect(v.notes!.join(' ')).toContain('#4271 is a known PR of this task')
  expect(v.notes!.join(' ')).toContain('this mentions 1 person')
  const q = questionOf(v).question
  expect(q).toContain('\nAzure DevOps text check: #4271')
  expect(q.indexOf('Target:')).toBeLessThan(q.indexOf('Azure DevOps text check'))
  expect(q.endsWith('Send exactly this?')).toBe(true)
  expect(await actionListText(h.host)).toContain('Azure DevOps text check')
  expect((await listActions(h.host))[0]!.notes).toEqual(v.notes)
})

test('a request in convert mode: the known PR is written !4271 before it is signed (the card shows the converted text); a work item comment and a batch item too', { timeoutMs: 20_000 }, async () => {
  const h = setup({ ado: { textRules: 'convert' } })
  const r = await addActionRequest(h.host, 't5', { kind: 'ado-pr-reply', params: { ...P, thread: 7, body: 'Superseded by #4271.' }, why: 'x' })
  expect(r.ok, r.text).toBe(true)
  expect(r.request!.text).toBe('Superseded by !4271.')
  expect(r.request!.notes![0]).toContain('#4271 -> !4271 (PR)')
  const w = await addActionRequest(h.host, 't5', { kind: 'ado-workitem-comment', params: { org: 'acme', project: 'Shop App', id: 1234, body: 'Done in #4271.' }, why: 'x' })
  expect(w.request!.text).toBe('Done in !4271.')
  const b = await checkActionText(h.host, 't5', 'batch', { items: [{ kind: 'ado-pr-comment', params: { ...P, body: 'x #4271' } }, { kind: 'ado-pr-vote', params: { ...P, vote: 'approve' } }] })
  expect((b.params as { items: { params: { body?: string } }[] }).items[0]!.params.body).toBe('x !4271')
  expect(b.findings).toHaveLength(1)
})

test('off, a GitHub kind and a clean text are never noted', { timeoutMs: 20_000 }, async () => {
  const off = setup({ ado: { textRules: 'off' } })
  const a = await addActionRequest(off.host, 't5', { kind: 'ado-pr-comment', params: { ...P, body: 'See #4271 @dana' }, why: 'x' })
  expect(a.request!.notes).toBeUndefined()
  const gh = setup()
  const g = await addActionRequest(gh.host, 't5', { kind: 'gh-pr-comment', params: { repo: 'acme/shop-api', pr: 42, body: 'See #4271 for @dana' }, why: 'x' })
  expect(g.ok, g.text).toBe(true)
  expect(g.request!.notes).toBeUndefined()
  expect(g.request!.text).toContain('See #4271 for @dana')
  const clean = setup()
  const c = await addActionRequest(clean.host, 't5', { kind: 'ado-pr-comment', params: { ...P, body: 'Rebased on main.' }, why: 'x' })
  expect(c.request!.notes).toBeUndefined()
  expect(questionOf(c.request!).question).not.toContain('Azure DevOps text check')
})

test('a mention the user wrote is not flagged on a request', { timeoutMs: 20_000 }, async () => {
  const h = setup()
  await recordHumanPrompt(h.host, { text: 'please thank @dana in the PR', wait: false, origin: { kind: 'composer' } })
  const r = await addActionRequest(h.host, 't5', { kind: 'ado-pr-comment', params: { ...P, body: 'Thanks @dana' }, why: 'x' })
  expect(r.request!.notes).toBeUndefined()
})

test('the PR text before a push: warn mode gives the findings, convert mode the converted text; the Azure DevOps origin test', async () => {
  const h = setup()
  const t = await checkPrText(h.host, 't5', { title: 'Fix login (#4271)', body: '## Summary\nSupersedes #4271 @dana\n' })
  expect(t.title).toBe('Fix login (#4271)')
  expect(t.findings.map(f => f.token)).toEqual(['#4271', '@dana'])
  const c = setup({ ado: { textRules: 'convert' } })
  const u = await checkPrText(c.host, 't5', { title: 'Fix login (#4271)', body: 'Supersedes #4271' })
  expect([u.title, u.body]).toEqual(['Fix login (!4271)', 'Supersedes !4271'])
  expect(isAdoUrl('https://dev.azure.com/acme/Shop%20App/_git/shop-api')).toBe(true)
  expect(isAdoUrl('git@ssh.dev.azure.com:v3/acme/Shop/api')).toBe(true)
  expect(isAdoUrl('https://acme.visualstudio.com/Shop/_git/api')).toBe(true)
  expect(isAdoUrl('https://github.com/acme/shop-api.git')).toBe(false)
})

test('commit message lint: a hint line (never a refusal) for "#<id>" in a git commit -m on an Azure DevOps origin; GitHub and clean messages say nothing', async () => {
  expect(commitMessages('git commit -m "Fix #4271" -m \'second #1\'')).toEqual(['Fix #4271', 'second #1'])
  expect(commitMessages('git -C /w commit --message="Fix #4271"')).toEqual(['Fix #4271'])
  expect(commitMessages('git status')).toEqual([])
  const ado = setup()
  ado.git.handler = argv => (argv.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 0, stdout: '' })
  const hint = await commitHint(ado.host, 't5', 'git commit -m "Follow-up to #4271 and #4210"', '/w')
  expect(hint).toContain('Azure DevOps: PR is !<id>, work item is #<id>')
  expect(hint).toContain('#4271 is a known PR of this task')
  expect(hint).toContain('#4210 is a work item on Azure DevOps')
  expect(hint).toContain('Nothing was refused')
  expect(await commitHint(ado.host, 't5', 'git commit -m "Fix login"', '/w')).toBe('')
  const gh = setup()
  gh.git.handler = argv => (argv.includes('get-url') ? { exitCode: 0, stdout: 'https://github.com/acme/shop-api.git\n' } : { exitCode: 0, stdout: '' })
  expect(await commitHint(gh.host, 't5', 'git commit -m "Fix #4271"', '/w')).toBe('')
  expect(await commitHint(ado.host, 't5', 'git commit -m "Fix #4271"', '')).toBe('') // no folder: nothing to look at
  const off = setup({ ado: { textRules: 'off' } })
  off.git.handler = ado.git.handler
  expect(await commitHint(off.host, 't5', 'git commit -m "Fix #4271"', '/w')).toBe('')
})

test('the guide line and the finding line format', () => {
  expect(ADO_GUIDE_LINE).toContain('a PR is !<id>, a work item is #<id> (GitHub uses #<id> for both)')
  expect(findingLines([{ token: '#1', what: 'w', did: 'warned' }])).toEqual(['#1: w [warned]'])
})
