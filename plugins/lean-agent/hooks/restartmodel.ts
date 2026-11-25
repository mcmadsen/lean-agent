// The model and effort each session start / restart of a thread really used (1.0.35; fix731 gap: a restart can start on another model than the thread's first one
// - an expensive one held, a retry on sonnet, a model named by the restart - and the card only showed the current one). thread.json `restarts`: newest last,
// at most MAX_RESTARTS entries (the first start is always kept: the card compares with it).
export type Restart = { model: string; effort: string; ts: number }
export const MAX_RESTARTS = 20

export function noteRestart(list: unknown, r: Restart): Restart[] {
  const have = (Array.isArray(list) ? list : []).filter((x): x is Restart => !!x && typeof x.model === 'string' && typeof x.effort === 'string' && Number.isFinite(x.ts))
  const all = [...have, r]
  return all.length <= MAX_RESTARTS ? all : [all[0]!, ...all.slice(all.length - (MAX_RESTARTS - 1))]
}

// "last restart: sonnet/high" for the unfolded card, only when the last start differs from the thread's first start or from its current model / effort; '' otherwise
export function lastRestartLine(t: { model?: string; effort?: string; restarts?: unknown }): string {
  const list = Array.isArray(t.restarts) ? (t.restarts as Restart[]).filter(x => !!x && typeof x.model === 'string') : []
  if (list.length < 2) return '' // the first start is the thread's model: nothing restarted yet
  const last = list[list.length - 1]!
  const first = list[0]!
  const same = (a: { model?: string; effort?: string }, b: { model?: string; effort?: string }) => a.model === b.model && a.effort === b.effort
  return same(last, first) && same(last, t) ? '' : `last restart: ${last.model}/${last.effort}`
}
