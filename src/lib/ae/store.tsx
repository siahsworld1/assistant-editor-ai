import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EngineClient, resolveTransport } from "./service";
import type { BuildResult, SourceFrame } from "./service";
import type { HostContext } from "./transport";
import type { WorkerStatus } from "@/types/bridge";
import type { History } from "@/lib/timeline/history";
import { randomIds, type IdGenerator } from "@/lib/timeline/ids";
import type { MediaInventory } from "@/lib/timeline/invariants";
import type { Sequence, Transaction } from "@/lib/timeline/types";
import {
  dispatchTransaction as dispatchToWorkspace,
  editorStatus,
  parseSavedEditStateV2,
  redoIn,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  type DispatchOutcome,
  type Workspace,
} from "@/lib/timeline/workspace";
import type {
  AppMode,
  Clip,
  EditingProfile,
  ConnectionState,
  DiagnosticsMap,
  EditVersion,
  EngineCapabilities,
  EngineEndpoint,
  EngineHealth,
  NLEStatus,
  ProjectBrain,
  Select,
  SettingsState,
  StoryCandidate,
  UniversalTimeline,
} from "./types";
import {
  brainFromRecord,
  sanitizeMediaIndex,
  importMediaFolder,
  newProjectRecord,
  resolveProjectStore,
  type MediaImportOutcome,
  type MediaIndex,
  type ProjectRecord,
  type ProjectStore,
} from "./projects";
import {
  demoNle,
  demoProject,
  demoSelects,
  demoStories,
  demoTimeline,
  demoVersions,
} from "./fixtures";

export const APP_VERSION = "v0.3.1-connected";

const HEALTH_POLL_MS = 10_000;
const ANALYSIS_POLL_MS = 3_000;
const PROJECT_ID = "proj-community-doc";

const ENDPOINTS: Array<{ id: EngineEndpoint; optional: boolean }> = [
  { id: "health", optional: false },
  { id: "analyze", optional: false },
  { id: "selects", optional: false },
  { id: "stories", optional: false },
  { id: "build", optional: false },
  { id: "project", optional: true },
  { id: "nle", optional: true },
];

function initialDiagnostics(state: DiagnosticsMap[EngineEndpoint]["state"] = "unknown") {
  return Object.fromEntries(
    ENDPOINTS.map(({ id, optional }) => [
      id,
      { endpoint: id, optional, state, lastSuccessAt: null, lastCheckedAt: null, error: null },
    ]),
  ) as DiagnosticsMap;
}

/** Host integrations we could not confirm — never a reason to leave Live mode. */
function unreportedNle(): NLEStatus[] {
  return [
    { id: "premiere", name: "Adobe Premiere Pro", detected: false, note: "Bridge not reported" },
    { id: "fcp", name: "Final Cut Pro", detected: false, note: "Bridge not reported" },
    { id: "resolve", name: "DaVinci Resolve", detected: false, note: "Bridge not reported" },
  ];
}

const ACTIVE_PROJECT_KEY = "assistant-editor.activeProject.v1";

function readActiveProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeActiveProjectId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    /* private mode — the session simply will not remember the last project */
  }
}

/** Which project to reopen. The desktop app keeps it in the main process —
 * the packaged renderer gets a new loopback port (= origin = empty
 * localStorage) on every launch; localStorage remains the web/dev fallback. */
async function loadActiveProjectId(): Promise<string | null> {
  const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
  if (desktop?.available) {
    try {
      const res = await desktop.getActiveProject();
      if (res.ok && res.id) return res.id;
    } catch {
      /* fall through */
    }
  }
  return readActiveProjectId();
}

function rememberActiveProject(id: string | null) {
  writeActiveProjectId(id);
  const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
  if (desktop?.available) void desktop.setActiveProject(id).catch(() => {});
}

const EDIT_STATE_SCHEMA = 1;

/** The editor-side state saved per project so a cut survives quitting. */
export interface SavedEditState {
  schema: typeof EDIT_STATE_SCHEMA;
  /** The engine analysis these versions were built from; restored only against it. */
  analysisId: string;
  versions: EditVersion[];
  activeVersionId: string;
  chosenStoryId: string | null;
  targetSeconds: number;
  storyboardSelectIds: string[];
  savedAt: string;
}

/** Validates a saved edit state; null unless it is well-formed AND belongs to
 * `analysisId` (versions from another analysis reference other clip ids). */
export function parseSavedEditState(
  raw: unknown,
  analysisId: string | null | undefined,
): SavedEditState | null {
  if (!analysisId || typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["schema"] !== EDIT_STATE_SCHEMA || r["analysisId"] !== analysisId) return null;
  const versions = Array.isArray(r["versions"])
    ? (r["versions"] as unknown[]).filter(
        (v): v is EditVersion =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as EditVersion).id === "string" &&
          Array.isArray((v as EditVersion).timeline?.decisions),
      )
    : [];
  if (versions.length === 0) return null;
  const active = typeof r["activeVersionId"] === "string" ? (r["activeVersionId"] as string) : "";
  const target = Number(r["targetSeconds"]);
  return {
    schema: EDIT_STATE_SCHEMA,
    analysisId,
    versions,
    activeVersionId: versions.some((v) => v.id === active)
      ? active
      : versions[versions.length - 1]!.id,
    chosenStoryId: typeof r["chosenStoryId"] === "string" ? (r["chosenStoryId"] as string) : null,
    targetSeconds: Number.isFinite(target) && target >= 5 && target <= 36000 ? target : 360,
    storyboardSelectIds: Array.isArray(r["storyboardSelectIds"])
      ? (r["storyboardSelectIds"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    savedAt: typeof r["savedAt"] === "string" ? (r["savedAt"] as string) : "",
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function emptyTimeline(targetSeconds: number): UniversalTimeline {
  return {
    id: "tl-empty",
    name: "No assembly yet",
    fps: 24,
    targetSeconds,
    totalSeconds: 0,
    decisions: [],
  };
}

function baselineVersion(targetSeconds: number): EditVersion {
  return {
    id: "v1",
    label: "Awaiting first build",
    version: "v1.0",
    command: "",
    summary: "No sequence built yet. Run a build or send a Director Mode command.",
    createdAt: "—",
    changes: [],
    timeline: emptyTimeline(targetSeconds),
  };
}

interface AEContextValue {
  appVersion: string;
  mode: AppMode;
  connection: ConnectionState;
  hostContext: HostContext;
  blockedReason: string | null;
  transportLabel: string;
  health: EngineHealth | null;
  capabilities: EngineCapabilities | null;
  diagnostics: DiagnosticsMap;
  lastHealthAt: number | null;
  connectionError: string | null;
  /** Why the desktop-owned worker isn't running (startup failure / crash),
   * including its last log lines. Null when healthy or not on desktop. */
  engineStartupError: WorkerStatus["error"];
  loading: boolean;
  project: ProjectBrain | null;
  nle: NLEStatus[];
  nleReported: boolean;
  selects: Select[];
  stories: StoryCandidate[];
  chosenStoryId: string | null;
  auditionId: string | null;
  storyboardSelectIds: string[];
  versions: EditVersion[];
  activeVersionId: string;
  settings: SettingsState;
  targetSeconds: number;
  building: boolean;
  /** Persisted local projects (desktop file store, or browser storage in dev). */
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  projectStoreLabel: string;
  projectsLoading: boolean;
  projectBusy: boolean;
  projectError: string | null;
  mediaIndex: MediaIndex | null;
  desktopCapabilities: boolean;
  createProject: (input: {
    name: string;
    client?: string;
    format?: string;
    profile?: EditingProfile;
  }) => Promise<ProjectRecord | null>;
  openProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  importMedia: () => Promise<MediaImportOutcome>;
  retryConnection: () => void;
  setMode: (mode: AppMode) => void;
  analyze: () => void;
  /** Re-runs only the AI steps that failed in the loaded analysis — no proxy,
   * thumbnail or metadata work (POST /analyze/retry-ai). */
  retryAiAnalysis: () => void;
  /** Why the Director couldn't build (analysis never run / still running /
   * failed / incomplete) — shown instead of an empty version. */
  directorNotice: string | null;
  chooseStory: (id: string) => void;
  audition: (id: string | null) => void;
  toggleStorySelect: (id: string) => void;
  runCommand: (command: string) => Promise<void>;
  setActiveVersion: (id: string) => void;
  /** The canonical schema-2 editor for the active version (see EditorApi). */
  editor: EditorApi;
  setTargetSeconds: (s: number) => void;
  updateSettings: (patch: Partial<SettingsState>) => void;
  /** Real frames of a clip at source times, aligned with `times` (null = unavailable). */
  fetchFrames: (
    clipId: string,
    times: number[],
    width?: 160 | 240 | 320,
  ) => Promise<Array<SourceFrame | null>>;
}

/**
 * The one editable timeline for the active version. All timeline semantics
 * live in src/lib/timeline/; this only routes transactions to the workspace
 * and exposes the result. `sequence` is the canonical schema-2 Sequence: the
 * working Sequence of an edited version, or the (immutable) imported Sequence
 * of a Director version — a transaction against a Director version forks an
 * edited working version and makes it active.
 */
export interface EditorApi {
  sequence: Sequence | null;
  /** Generates ids for new commands/transactions (once, at build time). */
  ids: IdGenerator;
  dispatchTransaction: (txn: Transaction) => DispatchOutcome;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  nextUndoLabel: string | null;
  nextRedoLabel: string | null;
  /** True when the active version is a manual working version. */
  edited: boolean;
  /** Whether the editor state on screen is safely on disk. */
  persistence: EditorPersistence;
  /** Tries the last failed save again (any further edit also retries). */
  retrySave: () => void;
}

/**
 * Save status of the project's editor state. A failed save is never silent:
 * the edit stays in memory, the previous file on disk is left as it was, and
 * the status stays "error" (with a message safe to show) until a later save
 * succeeds.
 */
export type EditorSaveStatus = "saved" | "saving" | "error";
export interface EditorPersistence {
  status: EditorSaveStatus;
  message: string | null;
}

const SAVED: EditorPersistence = { status: "saved", message: null };
const SAVING: EditorPersistence = { status: "saving", message: null };

/** A user-facing message for a failed save. Never echoes what the desktop
 * side reported (paths, system errors) — only its error code is read. */
function saveErrorMessage(code: string | undefined): string {
  if (code === "too-large")
    return "Your latest edits are too large to save. They are still open here, but are not saved.";
  if (code === "unsupported")
    return "This version of the desktop app cannot save edited timelines. Your edits are still open here, but are not saved.";
  return "Your latest edits could not be saved. They are still open here — try saving again.";
}

const AEContext = createContext<AEContextValue | null>(null);

const defaultSettings: SettingsState = {
  processing: "local", // Local / Private stays the default
  transcriptionModel: "whisper-large-v3 (local)",
  transcriptionLanguage: "en-US",
  speakerDiarization: true,
  filler_words: false,
  cacheGb: 64,
  proxyMedia: true,
  profile: "documentary",
};

interface EditSelections {
  activeVersionId: string;
  chosenStoryId: string | null;
  targetSeconds: number;
  storyboardSelectIds: string[];
}

/** The persisted selections, in one fixed shape and key order. */
function editSelections(s: EditSelections): EditSelections {
  return {
    activeVersionId: s.activeVersionId,
    chosenStoryId: s.chosenStoryId,
    targetSeconds: s.targetSeconds,
    storyboardSelectIds: s.storyboardSelectIds,
  };
}

/** The schema-1 state, unstamped — built the same way for saving and for
 * recognising an unchanged state after loading. */
function schema1State(
  analysisId: string,
  versions: EditVersion[],
  sel: EditSelections,
): SavedEditState {
  return { schema: EDIT_STATE_SCHEMA, analysisId, versions, ...editSelections(sel), savedAt: "" };
}

function nextVersionLabel(count: number) {
  return `v1.${count}`;
}

/** Demo-only command simulation. Never runs while a live engine is attached. */
function commandResult(command: string, prev: EditVersion) {
  const c = command.toLowerCase();
  const tl = structuredClone(prev.timeline);
  let summary = "Re-assembled timeline from the current story spine.";
  let changes = ["Recalculated pacing", "Re-checked B-roll coverage"];

  if (c.includes("opening") || c.includes("stronger")) {
    summary = "Opening replaced with the highest-scoring cold-open bite.";
    changes = [
      "Swapped opening to sel-02 (Marisol, 'nobody waited for the city')",
      "Trimmed 1.4s of handle before first word",
      "Moved B101 sunrise wide under the first line",
    ];
  } else if (/\d+\s*second|60|minute|shorter|tighten/.test(c)) {
    const target = /(\d+)\s*second/.exec(c)?.[1];
    const secs = target ? Number(target) : 60;
    tl.targetSeconds = secs;
    tl.decisions = tl.decisions.slice(0, 5);
    let cursor = 0;
    tl.decisions = tl.decisions.map((d) => {
      const dur = Math.max(4, d.durationSeconds * 0.62);
      const out = { ...d, timelineStartSeconds: cursor, durationSeconds: dur };
      cursor += dur;
      return out;
    });
    tl.totalSeconds = Math.round(cursor);
    summary = `Condensed to ${secs}s: 4 events lifted, remaining bites tightened.`;
    changes = [
      "Dropped the humor beat and one B-roll cover",
      "Tightened sentence handles across all interview events",
      `Timeline now ${Math.round(cursor)}s against a ${secs}s target`,
    ];
  } else if (c.includes("b-roll") || c.includes("broll")) {
    const extra = tl.decisions
      .filter((d) => d.lane === "interview")
      .slice(0, 3)
      .map((d, i) => ({
        ...d,
        id: `${d.id}-cover-${i}`,
        lane: "b-roll" as const,
        label: `Cover: ${["B104 kitchen hands", "B109 block party", "B112 mural wall"][i]}`,
        durationSeconds: Math.min(6, d.durationSeconds * 0.5),
        selectId: undefined,
      }));
    tl.decisions = [...tl.decisions, ...extra];
    summary = "Three additional B-roll covers laid over interview sync.";
    changes = [
      "Added 3 cutaways from analyzed B-roll pool",
      "Kept sync audio underneath all covers",
      "Coverage ratio now 46% visual / 54% talking head",
    ];
  } else if (c.includes("breathing") || c.includes("middle") || c.includes("slower")) {
    tl.decisions = tl.decisions.map((d, i) =>
      i > 2 && i < 6 ? { ...d, durationSeconds: d.durationSeconds + 2.2 } : d,
    );
    let cursor = 0;
    tl.decisions = tl.decisions.map((d) => {
      const out = { ...d, timelineStartSeconds: cursor };
      cursor += d.durationSeconds;
      return out;
    });
    tl.totalSeconds = Math.round(cursor);
    summary = "Act two loosened — holds extended and two pauses restored.";
    changes = [
      "Extended 3 mid-timeline events by ~2s each",
      "Restored natural pauses that were previously trimmed",
      "Added a 1.5s ambient-only rest before the emotional beat",
    ];
  } else if (c.includes("ending") || c.includes("alternate")) {
    summary = "Three alternate endings generated as branchable tails.";
    changes = [
      "Ending A — forward look (sel-04), 16.4s",
      "Ending B — thesis button (sel-06), 18.6s",
      "Ending C — silent B-roll fade on B101, 11.0s",
    ];
  }

  tl.id = `${tl.id}-${Math.random().toString(36).slice(2, 7)}`;
  return { summary, changes, timeline: tl };
}

export function AEProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<EngineClient | null>(null);

  const [mode, setModeState] = useState<AppMode>("auto");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [hostContext, setHostContext] = useState<HostContext>("server");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [transportLabel, setTransportLabel] = useState("Direct loopback");
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsMap>(() => initialDiagnostics());
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [engineStartupError, setEngineStartupError] = useState<WorkerStatus["error"]>(null);
  const [loading, setLoading] = useState(true);

  const [project, setProject] = useState<ProjectBrain | null>(null);
  // The project's clips, readable from async callbacks (their rates rebuild a
  // Director version's import when a saved edited version refers to it).
  const projectClipsRef = useRef<readonly Clip[]>([]);
  projectClipsRef.current = project?.clips ?? [];
  const [nle, setNle] = useState<NLEStatus[]>(unreportedNle());
  const [nleReported, setNleReported] = useState(false);
  const [selects, setSelects] = useState<Select[]>([]);
  const [stories, setStories] = useState<StoryCandidate[]>([]);
  const [chosenStoryId, setChosenStoryId] = useState<string | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [storyboardSelectIds, setStoryboardSelectIds] = useState<string[]>([]);
  const [versions, setVersions] = useState<EditVersion[]>([baselineVersion(360)]);
  /** Working version id → transaction history (src/lib/timeline/history). */
  const [histories, setHistories] = useState<Record<string, History>>({});
  const [activeVersionId, setActiveVersionId] = useState("v1");
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [targetSeconds, setTargetSeconds] = useState(360);
  const [building, setBuilding] = useState(false);
  const [directorNotice, setDirectorNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const storeRef = useRef<ProjectStore | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [projectStoreLabel, setProjectStoreLabel] = useState("In-memory (not persisted)");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [mediaIndex, setMediaIndex] = useState<MediaIndex | null>(null);
  const [desktopCapabilities, setDesktopCapabilities] = useState(false);

  const report = useCallback(
    (endpoint: EngineEndpoint, result: { ok: boolean; error?: string; unsupported?: boolean }) => {
      const now = Date.now();
      setDiagnostics((d) => ({
        ...d,
        [endpoint]: {
          ...d[endpoint],
          state: result.ok ? "ok" : result.unsupported ? "unsupported" : "error",
          lastCheckedAt: now,
          lastSuccessAt: result.ok ? now : d[endpoint].lastSuccessAt,
          error: result.ok ? null : (result.error ?? "Request failed"),
        },
      }));
    },
    [],
  );

  /** `${projectId}:${analysisId}` once that pair's saved edit state has been
   * loaded (or found absent). Saving is blocked until then, so a fresh baseline
   * can never overwrite a saved cut before it has been restored. */
  const hydratedKeyRef = useRef<string | null>(null);
  /** Saves go to the schema-2 file once the project has one (or an edit
   * needs one); until then beta.1's schema-1 file is used, as before. */
  const schema2Ref = useRef(false);
  /** What was last loaded or saved, minus its timestamp: an unchanged state is
   * never written back (opening a project must not rewrite its files). */
  const persistedRef = useRef<string | null>(null);
  const [persistence, setPersistence] = useState<EditorPersistence>(SAVED);
  /** Bumped by retrySave() to run the save effect again. */
  const [saveRetry, setSaveRetry] = useState(0);
  /** Writes run one at a time, in order (never two writes to one file at once). */
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** Only the newest write's outcome sets the status. */
  const saveAttemptRef = useRef(0);
  /** Set below once the engine-sync helpers exist (they're declared later). */
  const projectSwitchedRef = useRef<(record: ProjectRecord | null) => void>(() => {});
  const targetSecondsRef = useRef(targetSeconds);
  targetSecondsRef.current = targetSeconds;

  const activeRef = useRef<{ record: ProjectRecord | null; index: MediaIndex | null }>({
    record: null,
    index: null,
  });

  const modeRef = useRef<AppMode>(mode);
  modeRef.current = mode;

  /** Project state for the current record — never fixture data. */
  const applyActive = useCallback((record: ProjectRecord | null, index: MediaIndex | null) => {
    activeRef.current = { record, index };
    setActiveProject(record);
    setMediaIndex(index);
    // Demo Mode owns `project` while it is active; the record is still tracked.
    if (modeRef.current !== "demo") setProject(record ? brainFromRecord(record, index) : null);
  }, []);

  /** Re-read a previously authorised media folder (metadata only). */
  const reindex = useCallback(async (record: ProjectRecord): Promise<MediaIndex | null> => {
    const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
    if (!desktop?.available || !record.mediaRoot) return null;
    try {
      const res = await desktop.indexMedia(record.mediaRoot);
      if (!res.ok) return null;
      return sanitizeMediaIndex(res);
    } catch {
      return null;
    }
  }, []);

  // Load persisted projects once per session.
  useEffect(() => {
    let cancelled = false;
    const store = resolveProjectStore();
    storeRef.current = store;
    setProjectStoreLabel(store.label);
    setDesktopCapabilities(
      typeof window !== "undefined" && window.assistantEditorDesktop?.available === true,
    );
    void (async () => {
      try {
        const list = await store.list();
        if (cancelled) return;
        setProjects(list);
        const wanted = await loadActiveProjectId();
        const record = list.find((p) => p.id === wanted) ?? list[0] ?? null;
        const index = record ? await reindex(record) : null;
        if (cancelled) return;
        if (record) rememberActiveProject(record.id);
        applyActive(record, index);
        // The engine may already be live (it starts in parallel): restore this
        // project now. If it isn't live yet, the boot sync does it instead.
        projectSwitchedRef.current(record);
      } catch (err) {
        if (!cancelled) {
          setProjectError(
            err instanceof Error ? err.message : "Saved projects could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyActive, reindex]);

  const createProject = useCallback(
    async (input: {
      name: string;
      client?: string;
      format?: string;
      profile?: EditingProfile;
    }) => {
      const store = storeRef.current;
      if (!store) return null;
      setProjectBusy(true);
      setProjectError(null);
      try {
        const record = newProjectRecord(input);
        setProjects(await store.save(record));
        rememberActiveProject(record.id);
        applyActive(record, null);
        projectSwitchedRef.current(record);
        return record;
      } catch (err) {
        setProjectError(err instanceof Error ? err.message : "The project could not be created.");
        return null;
      } finally {
        setProjectBusy(false);
      }
    },
    [applyActive],
  );

  const openProject = useCallback(
    async (id: string) => {
      const store = storeRef.current;
      if (!store) return;
      setProjectBusy(true);
      setProjectError(null);
      try {
        const list = await store.list();
        setProjects(list);
        const record = list.find((p) => p.id === id) ?? null;
        if (!record) {
          setProjectError("That project is no longer in the local project store.");
          return;
        }
        rememberActiveProject(record.id);
        applyActive(record, await reindex(record));
        projectSwitchedRef.current(record);
      } catch (err) {
        setProjectError(err instanceof Error ? err.message : "The project could not be opened.");
      } finally {
        setProjectBusy(false);
      }
    },
    [applyActive, reindex],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      const store = storeRef.current;
      if (!store) return;
      setProjectBusy(true);
      try {
        const list = await store.remove(id);
        setProjects(list);
        if (activeRef.current.record?.id === id) {
          const next = list[0] ?? null;
          rememberActiveProject(next?.id ?? null);
          applyActive(next, next ? await reindex(next) : null);
          projectSwitchedRef.current(next);
        }
      } catch (err) {
        setProjectError(err instanceof Error ? err.message : "The project could not be removed.");
      } finally {
        setProjectBusy(false);
      }
    },
    [applyActive, reindex],
  );

  /** User-gated media import. Indexing happens in the desktop main process. */
  const importMedia = useCallback(async (): Promise<MediaImportOutcome> => {
    const store = storeRef.current;
    const record = activeRef.current.record;
    if (!record) {
      const outcome: MediaImportOutcome = {
        status: "error",
        error: "Create or open a project before importing media.",
      };
      setProjectError(outcome.error!);
      return outcome;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const outcome = await importMediaFolder();
      if (outcome.status !== "imported" || !outcome.index) {
        if (outcome.error) setProjectError(outcome.error);
        return outcome;
      }
      const updated: ProjectRecord = {
        ...record,
        mediaRoot: outcome.index.root,
        mediaCount: outcome.index.files.length,
        updatedAt: new Date().toISOString(),
      };
      if (store) setProjects(await store.save(updated));
      applyActive(updated, outcome.index);
      projectSwitchedRef.current(updated);
      return outcome;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Media import failed.";
      setProjectError(error);
      return { status: "error", error };
    } finally {
      setProjectBusy(false);
    }
  }, [applyActive]);

  // Authorizes the desktop companion's ae-media:// playback protocol to stream
  // from whichever project is actually open, whenever that changes. This is the
  // only place activeMediaRoot is ever set — see electron/media-protocol.cjs,
  // which refuses every request until this has run at least once.
  useEffect(() => {
    if (typeof window === "undefined" || !window.assistantEditorDesktop?.available) return;
    void window.assistantEditorDesktop.setActiveMediaRoot(activeProject?.mediaRoot || "");
  }, [activeProject?.mediaRoot]);

  const loadDemo = useCallback(() => {
    setProject(structuredClone(demoProject));
    setNle(structuredClone(demoNle));
    setNleReported(true);
    setSelects(structuredClone(demoSelects));
    setStories(structuredClone(demoStories));
    setChosenStoryId("story-01");
    setHistories({});
    setVersions(structuredClone(demoVersions));
    setActiveVersionId("v1");
    setTargetSeconds(demoTimeline.targetSeconds);
    setHealth({ ok: false, version: `${APP_VERSION}-demo`, uptimeSeconds: 0, gpu: "n/a", queue: 0 });
    setCapabilities(null);
    setDiagnostics(initialDiagnostics("unknown"));
    setLoading(false);
  }, []);

  const refreshEvidence = useCallback(async (client: EngineClient) => {
    // Use the real active project's id — falling back to the placeholder constant
    // only when no project is open yet (e.g. Demo Mode's brief live-engine probe).
    // The worker itself is single-tenant and ignores this id today, but the UI
    // should never send a fabricated id when a real one is available.
    const projectId = activeRef.current.record?.id ?? PROJECT_ID;
    const [s, st] = await Promise.allSettled([
      client.getSelects(projectId),
      client.getStories(projectId),
    ]);
    if (s.status === "fulfilled") setSelects(s.value);
    if (st.status === "fulfilled") {
      setStories(st.value);
      setChosenStoryId((cur) => cur ?? st.value[0]?.id ?? null);
    }
  }, []);

  /** Applies a project's saved edit state if it belongs to this analysis. */
  const hydrateEditState = useCallback(
    async (projectId: string, analysisId: string, clips: readonly Clip[]) => {
      const key = `${projectId}:${analysisId}`;
      if (hydratedKeyRef.current === key) return;
      const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
      // Schema 2 (1.1+) first; otherwise beta.1's schema 1, read without being
      // rewritten. Schema 1 converts to Sequences in memory, on demand.
      let v2: ReturnType<typeof parseSavedEditStateV2> = null;
      let saved: SavedEditState | null = null;
      if (desktop?.available) {
        if (desktop.loadEditStateV2) {
          try {
            v2 = parseSavedEditStateV2(
              (await desktop.loadEditStateV2(projectId)).state,
              analysisId,
              clips,
            );
          } catch {
            v2 = null;
          }
        }
        if (!v2) {
          try {
            const res = await desktop.loadEditState(projectId);
            saved = parseSavedEditState(res.state, analysisId);
          } catch {
            saved = null;
          }
        }
      }
      if (activeRef.current.record?.id !== projectId) return; // switched meanwhile
      schema2Ref.current = !!v2;
      persistedRef.current = null;
      setPersistence(SAVED); // what is on screen is what is on disk
      if (v2) {
        setVersions(v2.workspace.versions);
        setHistories(v2.workspace.histories);
        setActiveVersionId(v2.activeVersionId);
        setChosenStoryId(v2.chosenStoryId);
        setTargetSeconds(v2.targetSeconds);
        setStoryboardSelectIds(v2.storyboardSelectIds);
        persistedRef.current = JSON.stringify(
          serializeWorkspace(v2.workspace, editSelections(v2), analysisId, "", clips),
        );
      } else if (saved) {
        setHistories({});
        setVersions(saved.versions);
        setActiveVersionId(saved.activeVersionId);
        setChosenStoryId(saved.chosenStoryId);
        setTargetSeconds(saved.targetSeconds);
        setStoryboardSelectIds(saved.storyboardSelectIds);
        persistedRef.current = JSON.stringify(schema1State(analysisId, saved.versions, saved));
      }
      hydratedKeyRef.current = key;
    },
    [],
  );

  /**
   * Brings the engine and the editor back to where a project was left: reloads
   * the engine's saved analysis for the project's media folder, then that
   * analysis's selects/stories and the project's saved cuts. The engine is
   * single-tenant — if what it holds belongs to another folder, it's ignored
   * rather than shown under this project.
   */
  const syncProjectWithEngine = useCallback(
    async (client: EngineClient, record: ProjectRecord | null) => {
      hydratedKeyRef.current = null;
      if (!record?.mediaRoot) {
        setSelects([]);
        setStories([]);
        return;
      }
      await client.restore(record.id, record.mediaRoot);
      const patch = await client.getProjectPatch();
      if (activeRef.current.record?.id !== record.id) return;
      if (!patch?.mediaRoot || !samePath(patch.mediaRoot, record.mediaRoot)) {
        setSelects([]);
        setStories([]);
        return;
      }
      setProject((p) => (p ? { ...p, ...patch } : p));
      if (patch.analysisState === "complete" && patch.analysisId) {
        await refreshEvidence(client);
        await hydrateEditState(record.id, patch.analysisId, patch.clips ?? projectClipsRef.current);
      }
    },
    [refreshEvidence, hydrateEditState],
  );

  /** Clears editor state when switching projects, before the new one syncs. */
  const resetEditor = useCallback(() => {
    hydratedKeyRef.current = null;
    saveAttemptRef.current += 1; // a write still in flight no longer reports here
    setPersistence(SAVED);
    setSelects([]);
    setStories([]);
    setChosenStoryId(null);
    setStoryboardSelectIds([]);
    setHistories({});
    setVersions([baselineVersion(targetSecondsRef.current)]);
    setActiveVersionId("v1");
  }, []);

  projectSwitchedRef.current = () => {
    resetEditor();
  };

  // Restore the active project's engine analysis + saved cuts whenever the
  // engine is (re)connected or the active project / its media folder changes —
  // whichever happens last. Driven by state, not by call sites: at launch the
  // project list and the engine come up in parallel, and a call-site sync
  // could run in the gap between them and silently restore nothing.
  const engineLive = connection === "live" || connection === "degraded";
  useEffect(() => {
    if (!engineLive || mode === "demo" || capabilities?.project === false) return;
    const client = clientRef.current;
    if (!client) return;
    void syncProjectWithEngine(client, activeRef.current.record);
  }, [
    engineLive,
    mode,
    capabilities?.project,
    activeProject?.id,
    activeProject?.mediaRoot,
    syncProjectWithEngine,
  ]);

  // Persist the editor state (versions, active cut, chosen story, target) per
  // project, debounced — but only once that project's saved state for the
  // current analysis has been loaded (hydratedKeyRef), never before.
  useEffect(() => {
    if (mode === "demo") return;
    const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
    const projectId = activeProject?.id;
    const analysisId = project?.analysisId;
    if (!desktop?.available || !projectId || !analysisId) return;
    const key = `${projectId}:${analysisId}`;
    if (hydratedKeyRef.current !== key) return;
    // Nothing the user made yet (one empty version, default story, no picks):
    // don't save it — writing it would replace a previously saved cut history
    // with an untouched baseline (e.g. right after a re-analysis).
    const pristine =
      versions.length === 1 &&
      versions[0]!.timeline.decisions.length === 0 &&
      storyboardSelectIds.length === 0 &&
      (chosenStoryId === null || chosenStoryId === stories[0]?.id);
    const selections = editSelections({
      activeVersionId,
      chosenStoryId,
      targetSeconds,
      storyboardSelectIds,
    });
    const useV2 = schema2Ref.current || Object.keys(histories).length > 0;
    if (useV2 && !desktop.saveEditStateV2) {
      // An old bridge: never fall back to schema 1 — and never pretend it saved.
      setPersistence({ status: "error", message: saveErrorMessage("unsupported") });
      return;
    }
    if (pristine && !useV2) return;
    const state = useV2
      ? serializeWorkspace(
          { versions, histories },
          selections,
          analysisId,
          "",
          projectClipsRef.current,
        )
      : schema1State(analysisId, versions, selections);
    const fingerprint = JSON.stringify(state);
    if (fingerprint === persistedRef.current) {
      // Unchanged since load/save — e.g. undone back to what is on disk.
      saveAttemptRef.current += 1;
      setPersistence((p) => (p.status === "saved" ? p : SAVED));
      return;
    }
    setPersistence((p) => (p.status === "saving" ? p : SAVING));
    const t = setTimeout(() => {
      const attempt = (saveAttemptRef.current += 1);
      const stamped = { ...state, savedAt: new Date().toISOString() };
      const write = () =>
        useV2
          ? desktop.saveEditStateV2!(projectId, stamped)
          : desktop.saveEditState(projectId, stamped);
      const done = saveChainRef.current.then(write).then(
        (res) => ({ ok: !!res?.ok, code: res?.ok ? undefined : res?.code }),
        () => ({ ok: false, code: undefined }),
      );
      saveChainRef.current = done;
      void done.then(({ ok, code }) => {
        if (hydratedKeyRef.current !== key) return; // project switched meanwhile
        if (ok) {
          persistedRef.current = fingerprint;
          if (useV2) schema2Ref.current = true;
        }
        if (attempt !== saveAttemptRef.current) return; // a newer save will report
        // On failure nothing else changes: the edit stays in memory, the
        // last good file stays on disk, and the next change (or retrySave)
        // writes again.
        setPersistence(ok ? SAVED : { status: "error", message: saveErrorMessage(code) });
      });
    }, 300);
    return () => clearTimeout(t);
  }, [
    saveRetry,
    mode,
    activeProject?.id,
    project?.analysisId,
    versions,
    histories,
    activeVersionId,
    chosenStoryId,
    targetSeconds,
    storyboardSelectIds,
    stories,
  ]);

  // Boot / reconnect
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConnectionError(null);
    setEngineStartupError(null);

    if (mode === "demo") {
      setConnection("demo");
      setBlockedReason(null);
      loadDemo();
      return;
    }

    setConnection("connecting");
    const { transport, host, blockedReason: blocked } = resolveTransport();
    setHostContext(host);
    setBlockedReason(blocked);
    setTransportLabel(transport?.label ?? "Unavailable");

    if (!transport) {
      // Hosted HTTPS preview (or SSR): loopback is unreachable by design.
      setConnection("bridge-required");
      setDiagnostics(initialDiagnostics("blocked"));
      setProject(
        activeRef.current.record
          ? brainFromRecord(activeRef.current.record, activeRef.current.index)
          : null,
      );
      setSelects([]);
      setStories([]);
      setNle(unreportedNle());
      setNleReported(false);
      setHistories({});
      setVersions([baselineVersion(targetSeconds)]);
      setActiveVersionId("v1");
      setHealth(null);
      setCapabilities(null);
      setLoading(false);
      return;
    }

    const client = new EngineClient(transport, report);
    clientRef.current = client;

    /** The engine is unavailable: an explicit error state with the real
     * reason. Never fixture data — Demo Mode is only entered via setMode. */
    const goOffline = (message: string, startup: WorkerStatus["error"] = null) => {
      clientRef.current = null;
      setConnection("offline");
      setConnectionError(message);
      setEngineStartupError(startup);
      setProject(
        activeRef.current.record
          ? brainFromRecord(activeRef.current.record, activeRef.current.index)
          : null,
      );
      setSelects([]);
      setStories([]);
      setNle(unreportedNle());
      setNleReported(false);
      setHistories({});
      setVersions([baselineVersion(targetSeconds)]);
      setActiveVersionId("v1");
      setHealth(null);
      setCapabilities(null);
    };

    (async () => {
      try {
        // In the desktop app, Electron owns the worker: wait for its startup
        // to settle (health-gated, bounded — electron/worker-supervisor.cjs)
        // instead of racing a cold Python start with a single probe.
        const worker = typeof window === "undefined" ? undefined : window.assistantEditorWorker;
        if (worker?.available) {
          const status = await worker.waitUntilReady();
          if (cancelled) return;
          if (status.state !== "ready") {
            goOffline(status.error?.message ?? "The local engine did not start.", status.error);
            return;
          }
        }
        const { health: h, capabilities: caps } = await client.health();
        if (cancelled) return;
        setHealth(h);
        setCapabilities(caps);
        setLastHealthAt(Date.now());
        setConnection("live");
        setProject(
          activeRef.current.record
            ? brainFromRecord(activeRef.current.record, activeRef.current.index)
            : null,
        );
        setSelects([]);
        setStories([]);
        setNle(unreportedNle());
        setNleReported(false);
        setHistories({});
        setVersions([baselineVersion(targetSeconds)]);
        setActiveVersionId("v1");

        // An engine without /project only has its evidence endpoints; otherwise
        // the project-sync effect below restores the project once live.
        if (caps.project === false) await refreshEvidence(client);
        if (cancelled) return;

        // Optional enrichment — failures never change connection state.
        const hosts = caps.nle === false ? null : await client.getNle();
        if (cancelled) return;
        if (hosts) {
          setNle(hosts);
          setNleReported(true);
        }
      } catch (err) {
        if (cancelled) return;
        // Engine unreachable on this boot → explicit offline error state. This
        // used to silently load Demo Mode fixtures, which made a dead engine
        // look like a working project full of fake data.
        goOffline(
          err instanceof Error ? err.message : "Local engine unreachable on 127.0.0.1:32145",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, mode, loadDemo, refreshEvidence, report]);

  // Periodic health polling while attached to a real engine.
  useEffect(() => {
    if (connection !== "live" && connection !== "degraded") return;
    const client = clientRef.current;
    if (!client) return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const { health: h, capabilities: caps } = await client.health();
          setHealth(h);
          setCapabilities(caps);
          setLastHealthAt(Date.now());
          setConnection("live");
          setConnectionError(null);
        } catch (err) {
          // Degrade, but keep real data — never swap in fixtures mid-session.
          setConnection("degraded");
          setConnectionError(
            err instanceof Error ? err.message : "Health poll failed — reconnecting",
          );
        }
      })();
    }, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [connection]);

  // Live progress polling while a real engine is running an analysis job.
  // A real engine's POST /analyze returns almost immediately and keeps working in the
  // background (see worker/pipeline.py), so this is the ONLY place progress, clip
  // state, transcripts, visual evidence and the eventual selects/stories reach the
  // UI — analyze() itself only fires the job and records the accept response.
  useEffect(() => {
    if (connection !== "live" && connection !== "degraded") return;
    if (project?.analysisState !== "running") return;
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;
    const t = setInterval(() => {
      void (async () => {
        const patch = await client.getProjectPatch().catch(() => null);
        if (cancelled || !patch) return;
        // GET /project's own analysisState is authoritative when the worker reports
        // one (normalizeProjectPatch reads worker/store.py::project_json's real
        // analysisState/error) — progress reaching 100 is only the fallback signal
        // for a worker that doesn't report analysisState at all. Either way, a real
        // "error" from the worker always wins: an analysis that failed partway
        // through must never be reported as complete just because some earlier
        // clip had already reached 100% before the failure.
        const progress = patch.analysisProgress ?? undefined;
        const doneByProgress = progress !== undefined && progress >= 100;
        const resolvedState: ProjectBrain["analysisState"] =
          patch.analysisState === "error"
            ? "error"
            : patch.analysisState === "complete" || doneByProgress
              ? "complete"
              : "running";
        setProject((p) => (p ? { ...p, ...patch, analysisState: resolvedState } : p));
        // Polling stops naturally next render since this effect's dependency
        // (project.analysisState) will no longer be "running".
        if (resolvedState === "complete") {
          // A NEW analysis re-ranks selects and re-numbers clips, so cuts built
          // on the previous one no longer reference valid material: start a
          // fresh history (the previous analysis's saved cuts stay on disk,
          // tied to their own analysisId).
          const record = activeRef.current.record;
          const key = record && patch.analysisId ? `${record.id}:${patch.analysisId}` : null;
          if (key && hydratedKeyRef.current !== key) {
            setHistories({});
            setVersions([baselineVersion(targetSecondsRef.current)]);
            setActiveVersionId("v1");
            setChosenStoryId(null);
            hydratedKeyRef.current = key;
          }
          await refreshEvidence(client);
        }
      })();
    }, ANALYSIS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, project?.analysisState, refreshEvidence]);

  const analyze = useCallback(() => {
    const client = clientRef.current;
    if (!client && modeRef.current !== "demo") {
      setProject((p) =>
        p
          ? {
              ...p,
              analysisState: "error",
              analysisError: "The local engine is offline — Reconnect, then analyze again.",
            }
          : p,
      );
      return;
    }
    setProject((p) =>
      p ? { ...p, analysisState: "running", analysisProgress: 2, analysisError: null } : p,
    );
    if (!client) return; // explicit Demo Mode: simulated below
    void (async () => {
      try {
        // POST /analyze only *starts* a background job on a real engine (see
        // worker/pipeline.py::run_analysis, run on a daemon thread) — it does not
        // wait for it to finish. The job's actual progress, clip states,
        // transcripts, visual evidence and summary only ever reach the UI through
        // the polling effect above, which watches analysisState === "running" and
        // keeps refetching GET /project until the worker itself reports completion
        // (or a real error). This handler's only job is to kick the job off and
        // record whatever the accept response says right now — it must never mark
        // the run "complete" itself, or it would stop that polling effect before
        // any real work has actually happened.
        const res = await client.analyze({
          projectId: activeRef.current.record?.id ?? PROJECT_ID,
          mediaRoot: activeRef.current.record?.mediaRoot || undefined,
        });
        setProject((p) => {
          if (!p) return p;
          const state = res.state === "error" ? "error" : (res.state ?? "running");
          return {
            ...p,
            analysisProgress: res.progress ?? p.analysisProgress,
            analysisState: state,
            ...(res.summary ? { summary: { ...p.summary, ...res.summary } } : {}),
          };
        });
      } catch (err) {
        // A real failure to even start analysis (engine unreachable, 4xx/5xx on
        // POST /analyze) — surface the actual reason instead of silently resetting
        // clip/transcript/evidence state back to as if nothing had been tried.
        const errorMessage = err instanceof Error ? err.message : "Analyze request failed.";
        setProject((p) => (p ? { ...p, analysisState: "error", analysisError: errorMessage } : p));
      }
    })();
  }, []);

  const retryAiAnalysis = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setProject((p) =>
      p ? { ...p, analysisState: "running", analysisProgress: 5, analysisError: null } : p,
    );
    void (async () => {
      // Like analyze(): this only starts the job; the polling effect above
      // follows it through GET /project until the engine reports completion.
      const refresh = async (error: string | null) => {
        const patch = await client.getProjectPatch().catch(() => null);
        setProject((p) =>
          p
            ? {
                ...p,
                ...(patch ?? {}),
                analysisState: patch?.analysisState ?? "complete",
                analysisError: error,
              }
            : p,
        );
      };
      try {
        const res = await client.retryAi();
        if (!res.accepted) {
          await refresh(
            res.reason === "analysis-running"
              ? "An analysis is already running — wait for it to finish."
              : null,
          );
        }
      } catch (err) {
        await refresh(err instanceof Error ? err.message : "Retry request failed.");
      }
    })();
  }, []);

  // Demo-only analysis animation.
  useEffect(() => {
    if (connection !== "demo") return;
    if (project?.analysisState !== "running") return;
    const t = setInterval(() => {
      setProject((p) => {
        if (!p || p.analysisState !== "running") return p;
        const next = Math.min(100, p.analysisProgress + 6);
        const clips = p.clips.map((c) =>
          c.state === "analyzed"
            ? c
            : {
                ...c,
                state: next >= 100 ? ("analyzed" as const) : ("analyzing" as const),
                progress: Math.min(100, c.progress + 9),
                hasTranscript: next >= 100 ? c.role === "interview" : c.hasTranscript,
                visualEvidenceCount:
                  next >= 100 ? Math.max(c.visualEvidenceCount, 14) : c.visualEvidenceCount,
              },
        );
        return {
          ...p,
          clips,
          analysisProgress: next,
          analysisState: next >= 100 ? "complete" : "running",
        };
      });
    }, 420);
    return () => clearInterval(t);
  }, [project?.analysisState, connection]);

  const pushVersion = useCallback(
    (command: string, prevId: string, result: BuildResult) => {
      setVersions((v) => {
        const id = `v${v.length + 1}`;
        const version: EditVersion = {
          id,
          label: command.length > 42 ? `${command.slice(0, 42)}…` : command,
          version: nextVersionLabel(v.length),
          command,
          summary: result.summary,
          changes: result.changes,
          createdAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          timeline: result.timeline,
          parentId: prevId,
        };
        setActiveVersionId(id);
        return [...v, version];
      });
    },
    [],
  );

  const runCommand = useCallback(
    async (command: string) => {
      const client = clientRef.current;
      const prev = versions.find((v) => v.id === activeVersionId) ?? versions[versions.length - 1]!;
      setBuilding(true);
      try {
        if (client) {
          const result = await client.build({
            projectId: activeRef.current.record?.id ?? PROJECT_ID,
            storyId: chosenStoryId ?? stories[0]?.id ?? "story-01",
            targetSeconds,
            command,
          });
          if (result.status?.status === "blocked") {
            // Nothing was built: say why instead of adding an empty version.
            setDirectorNotice(result.status.message ?? result.summary);
            return;
          }
          setDirectorNotice(null);
          pushVersion(command, prev.id, result);
        } else if (modeRef.current === "demo") {
          const { summary, changes, timeline } = commandResult(command, prev);
          pushVersion(command, prev.id, { summary, changes, timeline });
        } else {
          // No engine: never fabricate an edit outside explicit Demo Mode.
          setConnectionError(
            "The local engine is offline — nothing was built. Reconnect and try again.",
          );
        }
      } catch (err) {
        setConnectionError(
          err instanceof Error ? err.message : "Build request failed on the engine",
        );
      } finally {
        setBuilding(false);
      }
    },
    [versions, activeVersionId, chosenStoryId, stories, targetSeconds, pushVersion],
  );

  const fetchFrames = useCallback(
    async (clipId: string, times: number[], width: 160 | 240 | 320 = 240) => {
      const client = clientRef.current;
      if (!client || times.length === 0) return times.map(() => null);
      try {
        return await client.frames(clipId, times, width);
      } catch {
        return times.map(() => null);
      }
    },
    [],
  );

  const retryConnection = useCallback(() => {
    void (async () => {
      const worker = typeof window === "undefined" ? undefined : window.assistantEditorWorker;
      if (worker?.available && modeRef.current !== "demo") {
        setConnection("connecting");
        const status = await worker.status();
        if (status.state === "error" || status.state === "stopped") await worker.restart();
      }
      setNonce((n) => n + 1);
    })();
  }, []);

  const setMode = useCallback((next: AppMode) => {
    clientRef.current = null;
    setModeState(next);
    setNonce((n) => n + 1);
  }, []);

  // ---- Canonical editor (schema 2). Semantics live in src/lib/timeline/. ----
  const editorClips = useMemo(() => project?.clips ?? [], [project?.clips]);
  const editorMedia = useMemo<MediaInventory>(
    () => new Map(editorClips.map((c) => [c.id, { durationSeconds: c.durationSeconds }])),
    [editorClips],
  );
  // The latest workspace, readable synchronously so back-to-back gestures in
  // one tick each see the result of the previous one.
  const workspaceRef = useRef<{ ws: Workspace; active: string }>({
    ws: { versions, histories },
    active: activeVersionId,
  });
  workspaceRef.current = { ws: { versions, histories }, active: activeVersionId };

  const publishWorkspace = useCallback((ws: Workspace, active: string) => {
    workspaceRef.current = { ws, active };
    setVersions(ws.versions);
    setHistories(ws.histories);
    setActiveVersionId(active);
  }, []);

  const dispatchEditorTransaction = useCallback(
    (txn: Transaction): DispatchOutcome => {
      const { ws, active } = workspaceRef.current;
      const out = dispatchToWorkspace(ws, active, txn, {
        clips: editorClips,
        media: editorMedia,
        ids: randomIds,
      });
      if (out.ok) publishWorkspace(out.workspace, out.activeVersionId);
      return out;
    },
    [editorClips, editorMedia, publishWorkspace],
  );
  const undoEditor = useCallback(() => {
    const { ws, active } = workspaceRef.current;
    const next = undoIn(ws, active);
    if (next !== ws) publishWorkspace(next, active);
  }, [publishWorkspace]);
  const redoEditor = useCallback(() => {
    const { ws, active } = workspaceRef.current;
    const next = redoIn(ws, active);
    if (next !== ws) publishWorkspace(next, active);
  }, [publishWorkspace]);

  const retrySave = useCallback(() => setSaveRetry((n) => n + 1), []);

  const editor = useMemo<EditorApi>(() => {
    const ws: Workspace = { versions, histories };
    return {
      sequence: sequenceOf(ws, activeVersionId, editorClips),
      ids: randomIds,
      dispatchTransaction: dispatchEditorTransaction,
      undo: undoEditor,
      redo: redoEditor,
      ...editorStatus(ws, activeVersionId),
      persistence,
      retrySave,
    };
  }, [
    versions,
    histories,
    activeVersionId,
    editorClips,
    dispatchEditorTransaction,
    undoEditor,
    redoEditor,
    persistence,
    retrySave,
  ]);

  const value = useMemo<AEContextValue>(
    () => ({
      appVersion: APP_VERSION,
      mode,
      connection,
      hostContext,
      blockedReason,
      transportLabel,
      health,
      capabilities,
      diagnostics,
      lastHealthAt,
      connectionError,
      engineStartupError,
      loading,
      project,
      nle,
      nleReported,
      selects,
      stories,
      chosenStoryId,
      auditionId,
      storyboardSelectIds,
      versions,
      activeVersionId,
      settings,
      targetSeconds,
      building,
      projects,
      activeProject,
      projectStoreLabel,
      projectsLoading,
      projectBusy,
      projectError,
      mediaIndex,
      desktopCapabilities,
      createProject,
      openProject,
      deleteProject,
      importMedia,
      retryConnection,
      setMode,
      analyze,
      retryAiAnalysis,
      directorNotice,
      chooseStory: (id: string) => setChosenStoryId(id),
      audition: (id: string | null) => setAuditionId(id),
      toggleStorySelect: (id: string) =>
        setStoryboardSelectIds((ids) =>
          ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
        ),
      runCommand,
      setActiveVersion: (id: string) => setActiveVersionId(id),
      editor,
      setTargetSeconds,
      updateSettings: (patch: Partial<SettingsState>) => setSettings((s) => ({ ...s, ...patch })),
      fetchFrames,
    }),
    [
      mode,
      connection,
      hostContext,
      blockedReason,
      transportLabel,
      health,
      capabilities,
      diagnostics,
      lastHealthAt,
      connectionError,
      engineStartupError,
      retryConnection,
      loading,
      project,
      nle,
      nleReported,
      selects,
      stories,
      chosenStoryId,
      auditionId,
      storyboardSelectIds,
      versions,
      activeVersionId,
      editor,
      settings,
      targetSeconds,
      building,
      analyze,
      retryAiAnalysis,
      directorNotice,
      runCommand,
      setMode,
      projects,
      activeProject,
      projectStoreLabel,
      projectsLoading,
      projectBusy,
      projectError,
      mediaIndex,
      desktopCapabilities,
      createProject,
      openProject,
      deleteProject,
      importMedia,
      fetchFrames,
    ],
  );

  return <AEContext.Provider value={value}>{children}</AEContext.Provider>;
}

export function useAE() {
  const ctx = useContext(AEContext);
  if (!ctx) throw new Error("useAE must be used inside AEProvider");
  return ctx;
}

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
