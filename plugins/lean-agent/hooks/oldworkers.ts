// A restarted session never waits for what the PREVIOUS session started (1.0.35). Field (1.0.34): a thread waited for a background worker and checkpointed at 85k; its
// `next` said "Wait for worker <id> ..." and the new session did exactly that: the worker's completion notice goes to the session that started it, so the new one waited
// for nothing, with no tool call and no report for 12 minutes. The mod knows the old session's running background workers (orchestrate.ts liveWorkers, the slots of the
// Agent calls that only launched); this says what the new session does instead: read the worker's result file if it left one, or redo that step with a new worker.
import { shortId } from './answers'
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'

export type WorkerRef = { id: string; type?: string }

// <thread folder>/workers.json {sid, at, workers}: the background workers the thread's session has running (written by its own mod when one is launched or ends), read by the
// handover and the checkpoint restart. Only believed for the session that wrote it: the one being replaced.
export const workersFile = (home: string, id: string) => `${threadsDir(home)}/${id}/workers.json`
export async function writeWorkers(h: Host, id: string, sid: string, workers: WorkerRef[]): Promise<void> {
  try {
    if (!/^t\d+$/.test(id) || !sid) return
    await writeJson(h, workersFile(await homeDir(h), id), { sid, at: await h.clock.now(), workers: workers.slice(0, 10).map(w => ({ id: w.id, ...(w.type ? { type: w.type } : {}) })) })
  } catch {
    /* display only */
  }
}
export async function readWorkers(h: Host, home: string, id: string, sid: string | undefined): Promise<WorkerRef[]> {
  const r = await readJson<{ sid?: string; workers?: WorkerRef[] } | null>(h, workersFile(home, id), null).catch(() => null)
  return r && sid && r.sid === sid && Array.isArray(r.workers) ? r.workers.filter(w => w && typeof w.id === 'string' && w.id) : []
}

// a `next` / brief line that waits for a worker, an agent, a background job or a monitor (the new session cannot be told by anything that finished in the old one)
const WAITS = /\b(?:wait(?:ing)?|await(?:ing)?|hold(?:ing)? (?:off )?until|until)\b[^.\n]{0,60}\b(?:worker|sub-?agent|agents?|background|bg|monitor|job|task|process|build|run)\b|\b(?:worker|sub-?agent|background (?:job|task|agent|worker)|monitor)\b[^.\n]{0,60}\b(?:finish|finishes|finished|complete|completes|completed|done|returns?|reports?)\b/i
export const waitsForWorker = (text: unknown): boolean => typeof text === 'string' && WAITS.test(text)

const name = (w: WorkerRef): string => `worker ${w.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)}${w.type ? ` (${w.type.replace(/^lean-agent:/, '')})` : ''}`
export const GENERIC_NOTE = 'A worker, background job or monitor of the previous session cannot report to you: never wait for it. Read its result file if it left one (the scratch folder) or redo that step with a new worker.'

// "worker a1b2 belonged to the previous session and cannot report to you: read its result file if it left one (<dir>/scratch/*-<id>.md) or redo that step with a new worker; never wait for it"
export function oldWorkersNote(ws: WorkerRef[] | undefined, dir: string): string {
  const list = (Array.isArray(ws) ? ws : []).filter(w => w && typeof w.id === 'string' && w.id).slice(0, 5)
  if (!list.length) return ''
  const names = list.map(name).join(', ')
  const files = list.map(w => `${dir}/scratch/*-${shortId(w.id)}.md`).join(' or ')
  return `${names} belonged to the previous session and cannot report to you: read its result file if it left one (${files}) or redo that step with a new worker; never wait for it.`
}

// the continue text of a checkpoint restart: the thread's own next step, with the worker note when the old session had running workers or the step waits for one
export function continueText(next: string, ws: WorkerRef[] | undefined, dir: string): string {
  const note = oldWorkersNote(ws, dir) || (waitsForWorker(next) ? GENERIC_NOTE : '')
  return note ? `Continue now. Your previous session's next step was: ${next} ${note}` : `Continue now with: ${next}`
}
