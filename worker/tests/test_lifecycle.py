"""Worker side of the desktop lifecycle (electron/worker-supervisor.cjs):
GET /health identifies this process, and a worker started by the desktop app
exits on its own if that app disappears without a clean quit.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

from store import STORE  # noqa: E402

WORKER_DIR = Path(__file__).resolve().parent.parent


class TestHealthIdentity(unittest.TestCase):
    def test_health_names_the_service_and_the_answering_process(self):
        body = STORE.health_json()
        # The desktop app adopts a worker only on this exact id, and checks the
        # pid matches the process it started.
        self.assertEqual(body["service"], "assistant-editor-worker")
        self.assertEqual(body["pid"], os.getpid())
        self.assertTrue(body["ok"])

    def test_health_is_served_by_the_real_flask_app(self):
        import server

        resp = server.app.test_client().get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["service"], "assistant-editor-worker")


def _run_watchdog(parent_pid_expr: str, seconds: float) -> subprocess.CompletedProcess:
    """A real Python process that imports the real server module and arms the
    real watchdog against `parent_pid_expr` — without ever binding port 32145."""
    code = (
        "import os, sys, time; sys.path.insert(0, '.');"
        "import server;"
        f"server._exit_when_parent_dies({parent_pid_expr});"
        f"time.sleep({seconds}); print('STILL-ALIVE', flush=True)"
    )
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(WORKER_DIR), capture_output=True, text=True, timeout=seconds + 10,
        env={**os.environ, "ASSISTANT_EDITOR_SKIP_DOTENV": "1"},
    )


class TestParentWatchdog(unittest.TestCase):
    def test_exits_promptly_once_its_parent_is_gone(self):
        # A pid that isn't our parent looks exactly like "the app went away".
        started = time.monotonic()
        proc = _run_watchdog("999999", seconds=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("STILL-ALIVE", proc.stdout)
        self.assertLess(time.monotonic() - started, 6)

    def test_keeps_running_while_its_parent_is_alive(self):
        proc = _run_watchdog("os.getppid()", seconds=2.5)
        self.assertIn("STILL-ALIVE", proc.stdout, proc.stderr)


class TestNoDotenvWhenSkipped(unittest.TestCase):
    """Regression: Flask's app.run() has its OWN .env loader that searches from
    the current directory upward. In the packaged app (cwd inside the bundle)
    it loaded the repo-root .env and the worker made real, paid API calls even
    with ASSISTANT_EDITOR_SKIP_DOTENV=1. Runs the real server.py main path from
    a directory containing a .env with fake keys; Werkzeug is stopped right
    before it would bind the port, and reports what reached os.environ."""

    def setUp(self):
        import tempfile

        self.tmp = Path(tempfile.mkdtemp(prefix="ae-dotenv-test-"))
        (self.tmp / ".env").write_text("OPENAI_API_KEY=sk-fake-should-never-load-000\nANTHROPIC_API_KEY=sk-ant-fake-000\n")
        (self.tmp / ".flaskenv").write_text("ANTHROPIC_API_KEY=sk-ant-fake-flaskenv-000\n")
        hook = self.tmp / "hook"
        hook.mkdir()
        (hook / "sitecustomize.py").write_text(
            "import os, sys, werkzeug.serving\n"
            "def _stop(*a, **k):\n"
            "    keys = sorted(k for k in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY') if os.environ.get(k))\n"
            "    print('KEYS-AT-SERVE=' + ','.join(keys), flush=True)\n"
            "    os._exit(0)\n"
            "werkzeug.serving.run_simple = _stop\n"
        )

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_packaged_style_launch_never_loads_a_dotenv_from_the_working_directory(self):
        env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY")}
        env.update({"ASSISTANT_EDITOR_SKIP_DOTENV": "1", "PYTHONPATH": f"{self.tmp / 'hook'}:{WORKER_DIR}"})
        env.pop("FLASK_SKIP_DOTENV", None)  # prove server.py itself is safe, not just the launcher's env
        proc = subprocess.run(
            [sys.executable, str(WORKER_DIR / "server.py")],
            cwd=str(self.tmp), capture_output=True, text=True, timeout=60, env=env,
        )
        self.assertIn("KEYS-AT-SERVE=", proc.stdout, proc.stderr[-2000:])
        self.assertIn("KEYS-AT-SERVE=\n", proc.stdout)  # no key at all reached the server


if __name__ == "__main__":
    unittest.main()
