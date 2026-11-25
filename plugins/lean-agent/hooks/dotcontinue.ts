// "." to continue after a desk restart (1.0.33). The new desk waits for the user's first message; people always typed the same thing, so a first message of exactly "."
// stands for a fixed instruction. The marker is written when a new desk session SERVES the handover (serveHandover: only a session that did not write it) and is
// consumed by the first typed message of that session, whatever it says: a later "." means nothing special. Without a pending marker, or with config
// desk.dotContinue false, a "." goes through unchanged. Script only: no model call decides anything here.
import { readConfig } from './budget'
import { deskState } from './delivery'
import { isHumanPrompt } from './humanprompts'
import { homeDir, readJson, writeJson } from './state'
import type { Host } from './state'

export const DOT_HINT = 'type . to continue'
export const DOT_PROMPT = 'Continue from the handover: read it, resume the open work, and tell me in 3 lines what is open.'

type Mark = { sid: string; at: number; consumed: boolean }
const markFile = (home: string) => `${deskState(home)}/dot-pending.json`

// config desk.dotContinue (default true), nested or flat
export async function dotEnabled(h: Host): Promise<boolean> {
  const c = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as { desk?: { dotContinue?: unknown }; [k: string]: unknown }
  const v = c?.desk?.dotContinue ?? c?.['desk.dotContinue']
  return !(v === false || v === 'false')
}

// a new desk session started: a handover was served (a marker is pending) or not (no marker; an older one is replaced, never left pending)
export async function armDot(h: Host, sid: string, served: string | null): Promise<void> {
  try {
    await writeJson(h, markFile(await homeDir(h)), { sid, at: await h.clock.now(), consumed: !served } satisfies Mark)
  } catch {
    /* no marker: a "." goes through unchanged */
  }
}

// the user's own message: an event with no origin at all (an older engine) counts, an injected one (a relayed report, a wake, a task notice) does not
const typedByUser = (e: { text?: unknown; isMeta?: unknown; origin?: { kind?: unknown } | null }, inApp: boolean): boolean =>
  typeof e.text === 'string' && e.isMeta !== true && (!e.origin || typeof e.origin.kind !== 'string' ? true : isHumanPrompt(e, inApp))

// The prompt.submit step of the desk. Returns the text to use instead of the typed one, or null (unchanged). The first typed message of a fresh desk with a pending
// marker consumes it; only "." (trimmed) is rewritten.
export async function dotStep(h: Host, e: { text?: unknown; isMeta?: unknown; origin?: { kind?: unknown } | null; agentId?: unknown }, sid: string, inApp = false): Promise<string | null> {
  try {
    if (e.agentId || !typedByUser(e, inApp)) return null
    const file = markFile(await homeDir(h))
    const m = await readJson<Mark | null>(h, file, null)
    if (!m || typeof m !== 'object' || m.consumed !== false || (m.sid ?? '') !== sid) return null
    await writeJson(h, file, { ...m, consumed: true }) // (consumed by this first message, whatever it says)
    return (e.text as string).trim() === '.' && (await dotEnabled(h)) ? DOT_PROMPT : null
  } catch {
    return null
  }
}
