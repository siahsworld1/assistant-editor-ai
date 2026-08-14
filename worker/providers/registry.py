"""Environment-driven provider selection. This is the one place in the codebase
that knows which vendor implements which capability — worker/reasoning.py and
worker/pipeline.py never import a provider module directly, only this registry
(and, for tests, worker/tests/fakes.py's fake providers, injected directly rather
than through here).

Adding a new vendor means: write a class in providers/<vendor>.py implementing
TranscriptionProvider and/or ReasoningProvider, add one line to
_register_defaults() below, and it's selectable via an env var. Nothing else in
the app changes.
"""

from __future__ import annotations

import os

from .base import ProviderError, ReasoningProvider, TranscriptionProvider

TRANSCRIPTION_PROVIDER_ENV = "ASSISTANT_EDITOR_TRANSCRIPTION_PROVIDER"
REASONING_PROVIDER_ENV = "ASSISTANT_EDITOR_REASONING_PROVIDER"

DEFAULT_TRANSCRIPTION_PROVIDER = "openai"
DEFAULT_REASONING_PROVIDER = "anthropic"

_TRANSCRIPTION_FACTORIES: dict = {}
_REASONING_FACTORIES: dict = {}


def _register_defaults():
    if _TRANSCRIPTION_FACTORIES and _REASONING_FACTORIES:
        return
    # Imported lazily (not at module top level) so that importing this registry
    # never requires the openai/anthropic SDKs to be installed — only actually
    # instantiating a provider does.
    from .anthropic_provider import AnthropicReasoningProvider
    from .openai_provider import OpenAIReasoningProvider, OpenAIWhisperTranscriptionProvider

    _TRANSCRIPTION_FACTORIES["openai"] = OpenAIWhisperTranscriptionProvider
    _REASONING_FACTORIES["anthropic"] = AnthropicReasoningProvider
    _REASONING_FACTORIES["openai"] = OpenAIReasoningProvider


def get_transcription_provider() -> TranscriptionProvider:
    """Raises ProviderError if the selected provider is unknown, or if it can't
    run (e.g. missing API key) — the same exception type either way, so callers
    have one thing to catch."""
    _register_defaults()
    key = os.environ.get(TRANSCRIPTION_PROVIDER_ENV, DEFAULT_TRANSCRIPTION_PROVIDER).strip().lower()
    factory = _TRANSCRIPTION_FACTORIES.get(key)
    if not factory:
        raise ProviderError(
            f"Unknown transcription provider '{key}' ({TRANSCRIPTION_PROVIDER_ENV}). "
            f"Available: {', '.join(sorted(_TRANSCRIPTION_FACTORIES))}."
        )
    return factory()


def get_reasoning_provider() -> ReasoningProvider:
    """Raises ProviderError if the selected provider is unknown, or if it can't
    run (e.g. missing API key)."""
    _register_defaults()
    key = os.environ.get(REASONING_PROVIDER_ENV, DEFAULT_REASONING_PROVIDER).strip().lower()
    factory = _REASONING_FACTORIES.get(key)
    if not factory:
        raise ProviderError(
            f"Unknown reasoning provider '{key}' ({REASONING_PROVIDER_ENV}). "
            f"Available: {', '.join(sorted(_REASONING_FACTORIES))}."
        )
    return factory()
