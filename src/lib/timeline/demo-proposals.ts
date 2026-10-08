// DEVELOPER DEMONSTRATION — not an AI capability.
//
// Builds deterministic EditProposals for the active sequence so the CUT
// proposal review (preview / accept / reject) can be exercised without any
// AI-provider call. Each proposal is clearly labeled as a demo. The three
// "valid" demos search for an edit the engine accepts (dry-run review); the
// two "conflict" demos deliberately target hand-edited or protected material,
// so the review refuses them.
import {
  ownershipOf,
  PROPOSAL_SCHEMA,
  reviewProposal,
  sequenceRevision,
  type ProposalContext,
  type ProposalOp,
} from "./proposals";
import { endFrame, isLockedFrom } from "./selectors";
import type { ClipItem, Sequence } from "./types";
import { sequenceOf } from "./workspace";

export type DemoKind =
  "move-broll" | "trim-interview" | "ripple-remove" | "manual-conflict" | "protected-conflict";

export const DEMO_KINDS: ReadonlyArray<{ kind: DemoKind; label: string }> = [
  { kind: "move-broll", label: "Move a B-roll clip" },
  { kind: "trim-interview", label: "Trim an interview clip" },
  { kind: "ripple-remove", label: "Remove a section" },
  { kind: "manual-conflict", label: "Touch a hand-edited clip" },
  { kind: "protected-conflict", label: "Touch a protected clip" },
];

export type DemoResult =
  { ok: true; proposal: Record<string, unknown> } | { ok: false; reason: string };

const trackName = (seq: Sequence, item: ClipItem) =>
  seq.tracks.find((t) => t.id === item.trackId)?.name ?? "";
const onTrack = (seq: Sequence, name: string) =>
  Object.values(seq.items)
    .filter((i) => trackName(seq, i) === name)
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));

export function demoProposal(kind: DemoKind, ctx: ProposalContext): DemoResult {
  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq || !Object.keys(seq.items).length)
    return { ok: false, reason: "There is no cut to propose against." };
  const owner = ownershipOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  const base = { versionId: ctx.activeVersionId, revision: sequenceRevision(seq) };
  const make = (ops: ProposalOp[], instruction: string, summary: string, reason: string) => ({
    schema: PROPOSAL_SCHEMA,
    id: `prp_demo_${kind}_${base.revision.slice(4, 12)}`,
    instruction: `[Demo] ${instruction}`,
    summary,
    base,
    operations: ops,
    rationale: [{ opIndex: 0, reason }],
  });
  const free = (i: ClipItem) => owner(i.id) === "director" && !isLockedFrom(seq, i, "director");
  const firstValid = (candidates: Array<Record<string, unknown>>): DemoResult => {
    for (const p of candidates) if (reviewProposal(p, ctx).ok) return { ok: true, proposal: p };
    return { ok: false, reason: "No clip in this cut allows that demo edit right now." };
  };

  switch (kind) {
    case "move-broll":
      return firstValid(
        onTrack(seq, "V2")
          .filter(free)
          .flatMap((i) =>
            [-12, 12, -24, 24, -6, 6].map((d) =>
              make(
                [{ op: "move", itemIds: [i.id], deltaFrames: d }],
                `Move "${i.label}" ${Math.abs(d)} frames ${d < 0 ? "earlier" : "later"}`,
                `Shifts one cutaway by ${Math.abs(d)} frames; nothing else moves.`,
                "Demonstration: a small, valid B-roll adjustment.",
              ),
            ),
          ),
      );
    case "trim-interview":
      return firstValid(
        onTrack(seq, "V1")
          .filter(free)
          .flatMap((i) =>
            [
              ["out", -12],
              ["out", -6],
              ["in", 12],
              ["in", 6],
            ].map(([edge, d]) =>
              make(
                [
                  {
                    op: "trim",
                    itemId: i.id,
                    edge: edge as "in" | "out",
                    deltaSourceFrames: d as number,
                  },
                ],
                `Tighten the ${edge} point of "${i.label}"`,
                `Trims ${Math.abs(d as number)} source frames from the ${edge} point; its sync audio follows.`,
                "Demonstration: a small, valid interview trim.",
              ),
            ),
          ),
      );
    case "ripple-remove": {
      const candidates = onTrack(seq, "V1")
        .filter(free)
        .sort((a, b) => endFrame(b) - endFrame(a));
      const rippled = firstValid(
        candidates.map((i) =>
          make(
            [{ op: "remove", itemIds: [i.id], ripple: true }],
            `Remove "${i.label}" and close the gap`,
            "Removes one interview section (with its sync audio) and closes the gap.",
            "Demonstration: a valid ripple removal.",
          ),
        ),
      );
      if (rippled.ok) return rippled;
      // Ripple rules forbid closing the gap anywhere here (e.g. a cutaway sits
      // over every interview clip): remove the section and leave the gap.
      return firstValid(
        candidates.map((i) =>
          make(
            [{ op: "remove", itemIds: [i.id], ripple: false }],
            `Remove "${i.label}" (gap left)`,
            "Removes one interview section (with its sync audio). Ripple rules don't allow closing the gap here — a cutaway sits over it — so the gap is left for you to close.",
            "Demonstration: a removal within the ripple rules.",
          ),
        ),
      );
    }
    case "manual-conflict": {
      const target = Object.values(seq.items).find((i) => owner(i.id) === "manual");
      if (!target)
        return {
          ok: false,
          reason: "No clip in this cut has been edited by hand yet — edit one, then try again.",
        };
      return {
        ok: true,
        proposal: make(
          [{ op: "move", itemIds: [target.id], deltaFrames: -1 }],
          `Nudge the hand-edited "${target.label}"`,
          "Tries to move a clip the filmmaker edited by hand — the review must refuse it.",
          "Demonstration: the Director never overrides manual edits.",
        ),
      };
    }
    case "protected-conflict": {
      const target = Object.values(seq.items).find((i) => isLockedFrom(seq, i, "director"));
      if (!target)
        return {
          ok: false,
          reason: "No clip is locked or AI-protected — protect one, then try again.",
        };
      return {
        ok: true,
        proposal: make(
          [{ op: "move", itemIds: [target.id], deltaFrames: -1 }],
          `Nudge the protected "${target.label}"`,
          "Tries to move a locked or AI-protected clip — the review must refuse it.",
          "Demonstration: protected material is never changed by the Director.",
        ),
      };
    }
  }
}
