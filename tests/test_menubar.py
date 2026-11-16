import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "plugins", "lean-agent", "scripts")
SCRIPT = os.path.join(SCRIPTS, "lean_agent.py")
JS = os.path.join(SCRIPTS, "menubar.js")


def run(*args, platform="", home=None):
    env = dict(os.environ, LEAN_AGENT_SERVICE_PLATFORM=platform)
    if home:
        env["HOME"] = home
        env["LEAN_AGENT_HOME"] = os.path.join(home, "la")
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=60, env=env)


class MenubarTest(unittest.TestCase):
    def test_non_macos_message_and_exit_code(self):
        for form in ([], ["--install"], ["--uninstall"], ["--status"]):
            r = run("menubar", *form, platform="linux")
            self.assertEqual(r.returncode, 2, form)
            self.assertIn("the menu bar item is macOS-only; on Windows the tray item needs lean-agent's service on "
                          "Windows first (not supported yet)", r.stderr)

    def test_plist_is_a_pure_function(self):
        sys.path.insert(0, SCRIPTS)
        import lean_agent
        d = lean_agent.menubar_plist("/x/menubar.js", "/x/lean-agent")
        self.assertEqual(d["Label"], "com.lean-agent.menubar")
        self.assertEqual(d["ProgramArguments"], ["osascript", "-l", "JavaScript", "/x/menubar.js"])
        self.assertIs(d["RunAtLoad"], True)
        self.assertIs(d["KeepAlive"], False)

    def test_install_and_uninstall_call_launchctl(self):
        with tempfile.TemporaryDirectory() as home:
            fake = os.path.join(home, "launchctl")
            log = os.path.join(home, "calls.txt")
            with open(fake, "w") as fh:
                fh.write(f'#!/bin/sh\necho "$@" >> {log}\n')
            os.chmod(fake, 0o755)
            os.environ["LEAN_AGENT_LAUNCHCTL"] = fake
            try:
                r = run("menubar", "--install", platform="mac", home=home)
                self.assertEqual(r.returncode, 0, r.stderr)
                path = os.path.join(home, "Library", "LaunchAgents", "com.lean-agent.menubar.plist")
                with open(path, "rb") as fh:
                    p = plistlib.load(fh)
                self.assertEqual(p["ProgramArguments"][:3], ["osascript", "-l", "JavaScript"])
                self.assertTrue(p["ProgramArguments"][3].endswith("menubar.js"))
                self.assertTrue(p["RunAtLoad"])
                r = run("menubar", "--uninstall", platform="mac", home=home)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertFalse(os.path.exists(path))
                calls = open(log).read().splitlines()
                self.assertTrue(any(c.startswith("bootstrap gui/") and c.endswith("menubar.plist") for c in calls), calls)
                self.assertTrue(any(c.startswith("bootout gui/") and c.endswith("/com.lean-agent.menubar") for c in calls), calls)
            finally:
                os.environ.pop("LEAN_AGENT_LAUNCHCTL", None)

    def test_js_has_no_network_and_runs_only_known_commands(self):
        src = open(JS).read()
        for bad in ("http://", "https://", "NSURLSession", "NSURLConnection", "XMLHttpRequest", "fetch(", "WebSocket",
                    "doShellScript", "NSAppleScript"):
            self.assertNotIn(bad, src)
        cmds = set(re.findall(r"(?:spawn|run)\(\[(BIN, '[a-z]+'|'open', '-a', 'Claude')", src))
        self.assertTrue(cmds <= {"BIN, 'map'", "BIN, 'menubar'", "'open', '-a', 'Claude'"}, cmds)
        self.assertIn("BIN, 'map'", cmds)
        self.assertIn("'open', '-a', 'Claude'", cmds)
        self.assertIn("'map', '--json'", src)
        self.assertIn("'--svg', '--mini'", src)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_js_syntax(self):
        r = subprocess.run(["node", "--check", JS], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
