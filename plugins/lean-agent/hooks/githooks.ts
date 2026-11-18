// Backstop for PRIVATE projects: thread sessions run with GIT_CONFIG_* (core.hooksPath) pointing at ~/.lean-agent/githooks.
// Every standard git hook name there is a small POSIX sh wrapper that (1) runs lean-agent's own check (only pre-push has
// one: a repo listed in private.list is never pushed) and then (2) chains to the repo's own hook, so husky, pre-commit,
// commit-msg, git-lfs ... keep running. This is a backstop, not a guarantee: `git push --no-verify`, `-c core.hooksPath=`
// or other GIT_CONFIG_* overrides skip it, so the shell check in guard.ts refuses those in private projects too.
import { homeDir, leanDir, mkdirp, readJson, realPath } from './state'
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

// private.list: `path <real path>` and `url <lowercased url without .git or trailing />` lines, one per private project
export const HOOK = `#!/bin/sh
# lean-agent: runs lean-agent's own check, then chains to the repo's original hook. Written by the mod; edits are overwritten.
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's:/*$::; s:\\.git$::'; }
if [ "$name" = pre-push ]; then
  list="$here/private.list"
  if [ ! -r "$list" ]; then
    echo "lean-agent: cannot read $list: git push is refused (fail closed)" >&2
    exit 1
  fi
  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  top=$(cd "$top" && pwd -P)
  urls=$( { git remote -v 2>/dev/null | awk '{print $2}'; printf '%s\\n' "$2"; } | while IFS= read -r u; do [ -n "$u" ] && norm "$u"; echo; done)
  hit=
  while IFS= read -r line || [ -n "$line" ]; do
    kind=\${line%% *}
    val=\${line#* }
    [ -n "$val" ] || continue
    case "$kind" in
      path) case "$top/" in "$val"/*) hit=$val ;; esac ;;
      url) if printf '%s\\n' "$urls" | grep -qxF -- "$val"; then hit=$val; fi ;;
    esac
    [ -n "$hit" ] && break
  done < "$list"
  if [ -n "$hit" ]; then
    echo "lean-agent: $hit is a private project: git push is refused (no override)" >&2
    exit 1
  fi
fi
# chain: the repo's own core.hooksPath (its local config, e.g. husky) else <common git dir>/hooks
orig=$(git config --local --get core.hooksPath 2>/dev/null)
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
if [ -f "$orig/$name" ] && [ -x "$orig/$name" ]; then exec "$orig/$name" "$@"; fi
exit 0
`

type Proj = { path?: string; private?: boolean; remote?: string; url?: string }
const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')

// the list is rewritten on every thread start from projects.json
export async function privateList(h: Host, home: string): Promise<string> {
  const projs = await readJson<Record<string, Proj>>(h, `${leanDir(home)}/projects.json`, {})
  const lean = await realPath(h, leanDir(home))
  const out: string[] = []
  for (const [k, v] of Object.entries(projs ?? {})) {
    if (!v || typeof v !== 'object' || v.private !== true) continue
    if (v.path) {
      out.push(`path ${await realPath(h, v.path)}`)
      out.push(`path ${v.path.replace(/\/+$/, '')}`)
    }
    if (/^[\w.-]+$/.test(k)) out.push(`path ${lean}/worktrees/${k}`)
    for (const u of [v.remote, v.url]) if (typeof u === 'string' && u.trim()) out.push(`url ${normUrl(u)}`)
  }
  return [...new Set(out)].join('\n') + '\n'
}

// idempotent: wrappers and list are rewritten on every thread start
export async function ensureGitHooks(h: Host): Promise<void> {
  const home = await homeDir(h)
  const dir = hooksDir(home)
  await mkdirp(h, dir)
  await h.fs.write(`${dir}/${LIST}`, await privateList(h, home))
  for (const n of HOOK_NAMES) await h.fs.write(`${dir}/${n}`, HOOK)
  await h.process.run(['chmod', '755', ...HOOK_NAMES.map(n => `${dir}/${n}`)])
}
