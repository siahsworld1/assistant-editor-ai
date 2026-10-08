// Deterministic fixture proposals for Director AI 2.0 Phase 1 — what a
// Director would send for the four demonstration cases, built against the
// v1.2-shaped Director cut (tests/timeline/legacy-fixtures.ts):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 (over e3) · e7 708–784 (over e6)
// Item ids are content-derived (stableId), so these are fully deterministic.
import { PROPOSAL_SCHEMA, sequenceRevision, type ProposalOp } from "@/lib/timeline/proposals";
import type { Sequence } from "@/lib/timeline/types";

export function itemIdOf(seq: Sequence, decisionId: string): string {
  const found = Object.values(seq.items).find((i) => i.legacy?.decision.id === decisionId);
  if (!found) throw new Error(`no item for ${decisionId}`);
  return found.id;
}

/** A well-formed proposal against `seq` as version `versionId`. */
export function proposal(
  versionId: string,
  seq: Sequence,
  operations: ProposalOp[] | unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: PROPOSAL_SCHEMA,
    id: "prp_fixture",
    instruction: "Fixture instruction",
    summary: "Fixture summary.",
    base: { versionId, revision: sequenceRevision(seq) },
    operations,
    ...extra,
  };
}

/** 1. Move an unprotected cutaway one second earlier. */
export const moveCutaway = (versionId: string, seq: Sequence) =>
  proposal(
    versionId,
    seq,
    [{ op: "move", itemIds: [itemIdOf(seq, "event-7")], deltaFrames: -24 }],
    {
      id: "prp_move_cutaway",
      instruction: "Bring the last cutaway in a second earlier",
      summary: "Moves the closing cutaway 24 frames earlier, still over the final interview line.",
      rationale: [{ opIndex: 0, reason: "Lands the cutaway on the start of the final thought." }],
    },
  );

/** 2. Trim an unprotected interview clip's out point by one second. */
export const trimOut = (versionId: string, seq: Sequence) =>
  proposal(
    versionId,
    seq,
    [{ op: "trim", itemId: itemIdOf(seq, "event-6"), edge: "out", deltaSourceFrames: -24 }],
    {
      id: "prp_trim_out",
      instruction: "Tighten the ending",
      summary: "Takes one second off the end of the final interview line (its sync audio follows).",
    },
  );

/** 3. Remove a section and close the gap (conservative ripple rules apply). */
export const rippleRemove = (versionId: string, seq: Sequence) =>
  proposal(versionId, seq, [{ op: "remove", itemIds: [itemIdOf(seq, "event-5")], ripple: true }], {
    id: "prp_ripple_remove",
    instruction: "Drop the fourth statement",
    summary: "Removes the fourth interview statement and closes the gap.",
  });
