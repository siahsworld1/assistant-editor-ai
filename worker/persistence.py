"""Saved analysis, so a project survives the app (and this worker) restarting.

The worker keeps analysis in memory (store.py). When an analysis completes, a
snapshot — clips, transcript, visual evidence, selects, stories — is written
next to the media it describes (<mediaRoot>/.ae_analysis.json, beside the
.ae_proxies/.ae_thumbs caches) so it travels with the footage and needs no
database. POST /restore loads it back.

A snapshot is restored ONLY if every analyzed source file still exists and is
the exact same version (same media.source_cache_key: path + size + mtime). If
anything changed, nothing is restored and the app asks for a re-analysis —
stale transcripts or timecodes are never shown against different media.

A snapshot is never replaced blindly (saved cuts are tied to its analysisId):
  - the previous file is first copied, byte for byte and verified, into
    <mediaRoot>/.ae_analysis_history/ under a content-addressed name, and the
    replacement is refused if that copy can't be made; history copies are never
    deleted by the app;
  - an analysis that LOST transcript or visual evidence the saved one had (a
    stage skipped, failed or produced nothing — e.g. no AI credentials) does
    not replace it unless the filmmaker explicitly allowed that;
  - the new file is written to a partial file, fsynced, then renamed into place.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import asdict, fields
from pathlib import Path

import media
from store import ClipState, ProjectStore

log = logging.getLogger("assistant-editor-worker")

SNAPSHOT_NAME = ".ae_analysis.json"
SCHEMA_VERSION = 1
MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024

# Analysis persistence is ON for every normal worker. Set to "0" for runs that
# must leave the project's saved state alone — worker/validate_e2e.py does, so
# validating real footage never replaces the .ae_analysis.json (and with it the
# analysisId) a real project and its saved cuts depend on. When off, the worker
# neither writes nor reads snapshots.
PERSIST_ENV = "ASSISTANT_EDITOR_PERSIST_ANALYSIS"


def persistence_enabled() -> bool:
    return os.environ.get(PERSIST_ENV, "1") != "0"

_CLIP_FIELDS = {f.name for f in fields(ClipState)}


def snapshot_path(media_root: str) -> Path:
    return Path(media_root) / SNAPSHOT_NAME


HISTORY_DIR = ".ae_analysis_history"


def history_dir(media_root: str) -> Path:
    return Path(media_root) / HISTORY_DIR


def read_saved(media_root: str) -> dict | None:
    """The saved snapshot for `media_root` as data, or None (absent/unreadable)."""
    try:
        path = snapshot_path(media_root)
        if not path.is_file() or path.stat().st_size > MAX_SNAPSHOT_BYTES:
            return None
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def saved_summary(data: dict | None) -> dict | None:
    """What a saved analysis holds, for the filmmaker's confirmation."""
    if not data or not isinstance(data.get("analysisId"), str):
        return None
    count = lambda k: len(data.get(k) or []) if isinstance(data.get(k), list) else 0  # noqa: E731
    return {
        "analysisId": data["analysisId"],
        "clips": count("clips"),
        "transcript": count("transcript"),
        "visualEvidence": count("visualEvidence"),
        "selects": count("selects"),
        "stories": count("stories"),
    }


def _evidence_by_file(data: dict) -> tuple[dict[str, int], dict[str, int]]:
    """Transcript lines and visual-evidence entries per source file (rel path)."""
    files = {c.get("id"): (c.get("rel_path") or c.get("filename")) for c in data.get("clips") or [] if isinstance(c, dict)}
    lines: dict[str, int] = {}
    evidence: dict[str, int] = {}
    for key, out in (("transcript", lines), ("visualEvidence", evidence)):
        for item in data.get(key) or []:
            name = files.get(item.get("clipId")) if isinstance(item, dict) else None
            if name:
                out[name] = out.get(name, 0) + 1
    return lines, evidence


def lost_evidence(old: dict | None, new: dict) -> list[str]:
    """What `new` would lose that `old` has: files whose transcript or visual
    evidence existed before and is missing now (a skipped, failed or empty
    stage). Empty when nothing meaningful would be lost."""
    if not old:
        return []
    old_lines, old_ev = _evidence_by_file(old)
    new_lines, new_ev = _evidence_by_file(new)
    lost = [f"transcript of {name}" for name in sorted(old_lines) if not new_lines.get(name)]
    lost += [f"visual evidence of {name}" for name in sorted(old_ev) if not new_ev.get(name)]
    return lost


def preserve_existing(media_root: str) -> dict:
    """Copies the current snapshot, byte for byte, into the history folder under
    a content-addressed name and verifies the copy. Returns {"ok": True,
    "preservedAs": name | None} (None: nothing to preserve) or {"ok": False}."""
    src = snapshot_path(media_root)
    try:
        if not src.exists():
            return {"ok": True, "preservedAs": None}
        raw = src.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        try:
            analysis_id = str(json.loads(raw).get("analysisId") or "unknown")[:8]
        except (ValueError, AttributeError):
            analysis_id = "unreadable"
        name = f"{analysis_id}-{digest[:16]}.json"
        hist = history_dir(media_root)
        hist.mkdir(exist_ok=True)
        dest = hist / name
        if not (dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == digest):
            partial = dest.with_name(dest.name + ".partial")
            with open(partial, "wb") as fh:
                fh.write(raw)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(partial, dest)
            if hashlib.sha256(dest.read_bytes()).hexdigest() != digest:
                return {"ok": False}
        return {"ok": True, "preservedAs": f"{HISTORY_DIR}/{name}"}
    except OSError as exc:
        log.warning("could not preserve the previous analysis in %s: %s", history_dir(media_root), exc)
        return {"ok": False}


def save_snapshot(store: ProjectStore, allow_incomplete: bool = False) -> Path | None:
    """Writes the completed analysis (see write_snapshot). Never raises.
    Returns the written path, or None when nothing was written."""
    outcome = write_snapshot(store, allow_incomplete=allow_incomplete)
    return outcome.get("path")


def write_snapshot(store: ProjectStore, allow_incomplete: bool = False) -> dict:
    """Writes the completed analysis atomically, never replacing a saved one
    blindly (module docstring). Never raises. Returns {"saved": bool, "reason":
    "written" | "unchanged" | "persistence-disabled" | "not-complete" |
    "would-lose-evidence" | "preserve-failed" | "write-failed", "path"?,
    "preservedAs"?, "lost"?}."""
    if not persistence_enabled():
        log.info("analysis persistence is off for this run — not writing %s", SNAPSHOT_NAME)
        return {"saved": False, "reason": "persistence-disabled"}
    with store._lock:  # noqa: SLF001 - single-process, consistent snapshot
        if store.analysis_state != "complete" or not store.media_root:
            return {"saved": False, "reason": "not-complete"}
        data = {
            "schema": SCHEMA_VERSION,
            "savedAt": time.time(),
            "projectId": store.project_id,
            "mediaRoot": os.path.realpath(store.media_root),
            "analysisId": store.analysis_id,
            "clips": [asdict(c) for c in store.clips.values()],
            "transcript": store.transcript,
            "visualEvidence": store.visual_evidence,
            "selects": store.selects,
            "stories": store.stories,
            # Status of the project-level AI steps (selects, stories); per-clip
            # AI status travels inside each clip. See ai_status.py.
            "aiTasks": store.ai_tasks,
        }
        media_root = store.media_root
        dest = snapshot_path(media_root)
    text = json.dumps(data)
    old = read_saved(media_root)
    if old is not None and {k: v for k, v in old.items() if k != "savedAt"} == {
        k: v for k, v in data.items() if k != "savedAt"
    }:
        return {"saved": True, "reason": "unchanged", "path": dest}
    lost = [] if allow_incomplete else lost_evidence(old, data)
    if lost:
        log.warning("not replacing the saved analysis: the new one would lose %d item(s) of evidence", len(lost))
        return {"saved": False, "reason": "would-lose-evidence", "lost": lost}
    kept = preserve_existing(media_root)
    if not kept["ok"]:
        return {"saved": False, "reason": "preserve-failed"}
    partial = dest.with_name(dest.name + ".partial")
    try:
        with open(partial, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(partial, dest)
        return {"saved": True, "reason": "written", "path": dest, "preservedAs": kept.get("preservedAs")}
    except OSError as exc:
        partial.unlink(missing_ok=True)
        log.warning("could not save analysis snapshot to %s: %s", dest, exc)
        return {"saved": False, "reason": "write-failed", "preservedAs": kept.get("preservedAs")}


def restore_snapshot(store: ProjectStore, project_id: str | None, media_root: str) -> dict:
    """Loads a saved analysis for `media_root` into `store` if — and only if —
    it still matches the media on disk. Returns {"restored": bool, "reason": str}."""
    if not persistence_enabled():
        return {"restored": False, "reason": "persistence-disabled"}
    path = snapshot_path(media_root)
    if not path.is_file():
        return {"restored": False, "reason": "no-saved-analysis"}
    try:
        if path.stat().st_size > MAX_SNAPSHOT_BYTES:
            return {"restored": False, "reason": "saved-analysis-too-large"}
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        log.warning("unreadable analysis snapshot %s: %s", path, exc)
        return {"restored": False, "reason": "saved-analysis-unreadable"}
    if not isinstance(data, dict) or data.get("schema") != SCHEMA_VERSION:
        return {"restored": False, "reason": "saved-analysis-incompatible"}
    if data.get("mediaRoot") != os.path.realpath(media_root):
        return {"restored": False, "reason": "saved-analysis-for-another-folder"}

    clips: list[ClipState] = []
    for raw in data.get("clips") or []:
        if not isinstance(raw, dict):
            return {"restored": False, "reason": "saved-analysis-incompatible"}
        clip = ClipState(**{k: v for k, v in raw.items() if k in _CLIP_FIELDS})
        source = Path(media_root) / clip.rel_path
        if not clip.source_key or not source.is_file() or media.source_cache_key(source) != clip.source_key:
            return {"restored": False, "reason": "media-changed", "clip": clip.filename}
        clips.append(clip)

    with store._lock:  # noqa: SLF001
        store.reset()
        store.project_id = project_id or data.get("projectId") or store.project_id
        store.media_root = media_root
        store.clips = {c.id: c for c in clips}
        store.transcript = list(data.get("transcript") or [])
        store.visual_evidence = list(data.get("visualEvidence") or [])
        store.selects = list(data.get("selects") or [])
        store.stories = list(data.get("stories") or [])
        ai_tasks = data.get("aiTasks")
        store.ai_tasks = dict(ai_tasks) if isinstance(ai_tasks, dict) else {}
        store.analysis_id = data.get("analysisId")
        store.analysis_state = "complete"
        store.analysis_progress = 100
    return {"restored": True, "reason": "restored", "analysisId": store.analysis_id, "clipCount": len(clips)}
