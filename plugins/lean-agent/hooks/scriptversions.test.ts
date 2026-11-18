import { expect, test } from 'claude-code/testing'
import { fakeHost, withSha } from './fake'
import { readJsonl } from './state'
import { MAX_PROJECT_LINES, bodyLines, looksMechanical, recordLearn, ruleProblems, rulesStats, syncRules } from './rules'
import { threadTool } from './delivery'
import { MARK_OPEN, PREFACE, rebuildScriptRules, syncWithScripts } from './rulelines'
import { DONE_QUESTION, auditFromReply as audited0, bashFailed, doneQuestion, noteUse, resetScripts, scriptCounts, scriptTool } from './scripts'
import type { Who } from './scripts'
import { hashText } from './recipe'
import { unifiedDiff } from './textdiff'
import { decide } from './guard'
import { resetLocks } from './threads'

const TH = '/h/.lean-agent/threads/t1/thread.json'
const SRC = '/tmp/w/count.py'
const CODE = 'import sys\nprint(sum(1 for _ in open(sys.argv[1])))\n'
const T: Who = { kind: 'thread', id: 't1' }
const D: Who = { kind: 'desk' }
const CAND = '/h/.lean-agent/scripts/candidates/count-lines'
const DIR = '/h/.lean-agent/proj/scripts/count-lines'
const PDIR = '/h/.lean-agent/proj'

function setup() {
  resetScripts()
  const h = fakeHost(null)
  h.files.set(TH, JSON.stringify({ id: 't1', project: 'proj' }))
  h.files.set(SRC, CODE)
  h.git.handler = a => (a[0] === 'rev-parse' ? { exitCode: 0, stdout: '/repo/.git\n' } : { exitCode: 1, stdout: '' })
  return h
}
const prop = (h: any, o: any = {}) =>
  scriptTool(h.host, T, { action: 'propose', name: 'count-lines', path: SRC, purpose: 'Count the lines of a file', run: 'python3 {script} <file>', inputs: ['a file path'], outputs: ['stdout'], ...o })
const line = (o: any = {}) =>
  `LEAN-AUDIT ${JSON.stringify({ name: 'count-lines', verdict: 'adopt', reads: [], writes: [], network: false, deletes: false, secrets: false, hardcoded: [], deterministic: true, errors_handled: true, generalises: true, changes: [], reason: '', ...o })}`
// the audit line gets the sha256 of what is stored, as a real auditor copies it from the brief
const audited = async (host: any, by: string, text: string, prompt: string) => audited0(host, by, await withSha(host, text), prompt)
const aud = (h: any, text: string, prompt = `audit ${CAND}/`) => audited(h.host, 't1', text, prompt)
const meta = (h: any, dir = DIR) => JSON.parse(h.files.get(`${dir}/meta.json`))
async function adopted(h: any, o: any = {}) {
  await prop(h, o)
  const out = await aud(h, line())
  expect(out).toContain('adopted')
}
const EDIT = [{ find: 'sum(1 for _ in open(sys.argv[1]))', replace: 'sum(1 for _ in open(sys.argv[1]) if _.strip())' }]
const V2 = CODE.replace('sum(1 for _ in open(sys.argv[1]))', 'sum(1 for _ in open(sys.argv[1]) if _.strip())')
const upd = (h: any, o: any = {}, who: Who = T) => scriptTool(h.host, who, { action: 'update', name: 'count-lines', edits: EDIT, ...o })
const audV = (h: any, v: string, text = line()) => aud(h, text, `audit the update in ${DIR}/${v}/`)

// ---- the diff ---------------------------------------------------------------------------------------------------------------
test('unified diff: head and tail trimmed, hunks with context, empty when equal', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  const b = a.replace('l10', 'changed').replace('l11\n', '')
  const d = unifiedDiff(a, b, 'v1/x', 'v2/x')
  expect(d).toContain('--- v1/x\n+++ v2/x')
  expect(d).toContain('-l10\n')
  expect(d).toContain('+changed\n')
  expect(d).toContain('-l11\n')
  expect(d).not.toContain('l1\n') // far from the change: no context there
  expect(unifiedDiff(a, a, 'a', 'b')).toBe('')
})

// ---- update: audit the change, switch current, rules and skill untouched -------------------------------------------------------
test('update stores a pending version and a diff; nothing runs or switches until the diff is audited; then current moves and rules stay as they were', async () => {
  const h = setup()
  await adopted(h)
  const rules = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(rules).toContain(`python3 ${DIR}/run <file>`)
  const skill = h.files.get(`${DIR}/SKILL.md`)
  const r = await upd(h)
  expect(r.ok).toBe(true)
  expect(r.text).toContain('v1 stays current')
  expect(r.text).toContain(`${DIR}/v2/.changes.diff`) // the auditor gets the change
  expect(r.text).toContain('Audit ONLY the change')
  expect(h.files.get(`${DIR}/v2/count.py`)).toBe(V2)
  expect(h.files.get(`${DIR}/v2/.changes.diff`)).toContain('+print(sum(1 for _ in open(sys.argv[1]) if _.strip()))')
  expect(h.files.get(`${DIR}/run`)).toBe(CODE) // still v1
  expect(meta(h)).toMatchObject({ current: 'v1', pending: { v: 'v2', author: 't1' } })
  const msg = await audV(h, 'v2')
  expect(msg).toContain('is now v2')
  const m = meta(h)
  expect(m).toMatchObject({ current: 'v2', failures: 0, sha256: hashText(V2) })
  expect(m.pending).toBeUndefined()
  expect(m.versions.map((v: any) => v.v)).toEqual(['v1', 'v2'])
  expect(m.versions[1].audit.verdict).toBe('adopt') // a verdict per version
  expect(h.files.get(`${DIR}/run`)).toBe(V2) // the stable copy follows
  expect(h.files.get(`${DIR}/v1/count.py`)).toBe(CODE) // the old version is kept
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toBe(rules) // the rule line is untouched: same stable path
  expect(h.files.get(`${DIR}/SKILL.md`)).toBe(skill)
})

test('the update audit is bound to the update folder: the current version, the candidate path or two folders are refused; one audit per content', async () => {
  const h = setup()
  await adopted(h)
  await upd(h)
  expect(await audited(h.host, 't1', line(), `audit ${DIR}/v1/`)).toContain('exactly this folder')
  expect(await audited(h.host, 't1', line(), `audit ${DIR}/v2/ and ${DIR}/v1/`)).toContain('exactly this folder')
  expect(meta(h).pending.audit).toBeUndefined()
  expect(await audV(h, 'v2', line({ network: true }))).toContain('adapt') // the mod's rules apply to updates too
  expect(await audV(h, 'v2')).toContain('already audited')
  expect(meta(h).current).toBe('v1')
  expect(await scriptTool(h.host, T, { action: 'audit', name: 'count-lines' }).then(x => x.text)).toContain('UPDATE v2')
})

test('update with a new file, a repeat, an identical text and an old text are handled', async () => {
  const h = setup()
  await adopted(h)
  expect((await upd(h, { edits: [{ find: 'nope', replace: 'x' }] })).text).toContain('exactly once')
  expect((await upd(h, { edits: undefined })).text).toContain('path (the new script file) or edits')
  expect((await upd(h, { edits: [{ find: 'sys', replace: 'x' }] })).text).toContain('found 2') // not unique
  h.files.set('/tmp/w/new.py', 'import sys\nprint(len(open(sys.argv[1]).readlines()))\n')
  expect((await upd(h, { edits: undefined, path: '/tmp/w/new.py' })).ok).toBe(true)
  expect(h.files.get(`${DIR}/v2/count.py`)).toContain('readlines') // stored under the current file name
  expect((await upd(h, { edits: undefined, path: SRC })).text).toContain('identical to the current version')
  await upd(h) // a newer update replaces the one that waits, under a NEW number (numbers are never reused)
  expect(meta(h).pending.v).toBe('v3')
  expect(h.files.get(`${DIR}/v3/count.py`)).toBe(V2)
  expect(h.files.has(`${DIR}/v2/count.py`)).toBe(false)
  await audV(h, 'v3')
  expect((await upd(h, { edits: undefined, path: SRC })).text).toContain('rollback count-lines v1') // that is v1 again
  expect((await upd(h, { edits: [{ find: 'print(', replace: 'x = ' }, { find: 'sys', replace: 'z' }] })).ok).toBe(false) // the second edit is not unique: nothing is stored
  h.files.set('/tmp/w/k.py', `k = "AKIA${'ABCDEFGHIJKLMNOP'}"\n`)
  expect((await upd(h, { edits: undefined, path: '/tmp/w/k.py' })).text).toContain('not stored')
})

test('a changed purpose or run line is shown and never adopted by the audit alone; the desk decides (confirm), or rejects the update', async () => {
  const h = setup()
  await adopted(h)
  const r = await upd(h, { run: 'python3 -u {script} <file>', purpose: 'Count the non-empty lines of a file' })
  expect(r.text).toContain('changes the purpose')
  expect(r.text).toContain('changes the run line')
  const msg = await audV(h, 'v2')
  expect(msg).toContain('adapt')
  expect(msg).toContain('changes the purpose')
  expect(meta(h).current).toBe('v1')
  const ask = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user agrees' })
  expect(ask.text).toContain('confirm: true')
  const ok = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user agrees', confirm: true })
  expect(ok.ok).toBe(true)
  expect(meta(h)).toMatchObject({ current: 'v2', run: 'python3 -u {script} <file>', purpose: 'Count the non-empty lines of a file' })
  expect(meta(h).decision.value).toBe('adopt')
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain('Count the non-empty lines of a file') // the line follows the new purpose by itself
  const log = await readJsonl<any>(h.host, '/h/.lean-agent/scripts/decisions.jsonl')
  expect(log[0]).toMatchObject({ name: 'count-lines', value: 'adopt', version: 'v2' })
  // reject an update: it is dropped, current stays
  await upd(h, { edits: [{ find: 'if _.strip()', replace: 'if _.strip() and 1' }], purpose: 'something else' })
  await audV(h, 'v3')
  const rej = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'reject', reason: 'no' })
  expect(rej.text).toContain('update v3 rejected')
  expect(meta(h).pending).toBeUndefined()
  expect(h.files.has(`${DIR}/v3/count.py`)).toBe(false)
  expect(meta(h).current).toBe('v2')
})

test('a rejected update audit drops the update; a desk update starts a thread with the diff brief', async () => {
  const h = setup()
  await adopted(h)
  let started: any
  const d = await scriptTool(h.host, D, { action: 'update', name: 'count-lines', edits: EDIT }, { startThread: async (title, text, project) => ((started = { title, text, project }), { ok: true, text: 't9 started' }) })
  expect(d.text).toContain('t9 started')
  expect(started.title).toContain('audit update')
  expect(started.text).toContain('.changes.diff')
  expect(started.project).toBe('proj')
  expect(meta(h).pending.author).toBe('desk')
  expect(await audV(h, 'v2', line({ verdict: 'reject', reason: 'reads the whole file into memory' }))).toContain('rejected and dropped')
  expect(meta(h).pending).toBeUndefined()
  expect(h.files.has(`${DIR}/v2/count.py`)).toBe(false)
  expect(meta(h).current).toBe('v1')
})

// ---- rollback ---------------------------------------------------------------------------------------------------------------
test('rollback switches back at once, is logged, needs a reason from a thread, and refuses a version that was edited or never adopted', async () => {
  const h = setup()
  await adopted(h)
  await upd(h)
  await audV(h, 'v2')
  expect((await scriptTool(h.host, T, { action: 'rollback', name: 'count-lines' })).text).toContain('reason')
  const r = await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines' })
  expect(r.ok).toBe(true)
  expect(meta(h)).toMatchObject({ current: 'v1', sha256: hashText(CODE) })
  expect(h.files.get(`${DIR}/run`)).toBe(CODE)
  expect(h.files.get(`${DIR}/v2/count.py`)).toBe(V2) // v2 stays stored: roll forward is possible
  const fwd = await scriptTool(h.host, T, { action: 'rollback', name: 'count-lines', version: 'v2', reason: 'v2 was fine after all' })
  expect(fwd.ok).toBe(true)
  expect(meta(h).current).toBe('v2')
  const log = await readJsonl<any>(h.host, '/h/.lean-agent/scripts/decisions.jsonl')
  expect(log.map((x: any) => `${x.by} ${x.value} ${x.from}>${x.to}`)).toEqual(['desk rollback v2>v1', 't1 rollback v1>v2'])
  expect((await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines', version: 'v9' })).text).toContain('no version v9')
  h.files.set(`${DIR}/v1/count.py`, 'print("edited")\n')
  expect((await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines', version: 'v1' })).text).toContain('edited by hand')
  // an update still waiting (never audited) is not a version to go back to
  h.files.set(`${DIR}/v1/count.py`, CODE)
  await upd(h, { edits: [{ find: 'if _.strip()', replace: 'if _.strip() and 2' }] })
  expect((await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines', version: 'v3' })).ok).toBe(false)
})

test('the stable path never changes: update and rollback leave the command, the rule line and the skill pointing at run', async () => {
  const h = setup()
  await adopted(h)
  const cmd = () => `python3 ${DIR}/run <file>`
  await upd(h)
  await audV(h, 'v2')
  await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines' })
  const shown = JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text)
  expect(shown.command).toBe(cmd())
  expect(h.files.get(`${DIR}/SKILL.md`)).toContain(`run: ${cmd()}`)
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(`run \`${cmd()}\``)
})

// ---- failures, needs-update, report-bad ----------------------------------------------------------------------------------------
test('a failed Bash run is counted; the second marks needs-update (rule line, list, counts), the next use nudges once; an update clears it', async () => {
  const h = setup()
  await adopted(h)
  const run = `python3 ${DIR}/run /tmp/x.log`
  const n1 = await noteUse(h.host, run, 't1', true)
  expect(n1).toContain('1 failure')
  expect(meta(h)).toMatchObject({ failures: 1 })
  expect(meta(h).state).toBeUndefined()
  const n2 = await noteUse(h.host, run, 't1', true)
  expect(n2).toContain('now marked needs-update')
  expect(n2).toContain('lean_script update count-lines') // the nudge to propose a fix
  expect(meta(h)).toMatchObject({ failures: 2, state: 'needs-update' })
  expect(await noteUse(h.host, run, 't1', false)).toBeNull() // nudged once per session
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain('(needs update)')
  expect((await scriptTool(h.host, D, { action: 'list' })).text).toContain('NEEDS-UPDATE')
  expect(await scriptCounts(h.host)).toMatchObject({ adopted: 1, needsUpdate: 1 })
  // after a fresh session the next thread that uses it is nudged again
  resetScripts()
  expect(await noteUse(h.host, run, 't2', false)).toContain('needs-update')
  await upd(h)
  await audV(h, 'v2')
  expect(meta(h).state).toBeUndefined()
  expect(meta(h).failures).toBe(0)
  expect(h.files.get(`${PDIR}/rules/_project.md`)).not.toContain('(needs update)')
  expect((await readJsonl<any>(h.host, '/h/.lean-agent/scripts/uses.jsonl')).filter((x: any) => x.failed).length).toBe(2)
})

test('failure detection reads the Bash result: an error flag or an Exit code line, never a denial', () => {
  expect(bashFailed({ isError: true, result: 'x' })).toBe(true)
  expect(bashFailed({ result: 'out\nExit code 2\nerr' })).toBe(true)
  expect(bashFailed({ result: [{ type: 'text', text: 'Exit code 127' }] })).toBe(true)
  expect(bashFailed({ result: 'fine, exit code is not shown' })).toBe(false)
  expect(bashFailed({ result: 'Exit code 0' })).toBe(false)
  expect(bashFailed({ deny: 'refused', isError: true })).toBe(false)
  expect(bashFailed(undefined)).toBe(false)
})

test('report-bad marks needs-update at once (threads only, with a reason) and shows in the rule line', async () => {
  const h = setup()
  await adopted(h)
  expect((await scriptTool(h.host, D, { action: 'report-bad', name: 'count-lines', why: 'wrong' })).ok).toBe(false)
  expect((await scriptTool(h.host, T, { action: 'report-bad', name: 'count-lines' })).text).toContain('why')
  const r = await scriptTool(h.host, T, { action: 'report-bad', name: 'count-lines', why: 'counts blank lines too' })
  expect(r.text).toContain('lean_script update count-lines')
  expect(meta(h)).toMatchObject({ state: 'needs-update', badWhy: 'counts blank lines too' })
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain('(needs update)')
  expect(await noteUse(h.host, `python3 ${DIR}/run x`, 't1')).toContain('counts blank lines too')
})

// ---- hand edits -------------------------------------------------------------------------------------------------------------
test('a hand edit of run is detected on use, in list, rules and sync; a subagent never runs it; rollback restores the audited text', async () => {
  const h = setup()
  await adopted(h)
  const run = `python3 ${DIR}/run /tmp/x.log`
  expect(await noteUse(h.host, run, 't1')).toBeNull() // intact
  h.files.set(`${DIR}/run`, 'print("changed by hand")\n')
  const w = await noteUse(h.host, run, 't1')
  expect(w).toContain('WARNING')
  expect(w).toContain('edited by hand')
  expect(w).toContain('unaudited')
  expect((await scriptTool(h.host, D, { action: 'list' })).text).toContain('EDITED, UNAUDITED')
  expect(JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text)).toMatchObject({ health: 'edited, unaudited' })
  await rebuildScriptRules(h.host, 'proj')
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain('(edited, unaudited)')
  await syncRules(h.host, 'proj', '/repo')
  expect(h.files.has('/repo/.claude/skills/lean-agent-script-count-lines/SKILL.md')).toBe(false) // never advertised while unaudited
  expect(await scriptCounts(h.host)).toMatchObject({ needsUpdate: 1 })
  const worker = { role: { kind: 'thread', id: 't1' } as any, cwd: '/r', agentType: 'lean-agent:worker-sonnet', agentId: 'w1' }
  expect(await decide(h.host, worker, { tool: 'Bash', command: run })).toContain('unaudited')
  expect(await decide(h.host, worker, { tool: 'Bash', command: 'ls /r' })).toBeNull()
  const r = await scriptTool(h.host, T, { action: 'rollback', name: 'count-lines', version: 'v1', reason: 'restore the audited text' }) // restores run from v1
  expect(r.ok).toBe(true)
  expect(h.files.get(`${DIR}/run`)).toBe(CODE)
  expect(await noteUse(h.host, run, 't1')).toBeNull()
  expect(await decide(h.host, worker, { tool: 'Bash', command: run })).toBeNull()
})

test('a hand edit of a version file is detected too; update still works from the audited text only', async () => {
  const h = setup()
  await adopted(h)
  h.files.set(`${DIR}/v1/count.py`, 'print("edited version file")\n')
  const ig = JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text)
  expect(ig.integrity).toContain('v1/count.py was edited')
  expect((await upd(h)).text).toContain('missing or was edited')
})

test('diff and show: versions with their verdicts, failures, the change between two versions', async () => {
  const h = setup()
  await adopted(h)
  expect((await scriptTool(h.host, D, { action: 'diff', name: 'count-lines' })).text).toContain('only one version')
  await upd(h)
  const pending = await scriptTool(h.host, D, { action: 'diff', name: 'count-lines' }) // current vs the waiting update
  expect(pending.text).toContain('--- v1/count.py')
  expect(pending.text).toContain('+++ v2/count.py')
  await audV(h, 'v2')
  const d = await scriptTool(h.host, D, { action: 'diff', name: 'count-lines', a: 'v1', b: 'v2' })
  expect(d.text).toContain('+print(sum(1 for _ in open(sys.argv[1]) if _.strip()))')
  expect((await scriptTool(h.host, D, { action: 'diff', name: 'count-lines' })).text).toContain('--- v1/count.py') // previous vs current
  const s = JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text)
  expect(s.versionList).toHaveLength(2)
  expect(s.versionList[1]).toMatch(/^v2 \(current\) · [0-9a-f]{8} · t1 · \d{4}-\d{2}-\d{2} · adopt$/)
  expect(s).toMatchObject({ failures: 0, health: 'ok', current: 'v2' })
  expect((await scriptTool(h.host, D, { action: 'diff', name: 'count-lines', a: 'v1', b: 'v7' })).ok).toBe(false)
})

// ---- the rule lines (EXTRA 2) -------------------------------------------------------------------------------------------------
const rule = (n = 3) => `---\npaths:\n  - "services/billing/**"\n---\n# billing\n${Array.from({ length: n }, (_, i) => `- line ${i}`).join('\n')}\n<!-- lean-agent: learned abc 2026-01-01 sources: services/billing/** -->\n`
const LINE = `- Count the lines of a file: run \`python3 ${DIR}/run <file>\` (script, do not compute this by reading files)`
const blocks = (t: string) => (t.match(/<!-- lean-agent:scripts -->/g) ?? []).length

async function learned(h: any) {
  await recordLearn(h.host, 'proj', 'billing', { globs: ['services/billing/**'], sha: 'abc', lines: 5 })
  h.files.set(`${PDIR}/rules/billing.md`, rule())
  h.files.set(`${PDIR}/rules/_project.md`, '# project\n- pnpm test\n')
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ proj: { path: '/repo' } }))
}

// ---- the seams with the learn flow (1.0.6): sync all, record, and the character caps -----------------------------------------------
test('lean_rules sync with all goes through the script lines and answers 1.0.6\'s summary; record keeps the scripts block', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { inputs: ['services/billing/data.csv'] })
  h.files.set(`${PDIR}/rules/billing.md`, h.files.get(`${PDIR}/rules/billing.md`)!.replace(LINE, '- stale line')) // the block went stale
  const r = await threadTool(h.host, 't1', 'lean_rules', { action: 'sync', repo: '/repo', all: true })
  expect(r.ok).toBe(true)
  expect(r.text).toMatch(/^\/repo: copied \d+, removed 0, skipped 0, exclude ok$/m) // one summary line, not JSON
  expect(h.files.get('/repo/.claude/rules/lean-agent/billing.md')).toContain(LINE) // regenerated from the store, then copied
  const rec = await threadTool(h.host, 't1', 'lean_rules', { action: 'record', area: 'billing', globs: ['services/billing/**'], sha: 'def', lines: 5 })
  expect(rec.ok).toBe(true)
  expect(h.files.get(`${PDIR}/rules/billing.md`)).toContain(`${MARK_OPEN}\n${LINE}\n<!-- /lean-agent:scripts -->`) // the footer is rewritten, the block is not
  expect(blocks(h.files.get(`${PDIR}/rules/billing.md`)!)).toBe(1)
})

test('the character and width caps hold for the script lines: what does not fit an area rule goes to _project, and no rule is made one sync would skip', async () => {
  const h = setup()
  await learned(h)
  // 24 lines of 81 characters: 1,967 of the 2,000 characters; the rule line would make it 2,070
  const full = `---\npaths:\n  - "services/billing/**"\n---\n${Array.from({ length: 24 }, (_, i) => `- ${String(i).padStart(2, '0')} ${'x'.repeat(76)}`).join('\n')}\n<!-- lean-agent: learned abc 2026-01-01 -->\n`
  h.files.set(`${PDIR}/rules/billing.md`, full)
  await adopted(h, { inputs: ['services/billing/data.csv'] })
  const billing = h.files.get(`${PDIR}/rules/billing.md`)!
  expect(billing).not.toContain(MARK_OPEN)
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(LINE)
  for (const f of ['billing.md', '_project.md']) expect([f, ruleProblems(f, h.files.get(`${PDIR}/rules/${f}`)!)]).toEqual([f, []])
  const s = await syncWithScripts(h.host, 'proj', '/repo', false)
  expect(s.detail[0]!.out!.skipped).toEqual([])
})

test('an audit of another project\'s candidate adopts nothing (a thread audits its own project and global scripts only)', async () => {
  const h = setup()
  await prop(h)
  h.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ id: 't2', project: 'other' }))
  const out = await audited(h.host, 't2', line(), `audit ${CAND}/`)
  expect(out).toContain('belongs to project proj')
  expect(h.files.has(`${CAND}/meta.json`)).toBe(true) // still a candidate
  expect(meta(h, CAND).status).toBe('candidate')
  expect(meta(h, CAND).audit).toBeUndefined()
})

test('a _project rule with no room for even the one line loses its old script block, never keeps a retired script\'s line', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { inputs: ['a log file'] })
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(MARK_OPEN)
  const ten = Array.from({ length: MAX_PROJECT_LINES }, (_, i) => `- fact ${i}`).join('\n')
  h.files.set(`${PDIR}/rules/_project.md`, `# project\n${ten}\n${MARK_OPEN}\n- an old script line\n<!-- /lean-agent:scripts -->\n`)
  await rebuildScriptRules(h.host, 'proj')
  const p = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(p).not.toContain(MARK_OPEN)
  expect(p).not.toContain('an old script line')
  expect(p).toContain('- fact 9') // the learned lines stay
})

test('adopt writes ONE marked line into the rule of the script\'s area and syncs it into the checkout; _project gets its line once', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { inputs: ['services/billing/data.csv'] })
  const billing = h.files.get(`${PDIR}/rules/billing.md`)!
  expect(billing).toContain(`${MARK_OPEN}\n${LINE}\n<!-- /lean-agent:scripts -->`)
  expect(blocks(billing)).toBe(1)
  expect(billing).toContain('- line 2') // the learned lines are untouched
  const project = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(project).toContain(PREFACE)
  expect(project.split(PREFACE).length - 1).toBe(1)
  expect(project).not.toContain(LINE) // an area script does not go to _project
  expect(h.files.get('/repo/.claude/rules/lean-agent/billing.md')).toContain(LINE) // synced
  expect(h.files.get('/repo/.claude/rules/lean-agent/_project.md')).toContain(PREFACE)
  expect(h.files.get('/repo/.claude/skills/lean-agent-script-count-lines/SKILL.md')).toContain('run: python3')
  // idempotent: a second rebuild changes nothing
  expect(await rebuildScriptRules(h.host, 'proj')).toEqual([])
  await syncWithScripts(h.host, 'proj', '/repo')
  expect(blocks(h.files.get(`${PDIR}/rules/billing.md`)!)).toBe(1)
  expect(h.files.get(`${PDIR}/rules/_project.md`)!.split(PREFACE).length - 1).toBe(1)
})

test('a script outside every area (or global) goes to _project; learn / trim rewrites keep the line because the next sync writes it again', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { inputs: ['a log file'] })
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(LINE)
  expect(h.files.get(`${PDIR}/rules/billing.md`)).not.toContain(MARK_OPEN)
  h.files.set(`${PDIR}/rules/_project.md`, '# project\n- rewritten by learn\n') // a model rewrote the rule and lost the block
  await syncWithScripts(h.host, 'proj', '/repo')
  const p = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(p).toContain('- rewritten by learn')
  expect(p).toContain(LINE)
  expect(p).toContain(PREFACE)
  expect(blocks(p)).toBe(1)
})

test('a global script gets its line in _project of every project that is synced', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { project: 'global' })
  const line = `- Count the lines of a file: run \`python3 /h/.lean-agent/scripts/count-lines/run <file>\` (script, do not compute this by reading files)`
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(line)
  expect(h.files.get('/repo/.claude/rules/lean-agent/_project.md')).toContain(line)
})

test('the caps hold: a full area rule sends the line to _project; a full _project gets one "more scripts" pointer', async () => {
  const h = setup()
  await learned(h)
  h.files.set(`${PDIR}/rules/billing.md`, rule(24)) // 25 body lines: no room
  await adopted(h, { inputs: ['services/billing/data.csv'] })
  expect(h.files.get(`${PDIR}/rules/billing.md`)).not.toContain(MARK_OPEN)
  expect(bodyLines(h.files.get(`${PDIR}/rules/billing.md`)!)).toBe(25)
  expect(h.files.get(`${PDIR}/rules/_project.md`)).toContain(LINE) // a pointer in _project instead
  // many global scripts: _project stays within its cap
  for (let i = 0; i < 10; i++) {
    const code = `print(${i})\n`
    h.files.set(`/h/.lean-agent/scripts/g${i}/run`, code)
    h.files.set(`/h/.lean-agent/scripts/g${i}/meta.json`, JSON.stringify({ name: `g${i}`, status: 'adopted', purpose: `global ${i}`, run: 'python3 {script}', inputs: ['x'], outputs: ['stdout'], file: 'run', sha256: hashText(code), project: 'global' }))
  }
  await rebuildScriptRules(h.host, 'proj')
  const p = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(bodyLines(p)).toBeLessThanOrEqual(MAX_PROJECT_LINES)
  expect(p).toMatch(/- \d+ more scripts: see the lean-agent-script-\* skills/)
  expect(blocks(p)).toBe(1)
})

test('retire removes the line; a project with no rules and no scripts is left alone', async () => {
  const h = setup()
  await learned(h)
  await adopted(h, { inputs: ['services/billing/data.csv'] })
  expect(h.files.get(`${PDIR}/rules/billing.md`)).toContain(LINE)
  await scriptTool(h.host, D, { action: 'retire', name: 'count-lines', reason: 'replaced' })
  expect(h.files.get(`${PDIR}/rules/billing.md`)).toBe(rule()) // exactly as learned
  expect(h.files.get('/repo/.claude/rules/lean-agent/billing.md')).not.toContain(LINE)
  expect(h.files.get(`${PDIR}/rules/_project.md`)).not.toContain(LINE)
  const h2 = setup()
  expect(await rebuildScriptRules(h2.host, 'nothing-here')).toEqual([])
  expect([...h2.files.keys()].some(k => k.includes('/nothing-here/'))).toBe(false)
})

// ---- the done-report question and the gaps classifier ---------------------------------------------------------------------------
test('a thread reporting done is asked once per session whether a step could have been a script', () => {
  resetScripts()
  expect(doneQuestion('t1')).toBe(DONE_QUESTION)
  expect(doneQuestion('t1')).toBeNull()
  expect(doneQuestion('t2')).toBe(DONE_QUESTION) // per thread
  resetScripts()
  expect(doneQuestion('t1')).toBe(DONE_QUESTION) // a new session asks again
})

async function session($: any, on: any, base: () => void = () => undefined) {
  const h = fakeHost(on)
  base() // hooks beneath the plugin must exist before the first $ call
  resetLocks()
  resetScripts()
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', () => ({ value: { cancel() {} } }))
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set(TH, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/h/.lean-agent/threads/t1', surface: 'desktop', isInteractive: true } as any)
  return h
}
test('lean_report state done adds the question once; a working report, a blocked one and a worker\'s call do not', async ($, on) => {
  await session($, on)
  const report = (o: any) => $.tool.call({ tool: 'mcp__lean-agent__lean_report', ...o } as any) as Promise<any>
  expect((await report({ text: 'half way', state: 'working' })).result).not.toContain('script')
  expect((await report({ text: 'stuck', state: 'blocked' })).result).not.toContain('script')
  expect((await report({ text: 'by a worker', state: 'done', agentId: 'w1' })).result).not.toContain('script')
  const done = await report({ text: 'all done', state: 'done' })
  expect(done.result).toContain('reported to the desk')
  expect(done.result).toContain(DONE_QUESTION)
  expect((await report({ text: 'done again', state: 'done' })).result).not.toContain(DONE_QUESTION)
})

test('a Bash run of an adopted script that fails is counted through the engine, and the result gets the lines', async ($, on) => {
  const h = await session($, on, () => on('tool.call', { tool: 'Bash' }, () => ({ result: 'boom\nExit code 1', isError: true }) as any))
  h.files.set(SRC, CODE)
  await prop(h)
  await aud(h, line())
  const r: any = await $.tool.call({ tool: 'Bash', command: `python3 ${DIR}/run /tmp/x` } as any)
  expect(JSON.stringify(r.context)).toContain('1 failure')
  expect(meta(h).failures).toBe(1)
})

test('gaps that read like mechanical work are listed as script candidates by stats, once each', async () => {
  const h = setup()
  for (const t of ['count how many files import the old client', 'List all the callers of parse()', 'which files changed since the tag', 'sum the totals per customer', 'where the build output goes']) expect(looksMechanical(t), t).toBe(t !== 'where the build output goes')
  expect(looksMechanical('the retry logic is subtle')).toBe(false)
  const rows = [
    { path: 'src/a.ts', text: 'Count how many files import the old client' },
    { path: 'src/b.ts', text: 'count how many files import the old client' }, // a repeat
    { path: 'src/c.ts', text: 'the retry logic is subtle' },
    { path: '', text: 'find all usages of the flag' },
  ]
  h.files.set(`${PDIR}/gaps.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const s = await rulesStats(h.host, 'proj')
  expect(s.scriptCandidates).toEqual(['src/a.ts: Count how many files import the old client', 'find all usages of the flag'])
})

// ---- review round: audits tied to the text they read, numbers never reused, project limits, lock, rule-line edges ------------------
test('an audit that read an older text is never recorded against a newer one: new number for every update, the sha is echoed', async () => {
  const h = setup()
  await adopted(h)
  await upd(h) // v2
  const old = meta(h).pending.sha256
  await upd(h, { edits: [{ find: 'sum(1 for _ in open(sys.argv[1]))', replace: 'sum(1 for _ in open(sys.argv[1]) if len(_) > 1)' }] }) // replaces it: v3
  expect(meta(h).pending.v).toBe('v3')
  // the auditor started on v2 finishes now: its folder is gone, and with the old sha it would not match v3 either
  expect(await audited(h.host, 't1', line(), `audit ${DIR}/v2/`)).toContain('exactly this folder')
  expect(await audited0(h.host, 't1', line({ sha: old }), `audit ${DIR}/v3/`)).toContain('does not carry the sha256')
  expect(await audited0(h.host, 't1', line({ sha: old.slice(0, 11) }), `audit ${DIR}/v3/`)).toContain('does not carry the sha256') // too short to count
  expect(await audited0(h.host, 't1', line({ sha: undefined }), `audit ${DIR}/v3/`)).toContain('does not carry the sha256')
  expect(meta(h).pending.audit).toBeUndefined()
  // after a reject the number is not handed out again either
  expect(await audV(h, 'v3', line({ verdict: 'reject', reason: 'no' }))).toContain('rejected and dropped')
  await upd(h)
  expect(meta(h).pending.v).toBe('v4')
  // a candidate: the same for a script proposed again while an auditor ran
  const h2 = setup()
  await prop(h2)
  const was = meta(h2, CAND).sha256
  h2.files.set(SRC, 'print(2)\n')
  await prop(h2) // replaces the candidate
  expect(await audited0(h2.host, 't1', line({ sha: was }), `audit ${CAND}/`)).toContain('does not carry the sha256')
  expect(await aud(h2, line())).toContain('adopted') // the current sha is accepted (and a longer-than-12 prefix is enough)
})

test('a rollback drops the update that waits; a changed purpose is always judged against what is current now', async () => {
  const h = setup()
  await adopted(h)
  await upd(h)
  await audV(h, 'v2') // v2 current
  const w = await upd(h, { edits: [{ find: 'if _.strip()', replace: 'if _.strip() and 3' }], purpose: 'Count the non-blank lines' }) // v3 waits
  expect(w.text).toContain('update v3 stored')
  expect(meta(h).pending.v).toBe('v3')
  await scriptTool(h.host, D, { action: 'rollback', name: 'count-lines' }) // back to v1
  expect(meta(h).pending).toBeUndefined()
  expect(h.files.has(`${DIR}/v3/count.py`)).toBe(false)
  await upd(h, { edits: [{ find: 'sum(1 for _ in open(sys.argv[1]))', replace: 'sum(1 for _ in open(sys.argv[1]) if len(_) > 2)' }] }) // (v2's text is a version already)
  expect(meta(h).pending.v).toBe('v4') // and the numbers keep counting
})

test('a thread changes only its own project\'s scripts and global ones: update, rollback, report-bad and retire; the desk may touch all', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ id: 't2', project: 'other' }))
  await adopted(h) // a script of project proj
  const t2: Who = { kind: 'thread', id: 't2' }
  for (const a of [{ action: 'update', edits: EDIT }, { action: 'rollback', reason: 'x' }, { action: 'report-bad', why: 'x' }, { action: 'retire' }]) {
    const r = await scriptTool(h.host, t2, { name: 'count-lines', ...a })
    expect(r.ok, a.action).toBe(false)
    expect(r.text, a.action).toContain('belongs to project proj')
  }
  expect(meta(h).pending).toBeUndefined()
  expect(meta(h).status).toBe('adopted')
  expect((await scriptTool(h.host, D, { action: 'report-bad', name: 'count-lines', why: 'x' })).ok).toBe(false) // report-bad is a thread's, not the desk's
  const own = await scriptTool(h.host, T, { action: 'report-bad', name: 'count-lines', why: 'x' }) // t1 is on proj
  expect(own.ok).toBe(true)
  // a global script: any thread
  const h2 = setup()
  h2.files.set('/h/.lean-agent/threads/t2/thread.json', JSON.stringify({ id: 't2', project: 'other' }))
  await adopted(h2, { project: 'global' })
  expect((await scriptTool(h2.host, t2, { action: 'report-bad', name: 'count-lines', why: 'wrong' })).ok).toBe(true)
  expect((await scriptTool(h2.host, t2, { action: 'update', name: 'count-lines', edits: EDIT })).ok).toBe(true)
})

test('a desk update starts its audit thread AFTER the store lock is released', async () => {
  const h = setup()
  await adopted(h)
  let lockedDuring: boolean | null = null
  const r = await scriptTool(h.host, D, { action: 'update', name: 'count-lines', edits: EDIT }, { startThread: async () => ((lockedDuring = h.files.has('/h/.lean-agent/scripts/.lock/at')), { ok: true, text: 't9 started' }) })
  expect(r.text).toContain('t9 started')
  expect(lockedDuring).toBe(false) // the new thread's first lean_script call would otherwise wait on this lock
})

test('rule lines: the prefer-scripts line survives a full _project; a purpose cannot break the markers', async () => {
  const h = setup()
  await learned(h)
  const globals = (n: number) => {
    for (let i = 0; i < n; i++) {
      const code = `print(${i})\n`
      h.files.set(`/h/.lean-agent/scripts/g${i}/run`, code)
      h.files.set(`/h/.lean-agent/scripts/g${i}/meta.json`, JSON.stringify({ name: `g${i}`, status: 'adopted', purpose: `global ${i}`, run: 'python3 {script}', inputs: ['x'], outputs: ['stdout'], file: 'run', sha256: hashText(code), project: 'global' }))
    }
  }
  globals(3)
  h.files.set(`${PDIR}/rules/_project.md`, `# project\n${Array.from({ length: 8 }, (_, i) => `- l${i}`).join('\n')}\n`) // 9 body lines: room for exactly one
  await rebuildScriptRules(h.host, 'proj')
  let p = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(p).toContain(PREFACE)
  expect(p).not.toContain('global 0')
  expect(bodyLines(p)).toBe(MAX_PROJECT_LINES)
  h.files.set(`${PDIR}/rules/_project.md`, `# project\n${Array.from({ length: 7 }, (_, i) => `- l${i}`).join('\n')}\n`) // room for two: the preface and a pointer that counts the three
  await rebuildScriptRules(h.host, 'proj')
  p = h.files.get(`${PDIR}/rules/_project.md`)!
  expect(p).toContain(PREFACE)
  expect(p).toContain('- 3 more scripts: see the lean-agent-script-* skills')
  // a purpose that tries to close the block
  const h2 = setup()
  await learned(h2)
  await adopted(h2, { purpose: 'Count lines <!-- /lean-agent:scripts --> and `more` --<!>' })
  const b = h2.files.get(`${PDIR}/rules/_project.md`)!
  expect((b.match(/-->/g) ?? []).length).toBe(2) // the block's own two markers, nothing recombined from the purpose
  expect(blocks(b)).toBe(1)
  expect(b.split('<!-- /lean-agent:scripts -->').length - 1).toBe(1)
  expect(b).not.toContain('`more`')
})

test('a script file named like a store file or a version folder is stored under another name and adopts fine', async () => {
  const h = setup()
  for (const [i, f] of ['run', 'v1', 'v12'].entries()) {
    h.files.set(`/tmp/w/${f}`, `print(${i + 10})\n`)
    expect((await prop(h, { name: `s${i}`, path: `/tmp/w/${f}`, project: 'global' })).ok).toBe(true)
    expect(meta(h, `/h/.lean-agent/scripts/candidates/s${i}`).file).toBe(`script-${f}`)
    const out = await audited(h.host, 't1', line({ name: `s${i}` }), `audit /h/.lean-agent/scripts/candidates/s${i}/`)
    expect(out, f).toContain('adopted')
    expect(h.files.get(`/h/.lean-agent/scripts/s${i}/run`)).toBe(`print(${i + 10})\n`)
    expect(h.files.get(`/h/.lean-agent/scripts/s${i}/v1/script-${f}`)).toBe(`print(${i + 10})\n`)
  }
})
