// Phase 7, Milestone 1 — additional PlaceEdit regression coverage: the
// source → sequence frame rule at every app rate, history limits, atomic
// failure, and export compatibility (Premiere XML, EDL; FCPXML's existing
// B-roll omission is reported, not silent).
import { describe, expect, it } from "vitest";
import type { UniversalTimeline } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import { commands } from "@/lib/timeline/commands";
import { commit, createHistory, undo } from "@/lib/timeline/history";
import { seededIds, type IdGenerator } from "@/lib/timeline/ids";
import { findViolations, type MediaInventory } from "@/lib/timeline/invariants";
import { legacyToSequence } from "@/lib/timeline/legacy-adapter";
import { frameToTc, rateFromFps, sequenceDurationFrames } from "@/lib/timeline/time";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { Command, Sequence } from "@/lib/timeline/types";
import { derivedTimeline } from "@/lib/timeline/workspace";
import { deepFreeze, directorSequence, media, mediaOf, track } from "./engine-helpers";
import { clip, projectClips } from "./legacy-fixtures";

const added = (a: Sequence, b: Sequence) => Object.keys(b.items).filter((id) => !a.items[id]);
const cmdFor = (
  ids: IdGenerator,
  seq: Sequence,
  p: { mediaClipId: string; fps: number; inF: number; outF: number; start: number; label?: string },
) =>
  commands.place(ids, {
    trackId: track(seq, "V2").id,
    mediaClipId: p.mediaClipId,
    mediaRate: rateFromFps(p.fps),
    sourceInFrame: p.inF,
    sourceOutFrame: p.outF,
    startFrame: p.start,
    label: p.label ?? "B-roll",
  }) as unknown as Command;
function apply(seq: Sequence, cmds: (ids: IdGenerator) => Command[], m: MediaInventory = media) {
  const ids = seededIds("reg");
  return applyTransaction(seq, makeTransaction(ids, "Place", "director", cmds(ids), "t"), {
    media: m,
  });
}

describe("frame accuracy at every app rate (sequence × media)", () => {
  const RATES = [23.976, 24, 25, 29.97, 30];
  it.each(RATES.flatMap((s) => RATES.map((m) => [s, m] as const)))(
    "sequence %s fps, media %s fps",
    (seqFps, mediaFps) => {
      const interview = clip("c-int", seqFps, 60);
      const broll = clip("c-broll", mediaFps, 20);
      const tl: UniversalTimeline = {
        id: "tl",
        name: "rates",
        fps: seqFps,
        targetSeconds: 10,
        totalSeconds: 10,
        decisions: [
          {
            id: "d1",
            lane: "interview",
            clipId: "c-int",
            label: "one",
            sourceInTc: "00:00:10:00",
            sourceOutTc: "00:00:20:00",
            timelineStartSeconds: 0,
            durationSeconds: 10,
          },
        ],
      };
      const seq = deepFreeze(legacyToSequence(tl, [interview, broll], { scope: "rates" }));
      const m = mediaOf([interview, broll]);
      const nominal = Math.round(mediaFps); // one second of source timecode
      const out = apply(
        seq,
        (ids) => [
          cmdFor(ids, seq, {
            mediaClipId: "c-broll",
            fps: mediaFps,
            inF: nominal,
            outF: 3 * nominal,
            start: Math.round(seqFps),
          }),
        ],
        m,
      );
      if (!out.ok) throw new Error(out.error.message);
      const it = out.sequence.items[added(seq, out.sequence)[0]!]!;
      expect(Number.isInteger(it.durationFrames)).toBe(true);
      expect(it.durationFrames).toBe(
        sequenceDurationFrames(nominal, 3 * nominal, rateFromFps(mediaFps), seq.rate),
      );
      expect(it.durationFrames).toBe(2 * Math.round(seqFps)); // 2 s of source = 2 s of timeline
      expect(findViolations(out.sequence, { media: m })).toEqual([]);
      const d = derivedTimeline(out.sequence).decisions.find((x) => x.clipId === "c-broll")!;
      expect([d.lane, d.sourceInTc, d.sourceOutTc]).toEqual([
        "b-roll",
        frameToTc(nominal, rateFromFps(mediaFps)),
        frameToTc(3 * nominal, rateFromFps(mediaFps)),
      ]);
    },
  );
});

describe("history and atomicity", () => {
  it("history limits still apply: only the last N placements can be undone", () => {
    let h = createHistory(directorSequence(), 3);
    const ids = seededIds("cap");
    for (let n = 0; n < 5; n += 1) {
      const c = commit(
        h,
        makeTransaction(ids, `Place ${n}`, "director", [
          cmdFor(ids, h.present, {
            mediaClipId: "clip-005",
            fps: 23.976,
            inF: 0,
            outF: 24,
            start: n * 30,
          }),
        ]),
        { media },
      );
      if (!c.ok) throw new Error(c.error.message);
      h = c.history;
    }
    expect(h.past).toHaveLength(3);
    for (let n = 0; n < 3; n += 1) h = undo(h);
    expect(h.past).toHaveLength(0);
    expect(added(directorSequence(), h.present)).toHaveLength(2); // the two beyond the limit stay
  });

  it("a failed placement rejects its whole transaction; the input is untouched", () => {
    const seq = directorSequence();
    const before = JSON.stringify(seq);
    const out = apply(seq, (ids) => [
      cmdFor(ids, seq, { mediaClipId: "clip-005", fps: 23.976, inF: 0, outF: 48, start: 0 }),
      cmdFor(ids, seq, { mediaClipId: "clip-005", fps: 23.976, inF: 0, outF: 48, start: 24 }), // overlaps the first
    ]);
    expect(out.ok ? null : out.error.code).toBe("overlap");
    expect(JSON.stringify(seq)).toBe(before);
  });
});

describe("export compatibility", () => {
  it("Premiere XML and EDL carry the placement; untouched clips export exactly as before; FCPXML reports its existing omission", () => {
    const seq = directorSequence();
    const out = apply(seq, (ids) => [
      cmdFor(ids, seq, {
        mediaClipId: "clip-005",
        fps: 23.976,
        inF: 24,
        outF: 84,
        start: 216,
        label: "Park sign",
      }),
    ]);
    if (!out.ok) throw new Error(out.error.message);
    const before = derivedTimeline(seq);
    const after = derivedTimeline(out.sequence);
    expect(after.decisions).toHaveLength(before.decisions.length + 1);
    for (const d of before.decisions)
      expect(
        after.decisions.find((x) => x.id === d.id),
        d.id,
      ).toStrictEqual(d);
    const placed = after.decisions.find((d) => !before.decisions.some((b) => b.id === d.id))!;
    expect(placed).toMatchObject({
      lane: "b-roll",
      clipId: "clip-005",
      label: "Park sign",
      sourceInTc: frameToTc(24, rateFromFps(23.976)),
      sourceOutTc: frameToTc(84, rateFromFps(23.976)),
      timelineStartSeconds: 216 / 24,
      durationSeconds: 60 / 24,
    });
    const usableOf = (tl: UniversalTimeline) => validateTimelineForExport(tl, projectClips).usable;
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    // Premiere XML: one more clip item, the media referenced.
    const xml = buildXmeml(after, usableOf(after), projectClips, "/Media").xml;
    const xmlBefore = buildXmeml(before, usableOf(before), projectClips, "/Media").xml;
    expect(count(xml, "<clipitem")).toBe(count(xmlBefore, "<clipitem") + 1);
    expect(xml).toContain("CLIP-005.MP4");
    // EDL: one more event, with the exact source timecodes.
    const edl = buildCmx3600Edl(after, usableOf(after), projectClips);
    expect(edl).toContain(`${placed.sourceInTc} ${placed.sourceOutTc}`);
    expect(count(edl, "* FROM CLIP NAME:")).toBe(
      count(buildCmx3600Edl(before, usableOf(before), projectClips), "* FROM CLIP NAME:") + 1,
    );
    // FCPXML: the existing exporter builds only the primary storyline and
    // leaves out clips that overlap it (all B-roll, the existing cutaways too)
    // with a warning. The placement is reported, not silently dropped, and
    // everything else exports exactly as before.
    const fcp = buildFcpxml(after, usableOf(after), projectClips, "/Media");
    const fcpBefore = buildFcpxml(before, usableOf(before), projectClips, "/Media");
    expect(fcp.xml).toBe(fcpBefore.xml);
    expect(fcp.warnings.join(" ")).toContain(`"Park sign" overlaps the previous spine item`);
    expect(fcp.warnings).toHaveLength(fcpBefore.warnings.length + 1);
    // Round trip: re-importing the exported timeline gives the same placement.
    const back = legacyToSequence(after, projectClips, { scope: "rt" });
    const again = Object.values(back.items).find((i) => i.mediaClipId === "clip-005")!;
    expect([
      again.startFrame,
      again.durationFrames,
      again.sourceInFrame,
      again.sourceOutFrame,
    ]).toEqual([216, 60, 24, 84]);
  });
});
