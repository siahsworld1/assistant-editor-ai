"""The editorial-reasoning architecture: every prompt Assistant Editor AI sends
to a reasoning model, and the logic that turns raw model output into the app's
real data shapes (visual evidence, selects, stories, timeline decisions).

This module is intentionally vendor-agnostic — it never imports openai or
anthropic, and never decides *which* vendor answers a call. It talks only to
the TranscriptionProvider / ReasoningProvider interfaces in
worker/providers/base.py, passed in by the caller (worker/pipeline.py, which
resolves a concrete provider via worker/providers/registry.py, or a test, which
injects a fake — see worker/tests/fakes.py).

This split is deliberate and is where the app's actual proprietary value lives:
the prompts, the JSON schemas demanded back, the validation of what a model
returns, and the domain logic that turns that into selects/stories/timeline
data. Swapping the vendor behind ReasoningProvider changes none of it.
"""

from __future__ import annotations

from pathlib import Path

from providers.base import ImageBlock, ProviderError, ReasoningProvider, TextBlock, TranscriptionProvider
from providers.json_utils import extract_json

# Re-exported so callers can catch one exception type without importing
# providers.base directly — kept as an alias for readability at call sites
# ("no provider configured" reads more clearly as a config problem).
ConfigError = ProviderError


def transcribe_audio(provider: TranscriptionProvider, wav_path: Path) -> list[dict]:
    """Returns a list of {startSeconds, endSeconds, text, confidence} segments."""
    segments = provider.transcribe(wav_path)
    return [s.to_json() for s in segments]


VISUAL_EVIDENCE_SYSTEM = """You are a documentary post-production assistant reviewing sampled \
frames from a video clip. For each frame that shows something editorially useful, describe it. \
Reply with ONLY a JSON array (no prose, no markdown fences), where each item is:
{"frameIndex": <1-based int matching the frame order shown>, "kind": "face"|"motion"|"scene"|"b-roll"|"graphic"|"technical", \
"label": "<short human description, e.g. 'Tears welling, sustained eye contact'>", "confidence": <0..1>}
Also include an entry with "kind":"technical" for any visible focus, exposure, or framing problem \
(e.g. soft focus, rolling shutter artifacts, blown highlights). If a frame shows nothing notable, omit it. \
If nothing at all is notable across every frame, reply with an empty JSON array: []"""


def analyze_frames(provider: ReasoningProvider, frame_paths: list[Path]) -> list[dict]:
    """Returns [{frameIndex, kind, label, confidence}, ...] describing sampled frames."""
    if not frame_paths:
        return []
    content = [
        TextBlock(f"These are {len(frame_paths)} frames sampled evenly across one clip, in order.")
    ]
    for p in frame_paths:
        content.append(ImageBlock(p))
    text = provider.complete(VISUAL_EVIDENCE_SYSTEM, content, max_tokens=2048)
    result = extract_json(text)
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    return []


SELECTS_SYSTEM = """You are a senior documentary editor's assistant. You are given a full \
transcript (as timestamped segments grouped by clip and speaker) plus notes on visual evidence \
found in each clip. Identify the strongest "selects" — short quotable moments worth cutting into \
the film. Reply with ONLY a JSON array (no prose, no markdown fences). Each item:
{"speaker": "<name>", "clipId": "<clip id from the input>", "clipName": "<filename>", \
"startSeconds": <number>, "endSeconds": <number>, "score": <0-100 int>, \
"category": "strong-statement"|"emotional"|"context"|"humor"|"closing", \
"transcriptExcerpt": "<verbatim quote>", "reasons": ["<short reason>", ...], \
"evidence": [{"kind":"transcript"|"visual"|"audio"|"emotion", "detail":"<short detail>"}]}
Aim for 4-10 selects across the whole project, ranked roughly by how strong the material is \
(the array order does not need to be sorted — rank is inferred separately). Only use quotes and \
timestamps that actually appear in the transcript you were given — never invent dialogue."""


def rank_selects(provider: ReasoningProvider, transcript_summary: str) -> list[dict]:
    text = provider.complete(SELECTS_SYSTEM, [TextBlock(transcript_summary)], max_tokens=4096)
    result = extract_json(text)
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    return []


STORIES_SYSTEM = """You are a documentary story editor. You are given a ranked list of "selects" \
(short quotable moments with an id, speaker, category and excerpt). Propose 2-3 distinct story \
assemblies that could be cut from this material — different structures/angles, not just \
reorderings. Reply with ONLY a JSON array (no prose, no markdown fences). Each item:
{"title": "<short title>", "premise": "<1-2 sentence logline>", "confidence": <0..1>, \
"beats": [{"label": "<beat name>", "intent": "<what this beat accomplishes>", \
"estimatedSeconds": <int>, "selectIds": ["<select id>", ...]}], \
"supportingSelectIds": ["<select id>", ...]}
Only reference select ids that were given to you."""


def propose_stories(provider: ReasoningProvider, selects_summary: str) -> list[dict]:
    text = provider.complete(STORIES_SYSTEM, [TextBlock(selects_summary)], max_tokens=3072)
    result = extract_json(text)
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    return []


BUILD_SYSTEM = """You are assembling a rough-cut timeline for a documentary editor. You are given \
a chosen story (with beats), the full list of available selects (with real in/out timecodes), a \
target duration in seconds, and optionally a freeform director's note. Produce a sequence of \
timeline events that realizes the story using the given selects, in order, respecting the target \
duration as closely as reasonably possible. Reply with ONLY a JSON object (no prose, no markdown \
fences):
{"summary": "<1-2 sentence summary of what this assembly does>", \
"changes": ["<short change note>", ...], \
"decisions": [{"lane": "interview"|"b-roll"|"audio", "clipId": "<clip id>", "label": "<short label>", \
"sourceInTc": "<HH:MM:SS:FF from the select's startTc>", "sourceOutTc": "<HH:MM:SS:FF from the select's endTc>", \
"timelineStartSeconds": <number>, "durationSeconds": <number>, "selectId": "<select id or omit>"}]}
Only use clipIds and selectIds that were given to you. Keep timelineStartSeconds/durationSeconds \
internally consistent (each event starts where the previous one ends, on the same lane ordering \
given)."""


def build_timeline(provider: ReasoningProvider, build_brief: str) -> dict | None:
    text = provider.complete(BUILD_SYSTEM, [TextBlock(build_brief)], max_tokens=3072)
    result = extract_json(text)
    if isinstance(result, dict):
        return result
    return None
