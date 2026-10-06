"""Real unit tests for the worker — stdlib unittest only (no pytest dependency
required, so `python3 -m unittest discover` works in a bare environment).

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import media  # noqa: E402
import pipeline  # noqa: E402
from pipeline import _validate_decisions  # noqa: E402
from store import STORE, ClipState  # noqa: E402
from tests.fakes import FakeReasoningProvider  # noqa: E402


class TestTimecode(unittest.TestCase):
    def test_round_trip(self):
        for seconds in (0, 1.5, 59.99, 60, 125.25, 3661.0):
            tc = media.seconds_to_tc(seconds, fps=24)
            back = media.tc_to_seconds(tc, fps=24)
            self.assertAlmostEqual(back, seconds, delta=1 / 24 + 0.01)

    def test_rejects_garbage(self):
        self.assertIsNone(media.tc_to_seconds("not a timecode", 24))
        self.assertIsNone(media.tc_to_seconds("", 24))
        self.assertIsNone(media.tc_to_seconds("99:99:99:99", 24))
        self.assertIsNone(media.tc_to_seconds("00:00:00:99", 24))  # frame >= fps


class TestRoleAndSpeaker(unittest.TestCase):
    def test_role_inference(self):
        self.assertEqual(media.role_for_file("A001_INT_MARISOL_01.mov", ".mov"), "interview")
        self.assertEqual(media.role_for_file("B101_BROLL_GARDEN.mov", ".mov"), "b-roll")
        self.assertEqual(media.role_for_file("S201_AMBI_STREET.wav", ".wav"), "ambient")

    def test_speaker_inference(self):
        self.assertEqual(media.speaker_for_file("A001_INT_MARISOL_01.mov"), "Marisol")
        self.assertIsNone(media.speaker_for_file("random_clip_42.mp4"))


class TestValidateDecisions(unittest.TestCase):
    def setUp(self):
        self.clip = ClipState(
            id="clip-001",
            filename="a.mov",
            role="interview",
            duration_seconds=30.0,
            camera="FX6",
            resolution="4K",
            fps=24.0,
        )
        self.clips = {"clip-001": self.clip}

    def test_accepts_valid_decision(self):
        decisions = [
            {
                "clipId": "clip-001",
                "label": "ok",
                "sourceInTc": "00:00:01:00",
                "sourceOutTc": "00:00:05:00",
            }
        ]
        valid, warnings = _validate_decisions(decisions, self.clips)
        self.assertEqual(len(valid), 1)
        self.assertEqual(warnings, [])

    def test_rejects_unknown_clip(self):
        decisions = [{"clipId": "clip-999", "label": "ghost", "sourceInTc": "00:00:00:00", "sourceOutTc": "00:00:01:00"}]
        valid, warnings = _validate_decisions(decisions, self.clips)
        self.assertEqual(valid, [])
        self.assertIn("unknown clipId", warnings[0])

    def test_rejects_out_of_range_timecode(self):
        decisions = [
            {
                "clipId": "clip-001",
                "label": "too long",
                "sourceInTc": "00:00:01:00",
                "sourceOutTc": "00:05:00:00",  # far beyond the 30s clip
            }
        ]
        valid, warnings = _validate_decisions(decisions, self.clips)
        self.assertEqual(valid, [])
        self.assertIn("exceeds clip duration", warnings[0])

    def test_rejects_inverted_in_out(self):
        decisions = [
            {"clipId": "clip-001", "label": "backwards", "sourceInTc": "00:00:10:00", "sourceOutTc": "00:00:05:00"}
        ]
        valid, warnings = _validate_decisions(decisions, self.clips)
        self.assertEqual(valid, [])
        self.assertIn("not after", warnings[0])

    def test_rejects_unparsable_timecode(self):
        decisions = [{"clipId": "clip-001", "label": "bad tc", "sourceInTc": "soon", "sourceOutTc": "later"}]
        valid, warnings = _validate_decisions(decisions, self.clips)
        self.assertEqual(valid, [])
        self.assertIn("unparsable", warnings[0])


class TestBuildTimelineWithInjectedProvider(unittest.TestCase):
    """End-to-end proof that pipeline.build_timeline works against a fake
    ReasoningProvider with zero API keys, zero network access, and no vendor
    SDK involved — the dependency-injection path the model-agnostic
    architecture depends on for testability."""

    def setUp(self):
        STORE.reset()
        STORE.upsert_clip(
            ClipState(
                id="clip-001",
                filename="A001_INT_MARISOL_01.mov",
                role="interview",
                duration_seconds=30.0,
                camera="FX6",
                resolution="4K",
                fps=24.0,
                speakers=["Marisol"],
            )
        )
        STORE.selects = [
            {
                "id": "sel-01",
                "rank": 1,
                "speaker": "Marisol",
                "clipId": "clip-001",
                "clipName": "A001_INT_MARISOL_01.mov",
                "startTc": "00:00:01:00",
                "endTc": "00:00:05:00",
                "durationSeconds": 4.0,
                "score": 90,
                "category": "emotional",
                "transcriptExcerpt": "It changed everything for me.",
                "reasons": [],
                "evidence": [],
            }
        ]
        STORE.stories = [
            {
                "id": "story-01",
                "title": "A Story",
                "premise": "premise",
                "estimatedSeconds": 60,
                "confidence": 0.8,
                "beats": [{"id": "story-1-beat-1", "label": "Open", "intent": "hook", "estimatedSeconds": 60, "selectIds": ["sel-01"]}],
                "supportingSelectIds": ["sel-01"],
            }
        ]

    def test_uses_validated_model_decisions_when_provider_returns_them(self):
        fake = FakeReasoningProvider(
            responses=[
                {
                    "summary": "Real assembly from the fake model.",
                    "changes": ["did a thing"],
                    "decisions": [
                        {
                            "lane": "interview",
                            "clipId": "clip-001",
                            "label": "cold open",
                            "sourceInTc": "00:00:01:00",
                            "sourceOutTc": "00:00:05:00",
                            "timelineStartSeconds": 0,
                            "durationSeconds": 4,
                            "selectId": "sel-01",
                        }
                    ],
                }
            ]
        )
        result = pipeline.build_timeline("proj-1", "story-01", 60, "make it punchy", reasoning_provider=fake)
        self.assertEqual(result["summary"], "Real assembly from the fake model.")
        self.assertEqual(len(result["decisions"]), 1)
        self.assertEqual(result["decisions"][0]["clipId"], "clip-001")
        self.assertEqual(len(fake.calls), 1)

    def test_falls_back_to_deterministic_assembly_when_provider_returns_invalid_decisions(self):
        fake = FakeReasoningProvider(
            responses=[
                {
                    "summary": "hallucinated",
                    "changes": [],
                    "decisions": [
                        {"clipId": "clip-999-does-not-exist", "label": "ghost", "sourceInTc": "00:00:00:00", "sourceOutTc": "00:00:01:00"}
                    ],
                }
            ]
        )
        result = pipeline.build_timeline("proj-1", "story-01", 60, None, reasoning_provider=fake)
        self.assertIn("fallback assembly", result["summary"])
        self.assertEqual(len(result["decisions"]), 1)
        self.assertEqual(result["decisions"][0]["clipId"], "clip-001")

    def test_falls_back_when_provider_raises(self):
        fake = FakeReasoningProvider(fail=True)
        result = pipeline.build_timeline("proj-1", "story-01", 60, None, reasoning_provider=fake)
        self.assertIn("fallback assembly", result["summary"])
        self.assertEqual(len(result["decisions"]), 1)


class TestAnalyzeOneClipSurfacesFfprobeFailure(unittest.TestCase):
    """Reproduces the real bug report: a clip (named after the actual file that
    triggered it) that ffprobe can't read must end up visibly marked as an
    error with a real reason — never silently "ready" with 0:00 and no
    metadata — and must skip thumbnail/proxy/transcription/vision entirely
    rather than waste time on a file we already know is unreadable."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-ffprobe-clip-test-"))
        self.media_root = self.tmp / "footage"
        self.media_root.mkdir()
        STORE.reset()
        STORE.media_root = str(self.media_root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unreadable_clip_is_marked_error_with_a_real_note(self):
        bogus = self.media_root / "18C_0681.MP4"
        bogus.write_bytes(b"not a real video file")
        pipeline._analyze_one_clip("clip-001", bogus, self.tmp / "work", None, None)

        clip = STORE.clips["clip-001"]
        self.assertEqual(clip.state, "error")
        self.assertTrue(clip.note, "a real, non-empty error reason must be recorded")
        self.assertEqual(clip.duration_seconds, 0.0)
        self.assertEqual(clip.resolution, "—")
        # Nothing downstream should have been attempted against an unreadable file.
        self.assertEqual(clip.proxy_rel_path, "")
        self.assertEqual(clip.thumbnail_rel_path, "")
        self.assertFalse(clip.has_transcript)
        self.assertEqual(clip.visual_evidence_count, 0)


if __name__ == "__main__":
    unittest.main()


class TestDurationIsAuthoritativeFromSourceRange(unittest.TestCase):
    """P0 Step 4 regression: the model returns durationSeconds separately from
    sourceInTc/sourceOutTc, and the exporters place an event from the former
    but read media from the latter. A mismatch imported into Premiere as an
    implied speed change (a 20s source range in a 12s slot = 1.66x). The
    validation gate now derives every duration from the source range."""

    def setUp(self):
        self.clip24 = ClipState(
            id="clip-24", filename="a.mov", role="interview", duration_seconds=30.0,
            camera="FX6", resolution="4K", fps=24.0,
        )
        # Real 18C_0681.MP4 metadata: 23.976fps, 32.4s.
        self.clip976 = ClipState(
            id="clip-976", filename="18C_0681.MP4", role="interview", duration_seconds=32.4,
            camera="HEVC", resolution="3840x2160", fps=23.976,
        )
        self.clips = {"clip-24": self.clip24, "clip-976": self.clip976}

    def _one(self, **overrides):
        d = {"lane": "interview", "clipId": "clip-24", "label": "e", "sourceInTc": "00:00:05:00",
             "sourceOutTc": "00:00:25:00", "timelineStartSeconds": 0}
        d.update(overrides)
        return _validate_decisions([d], self.clips)

    def test_mismatched_model_duration_is_replaced_by_the_source_range(self):
        valid, warnings = self._one(durationSeconds=12)
        self.assertEqual(valid[0]["durationSeconds"], 20.0)
        self.assertTrue(any("Corrected 'e'" in w and "12.00s" in w and "20.00s" in w for w in warnings), warnings)

    def test_a_consistent_range_is_normalized_without_noise(self):
        for claimed in (20, 20.0, 20.01):  # within half a frame -> no warning
            valid, warnings = self._one(durationSeconds=claimed)
            self.assertEqual(valid[0]["durationSeconds"], 20.0)
            self.assertEqual(warnings, [], claimed)
        valid, warnings = self._one()  # no claimed duration at all -> derived, silently
        self.assertEqual(valid[0]["durationSeconds"], 20.0)
        self.assertEqual(warnings, [])

    def test_zero_length_range_is_dropped(self):
        valid, warnings = self._one(sourceInTc="00:00:05:00", sourceOutTc="00:00:05:00", durationSeconds=3)
        self.assertEqual(valid, [])
        self.assertIn("not after", warnings[0])

    def test_inverted_range_is_dropped_whatever_duration_the_model_claims(self):
        valid, warnings = self._one(sourceInTc="00:00:10:00", sourceOutTc="00:00:04:00", durationSeconds=6)
        self.assertEqual(valid, [])
        self.assertIn("not after", warnings[0])

    def test_negative_timecodes_are_dropped(self):
        for in_tc, out_tc in (("-00:00:01:00", "00:00:04:00"), ("00:00:01:00", "00:00:-4:00")):
            valid, warnings = self._one(sourceInTc=in_tc, sourceOutTc=out_tc)
            self.assertEqual(valid, [], (in_tc, out_tc))
            self.assertIn("unparsable", warnings[0])

    def test_out_point_beyond_the_source_is_dropped(self):
        valid, warnings = self._one(sourceInTc="00:00:20:00", sourceOutTc="00:00:31:00")  # 30s clip, +1.0s
        self.assertEqual(valid, [])
        self.assertIn("exceeds clip duration", warnings[0])

    def test_in_point_at_or_past_the_end_is_dropped(self):
        valid, warnings = self._one(sourceInTc="00:00:30:00", sourceOutTc="00:00:30:10")
        self.assertEqual(valid, [])
        self.assertIn("past the clip's end", warnings[0])

    def test_tail_rounding_overshoot_is_clamped_to_the_last_real_frame(self):
        # 23.976 clip measured at 32.4s; out point 0.3s past the end (within
        # tolerance) is clamped to the frame-floored end, and duration follows.
        valid, warnings = _validate_decisions(
            [{"lane": "interview", "clipId": "clip-976", "label": "tail", "sourceInTc": "00:00:30:00",
              "sourceOutTc": "00:00:32:17", "timelineStartSeconds": 0, "durationSeconds": 2.7}],
            self.clips,
        )
        self.assertEqual(len(valid), 1, warnings)
        out_s = media.tc_to_seconds(valid[0]["sourceOutTc"], 23.976)
        self.assertLessEqual(out_s, 32.4)
        self.assertEqual(valid[0]["sourceOutTc"], media.seconds_to_tc(32.4, 23.976))
        self.assertAlmostEqual(valid[0]["durationSeconds"], out_s - 30.0, places=6)
        self.assertTrue(any("Trimmed 'tail'" in w for w in warnings), warnings)

    def test_23976_source_timecodes_are_read_at_the_clip_rate_not_24(self):
        # Frame field 12 of a 23.976 clip = 12/23.976s, not 12/24s. Reading it
        # at 24 would reintroduce the clip-rate vs sequence-rate bug (2e59af3).
        valid, warnings = _validate_decisions(
            [{"lane": "interview", "clipId": "clip-976", "label": "ntsc", "sourceInTc": "00:00:05:12",
              "sourceOutTc": "00:00:25:00", "timelineStartSeconds": 0, "durationSeconds": 19.5}],
            self.clips,
        )
        expected = round(25.0 - (5 + 12 / 23.976), 6)
        self.assertEqual(valid[0]["durationSeconds"], expected)
        self.assertNotEqual(valid[0]["durationSeconds"], 19.5)  # what 24fps math would have produced
        self.assertEqual(warnings, [])  # 19.5 is within half a 23.976 frame of 19.4995

    def test_corrected_durations_never_overlap_on_a_lane_and_other_lanes_are_untouched(self):
        valid, warnings = _validate_decisions(
            [
                {"lane": "interview", "clipId": "clip-24", "label": "A", "sourceInTc": "00:00:05:00",
                 "sourceOutTc": "00:00:25:00", "timelineStartSeconds": 0, "durationSeconds": 12},
                {"lane": "b-roll", "clipId": "clip-24", "label": "cover", "sourceInTc": "00:00:01:00",
                 "sourceOutTc": "00:00:04:00", "timelineStartSeconds": 3, "durationSeconds": 3},
                {"lane": "interview", "clipId": "clip-24", "label": "B", "sourceInTc": "00:00:26:00",
                 "sourceOutTc": "00:00:29:00", "timelineStartSeconds": 12, "durationSeconds": 3},
            ],
            self.clips,
        )
        by_label = {d["label"]: d for d in valid}
        self.assertEqual([d["label"] for d in valid], ["A", "cover", "B"])  # input order preserved
        self.assertEqual(by_label["A"]["timelineStartSeconds"], 0.0)
        self.assertEqual(by_label["B"]["timelineStartSeconds"], 20.0)  # pushed past A's real end
        self.assertEqual(by_label["cover"]["timelineStartSeconds"], 3.0)  # b-roll lane unaffected
        self.assertTrue(any("Moved 'B'" in w for w in warnings), warnings)

    def test_missing_or_negative_start_is_placed_after_the_lane_and_gaps_are_kept(self):
        valid, _ = _validate_decisions(
            [
                {"lane": "interview", "clipId": "clip-24", "label": "A", "sourceInTc": "00:00:00:00",
                 "sourceOutTc": "00:00:02:00", "timelineStartSeconds": 10},
                {"lane": "interview", "clipId": "clip-24", "label": "B", "sourceInTc": "00:00:03:00",
                 "sourceOutTc": "00:00:04:00", "timelineStartSeconds": -5},
                {"lane": "interview", "clipId": "clip-24", "label": "C", "sourceInTc": "00:00:05:00",
                 "sourceOutTc": "00:00:06:00"},
            ],
            self.clips,
        )
        starts = {d["label"]: d["timelineStartSeconds"] for d in valid}
        self.assertEqual(starts, {"A": 10.0, "B": 12.0, "C": 13.0})  # model's 0-10s gap kept

    def test_fallback_assembly_is_contiguous_and_frame_exact_from_source_ranges(self):
        STORE.reset()
        STORE.upsert_clip(self.clip976)
        common = {"rank": 1, "speaker": "S", "clipId": "clip-976", "clipName": "18C_0681.MP4", "score": 80,
                  "category": "context", "reasons": [], "evidence": []}
        STORE.selects = [
            # durationSeconds here is the select's 0.1s-rounded value — the
            # fallback must NOT lay the timeline out from it.
            {**common, "id": "sel-01", "startTc": "00:00:01:05", "endTc": "00:00:04:17", "durationSeconds": 3.5,
             "transcriptExcerpt": "one"},
            {**common, "id": "sel-02", "startTc": "00:00:10:00", "endTc": "00:00:12:03", "durationSeconds": 2.1,
             "transcriptExcerpt": "two"},
        ]
        STORE.stories = [{"id": "story-01", "title": "T", "premise": "", "beats": [
            {"id": "b1", "label": "Open", "intent": "", "estimatedSeconds": 6, "selectIds": ["sel-01", "sel-02"]}]}]
        result = pipeline.build_timeline("p", "story-01", 60, None, reasoning_provider=FakeReasoningProvider(fail=True))
        a, b = result["decisions"]
        fps = 23.976
        self.assertEqual(a["durationSeconds"], round((4 + 17 / fps) - (1 + 5 / fps), 6))
        self.assertEqual(b["durationSeconds"], round((12 + 3 / fps) - 10.0, 6))
        self.assertEqual(a["timelineStartSeconds"], 0.0)
        self.assertAlmostEqual(b["timelineStartSeconds"], a["durationSeconds"], places=6)  # no gap, no overlap
