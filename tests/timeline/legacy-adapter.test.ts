// Legacy adapter gates (src/lib/timeline/legacy-adapter.ts):
//   1. every schema-1 cut survives legacy → Sequence → legacy unchanged;
//   2. XMEML, EDL and FCPXML of an unedited cut are byte-identical to beta.1;
//   3. the canonical model built on import is well-formed and deterministic.
// Optional: set AE_EDIT_STATE_FILES (comma-separated saved edit-state JSON
// files) and AE_ANALYSIS_FILE to replay real saved cuts through the same gates.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import {
  isUneditedLegacyItem,
  legacyToSequence,
  sequenceToLegacy,
} from "@/lib/timeline/legacy-adapter";
import {
  frameToTc,
  framesToSeconds,
  rateFromFps,
  rescaleFrames,
  sequenceDurationFrames,
  tcToFrame,
} from "@/lib/timeline/time";
import type { Sequence } from "@/lib/timeline/types";
import { cases, clip, directorCut, projectClips, refinedCut } from "./legacy-fixtures";

const MEDIA_ROOT = "/Users/editor/Footage";

function exportsOf(timeline: UniversalTimeline, clips: Clip[]) {
  const { usable, errors } = validateTimelineForExport(timeline, clips);
  if (usable.length === 0)
    return { errors, edl: "", xmeml: "", xmemlWarnings: [], fcpxml: "", fcpxmlWarnings: [] };
  const x = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
  const f = buildFcpxml(timeline, usable, clips, MEDIA_ROOT);
  return {
    errors,
    edl: buildCmx3600Edl(timeline, usable, clips),
    xmeml: x.xml,
    xmemlWarnings: x.warnings,
    fcpxml: f.xml,
    fcpxmlWarnings: f.warnings,
  };
}

function roundTrip(timeline: UniversalTimeline, clips: Clip[], scope = "v1") {
  const seq = legacyToSequence(timeline, clips, { scope });
  return { seq, ...sequenceToLegacy(seq) };
}

describe.each(cases)("$name", ({ timeline, clips }) => {
  it("round-trips legacy → Sequence → legacy exactly (deep, strict equality)", () => {
    const { timeline: back, warnings } = roundTrip(timeline, clips);
    expect(back).toStrictEqual(timeline);
    expect(warnings).toEqual([]);
  });

  it("exports byte-identical XMEML, EDL and FCPXML when unedited", () => {
    const before = exportsOf(timeline, clips);
    const after = exportsOf(roundTrip(timeline, clips).timeline, clips);
    expect(after.errors).toEqual(before.errors);
    expect(after.xmeml).toBe(before.xmeml);
    expect(after.edl).toBe(before.edl);
    expect(after.fcpxml).toBe(before.fcpxml);
    expect(after.xmemlWarnings).toEqual(before.xmemlWarnings);
    expect(after.fcpxmlWarnings).toEqual(before.fcpxmlWarnings);
  });

  it("imports deterministically (same cut → same ids, every time)", () => {
    expect(legacyToSequence(timeline, clips, { scope: "v1" })).toStrictEqual(
      legacyToSequence(timeline, clips, { scope: "v1" }),
    );
    const other = legacyToSequence(timeline, clips, { scope: "v2" });
    expect(other.id).not.toBe(legacyToSequence(timeline, clips, { scope: "v1" }).id);
  });

  it("builds a well-formed canonical model", () => {
    const seq = legacyToSequence(timeline, clips, { scope: "v1" });
    expect(seq.schema).toBe(2);
    expect(seq.tracks.map((t) => t.name)).toEqual(["V1", "V2", "A1", "A2"]);
    const ids = new Set([
      seq.id,
      ...seq.tracks.map((t) => t.id),
      ...Object.keys(seq.items),
      ...Object.keys(seq.links),
    ]);
    expect(ids.size).toBe(
      1 + seq.tracks.length + Object.keys(seq.items).length + Object.keys(seq.links).length,
    );
    const v1 = seq.tracks.find((t) => t.name === "V1")!.id;
    const a1 = seq.tracks.find((t) => t.name === "A1")!.id;
    const pictures = Object.values(seq.items).filter((i) => i.trackId === v1);
    const sound = Object.values(seq.items).filter((i) => i.trackId === a1);
    expect(sound).toHaveLength(pictures.length); // every V1 item has its A1
    for (const item of Object.values(seq.items)) {
      for (const k of [
        "startFrame",
        "durationFrames",
        "sourceInFrame",
        "sourceOutFrame",
      ] as const) {
        expect(Number.isInteger(item[k])).toBe(true);
        expect(item[k]).toBeGreaterThanOrEqual(0);
      }
      expect(item.durationFrames).toBeGreaterThanOrEqual(1);
      expect(item.origin).toBe("director");
      expect(item.protection).toEqual({ locked: false, aiLocked: false });
      expect(Object.keys(item).sort()).not.toContain("durationSeconds"); // nothing redundant stored
    }
    for (const pic of pictures) {
      const link = seq.links[pic.linkGroupId!]!;
      const partner = seq.items[link.itemIds.find((id) => id !== pic.id)!]!;
      expect(partner.trackId).toBe(a1);
      expect([
        partner.startFrame,
        partner.durationFrames,
        partner.sourceInFrame,
        partner.sourceOutFrame,
      ]).toEqual([pic.startFrame, pic.durationFrames, pic.sourceInFrame, pic.sourceOutFrame]);
      expect(partner.legacy).toBeUndefined();
    }
  });
});

describe("canonical frames match what the exporters compute", () => {
  it("source frames are the XMEML exporter's in/out frames; positions its start frames", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const xml = exportsOf(directorCut, projectClips).xmeml;
    const v1 = seq.tracks.find((t) => t.name === "V1")!.id;
    for (const item of Object.values(seq.items).filter((i) => i.trackId === v1)) {
      expect(xml).toContain(`<in>${item.sourceInFrame}</in>`);
      expect(xml).toContain(`<out>${item.sourceOutFrame}</out>`);
      expect(xml).toContain(`<start>${item.startFrame}</start>`);
    }
  });

  it("uses each clip's own rate for source frames and the sequence rate for positions", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const first = Object.values(seq.items).find((i) => i.legacy?.decision.id === "event-1")!;
    expect(first.mediaRate).toEqual(rateFromFps(23.976));
    expect(seq.rate).toEqual(rateFromFps(24));
    expect(first.sourceInFrame).toBe(tcToFrame("00:01:02:00", rateFromFps(23.976)));
    // Two time domains: "00:01:02:00"–"00:01:12:00" is 239 source frames of
    // 23.976 media and 240 frames of the 24 fps sequence — exactly what beta.1
    // exported.
    expect(first.sourceOutFrame - first.sourceInFrame).toBe(239);
    expect(first.durationFrames).toBe(240);
    expect(exportsOf(directorCut, projectClips).xmeml).toMatch(
      /<start>0<\/start>\s*<end>240<\/end>/,
    );
  });
});

describe("an edited item converts from its frames, not its provenance", () => {
  function moved(seq: Sequence, decisionId: string, frames: number): Sequence {
    const next = structuredClone(seq);
    const item = Object.values(next.items).find((i) => i.legacy?.decision.id === decisionId)!;
    item.startFrame += frames;
    if (item.linkGroupId) {
      for (const id of next.links[item.linkGroupId]!.itemIds)
        if (id !== item.id) next.items[id]!.startFrame += frames;
    }
    return next;
  }

  it("only the changed item is regenerated; its timecodes re-read to the same frames", () => {
    const seq = legacyToSequence(refinedCut, projectClips);
    const edited = moved(seq, "event-4", 12);
    const item = Object.values(edited.items).find((i) => i.legacy?.decision.id === "event-4")!;
    expect(isUneditedLegacyItem(item)).toBe(false);
    const { timeline, warnings } = sequenceToLegacy(edited);
    expect(warnings).toEqual([]);
    for (const dd of timeline.decisions) {
      const orig = refinedCut.decisions.find((o) => o.id === dd.id)!;
      if (dd.id !== "event-4") expect(dd).toStrictEqual(orig);
    }
    const out = timeline.decisions.find((x) => x.id === "event-4")!;
    expect(out.timelineStartSeconds).toBe(framesToSeconds(item.startFrame, edited.rate));
    expect(tcToFrame(out.sourceInTc, item.mediaRate)).toBe(item.sourceInFrame);
    expect(tcToFrame(out.sourceOutTc, item.mediaRate)).toBe(item.sourceOutFrame);
    expect(timeline.totalSeconds).not.toBeUndefined();
    // …and the export reflects the move, frame-exact, with A1 still on V1.
    const xml = exportsOf(timeline, projectClips).xmeml;
    expect(xml).toContain(`<start>${item.startFrame}</start>`);
  });

  it("an A1 item pulled out of line with its V1 picture is reported, not silently realigned", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const a1 = seq.tracks.find((t) => t.name === "A1")!.id;
    const audio = Object.values(seq.items).find((i) => i.trackId === a1)!;
    audio.startFrame += 6; // a J-cut schema 1 cannot express
    const { warnings } = sequenceToLegacy(seq);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not aligned with linked V1/);
  });
});

/* ----------- 24 fps sequences of 23.976 media (the 239/240 case) ----------- */

const R23 = rateFromFps(23.976);
const R24 = rateFromFps(24);

function itemsOn(seq: Sequence, track: string) {
  const id = seq.tracks.find((t) => t.name === track)!.id;
  return Object.values(seq.items)
    .filter((i) => i.trackId === id)
    .sort((a, b) => a.startFrame - b.startFrame);
}

/** Every timing number the XML exporters write, in order (names/labels excluded). */
function timingOf(timeline: UniversalTimeline, clips: Clip[]) {
  const e = exportsOf(timeline, clips);
  return {
    xmeml: [...e.xmeml.matchAll(/<(start|end|in|out)>(-?\d+)<\/\1>/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    fcpxml: [...e.fcpxml.matchAll(/\b(offset|start|duration)="([^"]+)"/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
  };
}

/** EDL events: [source in, source out, record in, record out] per event. */
function edlEvents(timeline: UniversalTimeline, clips: Clip[]) {
  const tc = "((?:\\d{2}:){3}\\d{2})";
  const re = new RegExp(`^\\d{3}\\s.*?${tc} ${tc} ${tc} ${tc}$`, "gm");
  return [...exportsOf(timeline, clips).edl.matchAll(re)].map((m) => [m[1]!, m[2]!, m[3]!, m[4]!]);
}

/**
 * The EDL of a regenerated cut: same source timecodes as beta.1, and record
 * in/out exactly at each item's sequence frames (so it agrees with XMEML).
 * Beta.1's EDL writer truncates off-frame float positions (secondsToTc floors)
 * where its XMEML writer rounds them, so for those it was a frame early; a
 * frame-exact cut no longer has off-frame positions.
 */
function expectFrameExactEdl(
  original: UniversalTimeline,
  regenerated: UniversalTimeline,
  seq: Sequence,
  clips: Clip[],
) {
  const before = edlEvents(original, clips);
  const after = edlEvents(regenerated, clips);
  expect(after.length).toBe(before.length);
  expect(after.map((e) => [e[0], e[1]])).toEqual(before.map((e) => [e[0], e[1]]));
  const a1 = new Set(seq.tracks.filter((t) => t.role === "dialogue-audio").map((t) => t.id));
  const spans = new Set(
    Object.values(seq.items)
      .filter((i) => !a1.has(i.trackId))
      .map(
        (i) =>
          `${frameToTc(i.startFrame, seq.rate)} ${frameToTc(i.startFrame + i.durationFrames, seq.rate)}`,
      ),
  );
  for (const e of after) expect(spans.has(`${e[2]} ${e[3]}`), `${e[2]}–${e[3]}`).toBe(true);
}

/** Breaks provenance on every item without touching any frame (relabels it). */
function relabelAll(seq: Sequence): Sequence {
  const next = structuredClone(seq);
  for (const item of Object.values(next.items)) item.label = `${item.label} (edited)`;
  return next;
}

/** A source trim: source frames change; the sequence length follows the rule. */
function trimOut(seq: Sequence, decisionId: string, sourceFrames: number): Sequence {
  const next = structuredClone(seq);
  const pic = Object.values(next.items).find((i) => i.legacy?.decision.id === decisionId)!;
  const group = pic.linkGroupId ? next.links[pic.linkGroupId]!.itemIds : [pic.id];
  for (const id of group) {
    const it = next.items[id]!;
    it.sourceOutFrame += sourceFrames;
    it.durationFrames = sequenceDurationFrames(
      it.sourceInFrame,
      it.sourceOutFrame,
      it.mediaRate,
      next.rate,
    );
  }
  return next;
}

describe("24 fps sequence with 23.976 media", () => {
  it("imports each item's sequence length exactly as beta.1 placed it (240, not 239)", () => {
    for (const cut of [directorCut, refinedCut]) {
      const seq = legacyToSequence(cut, projectClips);
      const xml = exportsOf(cut, projectClips).xmeml;
      for (const item of itemsOn(seq, "V1")) {
        expect(xml).toMatch(
          new RegExp(
            `<start>${item.startFrame}</start>\\s*<end>${item.startFrame + item.durationFrames}</end>`,
          ),
        );
      }
    }
  });

  it("the one conversion rule reproduces those lengths for every Director-built item", () => {
    for (const cut of [directorCut, refinedCut]) {
      const seq = legacyToSequence(cut, projectClips);
      for (const item of Object.values(seq.items)) {
        expect(
          sequenceDurationFrames(item.sourceInFrame, item.sourceOutFrame, item.mediaRate, seq.rate),
          item.legacy?.decision.id ?? item.label,
        ).toBe(item.durationFrames);
      }
    }
    // …whereas rescaling the frame count is what produced the one-frame gap.
    expect(sequenceDurationFrames(1487, 1726, R23, R24)).toBe(240);
    expect(rescaleFrames(1726 - 1487, R23, R24)).toBe(239);
  });

  it("is deterministic, never below one frame, and the identity on one clock", () => {
    expect(sequenceDurationFrames(1487, 1726, R23, R24)).toBe(
      sequenceDurationFrames(1487, 1726, R23, R24),
    );
    expect(sequenceDurationFrames(500, 500, R23, R24)).toBe(1);
    for (let n = 1; n < 400; n += 7)
      expect(sequenceDurationFrames(1000, 1000 + n, R24, R24)).toBe(n);
  });

  it("an edited item cannot open a 239/240 gap just because it lost its provenance", () => {
    for (const cut of [directorCut, refinedCut]) {
      const seq = legacyToSequence(cut, projectClips);
      const edited = relabelAll(seq);
      expect(Object.values(edited.items).some(isUneditedLegacyItem)).toBe(false); // all regenerated
      const { timeline, warnings } = sequenceToLegacy(edited);
      expect(warnings).toEqual([]);
      expect(timeline.fps).toBe(24);
      expect(edited.rate).toEqual(R24);
      // Every timing number in both XML exports is unchanged: no gap, no overlap.
      expect(timingOf(timeline, projectClips)).toEqual(timingOf(cut, projectClips));
      expectFrameExactEdl(cut, timeline, edited, projectClips);
    }
  });

  it("a contiguous V1 stays contiguous after its items are regenerated", () => {
    const seq = relabelAll(legacyToSequence(directorCut, projectClips));
    const xml = exportsOf(sequenceToLegacy(seq).timeline, projectClips).xmeml;
    const v1 = xml.split("<track>")[1]!; // first video track = V1
    const spans = [...v1.matchAll(/<start>(\d+)<\/start>\s*<end>(\d+)<\/end>/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(spans.length).toBe(5);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]![0]).toBe(spans[i - 1]![1]);
  });

  it("moving an item changes its start frame only (length stays 240)", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const next = structuredClone(seq);
    for (const item of itemsOn(next, "V1").concat(itemsOn(next, "A1"))) {
      next.items[item.id]!.startFrame += 48;
    }
    const before = itemsOn(seq, "V1");
    const after = itemsOn(next, "V1");
    after.forEach((it, i) => {
      expect(it.startFrame).toBe(before[i]!.startFrame + 48);
      expect([it.durationFrames, it.sourceInFrame, it.sourceOutFrame]).toEqual([
        before[i]!.durationFrames,
        before[i]!.sourceInFrame,
        before[i]!.sourceOutFrame,
      ]);
    });
    const xml = exportsOf(sequenceToLegacy(next).timeline, projectClips).xmeml;
    expect(xml).toMatch(/<start>48<\/start>\s*<end>288<\/end>/);
    expect(next.rate).toEqual(R24);
  });

  it("a one-frame source trim changes the sequence length by one frame, not two", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const shorter = trimOut(seq, "event-1", -1);
    const pic = Object.values(shorter.items).find((i) => i.legacy?.decision.id === "event-1")!;
    expect(pic.sourceOutFrame - pic.sourceInFrame).toBe(238);
    expect(pic.durationFrames).toBe(239); // rescaling the count would give 238
    expect(rescaleFrames(238, R23, R24)).toBe(238);
    const restored = trimOut(shorter, "event-1", +1);
    expect(
      Object.values(restored.items).find((i) => i.legacy?.decision.id === "event-1")!
        .durationFrames,
    ).toBe(240);
    // Source-domain trim, sequence-domain length; the rate itself never moves.
    expect(restored.rate).toEqual(R24);
    const back = sequenceToLegacy(restored);
    expect(back.timeline.fps).toBe(24);
    expect(back.warnings).toEqual([]);
    // Trimmed back to its imported range, the item is unedited again: verbatim.
    expect(back.timeline).toStrictEqual(directorCut);
  });

  it("exports an edited 240-frame item at 240 sequence frames in every format", () => {
    const seq = legacyToSequence(directorCut, projectClips);
    const shorter = trimOut(trimOut(seq, "event-1", -1), "event-1", +1); // same range, lost nothing
    const edited = structuredClone(shorter);
    const pic = Object.values(edited.items).find((i) => i.legacy?.decision.id === "event-1")!;
    pic.label = "relabelled"; // provenance broken for real
    const { timeline } = sequenceToLegacy(edited);
    const e = exportsOf(timeline, projectClips);
    expect(e.xmeml).toMatch(/<start>0<\/start>\s*<end>240<\/end>/);
    expect(e.edl).toContain("00:00:00:00 00:00:10:00"); // record in/out of event 1
    expect(timingOf(timeline, projectClips)).toEqual(timingOf(directorCut, projectClips));
    // Only event 1 was regenerated; every other item is still verbatim beta.1.
    expect(edlEvents(timeline, projectClips)).toEqual(edlEvents(directorCut, projectClips));
  });
});

/* ------------- optional: replay real saved cuts (not committed data) ------------- */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(stateFiles.length === 0 || !analysisFile || !existsSync(analysisFile))(
  "real saved cuts",
  () => {
    it("every saved version round-trips and exports byte-identically", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map(
        (c: { id: string; fps: number; duration_seconds: number; rel_path?: string }) =>
          clip(c.id, c.fps, c.duration_seconds, c.rel_path ? { relPath: c.rel_path } : {}),
      );
      let checked = 0;
      for (const file of stateFiles) {
        const state = JSON.parse(readFileSync(file, "utf8"));
        for (const version of state.versions) {
          const { timeline: back, warnings } = roundTrip(version.timeline, clips, version.id);
          expect(back, `${file} ${version.id}`).toStrictEqual(version.timeline);
          expect(warnings).toEqual([]);
          // The one conversion rule agrees with every Director-built length.
          const seq = legacyToSequence(version.timeline, clips, { scope: version.id });
          for (const item of Object.values(seq.items)) {
            expect(
              sequenceDurationFrames(
                item.sourceInFrame,
                item.sourceOutFrame,
                item.mediaRate,
                seq.rate,
              ),
              `${version.id} ${item.label}`,
            ).toBe(item.durationFrames);
          }
          // Breaking provenance without moving a frame leaves every timing intact.
          const relabelled = relabelAll(seq);
          const regenerated = sequenceToLegacy(relabelled).timeline;
          expect(timingOf(regenerated, clips)).toEqual(timingOf(version.timeline, clips));
          expectFrameExactEdl(version.timeline, regenerated, relabelled, clips);
          const a = exportsOf(version.timeline, clips);
          const b = exportsOf(back, clips);
          expect([b.xmeml, b.edl, b.fcpxml]).toEqual([a.xmeml, a.edl, a.fcpxml]);
          checked += 1;
        }
      }
      console.info(`real saved cuts checked: ${checked}`);
      expect(checked).toBeGreaterThan(0);
    });
  },
);
