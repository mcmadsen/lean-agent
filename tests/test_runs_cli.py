"""0.45.46: --cards name parsing, card cut notes, runs --last, resume visibility."""
import os
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent as agent  # noqa: E402


def card(cid, title="", text="body"):
    return {"id": cid, "title": title or cid, "text": text, "tokens": agent.est_tokens(text), "archived": False}


class CardNames(unittest.TestCase):
    def setUp(self):
        self.lib = {c["id"]: c for c in (card("mem-alpha-one", "Alpha one"), card("mem-beta-two", "Beta two"),
                                         card("mem-beta-three", "Beta three"))}

    def test_comma_space_quotes_and_trailing_comma(self):
        ids, miss = agent.parse_card_names(' mem-alpha-one, "mem-beta-two" ,', self.lib)
        self.assertEqual((ids, miss), (["mem-alpha-one", "mem-beta-two"], []))

    def test_title_slug_and_unique_partial(self):
        ids, miss = agent.parse_card_names("Alpha one,alpha", self.lib)
        self.assertEqual((ids, miss), (["mem-alpha-one"], []))

    def test_missing_and_ambiguous_are_named(self):
        ids, miss = agent.parse_card_names("nope, beta", self.lib)
        self.assertEqual(ids, [])
        self.assertEqual(len(miss), 2)
        self.assertEqual(miss[0], "nope")
        self.assertIn("ambiguous", miss[1])

    def test_auto_and_none_pass_through(self):
        self.assertEqual(agent.parse_card_names("auto, mem-alpha-one", self.lib)[0], ["auto", "mem-alpha-one"])


class CardCut(unittest.TestCase):
    def test_cut_note_names_lines_and_absolute_path(self):
        text = "\n".join(f"- line {i} " + "word " * 20 for i in range(200))
        with tempfile.TemporaryDirectory() as d:
            out, kept, total = agent.trim_for_load(dict(card("big", text=text)), d)
            last = out.splitlines()[-1]
            self.assertRegex(last, r"^\(cut: \d+ more lines; full card: /")
            path = last.split("full card: ")[1].rstrip(")")
            self.assertTrue(os.path.isabs(path) and os.path.exists(path))

    def test_table_card_gets_a_bigger_cap(self):
        rows = "\n".join(f"| row {i} | " + "x" * 30 + " | y |" for i in range(160))
        prose = "\n".join(f"row {i} " + "x" * 30 + " y" for i in range(160))
        t, p = card("t", text=rows), card("p", text=prose)
        self.assertTrue(agent.table_shaped(t) and not agent.table_shaped(p))
        with tempfile.TemporaryDirectory() as d:
            self.assertGreater(agent.trim_for_load(t, d)[1], agent.trim_for_load(p, d)[1])
            self.assertLessEqual(agent.trim_for_load(t, d)[1], agent.CARD_LOAD_CAP * agent.CARD_TABLE_FACTOR)


if __name__ == "__main__":
    unittest.main()
