// 1.0.31: a review's comments end with ONE vote item for the same PR (Azure DevOps ado-pr-vote wait-for-author, GitHub gh-pr-review): one request, one Approve, comments first and
// the vote only when a comment went out; the GitHub review executor (head commit read at send time, never an approval of the user's own PR); the severity word of each comment;
// the script that decides the vote. Canned curl / gh output ONLY: nothing is ever sent. Synthetic names.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { COMMENT_BATCH_MAX, addActionRequest, answerAction, approveAction, bindAnswers, checkAction, questionOf, renderingOf, resetActions } from './deskactions'
import { runOwnPr } from './ownpr'
import { lintReviewText } from './anchor'
import { checkOn, voteAdvice, voteLine, withSeverity } from './prvote'
import { resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const ME = '99999999-8888-7777-6666-555555555555'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const BASE = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321 }
const PRS = 'https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/4321'
const adoC = (n: number, extra: Record<string, unknown> = {}) => ({ kind: 'ado-pr-comment', params: { ...BASE, body: `The handler number ${n} drops the error.`, ...extra } })
const ghC = (n: number) => ({ kind: 'gh-pr-comment', params: { repo: 'acme/shop', pr: 7, body: `The helper number ${n} leaks the handle.` } })
const adoV = (vote = 'wait-for-author') => ({ kind: 'ado-pr-vote', params: { ...BASE, vote } })
const ghV = (event = 'request-changes', body: string | null = '2 comments: 1 blocking') => ({ kind: 'gh-pr-review', params: { repo: 'acme/shop', pr: 7, event, ...(body ? { body } : {}) } })
const batch = (items: unknown[]) => ({ kind: 'batch', params: { items } })

type World = { author: string; me: string; head: unknown; failComments: boolean; log: string[]; ghStdin: string[]; ghArgv: string[][] }
function setup(config: unknown = { actions: { holdSeconds: 0 } }, owns = false) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.clock.t = 1_000_000
  const pr = { host: 'azure', org: 'acme', project: 'Shop App', repo: 'shop-api', id: 4321, url: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api/pullrequest/4321', since: 500_000 }
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...(owns ? { pr } : {}) }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  h.files.set(`${L}/config.json`, JSON.stringify(config))
  const w: World = { author: 'someone-else', me: 'the-user', head: { sha: SHA }, failComments: false, log: [], ghStdin: [], ghArgv: [] }
  h.exec.handler = (argv, c) => {
    if (argv[0] === 'az') return { exitCode: 0, stdout: `${TOKEN}\n` }
    if (argv[0] === 'gh') {
      if (argv.includes('POST')) {
        w.ghArgv.push(argv)
        w.ghStdin.push(c.stdin ?? '')
        const url = argv.find(a => a.startsWith('repos/'))!
        w.log.push(`gh POST ${url}`)
        return url.endsWith('/reviews') || !w.failComments ? { exitCode: 0, stdout: JSON.stringify({ id: 5, html_url: 'https://github.com/acme/shop/pull/7#x' }) } : { exitCode: 1, stdout: '', stderr: 'HTTP 403' }
      }
      const path = argv.find(a => a.startsWith('repos/')) ?? 'user'
      if (path === 'user') return { exitCode: 0, stdout: JSON.stringify({ login: w.me }) }
      if (path === 'repos/acme/shop/pulls/7') return w.head ? { exitCode: 0, stdout: JSON.stringify({ head: w.head, user: { login: w.author } }) } : { exitCode: 1, stdout: '', stderr: 'HTTP 404' }
      return { exitCode: 1, stdout: '', stderr: 'unknown' }
    }
    if (argv[0] === 'curl') {
      const url = argv[argv.length - 1]!
      const method = argv[argv.indexOf('-X') + 1]
      if (method === 'GET') return url.includes('/_apis/connectionData') ? { exitCode: 0, stdout: JSON.stringify({ authenticatedUser: { id: ME } }) } : { exitCode: 1, stdout: '' }
      w.log.push(`${method} ${url.replace(PRS, '')}`)
      if (url.includes('/threads')) return w.failComments ? { exitCode: 22, stdout: '', stderr: 'HTTP 403' } : { exitCode: 0, stdout: JSON.stringify({ id: 700 }) }
      return { exitCode: 0, stdout: JSON.stringify({ id: 1 }) }
    }
    return { exitCode: 127, stdout: '', stderr: 'unknown' }
  }
  const told: string[] = []
  const tell = async (_t: string, text: string) => {
    told.push(text)
  }
  return { h, w, told, tell }
}
type S = ReturnType<typeof setup>
const ask = async (s: S, action: Record<string, unknown>) => {
  const r = await addActionRequest(s.h.host, 't5', { ...action, why: 'the review round' })
  expect(r.ok, r.text).toBe(true)
  return r.request!
}
const approve = async (s: S, v: Awaited<ReturnType<typeof ask>>) => {
  const q = questionOf(v)
  const qq = { question: q.question, options: q.options.map(o => ({ label: o.label, description: o.description })) }
  await bindAnswers(s.h.host, [qq], { [qq.question]: 'Approve' }, s.tell)
  return approveAction(s.h.host, v.id, s.tell)
}
const noToken = (s: S) => {
  for (const c of s.h.calls) expect(c.argv.join(' ')).not.toContain(TOKEN)
  expect([...s.h.files.values()].join('\n')).not.toContain(TOKEN)
}

// ---- 1 the batch: comments, then ONE vote item ----------------------------------------------------------------------------------------------
test('a batch of comments may end with exactly ONE vote item: 60 comments + 1; a second vote item, or a vote that is not last, over ten items is refused', () => {
  const comments = (n: number) => Array.from({ length: n }, (_, i) => adoC(i + 1))
  const ok = checkAction(batch([...comments(COMMENT_BATCH_MAX), adoV()]))
  expect(ok.ok).toBe(true)
  expect(checkAction(batch([...comments(COMMENT_BATCH_MAX + 1), adoV()])).ok).toBe(false) // 61 comments
  expect(checkAction(batch([...comments(COMMENT_BATCH_MAX), adoV(), adoV('reset')])).ok).toBe(false) // two votes over ten items
  expect(checkAction(batch([adoV(), ...comments(15)])).ok).toBe(false) // the vote must be last when the batch is a review of more than ten items
  const bad = checkAction(batch([...comments(COMMENT_BATCH_MAX), adoV(), adoV('reset')]))
  expect(!bad.ok && bad.text).toContain('may end with ONE vote item')
  const many = checkAction(batch([...comments(COMMENT_BATCH_MAX + 1), adoV()]))
  expect(!many.ok && many.text).toContain('at most 61 items (got 62')
  expect(checkAction(batch([adoC(1), adoC(2), adoV()])).ok).toBe(true)
  expect(checkAction(batch([adoC(1), ghV()])).ok).toBe(false) // another PR is another target
  expect(checkAction(batch([ghC(1), ghC(2), ghV()])).ok).toBe(true) // GitHub: comments + a review of the same PR
  expect(checkAction(batch([ghC(1), { ...ghV(), params: { ...ghV().params, pr: 8 } }])).ok).toBe(false)
})

test('the card and the question list the vote last ("then: set the PR to Waiting for author"); the hash covers every item in order', async () => {
  const s = setup()
  const v = await ask(s, batch([adoC(1), adoC(2), adoV()]))
  expect(v.headline).toContain('post 2 review comments, then set the PR to Waiting for author')
  expect(v.text.trimEnd().split('\n').pop()).toBe('then: set the PR to Waiting for author')
  expect(v.writes).toBe(3)
  const q = questionOf(v)
  expect(q.question).toContain('then: set the PR to Waiting for author')
  expect(q.question.indexOf('The handler number 2')).toBeLessThan(q.question.indexOf('then: set the PR'))
  const a = checkAction(batch([adoC(1), adoC(2), adoV()]))
  const b = checkAction(batch([adoC(1), adoC(2), adoV('reject')]))
  const c = checkAction(batch([adoC(2), adoC(1), adoV()]))
  const hashes = [a, b, c].map(x => (x.ok ? renderingOf(x.plan) : ''))
  expect(new Set(hashes).size).toBe(3)
})

test('Azure DevOps: one Approve sends the comments first, then the vote -5 as the identity the login belongs to; the token is never in argv or a file', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, batch([adoC(1), adoC(2), adoV()]))
  const r = await approve(s, v)
  expect(r.ok, r.text).toBe(true)
  expect(s.w.log).toEqual(['POST /threads?api-version=7.1', 'POST /threads?api-version=7.1', `PUT /reviewers/${ME}?api-version=7.1`])
  expect(r.text).toContain('3: done')
  noToken(s)
})

test('when every comment fails, the vote is NOT sent (and the request may be reported as failed)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  s.w.failComments = true
  const v = await ask(s, batch([adoC(1), adoC(2), adoV()]))
  const r = await approve(s, v)
  expect(r.ok).toBe(false)
  expect(s.w.log.some(l => l.startsWith('PUT'))).toBe(false)
  expect(r.text).toContain('3: not run (no comment of this request was posted, so the vote was not sent)')
})

test('the own-PR default and standing approvals never cover a vote: a comments + vote batch on the thread\'s own PR is still asked', { timeoutMs: 20_000 }, async () => {
  const s = setup(undefined, true)
  const made = await addActionRequest(s.h.host, 't5', { ...batch([adoC(1), adoV()]), why: 'the review round' })
  expect(made.ok, made.text).toBe(true)
  const r = await runOwnPr(s.h.host, made.request!.id)
  expect(r?.sent).toBeFalsy()
  await answerAction(s.h.host, made.request!.id, 'deny', 'pane')
  expect(s.w.log).toEqual([])
  const plain = await addActionRequest(s.h.host, 't5', { ...batch([adoC(1), adoC(2)]), why: 'the review round' })
  expect(plain.request?.standing).toBeFalsy() // comments alone never carry a standing approval either
})

// ---- 2 GitHub gh-pr-review --------------------------------------------------------------------------------------------------------------------
test('gh-pr-review: pulls/<n>/reviews with the event and the head placeholder; request-changes and comment need a body, approve may go without; other words are refused', () => {
  const c = checkAction(ghV())
  expect(c.ok && c.plan.url).toBe('https://api.github.com/repos/acme/shop/pulls/7/reviews')
  expect(c.ok && JSON.parse(c.plan.body)).toEqual({ event: 'REQUEST_CHANGES', commit_id: '<PR head commit>', body: '2 comments: 1 blocking' })
  expect(checkAction(ghV('approve', null)).ok).toBe(true)
  expect(checkAction(ghV('request-changes', null)).ok).toBe(false)
  expect(checkAction(ghV('comment', null)).ok).toBe(false)
  for (const event of ['merge', 'dismiss', 'REQUEST_CHANGES_NOW', '']) expect([event, checkAction(ghV(event)).ok]).toEqual([event, false])
  expect(checkAction({ kind: 'gh-pr-review', params: { repo: 'nope', pr: 7, event: 'comment', body: 'x' } }).ok).toBe(false)
  expect(checkAction({ kind: 'gh-pr-review', params: { repo: 'acme/shop', pr: 7, event: 'comment', body: 'x', commit_id: SHA } }).ok).toBe(false) // never a commit of its own
  expect(checkAction({ kind: 'gh-pr-review', params: { repo: 'acme/shop', pr: 7, event: 'Request Changes', body: 'x' } }).ok).toBe(true) // the words, any case
})

test('gh-pr-review: sent through gh api (argv, the body on stdin) with the head commit read NOW; after the comments in a batch', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  const v = await ask(s, batch([ghC(1), ghC(2), ghV()]))
  s.w.head = { sha: 'b'.repeat(40) } // a push between the request and the send: the NEW head is the commit named
  const r = await approve(s, v)
  expect(r.ok, r.text).toBe(true)
  expect(s.w.log).toEqual(['gh POST repos/acme/shop/issues/7/comments', 'gh POST repos/acme/shop/issues/7/comments', 'gh POST repos/acme/shop/pulls/7/reviews'])
  expect(JSON.parse(s.w.ghStdin[2]!)).toEqual({ event: 'REQUEST_CHANGES', commit_id: 'b'.repeat(40), body: '2 comments: 1 blocking' })
  expect(s.w.ghArgv[2]!.slice(0, 4)).toEqual(['gh', 'api', '--method', 'POST'])
  expect(s.w.ghArgv[2]!.join(' ')).not.toContain('blocking') // the text is on stdin only
  noToken(s)
})

test('gh-pr-review: an APPROVE of a PR the user wrote is refused (nothing written); another author\'s PR is approved only through the user\'s Approve; no head, nothing written', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  s.w.author = 'the-user'
  const mine = await ask(s, ghV('approve', null))
  const r = await approve(s, mine)
  expect(r.ok).toBe(false)
  expect(r.text).toContain('never approves your own PR')
  expect(s.w.log).toEqual([])
  const t = setup()
  const theirs = await ask(t, ghV('approve', null))
  expect((await approve(t, theirs)).ok).toBe(true)
  expect(JSON.parse(t.w.ghStdin[0]!)).toEqual({ event: 'APPROVE', commit_id: SHA })
  const u = setup()
  u.w.head = null
  const none = await ask(u, ghV())
  const bad = await approve(u, none)
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('could not read the head commit')
  expect(u.w.log).toEqual([])
  // request-changes on the user's own PR is allowed to be sent (only an approval of own work is refused)
  const w = setup()
  w.w.author = 'the-user'
  expect((await approve(w, await ask(w, ghV()))).ok).toBe(true)
})

test('an approval is not sent when the gh login cannot be read (it could be the user\'s own PR)', { timeoutMs: 20_000 }, async () => {
  const s = setup()
  s.w.me = ''
  const r = await approve(s, await ask(s, ghV('approve', null)))
  expect(r.ok).toBe(false)
  expect(r.text).toContain('an approval is not sent without knowing')
  expect(s.w.log).toEqual([])
})

// ---- 4b the severity word ---------------------------------------------------------------------------------------------------------------------
test('severity: the word of the finding starts the comment text (added when missing, kept when there); an unknown word is refused; config off leaves the text', async () => {
  expect(withSeverity('The handler drops the error.', 'blocker')).toBe('blocking: The handler drops the error.')
  expect(withSeverity('The handler drops the error.', 'nit')).toBe('nit: The handler drops the error.')
  expect(withSeverity('minor: already there', 'major')).toBe('minor: already there')
  expect(withSeverity('Anything.', 'banana')).toBe('Anything.')
  const c = checkAction(adoC(1, { severity: 'major' }))
  expect(c.ok && c.params.body).toBe('major: The handler number 1 drops the error.')
  expect(c.ok && 'severity' in c.params).toBe(false) // consumed: the stored request holds the final text
  expect(checkAction(adoC(1, { severity: 'banana' })).ok).toBe(false)
  const g = checkAction({ kind: 'gh-pr-review-comment', params: { repo: 'acme/shop', pr: 7, body: 'The key is logged.', file: 'src/a.ts', line: 4, severity: 'blocker' } })
  expect(g.ok && JSON.parse(g.plan.body).body).toBe('blocking: The key is logged.')
  expect(checkAction(adoC(1, { severity: 'question' }), { severity: false }).ok && (checkAction(adoC(1, { severity: 'question' }), { severity: false }) as any).params.body).toBe('The handler number 1 drops the error.')
  expect(lintReviewText('minor: LGTM')).toContain('only an approval phrase') // the word in front does not make a disclaimer a comment
  const s = setup({ actions: { holdSeconds: 0 }, review: { prChecks: { severity: false } } })
  const v = await ask(s, adoC(1, { severity: 'major' }))
  expect(v.text).toContain('The handler number 1 drops the error.')
  expect(v.text.startsWith('major:')).toBe(false)
})

// ---- the script that decides the vote ----------------------------------------------------------------------------------------------------------
test('voteAdvice: a posted blocking / major / minor comment, or a gate that is not green, means waiting for author; green with no ask proposes approve (asked) or nothing for the author', () => {
  expect(voteAdvice(['blocker', 'minor', 'nit'], true, false)).toMatchObject({ vote: 'wait-for-author', summary: '3 comments: 1 blocking' })
  expect(voteAdvice(['nit'], false, false).vote).toBe('wait-for-author') // not green
  expect(voteAdvice([], false, false)).toMatchObject({ vote: 'wait-for-author', summary: '0 comments: 0 blocking' })
  expect(voteAdvice(['nit', 'question'], true, false).vote).toBe('approve')
  expect(voteAdvice([], true, false).vote).toBe('approve')
  expect(voteAdvice([], true, true).vote).toBe('none') // the user wrote the PR
  expect(voteAdvice(['major'], true, true).vote).toBe('wait-for-author')
  expect(voteLine(voteAdvice(['major'], true, false))).toContain('ado-pr-vote vote wait-for-author')
  expect(voteLine(voteAdvice(['major'], true, false))).toContain('gh-pr-review event request-changes with body "1 comment: 0 blocking"')
  expect(voteLine(voteAdvice([], true, false))).toContain('never approve by yourself')
  expect(voteLine(voteAdvice([], true, true))).toContain('none')
})

test('config switches: false turns a group off, an object turns single checks off, unset is on', () => {
  expect(checkOn({}, 'review', 'severity')).toBe(true)
  expect(checkOn({ review: { prChecks: false } }, 'review', 'size')).toBe(false)
  expect(checkOn({ review: { prChecks: { severity: false } } }, 'review', 'size')).toBe(true)
  expect(checkOn({ pr: { checks: { secrets: false } } }, 'pr', 'secrets')).toBe(false)
  expect(checkOn({ pr: { checks: { secrets: false } } }, 'pr', 'guide')).toBe(true)
  expect(checkOn(null, 'pr', 'force')).toBe(true)
})
