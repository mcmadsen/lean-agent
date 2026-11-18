---
name: worktree
description: Create, list and remove git worktrees for a project under ~/.lean-agent/worktrees, so threads never share a checkout. Use when a thread needs its own branch checkout or a worktree must be cleaned up.
argument-hint: new <project> <branch> | list | rm <project> <branch>
---

# Worktrees

Layout: `~/.lean-agent/worktrees/<project>/<branch-dir>` (slashes in the branch become `-`). Registry:
`~/.lean-agent/worktrees.json`, an object keyed `<project>/<branch>` with `{path, repo, branch, thread?, shared?}`.

- **new**: path of the project's main checkout from `projects.json`; branch name per the `branch` skill.
  `git -C <repo> worktree add <path> -b <branch> <base>` (existing branch: omit `-b`). Then copy learned rules
  into it: call `lean_rules` `sync` with `project` and `repo` = the new worktree path (rules are copied files, git-excluded, and a
  worktree is its own checkout). Add the registry entry (Read, edit the JSON, Write).
- **shared**: two threads may use one worktree only if the registry entry says `shared: true`; otherwise refuse
  and make a new one.
- **list**: read the registry, check each path exists, and show `git -C <path> status -sb` for the live ones.
- **rm**: refuse when `git status --porcelain` is not empty or unpushed commits exist (`git log @{u}..`) unless the
  user says to discard; then `git -C <repo> worktree remove <path>` and drop the registry entry.

Never delete a worktree you did not create or that another thread's entry points at.
