// The script store's pure parts (no Host): the meta record, content hash, the run command and the recipe skill an adopted
// script becomes. rules.ts uses them at `lean_rules sync` to regenerate the skill from the verified meta instead of trusting a file.
import { sha256 } from './sha'

export type Verdict = 'adopt' | 'adapt' | 'reject'
export type Audit = {
  ts: number
  by: string
  sha: string // the stored script the auditor judged
  claimed: Verdict // what the auditor said
  verdict: Verdict // after the mod's rules
  reads: string[]
  writes: string[]
  network: boolean
  deletes: boolean
  secrets: boolean
  hardcoded: string[]
  deterministic: boolean
  errorsHandled: boolean
  generalises: boolean
  changes: string[]
  blockers: string[]
  reason: string
}
export type Decision = { value: 'adopt' | 'reject'; by: 'user'; reason: string; ts: number; overrode?: string[] }
// One version of an adopted script: scripts/<name>/v<N>/<file>. The stable copy of the current one is scripts/<name>/run.
export type Version = { v: string; file: string; sha256: string; author: string; ts: number; purpose: string; run: string; audit?: Audit; decision?: Decision; changes?: string[] }
export type Meta = {
  name: string
  purpose: string
  run: string // contains {script}
  inputs: string[]
  outputs: string[]
  project: string // a project slug or "global"
  author: string // tN
  created: number
  sha256: string // of the current version (a candidate: of its file)
  file: string // a candidate: its file; adopted: always `run`, the stable path
  status: 'candidate' | 'adopted' | 'rejected' | 'retired'
  core?: boolean
  scan?: string[] // privacy findings of the stored text (they block adoption)
  audit?: Audit // of the current version
  decision?: Decision // of the current version
  adopted?: number
  current?: string // adopted: the current version, `v1` ...
  versions?: Version[]
  pending?: Version // an update waiting for its audit (never run, never current)
  failures?: number // failed runs since the last update or rollback
  state?: 'needs-update'
  badWhy?: string
  history?: { ts: number; what: string }[]
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const hashText = (t: string) => hex(sha256(new TextEncoder().encode(t)))
export const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const expandRun = (meta: Meta, dir: string) => {
  const p = `${dir}/${meta.file}`
  const q = /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
  return meta.run.replace(/\{script\}/g, () => q)
}

export function recipeText(meta: Meta, dir: string): string {
  const desc = `Scripts over models: ${meta.purpose}`.replace(/\s+/g, ' ').slice(0, 200)
  return [
    '---',
    `name: lean-agent-script-${meta.name}`,
    `description: ${JSON.stringify(desc)}`,
    '---',
    `# ${meta.name} (adopted script)`,
    '',
    meta.purpose,
    '',
    `- inputs: ${meta.inputs.join('; ')}`,
    `- outputs: ${meta.outputs.join('; ')}`,
    `- run: ${expandRun(meta, dir)}`,
    '',
    'Audited and adopted by lean-agent: run it instead of reading the data with a model, and do not edit it in place. If it is wrong for your data, change a copy and `lean_script` propose it under a new name.',
    '',
  ].join('\n')
}

// The skill text to ship for the adopted script in `dir`, or null when it is not (or no longer) what was audited and adopted: the meta
// must say adopted, the file name must be plain, the text must still hash to the audited sha, and the audit (or the user's decision
// on it) must be for exactly that text. The text is generated here, never read from a file that could have been edited.
export function shippable(meta: unknown, code: unknown, dir: string): string | null {
  try {
    const m = meta as Meta
    if (!m || typeof m !== 'object' || m.status !== 'adopted' || typeof m.file !== 'string' || !SAFE_FILE.test(m.file) || typeof code !== 'string') return null
    if (m.name !== dir.split('/').pop() || typeof m.purpose !== 'string' || typeof m.run !== 'string' || !Array.isArray(m.inputs) || !Array.isArray(m.outputs)) return null
    if (hashText(code) !== m.sha256 || m.audit?.sha !== m.sha256) return null
    if (m.decision?.value !== 'adopt' && m.audit.verdict !== 'adopt') return null
    return recipeText(m, dir)
  } catch {
    return null
  }
}
