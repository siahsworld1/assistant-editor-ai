// Phase 7, Milestone 5 — Cover mode's one deterministic run: the live cut's
// coverage analysis (Milestone 3), the project's B-roll inventory, the plan
// and its compiled, reviewed proposal (Milestone 4). Pure and local: no AI
// provider, no worker request, nothing applied. CUT shows the result for the
// filmmaker to review; only Accept (through the store) changes the cut.
import type { Clip, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import {
  analyzeCoverage,
  brollInventory,
  type BrollInventory,
  type CoverageAnalysis,
  type CoverageCut,
  type MediaRoleOverrides,
} from "@/lib/timeline/coverage";
import {
  compileCoverageProposal,
  planCoverage,
  type CompiledCoverage,
  type PlanResult,
} from "@/lib/timeline/coverage-plan";
import type { AnalysisInventory, ProposalContext } from "@/lib/timeline/proposals";
import { sequenceOf } from "@/lib/timeline/workspace";

export interface CoverageRun {
  versionId: string;
  analysis: CoverageAnalysis;
  inventory: BrollInventory;
  plan: PlanResult;
  /** The plan as a reviewed proposal; null when nothing was planned. */
  compiled: CompiledCoverage | null;
}

export interface CoverageSource {
  clips: readonly Clip[];
  visualEvidence: readonly VisualEvidence[];
  transcript: readonly TranscriptSegment[];
  overrides?: MediaRoleOverrides | undefined;
}

/** How a potential jump cut is shown: by its coverage, and whether the
 * Director may cover it at all. */
export type CutState = "uncovered" | "partial" | "covered" | "blocked";
export const CUT_STATE_TEXT: Record<CutState, string> = {
  uncovered: "uncovered",
  partial: "partly covered",
  covered: "covered",
  blocked: "can't be covered safely",
};
export function cutState(c: CoverageCut): CutState {
  if (c.coverage === "covered") return "covered";
  if (c.coverage === "partial") return "partial";
  return c.directorMayCover ? "uncovered" : "blocked";
}

const NO_ANALYSIS: AnalysisInventory = {
  selectIds: new Set(),
  transcriptIds: new Set(),
  visualIds: new Set(),
};

/** Analyses, plans and compiles coverage for the version on screen. */
export function runCoverage(ctx: ProposalContext, source: CoverageSource): CoverageRun | null {
  const versionId = ctx.activeVersionId;
  const seq = sequenceOf(ctx.workspace, versionId, ctx.clips as Clip[]);
  if (!seq) return null;
  const analysis = analyzeCoverage(seq, versionId);
  const inventory = brollInventory(seq, {
    clips: source.clips,
    visualEvidence: source.visualEvidence,
    overrides: source.overrides,
  });
  const plan = planCoverage({
    seq,
    versionId,
    media: ctx.media ?? new Map(), // no inventory: every source is refused, never guessed
    analysis,
    inventory,
    visualEvidence: source.visualEvidence,
    transcript: source.transcript,
  });
  const compiled = plan.ok
    ? compileCoverageProposal(plan.plan, { ...ctx, analysis: ctx.analysis ?? NO_ANALYSIS })
    : null;
  return { versionId, analysis, inventory, plan, compiled };
}
