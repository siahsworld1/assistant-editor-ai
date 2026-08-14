"""Real unit tests for the worker — stdlib unittest only (no pytest dependency
required, so `python3 -m unittest discover` works in a bare environment).

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

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


if __name__ == "__main__":
    unittest.main()
