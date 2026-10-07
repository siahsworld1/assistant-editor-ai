// 1.1 Step 5 — the real store (AEProvider) driving the canonical editor, with
// a fake engine and an in-memory desktop file store standing in for disk:
// opening does not rewrite anything; the first edit forks and creates the
// schema-2 file; quit → relaunch restores the exact Sequence, ids and
// undo/redo; version switching shows the untouched Director cut; a failed
// save is never silent (status, message, retry) and never loses the last
// good file or the edit on screen.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditVersion } from "@/lib/ae/types";
import { AEProvider, useAE } from "@/lib/ae/store";
import { commands } from "@/lib/timeline/commands";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Sequence } from "@/lib/timeline/types";
import { importedSequence } from "@/lib/timeline/workspace";
import { directorCut, projectClips } from "./timeline/legacy-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEDIA_ROOT = "/Users/editor/Footage";
const ANALYSIS = "analysis-A";

const baseline: EditVersion = {
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
const director: EditVersion = {
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
const schema1File = JSON.stringify({
  schema: 1,
  analysisId: ANALYSIS,
  versions: [baseline, director],
  activeVersionId: "v2",
  chosenStoryId: "story-01",
  targetSeconds: 30,
  storyboardSelectIds: [],
  savedAt: "2026-10-06T19:00:00.000Z",
});

/** The "disk": survives unmount/remount, like the app's userData folder. */
interface Disk {
  v1: string | null;
  v2: string | null;
  saves1: number;
  saves2: number;
  /** Makes schema-2 saves fail like the desktop side does (the file on disk
   * is left as it was), or reject outright like a broken IPC channel. */
  fail2?: "too-large" | "write-failed" | "throw" | null;
}

type Ctx = ReturnType<typeof useAE>;
let ctx: Ctx | null = null;
let root: Root | null = null;
function Probe(): ReactNode {
  ctx = useAE();
  return null;
}

function install(disk: Disk) {
  const engineProject = {
    id: "proj-1",
    mediaRoot: MEDIA_ROOT,
    analysisState: "complete",
    analysisProgress: 100,
    analysisId: ANALYSIS,
    clips: projectClips.map((c) => ({
      id: c.id,
      filename: c.filename,
      state: "analyzed",
      fps: c.fps,
      durationSeconds: c.durationSeconds,
      hasTranscript: true,
    })),
    transcript: [],
    visualEvidence: [],
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
      if (path === "/selects") return { status: 200, body: { selects: [] } };
      if (path === "/stories") return { status: 200, body: { stories: [] } };
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
    listProjects: vi.fn(async () => ({ ok: true, projects: [project] })),
    saveProject: vi.fn(async () => ({ ok: true, projects: [project] })),
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
      disk.saves1 += 1;
      return { ok: true };
    }),
    loadEditStateV2: vi.fn(async () => ({ ok: true, state: disk.v2 ? JSON.parse(disk.v2) : null })),
    saveEditStateV2: vi.fn(async (_id: string, state: unknown) => {
      if (disk.fail2 === "throw") throw new Error("IPC channel closed: /Users/x/secret");
      if (disk.fail2) return { ok: false, code: disk.fail2, error: "raw desktop text /Users/x" };
      disk.v2 = JSON.stringify(state);
      disk.saves2 += 1;
      return { ok: true };
    }),
  };
}

async function settle(until: (c: Ctx) => boolean, ms = 8000) {
  for (let t = 0; t < ms; t += 25) {
    if (ctx && until(ctx)) return;
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
  throw new Error(
    `never settled (versions=${ctx?.versions.length}, active=${ctx?.activeVersionId})`,
  );
}

const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

/** Launch the app on `disk` and wait until the project's cuts are restored. */
async function launch(disk: Disk, ready: (c: Ctx) => boolean) {
  install(disk);
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(AEProvider, null, createElement(Probe))));
  await settle((c) => c.project?.analysisId === ANALYSIS && !!c.editor.sequence && ready(c));
}

async function quit() {
  await act(async () => root?.unmount());
  root = null;
  ctx = null;
}

function itemOf(seq: Sequence, decisionId: string) {
  return Object.values(seq.items).find((i) => i.legacy?.decision.id === decisionId)!;
}

function edit(label: string, build: (seq: Sequence) => Parameters<typeof makeTransaction>[3]) {
  const seq = ctx!.editor.sequence!;
  let out: ReturnType<Ctx["editor"]["dispatchTransaction"]> | undefined;
  act(() => {
    out = ctx!.editor.dispatchTransaction(
      makeTransaction(ctx!.editor.ids, label, "manual", build(seq)),
    );
  });
  if (!out?.ok) throw new Error(`edit failed: ${out && !out.ok ? out.error.message : "?"}`);
  return out;
}

afterEach(async () => {
  await quit();
  delete window.assistantEditorBridge;
  delete window.assistantEditorDesktop;
  window.localStorage.clear();
});

describe("store: canonical editor + schema-2 persistence across relaunch", () => {
  it("open → edit → quit → relaunch → exact Sequence/ids → undo → quit → relaunch → redo", async () => {
    const disk: Disk = { v1: schema1File, v2: null, saves1: 0, saves2: 0 };

    // Launch on beta.1's schema-1 state: read, converted in memory, NOT rewritten.
    await launch(disk, (c) => c.activeVersionId === "v2");
    expect(ctx!.editor.edited).toBe(false);
    expect(ctx!.editor.sequence).toStrictEqual(importedSequence(director, projectClips));
    await wait(700);
    expect([disk.saves1, disk.saves2, disk.v1, disk.v2]).toEqual([0, 0, schema1File, null]);

    // First manual edit: forks "v1.1 · edited", creates the schema-2 file.
    const first = edit("Move event 6", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-6").id], 24),
    ]);
    expect(first.ok && first.forkedFrom).toBe("v2");
    const working = ctx!.activeVersionId;
    expect(ctx!.versions.find((v) => v.id === working)).toMatchObject({
      kind: "edited",
      parentId: "v2",
    });
    expect(ctx!.versions.find((v) => v.id === "v2")!.timeline).toStrictEqual(directorCut);
    const afterFirst = ctx!.editor.sequence!;

    // Second edit continues the working version.
    edit("Trim event 1", (seq) => [
      commands.trim(ctx!.editor.ids, itemOf(seq, "event-1").id, "out", -12),
    ]);
    expect(ctx!.versions).toHaveLength(3);
    expect(ctx!.editor.nextUndoLabel).toBe("Trim event 1");
    const afterSecond = ctx!.editor.sequence!;
    await settle(
      () => disk.saves2 > 0 && JSON.parse(disk.v2!).histories[working].past.length === 2,
    );
    expect(disk.v1).toBe(schema1File); // beta.1's file untouched, ever
    expect(disk.saves1).toBe(0);

    // Quit → relaunch: the exact edited Sequence, same ids, same history.
    await quit();
    const savesBeforeRelaunch = disk.saves2;
    await launch(disk, (c) => c.activeVersionId === working);
    expect(ctx!.editor.sequence).toStrictEqual(afterSecond);
    expect(Object.keys(ctx!.editor.sequence!.items).sort()).toEqual(
      Object.keys(afterSecond.items).sort(),
    );
    expect([ctx!.editor.edited, ctx!.editor.canUndo, ctx!.editor.nextUndoLabel]).toEqual([
      true,
      true,
      "Trim event 1",
    ]);
    await wait(700);
    expect(disk.saves2).toBe(savesBeforeRelaunch); // opening does not rewrite the schema-2 file either

    // Undo after relaunch → the exact state before the last edit.
    act(() => ctx!.editor.undo());
    expect(ctx!.editor.sequence).toStrictEqual(afterFirst);
    await settle(() => JSON.parse(disk.v2!).histories[working].future.length === 1);

    // Quit → relaunch → redo → the exact edited Sequence again.
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect([ctx!.editor.canRedo, ctx!.editor.nextRedoLabel]).toEqual([true, "Trim event 1"]);
    act(() => ctx!.editor.redo());
    expect(ctx!.editor.sequence).toStrictEqual(afterSecond);

    // Version switching: the Director cut is untouched; the child keeps its edits.
    act(() => ctx!.setActiveVersion("v2"));
    expect(ctx!.editor.edited).toBe(false);
    expect(ctx!.editor.sequence).toStrictEqual(importedSequence(director, projectClips));
    act(() => ctx!.setActiveVersion(working));
    expect(ctx!.editor.sequence).toStrictEqual(afterSecond);
    expect(disk.v1).toBe(schema1File);
  }, 30000);

  it("editing the Director version again forks a sibling, leaving the first edited child intact", async () => {
    const disk: Disk = { v1: schema1File, v2: null, saves1: 0, saves2: 0 };
    await launch(disk, (c) => c.activeVersionId === "v2");
    edit("Lift event 3", (seq) => [commands.delete(ctx!.editor.ids, [itemOf(seq, "event-3").id])]);
    const firstChild = ctx!.activeVersionId;
    const firstSeq = ctx!.editor.sequence!;
    act(() => ctx!.setActiveVersion("v2"));
    edit("Lift event 7", (seq) => [commands.delete(ctx!.editor.ids, [itemOf(seq, "event-7").id])]);
    const second = ctx!.activeVersionId;
    expect(second).not.toBe(firstChild);
    expect(ctx!.versions.find((v) => v.id === second)!.version).toBe("v1.1 · edited 2");
    act(() => ctx!.setActiveVersion(firstChild));
    expect(ctx!.editor.sequence).toBe(firstSeq);
    expect(ctx!.editor.nextUndoLabel).toBe("Lift event 3");
  }, 30000);

  it("a malformed schema-2 file falls back to schema 1 without losing it", async () => {
    const disk: Disk = {
      v1: schema1File,
      v2: JSON.stringify({ schema: 2, analysisId: ANALYSIS, versions: "broken" }),
      saves1: 0,
      saves2: 0,
    };
    await launch(disk, (c) => c.activeVersionId === "v2");
    expect(ctx!.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(ctx!.editor.sequence).toStrictEqual(importedSequence(director, projectClips));
    await wait(700);
    expect([disk.saves1, disk.saves2]).toEqual([0, 0]);
  }, 30000);

  it("a failed save is never silent: error status, edit kept, last good file kept, retry → saved", async () => {
    const disk: Disk = { v1: schema1File, v2: null, saves1: 0, saves2: 0 };
    await launch(disk, (c) => c.activeVersionId === "v2");
    expect(ctx!.editor.persistence).toEqual({ status: "saved", message: null });

    edit("Move event 6", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-6").id], 24),
    ]);
    const working = ctx!.activeVersionId;
    expect(ctx!.editor.persistence.status).toBe("saving"); // not yet on disk
    await settle((c) => c.editor.persistence.status === "saved" && disk.saves2 === 1);
    const goodFile = disk.v2;

    // Disk/write failure.
    disk.fail2 = "write-failed";
    edit("Trim event 1", (seq) => [
      commands.trim(ctx!.editor.ids, itemOf(seq, "event-1").id, "out", -12),
    ]);
    const unsaved = ctx!.editor.sequence!;
    await settle((c) => c.editor.persistence.status === "error");
    expect(ctx!.editor.persistence.message).toBe(
      "Your latest edits could not be saved. They are still open here — try saving again.",
    );
    expect(ctx!.editor.persistence.message).not.toMatch(/Users|desktop text/); // nothing raw
    expect(disk.v2).toBe(goodFile); // the previous valid file is untouched
    expect(ctx!.editor.sequence).toBe(unsaved); // the edit is still in memory…
    expect(ctx!.editor.nextUndoLabel).toBe("Trim event 1"); // …with its history

    // Retrying while the disk still fails stays an error (never "saved").
    act(() => ctx!.editor.retrySave());
    await wait(500);
    expect(ctx!.editor.persistence.status).toBe("error");
    expect(disk.v2).toBe(goodFile);

    // The disk recovers: retry writes the edit and the status returns to saved.
    disk.fail2 = null;
    act(() => ctx!.editor.retrySave());
    await settle((c) => c.editor.persistence.status === "saved");
    expect(ctx!.editor.persistence.message).toBeNull();
    expect(JSON.parse(disk.v2!).histories[working].past).toHaveLength(2);

    // Oversize rejection: same contract, its own message.
    disk.fail2 = "too-large";
    edit("Move event 7", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-7").id], -2),
    ]);
    await settle((c) => c.editor.persistence.status === "error");
    expect(ctx!.editor.persistence.message).toMatch(/too large to save/);
    expect(JSON.parse(disk.v2!).histories[working].past).toHaveLength(2);

    // A rejected IPC call is an error too, not a silent no-op.
    disk.fail2 = "throw";
    edit("Move event 4", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-4").id], -2),
    ]);
    await wait(500);
    expect(ctx!.editor.persistence.status).toBe("error");
    expect(ctx!.editor.persistence.message).not.toMatch(/IPC|secret/);
    const latest = ctx!.editor.sequence!;

    // Relaunching now restores the last file that was saved — intact.
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(ctx!.editor.persistence.status).toBe("saved");
    expect(ctx!.editor.nextUndoLabel).toBe("Trim event 1");

    // …whereas a subsequent successful save (the next edit, no retry needed)
    // clears an error and writes everything on screen.
    disk.fail2 = "write-failed";
    edit("Move event 7", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-7").id], -2),
    ]);
    await settle((c) => c.editor.persistence.status === "error");
    disk.fail2 = null;
    edit("Move event 4", (seq) => [
      commands.move(ctx!.editor.ids, [itemOf(seq, "event-4").id], -2),
    ]);
    await settle((c) => c.editor.persistence.status === "saved");
    // The same two moves, re-made after relaunch (new transaction ids): the
    // same frames as the state that failed to save before.
    const frames = (q: Sequence) =>
      Object.values(q.items).map((i) => [i.id, i.startFrame, i.sourceInFrame, i.sourceOutFrame]);
    expect(frames(ctx!.editor.sequence!)).toEqual(frames(latest));
    expect(JSON.parse(disk.v2!).histories[working].past).toHaveLength(4);
    expect(disk.v1).toBe(schema1File);
  }, 30000);

  it("an old desktop bridge without schema-2 saving reports an error instead of dropping the edit", async () => {
    const disk: Disk = { v1: schema1File, v2: null, saves1: 0, saves2: 0 };
    await launch(disk, (c) => c.activeVersionId === "v2");
    delete (window.assistantEditorDesktop as { saveEditStateV2?: unknown }).saveEditStateV2;
    edit("Lift event 3", (seq) => [commands.delete(ctx!.editor.ids, [itemOf(seq, "event-3").id])]);
    await settle((c) => c.editor.persistence.status === "error");
    expect(ctx!.editor.persistence.message).toMatch(/cannot save edited timelines/);
    expect(ctx!.editor.edited).toBe(true);
    await wait(500);
    expect([disk.v1, disk.saves1]).toEqual([schema1File, 0]); // never falls back to schema 1
  }, 30000);
});
