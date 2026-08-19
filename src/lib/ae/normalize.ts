// DTO normalization: the local worker may answer with direct arrays/objects or
// wrapped envelopes ({selects:[...]}, {stories:[...]}, {timeline:{...}}, {ok:true,...}).
// Nothing in the UI binds to raw engine JSON — everything passes through here.

import type {
  AnalysisSummary,
  Clip,
  EditDecision,
  EditDecisionLane,
  EngineCapabilities,
  EngineHealth,
  NLEStatus,
  ProjectBrain,
  Select,
  SelectEvidence,
  StoryBeat,
  StoryCandidate,
  UniversalTimeline,
} from "./types";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!isRec(obj)) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return fallback;
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  if (typeof v === "number") return v !== 0;
  return fallback;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

/** Unwraps `{key:[...]}` / `{data:[...]}` / `{items:[...]}` / `{results:[...]}` envelopes. */
export function unwrapArray(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRec(payload)) {
    for (const k of [...keys, "data", "items", "results", "value"]) {
      const v = payload[k];
      if (Array.isArray(v)) return v;
      if (isRec(v)) {
        const nested = unwrapArrayShallow(v);
        if (nested) return nested;
      }
    }
  }
  return [];
}

function unwrapArrayShallow(obj: Rec): unknown[] | null {
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return null;
}

/** Unwraps `{timeline:{...}}` / `{data:{...}}` envelopes to the inner object. */
export function unwrapObject(payload: unknown, ...keys: string[]): Rec | null {
  if (!isRec(payload)) return null;
  for (const k of [...keys, "data", "result", "value"]) {
    const v = payload[k];
    if (isRec(v)) return v;
  }
  return payload;
}

export function secondsToTc(seconds: number, fps = 24): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(sec)}:${p(f)}`;
}

function tc(v: unknown, secondsFallback: unknown, fps = 24): string {
  const s = str(v);
  if (s) return s;
  return secondsToTc(num(secondsFallback), fps);
}

/* ------------------------------- /health -------------------------------- */

export function normalizeHealth(payload: unknown): EngineHealth {
  const root = isRec(payload) ? payload : {};
  const inner = isRec(root["health"]) ? (root["health"] as Rec) : root;
  const statusStr = str(pick(inner, "status", "state")).toLowerCase();
  const okField = pick(inner, "ok", "healthy", "alive", "ready");
  const ok =
    okField !== undefined
      ? bool(okField, true)
      : statusStr
        ? ["ok", "healthy", "ready", "up", "running"].includes(statusStr)
        : true; // a 200 with an unrecognised body still means the engine answered
  return {
    ok,
    version: str(pick(inner, "version", "engineVersion", "build"), "unknown"),
    uptimeSeconds: num(pick(inner, "uptimeSeconds", "uptime", "uptime_s")),
    gpu: str(pick(inner, "gpu", "device", "accelerator"), "unreported"),
    queue: num(pick(inner, "queue", "queueDepth", "jobs", "pending")),
  };
}

const GUARANTEED: EngineCapabilities = {
  health: true,
  analyze: true,
  selects: true,
  stories: true,
  build: true,
  project: false,
  nle: false,
};

/** Prefer capability fields reported by /health; otherwise infer the guaranteed contract. */
export function normalizeCapabilities(payload: unknown): EngineCapabilities {
  const root = isRec(payload) ? payload : {};
  const caps = pick(root, "capabilities", "features", "endpoints", "routes");
  const out: EngineCapabilities = { ...GUARANTEED };
  if (Array.isArray(caps)) {
    const list = caps.map((c) => str(c).replace(/^\/+/, "").toLowerCase());
    for (const key of Object.keys(out) as Array<keyof EngineCapabilities>) {
      out[key] = list.includes(key);
    }
    out.health = true;
    return out;
  }
  if (isRec(caps)) {
    for (const key of Object.keys(out) as Array<keyof EngineCapabilities>) {
      const v = caps[key] ?? caps[`/${key}`];
      if (v !== undefined) out[key] = bool(v, false);
    }
    out.health = true;
    return out;
  }
  return out;
}

/* ------------------------------- /selects ------------------------------- */

const SELECT_CATEGORIES: Select["category"][] = [
  "strong-statement",
  "emotional",
  "context",
  "humor",
  "closing",
];

function normalizeEvidence(v: unknown): SelectEvidence[] {
  const arr = Array.isArray(v) ? v : [];
  return arr.map((e) => {
    if (typeof e === "string") return { kind: "transcript" as const, detail: e };
    const kind = str(pick(e, "kind", "type"), "transcript");
    const allowed: SelectEvidence["kind"][] = ["transcript", "visual", "audio", "emotion"];
    return {
      kind: (allowed as string[]).includes(kind) ? (kind as SelectEvidence["kind"]) : "transcript",
      detail: str(pick(e, "detail", "text", "description", "label"), kind),
    };
  });
}

export function normalizeSelects(payload: unknown): Select[] {
  return unwrapArray(payload, "selects").map((raw, i) => {
    const category = str(pick(raw, "category", "type", "kind"), "context");
    const durationSeconds = num(
      pick(raw, "durationSeconds", "duration", "duration_s", "length"),
      0,
    );
    const score = num(pick(raw, "score", "rating", "confidence"), 0);
    const alternateOf = str(pick(raw, "alternateOf", "alternate_of"));
    return {
      id: str(pick(raw, "id", "selectId", "uid"), `sel-${i + 1}`),
      rank: num(pick(raw, "rank", "position", "order"), i + 1),
      speaker: str(pick(raw, "speaker", "subject", "person"), "Unknown speaker"),
      clipId: str(pick(raw, "clipId", "clip_id", "clip"), ""),
      clipName: str(pick(raw, "clipName", "clip_name", "filename", "source"), "—"),
      startTc: tc(pick(raw, "startTc", "start_tc", "tcIn"), pick(raw, "startSeconds", "start")),
      endTc: tc(pick(raw, "endTc", "end_tc", "tcOut"), pick(raw, "endSeconds", "end")),
      durationSeconds,
      score: score > 0 && score <= 1 ? Math.round(score * 100) : Math.round(score),
      category: (SELECT_CATEGORIES as string[]).includes(category)
        ? (category as Select["category"])
        : "context",
      transcriptExcerpt: str(
        pick(raw, "transcriptExcerpt", "transcript", "text", "excerpt", "quote"),
      ),
      reasons: strList(pick(raw, "reasons", "why", "rationale")),
      evidence: normalizeEvidence(pick(raw, "evidence", "signals")),
      ...(alternateOf ? { alternateOf } : {}),
    } satisfies Select;
  });
}

/* ------------------------------- /stories ------------------------------- */

function normalizeBeats(v: unknown): StoryBeat[] {
  return unwrapArray(v, "beats").map((raw, i) => ({
    id: str(pick(raw, "id", "beatId"), `beat-${i + 1}`),
    label: str(pick(raw, "label", "title", "name"), `Beat ${i + 1}`),
    intent: str(pick(raw, "intent", "description", "purpose", "summary")),
    estimatedSeconds: num(pick(raw, "estimatedSeconds", "seconds", "duration"), 0),
    selectIds: strList(pick(raw, "selectIds", "select_ids", "selects")),
  }));
}

export function normalizeStories(payload: unknown): StoryCandidate[] {
  return unwrapArray(payload, "stories", "candidates").map((raw, i) => {
    const beats = normalizeBeats(pick(raw, "beats", "structure", "acts"));
    const confidence = num(pick(raw, "confidence", "score"), 0);
    const estimated = num(
      pick(raw, "estimatedSeconds", "duration", "targetSeconds"),
      beats.reduce((a, b) => a + b.estimatedSeconds, 0),
    );
    return {
      id: str(pick(raw, "id", "storyId"), `story-${i + 1}`),
      title: str(pick(raw, "title", "name", "label"), `Story ${i + 1}`),
      premise: str(pick(raw, "premise", "summary", "description", "logline")),
      estimatedSeconds: estimated || 1,
      confidence: confidence > 1 ? confidence / 100 : confidence,
      beats,
      supportingSelectIds: strList(
        pick(raw, "supportingSelectIds", "supporting_selects", "selectIds", "selects"),
      ),
    } satisfies StoryCandidate;
  });
}

/* -------------------------------- /build -------------------------------- */

const LANES: EditDecisionLane[] = ["interview", "b-roll", "audio"];

function normalizeDecisions(v: unknown, fps: number): EditDecision[] {
  let cursor = 0;
  return unwrapArray(v, "decisions", "events", "clips", "edits").map((raw, i) => {
    const lane = str(pick(raw, "lane", "track", "type"), "interview").toLowerCase();
    const duration = num(pick(raw, "durationSeconds", "duration", "length"), 0);
    const start = num(pick(raw, "timelineStartSeconds", "start", "timelineStart"), cursor);
    cursor = start + duration;
    const selectId = str(pick(raw, "selectId", "select_id"));
    return {
      id: str(pick(raw, "id", "eventId"), `event-${i + 1}`),
      lane: (LANES as string[]).includes(lane)
        ? (lane as EditDecisionLane)
        : lane.includes("b") && lane.includes("roll")
          ? "b-roll"
          : lane.includes("audio")
            ? "audio"
            : "interview",
      clipId: str(pick(raw, "clipId", "clip_id", "clip"), ""),
      label: str(pick(raw, "label", "name", "title", "text"), `Event ${i + 1}`),
      sourceInTc: tc(pick(raw, "sourceInTc", "inTc", "tcIn"), pick(raw, "sourceIn", "in"), fps),
      sourceOutTc: tc(pick(raw, "sourceOutTc", "outTc", "tcOut"), pick(raw, "sourceOut", "out"), fps),
      timelineStartSeconds: start,
      durationSeconds: duration,
      ...(selectId ? { selectId } : {}),
    } satisfies EditDecision;
  });
}

export function normalizeTimeline(payload: unknown, fallbackTarget: number): UniversalTimeline {
  const root = unwrapObject(payload, "timeline", "sequence", "edl") ?? {};
  const fps = num(pick(root, "fps", "frameRate", "frame_rate"), 24);
  const decisions = normalizeDecisions(
    pick(root, "decisions", "events", "clips", "edits") ?? root,
    fps,
  );
  const total = num(
    pick(root, "totalSeconds", "duration", "length"),
    decisions.reduce((a, d) => Math.max(a, d.timelineStartSeconds + d.durationSeconds), 0),
  );
  return {
    id: str(pick(root, "id", "timelineId"), `tl-${Date.now().toString(36)}`),
    name: str(pick(root, "name", "title"), "Engine assembly"),
    fps,
    targetSeconds: num(pick(root, "targetSeconds", "target"), fallbackTarget),
    totalSeconds: Math.round(total),
    decisions,
  };
}

export function extractBuildSummary(payload: unknown): { summary: string; changes: string[] } {
  const root = isRec(payload) ? payload : {};
  const summary = str(
    pick(root, "summary", "message", "explanation", "note"),
    "Engine returned a new assembly.",
  );
  const changes = strList(pick(root, "changes", "notes", "diff", "actions"));
  return { summary, changes };
}

/* ------------------------- /analyze (optional body) ---------------------- */

export interface AnalyzeResult {
  accepted: boolean;
  jobId: string | null;
  progress: number | null;
  state: ProjectBrain["analysisState"] | null;
  summary: Partial<AnalysisSummary> | null;
}

export function normalizeAnalyze(payload: unknown): AnalyzeResult {
  const root = unwrapObject(payload, "analysis", "job") ?? {};
  const acceptedField = pick(root, "accepted", "ok", "started", "queued");
  const stateStr = str(pick(root, "state", "status")).toLowerCase();
  const state: ProjectBrain["analysisState"] | null =
    stateStr === "error" || stateStr === "failed"
      ? "error"
      : stateStr === "complete" || stateStr === "done" || stateStr === "finished"
        ? "complete"
        : stateStr === "running" || stateStr === "analyzing" || stateStr === "processing"
          ? "running"
          : stateStr === "idle"
            ? "idle"
            : null;
  const rawSummary = pick(root, "summary", "counts", "stats");
  const summary = isRec(rawSummary) ? normalizeSummary(rawSummary) : null;
  const jobId = str(pick(root, "jobId", "job_id", "id")) || null;
  const progressField = pick(root, "progress", "percent");
  return {
    accepted: acceptedField === undefined ? true : bool(acceptedField, true),
    jobId,
    progress: progressField === undefined ? null : num(progressField),
    state,
    summary,
  };
}

function normalizeSummary(raw: Rec): Partial<AnalysisSummary> {
  const out: Partial<AnalysisSummary> = {};
  const map: Array<[keyof AnalysisSummary, string[]]> = [
    ["speakers", ["speakers", "speakerCount"]],
    ["strongStatements", ["strongStatements", "strong_statements"]],
    ["emotionalMoments", ["emotionalMoments", "emotional_moments"]],
    ["brollOpportunities", ["brollOpportunities", "broll", "broll_opportunities"]],
    ["technicalIssues", ["technicalIssues", "technical_issues", "issues"]],
    ["transcribedMinutes", ["transcribedMinutes", "transcribed_minutes", "minutes"]],
  ];
  for (const [key, aliases] of map) {
    const v = pick(raw, ...aliases);
    if (v !== undefined) out[key] = num(v);
  }
  return out;
}

/* --------------------- /project and /nle (optional) ---------------------- */

const CLIP_ROLES: Clip["role"][] = ["interview", "b-roll", "ambient"];
const CLIP_STATES: Clip["state"][] = ["pending", "analyzing", "analyzed", "error"];

function normalizeClips(v: unknown): Clip[] {
  return unwrapArray(v, "clips", "media").map((raw, i) => {
    const role = str(pick(raw, "role", "type"), "interview");
    const state = str(pick(raw, "state", "status"), "pending");
    const note = str(pick(raw, "note", "comment"));
    const relPath = str(pick(raw, "relPath", "rel_path"));
    const proxyRelPath = str(pick(raw, "proxyRelPath", "proxy_rel_path"));
    const thumbnailRelPath = str(pick(raw, "thumbnailRelPath", "thumbnail_rel_path"));
    return {
      id: str(pick(raw, "id", "clipId"), `clip-${i + 1}`),
      filename: str(pick(raw, "filename", "name", "file", "path"), `clip-${i + 1}`),
      ...(relPath ? { relPath } : {}),
      ...(proxyRelPath ? { proxyRelPath } : {}),
      ...(thumbnailRelPath ? { thumbnailRelPath } : {}),
      role: (CLIP_ROLES as string[]).includes(role) ? (role as Clip["role"]) : "interview",
      durationSeconds: num(pick(raw, "durationSeconds", "duration"), 0),
      camera: str(pick(raw, "camera", "device"), "—"),
      resolution: str(pick(raw, "resolution", "res"), "—"),
      fps: num(pick(raw, "fps", "frameRate"), 24),
      speakers: strList(pick(raw, "speakers")),
      state: (CLIP_STATES as string[]).includes(state) ? (state as Clip["state"]) : "pending",
      progress: num(pick(raw, "progress"), 0),
      hasTranscript: bool(pick(raw, "hasTranscript", "transcribed")),
      visualEvidenceCount: num(pick(raw, "visualEvidenceCount", "visualEvidence"), 0),
      technicalIssues: strList(pick(raw, "technicalIssues", "issues")),
      thumbHue: num(pick(raw, "thumbHue"), (i * 47) % 360),
      ...(note ? { note } : {}),
    } satisfies Clip;
  });
}

/** Optional enrichment — merged over the existing shell, never replacing it wholesale. */
export function normalizeProjectPatch(payload: unknown): Partial<ProjectBrain> {
  const root = unwrapObject(payload, "project", "brain");
  if (!root) return {};
  const patch: Partial<ProjectBrain> = {};
  const name = str(pick(root, "name", "title"));
  if (name) patch.name = name;
  const client = str(pick(root, "client"));
  if (client) patch.client = client;
  const format = str(pick(root, "format"));
  if (format) patch.format = format;
  const mediaRoot = str(pick(root, "mediaRoot", "media_root", "path", "root"));
  if (mediaRoot) patch.mediaRoot = mediaRoot;
  const id = str(pick(root, "id", "projectId"));
  if (id) patch.id = id;
  const clipsRaw = pick(root, "clips", "media");
  if (clipsRaw !== undefined) patch.clips = normalizeClips(clipsRaw);
  const summaryRaw = pick(root, "summary", "stats");
  if (isRec(summaryRaw)) {
    patch.summary = {
      speakers: 0,
      strongStatements: 0,
      emotionalMoments: 0,
      brollOpportunities: 0,
      technicalIssues: 0,
      transcribedMinutes: 0,
      ...normalizeSummary(summaryRaw),
    };
  }
  const progress = pick(root, "analysisProgress", "progress");
  if (progress !== undefined) patch.analysisProgress = num(progress);
  // GET /project always reports the worker's real analysisState — this used to be
  // dropped on the floor here, which is why the polling loop that reads this patch
  // could only ever infer "done" from progress reaching 100 and had no way to learn
  // a background analysis run had actually failed (worker/store.py::fail leaves
  // progress wherever it was, not 100).
  const stateStr = str(pick(root, "analysisState", "state", "status")).toLowerCase();
  const state: ProjectBrain["analysisState"] | null =
    stateStr === "error" || stateStr === "failed"
      ? "error"
      : stateStr === "complete" || stateStr === "done" || stateStr === "finished"
        ? "complete"
        : stateStr === "running" || stateStr === "analyzing" || stateStr === "processing"
          ? "running"
          : stateStr === "idle"
            ? "idle"
            : null;
  if (state) patch.analysisState = state;
  // Always set (never conditionally omitted) so a resolved error clears on the next
  // successful poll instead of lingering in state after the user re-runs Analyze.
  if ("error" in root || "analysisState" in root || "state" in root) {
    const errText = str(pick(root, "error", "errorMessage", "message"));
    patch.analysisError = errText || null;
  }
  return patch;
}

const NLE_NAMES: Record<string, string> = {
  premiere: "Adobe Premiere Pro",
  fcp: "Final Cut Pro",
  resolve: "DaVinci Resolve",
};

export function normalizeNle(payload: unknown): NLEStatus[] {
  return unwrapArray(payload, "nle", "hosts", "integrations").map((raw, i) => {
    const id = str(pick(raw, "id", "host", "app"), `host-${i + 1}`).toLowerCase();
    const key = (["premiere", "fcp", "resolve"] as const).find((k) => id.includes(k));
    const version = str(pick(raw, "version"));
    const note = str(pick(raw, "note", "detail", "message"));
    const linked = str(pick(raw, "projectLinked", "project", "linked"));
    return {
      id: key ?? "premiere",
      name: str(pick(raw, "name", "label"), key ? NLE_NAMES[key]! : id),
      detected: bool(pick(raw, "detected", "installed", "available")),
      ...(version ? { version } : {}),
      ...(linked ? { projectLinked: linked } : {}),
      ...(note ? { note } : {}),
    } satisfies NLEStatus;
  });
}
