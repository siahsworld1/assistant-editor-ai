"""P0 Step 8 regressions: evidence reaching the app, saved analysis surviving a
restart, real source-moment frames, and B-roll material reaching the build.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import media  # noqa: E402
import persistence  # noqa: E402
import pipeline  # noqa: E402
from store import STORE, ClipState  # noqa: E402
from tests.fakes import FakeReasoningProvider  # noqa: E402


def _ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_clip(dest: Path, size: str = "320x240", seconds: float = 3.0) -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=24:duration={seconds}",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(dest)],
            capture_output=True, timeout=60, check=True,
        )
        return dest.exists()
    except (subprocess.SubprocessError, OSError):
        return False


def _seed_store(root: Path, filenames: list[str]) -> None:
    """A completed analysis over real files, as pipeline.run_analysis leaves it."""
    STORE.reset()
    STORE.project_id = "proj-rc"
    STORE.media_root = str(root)
    for i, name in enumerate(filenames):
        STORE.upsert_clip(ClipState(
            id=f"clip-{i + 1:03d}", filename=name, rel_path=name, role="interview", duration_seconds=3.0,
            camera="H.264", resolution="320x240", fps=23.976, state="analyzed", has_transcript=(i == 0),
            source_key=media.source_cache_key(root / name) or "",
        ))
    STORE.transcript = [{"id": "clip-001-t1", "clipId": "clip-001", "speaker": "Ana", "startTc": "00:00:00:12",
                         "endTc": "00:00:02:00", "text": "We built this together.", "confidence": 0.9}]
    STORE.visual_evidence = [{"id": "clip-002-v1", "clipId": "clip-002", "kind": "b-roll",
                              "label": "Hands planting seedlings", "atTc": "00:00:01:00", "confidence": 0.8}]
    STORE.selects = [{"id": "sel-01", "rank": 1, "speaker": "Ana", "clipId": "clip-001", "clipName": filenames[0],
                      "startTc": "00:00:00:12", "endTc": "00:00:02:00", "durationSeconds": 1.5, "score": 90,
                      "category": "emotional", "transcriptExcerpt": "We built this together.", "reasons": [],
                      "evidence": []}]
    STORE.stories = [{"id": "story-01", "title": "Together", "premise": "p", "estimatedSeconds": 30,
                      "confidence": 0.8, "beats": [{"id": "b1", "label": "Open", "intent": "hook",
                                                    "estimatedSeconds": 30, "selectIds": ["sel-01"]}],
                      "supportingSelectIds": ["sel-01"]}]
    STORE.complete()


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class _MediaFolderCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ae-rc-test-"))
        for name in ("a.mov", "b.mov"):
            if not _make_clip(self.root / name):
                self.skipTest("Could not synthesize test clips with this ffmpeg build.")
        _seed_store(self.root, ["a.mov", "b.mov"])

    def tearDown(self):
        STORE.reset()
        shutil.rmtree(self.root, ignore_errors=True)


class TestEvidenceReachesTheApp(_MediaFolderCase):
    """Root cause of WATCH showing 'No dialogue detected' / 'Nothing logged yet'
    for analyzed clips: GET /project only ever sent per-clip counts."""

    def test_project_json_carries_transcript_visual_evidence_and_analysis_id(self):
        body = STORE.project_json()
        self.assertEqual([t["text"] for t in body["transcript"]], ["We built this together."])
        self.assertEqual([v["label"] for v in body["visualEvidence"]], ["Hands planting seedlings"])
        self.assertTrue(body["analysisId"])

    def test_served_by_the_real_route(self):
        import server

        body = server.app.test_client().get("/project").get_json()["project"]
        self.assertEqual(body["transcript"][0]["clipId"], "clip-001")
        self.assertEqual(body["visualEvidence"][0]["clipId"], "clip-002")


class TestSavedAnalysis(_MediaFolderCase):
    def test_completed_analysis_survives_a_worker_restart(self):
        saved = persistence.save_snapshot(STORE)
        self.assertEqual(saved, self.root / persistence.SNAPSHOT_NAME)
        before = STORE.project_json()
        STORE.reset()  # worker restarted: memory is empty
        res = persistence.restore_snapshot(STORE, "proj-rc", str(self.root))
        self.assertTrue(res["restored"], res)
        after = STORE.project_json()
        for key in ("clips", "transcript", "visualEvidence", "analysisId", "analysisState"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(STORE.selects[0]["id"], "sel-01")
        self.assertEqual(STORE.stories[0]["id"], "story-01")

    def test_refuses_when_a_source_file_changed(self):
        persistence.save_snapshot(STORE)
        st = (self.root / "b.mov").stat()
        os.utime(self.root / "b.mov", ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        STORE.reset()
        res = persistence.restore_snapshot(STORE, "proj-rc", str(self.root))
        self.assertEqual(res["reason"], "media-changed")
        self.assertEqual(STORE.analysis_state, "idle")  # nothing partially restored
        self.assertEqual(STORE.clips, {})

    def test_refuses_when_a_source_file_is_gone(self):
        persistence.save_snapshot(STORE)
        (self.root / "a.mov").unlink()
        STORE.reset()
        self.assertEqual(persistence.restore_snapshot(STORE, "p", str(self.root))["reason"], "media-changed")

    def test_no_snapshot_and_foreign_or_incompatible_snapshots(self):
        STORE.reset()
        self.assertEqual(persistence.restore_snapshot(STORE, "p", str(self.root))["reason"], "no-saved-analysis")
        (self.root / persistence.SNAPSHOT_NAME).write_text(json.dumps({"schema": 999}))
        self.assertEqual(persistence.restore_snapshot(STORE, "p", str(self.root))["reason"], "saved-analysis-incompatible")
        (self.root / persistence.SNAPSHOT_NAME).write_text(json.dumps({"schema": 1, "mediaRoot": "/elsewhere"}))
        self.assertEqual(persistence.restore_snapshot(STORE, "p", str(self.root))["reason"], "saved-analysis-for-another-folder")

    def test_the_restore_route_validates_input_and_never_interrupts_an_analysis(self):
        import server

        client = server.app.test_client()
        persistence.save_snapshot(STORE)
        self.assertEqual(client.post("/restore", json={"mediaRoot": "relative/path"}).status_code, 400)
        STORE.analysis_state = "running"
        self.assertEqual(client.post("/restore", json={"mediaRoot": str(self.root)}).get_json()["reason"], "analysis-running")
        STORE.reset()
        res = client.post("/restore", json={"projectId": "proj-rc", "mediaRoot": str(self.root)}).get_json()
        self.assertTrue(res["restored"], res)
        again = client.post("/restore", json={"projectId": "proj-rc", "mediaRoot": str(self.root)}).get_json()
        self.assertEqual(again["reason"], "already-loaded")


class TestNormalAnalysisStillPersists(_MediaFolderCase):
    """The validator turns persistence off for itself only: a normal analysis
    run through the real pipeline still saves (and can restore) its snapshot."""

    def setUp(self):
        super().setUp()
        STORE.reset()
        os.environ.pop(persistence.PERSIST_ENV, None)

    def tearDown(self):
        os.environ.pop(persistence.PERSIST_ENV, None)
        super().tearDown()

    def test_a_normal_analysis_saves_a_restorable_snapshot(self):
        pipeline.run_analysis("proj-normal", str(self.root))
        self.assertEqual(STORE.analysis_state, "complete", STORE.error)
        saved = self.root / persistence.SNAPSHOT_NAME
        self.assertTrue(saved.is_file())
        analysis_id = STORE.analysis_id
        STORE.reset()
        res = persistence.restore_snapshot(STORE, "proj-normal", str(self.root))
        self.assertTrue(res["restored"], res)
        self.assertEqual(STORE.analysis_id, analysis_id)

    def test_with_persistence_off_nothing_is_written_or_read(self):
        os.environ[persistence.PERSIST_ENV] = "0"
        pipeline.run_analysis("proj-off", str(self.root))
        self.assertEqual(STORE.analysis_state, "complete", STORE.error)
        self.assertFalse((self.root / persistence.SNAPSHOT_NAME).exists())
        self.assertEqual(persistence.restore_snapshot(STORE, "p", str(self.root))["reason"], "persistence-disabled")


class TestSourceFrames(_MediaFolderCase):
    def test_returns_real_cached_frames_at_the_requested_source_times(self):
        import server

        client = server.app.test_client()
        res = client.post("/frames", json={"clipId": "clip-001", "times": [0.5, 2.0], "width": 160}).get_json()
        self.assertEqual([f["seconds"] for f in res["frames"]], [0.5, 2.0])
        for f in res["frames"]:
            path = self.root / f["relPath"]
            self.assertTrue(media.cached_artifact_is_valid(path), f)
            self.assertTrue(f["relPath"].startswith(".ae_thumbs/frames/"))
        mtime = (self.root / res["frames"][0]["relPath"]).stat().st_mtime_ns
        time.sleep(0.05)
        again = client.post("/frames", json={"clipId": "clip-001", "times": [0.5], "width": 160}).get_json()
        self.assertEqual((self.root / again["frames"][0]["relPath"]).stat().st_mtime_ns, mtime)  # served from cache

    def test_clamps_times_to_the_clip_and_bounds_the_request(self):
        import server

        client = server.app.test_client()
        res = client.post("/frames", json={"clipId": "clip-001", "times": [-5, 99] + [1] * 30}).get_json()
        self.assertLessEqual(len(res["frames"]), 16)
        self.assertEqual(res["frames"][0]["seconds"], 0.0)
        self.assertLessEqual(res["frames"][1]["seconds"], 3.0)
        self.assertEqual(client.post("/frames", json={"clipId": "clip-999", "times": [1]}).status_code, 404)


class TestBrollMaterialReachesTheBuild(_MediaFolderCase):
    """Root cause of 'no V2 B-roll': the build brief only ever listed
    transcript selects, so the model had no visual material to cut away to."""

    def test_brief_lists_every_analyzed_clip_with_its_real_visual_moments(self):
        fake = FakeReasoningProvider(responses=[{"summary": "s", "changes": [], "decisions": []}])
        pipeline.build_timeline("proj-rc", "story-01", 30, "use b-roll", reasoning_provider=fake)
        brief = fake.calls[0][1][0].text
        self.assertIn("CLIP MATERIAL", brief)
        # No transcript → judged non-dialogue (worker/dialogue.py), labelled for the Director.
        self.assertIn("clip-002 | b.mov | 3.0 | no (likely B-roll) | 00:00:01:00 b-roll: Hands planting seedlings", brief)
        self.assertIn("clip-001 | a.mov | 3.0 | yes | —", brief)

    def test_b_roll_decisions_from_the_model_survive_validation_on_their_own_lane(self):
        fake = FakeReasoningProvider(responses=[{"summary": "s", "changes": [], "decisions": [
            {"lane": "interview", "clipId": "clip-001", "label": "Ana", "sourceInTc": "00:00:00:12",
             "sourceOutTc": "00:00:02:00", "timelineStartSeconds": 0, "durationSeconds": 1.5},
            {"lane": "b-roll", "clipId": "clip-002", "label": "seedlings", "sourceInTc": "00:00:00:12",
             "sourceOutTc": "00:00:01:12", "timelineStartSeconds": 0.5, "durationSeconds": 1.0},
        ]}])
        res = pipeline.build_timeline("proj-rc", "story-01", 30, None, reasoning_provider=fake)
        lanes = {d["lane"]: d for d in res["decisions"]}
        self.assertEqual(set(lanes), {"interview", "b-roll"})
        self.assertEqual(lanes["b-roll"]["timelineStartSeconds"], 0.5)  # overlay kept where the model put it

    def test_an_explicit_length_in_the_note_becomes_the_target(self):
        fake = FakeReasoningProvider(responses=[{"summary": "s", "changes": [], "decisions": []}])
        res = pipeline.build_timeline("proj-rc", "story-01", 360, "Create a 30-second rough cut", reasoning_provider=fake)
        self.assertIn("TARGET SECONDS: 30.0", fake.calls[0][1][0].text)
        self.assertEqual(res["targetSeconds"], 30.0)  # the app scales/labels the version by it

    def test_note_length_parsing(self):
        cases = {"Create a 30-second rough cut": 30.0, "a 2-minute cut": 120.0, "45 sec teaser": 45.0,
                 "give it a 70s vibe": None, "the 1990s footage": None, "use 3 clips": None, None: None}
        for note, want in cases.items():
            self.assertEqual(pipeline.target_seconds_from_note(note), want, note)


if __name__ == "__main__":
    unittest.main()
