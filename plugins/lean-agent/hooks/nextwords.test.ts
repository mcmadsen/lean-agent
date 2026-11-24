// The widened announcement phrases (1.0.31: the cheap second net when a thread has no task list). Synthetic text only.
import { expect, test } from 'claude-code/testing'
import { announcedNext } from './continuepending'

const USER_TEXT = 'The doc update went through. The old "Next: C2" bullet is now replaced by the C3 one, which is what I wanted, so nothing needs restoring. TODO 1 is finished and reported. I\'m continuing with TODO 2 (C3, wiring the handler to the engine) in the next step.'

test('the user\'s exact text (lower-cased by the matcher) is an announcement', () => {
  expect(announcedNext(USER_TEXT)).toContain('TODO 2')
  expect(announcedNext(USER_TEXT.toLowerCase())).not.toBeNull()
})

const POSITIVE: [string, string][] = [
  ["I'm continuing with the parser tests.", 'the parser tests'],
  ['Continuing with step 3 now.', 'step 3 now'],
  ['I will continue with the migration.', 'the migration'],
  ["I'll continue with the lint fixes.", 'the lint fixes'],
  ['Moving on to the integration tests.', 'the integration tests'],
  ['Proceeding with the rollout of the config change.', 'the rollout of the config change'],
  ['Proceeding to the next module.', 'the next module'],
  ['Fixtures are updated; the endpoint comes in the next step.', ''],
  ["Next I'll add the retry logic.", 'add the retry logic'],
  ['Next up: the retry logic.', 'the retry logic'],
  ["Handler is wired. I'll do that next.", ''],
  ['Now continuing with the cache layer.', 'the cache layer'],
  ['Tables are done, on to the cache layer.', 'the cache layer'],
  ['Schema is migrated. I\'m continuing with the seed data. Both tables are in place.', 'the seed data'], // not the last sentence
  ['All checks pass.\n\nTests are done and committed. Moving on to the docs update. That one is quick.', 'the docs update'], // the last paragraph announces it
  ["I'll proceed with the docs.", 'the docs'],
]
test('15+ real-world phrasings announce a next action (also a sentence that is not the last of the last paragraph)', () => {
  for (const [text, want] of POSITIVE) {
    const got = announcedNext(text)
    expect(got, text).not.toBeNull()
    if (want) expect(got, text).toBe(want)
  }
})

const NEGATIVE = [
  'All done. The suite is green and nothing is left.',
  'Done.',
  'Waiting for your answer on the branch name.',
  'Which branch should I use?',
  'I did not continue because the build is red.',
  'I continued with TODO 2 and finished it.',
  'TODO 1 is finished and reported. The old "Next: C2" bullet is gone.',
  'The report is written to scratch/notes.md.',
  'Blocked: the token has expired, I need a new one.',
  'I was moving the file when the lock appeared, so I stopped.',
  'The migration will be proceeding without downtime.',
  'Nothing to continue; the task is complete.',
  'You can hold on to the old branch until Monday.',
  'I would continue with the refactor if you approve it.',
  'Summary: 3 files changed, 12 tests added, no failures.',
  'The release goes out next week; I will do that next week.',
  'Earlier paragraph: moving on to the docs.\n\nEverything is finished and reported.',
]
test('15 finished reports, questions, waits and past-tense or negated sentences do NOT announce anything', () => {
  for (const text of NEGATIVE) expect(announcedNext(text), text).toBeNull()
})

test('the old forms still work and a question at the end still wins', () => {
  expect(announcedNext('Report written.\nNext: run the full suite')).toBe('run the full suite')
  expect(announcedNext('Fixed the parser. I will now run the build.')).toBe('run the build')
  expect(announcedNext('Next: run the suite\nand that is all')).toBeNull()
  expect(announcedNext("I'm continuing with the tests. Should I?")).toBeNull()
})
