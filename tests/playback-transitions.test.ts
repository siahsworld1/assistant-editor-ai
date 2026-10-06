// CUT preview playback across edit points (Release Step 4C, FIX 2).
//
// The packaged validation showed brief black frames between edits in the CUT
// preview (never in the cut itself: V1 and the exported XML are gap-free and
// Premiere played clean). Cause: ONE <video> had its src swapped at each
// cross-source edit, which drops the current frame until the next file loads,
// seeks and decodes. SequenceBuffer double-buffers instead; these tests drive
// it with fake media elements and check, frame by frame, that the visible
// element ALWAYS has a decoded frame.
import { describe, expect, it } from "vitest";
import { SequenceBuffer, type MediaLike, type SequenceState } from "@/lib/ae/sequence-buffer";
import { buildPlaybackPlan } from "@/lib/ae/timeline-playback";
import type { Clip, EditDecision, UniversalTimeline } from "@/lib/ae/types";

const NTSC = 23.976;

class FakeMedia implements MediaLike {
  private _src = "";
  private _time = 0;
  paused = true;
  seeking = false;
  readyState = 0;
  muted = false;
  /** auto: load + seek complete instantly (fast disk); manual: call finish*(). */
  constructor(public auto = true) {}
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.readyState = 0; // a new src drops the current frame
    this._time = 0;
    this.paused = true;
    if (this.auto) this.finishLoad();
  }
  get currentTime() {
    return this._time;
  }
  set currentTime(t: number) {
    this._time = t;
    this.seeking = true;
    if (this.auto) this.finishSeek();
  }
  finishLoad() {
    this.readyState = 1;
    this.fire("loadedmetadata");
  }
  finishSeek() {
    this.seeking = false;
    this.readyState = 4;
    this.fire("seeked");
  }
  play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  /** What a viewer sees from this element right now. */
  hasFrame() {
    return this.readyState >= 2 && !!this._src;
  }
  advance(dt: number) {
    if (!this.paused && this.readyState >= 2 && !this.seeking) this._time += dt;
  }
}

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

function ev(
  id: string,
  clipId: string,
  inTc: string,
  outTc: string,
  start: number,
  dur: number,
  lane: EditDecision["lane"] = "interview",
): EditDecision {
  return {
    id,
    lane,
    clipId,
    label: id,
    sourceInTc: inTc,
    sourceOutTc: outTc,
    timelineStartSeconds: start,
    durationSeconds: dur,
  };
}

// Shape of the validated Director cut: 0687, 0687, 0687, 0681, 0687 on V1 —
// three same-source edits, then cross-source edits both ways — plus V2.
const timeline: UniversalTimeline = {
  id: "t",
  name: "t",
  fps: 24,
  targetSeconds: 30,
  totalSeconds: 33,
  decisions: [
    ev("e1", "c87", "00:01:02:00", "00:01:12:00", 0, 10),
    ev("e2", "c87", "00:00:25:00", "00:00:32:00", 10, 7),
    ev("e3", "c87", "00:00:43:00", "00:00:49:00", 17, 6),
    ev("b1", "c91", "00:00:06:23", "00:00:11:15", 17.5, 4.67, "b-roll"),
    ev("e5", "c81", "00:00:22:00", "00:00:28:00", 23, 6),
    ev("e6", "c87", "00:01:28:00", "00:01:32:00", 29, 4),
    ev("b2", "c92", "00:00:04:20", "00:00:08:00", 29.5, 3.17, "b-roll"),
  ],
};
const plan = buildPlaybackPlan(timeline, ["c87", "c81", "c91", "c92"].map(clip));

function setup(auto = true) {
  const states: SequenceState[] = [];
  const buffer = new SequenceBuffer((s) => states.push({ ...s }));
  const media = [new FakeMedia(auto), new FakeMedia(auto)] as const;
  buffer.attach(0, media[0]);
  buffer.attach(1, media[1]);
  buffer.setSequence(plan.sequence, timeline.totalSeconds);
  const last = () => states[states.length - 1]!;
  const front = () => media[last().frontSlot];
  return { buffer, media, states, last, front };
}

/** Plays at ~60 fps for `seconds`, asserting no black frame on the way. */
function run(env: ReturnType<typeof setup>, seconds: number, onFrame?: () => void) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    env.front().advance(dt);
    env.buffer.tick();
    onFrame?.();
    if (env.last().activeIndex !== null) {
      expect(
        env.front().hasFrame(),
        `black frame at playhead ${env.last().playheadSeconds.toFixed(2)}s`,
      ).toBe(true);
    }
  }
}

describe("CUT preview: double-buffered playback", () => {
  it("plays V1 only, with V2 as overlays (sequence shape)", () => {
    expect(plan.sequence.map((s) => s.decision.id)).toEqual(["e1", "e2", "e3", "e5", "e6"]);
    expect(plan.overlays.map((s) => s.decision.id)).toEqual(["b1", "b2"]);
  });

  it("pre-rolls the next edit in the hidden element before the cut", () => {
    const env = setup();
    env.buffer.play();
    expect(env.last().activeIndex).toBe(0);
    const back = env.media[env.last().frontSlot === 0 ? 1 : 0];
    expect(back.src).toBe(plan.sequence[1]!.src); // same-source next edit…
    expect(back.currentTime).toBeCloseTo(25, 6); // …already parked at its in-point
    expect(back.hasFrame()).toBe(true);
    expect(back.paused && back.muted).toBe(true);
  });

  it("never shows a black frame across same-source and cross-source cuts, end to end", () => {
    const env = setup();
    env.buffer.play();
    const order: number[] = [];
    run(env, 34, () => {
      const i = env.last().activeIndex;
      if (i !== null && order[order.length - 1] !== i) order.push(i);
      // Only the visible element is ever audible.
      const audible = env.media.filter((m) => !m.muted && !m.paused);
      expect(audible.length).toBeLessThanOrEqual(1);
      if (audible.length === 1) expect(audible[0]).toBe(env.front());
    });
    expect(order).toEqual([0, 1, 2, 3, 4]);
    // End of the cut: stopped, holding the last frame.
    expect(env.last().playing).toBe(false);
    expect(env.last().playheadSeconds).toBe(33);
    expect(env.front().paused).toBe(true);
    expect(env.front().hasFrame()).toBe(true);
  });

  it("switches within a frame of each out-point (no overshoot past the edit)", () => {
    const env = setup();
    env.buffer.play();
    let lastIndex = 0;
    run(env, 10.5, () => {
      const i = env.last().activeIndex!;
      if (i !== lastIndex) {
        // The new edit starts at its own in-point, not mid-way.
        expect(env.front().currentTime).toBeCloseTo(plan.sequence[i]!.sourceInSeconds, 1);
        lastIndex = i;
      }
    });
    expect(lastIndex).toBe(1);
    expect(env.last().playheadSeconds).toBeGreaterThanOrEqual(10);
    expect(env.last().playheadSeconds).toBeLessThan(10.6);
  });

  it("holds the last frame (does not go black) while a slow next clip loads, then swaps and plays", () => {
    const env = setup(false);
    // First edit: load + seek it manually.
    env.buffer.play();
    env.media[0].finishLoad();
    env.media[0].finishSeek();
    expect(env.last().activeIndex).toBe(0);
    env.media[1].finishLoad(); // pre-roll of e2 (same file) — leave its seek pending
    // Run to e1's out-point: the back element isn't ready, so the front holds.
    for (let t = 0; t < 10.1; t += 1 / 60) {
      env.front().advance(1 / 60);
      env.buffer.tick();
    }
    expect(env.last().activeIndex).toBe(0);
    expect(env.last().frontSlot).toBe(0);
    expect(env.media[0].hasFrame()).toBe(true); // last frame still on screen
    expect(env.media[0].paused).toBe(true); // held still and silent
    env.media[1].finishSeek(); // next frame decoded → swap
    expect(env.last().frontSlot).toBe(1);
    expect(env.last().activeIndex).toBe(1);
    expect(env.media[1].paused).toBe(false);
    expect(env.media[1].muted).toBe(false);
    expect(env.media[0].muted).toBe(true);
  });

  it("seeks across edit boundaries to the right source position", () => {
    const env = setup();
    env.buffer.play();
    env.buffer.seek(24); // 1s into e5 (18C_0681 @ 22:00)
    expect(env.last().activeIndex).toBe(3);
    expect(env.front().src).toBe(plan.sequence[3]!.src);
    expect(env.front().currentTime).toBeCloseTo(23, 6);
    expect(env.last().playheadSeconds).toBeCloseTo(24, 6);
    env.buffer.seek(12); // back to e2, 2s in (00:00:25:00 + 2)
    expect(env.last().activeIndex).toBe(1);
    expect(env.front().currentTime).toBeCloseTo(27, 6);
    expect(env.front().hasFrame()).toBe(true);
  });

  it("seeking inside the edit on screen moves the same element (no swap)", () => {
    const env = setup();
    env.buffer.play();
    const slot = env.last().frontSlot;
    env.buffer.seek(4);
    expect(env.last().frontSlot).toBe(slot);
    expect(env.front().currentTime).toBeCloseTo(66, 6);
  });

  it("play after the end restarts from the first edit", () => {
    const env = setup();
    env.buffer.play();
    run(env, 34);
    expect(env.last().playing).toBe(false);
    env.buffer.play();
    expect(env.last().activeIndex).toBe(0);
    expect(env.last().playing).toBe(true);
  });
});
