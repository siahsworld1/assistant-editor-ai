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
"""

from __future__ import annotations

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


def save_snapshot(store: ProjectStore) -> Path | None:
    """Writes the completed analysis atomically. Never raises."""
    if not persistence_enabled():
        log.info("analysis persistence is off for this run — not writing %s", SNAPSHOT_NAME)
        return None
    with store._lock:  # noqa: SLF001 - single-process, consistent snapshot
        if store.analysis_state != "complete" or not store.media_root:
            return None
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
        }
        dest = snapshot_path(store.media_root)
    partial = dest.with_name(dest.name + ".partial")
    try:
        partial.write_text(json.dumps(data))
        os.replace(partial, dest)
        return dest
    except OSError as exc:
        partial.unlink(missing_ok=True)
        log.warning("could not save analysis snapshot to %s: %s", dest, exc)
        return None


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
        store.analysis_id = data.get("analysisId")
        store.analysis_state = "complete"
        store.analysis_progress = 100
    return {"restored": True, "reason": "restored", "analysisId": store.analysis_id, "clipCount": len(clips)}
