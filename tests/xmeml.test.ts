// XMEML export: per-lane real tracks, frame-accurate positions. Mirrors
// tests/edl.test.ts's fixture shape so the same timeline can be sanity-checked
// against both exporters.
import { describe, expect, it } from "vitest";
import { buildXmeml, xmemlFilename } from "@/lib/nle/xmeml";
import { validateTimelineForExport } from "@/lib/nle/edl";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

function makeClip(id: string, filename: string, relPath?: string): Clip {
  return {
    id,
    filename,
    ...(relPath ? { relPath } : {}),
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

const MEDIA_ROOT = "/Users/editor/Footage/community-doc";

describe("buildXmeml", () => {
  const clips = [
    makeClip("clip-001", "A001_INT_MARISOL_01.mov", "A001_INT_MARISOL_01.mov"),
    makeClip("clip-004", "B101_BROLL_GARDEN.mov", "broll/B101_BROLL_GARDEN.mov"),
  ];

  it("places interview and b-roll on separate real tracks", () => {
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
        timelineStartSeconds: 0,
        durationSeconds: 8,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml, warnings } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);

    expect(xml).toContain("<!DOCTYPE xmeml>");
    expect(xml).toContain('<xmeml version="5">');
    // <track> only ever appears for a top-level V1/V2/A1 track — never inside a
    // clipitem's own nested <file><media><video> block — so a document-wide
    // count is unambiguous (no need to slice out a "video section" first, which
    // would break on the first nested </video> closing tag).
    expect((xml.match(/<track>/g) ?? []).length).toBe(2);
    expect(xml).toContain("A001_INT_MARISOL_01.mov");
    expect(xml).toContain("B101_BROLL_GARDEN.mov");
    expect(xml).toContain(`file:///Users/editor/Footage/community-doc/A001_INT_MARISOL_01.mov`);
    expect(xml).toContain(`file:///Users/editor/Footage/community-doc/broll/B101_BROLL_GARDEN.mov`);
    expect(warnings).toEqual([]);
  });

  it("computes frame-accurate in/out/duration from source timecodes", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "one second at 24fps",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:02:00",
        timelineStartSeconds: 0,
        durationSeconds: 1,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
    // 1s @ 24fps = 24 frames in, 48 frames out, 24 frames duration.
    expect(xml).toContain("<in>24</in>");
    expect(xml).toContain("<out>48</out>");
    expect(xml).toMatch(/<duration>24<\/duration>/);
  });

  it("warns instead of fabricating a path when relPath is missing", () => {
    const noPathClip = makeClip("clip-001", "A001_INT_MARISOL_01.mov"); // no relPath
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "cold open",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 0,
        durationSeconds: 4,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, [noPathClip]);
    const { warnings } = buildXmeml(timeline, usable, [noPathClip], MEDIA_ROOT);
    expect(warnings.some((w) => w.includes("Could not resolve an absolute path"))).toBe(true);
  });

  it("omits an empty audio track when there are no audio-lane decisions", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "cold open",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:05:00",
        timelineStartSeconds: 0,
        durationSeconds: 4,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
    expect(xml).not.toContain("<audio>");
  });
});

describe("xmemlFilename", () => {
  it("slugifies the timeline name and appends .xml", () => {
    expect(xmemlFilename(makeTimeline([]))).toBe("test-60s-emotional-cut.xml");
  });
});
