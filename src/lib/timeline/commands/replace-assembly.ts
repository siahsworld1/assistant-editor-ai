// ReplaceAssembly: a complete assembly (e.g. a Director build) entering the
// SAME command/transaction/history path as manual edits — not a special
// mutation path. It replaces every item the transaction's origin may change and
// keeps every item it may not (locked, or aiLocked for a Director transaction),
// so manual work the user protected survives a rebuild. Inserted items must
// fit around what is kept; overlaps are rejected by the invariant check.
//
// `assemblyFromLegacy` builds the params from a schema-1 Director result,
// generating every id exactly once.
import type { Clip, UniversalTimeline } from "@/lib/ae/types";
import type { IdGenerator } from "../ids";
import { fingerprintOf, legacyToSequence } from "../legacy-adapter";
import { isProtectedFrom } from "../selectors";
import type { ClipItem, LinkGroup, Origin, Sequence } from "../types";
import {
  changed,
  fail,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type ReplaceAssemblyParams,
} from "./types";

export function replaceAssembly(
  seq: Sequence,
  p: ReplaceAssemblyParams,
  ctx: CommandContext,
): CommandOutcome {
  if (!Array.isArray(p.items) || !Array.isArray(p.links)) {
    return fail("invalid-params", "ReplaceAssembly needs items and links.");
  }
  const trackIds = new Set(seq.tracks.map((t) => t.id));
  const badTrack = p.items.find((i) => !trackIds.has(i.trackId));
  if (badTrack)
    return fail("unknown-track", `"${badTrack.label}" targets a track this cut does not have.`, [
      badTrack.id,
    ]);

  const kept = Object.values(seq.items).filter((i) => isProtectedFrom(seq, i, ctx.origin));
  const keptIds = new Set(kept.map((i) => i.id));
  const clash = p.items.find((i) => keptIds.has(i.id));
  if (clash)
    return fail("invalid-params", `Assembly item id ${clash.id} collides with a protected item.`, [
      clash.id,
    ]);
  const dup = p.items.find((i, n) => p.items.findIndex((j) => j.id === i.id) !== n);
  if (dup) return fail("invalid-params", `Assembly item id ${dup.id} is used twice.`, [dup.id]);

  const items: Record<string, ClipItem | null> = {};
  for (const item of Object.values(seq.items)) if (!keptIds.has(item.id)) items[item.id] = null;
  for (const item of p.items) items[item.id] = changed(item, ctx, {});
  const links: Record<string, LinkGroup | null> = {};
  for (const link of Object.values(seq.links)) {
    if (!link.itemIds.every((id) => keptIds.has(id))) links[link.id] = null;
  }
  for (const link of p.links) links[link.id] = { ...link, itemIds: [...link.itemIds] };

  const removed = Object.keys(items).filter((id) => items[id] === null);
  return {
    ok: true,
    sequence: withChanges(seq, items, links),
    changedIds: [...removed, ...p.items.map((i) => i.id)],
    notes: [
      `Replaced the assembly: ${p.items.length} item(s) in, ${removed.length} out, ${kept.length} protected kept.`,
    ],
  };
}

/**
 * ReplaceAssembly params from a schema-1 assembly (the Director's /build
 * result): imported through the legacy adapter (so an untouched build still
 * exports byte-identically to beta.1), mapped onto `target`'s tracks by name,
 * and given fresh ids from `ids` — generated here, once.
 */
export function assemblyFromLegacy(
  target: Sequence,
  timeline: UniversalTimeline,
  clips: ReadonlyArray<Pick<Clip, "id" | "fps">>,
  ids: IdGenerator,
  origin: Origin = "director",
): ReplaceAssemblyParams {
  const built = legacyToSequence(timeline, clips, { origin });
  const trackByName = new Map(target.tracks.map((t) => [t.name, t.id]));
  const builtName = new Map(built.tracks.map((t) => [t.id, t.name]));
  const itemId = new Map(Object.keys(built.items).map((id) => [id, ids.next("item")]));
  const linkId = new Map(Object.keys(built.links).map((id) => [id, ids.next("link")]));
  const items = Object.values(built.items).map((item) => {
    const mapped: ClipItem = {
      ...item,
      id: itemId.get(item.id)!,
      trackId: trackByName.get(builtName.get(item.trackId)!) ?? item.trackId,
      ...(item.linkGroupId ? { linkGroupId: linkId.get(item.linkGroupId)! } : {}),
    };
    if (mapped.legacy) mapped.legacy = { ...mapped.legacy, fingerprint: fingerprintOf(mapped) };
    return mapped;
  });
  const links = Object.values(built.links).map((l) => ({
    id: linkId.get(l.id)!,
    itemIds: l.itemIds.map((m) => itemId.get(m)!),
  }));
  return { items, links };
}
