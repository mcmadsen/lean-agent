// The one table of proserequest.ts (1.0.28): the words that make a sentence of a lean_report a REQUEST TO THE USER (an approval or an
// answer) and the words that say it is not one ("approved earlier", "no approval needed"). Data only: add a phrase here, nowhere else.
// Each entry is a regular expression source, matched case-insensitively against one sentence.
export const REQUEST_WORDS: string[] = [
  'for (your )?(approval|ok|go-?ahead|confirmation|decision)',
  'awaiting (your )?(approval|answer|reply|confirmation|go-?ahead|decision|ok)',
  'needs? (your )?(approval|answer|ok|go-?ahead|decision|confirmation|input)',
  'approval (is )?(needed|required|requested|pending)',
  'please (approve|confirm|let me know|tell me|reply|answer|advise|say)',
  'ok to (post|send|push|proceed|go|merge|apply)',
  'okay to (post|send|push|proceed|go|merge|apply)',
  '\\bmay i\\b',
  '\\bshould i\\b',
  '\\bshall i\\b',
  '\\bcan i (post|send|push|go|proceed|merge|apply)\\b',
  'do you want',
  'would you like',
  '\\bwant me to\\b',
  'waiting (for|on) (your|the user|you)\\b',
  'nothing (is|will be|gets) (posted|sent|pushed|written|merged|applied) until',
  'until you (approve|confirm|say|answer|reply|agree)',
  'tell me (whether|if|which|how)',
  'let me know (whether|if|which|how)',
  '\\b(once|if|when) you (approve|confirm|agree|say yes)\\b',
  '\\bapprove (it|this|these|the|them)\\b',
  '\\bis (that|this) ok(ay)?\\b',
]
// a sentence that matches one of these is no request even when it matches a word above
export const NOT_A_REQUEST: string[] = [
  '\\b(already|earlier|previously) approved\\b',
  'approved (earlier|before|already|by you)',
  '\\b(was|were|been|is|are) approved\\b',
  '\\byou (approved|confirmed|agreed|said yes)\\b',
  'no (approval|confirmation|answer|decision|input) (is |was )?(needed|required|necessary)',
  '(approval|confirmation|an answer) (is |was )?not (needed|required|necessary)',
  '(does|do|did) not need (your )?(approval|answer|confirmation)',
  "(doesn't|don't|didn't) need (your )?(approval|answer|confirmation)",
  '\\bwithout (your )?(approval|asking)\\b',
  '\\bnot (waiting|asking)\\b',
]
