---
name: config
description: Show and change lean-agent's settings (list, get, set, reset, validate) through lean_config instead of hand-editing config.json. Use for "change a setting", "turn X off", "what is X set to", "reset X", "check my config".
argument-hint: [key [value] | reset <key> | validate]
roles: desk
---

# Settings

Every setting of `~/.lean-agent/config.json` changes through the desk's `lean_config` tool (full name `mcp__lean-agent__lean_config`), never by editing
the file and never by asking a thread to. It works in the desk session only. The tool checks the value (type, range, the allowed words, that a folder exists),
writes the file atomically, keeps keys it does not know and the file's style, never stores a secret, and says when the change applies (now, from the next session,
after the desk restarts): repeat that in your answer.

- no arguments: `lean_config list`, shown as a short table per group (key, now, default; `*` marks a value that differs from the default; `(sensitive)` as the tool marks it). One line each, no descriptions unless the user asks. `lean_config list <group>` for one group: desk, threads, workers, review, budget, pane, feedback, safety, other.
- a key: `lean_config get <key>` (current value, default, what it accepts, when it applies).
- a key and a value: `lean_config set <key> <value>`; a list takes `a, b` or `["a", "b"]`, a folder takes `~/Downloads`.
- `reset <key>`: `lean_config unset <key>` (back to the default).
- `validate`: `lean_config validate` checks the whole file: unknown keys with the nearest known key, bad values, spellings nothing reads.

An unknown key is answered with the nearest key ("did you mean ..."): say it and ask which one the user meant; never write a key the tool does not know.

Sensitive keys loosen a safety rule (`lean.orchestrate`, the `actions.*` approvals and hold time, what a thread or worker may load or run, review size caps and skips):
the mod changes one only when the user's own typed words this session name the key, or when the user answers the mod's own question with Approve. If the tool refuses,
tell the user: "this setting loosens a safety rule: type `/lean-agent:config <key> <value>` in the chat box, or I ask you with a question", then ask the question the reply carries with
AskUserQuestion, pasted exactly, with exactly the options Approve, Not now; the mod reads the answer itself and makes the change, never answer for them and never call the tool again
to get around the refusal. Never put the command in a code block (the app turns it into a Run button that runs it in a shell, where lean-agent does not see it): give it as plain text.

A thread or worker never changes settings: if one needs a setting changed, it reports that to the desk and the desk asks the user.

Arguments: $ARGUMENTS
