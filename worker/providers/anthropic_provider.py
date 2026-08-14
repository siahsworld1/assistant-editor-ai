"""Anthropic-backed reasoning provider (Claude): vision + editorial reasoning.

This is the default ReasoningProvider (ASSISTANT_EDITOR_REASONING_PROVIDER
defaults to "anthropic" in providers/registry.py), but it is not privileged in
the code — it implements exactly the same ReasoningProvider interface as
providers/openai_provider.py's OpenAIReasoningProvider, and worker/reasoning.py
cannot tell which one it's talking to.

The `anthropic` SDK is imported lazily, inside `_client()`, so this module stays
importable without the package installed.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from .base import ContentBlock, ImageBlock, ProviderError, ReasoningProvider, TextBlock

ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"


def _client():
    api_key = os.environ.get(ANTHROPIC_API_KEY_ENV, "")
    if not api_key:
        raise ProviderError(f"{ANTHROPIC_API_KEY_ENV} is not set.")
    import anthropic  # lazy: keep this module importable without the SDK installed

    return anthropic.Anthropic(api_key=api_key)


class AnthropicReasoningProvider(ReasoningProvider):
    name = "anthropic-claude"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("ASSISTANT_EDITOR_CLAUDE_MODEL", "claude-sonnet-4-5")

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
                        "type": "image",
                        "source": {"type": "base64", "media_type": block.media_type, "data": data},
                    }
                )
        resp = client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user_content}],
        )
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
