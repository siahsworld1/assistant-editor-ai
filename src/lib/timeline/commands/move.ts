// MoveEdit: change where items sit on the sequence. Sequence frames only —
// the source range and `durationFrames` never change. Linked items (a V1
// picture's A1 sync audio) move with it; nothing else moves.
import { expandLinked } from "../selectors";
import type { Sequence } from "../types";
import { rejectNewOverlaps, requireEditable, requireItems } from "./guards";
import {
  changed,
  fail,
  isInt,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type MoveEditParams,
} from "./types";

export function moveEdit(seq: Sequence, p: MoveEditParams, ctx: CommandContext): CommandOutcome {
  if (!Array.isArray(p.itemIds) || p.itemIds.length === 0 || !isInt(p.deltaFrames)) {
    return fail("invalid-params", "MoveEdit needs item ids and a whole number of frames.");
  }
  const missing = requireItems(seq, p.itemIds);
  if (missing) return missing;
  const ids = expandLinked(seq, p.itemIds);
  const locked = requireEditable(seq, ids, ctx);
  if (locked) return locked;
  if (p.deltaFrames === 0) return { ok: true, sequence: seq, changedIds: [], notes: [] };

  const updates: Record<string, ReturnType<typeof changed>> = {};
  for (const id of ids) {
    const item = seq.items[id]!;
    const startFrame = item.startFrame + p.deltaFrames;
    if (startFrame < 0)
      return fail("out-of-bounds", `"${item.label}" would start before the sequence.`, [id]);
    updates[id] = changed(item, ctx, { startFrame });
  }
  const next = withChanges(seq, updates);
  const overlap = rejectNewOverlaps(
    seq,
    next,
    ids.map((id) => seq.items[id]!.trackId),
  );
  if (overlap) return overlap;
  return {
    ok: true,
    sequence: next,
    changedIds: ids,
    notes: [`Moved ${ids.length} item${ids.length > 1 ? "s" : ""} by ${p.deltaFrames} frames.`],
  };
}
