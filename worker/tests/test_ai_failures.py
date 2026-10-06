"""Release Step 4C, FIX 1 — AI/provider failures are surfaced, not silent.

The packaged-app validation reproduced it: with the network down or a provider
failing, the worker only logged the failure, still marked every clip
"analyzed", and the Director then said "run Analyze first". These tests rerun
those exact failures through the REAL OpenAI and Anthropic SDK code
(providers/*_provider.py) against loopback endpoints — an unreachable port, and
a local stub answering HTTP 500 or 401 — with fake keys only, and check the
structured state the app reads (GET /project, POST /build), the selective
retry, and that nothing sensitive leaks.

Run from worker/: `.venv/bin/python -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import ai_status  # noqa: E402
import persistence  # noqa: E402
import pipeline  # noqa: E402
from providers import anthropic_provider, openai_provider  # noqa: E402
from store import STORE  # noqa: E402
from tests.fakes import FakeReasoningProvider, FakeTranscriptionProvider  # noqa: E402

FAKE_KEY = "test-key-not-a-real-credential"


def _ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_clip(dest: Path) -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(dest)],
            capture_output=True, timeout=60, check=True,
        )
        return dest.exists()
    except (subprocess.SubprocessError, OSError):
        return False


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Stub:
    """Loopback HTTP server that answers every request with one status."""

    def __init__(self, status: int):
        status_code = status

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("content-length") or 0))
                body = json.dumps({"type": "error", "error": {"type": "stub", "message": "SECRET-PAYLOAD-DETAIL"}}).encode()
                self.send_response(status_code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _real_sdk_clients(base_url: str):
    """Patches the providers' _client() to the real SDK clients pointed at
    base_url (retries off so the tests stay fast)."""
    import anthropic
    import openai

    return (
        patch.object(openai_provider, "_client", lambda: openai.OpenAI(api_key=FAKE_KEY, base_url=f"{base_url}/v1", max_retries=0, timeout=5)),
        patch.object(anthropic_provider, "_client", lambda: anthropic.Anthropic(api_key=FAKE_KEY, base_url=base_url, max_retries=0, timeout=5)),
    )


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class _FolderCase(unittest.TestCase):
    def setUp(self):
        STORE.reset()
        self.root = Path(tempfile.mkdtemp(prefix="ae-ai-fail-"))
        if not _make_clip(self.root / "A001_INT_TEST.mov"):
            self.skipTest("Could not synthesize a test clip with this ffmpeg build.")
        os.environ[persistence.PERSIST_ENV] = "0"
        self.logs: list[str] = []
        handler = logging.Handler()
        handler.emit = lambda record: self.logs.append(record.getMessage())
        logging.getLogger("assistant-editor-worker").addHandler(handler)
        self.addCleanup(logging.getLogger("assistant-editor-worker").removeHandler, handler)

    def tearDown(self):
        os.environ.pop(persistence.PERSIST_ENV, None)
        STORE.reset()
        shutil.rmtree(self.root, ignore_errors=True)

    def analyze_with_real_providers(self, base_url: str) -> dict:
        p1, p2 = _real_sdk_clients(base_url)
        with p1, p2, patch.object(pipeline, "_resolve_transcription_provider", lambda: openai_provider.OpenAIWhisperTranscriptionProvider()), \
                patch.object(pipeline, "_resolve_reasoning_provider", lambda: anthropic_provider.AnthropicReasoningProvider()):
            pipeline.run_analysis("p", str(self.root))
        return STORE.project_json()

    def assert_nothing_sensitive(self, *payloads):
        text = json.dumps(payloads) + "\n".join(self.logs)
        self.assertNotIn(FAKE_KEY, text)
        self.assertNotIn("SECRET-PAYLOAD-DETAIL", text)
        self.assertNotRegex(text, r"(?i)authorization|x-api-key|bearer")


class TestReproducedFailures(_FolderCase):
    def check_failed(self, project: dict, category: str, http: int | None):
        clip = project["clips"][0]
        # Local processing kept…
        self.assertEqual(clip["state"], "analyzed")
        self.assertTrue(clip["proxyRelPath"] and (self.root / clip["proxyRelPath"]).is_file())
        self.assertTrue(clip["thumbnailRelPath"] and (self.root / clip["thumbnailRelPath"]).is_file())
        # …but AI is not reported as analyzed.
        self.assertFalse(clip["hasTranscript"])
        self.assertEqual(clip["aiStatus"], "failed")
        for task, provider in (("transcription", "OpenAI"), ("visual-analysis", "Anthropic")):
            entry = clip["ai"][task]
            self.assertEqual((entry["status"], entry["provider"], entry["category"]), ("failed", provider, category))
            self.assertEqual(entry["httpStatus"], http)
        self.assertEqual(project["analysisState"], "complete")
        self.assertEqual(project["analysisOutcome"], "failed")
        self.assertEqual([i["task"] for i in project["aiIssues"]], ["transcription", "visual-analysis"])
        self.assertTrue(project["analysisMessage"].startswith("AI analysis failed — transcription "))
        self.assertEqual(project["aiTasks"]["selects"]["status"], "not-applicable")

    def test_unreachable_endpoint(self):
        project = self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        self.check_failed(project, "network", None)
        self.assertEqual(project["analysisMessage"], "AI analysis failed — transcription couldn't connect to OpenAI.")
        self.assertTrue(project["aiIssues"][0]["retryable"])
        self.assert_nothing_sensitive(project)

    def test_http_500(self):
        stub = _Stub(500)
        self.addCleanup(stub.close)
        project = self.analyze_with_real_providers(stub.url)
        self.check_failed(project, "provider-error", 500)
        self.assertIn("got a provider error from Anthropic (HTTP 500)", project["aiIssues"][1]["message"])
        self.assertTrue(project["aiIssues"][0]["retryable"])
        self.assert_nothing_sensitive(project)

    def test_http_401(self):
        stub = _Stub(401)
        self.addCleanup(stub.close)
        project = self.analyze_with_real_providers(stub.url)
        self.check_failed(project, "auth", 401)
        self.assertIn("check the API key in Settings", project["analysisMessage"])
        self.assertFalse(project["aiIssues"][0]["retryable"])
        self.assert_nothing_sensitive(project)


class TestPartialAnalysisAndRetry(_FolderCase):
    def test_one_task_failing_keeps_the_other_and_reports_partial(self):
        stub = _Stub(500)
        self.addCleanup(stub.close)
        p1, p2 = _real_sdk_clients(stub.url)
        with p1, p2, patch.object(pipeline, "_resolve_transcription_provider", lambda: FakeTranscriptionProvider()), \
                patch.object(pipeline, "_resolve_reasoning_provider", lambda: anthropic_provider.AnthropicReasoningProvider()):
            pipeline.run_analysis("p", str(self.root))
        project = STORE.project_json()
        clip = project["clips"][0]
        self.assertEqual(clip["ai"]["transcription"]["status"], "succeeded")
        self.assertTrue(clip["hasTranscript"])
        self.assertEqual(clip["ai"]["visual-analysis"]["status"], "failed")
        self.assertEqual(clip["aiStatus"], "partial")
        self.assertEqual(project["analysisOutcome"], "partial")
        self.assertTrue(project["analysisMessage"].startswith("AI analysis incomplete — visual analysis got a provider error"))

    def test_retry_reruns_only_the_failed_steps_and_keeps_everything_else(self):
        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        clip = next(iter(STORE.clips.values()))
        analysis_id = STORE.analysis_id
        proxy, thumb = self.root / clip.proxy_rel_path, self.root / clip.thumbnail_rel_path
        mtimes = (proxy.stat().st_mtime_ns, thumb.stat().st_mtime_ns)
        self.assertEqual(sorted(t for _, t in pipeline.failed_ai_steps()), ["transcription", "visual-analysis"])

        transcriber = FakeTranscriptionProvider()
        reasoner = FakeReasoningProvider([  # visual analysis, then selects, then stories
            [{"frameIndex": 1, "kind": "scene", "label": "Test pattern", "confidence": 0.9}],
            [{"clipId": clip.id, "startSeconds": 0, "endSeconds": 1.5, "score": 80, "speaker": "S",
              "transcriptExcerpt": "This is a fake transcript segment."}],
            [{"title": "T", "premise": "P", "beats": [{"label": "B", "selectIds": ["sel-01"]}]}],
        ])
        with patch.object(pipeline, "_resolve_transcription_provider", lambda: transcriber), \
                patch.object(pipeline, "_resolve_reasoning_provider", lambda: reasoner), \
                patch("media.generate_proxy", side_effect=AssertionError("proxy regenerated")), \
                patch("media.generate_thumbnail", side_effect=AssertionError("thumbnail regenerated")):
            pipeline.retry_failed_ai()

        project = STORE.project_json()
        self.assertEqual(project["analysisOutcome"], "succeeded")
        self.assertIsNone(project["analysisMessage"])
        self.assertEqual(project["aiIssues"], [])
        self.assertEqual(STORE.analysis_id, analysis_id)  # saved cuts stay valid
        self.assertEqual((proxy.stat().st_mtime_ns, thumb.stat().st_mtime_ns), mtimes)
        self.assertEqual(len(transcriber.calls), 1)
        self.assertTrue(project["clips"][0]["hasTranscript"])
        self.assertEqual(len(project["visualEvidence"]), 1)
        self.assertEqual(len(STORE.selects), 1)

    def test_retry_route(self):
        import server

        client = server.app.test_client()
        self.assertFalse(client.post("/analyze/retry-ai").get_json()["accepted"])  # nothing analyzed yet
        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        with patch.object(pipeline, "retry_failed_ai", lambda: None):
            body = client.post("/analyze/retry-ai").get_json()
        self.assertTrue(body["accepted"])
        self.assertEqual(sorted(r["task"] for r in body["retrying"]), ["transcription", "visual-analysis"])


class TestDirectorKnowsWhy(_FolderCase):
    def build(self):
        return pipeline.build_timeline("p", None, 30, "Create a 30-second rough cut", reasoning_provider=FakeReasoningProvider())

    def test_never_analyzed(self):
        result = self.build()
        self.assertEqual((result["status"], result["analysis"]["status"]), ("blocked", "not-run"))
        self.assertIn("run Analyze in WATCH", result["summary"])

    def test_still_running(self):
        STORE.begin_analysis("p", str(self.root))
        STORE.set_progress(40)
        result = self.build()
        self.assertEqual(result["analysis"]["status"], "running")
        self.assertIn("still running (40%)", result["summary"])

    def test_failed_ai_is_not_reported_as_never_analyzed(self):
        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        result = self.build()
        self.assertEqual((result["status"], result["analysis"]["status"]), ("blocked", "failed"))
        self.assertNotIn("run Analyze first", result["summary"])
        self.assertIn("couldn't connect to OpenAI", result["summary"])
        self.assertIn("Retry AI Analysis", result["summary"])

    def test_route_returns_the_structured_status(self):
        import server

        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        body = server.app.test_client().post("/build", json={"command": "Create a 30-second rough cut"}).get_json()
        self.assertEqual(body["status"], "blocked")
        self.assertEqual(body["analysis"]["status"], "failed")


class TestPersistence(_FolderCase):
    def test_failure_status_survives_save_and_restore(self):
        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        os.environ[persistence.PERSIST_ENV] = "1"
        persistence.save_snapshot(STORE)
        STORE.reset()
        self.assertTrue(persistence.restore_snapshot(STORE, "p", str(self.root))["restored"])
        project = STORE.project_json()
        self.assertEqual(project["analysisOutcome"], "failed")
        self.assertEqual(project["clips"][0]["ai"]["transcription"]["category"], "network")
        self.assertEqual(project["aiTasks"]["selects"]["status"], "not-applicable")

    def test_an_analysis_saved_before_ai_status_reports_no_outcome(self):
        self.analyze_with_real_providers(f"http://127.0.0.1:{_free_port()}")
        for clip in STORE.clips.values():
            clip.ai = {}
        STORE.ai_tasks = {}
        project = STORE.project_json()
        self.assertIsNone(project["analysisOutcome"])
        self.assertEqual(project["aiIssues"], [])
        self.assertIsNone(project["analysisMessage"])


class TestClassification(unittest.TestCase):
    """Real SDK exception types → categories (no network)."""

    def test_sdk_exceptions(self):
        import anthropic
        import httpx
        import openai

        req = httpx.Request("POST", "http://127.0.0.1/v1/x")

        def status(cls, code):
            return cls("x", response=httpx.Response(code, request=req), body=None)

        cases = [
            (openai.APIConnectionError(request=req), "network"),
            (openai.APITimeoutError(request=req), "timeout"),
            (status(openai.AuthenticationError, 401), "auth"),
            (status(anthropic.PermissionDeniedError, 403), "auth"),
            (status(openai.RateLimitError, 429), "rate-limit"),
            (status(anthropic.InternalServerError, 500), "provider-error"),
            (status(anthropic.APIStatusError, 529), "provider-error"),
            (status(openai.BadRequestError, 400), "bad-request"),
            (openai_provider.ProviderError("OPENAI_API_KEY is not set."), "not-configured"),
            (ValueError("odd"), "unknown"),
        ]
        for exc, expected in cases:
            with self.subTest(type(exc).__name__):
                self.assertEqual(ai_status.classify(exc)[0], expected)

    def test_messages_never_echo_the_exception(self):
        entry = ai_status.failed("transcription", "OpenAI", RuntimeError("sk-proj-SECRET payload"))
        self.assertNotIn("SECRET", json.dumps(entry))

    def test_outcome(self):
        ok, bad = {"status": "succeeded"}, {"status": "failed"}
        na = {"status": "not-applicable"}
        self.assertEqual(ai_status.outcome([ok, na]), "succeeded")
        self.assertEqual(ai_status.outcome([ok, bad]), "partial")
        self.assertEqual(ai_status.outcome([bad, na]), "failed")
        self.assertEqual(ai_status.outcome([na]), "succeeded")


if __name__ == "__main__":
    unittest.main()
