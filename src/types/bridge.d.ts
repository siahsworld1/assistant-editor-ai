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
  /** The project to reopen on launch (kept by the main process). */
  getActiveProject(): Promise<{ ok: boolean; id?: string | null; error?: string }>;
  setActiveProject(id: string | null): Promise<{ ok: boolean; error?: string }>;
  /** Per-project editor state (versions, active cut, chosen story). */
  loadEditState(id: string): Promise<{ ok: boolean; state?: unknown; error?: string }>;
  saveEditState(
    id: string,
    state: unknown,
  ): Promise<{
    ok: boolean;
    error?: string;
    code?: string;
    /** The file it replaced (another analysis's or damaged edits) was first
     * kept as this file name, beside it. */
    preservedAs?: string;
  }>;
  /** Schema-2 editor state (1.1+), kept in its own file so the schema-1 file
   * above stays exactly as beta.1 wrote it. Optional: older bridges lack it. */
  loadEditStateV2?(id: string): Promise<{
    ok: boolean;
    state?: unknown;
    error?: string;
    /** The file exists but couldn't be read; a copy was kept as `preservedAs`. */
    unreadable?: boolean;
    preservedAs?: string;
  }>;
  saveEditStateV2?(
    id: string,
    state: unknown,
  ): Promise<{
    ok: boolean;
    error?: string;
    code?: string;
    /** The file it replaced (another analysis's or damaged edits) was first
     * kept as this file name, beside it. */
    preservedAs?: string;
  }>;
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

export type CredentialProvider = "openai" | "anthropic";

/** Renderer-safe credential status (electron/credential-store.cjs) — never the key. */
export interface CredentialStatusResponse {
  ok: boolean;
  error?: string;
  providers: Record<CredentialProvider, { name: string; configured: boolean }>;
  /** "worker": saved keys drive the worker (packaged app). "development-dotenv":
   * development keeps using the repository .env. */
  appliesTo: "worker" | "development-dotenv";
  worker: { state: WorkerStatus["state"]; owned: boolean };
}

export interface CredentialChangeResponse extends Partial<CredentialStatusResponse> {
  ok: boolean;
  error?: string;
  /** How the change reached the worker. */
  worker?: CredentialStatusResponse["worker"] & {
    applied?: boolean;
    restarted?: boolean;
    reason?: "development-dotenv" | "adopted" | "restart-failed";
    error?: string;
  };
}

export interface CredentialsApi {
  available: true;
  status(): Promise<CredentialStatusResponse>;
  save(provider: CredentialProvider, key: string): Promise<CredentialChangeResponse>;
  remove(provider: CredentialProvider): Promise<CredentialChangeResponse>;
}

declare global {
  interface Window {
    /** AI-provider key management — status/save/remove only, never read-back. */
    assistantEditorCredentials?: CredentialsApi;
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
