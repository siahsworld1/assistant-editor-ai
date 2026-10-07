"""Dialogue validity: how far a clip's transcript can be trusted as real speech.

Whisper invents text on silent or music-only audio — classically a YouTube
outro ("Thanks for watching and don't forget to like and subscribe!"), often
in another language. The packaged validation footage showed exactly that on
three silent B-roll clips, so every clip reached the Director as "dialogue:
yes" and its "prefer clips without dialogue" rule could never apply.

This layer is deliberately conservative and evidence-based. It never edits or
deletes the transcript; it only labels it:

  - each segment: "speech" | "suspect" (filler pattern, near-zero confidence,
    or a high Whisper no-speech probability), plus whether it's in a different
    writing system from the project's dominant one (supporting evidence only)
  - each clip: "dialogue" | "non-dialogue" | "uncertain"

A language mismatch on its own never makes a clip non-dialogue — legitimate
multilingual speech stays dialogue — and ambiguous evidence stays "uncertain"
instead of being forced either way. Older saved analyses have no no-speech
probability; everything here works without it.
"""

from __future__ import annotations

import re
import unicodedata

DIALOGUE = "dialogue"
NON_DIALOGUE = "non-dialogue"
UNCERTAIN = "uncertain"

# Generic creator/outro lines Whisper produces on silence. Each pattern is a
# specific outro phrase (case-insensitive), so a real sentence that merely
# contains "thanks" or "subscribe" doesn't match.
_FILLER_PATTERNS = [
    r"thanks? (you )?(so much )?for watching",
    r"(don'?t forget to|please|like and) subscribe",
    r"subscribe to (my|our|the) channel",
    r"like,? (comment,? )?(and|&) subscribe",
    r"see you (guys )?(in the )?next (video|time)",
    r"subtitles? (by|created by)",
    r"amara\.org",
    # Common non-English equivalents of the same outro.
    r"ご視聴ありがとうございました",
    r"チャンネル登録",
    r"시청해 ?주셔서 ?감사합니다",
    r"구독.{0,8}좋아요|좋아요.{0,8}구독",
    r"abone ol",
    r"videoyu beğen",
    r"gracias por ver",
    r"suscr[ií]bete",
    r"merci d'avoir regard[ée]",
    r"abonnez-vous",
    r"danke f[üu]rs zuschauen",
    r"感谢观看",
    r"请订阅",
    r"谢谢观看",
]
_FILLER_RE = re.compile("|".join(f"(?:{p})" for p in _FILLER_PATTERNS), re.IGNORECASE)

# Whisper's no_speech_prob: above this, the segment is probably not speech.
NO_SPEECH_SUSPECT = 0.6
# confidence is derived from avg_logprob (1 + logprob/2); <= 0.25 means the
# model was guessing (avg_logprob <= -1.5).
LOW_CONFIDENCE = 0.25


def is_filler(text: str) -> bool:
    return bool(_FILLER_RE.search(text or ""))


def script_of(text: str) -> str | None:
    """The dominant writing system of a string ('latin', 'cjk', 'hangul', …),
    or None when it has no letters."""
    counts: dict[str, int] = {}
    for ch in text or "":
        if not ch.isalpha():
            continue
        name = unicodedata.name(ch, "")
        if name.startswith("LATIN"):
            key = "latin"
        elif name.startswith("HANGUL"):
            key = "hangul"
        elif name.startswith(("CJK", "HIRAGANA", "KATAKANA")):
            key = "cjk"
        elif name.startswith("CYRILLIC"):
            key = "cyrillic"
        elif name.startswith("ARABIC"):
            key = "arabic"
        elif name.startswith("HEBREW"):
            key = "hebrew"
        elif name.startswith("GREEK"):
            key = "greek"
        elif name.startswith("DEVANAGARI"):
            key = "devanagari"
        else:
            key = "other"
        counts[key] = counts.get(key, 0) + 1
    return max(counts, key=counts.get) if counts else None


def segment_flags(seg: dict) -> list[str]:
    """Why a segment looks unlike real speech (empty list = no doubt)."""
    flags = []
    if is_filler(seg.get("text", "")):
        flags.append("filler")
    nsp = seg.get("noSpeechProb")
    if isinstance(nsp, (int, float)) and nsp >= NO_SPEECH_SUSPECT:
        flags.append("no-speech")
    conf = seg.get("confidence")
    if isinstance(conf, (int, float)) and conf <= LOW_CONFIDENCE:
        flags.append("low-confidence")
    return flags


def is_suspect(seg: dict) -> bool:
    return bool(segment_flags(seg))


def dominant_script(transcript: list[dict]) -> str | None:
    """The project's main writing system, weighted by text length, from
    segments that aren't themselves suspect."""
    weight: dict[str, int] = {}
    for seg in transcript:
        if is_suspect(seg):
            continue
        s = script_of(seg.get("text", ""))
        if s:
            weight[s] = weight.get(s, 0) + len(seg.get("text", ""))
    return max(weight, key=weight.get) if weight else None


def assess_clip(clip, segments: list[dict], visual: list[dict], project_script: str | None) -> dict:
    """{status, reasons} for one clip, combining transcript content,
    no-speech/confidence signals, writing system and visual evidence."""
    ai = getattr(clip, "ai", {}) or {}
    tr = ai.get("transcription") or {}
    if not segments:
        if tr.get("status") == "failed":
            return {"status": UNCERTAIN, "reasons": ["transcription failed"]}
        if tr.get("status") == "not-applicable" or not getattr(clip, "has_transcript", False):
            return {"status": NON_DIALOGUE, "reasons": ["no speech transcribed"]}
        return {"status": UNCERTAIN, "reasons": ["no transcript segments"]}

    clean, suspect, foreign = [], [], []
    for seg in segments:
        if is_suspect(seg):
            suspect.append(seg)
        elif project_script and script_of(seg.get("text", "")) not in (None, project_script):
            foreign.append(seg)
        else:
            clean.append(seg)
    kinds = {v.get("kind") for v in visual}
    has_face = "face" in kinds
    broll_visual = bool(kinds & {"b-roll", "graphic", "scene"}) and not has_face

    reasons = []
    if suspect:
        reasons.append(f"{len(suspect)} of {len(segments)} segments look like transcription filler/noise")
    if foreign:
        reasons.append(f"{len(foreign)} segments in a different language from the project")

    if clean:
        return {"status": DIALOGUE, "reasons": reasons or ["speech in transcript"]}
    if foreign:
        # Different-language speech that isn't otherwise suspicious is NOT
        # discarded: it's dialogue unless other evidence points away from it.
        if suspect or broll_visual:
            if broll_visual:
                reasons.append("visuals look like B-roll (no faces logged)")
            return {"status": UNCERTAIN, "reasons": reasons}
        return {"status": DIALOGUE, "reasons": reasons}
    # Every segment is suspect.
    if has_face:
        reasons.append("a face is logged on camera")
        return {"status": UNCERTAIN, "reasons": reasons}
    return {"status": NON_DIALOGUE, "reasons": reasons}


def assess_project(clips: dict, transcript: list[dict], visual_evidence: list[dict]) -> dict[str, dict]:
    """clipId -> {status, reasons} for every clip."""
    project_script = dominant_script(transcript)
    by_clip: dict[str, list[dict]] = {}
    for seg in transcript:
        by_clip.setdefault(seg.get("clipId", ""), []).append(seg)
    vis: dict[str, list[dict]] = {}
    for v in visual_evidence:
        vis.setdefault(v.get("clipId", ""), []).append(v)
    return {
        cid: assess_clip(c, by_clip.get(cid, []), vis.get(cid, []), project_script)
        for cid, c in clips.items()
    }
