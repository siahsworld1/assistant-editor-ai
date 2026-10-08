// SetProtection: lock / unlock items, or turn AI protection on / off.
//   - Only the filmmaker may change protection: a Director or system
//     transaction is refused (the AI can never unlock or un-protect anything).
//   - Applies to every linked partner too (a V1 picture and its A1 sync audio
//     are protected together).
//   - Respects track protection: an item on a locked track can't be changed
//     until the track is unlocked.
//   - Changes ONLY `protection`. It is not an edit of the material, so it
//     neither stamps the item nor changes its ownership: locking a Director
//     clip doesn't make it manual, and unlocking it doesn't either.
import { expandLinked } from "../selectors";
import type { ClipItem, Sequence } from "../types";
import { requireItems } from "./guards";
import {
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type SetProtectionParams,
} from "./types";

export function setProtection(
  seq: Sequence,
  p: SetProtectionParams,
  ctx: CommandContext,
): CommandOutcome {
  const flag = (v: unknown) => v === undefined || typeof v === "boolean";
  if (
    !Array.isArray(p.itemIds) ||
    p.itemIds.length === 0 ||
    !flag(p.locked) ||
    !flag(p.aiLocked) ||
    (p.locked === undefined && p.aiLocked === undefined)
  ) {
    return fail(
      "invalid-params",
      "SetProtection needs item ids and at least one of locked / aiLocked (true or false).",
    );
  }
  if (ctx.origin !== "manual") {
    return fail("protected", "Only the filmmaker can change protection.", [...p.itemIds]);
  }
  const missing = requireItems(seq, p.itemIds);
  if (missing) return missing;
  const ids = expandLinked(seq, p.itemIds);
  const onLockedTrack = ids.filter(
    (id) => seq.tracks.find((t) => t.id === seq.items[id]!.trackId)?.protection.locked,
  );
  if (onLockedTrack.length) {
    return fail(
      "protected",
      "These clips are on a locked track — unlock the track first.",
      onLockedTrack,
    );
  }
  const updates: Record<string, ClipItem> = {};
  for (const id of ids) {
    const item = seq.items[id]!;
    const protection = {
      locked: p.locked ?? item.protection.locked,
      aiLocked: p.aiLocked ?? item.protection.aiLocked,
    };
    if (
      protection.locked !== item.protection.locked ||
      protection.aiLocked !== item.protection.aiLocked
    ) {
      updates[id] = { ...item, protection };
    }
  }
  const changedIds = Object.keys(updates);
  if (!changedIds.length) return { ok: true, sequence: seq, changedIds: [], notes: [] };
  const what = [
    p.locked === undefined ? null : p.locked ? "locked" : "unlocked",
    p.aiLocked === undefined ? null : p.aiLocked ? "protected from AI" : "open to AI",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    ok: true,
    sequence: withChanges(seq, updates),
    changedIds,
    notes: [`${changedIds.length} item(s) ${what}.`],
  };
}
