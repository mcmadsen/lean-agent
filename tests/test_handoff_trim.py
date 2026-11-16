"""0.45.75: the start injection carries only open, recent hand-off notes (one line each, capped) and open threads."""
import datetime
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)
os.environ["LEAN_AGENT_HOME"] = tempfile.mkdtemp()
os.environ["LEAN_AGENT_TEST"] = "1"

import compact_hook  # noqa: E402
import lean_threads  # noqa: E402

HOME = os.environ["LEAN_AGENT_HOME"]


def iso(days_ago):
    return (datetime.datetime.now() - datetime.timedelta(days=days_ago)).isoformat(timespec="seconds")


def fixture_notes(n=30, long_every=3, old_every=5):
    """n open notes (done ones are removed from the file); every `long_every`th is long, every `old_every`th is 10 days old."""
    out = []
    for i in range(1, n + 1):
        text = f"Note {i}: " + ("detail " * (150 if i % long_every == 0 else 3))
        out.append({"ts": iso(10 if i % old_every == 0 else i / 24), "text": text.strip()})
    return out


def write_notes(notes):
    with open(os.path.join(HOME, "handoff-notes.json"), "w") as fh:
        json.dump(notes, fh)


def tokens(text):
    return (len(text) + 3) // 4


class Trim(unittest.TestCase):
    def test_only_recent_open_notes_newest_first_one_line_each(self):
        write_notes([{"ts": iso(10), "text": "Too old note"}, {"ts": iso(2), "text": "Older note"},
                     {"ts": iso(0), "text": "x" * 400}, {"ts": iso(1), "text": "Middle note"},
                     {"ts": iso(0), "text": "Checkpoint body", "kind": "checkpoint"}])
        out = compact_hook.handoff(inject=True)
        self.assertNotIn("Too old note", out)
        self.assertNotIn("Checkpoint body", out)
        self.assertLess(out.index("Middle note"), out.index("Older note"))
        lines = [ln for ln in out.splitlines() if ln.startswith("  3. ")]
        self.assertEqual(len(lines), 1)
        self.assertLessEqual(len(lines[0]), 170)
        self.assertIn("1 more notes (older or longer): lean-agent handoff", out)

    def test_done_notes_are_never_injected(self):
        write_notes([{"ts": iso(0), "text": "Keep me"}, {"ts": iso(0), "text": "Close me"}])
        compact_hook.os.environ["LEAN_AGENT_HOME"] = HOME
        import lean_agent
        a = type("A", (), {"note": None, "done": "2", "kind": None, "hours": 12})()
        lean_agent.cmd_handoff(a)
        out = compact_hook.handoff(inject=True)
        self.assertIn("Keep me", out)
        self.assertNotIn("Close me", out)
        self.assertNotIn("more notes", out)

    def test_the_cap_holds_with_long_notes(self):
        notes = fixture_notes(200, long_every=1, old_every=1000)
        lines = compact_hook.inject_notes(notes)
        self.assertLessEqual(tokens("\n".join(lines)), compact_hook.NOTE_TOKENS + 40)
        self.assertRegex(lines[-1], r"^\d+ more notes \(older or longer\): lean-agent handoff$")
        self.assertTrue(all(len(ln) <= 170 for ln in lines[1:-1]))

    def test_no_more_line_when_everything_fits(self):
        write_notes([{"ts": iso(0), "text": "One"}, {"ts": iso(1), "text": "Two"}])
        self.assertNotIn("more notes", compact_hook.handoff(inject=True))

    def test_handoff_without_trim_shows_all_notes_in_full(self):
        notes = fixture_notes()
        write_notes(notes)
        out = compact_hook.handoff()
        for i, n in enumerate(notes, 1):
            self.assertIn(f"  {i}. {n['text']}", out)

    def test_fixture_numbers(self):
        notes = fixture_notes()
        write_notes(notes)
        before, after = tokens(compact_hook.handoff()), tokens(compact_hook.handoff(inject=True))
        print(f"\nhand-off tokens: before {before}, after {after}")
        self.assertLess(after, before)


class Threads(unittest.TestCase):
    def test_thread_table_keeps_open_threads_and_counts_the_rest(self):
        os.environ["LEAN_AGENT_HOME"] = HOME
        for i in range(20):
            tid = lean_threads.new(f"Topic {i}")
            if i < 8:
                lean_threads.ask(tid, f"question {i}")
        out = compact_hook.threads_summary()
        rows = [ln for ln in out.splitlines() if ln.startswith("| t")]
        self.assertEqual(len(rows), 12)  # the table cap; the other 8 are counted
        self.assertIn("8 closed/parked: lean-agent now", out)
        old = iso(5)
        with lean_threads._locked() as data:
            for tid in list(data["threads"])[8:]:
                data["threads"][tid]["last_message"] = old
        out = compact_hook.threads_summary()
        rows = [ln for ln in out.splitlines() if ln.startswith("| t")]
        self.assertEqual(len(rows), 8)
        self.assertIn("12 closed/parked: lean-agent now", out)


if __name__ == "__main__":
    unittest.main()
