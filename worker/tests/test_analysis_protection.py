"""A completed analysis is never replaced blindly (worker/persistence.py,
worker/pipeline.py, worker/server.py).

Root cause this guards against (2026-10-09): "Analyze Footage" on a folder that
already had a full analysis ran a fresh one with no AI credentials and the
worker wrote the empty result over .ae_analysis.json — a new analysisId, so the
saved cuts no longer opened. Now:
  - POST /analyze needs the filmmaker's confirmation for the saved analysis id;
  - the previous file is first copied (content-addressed, verified) into
    .ae_analysis_history/, and nothing is written if that fails;
  - an analysis that lost transcript or visual evidence the saved one had does
    not replace it unless the filmmaker allowed exactly that;
  - a failed or refused re-analysis puts the saved analysis back, with a note;
  - the worker only answers the app that started it (its token).

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import persistence  # noqa: E402
import pipeline  # noqa: E402
import server  # noqa: E402
from store import STORE  # noqa: E402
from tests.test_rc_workflow import _ffmpeg_present, _make_clip, _seed_store  # noqa: E402


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class _Folder(unittest.TestCase):
    """Two real clips and a SAVED analysis with transcript + visual evidence."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ae-protect-test-"))
        for name in ("a.mov", "b.mov"):
            if not _make_clip(self.root / name):
                self.skipTest("Could not synthesize test clips with this ffmpeg build.")
        _seed_store(self.root, ["a.mov", "b.mov"])
        self.assertIsNotNone(persistence.save_snapshot(STORE))
        self.snapshot = self.root / persistence.SNAPSHOT_NAME
        self.saved_id = STORE.analysis_id
        self.saved_sha = _sha(self.snapshot)

    def tearDown(self):
        STORE.reset()
        shutil.rmtree(self.root, ignore_errors=True)

    def history(self) -> list[Path]:
        d = persistence.history_dir(str(self.root))
        return sorted(p for p in d.iterdir() if p.suffix == ".json") if d.is_dir() else []

    def assert_saved_untouched(self):
        self.assertEqual(_sha(self.snapshot), self.saved_sha)
        self.assertFalse(list(self.root.glob("*.partial")))


class TestFirstAnalysis(unittest.TestCase):
    @unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
    def test_a_first_analysis_needs_no_confirmation_and_keeps_no_history(self):
        root = Path(tempfile.mkdtemp(prefix="ae-first-"))
        try:
            if not _make_clip(root / "a.mov"):
                self.skipTest("no test clip")
            STORE.reset()
            with patch.object(pipeline, "run_analysis") as run:
                body = server.app.test_client().post(
                    "/analyze", json={"projectId": "p", "mediaRoot": str(root)}).get_json()
            self.assertTrue(body["accepted"], body)
            run.assert_called_once_with("p", str(root), False)
            pipeline.run_analysis("p", str(root))  # the real run (no AI keys: no evidence)
            self.assertEqual(STORE.analysis_state, "complete", STORE.error)
            self.assertTrue((root / persistence.SNAPSHOT_NAME).is_file())
            self.assertFalse(persistence.history_dir(str(root)).exists())
            self.assertIsNone(STORE.analysis_note)
        finally:
            STORE.reset()
            shutil.rmtree(root, ignore_errors=True)


class TestConfirmation(_Folder):
    def post(self, **extra):
        return server.app.test_client().post(
            "/analyze", json={"projectId": "p", "mediaRoot": str(self.root), **extra}).get_json()

    def test_reanalysis_needs_the_confirmation_for_the_saved_analysis(self):
        with patch.object(pipeline, "run_analysis") as run:
            for extra in ({}, {"confirmReplace": True}, {"confirmReplace": {"analysisId": "other"}},
                          {"confirmReplace": {"allowIncomplete": True}}):
                body = self.post(**extra)
                self.assertEqual(body["accepted"], False, extra)
                self.assertEqual(body["state"], "confirmation-required")
                self.assertEqual(body["existing"], {"analysisId": self.saved_id, "clips": 2, "transcript": 1,
                                                    "visualEvidence": 1, "selects": 1, "stories": 1})
            run.assert_not_called()
        self.assert_saved_untouched()

    def test_confirmed_reanalysis_starts_and_carries_the_incomplete_permission(self):
        with patch.object(pipeline, "run_analysis") as run:
            self.assertTrue(self.post(confirmReplace={"analysisId": self.saved_id})["accepted"])
            run.assert_called_with("p", str(self.root), False)
            server._analysis_lock.acquire(timeout=5)
            server._analysis_lock.release()
            self.assertTrue(self.post(confirmReplace={"analysisId": self.saved_id, "allowIncomplete": True})["accepted"])
            run.assert_called_with("p", str(self.root), True)


class TestNoSilentDowngrade(_Folder):
    def test_missing_api_credentials_never_replace_a_full_analysis(self):
        pipeline.run_analysis("p", str(self.root))  # no keys: transcription and vision can't run
        self.assert_saved_untouched()
        self.assertEqual(self.history(), [])  # nothing was replaced, so nothing to back up
        self.assertEqual(STORE.analysis_state, "complete")
        self.assertEqual(STORE.analysis_id, self.saved_id)  # the saved analysis is back
        self.assertEqual(len(STORE.transcript), 1)
        self.assertRegex(STORE.analysis_note, r"did not produce the transcript of 1 file and the visual "
                                              r"evidence of 1 file.*previous analysis was kept")
        self.assertEqual(server.app.test_client().get("/project").get_json()["project"]["analysisNote"],
                         STORE.analysis_note)

    def test_an_incomplete_analysis_losing_one_files_evidence_is_refused(self):
        STORE.transcript = []  # the new analysis lost a.mov's transcript only
        out = persistence.write_snapshot(STORE)
        self.assertEqual((out["saved"], out["reason"]), (False, "would-lose-evidence"))
        self.assertEqual(out["lost"], ["transcript of a.mov"])
        self.assert_saved_untouched()

    def test_the_filmmaker_can_allow_it_and_the_previous_one_is_kept_byte_for_byte(self):
        before = self.snapshot.read_bytes()
        pipeline.run_analysis("p", str(self.root), allow_incomplete=True)
        self.assertNotEqual(STORE.analysis_id, self.saved_id)
        self.assertNotEqual(_sha(self.snapshot), self.saved_sha)
        [kept] = self.history()
        self.assertEqual(kept.read_bytes(), before)
        self.assertEqual(kept.name, f"{self.saved_id[:8]}-{hashlib.sha256(before).hexdigest()[:16]}.json")
        self.assertIsNone(STORE.analysis_note)

    def test_a_failed_reanalysis_puts_the_saved_analysis_back(self):
        with patch.object(pipeline, "_analyze_one_clip", side_effect=RuntimeError("probe crashed")):
            pipeline.run_analysis("p", str(self.root), allow_incomplete=True)
        self.assert_saved_untouched()
        self.assertEqual((STORE.analysis_state, STORE.analysis_id), ("complete", self.saved_id))
        self.assertRegex(STORE.analysis_note, r"Re-analysis failed \(probe crashed\).*previous analysis was kept")


class TestBackupAndAtomicWrite(_Folder):
    def test_backup_failure_refuses_the_replacement(self):
        (self.root / persistence.HISTORY_DIR).write_text("not a folder")  # the copy can't be made
        pipeline.run_analysis("p", str(self.root), allow_incomplete=True)
        self.assert_saved_untouched()
        self.assertEqual(STORE.analysis_id, self.saved_id)
        self.assertRegex(STORE.analysis_note, r"couldn't be backed up first.*kept")

    def test_a_backup_that_does_not_verify_counts_as_failed(self):
        real = persistence.os.replace

        def corrupting(src, dst):
            real(src, dst)
            if persistence.HISTORY_DIR in str(dst):
                Path(dst).write_bytes(b"corrupted")

        with patch.object(persistence.os, "replace", side_effect=corrupting):
            STORE.analysis_id = "new-analysis"
            out = persistence.write_snapshot(STORE, allow_incomplete=True)
        self.assertEqual(out["reason"], "preserve-failed")
        self.assert_saved_untouched()

    def test_an_interrupted_write_leaves_the_saved_file_and_no_partial(self):
        real = persistence.os.replace

        def failing(src, dst):
            if Path(dst) == self.snapshot:
                raise OSError("disk full")
            return real(src, dst)

        STORE.analysis_id = "new-analysis"
        with patch.object(persistence.os, "replace", side_effect=failing):
            out = persistence.write_snapshot(STORE, allow_incomplete=True)
        self.assertEqual(out["reason"], "write-failed")
        self.assert_saved_untouched()
        [kept] = self.history()  # backed up before the write was tried
        self.assertEqual(_sha(kept), self.saved_sha)

    def test_backups_are_content_addressed_and_never_removed(self):
        for n in range(3):
            STORE.analysis_id = f"next-{n}"
            self.assertTrue(persistence.write_snapshot(STORE, allow_incomplete=True)["saved"])
        names = [p.name for p in self.history()]
        self.assertEqual(len(names), 3)  # the original + the first two replacements
        self.assertEqual(sum(n.startswith(self.saved_id[:8] + "-") for n in names), 1)  # the original, once
        # Re-saving the very same analysis is not a replacement: nothing new is kept.
        self.assertEqual(persistence.write_snapshot(STORE)["reason"], "unchanged")
        self.assertEqual(len(self.history()), 3)


class TestWorkerToken(unittest.TestCase):
    TOKEN = "t" * 64

    def client(self, token: str):
        with patch.object(server, "WORKER_TOKEN", token):
            return server.app.test_client()

    def test_with_a_token_only_its_owner_is_answered(self):
        with patch.object(server, "WORKER_TOKEN", self.TOKEN), patch.dict(
            "os.environ", {"ASSISTANT_EDITOR_WORKER_TOKEN": self.TOKEN}
        ):
            c = server.app.test_client()
            for headers in ({}, {"X-Assistant-Editor-Token": "wrong"}, {"X-Assistant-Editor-Token": ""}):
                for method, path in (("get", "/project"), ("post", "/analyze"), ("post", "/restore"), ("get", "/selects")):
                    res = getattr(c, method)(path, headers=headers, json={})
                    self.assertEqual(res.status_code, 401, (path, headers))
                    self.assertNotIn(self.TOKEN, res.get_data(as_text=True))
            ok = c.get("/project", headers={"X-Assistant-Editor-Token": self.TOKEN})
            self.assertEqual(ok.status_code, 200)
            health = c.get("/health")  # identification stays open: the app probes the port with it
            self.assertEqual((health.status_code, health.get_json()["auth"]), (200, "token"))
            self.assertNotIn(self.TOKEN, health.get_data(as_text=True))
            self.assertEqual(c.open("/analyze", method="OPTIONS").status_code, 204)

    def test_a_worker_started_by_hand_without_a_token_stays_open(self):
        with patch.object(server, "WORKER_TOKEN", ""), patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("ASSISTANT_EDITOR_WORKER_TOKEN", None)
            c = server.app.test_client()
            self.assertEqual(c.get("/project").status_code, 200)
            self.assertEqual(c.get("/health").get_json()["auth"], "open")


if __name__ == "__main__":
    unittest.main()
