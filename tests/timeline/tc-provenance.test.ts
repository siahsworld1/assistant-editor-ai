// Source-label provenance (Step 5 amendment A).
//
// 23.976 media has 24 timecode labels per wall-clock second, so about one
// second boundary in 42 has two labels for ONE frame ("…:20:23" and "…:21:00").
// Frames stay the only canonical/editable timing; the imported label is kept
// read-only and consulted only while an endpoint is still exactly at its
// imported frame. These tests sweep every shared-label boundary in an hour of
// media and prove: import → edit → edit back restores the exact length and
// labels; moves keep the provenance; a genuinely changed endpoint is converted
// normally; and splits behave as well as the model permits.
import { describe, expect, it } from "vitest";
import type { UniversalTimeline } from "@/lib/ae/types";
import { secondsToTc, tcToSeconds } from "@/lib/nle/timecode";
import { commands } from "@/lib/timeline/commands";
import { seededIds } from "@/lib/timeline/ids";
import { legacyToSequence, sequenceToLegacy } from "@/lib/timeline/legacy-adapter";
import {
  frameToTc,
  frameToTcPreferring,
  rateFromFps,
  sequenceDurationFrames,
  tcToFrame,
} from "@/lib/timeline/time";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { ClipItem, Command, Sequence } from "@/lib/timeline/types";
import { deepFreeze, mediaOf } from "./engine-helpers";
import { clip } from "./legacy-fixtures";

const FPS = 23.976;
const R23 = rateFromFps(FPS);
const R24 = rateFromFps(24);
const HOUR = 3600;
const LONG = [clip("clip-long", FPS, HOUR + 30)];
const media = mediaOf(LONG);

const whole = (s: number) => secondsToTc(s, FPS); // "…:S:00"
const lastOfPrev = (s: number) => secondsToTc(s - 1 + 23 / FPS, FPS); // "…:(S-1):23"
const secs = (tc: string) => tcToSeconds(tc, FPS)!;

/** Every whole second whose "S:00" label shares a frame with "(S-1):23". */
const SHARED: number[] = [];
for (let s = 1; s < HOUR; s += 1) {
  if (tcToFrame(whole(s), R23) === tcToFrame(lastOfPrev(s), R23)) SHARED.push(s);
}

/** The labels that name a second boundary: one, or two when shared. */
function labelsAt(s: number): string[] {
  return SHARED.includes(s) ? [whole(s), lastOfPrev(s)] : [whole(s)];
}

function cut(
  inTc: string,
  outTc: string,
  lane: "b-roll" | "interview" = "b-roll",
): UniversalTimeline {
  return {
    id: "tl",
    name: "Provenance",
    fps: 24,
    targetSeconds: 10,
    totalSeconds: 10,
    decisions: [
      {
        id: "e",
        lane,
        clipId: "clip-long",
        label: "e",
        sourceInTc: inTc,
        sourceOutTc: outTc,
        timelineStartSeconds: 4,
        // As the worker writes it: out − in on the timecode clock.
        durationSeconds: Math.round((secs(outTc) - secs(inTc)) * 1e6) / 1e6,
      },
    ],
  };
}

function only(seq: Sequence): ClipItem {
  return Object.values(seq.items).find((i) => i.legacy)!;
}

function apply(seq: Sequence, build: (ids: ReturnType<typeof seededIds>) => Command[]): Sequence {
  const ids = seededIds("prov");
  const out = applyTransaction(seq, makeTransaction(ids, "t", "manual", build(ids), "x"), {
    media,
  });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return deepFreeze(out.sequence);
}

/** Every 8-second range starting at a shared boundary, in both label forms
 * at each end where the end is also shared — plus every plain boundary. */
const RANGES: Array<[string, string]> = [];
for (let s = 1; s + 8 < HOUR; s += 1) {
  for (const inTc of labelsAt(s)) for (const outTc of labelsAt(s + 8)) RANGES.push([inTc, outTc]);
}

describe("the shared labels", () => {
  it("exist: 86 boundaries in an hour of 23.976 media", () => {
    expect(SHARED).toHaveLength(86);
    expect(RANGES.length).toBeGreaterThan(3591);
  });

  it("frameToTc alone cannot tell them apart — the problem being fixed", () => {
    let drift = 0;
    for (const [inTc, outTc] of RANGES) {
      const a = tcToFrame(inTc, R23)!;
      const b = tcToFrame(outTc, R23)!;
      const expected = Math.round((secs(outTc) - secs(inTc)) * 24);
      if (sequenceDurationFrames(a, b, R23, R24) !== expected) drift += 1;
    }
    expect(drift).toBeGreaterThan(0);
  });
});

describe("label hints (time.ts)", () => {
  const s = SHARED[0]!;
  const frame = tcToFrame(whole(s), R23)!;

  it("apply only to the exact frame they were imported at", () => {
    expect(frameToTc(frame, R23)).toBe(lastOfPrev(s));
    expect(frameToTcPreferring(frame, R23, { frame, tc: whole(s) })).toBe(whole(s));
    expect(frameToTcPreferring(frame + 1, R23, { frame, tc: whole(s) })).toBe(
      frameToTc(frame + 1, R23),
    );
    expect(frameToTcPreferring(frame - 1, R23, { frame, tc: whole(s) })).toBe(
      frameToTc(frame - 1, R23),
    );
  });

  it("are ignored when the label does not name the frame", () => {
    expect(frameToTcPreferring(frame, R23, { frame, tc: whole(s + 1) })).toBe(lastOfPrev(s));
    expect(frameToTcPreferring(frame, R23, { frame, tc: "garbage" })).toBe(lastOfPrev(s));
  });
});

describe("import records provenance only where it matters", () => {
  it("no hint for an unambiguous endpoint or for the label frameToTc already gives", () => {
    const plain = only(legacyToSequence(cut(whole(10), whole(18)), LONG, { scope: "t" }));
    expect(SHARED.includes(10) || SHARED.includes(18)).toBe(false);
    expect(plain.sourceTcProvenance).toBeUndefined();
    const s = SHARED[0]!;
    const asDefault = only(
      legacyToSequence(cut(lastOfPrev(s), whole(s + 8)), LONG, { scope: "t" }),
    );
    if (!SHARED.includes(s + 8)) expect(asDefault.sourceTcProvenance).toBeUndefined();
  });

  it("a hint for the second label of a shared frame", () => {
    const s = SHARED[0]!;
    const it = only(legacyToSequence(cut(whole(s), whole(s + 8)), LONG, { scope: "t" }));
    expect(it.sourceTcProvenance?.in).toEqual({ frame: it.sourceInFrame, tc: whole(s) });
  });
});

describe("every shared-label boundary (exhaustive, one hour of media)", () => {
  it("imports at exactly the legacy length, and the rule agrees with it", () => {
    for (const [inTc, outTc] of RANGES) {
      const it = only(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
      const expected = Math.round((secs(outTc) - secs(inTc)) * 24);
      expect(it.durationFrames, `${inTc}→${outTc}`).toBe(expected);
      expect(
        sequenceDurationFrames(
          it.sourceInFrame,
          it.sourceOutFrame,
          R23,
          R24,
          it.sourceTcProvenance,
        ),
        `${inTc}→${outTc}`,
      ).toBe(expected);
    }
  });

  it.each(["in", "out"] as const)(
    "original → trim %s −1 → trim +1 restores the exact length, frames and labels",
    (edge) => {
      for (const [inTc, outTc] of RANGES) {
        const seq = deepFreeze(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
        const orig = only(seq);
        const away = apply(seq, (ids) => [commands.trim(ids, orig.id, edge, -1)]);
        const back = apply(away, (ids) => [commands.trim(ids, orig.id, edge, +1)]);
        const b = back.items[orig.id]!;
        const tag = `${edge} ${inTc}→${outTc}`;
        expect(b.durationFrames, tag).toBe(orig.durationFrames);
        expect(b.startFrame, tag).toBe(orig.startFrame);
        expect([b.sourceInFrame, b.sourceOutFrame], tag).toEqual([
          orig.sourceInFrame,
          orig.sourceOutFrame,
        ]);
        expect(b.sourceTcProvenance, tag).toEqual(orig.sourceTcProvenance);
        const d = sequenceToLegacy(back).timeline.decisions[0]!;
        expect([d.sourceInTc, d.sourceOutTc], tag).toEqual([inTc, outTc]);
        expect(Math.round(d.durationSeconds * 24), tag).toBe(orig.durationFrames);
      }
    },
  );

  it("trim away by several frames and exactly back also restores it", () => {
    for (const [inTc, outTc] of RANGES) {
      const seq = deepFreeze(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
      const orig = only(seq);
      const a = apply(seq, (ids) => [
        commands.trim(ids, orig.id, "out", -5),
        commands.trim(ids, orig.id, "in", 3),
      ]);
      const b = apply(a, (ids) => [
        commands.trim(ids, orig.id, "in", -3),
        commands.trim(ids, orig.id, "out", 5),
      ]);
      expect(b.items[orig.id]!.durationFrames, `${inTc}→${outTc}`).toBe(orig.durationFrames);
      expect(b.items[orig.id]!.startFrame, `${inTc}→${outTc}`).toBe(orig.startFrame);
    }
  });

  it("a move keeps provenance and the exported labels", () => {
    for (const [inTc, outTc] of RANGES) {
      const seq = deepFreeze(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
      const orig = only(seq);
      const moved = apply(seq, (ids) => [commands.move(ids, [orig.id], 37)]);
      const m = moved.items[orig.id]!;
      expect(m.sourceTcProvenance).toEqual(orig.sourceTcProvenance);
      expect(m.durationFrames).toBe(orig.durationFrames);
      const d = sequenceToLegacy(moved).timeline.decisions[0]!;
      expect([d.sourceInTc, d.sourceOutTc], `${inTc}→${outTc}`).toEqual([inTc, outTc]);
      // …and a trim after the move still round-trips.
      const back = apply(
        apply(moved, (ids) => [commands.trim(ids, orig.id, "out", -1)]),
        (ids) => [commands.trim(ids, orig.id, "out", 1)],
      );
      expect(back.items[orig.id]!.durationFrames).toBe(orig.durationFrames);
    }
  });

  it("a genuinely changed endpoint is converted normally — provenance never hides it", () => {
    for (const [inTc, outTc] of RANGES) {
      const seq = deepFreeze(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
      const orig = only(seq);
      const t = apply(seq, (ids) => [commands.trim(ids, orig.id, "out", -1)]);
      const it = t.items[orig.id]!;
      // The moved out point is read with the plain conversion; the untouched
      // in point keeps its imported label.
      expect(it.durationFrames).toBe(
        sequenceDurationFrames(it.sourceInFrame, it.sourceOutFrame, R23, R24, {
          in: orig.sourceTcProvenance?.in ?? null,
          out: null,
        }),
      );
      const d = sequenceToLegacy(t).timeline.decisions[0]!;
      expect(d.sourceOutTc).toBe(frameToTc(orig.sourceOutFrame - 1, R23));
      expect(d.sourceInTc).toBe(inTc);
      expect(it.sourceOutFrame).toBe(orig.sourceOutFrame - 1); // frames are the truth
    }
  });

  it("linked V1/A1 pairs trim back identically and stay aligned", () => {
    for (const s of SHARED) {
      const seq = deepFreeze(
        legacyToSequence(cut(whole(s), whole(s + 8), "interview"), LONG, { scope: "t" }),
      );
      const v = only(seq);
      const back = apply(
        apply(seq, (ids) => [commands.trim(ids, v.id, "in", -1)]),
        (ids) => [commands.trim(ids, v.id, "in", 1)],
      );
      for (const id of seq.links[v.linkGroupId!]!.itemIds) {
        expect(back.items[id]!.durationFrames).toBe(v.durationFrames);
        expect(back.items[id]!.startFrame).toBe(v.startFrame);
      }
      expect(sequenceToLegacy(back).timeline.decisions).toHaveLength(1); // A1 implicit again
    }
  });
});

describe("split at a shared-label boundary", () => {
  // Every range above, bladed at every 24th frame and at frames next to a shared label.
  function splitCases() {
    const out: Array<{ seq: Sequence; orig: ClipItem; offset: number; tag: string }> = [];
    for (const [inTc, outTc] of RANGES.filter(
      ([a, b]) => SHARED.includes(Math.round(secs(a))) || SHARED.includes(Math.round(secs(b))),
    )) {
      const seq = deepFreeze(legacyToSequence(cut(inTc, outTc), LONG, { scope: "t" }));
      const orig = only(seq);
      for (const offset of [1, 23, 24, 25, 96, 167, 168, orig.durationFrames - 1]) {
        out.push({ seq, orig, offset, tag: `${inTc}→${outTc} @${offset}` });
      }
    }
    return out;
  }

  it("pieces cover the original exactly and each keeps the outer label", () => {
    let bothExact = 0;
    let leftExact = 0;
    let total = 0;
    for (const { seq, orig, offset, tag } of splitCases()) {
      let rightId = "";
      const after = apply(seq, (ids) => {
        const c = commands.split(ids, seq, orig.id, orig.startFrame + offset);
        rightId = c.params.rightItemIds[orig.id]!;
        return [c];
      });
      const left = after.items[orig.id]!;
      const right = after.items[rightId]!;
      expect(left.durationFrames + right.durationFrames, tag).toBe(orig.durationFrames);
      expect(right.startFrame, tag).toBe(left.startFrame + left.durationFrames);
      expect(left.sourceOutFrame, tag).toBe(right.sourceInFrame);
      // Each piece's stored length is exact by construction (left = offset,
      // right = remainder). Its source range is the nearest the frame grid
      // allows: the rule agrees exactly in almost every case and is never more
      // than one frame off (some lengths have no source range at all).
      const leftRule = sequenceDurationFrames(left.sourceInFrame, left.sourceOutFrame, R23, R24, {
        in: left.sourceTcProvenance?.in,
      });
      const rightRule = sequenceDurationFrames(
        right.sourceInFrame,
        right.sourceOutFrame,
        R23,
        R24,
        { out: right.sourceTcProvenance?.out },
      );
      expect(Math.abs(leftRule - left.durationFrames), tag).toBeLessThanOrEqual(1);
      expect(Math.abs(rightRule - right.durationFrames), tag).toBeLessThanOrEqual(1);
      if (leftRule === left.durationFrames) leftExact += 1;
      else {
        // Only where the frame grid permits nothing better: no source frame
        // anywhere in the item gives the left piece exactly `offset`.
        for (let f = orig.sourceInFrame + 1; f < orig.sourceOutFrame; f += 1) {
          const l = sequenceDurationFrames(orig.sourceInFrame, f, R23, R24, {
            in: orig.sourceTcProvenance?.in,
          });
          expect(l, `${tag} source frame ${f}`).not.toBe(offset);
        }
      }
      total += 1;
      if (leftRule === left.durationFrames && rightRule === right.durationFrames) bothExact += 1;
      // Outer labels survive on the exported pieces.
      const ds = sequenceToLegacy(after).timeline.decisions;
      const dl = ds.find((d) => d.id === "e")!;
      const dr = ds.find((d) => d.id !== "e")!;
      expect(dl.sourceInTc, tag).toBe(sequenceToLegacy(seq).timeline.decisions[0]!.sourceInTc);
      expect(dr.sourceOutTc, tag).toBe(sequenceToLegacy(seq).timeline.decisions[0]!.sourceOutTc);
    }
    // Reported, and pinned so a regression is visible.
    expect(bothExact).toBe(leftExact); // the right piece is exact whenever the left can be
    expect(bothExact / total).toBeGreaterThan(0.9);
    console.info(`split: ${bothExact}/${total} exact on both pieces, ${leftExact}/${total} left`);
  });

  it("each piece's outer edge trims away and back to its exact length", () => {
    for (const { seq, orig, offset, tag } of splitCases().filter((c) => c.offset === 96)) {
      let rightId = "";
      const after = apply(seq, (ids) => {
        const c = commands.split(ids, seq, orig.id, orig.startFrame + offset);
        rightId = c.params.rightItemIds[orig.id]!;
        return [c];
      });
      const left = after.items[orig.id]!;
      const right = after.items[rightId]!;
      const l2 = apply(
        apply(after, (ids) => [commands.trim(ids, left.id, "in", -1)]),
        (ids) => [commands.trim(ids, left.id, "in", 1)],
      ).items[left.id]!;
      expect(l2.durationFrames, tag).toBe(left.durationFrames);
      const r2 = apply(
        apply(after, (ids) => [commands.trim(ids, rightId, "out", -1)]),
        (ids) => [commands.trim(ids, rightId, "out", 1)],
      ).items[rightId]!;
      // The right piece re-derives by the rule; where the split's remainder
      // already matched the rule (the common case) this is its exact length.
      const rightRule = sequenceDurationFrames(
        right.sourceInFrame,
        right.sourceOutFrame,
        R23,
        R24,
        { out: right.sourceTcProvenance?.out },
      );
      expect(r2.durationFrames, tag).toBe(rightRule);
    }
  });
});
