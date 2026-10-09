// Phase 7, Milestone 2 — placement proposals: the review rules Milestone 2
// adds or depends on, beyond tests/timeline/proposals-place.test.ts.
//  - Protected interview footage can't be covered by a proposal (the engine
//    rule from Milestone 1, reached through review); hand-edited footage can,
//    and keeps its ownership.
//  - A proposal can't choose the new clip's id, ownership or protection; the
//    id is derived (placementItemId) and identical in preview and acceptance.
//  - Media without a known frame rate is refused, never guessed.
//  - Accepted placements export to Premiere XML and EDL.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 · e2 240–408 · … · V2: e4 420–532 · e7 708–784
import { describe, expect, it } from "vitest";
import type { EditVersion } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml } from "@/lib/nle/xmeml";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import {
  acceptProposal,
  placementItemId,
  reviewProposal,
  type ProposalContext,
} from "@/lib/timeline/proposals";
import { frameToTc, rateFromFps } from "@/lib/timeline/time";
import type { Sequence } from "@/lib/timeline/types";
import {
  derivedTimeline,
  redoIn,
  sequenceOf,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, item, mediaOf, partner, protect, track } from "./engine-helpers";
import { directorCut, projectClips } from "./legacy-fixtures";
import { proposal } from "./proposal-fixtures";

const director: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.1",
  command: "c",
  summary: "s",
  createdAt: "—",
  changes: [],
  timeline: directorCut,
};
const media = mediaOf(projectClips);
const ctxOf = (ws: Workspace, active = "v2", clips = projectClips): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips,
  media,
});
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const seqOf = (ws: Workspace, v = "v2") => sequenceOf(ws, v, projectClips)!;
/** A working version holding `s` (test setup only). */
function working(s: Sequence): Workspace {
  return deepFreeze({
    versions: [
      structuredClone(director),
      { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
    ],
    histories: { ver_w: createHistory(s) },
  } as Workspace);
}
/** Park sign over the e1/e2 cut at 240 (216–276). */
const place = (s: Sequence, extra: Record<string, unknown> = {}) => ({
  op: "place",
  mediaClipId: "clip-005",
  trackId: track(s, "V2").id,
  sourceInFrame: 24,
  sourceOutFrame: 84,
  startFrame: 216,
  label: "Park sign",
  ...extra,
});
const codes = (r: ReturnType<typeof reviewProposal>) => (r.ok ? [] : r.issues.map((i) => i.code));
const engine = (r: ReturnType<typeof reviewProposal>) =>
  r.ok ? [] : r.issues.map((i) => i.engineCode ?? null);

describe("protection through review", () => {
  it("a placement over locked or AI-protected interview footage is refused — the clip is named", () => {
    const base = seqOf(fresh());
    const e2 = item(base, "event-2");
    for (const p of [{ aiLocked: true }, { locked: true }]) {
      const ws = working(protect(base, { itemId: e2.id }, p));
      const s = seqOf(ws, "ver_w");
      const r = reviewProposal(proposal("ver_w", s, [place(s)]), ctxOf(ws, "ver_w"));
      expect(codes(r)).toEqual(["protected"]);
      if (!r.ok) expect(r.issues[0]!.itemIds).toEqual([e2.id]);
    }
  });

  it("a locked or AI-protected V2 track refuses the placement", () => {
    const base = seqOf(fresh());
    for (const p of [{ aiLocked: true }, { locked: true }]) {
      const ws = working(protect(base, { trackName: "V2" }, p));
      const s = seqOf(ws, "ver_w");
      expect(codes(reviewProposal(proposal("ver_w", s, [place(s)]), ctxOf(ws, "ver_w")))).toEqual([
        "protected",
      ]);
    }
  });

  it("a hand-edited interview may be covered; accepting leaves it, its audio and its ownership unchanged", () => {
    const base = seqOf(fresh());
    const e2 = item(base, "event-2");
    const s0 = structuredClone(base) as Sequence;
    s0.items[e2.id]!.editedBy = "manual";
    const ws = working(deepFreeze(s0));
    const s = seqOf(ws, "ver_w");
    const raw = proposal("ver_w", s, [place(s)]);
    expect(reviewProposal(raw, ctxOf(ws, "ver_w")).ok).toBe(true);
    const out = acceptProposal(raw, { ...ctxOf(ws, "ver_w"), ids: seededIds("acc") });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const after = seqOf(out.workspace, out.activeVersionId);
    const a1 = partner(s, s.items[e2.id]!);
    expect(after.items[e2.id]).toStrictEqual(s.items[e2.id]);
    expect(after.items[a1.id]).toStrictEqual(s.items[a1.id]);
    expect(after.items[e2.id]!.editedBy).toBe("manual");
  });
});

describe("the proposal can't choose identity, ownership or protection", () => {
  it.each([
    ["an item id", { itemId: "itm_mine" }, "malformed"],
    ["ownership", { editedBy: "manual" }, "malformed"],
    ["protection", { protection: { locked: false, aiLocked: false } }, "malformed"],
    ["a media rate", { mediaRate: { num: 30, den: 1 } }, "malformed"],
    ["self-authorization", { allowProtected: true }, "self-authorization"],
  ])("a place op carrying %s is refused", (_n, extra, code) => {
    const ws = fresh();
    const s = seqOf(ws);
    expect(codes(reviewProposal(proposal("v2", s, [place(s, extra)]), ctxOf(ws)))).toContain(code);
  });

  it("the new clip's id is derived from the proposal: the preview and the accepted clip share it, and it's Director-owned", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const raw = proposal("v2", s, [place(s)], { id: "prp_place_fixture" });
    const id = placementItemId("prp_place_fixture", 0);
    const r = reviewProposal(raw, ctxOf(ws));
    if (!r.ok) throw new Error("review failed");
    expect(r.preview.items[id]).toBeDefined();
    const out = acceptProposal(raw, { ...ctxOf(ws), ids: seededIds("acc") });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const after = seqOf(out.workspace, out.activeVersionId);
    expect(after.items[id]).toMatchObject({ editedBy: "director", origin: "director" });
    expect(after.items[id]!.linkGroupId).toBeUndefined();
  });

  it("media whose frame rate isn't known is refused, never placed at a guessed rate", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const noRate = projectClips.map((c) => (c.id === "clip-005" ? { ...c, fps: 0 } : c));
    const r = reviewProposal(proposal("v2", s, [place(s)]), ctxOf(ws, "v2", noRate));
    expect(codes(r)).toEqual(["invalid-range"]);
    if (!r.ok) expect(r.issues[0]!.message).toMatch(/frame rate isn't known/);
  });

  it("a placement past the media's end or over existing B-roll is refused by the engine dry run", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const past = reviewProposal(proposal("v2", s, [place(s, { sourceOutFrame: 226 })]), ctxOf(ws));
    expect(engine(past)).toEqual(["out-of-bounds"]);
    const over = reviewProposal(proposal("v2", s, [place(s, { startFrame: 450 })]), ctxOf(ws));
    expect(engine(over)).toEqual(["overlap"]);
  });
});

describe("accepted placements: undo, redo, export", () => {
  it("one Director transaction; undo removes it, redo restores it; Premiere XML and EDL carry it", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const raw = proposal("v2", s, [place(s)], { id: "prp_export" });
    const out = acceptProposal(raw, { ...ctxOf(ws), ids: seededIds("acc") });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const w = out.activeVersionId;
    const id = placementItemId("prp_export", 0);
    expect(out.workspace.histories[w]!.past).toHaveLength(1);
    expect(out.workspace.histories[w]!.past[0]!.transaction.commands.map((c) => c.type)).toEqual([
      "PlaceEdit",
    ]);
    expect(seqOf(undoIn(out.workspace, w), w).items[id]).toBeUndefined();
    expect(seqOf(undoIn(out.workspace, w), w)).toStrictEqual(s);
    const after = seqOf(redoIn(undoIn(out.workspace, w), w), w);
    expect(after.items[id]).toBeDefined();

    const tl = derivedTimeline(after);
    const { usable } = validateTimelineForExport(tl, projectClips);
    const placed = tl.decisions.find((d) => d.label === "Park sign")!;
    expect(usable.some((d) => d.id === placed.id)).toBe(true);
    const xml = buildXmeml(tl, usable, projectClips, "/Media").xml;
    expect(xml).toContain("CLIP-005.MP4");
    const before = derivedTimeline(s);
    const xmlBefore = buildXmeml(
      before,
      validateTimelineForExport(before, projectClips).usable,
      projectClips,
      "/Media",
    ).xml;
    const count = (x: string) => x.split("<clipitem").length - 1;
    expect(count(xml)).toBe(count(xmlBefore) + 1); // XML names clip items by file, not label
    const edl = buildCmx3600Edl(tl, usable, projectClips);
    const rate = rateFromFps(23.976);
    expect(edl).toContain(`${frameToTc(24, rate)} ${frameToTc(84, rate)}`);
  });
});
