// Adopted scripts in the learned rules (scripts.ts adopts, this keeps the rules in step). The source of truth is the script store:
// between the markers <!-- lean-agent:scripts --> ... <!-- /lean-agent:scripts --> of a project's rule files the mod writes ONE line
// per adopted script, regenerated from the store at every sync, so adopt, retire, update, rollback and "needs update" never need a
// hand edit and a learn / trim rewrite of the rule loses nothing. A script goes to the rule of the area its declared inputs/outputs
// paths fall in (learn.json globs), else to `_project`; a global script goes to `_project`. The caps of the rules hold: what does not
// fit an area rule goes to `_project`, what does not fit there becomes one "N more scripts" pointer. `_project` also carries, once,
// the line that says to prefer scripts over model work.
import { atomicWrite, homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { MAX_PROJECT_LINES, MAX_RULE_LINES, bodyLines, matches, pathsIn, projectDir, slugOk, syncRules } from './rules'
import type { Learn } from './rules'
import { expandRun, hashText } from './recipe'
import type { Meta } from './recipe'

export const MARK_OPEN = '<!-- lean-agent:scripts -->'
export const MARK_CLOSE = '<!-- /lean-agent:scripts -->'
export const PREFACE = '- Prefer scripts over model work for counting, summing, listing, transforming; known scripts are listed in the area rules; propose new ones with lean_script propose.'
const BLOCK = /\n*<!-- lean-agent:scripts -->[\s\S]*?<!-- \/lean-agent:scripts -->\n*/
const withBlock = (base: string, lines: string[]) => `${base.replace(/\n*$/, '\n')}${MARK_OPEN}\n${lines.join('\n')}\n${MARK_CLOSE}\n`

type Row = { meta: Meta; dir: string }
async function adopted(h: Host, base: string): Promise<Row[]> {
  const out: Row[] = []
  for (const d of (await h.fs.list(base).catch(() => [])).filter(f => f.kind === 'dir' && f.name !== 'candidates' && f.name !== 'retired')) {
    const meta = await readJson<Meta | null>(h, `${base}/${d.name}/meta.json`, null)
    if (meta && meta.status === 'adopted' && meta.name === d.name) out.push({ meta, dir: `${base}/${d.name}` })
  }
  return out
}

// the rule line for one adopted script; the suffix says when it should not be trusted blindly
async function lineOf(h: Host, r: Row): Promise<string> {
  const code = await h.fs.read(`${r.dir}/${r.meta.file}`).catch(() => null)
  const edited = typeof code !== 'string' || hashText(code) !== r.meta.sha256
  const suffix = edited ? ' (edited, unaudited)' : r.meta.state === 'needs-update' ? ' (needs update)' : ''
  const purpose = r.meta.purpose.replace(/\s+/g, ' ').slice(0, 140)
  return `- ${purpose}: run \`${expandRun(r.meta, r.dir)}\` (script, do not compute this by reading files)${suffix}`
}

export async function rebuildScriptRules(h: Host, project: string): Promise<string[]> {
  if (!slugOk(project)) return []
  const home = await homeDir(h)
  const pdir = projectDir(home, project)
  const own = await adopted(h, `${pdir}/scripts`)
  const global = await adopted(h, `${leanDir(home)}/scripts`)
  const files = (await h.fs.list(`${pdir}/rules`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name)
  if (!own.length && !global.length && !files.length) return []
  const learn = await readJson<Learn>(h, `${pdir}/learn.json`, { sha: '', areas: {} })
  const lines = new Map<string, string[]>()
  const put = (file: string, line: string) => lines.set(file, [...(lines.get(file) ?? []), line])
  for (const r of own) {
    const paths = pathsIn([...r.meta.inputs, ...r.meta.outputs].join(' '))
    const area = Object.entries(learn.areas ?? {}).find(([n, a]) => files.includes(`${n}.md`) && paths.some(p => matches(a.globs ?? [], p)))?.[0]
    put(area ? `${area}.md` : '_project.md', await lineOf(h, r))
  }
  for (const r of global) put('_project.md', await lineOf(h, r))
  const written: string[] = []
  const save = async (file: string, have: string | null, next: string) => {
    if (have === next) return
    await atomicWrite(h, `${pdir}/rules/${file}`, next)
    written.push(file)
  }
  const overflow: string[] = []
  for (const f of files.filter(n => n !== '_project.md')) {
    const text = String(await h.fs.read(`${pdir}/rules/${f}`).catch(() => ''))
    const base = BLOCK.test(text) ? text.replace(BLOCK, '\n') : text
    const want = lines.get(f) ?? []
    const keep = want.slice(0, Math.max(0, MAX_RULE_LINES - bodyLines(base))) // the area rule's cap holds; the rest goes to _project
    overflow.push(...want.slice(keep.length))
    await save(f, text, keep.length ? withBlock(base, keep) : base)
  }
  const ptext = files.includes('_project.md') ? String(await h.fs.read(`${pdir}/rules/_project.md`).catch(() => '')) : null
  const pbase = ptext === null ? '# project\n' : BLOCK.test(ptext) ? ptext.replace(BLOCK, '\n') : ptext
  const all = [PREFACE, ...(lines.get('_project.md') ?? []), ...overflow]
  const room = MAX_PROJECT_LINES - bodyLines(pbase)
  if (room >= 1) {
    const shown = all.length > room ? [...all.slice(0, room - 1), `- ${all.length - room + 1} more scripts: see the lean-agent-script-* skills`] : all
    await save('_project.md', ptext, withBlock(pbase, shown))
  }
  return written
}

// lean_rules sync for a project: the script lines first, then the copy into the checkout
export async function syncWithScripts(h: Host, project: string, repo: string) {
  await rebuildScriptRules(h, project).catch(() => [])
  return syncRules(h, project, repo)
}

// after a script changed (adopted, retired, updated, rolled back, flagged): the rule lines of its project (a global script: of every
// registered project) are rebuilt and copied into the registered checkout
export async function refreshScriptRules(h: Host, project: string): Promise<void> {
  const home = await homeDir(h)
  const projs = await readJson<Record<string, { path?: string }>>(h, `${leanDir(home)}/projects.json`, {})
  for (const n of project === 'global' ? Object.keys(projs ?? {}) : [project]) {
    if (!slugOk(n)) continue
    await rebuildScriptRules(h, n).catch(() => [])
    const repo = projs?.[n]?.path
    if (typeof repo === 'string' && repo.startsWith('/')) await syncRules(h, n, repo).catch(() => undefined)
  }
}
