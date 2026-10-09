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
  extractBuildStatus,
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
  type BuildStatus,
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

export interface RestoreResult {
  restored: boolean;
  /** e.g. "restored", "already-loaded", "no-saved-analysis", "media-changed". */
  reason: string;
}

export interface SourceFrame {
  seconds: number;
  /** mediaRoot-relative, served through the ae-media:// protocol. */
  relPath: string;
}

export interface BuildResult {
  timeline: UniversalTimeline;
  summary: string;
  changes: string[];
  /** Absent for Demo Mode / engines that don't report it. */
  status?: BuildStatus | undefined;
}

/** What the AI Director answered for one instruction (POST /propose). A
 * proposal is NOT trusted here: the app validates it deterministically. */
export type DirectorProposalResult =
  | { status: "proposal"; proposal: Record<string, unknown> }
  | { status: "refused"; reason: string }
  | { status: "failed"; message: string; retryable: boolean }
  | { status: "invalid"; reason: string };

/** What POST /propose/story answered (Phase 6). A plan is only a plan: the
 * app binds it to the cut it described and compiles it (story-plan.ts). */
export type StoryPlanResult =
  | { status: "plan"; plan: Record<string, unknown> }
  | { status: "refused"; reason: string }
  | { status: "failed"; message: string; retryable: boolean }
  | { status: "invalid"; reason: string };

/** What POST /propose/coverage-rank answered (Phase 7). A ranking is only
 * a ranking: the app checks it against the live cut (coverage-ranking.ts)
 * and its deterministic planner decides any placement. */
export type CoverageRankResult =
  | { status: "ranking"; ranking: Record<string, unknown> }
  | { status: "refused"; reason: string }
  | { status: "failed"; message: string; retryable: boolean }
  | { status: "invalid"; reason: string };

export interface RetryAiResult {
  accepted: boolean;
  /** Why nothing started: "nothing-to-retry", "analysis-running", … */
  reason: string | null;
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
    /** The filmmaker confirmed replacing THIS saved analysis. */
    confirmReplace?: { analysisId: string; allowIncomplete: boolean } | undefined;
  }): Promise<AnalyzeResult> {
    const body: Record<string, unknown> = {};
    if (meta.confirmReplace) body["confirmReplace"] = meta.confirmReplace;
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
    return {
      timeline: normalizeTimeline(raw, req.targetSeconds),
      ...extractBuildSummary(raw),
      status: extractBuildStatus(raw),
    };
  }

  /** Asks the AI Director for an edit proposal against the CURRENT sequence
   * (worker/director.py). Never throws: an unreachable engine, a timeout or a
   * provider failure comes back as `failed`. */
  async propose(instruction: string, context: unknown): Promise<DirectorProposalResult> {
    let raw: unknown;
    try {
      raw = await this.call("build", "/propose", {
        method: "POST",
        body: { instruction, context },
        timeoutMs: 90000,
      });
    } catch (err) {
      return {
        status: "failed",
        message: `The local engine didn't answer (${message(err)}).`,
        retryable: true,
      };
    }
    const root = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v.trim() : fallback;
    switch (root["status"]) {
      case "proposal":
        return root["proposal"] && typeof root["proposal"] === "object"
          ? { status: "proposal", proposal: root["proposal"] as Record<string, unknown> }
          : { status: "invalid", reason: "The Director's reply was not a usable proposal." };
      case "refused":
        return { status: "refused", reason: text(root["reason"], "The Director can't do that.") };
      case "failed": {
        const f = (root["aiFailure"] ?? {}) as Record<string, unknown>;
        return {
          status: "failed",
          message: text(f["message"], "the AI provider didn't respond"),
          retryable: f["retryable"] !== false,
        };
      }
      case "invalid-request":
      case "invalid-response":
        return {
          status: "invalid",
          reason: text(root["reason"], "The Director's reply could not be used."),
        };
      default:
        return { status: "invalid", reason: "The engine doesn't support Director proposals yet." };
    }
  }

  /** A story plan for the current sequence (Phase 6). Never throws. */
  async proposeStory(instruction: string, context: unknown): Promise<StoryPlanResult> {
    let raw: unknown;
    try {
      raw = await this.call("build", "/propose/story", {
        method: "POST",
        body: { instruction, context },
        timeoutMs: 90000,
      });
    } catch (err) {
      return {
        status: "failed",
        message: `The local engine didn't answer (${message(err)}).`,
        retryable: true,
      };
    }
    const root = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v.trim() : fallback;
    switch (root["status"]) {
      case "plan":
        return root["plan"] && typeof root["plan"] === "object" && !Array.isArray(root["plan"])
          ? { status: "plan", plan: root["plan"] as Record<string, unknown> }
          : { status: "invalid", reason: "The Director's reply was not a usable story plan." };
      case "refused":
        return { status: "refused", reason: text(root["reason"], "The Director can't do that.") };
      case "failed": {
        const f = (root["aiFailure"] ?? {}) as Record<string, unknown>;
        return {
          status: "failed",
          message: text(f["message"], "the AI provider didn't respond"),
          retryable: f["retryable"] !== false,
        };
      }
      case "invalid-request":
      case "invalid-response":
        return {
          status: "invalid",
          reason: text(root["reason"], "The Director's reply could not be used."),
        };
      default:
        return { status: "invalid", reason: "The engine doesn't support story plans yet." };
    }
  }

  /** One AI ranking of verified B-roll candidates (POST /propose/coverage-rank).
   * One request per call; never retried here. */
  async rankCoverage(context: unknown): Promise<CoverageRankResult> {
    let raw: unknown;
    try {
      raw = await this.call("build", "/propose/coverage-rank", {
        method: "POST",
        body: { context },
        timeoutMs: 90000,
      });
    } catch (err) {
      return {
        status: "failed",
        message: `The local engine didn't answer (${message(err)}).`,
        retryable: true,
      };
    }
    const root = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : fallback;
    switch (root["status"]) {
      case "ranking":
        return root["ranking"] &&
          typeof root["ranking"] === "object" &&
          !Array.isArray(root["ranking"])
          ? { status: "ranking", ranking: root["ranking"] as Record<string, unknown> }
          : { status: "invalid", reason: "The AI's reply was not a usable ranking." };
      case "refused":
        return {
          status: "refused",
          reason: text(root["reason"], "The AI found nothing to recommend."),
        };
      case "failed": {
        const f = (root["aiFailure"] ?? {}) as Record<string, unknown>;
        return {
          status: "failed",
          message: text(f["message"], "the AI provider didn't respond"),
          retryable: f["retryable"] !== false,
        };
      }
      case "invalid-request":
      case "invalid-response":
        return {
          status: "invalid",
          reason: text(root["reason"], "The AI's reply could not be used."),
        };
      default:
        return { status: "invalid", reason: "The engine doesn't support AI ranking yet." };
    }
  }

  /** Re-runs only the AI steps that failed in the loaded analysis
   * (worker/server.py POST /analyze/retry-ai). Progress is then reported by
   * GET /project exactly like a normal analysis. */
  async retryAi(): Promise<RetryAiResult> {
    const raw = await this.call("analyze", "/analyze/retry-ai", { method: "POST", body: {}, timeoutMs: 15000 });
    const root = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      accepted: root["accepted"] === true,
      reason: typeof root["reason"] === "string" ? root["reason"] : null,
    };
  }

  /**
   * Reloads the engine's saved analysis for a project's media folder after the
   * app or engine restarted (worker/persistence.py). Never throws: an engine
   * without the route, or any failure, simply means "nothing restored".
   */
  async restore(projectId: string, mediaRoot: string): Promise<RestoreResult> {
    try {
      const raw = (await this.call("project", "/restore", {
        method: "POST",
        body: { projectId, mediaRoot },
        timeoutMs: 30000,
      })) as Record<string, unknown> | null;
      return {
        restored: raw?.["restored"] === true,
        reason: typeof raw?.["reason"] === "string" ? (raw["reason"] as string) : "unknown",
      };
    } catch {
      return { restored: false, reason: "unavailable" };
    }
  }

  /**
   * Real frames of a clip at source times (seconds). The result is ALIGNED with
   * `times` (one entry per requested time, null where that frame failed), so a
   * failure can never shift another frame onto the wrong moment.
   */
  async frames(
    clipId: string,
    times: number[],
    width: 160 | 240 | 320 = 240,
  ): Promise<Array<SourceFrame | null>> {
    const raw = (await this.call("project", "/frames", {
      method: "POST",
      body: { clipId, times, width },
      timeoutMs: 60000,
    })) as { frames?: unknown } | null;
    const list = Array.isArray(raw?.frames) ? raw.frames : [];
    return times.map((_, i) => {
      const f = list[i] as { seconds?: unknown; relPath?: unknown } | undefined;
      return f && typeof f.relPath === "string"
        ? { seconds: Number(f.seconds), relPath: f.relPath }
        : null;
    });
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
