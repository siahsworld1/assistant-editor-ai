// CUT's in-memory preview of one pending Director proposal.
//
// The proposal is held here — never in the store, the workspace, the undo
// history or anything persisted — and re-reviewed against the CURRENT
// sequence on every change (src/lib/timeline/proposals.ts reviewProposal), so
// an edit, undo or version switch that makes it stale is noticed at once.
// The "after" picture is the review's in-memory preview Sequence, turned into
// a playable schema-1 timeline the existing playback hook already plays.
// Accept goes through the store (one Director transaction, then saved like
// any edit); reject simply forgets the proposal.
import { useCallback, useMemo, useState } from "react";
import type { AcceptOutcome, ProposalIssue, ProposalOp, Review } from "@/lib/timeline/proposals";
import { reviewProposal } from "@/lib/timeline/proposals";
import type { ClipItem, Sequence } from "@/lib/timeline/types";
import { derivedTimeline } from "@/lib/timeline/workspace";
import type { EditorApi } from "./store";
import type { UniversalTimeline } from "./types";

export type CompareMode = "before" | "after";
/** How a clip is affected: changed in place, added, removed — or the reason
 * the proposal was refused (it names a clip it may not touch). */
export type ProposalMark = "changed" | "added" | "removed" | "blocked";

export interface ProposalCompare {
  /** Which picture is on screen. */
  mode: CompareMode;
  /** The Sequence to draw: the current one ("before") or the proposed one. */
  sequence: Sequence;
  marks: ReadonlyMap<string, ProposalMark>;
  /** In "after": clips the proposal removes, drawn as outlines where they were. */
  removed: ClipItem[];
}

export type ProposalNotice =
  | { kind: "accepted"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "error"; message: string; issues: ProposalIssue[] };

function marksFor(before: Sequence, after: Sequence, changedIds: string[]) {
  const b = new Map<string, ProposalMark>();
  const a = new Map<string, ProposalMark>();
  for (const id of changedIds) {
    const inBefore = !!before.items[id];
    const inAfter = !!after.items[id];
    if (inBefore) b.set(id, inAfter ? "changed" : "removed");
    if (inAfter) a.set(id, inBefore ? "changed" : "added");
  }
  return { before: b, after: a };
}

function clipName(seq: Sequence | null, id: string): string {
  const it = seq?.items[id];
  return it ? `"${it.label}"` : "an unknown clip";
}

/** One operation, in words, against the cut it was proposed for. */
export function describeOperation(op: ProposalOp, seq: Sequence | null): string {
  switch (op.op) {
    case "move": {
      const n = Math.abs(op.deltaFrames);
      const who = op.itemIds.map((id) => clipName(seq, id)).join(", ");
      const linked = op.itemIds.some((id) => seq?.items[id]?.linkGroupId);
      return `Move ${who} ${n} frame${n === 1 ? "" : "s"} ${op.deltaFrames < 0 ? "earlier" : "later"}${linked ? " (linked audio follows)" : ""}`;
    }
    case "trim": {
      const n = Math.abs(op.deltaSourceFrames);
      const shorter = op.edge === "out" ? op.deltaSourceFrames < 0 : op.deltaSourceFrames > 0;
      return `${shorter ? "Shorten" : "Lengthen"} ${clipName(seq, op.itemId)} at its ${op.edge} point by ${n} source frame${n === 1 ? "" : "s"}`;
    }
    case "remove": {
      const who = op.itemIds.map((id) => clipName(seq, id)).join(", ");
      return op.ripple ? `Remove ${who} and close the gap` : `Remove ${who}, leaving the gap`;
    }
  }
}

export function useProposalPreview(editor: EditorApi) {
  const [pending, setPending] = useState<unknown>(null);
  const [mode, setMode] = useState<CompareMode>("after");
  const [notice, setNotice] = useState<ProposalNotice | null>(null);

  // Re-reviewed whenever the editor (its sequence, versions, history) changes.
  const review: Review | null = useMemo(
    () => (pending === null ? null : reviewProposal(pending, editor.proposalContext())),
    [pending, editor],
  );

  const current = editor.sequence;
  const compare: ProposalCompare | null = useMemo(() => {
    if (!review || !current) return null;
    if (!review.ok) {
      // Refused: stay on the current cut, marking what it tried to touch.
      const blocked = new Map<string, ProposalMark>();
      for (const issue of review.issues)
        for (const id of issue.itemIds ?? []) if (current.items[id]) blocked.set(id, "blocked");
      return { mode: "before", sequence: current, marks: blocked, removed: [] };
    }
    const marks = marksFor(current, review.preview, review.changedIds);
    const removed = review.changedIds
      .filter((id) => current.items[id] && !review.preview.items[id])
      .map((id) => current.items[id]!);
    return mode === "after"
      ? { mode, sequence: review.preview, marks: marks.after, removed }
      : { mode, sequence: current, marks: marks.before, removed: [] };
  }, [review, current, mode]);

  /** The proposed cut as a playable timeline (only while showing "after"). */
  const previewTimeline: UniversalTimeline | null = useMemo(
    () => (review?.ok && mode === "after" ? derivedTimeline(review.preview) : null),
    [review, mode],
  );

  const propose = useCallback((raw: unknown) => {
    setPending(raw);
    setMode("after");
    setNotice(null);
  }, []);

  const accept = useCallback((): AcceptOutcome | null => {
    if (pending === null) return null;
    const out = editor.acceptProposal(pending);
    if (out.ok) {
      setPending(null);
      setNotice({
        kind: "accepted",
        message: "Accepted as one Director edit — Undo reverts all of it.",
      });
    } else {
      setNotice({
        kind: "error",
        message: out.issues[0]?.message ?? "Not accepted.",
        issues: out.issues,
      });
    }
    return out;
  }, [editor, pending]);

  /** Shows a message with no proposal under review (e.g. a demo that has
   * nothing to act on in this cut). */
  const inform = useCallback((message: string) => {
    setPending(null);
    setNotice({ kind: "error", message, issues: [] });
  }, []);

  const reject = useCallback(() => {
    if (pending === null) return;
    setPending(null);
    setNotice({ kind: "rejected", message: "Rejected — nothing in the project changed." });
  }, [pending]);

  return {
    /** The raw proposal under review (null when none). */
    pending,
    review,
    mode,
    setMode,
    compare,
    previewTimeline,
    notice,
    propose,
    accept,
    reject,
    inform,
  };
}

export type ProposalPreview = ReturnType<typeof useProposalPreview>;
