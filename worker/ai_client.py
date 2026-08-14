"""All calls to OpenAI (transcription) and Anthropic (vision + editorial reasoning).

Transcription always goes through OpenAI's Whisper API — Anthropic has no speech-to-text
product. Everything downstream (describing frames, ranking selects, assembling stories,
building a timeline) goes through Claude.

Every "ask the model for JSON" helper is defensive: models occasionally wrap JSON in
prose or code fences, so we extract the first top-level JSON value before parsing, and
callers treat a parse failure as "no results" rather than crashing the pipeline.
"""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("ASSISTANT_EDITOR_CLAUDE_MODEL", "claude-sonnet-4-5")


class ConfigError(RuntimeError):
    pass


def _openai_client():
    if not OPENAI_API_KEY:
        raise ConfigError("OPENAI_API_KEY is not set — transcription requires it.")
    from openai import OpenAI

    return OpenAI(api_key=OPENAI_API_KEY)


def _anthropic_client():
    if not ANTHROPIC_API_KEY:
        raise ConfigError("ANTHROPIC_API_KEY is not set — reasoning/vision requires it.")
    import anthropic

    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def transcribe_audio(wav_path: Path) -> list[dict]:
    """Returns a list of {startSeconds, endSeconds, text, confidence} segments."""
    client = _openai_client()
    with open(wav_path, "rb") as f:
        resp = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    segments = getattr(resp, "segments", None) or []
    out = []
    for seg in segments:
        seg_dict = seg if isinstance(seg, dict) else seg.model_dump()
        # Whisper doesn't return a per-segment confidence; avg_logprob is the closest
        # signal it does expose, so we convert it into an approximate 0..1 score.
        avg_logprob = seg_dict.get("avg_logprob", -0.2)
        confidence = max(0.0, min(1.0, 1.0 + (avg_logprob / 2.0)))
        out.append(
            {
                "startSeconds": float(seg_dict.get("start", 0.0)),
                "endSeconds": float(seg_dict.get("end", 0.0)),
                "text": str(seg_dict.get("text", "")).strip(),
                "confidence": round(confidence, 2),
            }
        )
    if not out:
        text = getattr(resp, "text", "") or ""
        if text.strip():
            out.append({"startSeconds": 0.0, "endSeconds": 0.0, "text": text.strip(), "confidence": 0.7})
    return out


def _extract_json(text: str):
    """Pulls the first balanced {...} or [...] out of a model response."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start_chars = "{["
    for i, ch in enumerate(text):
        if ch in start_chars:
            depth = 0
            opener = ch
            closer = "}" if opener == "{" else "]"
            for j in range(i, len(text)):
                if text[j] == opener:
                    depth += 1
                elif text[j] == closer:
                    depth -= 1
                    if depth == 0:
                        candidate = text[i : j + 1]
                        try:
                            return json.loads(candidate)
                        except json.JSONDecodeError:
                            break
            break
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _claude_json(system: str, user_content, max_tokens: int = 4096):
    client = _anthropic_client()
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
    )
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    parsed = _extract_json(text)
    return parsed


def _image_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode("ascii")
    media_type = "image/jpeg"
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


VISUAL_EVIDENCE_SYSTEM = """You are a documentary post-production assistant reviewing sampled \
frames from a video clip. For each frame that shows something editorially useful, describe it. \
Reply with ONLY a JSON array (no prose, no markdown fences), where each item is:
{"frameIndex": <1-based int matching the frame order shown>, "kind": "face"|"motion"|"scene"|"b-roll"|"graphic"|"technical", \
"label": "<short human description, e.g. 'Tears welling, sustained eye contact'>", "confidence": <0..1>}
Also include an entry with "kind":"technical" for any visible focus, exposure, or framing problem \
(e.g. soft focus, rolling shutter artifacts, blown highlights). If a frame shows nothing notable, omit it. \
If nothing at all is notable across every frame, reply with an empty JSON array: []"""


def analyze_frames(frame_paths: list[Path]) -> list[dict]:
    """Returns [{frameIndex, kind, label, confidence}, ...] describing sampled frames."""
    if not frame_paths:
        return []
    content = [
        {"type": "text", "text": f"These are {len(frame_paths)} frames sampled evenly across one clip, in order."}
    ]
    for p in frame_paths:
        content.append(_image_block(p))
    result = _claude_json(VISUAL_EVIDENCE_SYSTEM, content, max_tokens=2048)
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


def rank_selects(transcript_summary: str) -> list[dict]:
    result = _claude_json(
        SELECTS_SYSTEM,
        [{"type": "text", "text": transcript_summary}],
        max_tokens=4096,
    )
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


def propose_stories(selects_summary: str) -> list[dict]:
    result = _claude_json(
        STORIES_SYSTEM,
        [{"type": "text", "text": selects_summary}],
        max_tokens=3072,
    )
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


def build_timeline(build_brief: str) -> dict | None:
    result = _claude_json(
        BUILD_SYSTEM,
        [{"type": "text", "text": build_brief}],
        max_tokens=3072,
    )
    if isinstance(result, dict):
        return result
    return None
