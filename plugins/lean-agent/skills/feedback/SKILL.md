---
name: feedback
description: Draft a bug report or feature request for lean-agent from what just went wrong; posting it needs the user's OK. Use for "send feedback", "report this bug".
argument-hint: <what happened>
roles: desk, thread
---

# Feedback

1. Collect: lean-agent version (`plugin.json`), `claude --version`, what was asked, what happened, what was expected,
   and the relevant lines of `~/.lean-agent/feedback.jsonl` or a saved output. Strip user names, home paths, tokens,
   project names and ids.
2. thread: Write the draft to `~/.lean-agent/feedback-drafts/<YYYY-MM-DD>-<slug>.md`: a title line, then Steps, Expected,
   Actual, Environment. desk: it has no Write; show the draft text, or `send` a thread the facts to write it.
3. Show the draft and ask whether to post it (desk: AskUserQuestion; thread: `lean_ask`). Only after a yes, thread: `gh issue create --repo mcmadsen/lean-agent --title ... --body-file <draft>`; desk: it cannot run that, so `send` the yes and the draft path to a thread. Never post without that answer.
