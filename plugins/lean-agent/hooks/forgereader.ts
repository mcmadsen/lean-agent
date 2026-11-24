// The forge Reader of anchor.ts (GETs only: `gh api`, and Azure DevOps REST with the bearer token on curl's stdin, never in an argument list) for callers that cannot import
// deskactions.ts (reviewtool.ts is imported by delivery.ts, which deskactions.ts reaches: a cycle). Same behaviour as deskactions.ts readerOf; the two can be merged later.
import type { Host } from './state'
import type { Reader } from './anchor'
import { azureToken, joinPages } from './prhost'

const curlQ = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
export function forgeReader(h: Host): Reader {
  let tok: Promise<{ token: string } | { error: string }> | null = null
  const parse = (out: unknown): unknown | null => {
    try {
      return JSON.parse(String(out)) as unknown
    } catch {
      return null
    }
  }
  return {
    gh: async (path, paginate) => {
      const r = await h.process.run(['gh', 'api', ...(paginate ? ['--paginate'] : []), '-H', 'Accept: application/vnd.github+json', path], { timeoutMs: 60_000 }).catch(() => null)
      if (!r || r.exitCode !== 0) return null
      return paginate ? joinPages(String(r.stdout)) : parse(r.stdout)
    },
    az: async (method, url, body) => {
      const t = await (tok ??= azureToken(h))
      if ('error' in t) return null
      const config = [`header = ${curlQ(`Authorization: Bearer ${t.token}`)}`, ...(body === undefined ? [] : [`header = ${curlQ('Content-Type: application/json')}`]), `header = ${curlQ('Accept: application/json')}`, ...(body === undefined ? [] : [`data-binary = ${curlQ(JSON.stringify(body))}`]), ''].join('\n')
      const r = await h.process.run(['curl', '-sS', '--fail-with-body', '--max-time', '30', '-X', method, '-K', '-', url], { stdin: config, timeoutMs: 40_000 }).catch(() => null)
      return !r || r.exitCode !== 0 ? null : parse(r.stdout)
    },
  }
}
