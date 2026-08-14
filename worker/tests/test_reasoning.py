"""Proves the editorial-reasoning layer (worker/reasoning.py) is genuinely
vendor-agnostic: every function here is exercised end-to-end against fake
providers only — no API key, no network, no openai/anthropic import anywhere
in this file or in reasoning.py itself.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import reasoning  # noqa: E402
from providers.base import ProviderError, TextBlock  # noqa: E402
from tests.fakes import FakeReasoningProvider, FakeTranscriptionProvider  # noqa: E402


class TestTranscribeAudio(unittest.TestCase):
    def test_returns_json_shaped_segments(self):
        provider = FakeTranscriptionProvider()
        out = reasoning.transcribe_audio(provider, Path("/tmp/fake.wav"))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "This is a fake transcript segment.")
        self.assertIn("startSeconds", out[0])
        self.assertEqual(provider.calls, [Path("/tmp/fake.wav")])

    def test_propagates_provider_error(self):
        provider = FakeTranscriptionProvider(fail=True)
        with self.assertRaises(ProviderError):
            reasoning.transcribe_audio(provider, Path("/tmp/fake.wav"))


class TestAnalyzeFrames(unittest.TestCase):
    def test_empty_frame_list_short_circuits_without_calling_provider(self):
        provider = FakeReasoningProvider()
        result = reasoning.analyze_frames(provider, [])
        self.assertEqual(result, [])
        self.assertEqual(provider.calls, [])

    def test_parses_valid_json_array(self):
        provider = FakeReasoningProvider(
            responses=[[{"frameIndex": 1, "kind": "face", "label": "Close-up, direct eye contact", "confidence": 0.8}]]
        )
        result = reasoning.analyze_frames(provider, [Path("/tmp/frame1.jpg")])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["kind"], "face")

    def test_non_list_response_yields_empty(self):
        provider = FakeReasoningProvider(responses=[{"not": "a list"}])
        result = reasoning.analyze_frames(provider, [Path("/tmp/frame1.jpg")])
        self.assertEqual(result, [])

    def test_prose_wrapped_json_is_still_extracted(self):
        provider = FakeReasoningProvider(
            responses=["Sure, here you go:\n```json\n[{\"frameIndex\": 1, \"kind\": \"scene\", \"label\": \"Wide shot\", \"confidence\": 0.5}]\n```"]
        )
        result = reasoning.analyze_frames(provider, [Path("/tmp/frame1.jpg")])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["label"], "Wide shot")


class TestRankSelects(unittest.TestCase):
    def test_filters_non_dict_items(self):
        provider = FakeReasoningProvider(responses=[[{"speaker": "Marisol", "score": 90}, "garbage", 42]])
        result = reasoning.rank_selects(provider, "TRANSCRIPT: ...")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["speaker"], "Marisol")


class TestProposeStories(unittest.TestCase):
    def test_returns_parsed_list(self):
        provider = FakeReasoningProvider(responses=[[{"title": "A Story", "beats": []}]])
        result = reasoning.propose_stories(provider, "SELECTS: ...")
        self.assertEqual(result[0]["title"], "A Story")


class TestBuildTimeline(unittest.TestCase):
    def test_returns_dict_on_valid_object_response(self):
        provider = FakeReasoningProvider(
            responses=[{"summary": "ok", "changes": [], "decisions": []}]
        )
        result = reasoning.build_timeline(provider, "STORY: ...")
        self.assertIsInstance(result, dict)
        self.assertEqual(result["summary"], "ok")

    def test_returns_none_on_unparsable_response(self):
        provider = FakeReasoningProvider(responses=["not json at all, sorry"])
        result = reasoning.build_timeline(provider, "STORY: ...")
        self.assertIsNone(result)

    def test_sends_the_brief_as_a_text_block(self):
        provider = FakeReasoningProvider(responses=[{"summary": "", "changes": [], "decisions": []}])
        reasoning.build_timeline(provider, "STORY: the brief text")
        system, content, _max_tokens = provider.calls[0]
        self.assertIn("assembling a rough-cut timeline", system.lower())
        self.assertEqual(content, [TextBlock("STORY: the brief text")])


if __name__ == "__main__":
    unittest.main()
