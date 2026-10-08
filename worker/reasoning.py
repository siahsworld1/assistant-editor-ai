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
"sourceInTc": "<HH:MM:SS:FF>", "sourceOutTc": "<HH:MM:SS:FF>", \
"timelineStartSeconds": <number>, "durationSeconds": <number>, "selectId": "<select id or omit>"}]}
Only use clipIds and selectIds that were given to you. Keep timelineStartSeconds/durationSeconds \
internally consistent: interview events play back-to-back (each starts where the previous one ends).
CUT POINTS: an interview event's sourceInTc must be the startTc of one of the select's listed \
phrases and its sourceOutTc the endTc of one — never a time inside a phrase. To shorten a select, \
keep a run of whole phrases rather than cutting words off. Prefer starting where a sentence starts \
and ending where one ends, so each event is a complete thought; it is better to run somewhat over \
the target duration than to cut a thought in half. Don't start on an interviewer's question (a \
phrase ending in "?" just before the answer) unless the question is needed.
B-ROLL: when CLIP MATERIAL lists visual moments that support what is being said, you may add \
"b-roll" lane events — cutaways laid OVER the interview (the interview audio keeps playing \
underneath). For each, pick a clip and a source range around one of its listed visual moments \
(sourceInTc/sourceOutTc inside that clip's durationSeconds), and set timelineStartSeconds so it \
sits over the interview. B-roll does not advance the interview timeline, and b-roll events must \
not overlap each other. Prefer clips whose dialogue is "no (likely B-roll)".
JUMP CUTS: two consecutive interview events from the same clip are a jump cut (same camera and \
framing, the picture visibly jumps). Cover each with b-roll that starts about 1 second before the \
cut and runs at least 1 second after it — covering the start of the next statement is fine and \
expected here. Elsewhere, keep the speaker on camera for the most emotional moments. Only use \
visual moments that are listed — never invent footage."""


def build_timeline(provider: ReasoningProvider, build_brief: str) -> dict | None:
    text = provider.complete(BUILD_SYSTEM, [TextBlock(build_brief)], max_tokens=3072)
    result = extract_json(text)
    if isinstance(result, dict):
        return result
    return None


PROPOSE_SYSTEM = """You are the Director in Assistant Editor AI, an assistant editor working on a \
filmmaker's CURRENT edited sequence. The filmmaker asks for one change in plain language. You \
answer with a structured EDIT PROPOSAL that the application will validate, preview and only apply \
if the filmmaker accepts it. You never apply anything yourself.

You are given JSON: {"instruction": "...", "context": {...}}. The context describes the sequence:
- "fps" (sequence frames per second) and "durationFrames"; all timeline numbers are integer
  sequence frames.
- "clips": every clip on the timeline with its "id", "track" (V1 interview picture, V2 B-roll,
  A1 interview sync audio, A2 audio), "label", "file", "start"/"end" (sequence frames, end
  exclusive), "sourceIn"/"sourceOut" (frames at the clip's own "mediaFps"), "link" (clips sharing a
  link id move/trim/remove together), "owner" ("director" | "manual" | "unknown") and
  "locked"/"aiLocked".
- "selection": ids of the clips the filmmaker has selected ("this clip" means these).
- "evidence": analysis you may cite — "selects" (scored interview moments), "transcript"
  (timestamped text) and "visual" (logged moments), each with an "id".

You may ONLY use these operations, on existing clip ids:
  {"op": "move", "itemIds": ["<clip id>", ...], "deltaFrames": <non-zero integer>}
  {"op": "trim", "itemId": "<clip id>", "edge": "in" | "out", "deltaSourceFrames": <non-zero integer>}
     (source frames at that clip's mediaFps; "out" negative shortens, "in" positive shortens)
  {"op": "remove", "itemIds": ["<clip id>", ...], "ripple": true | false}

Hard rules:
- Never change a clip whose owner is "manual" or "unknown", or that is locked or aiLocked — not
  directly, not as linked audio, and not by a ripple that would shift it. If the request needs
  that, refuse.
- Never invent clips, files, timecodes or evidence ids. Cite evidence only by ids you were given.
- No other operations exist (no adding, replacing, reordering or splitting clips). If the request
  needs one, refuse and say what is not possible.
- If the request is ambiguous (e.g. which clip is meant is unclear), refuse and say what to clarify.
- Keep changes minimal and focused on what was asked.

Reply with ONLY one JSON object (no prose, no markdown fences), either:
{"status": "proposal", "summary": "<one or two sentences: what changes and why>",
 "operations": [ ... ],
 "rationale": [{"opIndex": <int>, "reason": "<short reason>", "evidence": [{"kind": "select"|"transcript"|"visual", "id": "<id>"}]}]}
or
{"status": "refused", "reason": "<one or two sentences the filmmaker will read>"}"""


def propose_edit(provider: ReasoningProvider, brief: str) -> dict | None:
    """Asks the model for an edit proposal against the current sequence. The
    reply is returned as parsed JSON (or None); it is never applied here —
    worker/director.py wraps it and the app validates it deterministically."""
    text = provider.complete(PROPOSE_SYSTEM, [TextBlock(brief)], max_tokens=2048)
    result = extract_json(text)
    return result if isinstance(result, dict) else None
