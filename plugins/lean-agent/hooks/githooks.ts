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
  # the private registry is read live: projects.json is the truth; private.list is its cache, trusted only while it is
  # strictly newer than projects.json (else the private entries are parsed straight from projects.json, which lean-agent
  # writes pretty-printed: 2-space keys per project, 4-space fields). Neither readable: fail closed.
  list="$here/private.list"
  lean=$(cd "$here/.." && pwd -P)
  proj="$lean/projects.json"
  entries=
  if [ -e "$proj" ] && [ ! -r "$proj" ]; then
    echo "lean-agent: cannot read $proj: git push is refused (fail closed)" >&2
    exit 1
  fi
  if [ -r "$list" ] && { [ ! -e "$proj" ] || [ "$list" -nt "$proj" ]; }; then
    entries=$(cat "$list")
  elif [ -r "$proj" ]; then
    if grep -q '[^[:space:]]' "$proj"; then
      if [ "$(head -c 1 "$proj")" != "{" ] || { [ "$(wc -l < "$proj")" -lt 1 ] && [ "$(tr -d '[:space:]' < "$proj")" != "{}" ]; }; then
        echo "lean-agent: cannot parse $proj: git push is refused (fail closed)" >&2
        exit 1
      fi
    fi
    entries=$(awk -v lean="$lean" '
      function val(s,   v) { v = s; sub(/^[^:]*:[[:space:]]*"/, "", v); sub(/"[[:space:]]*,?[[:space:]]*$/, "", v); return v }
      function flush() {
        if (key != "" && priv) {
          if (path != "") print "path " path
          print "path " lean "/worktrees/" key
          if (remote != "") print "url " remote
          if (url != "") print "url " url
        }
        key = ""
      }
      /^  "[^"]*"[[:space:]]*:[[:space:]]*[{]/ { flush(); key = $0; sub(/^  "/, "", key); sub(/".*$/, "", key); path = ""; remote = ""; url = ""; priv = 0; next }
      /^    "path"[[:space:]]*:/ { path = val($0) }
      /^    "remote"[[:space:]]*:/ { remote = val($0) }
      /^    "url"[[:space:]]*:/ { url = val($0) }
      /^    "private"[[:space:]]*:[[:space:]]*true/ { priv = 1 }
      END { flush() }' "$proj")
    # a project path also counts through its symlink-resolved form
    extra=$(printf '%s\\n' "$entries" | while IFS= read -r line; do
      case "$line" in "path "*) r=$(cd "\${line#path }" 2>/dev/null && pwd -P) && [ -n "$r" ] && echo "path $r" ;; esac
    done)
    entries=$(printf '%s\\n%s\\n' "$entries" "$extra")
  else
    echo "lean-agent: cannot read $list or $proj: git push is refused (fail closed)" >&2
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
if [ -f "$orig/$name" ] && [ -x "$orig/$name" ]; then exec "$orig/$name" "$@"; fi
exit 0
`

type Proj = { path?: string; private?: boolean; remote?: string; url?: string }
const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')

// the cache of projects.json's private entries (the pre-push hook also reads projects.json itself when it is newer)
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

export async function ensureGitHooks(h: Host): Promise<void> {
  const home = await homeDir(h)
  const dir = hooksDir(home)
  await mkdirp(h, dir)
  for (const n of HOOK_NAMES) {
    const have = await h.fs.read(`${dir}/${n}`).catch(() => null)
    if (have !== HOOK) await putAtomic(h, `${dir}/${n}`, HOOK, true)
  }
  await putAtomic(h, `${dir}/${LIST}`, await privateList(h, home), false)
}
