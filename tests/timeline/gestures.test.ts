// Gesture → command mapping (src/lib/timeline/gestures.ts): integer-frame
// snapping, engine-validated move/trim proposals, blade and ⌘K targets — and
// the playhead rule the CUT preview follows after an edit.
import { describe, expect, it } from "vitest";
import { keptPlayhead, sequenceEndSeconds } from "@/lib/ae/timeline-playback";
import {
  bladeFrame,
  linkRepresentatives,
  proposeMove,
  proposeTrim,
  SNAP_PX,
  snapFrame,
  snapPoints,
  snapThresholdFrames,
  splitAtPlayheadTargets,
} from "@/lib/timeline/gestures";
import { endFrame } from "@/lib/timeline/selectors";
import { directorCut } from "./legacy-fixtures";
import { directorSequence, item, media, partner } from "./engine-helpers";

const OFF = { enabled: false, playheadFrame: null, threshold: 0 };
const ON = (threshold: number, playheadFrame: number | null = null) => ({
  enabled: true,
  playheadFrame,
  threshold,
});

describe("snapping", () => {
  it("has a fixed on-screen reach, converted to whole frames at each zoom", () => {
    expect(SNAP_PX).toBe(8);
    expect(snapThresholdFrames(1)).toBe(8);
    expect(snapThresholdFrames(4)).toBe(2);
    expect(snapThresholdFrames(100)).toBe(1); // never less than one frame
    expect(snapThresholdFrames(0.5)).toBe(16);
  });

  it("snaps to the nearest point within reach (earlier point on a tie), else not at all", () => {
    expect(snapFrame(103, [100, 110], 5)).toEqual({ frame: 100, snappedTo: 100 });
    expect(snapFrame(105, [100, 110], 5)).toEqual({ frame: 100, snappedTo: 100 });
    expect(snapFrame(107, [100, 110], 5)).toEqual({ frame: 110, snappedTo: 110 });
    expect(snapFrame(150, [100, 110], 5)).toEqual({ frame: 150, snappedTo: null });
  });

  it("points are the playhead and other items' edges — never the dragged items'", () => {
    const seq = directorSequence();
    const e7 = item(seq, "event-7");
    const pts = snapPoints(seq, 333, new Set([e7.id]));
    expect(pts).toContain(333);
    expect(pts).toContain(696); // event 6 start
    expect(pts).not.toContain(708); // event 7 itself
    expect(pts.every(Number.isInteger)).toBe(true);
  });
});

describe("move proposals", () => {
  it("dry-run the real engine: the preview is the committed result", () => {
    const seq = directorSequence();
    const e7 = item(seq, "event-7");
    const p = proposeMove(seq, [e7.id], -10, OFF, media);
    expect(p.ok && p.sequence.items[e7.id]!.startFrame).toBe(698);
    expect(seq.items[e7.id]!.startFrame).toBe(708); // input untouched (frozen)
  });

  it("snap the group's start or end, whichever is nearer a point", () => {
    const seq = directorSequence();
    const e7 = item(seq, "event-7"); // 708–784
    expect(proposeMove(seq, [e7.id], -10, ON(4), media).deltaFrames).toBe(-12); // start → 696
    expect(proposeMove(seq, [e7.id], 6, ON(4), media).deltaFrames).toBe(8); // end → 792
    expect(proposeMove(seq, [e7.id], -10, ON(4, 699), media).deltaFrames).toBe(-9); // playhead
  });

  it("never start before frame 0, and report overlaps without a sequence", () => {
    const seq = directorSequence();
    const e4 = item(seq, "event-4");
    expect(proposeMove(seq, [e4.id], -10_000, OFF, media).deltaFrames).toBe(-420);
    const e1 = item(seq, "event-1");
    const bad = proposeMove(seq, [e1.id], 24, OFF, media);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("overlap");
  });
});

describe("trim proposals", () => {
  it("find the source delta that puts the edge exactly on the target where one exists", () => {
    const seq = directorSequence();
    const e6 = item(seq, "event-6");
    const p = proposeTrim(seq, e6.id, "out", 768, OFF, media);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(endFrame(p.sequence.items[e6.id]!)).toBe(768);
      expect(endFrame(p.sequence.items[partner(seq, e6).id]!)).toBe(768); // linked A1
    }
    expect(p.edgeFrame).toBe(768);
  });

  it("refuse a trim into the neighbour and one that empties the source range", () => {
    const seq = directorSequence();
    const e5 = item(seq, "event-5");
    expect(proposeTrim(seq, e5.id, "out", 730, OFF, media).ok).toBe(false);
    expect(proposeTrim(seq, e5.id, "out", 500, OFF, media).ok).toBe(false);
  });
});

describe("blade and ⌘K targets", () => {
  it("cut only strictly inside the clip; snapping can pull the cut to the playhead", () => {
    const seq = directorSequence();
    const e1 = item(seq, "event-1");
    expect(bladeFrame(seq, e1.id, 100, OFF)).toBe(100);
    expect(bladeFrame(seq, e1.id, 0, OFF)).toBeNull();
    expect(bladeFrame(seq, e1.id, 240, OFF)).toBeNull();
    expect(bladeFrame(seq, e1.id, 103, ON(5, 100))).toBe(100);
  });

  it("⌘K: one cut per link group, selected items first, otherwise everything under the playhead", () => {
    const seq = directorSequence();
    const e3 = item(seq, "event-3");
    const a3 = partner(seq, e3);
    expect(linkRepresentatives(seq, [e3.id, a3.id])).toEqual([e3.id]);
    expect(splitAtPlayheadTargets(seq, new Set([e3.id, a3.id]), 480)).toEqual([e3.id]);
    const all = splitAtPlayheadTargets(seq, new Set(), 480);
    expect(all).toHaveLength(2); // V1 e3 (with its A1) + V2 e4
    expect(all).toContain(item(seq, "event-4").id);
    expect(splitAtPlayheadTargets(seq, new Set(), 408)).toHaveLength(0); // on an edit point
  });
});

describe("playhead after an edit", () => {
  it("stays where it was, clamped to the new end of the cut", () => {
    expect(keptPlayhead(12.5, 33)).toBe(12.5);
    expect(keptPlayhead(40, 23)).toBe(23);
    expect(keptPlayhead(-1, 10)).toBe(0);
    expect(sequenceEndSeconds(directorCut)).toBeCloseTo(33, 6);
    expect(sequenceEndSeconds({ ...directorCut, decisions: [], totalSeconds: 7 })).toBe(7);
  });
});
