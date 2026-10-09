// Phase 6, Milestone 5 — what Story mode gets back from the store's askStory:
// the AI Director's story plan, already bound to the cut it was asked about
// and compiled (or the reason it couldn't be), plus readable labels for the
// evidence the plan cites. Only ever a proposal for the filmmaker to review.
import { itemsOnTrack } from "@/lib/timeline/selectors";
import { interviewTrackId, LOW_CONFIDENCE } from "@/lib/timeline/story-context";
import type { CompiledStoryPlan } from "@/lib/timeline/story-plan";
import type { Sequence } from "@/lib/timeline/types";
import type { Select, TranscriptSegment } from "./types";

/** A cited piece of evidence, as the filmmaker reads it. */
export interface StoryEvidence {
  kind: "transcript" | "select";
  /** Transcript text (excerpt) or "category · score". */
  text: string;
  lowConfidence: boolean;
}

export type StoryAskResult =
  | {
      status: "compiled";
      /** The plan as bound by the app (envelope from the request). */
      plan: Record<string, unknown>;
      compiled: CompiledStoryPlan;
      evidence: Record<string, StoryEvidence>;
    }
  | { status: "refused"; reason: string }
  | { status: "failed"; message: string; retryable: boolean }
  | { status: "invalid"; reason: string }
  | { status: "stale"; reason: string };

const EXCERPT = 160;

/** Labels for the transcript lines and selects a plan cites (that exist). */
export function storyEvidence(
  plan: Record<string, unknown>,
  analysis: { selects: ReadonlyArray<Select>; transcript: ReadonlyArray<TranscriptSegment> },
): Record<string, StoryEvidence> {
  const out: Record<string, StoryEvidence> = {};
  const rationale = Array.isArray(plan["rationale"]) ? (plan["rationale"] as unknown[]) : [];
  for (const r of rationale) {
    const ev = r && typeof r === "object" ? (r as { evidence?: unknown }).evidence : undefined;
    if (!Array.isArray(ev)) continue;
    for (const e of ev as Array<{ kind?: unknown; id?: unknown }>) {
      if (typeof e?.id !== "string") continue;
      if (e.kind === "transcript") {
        const t = analysis.transcript.find((x) => x.id === e.id);
        if (t)
          out[e.id] = {
            kind: "transcript",
            text: t.text.length > EXCERPT ? `${t.text.slice(0, EXCERPT - 1)}…` : t.text,
            lowConfidence: !(t.confidence >= LOW_CONFIDENCE),
          };
      } else if (e.kind === "select") {
        const s = analysis.selects.find((x) => x.id === e.id);
        if (s)
          out[e.id] = {
            kind: "select",
            text: `${s.category} · score ${s.score}`,
            lowConfidence: false,
          };
      }
    }
  }
  return out;
}

/** What Story mode shows the filmmaker about a plan, by clip name. */
export interface StoryShown {
  /** The compiled proposal's id (absent when the plan couldn't be compiled). */
  proposalId: string | null;
  summary: string;
  original: Array<{ id: string; label: string }>;
  proposed: Array<{ id: string; label: string; moved: boolean }>;
  removed: Array<{ id: string; label: string }>;
  reasons: Array<{
    id: string;
    label: string;
    reason: string;
    evidence: Array<{ kind: string; id: string; text: string | null; lowConfidence: boolean }>;
  }>;
  /** B-roll the plan removes explicitly — each one an operation in the proposal. */
  brollRemoved: Array<{ id: string; label: string }>;
  /** Informational: jump cuts, low-confidence or missing evidence. */
  warnings: string[];
  /** Why the plan can't go ahead (plan-level refusals). */
  issues: string[];
}

export function describeStory(
  result: Extract<StoryAskResult, { status: "compiled" }>,
  seq: Sequence | null,
): StoryShown {
  const { plan, compiled, evidence } = result;
  const label = (id: string) => seq?.items[id]?.label ?? id;
  const ids = (v: unknown) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  const v1 = seq ? interviewTrackId(seq) : null;
  const originalIds = seq && v1 ? itemsOnTrack(seq, v1).map((i) => i.id) : [];
  const order = ids(plan["order"]);
  const removed = ids(plan["remove"]);
  const kept = originalIds.filter((id) => !removed.includes(id));
  const cutaways =
    plan["cutaways"] && typeof plan["cutaways"] === "object"
      ? (plan["cutaways"] as Record<string, unknown>)
      : {};
  const rationale = Array.isArray(plan["rationale"]) ? (plan["rationale"] as unknown[]) : [];
  return {
    proposalId: compiled.ok
      ? String(compiled.proposal["id"])
      : compiled.proposal
        ? String(compiled.proposal["id"])
        : null,
    summary: typeof plan["summary"] === "string" ? plan["summary"] : "",
    original: originalIds.map((id) => ({ id, label: label(id) })),
    proposed: order.map((id, n) => ({ id, label: label(id), moved: kept[n] !== id })),
    removed: removed.map((id) => ({ id, label: label(id) })),
    reasons: rationale.flatMap((r) => {
      if (!r || typeof r !== "object") return [];
      const {
        clipId,
        reason,
        evidence: ev,
      } = r as {
        clipId?: unknown;
        reason?: unknown;
        evidence?: unknown;
      };
      if (typeof clipId !== "string" || typeof reason !== "string") return [];
      return [
        {
          id: clipId,
          label: label(clipId),
          reason,
          evidence: (Array.isArray(ev) ? ev : []).flatMap((e) =>
            e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string"
              ? [
                  {
                    kind: String((e as { kind?: unknown }).kind),
                    id: (e as { id: string }).id,
                    text: evidence[(e as { id: string }).id]?.text ?? null,
                    lowConfidence: evidence[(e as { id: string }).id]?.lowConfidence ?? false,
                  },
                ]
              : [],
          ),
        },
      ];
    }),
    brollRemoved: Object.entries(cutaways)
      .filter(([, d]) => d === "remove")
      .map(([id]) => ({ id, label: label(id) })),
    warnings: compiled.ok ? compiled.warnings : [],
    issues: compiled.ok
      ? []
      : compiled.issues.filter((i) => i.code !== "review-refused").map((i) => i.message),
  };
}
