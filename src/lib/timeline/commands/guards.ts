// Checks shared by the commands, so each rejects with a precise, typed reason
// instead of leaving it to the transaction-level invariant check (which still
// runs afterwards as the safety net).
import { isProtectedFrom, overlapsOnTrack } from "../selectors";
import type { Sequence } from "../types";
import { fail, type CommandContext, type CommandOutcome } from "./types";

/** Rejects if any item is missing. */
export function requireItems(seq: Sequence, ids: readonly string[]): CommandOutcome | null {
  const missing = ids.filter((id) => !seq.items[id]);
  return missing.length
    ? fail("unknown-item", `No such item: ${missing.join(", ")}`, missing)
    : null;
}

/** Rejects if `ctx.origin` may not change any of these items. */
export function requireEditable(
  seq: Sequence,
  ids: readonly string[],
  ctx: CommandContext,
): CommandOutcome | null {
  const blocked = ids.filter((id) => isProtectedFrom(seq, seq.items[id]!, ctx.origin));
  if (!blocked.length) return null;
  const who = ctx.origin === "director" ? "the Director" : "editing";
  return fail(
    "protected",
    `${blocked.map((id) => `"${seq.items[id]!.label}"`).join(", ")} ${blocked.length > 1 ? "are" : "is"} locked against ${who}.`,
    blocked,
  );
}

/** Rejects if `next` has a same-track overlap that `prev` did not. */
export function rejectNewOverlaps(
  prev: Sequence,
  next: Sequence,
  trackIds: Iterable<string>,
): CommandOutcome | null {
  for (const trackId of new Set(trackIds)) {
    const before = new Set(overlapsOnTrack(prev, trackId).map(([a, b]) => `${a.id}|${b.id}`));
    for (const [a, b] of overlapsOnTrack(next, trackId)) {
      if (before.has(`${a.id}|${b.id}`) || before.has(`${b.id}|${a.id}`)) continue;
      const track = next.tracks.find((t) => t.id === trackId);
      return fail(
        "overlap",
        `"${a.label}" would overlap "${b.label}" on ${track?.name ?? "its track"}.`,
        [a.id, b.id],
      );
    }
  }
  return null;
}
