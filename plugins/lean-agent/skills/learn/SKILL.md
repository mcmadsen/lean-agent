---
name: learn
description: Learn a project's build/test commands, conventions and gotchas into path-scoped rules that load only when a file of that area is read. Run in a thread, never the desk. Use for "learn <project>", "re-learn <area>" or "trim the rules".
argument-hint: <project> [--area <dir>] [--trim]
---

# Learn project rules

Run in a thread whose checkout is the project. Rules are written to `~/.lean-agent/<project>/rules/` (the source of
truth) and COPIED into the checkout by the `lean_rules` tool; never write into `<repo>/.claude/rules/` yourself and
never symlink (symlinked rule folders do not load).

1. List the areas: workspace packages/services (`package.json` workspaces, `go.work`, `Cargo.toml`, `pyproject`), else
   first-level source folders. Skip areas the repo's own `CLAUDE.md` or `.claude/rules` already covers. With `--area`
   do only that one.
2. Per area start one `explorer` subagent (Agent tool). Its brief names the area and lists the gaps from
   `~/.lean-agent/<project>/gaps.jsonl` and the memory notes for that path. It returns at most 25 lines.
3. Write `rules/<area>.md` (at most 25 lines of body):

   ```markdown
   ---
   paths:
     - "services/billing/**/*.ts"
   ---
   # billing
   - Test: `pnpm --filter billing test -- <file>`
   <!-- lean-agent: learned <sha> <date> sources: services/billing/** -->
   ```

   plus one always-loaded `rules/_project.md` (no `paths:`, at most 10 lines: how to build and test the whole repo).
   At most 40 rule files. Rules say what the code does not; no file listings, no secrets.
4. Call `lean_rules` `record` per area (`area`, `globs`, `sha` = `git rev-parse HEAD`, `lines`), then `sync` with
   `repo` = this checkout (and every worktree of the project). `sync` copies the rules and recipe skills, removes
   stale copies, and adds `.claude/rules/lean-agent/` to the shared `.git/info/exclude`. It lists any file it skipped
   for being over its line cap: shorten those.
5. `--trim`: call `lean_rules` `stats`. Rewrite rules that loaded often but have gaps in `gaps.jsonl`; delete rules in
   `never` after 30 days; `sync` again.

Freshness: `lean_rules` `stale` (run at thread start automatically) names areas whose files changed a lot since they
were learned or that have three gaps; re-learn those with `--area` when you touch them. There is no background re-learn.
