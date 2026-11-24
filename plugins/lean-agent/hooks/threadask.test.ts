// Answers from the store (threadask.ts through lean_thread): find, ask (the store by script, else a FRESH small session), report.
// Synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { askText, findText, reportText, storeLines } from './threadask'
import { leanThread, resetLocks } from './threads'
import { resetFinish } from './finish'
import { resetThreadCache } from './threaddetail'

const ROOT = '/p'
const L = '/h/.lean-agent'
const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'

function setup() {
  resetLocks()
  resetFinish()
  resetThreadCache()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'fix login redirect', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'medium' }))
  h.files.set(`${L}/threads/t1/brief.md`, 'fix the login redirect\n')
  h.files.set(`${L}/threads/t1/notes.md`, 'decided to keep the cookie name\nTODO: rename the helper\n')
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'docs sweep', project: 'site', state: 'parked', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'login redirect works on mobile' } }))
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { path: '/w/app', branch: 'fix-login-redirect', thread: 't1' } }))
  h.files.set(`${L}/memory/notes.jsonl`, rec({ from: 't1', text: 'the staging site needs the VPN' }))
  h.files.set(`${L}/desk/inbox.jsonl`, rec({ ts: 100, from: 't1', kind: 'report', state: 'working', text: 'opened PR 42 for the redirect\nreview pending' }) + rec({ ts: 200, from: 't1', kind: 'ask', text: 'which cookie domain should the redirect use?' }) + rec({ ts: 300, from: 't2', kind: 'report', state: 'done', text: 'docs done, see PR 77' }) + rec({ ts: 400, from: 't1', kind: 'report', state: 'checkpoint', mod: true, text: 'context 205k over the limit' }))
  return h
}

test('find: matching lines with the thread id and the source file; AND over the words', async () => {
  const h = setup()
  const pr = await leanThread(h.host, ROOT, { action: 'find', text: 'PR 42' })
  expect(pr.ok).toBe(true)
  expect(pr.text).toContain('find "PR 42": 1 line(s) in 1 thread(s)')
  expect(pr.text).toContain('t1  desk/reports/100-t1-report.md: opened PR 42 for the redirect')
  const branch = await leanThread(h.host, ROOT, { action: 'find', text: 'fix-login-redirect' })
  expect(branch.text).toContain('t1  worktrees.json: path: /w/app · branch: fix-login-redirect · thread: t1')
  const project = (await leanThread(h.host, ROOT, { action: 'find', text: 'site' })).text
  expect(project).toContain('t2  threads/t2/thread.json: title: docs sweep · project: site · state: parked')
  expect(project).toContain('t1  memory/items.json: remembered: the staging site needs the VPN') // (the old note is imported into the one memory store)
  const goal = (await leanThread(h.host, ROOT, { action: 'find', text: 'mobile' })).text
  expect(goal).toContain('t1  goals.json: goal: login redirect works on mobile')
  expect((await leanThread(h.host, ROOT, { action: 'find', text: 'cookie' })).text).toContain('t1  threads/t1/notes.md: decided to keep the cookie name')
  expect((await leanThread(h.host, ROOT, { action: 'find', text: 'redirect nowhere' })).text).toContain('nothing matches')
  expect((await leanThread(h.host, ROOT, { action: 'find', text: '  ' })).ok).toBe(false)
})

test('find: a mod record is not a report, and no model runs', async () => {
  const h = setup()
  expect((await findText(h.host, '/h', 'over the limit')).text).toContain('nothing matches')
  expect((await storeLines(h.host, '/h')).some(l => l.text.includes('over the limit'))).toBe(false)
  expect(h.claudeCalls()).toEqual([])
})

test('ask: answered from the store by script when lines match; no session is started', async () => {
  const h = setup()
  const r = await leanThread(h.host, ROOT, { action: 'ask', tN: 't1', text: 'which cookie domain does the redirect use?' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('t1 (from the store, by script; no model)')
  expect(r.text).toContain('desk/reports/200-t1-ask.md: [question] which cookie domain should the redirect use?')
  expect((r.data as any).source).toBe('store')
  expect(h.claudeCalls()).toEqual([])
  // another thread's lines are not used
  const other = await askText(h.host, '/h', 't2', 'what happened with PR 42 redirect?', { run: async () => ({ ok: true, text: 'x' }) })
  expect((other.data as any).source).toBe('fresh')
})

test('ask: no matching line starts a FRESH small session (haiku / low) with the handover and the question; never a resume', async () => {
  const h = setup()
  h.claude.handler = (a: string[]) => (a[0] === '-p' ? { exitCode: 0, stdout: 'The deploy key is in the vault.\n' } : { exitCode: 0, stdout: '' })
  const r = await leanThread(h.host, ROOT, { action: 'ask', tN: 't1', text: 'zebra quantum entanglement' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('fresh haiku/low session with the handover')
  expect(r.text).toContain('the old session was not touched')
  expect(r.text).toContain('The deploy key is in the vault.')
  const calls = h.claudeCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--effort', 'low'])
  expect(calls[0]!.some(x => x === '--resume' || x === '--bg')).toBe(false)
  // a fresh session with no limits would be a tool-capable session fed untrusted notes: no tools, no MCP, no skills, not saved, a budget
  for (const f of ['--tools', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-budget-usd']) expect(calls[0]).toContain(f)
  expect(calls[0]![calls[0]!.indexOf('--tools') + 1]).toBe('')
  const prompt = calls[0]![calls[0]!.length - 1]!
  expect(prompt).toContain('Question: zebra quantum entanglement')
  expect(prompt).toContain('--- handover of t1 ---')
  expect(prompt).toContain('Resume the work now') // the handover (task first)
  expect(h.calls.find(c => c.argv[0] === 'claude')?.cwd).toBe(`${L}/desk/ask`) // a neutral folder, never the thread's own
  // config ask.model / ask.effort
  h.files.set(`${L}/config.json`, JSON.stringify({ ask: { model: 'sonnet', effort: 'medium' } }))
  await askText(h.host, '/h', 't1', 'zebra quantum entanglement')
  expect(h.claudeCalls()[1]!.slice(0, 5)).toEqual(['-p', '--model', 'sonnet', '--effort', 'medium'])
})

test('ask: a failing small session is a clear error; unknown thread and empty question', async () => {
  const h = setup()
  h.claude.handler = () => ({ exitCode: 1, stdout: '', stderr: 'boom' })
  const r = await leanThread(h.host, ROOT, { action: 'ask', tN: 't1', text: 'zebra quantum entanglement' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('no line of the store matches and the small session (haiku/low) failed: boom')
  expect((await leanThread(h.host, ROOT, { action: 'ask', tN: 't9', text: 'x y z' })).text).toBe('no thread t9')
  expect((await leanThread(h.host, ROOT, { action: 'ask', tN: 't1', text: ' ' })).ok).toBe(false)
  expect((await leanThread(h.host, ROOT, { action: 'ask', text: 'q' })).text).toBe('ask needs tN (like t3)')
})

test('report: a script summary (state, sha, verdict, open questions, counts, path of the full text), not the prose', async () => {
  const h = setup()
  h.files.set(`${L}/threads/t1/state.json`, JSON.stringify({ v: 1, id: 't1', at: 9_000_000, sid: 's1', dir: '/w/app', branch: 'fix-login-redirect', head: 'abc1234567890def', status: [' M a.ts'], diffStat: '', edited: [], tasks: [], lastReport: null, questions: [], tokens: 98_000 }))
  h.files.set(`${L}/threads/t1/context.json`, JSON.stringify({ tokens: 98_000, at: 9_000_000, sid: 's1' }))
  const r = await leanThread(h.host, ROOT, { action: 'report', tN: 't1' })
  expect(r.ok).toBe(true)
  const lines = r.text.split('\n')
  expect(lines[0]).toMatch(/^t1 \(fix login redirect\): open · last report working \d+ min ago$/)
  expect(lines[1]).toBe('sha: abc1234567 on fix-login-redirect · review: none for this sha · tree: 1 changed file(s)')
  expect(lines[2]).toMatch(/^open questions: 1 \(latest: which cookie domain should the redirect use\?\) · reports: 1 · questions asked: 1 · context /)
  expect(lines[3]).toBe(`full text: ${L}/desk/inbox.jsonl (the row with ts 200)`)
  expect(r.text).not.toContain('review pending') // the prose of the report is not in it
  expect(r.data).toMatchObject({ state: 'open', sha: 'abc1234567890def', open: 1, reports: 1, asks: 1 })
  // the full text file, when the desk wrote one, is the path
  h.files.set(`${L}/desk/reports/200-t1-ask.md`, '# Question')
  expect((await reportText(h.host, '/h', 't1')).text).toContain(`full text: ${L}/desk/reports/200-t1-ask.md`)
  // no snapshot yet, no report yet
  const t2 = (await leanThread(h.host, ROOT, { action: 'report', tN: 't2' })).text
  expect(t2).toContain('t2 (docs sweep): parked · last report done')
  expect(t2).toContain('sha: unknown · review: unknown (no snapshot yet)')
  expect((await leanThread(h.host, ROOT, { action: 'report', tN: 't9' })).text).toBe('no thread t9')
})
