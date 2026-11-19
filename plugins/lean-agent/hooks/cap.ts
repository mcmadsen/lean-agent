// Small messages (scripts over models): an oversized tool result is cut BEFORE it enters a thread's conversation. A Bash or MCP text
// over config.json `toolResultChars` (default 20000, 0 = off) keeps its head and tail; the full text is saved under the thread's own
// folder (threads/tN/output/) and one line says where (Read it if it is needed). Never touched: Edit and Write results, errors, the
// desk, a subagent's results, lean-agent's own tools. A result that cannot be saved in full is never cut. Every cut is counted
// (capped.jsonl) for `lean_doctor stats` ("saved 140k chars in 12 results").
//
// The result keeps the shape the engine gave (it validates a hook's answer against the tool's output schema): Bash's `{ stdout, stderr, ... }`
// record, an MCP result's text blocks, or a plain string; only the text is replaced.
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { readConfig } from './budget'

export const DEFAULT_CAP = 20_000
const MIN_CAP = 2_000 // a smaller configured value is ignored

// config.json `toolResultChars`: a number >= 2000 (below that, or not a number: the default); 0 turns the cap off
export async function capChars(h: Host): Promise<number> {
  const v = ((await readConfig(h, await homeDir(h))) as any)?.toolResultChars
  if (v === 0) return 0
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_CAP ? Math.floor(v) : DEFAULT_CAP
}

// head (about 60%) and tail (about 30%) of a text, cut at line ends where there is one near, with the pointer line at the end
export function cutText(text: string, cap: number, file: string): string {
  let head = text.slice(0, Math.floor(cap * 0.6))
  let tail = text.slice(text.length - Math.floor(cap * 0.3))
  const nl = head.lastIndexOf('\n')
  if (nl > head.length * 0.5) head = head.slice(0, nl)
  const tn = tail.indexOf('\n')
  if (tn >= 0 && tn < tail.length * 0.5) tail = tail.slice(tn + 1)
  const dropped = text.length - head.length - tail.length
  return `${head}\n[... ${dropped} characters cut ...]\n${tail}\n[lean-agent: result cut from ${text.length} to ${head.length + tail.length} characters; the full text is in ${file} (Read it if you need more)]`
}

const isText = (b: any): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string'
// the text of a result, in order (what the model would read)
function textsOf(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(textsOf)
  if (isText(v)) return [v.text]
  if (v && typeof v === 'object' && Array.isArray((v as any).content)) return textsOf((v as any).content)
  return []
}
// the same shape with every text passed through `f`
function mapTexts(v: unknown, f: (t: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => mapTexts(x, f))
  if (isText(v)) return { ...v, text: f(v.text) }
  if (v && typeof v === 'object' && Array.isArray((v as any).content)) return { ...(v as any), content: mapTexts((v as any).content, f) }
  return v
}

// a tool whose result may be cut: Bash and MCP tools (lean-agent's own are small and carry answers)
const cappable = (tool: string) => tool === 'Bash' || (tool.startsWith('mcp__') && !tool.startsWith('mcp__lean-agent__'))

let seq = 0
export const resetCap = (): void => {
  seq = 0
}

// `r` is what `next(e)` resolved to. Returns it unchanged unless a text of it is over the cap.
export async function capResult(h: Host, thread: string, tool: string, r: any): Promise<any> {
  if (!r || r.deny !== undefined || r.isError || !cappable(tool) || !/^t\d+$/.test(thread)) return r
  const res = r.result
  if (!res || (typeof res === 'object' && !Array.isArray(res) && res.isError === true)) return r
  const bash = tool === 'Bash'
  if (bash && (typeof res !== 'object' || Array.isArray(res) || typeof res.stdout !== 'string')) return r // (a failed call's result is its error text)
  const cap = await capChars(h)
  if (!cap) return r
  const all = bash ? [res.stdout as string, typeof res.stderr === 'string' ? (res.stderr as string) : ''] : textsOf(res)
  if (!all.some(t => t.length > cap)) return r
  const home = await homeDir(h)
  const dir = `${threadsDir(home)}/${thread}/output`
  const file = `${dir}/${await h.clock.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}.txt`
  try {
    await mkdirp(h, dir)
    await atomicWrite(h, file, bash && all[1] ? `${all[0]}\n--- stderr ---\n${all[1]}` : all.filter(Boolean).join('\n--- next block ---\n'))
  } catch {
    return r // cannot save the full text: never drop it
  }
  let saved = 0
  const f = (t: string) => {
    if (t.length <= cap) return t
    const out = cutText(t, cap, file)
    saved += Math.max(0, t.length - out.length)
    return out
  }
  const next = bash ? { ...res, stdout: f(res.stdout), stderr: typeof res.stderr === 'string' ? f(res.stderr) : res.stderr } : mapTexts(res, f)
  if (saved > 0) await appendJsonl(h, `${leanDir(home)}/capped.jsonl`, { ts: await h.clock.now(), tN: thread, tool: bash ? 'Bash' : 'mcp', saved }).catch(() => undefined)
  return { ...r, result: next }
}

// for `lean_doctor stats`: characters kept out of the conversations in the last `days` days
export async function capStats(h: Host, now: number, days: number): Promise<{ results: number; chars: number }> {
  const since = now - days * 86_400_000
  const rows = await readJsonl<{ ts?: number; saved?: number }>(h, `${leanDir(await homeDir(h))}/capped.jsonl`)
  let results = 0
  let chars = 0
  for (const r of rows) {
    if (r && typeof r.ts === 'number' && r.ts >= since && typeof r.saved === 'number') {
      results++
      chars += r.saved
    }
  }
  return { results, chars }
}
