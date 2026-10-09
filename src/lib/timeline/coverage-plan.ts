// Phase 7, Milestone 4 — the deterministic B-roll coverage planner and its
// proposal compiler. Pure: no AI call, nothing applied. It reads the
// Milestone 3 analysis (coverage.ts) and either plans placements over
// uncovered potential jump cuts or explains, cut by cut, why it can't.
//
// Planning:
//   - Only potential same-source jump cuts that are not fully covered are
//     candidates for coverage. Cuts the Director may not cover (protected
//     footage beneath, an unavailable overlay track, B-roll already within
//     half a second) are skipped with that reason; partially covered cuts are
//     skipped too — extending or moving existing B-roll isn't done here.
//     Hand-edited interview cuts may be covered; covering changes nothing
//     about them.
//   - Hard filters first: a candidate must be on a B-roll file the project
//     knows (with frame rate and length), cite evidence that exists, and use
//     source not already in the cut or in this plan.
//   - Then an explainable ranking: word overlap between the shot's label and
//     the interview lines around the cut, full handles, visual variety, the
//     evidence kind and its stored confidence — every component recorded,
//     ties broken by candidate id. When no words overlap, the plan says that
//     relevance could not be established from the stored evidence.
//   - Placement: about 1 s before and 1.5 s after the cut, never less than
//     half a second on either side, inside the free V2 space between the two
//     interview clips' outer edges. The source starts so the logged moment
//     lands on the cut, within the candidate's provisional window. All in
//     integer frames; the timeline length follows the engine's own rule.
//   - Cuts are planned in timeline order; each placement reserves its V2 span
//     and its source range, so later ones can't collide or repeat footage.
//
// Compiling: the plan becomes ordinary `place` operations in ae.proposal/1,
// with evidence-backed rationale, and passes the existing review (the engine
// dry run) before it is returned. Nothing here can accept it.
import type { TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import {
  type BrollCandidate,
  type BrollInventory,
  type CoverageAnalysis,
  type CoverageCut,
} from "./coverage";
import type { MediaInventory } from "./invariants";
import {
  PROPOSAL_SCHEMA,
  reviewProposal,
  sequenceRevision,
  type AnalysisInventory,
  type ProposalContext,
  type Review,
  type SourceRef,
} from "./proposals";
import { endFrame, itemsOnTrack, sequenceEndFrame } from "./selectors";
import { linesOf } from "./story-context";
import {
  frameToTc,
  rescaleFrames,
  secondsToFrames,
  sequenceDurationFrames,
  tcToFrame,
} from "./time";
import type { Sequence } from "./types";

export const COVERAGE_PLAN_SCHEMA = "ae.coverage-plan/1" as const;

/** Preferred handles around a cut, in seconds. */
export const LEAD_S = 1;
export const TAIL_S = 1.5;
/** Interview lines within this many seconds of a cut count as "nearby". */
const NEARBY_S = 5;
const MAX_PLACEMENTS = 50;
const STOP_WORDS = new Set(
  "the and that this with from for was are you our have has had they them their there then than what when where which who will would could should into onto over under about just very really also been being its it's i'm we're".split(
    " ",
  ),
);

export type SkipCode =
  | "not-a-jump"
  | "already-covered"
  | "partially-covered"
  | "director-may-not-cover"
  | "no-space"
  | "no-candidate"
  | "limit";

export interface RankBreakdown {
  /** Words the shot's label shares with nearby interview lines. */
  sharedWords: string[];
  relevance: number;
  fullHandles: boolean;
  /** The media isn't on screen elsewhere in the cut or this plan. */
  variety: boolean;
  kind: string;
  confidence: number;
  score: number;
}

export interface PlannedPlacement {
  cutId: string;
  cutTc: string;
  candidateId: string;
  mediaClipId: string;
  file: string;
  evidenceId: string;
  evidenceLabel: string;
  evidenceAtTc: string;
  sourceInFrame: number;
  sourceOutFrame: number;
  sourceInTc: string;
  sourceOutTc: string;
  startFrame: number;
  endFrame: number;
  startTc: string;
  endTc: string;
  /** Sequence frames of B-roll before / after the cut. */
  before: number;
  after: number;
  /** Interview lines whose words the label shares (cited as evidence). */
  transcriptIds: string[];
  rank: RankBreakdown;
  /** How many candidates passed the hard filters for this cut. */
  considered: number;
  reason: string;
  /** What the stored evidence can't establish about this choice. */
  uncertainty: string[];
}

export interface PlanSkip {
  cutId: string;
  cutTc: string;
  code: SkipCode;
  message: string;
}

export interface CoveragePlan {
  schema: typeof COVERAGE_PLAN_SCHEMA;
  versionId: string;
  revision: string;
  overlayTrackId: string;
  placements: PlannedPlacement[];
  skipped: PlanSkip[];
  /** Candidates removed by the hard filters, with why (across all cuts). */
  rejected: Array<{ candidateId: string; reason: string }>;
  limitations: string[];
}

export type PlanRefusalCode =
  "stale" | "no-overlay-track" | "nothing-to-cover" | "no-safe-coverage";

export type PlanResult =
  | { ok: true; plan: CoveragePlan }
  | { ok: false; code: PlanRefusalCode; message: string; plan?: CoveragePlan | undefined };

export interface PlanInput {
  seq: Sequence;
  versionId: string;
  /** The project's media: id → length. Required for every source check. */
  media: MediaInventory;
  analysis: CoverageAnalysis;
  inventory: BrollInventory;
  /** All visual evidence of the project (to verify every cited id). */
  visualEvidence: readonly Pick<VisualEvidence, "id">[];
  transcript: readonly TranscriptSegment[];
}

const LIMITATIONS = [
  "Each source window surrounds one sampled frame; shot boundaries, camera movement and image quality are not verified — preview every placement.",
  "Relevance is word overlap between a stored visual label and nearby interview lines; it is not an understanding of the footage.",
];

const intersects = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const wordsOf = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)));

/** Plans B-roll over the uncovered potential jump cuts of `input.seq`. */
export function planCoverage(input: PlanInput): PlanResult {
  const { seq, analysis, inventory } = input;
  const revision = sequenceRevision(seq);
  if (
    analysis.revision !== revision ||
    inventory.revision !== revision ||
    analysis.versionId !== input.versionId
  )
    return {
      ok: false,
      code: "stale",
      message: "The cut changed after it was analysed. Analyse it again before planning coverage.",
    };
  const overlay = analysis.overlayTrackId
    ? seq.tracks.find((t) => t.id === analysis.overlayTrackId)
    : undefined;
  if (!overlay)
    return {
      ok: false,
      code: "no-overlay-track",
      message: "There's no overlay video track (V2) to place B-roll on.",
    };

  const evidenceIds = new Set(input.visualEvidence.map((e) => e.id));
  const m = analysis.marginFrames;
  const lead = secondsToFrames(LEAD_S, seq.rate);
  const tail = secondsToFrames(TAIL_S, seq.rate);
  const seqEnd = sequenceEndFrame(seq);

  // Hard filters (independent of the cut).
  const rejected: CoveragePlan["rejected"] = [];
  const eligible = inventory.candidates.filter((c) => {
    const why =
      c.role.role !== "b-roll"
        ? "not a B-roll file"
        : !input.media.get(c.mediaClipId)
          ? "media not in the project"
          : !(c.mediaFps > 0) || !(c.durationSeconds > 0)
            ? "frame rate or length unknown"
            : c.window.sourceOutFrame > c.mediaEndFrame || c.window.sourceInFrame < 0
              ? "source window outside the media"
              : !evidenceIds.has(c.evidence.id)
                ? "its evidence id isn't in the project's analysis"
                : c.flags.includes("used-in-cut")
                  ? "its source is already used in this cut"
                  : null;
    if (why) rejected.push({ candidateId: c.id, reason: why });
    return why === null;
  });

  const occupied: Array<[number, number]> = itemsOnTrack(seq, overlay.id).map((i) => [
    i.startFrame,
    endFrame(i),
  ]);
  const usedMedia = new Set(Object.values(seq.items).map((i) => i.mediaClipId));
  const reservedSource: Array<{ media: string; a: number; b: number }> = [];
  const placements: PlannedPlacement[] = [];
  const skipped: PlanSkip[] = [];
  const skip = (cut: CoverageCut, code: SkipCode, message: string) =>
    skipped.push({ cutId: cut.id, cutTc: cut.tc, code, message });

  for (const cut of analysis.cuts) {
    if (cut.kind !== "jump") continue; // only potential jump cuts are offered cover
    if (cut.coverage === "covered") {
      skip(cut, "already-covered", "B-roll already covers this cut.");
      continue;
    }
    if (cut.coverage === "partial") {
      skip(
        cut,
        "partially-covered",
        "Existing B-roll partly covers this cut; extending or moving it isn't done automatically.",
      );
      continue;
    }
    if (!cut.directorMayCover) {
      skip(cut, "director-may-not-cover", cut.blockers.map((b) => b.message).join(" "));
      continue;
    }
    if (placements.length >= MAX_PLACEMENTS) {
      skip(cut, "limit", `At most ${MAX_PLACEMENTS} placements are proposed at a time.`);
      continue;
    }
    const left = seq.items[cut.leftId]!;
    const right = seq.items[cut.rightId]!;
    const F = cut.frame;
    // Free V2 space around the cut, inside the two interview clips' outer edges.
    const lo = Math.max(
      0,
      left.startFrame,
      ...occupied.filter(([, b]) => b <= F).map(([, b]) => b),
    );
    const hi = Math.min(
      seqEnd,
      endFrame(right),
      ...occupied.filter(([a]) => a >= F).map(([a]) => a),
    );
    if (occupied.some(([a, b]) => a < F && b > F) || F - lo < m || hi - F < m) {
      skip(
        cut,
        "no-space",
        "There isn't half a second of free V2 space on both sides of this cut.",
      );
      continue;
    }

    const nearby = [
      ...nearbyLines(left, "out", input.transcript, NEARBY_S),
      ...nearbyLines(right, "in", input.transcript, NEARBY_S),
    ];
    const options = eligible
      .map((c) => {
        const fit = fitCandidate(seq, c, F, lo, hi, m, lead, tail);
        if (!fit) return null;
        if (
          reservedSource.some(
            (r) => r.media === c.mediaClipId && intersects(fit.sourceIn, fit.sourceOut, r.a, r.b),
          )
        )
          return null; // this plan already uses that footage
        const labelWords = wordsOf(c.evidence.label);
        const shared = new Set<string>();
        const lineIds: string[] = [];
        for (const l of nearby) {
          const hits = [...wordsOf(l.text)].filter((w) => labelWords.has(w));
          if (hits.length) {
            hits.forEach((w) => shared.add(w));
            lineIds.push(l.id);
          }
        }
        const fullHandles =
          fit.before >= Math.min(lead, F - lo) && fit.after >= Math.min(tail, hi - F);
        const variety =
          !usedMedia.has(c.mediaClipId) && !placements.some((p) => p.mediaClipId === c.mediaClipId);
        const kindRank =
          ({ "b-roll": 3, scene: 2, motion: 1, graphic: 0 } as Record<string, number>)[
            c.evidence.kind
          ] ?? 0;
        const score =
          shared.size * 100 +
          (fullHandles ? 20 : 0) +
          (variety ? 10 : 0) +
          kindRank * 5 +
          c.evidence.confidence;
        return {
          c,
          fit,
          lineIds: [...new Set(lineIds)].sort(),
          rank: {
            sharedWords: [...shared].sort(),
            relevance: shared.size,
            fullHandles,
            variety,
            kind: c.evidence.kind,
            confidence: c.evidence.confidence,
            score: Math.round(score * 1000) / 1000,
          },
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .sort(
        (a, b) => b.rank.score - a.rank.score || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
      );

    const best = options[0];
    if (!best) {
      skip(
        cut,
        "no-candidate",
        eligible.length
          ? "No unused B-roll window fits the free space with half a second on both sides of this cut."
          : "No usable B-roll is available (check media roles — uncertain files need confirming as B-roll).",
      );
      continue;
    }
    const { c, fit, rank } = best;
    const start = F - fit.before;
    const end = F + fit.after;
    occupied.push([start, end]);
    reservedSource.push({ media: c.mediaClipId, a: fit.sourceIn, b: fit.sourceOut });
    const uncertainty = [
      `The window surrounds one sampled frame (${c.evidence.atTc}); the shot's boundaries aren't verified.`,
      ...(rank.relevance === 0
        ? [
            "No words in its label match the nearby interview lines — relevance isn't established from the stored evidence.",
          ]
        : []),
      ...(c.flags.includes("overlaps-another-candidate")
        ? ["Other logged moments in this file overlap this window (possibly the same shot)."]
        : []),
    ];
    const reason = [
      `Covers the potential jump cut at ${cut.tc} with "${c.evidence.label}" (${c.evidence.id}, ${c.evidence.kind}, confidence ${c.evidence.confidence}).`,
      rank.relevance
        ? `Its label shares ${rank.sharedWords.map((w) => `"${w}"`).join(", ")} with the interview around the cut.`
        : "No label words match the interview around the cut.",
      `${fit.before} frames before and ${fit.after} after the cut${rank.fullHandles ? "" : " (shorter than preferred, still at least half a second each side)"}${rank.variety ? "; not used elsewhere in the cut" : ""}.`,
      `Chosen from ${options.length} usable candidate${options.length === 1 ? "" : "s"}.`,
    ].join(" ");
    placements.push({
      cutId: cut.id,
      cutTc: cut.tc,
      candidateId: c.id,
      mediaClipId: c.mediaClipId,
      file: c.file,
      evidenceId: c.evidence.id,
      evidenceLabel: c.evidence.label,
      evidenceAtTc: c.evidence.atTc,
      sourceInFrame: fit.sourceIn,
      sourceOutFrame: fit.sourceOut,
      sourceInTc: frameToTc(fit.sourceIn, c.mediaRate),
      sourceOutTc: frameToTc(fit.sourceOut, c.mediaRate),
      startFrame: start,
      endFrame: end,
      startTc: frameToTc(start, seq.rate),
      endTc: frameToTc(end, seq.rate),
      before: fit.before,
      after: fit.after,
      transcriptIds: best.lineIds,
      rank,
      considered: options.length,
      reason,
      uncertainty,
    });
  }

  const plan: CoveragePlan = {
    schema: COVERAGE_PLAN_SCHEMA,
    versionId: input.versionId,
    revision,
    overlayTrackId: overlay.id,
    placements,
    skipped,
    rejected,
    limitations: LIMITATIONS,
  };
  if (placements.length) return { ok: true, plan };
  const jumps = analysis.cuts.filter((c) => c.kind === "jump");
  if (!jumps.some((c) => c.coverage !== "covered"))
    return {
      ok: false,
      code: "nothing-to-cover",
      message: jumps.length
        ? "Every potential jump cut is already covered — nothing to add."
        : "This cut has no potential jump cuts to cover.",
      plan,
    };
  return {
    ok: false,
    code: "no-safe-coverage",
    message:
      skipped.find((s) => s.code !== "already-covered")?.message ?? "No safe coverage was found.",
    plan,
  };
}

/** Interview lines of `item` near its in or out point, ignoring unreliable
 * or question lines. */
function nearbyLines(
  item: Sequence["items"][string],
  edge: "in" | "out",
  transcript: readonly TranscriptSegment[],
  seconds: number,
): TranscriptSegment[] {
  const span = secondsToFrames(seconds, item.mediaRate);
  return linesOf(item, transcript).filter((l) => {
    if (!(l.confidence >= 0.5) || l.text.trim().endsWith("?")) return false;
    const a = tcToFrame(l.startTc, item.mediaRate)!;
    const b = tcToFrame(l.endTc, item.mediaRate)!;
    return edge === "out" ? b > item.sourceOutFrame - span : a < item.sourceInFrame + span;
  });
}

/**
 * The placement of one candidate over the cut at F, or null. Before/after
 * are chosen first (preferred handles, limited by free space and the
 * candidate's window), then the source is cut to match in whole media frames
 * so that the logged moment lands on the cut where the window allows.
 */
function fitCandidate(
  seq: Sequence,
  c: BrollCandidate,
  F: number,
  lo: number,
  hi: number,
  m: number,
  lead: number,
  tail: number,
): { sourceIn: number; sourceOut: number; before: number; after: number } | null {
  const winIn = c.window.sourceInFrame;
  const winOut = c.window.sourceOutFrame;
  const windowFrames = sequenceDurationFrames(winIn, winOut, c.mediaRate, seq.rate);
  const wantBefore = Math.min(lead, F - lo);
  const wantAfter = Math.min(tail, hi - F);
  const total = Math.min(wantBefore + wantAfter, windowFrames);
  if (total < 2 * m) return null;
  let before = Math.min(wantBefore, total - m);
  // Start the source so the logged moment lands on the cut, inside the window.
  const leadMedia = rescaleFrames(before, seq.rate, c.mediaRate);
  let sourceIn = Math.max(winIn, Math.min(c.evidence.atFrame - leadMedia, winOut - 1));
  // The longest source from sourceIn (within the window) whose timeline length ≤ total.
  let a = sourceIn + 1;
  let b = winOut;
  let sourceOut = -1;
  while (a <= b) {
    const mid = Math.floor((a + b) / 2);
    if (sequenceDurationFrames(sourceIn, mid, c.mediaRate, seq.rate) <= total) {
      sourceOut = mid;
      a = mid + 1;
    } else b = mid - 1;
  }
  // Too little window left after the moment: start earlier in the window.
  if (sourceOut < 0 || sequenceDurationFrames(sourceIn, sourceOut, c.mediaRate, seq.rate) < 2 * m) {
    sourceIn = winIn;
    a = sourceIn + 1;
    b = winOut;
    sourceOut = -1;
    while (a <= b) {
      const mid = Math.floor((a + b) / 2);
      if (sequenceDurationFrames(sourceIn, mid, c.mediaRate, seq.rate) <= total) {
        sourceOut = mid;
        a = mid + 1;
      } else b = mid - 1;
    }
  }
  if (sourceOut < 0) return null;
  const length = sequenceDurationFrames(sourceIn, sourceOut, c.mediaRate, seq.rate);
  before = Math.min(before, length - m);
  const after = length - before;
  if (before < m || after < m || F - before < lo || F + after > hi) return null;
  return { sourceIn, sourceOut, before, after };
}

/* --------------------------------- compile --------------------------------- */

export type CompiledCoverage =
  | {
      ok: true;
      proposal: Record<string, unknown>;
      review: Extract<Review, { ok: true }>;
      plan: CoveragePlan;
    }
  | { ok: false; message: string; review?: Review | undefined; plan: CoveragePlan };

/**
 * The plan as ordinary `place` operations in ae.proposal/1, reviewed by the
 * existing engine dry run against the live cut. Never accepted here.
 */
export function compileCoverageProposal(
  plan: CoveragePlan,
  ctx: ProposalContext & { analysis: AnalysisInventory },
  instruction = "Cover the uncovered interview cuts with B-roll",
): CompiledCoverage {
  if (!plan.placements.length) return { ok: false, message: "The plan has no placements.", plan };
  const ops = plan.placements.map((p) => ({
    op: "place",
    mediaClipId: p.mediaClipId,
    trackId: plan.overlayTrackId,
    sourceInFrame: p.sourceInFrame,
    sourceOutFrame: p.sourceOutFrame,
    startFrame: p.startFrame,
    label: p.evidenceLabel.trim().slice(0, 200) || "B-roll",
  }));
  const rationale = plan.placements.map((p, opIndex) => {
    const evidence: SourceRef[] = [
      { kind: "visual", id: p.evidenceId },
      ...p.transcriptIds.slice(0, 19).map((id) => ({ kind: "transcript" as const, id })),
    ];
    return {
      opIndex,
      reason: `${p.reason} ${p.uncertainty.join(" ")}`.slice(0, 1000),
      evidence,
    };
  });
  const key = JSON.stringify([plan.revision, ops]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  const proposal: Record<string, unknown> = {
    schema: PROPOSAL_SCHEMA,
    id: `prp_cover_${h.toString(16).padStart(8, "0")}`,
    instruction,
    summary: `Adds ${plan.placements.length} picture-only cutaway${plan.placements.length === 1 ? "" : "s"} on V2 over potential jump cuts; the interview picture and audio stay as they are.${plan.skipped.filter((s) => s.code !== "already-covered").length ? ` ${plan.skipped.filter((s) => s.code !== "already-covered").length} cut(s) couldn't be covered.` : ""}`,
    base: { versionId: plan.versionId, revision: plan.revision },
    operations: ops,
    rationale,
  };
  const review = reviewProposal(proposal, ctx);
  if (!review.ok)
    return {
      ok: false,
      message: review.issues[0]?.message ?? "The timeline refused this coverage proposal.",
      review,
      plan,
    };
  return { ok: true, proposal, review, plan };
}
