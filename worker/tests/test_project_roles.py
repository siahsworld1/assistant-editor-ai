"""Phase 7, Milestone 3 — the project JSON carries each clip's deterministic
dialogue assessment (worker/dialogue.py) so the app can decide media roles.
Local only: no provider, no AI call, the transcript is never rewritten."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

from store import ClipState, ProjectStore  # noqa: E402


def clip(cid: str, **kw) -> ClipState:
    return ClipState(id=cid, filename=f"{cid}.MP4", rel_path=f"{cid}.MP4", role="interview",
                     duration_seconds=10.0, camera="HEVC", resolution="3840x2160", fps=24.0,
                     state="analyzed", has_transcript=kw.pop("has_transcript", True), **kw)


class TestProjectDialogue(unittest.TestCase):
    def test_every_clip_carries_its_dialogue_status_and_reasons(self):
        s = ProjectStore()
        s.upsert_clip(clip("talk"))
        s.upsert_clip(clip("silent", has_transcript=False))
        s.transcript = [
            {"id": "t1", "clipId": "talk", "speaker": "A", "startTc": "00:00:01:00",
             "endTc": "00:00:03:00", "text": "We built this park together.", "confidence": 0.9},
        ]
        before = [dict(t) for t in s.transcript]
        clips = {c["id"]: c for c in s.project_json()["clips"]}
        self.assertEqual(clips["talk"]["dialogue"]["status"], "dialogue")
        self.assertEqual(clips["silent"]["dialogue"]["status"], "non-dialogue")
        for c in clips.values():
            self.assertIsInstance(c["dialogue"]["reasons"], list)
        self.assertEqual(s.transcript, before)  # never rewritten


if __name__ == "__main__":
    unittest.main()
