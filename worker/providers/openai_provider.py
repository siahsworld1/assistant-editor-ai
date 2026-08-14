"""OpenAI-backed providers.

`OpenAIWhisperTranscriptionProvider` is the only transcription provider today —
Anthropic has no ASR product, so this one is load-bearing, not just an example.

`OpenAIReasoningProvider` (GPT-4o) is a second, independent implementation of
ReasoningProvider, alongside providers/anthropic_provider.py's Claude
implementation. It exists specifically to prove the reasoning side is genuinely
vendor-swappable — not an interface with exactly one implementation behind it.

The `openai` SDK is imported lazily, inside `_client()`, so the rest of the
worker (including this module's class *definitions*) stays importable in
environments where the package isn't installed (e.g. this repo's test/dev
sandbox, which has no network access to PyPI).
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from .base import (
    ContentBlock,
    ImageBlock,
    ProviderError,
    ReasoningProvider,
    TextBlock,
    TranscriptionProvider,
    TranscriptSegment,
)

OPENAI_API_KEY_ENV = "OPENAI_API_KEY"


def _client():
    api_key = os.environ.get(OPENAI_API_KEY_ENV, "")
    if not api_key:
        raise ProviderError(f"{OPENAI_API_KEY_ENV} is not set.")
    from openai import OpenAI  # lazy: keep this module importable without the SDK installed

    return OpenAI(api_key=api_key)


class OpenAIWhisperTranscriptionProvider(TranscriptionProvider):
    name = "openai-whisper"

    def __init__(self, model: str = "whisper-1"):
        self.model = model

    def transcribe(self, audio_path: Path) -> list[TranscriptSegment]:
        client = _client()
        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model=self.model,
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )
        segments = getattr(resp, "segments", None) or []
        out: list[TranscriptSegment] = []
        for seg in segments:
            seg_dict = seg if isinstance(seg, dict) else seg.model_dump()
            # Whisper doesn't return a per-segment confidence; avg_logprob is the
            # closest signal it does expose, converted into an approximate 0..1 score.
            avg_logprob = seg_dict.get("avg_logprob", -0.2)
            confidence = max(0.0, min(1.0, 1.0 + (avg_logprob / 2.0)))
            out.append(
                TranscriptSegment(
                    start_seconds=float(seg_dict.get("start", 0.0)),
                    end_seconds=float(seg_dict.get("end", 0.0)),
                    text=str(seg_dict.get("text", "")).strip(),
                    confidence=round(confidence, 2),
                )
            )
        if not out:
            text = getattr(resp, "text", "") or ""
            if text.strip():
                out.append(TranscriptSegment(0.0, 0.0, text.strip(), 0.7))
        return out


class OpenAIReasoningProvider(ReasoningProvider):
    """GPT-4o via the Chat Completions API. A second, real implementation of
    ReasoningProvider — set ASSISTANT_EDITOR_REASONING_PROVIDER=openai to use
    this instead of Claude for vision/selects/stories/build, with no other code
    change anywhere in the app."""

    name = "openai-gpt4o"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("ASSISTANT_EDITOR_OPENAI_MODEL", "gpt-4o")

    def complete(self, system: str, content: list[ContentBlock], max_tokens: int = 4096) -> str:
        client = _client()
        user_content = []
        for block in content:
            if isinstance(block, TextBlock):
                user_content.append({"type": "text", "text": block.text})
            elif isinstance(block, ImageBlock):
                data = base64.standard_b64encode(block.path.read_bytes()).decode("ascii")
                user_content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{block.media_type};base64,{data}"},
                    }
                )
        resp = client.chat.completions.create(
            model=self.model,
            max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
        )
        return resp.choices[0].message.content or ""
