"""In-memory state for the single active project. This worker is a local, single-user
desktop companion — no database, no multi-tenancy. State is lost on restart, which is
fine: "Analyze" re-derives everything from the media folder.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class ClipState:
    id: str
    filename: str
    role: str
    duration_seconds: float
    camera: str
    resolution: str
    fps: float
    rel_path: str = ""
    speakers: list[str] = field(default_factory=list)
    state: str = "pending"  # pending | analyzing | analyzed | error
    progress: int = 0
    has_transcript: bool = False
    visual_evidence_count: int = 0
    technical_issues: list[str] = field(default_factory=list)
    note: str | None = None

    def to_json(self) -> dict:
        d = {
            "id": self.id,
            "filename": self.filename,
            "relPath": self.rel_path,
            "role": self.role,
            "durationSeconds": self.duration_seconds,
            "camera": self.camera,
            "resolution": self.resolution,
            "fps": self.fps,
            "speakers": self.speakers,
            "state": self.state,
            "progress": self.progress,
            "hasTranscript": self.has_transcript,
            "visualEvidenceCount": self.visual_evidence_count,
            "technicalIssues": self.technical_issues,
        }
        if self.note:
            d["note"] = self.note
        return d


class ProjectStore:
    def __init__(self):
        self._lock = threading.RLock()
        self.project_id: str | None = None
        self.media_root: str | None = None
        self.started_at = time.time()
        self.reset()

    def reset(self):
        with self._lock:
            self.clips: dict[str, ClipState] = {}
            self.transcript: list[dict] = []  # {id, clipId, speaker, startTc, endTc, text, confidence}
            self.visual_evidence: list[dict] = []  # {id, clipId, kind, label, atTc, confidence}
            self.selects: list[dict] = []
            self.stories: list[dict] = []
            self.analysis_state = "idle"  # idle | running | complete | error
            self.analysis_progress = 0
            self.error: str | None = None

    def begin_analysis(self, project_id: str | None, media_root: str | None):
        with self._lock:
            self.project_id = project_id or self.project_id or "proj-local"
            self.media_root = media_root or self.media_root
            self.reset()
            self.analysis_state = "running"
            self.analysis_progress = 2

    def set_progress(self, pct: int):
        with self._lock:
            self.analysis_progress = max(0, min(100, int(pct)))

    def upsert_clip(self, clip: ClipState):
        with self._lock:
            self.clips[clip.id] = clip

    def fail(self, message: str):
        with self._lock:
            self.analysis_state = "error"
            self.error = message

    def complete(self):
        with self._lock:
            self.analysis_state = "complete"
            self.analysis_progress = 100

    def snapshot_summary(self) -> dict:
        with self._lock:
            speakers = {s for c in self.clips.values() for s in c.speakers}
            return {
                "speakers": len(speakers),
                "strongStatements": len([s for s in self.selects if s.get("category") == "strong-statement"]),
                "emotionalMoments": len([s for s in self.selects if s.get("category") == "emotional"]),
                "brollOpportunities": len([v for v in self.visual_evidence if v.get("kind") == "b-roll"]),
                "technicalIssues": sum(len(c.technical_issues) for c in self.clips.values()),
                "transcribedMinutes": round(sum(len(t.get("text", "")) for t in self.transcript) / 1000, 1),
            }

    def project_json(self) -> dict:
        with self._lock:
            return {
                "id": self.project_id or "proj-local",
                "mediaRoot": self.media_root or "",
                "clips": [c.to_json() for c in self.clips.values()],
                "summary": self.snapshot_summary(),
                "analysisState": self.analysis_state,
                "analysisProgress": self.analysis_progress,
            }

    def health_json(self) -> dict:
        with self._lock:
            return {
                "ok": True,
                "version": "0.1.0-real-engine",
                "uptimeSeconds": round(time.time() - self.started_at),
                "gpu": "cloud (OpenAI Whisper + Claude)",
                "queue": 1 if self.analysis_state == "running" else 0,
                "capabilities": {
                    "health": True,
                    "analyze": True,
                    "selects": True,
                    "stories": True,
                    "build": True,
                    "project": True,
                    "nle": False,
                },
            }


STORE = ProjectStore()
