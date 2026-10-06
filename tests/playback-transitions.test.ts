// CUT playback across edit points (P0 Step 8). Renders the real
// useTimelinePlayback hook with a fake player handle: consecutive events cut
// from the SAME source clip share one <video> src, so moving between them must
// seek the player explicitly — found playing a real cut that used 18C_0687
// twice in a row, where playback ran on past the first event's out-point.
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useTimelinePlayback, type TimelinePlayback } from "@/lib/ae/timeline-playback";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NTSC = 23.976;
const clip = (id: string): Clip => ({
  id,
  filename: `${id}.MP4`,
  relPath: `${id}.MP4`,
  proxyRelPath: `.ae_proxies/${id}.mp4`,
  role: "interview",
  durationSeconds: 120,
  camera: "HEVC",
  resolution: "3840x2160",
  fps: NTSC,
  speakers: [],
  state: "analyzed",
  progress: 100,
  hasTranscript: true,
  visualEvidenceCount: 0,
  technicalIssues: [],
  thumbHue: 0,
});
const timeline: UniversalTimeline = {
  id: "t",
  name: "t",
  fps: 24,
  targetSeconds: 30,
  totalSeconds: 12,
  decisions: [
    {
      id: "a",
      lane: "interview",
      clipId: "c87",
      label: "a",
      sourceInTc: "00:01:04:12",
      sourceOutTc: "00:01:11:18",
      timelineStartSeconds: 0,
      durationSeconds: 7.25,
    },
    {
      id: "b",
      lane: "interview",
      clipId: "c87",
      label: "b",
      sourceInTc: "00:01:26:12",
      sourceOutTc: "00:01:31:02",
      timelineStartSeconds: 7.25,
      durationSeconds: 4.583,
    },
  ],
};

async function mountPlayback() {
  let pb: TimelinePlayback | null = null;
  function Probe(): ReactNode {
    pb = useTimelinePlayback(timeline, [clip("c87")]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  const player = {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    getCurrentTime: () => 0,
    getDuration: () => 120,
  };
  pb!.playerRef.current = player;
  return { get: () => pb!, player, root };
}

describe("CUT playback across edit points", () => {
  it("seeks to the next event's in-point when both events share one source clip", async () => {
    const { get, player, root } = await mountPlayback();
    await act(async () => get().play()); // loads event a
    expect(get().activeSegment?.decision.id).toBe("a");
    const aOut = get().segments[0]!.sourceOutSeconds;
    await act(async () => get().handleTimeUpdate(aOut)); // reaches a's out-point
    expect(get().activeSegment?.decision.id).toBe("b");
    const bIn = 86 + 12 / NTSC; // 00:01:26:12 at the clip's 23.976
    expect(player.seek).toHaveBeenCalledWith(bIn);
    await act(async () => root.unmount());
  });

  it("stops at the end of the cut instead of playing on past the last out-point", async () => {
    const { get, player, root } = await mountPlayback();
    await act(async () => get().play());
    await act(async () => get().handleTimeUpdate(get().segments[0]!.sourceOutSeconds)); // → b
    player.pause.mockClear();
    await act(async () => get().handleTimeUpdate(get().segments[1]!.sourceOutSeconds)); // b's out-point
    expect(player.pause).toHaveBeenCalled();
    expect(get().playheadSeconds).toBe(timeline.totalSeconds);
    await act(async () => root.unmount());
  });

  it("seeking across an edit boundary lands at the right source position", async () => {
    const { get, player, root } = await mountPlayback();
    await act(async () => get().play());
    await act(async () => get().seek(8.25)); // 1s into event b
    expect(get().activeSegment?.decision.id).toBe("b");
    expect(player.seek).toHaveBeenLastCalledWith(expect.closeTo(86 + 12 / NTSC + 1, 6));
    await act(async () => root.unmount());
  });
});
