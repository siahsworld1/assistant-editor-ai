"""Provider interfaces for Assistant Editor AI's model-agnostic orchestration layer.

Nothing in worker/reasoning.py (the editorial-reasoning architecture — prompts,
selects/stories/timeline logic) or worker/pipeline.py (footage-analysis
orchestration) should import a vendor SDK directly. They talk only to these
interfaces. Swapping Claude for GPT-4o, or Whisper for a future local ASR model,
means writing a new provider module and registering it in providers/registry.py —
nothing else changes. This is deliberate: the proprietary value of this app is
the footage-analysis pipeline, the editorial-reasoning prompts/logic, the Edit
Decision validation, and the timeline/export engine — not a dependency on any
one AI vendor.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Union


class ProviderError(RuntimeError):
    """Raised when a provider can't run — missing API key, unsupported call, a
    hard vendor-side failure, etc. Callers treat this as "degrade, don't crash":
    the pipeline already has fallback behavior for absent AI results (see
    worker/pipeline.py's per-clip and per-stage try/except around every call)."""


@dataclass(frozen=True)
class TextBlock:
    """Plain text content sent to a reasoning provider."""

    text: str


@dataclass(frozen=True)
class ImageBlock:
    """A single still image, identified by path. Each provider implementation
    reads the file and encodes it however its vendor's wire format requires —
    worker/reasoning.py never encodes an image itself, so it never needs to know
    whether the destination model wants base64 JSON, a data: URL, or something
    else entirely."""

    path: Path
    media_type: str = "image/jpeg"


ContentBlock = Union[TextBlock, ImageBlock]


@dataclass(frozen=True)
class TranscriptSegment:
    start_seconds: float
    end_seconds: float
    text: str
    confidence: float

    def to_json(self) -> dict:
        return {
            "startSeconds": self.start_seconds,
            "endSeconds": self.end_seconds,
            "text": self.text,
            "confidence": self.confidence,
        }


class TranscriptionProvider(ABC):
    """Speech-to-text. Only implemented today by OpenAI Whisper — no other
    vendor in this stack ships a comparable product — but the interface exists
    precisely so that can change (a local Whisper model, a different vendor's
    ASR) without touching worker/reasoning.py or worker/pipeline.py."""

    name: str = "unknown"

    @abstractmethod
    def transcribe(self, audio_path: Path) -> list[TranscriptSegment]:
        """Raises ProviderError if the provider can't run (e.g. missing API key)."""
        raise NotImplementedError


class ReasoningProvider(ABC):
    """Text + vision reasoning: describing frames, ranking selects, proposing
    stories, assembling a timeline. Every editorial *prompt* lives in
    worker/reasoning.py, not here — this interface only knows how to send a
    system prompt plus content blocks to one specific vendor's model and return
    the raw text response. That split is what makes the reasoning architecture
    itself (the proprietary part) independent of which vendor answers it."""

    name: str = "unknown"
    supports_vision: bool = True

    @abstractmethod
    def complete(self, system: str, content: list[ContentBlock], max_tokens: int = 4096) -> str:
        """Raises ProviderError if the provider can't run (e.g. missing API key)."""
        raise NotImplementedError
