// Shared timecode <-> seconds conversion for the NLE/timeline layer. Split out
// of edl.ts so fcpxml.ts, xmeml.ts, and the CUT page's timeline-playback hook
// all use the exact same math instead of three hand-rolled copies drifting
// apart — this mirrors worker/media.py's seconds_to_tc/tc_to_seconds pair,
// which every export format's *source* timecodes ultimately came from.

export const TC_RE = /^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/;

export function secondsToTc(seconds: number, fps: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(sec)}:${p(f)}`;
}

/** Inverse of secondsToTc. Returns null for anything that isn't a well-formed
 * HH:MM:SS:FF timecode — callers must treat that as invalid, not 0. */
export function tcToSeconds(tc: string, fps: number): number | null {
  const m = TC_RE.exec(tc.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const f = Number(m[4]);
  const wholeFps = Math.max(1, Math.round(fps || 24));
  if (min >= 60 || s >= 60 || f >= wholeFps) return null;
  return h * 3600 + min * 60 + s + f / (fps || 24);
}

/** Rounds seconds to the nearest whole frame at `fps` — the unit XMEML/FCPXML
 * both use for absolute/relative timeline positions. */
export function framesForSeconds(seconds: number, fps: number): number {
  return Math.round(Math.max(0, seconds) * (fps || 24));
}
