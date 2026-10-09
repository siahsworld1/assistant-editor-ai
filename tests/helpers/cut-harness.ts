// Shared harness for the CUT timeline interaction tests: the REAL store
// (AEProvider → schema-2 workspace, history, persistence) and the REAL playback
// hook, wired exactly as src/routes/cut.tsx wires them, with a fake engine and
// an in-memory "disk". Drivers dispatch real pointer and keyboard events.
//
// The v1.2-shaped Director cut (24 fps sequence, 23.976 media):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 (over e3) · e7 708–784 (over e6)
//   A1: linked sync audio, aligned with every V1 item.
import { act, createElement, Fragment, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vitest";
import { ProposalPanel } from "@/components/ae/ProposalPanel";
import { RestoreWarnings } from "@/components/ae/RestoreWarnings";
import { TimelineEditor } from "@/components/ae/TimelineEditor";
import { useProposalPreview, type ProposalPreview } from "@/lib/ae/proposal-preview";
import { AEProvider, useAE } from "@/lib/ae/store";
import { useTimelinePlayback, type TimelinePlayback } from "@/lib/ae/timeline-playback";
import type { Clip, EditVersion } from "@/lib/ae/types";
import type { ClipItem, Sequence } from "@/lib/timeline/types";
import { directorCut, projectClips } from "../timeline/legacy-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const MEDIA_ROOT = "/Users/editor/Footage";
export const ANALYSIS = "analysis-A";
export const baseline: EditVersion = {
  id: "v1",
  label: "Awaiting first build",
  version: "v1.0",
  command: "—",
  summary: "No sequence built yet.",
  createdAt: "—",
  changes: [],
  timeline: {
    id: "tl-empty",
    name: "Empty",
    fps: 24,
    targetSeconds: 30,
    totalSeconds: 0,
    decisions: [],
  },
};
export const director: EditVersion = {
  id: "v2",
  label: "Create a 30-second rough cut",
  version: "v1.1",
  command: "Create a 30-second rough cut",
  summary: "Director build.",
  createdAt: "18:16",
  changes: [],
  timeline: directorCut,
  parentId: "v1",
};
export const schema1File = JSON.stringify({
  schema: 1,
  analysisId: ANALYSIS,
  versions: [baseline, director],
  activeVersionId: "v2",
  chosenStoryId: "story-01",
  targetSeconds: 30,
  storyboardSelectIds: [],
  savedAt: "2026-10-06T19:00:00.000Z",
});

/** Scripted AI Director: what POST /propose answers (fake — no provider). */
export const fakeDirector: {
  replies: Array<
    unknown | ((body: { instruction: string; context: Record<string, unknown> }) => unknown)
  >;
  requests: Array<{ instruction: string; context: Record<string, unknown> }>;
  delayMs: number;
} = { replies: [], requests: [], delayMs: 0 };

/** The analysis the fake engine reports (transcript and selects), and an
 * optional second project to switch to. Set before launch(). */
export const fakeAnalysis: {
  transcript: unknown[];
  selects: unknown[];
  otherProject: boolean;
  /** Cover mode: logged visual evidence and the engine's clips (default:
   * projectClips, no dialogue assessment). */
  visualEvidence?: unknown[];
  clips?: Clip[];
} = {
  transcript: [],
  selects: [],
  otherProject: false,
};

/** Scripted story Director: what POST /propose/story answers (fake — no provider). */
export const fakeStory: {
  replies: Array<
    unknown | ((body: { instruction: string; context: Record<string, unknown> }) => unknown)
  >;
  requests: Array<{ instruction: string; context: Record<string, unknown> }>;
  delayMs: number;
} = { replies: [], requests: [], delayMs: 0 };

/** Scripted AI ranking: what POST /propose/coverage-rank answers (fake — no provider). */
export const fakeRank: {
  replies: Array<unknown | ((body: { context: Record<string, unknown> }) => unknown)>;
  requests: Array<{ context: Record<string, unknown> }>;
  delayMs: number;
} = { replies: [], requests: [], delayMs: 0 };

/** What the worker answers with no AI key configured (the dev app). */
export const NOT_CONFIGURED = {
  status: "failed",
  aiFailure: {
    task: "director",
    status: "failed",
    category: "not-configured",
    message: "No AI provider is configured — add an API key in Settings",
    retryable: false,
  },
};

export interface Disk {
  v1: string | null;
  v2: string | null;
  saves2: number;
  fail2?: "write-failed" | null;
  /** The project record as last saved (e.g. with media-role overrides). */
  project?: unknown;
}

export type Ctx = ReturnType<typeof useAE>;
export let ctx: Ctx | null = null;
export let pb: TimelinePlayback | null = null;
export let pr: ProposalPreview | null = null;
export let root: Root | null = null;
export const pauseSpy = vi.fn();
export const togglePlaySpy = vi.fn();
export const shuttleSpy = vi.fn();
export const EMPTY: Clip[] = [];

/** The CUT timeline wired exactly as src/routes/cut.tsx wires it. */
export function Harness(): ReactNode {
  const ae = useAE();
  ctx = ae;
  const version = ae.versions.find((v) => v.id === ae.activeVersionId) ?? ae.versions[0]!;
  const clips = ae.project?.clips ?? EMPTY;
  const proposals = useProposalPreview(ae.editor);
  const [selection, setSelection] = useState<string[]>([]);
  pr = proposals;
  const [coverage, setCoverage] = useState(false);
  const playback = useTimelinePlayback(proposals.previewTimeline ?? version.timeline, clips);
  pb = playback;
  const panel = createElement(ProposalPanel, {
    editor: ae.editor,
    preview: proposals,
    selection,
    askDirector: ae.askDirector,
    askStory: ae.askStory,
    coverCuts: ae.coverCuts,
    rankCoverage: ae.askCoverageRanking,
    setMediaRole: ae.setMediaRole,
    onModeChange: (m: string) => setCoverage(m === "cover"),
    onBeforeChange: playback.pause,
    demo: true,
  });
  const timeline = createElement(TimelineEditor, {
    compare: proposals.compare,
    showCoverage: coverage,
    onSelectionChange: setSelection,
    editor: ae.editor,
    playback: {
      ...playback,
      pause: () => {
        pauseSpy();
        playback.pause();
      },
      togglePlay: () => {
        togglePlaySpy();
        playback.togglePlay();
      },
      shuttle: (direction: 1 | -1) => {
        shuttleSpy(direction);
        playback.shuttle(direction);
      },
    },
    clips,
  });
  const warnings = createElement(RestoreWarnings, { warnings: ae.restoreWarnings });
  return createElement(Fragment, null, warnings, panel, timeline);
}

export function install(disk: Disk) {
  const engineProject = {
    id: "proj-1",
    mediaRoot: MEDIA_ROOT,
    analysisState: "complete",
    analysisProgress: 100,
    analysisId: ANALYSIS,
    clips: (fakeAnalysis.clips ?? projectClips).map((c) => ({
      id: c.id,
      filename: c.filename,
      state: "analyzed",
      fps: c.fps,
      durationSeconds: c.durationSeconds,
      hasTranscript: true,
      ...(c.dialogue ? { dialogue: c.dialogue } : {}),
    })),
    transcript: fakeAnalysis.transcript,
    visualEvidence: fakeAnalysis.visualEvidence ?? [],
    error: null,
  };
  window.assistantEditorBridge = {
    request: vi.fn(async (req: { method: string; path: string }) => {
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
      if (path === "/project") return { status: 200, body: { project: engineProject } };
      if (path === "/selects") return { status: 200, body: { selects: fakeAnalysis.selects } };
      if (path === "/stories") return { status: 200, body: { stories: [] } };
      if (path === "/propose/coverage-rank") {
        const body = (req as unknown as { body: { context: Record<string, unknown> } }).body;
        fakeRank.requests.push(body);
        if (fakeRank.delayMs) await new Promise((r) => setTimeout(r, fakeRank.delayMs));
        const next = fakeRank.replies.length > 1 ? fakeRank.replies.shift() : fakeRank.replies[0];
        const reply = typeof next === "function" ? next(body) : next;
        if (reply instanceof Error) throw reply;
        return { status: 200, body: reply ?? NOT_CONFIGURED };
      }
      if (path === "/propose/story") {
        const body = (
          req as unknown as { body: { instruction: string; context: Record<string, unknown> } }
        ).body;
        fakeStory.requests.push(body);
        if (fakeStory.delayMs) await new Promise((r) => setTimeout(r, fakeStory.delayMs));
        const next =
          fakeStory.replies.length > 1 ? fakeStory.replies.shift() : fakeStory.replies[0];
        const reply = typeof next === "function" ? next(body) : next;
        if (reply instanceof Error) throw reply;
        return { status: 200, body: reply ?? NOT_CONFIGURED };
      }
      if (path === "/propose") {
        const body = (
          req as unknown as { body: { instruction: string; context: Record<string, unknown> } }
        ).body;
        fakeDirector.requests.push(body);
        if (fakeDirector.delayMs) await new Promise((r) => setTimeout(r, fakeDirector.delayMs));
        const next =
          fakeDirector.replies.length > 1 ? fakeDirector.replies.shift() : fakeDirector.replies[0];
        const reply = typeof next === "function" ? next(body) : next;
        if (reply instanceof Error) throw reply;
        return { status: 200, body: reply ?? NOT_CONFIGURED };
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
    mediaRoot: MEDIA_ROOT,
    mediaCount: projectClips.length,
    createdAt: "",
    updatedAt: "",
  };
  window.assistantEditorDesktop = {
    available: true as const,
    version: "t",
    listProjects: vi.fn(async () => ({
      ok: true,
      projects: fakeAnalysis.otherProject
        ? [disk.project ?? project, { ...project, id: "proj-2", name: "Other" }]
        : [disk.project ?? project],
    })),
    saveProject: vi.fn(async (saved: { id: string }) => {
      if (saved.id === project.id) disk.project = saved;
      return { ok: true, projects: [disk.project ?? project] };
    }),
    deleteProject: vi.fn(async () => ({ ok: true, projects: [project] })),
    chooseMediaFolder: vi.fn(async () => ({ ok: false })),
    indexMedia: vi.fn(async () => ({ ok: false })),
    exportFile: vi.fn(async () => ({ ok: false })),
    setActiveMediaRoot: vi.fn(async () => ({ ok: true })),
    getActiveProject: vi.fn(async () => ({ ok: true, id: "proj-1" })),
    setActiveProject: vi.fn(async () => ({ ok: true })),
    loadEditState: vi.fn(async () => ({ ok: true, state: disk.v1 ? JSON.parse(disk.v1) : null })),
    saveEditState: vi.fn(async (_id: string, state: unknown) => {
      disk.v1 = JSON.stringify(state);
      return { ok: true };
    }),
    loadEditStateV2: vi.fn(async () => {
      if (!disk.v2) return { ok: true, state: null };
      try {
        return { ok: true, state: JSON.parse(disk.v2) };
      } catch {
        // As the main process does: unreadable, a copy kept under this name.
        return {
          ok: true,
          state: null,
          unreadable: true,
          preservedAs: "proj-1.v2.unreadable-x.json",
        };
      }
    }),
    saveEditStateV2: vi.fn(async (_id: string, state: unknown) => {
      if (disk.fail2) return { ok: false, code: disk.fail2 };
      disk.v2 = JSON.stringify(state);
      disk.saves2 += 1;
      return { ok: true };
    }),
  };
}

export async function settle(until: (c: Ctx) => boolean, ms = 8000) {
  for (let t = 0; t < ms; t += 25) {
    if (ctx && until(ctx)) return;
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
  throw new Error("never settled");
}
export const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

export async function launch(
  disk: Disk,
  ready: (c: Ctx) => boolean = (c) => c.activeVersionId === "v2",
) {
  install(disk);
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AEProvider, null, createElement(Harness))));
  await settle((c) => c.project?.analysisId === ANALYSIS && !!c.editor.sequence && ready(c));
  await wait(50);
}
export async function quit() {
  await act(async () => root?.unmount());
  root = null;
  ctx = null;
  pb = null;
  pr = null;
  document.body.innerHTML = "";
}
export const freshDisk = (): Disk => ({ v1: schema1File, v2: null, saves2: 0 });

export async function teardown() {
  await quit();
  delete window.assistantEditorBridge;
  delete window.assistantEditorDesktop;
  window.localStorage.clear();
  pauseSpy.mockClear();
  togglePlaySpy.mockClear();
  fakeDirector.replies = [];
  fakeDirector.requests = [];
  fakeDirector.delayMs = 0;
  fakeAnalysis.transcript = [];
  fakeAnalysis.selects = [];
  fakeAnalysis.otherProject = false;
  delete fakeAnalysis.visualEvidence;
  delete fakeAnalysis.clips;
  fakeStory.replies = [];
  fakeStory.requests = [];
  fakeStory.delayMs = 0;
  fakeRank.replies = [];
  fakeRank.requests = [];
  fakeRank.delayMs = 0;
  shuttleSpy.mockClear();
}

/* --------------------------------- driving -------------------------------- */

export const seq = (): Sequence => ctx!.editor.sequence!;
export function itemOf(s: Sequence, decisionId: string): ClipItem {
  return Object.values(s.items).find((i) => i.legacy?.decision.id === decisionId)!;
}
export const partnerOf = (s: Sequence, it: ClipItem) =>
  s.items[s.links[it.linkGroupId!]!.itemIds.find((id) => id !== it.id)!]!;
export const ppf = () =>
  Number(document.querySelector<HTMLElement>("[data-testid=timeline-editor]")!.dataset.pxPerFrame);
export const x = (frame: number) => frame * ppf();
export const itemEl = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid=timeline-item][data-item-id="${id}"]`)!;
export const q = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

export function pointer(
  target: EventTarget,
  type: string,
  frame: number,
  init: PointerEventInit = {},
) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, clientX: x(frame), ...init }),
    );
  });
}
/** Press on `target` at `frame`, drag to `to` (in steps), optionally release. */
export function drag(
  target: HTMLElement,
  frame: number,
  to: number,
  opts: { release?: boolean } = {},
) {
  pointer(target, "pointerdown", frame);
  const steps = 4;
  for (let i = 1; i <= steps; i += 1)
    pointer(window, "pointermove", frame + ((to - frame) * i) / steps);
  if (opts.release !== false) pointer(window, "pointerup", to);
}
export function click(target: HTMLElement, frame: number, init: PointerEventInit = {}) {
  pointer(target, "pointerdown", frame, init);
  pointer(window, "pointerup", frame, init);
}
export function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
}
export function snappingOff() {
  if (q("timeline-editor")!.dataset.snapping === "on") key("s");
  expect(q("timeline-editor")!.dataset.snapping).toBe("off");
}
