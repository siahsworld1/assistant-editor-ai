// The command engine: one dispatch point for every command type, plus the
// builders that create commands. Builders are the ONLY place a command's ids
// (its own, and any ids it will create, e.g. a split's right-hand pieces) are
// generated — once — so applying, redoing or replaying it is deterministic.
import type { IdGenerator } from "../ids";
import { linkedIds } from "../selectors";
import type { Command, CommandType, Sequence } from "../types";
import { deleteEdit } from "./delete";
import { moveEdit } from "./move";
import { setProtection } from "./protection";
import { reorderEdit } from "./reorder";
import { replaceAssembly } from "./replace-assembly";
import { rippleDelete } from "./ripple-delete";
import { splitEdit } from "./split";
import { trimEdit } from "./trim";
import type { CommandContext, CommandOutcome, CommandParamsByType, TypedCommand } from "./types";

type Handler = (seq: Sequence, params: never, ctx: CommandContext) => CommandOutcome;

const notYet =
  (type: CommandType): Handler =>
  () => ({
    ok: false,
    error: { code: "not-implemented", message: `${type} is not available yet.` },
  });

/** Every command type the model knows, routed to its handler. */
const HANDLERS: Record<CommandType, Handler> = {
  MoveEdit: moveEdit as Handler,
  TrimEdit: trimEdit as Handler,
  SplitEdit: splitEdit as Handler,
  DeleteEdit: deleteEdit as Handler,
  RippleDelete: rippleDelete as Handler,
  ReorderEdit: reorderEdit as Handler,
  ReplaceAssembly: replaceAssembly as Handler,
  SetProtection: setProtection as Handler,
  RippleTrim: notYet("RippleTrim"),
  RollEdit: notYet("RollEdit"),
  SlipEdit: notYet("SlipEdit"),
  SlideEdit: notYet("SlideEdit"),
  InsertEdit: notYet("InsertEdit"),
  SetTrackState: notYet("SetTrackState"),
  LinkItems: notYet("LinkItems"),
  UnlinkItems: notYet("UnlinkItems"),
};

/** Applies one command. Pure: never mutates `seq`; a rejection returns no
 * sequence, so the caller's sequence is unchanged by construction. */
export function applyCommand(seq: Sequence, command: Command, ctx: CommandContext): CommandOutcome {
  const handler = HANDLERS[command.type as CommandType];
  if (!handler) {
    return {
      ok: false,
      error: { code: "invalid-params", message: `Unknown command "${String(command.type)}".` },
    };
  }
  const outcome = handler(seq, command.params as never, ctx);
  return outcome.ok ? outcome : { ok: false, error: { ...outcome.error, commandId: command.id } };
}

function make<T extends keyof CommandParamsByType>(
  ids: IdGenerator,
  type: T,
  params: CommandParamsByType[T],
): TypedCommand<T> {
  return { id: ids.next("command"), type, params } as TypedCommand<T>;
}

/** Command builders. The sequence is consulted only to pre-generate ids. */
export const commands = {
  move: (ids: IdGenerator, itemIds: string[], deltaFrames: number) =>
    make(ids, "MoveEdit", { itemIds: [...itemIds], deltaFrames }),
  trim: (ids: IdGenerator, itemId: string, edge: "in" | "out", deltaSourceFrames: number) =>
    make(ids, "TrimEdit", { itemId, edge, deltaSourceFrames }),
  split: (ids: IdGenerator, seq: Sequence, itemId: string, atFrame: number) => {
    const members = seq.items[itemId] ? linkedIds(seq, itemId) : [itemId];
    const rightItemIds = Object.fromEntries(members.map((m) => [m, ids.next("item")]));
    const linkId = seq.items[itemId]?.linkGroupId;
    const rightLinkIds = linkId ? { [linkId]: ids.next("link") } : {};
    return make(ids, "SplitEdit", { itemId, atFrame, rightItemIds, rightLinkIds });
  },
  delete: (ids: IdGenerator, itemIds: string[]) =>
    make(ids, "DeleteEdit", { itemIds: [...itemIds] }),
  rippleDelete: (ids: IdGenerator, itemIds: string[]) =>
    make(ids, "RippleDelete", { itemIds: [...itemIds] }),
  /** `itemIds`: a back-to-back run on one track, in its NEW order. */
  reorder: (ids: IdGenerator, itemIds: string[]) =>
    make(ids, "ReorderEdit", { itemIds: [...itemIds] }),
  replaceAssembly: (ids: IdGenerator, params: CommandParamsByType["ReplaceAssembly"]) =>
    make(ids, "ReplaceAssembly", params),
  /** Lock / unlock, AI-protect / open to AI (filmmaker transactions only). */
  setProtection: (
    ids: IdGenerator,
    itemIds: string[],
    protection: { locked?: boolean; aiLocked?: boolean },
  ) =>
    make(ids, "SetProtection", {
      itemIds: [...itemIds],
      ...(protection.locked !== undefined ? { locked: protection.locked } : {}),
      ...(protection.aiLocked !== undefined ? { aiLocked: protection.aiLocked } : {}),
    }),
  /** For the reserved commands (routed, rejected as not implemented). */
  reserved: <T extends keyof CommandParamsByType>(
    ids: IdGenerator,
    type: T,
    params: CommandParamsByType[T],
  ) => make(ids, type, params),
};

export type { CommandContext, CommandOutcome, TimelineError, TimelineErrorCode } from "./types";
