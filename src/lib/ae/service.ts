// Engine client. Owns endpoint semantics, optional-endpoint tolerance and
// diagnostics reporting. All payloads pass through ./normalize before reaching state.

import {
  DirectLoopbackTransport,
  DesktopBridgeTransport,
  ENGINE_BASE_URL,
  TransportError,
  resolveTransport,
  detectHostContext,
  type EngineTransport,
  type HostContext,
} from "./transport";
import {
  extractBuildSummary,
  normalizeAnalyze,
  normalizeCapabilities,
  normalizeHealth,
  normalizeNle,
  normalizeProjectPatch,
  normalizeSelects,
  normalizeStories,
  normalizeTimeline,
  type AnalyzeResult,
} from "./normalize";
import type {
  EngineCapabilities,
  EngineEndpoint,
  EngineHealth,
  NLEStatus,
  ProjectBrain,
  Select,
  StoryCandidate,
  UniversalTimeline,
} from "./types";

export {
  ENGINE_BASE_URL,
  DirectLoopbackTransport,
  DesktopBridgeTransport,
  resolveTransport,
  detectHostContext,
};
export type { EngineTransport, HostContext };

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface BuildRequest {
  projectId: string;
  storyId: string;
  targetSeconds: number;
  command?: string;
}

export interface BuildResult {
  timeline: UniversalTimeline;
  summary: string;
  changes: string[];
}

export type DiagnosticReporter = (
  endpoint: EngineEndpoint,
  result: { ok: boolean; error?: string; unsupported?: boolean },
) => void;

function message(err: unknown): string {
  if (err instanceof TransportError || err instanceof EngineError) return err.message;
  return err instanceof Error ? err.message : "Unknown engine error";
}

function statusOf(err: unknown): number | undefined {
  return err instanceof TransportError || err instanceof EngineError ? err.status : undefined;
}

/** 404/405/501 from an optional route means "not implemented by this worker". */
function isUnsupported(err: unknown): boolean {
  const s = statusOf(err);
  return s === 404 || s === 405 || s === 501;
}

export class EngineClient {
  constructor(
    readonly transport: EngineTransport,
    private readonly report: DiagnosticReporter = () => {},
  ) {}

  private async call(
    endpoint: EngineEndpoint,
    path: string,
    init?: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number },
  ): Promise<unknown> {
    try {
      const data = await this.transport.request({ path, ...init });
      this.report(endpoint, { ok: true });
      return data;
    } catch (err) {
      this.report(endpoint, {
        ok: false,
        error: message(err),
        ...(isUnsupported(err) ? { unsupported: true } : {}),
      });
      throw new EngineError(message(err), statusOf(err));
    }
  }

  /** The only probe that decides Live vs not. */
  async health(): Promise<{ health: EngineHealth; capabilities: EngineCapabilities }> {
    const raw = await this.call("health", "/health", { timeoutMs: 4000 });
    return { health: normalizeHealth(raw), capabilities: normalizeCapabilities(raw) };
  }

  /**
   * Generic analyze payload. Some workers want { projectId }, others only an empty
   * object or path metadata — a rejected payload is retried bare before failing.
   */
  async analyze(meta: {
    projectId?: string | undefined;
    mediaRoot?: string | undefined;
  }): Promise<AnalyzeResult> {
    const body: Record<string, unknown> = {};
    if (meta.projectId) {
      body["projectId"] = meta.projectId;
      body["project"] = meta.projectId;
    }
    if (meta.mediaRoot) {
      body["path"] = meta.mediaRoot;
      body["mediaRoot"] = meta.mediaRoot;
    }
    try {
      return normalizeAnalyze(
        await this.call("analyze", "/analyze", { method: "POST", body, timeoutMs: 15000 }),
      );
    } catch (err) {
      const s = statusOf(err);
      if (s === 400 || s === 415 || s === 422) {
        return normalizeAnalyze(
          await this.call("analyze", "/analyze", { method: "POST", body: {}, timeoutMs: 15000 }),
        );
      }
      throw err;
    }
  }

  async getSelects(projectId?: string): Promise<Select[]> {
    return normalizeSelects(await this.queryWithOptionalProject("selects", "/selects", projectId));
  }

  async getStories(projectId?: string): Promise<StoryCandidate[]> {
    return normalizeStories(await this.queryWithOptionalProject("stories", "/stories", projectId));
  }

  private async queryWithOptionalProject(
    endpoint: EngineEndpoint,
    path: string,
    projectId?: string,
  ): Promise<unknown> {
    const qs = projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;
    try {
      return await this.call(endpoint, qs, { timeoutMs: 10000 });
    } catch (err) {
      if (projectId && statusOf(err) === 400) return this.call(endpoint, path, { timeoutMs: 10000 });
      throw err;
    }
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const raw = await this.call("build", "/build", {
      method: "POST",
      body: {
        projectId: req.projectId,
        project: req.projectId,
        storyId: req.storyId,
        story: req.storyId,
        targetSeconds: req.targetSeconds,
        ...(req.command ? { command: req.command, prompt: req.command } : {}),
      },
      // A real engine calls out to an LLM synchronously to assemble the timeline —
      // give that materially more room than the original mock's 30s budget.
      timeoutMs: 90000,
    });
    return { timeline: normalizeTimeline(raw, req.targetSeconds), ...extractBuildSummary(raw) };
  }

  /** Optional enrichment. Resolves to null when the worker does not implement it. */
  async getProjectPatch(): Promise<Partial<ProjectBrain> | null> {
    try {
      return normalizeProjectPatch(await this.call("project", "/project", { timeoutMs: 6000 }));
    } catch {
      return null;
    }
  }

  /** Optional enrichment. Null means "bridge not reported", never Demo Mode. */
  async getNle(): Promise<NLEStatus[] | null> {
    try {
      const list = normalizeNle(await this.call("nle", "/nle", { timeoutMs: 6000 }));
      return list.length ? list : null;
    } catch {
      return null;
    }
  }
}
