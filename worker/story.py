"""Director AI 2.0, Phase 6 — story plans (POST /propose/story).

Receives the filmmaker's instruction and the app's story context for the
CURRENT sequence (src/lib/timeline/story-context.ts, schema ae.story-context/1),
asks the configured reasoning provider how the interview clips should be
arranged, and returns an ae.story-plan/1 plan — ids only — or a refusal.

Nothing here executes, filters or "fixes" an edit. The plan's envelope
(schema, base version/revision, instruction) comes from the request, never
from the model; the model's order, removals, cutaway decisions and rationale
are passed through exactly as returned (along with any other field it adds),
so the app's deterministic compiler (src/lib/timeline/story-plan.ts) — the
single judge of ids, evidence, cutaways, ownership and protection — sees and
refuses anything wrong. Provider failures are the same structured,
credential-free entries as the rest of the worker (ai_status.failed).
"""

from __future__ import annotations

import json
import logging

import pipeline
from providers.base import ReasoningProvider, TextBlock
from providers.json_utils import extract_json

log = logging.getLogger("assistant-editor-worker.story")

CONTEXT_SCHEMA = "ae.story-context/1"
PLAN_SCHEMA = "ae.story-plan/1"
MAX_INSTRUCTION_CHARS = 2000
MAX_BRIEF_CHARS = 120_000
# A reply bigger than this is not a plan (the app enforces its own limits too).
MAX_REPLY_CHARS = 64_000
# Fields that frame the plan: set from the request, never taken from the model.
ENVELOPE = ("status", "schema", "base", "instruction")

STORY_SYSTEM = """You are the story Director in Assistant Editor AI, an assistant editor working on \
a filmmaker's CURRENT edited sequence. The filmmaker gives a creative instruction about the story \
("start with the emotional moment", "remove repetitive statements", ...). You answer with a STORY \
PLAN that rearranges or removes whole interview clips. The application validates the plan, shows \
the filmmaker a before/after preview, and applies it only if they accept. You never apply anything.

You are given JSON: {"instruction": "...", "context": {...}}. The context (schema \
"ae.story-context/1") describes the sequence:
- "interview": the interview clips on V1, in their CURRENT timeline order. Each has an "id", \
"label", "file", "start"/"end" (sequence frames), "sourceInTc"/"sourceOutTc", "linked" (its sync \
audio — it always moves with the clip), "owner" ("director" | "manual" | "unknown"), \
"locked"/"aiLocked", "directorMayChange", "select" ({id, score 0-100, category}) or null, \
"beatIds" (story beats it serves) and "lines": the transcript lines in that clip, each with an \
"id", timecodes, "text", "placement" ("inside", or "crosses-in"/"crosses-out"/"spans" when the line \
runs past the clip's in or out point), "confidence", "lowConfidence" and "question" (ends with "?", \
likely the interviewer).
- "cutaways": B-roll over the interview, each with an "id", "label", "over" (the interview clip ids \
it overlaps), "insideClipId" (the one clip it lies wholly inside, else null) and "crossesCut".
- "story": the chosen story's beats (with the clips that serve each), or null.
- "selects": scored interview moments; "caveats": limits of the analysis you must respect.

Your plan arranges WHOLE interview clips only — you cannot split, trim, add, extend or move \
anything to a frame position. Put every interview clip exactly once in either "order" (kept, in the \
new order) or "remove" (cut out; the gap closes).

Cutaways: for every cutaway whose "over" includes a clip you move to a different position or \
remove, give an explicit decision in "cutaways": "keep" ONLY if its "insideClipId" is a clip you \
keep (it then travels with that clip, over the same words); otherwise "remove". Give no decision \
for a cutaway whose clips you leave in place. Never remove a cutaway you don't have to.

Hard rules:
- Never move or remove a clip whose "directorMayChange" is false (hand-edited, unverified, locked \
or AI-protected) — and keep it out of any change that would shift it. If the instruction needs \
that, refuse.
- Use only ids you were given. Never invent clips, lines, selects, timecodes, frames or files.
- Evidence: cite the transcript line ids ("kind": "transcript") or select ids ("kind": "select") \
that belong to the clip you are explaining. Do not rely on a line marked "lowConfidence" alone, and \
do not treat a "question" line as the subject's statement.
- Every clip you move or remove needs a short rationale entry.
- If the instruction is ambiguous, needs something you cannot do (splitting a clip, adding \
footage, sentence-level edits), or would change nothing, refuse and say why in one or two sentences.
- Change as little as the instruction needs.

Reply with ONLY one JSON object (no prose, no markdown fences), either:
{"status": "plan",
 "summary": "<one or two sentences: the new structure and why>",
 "order": ["<interview clip id>", ...],
 "remove": ["<interview clip id>", ...],
 "cutaways": {"<cutaway id>": "keep" | "remove"},
 "rationale": [{"clipId": "<clip id>", "reason": "<short reason>",
                "evidence": [{"kind": "transcript" | "select", "id": "<id>"}]}]}
("remove" and "cutaways" may be omitted when empty) or
{"status": "refused", "reason": "<one or two sentences the filmmaker will read>"}"""


def _story_reply(provider: ReasoningProvider, brief: str):
    text = provider.complete(STORY_SYSTEM, [TextBlock(brief)], max_tokens=3072)
    return extract_json(text)


def propose_story(instruction, context, reasoning_provider: ReasoningProvider | None = None) -> dict:
    """Returns one of:
    {"status": "plan", "plan": {...ae.story-plan/1...}}
    {"status": "refused", "reason": "..."}                — the Director declined
    {"status": "invalid-request", "reason": "..."}        — the app sent something unusable
    {"status": "invalid-response", "reason": "..."}       — the model's reply was unusable
    {"status": "failed", "aiFailure": {...ai_status...}}  — the provider call failed
    """
    if not isinstance(instruction, str) or not instruction.strip():
        return {"status": "invalid-request", "reason": "No instruction was given."}
    if len(instruction) > MAX_INSTRUCTION_CHARS:
        return {"status": "invalid-request", "reason": "That instruction is too long."}
    if (
        not isinstance(context, dict)
        or context.get("schema") != CONTEXT_SCHEMA
        or not isinstance(context.get("versionId"), str)
        or not isinstance(context.get("revision"), str)
        or not isinstance(context.get("interview"), list)
    ):
        return {"status": "invalid-request", "reason": "The story description is missing or not understood."}
    if len(context["interview"]) < 1:
        return {"status": "invalid-request", "reason": "There are no interview clips to arrange."}

    brief = json.dumps({"instruction": instruction.strip(), "context": context}, separators=(",", ":"))
    if len(brief) > MAX_BRIEF_CHARS:
        return {"status": "invalid-request", "reason": "This sequence is too large to send to the Director."}

    if reasoning_provider is None:
        reasoning_provider = pipeline._resolve_reasoning_provider()  # noqa: SLF001
        # One attempt only: no automatic (paid) SDK retries for a story request.
        # This is a fresh instance — analysis and /propose keep the SDK default.
        if reasoning_provider is not None and hasattr(reasoning_provider, "max_retries"):
            reasoning_provider.max_retries = 0
    raw, entry = pipeline._call_ai(  # noqa: SLF001
        "story", reasoning_provider, "reasoning", lambda: _story_reply(reasoning_provider, brief)
    )
    if entry.get("status") != "succeeded":
        return {"status": "failed", "aiFailure": entry}
    if not isinstance(raw, dict):
        return {"status": "invalid-response", "reason": "The Director's reply could not be read. Try again."}
    if len(json.dumps(raw, default=str)) > MAX_REPLY_CHARS:
        return {"status": "invalid-response", "reason": "The Director's reply was too large to be a plan."}

    status = raw.get("status")
    if status == "refused":
        reason = raw.get("reason")
        return {
            "status": "refused",
            "reason": reason.strip()[:1000] if isinstance(reason, str) and reason.strip() else "The Director can't do that.",
        }
    if status != "plan" or not isinstance(raw.get("order"), list):
        return {"status": "invalid-response", "reason": "The Director's reply was not a usable plan. Try again."}

    plan = {
        "schema": PLAN_SCHEMA,
        "base": {"versionId": context["versionId"], "revision": context["revision"]},
        "instruction": instruction.strip(),
    }
    # Everything else exactly as the model returned it — judged by the app.
    for key, value in raw.items():
        if key not in ENVELOPE:
            plan[key] = value
    if not isinstance(plan.get("summary"), str) or not plan["summary"].strip():
        plan["summary"] = "Director story plan."
    return {"status": "plan", "plan": plan}
