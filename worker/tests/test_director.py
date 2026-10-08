"""Director AI 2.0, Phase 5 — POST /propose (worker/director.py).

Fake providers only: no API key, no network, no paid call. The worker wraps
the model's reply in the app's proposal schema — passing its operations
through untouched for the app's deterministic validation — or reports a
refusal, an unreadable reply, or a structured provider failure.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import director  # noqa: E402
import pipeline  # noqa: E402
import reasoning  # noqa: E402
from tests.fakes import FakeReasoningProvider  # noqa: E402

CONTEXT = {
    "schema": "ae.context/1",
    "versionId": "ver_abc",
    "revision": "rev_0123456789abcdef_1a",
    "fps": 24,
    "durationFrames": 792,
    "selection": ["itm_cut7"],
    "clips": [
        {"id": "itm_v1", "track": "V1", "label": "event-1", "start": 0, "end": 240, "owner": "director"},
        {"id": "itm_cut7", "track": "V2", "label": "event-7", "start": 708, "end": 784, "owner": "director"},
    ],
    "evidence": {"selects": [{"id": "sel-01"}], "transcript": [], "visual": []},
}
PROPOSAL = {
    "status": "proposal",
    "summary": "Moves the closing cutaway a second earlier, onto the start of the final line.",
    "operations": [{"op": "move", "itemIds": ["itm_cut7"], "deltaFrames": -24}],
    "rationale": [{"opIndex": 0, "reason": "Lands on the line.", "evidence": [{"kind": "select", "id": "sel-01"}]}],
}


class TestPropose(unittest.TestCase):
    def test_wraps_a_proposal_in_the_app_schema_bound_to_the_sent_revision(self):
        fake = FakeReasoningProvider(PROPOSAL)
        out = director.propose("Bring the last cutaway in a second earlier", CONTEXT, reasoning_provider=fake)
        self.assertEqual(out["status"], "proposal")
        p = out["proposal"]
        self.assertEqual(p["schema"], "ae.proposal/1")
        self.assertEqual(p["base"], {"versionId": "ver_abc", "revision": "rev_0123456789abcdef_1a"})
        self.assertEqual(p["instruction"], "Bring the last cutaway in a second earlier")
        self.assertEqual(p["operations"], PROPOSAL["operations"])
        self.assertEqual(p["rationale"], PROPOSAL["rationale"])
        self.assertTrue(p["id"].startswith("prp_ai_"))
        # No self-authorization can be smuggled through the wrapper.
        self.assertEqual(set(p), {"schema", "id", "instruction", "summary", "base", "operations", "rationale"})
        # Deterministic id for the same request and reply.
        again = director.propose(
            "Bring the last cutaway in a second earlier", CONTEXT, reasoning_provider=FakeReasoningProvider(PROPOSAL)
        )
        self.assertEqual(again["proposal"]["id"], p["id"])

    def test_the_model_sees_the_instruction_the_current_sequence_and_the_rules(self):
        fake = FakeReasoningProvider(PROPOSAL)
        director.propose("Tighten it", CONTEXT, reasoning_provider=fake)
        system, content, max_tokens = fake.calls[0]
        self.assertIs(system, reasoning.PROPOSE_SYSTEM)
        brief = json.loads(content[0].text)
        self.assertEqual(brief, {"instruction": "Tighten it", "context": CONTEXT})
        self.assertLessEqual(max_tokens, 2048)
        for rule in ('"manual" or "unknown"', "aiLocked", "Never invent", "refuse"):
            self.assertIn(rule, system)

    def test_operations_pass_through_untouched_even_when_wrong(self):
        # Invented ids, unsupported ops, self-authorization: NOT filtered here —
        # the app's deterministic validation must see (and refuse) them.
        bad = {
            "status": "proposal",
            "summary": "x",
            "operations": [
                {"op": "move", "itemIds": ["itm_invented"], "deltaFrames": 3},
                {"op": "replaceAssembly"},
                {"op": "move", "itemIds": ["itm_v1"], "deltaFrames": 1, "force": True},
            ],
        }
        out = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(bad))
        self.assertEqual(out["status"], "proposal")
        self.assertEqual(out["proposal"]["operations"], bad["operations"])

    def test_a_refusal_is_returned_as_a_refusal(self):
        reply = {"status": "refused", "reason": "Which interview line do you mean? Select it first."}
        out = director.propose("Fix that bit", CONTEXT, reasoning_provider=FakeReasoningProvider(reply))
        self.assertEqual(out, {"status": "refused", "reason": reply["reason"]})
        blank = director.propose("Fix it", CONTEXT, reasoning_provider=FakeReasoningProvider({"status": "refused"}))
        self.assertEqual(blank["status"], "refused")

    def test_unreadable_or_unusable_replies_are_reported_not_guessed(self):
        for reply in ["not json at all", "[1, 2, 3]", {"status": "maybe"}, {"status": "proposal", "operations": "x"}, {}]:
            out = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(reply))
            self.assertEqual(out["status"], "invalid-response", reply)

    def test_provider_failure_is_structured_and_retryable_without_secrets(self):
        out = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(fail=True))
        self.assertEqual(out["status"], "failed")
        failure = out["aiFailure"]
        self.assertEqual(failure["task"], "director")
        self.assertEqual(failure["status"], "failed")
        self.assertIn("category", failure)
        self.assertNotIn("FakeReasoningProvider configured to fail", json.dumps(failure))
        # No provider configured at all (no key): reported, never raised.
        with patch.object(pipeline, "_resolve_reasoning_provider", lambda: None):
            none = director.propose("Do it", CONTEXT)
        self.assertEqual(none["status"], "failed")
        self.assertEqual(none["aiFailure"]["category"], "not-configured")
        # A retry with a working provider succeeds.
        ok = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(PROPOSAL))
        self.assertEqual(ok["status"], "proposal")

    def test_invalid_requests_never_reach_the_provider(self):
        fake = FakeReasoningProvider(PROPOSAL)
        cases = [
            (None, CONTEXT),
            ("   ", CONTEXT),
            ("x" * 2001, CONTEXT),
            ("Do it", None),
            ("Do it", {**CONTEXT, "schema": "other"}),
            ("Do it", {**CONTEXT, "revision": None}),
            ("Do it", {**CONTEXT, "clips": [{"id": "x", "pad": "y" * 130_000}]}),
        ]
        for instruction, context in cases:
            out = director.propose(instruction, context, reasoning_provider=fake)
            self.assertEqual(out["status"], "invalid-request")
        self.assertEqual(fake.calls, [])

    def test_oversized_replies_are_refused(self):
        huge = {**PROPOSAL, "summary": "x" * (director.MAX_REPLY_CHARS + 1)}
        out = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(huge))
        self.assertEqual(out["status"], "invalid-response")
        many = {**PROPOSAL, "operations": [{"op": "move", "itemIds": ["itm_v1"], "deltaFrames": 1}] * 5000}
        out = director.propose("Do it", CONTEXT, reasoning_provider=FakeReasoningProvider(many))
        self.assertEqual(out["status"], "invalid-response")

    def test_a_key_in_a_provider_error_never_reaches_the_reply_or_the_log(self):
        from providers.base import ProviderError

        fake_key = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE"

        class Leaky(FakeReasoningProvider):
            def complete(self, system, content, max_tokens=4096):
                raise ProviderError(f"401 Unauthorized for key {fake_key} (Authorization: Bearer {fake_key})")

        with self.assertLogs(level="DEBUG") as logs:
            out = director.propose("Do it", CONTEXT, reasoning_provider=Leaky())
        self.assertEqual(out["status"], "failed")
        self.assertNotIn(fake_key, json.dumps(out))
        self.assertNotIn(fake_key, "\n".join(logs.output))
        self.assertNotIn("sk-", json.dumps(out))

    def test_the_worker_never_edits_anything(self):
        # Only the provider resolver and the guarded AI call are used from the
        # pipeline; no timeline, project or file is touched — even for a reply
        # full of operations.
        import ast
        import inspect

        tree = ast.parse(inspect.getsource(director))
        used = {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "pipeline"
        }
        self.assertEqual(used, {"_resolve_reasoning_provider", "_call_ai"})
        imported = {a.name for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
        self.assertFalse(imported & {"store", "timeline", "server", "os", "subprocess", "shutil"}, imported)

        def boom(*_a, **_k):
            raise AssertionError("an editing path was called")

        import server

        client = server.app.test_client()
        with (
            patch.object(pipeline, "build_timeline", boom),
            patch.object(pipeline, "_resolve_reasoning_provider", lambda: FakeReasoningProvider(PROPOSAL)),
        ):
            body = client.post("/propose", json={"instruction": "Move it", "context": CONTEXT}).get_json()
        self.assertEqual(body["status"], "proposal")

    def test_route(self):
        import server

        client = server.app.test_client()
        with patch.object(pipeline, "_resolve_reasoning_provider", lambda: FakeReasoningProvider(PROPOSAL)):
            body = client.post("/propose", json={"instruction": "Move it", "context": CONTEXT}).get_json()
        self.assertEqual(body["status"], "proposal")
        self.assertEqual(body["proposal"]["base"]["revision"], CONTEXT["revision"])
        self.assertEqual(client.post("/propose", json={}).get_json()["status"], "invalid-request")


if __name__ == "__main__":
    unittest.main()
