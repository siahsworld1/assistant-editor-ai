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

import media
import persistence
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
    return {
        "summary": f"Assembled '{story['title']}' from {len(validated)} selects (fallback assembly — the reasoning model was unavailable or returned nothing valid).",
        "changes": ["Concatenated story selects in beat order", *warnings],
        "decisions": validated,
        # The target this cut was actually built against (a length named in
        # the Director note overrides the request) — so the app can scale and
        # label the version by it instead of an unrelated slider default.
        "targetSeconds": target_seconds,
    }
