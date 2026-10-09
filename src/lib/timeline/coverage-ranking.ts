// Phase 7, Milestone 6 — the optional AI ranking of B-roll candidates for
// Cover mode: what is sent, and how a reply is judged.
//
// The AI only RANKS candidates the deterministic engine already verified:
// for each cut the planner would cover, it may list up to five offered
// candidate ids, best first, each with a short editorial reason. It cannot
// name new media, source ranges, frames, timeline commands, ownership or
// protection — a reply carrying anything but the fields below is refused
// whole. A valid ranking only reorders the planner's options
// (coverage-plan.ts); the fit, reservations, compiler and review decide the
// edit, and nothing is applied without the filmmaker's Accept.
//
// Sent (bounded): the cut ids and timecodes the planner would cover, the
// reliable interview lines near each (no questions, confidence ≥ 0.5), and
// each usable candidate's id, evidence id, file NAME (no folder or absolute
// path), kind, label, logged timecode and stored confidence. No media, no
// paths, no keys, no speaker names, no whole transcript.
import type { TranscriptSegment } from "@/lib/ae/types";
import type { BrollCandidate, CoverageAnalysis, BrollInventory } from "./coverage";
import { nearbyLines, NEARBY_S, type CoveragePlan } from "./coverage-plan";
import type { Sequence } from "./types";

export const RANK_CONTEXT_SCHEMA = "ae.coverage-rank-context/1" as const;
export const RANKING_SCHEMA = "ae.coverage-ranking/1" as const;

const MAX_CUTS = 50;
const MAX_LINES_PER_CUT = 8;
const MAX_LINE_CHARS = 300;
const MAX_CANDIDATES = 200;
const MAX_LABEL_CHARS = 200;
export const MAX_CHOICES_PER_CUT = 5;
export const MAX_REASON_CHARS = 300;
const MAX_SUMMARY_CHARS = 1000;

export interface RankContext {
  schema: typeof RANK_CONTEXT_SCHEMA;
  versionId: string;
  revision: string;
  /** Fingerprint of the usable candidate inventory the AI is shown. */
  inventory: string;
  cuts: Array<{
    id: string;
    tc: string;
    lines: Array<{ id: string; text: string; confidence: number }>;
  }>;
  candidates: Array<{
    id: string;
    visualId: string;
    file: string;
    kind: string;
    label: string;
    atTc: string;
    confidence: number;
  }>;
  caveats: string[];
}

export interface RankChoice {
  candidateId: string;
  reason: string;
}

export type RankingCode =
  "malformed" | "unsupported-field" | "stale" | "unknown-cut" | "unknown-candidate" | "duplicate";

export type RankingCheck =
  | { ok: true; summary: string; byCut: Map<string, RankChoice[]> }
  | { ok: false; code: RankingCode; reason: string };

const CAVEATS = [
  "Each candidate is ONE sampled frame with a label; whole-shot content, motion, quality and boundaries are unknown.",
  "Rank only by what the labels and the interview lines actually say; do not infer places, dates or people beyond them.",
  "The application assigns frames, checks fit, protection and reuse, and the filmmaker accepts or rejects. You only rank.",
];

const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
};
const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/** The candidates that passed the planner's hard filters (id order). */
export function usableCandidates(inventory: BrollInventory, plan: CoveragePlan): BrollCandidate[] {
  const rejected = new Set(plan.rejected.map((r) => r.candidateId));
  return inventory.candidates
    .filter((c) => !rejected.has(c.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Changes whenever what the AI would be shown about the footage changes
 * (roles, evidence, windows, use in the cut). */
export function inventoryFingerprint(candidates: readonly BrollCandidate[]): string {
  return `inv_${fnv(
    JSON.stringify(
      candidates.map((c) => [
        c.id,
        c.mediaClipId,
        c.role.role,
        c.evidence.id,
        c.evidence.label,
        c.evidence.confidence,
        c.window.sourceInFrame,
        c.window.sourceOutFrame,
        c.flags,
      ]),
    ),
  )}_${candidates.length}`;
}

/**
 * What one AI ranking request describes, or why there is nothing to rank.
 * Only cuts the planner would try to cover are offered (uncovered potential
 * jump cuts the Director may cover); protected or covered cuts never are.
 */
export function buildRankContext(
  seq: Sequence,
  analysis: CoverageAnalysis,
  inventory: BrollInventory,
  plan: CoveragePlan | undefined,
  transcript: readonly TranscriptSegment[],
): { ok: true; context: RankContext } | { ok: false; reason: string } {
  if (!plan) return { ok: false, reason: "There is no coverage plan to improve for this cut." };
  const cuts = analysis.cuts
    .filter((c) => c.kind === "jump" && c.coverage === "uncovered" && c.directorMayCover)
    .slice(0, MAX_CUTS);
  if (!cuts.length)
    return {
      ok: false,
      reason: "No potential jump cut here can receive coverage, so there is nothing to rank.",
    };
  const usable = usableCandidates(inventory, plan);
  if (!usable.length)
    return { ok: false, reason: "There is no usable B-roll to rank (check the media roles)." };
  const shown = usable.slice(0, MAX_CANDIDATES);
  return {
    ok: true,
    context: {
      schema: RANK_CONTEXT_SCHEMA,
      versionId: analysis.versionId,
      revision: analysis.revision,
      inventory: inventoryFingerprint(shown),
      cuts: cuts.map((cut) => {
        const lines = [
          ...nearbyLines(seq.items[cut.leftId]!, "out", transcript, NEARBY_S),
          ...nearbyLines(seq.items[cut.rightId]!, "in", transcript, NEARBY_S),
        ];
        const seen = new Set<string>();
        return {
          id: cut.id,
          tc: cut.tc,
          lines: lines
            .filter((l) => !seen.has(l.id) && !!seen.add(l.id))
            .slice(0, MAX_LINES_PER_CUT)
            .map((l) => ({
              id: l.id,
              text: l.text.slice(0, MAX_LINE_CHARS),
              confidence: l.confidence,
            })),
        };
      }),
      candidates: shown.map((c) => ({
        id: c.id,
        visualId: c.evidence.id,
        file: baseName(c.file),
        kind: c.evidence.kind,
        label: c.evidence.label.slice(0, MAX_LABEL_CHARS),
        atTc: c.evidence.atTc,
        confidence: c.evidence.confidence,
      })),
      caveats: CAVEATS,
    },
  };
}

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

/**
 * Judges a ranking (as framed by the worker: envelope from the request,
 * everything else as the model returned it) against the context it must
 * answer — which the caller rebuilds from the LIVE cut. Anything unknown,
 * duplicated, out of date or outside the offered cuts and candidates is
 * refused whole; nothing is repaired.
 */
export function checkRanking(raw: unknown, context: RankContext): RankingCheck {
  const fail = (code: RankingCode, reason: string): RankingCheck => ({ ok: false, code, reason });
  if (!obj(raw) || raw["schema"] !== RANKING_SCHEMA)
    return fail("malformed", "The AI's reply was not a ranking.");
  if (!only(raw, ["schema", "base", "summary", "rankings"]))
    return fail("unsupported-field", "The AI's reply contained fields a ranking may not have.");
  const base = raw["base"];
  if (!obj(base) || !only(base, ["versionId", "revision", "inventory"]))
    return fail("malformed", "The AI's reply doesn't say which cut it ranked.");
  if (
    base["versionId"] !== context.versionId ||
    base["revision"] !== context.revision ||
    base["inventory"] !== context.inventory
  )
    return fail(
      "stale",
      "The cut or its B-roll changed since the AI was asked; its ranking no longer applies.",
    );
  const summary = raw["summary"];
  if (summary !== undefined && (typeof summary !== "string" || summary.length > MAX_SUMMARY_CHARS))
    return fail("malformed", "The AI's summary is not usable.");
  const rankings = raw["rankings"];
  if (!Array.isArray(rankings) || rankings.length < 1 || rankings.length > MAX_CUTS)
    return fail("malformed", "The AI's reply must rank candidates for at least one cut.");
  const cuts = new Set(context.cuts.map((c) => c.id));
  const candidates = new Set(context.candidates.map((c) => c.id));
  const byCut = new Map<string, RankChoice[]>();
  const used = new Set<string>();
  for (const r of rankings) {
    if (!obj(r)) return fail("malformed", "A cut ranking is not an object.");
    if (!only(r, ["cutId", "choices"]))
      return fail("unsupported-field", "A cut ranking contained fields a ranking may not have.");
    const cutId = r["cutId"];
    if (typeof cutId !== "string") return fail("malformed", "A cut ranking has no cut id.");
    if (!cuts.has(cutId))
      return fail("unknown-cut", `The AI ranked a cut it wasn't offered (${cutId.slice(0, 80)}).`);
    if (byCut.has(cutId)) return fail("duplicate", "The AI ranked the same cut twice.");
    const choices = r["choices"];
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > MAX_CHOICES_PER_CUT)
      return fail("malformed", `Each cut needs 1–${MAX_CHOICES_PER_CUT} ranked candidates.`);
    const list: RankChoice[] = [];
    for (const ch of choices) {
      if (!obj(ch)) return fail("malformed", "A ranked candidate is not an object.");
      if (!only(ch, ["candidateId", "reason"]))
        return fail(
          "unsupported-field",
          "A ranked candidate contained fields a ranking may not have (only an id and a reason).",
        );
      const id = ch["candidateId"];
      const reason = ch["reason"];
      if (typeof id !== "string") return fail("malformed", "A ranked candidate has no id.");
      if (!candidates.has(id))
        return fail(
          "unknown-candidate",
          `The AI named footage it wasn't offered (${id.slice(0, 80)}).`,
        );
      if (used.has(id))
        return fail("duplicate", "The AI recommended the same candidate more than once.");
      if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_REASON_CHARS)
        return fail(
          "malformed",
          `Each pick needs a short reason (at most ${MAX_REASON_CHARS} characters).`,
        );
      used.add(id);
      list.push({ candidateId: id, reason: reason.trim() });
    }
    byCut.set(cutId, list);
  }
  return { ok: true, summary: typeof summary === "string" ? summary.trim() : "", byCut };
}
