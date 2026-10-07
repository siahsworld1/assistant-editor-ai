// Shared helpers for the command-engine tests. Every sequence handed to the
// engine is deep-frozen, so any attempt to mutate an input throws.
import type { Clip } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import { seededIds, type IdGenerator } from "@/lib/timeline/ids";
import type { MediaInventory } from "@/lib/timeline/invariants";
import { legacyToSequence } from "@/lib/timeline/legacy-adapter";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { ClipItem, Command, Sequence, TransactionOrigin } from "@/lib/timeline/types";
import { directorCut, projectClips } from "./legacy-fixtures";

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function mediaOf(clips: Clip[]): MediaInventory {
  return new Map(clips.map((c) => [c.id, { durationSeconds: c.durationSeconds }]));
}

export const media = mediaOf(projectClips);

/** The v1.2-shaped Director cut: 24 fps sequence of 23.976 media.
 *   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
 *   V2: e4 420–532 (over e3) · e7 708–784 (over e6)
 *   A1: aligned with every V1 item. */
export function directorSequence(): Sequence {
  return deepFreeze(legacyToSequence(directorCut, projectClips, { scope: "test" }));
}

export function item(seq: Sequence, decisionId: string): ClipItem {
  const found = Object.values(seq.items).find((i) => i.legacy?.decision.id === decisionId);
  if (!found) throw new Error(`no item for ${decisionId}`);
  return found;
}

export function partner(seq: Sequence, it: ClipItem): ClipItem {
  const group = seq.links[it.linkGroupId!]!;
  return seq.items[group.itemIds.find((id) => id !== it.id)!]!;
}

export function track(seq: Sequence, name: string) {
  return seq.tracks.find((t) => t.name === name)!;
}

export function run(
  seq: Sequence,
  origin: TransactionOrigin,
  build: (ids: IdGenerator) => Command[],
  ids: IdGenerator = seededIds("test"),
) {
  const txn = makeTransaction(ids, "test", origin, build(ids), "2026-01-01T00:00:00.000Z");
  return { txn, outcome: applyTransaction(seq, txn, { media }) };
}

/** A copy of `seq` with protection set on one item or track (test setup only). */
export function protect(
  seq: Sequence,
  target: { itemId?: string; trackName?: string },
  protection: { locked?: boolean; aiLocked?: boolean },
): Sequence {
  const next = structuredClone(seq) as Sequence;
  if (target.itemId) {
    const it = next.items[target.itemId]!;
    it.protection = { ...it.protection, ...protection };
  }
  if (target.trackName) {
    const t = next.tracks.find((x) => x.name === target.trackName)!;
    t.protection = { ...t.protection, ...protection };
  }
  return deepFreeze(next);
}

export { commands };
