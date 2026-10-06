"""Offline contract tests for the vendor SDKs the worker actually ships
(worker/requirements.lock): the real `openai` / `anthropic` client code builds
and sends each request the providers make, and parses each response, against an
in-process httpx.MockTransport. No network, no real key, no cost — but a
version bump that changes a request shape, a response model or an error type
fails here instead of on a user's footage.

Run from worker/: `.venv/bin/python -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import httpx  # noqa: E402

from providers import anthropic_provider, openai_provider  # noqa: E402
from providers.base import ImageBlock, TextBlock  # noqa: E402

FAKE_KEY = "test-key-not-a-real-credential"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes\xff\xd9"


class _Recorder:
    def __init__(self, respond):
        self.requests: list[httpx.Request] = []
        self.respond = respond

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)


def _openai(recorder, **kw):
    import openai

    return openai.OpenAI(api_key=FAKE_KEY, max_retries=0,
                         http_client=httpx.Client(transport=httpx.MockTransport(recorder)), **kw)


def _anthropic(recorder, **kw):
    import anthropic

    return anthropic.Anthropic(api_key=FAKE_KEY, max_retries=0,
                               http_client=httpx.Client(transport=httpx.MockTransport(recorder)), **kw)


class _Files(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-sdk-contract-"))
        self.wav = self.tmp / "a.wav"
        self.wav.write_bytes(b"RIFF....WAVEfmt fake")
        self.jpg = self.tmp / "f.jpg"
        self.jpg.write_bytes(JPEG)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)


class TestOpenAITranscription(_Files):
    def test_whisper_request_and_segment_parsing(self):
        rec = _Recorder(lambda r: httpx.Response(200, json={
            "text": "Hello there. Second line.", "language": "english", "duration": 4.0,
            "segments": [
                {"id": 0, "seek": 0, "start": 0.0, "end": 1.5, "text": " Hello there.", "avg_logprob": -0.2,
                 "tokens": [], "temperature": 0.0, "compression_ratio": 1.0, "no_speech_prob": 0.0},
                {"id": 1, "seek": 0, "start": 1.5, "end": 4.0, "text": " Second line.", "avg_logprob": -1.0,
                 "tokens": [], "temperature": 0.0, "compression_ratio": 1.0, "no_speech_prob": 0.0},
            ],
        }))
        with patch.object(openai_provider, "_client", return_value=_openai(rec)):
            segs = openai_provider.OpenAIWhisperTranscriptionProvider().transcribe(self.wav)
        req = rec.requests[0]
        self.assertEqual((req.method, req.url.path), ("POST", "/v1/audio/transcriptions"))
        self.assertEqual(req.headers["authorization"], f"Bearer {FAKE_KEY}")
        body = req.read()
        for part in (b'name="model"', b"whisper-1", b"verbose_json", b"segment", b'name="file"'):
            self.assertIn(part, body)
        self.assertEqual([(s.start_seconds, s.end_seconds, s.text) for s in segs],
                         [(0.0, 1.5, "Hello there."), (1.5, 4.0, "Second line.")])
        self.assertEqual([s.confidence for s in segs], [0.9, 0.5])

    def test_text_only_response_still_yields_a_segment(self):
        rec = _Recorder(lambda r: httpx.Response(200, json={"text": "Only text.", "segments": []}))
        with patch.object(openai_provider, "_client", return_value=_openai(rec)):
            segs = openai_provider.OpenAIWhisperTranscriptionProvider().transcribe(self.wav)
        self.assertEqual([s.text for s in segs], ["Only text."])


class TestOpenAIReasoning(_Files):
    def test_chat_completion_with_image(self):
        rec = _Recorder(lambda r: httpx.Response(200, json={
            "id": "c1", "object": "chat.completion", "created": 0, "model": "gpt-4o",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": '{"ok": true}'}}],
        }))
        with patch.object(openai_provider, "_client", return_value=_openai(rec)):
            out = openai_provider.OpenAIReasoningProvider(model="gpt-4o").complete(
                "SYSTEM", [TextBlock("describe"), ImageBlock(self.jpg)], max_tokens=123)
        self.assertEqual(out, '{"ok": true}')
        body = json.loads(rec.requests[0].read())
        self.assertEqual(rec.requests[0].url.path, "/v1/chat/completions")
        self.assertEqual((body["model"], body["max_tokens"]), ("gpt-4o", 123))
        self.assertEqual(body["messages"][0], {"role": "system", "content": "SYSTEM"})
        parts = body["messages"][1]["content"]
        self.assertEqual(parts[0], {"type": "text", "text": "describe"})
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))


class TestAnthropicReasoning(_Files):
    def test_messages_request_with_image_and_text_blocks(self):
        rec = _Recorder(lambda r: httpx.Response(200, json={
            "id": "m1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "part one "}, {"type": "text", "text": "part two"}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }))
        with patch.object(anthropic_provider, "_client", return_value=_anthropic(rec)):
            out = anthropic_provider.AnthropicReasoningProvider(model="claude-sonnet-4-5").complete(
                "SYSTEM", [ImageBlock(self.jpg), TextBlock("which frames?")], max_tokens=77)
        self.assertEqual(out, "part one part two")
        req = rec.requests[0]
        self.assertEqual((req.method, req.url.path), ("POST", "/v1/messages"))
        self.assertEqual(req.headers["x-api-key"], FAKE_KEY)
        self.assertIn("anthropic-version", req.headers)
        body = json.loads(req.read())
        self.assertEqual((body["model"], body["max_tokens"], body["system"]), ("claude-sonnet-4-5", 77, "SYSTEM"))
        image, text = body["messages"][0]["content"]
        self.assertEqual(image["source"]["type"], "base64")
        self.assertEqual(image["source"]["media_type"], "image/jpeg")
        self.assertEqual(text, {"type": "text", "text": "which frames?"})


class TestErrorsSurfaceAsSdkErrors(_Files):
    """Timeouts, connection failures and HTTP errors must raise (the pipeline
    records them per stage) — never return an empty or fake result."""

    def _raise(self, exc):
        def handler(request):
            raise exc
        return _Recorder(handler)

    def test_openai_timeout_connection_and_status_errors(self):
        import openai

        cases = [
            (self._raise(httpx.ReadTimeout("slow")), openai.APITimeoutError),
            (self._raise(httpx.ConnectError("down")), openai.APIConnectionError),
            (_Recorder(lambda r: httpx.Response(429, json={"error": {"message": "slow down"}})), openai.RateLimitError),
            (_Recorder(lambda r: httpx.Response(401, json={"error": {"message": "bad key"}})), openai.AuthenticationError),
        ]
        for rec, error in cases:
            with self.subTest(error=error.__name__), patch.object(openai_provider, "_client", return_value=_openai(rec)):
                with self.assertRaises(error):
                    openai_provider.OpenAIWhisperTranscriptionProvider().transcribe(self.wav)

    def test_anthropic_timeout_connection_and_status_errors(self):
        import anthropic

        cases = [
            (self._raise(httpx.ReadTimeout("slow")), anthropic.APITimeoutError),
            (self._raise(httpx.ConnectError("down")), anthropic.APIConnectionError),
            (_Recorder(lambda r: httpx.Response(529, json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}})), anthropic.APIStatusError),
            (_Recorder(lambda r: httpx.Response(401, json={"type": "error", "error": {"type": "authentication_error", "message": "bad"}})), anthropic.AuthenticationError),
        ]
        for rec, error in cases:
            with self.subTest(error=error.__name__), patch.object(anthropic_provider, "_client", return_value=_anthropic(rec)):
                with self.assertRaises(error):
                    anthropic_provider.AnthropicReasoningProvider().complete("S", [TextBlock("x")])

    def test_the_real_clients_keep_the_sdk_retry_and_timeout_defaults(self):
        # providers/*._client() build plain SDK clients: the SDKs' own retries
        # (2) and timeouts (10 min) apply — pinned so an SDK bump that changes
        # them is noticed.
        with patch.dict("os.environ", {"OPENAI_API_KEY": FAKE_KEY, "ANTHROPIC_API_KEY": FAKE_KEY}):
            oc, ac = openai_provider._client(), anthropic_provider._client()
        self.assertEqual((oc.max_retries, ac.max_retries), (2, 2))
        self.assertEqual(oc.timeout.read, 600.0)
        self.assertEqual(ac.timeout.read, 600.0)


if __name__ == "__main__":
    unittest.main()
