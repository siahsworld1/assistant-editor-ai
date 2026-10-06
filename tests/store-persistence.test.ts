// P0 Step 8: reopening a project after quitting. Mounts the real AEProvider
// (happy-dom) with the desktop + engine bridges mocked the way
// electron/preload.cjs exposes them, and checks that the project, its engine
// analysis and its saved cuts come back — and that nothing is saved over a
// project's cuts before they've been loaded.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEProvider, useAE } from "@/lib/ae/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useAE>;
let ctx: Ctx | null = null;
let root: Root | null = null;
function Probe(): ReactNode {
  ctx = useAE();
  return null;
}

const MEDIA = "/Users/editor/Footage/doc";
const projects = [
  {
    id: "proj-1",
    name: "Older",
    client: "c",
    format: "Documentary",
    profile: "documentary",
    mediaRoot: "",
    mediaCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  },
  {
    id: "proj-2",
    name: "The doc",
    client: "c",
    format: "Documentary",
    profile: "documentary",
    mediaRoot: MEDIA,
    mediaCount: 6,
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  },
];
const savedState = {
  schema: 1,
  analysisId: "analysis-A",
  versions: [
    {
      id: "v1",
      label: "Awaiting first build",
      version: "v1.0",
      command: "",
      summary: "",
      createdAt: "—",
      changes: [],
      timeline: { id: "t0", name: "x", fps: 24, targetSeconds: 30, totalSeconds: 0, decisions: [] },
    },
    {
      id: "v2",
      label: "30-second cut",
      version: "v1.1",
      command: "Create a 30-second rough cut",
      summary: "s",
      createdAt: "10:00",
      changes: [],
      parentId: "v1",
      timeline: {
        id: "t1",
        name: "cut",
        fps: 24,
        targetSeconds: 30,
        totalSeconds: 4,
        decisions: [
          {
            id: "e1",
            lane: "interview",
            clipId: "clip-001",
            label: "a",
            sourceInTc: "00:00:01:00",
            sourceOutTc: "00:00:05:00",
            timelineStartSeconds: 0,
            durationSeconds: 4,
          },
        ],
      },
    },
  ],
  activeVersionId: "v2",
  chosenStoryId: "story-02",
  targetSeconds: 30,
  storyboardSelectIds: ["sel-02"],
  savedAt: "2026-10-05T10:00:00Z",
};

function mountWith(engineAnalysisId: string) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  window.assistantEditorBridge = {
    request: vi.fn(async (req: { method: string; path: string; body?: unknown }) => {
      requests.push(req);
      const path = req.path.split("?")[0];
      if (path === "/health")
        return {
          status: 200,
          body: {
            ok: true,
            version: "t",
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
      if (path === "/project")
        return {
          status: 200,
          body: {
            project: {
              id: "proj-2",
              mediaRoot: MEDIA,
              analysisState: "complete",
              analysisProgress: 100,
              analysisId: engineAnalysisId,
              clips: [{ id: "clip-001", filename: "18C_0681.MP4", fps: 23.976, state: "analyzed" }],
              transcript: [],
              visualEvidence: [],
            },
          },
        };
      if (path === "/selects")
        return {
          status: 200,
          body: {
            selects: [
              {
                id: "sel-02",
                rank: 1,
                speaker: "Ana",
                clipId: "clip-001",
                startTc: "00:00:01:00",
                endTc: "00:00:05:00",
                score: 90,
                transcriptExcerpt: "x",
              },
            ],
          },
        };
      if (path === "/stories")
        return {
          status: 200,
          body: {
            stories: [
              { id: "story-01", title: "One", beats: [] },
              { id: "story-02", title: "Two", beats: [] },
            ],
          },
        };
      return { status: 404, body: null };
    }),
  };
  const desktop = {
    available: true as const,
    version: "t",
    listProjects: vi.fn(async () => ({ ok: true, projects })),
    saveProject: vi.fn(async () => ({ ok: true, projects })),
    deleteProject: vi.fn(async () => ({ ok: true, projects })),
    chooseMediaFolder: vi.fn(async () => ({ ok: false })),
    indexMedia: vi.fn(async () => ({ ok: false })),
    exportFile: vi.fn(async () => ({ ok: false })),
    setActiveMediaRoot: vi.fn(async () => ({ ok: true })),
    getActiveProject: vi.fn(async () => ({ ok: true, id: "proj-2" })),
    setActiveProject: vi.fn(async () => ({ ok: true })),
    loadEditState: vi.fn(async () => ({ ok: true, state: savedState })),
    saveEditState: vi.fn(async () => ({ ok: true })),
  };
  window.assistantEditorDesktop = desktop;
  return { requests, desktop };
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AEProvider, null, createElement(Probe))));
}

async function settle(until: (c: Ctx) => boolean, ms = 3000) {
  for (let t = 0; t < ms; t += 20) {
    if (ctx && until(ctx)) return;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error(
    `never settled (connection=${ctx?.connection}, versions=${ctx?.versions.length})`,
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

describe("reopening a project after quitting", () => {
  it("restores the active project, its engine analysis and its saved cuts", async () => {
    const { requests, desktop } = mountWith("analysis-A");
    await mount();
    await settle((c) => c.versions.length === 2);

    expect(ctx!.activeProject?.id).toBe("proj-2"); // from the main process — not list[0]
    expect(requests).toContainEqual(
      expect.objectContaining({
        path: "/restore",
        body: { projectId: "proj-2", mediaRoot: MEDIA },
      }),
    );
    expect(ctx!.project?.analysisId).toBe("analysis-A");
    expect(ctx!.selects.map((s) => s.id)).toEqual(["sel-02"]);
    expect(ctx!.activeVersionId).toBe("v2");
    expect(ctx!.chosenStoryId).toBe("story-02");
    expect(ctx!.targetSeconds).toBe(30);
    expect(ctx!.versions.find((v) => v.id === "v2")!.timeline.decisions[0]!.clipId).toBe(
      "clip-001",
    );

    // Never wrote a fresh baseline over the saved cuts before they were loaded.
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    for (const [, state] of desktop.saveEditState.mock.calls as unknown as Array<
      [string, { versions: unknown[] }]
    >) {
      expect(state.versions).toHaveLength(2);
    }
  });

  it("does not restore cuts built on a different analysis (and doesn't overwrite them)", async () => {
    const { desktop } = mountWith("analysis-B"); // the media was re-analyzed since
    await mount();
    await settle((c) => c.project?.analysisId === "analysis-B" && c.selects.length === 1);
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(ctx!.versions.map((v) => v.id)).toEqual(["v1"]);
    expect(desktop.saveEditState).not.toHaveBeenCalled();
  });

  it("saves the editor state after it changes, tagged with the current analysis", async () => {
    const { desktop } = mountWith("analysis-A");
    await mount();
    await settle((c) => c.versions.length === 2);
    await act(async () => ctx!.chooseStory("story-01"));
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    const last = desktop.saveEditState.mock.calls.at(-1) as unknown as [
      string,
      { analysisId: string; chosenStoryId: string },
    ];
    expect(last[0]).toBe("proj-2");
    expect(last[1]).toMatchObject({ analysisId: "analysis-A", chosenStoryId: "story-01" });
  });
});
