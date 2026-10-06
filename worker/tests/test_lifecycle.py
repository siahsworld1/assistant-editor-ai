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


if __name__ == "__main__":
    unittest.main()
