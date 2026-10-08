// Phase 6, Milestone 1 — ReorderEdit (src/lib/timeline/commands/reorder.ts):
// a back-to-back run of items on one track put into a new order, repacked from
// the run's first frame. Linked audio and material wholly inside one moved
// item go with it; anything that can't is refused, never moved or deleted.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 (inside e3) · e7 708–784 (inside e6)
//   A1: aligned with every V1 item.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { endFrame, itemsOnTrack, sequenceEndFrame } from "@/lib/timeline/selectors";
import { applyTransaction, makeTransaction, replay } from "@/lib/timeline/transactions";
import type { ClipItem, Command, Sequence, TransactionOrigin } from "@/lib/timeline/types";
import {
  derivedTimeline,
  dispatchTransaction,
  parseSavedEditStateV2,
  redoIn,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  workspaceFromVersions,
} from "@/lib/timeline/workspace";
import {
  commands,
  deepFreeze,
  directorSequence,
  item,
  media,
  mediaOf,
  partner,
  protect,
  run,
} from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";

type Outcome = ReturnType<typeof run>["outcome"];
function ok(outcome: Outcome): Sequence {
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.sequence;
}
function refused(outcome: Outcome) {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.error;
}
/** Items whose object identity changed between two sequences. */
function touched(a: Sequence, b: Sequence): string[] {
  const ids = new Set([...Object.keys(a.items), ...Object.keys(b.items)]);
  return [...ids].filter((id) => a.items[id] !== b.items[id]).sort();
}
const reorder = (seq: Sequence, order: string[], origin: TransactionOrigin = "manual") =>
  run(seq, origin, (ids) => [commands.reorder(ids, order)]).outcome;
const ev = (seq: Sequence, ...names: string[]) => names.map((n) => item(seq, n).id);
const span = (s: Sequence, it: ClipItem) => [s.items[it.id]!.startFrame, endFrame(s.items[it.id]!)];
/** Everything except start frames (and the bookkeeping of a change). */
const shape = ({ startFrame: _s, originTransactionId: _t, editedBy: _e, ...rest }: ClipItem) =>
  rest;

/** A test-only copy of `seq` with items changed or added directly. */
function edit(seq: Sequence, fn: (s: Sequence) => void): Sequence {
  const next = structuredClone(seq) as Sequence;
  fn(next);
  return deepFreeze(next);
}
/** An A2 track (added if the cut has none) and an unlinked bed on it. */
function withBed(seq: Sequence, startFrame: number): { seq: Sequence; bedId: string } {
  const bedId = "itm_test_bed";
  const a1 = partner(seq, item(seq, "event-1")); // 240 frames of clip-002 audio
  return {
    bedId,
    seq: edit(seq, (s) => {
      let a2 = s.tracks.find((t) => t.name === "A2");
      if (!a2) {
        const base = s.tracks.find((t) => t.name === "A1")!;
        a2 = { ...structuredClone(base), id: "trk_test_a2", name: "A2", order: base.order + 1 };
        s.tracks.push(a2);
      }
      const bed: ClipItem = { ...structuredClone(a1), id: bedId, trackId: a2.id, startFrame };
      delete bed.linkGroupId;
      delete bed.legacy;
      s.items[bedId] = bed;
    }),
  };
}

describe("ReorderEdit — reordering", () => {
  it("swaps two clips: ids, sources and durations kept; linked A1 follows; nothing else moves", () => {
    const seq = directorSequence();
    const [e1, e2] = [item(seq, "event-1"), item(seq, "event-2")];
    const next = ok(reorder(seq, [e2.id, e1.id]));
    expect([span(next, e2), span(next, e1)]).toEqual([
      [0, 168],
      [168, 408],
    ]);
    for (const it of [e1, e2, partner(seq, e1), partner(seq, e2)])
      expect(shape(next.items[it.id]!)).toEqual(shape(it));
    for (const it of [e1, e2]) expect(span(next, partner(seq, it))).toEqual(span(next, it)); // in sync
    expect(touched(seq, next)).toEqual(
      [e1.id, e2.id, partner(seq, e1).id, partner(seq, e2).id].sort(),
    );
    expect(sequenceEndFrame(next)).toBe(sequenceEndFrame(seq));
    expect(findViolations(next, { media })).toEqual([]);
    expect(next.items[e1.id]!.editedBy).toBe("manual");
  });

  it("a cutaway wholly inside a moved clip goes with it, over the same words", () => {
    const seq = directorSequence();
    const [e5, e6, e7] = [item(seq, "event-5"), item(seq, "event-6"), item(seq, "event-7")];
    const next = ok(reorder(seq, [e6.id, e5.id]));
    expect([span(next, e6), span(next, e5)]).toEqual([
      [552, 648],
      [648, 792],
    ]);
    // e7 sat 12 frames into e6; it still does.
    expect(span(next, e7)).toEqual([564, 640]);
    expect(shape(next.items[e7.id]!)).toEqual(shape(e7));
    expect(findViolations(next, { media })).toEqual([]);
  });

  it("three- and five-clip permutations repack exactly; the run's length is unchanged", () => {
    const seq = directorSequence();
    const [e2, e3, e5] = ev(seq, "event-2", "event-3", "event-5");
    const three = ok(reorder(seq, [e5!, e2!, e3!]));
    expect([e5, e2, e3].map((id) => span(three, three.items[id!]!))).toEqual([
      [240, 384],
      [384, 552],
      [552, 696],
    ]);
    expect(span(three, item(seq, "event-4"))).toEqual([564, 676]); // with e3
    expect(span(three, item(seq, "event-1"))).toEqual([0, 240]); // before the run
    expect(span(three, item(seq, "event-6"))).toEqual([696, 792]); // after it
    expect(findViolations(three, { media })).toEqual([]);

    const reversed = ev(seq, "event-6", "event-5", "event-3", "event-2", "event-1");
    const all = ok(reorder(seq, reversed, "director"));
    expect(reversed.map((id) => span(all, all.items[id]!))).toEqual([
      [0, 96],
      [96, 240],
      [240, 384],
      [384, 552],
      [552, 792],
    ]);
    expect(span(all, item(seq, "event-7"))).toEqual([12, 88]);
    expect(span(all, item(seq, "event-4"))).toEqual([252, 364]);
    expect(sequenceEndFrame(all)).toBe(792);
    expect(findViolations(all, { media })).toEqual([]);
    expect(all.items[reversed[0]!]!.editedBy).toBe("director");
  });

  it("the current order is a no-op", () => {
    const seq = directorSequence();
    const out = reorder(seq, ev(seq, "event-1", "event-2"));
    expect(ok(out)).toBe(seq);
  });

  it("is deterministic: replaying the same transaction gives the same sequence", () => {
    const seq = directorSequence();
    const g = seededIds("replay");
    const t = makeTransaction(
      g,
      "Reorder",
      "manual",
      [commands.reorder(g, ev(seq, "event-5", "event-2", "event-3"))] as unknown as Command[],
      "2026-01-01T00:00:00.000Z",
    );
    const a = replay(seq, [t], { media });
    const b = replay(seq, [t], { media });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.sequence).toStrictEqual(b.sequence);
  });
});

describe("ReorderEdit — other tracks: carry, keep, or refuse", () => {
  it("refuses when a cutaway crosses a cut inside the run — never moves or deletes it", () => {
    const base = directorSequence();
    const e4 = item(base, "event-4");
    // Over the e2/e3 cut (408), as the Director places jump-cut coverage.
    const seq = edit(base, (s) => {
      s.items[e4.id]!.startFrame = 396;
    });
    const err = refused(reorder(seq, ev(seq, "event-3", "event-2")));
    expect(err.code).toBe("reorder-blocked");
    expect(err.itemIds).toEqual([e4.id]);
    expect(err.message).toMatch(/crosses a cut .* remove or move it first\. Nothing was changed\./);
    // A reorder elsewhere is unaffected by it.
    expect(span(ok(reorder(seq, ev(seq, "event-6", "event-5"))), e4)).toEqual([396, 508]);
  });

  it("refuses a cutaway that starts inside the run and ends outside it", () => {
    const base = directorSequence();
    const e7 = item(base, "event-7");
    const seq = edit(base, (s) => {
      s.items[e7.id]!.startFrame = 640; // inside e5, ends inside e6 (outside the run)
    });
    const err = refused(reorder(seq, ev(seq, "event-5", "event-3")));
    expect([err.code, err.itemIds]).toEqual(["reorder-blocked", [e7.id]]);
  });

  it("a music bed spanning the whole run stays; one that starts inside it refuses", () => {
    const run56 = (s: Sequence) => ev(s, "event-6", "event-5");
    const spanning = withBed(directorSequence(), 552); // 552–792: exactly the run
    const next = ok(reorder(spanning.seq, run56(spanning.seq)));
    expect(next.items[spanning.bedId]).toBe(spanning.seq.items[spanning.bedId]); // untouched
    expect(findViolations(next, { media })).toEqual([]);

    const partial = withBed(directorSequence(), 600); // starts inside e5
    const err = refused(reorder(partial.seq, run56(partial.seq)));
    expect([err.code, err.itemIds]).toEqual(["reorder-blocked", [partial.bedId]]);
  });
});

describe("ReorderEdit — protection (no override)", () => {
  const swap56 = (s: Sequence) => ev(s, "event-6", "event-5");

  it("an AI-protected clip: the Director is refused; the filmmaker may reorder it", () => {
    const base = directorSequence();
    const seq = protect(base, { itemId: item(base, "event-5").id }, { aiLocked: true });
    expect(refused(reorder(seq, swap56(seq), "director")).code).toBe("protected");
    ok(reorder(seq, swap56(seq), "manual"));
  });

  it("a locked clip or a locked track stops everyone", () => {
    const base = directorSequence();
    const lockedItem = protect(base, { itemId: item(base, "event-6").id }, { locked: true });
    const lockedTrack = protect(base, { trackName: "V1" }, { locked: true });
    for (const seq of [lockedItem, lockedTrack])
      for (const origin of ["manual", "director", "system"] as const)
        expect(refused(reorder(seq, swap56(seq), origin)).code).toBe("protected");
  });

  it("an AI-locked track stops the Director only", () => {
    const base = directorSequence();
    const seq = protect(base, { trackName: "V1" }, { aiLocked: true });
    expect(refused(reorder(seq, swap56(seq), "director")).code).toBe("protected");
    ok(reorder(seq, swap56(seq), "manual"));
  });

  it("a hand-edited clip, or one whose ownership can't be verified, is never moved by the Director", () => {
    const base = directorSequence();
    const e5 = item(base, "event-5").id;
    const manual = edit(base, (s) => {
      s.items[e5]!.editedBy = "manual";
    });
    const unknown = edit(base, (s) => {
      s.items[e5]!.editedBy = "unknown";
    });
    const unstamped = edit(base, (s) => {
      s.items[e5]!.originTransactionId = "txn_before_ownership"; // edited, owner not recorded
    });
    for (const seq of [manual, unknown, unstamped]) {
      const err = refused(reorder(seq, swap56(seq), "director"));
      expect(err.code).toBe("protected");
      expect(err.message).toMatch(/edited by hand \(or can't be verified\)/);
    }
    ok(reorder(manual, swap56(manual), "manual"));
  });

  it("protection reaches linked audio and carried cutaways (indirect moves)", () => {
    const base = directorSequence();
    const a1 = partner(base, item(base, "event-6")).id;
    const e7 = item(base, "event-7").id; // carried with e6
    for (const id of [a1, e7]) {
      const seq = protect(base, { itemId: id }, { aiLocked: true });
      const err = refused(reorder(seq, swap56(seq), "director"));
      expect(err.code).toBe("protected");
      expect(err.itemIds).toContain(id);
    }
    const handEdited = edit(base, (s) => {
      s.items[e7]!.editedBy = "manual";
    });
    expect(refused(reorder(handEdited, swap56(handEdited), "director")).code).toBe("protected");
  });

  it("a protected clip named in the reorder refuses it even if it would keep its place", () => {
    const base = directorSequence();
    // e1 stays first; e2 and e3 swap — e1 is still part of what was asked.
    const seq = protect(base, { itemId: item(base, "event-1").id }, { aiLocked: true });
    const err = refused(reorder(seq, ev(seq, "event-1", "event-3", "event-2"), "director"));
    expect(err.code).toBe("protected");
  });
});

describe("ReorderEdit — invalid requests", () => {
  it.each<[string, (s: Sequence) => unknown[], string]>([
    ["fewer than two items", (s) => ev(s, "event-1"), "invalid-params"],
    ["a duplicate id", (s) => ev(s, "event-1", "event-2", "event-1"), "invalid-params"],
    ["a missing id", (s) => [...ev(s, "event-1"), "itm_missing"], "unknown-item"],
    ["a non-string id", (s) => [...ev(s, "event-1"), 7], "invalid-params"],
    ["items on two tracks", (s) => ev(s, "event-3", "event-4"), "invalid-params"],
    ["a run with a clip skipped", (s) => ev(s, "event-3", "event-1"), "invalid-params"],
  ])("%s", (_name, order, code) => {
    const seq = directorSequence();
    const err = refused(reorder(seq, order(seq) as string[]));
    expect(err.code).toBe(code);
  });

  it("a run with a gap in it", () => {
    const base = directorSequence();
    const e6 = item(base, "event-6");
    const seq = edit(base, (s) => {
      for (const id of [e6.id, partner(base, e6).id, item(base, "event-7").id])
        s.items[id]!.startFrame += 10;
    });
    const err = refused(reorder(seq, ev(seq, "event-6", "event-5")));
    expect(err.code).toBe("invalid-params");
    expect(err.message).toMatch(/not back to back/);
  });

  it("not an item list at all", () => {
    const seq = directorSequence();
    const g = seededIds("bad");
    for (const params of [{}, { itemIds: "x" }, { itemIds: null }]) {
      const t = makeTransaction(g, "Bad", "manual", [
        { id: g.next("command"), type: "ReorderEdit", params } as unknown as Command,
      ]);
      const out = applyTransaction(seq, t, { media });
      expect(out.ok ? null : out.error.code).toBe("invalid-params");
    }
  });
});

describe("ReorderEdit — atomic, undoable, saved and exported", () => {
  it("a refused reorder rejects its whole transaction; the input is untouched", () => {
    const base = directorSequence();
    const e4 = item(base, "event-4");
    const seq = edit(base, (s) => {
      s.items[e4.id]!.startFrame = 396;
    });
    const before = JSON.stringify(seq);
    const g = seededIds("atomic");
    const t = makeTransaction(g, "Two steps", "manual", [
      commands.move(g, [item(seq, "event-7").id], -4),
      commands.reorder(g, ev(seq, "event-3", "event-2")),
    ] as unknown as Command[]);
    const out = applyTransaction(seq, t, { media });
    expect(out.ok ? null : out.error.code).toBe("reorder-blocked");
    expect(JSON.stringify(seq)).toBe(before);
  });

  it("undo/redo restore exactly; it saves, reloads and exports in the new order", () => {
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
    const ws = deepFreeze(workspaceFromVersions([structuredClone(director)]));
    const before = sequenceOf(ws, "v2", projectClips)!;
    const order = ev(before, "event-5", "event-2", "event-3");
    const g = seededIds("ws");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Reorder", "manual", [commands.reorder(g, order)] as unknown as Command[]),
      { clips: projectClips, media, ids: g, now: "19:00" },
    );
    if (!out.ok) throw new Error(out.error.message);
    const w = out.activeVersionId;
    expect(w).not.toBe("v2"); // forked a working version
    const after = sequenceOf(out.workspace, w, projectClips)!;

    const undone = undoIn(out.workspace, w);
    expect(sequenceOf(undone, w, projectClips)).toStrictEqual(before);
    const redone = redoIn(undone, w);
    expect(sequenceOf(redone, w, projectClips)).toStrictEqual(after);

    const json = JSON.stringify(
      serializeWorkspace(
        out.workspace,
        { activeVersionId: w, chosenStoryId: null, targetSeconds: 30, storyboardSelectIds: [] },
        "analysis-A",
        "",
        projectClips,
      ),
    );
    const restored = parseSavedEditStateV2(JSON.parse(json), "analysis-A", projectClips)!;
    expect(sequenceOf(restored.workspace, w, projectClips)).toStrictEqual(after);
    const reUndone = undoIn(restored.workspace, w);
    expect(sequenceOf(reUndone, w, projectClips)).toStrictEqual(before);

    // Exports: the derived timeline plays the clips in their new order.
    const timeline = derivedTimeline(after);
    const v1 = itemsOnTrack(after, after.tracks.find((t) => t.name === "V1")!.id).map(
      (i) => i.legacy?.decision.id,
    );
    expect(v1).toEqual(["event-1", "event-5", "event-2", "event-3", "event-6"]);
    const { usable } = validateTimelineForExport(timeline, projectClips);
    expect(usable).toHaveLength(timeline.decisions.length);
    expect(buildXmeml(timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(timeline, usable, projectClips)).toContain("TITLE:");
    expect(buildFcpxml(timeline, usable, projectClips, "/Media").xml).toContain("<fcpxml");
    const starts = Object.fromEntries(
      timeline.decisions.map((d) => [d.id, Math.round(d.timelineStartSeconds * 24)]),
    );
    expect([starts["event-5"], starts["event-2"], starts["event-3"]]).toEqual([240, 384, 552]);
  });
});

/* ------------------------------ real projects ------------------------------ */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("every V1 run of every saved version: reordered cleanly or refused for a stated reason — files untouched", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map((c: { id: string; fps: number; duration_seconds: number }) =>
        clip(c.id, c.fps, c.duration_seconds),
      );
      const realMedia = mediaOf(clips);
      const tally = { reordered: 0, refused: 0, versions: 0 };
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const seq = deepFreeze(sequenceOf(ws, v.id, clips)!);
          const v1 = seq.tracks.find((t) => t.name === "V1");
          const items = v1 ? itemsOnTrack(seq, v1.id) : [];
          if (items.length < 2) continue;
          tally.versions += 1;
          // Each maximal back-to-back run, reversed — by the Director.
          const runs: ClipItem[][] = [[items[0]!]];
          for (const it of items.slice(1)) {
            const last = runs[runs.length - 1]!;
            if (it.startFrame === endFrame(last[last.length - 1]!)) last.push(it);
            else runs.push([it]);
          }
          for (const r of runs.filter((x) => x.length >= 2)) {
            const order = [...r].reverse().map((i) => i.id);
            const g = seededIds("real");
            const out = applyTransaction(
              seq,
              makeTransaction(g, "Reverse", "director", [
                commands.reorder(g, order),
              ] as unknown as Command[]),
              { media: realMedia },
            );
            if (out.ok) {
              tally.reordered += 1;
              expect(sequenceEndFrame(out.sequence)).toBe(sequenceEndFrame(seq));
              expect(findViolations(out.sequence, { media: realMedia })).toEqual(
                findViolations(seq, { media: realMedia }),
              );
              const timeline = derivedTimeline(out.sequence);
              const { usable } = validateTimelineForExport(timeline, clips);
              expect(buildXmeml(timeline, usable, clips, "/Media").xml).toContain("<xmeml");
              for (const it of r) {
                const moved = out.sequence.items[it.id]!;
                expect(shape(moved)).toEqual(shape(it));
              }
            } else {
              tally.refused += 1;
              expect(["reorder-blocked", "protected"]).toContain(out.error.code);
              expect(out.error.itemIds?.every((id) => seq.items[id])).toBe(true);
            }
          }
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(tally.versions).toBeGreaterThan(0);
      expect(tally.reordered + tally.refused).toBeGreaterThan(0);
    });
  },
);
