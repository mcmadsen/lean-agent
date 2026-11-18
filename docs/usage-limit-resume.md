# Usage-limit auto-resume

A background thread that hits the account's usage limit ends its turn with "You've hit your ... limit · resets 4pm (UTC)" and
sits there: `claude agents --json` lists it as `state: "blocked"` with no `waitingFor` (a permission prompt sets `waitingFor`;
that one needs the user). Nobody can answer it, and nothing in lean-agent used to wake it. The desk now resumes it after the
reset.

## What it does

1. **Detect.** Every 60 s the desk's mod lists the sessions once. An open thread whose session is `blocked` without
   `waitingFor` is a limit candidate.
2. **Reset time** (first source that gives one wins):
   1. `limit.json` written by the thread's own mod: at `turn.complete` with `reason: 'error'` it reads
      `$.session.usage().rateLimits` and takes the exhausted windows (`percentUsed >= 100`, `resetsAt` ISO). The later
      `resetsAt` wins (a five-hour and a weekly window can both be spent). Structured, no text parsing. Best effort: the engine only
      reports the windows of the last API response.
   2. `claude logs <id>`: the last line matching `hit your ... limit ... resets <when>` (or `usage limit reached ... resets
      <when>`), ANSI and box characters stripped. The transcript file was not used: its folder naming and the error record shape are
      not documented, `claude logs` is.
   - Neither source: nothing is resumed, the row keeps "needs you: open it in the app".
3. **When text is parsed** (`parseResetText`): `4pm`, `4:30pm`, `16:00`, with an optional `(UTC)` / `(GMT+2)` / `(Europe/Berlin)`
   zone (no zone = the desk machine's zone; an unknown zone is no answer, never a guess), an optional date (`Nov 20`, `Nov 20,
   2026`, `20 Nov`, with or without `at` / `,`), and `in 2h 30m`. Without a date the time is the next occurrence after the moment
   the limit was first seen (a time already past means tomorrow). A bare hour (`4`) is ambiguous: no answer. A result more than 8
   days ahead, or not after the seen time, is no answer.
4. **Resume at reset + 2 minutes.** The desk calls its own `lean_thread` action `limit-resume tN` (not in the tool's schema: only
   the mod calls it). Inside the thread's one-action-at-a-time lock it lists sessions again, and if the process lingers runs
   `claude stop <id>`, waits (up to 8 polls) until no pid, then `claude --bg --resume <sid> -- "<prompt>"` with no other flag.
   The prompt is `The usage limit reset; check your worktree state and continue.`, followed by queued desk messages and the usual
   inbox mark (the same batch a wake delivers, so nothing is delivered twice).
5. **Pane.** The thread row reads "paused until 16:00" (with the date when it is not today) instead of "needs you", and its Close
   button stays (a paused thread is not working). A thread whose auto-resume failed three times shows "needs you" again.

## Rules

- **Once per reset.** `limit.json` keeps `resetAt`; before the resume it stores `resumedFor = resetAt`. The same `resetAt` is never
  resumed twice, whatever the session does afterwards (a resume that fails to start clears the mark and counts a try; three tries,
  then it stops and says why). A new limit has a different `resetAt` and is handled again.
- **Never for a parked or closed thread.** A thread that is not `open` is skipped, and its record is marked `cancelled` (so a later
  reopen does not trigger an old pause). The state is checked again inside the lock right before the stop.
- **Never over live work.** The stop applies only to a session that is `blocked` without `waitingFor`; a session that is running
  again is left alone (and counts as handled).
- **Off switch.** `config.json` `{ "desk": { "autoResume": false } }`.
- **No other side effects.** Reads `claude agents` and `claude logs`; writes only `threads/tN/limit.json`.

## State: `~/.lean-agent/threads/tN/limit.json`

`{ resetAt, seenAt, source: 'mod' | 'logs', sid, line?, resumedFor?, resumedAt?, tries?, error?, cancelled? }` (ms timestamps).
`line` is the matched limit sentence (at most 200 characters), nothing else of the log is kept. A record whose `sid` is not the
thread's current session, or whose `resetAt` is more than 6 hours past, is not used.

## Not verified live

No session was actually limit-blocked while this was written, so the exact `claude agents` row, the `claude logs` wording and
the `rateLimits` reading at the error turn come from the description of the feature and the engine's types; the parser accepts the
shapes above and refuses everything else. First real limit: check `limit.json` and the pane row.
