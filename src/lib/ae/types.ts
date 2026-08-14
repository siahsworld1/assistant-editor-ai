// Domain models for Assistant Editor AI v0.3.1
// These mirror the payloads served by the local Assistant Editor engine.

export type NLEId = "premiere" | "fcp" | "resolve";

export interface NLEStatus {
  id: NLEId;
  name: string;
  version?: string | undefined;
  detected: boolean;
  projectLinked?: string | null | undefined;
  note?: string | undefined;
}

export interface TranscriptSegment {
  id: string;
  clipId: string;
  speaker: string;
  startTc: string;
  endTc: string;
  text: string;
  confidence: number;
}

export type VisualEvidenceKind =
  | "face"
  | "motion"
  | "scene"
  | "b-roll"
  | "graphic"
  | "technical";

export interface VisualEvidence {
  id: string;
  clipId: string;
  kind: VisualEvidenceKind;
  label: string;
  atTc: string;
  confidence: number;
}

export type ClipRole = "interview" | "b-roll" | "ambient";
export type ClipAnalysisState = "pending" | "analyzing" | "analyzed" | "error";

export interface Clip {
  id: string;
  filename: string;
  /** Path relative to the project's mediaRoot. Required for export (reel refs) and
   * for locating the real source file on disk (playback, future NLE re-link). */
  relPath?: string | undefined;
  /** Path (relative to mediaRoot) of a generated H.264/AAC preview proxy, if the
   * engine has produced one for this clip (worker/media.py::generate_proxy). When
   * present, playback prefers this over `relPath` — Chromium can't decode every
   * camera-original format, but every proxy is guaranteed playable. */
  proxyRelPath?: string | undefined;
  role: ClipRole;
  durationSeconds: number;
  camera: string;
  resolution: string;
  fps: number;
  speakers: string[];
  state: ClipAnalysisState;
  progress: number;
  hasTranscript: boolean;
  visualEvidenceCount: number;
  technicalIssues: string[];
  thumbHue: number;
  note?: string | undefined;
}

export interface SelectEvidence {
  kind: "transcript" | "visual" | "audio" | "emotion";
  detail: string;
}

export interface Select {
  id: string;
  rank: number;
  speaker: string;
  clipId: string;
  clipName: string;
  startTc: string;
  endTc: string;
  durationSeconds: number;
  score: number;
  category: "strong-statement" | "emotional" | "context" | "humor" | "closing";
  transcriptExcerpt: string;
  reasons: string[];
  evidence: SelectEvidence[];
  alternateOf?: string | undefined;
}

export interface StoryBeat {
  id: string;
  label: string;
  intent: string;
  estimatedSeconds: number;
  selectIds: string[];
}

export interface StoryCandidate {
  id: string;
  title: string;
  premise: string;
  estimatedSeconds: number;
  confidence: number;
  beats: StoryBeat[];
  supportingSelectIds: string[];
}

export type EditDecisionLane = "interview" | "b-roll" | "audio";

export interface EditDecision {
  id: string;
  lane: EditDecisionLane;
  clipId: string;
  label: string;
  sourceInTc: string;
  sourceOutTc: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  selectId?: string | undefined;
}

export interface UniversalTimeline {
  id: string;
  name: string;
  fps: number;
  targetSeconds: number;
  totalSeconds: number;
  decisions: EditDecision[];
}

export interface EditVersion {
  id: string;
  label: string;
  version: string;
  command: string;
  summary: string;
  createdAt: string;
  changes: string[];
  timeline: UniversalTimeline;
  parentId?: string | undefined;
}

export interface AnalysisSummary {
  speakers: number;
  strongStatements: number;
  emotionalMoments: number;
  brollOpportunities: number;
  technicalIssues: number;
  transcribedMinutes: number;
}

export interface ProjectBrain {
  id: string;
  name: string;
  client: string;
  format: string;
  createdAt: string;
  mediaRoot: string;
  clips: Clip[];
  transcript: TranscriptSegment[];
  visualEvidence: VisualEvidence[];
  summary: AnalysisSummary;
  analysisState: "idle" | "running" | "complete";
  analysisProgress: number;
}

export interface EngineHealth {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  gpu: string;
  queue: number;
}

export type ConnectionState =
  | "connecting"
  | "live"
  /** Engine was reachable and real data is retained, but a recent poll failed. */
  | "degraded"
  /** Hosted HTTPS origin cannot reach loopback; the desktop companion is required. */
  | "bridge-required"
  | "demo";

/** How the app chose its data source. "auto" probes the engine; "demo" is explicit. */
export type AppMode = "auto" | "demo";

export type EngineEndpoint =
  | "health"
  | "analyze"
  | "selects"
  | "stories"
  | "build"
  | "project"
  | "nle";

export type EngineCapabilities = Record<EngineEndpoint, boolean>;

export type EndpointState = "unknown" | "pending" | "ok" | "error" | "unsupported" | "blocked";

export interface EndpointDiagnostic {
  endpoint: EngineEndpoint;
  optional: boolean;
  state: EndpointState;
  lastSuccessAt: number | null;
  lastCheckedAt: number | null;
  /** Short, human-readable failure reason. Never a stack trace. */
  error: string | null;
}

export type DiagnosticsMap = Record<EngineEndpoint, EndpointDiagnostic>;

export type EditingProfile =
  | "documentary"
  | "commercial"
  | "wedding"
  | "corporate"
  | "social";

export interface SettingsState {
  processing: "local" | "cloud";
  transcriptionModel: string;
  transcriptionLanguage: string;
  speakerDiarization: boolean;
  filler_words: boolean;
  cacheGb: number;
  proxyMedia: boolean;
  profile: EditingProfile;
}
