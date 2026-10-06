"""Real (subprocess) tests for validate_e2e.py itself — not the AI pipeline it
drives, but the harness's own honesty: does it start the real worker, does it
report FAIL (not a false PASS) when a stage genuinely has nothing to show, does
it cascade SKIPs sensibly downstream, and does it fail fast and clearly on bad
input? Deliberately run with no OPENAI_API_KEY/ANTHROPIC_API_KEY, so the
transcription/visual/selects stages are guaranteed to have nothing real to
report — this proves the script calls that out as FAIL rather than papering
over it, which is the whole point of a validation script. Exercising the
image/reasoning stages with real API keys and real results is up to the person
running this on their own machine (see VALIDATION.md); that isn't something
this sandbox can do.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_DIR))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else


def _ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_synthetic_clip(dest: Path, seconds: float = 1.0, with_audio: bool = True) -> bool:
    args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=24:duration={seconds}"]
    if with_audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if with_audio:
        args += ["-c:a", "aac", "-shortest"]
    args += [str(dest)]
    try:
        subprocess.run(args, capture_output=True, timeout=60, check=True)
        return dest.exists() and dest.stat().st_size > 0
    except (subprocess.SubprocessError, OSError):
        return False


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _run_validator(
    media_root: str, out_dir: Path, port: int, extra_args: list[str] | None = None, env_extra: dict | None = None,
) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(env_extra or {})
    env.pop("OPENAI_API_KEY", None)
    env.pop("ANTHROPIC_API_KEY", None)
    # Popping the keys alone isn't enough: the validator imports server.py,
    # whose load_dotenv() would restore them from the repo-root .env.
    env["ASSISTANT_EDITOR_SKIP_DOTENV"] = "1"
    args = [
        sys.executable, "validate_e2e.py",
        "--media-root", media_root,
        "--out-dir", str(out_dir),
        "--port", str(port),
        "--analyze-timeout-seconds", "90",
    ]
    return subprocess.run(
        args + (extra_args or []),
        cwd=str(WORKER_DIR), env=env, capture_output=True, text=True, timeout=150,
    )


def _stage_status(report: dict, name: str) -> str | None:
    for s in report["stages"]:
        if s["name"] == name:
            return s["status"]
    return None


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestValidateE2eHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-e2e-harness-test-"))
        self.footage = self.tmp / "footage"
        self.footage.mkdir()
        ok_int = _make_synthetic_clip(self.footage / "A001_INT_TEST_01.mov", with_audio=True)
        ok_broll = _make_synthetic_clip(self.footage / "B101_BROLL_TEST.mov", with_audio=False)
        if not (ok_int and ok_broll):
            self.skipTest("Could not synthesize test clips with this ffmpeg build.")
        self.out_dir = self.tmp / "out"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reports_honest_fail_cascade_without_api_keys(self):
        proc = _run_validator(str(self.footage), self.out_dir, _free_port())

        # No API keys -> real, correctly-installed pipeline should still run the
        # non-AI stages for real and fail the AI-dependent stages honestly,
        # never silently pass them.
        self.assertNotEqual(proc.returncode, 0, f"expected a nonzero exit with no API keys.\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")

        report_path = self.out_dir / "report.json"
        self.assertTrue(report_path.exists(), f"report.json was not written.\nstdout:\n{proc.stdout}")
        report = json.loads(report_path.read_text())
        self.assertFalse(report["overallOk"])

        # Real stages that don't need an API key: these must be PASS, or the
        # harness (or the underlying pipeline) is broken independent of keys.
        for name in ("import_footage", "worker_startup", "analyze_run", "proxies"):
            self.assertEqual(_stage_status(report, name), "PASS", f"stage {name} was not PASS:\n{report}")

        # AI-dependent stages: must be reported FAIL, not skipped or silently
        # passed, when no provider is configured — this is the core honesty
        # property this harness exists to guarantee.
        for name in ("transcription", "visual_analysis", "selects"):
            self.assertEqual(_stage_status(report, name), "FAIL", f"stage {name} should FAIL with no API keys:\n{report}")

        # Everything downstream of "no selects" has nothing to work with, so it
        # must cascade to SKIP, not FAIL (a FAIL there would blame the wrong
        # stage) and not PASS (there's nothing real to check).
        for name in ("stories", "decisions", "preview", "export"):
            self.assertEqual(_stage_status(report, name), "SKIP", f"stage {name} should SKIP with no selects:\n{report}")

    def test_never_touches_a_real_projects_saved_analysis_or_app_state(self):
        """Regression: validating a real project's folder replaced its
        .ae_analysis.json — a new analysisId — which (correctly) orphaned the
        project's saved cuts. The validator must leave all project state alone
        while still running the full pipeline."""
        import hashlib

        snapshot = self.footage / ".ae_analysis.json"
        original = json.dumps({"schema": 1, "analysisId": "real-project-analysis", "clips": []}).encode()
        snapshot.write_bytes(original)
        home = self.tmp / "home"
        app_data = home / "Library" / "Application Support" / "Assistant Editor AI"
        (app_data / "edit-state").mkdir(parents=True)
        edit_state = app_data / "edit-state" / "proj-1.json"
        edit_state.write_text(json.dumps({"schema": 1, "analysisId": "real-project-analysis", "versions": [{"id": "v2"}]}))
        app_state = app_data / "app-state.json"
        app_state.write_text(json.dumps({"activeProjectId": "proj-1"}))

        def digest(root: Path) -> dict:
            return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}

        app_before = digest(home)
        import site

        # A throwaway HOME (so the real app's userData can't even be reached),
        # keeping Python's user site-packages where the worker's deps live.
        env_extra = {"HOME": str(home), "PYTHONUSERBASE": site.getuserbase()}
        proc = _run_validator(str(self.footage), self.out_dir, _free_port(), env_extra=env_extra)

        self.assertEqual(snapshot.read_bytes(), original, "the project's saved analysis was modified")
        self.assertEqual(digest(home), app_before, "app userData (edit state / app state) was modified")
        report = json.loads((self.out_dir / "report.json").read_text())
        for name in ("import_footage", "worker_startup", "analyze_run", "proxies"):
            self.assertEqual(_stage_status(report, name), "PASS", f"stage {name}:\n{proc.stdout[-2000:]}")

    def test_does_not_create_a_saved_analysis_where_none_existed(self):
        proc = _run_validator(str(self.footage), self.out_dir, _free_port())
        report = json.loads((self.out_dir / "report.json").read_text())
        self.assertEqual(_stage_status(report, "analyze_run"), "PASS", proc.stdout[-2000:])
        self.assertFalse((self.footage / ".ae_analysis.json").exists())

    def test_fails_fast_and_clearly_on_a_nonexistent_media_root(self):
        bogus_root = str(self.tmp / "does-not-exist")
        proc = _run_validator(bogus_root, self.out_dir, _free_port())
        self.assertNotEqual(proc.returncode, 0)
        report = json.loads((self.out_dir / "report.json").read_text())
        self.assertEqual(len(report["stages"]), 1)
        self.assertEqual(report["stages"][0]["name"], "import_footage")
        self.assertEqual(report["stages"][0]["status"], "FAIL")
        # Must never have tried to start the real worker against bad input.
        self.assertIsNone(_stage_status(report, "worker_startup"))

    def test_reports_a_clear_error_when_the_port_is_already_taken(self):
        port = _free_port()
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            blocker.bind(("127.0.0.1", port))
            blocker.listen(1)
            proc = _run_validator(str(self.footage), self.out_dir, port)
            self.assertNotEqual(proc.returncode, 0)
            report = json.loads((self.out_dir / "report.json").read_text())
            self.assertEqual(_stage_status(report, "worker_startup"), "FAIL")
        finally:
            blocker.close()


if __name__ == "__main__":
    unittest.main()
