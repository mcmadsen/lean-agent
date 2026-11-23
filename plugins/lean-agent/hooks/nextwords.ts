// The words that announce a next action (data only, continuepending.ts reads it). A turn whose LAST line / sentence matches one of these, with no tool call after it,
// is a stall at once (field: a thread ended a report with "next: ..." and did nothing for 20 minutes).
// `line`: tested on the whole last line, anchored at its start (a label like "next:"); `sentence`: tested on the last sentence. The first group is the announced
// text (when a pattern has none, the whole sentence is the text). Lower case: the text is lower-cased before it is tested. Change the table here, nowhere else.
export const NEXT_LINE: RegExp[] = [/^(?:[-*>#\s]|\*\*)*(?:next(?: steps?)?|todo next|up next)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/]
export const NEXT_SENTENCE: RegExp[] = [
  /^(?:next(?: steps?)?)\s*:\s*(.+)/, // (a label after an earlier sentence on the same line)
  /\b(?:i will now|i'll now|i am now going to|i'm now going to)\s+(.+)/,
  /\bnow i(?:'ll| will)\s+(.+)/,
  /\bthen i(?:'ll| will)\s+(.+)/,
  /\b(?:i am|i'm|we are|we're) going to\s+(.+)/,
  /^(?:going to)\s+(.+)/,
]
