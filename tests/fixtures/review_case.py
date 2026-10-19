#!/usr/bin/env python3
"""Build a small sample repo for replaying a review: `python3 tests/fixtures/review_case.py <dir>`, then
`python3 tests/fixtures/review_case.py <dir> --fixed` adds the author's fixes (to replay `review --resume`).

Branch `main` has a check runner where a trigger that arrives while a check runs shares the running check
(when its scope is inside the running scope). Branch `fix-races` changes that and has the problems a good
review should find (neutral names, same shape as a real case):

1. coverage lost: four share tests are renamed and flipped to expect a follow-up; the case that must still
   share (scoped trigger inside the running scope, arriving BEFORE the requests are sent) has no test left;
2. a new optional parameter `capturedAtMs = Date.now()` whose default only keeps old test calls compiling,
   while the fix needs the time captured before the delay;
3. a queued "everything" (null) scope is merged into the next scoped check, but `markFullyChecked` still looks
   at the request scope, not the merged one;
4. new module-level state (`queuedScope`) that no spec resets;
plus: onLogout doesn't clear the queued scope (real bug), a hint flag not cleared on logout (nit), and an
import cycle between runner.js and scope.js (style).
"""
import os
import subprocess
import sys

BASE = {
    "src/checks/scope.js": """\
// Scopes: a list of item ids, or null for everything.
export function covers(outer, inner) {
  if (outer === null) return true;
  if (inner === null) return false;
  return inner.every((id) => outer.includes(id));
}
""",
    "src/checks/runner.js": """\
import { covers } from './scope.js';

// One check at a time. A trigger that arrives while a check runs is shared with the running check
// when its scope is inside the running scope.
let running = null; // { scope, promise }

export function runCheck(scope, deps) {
  if (running && covers(running.scope, scope)) return running.promise;
  const promise = deps.fetch(scope).then((result) => {
    running = null;
    deps.markFullyChecked(scope === null);
    return result;
  });
  running = { scope, promise };
  return promise;
}

export function onLogout() {
  running = null;
}

export function resumeSession(deps) {
  const capturedAt = Date.now(); // captured before the delay
  return deps.delay().then(() => deps.resume(capturedAt));
}
""",
    "src/app.js": """\
import { runCheck, resumeSession } from './checks/runner.js';

export function onActivity(deps, scope) {
  return runCheck(scope, deps);
}

export function onRestore(deps) {
  return resumeSession(deps);
}
""",
    "test/runner.spec.js": """\
import { runCheck } from '../src/checks/runner.js';

const deps = () => ({ fetch: jest.fn(() => new Promise(() => {})), markFullyChecked: jest.fn() });

test('shares a running check for the same scope', () => {
  const d = deps();
  runCheck(['a', 'b'], d); runCheck(['a', 'b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares a running check for a scope inside the running scope', () => {
  const d = deps();
  runCheck(['a', 'b'], d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares a running full check for any scope', () => {
  const d = deps();
  runCheck(null, d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares a running check for a single id', () => {
  const d = deps();
  runCheck(['a'], d); runCheck(['a'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares an unscoped trigger with a running unscoped check', () => {
  const d = deps();
  runCheck(null, d); runCheck(null, d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});
""",
}

FIX = {
    "src/checks/scope.js": """\
import { isSent } from './runner.js';

// Scopes: a list of item ids, or null for everything.
export function covers(outer, inner) {
  if (outer === null) return true;
  if (inner === null) return false;
  return inner.every((id) => outer.includes(id));
}

export function merge(a, b) {
  if (a === null || b === null) return null;
  return Array.from(new Set([...a, ...b]));
}

export function shareable(running, scope) {
  return !isSent(running) && covers(running.scope, scope);
}
""",
    "src/checks/runner.js": """\
import { merge, shareable } from './scope.js';

// One check at a time. A trigger that arrives while a check runs is shared with it until its requests are
// sent; after that it gets its own follow-up check, so changes made meanwhile aren't missed.
let running = null; // { scope, promise, sent }
let queuedScope; // scope for the follow-up check (undefined = none)
let hintShown = false;

export function isSent(r) {
  return Boolean(r && r.sent);
}

export function runCheck(scope, deps) {
  if (running && shareable(running, scope)) return running.promise;
  if (running) {
    queuedScope = queuedScope === undefined ? scope : merge(queuedScope, scope);
    hintShown = true;
    return running.promise.then(() => runCheck(takePending(), deps));
  }
  const effective = queuedScope === undefined ? scope : merge(queuedScope, scope);
  queuedScope = undefined;
  running = { scope: effective, sent: false };
  running.promise = deps.fetch(effective, () => { running.sent = true; }).then((result) => {
    running = null;
    deps.markFullyChecked(scope === null);
    return result;
  });
  return running.promise;
}

function takePending() {
  const s = queuedScope;
  queuedScope = undefined;
  return s;
}

export function onLogout() {
  running = null;
}

export function resumeSession(deps, capturedAtMs = Date.now()) {
  return deps.delay().then(() => deps.resume(capturedAtMs));
}
""",
    "src/app.js": """\
import { runCheck, resumeSession } from './checks/runner.js';

export function onActivity(deps, scope) {
  return runCheck(scope, deps);
}

export function onRestore(deps) {
  const capturedAt = Date.now();
  return resumeSession(deps, capturedAt);
}
""",
    "test/runner.spec.js": """\
import { runCheck, resumeSession } from '../src/checks/runner.js';

const deps = () => ({ fetch: jest.fn((scope, onSent) => { onSent(); return new Promise(() => {}); }),
                      markFullyChecked: jest.fn() });

test('queues a follow-up check for the same scope once requests are sent', () => {
  const d = deps();
  runCheck(['a', 'b'], d); runCheck(['a', 'b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1); // the follow-up runs after the first finishes
});

test('queues a follow-up check for a scope inside the running scope once requests are sent', () => {
  const d = deps();
  runCheck(['a', 'b'], d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('queues a follow-up check after a running full check', () => {
  const d = deps();
  runCheck(null, d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('queues a follow-up check for a single id', () => {
  const d = deps();
  runCheck(['a'], d); runCheck(['a'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares an unscoped trigger with a running unscoped check', () => {
  const d = { fetch: jest.fn(() => new Promise(() => {})), markFullyChecked: jest.fn() };
  runCheck(null, d); runCheck(null, d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('resumes with the time captured before the delay', async () => {
  const d = { delay: () => Promise.resolve(), resume: jest.fn() };
  await resumeSession(d);
  expect(d.resume).toHaveBeenCalled();
});
""",
}


# The author's fixes for everything above (for replaying `review --resume`).
FIXED = {
    "src/checks/scope.js": """\
// Scopes: a list of item ids, or null for everything.
export function covers(outer, inner) {
  if (outer === null) return true;
  if (inner === null) return false;
  return inner.every((id) => outer.includes(id));
}

export function merge(a, b) {
  if (a === null || b === null) return null;
  return Array.from(new Set([...a, ...b]));
}
""",
    "src/checks/runner.js": """\
import { covers, merge } from './scope.js';

// One check at a time. A trigger that arrives while a check runs is shared with it until its requests are
// sent; after that it gets one follow-up check (scopes merged), so changes made meanwhile aren't missed.
// `session` changes on logout, so late callbacks from before it do nothing.
let running = null; // { scope, promise, sent }
let queuedScope; // scope for the follow-up check (undefined = none)
let followUp = null; // the one promise every queued caller waits for
let session = 0;

export function resetForTests() {
  running = null;
  queuedScope = undefined;
  followUp = null;
  session += 1;
}

export function runCheck(scope, deps) {
  if (running && !running.sent && covers(running.scope, scope)) return running.promise;
  if (running) {
    queuedScope = queuedScope === undefined ? scope : merge(queuedScope, scope);
    if (!followUp) {
      const mine = session;
      const next = () => {
        if (mine !== session) return undefined;
        followUp = null;
        if (queuedScope === undefined) return undefined;
        const queued = queuedScope;
        queuedScope = undefined;
        return runCheck(queued, deps);
      };
      followUp = running.promise.then(next, next); // a failed check still runs the follow-up
    }
    return followUp;
  }
  const mine = session;
  const record = { scope, sent: false };
  running = record;
  record.promise = deps.fetch(scope, () => { record.sent = true; }).then((result) => {
    if (mine === session) deps.markFullyChecked(scope === null);
    return result;
  }).finally(() => {
    if (running === record) running = null;
  });
  return record.promise;
}

export function onLogout() {
  resetForTests();
}

export function resumeSession(deps, capturedAtMs) {
  return deps.delay().then(() => deps.resume(capturedAtMs));
}
""",
    "test/runner.spec.js": """\
import { runCheck, resumeSession, onLogout, resetForTests } from '../src/checks/runner.js';

function deferredFetch() {
  const calls = [];
  const fetch = jest.fn((scope, onSent) => new Promise((resolve) => calls.push({ scope, onSent, resolve })));
  return { fetch, calls, markFullyChecked: jest.fn() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetForTests());

test('shares a running check for a scope inside the running scope before its requests are sent', () => {
  const d = deferredFetch();
  runCheck(['a', 'b'], d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('shares a running full check before its requests are sent', () => {
  const d = deferredFetch();
  runCheck(null, d); runCheck(['b'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('queues one follow-up with the merged scope once requests are sent', async () => {
  const d = deferredFetch();
  runCheck(['a'], d);
  d.calls[0].onSent();
  const p1 = runCheck(['b'], d); const p2 = runCheck(['c'], d);
  d.calls[0].resolve();
  await flush();
  expect(d.fetch).toHaveBeenCalledTimes(2);
  expect(d.calls[1].scope).toEqual(['b', 'c']);
  expect(p1).toBe(p2);
});

test('marks revalidated only for a full check', async () => {
  const d = deferredFetch();
  const p = runCheck(['a'], d); d.calls[0].resolve(); await p;
  expect(d.markFullyChecked).toHaveBeenCalledWith(false);
});

test('logout drops the queued follow-up', async () => {
  const d = deferredFetch();
  runCheck(['a'], d); d.calls[0].onSent(); runCheck(['b'], d);
  onLogout();
  d.calls[0].resolve();
  await flush();
  expect(d.fetch).toHaveBeenCalledTimes(1);
  expect(d.markFullyChecked).not.toHaveBeenCalled();
});

test('a failed check still runs the queued follow-up', async () => {
  const d = deferredFetch();
  const first = runCheck(['a'], d); first.catch(() => {});
  d.calls[0].onSent(); runCheck(['b'], d);
  d.calls[0].resolve(Promise.reject(new Error('offline')));
  await flush();
  expect(d.fetch).toHaveBeenCalledTimes(2);
});

test('an unsent check that does not cover the trigger queues a follow-up', () => {
  const d = deferredFetch();
  runCheck(['a'], d); runCheck(['z'], d);
  expect(d.fetch).toHaveBeenCalledTimes(1);
});

test('resumes with the time captured before the delay', async () => {
  const d = { delay: () => Promise.resolve(), resume: jest.fn() };
  await resumeSession(d, 1234);
  expect(d.resume).toHaveBeenCalledWith(1234);
});
""",
}


def write(root, files):
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(text)


def build(root):
    def g(*args):
        subprocess.run(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True,
                       capture_output=True)
    os.makedirs(root, exist_ok=True)
    g("init", "-q", "-b", "main")
    write(root, BASE)
    g("add", "-A")
    g("commit", "-qm", "check runner: share running checks")
    g("checkout", "-qb", "fix-races")
    write(root, FIX)
    g("add", "-A")
    g("commit", "-qm", "check runner: follow-up check for triggers after requests are sent")
    g("checkout", "-q", "main")
    return root


def apply_fixes(root):
    """The author's second commit on fix-races, addressing the review."""
    def g(*args):
        subprocess.run(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True,
                       capture_output=True)
    g("checkout", "-q", "fix-races")
    write(root, FIXED)
    g("add", "-A")
    g("commit", "-qm", "address review: keep pre-sent sharing, one merged follow-up, logout cleanup, tests")
    g("checkout", "-q", "main")
    return root


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = args[0] if args else "review-case"
    print(apply_fixes(root) if "--fixed" in sys.argv else build(root))
