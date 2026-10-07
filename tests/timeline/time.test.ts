// Canonical model: frame-rate policy and time conversions (src/lib/timeline/time.ts).
import { describe, expect, it } from "vitest";
import { framesForSeconds, secondsToTc, tcToSeconds } from "@/lib/nle/timecode";
import {
  fpsOf,
  frameToTc,
  framesToSeconds,
  nominalRate,
  rateFromFps,
  rescaleFrames,
  sameRate,
  secondsToFrames,
  tcToFrame,
} from "@/lib/timeline/time";

const R24 = rateFromFps(24);
const R23 = rateFromFps(23.976);

describe("frame-rate policy", () => {
  it("represents the app's rates exactly", () => {
    expect(R24).toEqual({ num: 24, den: 1 });
    expect(R23).toEqual({ num: 2997, den: 125 });
    expect(rateFromFps(29.97)).toEqual({ num: 2997, den: 100 });
    expect(rateFromFps(25)).toEqual({ num: 25, den: 1 });
  });

  it("gives back the exact float the rest of the app uses", () => {
    for (const fps of [24, 23.976, 25, 29.97, 30, 50, 59.94, 60]) {
      expect(fpsOf(rateFromFps(fps))).toBe(fps);
    }
  });

  it("falls back to 24 for missing or invalid rates (as the exporters do)", () => {
    for (const bad of [0, -1, Number.NaN, Infinity, null, undefined]) {
      expect(rateFromFps(bad as number)).toEqual(R24);
    }
  });

  it("compares rates by value", () => {
    expect(sameRate({ num: 48, den: 2 }, R24)).toBe(true);
    expect(sameRate(R23, R24)).toBe(false);
  });

  it("describes NTSC rates the way the XMEML exporter does", () => {
    expect(nominalRate(R23)).toEqual({ timebase: 24, ntsc: true });
    expect(nominalRate(R24)).toEqual({ timebase: 24, ntsc: false });
    expect(nominalRate(rateFromFps(29.97))).toEqual({ timebase: 30, ntsc: true });
  });
});

describe("conversions agree with the existing timecode helpers", () => {
  it("seconds → frames is the exporters' framesForSeconds", () => {
    for (const fps of [24, 23.976, 29.97]) {
      const r = rateFromFps(fps);
      for (let s = 0; s < 120; s += 0.0137) {
        expect(secondsToFrames(s, r)).toBe(framesForSeconds(s, fps));
      }
    }
    expect(secondsToFrames(-3, R24)).toBe(0);
  });

  it("timecode → frame matches how the exporters read a source timecode", () => {
    for (const tc of ["00:00:00:00", "00:01:02:15", "00:00:24:19", "00:01:33:02", "01:00:00:23"]) {
      for (const fps of [24, 23.976]) {
        expect(tcToFrame(tc, rateFromFps(fps))).toBe(framesForSeconds(tcToSeconds(tc, fps)!, fps));
      }
    }
  });

  it("rejects malformed and out-of-range timecodes instead of reading them as 0", () => {
    for (const tc of ["", "12:00", "00:60:00:00", "00:00:00:24", "-00:00:01:00", "aa:bb:cc:dd"]) {
      expect(tcToFrame(tc, R24)).toBeNull();
    }
  });

  it("frames → seconds is exact and inverts seconds → frames", () => {
    expect(framesToSeconds(48, R24)).toBe(2);
    expect(framesToSeconds(2997, R23)).toBe(125);
    for (let f = 0; f < 5000; f += 7) {
      expect(secondsToFrames(framesToSeconds(f, R23), R23)).toBe(f);
      expect(secondsToFrames(framesToSeconds(f, R24), R24)).toBe(f);
    }
  });

  it("rescales frame counts between rates", () => {
    expect(rescaleFrames(240, R24, R24)).toBe(240);
    expect(rescaleFrames(2997, R23, R24)).toBe(3000); // 125 s
    expect(rescaleFrames(3000, R24, R23)).toBe(2997);
    expect(rescaleFrames(1, R23, R24)).toBe(1);
  });
});

describe("timecode ↔ frame at the app's rates", () => {
  it("is exact at integer rates", () => {
    for (let f = 0; f < 24 * 3600 + 100; f += 13) {
      const tc = frameToTc(f, R24);
      expect(tc).toBe(secondsToTc(f / 24, 24));
      expect(tcToFrame(tc, R24)).toBe(f);
    }
  });

  it("every frame at 23.976 has a timecode that converts back to it (first 2 hours)", () => {
    for (let f = 0; f < 23.976 * 7200; f += 1) {
      expect(tcToFrame(frameToTc(f, R23), R23)).toBe(f);
    }
  });

  it("documents the fractional-rate quirk: some 23.976 timecodes share a frame", () => {
    // 24 labels per wall-clock second for 23.976 frames: about one label in
    // every ~42 seconds lands on the same frame as its neighbour.
    const seen = new Map<number, string>();
    let shared = 0;
    for (let s = 0; s < 600; s += 1) {
      for (let f = 0; f < 24; f += 1) {
        const tc = secondsToTc(s, 23.976).slice(0, 9) + String(f).padStart(2, "0");
        const frame = tcToFrame(tc, R23)!;
        if (seen.has(frame)) shared += 1;
        else seen.set(frame, tc);
      }
    }
    expect(shared).toBeGreaterThan(0);
    // …which is why legacy cuts keep their original timecodes as read-only
    // provenance (see legacy-adapter) instead of regenerating them from frames.
  });
});
