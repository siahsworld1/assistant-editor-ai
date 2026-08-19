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
import type { BuildResult } from "./service";
import type { HostContext } from "./transport";
import type {
  AppMode,
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
  chooseStory: (id: string) => void;
  audition: (id: string | null) => void;
  toggleStorySelect: (id: string) => void;
  runCommand: (command: string) => Promise<void>;
  setActiveVersion: (id: string) => void;
  setTargetSeconds: (s: number) => void;
  updateSettings: (patch: Partial<SettingsState>) => void;
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
  const [loading, setLoading] = useState(true);

  const [project, setProject] = useState<ProjectBrain | null>(null);
  const [nle, setNle] = useState<NLEStatus[]>(unreportedNle());
  const [nleReported, setNleReported] = useState(false);
  const [selects, setSelects] = useState<Select[]>([]);
  const [stories, setStories] = useState<StoryCandidate[]>([]);
  const [chosenStoryId, setChosenStoryId] = useState<string | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [storyboardSelectIds, setStoryboardSelectIds] = useState<string[]>([]);
  const [versions, setVersions] = useState<EditVersion[]>([baselineVersion(360)]);
  const [activeVersionId, setActiveVersionId] = useState("v1");
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [targetSeconds, setTargetSeconds] = useState(360);
  const [building, setBuilding] = useState(false);
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
        const wanted = readActiveProjectId();
        const record = list.find((p) => p.id === wanted) ?? list[0] ?? null;
        const index = record ? await reindex(record) : null;
        if (cancelled) return;
        if (record) writeActiveProjectId(record.id);
        applyActive(record, index);
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
        writeActiveProjectId(record.id);
        applyActive(record, null);
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
        writeActiveProjectId(record.id);
        applyActive(record, await reindex(record));
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
          writeActiveProjectId(next?.id ?? null);
          applyActive(next, next ? await reindex(next) : null);
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

  // Boot / reconnect
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConnectionError(null);

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
      setVersions([baselineVersion(targetSeconds)]);
      setActiveVersionId("v1");
      setHealth(null);
      setCapabilities(null);
      setLoading(false);
      return;
    }

    const client = new EngineClient(transport, report);
    clientRef.current = client;

    (async () => {
      try {
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
        setVersions([baselineVersion(targetSeconds)]);
        setActiveVersionId("v1");

        // Guaranteed evidence endpoints.
        await refreshEvidence(client);
        if (cancelled) return;

        // Optional enrichments — failures never change connection state.
        const [patch, hosts] = await Promise.all([
          caps.project === false ? Promise.resolve(null) : client.getProjectPatch(),
          caps.nle === false ? Promise.resolve(null) : client.getNle(),
        ]);
        if (cancelled) return;
        if (patch) setProject((p) => (p ? { ...p, ...patch } : p));
        if (hosts) {
          setNle(hosts);
          setNleReported(true);
        }
      } catch (err) {
        if (cancelled) return;
        // Engine was never reachable on this boot → fall back to explicit Demo Mode.
        clientRef.current = null;
        setConnection("demo");
        setConnectionError(
          err instanceof Error ? err.message : "Local engine unreachable on 127.0.0.1:32145",
        );
        loadDemo();
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
        if (resolvedState === "complete") await refreshEvidence(client);
      })();
    }, ANALYSIS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, project?.analysisState, refreshEvidence]);

  const analyze = useCallback(() => {
    const client = clientRef.current;
    setProject((p) =>
      p ? { ...p, analysisState: "running", analysisProgress: 2, analysisError: null } : p,
    );
    if (!client) return; // demo: simulated below
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
          pushVersion(command, prev.id, result);
        } else {
          const { summary, changes, timeline } = commandResult(command, prev);
          pushVersion(command, prev.id, { summary, changes, timeline });
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

  const setMode = useCallback((next: AppMode) => {
    clientRef.current = null;
    setModeState(next);
    setNonce((n) => n + 1);
  }, []);

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
      retryConnection: () => setNonce((n) => n + 1),
      setMode,
      analyze,
      chooseStory: (id: string) => setChosenStoryId(id),
      audition: (id: string | null) => setAuditionId(id),
      toggleStorySelect: (id: string) =>
        setStoryboardSelectIds((ids) =>
          ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
        ),
      runCommand,
      setActiveVersion: (id: string) => setActiveVersionId(id),
      setTargetSeconds,
      updateSettings: (patch: Partial<SettingsState>) => setSettings((s) => ({ ...s, ...patch })),
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
      analyze,
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
