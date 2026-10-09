"""Phase 7, Milestone 6 — optional AI ranking of B-roll candidates
(POST /propose/coverage-rank).

Receives the app's ranking context for the CURRENT cut
(src/lib/timeline/coverage-ranking.ts, schema ae.coverage-rank-context/1):
the cuts the deterministic planner would cover, reliable interview lines near
each, and the candidates it already verified (ids, labels, file names — no
paths, no media). Asks the configured reasoning provider, ONCE, to rank those
candidate ids per cut, and returns an ae.coverage-ranking/1 reply — or a
refusal.

Nothing here places, trims or applies anything, and nothing is "fixed": the
envelope (schema and base version/revision/inventory) comes from the request,
never the model; the model's rankings and any other field it adds are passed
through exactly as returned, so the app's deterministic validator refuses
anything unknown, duplicated or out of date before its planner, compiler and
review decide the edit. Provider failures are the same structured,
credential-free entries as the rest of the worker (ai_status.failed).
"""

from __future__ import annotations

import json

import pipeline
from providers.base import ReasoningProvider, TextBlock
from providers.json_utils import extract_json

CONTEXT_SCHEMA = "ae.coverage-rank-context/1"
RANKING_SCHEMA = "ae.coverage-ranking/1"
MAX_CUTS = 50
MAX_CANDIDATES = 200
MAX_BRIEF_CHARS = 120_000
MAX_REPLY_CHARS = 32_000
MAX_TOKENS = 2048
# Fields that frame the ranking: set from the request, never taken from the model.
ENVELOPE = ("status", "schema", "base")

RANK_SYSTEM = """You are the assistant editor in Assistant Editor AI, helping a filmmaker choose \
B-roll for their CURRENT cut. You RANK footage; you never edit. The application has already \
found the interview cuts that need a cutaway and verified every candidate shot; it assigns all \
frames itself, checks fit, protection and reuse, previews the result, and applies nothing unless \
the filmmaker accepts.

You are given JSON (schema "ae.coverage-rank-context/1"):
- "cuts": each potential jump cut to cover — "id", "tc", and "lines": the interview lines just \
before and after it (id, text, confidence).
- "candidates": verified B-roll moments — "id", "visualId", "file", "kind", "label" (what one \
sampled frame shows), "atTc", "confidence".
- "caveats": limits you must respect.

For each cut you can help with, rank up to 5 candidate ids, best first, by how well the shot's \
label supports what is being said around that cut. Give each pick one short reason (under 300 \
characters) grounded in the label and the lines. Use each candidate at most once overall. Skip a \
cut when nothing fits.

Hard rules: use ONLY the cut ids and candidate ids you were given. Never invent ids, files, \
timecodes, frames or durations. Never add timeline commands, ownership, protection or approval. \
Do not claim more about a shot than its label says.

Reply with ONLY one JSON object (no prose, no markdown fences), either:
{"status": "ranking", "summary": "<one sentence>",
 "rankings": [{"cutId": "<cut id>", "choices": [{"candidateId": "<candidate id>", "reason": "<short reason>"}]}]}
or {"status": "refused", "reason": "<one or two sentences the filmmaker will read>"}"""


def _rank_reply(provider: ReasoningProvider, brief: str):
    return extract_json(provider.complete(RANK_SYSTEM, [TextBlock(brief)], max_tokens=MAX_TOKENS))


def rank_coverage(context, reasoning_provider: ReasoningProvider | None = None) -> dict:
    """Returns one of:
    {"status": "ranking", "ranking": {...ae.coverage-ranking/1...}}
    {"status": "refused", "reason": "..."}                — the AI declined
    {"status": "invalid-request", "reason": "..."}        — the app sent something unusable
    {"status": "invalid-response", "reason": "..."}       — the model's reply was unusable
    {"status": "failed", "aiFailure": {...ai_status...}}  — the provider call failed
    """
    if (
        not isinstance(context, dict)
        or context.get("schema") != CONTEXT_SCHEMA
        or not isinstance(context.get("versionId"), str)
        or not isinstance(context.get("revision"), str)
        or not isinstance(context.get("inventory"), str)
        or not isinstance(context.get("cuts"), list)
        or not isinstance(context.get("candidates"), list)
    ):
        return {"status": "invalid-request", "reason": "The B-roll inventory to rank is missing or not understood."}
    if not context["cuts"] or not context["candidates"]:
        return {"status": "invalid-request", "reason": "There are no cuts or no candidates to rank."}
    if len(context["cuts"]) > MAX_CUTS or len(context["candidates"]) > MAX_CANDIDATES:
        return {"status": "invalid-request", "reason": "Too many cuts or candidates to rank at once."}

    brief = json.dumps({"context": context}, separators=(",", ":"))
    if len(brief) > MAX_BRIEF_CHARS:
        return {"status": "invalid-request", "reason": "This inventory is too large to send for ranking."}

    if reasoning_provider is None:
        reasoning_provider = pipeline._resolve_reasoning_provider()  # noqa: SLF001
        # One attempt only: no automatic (paid) SDK retries for a ranking
        # request. A fresh instance — analysis and /propose keep the default.
        if reasoning_provider is not None and hasattr(reasoning_provider, "max_retries"):
            reasoning_provider.max_retries = 0
    raw, entry = pipeline._call_ai(  # noqa: SLF001
        "coverage-rank", reasoning_provider, "reasoning", lambda: _rank_reply(reasoning_provider, brief)
    )
    if entry.get("status") != "succeeded":
        return {"status": "failed", "aiFailure": entry}
    if not isinstance(raw, dict):
        return {"status": "invalid-response", "reason": "The AI's reply could not be read."}
    if len(json.dumps(raw, default=str)) > MAX_REPLY_CHARS:
        return {"status": "invalid-response", "reason": "The AI's reply was too large to be a ranking."}

    status = raw.get("status")
    if status == "refused":
        reason = raw.get("reason")
        return {
            "status": "refused",
            "reason": reason.strip()[:1000] if isinstance(reason, str) and reason.strip() else "The AI found nothing to recommend.",
        }
    if status != "ranking" or not isinstance(raw.get("rankings"), list):
        return {"status": "invalid-response", "reason": "The AI's reply was not a usable ranking."}

    ranking = {
        "schema": RANKING_SCHEMA,
        "base": {
            "versionId": context["versionId"],
            "revision": context["revision"],
            "inventory": context["inventory"],
        },
    }
    # Everything else exactly as the model returned it — judged by the app.
    for key, value in raw.items():
        if key not in ENVELOPE:
            ranking[key] = value
    return {"status": "ranking", "ranking": ranking}
