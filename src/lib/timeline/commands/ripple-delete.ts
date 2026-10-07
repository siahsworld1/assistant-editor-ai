// RippleDelete: remove items on ONE track (plus their linked items) and close
// the gap across the whole sequence.
//
// Semantics (sequence-wide ripple):
//   - The removed interval(s) are the targets' sequence ranges on their track.
//   - Every remaining item that starts at or after a removed interval shifts
//     left by the total length removed before it — on EVERY track, so V2
//     cutaways stay over the same dialogue they covered.
//   - Items wholly before the interval do not move.
//   - A remaining item on another track that overlaps a removed interval (e.g.
//     a cutaway over the deleted words, or an A2 bed running across it) blocks
//     the ripple: the caller must include it in the delete or move it first.
//     Nothing is ever partially shifted or silently deleted.
//   - If any item that would have to shift is protected from this
//     transaction's origin, the whole ripple is rejected.
import { endFrame, expandLinked } from "../selectors";
import type { ClipItem, Sequence } from "../types";
import { requireEditable, requireItems } from "./guards";
import {
  changed,
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type RippleDeleteParams,
} from "./types";

function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function rippleDelete(
  seq: Sequence,
  p: RippleDeleteParams,
  ctx: CommandContext,
): CommandOutcome {
  if (!Array.isArray(p.itemIds) || p.itemIds.length === 0) {
    return fail("invalid-params", "RippleDelete needs item ids.");
  }
  const missing = requireItems(seq, p.itemIds);
  if (missing) return missing;
  const anchorTrack = seq.items[p.itemIds[0]!]!.trackId;
  if (p.itemIds.some((id) => seq.items[id]!.trackId !== anchorTrack)) {
    return fail(
      "invalid-params",
      "Ripple delete removes items from one track at a time.",
      p.itemIds,
    );
  }
  const removed = expandLinked(seq, p.itemIds);
  const locked = requireEditable(seq, removed, ctx);
  if (locked) return locked;

  const gaps = merge(p.itemIds.map((id) => [seq.items[id]!.startFrame, endFrame(seq.items[id]!)]));
  const removedSet = new Set(removed);
  const remaining = Object.values(seq.items).filter((i) => !removedSet.has(i.id));

  const blocking = remaining.filter((i) =>
    gaps.some(([a, b]) => i.startFrame < b && endFrame(i) > a),
  );
  if (blocking.length) {
    return fail(
      "ripple-blocked",
      `${blocking.map((i) => `"${i.label}"`).join(", ")} overlap${blocking.length === 1 ? "s" : ""} the removed range — include ${blocking.length === 1 ? "it" : "them"} in the delete or move ${blocking.length === 1 ? "it" : "them"} first.`,
      blocking.map((i) => i.id),
    );
  }

  const updates: Record<string, ClipItem | null> = Object.fromEntries(
    removed.map((id) => [id, null]),
  );
  const toShift: ClipItem[] = [];
  for (const item of remaining) {
    const shift = gaps
      .filter(([, b]) => b <= item.startFrame)
      .reduce((s, [a, b]) => s + (b - a), 0);
    if (shift > 0) {
      toShift.push(item);
      updates[item.id] = changed(item, ctx, { startFrame: item.startFrame - shift });
    }
  }
  const lockedShift = requireEditable(
    seq,
    toShift.map((i) => i.id),
    ctx,
  );
  if (lockedShift && !lockedShift.ok) {
    return fail(
      "protected",
      `The ripple would have to move protected material — ${lockedShift.error.message} Nothing was changed.`,
      lockedShift.error.itemIds,
    );
  }
  const linkIds = [
    ...new Set(removed.map((id) => seq.items[id]!.linkGroupId).filter((l): l is string => !!l)),
  ];
  const total = gaps.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    ok: true,
    sequence: withChanges(seq, updates, Object.fromEntries(linkIds.map((id) => [id, null]))),
    changedIds: [...removed, ...toShift.map((i) => i.id)],
    notes: [
      `Ripple-deleted ${removed.length} item(s); closed ${total} frames; shifted ${toShift.length} item(s).`,
    ],
  };
}
