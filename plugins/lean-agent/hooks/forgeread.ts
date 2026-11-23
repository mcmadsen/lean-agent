// Forge READS (az / gh / curl / wget against Azure DevOps or GitHub): ONE fixed allow-list of read-only forms, on the WORDS of one simple
// command (quotes already resolved by the shell scanner). Used by shell.ts (ghDenied / azDenied: so a reader, a worker, the reviewer and
// the thread may run them), by orchestrate.ts (the thread's curl / wget) and by guard.ts (a reader's curl / wget). A form outside the list is
// not allowed; a WRITE is judged by forgewrite.ts (unchanged: "forge writes go through the desk"). Pure: no host, no I/O.
export const FORGE_READ_RULE = 'forge-read'
export const forgeReadRefusal = (): string => 'read it with lean_run get (forge reads by the mod), or one of: az repos pr show, az devops invoke (GET), gh pr view, gh api (GET)'
export const forgeReadHead = /^read it with lean_run get \(forge reads/

const FORGE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:dev\.azure\.com|(?:[\w-]+\.)+visualstudio\.com|api\.github\.com|github\.com)(?::\d+)?(?:[/?#]|$)/i
const prog = (w: string[]): string => (w[0] ?? '').split('/').pop() ?? ''
// curl / wget aimed at a forge host (a word that is a forge URL)
export const isForgeFetch = (w: string[]): boolean => /^(curl|wget)$/.test(prog(w)) && w.slice(1).some(x => FORGE_URL.test(x))
export const isForgeCommand = (w: string[]): boolean => /^(gh|az)$/.test(prog(w)) || isForgeFetch(w)

// a file a forge read may write: a temp folder or the thread's scratch (never a path that climbs out with `..`)
const TEMP = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[^\0]*\/\.claude\/jobs\/[^/]+\/tmp\/|[^\0]*\/\.lean-agent\/tmp\/)/
export const forgeTempOk = (p: string, scratch?: string): boolean => p === '-' || p === '/dev/null' || ((TEMP.test(p) || (!!scratch && p.startsWith(`${scratch}/`))) && !p.split('/').includes('..') && !/[`$]/.test(p))

const LEAD_VALUE = new Set(['-R', '--repo', '--hostname', '--subscription', '-o', '--output', '--organization', '--org', '--project', '-g', '--resource-group', '--query'])
const positionals = (w: string[]): string[] => {
  let i = 0
  while (i < w.length && w[i]!.startsWith('-')) i += LEAD_VALUE.has(w[i]!) ? 2 : 1
  const pos: string[] = []
  for (; i < w.length && !w[i]!.startsWith('-'); i++) pos.push(w[i]!)
  return pos
}
const hasFlag = (w: string[], names: string[]): boolean => w.some(x => names.some(n => x === n || x.startsWith(`${n}=`)))
const flagVal = (w: string[], names: string[]): string | undefined => {
  let out: string | undefined
  w.forEach((x, i) => {
    for (const n of names) {
      if (x === n) out = w[i + 1] ?? ''
      else if (x.startsWith(`${n}=`)) out = x.slice(n.length + 1)
    }
  })
  return out
}
const isGet = (m: string | undefined): boolean => m === undefined || /^get$/i.test(m)

// flags that open a browser, wait forever, take a template or write a file: never in a forge read
const BAD_FLAG = /^(-w|--web|--watch|--template|-t|--output-file)(=|$)|^--(debug|verbose)$|^-[a-zA-Z]*[wt][a-zA-Z]*$/

const GH_READS = new Set(['pr view', 'pr list', 'pr checks', 'pr diff', 'pr status', 'run view', 'run list', 'issue view', 'issue list', 'repo view', 'release view', 'release list'])
const AZ_READS = new Set([
  'repos pr show', 'repos pr list', 'repos pr policy list', 'repos pr reviewer list', 'repos pr work-item list', 'repos show', 'repos list', 'repos ref list',
  'boards work-item show', 'boards query', 'pipelines runs show', 'pipelines runs list', 'pipelines build show', 'pipelines build list', 'pipelines show', 'pipelines list',
  'account show', 'account get-access-token',
])

// `gh api` as a GET: no -X / --method other than GET, no field / input flag (those make it a POST). `gh api graphql` only with a query text
// that starts with `query` or `{` (never a mutation)
function ghApiOk(w: string[]): boolean {
  const VALUE = new Set(['-H', '--header', '-q', '--jq', '-p', '--preview', '--hostname', '--cache', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'])
  let method: string | undefined
  let endpoint = ''
  const fields: string[] = []
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!
    if (/^-X./.test(x)) { method = x.slice(2); continue }
    if (/^-[fF]./.test(x)) { fields.push(x.slice(2)); continue }
    const eq = x.startsWith('--') ? x.indexOf('=') : -1
    const name = eq > 0 ? x.slice(0, eq) : x
    if (VALUE.has(name)) {
      const val = eq > 0 ? x.slice(eq + 1) : (w[++i] ?? '')
      if (name === '-X' || name === '--method') method = val
      else if (name === '--input') return false
      else if (/^(-f|-F|--field|--raw-field)$/.test(name)) fields.push(val)
      continue
    }
    if (x.startsWith('-')) continue
    if (!endpoint) endpoint = x
  }
  if (!isGet(method) || !endpoint) return false
  if (endpoint === 'graphql') {
    const q = fields.find(f => f.startsWith('query='))
    if (q === undefined) return false
    const text = q.slice(6).trimStart()
    return /^(query\b|\{)/.test(text) && !/\b(mutation|subscription)\b/i.test(text) && fields.every(f => !/^[^=]*=@/.test(f))
  }
  return fields.length === 0
}

function azOk(w: string[]): boolean {
  if (w.some(x => /^@|=@/.test(x))) return false // an @file value reads a local file
  const key = positionals(w).join(' ')
  if (AZ_READS.has(key)) return true
  if (key === 'devops invoke') return isGet(flagVal(w, ['--http-method'])) && !hasFlag(w, ['--in-file', '-m', '--method'])
  if (key === 'rest') return isGet(flagVal(w, ['--method', '-m'])) && !hasFlag(w, ['--body', '-b'])
  return false
}

// curl / wget to a forge host: a plain GET. No method but GET, no data / form / upload / json body, no config file, and any output file
// (curl -o, wget -O; wget saves to a file by default, so it needs -O) only in a temp or scratch folder (okFile)
function fetchOk(w: string[], okFile: (p: string) => boolean): boolean {
  const wget = prog(w) === 'wget'
  let forge = 0
  let out = !wget // curl prints to stdout; wget needs an -O
  for (let i = 1; i < w.length; i++) {
    const x = w[i]!
    if (!x.startsWith('-') || x === '-') {
      if (FORGE_URL.test(x)) forge++
      else if (x.includes('://')) return false // another host
      continue
    }
    const eq = x.startsWith('--') ? x.indexOf('=') : -1
    const name = eq > 0 ? x.slice(0, eq) : x
    const val = (): string => (eq > 0 ? x.slice(eq + 1) : (w[++i] ?? ''))
    if (/^-X./.test(x)) { if (!isGet(x.slice(2))) return false; continue }
    if (/^-[dFTKe]./.test(x)) return false
    const own = /^-([sSqnvNfLkiIGg]*)O(.*)$/.exec(x)
    if (wget && own) { if (!okFile(own[2] || (w[++i] ?? ''))) return false; out = true; continue }
    if (/^(-X|--request|--method)$/.test(name)) { if (!isGet(val())) return false; continue }
    if (/^(-d|-F|-T|-K|-e|--config|--execute|--data(-[a-z]+)?|--json|--form(-string)?|--upload-file|--post-data|--post-file|--body-data|--body-file|--post30[123]|--netrc-file)$/.test(name)) return false
    if (/^(-o|--output|-D|--dump-header|-c|--cookie-jar|--trace|--trace-ascii|--stderr|-a|--append-output|--output-document|--output-file)$/.test(name)) {
      if (!okFile(val())) return false
      if (name === '--output-document' || (wget && name === '--output-file')) out = true
      continue
    }
    if (/^(-O|--remote-name|--remote-name-all|--output-dir|-P|--directory-prefix|-J)$/.test(name)) return false
    if (/^-[^-].+/.test(x) && !/^-[sSqnvNfLkiIGg46]+$/.test(x)) return false // a short-flag bundle or an attached value we do not know
  }
  return forge > 0 && out
}

// the allow-list: true = a read-only form (the command is `gh ...`, `az ...`, `curl ...` or `wget ...` as words)
export function forgeReadOk(w: string[], okFile: (p: string) => boolean = forgeTempOk): boolean {
  const p = prog(w)
  const rest = w.slice(1)
  if (p === 'curl' || p === 'wget') return fetchOk(w, okFile)
  if (p !== 'gh' && p !== 'az') return false
  if (rest.some(x => BAD_FLAG.test(x))) return false
  if (p === 'az') return azOk(rest)
  const pos = positionals(rest)
  if (pos[0] === 'api') return ghApiOk(rest.slice(rest.indexOf('api') + 1))
  return pos.length >= 2 && GH_READS.has(`${pos[0]} ${pos[1]}`)
}
