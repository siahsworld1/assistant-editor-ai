// Frame-rate policy and every time conversion for the canonical edit model.
//
// RATES. A rate is an exact fraction (FrameRate). Media and sequence rates are
// taken as the exact value the rest of the app already uses — the worker
// records a clip's rate rounded to 3 decimals (23.976), and the timeline's rate
// comes from the engine (24) — so 23.976 becomes 2997/125, not 24000/1001.
// Every frame computed here therefore agrees bit-for-bit with the worker,
// playback (timeline-playback.ts) and the exporters (src/lib/nle/*). Whether a
// rate is an NTSC rate (for an NLE's timebase/ntsc flags) is a separate,
// derived question: see `nominalRate`.
//
// TIMECODE. The app's timecode is NOT a SMPTE frame count: "HH:MM:SS:FF" means
// SS wall-clock seconds plus FF frames of 1/fps each (see
// src/lib/nle/timecode.ts and worker/media.py). At an integer rate that is
// exactly a frame count. At a fractional rate (23.976) each second carries 24
// labels for 23.976 frames, so:
//   - every frame has at least one timecode (there are no gaps), but
//   - occasionally two timecodes land on the same frame.
// `frameToTc` therefore searches for a label that converts back to exactly the
// requested frame; `tcToFrame(frameToTc(f)) === f` holds for every frame.
//
// Conversions round the way the exporters do (framesForSeconds = Math.round).
import { framesForSeconds, secondsToTc, tcToSeconds } from "@/lib/nle/timecode";
import type { FrameRate } from "./types";

const DEFAULT_FPS = 24;

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** The exact rate for an fps value as the app stores it (24 → 24/1,
 * 23.976 → 2997/125, 29.97 → 2997/100). Non-positive/invalid → 24/1. */
export function rateFromFps(fps: number | null | undefined): FrameRate {
  const v = typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  // The app's rates are decimals with at most 3 places; 6 keeps any other
  // value exact enough to reproduce the same float.
  const scale = 1_000_000;
  const num = Math.round(v * scale);
  const g = gcd(num, scale);
  return { num: num / g, den: scale / g };
}

/** The rate as a number — the exact float the rest of the app uses. */
export function fpsOf(rate: FrameRate): number {
  return rate.num / rate.den;
}

export function sameRate(a: FrameRate, b: FrameRate): boolean {
  return a.num * b.den === b.num * a.den;
}

/** NLE-facing description: timebase 24 + NTSC for 23.976, 24 + not-NTSC for 24
 * (same rule as the XMEML exporter's rateBlock). */
export function nominalRate(rate: FrameRate): { timebase: number; ntsc: boolean } {
  const fps = fpsOf(rate);
  const timebase = Math.max(1, Math.round(fps));
  return { timebase, ntsc: Math.abs(fps - timebase) > 0.001 };
}

/** Seconds → nearest whole frame (negative clamps to 0), as the exporters do. */
export function secondsToFrames(seconds: number, rate: FrameRate): number {
  return framesForSeconds(seconds, fpsOf(rate));
}

/** Frame → seconds, exact for the rate. */
export function framesToSeconds(frames: number, rate: FrameRate): number {
  return (frames * rate.den) / rate.num;
}

/** A frame count at one rate → the nearest frame count at another, by the
 * rates alone. NOT the rule for an item's length on the sequence — that is
 * `sequenceDurationFrames`, which reads the source range on the app's
 * timecode clock (see there for why the two differ). */
export function rescaleFrames(frames: number, from: FrameRate, to: FrameRate): number {
  if (sameRate(from, to)) return frames;
  return Math.round((frames * to.num * from.den) / (to.den * from.num));
}

/** App timecode → frame at `rate`; null for a malformed or out-of-range code
 * (callers must treat that as invalid, not 0). */
export function tcToFrame(tc: string, rate: FrameRate): number | null {
  const seconds = tcToSeconds(tc, fpsOf(rate));
  return seconds === null ? null : secondsToFrames(seconds, rate);
}

/** Frame at `rate` → an app timecode that converts back to exactly that frame. */
export function frameToTc(frame: number, rate: FrameRate): string {
  const fps = fpsOf(rate);
  const f = Math.max(0, Math.round(frame));
  const first = secondsToTc(framesToSeconds(f, rate), fps);
  if (tcToFrame(first, rate) === f) return first;
  // Fractional rate: the label floor() picked can sit on a neighbouring frame.
  // Every frame has a label within ±1 label of that guess (see file header).
  const labelsPerSecond = Math.max(1, Math.round(fps));
  const m = /^(\d+):(\d{2}):(\d{2}):(\d{2})$/.exec(first)!;
  const base =
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * labelsPerSecond + Number(m[4]);
  for (const delta of [1, -1, 2, -2]) {
    const label = base + delta;
    if (label < 0) continue;
    const sec = Math.floor(label / labelsPerSecond);
    const ff = label % labelsPerSecond;
    const p = (n: number) => String(n).padStart(2, "0");
    const tc = `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}:${p(ff)}`;
    if (tcToFrame(tc, rate) === f) return tc;
  }
  // Unreachable for the app's rates (every frame has a label); keep the
  // nearest label rather than throwing.
  return first;
}

/** Where a source frame sits on the app's timecode clock: the wall-clock
 * seconds of its timecode ("SS:FF" → SS + FF/fps). */
export function tcClockSeconds(frame: number, rate: FrameRate): number {
  return tcToSeconds(frameToTc(frame, rate), fpsOf(rate))!;
}

/**
 * THE source-range → sequence-length rule. Every item's `durationFrames` comes
 * from here whenever its source range is set or changed; nothing else may
 * compute a sequence length from source frames.
 *
 * The source range is measured on the app's timecode clock — the wall-clock
 * seconds between its in and out timecodes, which is how the worker, the
 * Director and beta.1 measure every edit (`durationSeconds` = out − in) — and
 * that length is placed on the sequence with the exporters' rounding
 * (`framesForSeconds`). For 23.976 media on a 24 fps sequence a 10-second
 * range is 239 source frames and 240 sequence frames, exactly as beta.1
 * exported it. (Rescaling the frame COUNT instead — 239 × 24 / 23.976 → 239 —
 * is what would open a one-frame gap next to an unedited neighbour.)
 *
 * Deterministic: a pure function of the range and the two rates. Because 23.976
 * media has 24 timecode labels per wall-clock second, the same number of source
 * frames can measure one sequence frame longer or shorter depending on where
 * the range sits; equal ranges always give equal results. Never less than 1.
 */
export function sequenceDurationFrames(
  sourceInFrame: number,
  sourceOutFrame: number,
  mediaRate: FrameRate,
  sequenceRate: FrameRate,
): number {
  const seconds =
    tcClockSeconds(sourceOutFrame, mediaRate) - tcClockSeconds(sourceInFrame, mediaRate);
  return Math.max(1, secondsToFrames(seconds, sequenceRate));
}
