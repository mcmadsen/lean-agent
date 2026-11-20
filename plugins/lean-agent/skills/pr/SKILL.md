---
name: pr
description: Pull requests for a project's branch on GitHub (gh) or Azure DevOps (az), by the host in the project's origin URL. A thread opens, updates and reads review comments; the desk only reads status (view, list) and routes everything else to the thread that owns the branch. Use for "open a PR", "pr tN" or PR status rows.
argument-hint: create | status [tN] | comments <n>
roles: desk, thread
---

# Pull requests

Every step names who runs it. **desk** is strict mode: it may run only the read-only forms `gh pr view|list|status`,
`gh search prs`, `az repos pr list|show` (one plain command, no pipe, redirect or `$`), and cannot push, create, comment or
use `gh api`. Everything else is **thread** work: the desk sends it to the thread that owns the branch (desk: `lean_thread` `send`;
`list` shows which thread, `new` starts one) and never retries a refused command another way.

Never in a private project (the guard denies every gh/az call that is not read-only, and any push, there) and never before the `review` skill
has recorded a green review for HEAD (the push guard enforces it).

## Host

Read the project's origin URL, then pick the CLI:

- thread: `git -C <repo> remote get-url origin`
- desk: Read `~/.lean-agent/projects.json` for the project's path, then `git -C <path> remote get-url origin`

| origin host | CLI | check it first |
|---|---|---|
| `github.com` | `gh` | `gh auth status` (thread) |
| `dev.azure.com`, `*.visualstudio.com` | `az repos pr ...` (extension `azure-devops`; `--organization https://dev.azure.com/{org} --project {project} --repository {repo}` unless `az devops configure -d` set them) | `az devops project list --top 1` (thread) |
| anything else | none | say the host is not supported; give the branch name |

If the CLI is not installed or not logged in, say exactly that ("gh is not installed", "az is not logged in: az login or
AZURE_DEVOPS_EXT_PAT") instead of passing on "command not found". With a PAT and no CLI, a thread may call the host's REST API
(GitHub `/repos/{owner}/{repo}/pulls`, Azure `https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1`
with the token in the header, read from an environment variable and never printed); the desk cannot.

## Steps

- **create** (desk pushes; a thread prepares it and never runs `git push` or `gh pr create`: its own permission check refuses them,
  because the user's yes was said to the desk):
  - thread: after a green `review`, `lean_report` "ready to push <full sha> (branch, PR title)" with the PR body text (what changed
    and why, plus how it was tested; add the attribution lines only if `~/.lean-agent/config.json` `attribution` is true, your thread
    CLAUDE.md states the value; default off) and stop.
  - desk: ask the user, naming that sha and branch; only after an explicit yes call `lean_thread` `approve-push` (tN, sha) and then
    `push` (tN, sha, `pr: { title, body, base?, draft? }`). The mod checks the review, the approval and the thread's worktree, runs
    the push and the PR itself (the host is read from the push remote's URL: gh pr create for GitHub, az repos pr create with
    --org, --project, --repository, --source-branch and --target-branch for Azure DevOps, using the user's own az login; the mod runs
    them, the desk never does) and queues a message to the thread. Relay the URL to the user. When the CLI is missing or fails the
    reply gives the host's create-PR link instead (Azure DevOps: .../_git/{repo}/pullrequestcreate?sourceRef=..&targetRef=..) and
    names the CLI that was needed ("az repos pr create needs az + az login"); the PR is then the user's to open.
- **status** (desk or thread; the desk's folder is not a repo, so it names the repo: github `--repo {owner}/{repo}`, Azure
  `--organization https://dev.azure.com/{org} --project {project} --repository {repo}`): github: `gh pr view <n> --json state,reviewDecision,statusCheckRollup,url,isDraft,mergeable`;
  find a branch's PR with `gh pr list --head <branch> --json number,url,state`. Azure: `az repos pr show --id <n>`;
  `az repos pr list --source-branch <branch> --status all --output json`. One row per PR: `tN | #n | state | checks | review`.
  A status the desk cannot read (no CLI, not logged in, other host) is reported as such; the desk then asks the thread with `send`.
- **comments** (thread only; the desk reads the summary of `status` and asks the thread for details): thread: `lean_review` `prs` with
  `project` and `pr` = the number. It is the one fetch `review-learn` uses too (`hooks/prhost.ts`), so the two never drift: it picks the
  host from the origin URL as above and returns the comments in one shape, with each Azure thread's status (active, fixed, wontFix,
  closed ...), the file and line, replies marked, and the owner's own comments, system threads (votes, policy results, ref updates),
  deleted comments, bare approvals and typo fixes already dropped and counted. For GitHub it runs `gh pr view <n> --json reviews,comments`
  and `gh api repos/{owner}/{repo}/pulls/<n>/comments`; for Azure DevOps `az repos pr show --id <n>` and REST
  `.../pullRequests/<n>/threads` with a bearer token from `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
  (never a PAT, never printed). Use the CLI forms by hand only when the tool is missing.
- **update status** (thread only): `az repos pr update --id <n> --status abandoned|active|completed`; github: the user does it, or `gh pr ready` / `gh pr close`.
- Merging, completing, closing and deleting remote branches are the user's call. thread: ask first with `lean_ask`; desk: ask with AskUserQuestion,
  then `send` the decision to the thread.
