"""Tests for the provider registry and the provider implementations' own
config-error handling. Deliberately does NOT require the openai/anthropic SDKs
to be installed: constructing a provider never imports the vendor SDK (only
actually calling .transcribe()/.complete() does, and this environment has no
API keys set, so those calls fail on the missing-key check before ever
reaching an SDK import — proving the lazy-import pattern holds).

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from providers.base import ProviderError  # noqa: E402
from providers.registry import (  # noqa: E402
    REASONING_PROVIDER_ENV,
    TRANSCRIPTION_PROVIDER_ENV,
    get_reasoning_provider,
    get_transcription_provider,
)


class TestRegistrySelection(unittest.TestCase):
    def setUp(self):
        self._saved = {
            k: os.environ.get(k) for k in (TRANSCRIPTION_PROVIDER_ENV, REASONING_PROVIDER_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY")
        }
        for k in (TRANSCRIPTION_PROVIDER_ENV, REASONING_PROVIDER_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_defaults_to_openai_transcription_and_anthropic_reasoning(self):
        self.assertEqual(get_transcription_provider().name, "openai-whisper")
        self.assertEqual(get_reasoning_provider().name, "anthropic-claude")

    def test_reasoning_provider_is_swappable_via_env_var(self):
        os.environ[REASONING_PROVIDER_ENV] = "openai"
        self.assertEqual(get_reasoning_provider().name, "openai-gpt4o")

    def test_unknown_transcription_provider_raises(self):
        os.environ[TRANSCRIPTION_PROVIDER_ENV] = "not-a-real-vendor"
        with self.assertRaises(ProviderError):
            get_transcription_provider()

    def test_unknown_reasoning_provider_raises(self):
        os.environ[REASONING_PROVIDER_ENV] = "not-a-real-vendor"
        with self.assertRaises(ProviderError):
            get_reasoning_provider()

    def test_missing_api_key_raises_before_touching_the_sdk(self):
        # No OPENAI_API_KEY/ANTHROPIC_API_KEY set (cleared in setUp) and neither
        # SDK is installed in this environment — if construction or the error
        # path accidentally imported the SDK, this would raise ModuleNotFoundError
        # instead of ProviderError.
        provider = get_transcription_provider()
        with self.assertRaises(ProviderError):
            provider.transcribe(Path("/tmp/does-not-matter.wav"))

        reasoning_provider = get_reasoning_provider()
        with self.assertRaises(ProviderError):
            reasoning_provider.complete("system", [])


if __name__ == "__main__":
    unittest.main()
