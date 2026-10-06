import type { DesktopBridgeApi } from "@/lib/ae/transport";
import type { IndexedMediaFile, ProjectRecord } from "@/lib/ae/projects";

/** Responses from electron/desktop-capabilities.cjs. Never `any`. */
export interface DesktopProjectsResponse {
  ok: boolean;
  error?: string;
  projects?: unknown;
  project?: unknown;
}

export interface DesktopFolderResponse {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  path?: string;
}

export interface DesktopMediaIndexResponse {
  ok: boolean;
  error?: string;
  root?: string;
  files?: IndexedMediaFile[];
  truncated?: boolean;
}

export interface DesktopExportResponse {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  path?: string;
}

export interface DesktopMediaRootResponse {
  ok: boolean;
  error?: string;
}

export interface DesktopCapabilitiesApi {
  available: true;
  version: string;
  listProjects(): Promise<DesktopProjectsResponse>;
  saveProject(project: ProjectRecord): Promise<DesktopProjectsResponse>;
  deleteProject(id: string): Promise<DesktopProjectsResponse>;
  chooseMediaFolder(): Promise<DesktopFolderResponse>;
  indexMedia(path: string): Promise<DesktopMediaIndexResponse>;
  exportFile(suggestedName: string, content: string): Promise<DesktopExportResponse>;
  /** Authorizes the ae-media:// playback protocol to stream from this mediaRoot
   * (must already be authorized via chooseMediaFolder). Pass "" to deauthorize. */
  setActiveMediaRoot(root: string): Promise<DesktopMediaRootResponse>;
}

/** Snapshot from electron/worker-supervisor.cjs::WorkerSupervisor.status(). */
export interface WorkerStatus {
  state: "idle" | "starting" | "ready" | "error" | "stopped";
  /** True when this app started the worker (and will stop it on quit). */
  owned: boolean;
  pid: number | null;
  url: string;
  error: {
    kind: string;
    message: string;
    /** Last worker log lines (secrets redacted) — the actual cause, if any. */
    logTail?: string[];
  } | null;
}

export interface WorkerLifecycleApi {
  available: true;
  status(): Promise<WorkerStatus>;
  /** Resolves once startup has settled: state "ready" or "error". */
  waitUntilReady(): Promise<WorkerStatus>;
  restart(): Promise<WorkerStatus>;
}

declare global {
  interface Window {
    /** Local engine lifecycle owned by the desktop companion (electron/worker-supervisor.cjs). */
    assistantEditorWorker?: WorkerLifecycleApi;
    /** Injected by the Assistant Editor desktop companion (electron/preload.cjs). */
    assistantEditorBridge?: DesktopBridgeApi;
    /** Narrow desktop capabilities: project persistence + user-gated media import. */
    assistantEditorDesktop?: DesktopCapabilitiesApi;
    /** Premiere Pro (UXP) integration status + command queue (v0.4.0). */
    assistantEditorPremiere?: import("@/lib/nle/premiere/contract").PremiereRendererApi;
  }
}

export {};
