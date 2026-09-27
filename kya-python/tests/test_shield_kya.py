import json
import os
import stat
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import shield_kya
from shield_kya import KyaDenied, evaluate, governed

FAKE_KYA = """#!/bin/sh
echo "$@" >> "$KYA_FAKE_LOG"
case "$*" in
  *never.event*)
    echo '{"eval":{"response":{"verdict":"DENY","reasonCode":"NEVER_EVENT","toolId":"x"},"offline":true},"sideEffect":"blocked"}'
    exit 1 ;;
  *data.write*)
    echo '{"eval":{"response":{"verdict":"REQUIRE_APPROVE","reasonCode":"HIGH_STAKES_WRITE","toolId":"x"},"offline":true},"sideEffect":"blocked"}'
    exit 0 ;;
  *infra.fail*)
    echo '{"eval":{"response":{"verdict":"ALLOW","reasonCode":"ALLOW","toolId":"x"},"offline":true}}'
    exit 2 ;;
  eval-tool*)
    echo '{"response":{"verdict":"ALLOW","reasonCode":"LOW_RISK_READ","toolId":"x"},"toolId":"x","offline":true}'
    exit 0 ;;
  *)
    echo '{"eval":{"response":{"verdict":"ALLOW","reasonCode":"ALLOW","toolId":"x"},"offline":true},"sideEffect":"blocked"}'
    exit 0 ;;
esac
"""


class ShieldKyaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        fake = Path(self.tmp.name) / "kya"
        fake.write_text(FAKE_KYA)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.log = Path(self.tmp.name) / "calls.log"
        self._env = unittest.mock.patch.dict(
            os.environ,
            {
                "PATH": f"{self.tmp.name}{os.pathsep}{os.environ['PATH']}",
                "KYA_FAKE_LOG": str(self.log),
            },
        )
        self._env.start()
        self.addCleanup(self._env.stop)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_evaluate_returns_parsed_verdict_dict(self):
        result = evaluate("org.sample.safe.read", {"path": "a.txt"})
        self.assertEqual(result["response"]["verdict"], "ALLOW")
        self.assertTrue(result["offline"])
        argv = self.calls()[0]
        self.assertIn("eval-tool", argv)
        self.assertIn("--offline", argv)
        self.assertIn('--args {"path": "a.txt"}', argv)

    def test_governed_allow_runs_function(self):
        @governed("org.sample.safe.read")
        def read(path):
            return f"contents of {path}"

        self.assertEqual(read("a.txt"), "contents of a.txt")

    def test_governed_sends_bound_args_to_the_cli(self):
        @governed("org.sample.safe.read")
        def read(path, limit=10):
            return f"{path}:{limit}"

        self.assertEqual(read("a.txt", limit=5), "a.txt:5")
        self.assertIn('--args {"path": "a.txt", "limit": 5}', self.calls()[0])

    def test_governed_args_fall_back_to_repr_when_unserializable(self):
        @governed("org.sample.safe.read")
        def read(handle):
            return "ok"

        self.assertEqual(read(object()), "ok")
        self.assertIn("--args ", self.calls()[0])

    def test_transport_failure_exit_code_raises_runtime_error(self):
        @governed("infra.fail")
        def ping():
            return "unreachable"

        with self.assertRaises(RuntimeError) as ctx:
            ping()
        self.assertIn("exited 2", str(ctx.exception))
        self.assertNotIsInstance(ctx.exception, KyaDenied)

    def test_governed_require_approve_runs_function(self):
        @governed("org.sample.data.write", irreversible=True)
        def write():
            return "wrote"

        self.assertEqual(write(), "wrote")
        self.assertIn("--irreversible", self.calls()[0])

    def test_governed_deny_raises_without_running(self):
        ran = []

        @governed("org.sample.never.event")
        def never():
            ran.append(1)

        with self.assertRaises(KyaDenied) as ctx:
            never()
        self.assertEqual(ran, [])
        self.assertEqual(ctx.exception.verdict, "DENY")
        self.assertEqual(ctx.exception.reason_code, "NEVER_EVENT")
        self.assertEqual(ctx.exception.tool_id, "org.sample.never.event")

    def test_governed_server_prefixes_tool_id(self):
        @governed("read_file", server="filesystem")
        def read():
            return "ok"

        self.assertEqual(read(), "ok")
        self.assertIn("--tool-id filesystem__read_file", self.calls()[0])


if __name__ == "__main__":
    unittest.main()
