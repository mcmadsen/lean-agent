// The words that announce a next action (data only, continuepending.ts reads it). A turn whose LAST line / sentence matches one of these, with no tool call after it,
// is a stall at once (field: a thread ended a report with "next: ..." and did nothing for 20 minutes). This table is only the cheap second net: the open-TODO rule
// (continuepending.ts, a thread's task list) does not read words at all.
// `line`: tested on the whole last line, anchored at its start (a label like "next:"); `sentence`: tested on the last sentence. The first group is the announced
// text (when a pattern has none, the whole sentence is the text). Lower case: the text is lower-cased before it is tested. Change the table here, nowhere else.
// `phrase` patterns are also tested on every sentence of the LAST PARAGRAPH (an announcement followed by a sentence or two of detail is still an announcement).
export const NEXT_LINE: RegExp[] = [/^(?:[-*>#\s]|\*\*)*(?:next(?: steps?)?|todo next|up next)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/]
export const NEXT_PHRASE: RegExp[] = [
  /\b(?:i will now|i'll now|i am now going to|i'm now going to)\s+(.+)/,
  /\bnow i(?:'ll| will)\s+(.+)/,
  /\bthen i(?:'ll| will)\s+(.+)/,
  /\b(?:i am|i'm|we are|we're) going to\s+(.+)/,
  /^(?:going to)\s+(.+)/,
  /\b(?:i am|i'm|we are|we're|now)\s+continuing\s+(?:with|on|to)\s+(.+)/, // "i'm continuing with", "now continuing with"
  /^continuing\s+(?:with|on|to)\s+(.+)/,
  /\b(?:i will|i'll|we will|we'll)\s+(?:now\s+)?continue(?:\s+(?:with|on|to))?\s*(.*)/, // "i will continue", "i'll continue with"
  /\b(?:i will|i'll|we will|we'll|let me)\s+proceed(?:\s+(?:with|to))?\s*(.*)/,
  /\bmoving on to\s+(.+)/,
  /^moving to\s+(.+)/,
  /\bproceeding\s+(?:with|to)\s+(.+)/,
  /\bin the next step\b/,
  /\bnext,?\s+i(?:'ll| will)\s+(.+)/, // "next i'll", "next, i will"
  /\bnext up(?:\s+is)?\s*[:,]?\s*(.+)/,
  /\b(?:will|'ll) do (?:that|this|it) next\b(?!\s+(?:week|month|year|time|quarter|sprint|release))/,
  /(?:^|[,;:]\s*|\b(?:and|now)\s+)on to\s+(.+)/, // "on to the cache layer" (not "hold on to")
]
// CONDITIONAL openers: a last paragraph that announces something conditional on an EXTERNAL event ("once the desk reports the push, I request ...", "when ci is green",
// "until you answer", "waiting for ...", "i will wait") is not a stall announcement: it is NOT continued as one. Whether the thread really waits is decided by
// records (waitevent.ts); one that waits for nothing any record will deliver gets the reminder instead (continuepending.ts). Tested on the lower-cased last paragraph.
export const NEXT_CONDITIONAL: RegExp[] = [
  /\b(?:once|when|after|as soon as|the moment|right after)\s+(?:the\s+|a\s+|your\s+)?(?:desk|push(?:ed)?|ci\b|pipeline|build\b|you\b|user\b|reviewers?|review\b|approval|approved|answers?\b|results?\b|repl(?:y|ies)|merge[ds]?|deploy(?:ment)?|tests? (?:run|finish)|run\b)/,
  /\buntil\s+(?:the|you|your|it|ci|a|an|i hear|there is)\b/,
  /\bwait(?:s|ed|ing)?\s+(?:for|on|until)\b/,
  /\bi(?:'ll| will) wait\b/,
  /\bawait(?:s|ing)?\b/,
  /\bpending (?:the|your|a|an)\b/,
  /\bdepends on (?:the|your)\b/,
  /\bonce (?:that|this|it) (?:is|has been|gets) (?:done|in|merged|pushed|approved|green|reported)\b/,
  /\bif (?:you|the user) (?:approve|say|confirm|agree|want|prefer)\b/,
]
export const NEXT_SENTENCE: RegExp[] = [
  /^(?:next(?: steps?)?)\s*:\s*(.+)/, // (a label after an earlier sentence on the same line)
  ...NEXT_PHRASE,
]
