// Where a select / story beat / edit actually lives in its source media — the
// single mapping SELECTS, STORY and CUT use for their pictures and previews.
// Source timecodes are always read at the referenced CLIP's own frame rate
// (a 23.976 source's frame field is 1/23.976s), matching the worker's
// validation and the XMEML exporter.
import { tcToSeconds } from "@/lib/nle/timecode";
import type { Clip, Select } from "./types";

export interface SourceRange {
  clip: Clip;
  inSeconds: number;
  outSeconds: number;
}

/** A timecoded range on a clip → seconds, or null when the clip is unknown. */
export function sourceRangeOf(
  ref: { clipId: string; startTc: string; endTc: string; durationSeconds: number },
  clipsById: ReadonlyMap<string, Clip>,
): SourceRange | null {
  const clip = clipsById.get(ref.clipId);
  if (!clip) return null;
  const fps = clip.fps || 24;
  const inSeconds = tcToSeconds(ref.startTc, fps) ?? 0;
  const parsedOut = tcToSeconds(ref.endTc, fps);
  const outSeconds =
    parsedOut !== null && parsedOut > inSeconds
      ? parsedOut
      : inSeconds + Math.max(0, ref.durationSeconds);
  return { clip, inSeconds, outSeconds };
}

/** An edit decision's source range (its in/out are named differently). */
export function decisionSourceRange(
  d: { clipId: string; sourceInTc: string; sourceOutTc: string; durationSeconds: number },
  clipsById: ReadonlyMap<string, Clip>,
): SourceRange | null {
  return sourceRangeOf(
    {
      clipId: d.clipId,
      startTc: d.sourceInTc,
      endTc: d.sourceOutTc,
      durationSeconds: d.durationSeconds,
    },
    clipsById,
  );
}

/** A story beat's picture source: its first select that resolves to a real
 * select AND a real clip. Unresolvable ids are reported, never substituted. */
export function beatSource(
  selectIds: readonly string[],
  selects: readonly Select[],
  clipsById: ReadonlyMap<string, Clip>,
):
  | { select: Select; range: SourceRange; missingSelectIds: string[] }
  | { select: null; range: null; missingSelectIds: string[] } {
  const byId = new Map(selects.map((s) => [s.id, s]));
  const missingSelectIds = selectIds.filter((id) => !byId.has(id));
  for (const id of selectIds) {
    const select = byId.get(id);
    const range = select ? sourceRangeOf(select, clipsById) : null;
    if (select && range) return { select, range, missingSelectIds };
  }
  return { select: null, range: null, missingSelectIds };
}

/**
 * Seconds the CUT track spans. Follows the cut's own length; the target is
 * included only when it is within 2x of it (so an under-length cut still shows
 * its target marker, but an unrelated or stale target can't shrink a 30-second
 * cut into a sliver of a 360-second track). An empty timeline shows its target.
 */
export function timelineScale(totalSeconds: number, targetSeconds: number): number {
  if (totalSeconds <= 0) return Math.max(targetSeconds, 1);
  return Math.max(totalSeconds, targetSeconds <= totalSeconds * 2 ? targetSeconds : 0, 1);
}
