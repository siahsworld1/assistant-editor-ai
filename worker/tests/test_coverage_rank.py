"""Phase 7, Milestone 6 — POST /propose/coverage-rank (worker/coverage_rank.py).

Fake providers only: no API key, no network, no paid call. The worker frames
the model's reply as an ae.coverage-ranking/1 ranking — schema and base from
the REQUEST, never the model — and passes everything else through untouched
for the app's deterministic validator (src/lib/timeline/coverage-ranking.ts),
which judges ids, duplicates, fields and staleness. Those judgements are
tested on the TypeScript side (tests/timeline/coverage-ranking.test.ts).
"""

from __future__ import annotations

import ast
import inspect
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import coverage_rank  # noqa: E402
import pipeline  # noqa: E402
from tests.fakes import FakeReasoningProvider  # noqa: E402

CONTEXT = {
    "schema": "ae.coverage-rank-context/1",
    "versionId": "ver_abc",
    "revision": "rev_0123456789abcdef_1a",
    "inventory": "inv_0badc0de_2",
    "cuts": [
        {"id": "cut:a|b@240", "tc": "00:00:10:00",
         "lines": [{"id": "t-1", "text": "The highway cut through.", "confidence": 0.9}]},
    ],
    "candidates": [
        {"id": "cand:park-1", "visualId": "park-1", "file": "CLIP-005.MP4", "kind": "b-roll",
         "label": "Park sign", "atTc": "00:00:03:00", "confidence": 0.8},
        {"id": "cand:street-1", "visualId": "street-1", "file": "CLIP-006.MP4", "kind": "b-roll",
         "label": "Empty street", "atTc": "00:00:04:00", "confidence": 0.8},
    ],
    "caveats": ["Each candidate is ONE sampled frame."],
}
REPLY = {
    "status": "ranking",
    "summary": "Street for the highway line.",
    "rankings": [{"cutId": "cut:a|b@240", "choices": [
        {"candidateId": "cand:street-1", "reason": "Empty street where the highway is mentioned."},
    ]}],
}


class CoverageRankTests(unittest.TestCase):
    def test_frames_a_ranking_with_the_requests_version_revision_and_inventory(self):
        fake = FakeReasoningProvider(REPLY)
        out = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=fake)
        self.assertEqual(out["status"], "ranking")
        r = out["ranking"]
        self.assertEqual(r["schema"], "ae.coverage-ranking/1")
        self.assertEqual(r["base"], {"versionId": "ver_abc", "revision": "rev_0123456789abcdef_1a",
                                     "inventory": "inv_0badc0de_2"})
        self.assertEqual(r["rankings"], REPLY["rankings"])
        self.assertEqual(len(fake.calls), 1)

    def test_the_model_cannot_set_the_envelope(self):
        forged = {**REPLY, "schema": "x", "base": {"versionId": "other", "revision": "r", "inventory": "i"}}
        r = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=FakeReasoningProvider(forged))["ranking"]
        self.assertEqual(r["schema"], "ae.coverage-ranking/1")
        self.assertEqual(r["base"]["versionId"], "ver_abc")
        self.assertEqual(r["base"]["inventory"], "inv_0badc0de_2")

    def test_everything_else_passes_through_untouched_for_the_apps_validator(self):
        sneaky = {**REPLY, "operations": [{"op": "place"}], "rankings": [
            {"cutId": "cut:invented", "choices": [{"candidateId": "clip-999", "reason": "r", "sourceInFrame": 0}]}]}
        r = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=FakeReasoningProvider(sneaky))["ranking"]
        self.assertEqual(r["operations"], [{"op": "place"}])
        self.assertEqual(r["rankings"], sneaky["rankings"])

    def test_the_model_sees_only_the_context_and_the_rules(self):
        fake = FakeReasoningProvider(REPLY)
        coverage_rank.rank_coverage(CONTEXT, reasoning_provider=fake)
        system, content, max_tokens = fake.calls[0]
        self.assertIn("You RANK footage; you never edit", system)
        self.assertIn("ONLY the cut ids and candidate ids", system)
        self.assertEqual(json.loads(content[0].text), {"context": CONTEXT})
        self.assertEqual(max_tokens, coverage_rank.MAX_TOKENS)

    def test_a_refusal_is_returned_as_a_refusal(self):
        out = coverage_rank.rank_coverage(
            CONTEXT, reasoning_provider=FakeReasoningProvider({"status": "refused", "reason": " Nothing fits. "}))
        self.assertEqual(out, {"status": "refused", "reason": "Nothing fits."})
        blank = coverage_rank.rank_coverage(
            CONTEXT, reasoning_provider=FakeReasoningProvider({"status": "refused"}))
        self.assertEqual(blank["status"], "refused")

    def test_malformed_or_unusable_replies_are_reported_not_guessed(self):
        for reply in ["not json at all", [], {"status": "plan", "order": []}, {"status": "ranking"},
                      {"status": "ranking", "rankings": "street"}]:
            out = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=FakeReasoningProvider(reply))
            self.assertEqual(out["status"], "invalid-response", reply)

    def test_oversized_replies_are_refused(self):
        huge = {**REPLY, "summary": "x" * (coverage_rank.MAX_REPLY_CHARS + 1)}
        out = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=FakeReasoningProvider(huge))
        self.assertEqual(out["status"], "invalid-response")

    def test_provider_failure_is_structured_and_credential_free(self):
        out = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=FakeReasoningProvider(fail=True))
        self.assertEqual(out["status"], "failed")
        self.assertEqual(out["aiFailure"]["task"], "coverage-rank")
        with patch.object(pipeline, "_resolve_reasoning_provider", lambda: None):
            none = coverage_rank.rank_coverage(CONTEXT)
        self.assertEqual(none["aiFailure"]["category"], "not-configured")

    def test_a_key_in_a_provider_error_never_reaches_the_reply_or_the_log(self):
        from providers.base import ProviderError

        fake_key = "sk-ant-api03-RANKFAKERANKFAKERANKFAKE"

        class Leaky(FakeReasoningProvider):
            def complete(self, system, content, max_tokens=4096):
                raise ProviderError(f"401 for key {fake_key} (Authorization: Bearer {fake_key})")

        with self.assertLogs(level="DEBUG") as logs:
            out = coverage_rank.rank_coverage(CONTEXT, reasoning_provider=Leaky())
        self.assertEqual(out["status"], "failed")
        self.assertNotIn(fake_key, json.dumps(out))
        self.assertNotIn(fake_key, "\n".join(logs.output))

    def test_invalid_requests_never_reach_the_provider(self):
        fake = FakeReasoningProvider(REPLY)
        cases = [
            None,
            {**CONTEXT, "schema": "ae.story-context/1"},
            {**CONTEXT, "revision": None},
            {**CONTEXT, "inventory": None},
            {**CONTEXT, "cuts": []},
            {**CONTEXT, "candidates": []},
            {**CONTEXT, "cuts": "cut"},
            {**CONTEXT, "cuts": [CONTEXT["cuts"][0]] * 51},
            {**CONTEXT, "candidates": [CONTEXT["candidates"][0]] * 201},
            {**CONTEXT, "caveats": ["y" * 130_000]},
        ]
        for context in cases:
            self.assertEqual(coverage_rank.rank_coverage(context, reasoning_provider=fake)["status"],
                             "invalid-request")
        self.assertEqual(fake.calls, [])

    def test_the_worker_never_edits_anything(self):
        tree = ast.parse(inspect.getsource(coverage_rank))
        used = {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "pipeline"
        }
        self.assertEqual(used, {"_resolve_reasoning_provider", "_call_ai"})
        imported = {a.name for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
        self.assertFalse(imported & {"store", "timeline", "server", "director", "story", "os", "subprocess", "shutil"},
                         imported)

        def boom(*_a, **_k):
            raise AssertionError("an editing path was called")

        import server

        client = server.app.test_client()
        with (
            patch.object(pipeline, "build_timeline", boom),
            patch.object(pipeline, "_resolve_reasoning_provider", lambda: FakeReasoningProvider(REPLY)),
        ):
            body = client.post("/propose/coverage-rank", json={"context": CONTEXT}).get_json()
        self.assertEqual(body["status"], "ranking")
        self.assertEqual(client.post("/propose/coverage-rank", json={}).get_json()["status"], "invalid-request")

    def test_ranking_requests_make_one_attempt_while_everything_else_keeps_sdk_retries(self):
        import anthropic
        import openai

        made = []

        class Recorder:
            def __init__(self, **kwargs):
                made.append(kwargs)
                outer = self

                class _Messages:
                    def create(self, **_k):
                        class R:
                            content = [type("B", (), {"type": "text", "text": json.dumps(REPLY)})()]

                        return R()

                class _Completions:
                    def create(self, **_k):
                        msg = type("M", (), {"content": json.dumps(REPLY)})()
                        return type("R", (), {"choices": [type("C", (), {"message": msg})()]})()

                outer.messages = _Messages()
                outer.chat = type("Chat", (), {"completions": _Completions()})()

        env = {"ANTHROPIC_API_KEY": "dummy-not-a-key", "OPENAI_API_KEY": "dummy-not-a-key"}
        for vendor, sdk, attr in (("anthropic", anthropic, "Anthropic"), ("openai", openai, "OpenAI")):
            made.clear()
            with (
                patch.dict("os.environ", {**env, "ASSISTANT_EDITOR_REASONING_PROVIDER": vendor}),
                patch.object(sdk, attr, Recorder),
            ):
                out = coverage_rank.rank_coverage(CONTEXT)  # resolves its own provider
                self.assertEqual(out["status"], "ranking", vendor)
                self.assertEqual(made[-1].get("max_retries"), 0, vendor)
                provider = pipeline._resolve_reasoning_provider()  # noqa: SLF001
                provider.complete("s", [], max_tokens=10)
                self.assertNotIn("max_retries", made[-1], vendor)

    def test_a_passed_provider_is_not_reconfigured(self):
        fake = FakeReasoningProvider(REPLY)
        fake.max_retries = 3
        coverage_rank.rank_coverage(CONTEXT, reasoning_provider=fake)
        self.assertEqual(fake.max_retries, 3)


if __name__ == "__main__":
    unittest.main()
