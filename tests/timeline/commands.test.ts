// Command engine (src/lib/timeline/commands): Move, Trim, Split, Delete,
// RippleDelete, ReplaceAssembly; protection; invariants; reserved commands.
// All on a 24 fps sequence of 23.976 media (the v1.2 Director cut).
import { describe, expect, it } from "vitest";
import { assemblyFromLegacy } from "@/lib/timeline/commands/replace-assembly";
import { splitSourceFrame } from "@/lib/timeline/commands/split";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { legacyToSequence, sequenceToLegacy } from "@/lib/timeline/legacy-adapter";
import { endFrame, itemsOnTrack } from "@/lib/timeline/selectors";
import { sequenceDurationFrames } from "@/lib/timeline/time";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { CommandType, Sequence } from "@/lib/timeline/types";
import {
  commands,
  deepFreeze,
  directorSequence,
  item,
  media,
  partner,
  protect,
  run,
  track,
} from "./engine-helpers";
import {
  awkwardClips,
  awkwardCut,
  directorCut,
  emptyCut,
  projectClips,
  refinedCut,
} from "./legacy-fixtures";

function ok(outcome: ReturnType<typeof run>["outcome"]): Sequence {
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.sequence;
}

/** Items whose object identity changed between two sequences. */
function touched(a: Sequence, b: Sequence): string[] {
  const ids = new Set([...Object.keys(a.items), ...Object.keys(b.items)]);
  return [...ids].filter((id) => a.items[id] !== b.items[id]).sort();
}

describe("MoveEdit", () => {
  it("changes start frames only; linked A1 follows; nothing else moves", () => {
    const seq = directorSequence();
    const e6 = item(seq, "event-6");
    const next = ok(run(seq, "manual", (ids) => [commands.move(ids, [e6.id], 48)]).outcome);
    const moved = next.items[e6.id]!;
    expect(moved.startFrame).toBe(e6.startFrame + 48);
    expect([moved.durationFrames, moved.sourceInFrame, moved.sourceOutFrame]).toEqual([
      e6.durationFrames,
      e6.sourceInFrame,
      e6.sourceOutFrame,
    ]);
    const a1 = partner(next, moved);
    expect([a1.startFrame, a1.durationFrames]).toEqual([moved.startFrame, moved.durationFrames]);
    expect(touched(seq, next)).toEqual([e6.id, partner(seq, e6).id].sort());
    expect(findViolations(next)).toEqual([]);
  });

  it("rejects a same-track overlap and leaves the sequence untouched", () => {
    const seq = directorSequence();
    const { outcome } = run(seq, "manual", (ids) => [
      commands.move(ids, [item(seq, "event-1").id], 10),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("overlap");
    expect(seq).toStrictEqual(directorSequence());
  });

  it("rejects moving before the start of the sequence", () => {
    const seq = directorSequence();
    const { outcome } = run(seq, "manual", (ids) => [
      commands.move(ids, [item(seq, "event-1").id], -1),
    ]);
    expect(!outcome.ok && outcome.error.code).toBe("out-of-bounds");
  });

  it("moves a V2 cutaway without moving the dialogue under it", () => {
    const seq = directorSequence();
    const e4 = item(seq, "event-4");
    const next = ok(run(seq, "manual", (ids) => [commands.move(ids, [e4.id], -12)]).outcome);
    expect(next.items[e4.id]!.startFrame).toBe(e4.startFrame - 12);
    expect(touched(seq, next)).toEqual([e4.id]);
  });

  it("keeps the 240-frame length of a 239-source-frame item through a move (239/240 regression)", () => {
    const seq = directorSequence();
    const e1 = item(seq, "event-1");
    expect([e1.sourceOutFrame - e1.sourceInFrame, e1.durationFrames]).toEqual([239, 240]);
    // Lift event 2 to make room, then move event 1 sixty frames into the gap:
    // its provenance no longer matches, so it is regenerated from frames.
    const next = ok(
      run(seq, "manual", (ids) => [
        commands.delete(ids, [item(seq, "event-2").id]),
        commands.move(ids, [e1.id], 60),
      ]).outcome,
    );
    const moved = next.items[e1.id]!;
    expect([moved.startFrame, moved.durationFrames]).toEqual([60, 240]);
    expect([moved.sourceInFrame, moved.sourceOutFrame]).toEqual([
      e1.sourceInFrame,
      e1.sourceOutFrame,
    ]);
    const { timeline, warnings } = sequenceToLegacy(next);
    expect(warnings).toEqual([]);
    expect(timeline.fps).toBe(24);
    const d = timeline.decisions.find((x) => x.id === "event-1")!;
    expect(d).not.toStrictEqual(directorCut.decisions[0]); // regenerated, not provenance
    expect(Math.round(d.timelineStartSeconds * 24)).toBe(60);
    expect(Math.round(d.durationSeconds * 24)).toBe(240); // 240 sequence frames, not 239
  });
});

describe("TrimEdit", () => {
  it("out-trim: source frames change, length follows the schema-2 rule, start stays, A1 matches", () => {
    const seq = directorSequence();
    const e6 = item(seq, "event-6");
    const next = ok(run(seq, "manual", (ids) => [commands.trim(ids, e6.id, "out", -24)]).outcome);
    const t = next.items[e6.id]!;
    expect(t.sourceOutFrame).toBe(e6.sourceOutFrame - 24);
    expect(t.startFrame).toBe(e6.startFrame);
    expect(t.durationFrames).toBe(
      sequenceDurationFrames(t.sourceInFrame, t.sourceOutFrame, t.mediaRate, next.rate),
    );
    expect(partner(next, t)).toMatchObject({
      startFrame: t.startFrame,
      durationFrames: t.durationFrames,
      sourceInFrame: t.sourceInFrame,
      sourceOutFrame: t.sourceOutFrame,
    });
    expect(touched(seq, next)).toEqual([e6.id, partner(seq, e6).id].sort()); // non-ripple: nothing else moves
  });

  it("in-trim keeps the item's end on the sequence and moves its start", () => {
    const seq = directorSequence();
    const e6 = item(seq, "event-6");
    const t = ok(run(seq, "manual", (ids) => [commands.trim(ids, e6.id, "in", 12)]).outcome).items[
      e6.id
    ]!;
    expect(t.sourceInFrame).toBe(e6.sourceInFrame + 12);
    expect(endFrame(t)).toBe(endFrame(e6));
    expect(t.startFrame).toBe(endFrame(e6) - t.durationFrames);
  });

  it("a one-source-frame trim changes the 240-frame item by one sequence frame (239/240)", () => {
    const seq = directorSequence();
    const e1 = item(seq, "event-1");
    const shorter = ok(run(seq, "manual", (ids) => [commands.trim(ids, e1.id, "out", -1)]).outcome);
    expect(shorter.items[e1.id]!.durationFrames).toBe(239);
    const back = ok(
      run(deepFreeze(shorter), "manual", (ids) => [commands.trim(ids, e1.id, "out", 1)]).outcome,
    );
    expect(back.items[e1.id]!.durationFrames).toBe(240);
    expect(back.rate).toEqual(seq.rate);
  });

  it("rejects empty/negative ranges, media-bound violations and overlaps", () => {
    const seq = directorSequence();
    const e6 = item(seq, "event-6");
    const e5 = item(seq, "event-5");
    const len = e6.sourceOutFrame - e6.sourceInFrame;
    const cases: Array<[ReturnType<typeof commands.trim>, string]> = [];
    const ids = seededIds("bad");
    cases.push([commands.trim(ids, e6.id, "out", -len), "invalid-range"]);
    cases.push([commands.trim(ids, e6.id, "in", len), "invalid-range"]);
    cases.push([commands.trim(ids, e6.id, "in", -e6.sourceInFrame - 1), "out-of-bounds"]);
    cases.push([commands.trim(ids, e6.id, "out", 99_999), "out-of-bounds"]); // past the media end
    cases.push([commands.trim(ids, e5.id, "out", 48), "overlap"]); // into event 6
    for (const [cmd, code] of cases) {
      const outcome = applyTransaction(seq, makeTransaction(ids, "t", "manual", [cmd]), { media });
      expect(!outcome.ok && outcome.error.code, JSON.stringify(cmd.params)).toBe(code);
    }
  });
});

describe("SplitEdit", () => {
  it("two pieces exactly cover the original, with contiguous source and linked A1 split too", () => {
    const seq = directorSequence();
    const e1 = item(seq, "event-1");
    const ids = seededIds("split");
    const cmd = commands.split(ids, seq, e1.id, 100);
    const next = ok(
      applyTransaction(seq, makeTransaction(ids, "split", "manual", [cmd]), { media }),
    );
    const left = next.items[e1.id]!;
    const right = next.items[cmd.params.rightItemIds[e1.id]!]!;
    expect([left.startFrame, left.durationFrames, right.startFrame, right.durationFrames]).toEqual([
      0, 100, 100, 140,
    ]);
    expect(left.durationFrames + right.durationFrames).toBe(e1.durationFrames);
    expect(left.sourceOutFrame).toBe(right.sourceInFrame);
    expect([left.sourceInFrame, right.sourceOutFrame]).toEqual([
      e1.sourceInFrame,
      e1.sourceOutFrame,
    ]);
    // Linked A1: split identically, left in the old link, right in the new one.
    const leftA1 = partner(next, left);
    const rightA1 = partner(next, right);
    expect(rightA1.id).toBe(cmd.params.rightItemIds[partner(seq, e1).id]);
    expect(right.linkGroupId).toBe(cmd.params.rightLinkIds[e1.linkGroupId!]);
    for (const [v, a] of [
      [left, leftA1],
      [right, rightA1],
    ] as const) {
      expect([a.startFrame, a.durationFrames, a.sourceInFrame, a.sourceOutFrame]).toEqual([
        v.startFrame,
        v.durationFrames,
        v.sourceInFrame,
        v.sourceOutFrame,
      ]);
    }
    expect(findViolations(next)).toEqual([]);
  });

  it("picks the split source frame by the schema-2 rule on 23.976 media", () => {
    const seq = directorSequence();
    const e2 = item(seq, "event-2");
    for (let offset = 1; offset < e2.durationFrames; offset += 1) {
      const s = splitSourceFrame(e2, offset, seq);
      expect(s).toBeGreaterThan(e2.sourceInFrame);
      expect(s).toBeLessThan(e2.sourceOutFrame);
      expect(sequenceDurationFrames(e2.sourceInFrame, s, e2.mediaRate, seq.rate)).toBe(offset);
    }
  });

  it("rejects a split at or outside the item's edges, and reused ids", () => {
    const seq = directorSequence();
    const e1 = item(seq, "event-1");
    const ids = seededIds("edge");
    for (const at of [0, 240, 500]) {
      const outcome = applyTransaction(
        seq,
        makeTransaction(ids, "t", "manual", [commands.split(ids, seq, e1.id, at)]),
      );
      expect(!outcome.ok && outcome.error.code).toBe("invalid-params");
    }
    const reuse = commands.split(ids, seq, e1.id, 50);
    reuse.params.rightItemIds[e1.id] = item(seq, "event-2").id;
    const outcome = applyTransaction(seq, makeTransaction(ids, "t", "manual", [reuse]));
    expect(!outcome.ok && outcome.error.code).toBe("invalid-params");
  });
});

describe("DeleteEdit (lift)", () => {
  it("removes the item and its linked A1, leaves the gap, touches nothing else", () => {
    const seq = directorSequence();
    const e3 = item(seq, "event-3");
    const next = ok(run(seq, "manual", (ids) => [commands.delete(ids, [e3.id])]).outcome);
    expect(next.items[e3.id]).toBeUndefined();
    expect(next.items[partner(seq, e3).id]).toBeUndefined();
    expect(next.links[e3.linkGroupId!]).toBeUndefined();
    expect(next.items[item(seq, "event-5").id]!.startFrame).toBe(item(seq, "event-5").startFrame); // gap stays
    expect(touched(seq, next)).toEqual([e3.id, partner(seq, e3).id].sort());
  });

  it("explicit linked rule: deleting the A1 side deletes its V1 picture too", () => {
    const seq = directorSequence();
    const e3 = item(seq, "event-3");
    const next = ok(
      run(seq, "manual", (ids) => [commands.delete(ids, [partner(seq, e3).id])]).outcome,
    );
    expect(next.items[e3.id]).toBeUndefined();
  });
});

describe("RippleDelete", () => {
  it("closes the gap on every track; V2 stays over the same dialogue", () => {
    const seq = directorSequence();
    const e2 = item(seq, "event-2");
    const e3 = item(seq, "event-3");
    const e4 = item(seq, "event-4"); // cutaway over event 3
    const next = ok(run(seq, "manual", (ids) => [commands.rippleDelete(ids, [e2.id])]).outcome);
    const removed = e2.durationFrames; // 168
    expect(next.items[e2.id]).toBeUndefined();
    expect(next.items[partner(seq, e2).id]).toBeUndefined();
    expect(next.items[item(seq, "event-1").id]).toBe(seq.items[item(seq, "event-1").id]); // before: untouched
    for (const id of ["event-3", "event-5", "event-6", "event-4", "event-7"]) {
      expect(next.items[item(seq, id).id]!.startFrame).toBe(item(seq, id).startFrame - removed);
    }
    // The cutaway keeps its offset into the dialogue it covers.
    expect(next.items[e4.id]!.startFrame - next.items[e3.id]!.startFrame).toBe(
      e4.startFrame - e3.startFrame,
    );
    // V1 stays contiguous.
    const v1 = itemsOnTrack(next, track(next, "V1").id);
    for (let i = 1; i < v1.length; i += 1) expect(v1[i]!.startFrame).toBe(endFrame(v1[i - 1]!));
    expect(findViolations(next)).toEqual([]);
  });

  it("is blocked by material on another track inside the removed range — unless it is deleted in the same transaction", () => {
    const seq = directorSequence();
    const e3 = item(seq, "event-3");
    const e4 = item(seq, "event-4");
    const blocked = run(seq, "manual", (ids) => [commands.rippleDelete(ids, [e3.id])]).outcome;
    expect(!blocked.ok && blocked.error.code).toBe("ripple-blocked");
    expect(!blocked.ok && blocked.error.itemIds).toEqual([e4.id]);
    const next = ok(
      run(seq, "manual", (ids) => [
        commands.delete(ids, [e4.id]),
        commands.rippleDelete(ids, [e3.id]),
      ]).outcome,
    );
    expect(next.items[item(seq, "event-5").id]!.startFrame).toBe(e3.startFrame);
  });

  it("rejects the whole ripple if it would have to move protected material", () => {
    const base = directorSequence();
    for (const target of [{ itemId: item(base, "event-7").id }, { trackName: "V2" }]) {
      const seq = protect(base, target, { locked: true });
      const outcome = run(seq, "manual", (ids) => [
        commands.rippleDelete(ids, [item(seq, "event-2").id]),
      ]).outcome;
      expect(!outcome.ok && outcome.error.code).toBe("protected");
    }
  });

  it("removes from one track at a time", () => {
    const seq = directorSequence();
    const outcome = run(seq, "manual", (ids) => [
      commands.rippleDelete(ids, [item(seq, "event-1").id, item(seq, "event-4").id]),
    ]).outcome;
    expect(!outcome.ok && outcome.error.code).toBe("invalid-params");
  });
});

describe("protection", () => {
  const ops = (seq: Sequence) => {
    const e6 = item(seq, "event-6");
    return {
      move: (ids: ReturnType<typeof seededIds>) => [commands.move(ids, [e6.id], 4)],
      trim: (ids: ReturnType<typeof seededIds>) => [commands.trim(ids, e6.id, "out", -4)],
      split: (ids: ReturnType<typeof seededIds>) => [
        commands.split(ids, seq, e6.id, e6.startFrame + 10),
      ],
      delete: (ids: ReturnType<typeof seededIds>) => [commands.delete(ids, [e6.id])],
    };
  };

  it("`locked` item: rejected for manual, director and system", () => {
    const seq = protect(
      directorSequence(),
      { itemId: item(directorSequence(), "event-6").id },
      { locked: true },
    );
    for (const origin of ["manual", "director", "system"] as const) {
      for (const [name, build] of Object.entries(ops(seq))) {
        const { outcome } = run(seq, origin, build);
        expect(!outcome.ok && outcome.error.code, `${origin} ${name}`).toBe("protected");
      }
    }
  });

  it("`locked` track: rejected for everyone, including linked partners on it", () => {
    const seq = protect(directorSequence(), { trackName: "A1" }, { locked: true });
    for (const origin of ["manual", "director"] as const) {
      for (const [name, build] of Object.entries(ops(seq))) {
        const { outcome } = run(seq, origin, build);
        expect(!outcome.ok && outcome.error.code, `${origin} ${name}`).toBe("protected");
      }
    }
  });

  it("`aiLocked` item: the Director is rejected; deliberate manual editing is allowed", () => {
    const seq = protect(
      directorSequence(),
      { itemId: item(directorSequence(), "event-6").id },
      { aiLocked: true },
    );
    for (const [name, build] of Object.entries(ops(seq))) {
      expect(run(seq, "director", build).outcome.ok, `director ${name}`).toBe(false);
      expect(run(seq, "manual", build).outcome.ok, `manual ${name}`).toBe(true);
    }
  });

  it("`aiLocked` track: the Director is rejected; manual editing is allowed", () => {
    const seq = protect(directorSequence(), { trackName: "V1" }, { aiLocked: true });
    for (const [name, build] of Object.entries(ops(seq))) {
      const d = run(seq, "director", build).outcome;
      expect(!d.ok && d.error.code, `director ${name}`).toBe("protected");
      expect(run(seq, "manual", build).outcome.ok, `manual ${name}`).toBe(true);
    }
  });
});

describe("ReplaceAssembly", () => {
  it("brings a whole Director build in as one command, exporting exactly as the build", () => {
    const empty = deepFreeze(legacyToSequence(emptyCut, projectClips, { scope: "empty" }));
    const ids = seededIds("assembly");
    const params = assemblyFromLegacy(empty, directorCut, projectClips, ids);
    const txn = makeTransaction(ids, "Director build", "director", [
      commands.replaceAssembly(ids, params),
    ]);
    const next = ok(applyTransaction(empty, txn, { media }));
    expect(Object.keys(next.items)).toHaveLength(Object.keys(directorSequence().items).length);
    expect(Object.values(next.items).every((i) => i.originTransactionId === txn.id)).toBe(true);
    expect(sequenceToLegacy(next).timeline.decisions).toStrictEqual(directorCut.decisions);
    expect(findViolations(next)).toEqual([]);
  });

  it("keeps material protected from the Director and rejects an assembly that would overlap it", () => {
    const seq = directorSequence();
    const kept = item(seq, "event-7");
    const protectedSeq = protect(seq, { itemId: kept.id }, { aiLocked: true });
    const ids = seededIds("rebuild");
    const params = assemblyFromLegacy(protectedSeq, directorCut, projectClips, ids);
    // The rebuild re-creates a cutaway exactly where the kept one sits → overlap.
    const clash = applyTransaction(
      protectedSeq,
      makeTransaction(ids, "rebuild", "director", [commands.replaceAssembly(ids, params)]),
      { media },
    );
    expect(!clash.ok && clash.error.code).toBe("invariant");
    // Without the clashing cutaway the rebuild goes in and the kept item survives.
    const withoutV2 = {
      ...params,
      items: params.items.filter((i) => i.legacy?.decision.id !== "event-7"),
    };
    const next = ok(
      applyTransaction(
        protectedSeq,
        makeTransaction(ids, "rebuild", "director", [commands.replaceAssembly(ids, withoutV2)]),
        { media },
      ),
    );
    expect(next.items[kept.id]).toBe(protectedSeq.items[kept.id]);
  });

  it("cannot place items on a track locked against the Director", () => {
    const empty = protect(
      legacyToSequence(emptyCut, projectClips, { scope: "e" }),
      { trackName: "V2" },
      { aiLocked: true },
    );
    const ids = seededIds("locked-track");
    const params = assemblyFromLegacy(empty, directorCut, projectClips, ids);
    const outcome = applyTransaction(
      empty,
      makeTransaction(ids, "b", "director", [commands.replaceAssembly(ids, params)]),
    );
    expect(!outcome.ok && outcome.error.code).toBe("protected");
  });
});

describe("invariants", () => {
  it("imported Director cuts are clean", () => {
    expect(findViolations(directorSequence(), { media })).toEqual([]);
    expect(findViolations(legacyToSequence(refinedCut, projectClips), { media })).toEqual([]);
  });

  it("detects each kind of violation", () => {
    const seq = structuredClone(directorSequence()) as Sequence;
    const [a, b, c, d, e] = Object.values(seq.items);
    a!.durationFrames = 0;
    b!.trackId = "trk_missing";
    c!.mediaClipId = "clip-nope";
    d!.sourceOutFrame = 9_999_999;
    e!.startFrame = -3;
    const codes = new Set(findViolations(seq, { media }).map((v) => v.code));
    for (const code of [
      "bad-duration",
      "missing-track",
      "missing-media",
      "out-of-media-bounds",
      "bad-position",
    ]) {
      expect(codes.has(code as never), code).toBe(true);
    }
    const dup = structuredClone(directorSequence()) as Sequence;
    dup.tracks[1]!.id = dup.tracks[0]!.id;
    expect(findViolations(dup).some((v) => v.code === "duplicate-id")).toBe(true);
    const misaligned = structuredClone(directorSequence()) as Sequence;
    const v1 = item(misaligned, "event-2");
    partner(misaligned, v1).startFrame += 1;
    expect(findViolations(misaligned).some((v) => v.code === "link-misaligned")).toBe(true);
  });

  it("tolerates violations a legacy cut already had, while still editing elsewhere", () => {
    const awkward = deepFreeze(legacyToSequence(awkwardCut, awkwardClips, { scope: "awk" }));
    expect(findViolations(awkward).some((v) => v.code === "overlap")).toBe(true); // pre-existing V2 overlap
    const e8 = Object.values(awkward.items).find((i) => i.legacy?.decision.id === "event-8")!;
    const outcome = applyTransaction(
      awkward,
      makeTransaction(seededIds("awk"), "move", "manual", [
        commands.move(seededIds("awk2"), [e8.id], 300),
      ]),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("reserved commands", () => {
  it("are routed but rejected as not implemented, leaving the sequence unchanged", () => {
    const seq = directorSequence();
    const ids = seededIds("reserved");
    const reserved: CommandType[] = [
      "RippleTrim",
      "RollEdit",
      "SlipEdit",
      "SlideEdit",
      "InsertEdit",
      "SetTrackState",
      "LinkItems",
      "UnlinkItems",
    ];
    for (const type of reserved) {
      const outcome = applyTransaction(
        seq,
        makeTransaction(ids, type, "manual", [{ id: ids.next("command"), type, params: {} }]),
      );
      expect(!outcome.ok && outcome.error.code, type).toBe("not-implemented");
    }
  });
});
