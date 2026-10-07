// Undo/redo at transaction level.
//
// Each committed transaction is kept with the exact sequence before and after
// it. Undo restores `before`; redo restores `after` — nothing is re-applied
// and no id is regenerated, so both are exact. Committing a new transaction
// clears the redo stack. At most `cap` (default 200) transactions are kept;
// the oldest is dropped first. Pure: every operation returns a new History.
import { applyTransaction, type ApplyOptions, type TransactionOutcome } from "./transactions";
import type { Sequence, Transaction, TransactionOrigin } from "./types";

export const HISTORY_CAP = 200;

export interface HistoryEntry {
  transaction: Transaction;
  before: Sequence;
  after: Sequence;
  changedIds: string[];
  notes: string[];
}

export interface History {
  present: Sequence;
  /** Oldest first; the last entry is the next to undo. */
  past: HistoryEntry[];
  /** Next to redo first. */
  future: HistoryEntry[];
  cap: number;
}

export function createHistory(present: Sequence, cap: number = HISTORY_CAP): History {
  return { present, past: [], future: [], cap: Math.max(1, Math.floor(cap)) };
}

export type CommitOutcome =
  | { ok: true; history: History; entry: HistoryEntry }
  | { ok: false; error: Extract<TransactionOutcome, { ok: false }>["error"]; history: History };

/** Applies a transaction to the present sequence and records it. On
 * rejection the history is returned unchanged. */
export function commit(
  history: History,
  txn: Transaction,
  options: ApplyOptions = {},
): CommitOutcome {
  const outcome = applyTransaction(history.present, txn, options);
  if (!outcome.ok) return { ok: false, error: outcome.error, history };
  const entry: HistoryEntry = {
    transaction: txn,
    before: history.present,
    after: outcome.sequence,
    changedIds: outcome.changedIds,
    notes: outcome.notes,
  };
  const past = [...history.past, entry];
  return {
    ok: true,
    entry,
    history: { ...history, present: outcome.sequence, past: past.slice(-history.cap), future: [] },
  };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;

export function undo(h: History): History {
  const entry = h.past[h.past.length - 1];
  if (!entry) return h;
  return { ...h, present: entry.before, past: h.past.slice(0, -1), future: [entry, ...h.future] };
}

export function redo(h: History): History {
  const entry = h.future[0];
  if (!entry) return h;
  return {
    ...h,
    present: entry.after,
    past: [...h.past, entry].slice(-h.cap),
    future: h.future.slice(1),
  };
}

/** What undo/redo would do next, for a menu label ("Undo Split"). */
export function nextUndo(h: History): { label: string; origin: TransactionOrigin } | null {
  const e = h.past[h.past.length - 1];
  return e ? { label: e.transaction.label, origin: e.transaction.origin } : null;
}

export function nextRedo(h: History): { label: string; origin: TransactionOrigin } | null {
  const e = h.future[0];
  return e ? { label: e.transaction.label, origin: e.transaction.origin } : null;
}
