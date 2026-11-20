// A done report is checked by script (donecheck.ts, delivery.ts threadTool): synthetic ids, names and paths only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { outputClaims, missingOutputs } from './donecheck'
import { threadTool } from './delivery'
import { sweepFinished, resetFinish } from './finish'

const L = '/h/.lean-agent'
const INBOX = `${L}/desk/inbox.jsonl`
const inbox = (h: any) => (h.files.get(INBOX) ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

test('outputClaims: absolute or ~/ paths with an extension after saved/written/at/in or in backticks; URLs and gone files are not claims', () => {
  const c = (t: string) => outputClaims(t, '/h')
  expect(c('done, draft saved at ~/Downloads/draft.md')).toEqual(['/h/Downloads/draft.md'])
  expect(c('written to /tmp/out/summary.csv.')).toEqual(['/tmp/out/summary.csv'])
  expect(c('see `/srv/x/report.pdf` and `~/notes.txt`')).toEqual(['/srv/x/report.pdf', '/h/notes.txt'])
  expect(c('created the file in /h/.lean-agent/worktrees/app/docs/guide.md (new)')).toEqual(['/h/.lean-agent/worktrees/app/docs/guide.md'])
  expect(c('docs at https://example.org/docs/guide.md and http://x.test/a/b.pdf')).toEqual([])
  expect(c('removed /src/old/legacy.ts and deleted `/src/old/util.ts`')).toEqual([])
  expect(c('no extension: saved at /tmp/out/dir and ~/Downloads/')).toEqual([])
  expect(c('the tests pass; nothing was written')).toEqual([])
  expect(c('merged branch fix/x into /srv/x/main.ts')).toEqual(['/srv/x/main.ts']) // (a path after "in/into" is a claim: it must exist)
  expect(c('saved at ~/a.md, ~/a.md and ~/b.md')).toEqual(['/h/a.md', '/h/b.md'])
})

test('missingOutputs: an existing file (also under the lean home or a worktree) passes; a missing one is named; a file git tracks as deleted is no claim', async () => {
  const h = fakeHost(null)
  h.files.set('/h/Downloads/draft.md', '# draft')
  h.files.set(`${L}/worktrees/app/docs/guide.md`, 'x')
  expect(await missingOutputs(h.host, 'draft saved at ~/Downloads/draft.md and written to /h/.lean-agent/worktrees/app/docs/guide.md')).toEqual([])
  expect(await missingOutputs(h.host, 'draft saved at ~/Downloads/other.md')).toEqual(['/h/Downloads/other.md'])
  // a tracked file the diff deleted, named in a diff summary
  h.files.set('/h/repo/src/keep.ts', 'k')
  h.git.handler = (a: string[]) => (a.includes('status') ? { exitCode: 0, stdout: ' D /h/repo/src/old.ts\n' } : { exitCode: 0, stdout: '' })
  expect(await missingOutputs(h.host, 'cleanup in `/h/repo/src/old.ts`, kept `/h/repo/src/keep.ts`')).toEqual([])
  h.git.handler = (a: string[]) => (a.includes('log') ? { exitCode: 0, stdout: 'abc1234\n' } : { exitCode: 0, stdout: '' }) // deleted in a commit
  expect(await missingOutputs(h.host, 'cleanup in `/h/repo/src/old.ts`')).toEqual([])
  h.git.handler = () => ({ exitCode: 1, stdout: '' }) // git cannot say: missing stays missing
  expect(await missingOutputs(h.host, 'cleanup in `/h/repo/src/old.ts`')).toEqual(['/h/repo/src/old.ts'])
})

test('lean_report done with a missing output: refused with the exact line, recorded in the refusal record, nothing reaches the desk inbox; the auto-close finds no done report', async () => {
  resetFinish()
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'app', state: 'open', sid: 'sid1', created: 1, lastWake: 1, delivered: 0 }))
  const r = await threadTool(h.host, 't1', 'lean_report', { text: 'done, draft saved at ~/Downloads/draft.md', state: 'done' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain("not done: /h/Downloads/draft.md does not exist; write it (a worker's 'written' is not proof) or drop the claim")
  expect(inbox(h)).toEqual([])
  const ref = (h.files.get(`${L}/refusals.jsonl`) ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(ref).toHaveLength(1)
  expect(ref[0]).toMatchObject({ role: 'thread', rule: 'done-output-missing', kind: 'refusal', thread: 't1' })
  expect(ref[0].text).toContain('/h/Downloads/draft.md does not exist')
  let ran = 0
  expect(await sweepFinished(h.host, async () => (ran++, { ok: true, text: '' }))).toEqual([])
  expect(ran).toBe(0)
  // a working report naming the same path is not a done report: no check
  expect((await threadTool(h.host, 't1', 'lean_report', { text: 'will save at ~/Downloads/draft.md', state: 'working' })).ok).toBe(true)
  // the file exists now: the done report counts, and the auto-close sees it
  h.files.set('/h/Downloads/draft.md', '# draft')
  const ok = await threadTool(h.host, 't1', 'lean_report', { text: 'done, draft saved at ~/Downloads/draft.md', state: 'done' })
  expect(ok.ok).toBe(true)
  expect(inbox(h).filter((x: any) => x.state === 'done')).toHaveLength(1)
  expect(await sweepFinished(h.host, async () => (ran++, { ok: true, text: '', data: { finished: true } }))).toEqual(['t1'])
  expect(ran).toBe(1)
})
