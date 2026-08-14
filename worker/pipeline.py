"""Orchestrates a full analysis pass: walk media -> ffprobe -> transcribe ->
sample + describe frames (vision) -> rank selects -> propose stories. Also
builds a timeline for POST /build. Designed so a failure on one clip never
kills the whole run — clips that error are marked state="error" and skipped
for downstream reasoning, but everything else still completes.

This module knows nothing about which AI vendor answers a call — it resolves a
TranscriptionProvider and a ReasoningProvider once per run (via
providers/registry.py, env-var-selected) and passes them down to
worker/reasoning.py, which holds the actual prompts/business logic. Every
function that needs a provider also accepts one as an optional parameter so
tests can inject a fake (worker/tests/fakes.py) without touching the registry,
an API key, or the network at all.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import traceback
from pathlib import Path

import media
import reasoning
from providers.base import ProviderError, ReasoningProvider, TranscriptionProvider
from providers.registry import get_reasoning_provider, get_transcription_provider
from store import STORE, ClipState

log = logging.getLogger("assistant-editor-worker")

MAX_TRANSCRIPT_CHARS = 160_000
FRAMES_PER_CLIP = 6


def run_analysis(project_id: str | None, media_root: str | None):
    try:
        _run_analysis(project_id, media_root)
    except Exception as exc:  # noqa: BLE001 - top-level background job guard
        log.error("analysis failed: %s\n%s", exc, traceback.format_exc())
        STORE.fail(str(exc))


def _resolve_transcription_provider() -> TranscriptionProvider | None:
    try:
        return get_transcription_provider()
    except ProviderError as exc:
        log.warning("transcription provider unavailable: %s", exc)
        return None


def _resolve_reasoning_provider() -> ReasoningProvider | None:
    try:
        return get_reasoning_provider()
    except ProviderError as exc:
        log.warning("reasoning provider unavailable: %s", exc)
        return None


def _run_analysis(project_id: str | None, media_root: str | None):
    STORE.begin_analysis(project_id, media_root)

    if not media_root:
        STORE.fail("No media folder is set for this project yet. Use Import Media first.")
        return
    if not media.ffmpeg_available():
        STORE.fail("ffmpeg/ffprobe not found on PATH. Install with `brew install ffmpeg` and restart the worker.")
        return

    files = media.walk_media_root(media_root)
    if not files:
        STORE.fail(f"No supported media files found under {media_root}.")
        return

    # Resolved once per run, independently — a missing OPENAI_API_KEY only
    # degrades transcription; a missing ANTHROPIC_API_KEY (or whichever vendor
    # is configured for reasoning) only degrades vision/selects/stories. Neither
    # failure crashes the run.
    transcription_provider = _resolve_transcription_provider()
    reasoning_provider = _resolve_reasoning_provider()

    tmp_root = Path(tempfile.mkdtemp(prefix="ae-worker-"))
    try:
        total = len(files)
        for idx, path in enumerate(files):
            clip_id = f"clip-{idx + 1:03d}"
            _analyze_one_clip(clip_id, path, tmp_root, transcription_provider, reasoning_provider)
            # Leave headroom (up to 70%) for the reasoning passes that follow.
            STORE.set_progress(int(((idx + 1) / total) * 70))

        STORE.set_progress(75)
        _generate_selects(reasoning_provider)
        STORE.set_progress(88)
        _generate_stories(reasoning_provider)
        STORE.complete()
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _analyze_one_clip(
    clip_id: str,
    path: Path,
    tmp_root: Path,
    transcription_provider: TranscriptionProvider | None,
    reasoning_provider: ReasoningProvider | None,
):
    ext = path.suffix.lower()
    role = media.role_for_file(path.name, ext)
    speaker = media.speaker_for_file(path.name)
    info = media.ffprobe_info(path)

    try:
        rel_path = str(path.relative_to(STORE.media_root)) if STORE.media_root else path.name
    except ValueError:
        rel_path = path.name

    clip = ClipState(
        id=clip_id,
        filename=path.name,
        rel_path=rel_path,
        role=role,
        duration_seconds=round(info["duration"], 1),
        camera=info["camera"],
        resolution=info["resolution"],
        fps=info["fps"] or 24.0,
        speakers=[speaker] if (role == "interview" and speaker) else [],
        state="analyzing",
    )
    STORE.upsert_clip(clip)

    technical_issues: list[str] = []
    clip_dir = tmp_root / clip_id
    clip_dir.mkdir(parents=True, exist_ok=True)

    try:
        if info["has_audio"]:
            wav_path = clip_dir / "audio.wav"
            if media.extract_audio(path, wav_path):
                technical_issues.extend(media.detect_hum(wav_path))
                segments = []
                if transcription_provider is None:
                    log.warning("transcription skipped for %s: no transcription provider available", path.name)
                else:
                    try:
                        segments = reasoning.transcribe_audio(transcription_provider, wav_path)
                    except ProviderError as exc:
                        log.warning("transcription skipped for %s: %s", path.name, exc)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("transcription failed for %s: %s", path.name, exc)
                speaker_label = speaker or "Unknown speaker"
                for i, seg in enumerate(segments):
                    if not seg.get("text"):
                        continue
                    STORE.transcript.append(
                        {
                            "id": f"{clip_id}-t{i + 1}",
                            "clipId": clip_id,
                            "speaker": speaker_label,
                            "startTc": media.seconds_to_tc(seg["startSeconds"], clip.fps),
                            "endTc": media.seconds_to_tc(seg["endSeconds"], clip.fps),
                            "text": seg["text"],
                            "confidence": seg.get("confidence", 0.7),
                        }
                    )
                clip.has_transcript = any(t["clipId"] == clip_id for t in STORE.transcript)

        if ext not in media.AUDIO_ONLY_EXTENSIONS:
            frames = media.extract_frames(path, clip_dir / "frames", FRAMES_PER_CLIP)
            if frames:
                findings = []
                if reasoning_provider is None:
                    log.warning("visual analysis skipped for %s: no reasoning provider available", path.name)
                else:
                    try:
                        findings = reasoning.analyze_frames(reasoning_provider, frames)
                    except ProviderError as exc:
                        log.warning("visual analysis skipped for %s: %s", path.name, exc)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("visual analysis failed for %s: %s", path.name, exc)
                evidence_count = 0
                for i, item in enumerate(findings):
                    frame_index = item.get("frameIndex")
                    if not isinstance(frame_index, int):
                        frame_index = i + 1
                    at_tc = media.frame_timecode(frame_index - 1, len(frames), info["duration"], clip.fps)
                    kind = item.get("kind") if item.get("kind") in {
                        "face", "motion", "scene", "b-roll", "graphic", "technical",
                    } else "scene"
                    label = str(item.get("label", "")).strip()
                    if not label:
                        continue
                    if kind == "technical":
                        technical_issues.append(label)
                        continue
                    evidence_count += 1
                    STORE.visual_evidence.append(
                        {
                            "id": f"{clip_id}-v{i + 1}",
                            "clipId": clip_id,
                            "kind": kind,
                            "label": label,
                            "atTc": at_tc,
                            "confidence": float(item.get("confidence", 0.6)),
                        }
                    )
                clip.visual_evidence_count = evidence_count

        clip.technical_issues = list(dict.fromkeys(technical_issues))
        clip.state = "analyzed"
        clip.progress = 100
    except Exception as exc:  # noqa: BLE001 - one bad clip must not kill the run
        log.error("clip %s failed: %s\n%s", path.name, exc, traceback.format_exc())
        clip.state = "error"
        clip.note = str(exc)[:200]
    finally:
        STORE.upsert_clip(clip)
        shutil.rmtree(clip_dir, ignore_errors=True)


def _clip_lookup() -> dict:
    with STORE._lock:  # noqa: SLF001 - internal, single-process, read-only snapshot
        return dict(STORE.clips)


def _generate_selects(reasoning_provider: ReasoningProvider | None = None):
    clips = _clip_lookup()
    if not STORE.transcript:
        STORE.selects = []
        return
    lines = ["CLIPS:"]
    for c in clips.values():
        if c.role == "interview":
            lines.append(f"- {c.id}: {c.filename} (speaker: {', '.join(c.speakers) or 'unknown'})")
    lines.append("\nTRANSCRIPT (clipId | speaker | startTc | endTc | text):")
    for t in STORE.transcript:
        lines.append(f"{t['clipId']} | {t['speaker']} | {t['startTc']} | {t['endTc']} | {t['text']}")
    if STORE.visual_evidence:
        lines.append("\nVISUAL EVIDENCE (clipId | kind | label | atTc):")
        for v in STORE.visual_evidence:
            lines.append(f"{v['clipId']} | {v['kind']} | {v['label']} | {v['atTc']}")
    summary = "\n".join(lines)[:MAX_TRANSCRIPT_CHARS]

    raw = []
    if reasoning_provider is None:
        log.warning("select ranking skipped: no reasoning provider available")
    else:
        try:
            raw = reasoning.rank_selects(reasoning_provider, summary)
        except ProviderError as exc:
            log.warning("select ranking skipped: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.error("select ranking failed: %s", exc)

    selects = []
    for i, item in enumerate(sorted(raw, key=lambda r: r.get("score", 0), reverse=True)):
        clip_id = str(item.get("clipId", ""))
        clip = clips.get(clip_id)
        fps = clip.fps if clip else 24.0
        start_s = float(item.get("startSeconds", 0) or 0)
        end_s = float(item.get("endSeconds", start_s) or start_s)
        selects.append(
            {
                "id": f"sel-{i + 1:02d}",
                "rank": i + 1,
                "speaker": str(item.get("speaker", "Unknown speaker")),
                "clipId": clip_id,
                "clipName": clip.filename if clip else str(item.get("clipName", "—")),
                "startTc": media.seconds_to_tc(start_s, fps),
                "endTc": media.seconds_to_tc(end_s, fps),
                "durationSeconds": round(max(0.0, end_s - start_s), 1),
                "score": max(0, min(100, int(item.get("score", 50)))),
                "category": item.get("category") if item.get("category") in {
                    "strong-statement", "emotional", "context", "humor", "closing",
                } else "context",
                "transcriptExcerpt": str(item.get("transcriptExcerpt", "")),
                "reasons": [str(r) for r in item.get("reasons", []) if isinstance(r, (str, int, float))],
                "evidence": [
                    {
                        "kind": e.get("kind") if e.get("kind") in {"transcript", "visual", "audio", "emotion"} else "transcript",
                        "detail": str(e.get("detail", "")),
                    }
                    for e in item.get("evidence", [])
                    if isinstance(e, dict)
                ],
            }
        )
    STORE.selects = selects


def _generate_stories(reasoning_provider: ReasoningProvider | None = None):
    if not STORE.selects:
        STORE.stories = []
        return
    lines = ["SELECTS:"]
    for s in STORE.selects:
        lines.append(
            f"{s['id']} | {s['speaker']} | {s['category']} | score {s['score']} | \"{s['transcriptExcerpt']}\""
        )
    summary = "\n".join(lines)[:MAX_TRANSCRIPT_CHARS]

    raw = []
    if reasoning_provider is None:
        log.warning("story generation skipped: no reasoning provider available")
    else:
        try:
            raw = reasoning.propose_stories(reasoning_provider, summary)
        except ProviderError as exc:
            log.warning("story generation skipped: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.error("story generation failed: %s", exc)

    valid_ids = {s["id"] for s in STORE.selects}
    stories = []
    for i, item in enumerate(raw):
        beats = []
        for j, b in enumerate(item.get("beats", []) or []):
            if not isinstance(b, dict):
                continue
            beats.append(
                {
                    "id": f"story-{i + 1}-beat-{j + 1}",
                    "label": str(b.get("label", f"Beat {j + 1}")),
                    "intent": str(b.get("intent", "")),
                    "estimatedSeconds": int(b.get("estimatedSeconds", 30) or 30),
                    "selectIds": [sid for sid in b.get("selectIds", []) if sid in valid_ids],
                }
            )
        supporting = [sid for sid in item.get("supportingSelectIds", []) if sid in valid_ids]
        confidence = float(item.get("confidence", 0.6) or 0.6)
        stories.append(
            {
                "id": f"story-{i + 1:02d}",
                "title": str(item.get("title", f"Story {i + 1}")),
                "premise": str(item.get("premise", "")),
                "estimatedSeconds": sum(b["estimatedSeconds"] for b in beats) or 120,
                "confidence": confidence if confidence <= 1 else confidence / 100,
                "beats": beats,
                "supportingSelectIds": supporting or [b for beat in beats for b in beat["selectIds"]],
            }
        )
    STORE.stories = stories


def _validate_decisions(decisions: list, clips: dict) -> tuple[list, list[str]]:
    """Drops any decision that doesn't reference a real, known clip or whose
    source in/out timecodes don't parse or fall outside that clip's actual
    duration. This is the "validated edit decisions" gate — nothing downstream
    (preview, export) should ever see a decision that wasn't checked here."""
    valid: list = []
    warnings: list[str] = []
    for i, d in enumerate(decisions):
        if not isinstance(d, dict):
            continue
        label = str(d.get("label", f"event {i + 1}"))
        clip_id = str(d.get("clipId", ""))
        clip = clips.get(clip_id)
        if not clip:
            warnings.append(f"Dropped '{label}': references unknown clipId '{clip_id}'.")
            continue
        fps = clip.fps or 24.0
        in_s = media.tc_to_seconds(str(d.get("sourceInTc", "")), fps)
        out_s = media.tc_to_seconds(str(d.get("sourceOutTc", "")), fps)
        if in_s is None or out_s is None:
            warnings.append(f"Dropped '{label}': unparsable source timecode.")
            continue
        if out_s <= in_s:
            warnings.append(f"Dropped '{label}': source out is not after source in.")
            continue
        # Small tolerance for rounding at the tail of a clip.
        if clip.duration_seconds > 0 and out_s > clip.duration_seconds + 0.5:
            warnings.append(
                f"Dropped '{label}': source out ({out_s:.1f}s) exceeds clip duration ({clip.duration_seconds:.1f}s)."
            )
            continue
        valid.append(d)
    return valid, warnings


def build_timeline(
    project_id: str | None,
    story_id: str | None,
    target_seconds: float,
    command: str | None,
    reasoning_provider: ReasoningProvider | None = None,
) -> dict:
    """reasoning_provider is optional and DI-friendly: production (server.py)
    leaves it unset and this resolves one from the registry; tests pass a fake
    directly (see worker/tests/fakes.py) with no API key or network involved."""
    story = next((s for s in STORE.stories if s["id"] == story_id), None) or (
        STORE.stories[0] if STORE.stories else None
    )
    selects_by_id = {s["id"]: s for s in STORE.selects}

    if not story or not STORE.selects:
        return {
            "summary": "No analyzed selects are available yet — run Analyze first.",
            "changes": [],
            "decisions": [],
        }

    lines = [
        f"STORY: {story['title']} — {story['premise']}",
        f"TARGET SECONDS: {target_seconds}",
    ]
    if command:
        lines.append(f"DIRECTOR NOTE: {command}")
    lines.append("\nBEATS:")
    for b in story["beats"]:
        lines.append(f"- {b['label']} ({b['intent']}): selects {b['selectIds']}")
    lines.append("\nAVAILABLE SELECTS (id | clipId | startTc | endTc | durationSeconds | excerpt):")
    for s in STORE.selects:
        lines.append(
            f"{s['id']} | {s['clipId']} | {s['startTc']} | {s['endTc']} | {s['durationSeconds']} | \"{s['transcriptExcerpt']}\""
        )
    brief = "\n".join(lines)[:MAX_TRANSCRIPT_CHARS]

    if reasoning_provider is None:
        reasoning_provider = _resolve_reasoning_provider()

    result = None
    if reasoning_provider is not None:
        try:
            result = reasoning.build_timeline(reasoning_provider, brief)
        except ProviderError as exc:
            log.warning("build skipped: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.error("build failed: %s", exc)

    clips = _clip_lookup()
    if result and isinstance(result.get("decisions"), list) and result["decisions"]:
        validated, warnings = _validate_decisions(result["decisions"], clips)
        if validated:
            changes = [str(c) for c in result.get("changes", [])] + warnings
            return {
                "summary": str(result.get("summary", "Engine returned a new assembly.")),
                "changes": changes,
                "decisions": validated,
            }
        log.warning("build_timeline: model result had zero valid decisions (%s); using fallback", warnings)

    # Deterministic fallback: lay the story's selects back-to-back in beat order so
    # /build always returns something usable even if the model call fails.
    decisions = []
    cursor = 0.0
    ordered_ids = [sid for beat in story["beats"] for sid in beat["selectIds"]] or list(selects_by_id.keys())
    for i, sid in enumerate(ordered_ids):
        sel = selects_by_id.get(sid)
        if not sel:
            continue
        decisions.append(
            {
                "id": f"event-{i + 1}",
                "lane": "interview",
                "clipId": sel["clipId"],
                "label": f"{sel['speaker']} — {sel['transcriptExcerpt'][:40]}",
                "sourceInTc": sel["startTc"],
                "sourceOutTc": sel["endTc"],
                "timelineStartSeconds": round(cursor, 1),
                "durationSeconds": sel["durationSeconds"],
                "selectId": sid,
            }
        )
        cursor += sel["durationSeconds"]
    validated, warnings = _validate_decisions(decisions, clips)
    return {
        "summary": f"Assembled '{story['title']}' from {len(validated)} selects (fallback assembly — the reasoning model was unavailable or returned nothing valid).",
        "changes": ["Concatenated story selects in beat order", *warnings],
        "decisions": validated,
    }
