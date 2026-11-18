// Backstop for PRIVATE projects: thread sessions run with GIT_CONFIG_* (core.hooksPath) pointing at ~/.lean-agent/githooks.
// Every standard git hook name there is a small POSIX sh wrapper that (1) runs lean-agent's own check (only pre-push has
// one: a repo listed in private.list is never pushed, nor is a push its own/deny lines refuse; a stale list refuses too) and then (2) chains to the repo's own hook, so husky, pre-commit,
// commit-msg, git-lfs ... keep running. This is a backstop, not a guarantee: `git push --no-verify`, `-c core.hooksPath=`
// or other GIT_CONFIG_* overrides skip it, so the shell check in guard.ts refuses those in private projects too.
import { homeDir, leanDir, mkdirp, readJson, realPath } from './state'
import { setNotice } from './notices'
import type { Host } from './state'

export const hooksDir = (home: string) => `${leanDir(home)}/githooks`
export const LIST = 'private.list'

// env for a session's settings.json: git reads GIT_CONFIG_COUNT / _KEY_n / _VALUE_n as `-c core.hooksPath=<dir>`
export const gitEnv = (home: string): Record<string, string> => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksDir(home) })

export const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'pre-auto-gc', 'reference-transaction',
  'post-index-change', 'push-to-checkout', 'fsmonitor-watchman', 'sendemail-validate', 'pre-receive', 'update', 'proc-receive',
  'post-receive', 'post-update', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-merge-commit',
]

// private.list (one entry per line, grep-friendly): `path <real path>` and `url <lowercased url without .git or trailing />` per private
// project; `own <path>` for a project with its own guards.push-deny (even an empty one) and `deny <path>|<glob>` per glob of it
export const HOOK = `#!/bin/sh
# lean-agent: runs lean-agent's own check, then chains to the repo's original hook. Written by the mod; edits are overwritten.
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's:/*$::; s:\\.git$::'; }
if [ "$name" = pre-push ]; then
  # git's ref list ("<local ref> <local sha> <remote ref> <remote sha>" per line) is read once, then handed on to the repo's own hook
  refs=$(cat)
  # private.list is the only registry this hook trusts (the mod rewrites it atomically on every change). Missing,
  # unreadable or older than projects.json: the repo cannot be classified, so the push is refused (fail closed).
  list="$here/private.list"
  lean=$(cd "$here/.." && pwd -P)
  proj="$lean/projects.json"
  if [ ! -r "$list" ] || { [ -e "$proj" ] && [ "$proj" -nt "$list" ]; }; then
    echo "lean-agent: the private-project list ($list) is missing, unreadable or older than projects.json, so this repo cannot be classified: git push is refused (fail closed). Open any lean-agent session to refresh it." >&2
    exit 1
  fi
  entries=$(cat "$list")
  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  top=$(cd "$top" && pwd -P)
  urls=$( { git remote -v 2>/dev/null | awk '{print $2}'; printf '%s\\n' "$2"; } | while IFS= read -r u; do [ -n "$u" ] && norm "$u"; echo; done)
  hit=
  while IFS= read -r line || [ -n "$line" ]; do
    kind=\${line%% *}
    val=\${line#* }
    [ -n "$val" ] || continue
    case "$kind" in
      path) val=\${val%/}; case "$top/" in "$val"/*) hit=$val ;; esac ;;
      url) val=$(norm "$val"); if printf '%s\\n' "$urls" | grep -qxF -- "$val"; then hit=$val; fi ;;
    esac
    [ -n "$hit" ] && break
  done <<EOF_ENTRIES
$entries
EOF_ENTRIES
  if [ -n "$hit" ]; then
    echo "lean-agent: $hit is a private project: git push is refused (no override)" >&2
    exit 1
  fi
  # guarded branches (release/*, develop, main, master, or the project's own guards.push-deny: own/deny lines of the list);
  # a push to a local path or file:// URL is not checked unless LEAN_AGENT_PUSH_GUARD_LOCAL=1; LEAN_AGENT_PUSH_GUARD_OVERRIDE=1 skips
  skip=
  [ "\${LEAN_AGENT_PUSH_GUARD_OVERRIDE:-}" = 1 ] && skip=1
  if [ -z "$skip" ] && [ "\${LEAN_AGENT_PUSH_GUARD_LOCAL:-}" != 1 ]; then
    case "$2" in
      file://*) skip=1 ;;
      *://*) ;;
      *) printf '%s' "$2" | grep -Eq '^([^/@]+@)?[^/:]+:' || skip=1 ;;
    esac
  fi
  if [ -z "$skip" ]; then
    own=
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in "own "*) v=\${line#own }; v=\${v%/}; case "$top/" in "$v"/*) own=1 ;; esac ;; esac
    done <<EOF_OWN
$entries
EOF_OWN
    pats=
    if [ -n "$own" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in "deny "*) v=\${line#deny }; dp=\${v%%|*}; dp=\${dp%/}; case "$top/" in "$dp"/*) pats="$pats
\${v#*|}" ;; esac ;; esac
      done <<EOF_DENY
$entries
EOF_DENY
    else
      pats="release/*
develop
main
master"
    fi
    while IFS= read -r ref || [ -n "$ref" ]; do
      [ -n "$ref" ] || continue
      rref=$(printf '%s' "$ref" | awk '{print $3}')
      case "$rref" in refs/heads/*) ;; *) continue ;; esac
      branch=\${rref#refs/heads/}
      while IFS= read -r g; do
        [ -n "$g" ] || continue
        case "$branch" in
          $g)
            echo "lean-agent: git push would update $branch, which lean-agent never pushes to (guard '$g'). Push your own branch and open a pull request." >&2
            exit 1 ;;
        esac
      done <<EOF_PATS
$pats
EOF_PATS
    done <<EOF_REFS
$refs
EOF_REFS
  fi
fi
# chain: the repo's effective core.hooksPath (local, then global, then system config; lean-agent's own env override is
# not a config file, so it is never seen here) else <common git dir>/hooks
orig=
for scope in --local --global --system; do
  orig=$(git config $scope --get core.hooksPath 2>/dev/null) && [ -n "$orig" ] && break
  orig=
done
if [ -n "$orig" ]; then
  case "$orig" in "~/"*) orig="$HOME/\${orig#"~/"}" ;; esac
  case "$orig" in /*) ;; *) orig="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/$orig" ;; esac
else
  common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
  orig="$common/hooks"
fi
[ -d "$orig" ] || exit 0
orig=$(cd "$orig" && pwd -P)
[ "$orig" = "$here" ] && exit 0
if [ -f "$orig/$name" ] && [ -x "$orig/$name" ]; then
  if [ "$name" = pre-push ]; then
    if [ -n "$refs" ]; then printf '%s\\n' "$refs" | "$orig/$name" "$@"; else "$orig/$name" "$@" </dev/null; fi
    exit $?
  fi
  exec "$orig/$name" "$@"
fi
exit 0
`

type Proj = { path?: string; private?: boolean; remote?: string; url?: string; guards?: { 'push-deny'?: unknown } }
const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')

// the list the pre-push hook reads: projects.json's private entries plus the own/deny lines. The hook fails closed: it
// refuses the push when projects.json is newer than this list, until the list is regenerated.
export async function privateList(h: Host, home: string): Promise<string> {
  const projs = await readJson<Record<string, Proj>>(h, `${leanDir(home)}/projects.json`, {})
  const lean = await realPath(h, leanDir(home))
  const out: string[] = []
  for (const [k, v] of Object.entries(projs ?? {})) {
    if (!v || typeof v !== 'object') continue
    const paths: string[] = []
    if (v.path) paths.push(await realPath(h, v.path), v.path.replace(/\/+$/, ''))
    if (/^[\w.-]+$/.test(k)) paths.push(`${lean}/worktrees/${k}`)
    if (v.private === true) {
      for (const p of paths) out.push(`path ${p}`)
      for (const u of [v.remote, v.url]) if (typeof u === 'string' && u.trim()) out.push(`url ${normUrl(u)}`)
    }
    const pd = v.guards?.['push-deny']
    if (Array.isArray(pd))
      for (const p of paths) {
        out.push(`own ${p}`)
        for (const g of pd) if (typeof g === 'string' && g && !/[\n|]/.test(g)) out.push(`deny ${p}|${g}`)
      }
  }
  return [...new Set(out)].join('\n') + '\n'
}

// Atomic: every file is written under a temp name (executable bit set for wrappers) and renamed into place, so a git
// process never runs a half-written wrapper or reads a half-written list. The list is rewritten on EVERY call (the mod
// calls this at desk/thread start, on every lean_thread action and after every lean_* tool); wrappers only when changed.
let seq = 0
async function putAtomic(h: Host, path: string, text: string, exec: boolean): Promise<void> {
  const tmp = `${path}.tmp-${++seq}-${Math.floor(Math.random() * 1e9).toString(36)}`
  await h.fs.write(tmp, text)
  if (exec) {
    const c = await h.process.run(['chmod', '755', tmp])
    if (c.exitCode !== 0) { await h.process.run(['rm', '-f', tmp]); throw new Error(`chmod ${tmp} failed`) }
  }
  const r = await h.process.run(['mv', '-f', tmp, path])
  if (r.exitCode !== 0) { await h.process.run(['rm', '-f', tmp]); throw new Error(`atomic write to ${path} failed`) }
}

// chmod 755 is re-applied to every wrapper on EVERY call (cheap), even when its content is unchanged: one that lost +x
// is skipped by git silently. Throws when the wrappers cannot be made ready (the caller must then not point git at them).
export async function ensureGitHooks(h: Host): Promise<void> {
  try {
    await writeGitHooks(h)
  } catch (e) {
    await setNotice(h, 'githooks', `lean-agent: git hooks not installed (${String((e as Error)?.message ?? e).slice(0, 160)}); push protection is off, thread sessions use the repo's own hooks`)
    throw e
  }
  await setNotice(h, 'githooks', null)
}

async function writeGitHooks(h: Host): Promise<void> {
  const home = await homeDir(h)
  const dir = hooksDir(home)
  await mkdirp(h, dir)
  for (const n of HOOK_NAMES) {
    const have = await h.fs.read(`${dir}/${n}`).catch(() => null)
    if (have !== HOOK) await putAtomic(h, `${dir}/${n}`, HOOK, true)
  }
  const c = await h.process.run(['chmod', '755', ...HOOK_NAMES.map(n => `${dir}/${n}`)])
  if (c.exitCode !== 0) throw new Error(`chmod 755 on the git hook wrappers in ${dir} failed`)
  await putAtomic(h, `${dir}/${LIST}`, await privateList(h, home), false)
}
