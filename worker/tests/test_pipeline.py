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
from pipeline import _validate_decisions  # noqa: E402
from store import ClipState  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
