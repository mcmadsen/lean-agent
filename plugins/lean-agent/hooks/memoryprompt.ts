// What the memory adds to a typed prompt (prompt.submit, desk and thread, never a worker's): the one-line notices of what the mod remembered, ONE candidate
// to confirm or drop. All by script (memorycapture.ts); a failure adds nothing.
import { homeDir } from './state'
import type { Host } from './state'
import type { Role } from './role'
import { candidateLines, captureTyped } from './memorycapture'
import { deskCtx, threadCtx } from './memorytool'
import { resetTurn } from './memoryindex'

export async function memoryOnPrompt(h: Host, e: { text?: string }, role: Role, inApp: boolean): Promise<string[]> {
  resetTurn() // a new prompt: a trigger may remind again (one line per turn)
  if (role.kind !== 'desk' && role.kind !== 'thread') return []
  const home = await homeDir(h)
  const ctx = role.kind === 'thread' ? await threadCtx(h, home, role.id) : await deskCtx(h, home)
  const out = await candidateLines(h, home, ctx) // first: a candidate captured by THIS prompt is shown at the next reply, once
  out.push(...(await captureTyped(h, home, e, ctx, inApp)))
  return out
}
