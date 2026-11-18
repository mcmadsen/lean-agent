---
name: worktree
description: Create, adopt, list and remove git worktrees for a project under ~/.lean-agent/worktrees, so threads never share a checkout; installs dependencies in a fresh one. Use when a thread needs its own branch checkout, a PR branch made with plain `git worktree add` should be registered, or a worktree must be cleaned up.
argument-hint: new <project> <branch> | adopt <path> | list | rm <project> <branch>
roles: thread
---

# Worktrees

Layout: `~/.lean-agent/worktrees/<project>/<branch-dir>` (slashes in the branch become `-`). Registry:
`~/.lean-agent/worktrees.json`, an object keyed `<project>/<branch>` with `{path, repo, branch, thread?, shared?}`.

- **new**: path of the project's main checkout from `projects.json`; branch name per the `branch` skill.
  `git -C <repo> worktree add <path> -b <branch> <base>` (existing branch: omit `-b`), `<path>` absolute under `~/.lean-agent/worktrees`.
  **Never the EnterWorktree tool**: for a path outside `.claude/worktrees/` it asks a permission prompt that a background thread
  cannot answer, so the thread blocks silently. After creating the worktree work with absolute paths and `git -C <path>`, no `cd`. Then copy learned rules
  into it: call `lean_rules` `sync` with `project` and `repo` = the new worktree path (rules are copied files, git-excluded, and a
  worktree is its own checkout). Add the registry entry (Read, edit the JSON, Write).
- **dependencies** (after `new`, and after `adopt` when `node_modules` is missing): when the worktree has a lockfile, a
  `lean-agent:worker-haiku` runs the install in the worktree and the result is reported (command, exit code, last lines):
  `yarn.lock` -> `yarn install --frozen-lockfile` for yarn 1 (`yarn --version` starts with 1) or `yarn install --immutable` for
  yarn 2+; `package-lock.json` -> `npm ci`; `pnpm-lock.yaml` -> `pnpm install --frozen-lockfile`. Tell that worker to run
  exactly that command (nothing else) and give it `allow-edit:` for the worktree path. **Never symlink `node_modules` from another
  worktree by default**: `link:` / `file:` dependencies can point at per-branch generated code. Only when the install is
  impossible (offline, registry down) may it BORROW from a donor worktree of the same project, and only if the donor's lockfile
  AND every `link:` / `file:` target named in `package.json` / the lockfile are byte-identical to this worktree's (`cmp`,
  `git diff --no-index` on each target); copy, do not link, and say which donor was used. Otherwise report "dependencies not installed" and why.
- **adopt** `<path>`: register a worktree or branch that was made with plain `git worktree add` (for example a PR branch).
  Check `git -C <path> rev-parse --show-toplevel` equals `<path>` and `git -C <path> worktree list` shows it, find the project
  whose `repo` is the main checkout (`git -C <path> rev-parse --git-common-dir`; ask if none matches), take the branch from
  `git -C <path> branch --show-current`, add the registry entry `{path, repo, branch, thread: <this thread>, adopted: true}`
  (refuse when the entry exists for another thread), run `lean_rules` `sync` for it, then **dependencies**. `rm` of an adopted
  worktree needs the user's yes; it was not created here.
- **reuse**: when the registry already has `<project>/<branch>` and its path exists, use that worktree (say its path)
  instead of creating another; a registry entry without a usable `path` is an error to report, not a path to guess.
- **shared**: two threads may use one worktree only if the registry entry says `shared: true`; otherwise refuse
  and make a new one.
- **list**: read the registry, check each path exists, and show `git -C <path> status -sb` for the live ones.
- **rm**: refuse when `git status --porcelain` is not empty or unpushed commits exist (`git log @{u}..`) unless the
  user says to discard; then `git -C <repo> worktree remove <path>` and drop the registry entry.

Never delete a worktree you did not create or that another thread's entry points at.
