// A review never changes the PR's checkout (1.0.31). A review thread (a thread started by /lean-agent:review: the mod's marker, reviewkind.ts), its workers
// and its reviewers read the PR with `git diff` against the merge base; none of them may pull, merge, rebase, reset, commit ... in the checkout, which
// would put the target's changes into the PR head and make the changed-lines table wrong. Pure command analysis (argv aware): `git -C <dir>`, `-c` options
// (an alias defined with -c is refused), `sh -c '...'` strings and every segment of a pipeline or && chain. A fetch into a scratch ref stays allowed
// (reviewext.ts fetches into refs/ext/* of its own bare repository, by the mod itself); `git fetch origin` only moves remote-tracking refs.
export const REVIEW_READONLY = "a review never changes the PR's checkout: it is read-only (diff against the merge base)"

const WRITES = new Set(['merge', 'pull', 'rebase', 'reset', 'cherry-pick', 'commit', 'push', 'checkout', 'switch', 'stash', 'apply', 'am', 'revert', 'clean', 'restore', 'update-ref', 'read-tree'])
// options of `git` itself that take a value as the next word
const VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

// the git invocations of a command text: [options before the subcommand, subcommand, the words after it]
export function gitCalls(command: string): { opts: string[]; sub: string; args: string[] }[] {
  const out: { opts: string[]; sub: string; args: string[] }[] = []
  // quotes and subshells become spaces so `sh -c 'git pull'` and $(git pull) are seen like plain commands
  for (const seg of command.replace(/["'`()]|\$\{?/g, ' ').split(/[;&|\n]+/)) {
    const w = seg.split(/\s+/).filter(Boolean)
    for (let i = 0; i < w.length; i++) {
      if (!/(^|\/)git$/.test(w[i]!)) continue
      const opts: string[] = []
      let j = i + 1
      while (j < w.length && w[j]!.startsWith('-')) {
        const o = w[j]!
        opts.push(o)
        if (VALUE_OPTS.has(o) && j + 1 < w.length) { opts.push(w[j + 1]!); j += 2 } else j++
      }
      if (j < w.length) out.push({ opts, sub: w[j]!, args: w.slice(j + 1) })
    }
  }
  return out
}

// null = allowed; else the one-line refusal
export function reviewGitDenial(command: string): string | null {
  for (const g of gitCalls(command)) {
    if (g.opts.some(o => /^(?:alias\.|--config-env=alias\.)/i.test(o))) return REVIEW_READONLY // `-c alias.x=!git pull`
    if (WRITES.has(g.sub)) return REVIEW_READONLY
    if (g.sub === 'fetch') {
      // into a checked-out branch ref: a refspec whose destination is refs/heads/* or a bare branch name; scratch refs (refs/ext/*) and remote-tracking refs are fine
      for (const a of g.args) {
        const m = /^\+?[^:]*:(.+)$/.exec(a)
        if (m && !/^refs\/(ext|remotes|tags)\//.test(m[1]!) && !/^https?:/.test(a)) return REVIEW_READONLY
      }
      if (g.args.includes('--update-head-ok')) return REVIEW_READONLY
    }
  }
  return null
}
