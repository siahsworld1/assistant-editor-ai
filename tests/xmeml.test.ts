// XMEML export: per-lane real tracks, frame-accurate positions. Mirrors
// tests/edl.test.ts's fixture shape so the same timeline can be sanity-checked
// against both exporters.
import { describe, expect, it } from "vitest";
import { buildXmeml, xmemlFilename } from "@/lib/nle/xmeml";
import { validateTimelineForExport } from "@/lib/nle/edl";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

function makeClip(id: string, filename: string, relPath?: string, fps = 24): Clip {
  return {
    id,
    filename,
    ...(relPath ? { relPath } : {}),
    role: "interview",
    durationSeconds: 60,
    camera: "FX6",
    resolution: "4K",
    fps,
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
    // would break on the first nested </video> closing tag). V1 (interview),
    // V2 (b-roll), A1 (interview's own synced audio) = 3.
    expect((xml.match(/<track>/g) ?? []).length).toBe(3);
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

  it("omits an empty audio track when there is nothing that needs one (b-roll only)", () => {
    // No interview lane (which now always carries its own synced audio — see
    // below) and no standalone "audio"-lane decisions: b-roll alone still
    // produces a picture-only sequence, so <audio> must stay absent rather
    // than emitting an empty/meaningless section.
    const timeline = makeTimeline([
      {
        id: "e1",
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
    const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
    expect(xml).not.toContain("<audio>");
  });

  // Real Premiere Pro import test (first real end-to-end run, real H.265
  // footage): Premiere reported six "Matrix cannot be inverted" errors (3
  // video events × 2 — sequence format + per-clip file media) and the
  // imported sequence had video on V1 with no matching audio on A1. Both
  // reproduced and fixed below.
  describe("real Premiere import fixes", () => {
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

    it("gives every video samplecharacteristics block a real, non-zero width and height", () => {
      // clip-001 is "4K" (a label, not literal pixel dimensions) and
      // clip-004 has no resolution set at all — both must still get a real,
      // parseable, non-zero frame geometry so Premiere's frame-to-sequence
      // transform matrix is never singular. This is the root cause of the
      // real "Matrix cannot be inverted" report: these fields were entirely
      // absent before this fix, for every video samplecharacteristics block
      // (sequence format + each clip's file media).
      const { usable } = validateTimelineForExport(timeline, clips);
      const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);

      const widths = [...xml.matchAll(/<width>(\d+)<\/width>/g)].map((m) => Number(m[1]));
      const heights = [...xml.matchAll(/<height>(\d+)<\/height>/g)].map((m) => Number(m[1]));
      // One <width>/<height> pair for the sequence format, one per video clip
      // (interview + b-roll) = 3 each.
      expect(widths.length).toBe(3);
      expect(heights.length).toBe(3);
      for (const w of widths) expect(w).toBeGreaterThan(0);
      for (const h of heights) expect(h).toBeGreaterThan(0);
      // A real, parseable resolution is used as-is: e.g. a real 3840x2160
      // clip would produce those exact values, never a silently-substituted
      // fallback — verified separately below.
    });

    it("uses a clip's real parsed resolution, not just the fallback, when it's available", () => {
      const realResClip = makeClip("clip-009", "A009_INT_REAL_4K.mov", "A009_INT_REAL_4K.mov");
      realResClip.resolution = "3840x2160";
      const tl = makeTimeline([
        {
          id: "e9",
          lane: "interview",
          clipId: "clip-009",
          label: "real 4k",
          sourceInTc: "00:00:01:00",
          sourceOutTc: "00:00:05:00",
          timelineStartSeconds: 0,
          durationSeconds: 4,
        },
      ]);
      const { usable } = validateTimelineForExport(tl, [realResClip]);
      const { xml } = buildXmeml(tl, usable, [realResClip], MEDIA_ROOT);
      expect(xml).toContain("<width>3840</width>");
      expect(xml).toContain("<height>2160</height>");
    });

    it("exports the interview lane's own production audio onto A1, linked to its V1 video", () => {
      const { usable } = validateTimelineForExport(timeline, clips);
      const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);

      expect(xml).toContain("<audio>");
      // Exactly one audio track (A1) — this timeline has no standalone
      // "audio"-lane decisions, only interview-synced audio.
      const audioSection = topLevelAudioSection(xml);
      expect((audioSection.match(/<track>/g) ?? []).length).toBe(1);
      // The audio clipitem carries the same source clip name as its video
      // counterpart — it's the same file's own audio, not a separate asset.
      expect(audioSection).toContain("A001_INT_MARISOL_01.mov");
      // Real in/out/start, matching the video event exactly (same source
      // range, same timeline position) — not just present, but correct.
      expect(audioSection).toContain("<in>24</in>");
      expect(audioSection).toContain("<out>120</out>");
      expect(audioSection).toContain("<start>0</start>");

      // Linked: both the video and the audio clipitem reference each other's
      // real ids via <linkclipref>, so an NLE moves/trims them as one unit.
      const linkRefs = [...xml.matchAll(/<linkclipref>([^<]+)<\/linkclipref>/g)].map((m) => m[1]);
      expect(linkRefs).toContain("v1-e1");
      expect(linkRefs).toContain("a1-e1");
      // 2 clipitems (video + audio) × 2 <link> blocks each (self + partner).
      expect((xml.match(/<link>/g) ?? []).length).toBe(4);
    });

    it("does not add synced audio for b-roll, and never links a b-roll clipitem", () => {
      const { usable } = validateTimelineForExport(timeline, clips);
      const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
      const audioSection = topLevelAudioSection(xml);
      expect(audioSection).not.toContain("B101_BROLL_GARDEN.mov");
      expect(linksReferencing(xml, "v2-e2")).toBe(0);
    });

    it("keeps a standalone audio-lane decision on its own A2 track, unlinked", () => {
      const audioClip = makeClip("clip-010", "narration.wav", "narration.wav");
      const tl = makeTimeline([
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
          id: "e3",
          lane: "audio",
          clipId: "clip-010",
          label: "narration",
          sourceInTc: "00:00:00:00",
          sourceOutTc: "00:00:04:00",
          timelineStartSeconds: 0,
          durationSeconds: 4,
        },
      ]);
      const { usable } = validateTimelineForExport(tl, [...clips, audioClip]);
      const { xml } = buildXmeml(tl, usable, [...clips, audioClip], MEDIA_ROOT);
      const audioSection = topLevelAudioSection(xml);
      // Both the interview's synced A1 audio and the standalone A2 narration
      // are present, on two distinct tracks.
      expect((audioSection.match(/<track>/g) ?? []).length).toBe(2);
      expect(audioSection).toContain("narration.wav");
      // The standalone audio-lane clipitem is never linked to anything.
      expect(linksReferencing(xml, "a2-e3")).toBe(0);
    });

    it("gives every audio samplecharacteristics block a real depth and sample rate", () => {
      const { usable } = validateTimelineForExport(timeline, clips);
      const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);
      const audioSection = topLevelAudioSection(xml);
      expect(audioSection).toContain("<depth>16</depth>");
      expect(audioSection).toContain("<samplerate>48000</samplerate>");
    });

    // Second real Premiere import test, immediately after the fixes above:
    // Premiere returned a hard "File Import Failure" (blank error message,
    // zero clips imported) on a real 3-event interview timeline where one
    // clip (18C_0687.MP4) was selected twice. Root cause: the same <file
    // id="..."> was defined three times with CONFLICTING content — a
    // video-only <media> block from each of its two V1 clipitems, an
    // audio-only one from its A1 clipitem — because file blocks were built
    // independently per clipitem with no shared, cross-clipitem definition
    // tracking. Premiere treats <file id="..."> as a real cross-reference
    // key; redefining it with contradictory content is what broke the import
    // outright, worse than the earlier "Matrix cannot be inverted" warnings.
    it("defines a repeated clip's <file> exactly once, covering all its media kinds, everywhere else a bare reference", () => {
      const repeatedClip = makeClip("clip-002", "18C_0687.MP4", "18C_0687.MP4");
      const otherClip = makeClip("clip-001", "18C_0681.MP4", "18C_0681.MP4");
      const tl = makeTimeline([
        {
          id: "event-1",
          lane: "interview",
          clipId: "clip-002",
          label: "e1",
          sourceInTc: "00:00:27:00",
          sourceOutTc: "00:00:39:00",
          timelineStartSeconds: 0,
          durationSeconds: 12,
        },
        {
          id: "event-2",
          lane: "interview",
          clipId: "clip-001",
          label: "e2",
          sourceInTc: "00:00:23:00",
          sourceOutTc: "00:00:32:00",
          timelineStartSeconds: 12,
          durationSeconds: 9,
        },
        {
          id: "event-3",
          lane: "interview",
          clipId: "clip-002",
          label: "e3",
          sourceInTc: "00:01:04:00",
          sourceOutTc: "00:01:13:00",
          timelineStartSeconds: 21,
          durationSeconds: 9,
        },
      ]);
      const { usable } = validateTimelineForExport(tl, [repeatedClip, otherClip]);
      const { xml } = buildXmeml(tl, usable, [repeatedClip, otherClip], MEDIA_ROOT);

      // clip-002 is used 4 times total (V1 × 2 + its linked A1 × 2) — exactly
      // one real <file id="file-clip-002"> definition, three bare references.
      const fullDefs = [...xml.matchAll(/<file id="([^"]+)">/g)].map((m) => m[1]);
      const bareRefs = [...xml.matchAll(/<file id="([^"]+)"\/>/g)].map((m) => m[1]);
      expect(fullDefs.filter((id) => id === "file-clip-002").length).toBe(1);
      expect(bareRefs.filter((id) => id === "file-clip-002").length).toBe(3);
      // No id is ever fully defined more than once, for any clip.
      const defCounts = new Map<string, number>();
      for (const id of fullDefs) defCounts.set(id, (defCounts.get(id) ?? 0) + 1);
      for (const count of defCounts.values()) expect(count).toBe(1);

      // The one real definition covers BOTH media kinds that clip is used
      // as — a single <media> block with both <video> and <audio> children —
      // rather than two separate, conflicting single-kind definitions.
      const fileBlockMatch = xml.match(/<file id="file-clip-002">[\s\S]*?<\/file>/);
      expect(fileBlockMatch).not.toBeNull();
      const fileBlock = fileBlockMatch![0];
      expect(fileBlock).toContain("<video>");
      expect(fileBlock).toContain("<audio>");
      expect(fileBlock).toContain("<width>");
      expect(fileBlock).toContain("<depth>16</depth>");
    });

    // Third real Premiere import test, after the file-id dedup fix above:
    // import succeeded (sequence created, V1/A1/dedup all correct), but
    // Premiere's Events window still reported exactly ONE "Matrix cannot be
    // inverted" — down from six, but not zero. Inspecting the real exported
    // XML byte-for-byte showed width/height/anamorphic/pixelaspectratio/
    // fielddominance/rate all present and IDENTICAL between the sequence-level
    // <video><format><samplecharacteristics> block and every per-file block —
    // ruling out a mismatch, and pointing at something emitted once per
    // sequence rather than once per clip. Per Apple's own XMEML reference, the
    // canonical FULL example of a sequence-format samplecharacteristics block
    // includes <colordepth> (this exporter never emitted it anywhere); real
    // Premiere-generated sequences also always give <sequence> an id
    // attribute, even though the DTD marks it optional.
    //
    // Fourth real Premiere import test, after adding <colordepth> to EVERY
    // video samplecharacteristics block (sequence AND per-file alike, commit
    // 2b84d1f): import still succeeded, but Events reported exactly TWO new
    // "Matrix cannot be inverted" — matching this timeline's exactly two
    // distinct <file id> definitions. The math against test #3 lines up
    // cleanly (1 sequence error + 0 file errors -> 0 sequence errors + 2 file
    // errors), so the sequence-level colordepth addition really did fix the
    // original error; only adding it to the per-file blocks (which have no
    // <format> wrapper, unlike the sequence block) regressed. <colordepth> is
    // now scoped to the once-per-sequence, <format>-wrapped block only.
    it("gives the sequence a real id attribute and the once-per-sequence format block a real colordepth", () => {
      const { usable } = validateTimelineForExport(timeline, clips);
      const { xml } = buildXmeml(timeline, usable, clips, MEDIA_ROOT);

      expect(xml).toMatch(/<sequence id="[^"]+">/);

      // Exactly ONE colordepth in the whole document — the once-per-sequence
      // <format> block — never inside a per-file <video> block (see the
      // real-test-#4 regression this guards against).
      const colordepths = [...xml.matchAll(/<colordepth>(\d+)<\/colordepth>/g)];
      expect(colordepths.length).toBe(1);
      expect(Number(colordepths[0][1])).toBeGreaterThan(0);

      const firstTrack = xml.indexOf("<track>");
      const sequenceFormatSection = xml.slice(0, firstTrack);
      expect(sequenceFormatSection).toContain("<colordepth>");
    });

    it("never puts colordepth in a per-file video samplecharacteristics block, even with multiple distinct files", () => {
      // Reuses the exact repeated-clip / two-distinct-file shape that
      // produced the real test-#4 regression (two unique <file id>
      // definitions, file-clip-002 and file-clip-001) — the fresh export that
      // reproduced it (test4.xml) had exactly two new Matrix errors, one per
      // file-level colordepth.
      const repeatedClip = makeClip("clip-002", "18C_0687.MP4", "18C_0687.MP4");
      const otherClip = makeClip("clip-001", "18C_0681.MP4", "18C_0681.MP4");
      const tl = makeTimeline([
        {
          id: "event-1",
          lane: "interview",
          clipId: "clip-002",
          label: "e1",
          sourceInTc: "00:01:04:00",
          sourceOutTc: "00:01:19:00",
          timelineStartSeconds: 0,
          durationSeconds: 15,
        },
        {
          id: "event-2",
          lane: "interview",
          clipId: "clip-001",
          label: "e2",
          sourceInTc: "00:00:23:00",
          sourceOutTc: "00:00:32:00",
          timelineStartSeconds: 15,
          durationSeconds: 9,
        },
        {
          id: "event-3",
          lane: "interview",
          clipId: "clip-002",
          label: "e3",
          sourceInTc: "00:01:26:00",
          sourceOutTc: "00:01:32:00",
          timelineStartSeconds: 24,
          durationSeconds: 6,
        },
      ]);
      const { usable } = validateTimelineForExport(tl, [repeatedClip, otherClip]);
      const { xml } = buildXmeml(tl, usable, [repeatedClip, otherClip], MEDIA_ROOT);

      // Two distinct real <file> definitions, exactly as in the real
      // regression fixture.
      const fullDefs = [...xml.matchAll(/<file id="([^"]+)">/g)].map((m) => m[1]);
      expect(new Set(fullDefs).size).toBe(2);

      // Still exactly one colordepth total (the sequence format block) — not
      // one per file, which is what actually broke import.
      const colordepths = [...xml.matchAll(/<colordepth>/g)];
      expect(colordepths.length).toBe(1);

      // Each real <file id="..."> block's own <video><samplecharacteristics>
      // must not contain colordepth at all.
      for (const fileId of new Set(fullDefs)) {
        const re = new RegExp(`<file id="${fileId}">[\\s\\S]*?<\\/file>`);
        const fileBlock = xml.match(re)![0];
        expect(fileBlock).not.toContain("<colordepth>");
        // Sanity: it still has real geometry — just not colordepth.
        expect(fileBlock).toContain("<width>");
      }
    });

    // Fifth real Premiere import test, after acaab01: import succeeded and
    // the two colordepth-driven errors were gone, but Premiere's Events
    // window still reported one "Matrix cannot be inverted" — traced this
    // time to a rate-model bug, not geometry. Real source clips were shot at
    // 23.976fps but cut into a 24fps sequence; every <file><rate> (and the
    // nested samplecharacteristics <rate>) was still emitted at the
    // sequence's 24fps/NTSC-FALSE, because a single `fps` — the timeline's —
    // was being used for both the clip's source-frame math AND the timeline
    // position math. Per Apple's own XMEML "Timing Values" reference, <in>/
    // <out> are interpreted via the source media's own rate while <start>/
    // <end> are interpreted via the sequence's — and this app's own backend
    // (worker/pipeline.py::_validate_decisions) already treats
    // sourceInTc/sourceOutTc as clip-native (`fps = clip.fps or 24.0`).
    it("emits each source clip's own real fps for 23.976 footage cut into a 24fps sequence, keeping sequence timing in the sequence's fps", () => {
      const clip976 = makeClip("clip-976", "18C_0687.MP4", "18C_0687.MP4", 23.976);
      const tl = makeTimeline([
        {
          id: "e1",
          lane: "interview",
          clipId: "clip-976",
          label: "e1",
          sourceInTc: "00:01:04:00",
          sourceOutTc: "00:01:19:00",
          timelineStartSeconds: 0,
          durationSeconds: 15,
        },
      ]);
      // Sanity: the timeline itself is a real 24fps sequence, distinct from
      // the clip's 23.976fps — this is the whole point of the fixture.
      expect(tl.fps).toBe(24);

      const { usable } = validateTimelineForExport(tl, [clip976]);
      const { xml, warnings } = buildXmeml(tl, usable, [clip976], MEDIA_ROOT);
      expect(warnings).toEqual([]);

      // The sequence's own rate must stay 24/FALSE — never silently
      // converted toward the clip's rate.
      const sequenceSection = xml.slice(0, xml.indexOf("<track>"));
      expect(sequenceSection).toMatch(/<rate>\s*<timebase>24<\/timebase>\s*<ntsc>FALSE<\/ntsc>/);

      // The file's own <rate> AND its nested samplecharacteristics <rate>
      // must both be 24/TRUE (Premiere/FCP7's encoding for 23.976fps) — not
      // 24/FALSE, which is what the pre-fix bug emitted for every clip
      // regardless of its real measured rate.
      const fileBlock = xml.match(/<file id="[^"]+">[\s\S]*?<\/file>/)![0];
      const fileRates = [...fileBlock.matchAll(/<rate>\s*<timebase>(\d+)<\/timebase>\s*<ntsc>(TRUE|FALSE)<\/ntsc>\s*<\/rate>/g)];
      expect(fileRates.length).toBe(2); // file-level + samplecharacteristics-level
      for (const [, timebase, ntsc] of fileRates) {
        expect(timebase).toBe("24");
        expect(ntsc).toBe("TRUE");
      }

      // <in>/<out> are source-frame positions computed at the CLIP's real
      // 23.976fps, not the sequence's 24fps: 00:01:04:00 -> 64s * 23.976 =
      // 1534.464 -> 1534 (24fps would wrongly give 1536); 00:01:19:00 -> 79s
      // * 23.976 = 1894.104 -> 1894 (24fps would wrongly give 1896).
      expect(xml).toContain("<in>1534</in>");
      expect(xml).toContain("<out>1894</out>");

      // The clipitem's own placement on the timeline — <start>/<end>/its own
      // <duration> — stays entirely in the SEQUENCE's 24fps: 15s * 24fps =
      // 360 frames, regardless of the clip's real rate.
      expect(xml).toContain("<start>0</start>");
      expect(xml).toContain("<end>360</end>");
      const clipitemSection = xml.slice(xml.indexOf("<clipitem"));
      expect(clipitemSection).toMatch(/<duration>360<\/duration>/);

      // The sequence's own total <duration> is likewise purely timeline-fps:
      // 15s * 24fps = 360, not distorted by the clip's different rate.
      const seqDuration = xml.match(/<sequence id="[^"]+">\s*<name>[^<]*<\/name>\s*<duration>(\d+)<\/duration>/);
      expect(seqDuration).not.toBeNull();
      expect(seqDuration![1]).toBe("360");
    });

    it("handles a mixed-rate timeline — 23.976 and 24fps clips in the same 24fps sequence — without drifting sequence duration", () => {
      const clip976 = makeClip("clip-976b", "23976clip.MP4", "23976clip.MP4", 23.976);
      const clip24 = makeClip("clip-24", "24clip.MP4", "24clip.MP4", 24);
      const tl = makeTimeline([
        {
          id: "e1",
          lane: "interview",
          clipId: "clip-976b",
          label: "e1",
          sourceInTc: "00:00:10:00",
          sourceOutTc: "00:00:15:00",
          timelineStartSeconds: 0,
          durationSeconds: 5,
        },
        {
          id: "e2",
          lane: "interview",
          clipId: "clip-24",
          label: "e2",
          sourceInTc: "00:00:20:00",
          sourceOutTc: "00:00:25:00",
          timelineStartSeconds: 5,
          durationSeconds: 5,
        },
      ]);
      const { usable } = validateTimelineForExport(tl, [clip976, clip24]);
      const { xml, warnings } = buildXmeml(tl, usable, [clip976, clip24], MEDIA_ROOT);
      expect(warnings).toEqual([]);

      const rates = [...xml.matchAll(/<timebase>(\d+)<\/timebase>\s*<ntsc>(TRUE|FALSE)<\/ntsc>/g)];
      // Exactly 2 NTSC-TRUE rate blocks — the 23.976 clip's file-level and
      // samplecharacteristics-level <rate> — everything else (sequence,
      // every clipitem's own rate, and the 24fps clip's file blocks) is
      // NTSC-FALSE.
      expect(rates.filter((m) => m[2] === "TRUE").length).toBe(2);
      expect(rates.filter((m) => m[2] === "FALSE").length).toBeGreaterThan(0);

      // Sequence duration stays purely timeline-based (10s * 24fps = 240),
      // unaffected by mixing a 23.976 clip in.
      const seqDuration = xml.match(/<sequence id="[^"]+">\s*<name>[^<]*<\/name>\s*<duration>(\d+)<\/duration>/);
      expect(seqDuration).not.toBeNull();
      expect(seqDuration![1]).toBe("240");
    });
  });
});

function linksReferencing(xml: string, id: string): number {
  return [...xml.matchAll(/<linkclipref>([^<]+)<\/linkclipref>/g)].filter((m) => m[1] === id).length;
}

// The sequence's own top-level <audio> section (containing A1/A2 tracks) is
// always the LAST literal "<audio>" tag in the document: nested per-file
// <media><audio> samplecharacteristics blocks (see fileBlockXml in xmeml.ts)
// are only ever emitted while building V1/V2's clipitems, which happens
// strictly before the top-level <audio> section is written — so a plain
// indexOf("<audio>") is ambiguous once a clip's own file definition embeds
// its audio characteristics, but lastIndexOf is not.
function topLevelAudioSection(xml: string): string {
  // A clip used as both video and audio (interview) or audio-only
  // (standalone "audio" lane, or A2's own file definition) can embed a
  // nested <media><audio> samplecharacteristics block anywhere a full <file>
  // definition happens to land — including inside the A2 track itself, after
  // the top-level <audio> tag. So neither indexOf nor lastIndexOf("<audio>")
  // is reliably the sequence-level tag. The one structural landmark that IS
  // unique: the sequence-level <audio> section always immediately follows
  // the sequence-level </video> close, both at the same (6-space) indent —
  // nested closes never appear at that indent.
  const marker = "      </video>\n      <audio>";
  const idx = xml.indexOf(marker);
  const start = idx + "      </video>\n".length;
  return xml.slice(start, xml.indexOf("</audio>", start));
}

describe("xmemlFilename", () => {
  it("slugifies the timeline name and appends .xml", () => {
    expect(xmemlFilename(makeTimeline([]))).toBe("test-60s-emotional-cut.xml");
  });
});
