import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { blockedTruth, broadBrief, classifierDenial, noPromptText, withoutPress } from './denial'

const HAIKU = 'lean-agent:worker-haiku'
const REAL = (cat: string, more = '') => `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [${cat}]. ${more}If you believe this is wrong, ask the user.`
const WT = '/h/.lean-agent/worktrees/proj/t1-fix'

test('the matcher takes the classifier\'s real text for any reason category, whatever the reason says, and never our own refusals', () => {
  expect(classifierDenial(REAL('Destructive or Unwanted Actions'))).toEqual({ category: 'Destructive or Unwanted Actions' })
  expect(classifierDenial(REAL('Undermining Oversight'))).toEqual({ category: 'Undermining Oversight' })
  expect(classifierDenial(REAL('Some New Category'))).toEqual({ category: 'Some New Category' })
  // the reason itself may name lean-agent (the 1.0.18 filter threw such a text away)
  expect(classifierDenial(REAL('Undermining Oversight', 'The agent edits files under ~/.lean-agent/worktrees, lean-agent state. '))?.category).toBe('Undermining Oversight')
  expect(classifierDenial([{ type: 'text', text: REAL('Undermining Oversight') }])?.category).toBe('Undermining Oversight')
  expect(classifierDenial('Permission denied by the auto mode classifier')).toEqual({ category: 'unspecified' })
  expect(classifierDenial('lean-agent: at most 4 workers at once; the permission check refused (lean-agent 1.0.25)')).toBeNull()
  expect(classifierDenial('one step for a small worker: lean-agent:worker-haiku (lean-agent 1.0.25)')).toBeNull()
  expect(classifierDenial('it failed: file not found')).toBeNull()
  expect(classifierDenial('')).toBeNull()
})

test('a script check of the denied brief: more than 3 files / folders, "all", "every", "remove ... across" say it is broad, with the counts', () => {
  expect(broadBrief('edit /w/src/a.ts and its spec /w/src/a.test.ts; run npm test')).toBe('')
  const b = broadBrief('Remove all legacy code across packages/a packages/b packages/c docs/x.md docs/y.md')
  expect(b).toContain('this brief is broad: split it')
  expect(b).toContain('names 5 files or folders')
  expect(b).toContain('"all"')
  expect(b).toContain('"Remove all"')
  expect(broadBrief('delete the flag everywhere')).toContain('this brief is broad')
})

test('the thread\'s own words that tell the user to press Open are cut from a denial report', () => {
  expect(withoutPress('Worker denied. Needs the user\'s yes in t1\'s own session; press Open t1 in the pane. Path: a.ts')).not.toMatch(/Open|yes/)
})

// ---- through the engine (register.tsx) --------------------------------------------------------------------------------------------
async function session($: any, on: any, reply: (e: any) => any) {
  const h = fakeHost(on, { orchestrate: true })
  on('classic.SubagentStop', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('tool.call', (_: any, e: any) => ({ result: reply(e) }) as any)
  resetLocks()
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'proj/fix': { path: WT, repo: '/h/proj', branch: 'fix', thread: 't1' }, 'proj/other': { path: '/h/.lean-agent/worktrees/proj/other', repo: '/h/proj', branch: 'other', thread: 't2' } }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}
const refusalRows = (h: any) => (h.files.get('/h/.lean-agent/refusals.jsonl') ?? '').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
const agent = (type = HAIKU, prompt = 'job: edit\nin the worktree, remove the old flag from the settings module and update its spec') => ({ tool: 'Agent', subagent_type: type, prompt, toolUseId: 'u1' }) as any
const denyResult = (cat: string) => ({ isError: true, content: [{ type: 'text', text: REAL(cat, 'It touches ~/.lean-agent/worktrees (lean-agent state). ') }] })

test('through the engine: the classifier\'s denial arrives as the Agent call\'s result, the brief names no path: the thread may still edit its registered worktree itself, and says why', { timeoutMs: 20_000 }, async ($, on) => {
  let deny = false
  const h = await session($, on, e => (e.tool === 'Agent' && deny ? denyResult('Undermining Oversight') : 'ok'))
  const own = { tool: 'Edit', file_path: `${WT}/src/a.ts` } as any
  expect(((await $.tool.call(own)) as any).deny).toContain('one step for a small worker') // before: a worker step
  deny = true
  const r: any = await $.tool.call(agent())
  expect(r.deny).toBeUndefined() // (the call went to the engine; its result is the denial)
  const said = (r.context ?? []).join('\n') // said once, with the denied call's own result
  expect(said).toContain('the worker was denied (Undermining Oversight): your own edits in /h/.lean-agent/worktrees/proj/t1-fix are allowed now: do the step yourself, then continue')
  expect(said).toContain('retry with a narrower brief: ONE file plus its spec')
  expect(said).toContain('no permission prompt exists')
  const a: any = await $.tool.call(own)
  expect(a.deny).toBeUndefined()
  expect((a.context ?? []).join('\n')).not.toContain('the worker was denied')
  for (const t of [{ tool: 'Write', file_path: `${WT}/src/new.ts` }, { tool: 'NotebookEdit', notebook_path: `${WT}/n.ipynb` }, { tool: 'Read', file_path: `${WT}/src/a.ts` }, { tool: 'Grep', path: WT, pattern: 'x' }, { tool: 'Glob', path: WT, pattern: '*.ts' }]) expect(((await $.tool.call(t as any)) as any).deny).toBeUndefined() // all six tools; a Read needs no limit here
  const out: any = await $.tool.call({ tool: 'Edit', file_path: '/real/elsewhere/a.ts' } as any)
  expect(out.deny).toContain('the worker was denied (Undermining Oversight): your own edits in')
  expect(((await $.tool.call({ tool: 'Edit', file_path: '/h/.lean-agent/config.json' } as any)) as any).deny).toBeDefined() // never lean state
  expect(((await $.tool.call({ tool: 'Edit', file_path: '/h/.lean-agent/worktrees/proj/other/a.ts' } as any)) as any).deny).toContain('one step for a small worker') // another thread's worktree is not its own
  const row = refusalRows(h).filter((x: any) => x.rule === 'delegation-denied')
  expect(row.length).toBe(1)
  expect(row[0].text).toContain('reason Undermining Oversight')
})

test('through the engine: every lean-agent type counts, the PermissionDenied event and a failed Agent result with the real text too; a reader allows no edit but gets the retry advice', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, () => 'ok')
  const own = { tool: 'Edit', file_path: `${WT}/src/a.ts` } as any
  await $.classic.PostToolUseFailure({ tool_name: 'Agent', tool_use_id: 'r1', tool_input: { subagent_type: 'lean-agent:reader-haiku', prompt: 'job: lookup\nwhere is X' }, error: REAL('Destructive or Unwanted Actions'), session_id: 's', transcript_path: '', cwd: '/h/.lean-agent/threads/t1' } as any)
  expect(((await $.tool.call(own)) as any).deny).toContain('one step for a small worker') // a denied reader opens no edit
  const rd: any = await $.tool.call({ tool: 'Read', file_path: `${WT}/a.ts`, limit: 10 } as any)
  expect((rd.context ?? []).join('\n')).toContain('the reader was denied (Destructive or Unwanted Actions): retry once with one file, one question; else read in slices of 200 lines and write each finding to scratch/notes.md')
  await $.classic.PermissionDenied({ tool_name: 'Agent', tool_use_id: 'w1', reason: REAL('Undermining Oversight'), tool_input: { subagent_type: 'lean-agent:worker-sonnet', prompt: 'job: edit\nwhy-sonnet: x\none file' }, session_id: 's', transcript_path: '', cwd: '/h/.lean-agent/threads/t1' } as any)
  expect(((await $.tool.call(own)) as any).deny).toBeUndefined()
  expect(refusalRows(h).filter((x: any) => x.rule === 'delegation-denied').length).toBe(2)
})

test('through the engine: the denied brief is checked by script and its counts are said; a fresh session starts clean', { timeoutMs: 20_000 }, async ($, on) => {
  const h = await session($, on, () => 'ok')
  const wide = 'job: edit\nRemove all legacy code across /w/a/x.ts /w/b/y.ts /w/c/z.ts /w/d/q.ts'
  await $.classic.PermissionDenied({ tool_name: 'Agent', tool_use_id: 'w1', reason: REAL('Destructive or Unwanted Actions'), tool_input: { subagent_type: HAIKU, prompt: wide }, session_id: 's', transcript_path: '', cwd: '/h/.lean-agent/threads/t1' } as any)
  const a: any = await $.tool.call({ tool: 'Edit', file_path: `${WT}/a.ts` } as any)
  expect((a.context ?? []).join('\n')).toContain('this brief is broad: split it (it names 4 files or folders')
  expect(refusalRows(h).some((x: any) => /this brief is broad/.test(x.text))).toBe(true)
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  expect(((await $.tool.call({ tool: 'Edit', file_path: `${WT}/a.ts` } as any)) as any).deny).toContain('one step for a small worker')
})

test('a blocked report with no prompt behind it says so, drops the approval, offers the real options and cuts the thread\'s "press Open"', async () => {
  const h = fakeHost(null)
  h.store.set('denial.rec.t9', { ts: 1_000_000, category: 'Undermining Oversight', kind: 'worker', agent: HAIKU, roots: [] })
  const t = await blockedTruth(h.host, 't9', 'worker denied three times. Press Open t9 in the pane and answer there.', 'edit the settings module')
  expect(t.approval).toBe('')
  expect(t.category).toBe('Undermining Oversight')
  expect(t.text).toContain(noPromptText('t9', 'Undermining Oversight'))
  expect(t.text).toContain('Let t9 edit its worktree itself')
  expect(t.text).toContain('Retry the worker with a narrower brief')
  expect(t.text).toContain('retry with a narrower brief: ONE file plus its spec')
  expect(t.text).not.toMatch(/Press Open/)
  // no denial known and no classifier words: a real prompt keeps today's report
  const plain = await blockedTruth(fakeHost(null).host, 't9', 'needs the push approved', 'git push origin x')
  expect(plain).toEqual({ text: 'needs the push approved', approval: 'git push origin x' })
})
