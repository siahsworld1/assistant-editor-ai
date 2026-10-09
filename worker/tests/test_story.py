"""Director AI 2.0, Phase 6 — POST /propose/story (worker/story.py).

Fake providers only: no API key, no network, no paid call. The worker frames
the model's reply as an ae.story-plan/1 plan — schema, base and instruction
from the REQUEST, never the model — and passes everything else through
untouched for the app's deterministic compiler (src/lib/timeline/story-plan.ts),
which judges ids, evidence, cutaways and protection. Those judgements are
tested on the TypeScript side (tests/timeline/story-endpoint.test.ts).
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

import director  # noqa: E402
import pipeline  # noqa: E402
import story  # noqa: E402
from tests.fakes import FakeReasoningProvider  # noqa: E402

CONTEXT = {
    "schema": "ae.story-context/1",
    "versionId": "ver_abc",
    "revision": "rev_0123456789abcdef_1a",
    "fps": 24,
    "durationFrames": 910,
    "interview": [
        {"id": "itm_a", "label": "Highway", "select": {"id": "sel-01", "score": 92, "category": "context"},
         "lines": [{"id": "t-01", "text": "They built the highway.", "lowConfidence": False}], "directorMayChange": True},
        {"id": "itm_b", "label": "Shared stories", "select": None, "lines": [], "directorMayChange": True},
        {"id": "itm_c", "label": "Emotion", "select": {"id": "sel-02", "score": 88, "category": "emotional"},
         "lines": [], "directorMayChange": True},
    ],
    "cutaways": [{"id": "itm_v2", "over": ["itm_a", "itm_b"], "insideClipId": None, "crossesCut": True}],
    "story": None,
    "selects": [],
    "caveats": ["Speakers are not identified."],
}
PLAN = {
    "status": "plan",
    "summary": "Opens on the emotional moment, then explains what happened.",
    "order": ["itm_c", "itm_a", "itm_b"],
    "cutaways": {"itm_v2": "remove"},
    "rationale": [
        {"clipId": "itm_c", "reason": "The strongest emotional moment.", "evidence": [{"kind": "select", "id": "sel-02"}]},
        {"clipId": "itm_a", "reason": "Then the context.", "evidence": [{"kind": "transcript", "id": "t-01"}]},
        {"clipId": "itm_b", "reason": "Then the community."},
    ],
}
ASK = "Start with the emotional moment, then explain what happened."


class TestProposeStory(unittest.TestCase):
    def test_frames_a_plan_with_the_requests_version_revision_and_instruction(self):
        out = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(PLAN))
        self.assertEqual(out["status"], "plan")
        plan = out["plan"]
        self.assertEqual(plan["schema"], "ae.story-plan/1")
        self.assertEqual(plan["base"], {"versionId": "ver_abc", "revision": "rev_0123456789abcdef_1a"})
        self.assertEqual(plan["instruction"], ASK)
        for k in ("summary", "order", "cutaways", "rationale"):
            self.assertEqual(plan[k], PLAN[k])
        self.assertNotIn("status", plan)
        # Exactly the compiler's accepted fields — nothing else invented here.
        self.assertEqual(set(plan), {"schema", "base", "instruction", "summary", "order", "cutaways", "rationale"})

    def test_the_model_cannot_set_the_envelope(self):
        reply = {**PLAN, "schema": "ae.story-plan/9", "base": {"versionId": "v_other", "revision": "rev_x"},
                 "instruction": "Something else"}
        plan = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(reply))["plan"]
        self.assertEqual(plan["schema"], "ae.story-plan/1")
        self.assertEqual(plan["base"], {"versionId": "ver_abc", "revision": "rev_0123456789abcdef_1a"})
        self.assertEqual(plan["instruction"], ASK)

    def test_everything_else_passes_through_untouched_for_the_apps_compiler(self):
        # Invented ids, bad evidence, bad cutaway decisions, frame positions,
        # self-authorization: NOT filtered here — the app must see and refuse them.
        bad = {
            "status": "plan",
            "summary": "x",
            "order": ["itm_c", "itm_invented"],
            "remove": ["itm_a"],
            "cutaways": {"itm_v2": "move", "itm_ghost": "keep"},
            "rationale": [{"clipId": "itm_c", "reason": "r", "evidence": [{"kind": "transcript", "id": "t-made-up"}]}],
            "startFrame": 120,
            "allowManual": True,
        }
        plan = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(bad))["plan"]
        for k in ("order", "remove", "cutaways", "rationale", "startFrame", "allowManual"):
            self.assertEqual(plan[k], bad[k])

    def test_the_model_sees_the_instruction_the_story_context_and_the_rules(self):
        fake = FakeReasoningProvider(PLAN)
        story.propose_story(ASK, CONTEXT, reasoning_provider=fake)
        system, content, max_tokens = fake.calls[0]
        self.assertIs(system, story.STORY_SYSTEM)
        self.assertEqual(json.loads(content[0].text), {"instruction": ASK, "context": CONTEXT})
        self.assertLessEqual(max_tokens, 3072)
        # The prompt describes exactly the compiler's plan fields and rules.
        for field in ('"order"', '"remove"', '"cutaways"', '"rationale"', '"clipId"', '"evidence"',
                      '"keep" | "remove"', '"transcript" | "select"', '"status": "plan"', '"status": "refused"'):
            self.assertIn(field, system)
        for rule in ("directorMayChange", "insideClipId", "Never invent", "lowConfidence", "WHOLE interview clips",
                     "refuse"):
            self.assertIn(rule, system)

    def test_a_refusal_is_returned_as_a_refusal(self):
        reply = {"status": "refused", "reason": "Splitting a clip isn't possible yet."}
        out = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(reply))
        self.assertEqual(out, {"status": "refused", "reason": reply["reason"]})
        blank = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider({"status": "refused"}))
        self.assertEqual(blank["status"], "refused")

    def test_malformed_or_unusable_replies_are_reported_not_guessed(self):
        for reply in ["not json at all", '{"status": "plan", "order": ', "[1, 2, 3]", {"status": "maybe"},
                      {"status": "plan"}, {"status": "plan", "order": "itm_a"}, {}]:
            out = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(reply))
            self.assertEqual(out["status"], "invalid-response", reply)

    def test_a_missing_summary_gets_a_neutral_one_other_missing_fields_are_left_for_the_app(self):
        reply = {"status": "plan", "order": ["itm_a", "itm_b", "itm_c"]}
        plan = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(reply))["plan"]
        self.assertEqual(plan["summary"], "Director story plan.")
        self.assertNotIn("rationale", plan)  # the app's compiler reports what's missing

    def test_oversized_replies_are_refused(self):
        huge = {**PLAN, "summary": "x" * (story.MAX_REPLY_CHARS + 1)}
        out = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(huge))
        self.assertEqual(out["status"], "invalid-response")
        many = {**PLAN, "rationale": [{"clipId": "itm_a", "reason": "r" * 900}] * 100}
        self.assertEqual(
            story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(many))["status"],
            "invalid-response",
        )

    def test_provider_failure_is_structured_retryable_and_credential_free(self):
        out = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(fail=True))
        self.assertEqual(out["status"], "failed")
        self.assertEqual(out["aiFailure"]["task"], "story")
        self.assertIn("category", out["aiFailure"])
        with patch.object(pipeline, "_resolve_reasoning_provider", lambda: None):
            none = story.propose_story(ASK, CONTEXT)
        self.assertEqual(none["aiFailure"]["category"], "not-configured")
        ok = story.propose_story(ASK, CONTEXT, reasoning_provider=FakeReasoningProvider(PLAN))
        self.assertEqual(ok["status"], "plan")  # a retry with a working provider

    def test_a_key_in_a_provider_error_never_reaches_the_reply_or_the_log(self):
        from providers.base import ProviderError

        fake_key = "sk-ant-api03-STORYFAKESTORYFAKESTORYFAKE"

        class Leaky(FakeReasoningProvider):
            def complete(self, system, content, max_tokens=4096):
                raise ProviderError(f"401 for key {fake_key} (Authorization: Bearer {fake_key})")

        with self.assertLogs(level="DEBUG") as logs:
            out = story.propose_story(ASK, CONTEXT, reasoning_provider=Leaky())
        self.assertEqual(out["status"], "failed")
        self.assertNotIn(fake_key, json.dumps(out))
        self.assertNotIn(fake_key, "\n".join(logs.output))

    def test_invalid_requests_never_reach_the_provider(self):
        fake = FakeReasoningProvider(PLAN)
        cases = [
            (None, CONTEXT),
            ("   ", CONTEXT),
            ("x" * 2001, CONTEXT),
            (ASK, None),
            (ASK, {**CONTEXT, "schema": "ae.context/1"}),  # a Phase 5 context is not a story context
            (ASK, {**CONTEXT, "revision": None}),
            (ASK, {**CONTEXT, "interview": "itm_a"}),
            (ASK, {**CONTEXT, "interview": []}),
            (ASK, {**CONTEXT, "interview": [{"id": "x", "pad": "y" * 130_000}]}),
        ]
        for instruction, context in cases:
            self.assertEqual(story.propose_story(instruction, context, reasoning_provider=fake)["status"],
                             "invalid-request")
        self.assertEqual(fake.calls, [])

    def test_the_worker_never_edits_anything(self):
        tree = ast.parse(inspect.getsource(story))
        used = {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "pipeline"
        }
        self.assertEqual(used, {"_resolve_reasoning_provider", "_call_ai"})
        imported = {a.name for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
        self.assertFalse(imported & {"store", "timeline", "server", "director", "os", "subprocess", "shutil"},
                         imported)

        def boom(*_a, **_k):
            raise AssertionError("an editing path was called")

        import server

        client = server.app.test_client()
        with (
            patch.object(pipeline, "build_timeline", boom),
            patch.object(pipeline, "_resolve_reasoning_provider", lambda: FakeReasoningProvider(PLAN)),
        ):
            body = client.post("/propose/story", json={"instruction": ASK, "context": CONTEXT}).get_json()
        self.assertEqual(body["status"], "plan")
        self.assertEqual(client.post("/propose/story", json={}).get_json()["status"], "invalid-request")

    def test_propose_is_unchanged(self):
        # Phase 5's endpoint answers exactly as before, separately.
        import server

        ctx = {"schema": "ae.context/1", "versionId": "v", "revision": "rev_0123456789abcdef_1", "clips": []}
        reply = {"status": "proposal", "summary": "s", "operations": [{"op": "reorder", "itemIds": ["a", "b"]}]}
        client = server.app.test_client()
        with patch.object(pipeline, "_resolve_reasoning_provider", lambda: FakeReasoningProvider(reply)):
            body = client.post("/propose", json={"instruction": "x", "context": ctx}).get_json()
        self.assertEqual(body["status"], "proposal")
        self.assertEqual(body["proposal"]["schema"], "ae.proposal/1")
        self.assertEqual(director.propose.__module__, "director")
        # A story context sent to /propose is not understood there.
        self.assertEqual(
            client.post("/propose", json={"instruction": "x", "context": CONTEXT}).get_json()["status"],
            "invalid-request",
        )


if __name__ == "__main__":
    unittest.main()
