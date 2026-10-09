// Phase 6, Milestone 3 — the deterministic Story Plan compiler.
//
// A story plan says, by id only, how the interview clips should be arranged:
// which to keep and in what order, which to remove, what happens to each
// cutaway the change touches, and why (citing transcript lines and selects).
// It never says where anything goes in frames. This module checks the plan
// against the CURRENT sequence and the project's analysis, compiles it into
// existing proposal operations — and nothing else:
//
//   1. remove (lift, gap stays)   — cutaways the plan explicitly removes
//   2. remove (ripple)            — interview clips the plan removes
//   3. reorder                    — the smallest run of kept clips whose order changes
//
// and runs the result through reviewProposal, the same validation every
// proposal gets. It never applies anything: the output is a proposal for the
// filmmaker to preview and accept or reject.
//
// Conservative by design: every cutaway the change touches needs an explicit
// decision; "keep" is only accepted where the engine can keep it over the same
// words (wholly inside one moved clip, or clear of everything that changes);
// a removed cutaway is an operation in the proposal, shown and reviewed like
// any other. Nothing is removed or repositioned unless the plan says so.

import {
  PROPOSAL_SCHEMA,
  reviewProposal,
  sequenceRevision,
  type AnalysisInventory,
  type ProposalContext,
  type ProposalIssue,
  type ProposalOp,
  type Review,
  type SourceRef,
} from "./proposals";
import { endFrame, itemsOnTrack } from "./selectors";
import { LOW_CONFIDENCE, interviewTrackId, linesOf, type StoryAnalysis } from "./story-context";
import { frameToTc, tcToFrame } from "./time";
import type { ClipItem, Sequence } from "./types";
import { sequenceOf } from "./workspace";

export const STORY_PLAN_SCHEMA = "ae.story-plan/1" as const;

export type CutawayDecision = "keep" | "remove";

export interface StoryPlan {
  schema: typeof STORY_PLAN_SCHEMA;
  /** The exact sequence the plan was made against. */
  base: { versionId: string; revision: string };
  instruction: string;
  summary: string;
  /** Interview clips to keep, in their new order. */
  order: string[];
  /** Interview clips to remove (the gap is closed). */
  remove?: string[] | undefined;
  /** An explicit decision for every cutaway the change touches. */
  cutaways?: Record<string, CutawayDecision> | undefined;
  rationale?:
    | Array<{
        clipId: string;
        reason: string;
        evidence?: Array<{ kind: "transcript" | "select"; id: string }> | undefined;
      }>
    | undefined;
}

export type StoryPlanIssueCode =
  | "malformed"
  | "self-authorization"
  | "stale"
  | "no-sequence"
  | "unknown-clip"
  | "not-interview"
  | "duplicate"
  | "incomplete-order"
  | "not-contiguous"
  | "no-change"
  | "missing-rationale"
  | "unknown-evidence"
  | "wrong-clip-evidence"
  | "cutaway-decision-missing"
  | "invalid-cutaway-decision"
  | "cutaway-cannot-stay"
  | "review-refused"
  | "cutaway-relationship-changed"
  | "cutaway-lost";

export interface StoryPlanIssue {
  code: StoryPlanIssueCode;
  message: string;
  ids?: string[] | undefined;
  /** For review-refused: the proposal engine's own issue. */
  review?: ProposalIssue | undefined;
}

/** One interview edit point in the proposed cut. */
export interface EditPoint {
  frame: number;
  tc: string;
  leftId: string;
  rightId: string;
  /** These two clips weren't joined here before. */
  isNew: boolean;
  /** Same source file, discontinuous source: the picture visibly jumps. */
  jumpCut: boolean;
  /** A cutaway on another video track runs across it. */
  covered: boolean;
  /** Was this same join covered before the change? */
  wasCovered: boolean;
}

export type CompiledStoryPlan =
  | {
      ok: true;
      proposal: Record<string, unknown>;
      review: Extract<Review, { ok: true }>;
      editPoints: EditPoint[];
      /** What each retained cutaway covers, before and after (identical by construction). */
      cutaways: CutawayRelation[];
      /** Informational only — nothing is done about them automatically. */
      warnings: string[];
    }
  | {
      ok: false;
      issues: StoryPlanIssue[];
      /** When compilation got as far as a proposal (refused by review). */
      proposal?: Record<string, unknown> | undefined;
      review?: Review | undefined;
    };

const MAX_CLIPS = 50;
const MAX_RATIONALE = 50;
const MAX_EVIDENCE = 20;
const MAX_TEXT = 2000;
const MAX_REASON = 1000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PLAN_KEYS = [
  "schema",
  "base",
  "instruction",
  "summary",
  "order",
  "remove",
  "cutaways",
  "rationale",
];
const AUTHORIZATION_KEYS = [
  "authorization",
  "authorize",
  "authorized",
  "override",
  "overrides",
  "force",
  "allowManual",
  "allowProtected",
];

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isIdList = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && ID_RE.test(x));
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;

/** Strict structural check. */
function parsePlan(
  raw: unknown,
): { ok: true; plan: StoryPlan } | { ok: false; issues: StoryPlanIssue[] } {
  const issues: StoryPlanIssue[] = [];
  const bad = (message: string, code: StoryPlanIssueCode = "malformed") =>
    issues.push({ code, message });
  if (!isObj(raw))
    return {
      ok: false,
      issues: [{ code: "malformed", message: "A story plan must be an object." }],
    };
  for (const k of Object.keys(raw)) {
    if (AUTHORIZATION_KEYS.includes(k))
      bad(
        "A plan cannot authorize itself to override protected or hand-edited clips.",
        "self-authorization",
      );
    else if (!PLAN_KEYS.includes(k)) bad(`Unknown field "${k}".`);
  }
  if (raw["schema"] !== STORY_PLAN_SCHEMA) bad(`Schema must be "${STORY_PLAN_SCHEMA}".`);
  const base = raw["base"];
  if (
    !isObj(base) ||
    Object.keys(base).length !== 2 ||
    typeof base["versionId"] !== "string" ||
    typeof base["revision"] !== "string"
  )
    bad("base must be { versionId, revision }.");
  if (!text(raw["instruction"], MAX_TEXT)) bad("instruction must be non-empty text.");
  if (!text(raw["summary"], MAX_TEXT)) bad("summary must be non-empty text.");
  if (!isIdList(raw["order"], MAX_CLIPS) || (raw["order"] as unknown[]).length === 0)
    bad(`order must list 1–${MAX_CLIPS} clip ids.`);
  if (raw["remove"] !== undefined && !isIdList(raw["remove"], MAX_CLIPS))
    bad("remove must be a list of clip ids.");
  const cut = raw["cutaways"];
  if (
    cut !== undefined &&
    (!isObj(cut) ||
      Object.keys(cut).length > MAX_CLIPS ||
      Object.entries(cut).some(([k, v]) => !ID_RE.test(k) || (v !== "keep" && v !== "remove")))
  )
    bad('cutaways must map cutaway ids to "keep" or "remove".');
  const rat = raw["rationale"];
  if (rat !== undefined) {
    if (!Array.isArray(rat) || rat.length > MAX_RATIONALE) bad("rationale must be a short list.");
    else
      rat.forEach((r, i) => {
        if (
          !isObj(r) ||
          Object.keys(r).some((k) => !["clipId", "reason", "evidence"].includes(k)) ||
          typeof r["clipId"] !== "string" ||
          !ID_RE.test(r["clipId"]) ||
          !text(r["reason"], MAX_REASON)
        ) {
          bad(`rationale[${i}] must be { clipId, reason, evidence? }.`);
          return;
        }
        const ev = r["evidence"];
        if (
          ev !== undefined &&
          (!Array.isArray(ev) ||
            ev.length > MAX_EVIDENCE ||
            ev.some(
              (e) =>
                !isObj(e) ||
                Object.keys(e).length !== 2 ||
                (e["kind"] !== "transcript" && e["kind"] !== "select") ||
                typeof e["id"] !== "string" ||
                !ID_RE.test(e["id"]),
            ))
        )
          bad(`rationale[${i}].evidence must list { kind: transcript|select, id }.`);
      });
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, plan: structuredClone(raw) as unknown as StoryPlan };
}

const overlaps = (a: ClipItem, b: ClipItem) =>
  a.startFrame < endFrame(b) && endFrame(a) > b.startFrame;

/** A short, stable id for the compiled proposal. */
function planId(plan: StoryPlan): string {
  const s = JSON.stringify([plan.base, plan.order, plan.remove ?? [], plan.cutaways ?? {}]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return `prp_story_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Checks and compiles a story plan. Pure: the workspace is untouched; the
 * returned proposal has already passed reviewProposal (or the reasons it was
 * refused are returned).
 */
export function compileStoryPlan(
  raw: unknown,
  ctx: ProposalContext,
  analysis: Pick<StoryAnalysis, "selects" | "transcript">,
): CompiledStoryPlan {
  const parsed = parsePlan(raw);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const plan = parsed.plan;
  const fail = (issues: StoryPlanIssue[]): CompiledStoryPlan => ({ ok: false, issues });

  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq) return fail([{ code: "no-sequence", message: "There is no cut on screen." }]);
  if (plan.base.versionId !== ctx.activeVersionId || plan.base.revision !== sequenceRevision(seq))
    return fail([
      {
        code: "stale",
        message: "The cut changed after this plan was made. Ask for a new plan.",
      },
    ]);

  // --- interview clips: the plan must account for every one, exactly once ---
  const v1 = interviewTrackId(seq);
  const interview = v1 ? itemsOnTrack(seq, v1) : [];
  const interviewIds = new Set(interview.map((i) => i.id));
  const issues: StoryPlanIssue[] = [];
  const removeIds = plan.remove ?? [];
  const listed = [...plan.order, ...removeIds];
  for (const id of new Set(listed)) {
    if (!seq.items[id])
      issues.push({ code: "unknown-clip", message: `Clip ${id} is not in this cut.`, ids: [id] });
    else if (!interviewIds.has(id))
      issues.push({
        code: "not-interview",
        message: `"${seq.items[id]!.label}" is not an interview clip — only interview clips are arranged by a story plan.`,
        ids: [id],
      });
  }
  const dupes = listed.filter((id, n) => listed.indexOf(id) !== n);
  if (dupes.length)
    issues.push({
      code: "duplicate",
      message: `Each clip may appear once, in order or remove: ${[...new Set(dupes)].join(", ")}.`,
      ids: [...new Set(dupes)],
    });
  const missing = interview.filter((i) => !listed.includes(i.id));
  if (missing.length)
    issues.push({
      code: "incomplete-order",
      message: `The plan leaves out ${missing.map((i) => `"${i.label}"`).join(", ")} — every interview clip must be kept (in order) or removed.`,
      ids: missing.map((i) => i.id),
    });
  if (issues.length) return fail(issues);
  for (let n = 1; n < interview.length; n += 1)
    if (interview[n]!.startFrame !== endFrame(interview[n - 1]!))
      return fail([
        {
          code: "not-contiguous",
          message:
            "The interview clips aren't back to back, so this cut can't be restructured as one run yet.",
          ids: [interview[n - 1]!.id, interview[n]!.id],
        },
      ]);

  // --- what actually changes ---
  const removed = new Set(removeIds);
  const keptNow = interview.filter((i) => !removed.has(i.id)).map((i) => i.id);
  let p = 0;
  while (p < keptNow.length && keptNow[p] === plan.order[p]) p += 1;
  let s = 0;
  while (
    s < keptNow.length - p &&
    keptNow[keptNow.length - 1 - s] === plan.order[plan.order.length - 1 - s]
  )
    s += 1;
  const subRun = plan.order.slice(p, plan.order.length - s);
  const moved = new Set(subRun);
  if (!removed.size && !moved.size)
    return fail([
      {
        code: "no-change",
        message: "The plan keeps every clip where it is — there is nothing to propose.",
      },
    ]);

  // --- cutaways: an explicit, valid decision for each one the change touches ---
  const decisions = plan.cutaways ?? {};
  const changedClips = interview.filter((i) => removed.has(i.id) || moved.has(i.id));
  const others = Object.values(seq.items).filter(
    (it) =>
      it.trackId !== v1 &&
      seq.tracks.find((t) => t.id === it.trackId)?.kind === "video" &&
      !interview.some((c) => c.linkGroupId && c.linkGroupId === it.linkGroupId),
  );
  const affected = others.filter((c) => changedClips.some((i) => overlaps(c, i)));
  const affectedIds = new Set(affected.map((c) => c.id));
  for (const [id, d] of Object.entries(decisions)) {
    if (!affectedIds.has(id))
      issues.push({
        code: "invalid-cutaway-decision",
        message: seq.items[id]
          ? `"${seq.items[id]!.label}" isn't touched by this plan — leave it out of the cutaway decisions (decided: ${d}).`
          : `Cutaway ${id} is not in this cut.`,
        ids: [id],
      });
  }
  for (const c of affected) {
    const d = decisions[c.id];
    if (!d) {
      issues.push({
        code: "cutaway-decision-missing",
        message: `"${c.label}" sits over clips this plan changes — the plan must say whether to keep or remove it.`,
        ids: [c.id],
      });
      continue;
    }
    if (d === "remove") continue;
    const overRemoved = interview.filter((i) => removed.has(i.id) && overlaps(c, i));
    const overMoved = interview.filter((i) => moved.has(i.id) && overlaps(c, i));
    const host =
      overMoved.length === 1 &&
      overMoved[0]!.startFrame <= c.startFrame &&
      endFrame(c) <= endFrame(overMoved[0]!);
    if (overRemoved.length)
      issues.push({
        code: "cutaway-cannot-stay",
        message: `"${c.label}" can't be kept: it sits over "${overRemoved[0]!.label}", which the plan removes. Remove it too, or keep that clip.`,
        ids: [c.id],
      });
    else if (!host)
      issues.push({
        code: "cutaway-cannot-stay",
        message: `"${c.label}" can't be kept: it runs across an edit point the plan changes, so it can't move with one clip. Remove it, or change the plan.`,
        ids: [c.id],
      });
  }

  // --- rationale and evidence ---
  const transcriptById = new Map(analysis.transcript.map((t) => [t.id, t]));
  const selectById = new Map(analysis.selects.map((x) => [x.id, x]));
  const warnings: string[] = [];
  const rationale = plan.rationale ?? [];
  const explained = new Set<string>();
  const lowConfidence: Record<string, string[]> = {};
  for (const r of rationale) {
    const it = seq.items[r.clipId];
    const isClip = interviewIds.has(r.clipId);
    const isRemovedCutaway = affectedIds.has(r.clipId) && decisions[r.clipId] === "remove";
    if (!it || (!isClip && !isRemovedCutaway)) {
      issues.push({
        code: "unknown-clip",
        message: `The rationale names ${it ? `"${it.label}"` : r.clipId}, which this plan doesn't arrange or remove.`,
        ids: [r.clipId],
      });
      continue;
    }
    explained.add(r.clipId);
    for (const e of r.evidence ?? []) {
      if (!isClip) {
        issues.push({
          code: "wrong-clip-evidence",
          message: `Evidence ${e.id} is attached to the cutaway "${it.label}"; transcript and select evidence belong to interview clips.`,
          ids: [r.clipId],
        });
        continue;
      }
      if (e.kind === "transcript") {
        const t = transcriptById.get(e.id);
        if (!t) {
          issues.push({
            code: "unknown-evidence",
            message: `Transcript line ${e.id} does not exist in this project's analysis.`,
          });
          continue;
        }
        if (!linesOf(it, [t]).length) {
          issues.push({
            code: "wrong-clip-evidence",
            message: `Transcript line ${e.id} is not part of "${it.label}" — evidence must come from the clip it explains.`,
            ids: [r.clipId],
          });
          continue;
        }
        if (!(t.confidence >= LOW_CONFIDENCE)) (lowConfidence[r.clipId] ??= []).push(e.id);
      } else {
        const sel = selectById.get(e.id);
        if (!sel) {
          issues.push({
            code: "unknown-evidence",
            message: `Select ${e.id} does not exist in this project's analysis.`,
          });
          continue;
        }
        if (!selectBelongs(it, sel)) {
          issues.push({
            code: "wrong-clip-evidence",
            message: `Select ${e.id} is not from "${it.label}" — evidence must come from the clip it explains.`,
            ids: [r.clipId],
          });
        }
      }
    }
  }
  for (const id of [...removed, ...moved]) {
    if (!explained.has(id))
      issues.push({
        code: "missing-rationale",
        message: `The plan ${removed.has(id) ? "removes" : "moves"} "${seq.items[id]!.label}" without saying why.`,
        ids: [id],
      });
  }
  if (issues.length) return fail(issues);
  for (const id of [...removed, ...moved]) {
    const cited = rationale.filter((r) => r.clipId === id).flatMap((r) => r.evidence ?? []);
    if (!cited.length)
      warnings.push(
        `No evidence is cited for ${removed.has(id) ? "removing" : "moving"} "${seq.items[id]!.label}".`,
      );
  }
  for (const [id, ts] of Object.entries(lowConfidence))
    warnings.push(
      `"${seq.items[id]!.label}" is justified with low-confidence transcript (${ts.join(", ")}) — the words may be wrong; check before relying on them.`,
    );

  // --- compile: existing proposal operations only ---
  const ops: ProposalOp[] = [];
  const opOf: Record<string, number> = {};
  const lift = affected.filter((c) => decisions[c.id] === "remove").map((c) => c.id);
  if (lift.length) {
    lift.forEach((id) => (opOf[id] = ops.length));
    ops.push({ op: "remove", itemIds: lift, ripple: false });
  }
  if (removed.size) {
    const ids = interview.filter((i) => removed.has(i.id)).map((i) => i.id);
    ids.forEach((id) => (opOf[id] = ops.length));
    ops.push({ op: "remove", itemIds: ids, ripple: true });
  }
  if (subRun.length) {
    subRun.forEach((id) => (opOf[id] = ops.length));
    ops.push({ op: "reorder", itemIds: subRun });
  }
  const proposalRationale = rationale
    .filter((r) => opOf[r.clipId] !== undefined)
    .map((r) => {
      const low = lowConfidence[r.clipId];
      const reason = low
        ? `${r.reason} [cites low-confidence transcript: ${low.join(", ")}]`
        : r.reason;
      const evidence: SourceRef[] = (r.evidence ?? []).map((e) => ({ kind: e.kind, id: e.id }));
      return {
        opIndex: opOf[r.clipId]!,
        reason: reason.slice(0, MAX_REASON),
        ...(evidence.length ? { evidence } : {}),
      };
    });
  const proposal: Record<string, unknown> = {
    schema: PROPOSAL_SCHEMA,
    id: planId(plan),
    instruction: plan.instruction.trim(),
    summary: plan.summary.trim(),
    base: { versionId: plan.base.versionId, revision: plan.base.revision },
    operations: ops,
    ...(proposalRationale.length ? { rationale: proposalRationale } : {}),
  };

  // --- the same review every proposal gets ---
  const inventory: AnalysisInventory = ctx.analysis ?? {
    selectIds: new Set(analysis.selects.map((x) => x.id)),
    transcriptIds: new Set(analysis.transcript.map((t) => t.id)),
    visualIds: new Set(),
  };
  const review = reviewProposal(proposal, { ...ctx, analysis: inventory });
  if (!review.ok)
    return {
      ok: false,
      proposal,
      review,
      issues: review.issues.map((i) => ({
        code: "review-refused" as const,
        message: i.message,
        ids: i.itemIds,
        review: i,
      })),
    };

  // --- editorial safety: every cutaway still over the same words, none lost ---
  const relation = cutawayRelationIssues(seq, review.preview, lift);
  if (relation.issues.length) return { ok: false, proposal, review, issues: relation.issues };

  const editPoints = editPointsOf(seq, review.preview);
  for (const e of editPoints) {
    if (!e.jumpCut || e.covered) continue;
    const l = review.preview.items[e.leftId]!;
    const r = review.preview.items[e.rightId]!;
    if (e.isNew)
      warnings.push(
        `New jump cut at ${e.tc}: "${l.label}" → "${r.label}" (same source) with no B-roll over it.`,
      );
    else if (e.wasCovered)
      warnings.push(
        `The jump cut at ${e.tc} ("${l.label}" → "${r.label}") loses its B-roll coverage.`,
      );
  }
  return { ok: true, proposal, review, editPoints, warnings, cutaways: relation.relations };
}

/** A select explains a clip if it is that clip's select, or comes from the
 * same media and overlaps the clip's source range. */
function selectBelongs(
  it: ClipItem,
  sel: { id: string; clipId: string; startTc: string; endTc: string },
) {
  if (it.selectId === sel.id) return true;
  if (sel.clipId !== it.mediaClipId) return false;
  const a = tcToFrame(sel.startTc, it.mediaRate);
  const b = tcToFrame(sel.endTc, it.mediaRate);
  return a !== null && b !== null && a < it.sourceOutFrame && b > it.sourceInFrame;
}

/** Interview material under a cutaway: which clip, and which of its frames
 * (offsets from the clip's own start — unchanged by moving the clip). */
export interface Coverage {
  itemId: string;
  from: number;
  to: number;
}
export interface CutawayRelation {
  id: string;
  before: Coverage[];
  after: Coverage[];
}

function coverageOf(s: Sequence, cutaway: ClipItem): Coverage[] {
  const v1 = interviewTrackId(s);
  if (!v1) return [];
  const a = cutaway.startFrame;
  const b = endFrame(cutaway);
  return itemsOnTrack(s, v1)
    .filter((it) => it.startFrame < b && endFrame(it) > a)
    .map((it) => ({
      itemId: it.id,
      from: Math.max(a, it.startFrame) - it.startFrame,
      to: Math.min(b, endFrame(it)) - it.startFrame,
    }));
}

/**
 * Checks the proposed cut against the current one, cutaway by cutaway —
 * independently of the timeline's overlap rules: every cutaway that remains
 * must sit over exactly the same interview frames as before (same clip, same
 * frames of it), and every cutaway that is gone must be one the plan removes
 * explicitly (`lifted`). Anything else is refused.
 */
export function cutawayRelationIssues(
  before: Sequence,
  after: Sequence,
  lifted: readonly string[],
): { issues: StoryPlanIssue[]; relations: CutawayRelation[] } {
  const v1 = interviewTrackId(before);
  const cutaways = Object.values(before.items).filter(
    (it) =>
      it.trackId !== v1 &&
      before.tracks.find((t) => t.id === it.trackId)?.kind === "video" &&
      !Object.values(before.items).some(
        (i) => i.trackId === v1 && i.linkGroupId && i.linkGroupId === it.linkGroupId,
      ),
  );
  const issues: StoryPlanIssue[] = [];
  const relations: CutawayRelation[] = [];
  for (const c of cutaways) {
    const now = after.items[c.id];
    if (!now) {
      if (!lifted.includes(c.id))
        issues.push({
          code: "cutaway-lost",
          message: `"${c.label}" would disappear without the plan removing it — refused.`,
          ids: [c.id],
        });
      continue;
    }
    const was = coverageOf(before, c);
    const is = coverageOf(after, now);
    relations.push({ id: c.id, before: was, after: is });
    if (JSON.stringify(was) !== JSON.stringify(is))
      issues.push({
        code: "cutaway-relationship-changed",
        message: `"${c.label}" would end up over different interview material than it covers now — refused.`,
        ids: [c.id],
      });
  }
  for (const id of lifted)
    if (after.items[id])
      issues.push({
        code: "cutaway-lost",
        message: `"${before.items[id]?.label ?? id}" is marked for removal but is still in the proposed cut.`,
        ids: [id],
      });
  return { issues, relations };
}

/** Interview edit points of `after`, compared with `before`. */
export function editPointsOf(before: Sequence, after: Sequence): EditPoint[] {
  const pairs = (s: Sequence) => {
    const v1 = interviewTrackId(s);
    const items = v1 ? itemsOnTrack(s, v1) : [];
    return items
      .slice(1)
      .map((b, n) => [items[n]!, b] as const)
      .filter(([a, b]) => endFrame(a) === b.startFrame);
  };
  const coveredIn = (s: Sequence, frame: number) => {
    const v1 = interviewTrackId(s);
    return Object.values(s.items).some(
      (it) =>
        it.trackId !== v1 &&
        s.tracks.find((t) => t.id === it.trackId)?.kind === "video" &&
        it.startFrame < frame &&
        endFrame(it) > frame,
    );
  };
  const old = new Map(
    pairs(before).map(([a, b]) => [`${a.id}|${b.id}`, coveredIn(before, b.startFrame)]),
  );
  return pairs(after).map(([a, b]) => ({
    frame: b.startFrame,
    tc: frameToTc(b.startFrame, after.rate),
    leftId: a.id,
    rightId: b.id,
    isNew: !old.has(`${a.id}|${b.id}`),
    jumpCut: a.mediaClipId === b.mediaClipId && b.sourceInFrame !== a.sourceOutFrame,
    covered: coveredIn(after, b.startFrame),
    wasCovered: old.get(`${a.id}|${b.id}`) ?? false,
  }));
}
