"""`service stop|restart` never hangs silently: it says what it waits for, gives up after the timeout and kills the old service."""
import os
import signal
import sys
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "lean-agent", "scripts")
sys.path.insert(0, ROOT)

import lean_agent  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class WaitOrKillTest(unittest.TestCase):
    def run_wait(self, dies_at=None, dies_on=None):
        c, said, sigs = Clock(), [], []
        t0 = c.t

        def alive(pid):
            if dies_at is not None and c.t - t0 >= dies_at:
                return False
            return not (dies_on and dies_on in sigs)

        res = lean_agent.wait_or_kill(4242, wait=90, grace=10, say=said.append, alive=alive, sleep=c.sleep, clock=c.now,
                                      killpg=lambda p, sig: sigs.append(sig))
        return res, said, sigs, c.t - t0

    def test_stops_by_itself(self):
        res, said, sigs, took = self.run_wait(dies_at=25)
        self.assertEqual((res, sigs), ("stopped", []))
        self.assertTrue(any("waiting for the service to stop (pid 4242" in s for s in said))

    def test_gives_up_after_90s_and_terms(self):
        res, said, sigs, took = self.run_wait(dies_on=signal.SIGTERM)
        self.assertEqual((res, sigs), ("killed", [signal.SIGTERM]))
        self.assertTrue(90 <= took < 100)
        self.assertTrue(any("killing its process group" in s for s in said))

    def test_sigkill_after_10s(self):
        res, said, sigs, took = self.run_wait(dies_on=signal.SIGKILL)
        self.assertEqual(sigs, [signal.SIGTERM, signal.SIGKILL])
        self.assertGreaterEqual(took, 100)

    def test_gone(self):
        self.assertEqual(lean_agent.wait_or_kill(0), "gone")


class DoctorStartTest(unittest.TestCase):
    def check(self, text):
        out = []
        lean_agent.doctor_service_start(lambda ok, msg, fix=None: out.append((ok, msg)), text=text, now=2e9)
        return out

    def test_slow_start_warns(self):
        out = self.check("2026-11-09T10:00:00 DEBUG startup: service start\n2026-11-09T10:02:30 DEBUG startup: sessions up (1s)\n")
        self.assertIsNone(out[0][0])
        self.assertIn("150s", out[0][1])

    def test_fast_start_ok(self):
        out = self.check("2026-11-09T10:00:00 DEBUG startup: service start\n2026-11-09T10:00:05 DEBUG startup: sessions up (1s)\n")
        self.assertTrue(out[0][0])


if __name__ == "__main__":
    unittest.main()
