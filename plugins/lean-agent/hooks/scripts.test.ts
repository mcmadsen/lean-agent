import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { syncRules } from './rules'
import { allScripts, auditFromReply, judge, noteBash, noteUse, noteWrite, ownData, parseAudit, resetScripts, runProblem, scan, scriptCounts, scriptTool, takeNudges, useCounts } from './scripts'
import type { Who } from './scripts'
import { resetLocks } from './threads'

// synthetic sensitive-looking text, built from pieces so this file itself holds none
const USER_PATH = `/${'Users'}/someone/data`
const EMAIL = `dev${'@'}example.org`
const KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`

const TH = '/h/.lean-agent/threads/t1/thread.json'
const SRC = '/tmp/w/count.py'
const T: Who = { kind: 'thread', id: 't1' }
const D: Who = { kind: 'desk' }
const CAND = '/h/.lean-agent/scripts/candidates/count-lines'

function setup() {
  resetScripts()
  const h = fakeHost(null)
  h.files.set(TH, JSON.stringify({ id: 't1', project: 'proj' }))
  h.files.set(SRC, 'import sys\nprint(sum(1 for _ in open(sys.argv[1])))\n')
  return h
}
const propose = (h: any, o: any = {}) =>
  scriptTool(h.host, T, { action: 'propose', name: 'count-lines', path: SRC, purpose: 'Count the lines of a file', run: 'python3 {script} <file>', inputs: ['a file path'], outputs: ['stdout'], ...o })
const line = (o: any = {}) =>
  `LEAN-AUDIT ${JSON.stringify({ name: 'count-lines', verdict: 'adopt', reads: ['argv[1]'], writes: [], network: false, deletes: false, secrets: false, hardcoded: [], deterministic: true, errors_handled: true, generalises: true, changes: [], reason: '', ...o })}`
const meta = (h: any, dir = CAND) => JSON.parse(h.files.get(`${dir}/meta.json`))

test('propose copies the script into the candidate store and never executes it', async () => {
  const h = setup()
  const r = await propose(h)
  expect(r.ok).toBe(true)
  expect(h.files.get(`${CAND}/count.py`)).toBe(h.files.get(SRC))
  const m = meta(h)
  expect(m).toMatchObject({ name: 'count-lines', purpose: 'Count the lines of a file', run: 'python3 {script} <file>', author: 't1', project: 'proj', status: 'candidate', file: 'count.py' })
  expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(m.created).toBe(h.clock.t)
  expect(r.text).toContain('audit count-lines')
  expect(h.calls.map(c => c.argv[0]).filter(c => c !== 'mkdir' && c !== 'mv' && c !== 'rm')).toEqual([]) // no interpreter, nothing run
  expect(h.files.get(SRC)).toContain('argv') // the original stays
})

test('propose is refused for a bad name, path, run line or missing parts', async () => {
  const h = setup()
  expect((await propose(h, { name: 'candidates' })).ok).toBe(false)
  expect((await propose(h, { name: '../x' })).ok).toBe(false)
  expect((await propose(h, { path: 'count.py' })).text).toContain('absolute')
  expect((await propose(h, { path: '/tmp/none.py' })).text).toContain('no such file')
  expect((await propose(h, { purpose: '' })).ok).toBe(false)
  expect((await propose(h, { inputs: [] })).ok).toBe(false)
  expect((await propose(h, { outputs: undefined })).ok).toBe(false)
  expect((await propose(h, { run: 'python3 count.py' })).text).toContain('{script}')
  expect((await propose(h, { run: '{script} <file>' })).text).toContain('interpreter')
  expect((await propose(h, { run: 'python3 {script} <file> | sort' })).text).toContain('plain command')
  expect((await propose(h, { run: 'python3 {script} <file> > out.txt' })).ok).toBe(false)
  expect((await propose(h, { project: '../etc' })).ok).toBe(false)
  expect((await scriptTool(h.host, D, { action: 'propose', name: 'x', path: SRC })).text).toContain('threads')
  expect(h.files.has(`${CAND}/count.py`)).toBe(false)
})

test('a script with a secret is not stored; a home path or email is stored but flagged', async () => {
  const h = setup()
  h.files.set('/tmp/w/k.py', `key = "${KEY}"\n`)
  const r = await propose(h, { path: '/tmp/w/k.py' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not stored')
  expect(h.files.has(`${CAND}/k.py`)).toBe(false)
  h.files.set('/tmp/w/p.py', `open("${USER_PATH}/a")\n# ${EMAIL}\n`)
  const p = await propose(h, { path: '/tmp/w/p.py' })
  expect(p.ok).toBe(true)
  expect(meta(h).scan.length).toBe(2)
  expect(p.text).toContain('scan found')
})

test('the same content under another name, an adopted name and a re-proposal are handled', async () => {
  const h = setup()
  await propose(h)
  expect((await propose(h, { name: 'other' })).text).toContain('already candidate as count-lines')
  expect((await propose(h)).text).toContain('already proposed')
  h.files.set(SRC, 'print(2)\n') // a revised script replaces the candidate (its audit no longer applies)
  expect((await propose(h)).ok).toBe(true)
  expect(h.files.get(`${CAND}/count.py`)).toBe('print(2)\n')
  expect(meta(h).history.length).toBe(1)
  await auditFromReply(h.host, 't1', line())
  expect((await propose(h)).text).toContain('already ')
  h.files.set(SRC, 'print(3)\n')
  expect((await propose(h)).text).toContain('already adopted')
})

test('audit: the thread gets the auditor brief, the desk starts a thread with it', async () => {
  const h = setup()
  await propose(h)
  const t = await scriptTool(h.host, T, { action: 'audit', name: 'count-lines' })
  expect(t.text).toContain('lean-agent:auditor')
  expect(t.text).toContain(`${CAND}/count.py`)
  expect(t.text).toContain('Declared outputs: stdout')
  let started: any
  const d = await scriptTool(h.host, D, { action: 'audit', name: 'count-lines' }, { startThread: async (title, text, project) => ((started = { title, text, project }), { ok: true, text: 't9 started' }) })
  expect(d.ok).toBe(true)
  expect(started.title).toBe('audit script count-lines')
  expect(started.project).toBe('proj')
  expect(started.text).toContain('Declared purpose')
  expect((await scriptTool(h.host, T, { action: 'audit', name: 'nope' })).ok).toBe(false)
})

test('a clean adopt verdict moves the script to the project folder and writes its recipe skill', async () => {
  const h = setup()
  await propose(h)
  const msg = await auditFromReply(h.host, 't1', `looks fine\n${line()}\nLEAN-FEEDBACK {"status":"done"}`)
  expect(msg).toContain('adopted')
  const dir = '/h/.lean-agent/proj/scripts/count-lines'
  expect(h.files.has(`${CAND}/meta.json`)).toBe(false)
  expect(h.files.has(`${dir}/count.py`)).toBe(true)
  const m = meta(h, dir)
  expect(m.status).toBe('adopted')
  expect(m.audit.verdict).toBe('adopt')
  const skill = h.files.get(`${dir}/SKILL.md`)!
  expect(skill).toContain('name: lean-agent-script-count-lines')
  expect(skill).toContain(`run: python3 ${dir}/count.py <file>`)
  expect(skill).toContain('Count the lines of a file')
  expect(await scriptCounts(h.host)).toEqual({ candidates: 0, adopted: 1 })
})

test('a global script is adopted under scripts/<name> and synced into every project checkout as a skill', async () => {
  const h = setup()
  h.git.handler = a => (a[0] === 'rev-parse' ? { exitCode: 0, stdout: '/repo/.git\n' } : { exitCode: 1, stdout: '' })
  await propose(h, { project: 'global' })
  await auditFromReply(h.host, 't1', line())
  expect(h.files.has('/h/.lean-agent/scripts/count-lines/count.py')).toBe(true)
  await syncRules(h.host, 'proj', '/repo')
  const s = h.files.get('/repo/.claude/skills/lean-agent-script-count-lines/SKILL.md')!
  expect(s).toContain('run: python3 /h/.lean-agent/scripts/count-lines/count.py <file>')
  expect(h.files.get('/repo/.git/info/exclude')).toContain('.claude/skills/lean-agent-*/')
  // candidates are never skills
  h.files.set('/h/.lean-agent/scripts/candidates/zzz/SKILL.md', 'x')
  await syncRules(h.host, 'proj', '/repo')
  expect(h.files.has('/repo/.claude/skills/lean-agent-script-candidates/SKILL.md')).toBe(false)
  // retiring removes it at the next sync
  await scriptTool(h.host, T, { action: 'retire', name: 'count-lines', reason: 'replaced' })
  await syncRules(h.host, 'proj', '/repo')
  expect(h.files.has('/repo/.claude/skills/lean-agent-script-count-lines/SKILL.md')).toBe(false)
})

test('the mod, not the auditor, decides: network, deletes, stray writes, hardcoded values are never adopt', async () => {
  const cases: [string, any, string][] = [
    ['network', { network: true }, 'uses the network'],
    ['deletes', { deletes: true }, 'deletes or overwrites'],
    ['writes', { writes: ['/tmp/out/report.txt'] }, 'writes outside its declared outputs'],
    ['hardcoded', { hardcoded: ['the sample file name'] }, 'hardcoded'],
    ['generalises', { generalises: false }, 'only for the original data'],
  ]
  for (const [what, o, why] of cases) {
    const h = setup()
    await propose(h)
    const msg = await auditFromReply(h.host, 't1', line(o))
    expect(msg, what).toContain('adapt')
    expect(msg, what).toContain(why)
    expect(msg, what).toContain('the mod\'s rules say adapt')
    expect(h.files.has(`${CAND}/meta.json`), what).toBe(true) // still a candidate
    expect(h.files.has('/h/.lean-agent/proj/scripts/count-lines/count.py')).toBe(false)
    const a = meta(h).audit
    expect(a.claimed).toBe('adopt')
    expect(a.verdict).toBe('adapt')
    expect(a.changes.join(' ')).toContain(why)
  }
})

test('a write inside a declared output (exact, glob, folder) is fine', async () => {
  const h = setup()
  await propose(h, { outputs: ['stdout', '<outdir>/*.csv', '/tmp/out/'] })
  const m = meta(h)
  expect(judge(m, parseAudit(line({ writes: ['<outdir>/a.csv', '/tmp/out/x/y.txt', 'stdout'] }))! as any, { privacy: [], secrets: [] }).verdict).toBe('adopt')
  expect(judge(m, parseAudit(line({ writes: ['<outdir>/a.txt'] }))! as any, { privacy: [], secrets: [] }).verdict).toBe('adapt')
})

test('secrets are reject; adapt needs concrete changes; reject needs a reason; the answers are all required', async () => {
  let h = setup()
  await propose(h)
  expect(await auditFromReply(h.host, 't1', line({ secrets: true }))).toContain('reject')
  expect(meta(h).status).toBe('rejected')
  h = setup()
  await propose(h)
  expect(await auditFromReply(h.host, 't1', line({ verdict: 'adapt' }))).toContain('needs the concrete changes')
  expect(await auditFromReply(h.host, 't1', line({ verdict: 'reject' }))).toContain('needs a reason')
  expect(await auditFromReply(h.host, 't1', line({ verdict: 'maybe' }))).toContain('adopt, adapt or reject')
  expect(await auditFromReply(h.host, 't1', line({ network: undefined }))).toContain('audit incomplete')
  expect(await auditFromReply(h.host, 't1', line({ verdict: 'adapt', changes: ['take the path from argv'] }))).toContain('take the path from argv')
  expect(await auditFromReply(h.host, 't1', line({ verdict: 'reject', reason: 'reads secrets' }))).toContain('reject (reads secrets)')
  expect(await auditFromReply(h.host, 't1', line())).toContain('only a candidate is audited') // a rejected one is not audited again
})

test('an audit of text the script no longer has is refused; so is an audit of something that is not a candidate', async () => {
  const h = setup()
  await propose(h)
  h.files.set(`${CAND}/count.py`, 'print("tampered")\n')
  expect(await auditFromReply(h.host, 't1', line())).toContain('changed since it was proposed')
  expect(await auditFromReply(h.host, 't1', line({ name: 'ghost' }))).toContain('no candidate ghost')
  expect(await auditFromReply(h.host, 't1', 'no audit line here')).toBeNull()
})

test('a home path or email in the stored text blocks adopt even when the auditor says adopt', async () => {
  const h = setup()
  h.files.set('/tmp/w/p.py', `open("${USER_PATH}/a")\n`)
  await propose(h, { path: '/tmp/w/p.py' })
  const msg = await auditFromReply(h.host, 't1', line())
  expect(msg).toContain('adapt')
  expect(msg).toContain('hardcoded user path')
  expect(h.files.has('/h/.lean-agent/proj/scripts/count-lines/p.py')).toBe(false)
})

test('the report parameter records the auditor line when the hook could not (thread only)', async () => {
  const h = setup()
  await propose(h)
  expect((await scriptTool(h.host, D, { action: 'audit', name: 'count-lines', report: line() })).ok).toBe(false)
  expect((await scriptTool(h.host, T, { action: 'audit', name: 'count-lines', report: 'nonsense' })).ok).toBe(false)
  const r = await scriptTool(h.host, T, { action: 'audit', name: 'count-lines', report: line() })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('adopted')
})

test('decide: desk only, a reason, logged; adopt over a bad audit needs confirm; privacy and secrets are never overridden', async () => {
  const h = setup()
  await propose(h)
  expect((await scriptTool(h.host, T, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'x' })).text).toContain('desk')
  expect((await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt' })).text).toContain('reason')
  expect((await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user said so' })).text).toContain('never audited')
  await auditFromReply(h.host, 't1', line({ network: true }))
  const ask = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user wants it' })
  expect(ask.ok).toBe(false)
  expect(ask.text).toContain('confirm: true')
  expect(ask.text).toContain('uses the network')
  const ok = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'the user wants it', confirm: true })
  expect(ok.ok).toBe(true)
  const m = meta(h, '/h/.lean-agent/proj/scripts/count-lines')
  expect(m.status).toBe('adopted')
  expect(m.decision).toMatchObject({ value: 'adopt', by: 'user', reason: 'the user wants it' })
  expect(m.decision.overrode.join(' ')).toContain('uses the network')
  const log = await readJsonl<any>(h.host, '/h/.lean-agent/scripts/decisions.jsonl')
  expect(log.length).toBe(1)
  expect(log[0]).toMatchObject({ name: 'count-lines', value: 'adopt', by: 'user', prior: 'adapt' })

  const h2 = setup() // privacy: not even the user
  h2.files.set('/tmp/w/p.py', `open("${USER_PATH}/a")\n`)
  await propose(h2, { path: '/tmp/w/p.py' })
  await auditFromReply(h2.host, 't1', line())
  const no = await scriptTool(h2.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'x', confirm: true })
  expect(no.ok).toBe(false)
  expect(no.text).toContain('not even by the user')

  const h3 = setup() // an audit that found secrets
  await propose(h3)
  await auditFromReply(h3.host, 't1', line({ secrets: true }))
  expect((await scriptTool(h3.host, D, { action: 'decide', name: 'count-lines', verdict: 'adopt', reason: 'x', confirm: true })).text).toContain('not adopted')
})

test('decide reject marks it rejected and logs; an adopted script is retired instead', async () => {
  const h = setup()
  await propose(h)
  const r = await scriptTool(h.host, D, { action: 'decide', name: 'count-lines', verdict: 'reject', reason: 'not needed' })
  expect(r.ok).toBe(true)
  expect(meta(h).status).toBe('rejected')
  expect(meta(h).decision.reason).toBe('not needed')
  expect((await readJsonl<any>(h.host, '/h/.lean-agent/scripts/decisions.jsonl'))[0].value).toBe('reject')
  expect((await scriptTool(h.host, T, { action: 'list' })).text).toContain('count-lines · proj · rejected · reject (user decision)')
  const h2 = setup()
  await propose(h2)
  await auditFromReply(h2.host, 't1', line())
  expect((await scriptTool(h2.host, D, { action: 'decide', name: 'count-lines', verdict: 'reject', reason: 'x' })).text).toContain('retire')
})

test('retire moves an adopted script aside and keeps it; list and show report the state and the uses', async () => {
  const h = setup()
  await propose(h)
  await auditFromReply(h.host, 't1', line())
  const dir = '/h/.lean-agent/proj/scripts/count-lines'
  await noteUse(h.host, `python3 ${dir}/count.py /tmp/x.log`, 't1')
  await noteUse(h.host, `python3 ${dir}/count.py /tmp/y.log`, 't1')
  const l = await scriptTool(h.host, D, { action: 'list' })
  expect(l.text.split('\n')[0]).toBe('Scripts: 0 candidates, 1 adopted')
  expect(l.text).toContain('count-lines · proj · adopted · adopt · 2 use(s)')
  const s = JSON.parse((await scriptTool(h.host, D, { action: 'show', name: 'count-lines' })).text)
  expect(s.uses).toBe(2)
  expect(s.command).toBe(`python3 ${dir}/count.py <file>`)
  const r = await scriptTool(h.host, D, { action: 'retire', name: 'count-lines', reason: 'replaced' })
  expect(r.ok).toBe(true)
  expect(h.files.has(`${dir}/count.py`)).toBe(false)
  expect([...h.files.keys()].some(k => k.includes('/scripts/retired/count-lines-') && k.endsWith('/count.py'))).toBe(true)
  expect((await allScripts(h.host)).length).toBe(0)
  expect((await scriptTool(h.host, D, { action: 'retire', name: 'count-lines' })).ok).toBe(false)
})

test('uses: only a Bash command that names an adopted script folder counts', async () => {
  const h = setup()
  await propose(h)
  await auditFromReply(h.host, 't1', line())
  const dir = '/h/.lean-agent/proj/scripts/count-lines'
  await noteUse(h.host, 'ls /h/.lean-agent/scripts/candidates/count-lines/', 't1')
  await noteUse(h.host, 'python3 /h/.lean-agent/proj/scripts/ghost/x.py', 't1')
  await noteUse(h.host, 'echo hi', 't1')
  expect(await useCounts(h.host)).toEqual({})
  await noteUse(h.host, `cd /tmp && python3 ${dir}/count.py a`, 't1')
  expect(await useCounts(h.host)).toEqual({ 'count-lines': 1 })
  const rows = await readJsonl<any>(h.host, '/h/.lean-agent/scripts/uses.jsonl')
  expect(rows[0]).toMatchObject({ name: 'count-lines', project: 'proj', thread: 't1' })
})

test('a script about lean-agent\'s own data is also filed as a core candidate', async () => {
  const h = setup()
  h.files.set('/tmp/w/led.py', 'import json\nfor l in open(HOME + "/.lean-agent/ledger.jsonl"): pass\n')
  const r = await propose(h, { name: 'ledger-total', path: '/tmp/w/led.py', purpose: 'Total the cost ledger', inputs: ['ledger.jsonl'] })
  expect(r.text).toContain('core candidate')
  expect(meta(h, '/h/.lean-agent/scripts/candidates/ledger-total').core).toBe(true)
  const fb = await readJsonl<any>(h.host, '/h/.lean-agent/feedback.jsonl')
  expect(fb).toHaveLength(1)
  expect(fb[0]).toMatchObject({ kind: 'core-candidate', note: 'candidate for lean-agent core', script: 'ledger-total', thread: 't1' })
  await propose(h) // a script about something else is not
  expect(await readJsonl<any>(h.host, '/h/.lean-agent/feedback.jsonl')).toHaveLength(1)
  expect(ownData('totals the ledger.jsonl rows')).toBe(true)
  expect(ownData('counts lines in a log')).toBe(false)
})

test('privacy scrub: a named home path or an email blocks, a parameterised path does not', () => {
  expect(scan(`open("${USER_PATH}/x")`).privacy[0]).toContain('hardcoded user path')
  expect(scan('x = "/home/someone/y"').privacy.length).toBe(1)
  expect(scan(`mail ${EMAIL}`).privacy.length).toBe(1)
  expect(scan(`open(os.path.expanduser("~/x")); p = "$HOME/y"; q = "/${'Users'}/" + n; r = "/home/%s" % n`)).toEqual({ privacy: [], secrets: [] })
  expect(scan('x = "/root/a/b"', '/root').privacy[0]).toContain('home path')
  expect(scan(`k = "${KEY}"`).secrets.length).toBe(1)
  expect(scan('-----BEGIN RSA PRIVATE KEY-----').secrets.length).toBe(1)
  expect(scan('password = "hunter2hunter2"').secrets.length).toBe(1)
  expect(scan('password = os.environ["PW"]').secrets.length).toBe(0)
})

test('the run line: interpreter first, {script}, plain words, <placeholders>', () => {
  expect(runProblem('python3 {script} <ledger.jsonl> <day>')).toBeNull()
  expect(runProblem('node {script} --top 5')).toBeNull()
  expect(runProblem('python3 {script} $(whoami)')).not.toBeNull()
  expect(runProblem('python3 {script}; rm x')).not.toBeNull()
  expect(runProblem('')).not.toBeNull()
})

// ---- the nudge ------------------------------------------------------------------------------------------------------
test('nudge: a scratch script this session wrote and ran, never proposed, is named once at the next prompt', async () => {
  const h = setup()
  h.files.set('/tmp/w/tot.py', 'print(1)\n')
  noteWrite('/tmp/w/tot.py')
  noteBash('python3 /tmp/w/tot.py /tmp/big.jsonl', '/h/.lean-agent', 't1')
  expect(await takeNudges(h.host)).toBe('[lean-agent] you ran /tmp/w/tot.py; if it is reusable, lean_script propose it')
  expect(await takeNudges(h.host)).toBeNull() // once per file
  noteBash('python3 /tmp/w/tot.py again', '/h/.lean-agent', 't1')
  expect(await takeNudges(h.host)).toBeNull()
})

test('nudge: not for a proposed script, an inline command, a file not written this session, or a repo file', async () => {
  const h = setup()
  noteWrite(SRC)
  noteBash(`python3 ${SRC} x`, '/h/.lean-agent', 't1')
  await propose(h) // proposed before the turn ended
  expect(await takeNudges(h.host)).toBeNull()
  h.files.set('/tmp/w/old.py', 'x')
  noteBash('python3 /tmp/w/old.py', '/h/.lean-agent', 't1') // never written by this session
  noteBash('python3 -c "print(1)"', '/h/.lean-agent', 't1')
  h.files.set('/h/.lean-agent/worktrees/proj/tools/gen.py', 'x')
  noteWrite('/h/.lean-agent/worktrees/proj/tools/gen.py')
  noteBash('python3 /h/.lean-agent/worktrees/proj/tools/gen.py', '/h/.lean-agent', 't1') // a repo file, not scratch
  expect(await takeNudges(h.host)).toBeNull()
})

test('nudge: a file made by a shell redirect counts, node/bash/sh run it, a file that is gone is skipped', async () => {
  const h = setup()
  h.files.set('/tmp/q/a.js', 'x')
  noteBash("cat > /tmp/q/a.js <<'EOF'\nconsole.log(1)\nEOF\nnode /tmp/q/a.js", '/h/.lean-agent', 't1')
  h.files.set('/tmp/q/b.sh', 'x')
  noteBash('echo "ls" | tee /tmp/q/b.sh && bash /tmp/q/b.sh', '/h/.lean-agent', 't1')
  noteWrite('/tmp/q/gone.py')
  noteBash('python3 -u /tmp/q/gone.py', '/h/.lean-agent', 't1')
  const n = (await takeNudges(h.host))!.split('\n')
  expect(n).toEqual(['[lean-agent] you ran /tmp/q/a.js; if it is reusable, lean_script propose it', '[lean-agent] you ran /tmp/q/b.sh; if it is reusable, lean_script propose it'])
})

test('nudge: a script in the thread\'s own folder counts as scratch', async () => {
  const h = setup()
  h.files.set('/h/.lean-agent/threads/t1/sum.py', 'x')
  noteWrite('/h/.lean-agent/threads/t1/sum.py')
  noteBash('python3 /h/.lean-agent/threads/t1/sum.py', '/h/.lean-agent', 't1')
  expect(await takeNudges(h.host)).toContain('threads/t1/sum.py')
})

// ---- wiring through the engine ----------------------------------------------------------------------------------------
async function session($: any, on: any, cwd: string, base: () => void = () => undefined) {
  const h = fakeHost(on)
  base()
  resetLocks()
  on('clock.after', () => new Promise(() => {})) // a step's timeout never fires here
  on('clock.every', () => ({ value: { cancel() {} } }))
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/p/templates/front-desk.md', 'desk {{lean}}')
  h.files.set(TH, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(SRC, 'print(1)\n')
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  const reg: string[] = []
  on('tool.register', (_: any, e: any) => { reg.push(e.name); return { value: { tool: `mcp__lean-agent__${e.name}` } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return { h, reg }
}
const TOOL = 'mcp__lean-agent__lean_script'

test('lean_script is registered for a thread and for the desk, and refuses a plain session', async ($, on) => {
  const t = await session($, on, '/h/.lean-agent/threads/t1')
  expect(t.reg).toContain('lean_script')
  const r: any = await $.tool.call({ tool: TOOL, action: 'list' } as any)
  expect(r.result).toContain('Scripts: 0 candidates, 0 adopted')
})

test('lean_script on the desk lists; propose there is refused; on a plain session the tool refuses', async ($, on) => {
  const d = await session($, on, '/h/lean-agent-desk')
  expect(d.reg).toContain('lean_script')
  const r: any = await $.tool.call({ tool: TOOL, action: 'propose', name: 'x', path: SRC } as any)
  expect(r.isError).toBe(true)
  expect(r.result).toContain('threads')
})

test('lean_script refuses in a plain session', async ($, on) => {
  await session($, on, '/somewhere/else')
  const r: any = await $.tool.call({ tool: TOOL, action: 'list' } as any)
  expect(r.isError).toBe(true)
  expect(r.result).toContain('needs a thread session')
})

test('an auditor\'s Agent reply with a LEAN-AUDIT line is recorded by the mod, whatever the thread does next', async ($, on) => {
  const s = await session($, on, '/h/.lean-agent/threads/t1', () => on('tool.call', { tool: 'Agent' }, () => ({ result: `fine\n${line({ network: true })}\nLEAN-FEEDBACK {"status":"done","missing":"","remember":[]}` }) as any))
  await propose(s.h)
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:auditor', prompt: 'audit it' } as any)
  expect(JSON.stringify(r.context)).toContain('count-lines: adapt')
  expect(meta(s.h).audit.network).toBe(true)
  // another agent type's reply is not an audit
  const r2: any = await $.tool.call({ tool: 'Agent', subagent_type: 'lean-agent:reader-haiku', prompt: 'x' } as any)
  expect(JSON.stringify(r2.context ?? '')).not.toContain('count-lines')
})

test('through the engine: a scratch script that ran is nudged once at the next prompt; a run of an adopted one is counted', async ($, on) => {
  const s = await session($, on, '/h/.lean-agent/threads/t1', () => on('tool.call', () => ({ result: 'ok' }) as any))
  s.h.files.set('/tmp/w/tot.py', 'print(1)\n')
  await $.tool.call({ tool: 'Write', file_path: '/tmp/w/tot.py', content: 'print(1)\n' } as any)
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/w/tot.py /tmp/big.jsonl' } as any)
  const a: any = await $.prompt.submit({ text: 'next' } as any)
  expect(JSON.stringify(a.context)).toContain('you ran /tmp/w/tot.py; if it is reusable, lean_script propose it')
  const b: any = await $.prompt.submit({ text: 'again' } as any)
  expect(JSON.stringify(b.context ?? '')).not.toContain('you ran')
  await propose(s.h)
  await auditFromReply(s.h.host, 't1', line())
  await $.tool.call({ tool: 'Bash', command: 'python3 /h/.lean-agent/proj/scripts/count-lines/count.py /tmp/x' } as any)
  expect(await useCounts(s.h.host)).toEqual({ 'count-lines': 1 })
})
