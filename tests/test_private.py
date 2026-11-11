"""0.45.52: a private project is local only: nothing pushes or publishes, and feedback leaves it out."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _env  # noqa: E402

PLUGIN = os.path.join(HERE, "..", "plugins", "lean-agent")
SCRIPTS = os.path.join(PLUGIN, "scripts")
AGENT = os.path.join(SCRIPTS, "lean_agent.py")
sys.path.insert(0, SCRIPTS)


class PrivateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        self.env = {**_env.clean_environ(), "LEAN_AGENT_HOME": self.home, "HOME": self.tmp,
                    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        self.repo = os.path.join(self.tmp, "secretrepo")
        self.other = os.path.join(self.tmp, "openrepo")
        for r in (self.repo, self.other):
            os.makedirs(r)
            self.git(r, "init", "-q", "-b", "main")
            with open(os.path.join(r, "CLAUDE.md"), "w") as fh:
                fh.write("# Rules\n\nBe nice.\n")
            self.git(r, "add", "-A")
            self.git(r, "commit", "-qm", "init")
        self.bare = os.path.join(self.tmp, "remote.git")
        self.git(self.tmp, "init", "-q", "--bare", self.bare)
        self.git(self.repo, "remote", "add", "origin", self.bare)
        self.git(self.other, "remote", "add", "origin", self.bare)
        self.cli("learn", self.repo, "--name", "vault", "--private", "--no-rules")
        self.cli("learn", self.other, "--name", "open", "--no-rules")
        os.environ["LEAN_AGENT_HOME"] = self.home
        self.addCleanup(os.environ.pop, "LEAN_AGENT_HOME", None)

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, env=self.env)

    def cli(self, *args, cwd=None):
        return subprocess.run([sys.executable, AGENT, *args], capture_output=True, text=True, env=self.env, cwd=cwd or self.tmp)

    def hook(self, script, command, cwd):
        return subprocess.run([sys.executable, os.path.join(SCRIPTS, script)], capture_output=True, text=True, env=self.env,
                              input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd,
                                                "session_id": "s", "transcript_path": os.path.join(self.tmp, "t.jsonl")}))

    def denied(self, command, cwd=None, script="push_guard.py"):
        out = self.hook(script, command, cwd or self.repo).stdout
        if not out.strip():
            return ""
        d = json.loads(out)["hookSpecificOutput"]
        return d["permissionDecisionReason"] if d["permissionDecision"] == "deny" else ""

    MSG = "project vault is private (local only): pushing/publishing is disabled"


class Setting(PrivateCase):
    def test_config_on_off_and_listing(self):
        self.assertIn("[private]", self.cli("projects").stdout.split("vault")[1].split("\n")[0])
        self.assertIn("off", self.cli("config", "private", "vault", "off").stdout)
        self.assertNotIn("[private]", self.cli("projects").stdout)
        self.assertIn("on", self.cli("config", "private", "vault", "on").stdout)
        self.assertIn("[private]", self.cli("projects").stdout)

    def test_doctor_names_the_project_and_remote(self):
        out = self.cli("doctor", self.repo, cwd=self.repo).stdout
        self.assertIn("vault is private (local only)", out)
        self.assertIn("remote origin is unknown", out)


class Blocked(PrivateCase):
    def test_hooks_refuse_every_publishing_command_with_the_reason(self):
        for cmd in ("git push origin HEAD", "git push -u origin feature", "git -C . push --force", "git remote add x http://h/r",
                    "git remote set-url origin http://h/r", "gh pr create --title x", "gh repo create foo",
                    "gh release create v1", "az repos pr create --title x", "az repos create --name x",
                    "lean-agent worktree push vault feature", "lean-agent worktree push vault feature --allow-send ok",
                    "lean-agent worktree push vault feature --override-guard x --allow-send ok",
                    "lean-agent review vault --post"):
            with self.subTest(cmd=cmd):
                self.assertIn(self.MSG, self.denied(cmd))
                self.assertIn("lean-agent config private vault off", self.denied(cmd))
                self.assertIn(self.MSG, self.denied(cmd, script="budget_hook.py"))

    def test_reading_the_remote_is_allowed(self):
        for cmd in ("git fetch origin", "git pull", "git ls-remote origin", "git remote -v", "gh pr view 3", "az repos pr list"):
            with self.subTest(cmd=cmd):
                self.assertNotIn(self.MSG, self.denied(cmd))

    def test_other_projects_are_unaffected(self):
        self.assertNotIn("private", self.denied("git remote add x http://h/r", cwd=self.other))
        self.assertNotIn("private", self.denied("gh pr create", cwd=self.other))

    def test_worktree_dir_counts(self):
        wt = os.path.join(self.home, "worktrees", "vault", "w1")
        os.makedirs(wt)
        self.assertIn(self.MSG, self.denied("git push origin HEAD", cwd=wt))

    def test_command_itself_refuses_worktree_push_despite_overrides(self):
        for extra in ([], ["--allow-send", "ok"], ["--override-guard", "x", "--allow-send", "ok"]):
            p = self.cli("worktree", "push", "vault", "feature", *extra)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn(self.MSG, p.stderr + p.stdout)

    def test_git_itself_refuses_through_the_wrapper(self):
        wrapper = os.path.join(SCRIPTS, "push_guard.py")
        real = subprocess.run(["which", "git"], capture_output=True, text=True).stdout.strip()
        for args in (["push", "origin", "HEAD"], ["remote", "add", "y", "http://h/r"]):
            p = subprocess.run([sys.executable, wrapper, "git-wrapper", real, *args], capture_output=True, text=True,
                               cwd=self.repo, env={**self.env, "LEAN_AGENT_PUSH_GUARD_OVERRIDE": "1"})
            self.assertEqual(p.returncode, 1)
            self.assertIn(self.MSG, p.stderr)
        p = subprocess.run([sys.executable, wrapper, "git-wrapper", real, "fetch", "origin"], capture_output=True, text=True,
                           cwd=self.repo, env=self.env)
        self.assertEqual(p.returncode, 0)

    def test_off_lifts_it(self):
        self.cli("config", "private", "vault", "off")
        self.assertNotIn("private", self.denied("git remote add x http://h/r"))


class Feedback(PrivateCase):
    def test_export_redacts_a_private_project_only(self):
        import lean_feedback
        self.git(self.repo, "branch", "secret-launch")
        lean_feedback.add(f"worktree push vault failed for PR 4242 on {self.repo} branch secret-launch "
                          "see https://example.com/org/vault/pullrequest/4242", repro="lean-agent worktree push vault x")
        lean_feedback.add("open project push open failed for PR 77", commands=["lean-agent worktree push open t1"])
        out, _ = lean_feedback.export(out=os.path.join(self.tmp, "fb.md"))
        text = open(out).read()
        for leak in ("vault", "secretrepo", "secret-launch", "4242", "example.com"):
            self.assertNotIn(leak, text)
        self.assertIn("<private project>", text)
        self.assertIn("<redacted>", text)
        self.assertIn("1 items redacted (private projects)", text)
        self.assertIn("PR 77", text)
        self.assertIn("worktree push open", text)

    def test_list_and_crash_records_are_redacted(self):
        import lean_feedback
        lean_feedback.record_crash(["worktree", "push", "vault", "feat"], RuntimeError(f"boom in {self.repo}"))
        shown = lean_feedback.table(lean_feedback.list_items())
        self.assertNotIn("vault", shown)
        self.assertNotIn("secretrepo", shown)
        raw = open(os.path.join(self.home, "feedback", "feedback.jsonl")).read()
        self.assertNotIn("secretrepo", raw)


    def test_goals_private_and_dropped(self):
        import lean_goals
        led = os.path.join(self.home, "ledger.jsonl")
        with open(led, "w") as fh:
            fh.write(json.dumps({"id": "r1", "project": "vault", "thread": "t1", "task": "PR 700"}) + "\n")
            fh.write(json.dumps({"id": "r2", "project": "open", "thread": "t2", "task": "PR 701"}) + "\n")
        old = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, old)
        gid = lean_goals.ensure("work on vault PR 700", "t9")
        g = next(x for x in lean_goals._load() if x["id"] == gid)
        self.assertEqual(g["target"], lean_goals.LOCAL_TARGET)
        gid = lean_goals.ensure("PR 702", "t2")
        self.assertEqual(next(x for x in lean_goals._load() if x["id"] == gid)["target"], lean_goals.DEFAULT_TARGET)
        # dropped goals are not re-created automatically; an explicit add brings them back
        lean_goals.drop(gid, "not needed")
        self.assertEqual(lean_goals.ensure("PR 702", "t2"), "")
        self.assertTrue(lean_goals.add("PR 702", "t2"))
        # startup cleanup drops open outward goals of private threads once
        a = lean_goals.ensure("PR 703", "t1")
        b = lean_goals.ensure("PR 704", "t2")
        items = lean_goals._load()
        for x in items:
            if x["id"] in (a, b):
                x["target"] = lean_goals.DEFAULT_TARGET
        lean_goals._save(items)
        out = lean_goals.cleanup([], lambda tid: [])
        self.assertTrue(any("private" in line for line in out))
        st = {x["id"]: x for x in lean_goals._load()}
        self.assertEqual((st[a]["state"], st[a]["next"]), ("dropped", "private project"))
        self.assertNotEqual(st[b]["state"], "dropped")


    def test_fresh_project_has_no_foreign_cards(self):
        import lean_memory
        store = os.path.join(self.home, "memory")
        lean_memory.add(store, "Never use ado for tickets, the user's rule.", "feedback", scope="open", name="ado rule")
        lean_memory.add(store, "Be brief.", "user", scope="global", name="brief")
        os.makedirs(os.path.join(self.tmp, "x", "proj"))
        with open(os.path.join(self.tmp, "x", "proj", "README.md"), "w") as fh:
            fh.write("hi\n")
        r = self.cli("learn", os.path.join(self.tmp, "x", "proj"), "--name", "fresh", "--no-rules")
        self.assertIn("0 cards", r.stdout)
        out = self.cli("cards", "fresh").stdout
        self.assertIn("0 own cards", out)
        self.assertIn("shared global", out)
        self.assertNotIn("ado-rule", out)


    def test_rule_warning_ignores_common_words(self):
        import io
        import contextlib
        import lean_agent
        card = {"id": "r1", "is_rule": True, "targets": ["user's"], "alternative": "", "text": "x", "title": "t"}
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            lean_agent.task_rule_warnings([card], "update the user's profile page")
        self.assertEqual(err.getvalue(), "")


    def test_private_has_no_pr_refs(self):
        import lean_goals
        with open(os.path.join(self.home, "ledger.jsonl"), "w") as fh:
            fh.write(json.dumps({"id": "r1", "project": "vault", "thread": "t1", "task": "x"}) + "\n")
        old = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, old)
        self.assertEqual(lean_goals.ref_in("fix PR 2 and #7", private=True), "")
        self.assertEqual(lean_goals.ref_in("fix PR 2", private=False), "PR 2")
        self.assertEqual(lean_goals.note_text("review PR 2 please", "t1"), "")
        self.assertEqual(lean_goals.note_text("review PR 3 please", "t2"), lean_goals.note_text("review PR 3 please", "t2"))
        import lean_agent
        self.assertEqual([r for r in lean_agent.thread_pr_refs("t1")], [])
        lost = lean_goals.lost_message("r9", "task", private=True)
        self.assertNotIn("final report", lost)
        self.assertIn("locally", lost)
        self.assertIn("locally", lean_goals.nudge_message("task", private=True))
        g = {"id": "g1", "thread": "t1", "ref": "task", "state": "active"}
        self.assertTrue(lean_goals._context(g, {}, "lost", "r9", 0, True)["private"])

    def test_unscoped_memory_belongs_to_its_project(self):
        import lean_agent
        import lean_memory
        enc = "".join(c if c.isalnum() else "-" for c in lean_memory.git_root(self.repo))
        d = os.path.join(self.tmp, ".claude", "projects", enc, "memory")
        os.makedirs(d)
        with open(os.path.join(d, "note.md"), "w") as fh:
            fh.write("---\nname: n\ndescription: d\ntype: project\n---\nOnly for the vault.\n")
        os.environ["LEAN_AGENT_MEMORY_DIR"] = d
        self.addCleanup(os.environ.pop, "LEAN_AGENT_MEMORY_DIR", None)
        has = lambda slug: any("Only for the vault" in c["text"] for c in lean_agent.sync_memory(slug))
        self.assertTrue(has("vault"))
        self.assertFalse(has("open"))
        os.makedirs(os.path.join(self.tmp, "x", "p2"))
        with open(os.path.join(self.tmp, "x", "p2", "README.md"), "w") as fh:
            fh.write("hi\n")
        self.cli("learn", os.path.join(self.tmp, "x", "p2"), "--name", "newp", "--no-rules")
        self.assertFalse(has("newp"))


class StartLine(unittest.TestCase):
    def test_empty_cards_part_is_omitted(self):
        with open(AGENT, encoding="utf-8") as fh:
            src = fh.read()
        self.assertNotIn("""if cards else "")""", src.split("run {run_id} started")[1].split("see it later")[0])
        self.assertIn('" · private"', src)


if __name__ == "__main__":
    unittest.main()
