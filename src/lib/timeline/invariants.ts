// Centralised validation of the canonical model. Every transaction is checked
// here before it is committed (see ./transactions.ts):
//   - structural invariants (`findViolations`) — ids, positions, durations,
//     source ranges, tracks, media, same-track overlaps, link alignment;
//   - protection (`protectionViolations`) — nothing `locked` changed, and for a
//     Director transaction nothing `aiLocked` changed.
//
// A transaction is rejected only for violations it INTRODUCES
// (`introducedViolations`): a cut imported from beta.1 may already contain,
// say, a V2 overlap, and that must not make every later edit impossible.
// Pre-existing violations are tolerated, never made worse silently, and are
// reported by `findViolations` for the UI to surface.
import { isProtectedFrom, isTrackProtectedFrom, overlapsOnTrack } from "./selectors";
import { secondsToFrames } from "./time";
import type { ClipItem, Sequence, TransactionOrigin } from "./types";

export type ViolationCode =
  | "duplicate-id"
  | "id-mismatch"
  | "bad-position"
  | "bad-duration"
  | "bad-source-range"
  | "missing-track"
  | "missing-media"
  | "out-of-media-bounds"
  | "overlap"
  | "link-missing-item"
  | "link-membership"
  | "link-misaligned"
  | "protected-change";

export interface Violation {
  code: ViolationCode;
  message: string;
  ids: string[];
  /** Stable identity of the violation, for before/after comparison. */
  key: string;
}

/** Media the timeline may reference: clip id → its length. */
export type MediaInventory = ReadonlyMap<string, { durationSeconds: number }>;

export interface ValidationContext {
  media?: MediaInventory | undefined;
}

const isNonNegInt = (n: number) => Number.isInteger(n) && n >= 0;

function v(code: ViolationCode, message: string, ids: string[]): Violation {
  return { code, message, ids, key: `${code}:${[...ids].sort().join(",")}` };
}

/** The media frame an item's source out point may not exceed, when known. */
export function mediaEndFrame(item: ClipItem, media: MediaInventory | undefined): number | null {
  const m = media?.get(item.mediaClipId);
  if (!m || !(m.durationSeconds > 0)) return null;
  return secondsToFrames(m.durationSeconds, item.mediaRate);
}

export function findViolations(seq: Sequence, ctx: ValidationContext = {}): Violation[] {
  const out: Violation[] = [];

  // Identity: every id unique across the whole sequence, and keyed correctly.
  const seen = new Map<string, number>();
  const ids = [
    seq.id,
    ...seq.tracks.map((t) => t.id),
    ...Object.keys(seq.items),
    ...Object.keys(seq.links),
  ];
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, n] of seen)
    if (n > 1) out.push(v("duplicate-id", `id "${id}" is used ${n} times`, [id]));
  for (const [key, item] of Object.entries(seq.items)) {
    if (item.id !== key)
      out.push(v("id-mismatch", `item stored under "${key}" has id "${item.id}"`, [key]));
  }
  for (const [key, link] of Object.entries(seq.links)) {
    if (link.id !== key)
      out.push(v("id-mismatch", `link stored under "${key}" has id "${link.id}"`, [key]));
  }

  const trackIds = new Set(seq.tracks.map((t) => t.id));
  for (const item of Object.values(seq.items)) {
    if (!isNonNegInt(item.startFrame)) {
      out.push(v("bad-position", `"${item.label}" starts at ${item.startFrame}`, [item.id]));
    }
    if (!Number.isInteger(item.durationFrames) || item.durationFrames < 1) {
      out.push(v("bad-duration", `"${item.label}" lasts ${item.durationFrames} frames`, [item.id]));
    }
    if (
      !isNonNegInt(item.sourceInFrame) ||
      !Number.isInteger(item.sourceOutFrame) ||
      item.sourceOutFrame <= item.sourceInFrame
    ) {
      out.push(
        v(
          "bad-source-range",
          `"${item.label}" source ${item.sourceInFrame}–${item.sourceOutFrame}`,
          [item.id],
        ),
      );
    }
    if (!trackIds.has(item.trackId)) {
      out.push(
        v("missing-track", `"${item.label}" is on unknown track "${item.trackId}"`, [item.id]),
      );
    }
    if (ctx.media) {
      if (!ctx.media.has(item.mediaClipId)) {
        out.push(
          v("missing-media", `"${item.label}" uses unknown media "${item.mediaClipId}"`, [item.id]),
        );
      } else {
        const end = mediaEndFrame(item, ctx.media);
        if (end !== null && item.sourceOutFrame > end) {
          out.push(
            v(
              "out-of-media-bounds",
              `"${item.label}" source out ${item.sourceOutFrame} is past the media end ${end}`,
              [item.id],
            ),
          );
        }
      }
    }
  }

  for (const track of seq.tracks) {
    for (const [a, b] of overlapsOnTrack(seq, track.id)) {
      out.push(
        v("overlap", `"${a.label}" and "${b.label}" overlap on ${track.name}`, [a.id, b.id]),
      );
    }
  }

  // Links: members exist and point back to their group; Phase 1 links (picture
  // + sync audio) are frame-aligned. (J/L cuts will add an explicit offset.)
  for (const link of Object.values(seq.links)) {
    const members = link.itemIds.map((id) => seq.items[id]);
    if (members.some((m) => !m) || link.itemIds.length < 2) {
      out.push(v("link-missing-item", `link "${link.id}" references missing items`, [link.id]));
      continue;
    }
    for (const m of members) {
      if (m!.linkGroupId !== link.id)
        out.push(v("link-membership", `"${m!.label}" is not marked as in its link`, [m!.id]));
    }
    const [first, ...rest] = members as ClipItem[];
    for (const m of rest) {
      const aligned =
        m.startFrame === first!.startFrame &&
        m.durationFrames === first!.durationFrames &&
        m.sourceInFrame === first!.sourceInFrame &&
        m.sourceOutFrame === first!.sourceOutFrame &&
        m.mediaClipId === first!.mediaClipId;
      if (!aligned)
        out.push(
          v("link-misaligned", `"${m.label}" is out of sync with its link`, [first!.id, m.id]),
        );
    }
  }
  for (const item of Object.values(seq.items)) {
    if (item.linkGroupId && !seq.links[item.linkGroupId]?.itemIds.includes(item.id)) {
      out.push(v("link-membership", `"${item.label}" names a link it is not in`, [item.id]));
    }
  }
  return out;
}

function sameItem(a: ClipItem, b: ClipItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Changes `origin` was not allowed to make between `before` and `after`. */
export function protectionViolations(
  before: Sequence,
  after: Sequence,
  origin: TransactionOrigin,
): Violation[] {
  const out: Violation[] = [];
  for (const item of Object.values(before.items)) {
    if (!isProtectedFrom(before, item, origin)) continue;
    const now = after.items[item.id];
    if (!now || !sameItem(item, now)) {
      out.push(
        v("protected-change", `"${item.label}" is protected from ${origin} changes`, [item.id]),
      );
    }
  }
  for (const item of Object.values(after.items)) {
    if (before.items[item.id]) continue;
    const track = before.tracks.find((t) => t.id === item.trackId);
    if (track && isTrackProtectedFrom(track, origin)) {
      out.push(
        v("protected-change", `${track.name} is protected from ${origin} changes`, [item.id]),
      );
    }
  }
  return out;
}

/** Violations present after a change that were not present before it. */
export function introducedViolations(
  before: Sequence,
  after: Sequence,
  ctx: ValidationContext = {},
): Violation[] {
  const existing = new Set(findViolations(before, ctx).map((x) => x.key));
  return findViolations(after, ctx).filter((x) => !existing.has(x.key));
}
