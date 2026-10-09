// Phase 7, Milestone 7 — analyzeCoverage on long cuts. Real-app validation
// measured it growing with cuts × items (1.4 s for 2,000 interview clips,
// run on every change in Cover mode, twice); it now indexes items once.
// These tests pin that the indexed lookups give exactly what a full scan
// gives — coverage spans, the shots covering a cut, protected footage beneath
// it and shots occupying V2 near it, in the same order — and that a long cut
// stays fast.
import { describe, expect, it } from "vitest";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";
import { analyzeCoverage, halfSecondFrames } from "@/lib/timeline/coverage";
import { legacyToSequence } from "@/lib/timeline/legacy-adapter";
import { endFrame, isLockedFrom, itemsOnTrack } from "@/lib/timeline/selectors";
import type { ClipItem, Sequence } from "@/lib/timeline/types";

const tc = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}:00`;
const clip = (id: string, dur: number): Clip =>
  ({ id, filename: `${id}.MP4`, fps: 24, durationSeconds: dur }) as Clip;
/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random cut: interview clips (jumps, continuations and other files),
 * B-roll of very different lengths (some spanning many cuts), and random
 * protection, hidden V2 and disabled shots. */
function randomCut(seed: number, n: number): Sequence {
  const r = rng(seed);
  const clips = [clip("int-a", 4000), clip("int-b", 4000), clip("br", 4000)];
  const decisions: UniversalTimeline["decisions"] = [];
  let t = 0;
  let src = 0;
  for (let k = 0; k < n; k += 1) {
    const dur = 1 + Math.floor(r() * 4);
    const media = r() < 0.8 ? "int-a" : "int-b";
    src += r() < 0.5 ? 0 : 1 + Math.floor(r() * 3); // continue or jump
    decisions.push({
      id: `i${k}`,
      lane: "interview",
      clipId: media,
      label: `i${k}`,
      sourceInTc: tc(src),
      sourceOutTc: tc(src + dur),
      timelineStartSeconds: t,
      durationSeconds: dur,
    } as UniversalTimeline["decisions"][number]);
    src += dur;
    t += dur;
  }
  let b = 0;
  let k = 0;
  while (b < t) {
    b += Math.floor(r() * 6);
    const dur = r() < 0.15 ? 10 + Math.floor(r() * 30) : 0.5 + Math.floor(r() * 4);
    if (b + dur > t) break;
    decisions.push({
      id: `b${k}`,
      lane: "b-roll",
      clipId: "br",
      label: `b${k}`,
      sourceInTc: tc(k % 100),
      sourceOutTc: tc((k % 100) + Math.ceil(dur)),
      timelineStartSeconds: b,
      durationSeconds: dur,
    } as UniversalTimeline["decisions"][number]);
    b += dur;
    k += 1;
  }
  const seq = structuredClone(
    legacyToSequence(
      { id: `r${seed}`, name: "r", fps: 24, targetSeconds: t, totalSeconds: t, decisions },
      clips,
      { scope: "scale" },
    ),
  ) as Sequence;
  for (const item of Object.values(seq.items)) {
    const x = r();
    if (x < 0.05) item.protection = { ...item.protection, locked: true };
    else if (x < 0.1) item.protection = { ...item.protection, aiLocked: true };
    if (r() < 0.05) item.enabled = false;
  }
  if (seed % 5 === 0) seq.tracks.find((tr) => tr.name === "V2")!.hidden = true;
  return seq;
}

const intersects = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** The same answers by scanning everything, as analyzeCoverage used to. */
function bruteForce(seq: Sequence, frame: number) {
  const v1 = seq.tracks.find((t) => t.kind === "video" && t.role === "dialogue")!;
  const overlayTracks = seq.tracks
    .filter((t) => t.kind === "video" && t.order > v1.order)
    .sort((a, b) => a.order - b.order);
  const overlay = overlayTracks[0]!;
  const visible = new Set(overlayTracks.filter((t) => !t.hidden).map((t) => t.id));
  const overlays = Object.values(seq.items)
    .filter((i) => i.enabled && visible.has(i.trackId))
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
  const union: Array<[number, number]> = [];
  for (const o of overlays) {
    const last = union[union.length - 1];
    if (last && o.startFrame <= last[1]) last[1] = Math.max(last[1], endFrame(o));
    else union.push([o.startFrame, endFrame(o)]);
  }
  const span = union.find(([a, b]) => a < frame && b > frame);
  const m = halfSecondFrames(seq.rate);
  const beneath = Object.values(seq.items).filter((i) => {
    const t = seq.tracks.find((x) => x.id === i.trackId)!;
    return (
      t.kind === "video" &&
      t.order < overlay.order &&
      intersects(i.startFrame, endFrame(i), frame - m, frame + m)
    );
  });
  const locked = (i: ClipItem) => isLockedFrom(seq, i, "director");
  return {
    before: span ? frame - span[0] : 0,
    after: span ? span[1] - frame : 0,
    coveringIds: span
      ? overlays
          .filter((o) => intersects(o.startFrame, endFrame(o), span[0], span[1]))
          .map((o) => o.id)
      : [],
    lockedBeneath: beneath.filter(locked).map((i) => i.id),
    occupying: itemsOnTrack(seq, overlay.id)
      .filter((i) => intersects(i.startFrame, endFrame(i), frame - m, frame + m))
      .map((i) => i.id),
  };
}

describe("analyzeCoverage on long cuts", () => {
  it("the indexed lookups equal a full scan, cut by cut, on varied random cuts", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const seq = randomCut(seed, 60 + (seed % 7) * 20);
      for (const cut of analyzeCoverage(seq, "v").cuts) {
        const want = bruteForce(seq, cut.frame);
        expect([cut.coveredBefore, cut.coveredAfter]).toEqual([want.before, want.after]);
        expect(cut.coveringIds).toEqual(want.coveringIds);
        const blockerIds = (code: string) => cut.blockers.find((b) => b.code === code)?.ids ?? [];
        expect(
          [...blockerIds("locked-footage"), ...blockerIds("ai-protected-footage")].sort(),
        ).toEqual([...want.lockedBeneath].sort());
        // Messages name clips in the same order as before.
        for (const code of ["locked-footage", "ai-protected-footage"])
          expect(blockerIds(code)).toEqual(
            want.lockedBeneath.filter((id) => blockerIds(code).includes(id)),
          );
        if (cut.coverage !== "covered" && !seq.tracks.find((t) => t.name === "V2")!.hidden)
          expect(blockerIds("overlay-conflict")).toEqual(want.occupying);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("2,000 interview clips with B-roll are analysed in well under a second", () => {
    const seq = randomCut(7, 2000);
    expect(Object.keys(seq.items).length).toBeGreaterThan(4000);
    analyzeCoverage(seq, "v"); // warm up
    const t0 = performance.now();
    const a = analyzeCoverage(seq, "v");
    const ms = performance.now() - t0;
    expect(a.cuts.length).toBeGreaterThan(1700); // some clips are disabled at random
    expect(ms).toBeLessThan(250); // was ~1.4 s on an Apple M3 before indexing
  });
});
