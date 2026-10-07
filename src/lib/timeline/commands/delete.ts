// DeleteEdit (lift): remove items and leave their gap.
// Linked deletion rule (explicit): deleting any member of a link group deletes
// the whole group — a V1 picture and its A1 sync audio go together, so no
// orphaned sync audio is ever left behind. (Unlinking first will be the way to
// delete one side only, once UnlinkItems exists.)
import { expandLinked } from "../selectors";
import type { Sequence } from "../types";
import { requireEditable, requireItems } from "./guards";
import {
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type DeleteEditParams,
} from "./types";

export function deleteEdit(
  seq: Sequence,
  p: DeleteEditParams,
  ctx: CommandContext,
): CommandOutcome {
  if (!Array.isArray(p.itemIds) || p.itemIds.length === 0) {
    return fail("invalid-params", "DeleteEdit needs item ids.");
  }
  const missing = requireItems(seq, p.itemIds);
  if (missing) return missing;
  const ids = expandLinked(seq, p.itemIds);
  const locked = requireEditable(seq, ids, ctx);
  if (locked) return locked;
  const linkIds = [
    ...new Set(ids.map((id) => seq.items[id]!.linkGroupId).filter((l): l is string => !!l)),
  ];
  return {
    ok: true,
    sequence: withChanges(
      seq,
      Object.fromEntries(ids.map((id) => [id, null])),
      Object.fromEntries(linkIds.map((id) => [id, null])),
    ),
    changedIds: ids,
    notes: [`Lifted ${ids.length} item${ids.length > 1 ? "s" : ""}.`],
  };
}
