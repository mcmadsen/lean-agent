import { expect, test } from 'claude-code/testing'
import { fakeHost, withSha } from './fake'
import { auditFromReply, auditorPromptProblem, briefBlock, markAuditStarted, scriptTool, waitingForVerdict } from './scripts'
import type { Who } from './scripts'
import { resetLocks } from './threads'

// A script audit's verdict used to be recorded only from the auditor's own Agent reply; a background auditor returns before it has one.
// record-audit passes the LEAN-AUDIT fields on as a tool call; decide falls back to the audit thread's report; one audit thread per text.
const T: Who = { kind: 'thread', id: 't1' }
const T9: Who = { kind: 'thread', id: 't9' }
const D: Who = { kind: 'desk' }
const SRC = '/tmp/w/count.py'
const CLEAN = 'import sys\nprint(sum(1 for _ in open(sys.argv[1])))\n'
const CAND = '/h/.lean-agent/scripts/candidates/count-lines'
const DIR = '/h/.lean-agent/proj/scripts/count-lines'

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'proj', state: 'open' }))
  h.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ id: 't2', project: 'other', state: 'open' }))
  h.files.set('/h/.lean-agent/threads/t9/thread.json', JSON.stringify({ id: 't9', project: 'proj', state: 'open' }))
  h.files.set(SRC, CLEAN)
  return h
}
const prop = (h: any, o: any = {}) => scriptTool(h.host, T, { action: 'propose', name: 'count-lines', path: SRC, purpose: 'Count the lines of a file', run: 'python3 {script} <file>', inputs: ['a file path'], outputs: ['stdout'], ...o })
const fields = (o: any = {}) => ({ name: 'count-lines', verdict: 'adopt', reads: ['argv[1]'], writes: [], network: false, deletes: false, secrets: false, hardcoded: [], deterministic: true, errors_handled: true, generalises: true, changes: [], reason: 'plain line count', ...o })
const line = (o: any = {}) => `LEAN-AUDIT ${JSON.stringify(fields(o))}`
const brief = async (h: any, who: Who = T) => briefBlock((await scriptTool(h.host, who, { action: 'audit', name: 'count-lines' })).text)
const meta = (h: any, dir = CAND) => JSON.parse(h.files.get(`${dir}/meta.json`))
const shaOf = (h: any) => meta(h).sha256 as string
const started: string[] = []
const io = (h: any, id = 't9') => ({
  startThread: async (title: string) => {
    started.push(title)
    h.files.set(`/h/.lean-agent/threads/${id}/thread.json`, JSON.stringify({ id, project: 'proj', state: 'open' }))
    return { ok: true, text: `${id} started`, data: { id } }
  },
})
const record = (h: any, who: Who, o: any = {}) => scriptTool(h.host, who, { action: 'record-audit', ...fields(o), ...o, sha: o.sha ?? shaOf(h) })
const inbox = (h: any, from: string, text: string) => h.files.set('/h/.lean-agent/desk/inbox.jsonl', `${h.files.get('/h/.lean-agent/desk/inbox.jsonl') ?? ''}${JSON.stringify({ ts: 5, from, kind: 'report', state: 'done', text })}\n`)

test('foreground: the verdict is recorded from the auditor\'s reply; `show` says the audit is waiting for the verdict until then', async () => {
  const h = setup()
  await prop(h)
  expect(JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text).verdict).toBe('unaudited') // not started
  const b = await brief(h)
  expect((await scriptTool(h.host, T, { action: 'audit', name: 'count-lines' })).text).toContain('Audit started; verdict not recorded yet')
  expect(await markAuditStarted(h.host, 't1', b)).toBe(true) // the thread's Agent call with the exact brief
  expect(waitingForVerdict(meta(h))).toBe(true)
  expect(JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text).verdict).toBe('audited, waiting for the verdict')
  expect(await auditFromReply(h.host, 't1', await withSha(h.host, line()), b)).toContain('adopted')
  expect(meta(h, DIR).audit).toMatchObject({ verdict: 'adopt', by: 't1' })
  expect(meta(h, DIR).audit.via).toBeUndefined()
  expect(JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text).verdict).toBe('adopt')
  // any other prompt is not an audit that started
  const h2 = setup()
  await prop(h2)
  expect(await markAuditStarted(h2.host, 't1', 'audit count-lines please')).toBe(false)
  expect(meta(h2).auditing).toBeUndefined()
})

test('the desk\'s audit starts ONE audit thread per text, says the verdict is not recorded yet, and starts none while it runs', async () => {
  const h = setup()
  await prop(h)
  started.length = 0
  const first = await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h))
  expect(first.ok).toBe(true)
  expect(first.text).toContain('started in a thread: t9 started')
  expect(first.text).toContain('Audit started; verdict not recorded yet')
  expect(meta(h).auditing).toMatchObject({ sha: shaOf(h), thread: 't9' })
  const second = await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h))
  expect(second.text).toContain('already running in t9: no second audit thread was started')
  expect(second.text).toContain('Audit started; verdict not recorded yet')
  expect(started).toEqual(['audit script count-lines']) // one thread
  // the audit thread finished or was closed: a new audit may start one
  h.files.set('/h/.lean-agent/threads/t9/thread.json', JSON.stringify({ id: 't9', project: 'proj', state: 'open', finished: 1 }))
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h, 't10'))
  expect(started).toHaveLength(2)
  expect(meta(h).auditing.thread).toBe('t10')
  // a thread that did not start leaves nothing claimed
  const g = setup()
  await prop(g)
  const bad = await scriptTool(g.host, D, { action: 'audit', name: 'count-lines' }, { startThread: async () => ({ ok: false, text: 'claude --bg failed' }) })
  expect(bad.ok).toBe(false)
  expect(meta(g).auditing).toBeUndefined()
  // t10 is still working on it: a third audit starts nothing
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h, 't11'))
  expect(started).toHaveLength(2)
})

test('background hand-back: the audit thread passes the LEAN-AUDIT fields on with record-audit and the mod records and applies its rules', async () => {
  const h = setup()
  await prop(h)
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h))
  const b = await brief(h, T9)
  expect(await markAuditStarted(h.host, 't9', b)).toBe(true) // t9's Agent call (it ran in the background: no reply with a verdict)
  const out = await record(h, T9)
  expect(out.ok).toBe(true)
  expect(out.text).toContain('adopted')
  expect(out.text).toContain('recorded through record-audit')
  const m = meta(h, DIR)
  expect(m.status).toBe('adopted')
  expect(m.audit).toMatchObject({ verdict: 'adopt', by: 't9', via: 'record-audit', sha: m.sha256 })
  // the mod's rules still apply: the network flag is never adopt
  const n = setup()
  await prop(n)
  await markAuditStarted(n.host, 't1', await brief(n))
  const net = await record(n, T, { network: true })
  expect(net.ok).toBe(true)
  expect(net.text).toContain('adapt')
  expect(meta(n).audit).toMatchObject({ claimed: 'adopt', verdict: 'adapt', network: true, via: 'record-audit' })
  expect(n.files.has(`${DIR}/meta.json`)).toBe(false)
  // an adapt needs its changes, a reject its reason, as for a reply
  const a = setup()
  await prop(a)
  await markAuditStarted(a.host, 't1', await brief(a))
  expect((await record(a, T, { verdict: 'adapt', changes: [] })).text).toContain('needs the concrete changes')
  expect((await record(a, T, { verdict: 'reject', reason: '' })).text).toContain('needs a reason')
})

test('record-audit is refused: a wrong or missing sha, no auditor started, a caller that is not allowed, an incomplete answer, a second record', async () => {
  const h = setup()
  await prop(h)
  // no auditor was started: the mod saw nothing to record a verdict for (a thread cannot just assert one)
  expect((await record(h, T)).text).toContain('saw no auditor start')
  expect((await record(h, D)).text).toContain('saw no auditor start')
  expect(h.files.has(`${DIR}/meta.json`)).toBe(false)
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h)) // the desk started an audit thread: still no auditor call seen
  expect((await record(h, T9)).text).toContain('saw no auditor start')
  await markAuditStarted(h.host, 't9', await brief(h, T9))
  // a wrong sha: refused, nothing recorded
  for (const sha of ['0'.repeat(64), shaOf(h).slice(0, 8), '']) {
    const r = await scriptTool(h.host, T9, { action: 'record-audit', ...fields(), sha })
    expect(r.ok, sha).toBe(false)
    expect(r.text, sha).toMatch(/sha256|needs sha/)
  }
  expect(meta(h).audit).toBeUndefined()
  // a thread that is neither the auditor's starter nor its audit thread (another project's, or the author when it did not start it)
  expect((await record(h, { kind: 'thread', id: 't2' })).text).toContain('belongs to project')
  h.files.set('/h/.lean-agent/threads/t5/thread.json', JSON.stringify({ id: 't5', project: 'proj', state: 'open' }))
  expect((await record(h, { kind: 'thread', id: 't5' })).text).toContain('only the thread that started the auditor')
  // an unanswered flag, no name, no verdict
  expect((await scriptTool(h.host, T9, { action: 'record-audit', ...fields({ network: undefined }), sha: shaOf(h) })).text).toContain('audit incomplete')
  expect((await record(h, T9, { verdict: 'maybe' })).text).toContain('adopt, adapt or reject')
  expect((await scriptTool(h.host, T9, { action: 'record-audit', sha: shaOf(h) })).text).toContain('needs name')
  // the text changed since the audit started: the sha no longer matches the stored text
  h.files.set(`${CAND}/count.py`, `${CLEAN}# edited\n`)
  expect((await record(h, T9)).text).toContain('changed since it was proposed')
  h.files.set(`${CAND}/count.py`, CLEAN)
  // the right call is recorded once; a second one is refused (one audit per content)
  const sha = shaOf(h)
  expect((await record(h, T9, { sha })).ok).toBe(true)
  expect((await record(h, T9, { sha })).ok).toBe(false)
  // the desk may record it too
  const d = setup()
  await prop(d)
  await markAuditStarted(d.host, 't1', await brief(d))
  expect((await record(d, D)).text).toContain('adopted')
  expect(meta(d, DIR).audit.by).toBe('desk')
})

test('decide falls back to the audit thread\'s last report for that sha when the store has no verdict, and says so; the network flag still needs confirm', async () => {
  const h = setup()
  await prop(h)
  expect((await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so' })).text).toContain('never audited') // nothing started, nothing to fall back to
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h))
  // an audit was started, no report yet
  expect((await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so' })).text).toContain('an audit was started and its verdict has not been recorded')
  // a report of ANOTHER thread, another script, a wrong sha: ignored
  inbox(h, 't5', `done\n${await withSha(h.host, line())}`)
  inbox(h, 't9', `done\n${await withSha(h.host, line({ name: 'other-script' }))}`)
  inbox(h, 't9', `done\nLEAN-AUDIT ${JSON.stringify({ ...fields(), sha: '0'.repeat(64) })}`)
  expect((await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so' })).text).toContain('was never audited')
  expect(meta(h).audit).toBeUndefined()
  // the audit thread's report with the LEAN-AUDIT line for this sha
  inbox(h, 't9', `audit finished\n${await withSha(h.host, line())}`)
  const out = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so', sha: shaOf(h) })
  expect(out.ok).toBe(true)
  expect(out.text).toContain("verdict taken from the audit thread's report t9")
  const m = meta(h, DIR)
  expect(m.status).toBe('adopted')
  expect(m.audit).toMatchObject({ by: 't9', via: 'thread-report', verdict: 'adopt' })
  expect(m.history.map((x: any) => x.what).join('\n')).toContain("verdict taken from the audit thread's report")
  const log = (h.files.get('/h/.lean-agent/scripts/decisions.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(log[log.length - 1]).toMatchObject({ name: 'count-lines', value: 'adopt', note: "verdict taken from the audit thread's report" })
})

test('decide fallback: a report with the network flag needs the user\'s explicit adopt; the last report for the sha wins; reject needs no verdict at all', async () => {
  const h = setup()
  await prop(h)
  await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, io(h))
  inbox(h, 't9', `done\n${await withSha(h.host, line({ network: true }))}`)
  const d = { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so' }
  const refused = await scriptTool(h.host, D, d)
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('overrides the audit')
  expect(refused.text).toContain('uses the network')
  expect(h.files.has(`${DIR}/meta.json`)).toBe(false)
  const done = await scriptTool(h.host, D, { ...d, confirm: true })
  expect(done.ok).toBe(true)
  expect(meta(h, DIR).decision).toMatchObject({ value: 'adopt', by: 'user' })
  expect(meta(h, DIR).decision.overrode.join(' ')).toContain('uses the network')
  // a later report for the same sha replaces an earlier one
  const k = setup()
  await prop(k)
  await scriptTool(k.host, D, { action: 'audit', name: 'count-lines' }, io(k))
  inbox(k, 't9', `first\n${await withSha(k.host, line({ network: true }))}`)
  inbox(k, 't9', `second\n${await withSha(k.host, line())}`)
  expect((await scriptTool(k.host, D, d)).ok).toBe(true) // the clean one: no confirm needed
  // reject never needs a verdict
  const r = setup()
  await prop(r)
  expect((await scriptTool(r.host, D, { ...d, verdict: 'reject' })).ok).toBe(true)
})

test('an auditor prompt is still only the brief the mod generated (record-audit adds nothing to it)', async () => {
  const h = setup()
  await prop(h)
  const b = await brief(h)
  expect(await auditorPromptProblem(h.host, b)).toBeNull()
  expect(b).not.toContain('record-audit') // the thread-facing instruction is outside the block; the auditor is never asked to call a tool
  expect((await scriptTool(h.host, T, { action: 'audit', name: 'count-lines' })).text).toContain('lean_script record-audit')
})
