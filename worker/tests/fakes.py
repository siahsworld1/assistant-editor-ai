"""Fake TranscriptionProvider / ReasoningProvider implementations.

These exist to prove the provider abstraction is real: worker/pipeline.py and
worker/reasoning.py can run their full logic against these fakes with no API
key, no network access, and no vendor SDK installed — which is exactly the
constraint this test sandbox runs under. If pipeline.py or reasoning.py ever
grew a hidden import of `openai`/`anthropic`, or a hardcoded vendor branch,
tests using these fakes would either fail to run or fail to exercise the real
code path — that's the point of building them as full interface
implementations rather than mocking individual functions.
"""

from __future__ import annotations

import json
from pathlib import Path

from providers.base import (
    ContentBlock,
    ProviderError,
    ReasoningProvider,
    TranscriptionProvider,
    TranscriptSegment,
)


class FakeTranscriptionProvider(TranscriptionProvider):
    """Returns canned segments regardless of input. Set `segments` to control
    what a test sees; set `fail=True` to simulate a provider-side failure."""

    name = "fake-transcription"

    def __init__(self, segments: list[TranscriptSegment] | None = None, fail: bool = False):
        self.segments = segments if segments is not None else [
            TranscriptSegment(0.0, 2.5, "This is a fake transcript segment.", 0.9),
        ]
        self.fail = fail
        self.calls: list[Path] = []

    def transcribe(self, audio_path: Path) -> list[TranscriptSegment]:
        self.calls.append(audio_path)
        if self.fail:
            raise ProviderError("FakeTranscriptionProvider configured to fail.")
        return list(self.segments)


class FakeReasoningProvider(ReasoningProvider):
    """Returns a fixed JSON response (encoded as text, same as a real model reply
    would be) regardless of the system prompt or content — or a list of
    responses consumed in order across successive calls, so a test can script
    different answers for the visual-analysis call vs. the selects call vs. the
    build call within one pipeline run."""

    name = "fake-reasoning"

    def __init__(self, responses: list[object] | object = None, fail: bool = False):
        if responses is None:
            responses = []
        self._responses = responses if isinstance(responses, list) else [responses]
        self._idx = 0
        self.fail = fail
        self.calls: list[tuple[str, list[ContentBlock], int]] = []

    def complete(self, system: str, content: list[ContentBlock], max_tokens: int = 4096) -> str:
        self.calls.append((system, content, max_tokens))
        if self.fail:
            raise ProviderError("FakeReasoningProvider configured to fail.")
        if not self._responses:
            return "[]"
        value = self._responses[min(self._idx, len(self._responses) - 1)]
        self._idx += 1
        return value if isinstance(value, str) else json.dumps(value)
