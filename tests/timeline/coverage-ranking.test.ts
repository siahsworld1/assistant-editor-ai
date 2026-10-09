// Phase 7, Milestone 6 — the AI ranking contract (coverage-ranking.ts) and
// how a validated ranking reaches the deterministic planner and compiler.
// No provider, no worker: the ranking replies here are scripted.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 · e7 708–784. Potential jump cuts: 240 and 408.
import { describe, expect, it } from "vitest";
import { runCoverage, type CoverageRun } from "@/lib/ae/coverage-request";
import type { Clip, EditVersion, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import { analyzeCoverage, brollInventory } from "@/lib/timeline/coverage";
import { planCoverage } from "@/lib/timeline/coverage-plan";
import {
  buildRankContext,
  checkRanking,
  inventoryFingerprint,
  RANKING_SCHEMA,
  usableCandidates,
  type RankContext,
} from "@/lib/timeline/coverage-ranking";
import { createHistory } from "@/lib/timeline/history";
import type { ProposalContext } from "@/lib/timeline/proposals";
import type { Sequence } from "@/lib/timeline/types";
import { workspaceFromVersions, type Workspace } from "@/lib/timeline/workspace";
import { deepFreeze, directorSequence, item, mediaOf, protect } from "./engine-helpers";
import { directorCut, projectClips } from "./legacy-fixtures";

const director: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.1",
  command: "c",
  summary: "s",
  createdAt: "—",
  changes: [],
  timeline: directorCut,
};
const CLIPS: Clip[] = projectClips.map((c, i) => ({
  ...c,
  ...(c.id === "clip-005" ? { relPath: "Day 1/Park/CLIP-005.MP4" } : {}),
  dialogue: { status: i < 3 ? "dialogue" : "non-dialogue", reasons: ["fixture"] },
}));
const ev = (id: string, clipId: string, atTc: string, label: string): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label,
  atTc,
  confidence: 0.8,
});
const EVIDENCE = [
  ev("park-1", "clip-005", "00:00:03:00", "Park sign at the entrance"),
  ev("street-1", "clip-006", "00:00:04:00", "Empty street corner"),
];
const line = (
  id: string,
  a: string,
  b: string,
  text: string,
  confidence = 0.9,
): TranscriptSegment => ({
  id,
  clipId: "clip-002",
  speaker: "Jane Doe",
  startTc: a,
  endTc: b,
  text,
  confidence,
});
const TRANSCRIPT = [
  line("t-e1", "00:01:08:00", "00:01:11:00", "The highway cut straight through our neighborhood."),
  line("t-e2", "00:00:25:00", "00:00:28:00", "Now the park brings everyone back."),
  line("t-q", "00:00:28:00", "00:00:30:00", "Was the park busy?"),
  line("t-low", "00:00:30:00", "00:00:31:00", "mumble", 0.2),
];
const CUT_240 = (s: Sequence) => `cut:${item(s, "event-1").id}|${item(s, "event-2").id}@240`;
const CUT_408 = (s: Sequence) => `cut:${item(s, "event-2").id}|${item(s, "event-3").id}@408`;

function ctxFor(s: Sequence | null, clips = CLIPS, evidence = EVIDENCE): ProposalContext {
  const ws: Workspace = s
    ? ({
        versions: [
          structuredClone(director),
          { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
        ],
        histories: { ver_w: createHistory(deepFreeze(s)) },
      } as Workspace)
    : workspaceFromVersions([structuredClone(director)]);
  return {
    workspace: ws,
    activeVersionId: s ? "ver_w" : "v2",
    clips,
    media: mediaOf(clips),
    analysis: {
      selectIds: new Set(),
      transcriptIds: new Set(TRANSCRIPT.map((t) => t.id)),
      visualIds: new Set(evidence.map((e) => e.id)),
    },
  };
}
function setup(o: { seq?: Sequence | null; evidence?: VisualEvidence[]; clips?: Clip[] } = {}) {
  const evidence = o.evidence ?? EVIDENCE;
  const clips = o.clips ?? CLIPS;
  const ctx = ctxFor(o.seq ?? null, clips, evidence);
  const source = { clips, visualEvidence: evidence, transcript: TRANSCRIPT };
  const run = runCoverage(ctx, source)!;
  const built = buildRankContext(run.seq, run.analysis, run.inventory, run.plan.plan, TRANSCRIPT);
  return { ctx, source, run, built };
}
const contextOf = (b: ReturnType<typeof setup>["built"]): RankContext => {
  if (!b.ok) throw new Error(b.reason);
  return b.context;
};
/** A ranking framed exactly as the worker frames it (envelope from the request). */
const reply = (c: RankContext, rankings: unknown, extra: Record<string, unknown> = {}) => ({
  schema: RANKING_SCHEMA,
  base: { versionId: c.versionId, revision: c.revision, inventory: c.inventory },
  summary: "Street first at the highway line.",
  rankings,
  ...extra,
});
const pick = (candidateId: string, reason = "Matches what is said.") => ({ candidateId, reason });

describe("the request context", () => {
  it("offers only the cuts the planner would cover, reliable nearby lines, and verified candidates — no paths, no speakers, no media", () => {
    const { run, built } = setup();
    const c = contextOf(built);
    expect(c.versionId).toBe("v2");
    expect(c.revision).toBe(run.analysis.revision);
    expect(c.cuts.map((x) => [x.id, x.tc])).toEqual([
      [CUT_240(run.seq), "00:00:10:00"],
      [CUT_408(run.seq), "00:00:17:00"],
    ]);
    const ids = c.cuts.flatMap((x) => x.lines.map((l) => l.id));
    expect(ids).toContain("t-e2");
    expect(ids).not.toContain("t-q"); // a question
    expect(ids).not.toContain("t-low"); // unreliable
    expect(c.candidates.map((x) => [x.id, x.visualId, x.file])).toEqual([
      ["cand:park-1", "park-1", "CLIP-005.MP4"],
      ["cand:street-1", "street-1", "CLIP-006.MP4"],
    ]);
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/Day 1|\/Users|Park\/|Jane Doe|speaker|sourceInFrame|startFrame/);
    expect(c.caveats.join(" ")).toMatch(/ONE sampled frame/);
  });

  it("is bounded: at most 8 lines per cut, 300 characters per line, 200 characters per label", () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      line(`t-${i}`, "00:00:25:00", "00:00:28:00", "word ".repeat(200)),
    );
    const { run } = setup({
      evidence: [ev("park-1", "clip-005", "00:00:03:00", "x".repeat(900))],
    });
    const b = buildRankContext(run.seq, run.analysis, run.inventory, run.plan.plan, long);
    const c = contextOf(b);
    expect(Math.max(...c.cuts.map((x) => x.lines.length))).toBe(8);
    expect(Math.max(...c.cuts.flatMap((x) => x.lines.map((l) => l.text.length)))).toBe(300);
    expect(c.candidates[0]!.label).toHaveLength(200);
  });

  it("nothing to rank — every cut covered, every cut protected, or no usable B-roll — is said plainly, and no context is built", () => {
    const covered = directorSequence();
    const s1 = structuredClone(covered) as Sequence;
    s1.items[item(s1, "event-4").id]!.startFrame = 396; // covers 408
    s1.items[item(s1, "event-7").id]!.startFrame = 216; // covers 240
    expect(setup({ seq: s1 }).built).toMatchObject({ ok: false });
    const locked = protect(covered, { itemId: item(covered, "event-2").id }, { aiLocked: true });
    const p = setup({ seq: locked }).built;
    expect(!p.ok && p.reason).toMatch(/nothing to rank/);
    const none = setup({ evidence: [] }).built;
    expect(!none.ok && none.reason).toMatch(/no usable B-roll/);
  });

  it("the inventory fingerprint changes with what the AI would be shown about the footage", () => {
    const a = setup();
    const again = setup();
    expect(contextOf(again.built).inventory).toBe(contextOf(a.built).inventory);
    const relabelled = setup({
      evidence: [ev("park-1", "clip-005", "00:00:03:00", "Park gate"), EVIDENCE[1]!],
    });
    expect(contextOf(relabelled.built).inventory).not.toBe(contextOf(a.built).inventory);
    const fewer = setup({ evidence: [EVIDENCE[0]!] });
    expect(contextOf(fewer.built).inventory).not.toBe(contextOf(a.built).inventory);
    const plan = a.run.plan.ok ? a.run.plan.plan : null;
    expect(inventoryFingerprint(usableCandidates(a.run.inventory, plan!))).toBe(
      contextOf(a.built).inventory,
    );
  });
});

describe("checking a ranking", () => {
  const { run, built } = setup();
  const c = contextOf(built);
  const c240 = CUT_240(run.seq);
  const c408 = CUT_408(run.seq);

  it("accepts offered cuts and candidates, best first, with short reasons", () => {
    const r = checkRanking(
      reply(c, [
        { cutId: c240, choices: [pick("cand:street-1", "The highway line."), pick("cand:park-1")] },
      ]),
      c,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.byCut.keys()]).toEqual([c240]);
      expect(r.byCut.get(c240)!.map((x) => x.candidateId)).toEqual([
        "cand:street-1",
        "cand:park-1",
      ]);
      expect(r.summary).toBe("Street first at the highway line.");
    }
    expect(checkRanking(reply(c, [{ cutId: c408, choices: [pick("cand:park-1")] }]), c).ok).toBe(
      true,
    );
  });

  it.each([
    [
      "an unknown candidate",
      () => [{ cutId: c240, choices: [pick("cand:invented")] }],
      "unknown-candidate",
    ],
    [
      "a media id instead of a candidate",
      () => [{ cutId: c240, choices: [pick("clip-005")] }],
      "unknown-candidate",
    ],
    [
      "the same candidate twice in a cut",
      () => [{ cutId: c240, choices: [pick("cand:park-1"), pick("cand:park-1")] }],
      "duplicate",
    ],
    [
      "the same candidate for two cuts",
      () => [
        { cutId: c240, choices: [pick("cand:park-1")] },
        { cutId: c408, choices: [pick("cand:park-1")] },
      ],
      "duplicate",
    ],
    [
      "the same cut twice",
      () => [
        { cutId: c240, choices: [pick("cand:park-1")] },
        { cutId: c240, choices: [pick("cand:street-1")] },
      ],
      "duplicate",
    ],
    [
      "a cut it wasn't offered",
      () => [{ cutId: "cut:x|y@100", choices: [pick("cand:park-1")] }],
      "unknown-cut",
    ],
    ["no rankings", () => [], "malformed"],
    ["rankings that aren't a list", () => "cand:park-1", "malformed"],
    ["an empty choice list", () => [{ cutId: c240, choices: [] }], "malformed"],
    [
      "six choices",
      () => [{ cutId: c240, choices: Array.from({ length: 6 }, (_, i) => pick(`cand:${i}`)) }],
      "malformed",
    ],
    [
      "a pick with no reason",
      () => [{ cutId: c240, choices: [{ candidateId: "cand:park-1" }] }],
      "malformed",
    ],
    [
      "a pick with an over-long reason",
      () => [{ cutId: c240, choices: [pick("cand:park-1", "x".repeat(301))] }],
      "malformed",
    ],
    [
      "a source range on a pick",
      () => [{ cutId: c240, choices: [{ ...pick("cand:park-1"), sourceInFrame: 0 }] }],
      "unsupported-field",
    ],
    [
      "a track on a cut ranking",
      () => [{ cutId: c240, trackId: "V2", choices: [pick("cand:park-1")] }],
      "unsupported-field",
    ],
  ])("refuses %s", (_n, rankings, code) => {
    const r = checkRanking(reply(c, rankings()), c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it.each([
    ["timeline commands", { operations: [{ op: "place" }] }],
    ["ownership", { editedBy: "director" }],
    ["a protection override", { allowProtected: true }],
    ["acceptance", { accept: true }],
    ["new media", { media: [{ id: "clip-999" }] }],
  ])("refuses a reply carrying %s", (_n, extra) => {
    const r = checkRanking(reply(c, [{ cutId: c240, choices: [pick("cand:park-1")] }], extra), c);
    expect(!r.ok && r.code).toBe("unsupported-field");
  });

  it("refuses malformed replies and an envelope for another cut, version or inventory", () => {
    const ok = [{ cutId: c240, choices: [pick("cand:park-1")] }];
    expect(checkRanking(null, c)).toMatchObject({ ok: false, code: "malformed" });
    expect(checkRanking("ranking", c)).toMatchObject({ ok: false, code: "malformed" });
    expect(checkRanking({ ...reply(c, ok), schema: "ae.story-plan/1" }, c)).toMatchObject({
      ok: false,
      code: "malformed",
    });
    expect(
      checkRanking({ ...reply(c, ok), base: { ...reply(c, ok).base, approved: true } }, c),
    ).toMatchObject({ ok: false, code: "malformed" });
    for (const k of ["versionId", "revision", "inventory"] as const) {
      const r = checkRanking({ ...reply(c, ok), base: { ...reply(c, ok).base, [k]: "other" } }, c);
      expect(r).toMatchObject({ ok: false, code: "stale" });
    }
  });
});

describe("a validated ranking only reorders the planner's options", () => {
  const ranked = (run: CoverageRun, ctx: ProposalContext, rankings: unknown) => {
    const c = contextOf(
      buildRankContext(run.seq, run.analysis, run.inventory, run.plan.plan, TRANSCRIPT),
    );
    const r = checkRanking(reply(c, rankings), c);
    if (!r.ok) throw new Error(r.reason);
    return runCoverage(
      ctx,
      { clips: CLIPS, visualEvidence: EVIDENCE, transcript: TRANSCRIPT },
      r.byCut,
    )!;
  };

  it("the AI's first pick that fits is placed — by the same planner, compiler and review; other cuts stay deterministic", () => {
    const { ctx, run } = setup();
    if (!run.plan.ok) throw new Error("plan");
    const det = run.plan.plan.placements;
    expect(det.map((p) => [p.cutTc, p.candidateId, p.ranking])).toEqual([
      ["00:00:10:00", "cand:park-1", "deterministic"],
      ["00:00:17:00", "cand:street-1", "deterministic"],
    ]);
    const ai = ranked(run, ctx, [
      {
        cutId: CUT_240(run.seq),
        choices: [pick("cand:street-1", "Empty street for the highway line.")],
      },
    ]);
    if (!ai.plan.ok || !ai.compiled?.ok) throw new Error("ai plan");
    const p = ai.plan.plan;
    expect(p.ranking).toBe("ai-assisted");
    expect(p.placements.map((x) => [x.cutTc, x.candidateId, x.ranking])).toEqual([
      ["00:00:10:00", "cand:street-1", "ai"],
      ["00:00:17:00", "cand:park-1", "deterministic"],
    ]);
    const first = p.placements[0]!;
    expect(first.aiReason).toBe("Empty street for the highway line.");
    expect(first.reason).toMatch(
      /^AI-assisted ranking put this shot first for this cut: Empty street/,
    );
    expect(first.uncertainty.join(" ")).toMatch(/hasn't seen the footage/);
    // Same frame rules as the deterministic plan: ~1 s before, 1.5 s after.
    expect([first.startFrame, first.endFrame, first.before, first.after]).toEqual([
      216, 276, 24, 36,
    ]);
    // A distinct proposal, reviewed like any other.
    expect(ai.compiled.review.ok).toBe(true);
    expect(ai.compiled.proposal["id"]).not.toBe(run.compiled?.ok && run.compiled.proposal["id"]);
    expect(ai.compiled.proposal["instruction"]).toMatch(/AI-assisted ranking/);
    expect((ai.compiled.proposal["operations"] as Array<{ op: string }>).map((o) => o.op)).toEqual([
      "place",
      "place",
    ]);
  });

  it("an AI pick that doesn't fit (its footage is already used in this plan) falls back to the deterministic choice, and says so", () => {
    const evidence = [...EVIDENCE, ev("park-1b", "clip-005", "00:00:03:12", "Park sign again")];
    const { ctx, run } = setup({ evidence });
    const c = contextOf(
      buildRankContext(run.seq, run.analysis, run.inventory, run.plan.plan, TRANSCRIPT),
    );
    const r = checkRanking(
      reply(c, [{ cutId: CUT_408(run.seq), choices: [pick("cand:park-1b")] }]),
      c,
    );
    if (!r.ok) throw new Error(r.reason);
    const ai = runCoverage(
      ctx,
      { clips: CLIPS, visualEvidence: evidence, transcript: TRANSCRIPT },
      r.byCut,
    )!;
    if (!ai.plan.ok) throw new Error("plan");
    const at408 = ai.plan.plan.placements.find((x) => x.cutTc === "00:00:17:00")!;
    expect(at408.ranking).toBe("deterministic");
    expect(at408.candidateId).not.toBe("cand:park-1b");
    expect(at408.uncertainty.join(" ")).toMatch(/None of the AI's picks for this cut fit/);
  });

  it("protection still decides: a ranking for a protected cut can't pass the check, and the planner skips it even if handed one", () => {
    const base = directorSequence();
    const locked = protect(base, { itemId: item(base, "event-3").id }, { aiLocked: true });
    const { ctx, run } = setup({ seq: locked });
    const c = contextOf(
      buildRankContext(run.seq, run.analysis, run.inventory, run.plan.plan, TRANSCRIPT),
    );
    expect(c.cuts.map((x) => x.tc)).toEqual(["00:00:10:00"]); // 408 touches protected e3
    const r = checkRanking(
      reply(c, [{ cutId: CUT_408(run.seq), choices: [pick("cand:park-1")] }]),
      c,
    );
    expect(!r.ok && r.code).toBe("unknown-cut");
    // Handed straight to the planner, bypassing the check: still skipped.
    const forced = planCoverage({
      seq: run.seq,
      versionId: run.versionId,
      media: mediaOf(CLIPS),
      analysis: analyzeCoverage(run.seq, run.versionId),
      inventory: brollInventory(run.seq, { clips: CLIPS, visualEvidence: EVIDENCE }),
      visualEvidence: EVIDENCE,
      transcript: TRANSCRIPT,
      ranking: new Map([[CUT_408(run.seq), [pick("cand:park-1")]]]),
    });
    const plan = forced.ok ? forced.plan : forced.plan!;
    expect(plan.placements.some((x) => x.cutTc === "00:00:17:00")).toBe(false);
    expect(plan.skipped.find((x) => x.cutTc === "00:00:17:00")!.code).toBe(
      "director-may-not-cover",
    );
    void ctx;
  });
});
