import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { DEFAULT_TOKENS, DESK_COMPACT_INSTRUCTIONS, DESK_RETRY_MS, DESK_RESTARTED, contextTokens, deskHandover, deskNote, deskRetryWanted, deskTick, deskTokens, deskTurnEnded, lastCompaction, resetDeskCompact, restartDesk, serveHandover } from './deskcompact'

const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`

function setup(thread: Record<string, unknown> = {}) {
  resetDeskCompact()
  const h = fakeHost(null)
  h.clock.t = 10_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify({ id: 't1', title: 'fix login', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0, ...thread }))
  return { h }
}

function deskDeps(o: { tokens?: number; busy?: boolean; compact?: (i: string) => Promise<unknown> } = {}) {
  const seen = { compact: [] as string[], status: [] as string[], reset: 0, notes: 0 }
  return {
    seen,
    deps: {
      tokens: async () => o.tokens ?? 250_000,
      busy: () => o.busy ?? false,
      compact: async (i: string) => {
        seen.compact.push(i)
        return o.compact ? o.compact(i) : { messages: [] }
      },
      notes: async () => void seen.notes++,
      recent: async () => ['please keep the pane short', 'use sonnet for t3'],
      status: (t: string) => void seen.status.push(t),
      reset: () => void seen.reset++,
    },
  }
}

test('context size is input + cache read + cache write; the desk limit defaults to 200k (1.0.33), config deskTokens overrides it, bad values are ignored', async () => {
  expect(contextTokens({ input_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 300 })).toBe(321)
  expect(contextTokens(null)).toBe(0)
  expect(DEFAULT_TOKENS).toBe(200_000)
  const { h } = setup()
  expect(await deskTokens(h.host)).toBe(200_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 150_000 }))
  expect(await deskTokens(h.host)).toBe(150_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 5 }))
  expect(await deskTokens(h.host)).toBe(200_000) // too small a value is ignored
  h.files.set(`${L}/config.json`, JSON.stringify({ checkpoint: { deskTokens: 120_000 } })) // the 1.0.6 key is still read
  expect(await deskTokens(h.host)).toBe(120_000)
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 90_000, checkpoint: { deskTokens: 120_000 } }))
  expect(await deskTokens(h.host)).toBe(90_000)
})

test('an idle desk over its limit compacts itself with the fixed instructions; below it, or busy, it does not', async () => {
  const { h } = setup()
  const a = deskDeps()
  expect(await deskTick(h.host, a.deps)).toBe('compacted')
  expect(a.seen.compact).toEqual([DESK_COMPACT_INSTRUCTIONS])
  expect(a.seen.notes).toBe(1)
  expect(a.seen.reset).toBe(1)
  for (const w of ['goals', 'open threads table', 'unanswered thread question', 'preferences', 'pending approvals', 'tool outputs', 'old report texts']) expect(DESK_COMPACT_INSTRUCTIONS).toContain(w)
  const b = deskDeps({ busy: true })
  expect(await deskTick(h.host, b.deps)).toBe('busy')
  expect(b.seen.compact).toEqual([])
  const c = deskDeps({ tokens: 40_000 }) // under 80% of the 60k default
  expect(await deskTick(h.host, c.deps)).toBe('quiet')
  expect(c.seen.compact).toEqual([])
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 400_000 }))
  expect(await deskTick(h.host, deskDeps().deps)).toBe('quiet')
})

test('a hook veto is recorded with its reason (record, notice, doctor), not turned into a handover, and tried again when the turn ends', async () => {
  const { h } = setup()
  const v = deskDeps({ compact: async () => ({ skip: 'a hook said no' }) })
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  expect(v.seen.reset).toBe(0)
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  const rec = await lastCompaction(h.host)
  expect([rec?.result, rec?.reason, rec?.tokens]).toEqual(['vetoed', 'a hook said no', 250_000])
  expect(h.files.get(`${L}/notices/desk-compaction.txt`)).toContain('vetoed')
  expect(h.files.get(`${L}/notices/desk-compaction.txt`)).toContain('a hook said no')
  h.files.set('/plug/opener/open-desk.sh', 'x')
  h.claude.handler = () => ({ exitCode: 0, stdout: '2.1.327' })
  expect((await check(h.host, '/plug')).join('\n')).toMatch(/FIX {2}last desk compaction .*vetoed .*: a hook said no/)
  // not again for a while ...
  expect(await deskTick(h.host, v.deps)).toBe('quiet')
  expect(v.seen.compact.length).toBe(1)
  // ... unless the desk's turn ended: the next tick tries at once
  expect(deskRetryWanted()).toBe(true)
  deskTurnEnded()
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  expect(v.seen.compact.length).toBe(2)
  // the retry that works clears the notice and records the success
  const ok = deskDeps()
  deskTurnEnded()
  expect(await deskTick(h.host, ok.deps)).toBe('compacted')
  expect((await lastCompaction(h.host))?.result).toBe('compacted')
  expect(h.files.has(`${L}/notices/desk-compaction.txt`)).toBe(false)
  expect(deskRetryWanted()).toBe(false)
  expect((await check(h.host, '/plug')).join('\n')).toMatch(/ok {3}last desk compaction .*compacted/)
})

test('a hook that vetoes every time ends in the handover file and the /compact line; the notes are written once per episode; recovery clears the record', async () => {
  const { h } = setup()
  const v = deskDeps({ compact: async () => ({ skip: 'always no' }) })
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  for (let i = 0; i < 1; i++) {
    deskTurnEnded()
    expect(await deskTick(h.host, v.deps)).toBe('skipped')
  }
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  deskTurnEnded()
  expect(await deskTick(h.host, v.deps)).toBe('fallback') // the third veto in a row
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(true)
  expect(v.seen.status).toEqual(['desk context 250k: type /compact (or start a new desk session; it reads the handover)'])
  expect(v.seen.notes).toBe(1)
  expect(h.files.get(`${L}/notices/desk-compaction.txt`)).toContain('always no')
  // the user compacts by hand: the context is small again, the line, the notice and the doctor row are gone
  const low = deskDeps({ tokens: 20_000 })
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  expect(h.files.has(`${L}/notices/desk-compaction.txt`)).toBe(false)
  expect((await lastCompaction(h.host))?.result).toBe('compacted')
})

test('without a turn end a veto is tried again after the retry gap', async () => {
  const { h } = setup()
  const v = deskDeps({ compact: async () => ({ skip: 'later' }) })
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  h.clock.t += DESK_RETRY_MS
  expect(await deskTick(h.host, v.deps)).toBe('skipped')
  expect(v.seen.compact.length).toBe(2)
})

test('a failed compact is recorded with its reason; twice in a row (or an engine without it) writes desk/handover.md and the /compact status line', async () => {
  const r = setup()
  r.h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } })) // (the desk handover is core by default since 1.0.31: deskbudget.test.ts)
  r.h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  r.h.files.set(`${L}/desk/inbox.jsonl`, JSON.stringify({ ts: 5, from: 't1', kind: 'report', state: 'working', text: 'form | found' }) + '\n')
  r.h.files.set(`${L}/questions.jsonl`, JSON.stringify({ ts: 4, from: 't1', question: 'which login page?', answered: false }) + '\n')
  const bad = deskDeps({ compact: async () => { throw new Error('session.compact is not available') } })
  expect(await deskTick(r.h.host, bad.deps)).toBe('fallback')
  const rec = await lastCompaction(r.h.host)
  expect([rec?.result, rec?.reason]).toEqual(['failed', 'session.compact is not available'])
  expect(r.h.files.get(`${L}/notices/desk-compaction.txt`)).toContain('failed')
  const md = r.h.files.get(`${L}/desk/handover.md`)!
  expect(md).toContain('context 250k')
  expect(md).toContain('- t1: ship the login fix')
  expect(md).toContain('| t1 | fix login | app | open | ship the login fix | [working] form / found |') // (its goal is what it is doing: no task yet)
  expect(md).toContain('which login page?')
  expect(md).toContain('use sonnet for t3')
  expect(md.toLowerCase()).not.toContain('checkpoint')
  expect(bad.seen.status).toEqual(['desk context 250k: type /compact (or start a new desk session; it reads the handover)'])
  expect(deskNote()).toBe(bad.seen.status[0])
  expect(bad.seen.reset).toBe(0)
  // the status line is put back while it stays over (a status line may have been replaced), no second handover write
  const writes = r.h.writes.filter(p => p.includes('handover.md')).length
  expect(await deskTick(r.h.host, bad.deps)).toBe('fallback')
  expect(bad.seen.status.length).toBe(2)
  expect(r.h.writes.filter(p => p.includes('handover.md')).length).toBe(writes)
  expect(bad.seen.compact.length).toBe(1)
  // under the limit again (a new session): the note goes away
  expect(await deskTick(r.h.host, deskDeps({ tokens: 10_000 }).deps)).toBe('quiet')
  expect(deskNote()).toBe('')
})

// the engine's own text in a headless (SDK) session, as the pane showed it
const HEADLESS_TEXT = 'lean-agent: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on; it is tried again when the desk turn ends (or type /compact, or start a new desk session)'
const MANUAL = 'desk context 250k: the app cannot compact the desk automatically. Press Restart desk (fresh desk with the handover) or type /compact'

test('a headless (SDK) session cannot compact: asked once, no failure row, no notice, one calm line; the doctor shows an info note, not FIX', async () => {
  const { h } = setup()
  const d = deskDeps({ compact: async () => { throw new Error(HEADLESS_TEXT) } })
  expect(await deskTick(h.host, d.deps)).toBe('fallback')
  expect(d.seen.status).toEqual([MANUAL])
  expect(deskNote()).toBe(MANUAL)
  expect((await lastCompaction(h.host))?.result).toBe('unavailable')
  expect(h.files.has(`${L}/notices/desk-compaction.txt`)).toBe(false) // no red notice
  expect(h.files.get(`${L}/desk/handover.md`)).toContain('# Desk handover') // the app cannot compact: the handover is written at the limit (Restart desk opens the new desk)
  expect(deskRetryWanted()).toBe(false)
  // never again in this session: not at the turn end, not after the retry gap
  deskTurnEnded()
  h.clock.t += DESK_RETRY_MS * 3
  expect(await deskTick(h.host, d.deps)).toBe('fallback')
  expect(d.seen.compact.length).toBe(1)
  expect(deskRetryWanted()).toBe(false)
  h.files.set('/plug/opener/open-desk.sh', 'x')
  h.claude.handler = () => ({ exitCode: 0, stdout: '2.1.327' })
  const rows = (await check(h.host, '/plug')).filter(l => l.includes('last desk compaction'))
  expect(rows.length).toBe(1)
  expect(rows[0]).toMatch(/^note {1}last desk compaction at .* UTC: not possible in this session; desk context 250k: the app cannot compact/)
  expect(rows[0]).not.toMatch(/^FIX/)
  // the context falls below the limit (a restart, a /compact by hand): the line and the record go
  const low = deskDeps({ tokens: 20_000 })
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  expect(deskNote()).toBe('')
  expect((await lastCompaction(h.host))?.result).toBe('compacted')
})

test('a 1.0.8 record of the headless rejection reads as unavailable; both message shapes and any "not available" for session.compact are hopeless (no retry)', async () => {
  const { h } = setup()
  h.files.set(`${L}/desk/compact.json`, JSON.stringify({ ts: 1, tokens: 263_000, result: 'failed', reason: HEADLESS_TEXT.slice(0, 160) }))
  expect((await lastCompaction(h.host))?.result).toBe('unavailable')
  for (const msg of ['session.compact is not available', 'lean-agent: $.session.compact: not available here', 'not available: session.compact', 'x is not a function', HEADLESS_TEXT, '$.session.compact: not available in a headless (-p / SDK) session']) {
    const r = setup()
    const d = deskDeps({ compact: async () => { throw new Error(msg) } })
    expect(await deskTick(r.h.host, d.deps)).toBe('fallback')
    expect(deskRetryWanted()).toBe(false)
  }
  // a transient failure is not hopeless
  const t = setup()
  expect(await deskTick(t.h.host, deskDeps({ compact: async () => { throw new Error('overloaded, 529') } }).deps)).toBe('skipped')
})

test('a transient rejection is recorded and tried again at the turn end before the handover file; the status line is cleared when the reason is gone', async () => {
  const { h } = setup()
  let n = 0
  const d = deskDeps({ compact: async () => { n++; throw new Error('overloaded, try again') } })
  expect(await deskTick(h.host, d.deps)).toBe('skipped')
  expect((await lastCompaction(h.host))?.reason).toBe('overloaded, try again')
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  expect(deskRetryWanted()).toBe(true)
  expect(await deskTick(h.host, d.deps)).toBe('quiet') // not before the turn ends
  deskTurnEnded()
  expect(await deskTick(h.host, d.deps)).toBe('fallback') // twice in a row
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(true)
  expect(n).toBe(2)
  expect(deskRetryWanted()).toBe(false)
  // the context fell below the limit (a new session or a compaction by hand): the line is cleared, once
  const low = deskDeps({ tokens: 20_000 })
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  expect(await deskTick(h.host, low.deps)).toBe('quiet')
  expect(low.seen.status).toEqual([''])
  // a later success after a fallback clears it too
  const e = setup()
  const bad = deskDeps({ compact: async () => { throw new TypeError('x is not a function') } })
  expect(await deskTick(e.h.host, bad.deps)).toBe('fallback') // an engine without session.compact: no retry
  e.h.clock.t += DESK_RETRY_MS
  const good = deskDeps()
  expect(await deskTick(e.h.host, good.deps)).toBe('compacted')
  expect(good.seen.status).toEqual([''])
  expect(deskNote()).toBe('')
})

test('a compact that is rejected because a turn started meanwhile is no failure: nothing recorded, no handover, tried at the turn end', async () => {
  const { h } = setup()
  let busy = false
  const d = deskDeps({ compact: async () => { busy = true; throw new Error('a turn is running') } })
  expect(await deskTick(h.host, { ...d.deps, busy: () => busy })).toBe('busy')
  expect(h.files.has(`${L}/desk/handover.md`)).toBe(false)
  expect(await lastCompaction(h.host)).toBeNull()
  expect(d.seen.status).toEqual([])
  expect(deskRetryWanted()).toBe(true)
})

test('the handover marks a finished thread and carries no checkpoint count', async () => {
  const { h } = setup({ finished: 5, checkpoints: 2 })
  const md = await deskHandover(h.host, 0, [])
  expect(md).toContain('open (finished: the next message starts a new session)')
  expect(md).toContain('size unknown')
  expect(md.toLowerCase()).not.toContain('checkpoint')
})

test('serving the handover renames it to handover-read-<date>.md, keeps the last 3, and names the new path; nothing waiting says nothing', async () => {
  const { h } = setup()
  const D = `${L}/desk`
  expect(await serveHandover(h.host)).toBeNull()
  const served: string[] = []
  for (let i = 0; i < 5; i++) {
    h.clock.t += 60_000
    h.files.set(`${D}/handover.md`, `# handover ${i}`)
    const line = await serveHandover(h.host)
    expect(h.files.has(`${D}/handover.md`)).toBe(false)
    const path = /in (\S+handover-read-\S+\.md):/.exec(line ?? '')?.[1]
    expect(line).not.toContain('(written ') // (these test files carry no first line)
    expect(path).toMatch(/^\/h\/\.lean-agent\/desk\/handover-read-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.md$/)
    expect(h.files.get(path!)).toBe(`# handover ${i}`)
    served.push(path!)
  }
  const left = [...h.files.keys()].filter(k => k.includes('/handover-read-')).sort()
  expect(left).toEqual(served.slice(-3)) // the newest three
  // two starts in one second never overwrite each other
  h.files.set(`${D}/handover.md`, 'a')
  await serveHandover(h.host)
  h.files.set(`${D}/handover.md`, 'b')
  await serveHandover(h.host)
  const texts = [...h.files].filter(([k]) => k.includes('/handover-read-')).map(([, v]) => v)
  expect(texts).toContain('a')
  expect(texts).toContain('b')
  // a real handover says when it was written
  h.files.set(`${D}/handover.md`, '# Desk handover (written 2026-11-01T10:00:00.000Z, context 250k)\n\nbody')
  expect(await serveHandover(h.host)).toContain('(written 2026-11-01T10:00:00.000Z)')
  // a move that fails leaves the handover where it was, and says nothing
  h.files.set(`${D}/handover.md`, 'c')
  const run = h.host.process.run
  h.host.process.run = async (argv: string[], init?: any) => (argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'denied' } : run(argv, init))
  expect(await serveHandover(h.host)).toBeNull()
  expect(h.files.get(`${D}/handover.md`)).toBe('c')
})

test('a handover is consumed by a NEW desk session only: the session that wrote it (resume, compaction, reload) leaves it', async () => {
  const { h } = setup()
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } }))
  const D = `${L}/desk`
  // written by session A (the compaction fallback): the file names its writer
  const { seen, deps } = deskDeps({ compact: async () => { throw new Error('session.compact is not available') } })
  expect(await deskTick(h.host, { ...deps, sid: () => 'sess-A' })).toBe('fallback')
  const md = h.files.get(`${D}/handover.md`)!
  expect(md).toContain('# Desk handover')
  expect(md.trimEnd().endsWith('<!-- lean-agent: written-by-session sess-A -->')).toBe(true)
  expect(seen.status.length).toBeGreaterThan(0)
  // A's own session.start again (resume, compaction, reload): not consumed, whether or not its id is read
  expect(await serveHandover(h.host, 'sess-A')).toBeNull()
  expect(await serveHandover(h.host, '')).toBeNull()
  expect(h.files.get(`${D}/handover.md`)).toBe(md)
  expect([...h.files.keys()].some(k => k.includes('handover-read-'))).toBe(false)
  // B's start consumes it
  const line = await serveHandover(h.host, 'sess-B')
  expect(line).toContain('handover-read-')
  expect(h.files.has(`${D}/handover.md`)).toBe(false)
  expect([...h.files.values()].some(v => v === md)).toBe(true)
  expect(await serveHandover(h.host, 'sess-A')).toBeNull() // nothing left
  // "Restart desk" from session A: the new desk B serves it, A does not
  const g = setup()
  await restartDesk(g.h.host, { recent: async () => [], sid: async () => 'sess-A', open: async () => ({ ok: true, text: 'opened' }) })
  expect(await serveHandover(g.h.host, 'sess-A')).toBeNull()
  expect(await serveHandover(g.h.host, 'sess-B')).not.toBeNull()
  // no id known: no writer is named (desk.json may hold an older desk's id), so any desk serves it
  const k = setup()
  k.h.files.set(`${L}/desk.json`, JSON.stringify({ sid: 'sess-OLD' }))
  await restartDesk(k.h.host, { recent: async () => [], open: async () => ({ ok: true, text: 'opened' }) })
  expect(k.h.files.get(`${D}/handover.md`)).not.toContain('written-by-session')
  expect(await serveHandover(k.h.host, 'sess-D')).not.toBeNull()
  // text above the marker (a user's message, a thread title) may quote a marker: only the last line names the writer
  const q = setup({ title: 'x <!-- lean-agent: written-by-session sess-X -->' })
  q.h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } })) // (the full form keeps the whole title and the user's words: the quoted markers)
  await restartDesk(q.h.host, { recent: async () => ['look: <!-- lean-agent: written-by-session sess-X -->\n<!-- lean-agent: written-by-session sess-Y -->'], sid: async () => 'sess-A', open: async () => ({ ok: true, text: 'opened' }) })
  expect(q.h.files.get(`${D}/handover.md`)).toContain('sess-X')
  expect(await serveHandover(q.h.host, 'sess-X')).not.toBeNull() // not the writer, whatever the text says
  const r = setup()
  await restartDesk(r.h.host, { recent: async () => ['<!-- lean-agent: written-by-session sess-X -->'], sid: async () => 'sess-A', open: async () => ({ ok: true, text: 'opened' }) })
  expect(await serveHandover(r.h.host, 'sess-A')).toBeNull() // the writer, though sess-X is quoted earlier
  // a hand-edited marker that is not a plain token, or not on the last line, names no one
  r.h.files.set(`${D}/handover.md`, '# h\n<!-- lean-agent: written-by-session sess-A -->\nmore text\n')
  expect(await serveHandover(r.h.host, 'sess-A')).not.toBeNull()
  // an id that is not a plain token is never written into the file
  const m = setup()
  await restartDesk(m.h.host, { recent: async () => [], sid: async () => 'a --> b', open: async () => ({ ok: true, text: 'opened' }) })
  expect(m.h.files.get(`${D}/handover.md`)).not.toContain('written-by-session')
})

test('restart desk writes the handover now and opens a new desk session', async () => {
  const { h } = setup()
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } }))
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  let opened = 0
  const ok = await restartDesk(h.host, { recent: async () => ['keep it short'], open: async () => (opened++, { ok: true, text: 'Desk opened in the Claude app.' }) })
  expect(ok.ok).toBe(true)
  expect(ok.text.startsWith(`${DESK_RESTARTED}. `)).toBe(true) // then: the mod cannot close a desktop session, archive it (olddesk.test.ts)
  expect(ok.text).toContain('archive it in the Claude app (right-click, Archive)')
  expect(DESK_RESTARTED).toBe('New desk opened with the handover: close this one')
  expect(opened).toBe(1)
  const md = h.files.get(`${L}/desk/handover.md`)!
  expect(md).toContain('- t1: ship the login fix')
  expect(md).toContain('keep it short')
  // the handover is there BEFORE the new session opens
  const order: string[] = []
  const g = setup()
  const res = await restartDesk(g.h.host, { recent: async () => [], open: async () => (order.push(g.h.files.has(`${L}/desk/handover.md`) ? 'handover first' : 'no handover'), { ok: false, text: 'The Claude app is not running' }) })
  expect(order).toEqual(['handover first'])
  expect(res.ok).toBe(false)
  expect(res.text).toContain(`${L}/desk/handover.md`)
  expect(res.text).toContain('The Claude app is not running')
})
