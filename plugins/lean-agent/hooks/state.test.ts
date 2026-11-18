import { expect, test } from 'claude-code/testing'
import { atomicWrite, appendJsonl, readJson, readJsonl } from './state'
import { fakeHost } from './fake'

test('atomic write goes temp then rename, never straight to the target', async ($, on) => {
  const h = fakeHost(on)
  await atomicWrite(h.host, '/h/.lean-agent/a.json', '{"a":1}')
  expect(h.files.get('/h/.lean-agent/a.json')).toBe('{"a":1}')
  expect([...h.files.keys()].filter(k => k.includes('.tmp-'))).toEqual([])
  expect(h.writes.length).toBe(1)
  expect(h.writes[0]!.includes('.tmp-')).toBe(true) // the only fs.write went to a temp name
})

test('jsonl append adds one line per record and reads skip torn lines', async ($, on) => {
  const h = fakeHost(on)
  await appendJsonl(h.host, '/h/.lean-agent/x.jsonl', { n: 1 })
  await appendJsonl(h.host, '/h/.lean-agent/x.jsonl', { n: 2 })
  h.files.set('/h/.lean-agent/x.jsonl', h.files.get('/h/.lean-agent/x.jsonl') + '{"torn\n{"n":3}\n')
  expect(await readJsonl(h.host, '/h/.lean-agent/x.jsonl')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('read is tolerant: missing and damaged files give the fallback', async ($, on) => {
  const h = fakeHost(on)
  expect(await readJson(h.host, '/h/none.json', { d: 1 })).toEqual({ d: 1 })
  h.files.set('/h/bad.json', '{oops')
  expect(await readJson(h.host, '/h/bad.json', { d: 2 })).toEqual({ d: 2 })
  expect(await readJsonl(h.host, '/h/none.jsonl')).toEqual([])
})
