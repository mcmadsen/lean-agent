// What a review may use before it starts (1.0.31, in usage tokens since 1.0.33), by script: prepare states the fan-out size (reviewcost.ts fanOutText: areas x passes x the average
// usage tokens of your earlier reviewer runs, else a stated default) and, above config review.askAboveTokens (default 2M), does NOT start: the thread asks the user (lean_ask; the mod
// makes the question item) and goes on only with `confirm: true` after the user's yes. Above review.maxTokens (default 10M) it refuses outright unless `confirm`. `confirm` is not in
// the tool schema (the schema budget): the refusal names it.
import type { Host } from './state'
import { cfgNum } from './budgetcfg'
import { fmtTokens } from './formatusage'

// null = start; a string = prepare's refusal text
export async function spendStop(h: Host, project: string, tokens: number, line: string, confirm: boolean): Promise<string | null> {
  if (confirm) return null
  const max = (await cfgNum(h, 'review.maxTokens')) ?? 10_000_000
  const ask = (await cfgNum(h, 'review.askAboveTokens')) ?? 2_000_000
  const n = fmtTokens(tokens)
  const q = `The review of ${project} is expected to use ~${n} usage tokens: ${line}. Start it?`
  if (max > 0 && tokens > max) {
    return `prepare: NOT started: expected usage ~${n} tokens is above review.maxTokens ${fmtTokens(max)} (${line}). Nothing was computed for the reviewers. A smaller review is the way (level "light", or one scope at a time). Only if the user wants it anyway: lean_ask ${JSON.stringify(q)} with options ["yes, start","no, skip"], and after the user's yes run prepare again with confirm: true. Never confirm on your own.`
  }
  if (ask > 0 && tokens > ask) {
    return `prepare: NOT started: expected usage ~${n} tokens is above review.askAboveTokens ${fmtTokens(ask)} (${line}). Ask the user now: lean_ask ${JSON.stringify(q)} with options ["yes, start","no, skip"]. Go on only after the user's yes, by running prepare again with confirm: true; after a no, skip the review. Never confirm on your own.`
  }
  return null
}
