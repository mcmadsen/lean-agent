"""No module of the plugin defines the same top-level function, class or UPPER_CASE constant twice: a second
definition silently replaces the first, and every caller of the first breaks (it happened with a constant and a
function)."""
import ast
import collections
import glob
import os
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")


def top_level_names(tree):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield node.name, node.lineno
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Name) and t.id.isupper() and len(t.id) > 1:
                    yield t.id, node.lineno


class NoShadowing(unittest.TestCase):
    def test_no_duplicate_top_level_definitions(self):
        problems = []
        for path in sorted(glob.glob(os.path.join(SCRIPTS, "*.py"))):
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), path)
            seen = collections.defaultdict(list)
            for name, line in top_level_names(tree):
                seen[name].append(line)
            for name, lines in seen.items():
                if len(lines) > 1:
                    problems.append(f"{os.path.basename(path)}: {name} defined at lines {lines}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_no_duplicate_class_names_in_a_test_file(self):
        """A second `class X` in a test module replaces the first: its tests silently never run."""
        problems = []
        for path in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "*.py"))):
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), path)
            seen = collections.defaultdict(list)
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    seen[node.name].append(node.lineno)
            problems += [f"{os.path.basename(path)}: class {n} at lines {ls}" for n, ls in seen.items() if len(ls) > 1]
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
