// Picture-only overlay placement. No ripple, audio creation, or replacement.
//
// Covering footage is not modifying it: whatever lies beneath keeps its
// position, source range, sync and ownership, and a clip the filmmaker edited
// by hand may be covered. But the Director may not cover footage the filmmaker
// explicitly LOCKED or AI-PROTECTED (item or track) — that protection means
// "AI, keep away from this footage", which includes hiding it. The filmmaker
// may still place over it by hand.
import { mediaEndFrame } from "../invariants";
import { endFrame, isLockedFrom, isTrackProtectedFrom } from "../selectors";
import { sequenceDurationFrames } from "../time";
import type { ClipItem, FrameRate, Sequence } from "../types";
import { UNPROTECTED } from "../types";
import { rejectNewOverlaps } from "./guards";
import {
  changed,
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type PlaceEditParams,
} from "./types";

const validRate = (r: FrameRate | undefined): boolean =>
  !!r && Number.isSafeInteger(r.num) && r.num > 0 && Number.isSafeInteger(r.den) && r.den > 0;
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

export function placeEdit(seq: Sequence, p: PlaceEditParams, ctx: CommandContext): CommandOutcome {
  if (
    !p ||
    !nonEmpty(p.itemId) ||
    !nonEmpty(p.mediaClipId) ||
    !nonEmpty(p.trackId) ||
    !nonEmpty(p.label) ||
    !validRate(p.mediaRate) ||
    !validRate(seq.rate)
  ) {
    return fail(
      "invalid-params",
      "PlaceEdit needs ids, a label, and valid media and sequence rates.",
    );
  }
  if (
    p.itemId === seq.id ||
    seq.tracks.some((t) => t.id === p.itemId) ||
    p.itemId in seq.items ||
    p.itemId in seq.links
  ) {
    return fail("invalid-params", `Placement id ${p.itemId} is already in use.`, [p.itemId]);
  }
  if (!Number.isSafeInteger(p.startFrame) || p.startFrame < 0) {
    return fail("invalid-params", "Placement must start at a non-negative integer sequence frame.");
  }
  if (
    !Number.isSafeInteger(p.sourceInFrame) ||
    p.sourceInFrame < 0 ||
    !Number.isSafeInteger(p.sourceOutFrame) ||
    p.sourceOutFrame <= p.sourceInFrame
  ) {
    return fail("invalid-range", "Placement needs a positive, integer-frame source range.");
  }
  const track = seq.tracks.find((t) => t.id === p.trackId);
  if (!track) return fail("unknown-track", "Placement targets a track this cut does not have.");
  if (track.kind !== "video" || !Number.isSafeInteger(track.order) || track.order < 1) {
    return fail(
      "invalid-params",
      "Placement is only available on overlay video tracks (V2 and above).",
    );
  }
  if (isTrackProtectedFrom(track, ctx.origin)) {
    return fail("protected", `${track.name} is protected from ${ctx.origin} placement.`);
  }
  const media = ctx.media?.get(p.mediaClipId);
  if (!media || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) {
    return fail(
      "out-of-bounds",
      "Placement requires known media with a finite, positive duration.",
    );
  }
  const item: ClipItem = {
    id: p.itemId,
    trackId: p.trackId,
    mediaClipId: p.mediaClipId,
    mediaRate: { ...p.mediaRate },
    sourceInFrame: p.sourceInFrame,
    sourceOutFrame: p.sourceOutFrame,
    startFrame: p.startFrame,
    durationFrames: sequenceDurationFrames(
      p.sourceInFrame,
      p.sourceOutFrame,
      p.mediaRate,
      seq.rate,
    ),
    label: p.label,
    enabled: true,
    origin: ctx.origin === "director" ? "director" : "manual",
    protection: { ...UNPROTECTED },
  };
  const end = mediaEndFrame(item, ctx.media);
  if (end === null || !Number.isSafeInteger(end) || p.sourceOutFrame > end) {
    return fail("out-of-bounds", "Placement source range exceeds the known media bounds.");
  }
  if (
    !Number.isSafeInteger(item.durationFrames) ||
    item.durationFrames < 1 ||
    !Number.isSafeInteger(item.startFrame + item.durationFrames)
  ) {
    return fail("invalid-range", "Placement has an invalid sequence duration or end frame.");
  }
  const next = withChanges(seq, { [item.id]: changed(item, ctx, {}) });
  const overlap = rejectNewOverlaps(seq, next, [track.id]);
  if (overlap) return overlap;
  if (ctx.origin === "director") {
    const placedEnd = item.startFrame + item.durationFrames;
    const beneath = seq.tracks.filter((t) => t.kind === "video" && t.order < track.order);
    const covered = Object.values(seq.items).filter(
      (i) =>
        beneath.some((t) => t.id === i.trackId) &&
        i.startFrame < placedEnd &&
        endFrame(i) > item.startFrame &&
        isLockedFrom(seq, i, "director"),
    );
    if (covered.length) {
      return fail(
        "protected",
        `${covered.map((i) => `"${i.label}"`).join(", ")} ${covered.length > 1 ? "are" : "is"} locked or AI-protected — the Director won't cover ${covered.length > 1 ? "them" : "it"} with B-roll.`,
        covered.map((i) => i.id),
      );
    }
  }
  return {
    ok: true,
    sequence: next,
    changedIds: [item.id],
    notes: [`Placed "${item.label}" on ${track.name} (picture only).`],
  };
}
