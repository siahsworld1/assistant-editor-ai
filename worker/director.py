"""Director AI 2.0, Phase 5 — sequence-aware edit proposals.

POST /propose receives the filmmaker's instruction and a compact description of
the CURRENT edited sequence (built by the app: src/lib/timeline/ai-context.ts),
asks the configured reasoning provider for a proposal, and returns it wrapped
in the app's EditProposal schema (ae.proposal/1).

Nothing here executes, filters or "fixes" an edit. The model's operations are
passed through exactly as returned, bound to the sequence revision the app
sent; the app's deterministic proposal engine (src/lib/timeline/proposals.ts)
is the single judge of whether they are valid, safe and current. A proposal
can never authorize itself: the wrapper carries only schema, id, instruction,
summary, base, operations and rationale.

Provider failures are reported with the same structured, credential-free
entries as the rest of the worker (ai_status.failed); the provider is resolved
from the existing registry, or injected by tests.
"""

from __future__ import annotations

import hashlib
import json
import logging

import pipeline
import reasoning
from providers.base import ReasoningProvider

log = logging.getLogger("assistant-editor-worker.director")

CONTEXT_SCHEMA = "ae.context/1"
PROPOSAL_SCHEMA = "ae.proposal/1"
MAX_INSTRUCTION_CHARS = 2000
# The app keeps the context compact; this is a hard ceiling on what is sent on.
MAX_BRIEF_CHARS = 120_000
# A reply bigger than this is not a proposal (the app enforces the same limit).
MAX_REPLY_CHARS = 64_000


def _refused(reason: str) -> dict:
    return {"status": "refused", "reason": reason}


def propose(instruction, context, reasoning_provider: ReasoningProvider | None = None) -> dict:
    """Returns one of:
    {"status": "proposal", "proposal": {...ae.proposal/1...}}
    {"status": "refused", "reason": "..."}                — the Director declined
    {"status": "invalid-request", "reason": "..."}        — the app sent something unusable
    {"status": "invalid-response", "reason": "..."}       — the model's reply was unreadable
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
        or not isinstance(context.get("clips"), list)
    ):
        return {"status": "invalid-request", "reason": "The sequence description is missing or not understood."}

    brief = json.dumps({"instruction": instruction.strip(), "context": context}, separators=(",", ":"))
    if len(brief) > MAX_BRIEF_CHARS:
        return {"status": "invalid-request", "reason": "This sequence is too large to send to the Director."}

    if reasoning_provider is None:
        reasoning_provider = pipeline._resolve_reasoning_provider()  # noqa: SLF001
    raw, entry = pipeline._call_ai(  # noqa: SLF001
        "director", reasoning_provider, "reasoning", lambda: reasoning.propose_edit(reasoning_provider, brief)
    )
    if entry.get("status") != "succeeded":
        return {"status": "failed", "aiFailure": entry}
    if not isinstance(raw, dict):
        return {"status": "invalid-response", "reason": "The Director's reply could not be read. Try again."}
    if len(json.dumps(raw, default=str)) > MAX_REPLY_CHARS:
        return {"status": "invalid-response", "reason": "The Director's reply was too large to be a proposal."}

    status = raw.get("status")
    if status == "refused":
        reason = raw.get("reason")
        return _refused(str(reason)[:1000] if isinstance(reason, str) and reason.strip() else "The Director can't do that.")
    if status != "proposal" or not isinstance(raw.get("operations"), list):
        return {"status": "invalid-response", "reason": "The Director's reply was not a usable proposal. Try again."}

    digest = hashlib.sha256(
        json.dumps([instruction, context["revision"], raw.get("operations")], sort_keys=True).encode()
    ).hexdigest()[:24]
    summary = raw.get("summary")
    proposal = {
        "schema": PROPOSAL_SCHEMA,
        "id": f"prp_ai_{digest}",
        "instruction": instruction.strip(),
        "summary": summary.strip()[:2000] if isinstance(summary, str) and summary.strip() else "Director proposal.",
        "base": {"versionId": context["versionId"], "revision": context["revision"]},
        # Exactly as the model returned them — validated by the app, never here.
        "operations": raw["operations"],
    }
    if raw.get("rationale") is not None:
        proposal["rationale"] = raw["rationale"]
    return {"status": "proposal", "proposal": proposal}
