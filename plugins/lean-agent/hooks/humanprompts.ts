// The user's own typed prompts in the desk session, kept 24 h in the mod store (text, time): the written instruction an advance accept rests on
// (deskwrites.ts). Only the `prompt.submit` hook of the DESK writes here, and only for a prompt the engine itself stamped as the person's:
//   origin.kind 'composer' = the person's Enter at the prompt (typed or queued, or a click on a transcript link);
//   origin.kind 'bridge'   = the person's message through Remote Control (phone / web).
// Everything else carries another origin and is NOT recorded: a plugin's own `$.prompt.submit` (a thread report relayed into the desk is one,
// origin 'plugin'), a scheduled wake ('scheduled-trigger'), a task notification, a message from another session ('peer', 'peer-send-message',
// 'projects-relay', 'coordinator'), a channel ('channel'), the SDK host ('sdk'), an 'unclassified' turn, and any prompt flagged `isMeta`
// (a prompt the person does not see as typed). A hook's added context (`e.context`) is never part of `e.text`. Nothing a tool call or a thread
// writes lands here: the only caller is the hook, and the engine, not any hook, sets `origin`.
// An engine that sends no `origin` at all (an old one) records nothing: the desk then always asks.
// A pasted block is expanded into `text` and the engine marks no paste, so a prompt longer than PROMPT_MAX is not recorded (an instruction is
// short; a long one is a pasted document, and its words are not the user's instruction).
import type { Host } from './state'

export const PROMPT_TTL_MS = 24 * 60 * 60 * 1000
export const PROMPT_MAX = 1500
const KEEP = 30
const KEY = 'desk.human.prompts'
export type HumanPrompt = { text: string; ts: number }

const HUMAN_ORIGINS = new Set(['composer', 'bridge'])
// `inApp`: the session is shown by an app (the Claude desktop app, an IDE, a phone), not a terminal. There the person's typed turn arrives
// through the SDK host (origin 'sdk'): it counts as typed ONLY in such a session. A `claude -p` run (also 'sdk') has no app surface, so a
// session somebody started from a shell can never plant "the user's words". An event with no `origin` at all is never recorded.
export function isHumanPrompt(e: unknown, inApp = false): boolean {
  const x = e as { text?: unknown; isMeta?: unknown; origin?: { kind?: unknown } | null } | null
  if (!x || typeof x.text !== 'string' || !x.text.trim() || x.text.length > PROMPT_MAX || x.isMeta === true) return false
  if (!x.origin || typeof x.origin.kind !== 'string') return false
  return HUMAN_ORIGINS.has(x.origin.kind) || (inApp && x.origin.kind === 'sdk')
}

export async function recentPrompts(h: Host): Promise<HumanPrompt[]> {
  const now = await h.clock.now()
  const v = await h.store.get(KEY).catch(() => null)
  return (Array.isArray(v) ? v : []).filter((p): p is HumanPrompt => !!p && typeof p.text === 'string' && Number.isFinite(p.ts) && now - p.ts <= PROMPT_TTL_MS && p.ts <= now + 60_000)
}

// What the mod can SEE, said in a refusal: when the user's last recorded message was ("no message typed by you since 14:05 UTC names PR 5659"), and the hint that the
// command must be PLAIN TEXT: a code block with a Run button runs in a shell, where lean-agent sees nothing.
export const PLAIN_HINT = 'Give the command as PLAIN TEXT, never in a code block with a Run button (a Run button runs it in a shell, where lean-agent does not see it)'
export async function seenSince(h: Host): Promise<string> {
  const last = (await recentPrompts(h)).slice(-1)[0]
  return last ? `since ${new Date(last.ts).toISOString().slice(11, 16)} UTC` : 'in the last 24 h'
}

// the desk's prompt.submit hook calls this with the event; returns whether the prompt was recorded
export async function recordHumanPrompt(h: Host, e: unknown, inApp = false): Promise<boolean> {
  if (!isHumanPrompt(e, inApp)) return false
  const keep = await recentPrompts(h)
  await h.store.set(KEY, [...keep, { text: (e as { text: string }).text.trim(), ts: await h.clock.now() }].slice(-KEEP))
  return true
}
