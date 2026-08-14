// EDL export: validation gate + CMX3600 generation. Logic was hand-verified against
// a plain-JS port during development (no Node project graph was available to run
// vitest directly in that environment) — this file is the real, checked-in vitest
// suite that `npm test` picks up.
import { describe, expect, it } from "vitest";
import { buildCmx3600Edl, edlFilename, validateTimelineForExport } from "@/lib/nle/edl";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

function makeClip(id: string, filename: string): Clip {
  return {
    id,
    filename,
    role: "interview",
    durationSeconds: 60,
    camera: "FX6",
    resolution: "4K",
    fps: 24,
    speakers: [],
    state: "analyzed",
    progress: 100,
    hasTranscript: true,
    visualEvidenceCount: 0,
    technicalIssues: [],
    thumbHue: 0,
  };
}

function makeTimeline(decisions: UniversalTimeline["decisions"]): UniversalTimeline {
  return {
    id: "tl-test",
    name: "Test 60s emotional cut",
    fps: 24,
    targetSeconds: 60,
    totalSeconds: decisions.reduce((a, d) => Math.max(a, d.timelineStartSeconds + d.durationSeconds), 0),
    decisions,
  };
}

describe("validateTimelineForExport", () => {
  const clips = [makeClip("clip-001", "A001_INT_MARISOL_01.mov"), makeClip("clip-004", "B101_BROLL_GARDEN.mov")];

  it("rejects an empty timeline", () => {
    const result = validateTimelineForExport(makeTimeline([]), clips);
    expect(result.ok).toBe(false);
    expect(result.usable).toHaveLength(0);
  });

  it("accepts a well-formed timeline", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "cold open",
        sourceInTc: "00:04:12:06",
        sourceOutTc: "00:04:31:18",
        timelineStartSeconds: 0,
        durationSeconds: 19.5,
      },
    ]);
    const result = validateTimelineForExport(timeline, clips);
    expect(result.ok).toBe(true);
    expect(result.usable).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("drops decisions referencing an unknown clip, keeps the valid ones", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "real",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 0,
        durationSeconds: 4,
      },
      {
        id: "e2",
        lane: "interview",
        clipId: "clip-999",
        label: "ghost",
        sourceInTc: "00:00:00:00",
        sourceOutTc: "00:00:01:00",
        timelineStartSeconds: 4,
        durationSeconds: 1,
      },
    ]);
    const result = validateTimelineForExport(timeline, clips);
    expect(result.ok).toBe(true);
    expect(result.usable).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("clip-999");
  });

  it("rejects malformed timecodes and zero-duration events", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "bad tc",
        sourceInTc: "not-a-timecode",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 0,
        durationSeconds: 4,
      },
      {
        id: "e2",
        lane: "interview",
        clipId: "clip-001",
        label: "zero dur",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 4,
        durationSeconds: 0,
      },
    ]);
    const result = validateTimelineForExport(timeline, clips);
    expect(result.ok).toBe(false);
    expect(result.usable).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
  });
});

describe("buildCmx3600Edl", () => {
  const clips = [makeClip("clip-001", "A001_INT_MARISOL_01.mov"), makeClip("clip-004", "B101_BROLL_GARDEN.mov")];

  it("produces a well-formed CMX3600 header and one event block per decision", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "cold open",
        sourceInTc: "00:04:12:06",
        sourceOutTc: "00:04:31:18",
        timelineStartSeconds: 0,
        durationSeconds: 19.5,
      },
      {
        id: "e2",
        lane: "b-roll",
        clipId: "clip-004",
        label: "garden sunrise",
        sourceInTc: "00:00:14:00",
        sourceOutTc: "00:00:22:00",
        timelineStartSeconds: 19.5,
        durationSeconds: 8,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const edl = buildCmx3600Edl(timeline, usable, clips);

    expect(edl).toContain("TITLE: Test 60s emotional cut");
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001");
    expect(edl).toContain("002");
    expect(edl).toContain("00:04:12:06 00:04:31:18");
    expect(edl).toContain("* FROM CLIP NAME: A001_INT_MARISOL_01.mov");
    expect(edl).toContain("* FROM CLIP NAME: B101_BROLL_GARDEN.mov");
    // Record-side timecodes must be contiguous, derived from timeline position.
    expect(edl).toContain("00:00:00:00 00:00:19:12"); // 19.5s @ 24fps = 19:12
  });

  it("orders events by timeline position regardless of input order", () => {
    const timeline = makeTimeline([
      {
        id: "second",
        lane: "interview",
        clipId: "clip-001",
        label: "second",
        sourceInTc: "00:00:10:00",
        sourceOutTc: "00:00:15:00",
        timelineStartSeconds: 5,
        durationSeconds: 5,
      },
      {
        id: "first",
        lane: "interview",
        clipId: "clip-001",
        label: "first",
        sourceInTc: "00:00:00:00",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 0,
        durationSeconds: 5,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const edl = buildCmx3600Edl(timeline, usable, clips);
    expect(edl.indexOf("* first")).toBeLessThan(edl.indexOf("* second"));
  });
});

describe("edlFilename", () => {
  it("slugifies the timeline name and appends .edl", () => {
    expect(edlFilename(makeTimeline([]))).toBe("test-60s-emotional-cut.edl");
  });
});
