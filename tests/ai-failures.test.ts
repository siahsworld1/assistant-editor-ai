// Release Step 4C, FIX 1 — AI/provider failures reach the app instead of
// failing silently. Payloads mirror worker/store.py::project_json and
// worker/pipeline.py::build_timeline after a reproduced network failure.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canRetryAi, groupAiIssues } from "@/lib/ae/ai-status";
import { extractBuildStatus, normalizeProjectPatch } from "@/lib/ae/normalize";
import { AEProvider, useAE } from "@/lib/ae/store";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateRequest } = require("../electron/allowlist.cjs");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const networkFailure = (task: string, provider: string, clipId?: string) => ({
  task,
  status: "failed",
  provider,
  category: "network",
  message: `couldn't connect to ${provider}`,
  retryable: true,
  httpStatus: null,
  ...(clipId ? { clipId, filename: `${clipId}.mov` } : {}),
});

function failedProject(outcome: "failed" | "succeeded" = "failed") {
  const failed = outcome === "failed";
  return {
    id: "proj-1",
    mediaRoot: "/Users/editor/Footage",
    analysisState: "complete",
    analysisProgress: 100,
    analysisId: "analysis-A",
    analysisOutcome: outcome,
    analysisMessage: failed
      ? "AI analysis failed — transcription couldn't connect to OpenAI."
      : null,
    aiIssues: failed
      ? [
          networkFailure("transcription", "OpenAI", "clip-001"),
          networkFailure("visual-analysis", "Anthropic", "clip-001"),
          networkFailure("transcription", "OpenAI", "clip-002"),
        ]
      : [],
    clips: ["clip-001", "clip-002"].map((id) => ({
      id,
      filename: `${id}.mov`,
      state: "analyzed",
      fps: 23.976,
      durationSeconds: 9,
      hasTranscript: !failed,
      aiStatus: outcome,
      ai: {
        transcription: failed
          ? networkFailure("transcription", "OpenAI")
          : { task: "transcription", status: "succeeded", provider: "OpenAI" },
      },
    })),
    transcript: [],
    visualEvidence: [],
    error: null,
  };
}

describe("AI failure state from GET /project", () => {
  it("is carried through with safe, typed fields", () => {
    const patch = normalizeProjectPatch({ project: failedProject() });
    expect(patch.analysisState).toBe("complete");
    expect(patch.analysisOutcome).toBe("failed");
    expect(patch.analysisMessage).toBe(
      "AI analysis failed — transcription couldn't connect to OpenAI.",
    );
    expect(patch.aiIssues).toHaveLength(3);
    expect(patch.aiIssues![0]).toEqual({
      task: "transcription",
      status: "failed",
      provider: "OpenAI",
      category: "network",
      message: "couldn't connect to OpenAI",
      retryable: true,
      clipId: "clip-001",
      filename: "clip-001.mov",
    });
    expect(patch.clips![0]!.state).toBe("analyzed"); // the clip itself was processed…
    expect(patch.clips![0]!.aiStatus).toBe("failed"); // …its AI was not
    expect(patch.clips![0]!.ai!["transcription"]!.category).toBe("network");
  });

  it("clears after a successful retry", () => {
    const patch = normalizeProjectPatch({ project: failedProject("succeeded") });
    expect(patch.analysisOutcome).toBe("succeeded");
    expect(patch.aiIssues).toEqual([]);
    expect(patch.analysisMessage).toBeNull();
  });

  it("an analysis saved before AI status existed reports no outcome", () => {
    const legacy = {
      ...failedProject(),
      analysisOutcome: null,
      aiIssues: [],
      analysisMessage: null,
    };
    const patch = normalizeProjectPatch({ project: legacy });
    expect(patch.analysisOutcome).toBeNull();
    expect(canRetryAi({ ...(patch as never), analysisState: "complete" })).toBe(false);
  });
});

describe("WATCH presentation", () => {
  it("groups per-clip failures into one line per cause", () => {
    const patch = normalizeProjectPatch({ project: failedProject() });
    expect(groupAiIssues(patch.aiIssues!)).toEqual([
      { text: "Transcription couldn't connect to OpenAI", clips: 2, retryable: true },
      { text: "Visual analysis couldn't connect to Anthropic", clips: 1, retryable: true },
    ]);
  });

  it("offers Retry AI Analysis only for a completed analysis with failed AI", () => {
    const patch = normalizeProjectPatch({ project: failedProject() }) as never;
    expect(canRetryAi(patch)).toBe(true);
    expect(canRetryAi({ ...(patch as object), analysisState: "running" } as never)).toBe(false);
    expect(
      canRetryAi(normalizeProjectPatch({ project: failedProject("succeeded") }) as never),
    ).toBe(false);
  });

  it("the retry route is allowlisted for the renderer", () => {
    expect(validateRequest("POST", "/analyze/retry-ai").ok).toBe(true);
  });
});

describe("Director build status", () => {
  it("distinguishes a blocked build from a built one", () => {
    expect(
      extractBuildStatus({
        status: "blocked",
        analysis: { status: "failed", message: "x" },
        summary:
          "AI analysis failed — transcription couldn't connect to OpenAI. Fix the cause, then use Retry AI Analysis in WATCH.",
        decisions: [],
      }),
    ).toEqual({
      status: "blocked",
      analysis: "failed",
      message:
        "AI analysis failed — transcription couldn't connect to OpenAI. Fix the cause, then use Retry AI Analysis in WATCH.",
    });
    expect(
      extractBuildStatus({ status: "built", analysis: { status: "succeeded", message: null } })
        .status,
    ).toBe("built");
    expect(extractBuildStatus({ summary: "old engine" })).toEqual({
      status: null,
      analysis: null,
      message: null,
    });
  });
});

/* ------------------------------ store level ------------------------------ */

type Ctx = ReturnType<typeof useAE>;
let ctx: Ctx | null = null;
let root: Root | null = null;
function Probe(): ReactNode {
  ctx = useAE();
  return null;
}

function mountEngine() {
  let projectBody = failedProject();
  const requests: Array<{ method: string; path: string }> = [];
  window.assistantEditorBridge = {
    request: vi.fn(async (req: { method: string; path: string }) => {
      requests.push({ method: req.method, path: req.path });
      const path = req.path.split("?")[0];
      if (path === "/health")
        return {
          status: 200,
          body: {
            ok: true,
            service: "assistant-editor-worker",
            capabilities: {
              health: true,
              analyze: true,
              selects: true,
              stories: true,
              build: true,
              project: true,
              nle: false,
            },
          },
        };
      if (path === "/restore") return { status: 200, body: { restored: true, reason: "restored" } };
      if (path === "/project") return { status: 200, body: { project: projectBody } };
      if (path === "/selects") return { status: 200, body: { selects: [] } };
      if (path === "/stories") return { status: 200, body: { stories: [] } };
      if (path === "/build")
        return {
          status: 200,
          body: {
            status: "blocked",
            analysis: { status: "failed", message: projectBody.analysisMessage },
            summary: `${projectBody.analysisMessage} Fix the cause, then use Retry AI Analysis in WATCH.`,
            changes: [],
            decisions: [],
          },
        };
      if (path === "/analyze/retry-ai") {
        projectBody = failedProject("succeeded");
        return { status: 200, body: { accepted: true, state: "running" } };
      }
      return { status: 404, body: null };
    }),
  };
  const project = {
    id: "proj-1",
    name: "Doc",
    client: "c",
    format: "Documentary",
    profile: "documentary",
    mediaRoot: "/Users/editor/Footage",
    mediaCount: 2,
    createdAt: "",
    updatedAt: "",
  };
  window.assistantEditorDesktop = {
    available: true as const,
    version: "t",
    listProjects: vi.fn(async () => ({ ok: true, projects: [project] })),
    saveProject: vi.fn(async () => ({ ok: true, projects: [project] })),
    deleteProject: vi.fn(async () => ({ ok: true, projects: [project] })),
    chooseMediaFolder: vi.fn(async () => ({ ok: false })),
    indexMedia: vi.fn(async () => ({ ok: false })),
    exportFile: vi.fn(async () => ({ ok: false })),
    setActiveMediaRoot: vi.fn(async () => ({ ok: true })),
    getActiveProject: vi.fn(async () => ({ ok: true, id: "proj-1" })),
    setActiveProject: vi.fn(async () => ({ ok: true })),
    loadEditState: vi.fn(async () => ({ ok: true, state: null })),
    saveEditState: vi.fn(async () => ({ ok: true })),
  };
  return requests;
}

async function settle(until: (c: Ctx) => boolean, ms = 8000) {
  for (let t = 0; t < ms; t += 25) {
    if (ctx && until(ctx)) return;
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
  throw new Error(
    `never settled (state=${ctx?.project?.analysisState}, outcome=${ctx?.project?.analysisOutcome})`,
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  ctx = null;
  delete window.assistantEditorBridge;
  delete window.assistantEditorDesktop;
  window.localStorage.clear();
});

describe("store: failed AI analysis", () => {
  it("the Director explains the failure instead of adding an empty version, and Retry clears it", async () => {
    const requests = mountEngine();
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(AEProvider, null, createElement(Probe))));
    await settle((c) => c.project?.analysisOutcome === "failed");

    const before = ctx!.versions.length;
    await act(async () => ctx!.runCommand("Create a 30-second rough cut"));
    expect(ctx!.versions).toHaveLength(before);
    expect(ctx!.directorNotice).toContain("couldn't connect to OpenAI");
    expect(ctx!.directorNotice).not.toContain("run Analyze first");

    await act(async () => ctx!.retryAiAnalysis());
    expect(requests).toContainEqual({ method: "POST", path: "/analyze/retry-ai" });
    await settle(
      (c) => c.project?.analysisState === "complete" && c.project?.analysisOutcome === "succeeded",
    );
    expect(ctx!.project!.aiIssues).toEqual([]);
    expect(requests.filter((r) => r.path === "/analyze")).toHaveLength(0); // never a full re-analysis
  }, 15000);
});
