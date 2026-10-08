// The command contract. Every command is a pure function
//   (sequence, command, context) → CommandOutcome
// that never mutates its input and, on rejection, returns a typed error and
// no sequence at all — so the caller's sequence is untouched by definition.
import type { MediaInventory } from "../invariants";
import type {
  ClipItem,
  Command,
  EditOwner,
  LinkGroup,
  Sequence,
  TransactionOrigin,
} from "../types";

export interface CommandContext {
  origin: TransactionOrigin;
  /** The transaction this command runs in (recorded on changed items). */
  transactionId: string;
  media?: MediaInventory | undefined;
}

export type TimelineErrorCode =
  | "unknown-item"
  | "unknown-track"
  | "invalid-params"
  | "protected"
  | "overlap"
  | "out-of-bounds"
  | "invalid-range"
  | "would-break-link"
  | "ripple-blocked"
  | "not-implemented"
  | "invariant";

export interface TimelineError {
  code: TimelineErrorCode;
  message: string;
  commandId?: string | undefined;
  itemIds?: string[] | undefined;
  /** For `invariant`: what the transaction would have broken. */
  violations?: Array<{ code: string; message: string; ids: string[] }> | undefined;
}

export type CommandOutcome =
  | { ok: true; sequence: Sequence; changedIds: string[]; notes: string[] }
  | { ok: false; error: TimelineError };

/* ------------------------------- parameters ------------------------------- */

/** Move items (and everything linked to them) along their tracks. */
export interface MoveEditParams {
  itemIds: string[];
  /** Sequence frames; negative moves left. */
  deltaFrames: number;
}

/** Trim an item's in or out point (its linked items trim with it). */
export interface TrimEditParams {
  itemId: string;
  edge: "in" | "out";
  /** Media frames; positive moves the edge later in the source. */
  deltaSourceFrames: number;
}

/** Blade an item (and its linked items) at a sequence frame. */
export interface SplitEditParams {
  itemId: string;
  atFrame: number;
  /** Generated once when the command is built: original item id → id of its
   * right-hand piece; original link id → the right-hand pieces' link id. */
  rightItemIds: Record<string, string>;
  rightLinkIds: Record<string, string>;
}

/** Lift items (and everything linked to them), leaving a gap. */
export interface DeleteEditParams {
  itemIds: string[];
}

/** Remove items on ONE track (plus their linked items) and close the gap on
 * every track. */
export interface RippleDeleteParams {
  itemIds: string[];
}

/** Replace the cut's unprotected content with a complete assembly. */
export interface ReplaceAssemblyParams {
  /** Items to insert; ids generated once when the command is built, and
   * `trackId`s referring to tracks of the target sequence. */
  items: ClipItem[];
  links: LinkGroup[];
}

/** Lock / unlock items, or turn AI protection on / off (filmmaker only).
 * Applies to every linked partner too. Fields left out are unchanged. */
export interface SetProtectionParams {
  itemIds: string[];
  locked?: boolean | undefined;
  aiLocked?: boolean | undefined;
}

export interface CommandParamsByType {
  MoveEdit: MoveEditParams;
  TrimEdit: TrimEditParams;
  SplitEdit: SplitEditParams;
  DeleteEdit: DeleteEditParams;
  RippleDelete: RippleDeleteParams;
  ReplaceAssembly: ReplaceAssemblyParams;
  SetProtection: SetProtectionParams;
  // Reserved — routed by the engine, rejected as not implemented.
  RippleTrim: { itemId: string; edge: "in" | "out"; deltaSourceFrames: number };
  RollEdit: { leftItemId: string; rightItemId: string; deltaFrames: number };
  SlipEdit: { itemId: string; deltaSourceFrames: number };
  SlideEdit: { itemId: string; deltaFrames: number };
  InsertEdit: { items: ClipItem[]; links: LinkGroup[]; atFrame: number; trackId: string };
  SetTrackState: { trackId: string; changes: Record<string, unknown> };
  LinkItems: { itemIds: string[]; linkId: string };
  UnlinkItems: { linkId: string };
}

export type TypedCommand<T extends keyof CommandParamsByType = keyof CommandParamsByType> = Command<
  CommandParamsByType[T]
> & { type: T };

/* --------------------------------- helpers -------------------------------- */

export function fail(code: TimelineErrorCode, message: string, itemIds?: string[]): CommandOutcome {
  return { ok: false, error: { code, message, ...(itemIds ? { itemIds } : {}) } };
}

/** A new sequence with some items replaced (object), added (object) or
 * removed (null), and optionally links changed the same way. The input is
 * never mutated; unchanged items are shared, not copied. */
export function withChanges(
  seq: Sequence,
  items: Record<string, ClipItem | null>,
  links: Record<string, LinkGroup | null> = {},
): Sequence {
  const nextItems = { ...seq.items };
  for (const [id, item] of Object.entries(items)) {
    if (item === null) delete nextItems[id];
    else nextItems[id] = item;
  }
  const nextLinks = { ...seq.links };
  for (const [id, link] of Object.entries(links)) {
    if (link === null) delete nextLinks[id];
    else nextLinks[id] = link;
  }
  return { ...seq, items: nextItems, links: nextLinks };
}

/** A changed copy of an item, stamped with the transaction that changed it.
 * An item that leaves its imported state keeps its provenance record (so it
 * keeps its legacy decision id) — the adapter ignores provenance whose
 * fingerprint no longer matches. */
/**
 * The item after a command changed it: stamped with the transaction and with
 * durable ownership (types.ts EditOwner). Every command changes items through
 * here — including linked partners and ripple-shifted clips — so ownership
 * can never miss an indirect change. Manual is sticky; anything not issued by
 * the Director counts as manual (fail closed).
 */
export function changed(item: ClipItem, ctx: CommandContext, patch: Partial<ClipItem>): ClipItem {
  return {
    ...item,
    ...patch,
    originTransactionId: ctx.transactionId,
    editedBy: nextOwner(item, ctx.origin),
  };
}

export function nextOwner(item: ClipItem, origin: CommandContext["origin"]): EditOwner {
  if (origin !== "director") return "manual";
  // Before this command, who owned it? An item stamped by a transaction but
  // carrying no ownership was edited before ownership was tracked: unknown.
  const before = item.editedBy ?? (item.originTransactionId ? "unknown" : "director");
  return before === "manual" ? "manual" : before === "unknown" ? "unknown" : "director";
}

export function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}
