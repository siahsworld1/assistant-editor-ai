// Transactions: one user gesture or one AI operation = one transaction = one
// undo step. A transaction holds one or more commands and is applied
// atomically: every command must succeed, then the result must introduce no
// invariant violation and break no protection — otherwise nothing is
// committed and the caller keeps the sequence it had.
import { applyCommand, type TimelineError } from "./commands";
import type { IdGenerator } from "./ids";
import { introducedViolations, protectionViolations, type MediaInventory } from "./invariants";
import type { Command, Sequence, Transaction, TransactionOrigin } from "./types";

export interface TransactionResult {
  ok: true;
  sequence: Sequence;
  changedIds: string[];
  notes: string[];
}

export type TransactionOutcome = TransactionResult | { ok: false; error: TimelineError };

export interface ApplyOptions {
  media?: MediaInventory | undefined;
}

/** Wraps already-built commands (ids generated once, by the builders) in a
 * transaction with its own id. `createdAt` is metadata only. */
export function makeTransaction(
  ids: IdGenerator,
  label: string,
  origin: TransactionOrigin,
  commands: Command[],
  createdAt: string = new Date().toISOString(),
): Transaction {
  return { id: ids.next("transaction"), label, origin, commands: [...commands], createdAt };
}

export function applyTransaction(
  seq: Sequence,
  txn: Transaction,
  options: ApplyOptions = {},
): TransactionOutcome {
  if (!txn.commands.length) {
    return {
      ok: false,
      error: { code: "invalid-params", message: "A transaction needs at least one command." },
    };
  }
  const ctx = { origin: txn.origin, transactionId: txn.id, media: options.media };
  let current = seq;
  const changedIds: string[] = [];
  const notes: string[] = [];
  for (const command of txn.commands) {
    const outcome = applyCommand(current, command, ctx);
    if (!outcome.ok) return outcome; // atomic: nothing from this transaction survives
    current = outcome.sequence;
    for (const id of outcome.changedIds) if (!changedIds.includes(id)) changedIds.push(id);
    notes.push(...outcome.notes);
  }
  const violations = [
    ...protectionViolations(seq, current, txn.origin),
    ...introducedViolations(seq, current, { media: options.media }),
  ];
  if (violations.length) {
    return {
      ok: false,
      error: {
        code: violations.some((v) => v.code === "protected-change") ? "protected" : "invariant",
        message: violations[0]!.message,
        itemIds: [...new Set(violations.flatMap((v) => v.ids))],
        violations: violations.map(({ code, message, ids }) => ({ code, message, ids })),
      },
    };
  }
  return { ok: true, sequence: current, changedIds, notes };
}

/** Re-applies a committed transaction log from a starting sequence. Command
 * ids were fixed when the commands were built, so this reproduces the same
 * sequence, ids included, every time. */
export function replay(
  initial: Sequence,
  log: readonly Transaction[],
  options: ApplyOptions = {},
): TransactionOutcome & { applied?: number } {
  let current = initial;
  const changedIds: string[] = [];
  const notes: string[] = [];
  for (const txn of log) {
    const outcome = applyTransaction(current, txn, options);
    if (!outcome.ok) return outcome;
    current = outcome.sequence;
    changedIds.push(...outcome.changedIds);
    notes.push(...outcome.notes);
  }
  return { ok: true, sequence: current, changedIds, notes, applied: log.length };
}
