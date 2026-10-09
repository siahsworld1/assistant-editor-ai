// Phase 7, Milestone 7 — saved edits that can't be fully restored are
// explained, not hidden (store.restoreWarnings → RestoreWarnings in CUT).
// Found in real-app validation: a damaged undo log, a cut that uses media
// past its end, a truncated file or one from another analysis all opened
// silently. The edit itself is never repaired or rewritten on open.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Clip, VisualEvidence } from "@/lib/ae/types";
import {
  ctx,
  fakeAnalysis,
  freshDisk,
  launch,
  q,
  quit,
  seq,
  settle,
  teardown,
  wait,
  type Disk,
} from "./helpers/cut-harness";
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const CLIPS: Clip[] = projectClips.map((c, i) => ({
  ...c,
  dialogue: { status: i < 3 ? "dialogue" : "non-dialogue", reasons: ["fixture"] },
}));
const EVIDENCE: VisualEvidence[] = [
  {
    id: "park-1",
    clipId: "clip-005",
    kind: "b-roll",
    label: "Park sign",
    atTc: "00:00:03:00",
    confidence: 0.8,
  },
  {
    id: "street-1",
    clipId: "clip-006",
    kind: "b-roll",
    label: "Street",
    atTc: "00:00:04:00",
    confidence: 0.8,
  },
];
const prepare = () => {
  fakeAnalysis.clips = CLIPS;
  fakeAnalysis.visualEvidence = EVIDENCE;
};
const warnings = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="restore-warning"]')].map(
    (w) => w.textContent ?? "",
  );

/** The parts of a saved schema-2 file these tests tamper with. */
interface SavedItem {
  mediaClipId?: string;
  startFrame?: number;
  sourceOutFrame?: number;
}
interface Saved {
  analysisId: string;
  histories: Record<
    string,
    {
      past: Array<{ commands: Array<{ params: Record<string, unknown> }> }>;
      present: { items: Record<string, SavedItem | string> };
    }
  >;
}

/** A real saved file: Cover accepted (two PlaceEdits) on the Director cut. */
async function acceptedDisk(): Promise<{ disk: Disk; state: Saved }> {
  prepare();
  const disk = freshDisk();
  await launch(disk);
  act(() => q("mode-cover")!.click());
  act(() => q("proposal-accept")!.click());
  await settle(() => disk.saves2 > 0 && q("persistence-status")?.dataset.status === "saved");
  await quit();
  return { disk, state: JSON.parse(disk.v2!) };
}
async function reopen(disk: Disk, v2: string) {
  disk.v2 = v2;
  const saves = disk.saves2;
  await launch(disk, (c) => c.versions.length > 0);
  await wait(300);
  expect(disk.saves2).toBe(saves); // opening never rewrites the file
  expect(disk.v2).toBe(v2);
}
const edited = (s: Saved) => Object.keys(s.histories)[0]!;

describe("restoring saved edits", () => {
  it("a healthy file: no warning, the accepted edit and its undo history are back", async () => {
    const { disk, state } = await acceptedDisk();
    await reopen(disk, JSON.stringify(state));
    expect(q("restore-warnings")).toBeNull();
    expect(ctx!.restoreWarnings).toEqual([]);
    expect(ctx!.editor.canUndo).toBe(true);
  }, 30000);

  it("an undo log naming media that isn't in the project: the edit opens, the lost undo history is explained", async () => {
    const { disk, state } = await acceptedDisk();
    const id = edited(state);
    state.histories[id]!.past[0]!.commands[0]!.params["mediaClipId"] = "clip-999";
    await reopen(disk, JSON.stringify(state));
    expect(ctx!.activeVersionId).toBe(id);
    expect(Object.values(seq().items).filter((i) => i.mediaClipId === "clip-005")).toHaveLength(1);
    expect(ctx!.editor.canUndo).toBe(false);
    expect(warnings()).toEqual([
      expect.stringMatching(/Undo history for .* could not be fully restored/),
    ]);
  }, 30000);

  it("a cut that uses media past its end: opened unchanged, with the integrity warning", async () => {
    const { disk, state } = await acceptedDisk();
    const id = edited(state);
    const items = state.histories[id]!.present.items;
    const placed = Object.values(items).find(
      (i): i is SavedItem =>
        typeof i === "object" && i.mediaClipId === "clip-005" && i.startFrame === 216,
    );
    placed.sourceOutFrame = 100000;
    await reopen(disk, JSON.stringify(state));
    expect(ctx!.activeVersionId).toBe(id);
    expect(warnings().join(" ")).toMatch(
      /refers to media that is missing or shorter than the cut uses \(1 clip\)/,
    );
  }, 30000);

  it("a damaged (truncated) file: the last readable versions are shown, and the kept copy is named", async () => {
    const { disk, state } = await acceptedDisk();
    const text = JSON.stringify(state);
    await reopen(disk, text.slice(0, text.length / 2));
    expect(ctx!.versions.some((v) => v.kind === "edited")).toBe(false);
    expect(warnings()).toEqual([
      expect.stringMatching(
        /couldn't be read \(the file is damaged\).*kept as "proj-1\.v2\.unreadable-x\.json"/,
      ),
    ]);
  }, 30000);

  it("a file from another analysis of the media: not opened, and that is said", async () => {
    const { disk, state } = await acceptedDisk();
    await reopen(disk, JSON.stringify({ ...state, analysisId: "another-analysis" }));
    expect(ctx!.versions.some((v) => v.kind === "edited")).toBe(false);
    expect(warnings()).toEqual([expect.stringMatching(/belong to a different analysis/)]);
  }, 30000);

  it("the notice can be dismissed", async () => {
    const { disk, state } = await acceptedDisk();
    await reopen(disk, JSON.stringify({ ...state, analysisId: "another-analysis" }));
    act(() => q("restore-warnings-dismiss")!.click());
    expect(q("restore-warnings")).toBeNull();
  }, 30000);
});
