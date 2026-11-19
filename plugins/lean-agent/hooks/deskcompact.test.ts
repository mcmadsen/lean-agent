import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { DEFAULT_TOKENS, DESK_COMPACT_INSTRUCTIONS, DESK_RETRY_MS, DESK_RESTARTED, contextTokens, deskHandover, deskNote, deskRetryWanted, deskTick, deskTokens, deskTurnEnded, lastCompaction, resetDeskCompact, restartDesk } from './deskcompact'

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

test('context size is input + cache read + cache write; the desk limit defaults to 200k, config deskTokens overrides it, bad values are ignored', async () => {
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
  const c = deskDeps({ tokens: 150_000 }) // under the new 200k default
  expect(await deskTick(h.host, c.deps)).toBe('quiet')
  expect(c.seen.compact).toEqual([])
  h.files.set(`${L}/config.json`, JSON.stringify({ deskTokens: 300_000 }))
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
  expect(md).toContain('| t1 | fix login | app | open | [working] form / found |')
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

test('restart desk writes the handover now and opens a new desk session', async () => {
  const { h } = setup()
  h.files.set(`${L}/goals.json`, JSON.stringify({ t1: { text: 'ship the login fix', ts: 1 } }))
  let opened = 0
  const ok = await restartDesk(h.host, { recent: async () => ['keep it short'], open: async () => (opened++, { ok: true, text: 'Desk opened in the Claude app.' }) })
  expect(ok).toEqual({ ok: true, text: DESK_RESTARTED })
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
