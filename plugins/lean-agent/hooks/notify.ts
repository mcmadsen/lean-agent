// Desk notifications, by script (no model): a toast when a thread enters "needs you" (an approval, a question, a report ready to push,
// a blocked thread) or reports done, once per event. The events are the pane's own (view.ts `needsOf`, the done reports), so a toast
// and the pane's card always agree. Run by a desk timer (pane.tsx paneRole), whether or not the pane is open.
//
// config.json `notify: { toast: true, sound: false }`. toast (default true) turns the toasts off. sound is accepted and does nothing:
// the engine plays only a plugin's own bundled clip (`$.audio.play({ asset })`) and this plugin ships no audio file, so there is no
// sound to play. (Speech, `$.audio.speak`, needs the platform's synthesizer and would read thread titles aloud: not done.)
//
// Once per event: the keys already toasted are kept in desk/notify-seen.json while their event lasts (a key is forgotten when its event
// is over, so a thread that waits on a prompt twice is two events; the newest SEEN_MAX at most). The first run on a home has no file:
// it records what is there without a toast (an install must not announce a month of old reports). While toasts are off the keys are
// still recorded, so turning them on later announces only what happens after.
import { readConfig } from './budget'
import { budgetEvents } from './budgetalert'
import { deskState } from './delivery'
import { isRetiredNow } from './deskauto'
import { homeDir, readJson, writeJson } from './state'
import type { Host } from './state'
import { loadView } from './view'
import type { View } from './view'

export type NotifyCfg = { toast: boolean; sound: boolean }
export const SEEN_MAX = 400
export const PER_TICK = 3 // toasts drawn per tick; the rest are one summary line

export async function notifyConfig(h: Host): Promise<NotifyCfg> {
  const c: any = await readConfig(h, await homeDir(h)).catch(() => ({}))
  const n = c && typeof c.notify === 'object' && c.notify ? c.notify : {}
  return { toast: n.toast !== false, sound: n.sound === true }
}

export type NoteEvent = { key: string; text: string }
const one = (s: string, n = 140) => (s.replace(/\s+/g, ' ').trim().length > n ? s.replace(/\s+/g, ' ').trim().slice(0, n - 1) + '…' : s.replace(/\s+/g, ' ').trim())
const LEAD: Record<string, string> = { approval: 'needs your yes', question: 'question', push: 'ready to push', blocked: 'blocked' }

// what is toast-worthy in a view: its needs (not the ones that say notify: false), and the threads whose last record is a done report
export function eventsOf(v: Pick<View, 'needs' | 'threads'>): NoteEvent[] {
  const out: NoteEvent[] = v.needs.filter(n => n.notify).map(n => ({ key: n.key, text: `${LEAD[n.kind] ?? 'needs you'}: ${one(n.text)}` }))
  const pushing = new Set(v.needs.filter(n => n.kind === 'push').map(n => n.thread))
  for (const t of v.threads) if (t.done && t.state === 'open' && !pushing.has(t.id)) out.push({ key: `done:${t.id}:${t.recTs}`, text: `${t.id} done: ${one(t.title, 80)}` })
  return out
}

const seenFile = (home: string) => `${deskState(home)}/notify-seen.json`

// One pass: the toasts that are due are handed to `toast` (the engine's $.ui.toast); returns their texts. Never throws.
export async function notifyTick(h: Host, toast: (text: string) => void, view?: View): Promise<string[]> {
  try {
    if (isRetiredNow()) return [] // a newer desk took over (deskauto.ts): its toasts and its seen-list are the newer desk's
    const home = await homeDir(h)
    const cfg = await notifyConfig(h)
    const v = view ?? (await loadView(h))
    const events = [...eventsOf(v), ...(await budgetEvents(h))] // (the budget alerts of today: budgetalert.ts)
    const file = await readJson<{ keys?: unknown } | null>(h, seenFile(home), null)
    const first = !file
    const seen = new Set<string>(Array.isArray(file?.keys) ? file.keys.filter((k): k is string => typeof k === 'string') : [])
    const fresh = events.filter(e => !seen.has(e.key))
    // A key whose event is over is forgotten, so the same kind of event can come again (a thread that waits on a prompt, resumes, and
    // waits again is two events). Not while the view is incomplete (a failed listing makes events vanish for a moment and come back).
    const complete = !v.errors.some(m => /^(agents|threads|answers|questions|scripts):/.test(m))
    const now = new Set(events.map(e => e.key))
    const kept = [...seen].filter(k => !complete || now.has(k))
    if (fresh.length || first || kept.length !== seen.size) await writeJson(h, seenFile(home), { keys: [...kept, ...fresh.map(e => e.key)].slice(-SEEN_MAX) })
    if (first || !cfg.toast || !fresh.length) return []
    const shown = fresh.slice(0, PER_TICK).map(e => e.text)
    if (fresh.length > PER_TICK) shown.push(`+${fresh.length - PER_TICK} more: see the lean-agent pane`)
    for (const t of shown) toast(t)
    return shown
  } catch {
    return [] // a notification that cannot be made is not worth a failure; the next tick tries again
  }
}
