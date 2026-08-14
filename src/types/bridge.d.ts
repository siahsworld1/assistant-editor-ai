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

export interface DesktopCapabilitiesApi {
  available: true;
  version: string;
  listProjects(): Promise<DesktopProjectsResponse>;
  saveProject(project: ProjectRecord): Promise<DesktopProjectsResponse>;
  deleteProject(id: string): Promise<DesktopProjectsResponse>;
  chooseMediaFolder(): Promise<DesktopFolderResponse>;
  indexMedia(path: string): Promise<DesktopMediaIndexResponse>;
  exportFile(suggestedName: string, content: string): Promise<DesktopExportResponse>;
}

declare global {
  interface Window {
    /** Injected by the Assistant Editor desktop companion (electron/preload.cjs). */
    assistantEditorBridge?: DesktopBridgeApi;
    /** Narrow desktop capabilities: project persistence + user-gated media import. */
    assistantEditorDesktop?: DesktopCapabilitiesApi;
    /** Premiere Pro (UXP) integration status + command queue (v0.4.0). */
    assistantEditorPremiere?: import("@/lib/nle/premiere/contract").PremiereRendererApi;
  }
}

export {};
