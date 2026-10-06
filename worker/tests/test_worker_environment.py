"""The worker is developed, tested and packaged with ONE pinned Python and ONE
hash-locked dependency set (scripts/worker-python.sh, worker/requirements*.lock).
These tests pin that contract: the release Python is 3.12, the locks are fully
pinned and hashed and agree with their inputs, the tests themselves run in the
locked environment, and the worker self-test (which the packaged build checks
against the lock) reports every locked package.

Run from worker/ in the locked env: `.venv/bin/python -m unittest discover -s tests -v`
(create it with `scripts/worker-python.sh dev`).
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import re
import subprocess
import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent
REPO = WORKER_DIR.parent
sys.path.insert(0, str(WORKER_DIR))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

ENV_SCRIPT = (REPO / "scripts" / "worker-python.sh").read_text()
BUILD_SCRIPT = (REPO / "scripts" / "build-worker.sh").read_text()
LOCK = (WORKER_DIR / "requirements.lock").read_text()
BUILD_LOCK = (WORKER_DIR / "requirements-build.lock").read_text()
INPUT = (WORKER_DIR / "requirements.txt").read_text()


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _locked(text: str) -> dict[str, str]:
    return {_norm(m[1]): m[2] for m in re.finditer(r"^([A-Za-z0-9._-]+)==(\S+)", text, re.M)}


def _script_var(name: str) -> str:
    m = re.search(rf'^{name}="([^"]+)"', ENV_SCRIPT, re.M)
    assert m, name
    return m[1]


def _vt(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


class TestReleasePython(unittest.TestCase):
    def test_release_builds_use_pinned_python_3_12(self):
        version = _script_var("PY_VERSION")
        self.assertEqual(_vt(version)[:2], (3, 12))
        self.assertRegex(_script_var("PBS_SHA256"), r"^[0-9a-f]{64}$")
        self.assertIn("aarch64-apple-darwin", ENV_SCRIPT)
        # The build takes its interpreter from the pinned environment only —
        # never an overridable or PATH-chosen python3 — and refuses non-3.12.
        self.assertIn('scripts/worker-python.sh" build', BUILD_SCRIPT)
        self.assertNotIn("ASSISTANT_EDITOR_BUILD_PYTHON", BUILD_SCRIPT)
        self.assertIn('[[ "$PY_VERSION" == 3.12.* ]]', BUILD_SCRIPT)

    def test_installs_only_from_hashed_locks(self):
        for flag in ("--require-hashes", "--no-deps", "--only-binary=:all:", "--isolated"):
            self.assertIn(flag, ENV_SCRIPT)

    def test_tests_run_in_the_locked_environment(self):
        # Validating with one set of packages and shipping another is exactly
        # what the lock prevents — so the test run itself must be locked.
        self.assertEqual(platform.python_version(), _script_var("PY_VERSION"),
                         "run the worker tests with worker/.venv (scripts/worker-python.sh dev)")
        for name, version in _locked(LOCK).items():
            self.assertEqual(importlib.metadata.version(name), version, name)


class TestLockIntegrity(unittest.TestCase):
    def _entries(self, text: str) -> dict[str, list[str]]:
        blocks = re.split(r"\n(?=[A-Za-z0-9._-]+==)", text)
        out = {}
        for block in blocks:
            m = re.match(r"([A-Za-z0-9._-]+)==(\S+)", block)
            if m:
                out[_norm(m[1])] = re.findall(r"--hash=sha256:([0-9a-f]{64})", block)
        return out

    def test_every_locked_package_is_pinned_and_hashed(self):
        for text in (LOCK, BUILD_LOCK):
            entries = self._entries(text)
            self.assertTrue(entries)
            for name, hashes in entries.items():
                self.assertTrue(hashes, f"{name} has no hash")
            self.assertNotRegex(text, r"(?m)^[A-Za-z0-9._-]+(>=|<=|~=|>|<)")
            self.assertNotIn("/Users/", text)

    def test_lock_matches_its_input(self):
        locked = _locked(LOCK)
        for name, op, version in re.findall(r"(?m)^([A-Za-z0-9._-]+)\s*(==|>=)\s*(\S+)", INPUT):
            self.assertIn(_norm(name), locked, name)
            if op == "==":
                self.assertEqual(locked[_norm(name)], version, name)
            else:
                self.assertGreaterEqual(_vt(locked[_norm(name)]), _vt(version), name)

    def test_ai_sdks_are_pinned_deliberately(self):
        locked = _locked(LOCK)
        for name in ("openai", "anthropic", "httpx", "pydantic", "numpy", "flask", "werkzeug", "python-dotenv"):
            self.assertRegex(INPUT, rf"(?mi)^{name}==", f"{name} must be an exact, chosen pin")
            self.assertIn(name, locked)

    def test_build_tools_stay_out_of_the_production_lock(self):
        prod, build = _locked(LOCK), _locked(BUILD_LOCK)
        for tool in ("pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "macholib", "setuptools"):
            self.assertNotIn(tool, prod)
        self.assertIn("pyinstaller", build)
        for name in set(prod) & set(build):
            self.assertEqual(prod[name], build[name], name)


class TestSelftestReportsTheLockedSet(unittest.TestCase):
    def test_selftest_imports_everything_and_reports_locked_versions(self):
        env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY")}
        env["ASSISTANT_EDITOR_SKIP_DOTENV"] = "1"
        proc = subprocess.run([sys.executable, "server.py", "--selftest"], cwd=str(WORKER_DIR),
                              env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["python"], platform.python_version())
        self.assertFalse([k for k, v in report["modules"].items() if str(v).startswith("MISSING")])
        for name, version in _locked(LOCK).items():
            self.assertEqual(report["distributions"].get(name), version, name)


if __name__ == "__main__":
    unittest.main()
