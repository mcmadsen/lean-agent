// The desk's tool replies stay small (its conversation keeps every one): lean_thread list is one short line per thread, a start / restart / send reply is
// at most 3 lines, lean_doctor check prints the FIX rows and a count. The sizes are pinned here so they cannot grow back. Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { checkReply } from './doctor'
import { LIST_LINE_MAX, REPLY_LINES, REPLY_TAIL_MAX, leanThread, listLine, threeLines } from './threads'

test('listLine: id, state word, ctx, today, the first 80 characters of the last report; never longer than LIST_LINE_MAX', () => {
  const l = listLine({ id: 't3', title: 'parser work', state: 'open', live: 'running', ctx: 'ctx 108k/120k', today: 'today $0.42 (reviews $0.10)', lastText: `${'word '.repeat(60)}` })
  expect(l.startsWith('t3 running · ctx 108k/120k · today $0.42 · "word word')).toBe(true)
  expect(l).not.toContain('reviews')
  expect(l.length).toBeLessThanOrEqual(LIST_LINE_MAX)
  expect(listLine({ id: 't4', title: 'x'.repeat(100), state: 'closed' }).length).toBeLessThanOrEqual(LIST_LINE_MAX) // no report: the title, cut
  expect(listLine({ id: 't5', state: 'open', live: 'idle', stale: true, lastText: 'a' })).toContain('t5 idle (report stale)')
})

test('lean_thread list: one line per thread by default, the long form with verbose: true', async () => {
  const h = fakeHost(null)
  for (const n of [1, 2, 3]) h.files.set(`/h/.lean-agent/threads/t${n}/thread.json`, JSON.stringify({ id: `t${n}`, title: `Task number ${n} with a title`, project: 'demo', state: 'open', sid: '', lastWake: 0, model: 'sonnet', effort: 'high' }))
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', `${JSON.stringify({ ts: 1, from: 't2', kind: 'report', state: 'done', text: `merged the change. ${'details '.repeat(100)}` })}\n`)
  const short = await leanThread(h.host, '/p', { action: 'list' })
  const long = await leanThread(h.host, '/p', { action: 'list', verbose: true })
  const rows = short.text.split('\n').filter(l => /^t\d /.test(l))
  expect(rows).toHaveLength(3)
  for (const r of rows) expect(r.length).toBeLessThanOrEqual(LIST_LINE_MAX)
  expect(rows[1]).toContain('"merged the change. details')
  expect(short.text).not.toContain('sonnet/high')
  expect(long.text).toContain('sonnet/high')
  expect(short.text.length).toBeLessThan(3 * LIST_LINE_MAX + 100) // pinned: three threads, three short lines
})

test('start / restart / send replies: at most 3 lines (the rest joins the third, cut); a long one-line reply is not cut here', () => {
  expect(threeLines('a\nb\nc')).toBe('a\nb\nc')
  const t = threeLines('1\n2\n3\n4\n5')
  expect(t.split('\n')).toHaveLength(REPLY_LINES)
  expect(t).toBe('1\n2\n3 · 4 · 5')
  expect(threeLines(['x', 'y', 'z'.repeat(1000), 'w'].join('\n')).split('\n')[2]!.length).toBeLessThanOrEqual(REPLY_TAIL_MAX)
  expect(threeLines('one line\n\n')).toBe('one line')
})

test('a send to a thread that has no session answers in one short line', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'x', project: 'demo', state: 'open', sid: '', lastWake: 0 }))
  const r = await leanThread(h.host, '/p', { action: 'send', tN: 't1', text: 'hello' })
  expect(r.text.split('\n').length).toBeLessThanOrEqual(REPLY_LINES)
  expect(r.text.length).toBeLessThan(400)
})

test('lean_doctor check: only the FIX rows and a count of the rest; verbose lists every row', () => {
  const rows = ['ok   claude 2.1', 'ok   desk folder', 'FIX  login opener missing', 'ok   trust', 'note: something']
  const short = checkReply(rows, false)
  expect(short).toContain('FIX  login opener missing')
  expect(short).not.toContain('desk folder')
  expect(short).toContain('4 other row(s) not shown')
  expect(short.split('\n')).toHaveLength(2)
  expect(checkReply(rows, true)).toBe(rows.join('\n'))
  expect(checkReply(['ok   a', 'ok   b'], false)).toBe('2 other row(s) ok: nothing to fix; verbose: true lists them')
  expect(checkReply(['ok   a', 'ok   b'], false).length).toBeLessThan(80) // pinned
})
