"""Test runner that adds GitHub Actions annotations for failed tests."""
import inspect
import os
import sys
import unittest

MAX_ANNOTATIONS = 20
MAX_MESSAGE = 4000  # characters; GitHub cuts longer annotation messages


def _escape(text):
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_prop(text):
    return _escape(text).replace(":", "%3A").replace(",", "%2C")


def _annotation(test, err, test_file):
    cls = type(test)
    name = getattr(test, "_testMethodName", str(test))
    line = ""
    try:
        line = f",line={inspect.getsourcelines(getattr(cls, name))[1]}"
    except (OSError, TypeError, AttributeError):
        pass
    lines = err.strip().splitlines()
    # the exception message starts at the first unindented line after "Traceback"
    start = next((i for i, l in enumerate(lines)
                  if i and l and not l[0].isspace() and not l.startswith("Traceback")), 0)
    msg = "\n".join(lines[start:start + 80])
    if len(msg) > MAX_MESSAGE:  # keep the end: assertion helpers put the useful output (stderr) last
        msg = msg[:600] + "\n...\n" + msg[-(MAX_MESSAGE - 610):]
    title = f"{cls.__name__}.{name}"
    return (f"::error file={_escape_prop(test_file)}{line},"
            f"title={_escape_prop(title)}::{_escape(msg)}")


def _flatten(suite):
    for t in suite:
        if isinstance(t, unittest.TestSuite):
            yield from _flatten(t)
        else:
            yield t


def _shard_suite(spec):
    """Tests of module __main__ selected by LEAN_TEST_SHARD="i/n" (1-based), regrouped by class."""
    try:
        i, n = (int(x) for x in spec.split("/"))
        if not 1 <= i <= n:
            raise ValueError
    except ValueError:
        sys.exit(f"bad LEAN_TEST_SHARD {spec!r}: expected i/n with 1 <= i <= n")
    main_mod = sys.modules["__main__"]
    cases = sorted(_flatten(unittest.defaultTestLoader.loadTestsFromModule(main_mod)),
                   key=lambda t: t.id())
    picked = [t for k, t in enumerate(cases) if k % n == i - 1]
    print(f"shard {i}/{n}: {len(picked)} of {len(cases)} tests", file=sys.stderr)
    by_class = {}
    for t in picked:  # picked is sorted by id, so classes stay grouped and ordered
        by_class.setdefault(type(t), []).append(t)
    return unittest.TestSuite(unittest.TestSuite(v) for v in by_class.values()), picked


def _report(result, test_file):
    bad = result.failures + result.errors
    rel = os.path.relpath(test_file)
    for test, err in bad[:MAX_ANNOTATIONS]:
        print(_annotation(test, err, rel))
    print(f"::notice::Ran {result.testsRun} tests, {len(result.failures)} failures, "
          f"{len(result.errors)} errors, {len(result.skipped)} skipped")


def main(test_file):
    """Run unittest.main (or one shard of it); under GitHub Actions also emit annotations."""
    gha = os.environ.get("GITHUB_ACTIONS") == "true"
    spec = os.environ.get("LEAN_TEST_SHARD", "").strip()
    if spec:
        suite, picked = _shard_suite(spec)
        if os.environ.get("LEAN_TEST_SHARD_LIST") == "1":
            for t in picked:
                print(t.id())
            sys.exit(0)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if gha:
            _report(result, test_file)
        sys.exit(not result.wasSuccessful())
    if not gha:
        unittest.main(module="__main__", verbosity=2)
        return
    prog = unittest.main(module="__main__", verbosity=2, exit=False)
    _report(prog.result, test_file)
    sys.exit(not prog.result.wasSuccessful())
