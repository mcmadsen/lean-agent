// 1.0.28 allow-writes: targets from URLs (GUIDs in an Azure DevOps URL, work item and GitHub URLs, host / org checked against the thread's project remote),
// the command with and without the slash, and a refusal that says which forms count and what the user's last message missed. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetActions } from './deskactions'
import { allowWrites, writesView } from './deskwrites'
import { instructionIn } from './writeinstr'
import { recordHumanPrompt } from './humanprompts'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const PID = '11111111-2222-3333-4444-555555555555'
const RID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const GUID_URL = `https://dev.azure.com/acme/${PID}/_git/${RID}/pullrequest/4321?_a=overview`
const WI_URL = 'https://dev.azure.com/acme/Shop%20App/_workitems/edit/1234'

type Reads = { project?: string; repoProject?: string; fail?: boolean }
function setup(remote: 'azure' | 'github' = 'azure', reads: Reads = {}) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: remote === 'github' ? 'https://github.com/acme/shop-api.git\n' : 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] !== 'curl') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    if (reads.fail) return { exitCode: 22, stdout: '', stderr: 'curl: (22) 401' }
    const url = argv[argv.length - 1]!
    if (url.includes('/_apis/projects/')) return { exitCode: 0, stdout: JSON.stringify({ id: PID, name: reads.project ?? 'Shop App' }) }
    if (url.includes('/_apis/git/repositories/')) return { exitCode: 0, stdout: JSON.stringify({ id: RID, name: 'shop-api', project: { name: reads.repoProject ?? 'Shop App' } }) }
    return { exitCode: 1, stdout: '' }
  }
  const say = (text: string) => recordHumanPrompt(h.host, { text, wait: false, origin: { kind: 'composer' } })
  return { h, host: h.host, say }
}
const scopes = async (s: ReturnType<typeof setup>) => (await writesView(s.host)).grants.map(g => g.scope)

test('a pasted Azure DevOps PR URL with GUIDs (the number at its end is the target) is accepted with "please lets get this done"', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await s.say(`please lets get this done ${GUID_URL}`)
  const o = await allowWrites(s.host, 't5', { pr: GUID_URL })
  expect(o.ok, o.text).toBe(true)
  expect(await scopes(s)).toEqual(['Azure DevOps PR acme/Shop App/shop-api#4321']) // names, not GUIDs: what the requests carry
  for (const c of s.h.calls.filter(c => c.argv[0] === 'curl')) expect(c.argv.join(' ')).not.toContain(TOKEN) // the reads send the token on stdin
})

test('a URL whose project (by GUID or by name), org or forge is not the thread\'s is refused: "this URL points at <org>/<project>, not the project of t5"', { timeoutMs: 20_000 }, async () => {
  const s = setup('azure', { project: 'Other Project' })
  await s.say(`please handle ${GUID_URL}`)
  const o = await allowWrites(s.host, 't5', { pr: GUID_URL })
  expect(o.ok).toBe(false)
  expect(o.text).toContain('this URL points at acme/Other Project, not the project of t5')
  const r = setup('azure', { repoProject: 'Other Project' })
  await r.say(`please handle ${GUID_URL}`)
  expect((await allowWrites(r.host, 't5', { pr: GUID_URL })).text).toContain('this URL points at acme/Other Project, not the project of t5')
  const org = setup()
  const evil = 'https://dev.azure.com/evil/Shop%20App/_git/shop-api/pullrequest/42'
  await org.say(`please handle ${evil}`)
  expect((await allowWrites(org.host, 't5', { pr: evil })).text).toContain('this URL points at evil/Shop App, not the project of t5')
  const named = 'https://dev.azure.com/acme/Elsewhere/_git/shop-api/pullrequest/42'
  expect((await allowWrites(org.host, 't5', { pr: named })).text).toContain('this URL points at acme/Elsewhere')
  const gh = 'https://github.com/acme/shop-api/pull/42'
  expect((await allowWrites(org.host, 't5', { pr: gh })).text).toContain('this URL points at acme/shop-api, not the project of t5')
  expect(await scopes(org)).toEqual([])
})

test('GUIDs that cannot be read are taken as the thread\'s own project and repository, and the answer says so', { timeoutMs: 20_000 }, async () => {
  const s = setup('azure', { fail: true })
  await s.say(`please handle ${GUID_URL}`)
  const o = await allowWrites(s.host, 't5', { pr: GUID_URL })
  expect(o.ok, o.text).toBe(true)
  expect(o.text).toContain('could not be read')
  expect(await scopes(s)).toEqual(['Azure DevOps PR acme/Shop App/shop-api#4321'])
})

test('a work item URL and a GitHub PR URL name their targets (GitHub only for a GitHub remote)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  await s.say(`please finish ${WI_URL}`)
  const o = await allowWrites(s.host, 't5', { workitem: WI_URL })
  expect(o.ok, o.text).toBe(true)
  expect(await scopes(s)).toEqual(['Azure DevOps work item acme/Shop App#1234'])
  const g = setup('github')
  const gh = 'https://github.com/acme/shop-api/pull/42'
  await g.say(`go ahead with ${gh}`)
  expect((await allowWrites(g.host, 't5', { pr: gh })).ok).toBe(true)
  expect(await scopes(g)).toEqual(['GitHub PR acme/shop-api#42'])
})

test('a URL alone, or "please" without it, is no instruction; the soft words count only with a PR or work item URL and not after a negation', () => {
  expect(instructionIn(GUID_URL)).toBeNull()
  expect(instructionIn('please lets get this done')).toBeNull()
  expect(instructionIn(`please lets get this done ${GUID_URL}`)).toBeTruthy()
  expect(instructionIn(`go ahead ${WI_URL}`)).toBeTruthy()
  expect(instructionIn(`handle ${GUID_URL}`)).toBeTruthy()
  expect(instructionIn(`finish ${GUID_URL}`)).toBeTruthy()
  expect(instructionIn(`please do not touch ${WI_URL}`)).toBeNull()
  expect(instructionIn(`see ${WI_URL}`)).toBeNull()
})

test('the command counts with the slash, as lean-agent:allow and as allow', { timeoutMs: 20_000 }, async () => {
  for (const text of ['/lean-agent:allow t5 4321', 'lean-agent:allow t5 4321', 'allow t5 4321', 'Allow t5 4321']) {
    const s = setup()
    await s.say(text)
    const o = await allowWrites(s.host, 't5', { pr: 4321 })
    expect([text, o.ok]).toEqual([text, true])
  }
  expect(instructionIn('allow t8 4321')).toBeTruthy()
})

test('a refusal lists the forms that count and quotes the near miss: the last message that did not name the target', { timeoutMs: 20_000 }, async () => {
  const none = setup()
  const a = await allowWrites(none.host, 't5', { pr: 4321 })
  expect(a.ok).toBe(false)
  expect(a.text).toContain('in the CHAT box (never in a shell box')
  expect(a.text).toContain('/lean-agent:allow t5 <PR number or URL>')
  expect(a.text).toContain("fix the comments on PR <n>")
  expect(a.text).not.toContain('your last message') // nothing was typed: no near miss
  const vague = setup()
  await vague.say('please lets get this done')
  const b = await allowWrites(vague.host, 't5', { pr: 4321 })
  expect(b.text).toContain("your last message 'please lets get this done' did not name")
  const cmd = setup()
  await cmd.say('/lean-agent:allow t5 five thousand')
  const c = await allowWrites(cmd.host, 't5', { pr: 4321 })
  expect(c.text).toContain("your last message '/lean-agent:allow t5 five thousand' did not name a PR number or URL")
  const other = setup()
  await other.say('fix the comments on PR 77')
  const d = await allowWrites(other.host, 't5', { pr: 4321 })
  expect(d.text).toContain("your last message 'fix the comments on PR 77' did not name")
  const chat = setup()
  await chat.say('thanks, looks good')
  expect((await allowWrites(chat.host, 't5', { pr: 4321 })).text).not.toContain('your last message')
})
