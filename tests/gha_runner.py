"""Test runner that adds GitHub Actions annotations for failed tests."""
import inspect
import os
import sys
import unittest

MAX_ANNOTATIONS = 20


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
    msg = "\n".join(lines[start:start + 3])
    title = f"{cls.__name__}.{name}"
    return (f"::error file={_escape_prop(test_file)}{line},"
            f"title={_escape_prop(title)}::{_escape(msg)}")


def main(test_file):
    """Run unittest.main; under GitHub Actions also emit annotations."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        unittest.main(module="__main__", verbosity=2)
        return
    prog = unittest.main(module="__main__", verbosity=2, exit=False)
    result = prog.result
    bad = result.failures + result.errors
    rel = os.path.relpath(test_file)
    for test, err in bad[:MAX_ANNOTATIONS]:
        print(_annotation(test, err, rel))
    print(f"::notice::Ran {result.testsRun} tests, {len(result.failures)} failures, "
          f"{len(result.errors)} errors, {len(result.skipped)} skipped")
    sys.exit(not result.wasSuccessful())
