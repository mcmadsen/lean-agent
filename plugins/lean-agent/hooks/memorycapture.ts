// Automatic capture from what the USER typed (origin composer / bridge only, humanprompts.ts isHumanPrompt): by script, no model call.
//   explicit words ("remember", "from now on", "going forward", "always", "never", "don't ... again") -> stored at once (source user-typed) and one notice line
//   softer corrections ("no, I said", "that's wrong", "I told you") -> stored as a CANDIDATE and shown ONCE, in the next reply, as one line to confirm or drop
//   a text that would LOOSEN a safety rule (permissions, approvals, pushes, sends) is never stored active on this path: a candidate, with a clear line
//   the typed command /lean-agent:remember <text> is the user's explicit word: stored, whatever it says (unless it is a secret, too long ...)
import { isHumanPrompt } from './humanprompts'
import { addItem, flat, memConfig, mutate, readItems, TEXT_MAX, visible } from './memory'
import type { Ctx, Item } from './memory'
import type { Host } from './state'

const EXPLICIT = /\b(remember\b|from now on|going forward|(?:don'?t|do not|never)\b[^.!?\n]{0,80}\bagain\b|always\b|never\b)/i
const NARRATION = /\b(i|we|you|he|she|they|it|there|that|this)\s+(?:is |are |was |were |has |have |had |do |does |did )?(?:always|never)\b/i // "you always do that" is a complaint, not a rule
const SOFT = /\b(no,? i said|that'?s (?:wrong|not what i)|that is wrong|i told you|i already (?:told|said)|as i said|i said (?:to|that|use|we))\b/i
const COMMAND = /^\/(?:lean-agent:)?remember\b[ \t]*([\s\S]*)$/i
const LEAD = /^(?:please\s+)?remember(?:\s+(?:that|this))?\s*[:,-]?\s*/i

export const sentences = (text: string): string[] => flat(text.replace(/\n+/g, '. ')).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 3)

// what a typed prompt holds: the explicit sentences, the soft corrections, or the command's text
export function classify(text: string): { command?: string; explicit: string[]; soft: string[] } {
  const t = text.trim()
  const c = COMMAND.exec(t)
  if (c) return { command: flat(c[1] ?? ''), explicit: [], soft: [] }
  if (t.startsWith('/')) return { explicit: [], soft: [] } // another slash command: its words are not a habit
  const ss = sentences(t)
  const explicit = ss.filter(s => EXPLICIT.test(s) && !NARRATION.test(s) && !/\?$/.test(s)).slice(0, 2)
  const soft = ss.filter(s => SOFT.test(s) && !explicit.includes(s)).slice(0, 1)
  return { explicit, soft }
}

const undo = (id: string, ctx: Ctx) => (ctx.role === 'desk' ? `undo: lean_memory retire ${id}` : `undo: ask the desk to lean_memory retire ${id}`)

// the notice lines for one typed prompt (empty = nothing to say); never throws
export async function captureTyped(h: Host, home: string, e: unknown, ctx: Ctx, inApp = false): Promise<string[]> {
  try {
    if (!isHumanPrompt(e, inApp)) return []
    if (!(await memConfig(h, home)).autoCapture) return []
    const { command, explicit, soft } = classify((e as { text: string }).text)
    const out: string[] = []
    const one = async (raw: string, mode: 'command' | 'explicit' | 'soft') => {
      const text = flat(raw.replace(LEAD, ''))
      if (!text) return
      if (text.length > TEXT_MAX) {
        if (mode !== 'soft') out.push(`[lean-agent] not remembered: ${text.length} characters, the limit is ${TEXT_MAX}. Tell the user in one line to say it shorter with /lean-agent:remember <text>`)
        return
      }
      const o = await addItem(h, home, { text, source: 'user-typed', status: mode === 'soft' ? 'candidate' : 'active', viaCommand: mode === 'command', auto: mode !== 'command', ...(mode === 'soft' && ctx.role === 'desk' ? { scope: 'desk' } : {}), ...(mode === 'soft' ? { kind: 'correction' } : {}) }, ctx)
      if (!o.ok) {
        if (o.ask) out.push(`[lean-agent] memory: "${text}" was not stored yet: ${o.text}. Ask the user, then lean_memory add with that scope`)
        else if (mode !== 'soft') out.push(`[lean-agent] ${o.text}`)
        return
      }
      if (mode === 'soft') return // shown once, later (candidateLines)
      if (o.item?.status === 'candidate') {
        await mutate(h, home, s => void (s.items.find(i => i.id === o.id)!.shown = true))
        out.push(`[lean-agent] not remembered automatically: "${text}" would loosen a safety rule (permissions, approvals, pushes, sends); ${o.id} is only a candidate. Tell the user in one line: it is kept only with /lean-agent:remember <text> typed by them`)
        return
      }
      out.push(o.text.startsWith('already remembered') ? `[lean-agent] ${o.text}` : `[lean-agent] remembered: ${text} (${undo(o.id!, ctx)}). Tell the user in one line`)
    }
    if (command !== undefined) {
      if (command) await one(command, 'command')
      return out
    }
    for (const s of explicit) await one(s, 'explicit')
    for (const s of soft) await one(s, 'soft')
    return out
  } catch {
    return []
  }
}

// ONE line per reply for a candidate nobody has seen yet: confirm or drop; marked shown at once (it comes up once)
export async function candidateLines(h: Host, home: string, ctx: Ctx): Promise<string[]> {
  try {
    const c: Item | undefined = (await readItems(h, home)).find(i => i.status === 'candidate' && !i.shown && (ctx.role === 'desk' || visible(i.scope, ctx)))
    if (!c) return []
    await mutate(h, home, s => void (s.items.find(i => i.id === c.id)!.shown = true))
    return [`[lean-agent] memory candidate ${c.id} (${c.scope}): "${c.text}". Ask the user once, in one line: keep it (${ctx.role === 'desk' ? `lean_memory confirm ${c.id}` : `the desk confirms: lean_memory confirm ${c.id}`}) or drop it (lean_memory retire ${c.id})`]
  } catch {
    return []
  }
}
