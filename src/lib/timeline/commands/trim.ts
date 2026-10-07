// TrimEdit: move an item's in or out point within its source (media frames).
// The sequence length is recalculated by the one schema-2 rule
// (sequenceDurationFrames). Non-ripple: an out-trim keeps the item's start; an
// in-trim keeps the item's END where it is on the sequence (the start moves by
// the change in length). Linked items trim identically. Nothing else moves.
import { mediaEndFrame } from "../invariants";
import { endFrame, linkedIds } from "../selectors";
import { sequenceDurationFrames } from "../time";
import type { ClipItem, Sequence } from "../types";
import { rejectNewOverlaps, requireEditable, requireItems } from "./guards";
import {
  changed,
  fail,
  isInt,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type TrimEditParams,
} from "./types";

export function trimEdit(seq: Sequence, p: TrimEditParams, ctx: CommandContext): CommandOutcome {
  if (
    typeof p.itemId !== "string" ||
    (p.edge !== "in" && p.edge !== "out") ||
    !isInt(p.deltaSourceFrames)
  ) {
    return fail(
      "invalid-params",
      "TrimEdit needs an item, an edge (in|out) and a whole number of source frames.",
    );
  }
  const missing = requireItems(seq, [p.itemId]);
  if (missing) return missing;
  const ids = linkedIds(seq, p.itemId);
  const locked = requireEditable(seq, ids, ctx);
  if (locked) return locked;
  if (p.deltaSourceFrames === 0) return { ok: true, sequence: seq, changedIds: [], notes: [] };

  const updates: Record<string, ClipItem> = {};
  let note = "";
  for (const id of ids) {
    const item = seq.items[id]!;
    const sourceInFrame = item.sourceInFrame + (p.edge === "in" ? p.deltaSourceFrames : 0);
    const sourceOutFrame = item.sourceOutFrame + (p.edge === "out" ? p.deltaSourceFrames : 0);
    if (sourceInFrame < 0)
      return fail("out-of-bounds", `"${item.label}" cannot start before its media.`, [id]);
    if (sourceOutFrame <= sourceInFrame) {
      return fail(
        "invalid-range",
        `Trimming "${item.label}" that far would leave no source frames.`,
        [id],
      );
    }
    const mediaEnd = mediaEndFrame(item, ctx.media);
    if (mediaEnd !== null && sourceOutFrame > mediaEnd) {
      return fail("out-of-bounds", `"${item.label}" cannot extend past the end of its media.`, [
        id,
      ]);
    }
    const durationFrames = sequenceDurationFrames(
      sourceInFrame,
      sourceOutFrame,
      item.mediaRate,
      seq.rate,
    );
    const startFrame = p.edge === "in" ? endFrame(item) - durationFrames : item.startFrame;
    if (startFrame < 0)
      return fail("out-of-bounds", `"${item.label}" would start before the sequence.`, [id]);
    updates[id] = changed(item, ctx, { sourceInFrame, sourceOutFrame, durationFrames, startFrame });
    note ||= `Trimmed "${item.label}" ${p.edge} by ${p.deltaSourceFrames} source frames (${item.durationFrames} → ${durationFrames} sequence frames).`;
  }
  const next = withChanges(seq, updates);
  const overlap = rejectNewOverlaps(
    seq,
    next,
    ids.map((id) => seq.items[id]!.trackId),
  );
  if (overlap) return overlap;
  return { ok: true, sequence: next, changedIds: ids, notes: [note] };
}
