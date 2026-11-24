---
name: feedback
description: Draft ONE bug report or feature request for lean-agent from what just went wrong, or "export" an anonymised feedback file written by the mod; never posts without the user's explicit yes. Use for "send feedback", "report this bug", "export feedback".
argument-hint: <what happened> | export [notes]
roles: desk, thread
---

# Feedback

Nothing here is ever posted without an explicit yes from the user in this chat.

## A single report (a bug or an idea)

1. Collect: lean-agent version (`plugin.json`), `claude --version`, what was asked, what happened, what was expected,
   and the relevant lines of `~/.lean-agent/feedback.jsonl` or a saved output. Strip user names, home paths, tokens,
   project names and ids.
2. thread: Write the draft to `~/.lean-agent/feedback-drafts/<YYYY-MM-DD>-<slug>.md`: a title line, then Steps, Expected,
   Actual, Environment. desk: it has no Write; show the draft text, or `send` a thread the facts to write it.
3. Show the draft and ask whether to post it (desk: AskUserQuestion; thread: `lean_ask`). Only after a yes, and only if `gh` is
   installed (`command -v gh`), thread: `gh issue create --repo mcmadsen/lean-agent --title ... --body-file <draft>`; desk: it cannot run that, so `send` the yes and the draft path to a thread. Without `gh`,
   say so and give the draft's path: the user pastes it to the maintainers. Never post without that answer.

## Export (everything since the last export, in one file)

"export", `/lean-agent-feedback [notes]` (any session, no model turn) or, desk: `lean_doctor` action `export`
(`notes?`): the mod, as a script and not a model, writes ONE file `~/.lean-agent/feedback-export/<YYYY-MM-DD-HHMM>.md` and
prints its path. It holds: the user's notes, the environment (running vs installed lean-agent version, Claude Code version,
OS family), the doctor's problem lines, every draft in `feedback-drafts/` not exported before (titled by its first heading), the
worker feedback since the last export (old and new `feedback.jsonl` both read; counts by status; the `missing`, `refused`,
`unverified` and `unreached` texts grouped, de-duplicated, with counts), the guard refusals (text, agent type, counts), the
script candidates for lean-agent core and the threads that reported `blocked`. Every section is always there, saying `none` when
empty. It is anonymised by code (home dir and user name, project names as project-A, B ..., emails, URLs, hashes,
ticket numbers, tokens) and refuses to write the file when a known private string survived, saying which rule missed. Over 40 KB
the oldest and least repeated items are summarised.

The destination is the user's config (`config.json` `feedback.destination`: local, folder, github, folder+github; `feedback.folder`); never post without the user's Approve on the card the export returns.

Show the user the path and what it covers. The mod copies to the configured folder itself; for github it makes ONE Approve card (a public issue on mcmadsen/lean-agent: exact title and body) and posts only after that Approve. Otherwise they paste the file to the maintainers. Never
paste its content into a chat or a ticket on your own, and never run `gh issue create` yourself.
