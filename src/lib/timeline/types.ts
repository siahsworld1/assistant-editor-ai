// Canonical edit model for the CUT timeline (schema 2).
//
// One model for everything that touches a cut — manual editing, the Director,
// playback, persistence and the NLE exporters. There are no separate "AI" and
// "manual" timelines.
//
// Source of truth: integer frames, in two separate time domains.
//   - Source domain, at the MEDIA's own rate (`ClipItem.mediaRate`):
//     `sourceInFrame`, `sourceOutFrame` (exclusive).
//   - Sequence domain, at the SEQUENCE rate (`Sequence.rate`):
//     `startFrame`, `durationFrames`.
//   The two domains are different clocks (e.g. 23.976 media on a 24 fps
//   sequence: 239 source frames occupy 240 sequence frames), so the sequence
//   length is stored, not re-derived on the fly. It changes only when the
//   source range changes, through the one conversion rule in ./time.ts
//   (`sequenceDurationFrames`). Moving an item changes `startFrame` only.
//   A sequence's rate never changes as a side effect of editing.
//
// Legacy (schema-1) data is imported once through ./legacy-adapter.ts. The
// timecode strings it came with are kept only as read-only provenance
// (`LegacyItemProvenance`) so an item that has not been edited exports exactly
// as beta.1 did; they are never edited and never read once the item changes.
import type { EditDecision, UniversalTimeline } from "@/lib/ae/types";

/** An exact frame rate: fps = num / den (24/1, 24000/1001, 30000/1001…). */
export interface FrameRate {
  num: number;
  den: number;
}

export const SEQUENCE_SCHEMA = 2 as const;

/** Who produced an item: a Director build, its deterministic fallback, or
 * manual editing. (The transaction that last changed it is
 * `ClipItem.originTransactionId`.) */
export type Origin = "director" | "manual" | "fallback";

/** Who issued a transaction. `director` is any AI-issued change and is bound by
 * `aiLocked`; `system` is the app itself (e.g. migrations) and, like `manual`,
 * is bound only by `locked`. */
export type TransactionOrigin = "manual" | "director" | "system";

/**
 * What may change an item or a track.
 * - `locked`: nothing may modify it (the user must unlock it first).
 * - `aiLocked`: the Director / any AI-issued command must not modify it; manual
 *   editing still can. "AI must not modify this item."
 */
export interface Protection {
  locked: boolean;
  aiLocked: boolean;
}

export const UNPROTECTED: Readonly<Protection> = Object.freeze({ locked: false, aiLocked: false });

export type TrackKind = "video" | "audio";

/** What a track carries, for editorial logic (not for layout). */
export type TrackRole = "dialogue" | "broll" | "dialogue-audio" | "ambient" | "other";

export interface Track {
  id: string;
  kind: TrackKind;
  /** Display name, e.g. "V1", "A1". */
  name: string;
  /** Stacking order within its kind: V1 = 0, V2 = 1…; A1 = 0, A2 = 1… */
  order: number;
  role: TrackRole;
  protection: Protection;
  muted: boolean;
  solo: boolean;
  hidden: boolean;
}

export interface ClipItem {
  id: string;
  trackId: string;
  /** The media clip this item plays (ProjectBrain clip id). */
  mediaClipId: string;
  /* — source domain (media frames) — */
  /** Source range at the media's own rate; out is exclusive. */
  sourceInFrame: number;
  sourceOutFrame: number;
  /** The media's frame rate (the rate the source frames are counted at). */
  mediaRate: FrameRate;
  /* — sequence domain (sequence frames) — */
  /** Timeline position. */
  startFrame: number;
  /** Length on the timeline. Recalculated (time.ts `sequenceDurationFrames`)
   * only when the source range changes; never touched by a move. */
  durationFrames: number;
  label: string;
  selectId?: string | undefined;
  /** Items in one link group move/trim together (e.g. V1 picture + its A1 sync audio). */
  linkGroupId?: string | undefined;
  enabled: boolean;
  origin: Origin;
  /** The transaction that created or last changed this item, when known. */
  originTransactionId?: string | undefined;
  protection: Protection;
  /** Read-only import provenance; see the file header. */
  legacy?: LegacyItemProvenance | undefined;
  /** Read-only: the timecode labels the source endpoints were imported with.
   * Consulted ONLY while an endpoint's frame still equals its imported frame,
   * to tell apart two timecodes that share that frame (see time.ts). Never
   * edited; carried unchanged through moves, trims and splits. */
  sourceTcProvenance?: { in: TcLabelHint | null; out: TcLabelHint | null } | undefined;
}

/** A source frame and the timecode it was imported as. */
export interface TcLabelHint {
  frame: number;
  tc: string;
}

/** Linked items (picture + sync audio). Linked items stay aligned unless a
 * future J/L-cut command deliberately offsets them. */
export interface LinkGroup {
  id: string;
  itemIds: string[];
}

export interface Sequence {
  schema: typeof SEQUENCE_SCHEMA;
  id: string;
  name: string;
  rate: FrameRate;
  /** The length the cut was built toward, in sequence frames (0 = none). */
  targetFrames: number;
  /** Video tracks then audio tracks, each in `order`. */
  tracks: Track[];
  items: Record<string, ClipItem>;
  links: Record<string, LinkGroup>;
  /** Read-only import provenance; see the file header. */
  legacy?: LegacySequenceProvenance | undefined;
}

/* ------------------------------ legacy import ----------------------------- */

/**
 * The schema-1 decision an item was imported from, exactly as stored, plus the
 * frames it converted to. While the item still matches `fingerprint`, it is
 * unedited and converts back to `decision` verbatim (byte-identical exports to
 * beta.1). Once the item changes, this record is ignored (and may be dropped):
 * it is never edited and never a second source of truth.
 */
export interface LegacyItemProvenance {
  decision: EditDecision;
  fingerprint: ItemFingerprint;
}

/** The fields that decide whether an item is still exactly as imported. */
export interface ItemFingerprint {
  trackId: string;
  mediaClipId: string;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  label: string;
  selectId: string | null;
  enabled: boolean;
}

export interface LegacySequenceProvenance {
  timeline: Omit<UniversalTimeline, "decisions">;
  /** Item ids in the original decision order (A1 companions excluded). */
  decisionOrder: string[];
}

/* ------------------------- transactions & commands ------------------------ */
// Declared now so every layer shares one shape; behaviour lands in later steps.

/** Implemented in Phase 1. */
export type CoreCommandType =
  "MoveEdit" | "TrimEdit" | "SplitEdit" | "DeleteEdit" | "RippleDelete" | "ReplaceAssembly";

/** Reserved: declared and routed by the engine, rejected as not implemented. */
export type FutureCommandType =
  | "RippleTrim"
  | "RollEdit"
  | "SlipEdit"
  | "SlideEdit"
  | "InsertEdit"
  | "SetTrackState"
  | "LinkItems"
  | "UnlinkItems";

export type CommandType = CoreCommandType | FutureCommandType;

/** One deterministic timeline operation. Any ids it creates are generated
 * once, when the command is built, and recorded in `params`, so redo/replay
 * reproduces exactly. */
export interface Command<P = Record<string, unknown>> {
  id: string;
  type: CommandType;
  params: P;
}

/** One user gesture (or one AI operation): one undo step. */
export interface Transaction {
  id: string;
  label: string;
  origin: TransactionOrigin;
  commands: Command[];
  createdAt: string;
}
