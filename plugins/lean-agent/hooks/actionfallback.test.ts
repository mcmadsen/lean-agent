// The fallback command for the user's own shell (actionfallback.ts, 1.0.33): built from the request's params, quoted for bash / zsh, never with a secret, shown after the SAME kind
// failed twice (the desk's action list, the pane card, the answer of approve-action), with the sentence why a thread cannot run it. Synthetic names only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { WHY_NOT_THREAD, fallbackCommand, fallbackText, looksSecret, shq } from './actionfallback'
import { actionListText, addActionRequest, answerAction, approveAction, listActions, resetActions } from './deskactions'
import { relaxOwnTaskForSpecs } from './owntask'
import { resetLocks } from './threads'
relaxOwnTaskForSpecs()

// what a POSIX shell makes of one command line: the words, with '...' quoting and \' outside quotes (all the builder ever writes). Enough to prove the quoting round-trips.
function words(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let any = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      if (end < 0) throw new Error('unterminated quote')
      cur += cmd.slice(i + 1, end)
      i = end
      any = true
    } else if (c === '\\' && cmd[i + 1] === "'") {
      cur += "'"
      i++
      any = true
    } else if (c === '\\' || c === '$' || c === '`') {
      throw new Error(`unquoted ${c} at ${i}`) // a shell would act on it
    } else if (/\s/.test(c)) {
      if (any) out.push(cur)
      cur = ''
      any = false
    } else {
      cur += c
      any = true
    }
  }
  if (any) out.push(cur)
  return out
}
const flagOf = (ws: string[], name: string): string | undefined => ws.find(w => w.startsWith(`--${name}=`))?.slice(name.length + 3)
const NASTY = ["it's a \"test\"", 'cost $5 and $(rm -rf /) and ${HOME}', 'back`tick`s and \\n backslash', 'two\nlines\n', "'", '-starts-with-dash', 'semi; pipe | amp & redirect > file', 'ünï © 日本語']

test('shq: a quote, $, a backtick, a backslash, a newline and a leading dash are all literal characters in one shell word', () => {
  for (const t of NASTY) expect(words(`cmd --title=${shq(t)}`)).toEqual(['cmd', `--title=${t}`])
  expect(shq("a'b")).toBe("'a'\\''b'")
  expect(shq('x\0y')).toBe("'xy'") // a NUL byte is dropped
})

test('ado-workitem-create: az boards work-item create with every field quoted; the title with quotes, $, backticks and newlines survives; parent and PR links are comment lines, not guesses', () => {
  for (const title of NASTY) {
    const cmd = fallbackCommand('ado-workitem-create', { org: 'acme', project: 'Shop App', type: 'User Story', title, description: `${title}\nmore`, area: 'Shop App\\Team A', iteration: 'Shop App\\Sprint 4', assignedTo: 'dev@example.test' })!
    expect(cmd).toBeTruthy()
    const ws = words(cmd.split('\n# ')[0]!)
    expect(ws.slice(0, 4)).toEqual(['az', 'boards', 'work-item', 'create'])
    expect(flagOf(ws, 'org')).toBe('https://dev.azure.com/acme')
    expect(flagOf(ws, 'project')).toBe('Shop App')
    expect(flagOf(ws, 'type')).toBe('User Story')
    expect(flagOf(ws, 'title')).toBe(title)
    expect(flagOf(ws, 'description')).toBe(`${title}\nmore`)
    expect(flagOf(ws, 'area')).toBe('Shop App\\Team A')
    expect(flagOf(ws, 'iteration')).toBe('Shop App\\Sprint 4')
    expect(flagOf(ws, 'assigned-to')).toBe('dev@example.test')
  }
  const withParent = fallbackCommand('ado-workitem-create', { org: 'acme', project: 'P', type: 'Bug', title: 't', parent: 12, links: [{ pr: 4321 }] })!
  expect(withParent.split('\n')[0]).not.toContain('parent')
  expect(withParent).toContain('# then, with the new id it prints: az boards work-item relation add --id <new id> --relation-type parent --target-id 12')
  expect(withParent).toContain('4321')
  expect(fallbackCommand('ado-workitem-create', { org: 'acme', project: 'P', type: 'Bug' })).toBeNull() // no title: no command
})

test('ado-pr-comment: az rest POST of the thread JSON (one line, the body escaped by JSON, then quoted); an inline comment carries its file, line and side', () => {
  for (const body of NASTY) {
    const cmd = fallbackCommand('ado-pr-comment', { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 4321, body })!
    const ws = words(cmd)
    expect(ws.slice(0, 2)).toEqual(['az', 'rest'])
    expect(flagOf(ws, 'method')).toBe('post')
    expect(flagOf(ws, 'url')).toBe('https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop-api/pullRequests/4321/threads?api-version=7.1')
    const json = JSON.parse(flagOf(ws, 'body')!)
    expect(json.comments[0].content).toBe(body)
    expect(json.threadContext).toBeUndefined()
    expect(cmd.split('\n')).toHaveLength(1) // a newline in the body is JSON's \n, never a line of the command
  }
  const inline = fallbackCommand('ado-pr-comment', { org: 'acme', project: 'P', repo: 'r', pr: 7, body: 'nit', file: 'src/a b/c.ts', line: 10, endLine: 12, side: 'left', status: 'active' })!
  const json = JSON.parse(flagOf(words(inline.split('\n# ')[0]!), 'body')!)
  expect(json.threadContext).toEqual({ filePath: '/src/a b/c.ts', leftFileStart: { line: 10, offset: 1 }, leftFileEnd: { line: 12, offset: 1 } })
  expect(json.status).toBe(1)
})

test('gh-issue-create: gh issue create --repo --title --body, each quoted; the body may be long and multi-line', () => {
  for (const title of NASTY) {
    const body = `${title}\n\n${'line of the export\n'.repeat(50)}$(touch /tmp/x)`
    const ws = words(fallbackCommand('gh-issue-create', { repo: 'acme/lean-agent-feedback', title, body })!)
    expect(ws.slice(0, 3)).toEqual(['gh', 'issue', 'create'])
    expect(flagOf(ws, 'repo')).toBe('acme/lean-agent-feedback')
    expect(flagOf(ws, 'title')).toBe(title)
    expect(flagOf(ws, 'body')).toBe(body)
  }
})

test('a value that looks like a secret gives NO command (the text says why); a kind without a builder has none', () => {
  const tok = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
  expect(looksSecret(tok)).toBe(true)
  expect(looksSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe(true)
  expect(looksSecret('password = hunter2hunter2')).toBe(true)
  expect(looksSecret('the token refresh is flaky')).toBe(false)
  expect(fallbackCommand('gh-issue-create', { repo: 'acme/x', title: 't', body: `see ${tok}` })).toBeNull()
  const t = fallbackText('gh-issue-create', { repo: 'acme/x', title: 't', body: `see ${tok}` }, 2)!
  expect(t).toContain('looks like a secret')
  expect(t).not.toContain(tok)
  expect(fallbackCommand('ado-pr-reply', { org: 'a', project: 'b' })).toBeNull()
  expect(fallbackText('ado-pr-reply', { org: 'a', project: 'b' }, 2)).toBeNull()
  const ok = fallbackText('gh-issue-create', { repo: 'acme/x', title: 't', body: 'b' }, 2)!
  expect(ok).toContain('YOUR OWN shell')
  expect(ok).toContain(WHY_NOT_THREAD)
})

// ---- the same kind failing twice, end to end --------------------------------------------------------------------------------------------------
const L = '/h/.lean-agent'
const TOKEN = 'SECRET-TOKEN-0123456789'
const CREATE = { kind: 'ado-workitem-create', params: { org: 'acme', project: 'Shop App', type: 'Bug', title: "Digest's \"flaky\" test costs $5", description: 'line 1\nline `2`', area: 'Shop App\\Team A' }, why: 'track it' }
function world() {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'telemetry', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? (argv.includes('POST') ? { exitCode: 22, stdout: '{"message":"TF401320: Rule Error for field Area Path."}', stderr: 'curl: (22) The requested URL returned error: 400' } : { exitCode: 0, stdout: JSON.stringify({ value: [], workItems: [], count: 0 }) }) : { exitCode: 127, stdout: '', stderr: 'unknown' })
  return { h, tell: async () => undefined }
}
const failOnce = async (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => {
  const r = await addActionRequest(w.h.host, 't5', { ...CREATE, params: { ...CREATE.params, ...over } } as any)
  expect(r.ok, r.text).toBe(true)
  await answerAction(w.h.host, r.request!.id, 'approve', 'pane')
  return { id: r.request!.id, out: await approveAction(w.h.host, r.request!.id, w.tell) }
}

test('the first failure shows no command; the second shows the command for the user\'s shell in the action list and the answer of approve-action; the third request carries it on its card; the guard sentence is there', async () => {
  const w = world()
  const one = await failOnce(w)
  expect(one.out.ok).toBe(false)
  expect(one.out.text).not.toContain('az boards')
  expect(await actionListText(w.h.host, w.tell)).not.toContain('az boards')
  const two = await failOnce(w, { title: 'second try' })
  expect(two.out.ok).toBe(false)
  expect(two.out.text).toContain('ado-workitem-create failed 2 times')
  expect(two.out.text).toContain("az boards work-item create --org='https://dev.azure.com/acme' --project='Shop App' --type='Bug' --title='second try'")
  expect(two.out.text).toContain(WHY_NOT_THREAD)
  expect(two.out.text).not.toContain(TOKEN)
  const list = await actionListText(w.h.host, w.tell)
  expect(list).toContain(`${two.id} · t5 · ado-workitem-create · failed: HTTP 400`)
  expect(list).toContain('az boards work-item create')
  expect(list).toContain(WHY_NOT_THREAD)
  // the next request of that kind: its card carries the command built from ITS OWN params, with the quoting intact
  const third = await addActionRequest(w.h.host, 't5', CREATE as any)
  expect(third.ok, third.text).toBe(true)
  const view = (await listActions(w.h.host)).find(v => v.id === third.request!.id)!
  expect(view.fallback).toContain("--title='Digest'\\''s \"flaky\" test costs $5'")
  expect(view.fallback).toContain("--description='line 1\nline `2`'")
})

test('the failures of one thread do not count for another thread', async () => {
  const w = world()
  w.h.files.set(`${L}/threads/t6/thread.json`, JSON.stringify({ id: 't6', title: 'other', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  await failOnce(w)
  await failOnce(w, { title: 'again' })
  const other = await addActionRequest(w.h.host, 't6', CREATE as any)
  expect(other.ok, other.text).toBe(true)
  expect((await listActions(w.h.host)).find(v => v.id === other.request!.id)!.fallback).toBeUndefined()
})
