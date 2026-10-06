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
import math
import re
import shutil
import tempfile
import traceback
from pathlib import Path

import ai_status
import media
import persistence
import reasoning
from providers.base import ProviderError, ReasoningProvider, TranscriptionProvider
from providers.registry import (
    DEFAULT_REASONING_PROVIDER,
    DEFAULT_TRANSCRIPTION_PROVIDER,
    REASONING_PROVIDER_ENV,
    TRANSCRIPTION_PROVIDER_ENV,
    get_reasoning_provider,
    get_transcription_provider,
)
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


def retry_failed_ai():
    """Re-runs ONLY the AI steps that failed in the loaded analysis — per clip
    (transcription, visual analysis) — then selects and stories if their input
    changed or they failed themselves. Metadata, proxies, thumbnails, clip ids,
    every successful result and the analysis id are kept, so saved cuts (built
    on those clips) stay valid."""
    try:
        _retry_failed_ai()
    except Exception as exc:  # noqa: BLE001 - top-level background job guard
        log.error("AI retry failed: %s\n%s", exc, traceback.format_exc())
        STORE.fail(str(exc))


def failed_ai_steps() -> list[tuple[str, str]]:
    """(clipId, task) for every failed per-clip AI step of the loaded analysis."""
    with STORE._lock:  # noqa: SLF001
        return [
            (clip.id, task)
            for clip in STORE.clips.values()
            for task, entry in clip.ai.items()
            if entry.get("status") == "failed"
        ]


def _retry_failed_ai():
    STORE.begin_retry()
    steps = failed_ai_steps()
    project_failed = {t for t, e in STORE.ai_tasks.items() if e.get("status") == "failed"}
    transcription_provider = _resolve_transcription_provider() if any(t == "transcription" for _, t in steps) else None
    reasoning_provider = _resolve_reasoning_provider()
    tmp_root = Path(tempfile.mkdtemp(prefix="ae-worker-retry-"))
    try:
        recovered = False
        for idx, (clip_id, task) in enumerate(steps):
            clip = STORE.clips[clip_id]
            path = Path(STORE.media_root or "") / clip.rel_path
            work_dir = tmp_root / f"{clip_id}-{task}"
            work_dir.mkdir(parents=True, exist_ok=True)
            issues = list(clip.technical_issues)
            if task == "transcription":
                speaker = clip.speakers[0] if clip.speakers else None
                _transcribe_clip(clip, path, work_dir, speaker, transcription_provider, issues, detect_hum=False)
            else:
                _analyze_clip_frames(clip, path, work_dir, clip.duration_seconds, reasoning_provider, issues)
            clip.technical_issues = list(dict.fromkeys(issues))
            recovered = recovered or clip.ai[task]["status"] == "succeeded"
            STORE.upsert_clip(clip)
            STORE.set_progress(5 + int(((idx + 1) / max(1, len(steps))) * 65))
        if recovered or "selects" in project_failed or "stories" in project_failed:
            STORE.set_progress(75)
            _generate_selects(reasoning_provider)
            STORE.set_progress(88)
            _generate_stories(reasoning_provider)
        STORE.complete(keep_analysis_id=True)
        persistence.save_snapshot(STORE)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _provider_label(provider, kind: str) -> str:
    """User-facing vendor name for a provider instance — or, when none could be
    resolved, for the one the environment selects."""
    if provider is not None:
        return ai_status.provider_label(getattr(provider, "name", None))
    import os

    env, default = (
        (TRANSCRIPTION_PROVIDER_ENV, DEFAULT_TRANSCRIPTION_PROVIDER)
        if kind == "transcription"
        else (REASONING_PROVIDER_ENV, DEFAULT_REASONING_PROVIDER)
    )
    return ai_status.provider_label(os.environ.get(env, default).strip().lower())


def _call_ai(task: str, provider, kind: str, fn):
    """Runs one AI operation. Returns (result, status entry) — a failure is
    recorded as a structured entry (ai_status.failed), never raised and never
    reported as success. The log gets the category only, not the exception
    text (which can echo a provider's response)."""
    label = _provider_label(provider, kind)
    if provider is None:
        entry = ai_status.failed(task, label, ProviderError("provider unavailable"))
        log.warning(ai_status.log_line(entry))
        return None, entry
    try:
        return fn(), ai_status.succeeded(task, label)
    except Exception as exc:  # noqa: BLE001 - every provider failure becomes a status
        entry = ai_status.failed(task, label, exc)
        log.warning("%s [%s]", ai_status.log_line(entry), type(exc).__name__)
        return None, entry


def _run_analysis(project_id: str | None, media_root: str | None):
    STORE.begin_analysis(project_id, media_root)

    if not media_root:
        STORE.fail("No media folder is set for this project yet. Use Import Media first.")
        return
    if not media.ffmpeg_available():
        STORE.fail(f"Cannot analyze: {media.ffmpeg_missing_reason()}.")
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
        persistence.save_snapshot(STORE)
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
        audio_channels=info.get("audio_channels", 0),
        source_key=media.source_cache_key(path) or "",
        speakers=[speaker] if (role == "interview" and speaker) else [],
        state="analyzing",
    )
    STORE.upsert_clip(clip)

    if not info.get("ok", True):
        # ffprobe genuinely couldn't read this file — every downstream step
        # (thumbnail, proxy, transcription, visual analysis) needs real
        # duration/stream info to do anything meaningful, so there is nothing
        # honest left to attempt. Surface the real reason and stop, instead of
        # silently leaving this clip at 0:00/no metadata but marked "ready" —
        # which used to be indistinguishable from a genuinely quiet clip because
        # ffprobe_info() returned the exact same defaults for both cases.
        clip.state = "error"
        clip.note = (info.get("probeError") or "ffprobe could not read this file.")[:200]
        STORE.upsert_clip(clip)
        log.warning("ffprobe could not read %s: %s — marking clip as error, skipping analysis", path.name, clip.note)
        return

    technical_issues: list[str] = []
    clip_dir = tmp_root / clip_id
    clip_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Thumbnail generation runs first, before the (potentially much slower)
        # proxy transcode below, so the WATCH page's media bin shows a real image
        # for this clip almost immediately after Analyze starts rather than only
        # once the whole clip finishes analyzing. Same authorized-mediaRoot
        # boundary as proxies (media_root/.ae_thumbs/<sourceKey>.jpg) — no
        # separate allowlist entry needed. Skipped for audio-only files (WATCH
        # shows the waveform-style placeholder for those instead) and never fails
        # the clip — but a real failure IS surfaced in technicalIssues, instead
        # of only a server-side log line nobody looking at the app would see.
        cache_key = clip.source_key or None
        if ext not in media.AUDIO_ONLY_EXTENSIONS and STORE.media_root:
            thumb_rel, thumb_error = _cached_thumbnail(path, cache_key, info["duration"])
            if thumb_rel:
                clip.thumbnail_rel_path = thumb_rel
            else:
                reason = thumb_error or "unknown ffmpeg failure"
                log.warning("thumbnail generation failed for %s: %s — media bin will show the placeholder tile", path.name, reason)
                technical_issues.append(f"Thumbnail generation failed: {reason}"[:200])
            STORE.upsert_clip(clip)

        # Proxy generation: a scaled-down H.264/AAC MP4 that Chromium's <video>
        # element can actually decode and scrub, unlike many camera-original
        # formats (ProRes/MXF/HEVC variants). Lives under the media root itself
        # (media_root/.ae_proxies/<sourceKey>.mp4) so the same authorized-root
        # boundary that gates the ae-media:// playback protocol already covers
        # it — no separate allowlist entry needed. Skipped for audio-only files
        # (nothing to scale; the original plays fine as-is) and never fails the
        # clip — a missing proxy just means preview falls back to the original.
        if ext not in media.AUDIO_ONLY_EXTENSIONS and STORE.media_root:
            proxy_rel = _cached_proxy(path, cache_key)
            if proxy_rel:
                clip.proxy_rel_path = proxy_rel
            else:
                log.warning("proxy generation failed for %s — preview will fall back to the original file", path.name)
            STORE.upsert_clip(clip)

        if info["has_audio"]:
            _transcribe_clip(clip, path, clip_dir, speaker, transcription_provider, technical_issues, detect_hum=True)
        else:
            clip.ai["transcription"] = ai_status.not_applicable("transcription", "no-audio")

        if ext not in media.AUDIO_ONLY_EXTENSIONS:
            _analyze_clip_frames(clip, path, clip_dir, info["duration"], reasoning_provider, technical_issues)
        else:
            clip.ai["visual-analysis"] = ai_status.not_applicable("visual-analysis", "audio-only")

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


def _transcribe_clip(
    clip: ClipState,
    path: Path,
    work_dir: Path,
    speaker: str | None,
    provider: TranscriptionProvider | None,
    technical_issues: list[str],
    detect_hum: bool,
) -> None:
    """Extracts the audio and transcribes it, recording clip.ai['transcription'].
    Replaces any earlier transcript of this clip only when transcription succeeds."""
    wav_path = work_dir / "audio.wav"
    if not media.extract_audio(path, wav_path):
        technical_issues.append("Audio track could not be extracted for transcription")
        clip.ai["transcription"] = ai_status.not_applicable("transcription", "audio-extraction-failed")
        return
    if detect_hum:
        technical_issues.extend(media.detect_hum(wav_path))
    segments, entry = _call_ai(
        "transcription", provider, "transcription", lambda: reasoning.transcribe_audio(provider, wav_path)
    )
    clip.ai["transcription"] = entry
    if entry["status"] != "succeeded":
        return
    speaker_label = speaker or (clip.speakers[0] if clip.speakers else "Unknown speaker")
    with STORE._lock:  # noqa: SLF001
        STORE.transcript = [t for t in STORE.transcript if t["clipId"] != clip.id]
        for i, seg in enumerate(segments or []):
            if not seg.get("text"):
                continue
            STORE.transcript.append(
                {
                    "id": f"{clip.id}-t{i + 1}",
                    "clipId": clip.id,
                    "speaker": speaker_label,
                    "startTc": media.seconds_to_tc(seg["startSeconds"], clip.fps),
                    "endTc": media.seconds_to_tc(seg["endSeconds"], clip.fps),
                    "text": seg["text"],
                    "confidence": seg.get("confidence", 0.7),
                }
            )
        clip.has_transcript = any(t["clipId"] == clip.id for t in STORE.transcript)


def _analyze_clip_frames(
    clip: ClipState,
    path: Path,
    work_dir: Path,
    duration: float,
    provider: ReasoningProvider | None,
    technical_issues: list[str],
) -> None:
    """Samples frames and describes them, recording clip.ai['visual-analysis'].
    Replaces any earlier visual evidence of this clip only on success."""
    frames = media.extract_frames(path, work_dir / "frames", FRAMES_PER_CLIP)
    if not frames:
        technical_issues.append("Frames could not be extracted for visual analysis")
        clip.ai["visual-analysis"] = ai_status.not_applicable("visual-analysis", "frame-extraction-failed")
        return
    findings, entry = _call_ai(
        "visual-analysis", provider, "reasoning", lambda: reasoning.analyze_frames(provider, frames)
    )
    clip.ai["visual-analysis"] = entry
    if entry["status"] != "succeeded":
        return
    evidence = []
    for i, item in enumerate(findings or []):
        frame_index = item.get("frameIndex")
        if not isinstance(frame_index, int):
            frame_index = i + 1
        at_tc = media.frame_timecode(frame_index - 1, len(frames), duration, clip.fps)
        kind = item.get("kind") if item.get("kind") in {
            "face", "motion", "scene", "b-roll", "graphic", "technical",
        } else "scene"
        label = str(item.get("label", "")).strip()
        if not label:
            continue
        if kind == "technical":
            technical_issues.append(label)
            continue
        evidence.append(
            {
                "id": f"{clip.id}-v{i + 1}",
                "clipId": clip.id,
                "kind": kind,
                "label": label,
                "atTc": at_tc,
                "confidence": float(item.get("confidence", 0.6)),
            }
        )
    with STORE._lock:  # noqa: SLF001
        STORE.visual_evidence = [v for v in STORE.visual_evidence if v["clipId"] != clip.id] + evidence
    clip.visual_evidence_count = len(evidence)


def _cached_thumbnail(path: Path, cache_key: str | None, duration: float) -> tuple[str | None, str | None]:
    """Returns (relPath under media_root, error). Cached by the SOURCE's own
    identity (media.source_cache_key), never by clip position — see the cache
    identity comment in media.py. A missing key (source can't be stat'ed)
    means no caching rather than a guessed name."""
    if cache_key is None:
        return None, "could not read source file metadata for caching"
    rel = f"{media.THUMB_DIR_NAME}/{cache_key}.jpg"
    dest = Path(STORE.media_root) / rel
    if media.cached_artifact_is_valid(dest):
        return rel, None
    ok, error = media.generate_thumbnail(path, dest, duration)
    return (rel, None) if ok else (None, error)


def _cached_proxy(path: Path, cache_key: str | None) -> str | None:
    """relPath of a proxy for exactly this source version, generating it if
    needed; None if it couldn't be produced. Same keying as _cached_thumbnail."""
    if cache_key is None:
        return None
    rel = f"{media.PROXY_DIR_NAME}/{cache_key}.mp4"
    dest = Path(STORE.media_root) / rel
    if media.cached_artifact_is_valid(dest) or media.generate_proxy(path, dest):
        return rel
    return None


def _clip_lookup() -> dict:
    with STORE._lock:  # noqa: SLF001 - internal, single-process, read-only snapshot
        return dict(STORE.clips)


def _generate_selects(reasoning_provider: ReasoningProvider | None = None):
    clips = _clip_lookup()
    if not STORE.transcript:
        STORE.selects = []
        STORE.ai_tasks["selects"] = ai_status.not_applicable("selects", "no-transcript")
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

    raw, entry = _call_ai(
        "selects", reasoning_provider, "reasoning", lambda: reasoning.rank_selects(reasoning_provider, summary)
    )
    STORE.ai_tasks["selects"] = entry
    raw = raw or []

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
        STORE.ai_tasks["stories"] = ai_status.not_applicable("stories", "no-selects")
        return
    lines = ["SELECTS:"]
    for s in STORE.selects:
        lines.append(
            f"{s['id']} | {s['speaker']} | {s['category']} | score {s['score']} | \"{s['transcriptExcerpt']}\""
        )
    summary = "\n".join(lines)[:MAX_TRANSCRIPT_CHARS]

    raw, entry = _call_ai(
        "stories", reasoning_provider, "reasoning", lambda: reasoning.propose_stories(reasoning_provider, summary)
    )
    STORE.ai_tasks["stories"] = entry
    raw = raw or []

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


# How far past a clip's measured end a model-supplied out point may land and
# still be treated as tail rounding (then clamped to the real end) rather than
# a hallucinated range (dropped).
SOURCE_TAIL_TOLERANCE_SECONDS = 0.5


def _validate_decisions(decisions: list, clips: dict) -> tuple[list, list[str]]:
    """The "validated edit decisions" gate — nothing downstream (preview,
    export) should ever see a decision that wasn't checked AND normalized here.

    Drops any decision that references an unknown clip, has unparsable source
    timecodes, an empty/inverted/negative source range, or a range outside the
    clip's real media. For everything kept, the SOURCE RANGE is authoritative:

      - durationSeconds is always re-derived as sourceOut - sourceIn. The model
        returns durationSeconds separately, and exporters place an event on the
        timeline from durationSeconds but read the media from in/out; when the
        two disagree, an NLE imports an implicit speed change (a 20s source
        range in a 12s slot plays at 1.66x) — audio drifts, sync breaks.
      - Timecodes are parsed at the CLIP's own fps (a 23.976 source's frame
        field means 1/23.976s, never 1/24s), exactly as before.
      - An out point a hair past the clip's end (tail rounding) is clamped to
        the clip's last frame instead of pointing past the media.
      - Re-derived durations can make events on one lane overlap; see
        _resolve_lane_overlaps().

    Every material correction is reported in the returned warnings, which
    build_timeline() surfaces in the version's change notes."""
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
        in_tc = str(d.get("sourceInTc", ""))
        out_tc = str(d.get("sourceOutTc", ""))
        in_s = media.tc_to_seconds(in_tc, fps)
        out_s = media.tc_to_seconds(out_tc, fps)
        if in_s is None or out_s is None:
            # Also covers negative timecodes: tc_to_seconds rejects them.
            warnings.append(f"Dropped '{label}': unparsable source timecode.")
            continue
        if out_s <= in_s:
            warnings.append(f"Dropped '{label}': source out is not after source in.")
            continue
        clip_end = clip.duration_seconds
        if clip_end > 0:
            if in_s >= clip_end:
                warnings.append(f"Dropped '{label}': source in ({in_s:.1f}s) is at or past the clip's end ({clip_end:.1f}s).")
                continue
            if out_s > clip_end + SOURCE_TAIL_TOLERANCE_SECONDS:
                warnings.append(
                    f"Dropped '{label}': source out ({out_s:.1f}s) exceeds clip duration ({clip_end:.1f}s)."
                )
                continue
            if out_s > clip_end:
                # Floor to a whole frame at the clip's rate so the clamped
                # out point is a real frame that exists in the media.
                out_tc = media.seconds_to_tc(clip_end, fps)
                out_s = media.tc_to_seconds(out_tc, fps)
                if out_s is None or out_s <= in_s:
                    warnings.append(f"Dropped '{label}': nothing left of the source range after clamping to the clip's end.")
                    continue
                warnings.append(f"Trimmed '{label}': source out clamped to the clip's last frame ({out_tc}).")

        duration = round(out_s - in_s, 6)
        claimed = d.get("durationSeconds")
        if isinstance(claimed, (int, float)) and abs(float(claimed) - duration) > 0.5 / fps:
            warnings.append(
                f"Corrected '{label}': duration {float(claimed):.2f}s didn't match its source range; "
                f"using {duration:.2f}s from source in/out."
            )
        valid.append({**d, "sourceInTc": in_tc, "sourceOutTc": out_tc, "durationSeconds": duration})

    return _resolve_lane_overlaps(valid, warnings), warnings


def _resolve_lane_overlaps(decisions: list, warnings: list[str]) -> list:
    """Keeps events on the same lane from overlapping once durations come from
    the source range. Within a lane, events are taken in timeline order; one
    that starts before the previous event ends is moved to start exactly where
    it ends (reported). A missing/negative/non-numeric start is placed after
    the lane's last event — which is also how the deterministic fallback
    assembly gets laid out back-to-back. Gaps are left as the model placed
    them; lanes never affect each other. Input order is preserved."""
    def start_of(d) -> float | None:
        v = d.get("timelineStartSeconds")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        v = float(v)
        return v if math.isfinite(v) and v >= 0 else None

    placed: dict[int, float] = {}
    by_lane: dict[str, list[int]] = {}
    for idx, d in enumerate(decisions):
        by_lane.setdefault(str(d.get("lane", "interview")), []).append(idx)
    for lane, idxs in by_lane.items():
        timed = sorted((i for i in idxs if start_of(decisions[i]) is not None), key=lambda i: start_of(decisions[i]))
        untimed = [i for i in idxs if start_of(decisions[i]) is None]
        end = 0.0
        for i in timed + untimed:
            d = decisions[i]
            wanted = start_of(d)
            start = end if wanted is None else max(wanted, end)
            if wanted is not None and start - wanted > 1e-6:
                warnings.append(
                    f"Moved '{d.get('label', 'event')}' from {wanted:.2f}s to {start:.2f}s so it doesn't overlap "
                    f"the previous {lane} event."
                )
            placed[i] = round(start, 6)
            end = start + float(d["durationSeconds"])
    return [{**d, "timelineStartSeconds": placed[i]} for i, d in enumerate(decisions)]


_DURATION_IN_NOTE = re.compile(r"(\d{1,4}(?:\.\d+)?)\s*-?\s*(seconds?|secs?\b|minutes?|mins?\b)", re.IGNORECASE)


def target_seconds_from_note(note: str | None) -> float | None:
    """'30-second', '45 sec', '2-minute' → seconds; None if the note names no length."""
    if not note:
        return None
    m = _DURATION_IN_NOTE.search(note)
    if not m:
        return None
    value = float(m.group(1)) * (60 if m.group(2).lower().startswith("min") else 1)
    return value if 5 <= value <= 3 * 3600 else None


MAX_VISUAL_MOMENTS_PER_CLIP = 8


def _clip_material_lines() -> list[str]:
    """Every analyzed clip, with whether it has dialogue and its REAL logged
    visual moments — the material the model can lay over the interview as
    b-roll. Without this the model only ever saw transcript selects, so it had
    nothing to cut away to (found in the RC test: a prompt asking for B-roll
    produced no V2 at all). Nothing here is invented: only clips and visual
    evidence the analysis actually produced."""
    clips = _clip_lookup()
    if not clips:
        return []
    by_clip: dict[str, list[dict]] = {}
    for v in STORE.visual_evidence:
        by_clip.setdefault(v.get("clipId", ""), []).append(v)
    lines = ["\nCLIP MATERIAL (clipId | file | durationSeconds | dialogue | visual moments at source timecode):"]
    for c in clips.values():
        if c.state != "analyzed":
            continue
        moments = "; ".join(
            f"{v['atTc']} {v['kind']}: {v['label']}" for v in by_clip.get(c.id, [])[:MAX_VISUAL_MOMENTS_PER_CLIP]
        )
        lines.append(
            f"{c.id} | {c.filename} | {c.duration_seconds} | {'yes' if c.has_transcript else 'no'} | {moments or '—'}"
        )
    return lines


def analysis_readiness() -> dict:
    """Where the analysis stands, for the Director:
    status: 'not-run' | 'running' | 'failed' | 'partial' | 'succeeded' — and a
    user-facing message for every state that can't (fully) build."""
    with STORE._lock:  # noqa: SLF001
        state, progress, error = STORE.analysis_state, STORE.analysis_progress, STORE.error
    if state == "running":
        return {"status": "running", "message": f"Analysis is still running ({progress}%) — the Director can build once it finishes."}
    if state == "error":
        return {"status": "failed", "message": f"Analysis failed — {error or 'see WATCH for details'}."}
    if state != "complete" or not STORE.clips:
        return {"status": "not-run", "message": "No footage has been analyzed yet — import media and run Analyze in WATCH first."}
    outcome = STORE.analysis_outcome() or "succeeded"
    if outcome == "succeeded":
        return {"status": "succeeded", "message": None}
    headline = ai_status.headline(outcome, STORE.ai_issues())
    return {
        "status": outcome,
        "message": f"{headline} Fix the cause, then use Retry AI Analysis in WATCH.",
    }


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

    readiness = analysis_readiness()
    if not story or not STORE.selects:
        # Nothing to build from. Say why: never "run Analyze first" when an
        # analysis did run but its AI steps failed.
        message = readiness["message"] or (
            "The analysis found no usable dialogue selects to build from — check the transcripts in WATCH."
        )
        return {
            "status": "blocked",
            "analysis": readiness,
            "summary": message,
            "changes": [],
            "decisions": [],
        }

    # An explicit length in the Director note ("a 30-second rough cut") is the
    # editor's actual request — it wins over the CUT page's target slider,
    # which otherwise sends its own (unrelated) default alongside the note.
    requested = target_seconds_from_note(command)
    if requested is not None:
        target_seconds = requested

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
    lines.extend(_clip_material_lines())
    brief = "\n".join(lines)[:MAX_TRANSCRIPT_CHARS]

    if reasoning_provider is None:
        reasoning_provider = _resolve_reasoning_provider()

    result, director = _call_ai(
        "director", reasoning_provider, "reasoning", lambda: reasoning.build_timeline(reasoning_provider, brief)
    )
    # An incomplete analysis still builds from what succeeded — but says so.
    caveat = [readiness["message"]] if readiness["status"] == "partial" and readiness["message"] else []

    clips = _clip_lookup()
    if result and isinstance(result.get("decisions"), list) and result["decisions"]:
        validated, warnings = _validate_decisions(result["decisions"], clips)
        if validated:
            changes = caveat + [str(c) for c in result.get("changes", [])] + warnings
            return {
                "status": "built",
                "analysis": readiness,
                "summary": str(result.get("summary", "Engine returned a new assembly.")),
                "changes": changes,
                "decisions": validated,
                "targetSeconds": target_seconds,
            }
        log.warning("build_timeline: model result had zero valid decisions (%s); using fallback", warnings)

    # Deterministic fallback: lay the story's selects back-to-back in beat order so
    # /build always returns something usable even if the model call fails. No
    # timeline position is set here: _validate_decisions() derives each event's
    # duration from its frame-exact source range and places it right after the
    # previous one, so the layout can never disagree with the in/out points.
    decisions = []
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
                "selectId": sid,
            }
        )
    validated, warnings = _validate_decisions(decisions, clips)
    why = (
        f"the Director {director['message']}"
        if director["status"] == "failed"
        else "the reasoning model returned nothing valid"
    )
    return {
        "status": "fallback",
        "analysis": readiness,
        **({"aiFailure": director} if director["status"] == "failed" else {}),
        "summary": f"Assembled '{story['title']}' from {len(validated)} selects (fallback assembly — {why}).",
        "changes": [*caveat, "Concatenated story selects in beat order", *warnings],
        "decisions": validated,
        # The target this cut was actually built against (a length named in
        # the Director note overrides the request) — so the app can scale and
        # label the version by it instead of an unrelated slider default.
        "targetSeconds": target_seconds,
    }
