// Structural push protection for PRIVATE projects: thread sessions run with GIT_CONFIG_* (core.hooksPath) pointing at
// ~/.lean-agent/githooks, whose pre-push hook makes git itself refuse a push from a repo registered as private (by real
// path, by worktree folder, or by remote URL) in any shell form. The shell check in guard.ts is only the fast first line.
import { homeDir, leanDir, mkdirp } from './state'
import type { Host } from './state'

export const hooksDir = (home: string) => `${leanDir(home)}/githooks`

// env for a session's settings.json: git reads GIT_CONFIG_COUNT / _KEY_n / _VALUE_n as `-c core.hooksPath=<dir>`
export const gitEnv = (home: string): Record<string, string> => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksDir(home) })

export const PRE_PUSH = `#!/bin/sh
# lean-agent: a repo registered as a private project is never pushed. Written by the mod; edits are overwritten.
LEAN=$(cd "$(dirname "$0")/.." && pwd) # the hook lives in $LEAN/githooks
REG="$LEAN/projects.json"
[ -f "$REG" ] || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
urls=$( { git remote -v 2>/dev/null | awk '{print $2}'; printf '%s\\n' "$2"; } | sort -u)
if command -v python3 >/dev/null 2>&1; then
  hit=$(LEAN="$LEAN" TOP="$top" URLS="$urls" python3 - <<'PY'
import json, os
lean, top = os.environ['LEAN'], os.path.realpath(os.environ['TOP'])
urls = [u.strip() for u in os.environ['URLS'].split('\\n') if u.strip()]
try:
    reg = json.load(open(os.path.join(lean, 'projects.json')))
except Exception:
    reg = {}
wt = os.path.realpath(os.path.join(lean, 'worktrees')) + '/'
def within(p, r):
    return p == r or p.startswith(r.rstrip('/') + '/')
slug = top[len(wt):].split('/')[0] if (top + '/').startswith(wt) else ''
norm = lambda u: u.strip().rstrip('/').removesuffix('.git').lower()
for k, v in (reg.items() if isinstance(reg, dict) else []):
    if not isinstance(v, dict) or v.get('private') is not True:
        continue
    p = v.get('path')
    if (p and within(top, os.path.realpath(p))) or k == slug:
        print(k); break
    for key in ('remote', 'url'):
        if v.get(key) and any(norm(u) == norm(v[key]) for u in urls):
            print(k); break
PY
)
  [ -z "$hit" ] && exit 0
else
  grep -q '"private": *true' "$REG" || exit 0 # no python: refuse whenever any project is private
  hit=a private project
fi
echo "lean-agent: $hit is a private project: git push is refused (no override)" >&2
exit 1
`

// idempotent: the hook is rewritten on every thread start
export async function ensureGitHooks(h: Host): Promise<void> {
  const home = await homeDir(h)
  const dir = hooksDir(home)
  await mkdirp(h, dir)
  await h.fs.write(`${dir}/pre-push`, PRE_PUSH)
  await h.process.run(['chmod', '755', `${dir}/pre-push`])
}
