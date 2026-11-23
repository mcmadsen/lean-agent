// lean_run {get}: a forge READ by the mod, so no token is ever needed in a shell. GET only, Azure DevOps (dev.azure.com) or GitHub (via gh api),
// nothing else. Azure: the bearer token from `az account get-access-token` goes to curl on STDIN (never argv, a log or the output; scrubbed from
// every error), as in prhost.ts. GitHub: `gh api <path>` (argv, gh holds the login). The answer is the JSON, compact, cut to GET_MAX characters,
// with `select` (dotted field paths, applied by script) to keep a few lines; `threads: true` is the one-line-per-thread PR check.
import { azureToken, oneLine } from './prhost'
import type { Host } from './state'

export const GET_MAX = 8000
export type GetRequest = Record<string, unknown>
export type GetResult = { text: string; failed: boolean }

const KEYS = new Set(['host', 'org', 'project', 'repo', 'pr', 'path', 'query', 'threads', 'select', 'method'])
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/
const PATH = /^[A-Za-z0-9][A-Za-z0-9._~/%@=,-]{0,299}$/
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const enc = encodeURIComponent

function restPath(v: unknown): string {
  const p = str(v)
  if (!p) throw new Error('get.path is a REST path (e.g. git/repositories/<repo>/pullRequests/<n>/threads)')
  let d = p
  try {
    d = decodeURIComponent(p)
  } catch {
    throw new Error('get.path is not a valid REST path')
  }
  if (p.includes('..') || d.includes('..') || d.split(/[\\/]/).includes('..')) throw new Error('get.path must not contain ".."')
  if (!PATH.test(p) || p.includes('//')) throw new Error('get.path is a relative REST path: letters, digits and . _ ~ / % @ = , - only (no URL, no query: use get.query)')
  return p
}
function queryString(q: unknown, version: boolean): string {
  const pairs: [string, string][] = []
  if (typeof q === 'string') new URLSearchParams(q).forEach((v, k) => pairs.push([k, v]))
  else if (q !== undefined) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('get.query is an object {name: value}')
    for (const [k, v] of Object.entries(q)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error('get.query values are strings, numbers or booleans')
      pairs.push([k, String(v)])
    }
  }
  if (pairs.length > 20 || pairs.some(([k]) => !/^[A-Za-z0-9_.$-]{1,60}$/.test(k))) throw new Error('get.query: at most 20 plain names')
  if (version && !pairs.some(([k]) => k === 'api-version')) pairs.push(['api-version', '7.1'])
  return pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
}
function selectList(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 30 || v.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(x) || x.split('.').some(s => /^(__proto__|constructor|prototype)$/.test(s)))) throw new Error('get.select is a list of dotted field paths (e.g. ["value.id", "value.status"])')
  return v as string[]
}

// the JSON cut down to the dotted paths: through arrays element by element, an absent path leaves nothing
function pick(v: unknown, segs: string[]): unknown {
  if (!segs.length) return v
  if (Array.isArray(v)) return v.map(x => pick(x, segs))
  if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, segs[0]!)) {
    const r = pick((v as Record<string, unknown>)[segs[0]!], segs.slice(1))
    return r === undefined ? undefined : { [segs[0]!]: r }
  }
  return undefined
}
function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b
  if (b === undefined) return a
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v)
    return out
  }
  return a
}
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter(x => x !== undefined).map(tidy)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, tidy(x)]))
  return v
}
export function selectFields(json: unknown, paths: string[]): unknown {
  let out: unknown
  for (const p of paths) out = merge(out, pick(json, p.split('.')))
  return tidy(out ?? null)
}

const cutTo = (s: string): string => (s.length > GET_MAX ? `${s.slice(0, GET_MAX)}\n…(cut at ${GET_MAX} characters: narrow it with select, query or a deeper path)` : s)
// one line per thread: id, status, the first comment's first 80 characters
export function threadLines(json: unknown): string {
  const list = Array.isArray(json) ? json : Array.isArray((json as { value?: unknown })?.value) ? ((json as { value: unknown[] }).value) : []
  if (!list.length) return 'no threads'
  return list
    .map(t => {
      const th = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
      const first = (Array.isArray(th.comments) ? th.comments[0] : undefined) as Record<string, unknown> | undefined
      const status = typeof th.status === 'string' && th.status ? th.status : th.isDeleted === true ? 'deleted' : 'none'
      return `${typeof th.id === 'number' || typeof th.id === 'string' ? th.id : '?'} · ${status} · ${oneLine(typeof first?.content === 'string' ? first.content : '', 80)}`
    })
    .join('\n')
}

export async function runGet(h: Host, g: GetRequest): Promise<GetResult> {
  for (const k of Object.keys(g)) if (!KEYS.has(k)) throw new Error(`get: unknown field "${k.slice(0, 30)}" (host, org, project, path, query, select; repo, pr, threads for the PR threads check)`)
  if (g.method !== undefined && !/^get$/i.test(str(g.method))) throw new Error('get is GET only: a write goes through the desk (lean_report action kinds)')
  const host = g.host === 'ado' || g.host === 'github' ? g.host : null
  if (!host) throw new Error('get.host must be "ado" or "github" (forge hosts only)')
  const select = selectList(g.select)
  let target: string
  let token = ''
  const scrub = (s: string): string => (token ? s.split(token).join('***') : s)
  let argv: string[]
  let stdin: string | undefined
  if (host === 'ado') {
    const org = str(g.org)
    const project = str(g.project)
    if (!NAME.test(org) || !NAME.test(project)) throw new Error('get host ado needs org and project (names)')
    let path: string
    if (g.threads === true) {
      const repo = str(g.repo)
      const pr = typeof g.pr === 'number' ? g.pr : /^\d{1,12}$/.test(str(g.pr)) ? Number(str(g.pr)) : NaN
      if (g.path !== undefined) throw new Error('get: threads and path are two ways to name the same read: give one')
      if (!NAME.test(repo) || !Number.isInteger(pr) || pr < 1) throw new Error('get threads needs repo (a name) and pr (a number)')
      path = `git/repositories/${enc(repo)}/pullRequests/${pr}/threads`
    } else {
      if (g.repo !== undefined || g.pr !== undefined || g.threads !== undefined) throw new Error('get: repo, pr and threads go with threads: true (otherwise put them in path)')
      path = restPath(g.path)
    }
    if (/^_?apis(\/|$)/i.test(path)) throw new Error('get.path starts under the project (without _apis)')
    target = `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/${path}?${queryString(g.query, true)}`
    const t = await azureToken(h)
    if ('error' in t) throw new Error(t.error)
    token = t.token
    argv = ['curl', '-sS', '-f', '-H', '@-', target]
    stdin = `Authorization: Bearer ${token}\nAccept: application/json\n`
  } else {
    if (g.threads !== undefined || g.pr !== undefined || g.repo !== undefined || g.org !== undefined || g.project !== undefined) throw new Error('get host github takes path (e.g. repos/<owner>/<repo>/pulls/<n>/comments), query and select')
    const path = restPath(g.path)
    if (/^graphql(\/|$)/i.test(path)) throw new Error('get is GET only: graphql is a POST')
    const q = queryString(g.query, false)
    target = q ? `${path}?${q}` : path
    argv = ['gh', 'api', target, '-H', 'Accept: application/vnd.github+json']
  }
  const r = await h.process.run(argv, { timeoutMs: 60_000, ...(stdin !== undefined ? { stdin } : {}) }).catch((e: unknown) => ({ exitCode: 127, stdout: '', stderr: String((e as Error)?.message ?? e) }))
  if (r.exitCode !== 0) throw new Error(scrub(oneLine(r.stderr || r.stdout || `exit ${r.exitCode}`, 200)))
  let json: unknown
  try {
    json = JSON.parse(r.stdout)
  } catch {
    return { text: cutTo(scrub(r.stdout.trim())) || 'empty answer', failed: false }
  }
  const text = g.threads === true ? threadLines(json) : select.length ? JSON.stringify(selectFields(json, select)) : JSON.stringify(json)
  return { text: cutTo(scrub(text)), failed: false }
}
