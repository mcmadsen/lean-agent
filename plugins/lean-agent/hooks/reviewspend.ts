// What a review may cost before it starts (1.0.31), by script: prepare states the fan-out cost (reviewcost.ts fanOutText) and, above config review.askAboveUsd
// (default 5), does NOT start: the thread asks the user (lean_ask; the mod makes the question item) and goes on only with `confirm: true` after the user's yes.
// Above review.maxUsd (default 25) it refuses outright unless `confirm`. `confirm` is not in the tool schema (the schema budget): the refusal names it.
import type { Host } from './state'
import { cfgNum } from './budgetcfg'

// null = start; a string = prepare's refusal text
export async function spendStop(h: Host, project: string, usd: number, line: string, confirm: boolean): Promise<string | null> {
  if (confirm) return null
  const max = (await cfgNum(h, 'review.maxUsd')) ?? 25
  const ask = (await cfgNum(h, 'review.askAboveUsd')) ?? 5
  const q = `The review of ${project} is expected to cost ~$${usd.toFixed(2)}: ${line}. Start it?`
  if (max > 0 && usd > max) {
    return `prepare: NOT started: expected cost ~$${usd.toFixed(2)} is above review.maxUsd $${max} (${line}). Nothing was computed for the reviewers. A smaller review is the way (level "light", or one scope at a time). Only if the user wants it anyway: lean_ask ${JSON.stringify(q)} with options ["yes, start","no, skip"], and after the user's yes run prepare again with confirm: true. Never confirm on your own.`
  }
  if (ask > 0 && usd > ask) {
    return `prepare: NOT started: expected cost ~$${usd.toFixed(2)} is above review.askAboveUsd $${ask} (${line}). Ask the user now: lean_ask ${JSON.stringify(q)} with options ["yes, start","no, skip"]. Go on only after the user's yes, by running prepare again with confirm: true; after a no, skip the review. Never confirm on your own.`
  }
  return null
}
