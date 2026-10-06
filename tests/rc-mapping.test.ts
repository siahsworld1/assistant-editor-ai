// P0 Step 8 renderer logic: how selects / beats / edits map to real source
// moments, how the CUT plays V1 vs V2, frame-request alignment, which saved
// edit states may be restored, and the evidence WATCH needs from the engine.
import { describe, expect, it } from "vitest";
import { beatSource, decisionSourceRange, sourceRangeOf } from "@/lib/ae/source-range";
import { buildPlaybackPlan, overlayAt } from "@/lib/ae/timeline-playback";
import { EngineClient } from "@/lib/ae/service";
import type { EngineTransport } from "@/lib/ae/transport";
import { parseSavedEditState } from "@/lib/ae/store";
import { normalizeProjectPatch } from "@/lib/ae/normalize";
import type { Clip, Select, UniversalTimeline } from "@/lib/ae/types";

const NTSC = 23.976;
function clip(id: string, fps = NTSC): Clip {
  return {
    id,
    filename: `${id}.MP4`,
    relPath: `${id}.MP4`,
    proxyRelPath: `.ae_proxies/${id}.mp4`,
    role: "interview",
    durationSeconds: 60,
    camera: "HEVC",
    resolution: "3840x2160",
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
function select(id: string, clipId: string, startTc: string, endTc: string): Select {
  return {
    id,
    rank: 1,
    speaker: "Ana",
    clipId,
    clipName: `${clipId}.MP4`,
    startTc,
    endTc,
    durationSeconds: 2,
    score: 80,
    category: "emotional",
    transcriptExcerpt: "x",
    reasons: [],
    evidence: [],
  };
}
const clips = new Map([
  ["c1", clip("c1")],
  ["c2", clip("c2")],
  ["c24", clip("c24", 24)],
]);

describe("source-range mapping (SELECTS / STORY / CUT)", () => {
  it("reads timecodes at the clip's own frame rate", () => {
    const r = sourceRangeOf(select("s", "c1", "00:00:05:12", "00:00:10:00"), clips)!;
    expect(r.clip.id).toBe("c1");
    expect(r.inSeconds).toBeCloseTo(5 + 12 / NTSC, 9); // not 5.5 (the 24fps reading)
    expect(r.outSeconds).toBe(10);
    expect(sourceRangeOf(select("s", "c24", "00:00:05:12", "00:00:10:00"), clips)!.inSeconds).toBe(
      5.5,
    );
  });

  it("returns nothing for a clip that isn't in the project — never a stand-in", () => {
    expect(sourceRangeOf(select("s", "ghost", "00:00:01:00", "00:00:02:00"), clips)).toBeNull();
  });

  it("maps an edit decision's in/out the same way", () => {
    const r = decisionSourceRange(
      {
        clipId: "c2",
        sourceInTc: "00:00:01:06",
        sourceOutTc: "00:00:03:00",
        durationSeconds: 1.75,
      },
      clips,
    )!;
    expect(r.inSeconds).toBeCloseTo(1 + 6 / NTSC, 9);
  });

  it("a beat shows its first select that resolves to real media, and reports unresolved ids", () => {
    const sels = [
      select("s1", "ghost", "00:00:01:00", "00:00:02:00"),
      select("s2", "c2", "00:00:04:00", "00:00:06:00"),
    ];
    const found = beatSource(["missing", "s1", "s2"], sels, clips);
    expect(found.select?.id).toBe("s2"); // s1 exists but its clip doesn't → skipped, not faked
    expect(found.range?.clip.id).toBe("c2");
    expect(found.missingSelectIds).toEqual(["missing"]);
    const none = beatSource(["missing"], sels, clips);
    expect(none.select).toBeNull();
    expect(none.range).toBeNull();
  });
});

describe("CUT playback plan", () => {
  const timeline: UniversalTimeline = {
    id: "t",
    name: "t",
    fps: 24,
    targetSeconds: 30,
    totalSeconds: 8,
    decisions: [
      {
        id: "e1",
        lane: "interview",
        clipId: "c1",
        label: "a",
        sourceInTc: "00:00:05:12",
        sourceOutTc: "00:00:09:12",
        timelineStartSeconds: 0,
        durationSeconds: 4,
      },
      {
        id: "e2",
        lane: "interview",
        clipId: "c2",
        label: "b",
        sourceInTc: "00:00:20:00",
        sourceOutTc: "00:00:24:00",
        timelineStartSeconds: 4,
        durationSeconds: 4,
      },
      {
        id: "b1",
        lane: "b-roll",
        clipId: "c2",
        label: "cutaway",
        sourceInTc: "00:00:40:00",
        sourceOutTc: "00:00:42:00",
        timelineStartSeconds: 1,
        durationSeconds: 2,
      },
    ],
  };

  it("plays V1 as the sequence (picture + sync audio); V2 never becomes a sequential event", () => {
    const plan = buildPlaybackPlan(timeline, [...clips.values()]);
    expect(plan.sequence.map((s) => s.decision.id)).toEqual(["e1", "e2"]);
    expect(plan.overlays.map((s) => s.decision.id)).toEqual(["b1"]);
  });

  it("positions V1 in the source at the clip's frame rate", () => {
    const [first] = buildPlaybackPlan(timeline, [...clips.values()]).sequence;
    expect(first!.sourceInSeconds).toBeCloseTo(5 + 12 / NTSC, 9);
  });

  it("shows the V2 cutaway only during its own timeline span", () => {
    const { overlays } = buildPlaybackPlan(timeline, [...clips.values()]);
    expect(overlayAt(overlays, 0.5)).toBeNull();
    expect(overlayAt(overlays, 1)?.decision.id).toBe("b1");
    expect(overlayAt(overlays, 2.9)?.decision.id).toBe("b1");
    expect(overlayAt(overlays, 3)).toBeNull();
  });

  it("a timeline with only V2 events still plays", () => {
    const onlyBroll = {
      ...timeline,
      decisions: timeline.decisions.filter((d) => d.lane === "b-roll"),
    };
    expect(
      buildPlaybackPlan(onlyBroll, [...clips.values()]).sequence.map((s) => s.decision.id),
    ).toEqual(["b1"]);
  });
});

describe("EngineClient.frames", () => {
  it("keeps results aligned with the requested times when a frame fails", async () => {
    const transport: EngineTransport = {
      id: "direct-loopback",
      label: "fake",
      target: "fake",
      request: async () => ({
        frames: [
          { seconds: 1, relPath: ".ae_thumbs/frames/a.jpg" },
          { seconds: 2, error: "decode failed" },
          { seconds: 3, relPath: ".ae_thumbs/frames/c.jpg" },
        ],
      }),
    };
    const frames = await new EngineClient(transport).frames("c1", [1, 2, 3, 4]);
    expect(frames.map((f) => f?.relPath ?? null)).toEqual([
      ".ae_thumbs/frames/a.jpg",
      null,
      ".ae_thumbs/frames/c.jpg",
      null,
    ]);
  });
});

describe("saved edit state", () => {
  const saved = {
    schema: 1,
    analysisId: "a1",
    versions: [
      { id: "v1", timeline: { decisions: [] } },
      { id: "v2", timeline: { decisions: [] } },
      { junk: true },
    ],
    activeVersionId: "v2",
    chosenStoryId: "story-02",
    targetSeconds: 30,
    storyboardSelectIds: ["sel-01", 7],
  };

  it("restores only against the analysis it was built from", () => {
    const ok = parseSavedEditState(saved, "a1")!;
    expect(ok.versions.map((v) => v.id)).toEqual(["v1", "v2"]); // malformed entry dropped
    expect(ok.activeVersionId).toBe("v2");
    expect(ok.chosenStoryId).toBe("story-02");
    expect(ok.storyboardSelectIds).toEqual(["sel-01"]);
    expect(parseSavedEditState(saved, "a2")).toBeNull(); // re-analyzed: clip ids may differ
    expect(parseSavedEditState(saved, null)).toBeNull();
    expect(parseSavedEditState({ ...saved, schema: 2 }, "a1")).toBeNull();
    expect(parseSavedEditState("garbage", "a1")).toBeNull();
  });

  it("falls back safely for a missing active version or an out-of-range target", () => {
    const r = parseSavedEditState({ ...saved, activeVersionId: "v9", targetSeconds: -5 }, "a1")!;
    expect(r.activeVersionId).toBe("v2");
    expect(r.targetSeconds).toBe(360);
  });
});

describe("evidence WATCH needs from GET /project", () => {
  it("maps the engine's transcript, visual evidence and analysis id", () => {
    const patch = normalizeProjectPatch({
      project: {
        analysisId: "a1",
        transcript: [
          {
            id: "t1",
            clipId: "c1",
            speaker: "Ana",
            startTc: "00:00:01:00",
            endTc: "00:00:02:00",
            text: "Hi",
            confidence: 0.9,
          },
          { clipId: "c1", text: "" },
        ],
        visualEvidence: [
          {
            id: "v1",
            clipId: "c2",
            kind: "b-roll",
            label: "Hands",
            atTc: "00:00:03:00",
            confidence: 0.8,
          },
          { clipId: "c2", kind: "weird", label: "Sky" },
        ],
      },
    });
    expect(patch.analysisId).toBe("a1");
    expect(patch.transcript!.map((t) => t.text)).toEqual(["Hi"]); // empty segments dropped
    expect(patch.visualEvidence!.map((v) => [v.label, v.kind])).toEqual([
      ["Hands", "b-roll"],
      ["Sky", "scene"],
    ]);
  });

  it("leaves existing evidence alone when an older engine doesn't send it", () => {
    const patch = normalizeProjectPatch({ project: { analysisState: "complete" } });
    expect("transcript" in patch).toBe(false);
    expect("visualEvidence" in patch).toBe(false);
  });
});

describe("secondsToTc round-trips frame-exact times", () => {
  it("never shows a 23.976 in-point one frame early", async () => {
    const { secondsToTc, tcToSeconds } = await import("@/lib/nle/timecode");
    for (let f = 0; f < 24; f++) {
      const tc = `00:00:13:${String(f).padStart(2, "0")}`;
      expect(secondsToTc(tcToSeconds(tc, NTSC)!, NTSC)).toBe(tc);
      const tc24 = `00:01:59:${String(f).padStart(2, "0")}`;
      expect(secondsToTc(tcToSeconds(tc24, 24)!, 24)).toBe(tc24);
    }
    expect(secondsToTc(13.9999999999, 24)).toBe("00:00:14:00"); // carries, never frame 24
  });
});

describe("CUT timeline scale", () => {
  it("follows the cut, not an unrelated or stale target", async () => {
    const { timelineScale } = await import("@/lib/ae/source-range");
    expect(timelineScale(30.36, 360)).toBe(30.36); // 360 slider default can't shrink a 30s cut
    expect(timelineScale(30.36, 30)).toBe(30.36);
    expect(timelineScale(30, 45)).toBe(45); // under-length cut still shows its target
    expect(timelineScale(0, 360)).toBe(360); // empty timeline shows its target
  });
});
