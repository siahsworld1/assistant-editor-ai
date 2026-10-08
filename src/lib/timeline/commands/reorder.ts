// ReorderEdit: put a back-to-back run of items on ONE track into a new order.
//
// Semantics (conservative — Phase 6, Milestone 1):
//   - `itemIds` is the run in its NEW order: an exact permutation of items that
//     sit back to back on one track, with nothing else of that track between
//     them. The run is repacked from its first frame in the new order, so its
//     length, and everything before and after it, stays where it is.
//   - Only start frames change. Ids, source ranges and durations never do.
//   - Linked partners (a V1 picture's A1 sync audio) move with their item.
//   - Material on other tracks that lies wholly inside ONE run item (and whose
//     linked partners do too) moves with that item, at the same offset — it
//     stays over the same words.
//   - Material on other tracks that spans the whole run (a music bed) stays.
//   - Anything else that overlaps the run — a cutaway across a cut point, a
//     bed that starts or ends inside the run — blocks the reorder. Nothing is
//     ever deleted, trimmed or repositioned on its own; the caller must deal
//     with that material first.
//   - Every item named, every linked partner and everything carried along must
//     be editable by the transaction's origin, or the whole reorder is
//     rejected. A Director transaction can never move the filmmaker's edits.
import { endFrame, expandLinked, itemsOnTrack } from "../selectors";
import type { ClipItem, Sequence } from "../types";
import { rejectNewOverlaps, requireEditable, requireItems } from "./guards";
import {
  changed,
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type ReorderEditParams,
} from "./types";

export function reorderEdit(
  seq: Sequence,
  p: ReorderEditParams,
  ctx: CommandContext,
): CommandOutcome {
  if (
    !Array.isArray(p.itemIds) ||
    p.itemIds.length < 2 ||
    p.itemIds.some((id) => typeof id !== "string")
  ) {
    return fail("invalid-params", "ReorderEdit needs at least two item ids, in their new order.");
  }
  if (new Set(p.itemIds).size !== p.itemIds.length) {
    return fail("invalid-params", "Each item may appear only once in the new order.");
  }
  const missing = requireItems(seq, p.itemIds);
  if (missing) return missing;

  const trackId = seq.items[p.itemIds[0]!]!.trackId;
  if (p.itemIds.some((id) => seq.items[id]!.trackId !== trackId)) {
    return fail("invalid-params", "A reorder works on one track at a time.", p.itemIds);
  }

  // The run as it is now: back to back, nothing else of the track inside it.
  const named = new Set(p.itemIds);
  const current = itemsOnTrack(seq, trackId).filter((i) => named.has(i.id));
  for (let i = 1; i < current.length; i += 1) {
    if (current[i]!.startFrame !== endFrame(current[i - 1]!)) {
      return fail(
        "invalid-params",
        `"${current[i - 1]!.label}" and "${current[i]!.label}" are not back to back — only a contiguous run can be reordered.`,
        [current[i - 1]!.id, current[i]!.id],
      );
    }
  }
  const runStart = current[0]!.startFrame;
  const runEnd = endFrame(current[current.length - 1]!);
  const runItemIds = new Set(current.map((i) => i.id));

  // New position of every run item.
  const delta = new Map<string, number>();
  let at = runStart;
  for (const id of p.itemIds) {
    const it = seq.items[id]!;
    delta.set(id, at - it.startFrame);
    at += it.durationFrames;
  }
  if ([...delta.values()].every((d) => d === 0)) {
    return { ok: true, sequence: seq, changedIds: [], notes: ["Already in that order."] };
  }

  // Linked partners follow their item.
  const follows = new Map<string, number>();
  for (const id of p.itemIds) {
    for (const linked of expandLinked(seq, [id])) {
      if (runItemIds.has(linked)) continue;
      follows.set(linked, delta.get(id)!);
    }
  }

  // Other material over the run: carried, untouched, or blocking.
  const hostOf = (it: ClipItem) =>
    current.find((h) => h.startFrame <= it.startFrame && endFrame(it) <= endFrame(h));
  const blocking: ClipItem[] = [];
  const carried = new Map<string, number>();
  for (const it of Object.values(seq.items)) {
    if (it.trackId === trackId || runItemIds.has(it.id) || follows.has(it.id)) continue;
    if (endFrame(it) <= runStart || it.startFrame >= runEnd) continue; // outside the run
    if (it.startFrame <= runStart && endFrame(it) >= runEnd) continue; // spans it all: stays
    const host = hostOf(it);
    const group = expandLinked(seq, [it.id]);
    if (!host || group.some((m) => hostOf(seq.items[m]!)?.id !== host.id)) {
      blocking.push(it);
      continue;
    }
    for (const m of group) carried.set(m, delta.get(host.id)!);
  }
  if (blocking.length) {
    const names = blocking.map((i) => `"${i.label}"`).join(", ");
    const one = blocking.length === 1;
    return fail(
      "reorder-blocked",
      `${names} ${one ? "crosses" : "cross"} a cut inside the reordered run and can't move with one clip — remove or move ${one ? "it" : "them"} first. Nothing was changed.`,
      blocking.map((i) => i.id),
    );
  }

  // Protection: everything named, every partner, everything displaced.
  const moving = new Map<string, number>([...delta, ...follows, ...carried]);
  const mustBeEditable = [...moving].filter(([id, d]) => runItemIds.has(id) || d !== 0);
  const locked = requireEditable(
    seq,
    expandLinked(
      seq,
      mustBeEditable.map(([id]) => id),
    ),
    ctx,
  );
  if (locked) return locked;

  const updates: Record<string, ClipItem> = {};
  for (const [id, d] of moving) {
    if (d === 0) continue;
    const it = seq.items[id]!;
    updates[id] = changed(it, ctx, { startFrame: it.startFrame + d });
  }
  const next = withChanges(seq, updates);
  const overlap = rejectNewOverlaps(
    seq,
    next,
    Object.keys(updates).map((id) => seq.items[id]!.trackId),
  );
  if (overlap) return overlap;
  const others = Object.keys(updates).filter((id) => !runItemIds.has(id)).length;
  return {
    ok: true,
    sequence: next,
    changedIds: Object.keys(updates),
    notes: [
      `Reordered ${p.itemIds.length} items; ${others} linked or carried item${others === 1 ? "" : "s"} moved with them.`,
    ],
  };
}
