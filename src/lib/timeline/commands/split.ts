// SplitEdit: blade an item (and its linked items) at an exact sequence frame.
//   - The two pieces exactly cover the original sequence range:
//     left [start, at), right [at, end) — no gap, no overlap.
//   - Their source ranges are contiguous: left [in, s), right [s, out).
//   - The right pieces get the ids generated when the command was built; the
//     left piece keeps the original id. Linked pieces stay linked: left pieces
//     in the original link, right pieces in a new one.
// The split point `s` is the source frame whose position on the timecode clock
// gives the left piece exactly `at − start` sequence frames under the schema-2
// rule (or, if no source frame does, the nearest); among those, one that also
// gives the right piece exactly `end − at` is preferred. Both pieces keep the
// item's read-only source-label provenance (it only ever applies to an
// endpoint still at its imported frame: the left piece's in, the right's out).
import { endFrame, linkedIds } from "../selectors";
import { rescaleFrames, sequenceDurationFrames } from "../time";
import type { ClipItem, LinkGroup, Sequence } from "../types";
import { requireEditable, requireItems } from "./guards";
import {
  changed,
  fail,
  isInt,
  withChanges,
  type CommandContext,
  type CommandOutcome,
  type SplitEditParams,
} from "./types";

/** The source frame at `offset` sequence frames into `item` (deterministic). */
export function splitSourceFrame(item: ClipItem, offset: number, seq: Sequence): number {
  const guess = item.sourceInFrame + rescaleFrames(offset, seq.rate, item.mediaRate);
  const hints = item.sourceTcProvenance;
  const rightLength = item.durationFrames - offset;
  let best = guess;
  let bestKey: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let d = -3; d <= 3; d += 1) {
    const s = guess + d;
    if (s <= item.sourceInFrame || s >= item.sourceOutFrame) continue;
    const left = sequenceDurationFrames(item.sourceInFrame, s, item.mediaRate, seq.rate, {
      in: hints?.in,
    });
    const right = sequenceDurationFrames(s, item.sourceOutFrame, item.mediaRate, seq.rate, {
      out: hints?.out,
    });
    // Left piece exact first, then right piece exact, then nearest the guess.
    const key: [number, number, number] = [
      Math.abs(left - offset),
      Math.abs(right - rightLength),
      Math.abs(d),
    ];
    if (
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] &&
        (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
    ) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

export function splitEdit(seq: Sequence, p: SplitEditParams, ctx: CommandContext): CommandOutcome {
  if (typeof p.itemId !== "string" || !isInt(p.atFrame) || !p.rightItemIds || !p.rightLinkIds) {
    return fail("invalid-params", "SplitEdit needs an item, a whole frame and pre-generated ids.");
  }
  const missing = requireItems(seq, [p.itemId]);
  if (missing) return missing;
  const ids = linkedIds(seq, p.itemId);
  const locked = requireEditable(seq, ids, ctx);
  if (locked) return locked;
  const anchor = seq.items[p.itemId]!;
  if (!(p.atFrame > anchor.startFrame && p.atFrame < endFrame(anchor))) {
    return fail("invalid-params", `Frame ${p.atFrame} is not inside "${anchor.label}".`, [
      p.itemId,
    ]);
  }
  for (const id of ids) {
    const rightId = p.rightItemIds[id];
    if (!rightId)
      return fail("invalid-params", `No id was generated for the split of ${id}.`, [id]);
    if (seq.items[rightId])
      return fail("invalid-params", `Generated id ${rightId} is already in use.`, [rightId]);
  }
  const offset = p.atFrame - anchor.startFrame;

  const items: Record<string, ClipItem> = {};
  const links: Record<string, LinkGroup> = {};
  for (const id of ids) {
    const item = seq.items[id]!;
    const s = splitSourceFrame(item, offset, seq);
    if (!(s > item.sourceInFrame && s < item.sourceOutFrame)) {
      return fail("invalid-range", `"${item.label}" is too short to split at frame ${p.atFrame}.`, [
        id,
      ]);
    }
    const rightLink = item.linkGroupId ? p.rightLinkIds[item.linkGroupId] : undefined;
    if (item.linkGroupId && !rightLink)
      return fail("invalid-params", `No link id was generated for ${id}.`, [id]);
    items[id] = changed(item, ctx, { sourceOutFrame: s, durationFrames: offset });
    const { legacy: _provenance, ...rest } = item; // the right piece is new material
    items[p.rightItemIds[id]!] = changed(
      { ...rest, id: p.rightItemIds[id]!, linkGroupId: rightLink },
      ctx,
      { startFrame: p.atFrame, sourceInFrame: s, durationFrames: endFrame(item) - p.atFrame },
    );
    if (!rightLink) delete items[p.rightItemIds[id]!]!.linkGroupId;
    if (item.linkGroupId && rightLink && !links[rightLink]) {
      links[rightLink] = {
        id: rightLink,
        itemIds: seq.links[item.linkGroupId]!.itemIds.map((m) => p.rightItemIds[m]!),
      };
    }
  }
  return {
    ok: true,
    sequence: withChanges(seq, items, links),
    changedIds: [...ids, ...ids.map((id) => p.rightItemIds[id]!)],
    notes: [`Split "${anchor.label}" at frame ${p.atFrame}.`],
  };
}
