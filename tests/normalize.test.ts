// Real Premiere test #7: the XMEML exporter needs each clip's real audio
// channel count. It's measured by the worker (worker/media.py::ffprobe_info)
// and must survive GET /project normalization into Clip.audioChannels.
import { describe, expect, it } from "vitest";
import { normalizeProjectPatch } from "@/lib/ae/normalize";

function projectWithClip(extra: Record<string, unknown>) {
  return {
    project: {
      id: "proj-1",
      clips: [{ id: "clip-001", filename: "18C_0681.MP4", role: "interview", fps: 23.976, ...extra }],
    },
  };
}

describe("normalizeProjectPatch — audio channel count", () => {
  it("carries the worker's measured channel count onto the clip", () => {
    const clips = normalizeProjectPatch(projectWithClip({ audioChannels: 2 })).clips!;
    expect(clips[0]!.audioChannels).toBe(2);
  });

  it("leaves it undefined for 0 (no audio stream) or a worker that doesn't report it — never a default", () => {
    expect(normalizeProjectPatch(projectWithClip({ audioChannels: 0 })).clips![0]!.audioChannels).toBeUndefined();
    expect(normalizeProjectPatch(projectWithClip({})).clips![0]!.audioChannels).toBeUndefined();
  });
});
