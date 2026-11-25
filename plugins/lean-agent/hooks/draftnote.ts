// 1.0.35: a feedback draft is an OLD report. The desk once trusted a draft written on an old plugin version ("review-learn only handles GitHub") that was fixed long ago. By script, every
// draft the mod saves or lists carries the plugin version it was written against, and a banner says when that is not the installed version:
//   "written against 1.0.20, installed 1.0.34: this may be fixed already, check README/CHANGELOG or the current skill before relying on it"
//   * "OLD: " first when the draft is more than 3 releases behind (counted in the CHANGELOG's version headings when the file is found, else by the patch number inside one minor, else old)
//   * "possibly fixed in 1.0.N: <changelog line>" when a CHANGELOG section NEWER than the draft's version has a line that shares at least 2 words (4+ letters) with the draft's title
//   * an unknown version (the text names none) says so: "written against an unknown version"
// The version is read from the draft's own text ("Plugin version: lean-agent 1.0.20", or "lean-agent running: 1.0.20" of an export's environment block). The CHANGELOG's headings carry no
// dates, so a file date cannot give a version: it stays "unknown". The CHANGELOG is read from the plugin's own folder or the repository two levels above it; when it is not there (an installed
// plugin has only its own folder) the OLD count falls back to the patch number and no "possibly fixed" is looked for. Nothing here calls a model.
import type { Host } from './state'

export type Ver = [number, number, number]
export const parseVer = (s: unknown): Ver | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
export const verText = (v: Ver): string => v.join('.')
export const cmpVer = (a: Ver, b: Ver): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

// the version a draft says it was written against, or null
export function draftVersion(text: string): Ver | null {
  const m = /^\s*[-*>]*\s*Plugin version:\s*(?:lean-agent\s*)?v?(\d+\.\d+\.\d+)/im.exec(text) ?? /\blean-agent(?: running)?:?\s*v?(\d+\.\d+\.\d+)/i.exec(text)
  return m ? parseVer(m[1]) : null
}
export const VERSION_LINE = /^\s*[-*>]*\s*Plugin version:/im
// the draft's text with a "Plugin version: lean-agent X" line under its title when it has none ("unknown" when X is null)
export function stampVersion(text: string, v: Ver | string | null): string {
  if (VERSION_LINE.test(text)) return text
  const line = `Plugin version: lean-agent ${typeof v === 'string' ? v : v ? verText(v) : 'unknown'}`
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.trim().length)
  if (at < 0) return `${line}\n`
  lines.splice(at + 1, 0, '', line)
  return lines.join('\n')
}

export type ChangeSection = { ver: Ver; lines: string[] }
export function parseChangelog(text: string): ChangeSection[] {
  const out: ChangeSection[] = []
  for (const line of text.split('\n')) {
    const m = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(line)
    if (m) out.push({ ver: parseVer(m[1])!, lines: [] })
    else if (out.length) out[out.length - 1]!.lines.push(line)
  }
  return out
}
export async function readChangelog(h: Host, root: string): Promise<ChangeSection[]> {
  for (const p of [`${root}/CHANGELOG.md`, `${root}/../../CHANGELOG.md`]) {
    const t = await h.fs.read(p).catch(() => null)
    if (typeof t === 'string' && t.includes('## ')) return parseChangelog(t)
  }
  return []
}

const STOP = new Set(['that', 'this', 'with', 'from', 'when', 'does', 'have', 'only', 'into', 'than', 'then', 'them', 'they', 'what', 'which', 'would', 'should', 'could', 'about', 'after', 'before', 'not', 'the', 'and', 'for', 'are', 'was', 'its', 'lean', 'agent', 'thread', 'threads', 'desk', 'draft', 'report', 'bug', 'feature', 'request'])
export const titleWords = (t: string): string[] => [...new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter(w => !STOP.has(w))

// releases between the draft's version and the installed one
export function releasesBehind(draft: Ver, installed: Ver, log: ChangeSection[]): number {
  if (log.length) return log.filter(s => cmpVer(s.ver, draft) > 0 && cmpVer(s.ver, installed) <= 0).length
  return draft[0] === installed[0] && draft[1] === installed[1] ? installed[2] - draft[2] : 99
}

// the banner for one draft: '' when it was written against the installed version (minor + patch compared)
export function draftBanner(o: { text: string; title: string; installed: string; log?: ChangeSection[] }): string {
  const inst = parseVer(o.installed)
  const ver = draftVersion(o.text)
  const check = 'this may be fixed already, check README/CHANGELOG or the current skill before relying on it'
  if (!ver) return `written against an unknown version${inst ? `, installed ${verText(inst)}` : ''}: ${check}`
  if (!inst || cmpVer(ver, inst) === 0) return ''
  const log = o.log ?? []
  const old = releasesBehind(ver, inst, log) > 3 ? 'OLD: ' : ''
  const words = titleWords(o.title)
  let fixed = ''
  if (words.length >= 2) {
    for (const s of [...log].reverse()) {
      if (cmpVer(s.ver, ver) <= 0 || cmpVer(s.ver, inst) > 0) continue
      const hit = s.lines.find(l => {
        const lw = new Set(l.toLowerCase().match(/[a-z]{4,}/g) ?? [])
        return words.filter(w => lw.has(w)).length >= 2
      })
      if (hit) {
        fixed = ` · possibly fixed in ${verText(s.ver)}: ${hit.replace(/^[-*\s]+/, '').replace(/\s+/g, ' ').slice(0, 160)}`
        break
      }
    }
  }
  return `${old}written against ${verText(ver)}, installed ${verText(inst)}: ${check}${fixed}`
}
