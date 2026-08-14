// FCPXML export: single gap-filled spine, deduplicated resources, overlap
// detection. See the file-level comment in src/lib/nle/fcpxml.ts for the
// deliberate scope limits (no connected-clip lane anchoring).
import { describe, expect, it } from "vitest";
import { buildFcpxml, fcpxmlFilename } from "@/lib/nle/fcpxml";
import { validateTimelineForExport } from "@/lib/nle/edl";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

function makeClip(id: string, filename: string, relPath?: string, durationSeconds = 60): Clip {
  return {
    id,
    filename,
    ...(relPath ? { relPath } : {}),
    role: "interview",
    durationSeconds,
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

describe("buildFcpxml", () => {
  const clips = [
    makeClip("clip-001", "A001_INT_MARISOL_01.mov", "A001_INT_MARISOL_01.mov"),
    makeClip("clip-004", "B101_BROLL_GARDEN.mov", "broll/B101_BROLL_GARDEN.mov"),
  ];

  it("produces a well-formed spine with one asset-clip per decision, back to back", () => {
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
      {
        id: "e2",
        lane: "b-roll",
        clipId: "clip-004",
        label: "garden sunrise",
        sourceInTc: "00:00:14:00",
        sourceOutTc: "00:00:22:00",
        timelineStartSeconds: 4,
        durationSeconds: 8,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml, warnings } = buildFcpxml(timeline, usable, clips, MEDIA_ROOT);

    expect(xml).toContain("<!DOCTYPE fcpxml>");
    expect((xml.match(/<asset-clip/g) ?? []).length).toBe(2);
    expect(xml).not.toContain("<gap "); // back-to-back, no gap needed
    expect(xml).toContain(`file:///Users/editor/Footage/community-doc/A001_INT_MARISOL_01.mov`);
    expect(warnings).toEqual([]);
  });

  it("fills a real timing gap with an explicit <gap> element", () => {
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
      {
        id: "e2",
        lane: "interview",
        clipId: "clip-001",
        label: "second beat",
        sourceInTc: "00:00:10:00",
        sourceOutTc: "00:00:12:00",
        timelineStartSeconds: 10, // 6s gap after the first event ends at t=4
        durationSeconds: 2,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml } = buildFcpxml(timeline, usable, clips, MEDIA_ROOT);
    expect(xml).toContain('<gap name="Gap" offset="96/24s" duration="144/24s"/>'); // 4s->10s gap = 6s = 144 frames
  });

  it("drops an overlapping decision with a warning instead of guessing at lane placement", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "first",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:06:00",
        timelineStartSeconds: 0,
        durationSeconds: 5,
      },
      {
        id: "e2",
        lane: "b-roll",
        clipId: "clip-004",
        label: "overlapping cutaway",
        sourceInTc: "00:00:00:00",
        sourceOutTc: "00:00:02:00",
        timelineStartSeconds: 2, // starts inside the first event's [0,5) span
        durationSeconds: 2,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml, warnings } = buildFcpxml(timeline, usable, clips, MEDIA_ROOT);
    expect((xml.match(/<asset-clip/g) ?? []).length).toBe(1);
    expect(warnings.some((w) => w.includes("overlaps the previous spine item"))).toBe(true);
  });

  it("declares each source asset only once even when reused across decisions", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "interview",
        clipId: "clip-001",
        label: "first",
        sourceInTc: "00:00:01:00",
        sourceOutTc: "00:00:03:00",
        timelineStartSeconds: 0,
        durationSeconds: 2,
      },
      {
        id: "e2",
        lane: "interview",
        clipId: "clip-001",
        label: "second, same source clip",
        sourceInTc: "00:00:05:00",
        sourceOutTc: "00:00:07:00",
        timelineStartSeconds: 2,
        durationSeconds: 2,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, [clips[0]!]);
    const { xml } = buildFcpxml(timeline, usable, [clips[0]!], MEDIA_ROOT);
    expect((xml.match(/<asset /g) ?? []).length).toBe(1);
    expect((xml.match(/<asset-clip/g) ?? []).length).toBe(2);
  });

  it("skips audio-lane decisions with a warning rather than misplacing them on the spine", () => {
    const timeline = makeTimeline([
      {
        id: "e1",
        lane: "audio",
        clipId: "clip-001",
        label: "ambient bed",
        sourceInTc: "00:00:00:00",
        sourceOutTc: "00:00:10:00",
        timelineStartSeconds: 0,
        durationSeconds: 10,
      },
    ]);
    const { usable } = validateTimelineForExport(timeline, clips);
    const { xml, warnings } = buildFcpxml(timeline, usable, clips, MEDIA_ROOT);
    expect(xml).not.toContain("<asset-clip");
    expect(warnings.some((w) => w.includes("audio-lane"))).toBe(true);
  });
});

describe("fcpxmlFilename", () => {
  it("slugifies the timeline name and appends .fcpxml", () => {
    expect(fcpxmlFilename(makeTimeline([]))).toBe("test-60s-emotional-cut.fcpxml");
  });
});
