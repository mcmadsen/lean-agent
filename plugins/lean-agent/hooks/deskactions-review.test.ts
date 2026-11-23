// 1.0.30: the review writes of an Azure DevOps PR (vote, update, reviewer, policy queue, work item unlink, label): typed, the exact text, approval bound to the request id,
// the same executor (token on stdin, never in argv / log), the own-PR default only for the narrow kinds. Canned curl / az output ONLY: nothing is ever sent.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { ACTION_KINDS, addActionRequest, answerAction, approveAction, bindAnswers, checkAction, questionOf, renderingOf, resetActions } from './deskactions'
import { runOwnPr } from './ownpr'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const ME = '99999999-8888-7777-6666-555555555555'
const PROJECT_ID = '11111111-2222-3333-4444-555555555555'
const REPO_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PR = { host: 'azure', org: 'acme', project: 'Shop App', repo: 'shop-api', id: 4321, url: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4321', since: 500_000 }
const BASE = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321 }
const PRS = 'https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/4321'

type Reply = { exitCode: number; stdout: string; stderr?: string }
function setup(opts: { reads?: (url: string) => Reply | null; write?: Reply; owns?: boolean } = {}) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.clock.t = 1_000_000
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...(opts.owns === false ? {} : { pr: PR, workItems: [1234] }) }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/config.json`, JSON.stringify({ actions: { holdSeconds: 0 } }))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] !== 'curl') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    const url = argv[argv.length - 1]!
    if (argv[argv.indexOf('-X') + 1] === 'GET') {
      const own = opts.reads?.(url)
      if (own) return own
      if (url.includes('/_apis/connectionData')) return { exitCode: 0, stdout: JSON.stringify({ authenticatedUser: { id: ME } }) }
      return { exitCode: 0, stdout: JSON.stringify({ id: url.includes('/_apis/projects/') ? PROJECT_ID : REPO_ID }) }
    }
    return opts.write ?? { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) }
  }
  const sends = () => h.calls.filter(c => c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] !== 'GET')
  const told: string[] = []
  const tell = async (_t: string, text: string) => {
    told.push(text)
  }
  return { h, host: h.host, sends, told, tell }
}
type S = ReturnType<typeof setup>

const ask = async (s: S, kind: string, params: Record<string, unknown>) => {
  const r = await addActionRequest(s.host, 't5', { kind, params, why: 'the review round' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
// the user presses Approve on the desk's own question (the canonical one), then the desk sends
const approve = async (s: S, v: Awaited<ReturnType<typeof ask>>) => {
  const q = questionOf(v)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  await bindAnswers(s.host, [qq], { [qq.question]: 'Approve' }, s.tell)
  return approveAction(s.host, v.id, s.tell)
}
const noToken = (s: S) => {
  for (const c of s.h.calls) expect(`${c.argv.join(' ')}`).not.toContain(TOKEN)
  expect([...s.h.files.values()].join('\n')).not.toContain(TOKEN)
}
// the own-PR default: the request is made, then the default decides (a request it does not cover waits for the user: denied here so nothing stays open)
const own = async (s: S, kind: string, params: Record<string, unknown>) => {
  const made = await addActionRequest(s.host, 't5', { kind, params, why: 'the review round' })
  expect(made.ok, made.text).toBe(true)
  const r = await runOwnPr(s.host, made.request!.id)
  if (!r?.sent) await answerAction(s.host, made.request!.id, 'deny', 'pane')
  return r
}

// ---- 1 ado-pr-vote ---------------------------------------------------------------------------------------------------------------------
test('ado-pr-vote: every vote is the REST value of az repos pr set-vote, rendered exactly, and anything else is refused', () => {
  const want: Record<string, number> = { approve: 10, 'approve-with-suggestions': 5, reject: -10, reset: 0, 'wait-for-author': -5 }
  for (const [vote, n] of Object.entries(want)) {
    const c = checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote } })
    expect([vote, c.ok]).toEqual([vote, true])
    if (!c.ok) continue
    expect([c.plan.method, c.plan.contentType, JSON.parse(c.plan.body)]).toEqual(['PUT', 'application/json', { vote: n }])
    expect(c.plan.url).toBe(`${PRS}/reviewers/${encodeURIComponent('<your reviewer id>')}?api-version=7.1`)
    expect(c.plan.text).toContain(`vote "${vote}" (${n})`)
    expect(c.plan.headline).toContain('PR 4321')
  }
  expect(checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 'Approve With Suggestions' } }).ok).toBe(true) // the words, any case
  for (const vote of ['approved', 'merge', '10', '', 'complete']) expect([vote, checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote } }).ok]).toEqual([vote, false])
  expect(checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 10 } }).ok).toBe(false) // a number is not a word
  expect(checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 'approve', reviewer: 'someone-else' } }).ok).toBe(false) // never another identity's vote
  expect(checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 'approve', pr: 'x' } }).ok).toBe(false)
  expect(ACTION_KINDS['ado-pr-vote']).toContain('wait-for-author')
  const a = checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 'approve' } })
  const b = checkAction({ kind: 'ado-pr-vote', params: { ...BASE, vote: 'reject' } })
  if (a.ok && b.ok) expect(renderingOf(a.plan)).not.toBe(renderingOf(b.plan)) // the hash differs: an approval never carries over to another vote
})

test('ado-pr-vote: only an approved request is sent; "me" is read by a GET of connectionData at send time; the token is on stdin only', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, 'ado-pr-vote', { ...BASE, vote: 'approve-with-suggestions' })
  expect(v.text).toContain('vote "approve-with-suggestions" (5)')
  const refused = await approveAction(s.host, v.id, s.tell)
  expect(refused.ok).toBe(false) // no human Approve yet
  expect(s.sends()).toHaveLength(0)
  const o = await approve(s, v)
  expect(o.ok, o.text).toBe(true)
  const [w] = s.sends()
  expect(w!.argv).toContain('PUT')
  expect(w!.argv[w!.argv.length - 1]).toBe(`${PRS}/reviewers/${ME}?api-version=7.1`)
  expect(w!.stdin).toContain('Content-Type: application/json')
  expect(w!.stdin).toContain('data-binary = "{\\"vote\\":5}"')
  expect(w!.stdin).toContain(`Bearer ${TOKEN}`)
  const reads = s.h.calls.filter(c => c.argv[0] === 'curl' && c.argv[c.argv.indexOf('-X') + 1] === 'GET')
  expect(reads.map(c => c.argv[c.argv.length - 1])).toEqual(['https://dev.azure.com/acme/_apis/connectionData?api-version=7.1-preview.1'])
  noToken(s)
  expect(o.text).not.toContain(TOKEN)
  const again = await approveAction(s.host, v.id, s.tell)
  expect(again.ok).toBe(false) // one approval, one vote
  expect(s.sends()).toHaveLength(1)
})

test('ado-pr-vote: when the identity cannot be read, nothing is written and the request stays unused', { timeoutMs: 20_000 }, async () => {
  for (const bad of [{ exitCode: 22, stdout: '', stderr: `HTTP 401 with ${TOKEN}` }, { exitCode: 0, stdout: JSON.stringify({ authenticatedUser: { id: 'not-a-guid' } }) }, { exitCode: 0, stdout: 'not json' }]) {
    const s = setup({ reads: url => (url.includes('connectionData') ? bad : null) })
    const v = await ask(s, 'ado-pr-vote', { ...BASE, vote: 'reject' })
    const o = await approve(s, v)
    expect(o.ok).toBe(false)
    expect(o.text).toContain('nothing was written')
    expect(o.text).not.toContain(TOKEN)
    expect(s.sends()).toHaveLength(0)
  }
})

test('ado-pr-vote: the own-PR default covers ONLY a reset on the owned PR; approve, approve-with-suggestions, reject and wait-for-author are asked, and so is a reset on another PR', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  for (const vote of ['approve', 'approve-with-suggestions', 'reject', 'wait-for-author']) {
    const r = await own(s, 'ado-pr-vote', { ...BASE, vote })
    expect([vote, r]).toEqual([vote, null])
  }
  expect(await own(s, 'ado-pr-vote', { ...BASE, pr: 9999, vote: 'reset' })).toBeNull() // not the owned PR
  expect(s.sends()).toHaveLength(0)
  const r = await own(s, 'ado-pr-vote', { ...BASE, vote: 'reset' })
  expect(r?.sent).toBe(true)
  expect(r?.line).toContain('vote "reset" (0)')
  expect(s.sends()).toHaveLength(1)
  const none = setup({ owns: false })
  expect(await own(none, 'ado-pr-vote', { ...BASE, vote: 'reset' })).toBeNull() // a thread without a PR of its own is always asked
  expect(none.sends()).toHaveLength(0)
})

// (more kinds below)
