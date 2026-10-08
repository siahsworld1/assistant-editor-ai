// Read-only queries over a Sequence, shared by the command engine and the
// invariant checks so both use one definition of "end", "linked" and
// "overlap". Nothing here mutates or allocates ids.
import type { ClipItem, Sequence, Track, TransactionOrigin } from "./types";

/** Exclusive end of an item on the sequence. */
export function endFrame(item: ClipItem): number {
  return item.startFrame + item.durationFrames;
}

export function trackOf(seq: Sequence, item: ClipItem): Track | undefined {
  return seq.tracks.find((t) => t.id === item.trackId);
}

/** The item and every item linked to it (V1 picture + its A1), in a stable order. */
export function linkedIds(seq: Sequence, itemId: string): string[] {
  const item = seq.items[itemId];
  const group = item?.linkGroupId ? seq.links[item.linkGroupId] : undefined;
  return group ? [...group.itemIds] : [itemId];
}

/** Expands a selection to whole link groups, de-duplicated, order preserved. */
export function expandLinked(seq: Sequence, itemIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of itemIds)
    for (const linked of linkedIds(seq, id)) if (!out.includes(linked)) out.push(linked);
  return out;
}

/** Items on a track, by start frame (then id, for a total order). */
export function itemsOnTrack(seq: Sequence, trackId: string): ClipItem[] {
  return Object.values(seq.items)
    .filter((i) => i.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Pairs of items on the same track whose sequence ranges intersect. */
export function overlapsOnTrack(seq: Sequence, trackId: string): Array<[ClipItem, ClipItem]> {
  const items = itemsOnTrack(seq, trackId);
  const pairs: Array<[ClipItem, ClipItem]> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length && items[j]!.startFrame < endFrame(items[i]!); j += 1) {
      pairs.push([items[i]!, items[j]!]);
    }
  }
  return pairs;
}

/** Last frame covered by any item (the sequence's length in frames). */
export function sequenceEndFrame(seq: Sequence): number {
  return Object.values(seq.items).reduce((m, i) => Math.max(m, endFrame(i)), 0);
}

/** Is this item shaped by the filmmaker — or by someone we can't verify?
 * Manual or unknown ownership, or an item changed before ownership was
 * recorded (stamped by a transaction, no ownership): never the Director's. */
export function isOwnedAgainstDirector(item: ClipItem): boolean {
  return (
    item.editedBy === "manual" ||
    item.editedBy === "unknown" ||
    (item.editedBy === undefined && !!item.originTransactionId)
  );
}

/** The lock rules alone: `locked` (item or track) stops everyone; `aiLocked`
 * (item or track) stops the Director only. */
export function isLockedFrom(seq: Sequence, item: ClipItem, origin: TransactionOrigin): boolean {
  const track = trackOf(seq, item);
  if (item.protection.locked || track?.protection.locked) return true;
  return origin === "director" && (item.protection.aiLocked || !!track?.protection.aiLocked);
}

/**
 * May a transaction from `origin` change this item? The ONE predicate every
 * command guard, the transaction-level protection check and ReplaceAssembly's
 * keep-list consult. Locks as above — and a Director transaction may never
 * change anything the filmmaker shaped or whose ownership can't be verified
 * (directly, through linked audio, a ripple shift, a split or an assembly
 * replacement). There is no override.
 */
export function isProtectedFrom(seq: Sequence, item: ClipItem, origin: TransactionOrigin): boolean {
  return isLockedFrom(seq, item, origin) || (origin === "director" && isOwnedAgainstDirector(item));
}

/** May a transaction from `origin` add or remove items on this track? */
export function isTrackProtectedFrom(track: Track, origin: TransactionOrigin): boolean {
  return track.protection.locked || (origin === "director" && track.protection.aiLocked);
}
