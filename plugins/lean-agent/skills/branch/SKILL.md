---
name: branch
description: Name a git branch the way this project wants it (no lean/ prefix, optional type and task id). Use whenever a thread creates a branch.
argument-hint: [--type feature|bugfix|release] [--task ID] "<title>"
roles: thread
---

# Branch names

1. Look for a project rule first: `~/.lean-agent/<project>/rules/` or `CONTRIBUTING.md` / `.github` naming text;
   follow it when it exists.
2. Otherwise: `[<type>/]<task-id>-<slug>`: type only when given (`feature`, `bugfix`, `release`), the task id
   (ticket number) when there is one, the slug from the title: lowercase, words joined by `-`, at most 40
   characters, only `a-z0-9-`.
3. Never use a `lean/` prefix and never a name already taken: check `git branch -a --list "*<slug>*"`; on a clash
   add `-2`.

Examples: `feature/PROJ-12-add-login-form`, `fix-flaky-sync-test`, `release/1.4.0`.
