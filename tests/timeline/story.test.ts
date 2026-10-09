// Phase 6, Milestone 3 — the story context (src/lib/timeline/story-context.ts)
// and the deterministic story-plan compiler (src/lib/timeline/story-plan.ts).
// Pure: a plan (ids only) → existing proposal operations → reviewProposal.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 (clip-002 01:02–01:12) · e2 240–408 (clip-002 00:25–00:32)
//       e3 408–552 (clip-002 00:43–00:49) · e5 552–696 (clip-001 00:22–00:28)
//       e6 696–792 (clip-002 01:28–01:32)
//   V2: e4 420–532 (inside e3) · e7 708–784 (inside e6) · A1 under every V1 clip
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  Clip,
  EditVersion,
  Select,
  StoryCandidate,
  TranscriptSegment,
  UniversalTimeline,
} from "@/lib/ae/types";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { acceptProposal, sequenceRevision, type ProposalContext } from "@/lib/timeline/proposals";
import { endFrame, itemsOnTrack } from "@/lib/timeline/selectors";
import { buildStoryContext, linesOf, STORY_CONTEXT_SCHEMA } from "@/lib/timeline/story-context";
import {
  compileStoryPlan,
  cutawayRelationIssues,
  STORY_PLAN_SCHEMA,
  type CompiledStoryPlan,
  type StoryPlan,
} from "@/lib/timeline/story-plan";
import { rateFromFps } from "@/lib/timeline/time";
import type { Sequence } from "@/lib/timeline/types";
import {
  importedSequence,
  sequenceOf,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf, protect } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";
import { itemIdOf } from "./proposal-fixtures";

const media = mediaOf(projectClips);
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
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const ctxOf = (ws: Workspace, active = "v2"): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});
/** What the store passes when accepting: the project's analysis ids. */
const inventoryOf = (an: {
  selects: Array<{ id: string }>;
  transcript: Array<{ id: string }>;
}) => ({
  selectIds: new Set(an.selects.map((x) => x.id)),
  transcriptIds: new Set(an.transcript.map((x) => x.id)),
  visualIds: new Set<string>(),
});
const seqOf = (ws: Workspace, v = "v2") => sequenceOf(ws, v, projectClips)!;
const id = (s: Sequence, name: string) => itemIdOf(s, name);

/* ------------------------------- analysis -------------------------------- */

const seg = (
  sid: string,
  clipId: string,
  startTc: string,
  endTc: string,
  extra: Partial<TranscriptSegment> = {},
): TranscriptSegment => ({
  id: sid,
  clipId,
  speaker: "Unknown speaker",
  startTc,
  endTc,
  text: `Line ${sid}.`,
  confidence: 0.9,
  ...extra,
});
const TRANSCRIPT: TranscriptSegment[] = [
  seg("t-e1a", "clip-002", "00:01:03:00", "00:01:06:00"),
  seg("t-e1x", "clip-002", "00:01:10:00", "00:01:14:00"), // runs past e1's out point
  seg("t-e2x", "clip-002", "00:00:24:00", "00:00:27:00"), // starts before e2's in point
  seg("t-e2a", "clip-002", "00:00:28:00", "00:00:31:00"),
  seg("t-e3s", "clip-002", "00:00:42:00", "00:00:50:00"), // spans e3
  seg("t-e5", "clip-001", "00:00:23:00", "00:00:25:00", { confidence: 0 }),
  seg("t-e6q", "clip-002", "00:01:29:00", "00:01:31:00", { text: "And then what?" }),
  seg("t-off", "clip-002", "00:00:05:00", "00:00:07:00"), // not on the timeline
];
const sel = (
  sid: string,
  clipId: string,
  startTc: string,
  endTc: string,
  score: number,
  category: Select["category"],
): Select => ({
  id: sid,
  rank: 1,
  speaker: "Unknown speaker",
  clipId,
  clipName: clipId,
  startTc,
  endTc,
  durationSeconds: 5,
  score,
  category,
  transcriptExcerpt: "…",
  reasons: [],
  evidence: [],
});
const SELECTS: Select[] = [
  sel("sel-01", "clip-002", "00:00:25:00", "00:00:32:00", 92, "strong-statement"),
  sel("sel-02", "clip-002", "00:01:02:00", "00:01:12:00", 88, "emotional"),
  sel("sel-03", "clip-002", "00:00:43:00", "00:00:49:00", 85, "context"),
  sel("sel-09", "clip-005", "00:00:01:00", "00:00:03:00", 50, "humor"), // not on the timeline
];
const STORIES: StoryCandidate[] = [
  {
    id: "story-01",
    title: "Highway",
    premise: "…",
    estimatedSeconds: 30,
    confidence: 0.8,
    supportingSelectIds: ["sel-01", "sel-02", "sel-03"],
    beats: [
      {
        id: "b1",
        label: "Hook",
        intent: "Open on emotion",
        estimatedSeconds: 10,
        selectIds: ["sel-02"],
      },
      {
        id: "b2",
        label: "Context",
        intent: "What happened",
        estimatedSeconds: 20,
        selectIds: ["sel-01", "sel-03"],
      },
    ],
  },
];
const ANALYSIS = {
  selects: SELECTS,
  transcript: TRANSCRIPT,
  stories: STORIES,
  chosenStoryId: "story-01",
};

/* --------------------------------- plans --------------------------------- */

function plan(ws: Workspace, v: string, p: Partial<StoryPlan>): StoryPlan {
  return {
    schema: STORY_PLAN_SCHEMA,
    base: { versionId: v, revision: sequenceRevision(seqOf(ws, v)) },
    instruction: "Start with the context, then the strong statement",
    summary: "Moves the context section ahead of the strong statement.",
    order: [],
    ...p,
  };
}
const compile = (ws: Workspace, p: unknown, v = "v2") =>
  compileStoryPlan(p, ctxOf(ws, v), ANALYSIS);
const codes = (r: CompiledStoryPlan) => (r.ok ? [] : r.issues.map((i) => i.code));
const reviewCodes = (r: CompiledStoryPlan) =>
  r.ok ? [] : r.issues.map((i) => i.review?.code ?? null);

/** The order e1, e3, e2, e5, e6 — e2 and e3 swap; e4 (inside e3) keeps with it. */
function swap23(ws: Workspace, v = "v2", extra: Partial<StoryPlan> = {}): StoryPlan {
  const s = seqOf(ws, v);
  return plan(ws, v, {
    order: ["event-1", "event-3", "event-2", "event-5", "event-6"].map((n) => id(s, n)),
    cutaways: { [id(s, "event-4")]: "keep" },
    rationale: [
      {
        clipId: id(s, "event-3"),
        reason: "Context first.",
        evidence: [{ kind: "select", id: "sel-03" }],
      },
      {
        clipId: id(s, "event-2"),
        reason: "The statement lands after the context.",
        evidence: [{ kind: "transcript", id: "t-e2a" }],
      },
    ],
    ...extra,
  });
}

/** A working version whose sequence was changed directly (test setup only). */
function workingWith(change: (s: Sequence) => Sequence): Workspace {
  const seq = change(importedSequence(director, projectClips));
  return deepFreeze({
    versions: [
      structuredClone(director),
      { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
    ],
    histories: { ver_w: createHistory(seq) },
  } as Workspace);
}
const edited = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return deepFreeze(n);
};
/** e4 moved across the e2/e3 cut at 408 (as Director jump-cut coverage sits). */
const straddling = () =>
  workingWith((s) =>
    edited(s, (n) => {
      n.items[id(s, "event-4")]!.startFrame = 396;
    }),
  );

/* -------------------------------- context -------------------------------- */

describe("story context", () => {
  it("interview clips in order, with ids, source ranges, linked audio, ownership and the version they describe", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const c = buildStoryContext(ctxOf(ws), ANALYSIS, projectClips)!;
    expect(c.schema).toBe(STORY_CONTEXT_SCHEMA);
    expect([c.versionId, c.revision, c.fps, c.durationFrames]).toEqual([
      "v2",
      sequenceRevision(s),
      24,
      792,
    ]);
    expect(c.interview.map((x) => x.id)).toEqual(
      ["event-1", "event-2", "event-3", "event-5", "event-6"].map((n) => id(s, n)),
    );
    const e1 = c.interview[0]!;
    expect(e1).toMatchObject({
      file: "CLIP-002.MP4",
      mediaClipId: "clip-002",
      mediaFps: 23.976,
      start: 0,
      end: 240,
      sourceInTc: "00:01:02:00",
      sourceOutTc: "00:01:12:00",
      owner: "director",
      locked: false,
      aiLocked: false,
      directorMayChange: true,
      backToBackWithNext: true,
    });
    expect(e1.linked).toHaveLength(1);
    expect(s.items[e1.linked[0]!]!.trackId).not.toBe(s.items[e1.id]!.trackId); // its A1
    expect(c.interview.at(-1)!.backToBackWithNext).toBe(false);
    expect(JSON.stringify(c)).not.toMatch(/\/Users\/|relPath/);
  });

  it("maps transcript lines to clips, marking lines that run past an in or out point", () => {
    const ws = fresh();
    const c = buildStoryContext(ctxOf(ws), ANALYSIS, projectClips)!;
    const lines = (n: number) => c.interview[n]!.lines.map((l) => [l.id, l.placement]);
    expect(lines(0)).toEqual([
      ["t-e1a", "inside"],
      ["t-e1x", "crosses-out"],
    ]);
    expect(lines(1)).toEqual([
      ["t-e2x", "crosses-in"],
      ["t-e2a", "inside"],
    ]);
    expect(lines(2)).toEqual([["t-e3s", "spans"]]);
    expect(c.interview[3]!.lines[0]).toMatchObject({ id: "t-e5", lowConfidence: true });
    expect(c.interview[4]!.lines[0]).toMatchObject({ id: "t-e6q", question: true });
    expect(JSON.stringify(c.interview)).not.toContain("t-off");
    expect(c.caveats.join(" ")).toMatch(/Speakers are not identified/);
    expect(c.caveats.join(" ")).toMatch(/low-confidence/);
  });

  it("selects, story beats, cutaways and protection", () => {
    const base = importedSequence(director, projectClips);
    const ws = workingWith(() =>
      protect(base, { itemId: id(base, "event-5") }, { aiLocked: true }),
    );
    const s = seqOf(ws, "ver_w");
    const c = buildStoryContext(ctxOf(ws, "ver_w"), ANALYSIS, projectClips)!;
    const byId = new Map(c.interview.map((x) => [x.id, x]));
    expect(byId.get(id(s, "event-2"))!.select).toEqual({
      id: "sel-01",
      score: 92,
      category: "strong-statement",
    });
    expect(byId.get(id(s, "event-1"))!.beatIds).toEqual(["b1"]);
    expect(byId.get(id(s, "event-3"))!.beatIds).toEqual(["b2"]);
    expect(c.story!.beats.map((b) => b.clipIds)).toEqual([
      [id(s, "event-1")],
      [id(s, "event-2"), id(s, "event-3")],
    ]);
    expect(byId.get(id(s, "event-5"))).toMatchObject({ aiLocked: true, directorMayChange: false });
    expect(c.cutaways.map((x) => [x.id, x.insideClipId, x.crossesCut])).toEqual([
      [id(s, "event-4"), id(s, "event-3"), false],
      [id(s, "event-7"), id(s, "event-6"), false],
    ]);
    const cross = buildStoryContext(ctxOf(straddling(), "ver_w"), ANALYSIS, projectClips)!;
    expect(cross.cutaways[0]).toMatchObject({ insideClipId: null, crossesCut: true });
    expect(cross.cutaways[0]!.over).toHaveLength(2);
    expect(c.selects.map((x) => x.id)).toContain("sel-09");
  });

  it.each([23.976, 24, 29.97])(
    "maps lines on the media's own clock at %s fps — exact at the boundaries",
    (fps) => {
      const media = clip("c-rate", fps, 120);
      const timeline: UniversalTimeline = {
        id: "tl",
        name: "rate",
        fps: 24,
        targetSeconds: 10,
        totalSeconds: 10,
        decisions: [
          {
            id: "d1",
            lane: "interview",
            clipId: "c-rate",
            label: "one",
            sourceInTc: "00:00:10:00",
            sourceOutTc: "00:00:20:00",
            timelineStartSeconds: 0,
            durationSeconds: 10,
          },
        ],
      };
      const s = importedSequence({ ...director, timeline }, [media]);
      const it0 = Object.values(s.items).find((i) => i.legacy?.decision.id === "d1")!;
      expect(it0.mediaRate).toEqual(rateFromFps(fps));
      const last = Math.round(fps) - 1; // last frame label of a second
      const t = (sid: string, a: string, b: string) => seg(sid, "c-rate", a, b);
      const got = linesOf(it0, [
        t("ends-at-in", "00:00:08:00", "00:00:10:00"), // touches the in point: not in the clip
        t("one-before", `00:00:09:${last}`, "00:00:11:00"), // one frame before: crosses in
        t("inside", "00:00:10:00", "00:00:20:00"), // exactly the clip
        t("one-after", "00:00:19:00", "00:00:20:01"), // one frame past the out point
        t("starts-at-out", "00:00:20:00", "00:00:22:00"), // starts at the out point: not in it
      ]).map((l) => [l.id, l.placement]);
      expect(got).toEqual([
        ["one-before", "crosses-in"],
        ["inside", "inside"],
        ["one-after", "crosses-out"],
      ]);
    },
  );
});

/* ------------------------------- compiling ------------------------------- */

describe("valid story plans compile to existing proposal operations", () => {
  it("a reorder: only the changed run is reordered; a cutaway inside a moved clip goes with it", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(ws, swap23(ws));
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.proposal["operations"]).toEqual([
      { op: "reorder", itemIds: [id(s, "event-3"), id(s, "event-2")] },
    ]);
    expect(r.proposal["rationale"]).toEqual([
      { opIndex: 0, reason: "Context first.", evidence: [{ kind: "select", id: "sel-03" }] },
      {
        opIndex: 0,
        reason: "The statement lands after the context.",
        evidence: [{ kind: "transcript", id: "t-e2a" }],
      },
    ]);
    const p = r.review.preview;
    expect([p.items[id(s, "event-3")]!.startFrame, p.items[id(s, "event-2")]!.startFrame]).toEqual([
      240, 384,
    ]);
    expect(p.items[id(s, "event-4")]!.startFrame).toBe(252); // still 12 frames into e3
    for (const n of ["event-2", "event-3"]) {
      const it = p.items[id(s, n)]!;
      const a1 = Object.values(p.items).find(
        (x) => x.linkGroupId === it.linkGroupId && x.id !== it.id,
      )!;
      expect([a1.startFrame, endFrame(a1)]).toEqual([it.startFrame, endFrame(it)]); // in sync
    }
    expect(findViolations(p, { media })).toEqual([]);
    expect(seqOf(ws)).toBe(s); // nothing applied
  });

  it("a removal closes the gap; a cutaway over a later, unchanged clip needs no decision", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const order = ["event-1", "event-2", "event-3", "event-6"].map((n) => id(s, n));
    const r = compile(
      ws,
      plan(ws, "v2", {
        order,
        remove: [id(s, "event-5")],
        rationale: [
          {
            clipId: id(s, "event-5"),
            reason: "Repeats the context.",
            evidence: [{ kind: "transcript", id: "t-e5" }],
          },
        ],
      }),
    );
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.proposal["operations"]).toEqual([
      { op: "remove", itemIds: [id(s, "event-5")], ripple: true },
    ]);
    expect(r.review.preview.items[id(s, "event-6")]!.startFrame).toBe(552);
    expect(r.review.preview.items[id(s, "event-7")]!.startFrame).toBe(564); // rippled with e6
    // Low-confidence evidence is flagged, not trusted silently.
    expect(r.warnings.join(" ")).toMatch(/low-confidence transcript \(t-e5\)/);
    expect((r.proposal["rationale"] as Array<{ reason: string }>)[0]!.reason).toMatch(
      /\[cites low-confidence transcript: t-e5\]$/,
    );
  });

  it("an explicitly removed cutaway is a visible operation in the proposal", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(
      ws,
      plan(ws, "v2", {
        order: ["event-1", "event-2", "event-5", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-3")],
        cutaways: { [id(s, "event-4")]: "remove" },
        rationale: [{ clipId: id(s, "event-3"), reason: "Repeats event 2." }],
      }),
    );
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.proposal["operations"]).toEqual([
      { op: "remove", itemIds: [id(s, "event-4")], ripple: false },
      { op: "remove", itemIds: [id(s, "event-3")], ripple: true },
    ]);
    expect(r.review.preview.items[id(s, "event-4")]).toBeUndefined();
    expect(r.review.changedIds).toContain(id(s, "event-4"));
    expect(r.warnings.join(" ")).toMatch(/No evidence is cited for removing/);
  });
});

describe("cutaways: explicit, safe decisions only — never silent", () => {
  it("a decision is required for every cutaway the change touches", () => {
    const ws = fresh();
    const r = compile(ws, swap23(ws, "v2", { cutaways: {} }));
    expect(codes(r)).toEqual(["cutaway-decision-missing"]);
    if (!r.ok) expect(r.issues[0]!.ids).toEqual([id(seqOf(ws), "event-4")]);
  });

  it("decisions for untouched or unknown cutaways, or for interview clips, are invalid", () => {
    const ws = fresh();
    const s = seqOf(ws);
    for (const extra of [
      { [id(s, "event-7")]: "keep" as const }, // over e6, which doesn't change
      { itm_ghost: "remove" as const },
      { [id(s, "event-1")]: "remove" as const },
    ]) {
      const r = compile(
        ws,
        swap23(ws, "v2", { cutaways: { [id(s, "event-4")]: "keep", ...extra } }),
      );
      expect(codes(r)).toEqual(["invalid-cutaway-decision"]);
    }
    const bad = { ...swap23(ws), cutaways: { [id(s, "event-4")]: "move" } };
    expect(codes(compile(ws, bad))).toEqual(["malformed"]);
  });

  it("a cutaway across a changed edit point can't be kept — the plan must remove it, visibly", () => {
    const ws = straddling();
    const s = seqOf(ws, "ver_w");
    const keep = compile(ws, swap23(ws, "ver_w"), "ver_w");
    expect(codes(keep)).toEqual(["cutaway-cannot-stay"]);
    if (!keep.ok)
      expect(keep.issues[0]!.message).toMatch(/runs across an edit point the plan changes/);
    const removed = compile(
      ws,
      swap23(ws, "ver_w", { cutaways: { [id(s, "event-4")]: "remove" } }),
      "ver_w",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.proposal["operations"]).toEqual([
      { op: "remove", itemIds: [id(s, "event-4")], ripple: false },
      { op: "reorder", itemIds: [id(s, "event-3"), id(s, "event-2")] },
    ]);
  });

  it("a cutaway across an edit point the plan doesn't touch stays, with no decision needed", () => {
    const ws = straddling();
    const s = seqOf(ws, "ver_w");
    const r = compile(
      ws,
      plan(ws, "ver_w", {
        order: ["event-1", "event-2", "event-3", "event-6", "event-5"].map((n) => id(s, n)),
        cutaways: { [id(s, "event-7")]: "keep" },
        rationale: [
          { clipId: id(s, "event-6"), reason: "Earlier." },
          { clipId: id(s, "event-5"), reason: "Later." },
        ],
      }),
      "ver_w",
    );
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
    if (r.ok)
      expect(r.review.preview.items[id(s, "event-4")]).toBe(
        seqOf(ws, "ver_w").items[id(s, "event-4")],
      );
  });

  it("a cutaway over a removed clip can't be kept", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(
      ws,
      plan(ws, "v2", {
        order: ["event-1", "event-2", "event-5", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-3")],
        cutaways: { [id(s, "event-4")]: "keep" },
        rationale: [{ clipId: id(s, "event-3"), reason: "Repeats." }],
      }),
    );
    expect(codes(r)).toEqual(["cutaway-cannot-stay"]);
  });
});

describe("invalid plans are refused with a reason", () => {
  it.each<[string, (ws: Workspace, s: Sequence) => unknown, string[]]>([
    ["not an object", () => "plan", ["malformed"]],
    ["the wrong schema", (ws) => ({ ...swap23(ws), schema: "ae.story-plan/9" }), ["malformed"]],
    ["an unknown field", (ws) => ({ ...swap23(ws), operations: [] }), ["malformed"]],
    ["self-authorization", (ws) => ({ ...swap23(ws), allowManual: true }), ["self-authorization"]],
    ["an empty order", (ws) => ({ ...swap23(ws), order: [] }), ["malformed"]],
    [
      "an invented clip",
      (ws, s) => ({
        ...swap23(ws),
        order: [...swap23(ws).order.slice(0, 4), "itm_invented", id(s, "event-6")],
      }),
      ["unknown-clip"],
    ],
    [
      "a cutaway in the order",
      (ws, s) => ({ ...swap23(ws), order: [...swap23(ws).order, id(s, "event-4")] }),
      ["not-interview"],
    ],
    [
      "a duplicate",
      (ws, s) => ({ ...swap23(ws), order: [...swap23(ws).order, id(s, "event-1")] }),
      ["duplicate"],
    ],
    [
      "an incomplete order",
      (ws) => ({ ...swap23(ws), order: swap23(ws).order.slice(0, 4) }),
      ["incomplete-order"],
    ],
    ["kept and removed", (ws, s) => ({ ...swap23(ws), remove: [id(s, "event-1")] }), ["duplicate"]],
    [
      "no change at all",
      (ws, s) =>
        plan(ws, "v2", {
          order: ["event-1", "event-2", "event-3", "event-5", "event-6"].map((n) => id(s, n)),
        }),
      ["no-change"],
    ],
    [
      "a moved clip with no reason",
      (ws, s) =>
        swap23(ws, "v2", { rationale: [{ clipId: id(s, "event-3"), reason: "Context first." }] }),
      ["missing-rationale"],
    ],
  ])("%s", (_name, make, want) => {
    const ws = fresh();
    expect(codes(compile(ws, make(ws, seqOf(ws))))).toEqual(want);
  });

  it("a stale plan: the cut changed after it was made", () => {
    const ws = fresh();
    const p = swap23(ws);
    const moved = workingWith((s) =>
      edited(s, (n) => {
        n.items[id(s, "event-7")]!.startFrame += 1;
      }),
    );
    expect(
      codes(compile(moved, { ...p, base: { ...p.base, versionId: "ver_w" } }, "ver_w")),
    ).toEqual(["stale"]);
    expect(codes(compile(ws, { ...p, base: { ...p.base, versionId: "ver_other" } }))).toEqual([
      "stale",
    ]);
  });

  it("interview clips that aren't back to back", () => {
    const ws = workingWith((s) =>
      edited(s, (n) => {
        for (const it of Object.values(n.items)) if (it.startFrame >= 696) it.startFrame += 10; // a gap before e6
      }),
    );
    expect(codes(compile(ws, swap23(ws, "ver_w"), "ver_w"))).toEqual(["not-contiguous"]);
  });
});

describe("evidence", () => {
  const withEvidence = (
    ws: Workspace,
    clipName: string,
    evidence: Array<{ kind: "transcript" | "select"; id: string }>,
  ) => {
    const s = seqOf(ws);
    return swap23(ws, "v2", {
      rationale: [
        {
          clipId: id(s, "event-3"),
          reason: "Context.",
          ...(clipName === "event-3" ? { evidence } : {}),
        },
        {
          clipId: id(s, "event-2"),
          reason: "Statement.",
          ...(clipName === "event-2" ? { evidence } : {}),
        },
      ],
    });
  };

  it.each<[string, string, { kind: "transcript" | "select"; id: string }, string]>([
    [
      "an invented transcript line",
      "event-3",
      { kind: "transcript", id: "t-nope" },
      "unknown-evidence",
    ],
    ["an invented select", "event-3", { kind: "select", id: "sel-nope" }, "unknown-evidence"],
    [
      "another clip's transcript line",
      "event-3",
      { kind: "transcript", id: "t-e1a" },
      "wrong-clip-evidence",
    ],
    [
      "a line from the clip's media but outside its range",
      "event-2",
      { kind: "transcript", id: "t-off" },
      "wrong-clip-evidence",
    ],
    ["another clip's select", "event-3", { kind: "select", id: "sel-02" }, "wrong-clip-evidence"],
    [
      "a select from other media",
      "event-2",
      { kind: "select", id: "sel-09" },
      "wrong-clip-evidence",
    ],
  ])("%s is refused", (_n, clipName, e, code) => {
    const ws = fresh();
    expect(codes(compile(ws, withEvidence(ws, clipName, [e])))).toEqual([code]);
  });

  it("a line that only runs into the clip still counts as its evidence; a select overlapping its range too", () => {
    const ws = fresh();
    const r = compile(
      ws,
      withEvidence(ws, "event-2", [
        { kind: "transcript", id: "t-e2x" },
        { kind: "select", id: "sel-01" },
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it("evidence on a removed cutaway's rationale is refused (it belongs to interview clips)", () => {
    const ws = straddling();
    const s = seqOf(ws, "ver_w");
    const p = swap23(ws, "ver_w", { cutaways: { [id(s, "event-4")]: "remove" } });
    p.rationale!.push({
      clipId: id(s, "event-4"),
      reason: "Crosses the new cut.",
      evidence: [{ kind: "select", id: "sel-03" }],
    });
    expect(codes(compile(ws, p, "ver_w"))).toEqual(["wrong-clip-evidence"]);
    p.rationale!.pop();
    p.rationale!.push({ clipId: id(s, "event-4"), reason: "Crosses the new cut." });
    expect(compile(ws, p, "ver_w").ok).toBe(true);
  });
});

describe("protection: the proposal engine decides — refusals come back with its reasons", () => {
  it("AI-protected, locked or hand-edited clips, and their linked audio", () => {
    const base = importedSequence(director, projectClips);
    const e3 = id(base, "event-3");
    const a1 = Object.values(base.items).find(
      (x) => x.linkGroupId === base.items[e3]!.linkGroupId && x.id !== e3,
    )!.id;
    const cases: Array<[string, Sequence, string]> = [
      ["aiLocked clip", protect(base, { itemId: e3 }, { aiLocked: true }), "protected"],
      ["locked linked audio", protect(base, { itemId: a1 }, { locked: true }), "protected"],
      ["locked track", protect(base, { trackName: "V1" }, { locked: true }), "protected"],
      [
        "hand-edited clip",
        edited(base, (n) => {
          n.items[e3]!.editedBy = "manual";
        }),
        "manual-conflict",
      ],
      [
        "unverified clip",
        edited(base, (n) => {
          n.items[e3]!.editedBy = "unknown";
        }),
        "ownership-unknown",
      ],
    ];
    for (const [name, seq, want] of cases) {
      const ws = workingWith(() => seq);
      const r = compile(ws, swap23(ws, "ver_w"), "ver_w");
      expect(codes(r)[0], name).toBe("review-refused");
      expect(reviewCodes(r), name).toContain(want);
      if (!r.ok) expect(r.proposal, name).toBeDefined(); // compiled, then refused
    }
  });

  it("a ripple that would shift a hand-edited clip is refused — atomically, nothing touched", () => {
    const base = importedSequence(director, projectClips);
    const ws = workingWith(() =>
      edited(base, (n) => {
        n.items[id(base, "event-6")]!.editedBy = "manual";
      }),
    );
    const s = seqOf(ws, "ver_w");
    const before = JSON.stringify(ws);
    const r = compile(
      ws,
      plan(ws, "ver_w", {
        order: ["event-1", "event-2", "event-3", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-5")],
        rationale: [{ clipId: id(s, "event-5"), reason: "Repeats." }],
      }),
      "ver_w",
    );
    expect(codes(r)).toContain("review-refused");
    expect(reviewCodes(r)).toContain("manual-conflict");
    expect(JSON.stringify(ws)).toBe(before);
  });
});

describe("jump cuts — reported, never acted on", () => {
  it("new same-source joins without B-roll over them are named; different sources are not jump cuts", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(ws, swap23(ws));
    if (!r.ok) throw new Error("compile failed");
    const points = r.editPoints.map((e) => [e.tc, e.isNew, e.jumpCut, e.covered]);
    expect(points).toEqual([
      ["00:00:10:00", true, true, false], // e1 → e3 (both clip-002)
      ["00:00:16:00", true, true, false], // e3 → e2 (clip-002; e4 ends at 364 < 384)
      ["00:00:23:00", true, false, false], // e2 → e5 (clip-001): not a jump cut
      ["00:00:29:00", false, false, false], // e5 → e6 unchanged (e7 starts at 708)
    ]);
    expect(r.warnings.filter((w) => w.startsWith("New jump cut"))).toHaveLength(2);
    // Informational: the proposal contains only the reorder — no B-roll added.
    expect((r.proposal["operations"] as unknown[]).length).toBe(1);
    expect(Object.keys(r.review.preview.items).sort()).toEqual(Object.keys(s.items).sort());
  });

  it("removing a cutaway that covered an existing jump cut is reported too", () => {
    const ws = straddling(); // e4 covers the e2/e3 jump cut at 408
    const s = seqOf(ws, "ver_w");
    const r = compile(
      ws,
      plan(ws, "ver_w", {
        order: ["event-1", "event-2", "event-3", "event-6", "event-5"].map((n) => id(s, n)),
        cutaways: { [id(s, "event-7")]: "remove" },
        rationale: [
          { clipId: id(s, "event-6"), reason: "Earlier." },
          { clipId: id(s, "event-5"), reason: "Later." },
        ],
      }),
      "ver_w",
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.editPoints.find((e) => e.tc === "00:00:17:00")).toMatchObject({
      isNew: false,
      jumpCut: true,
      covered: true,
    });
  });
});

describe("preview consistency and acceptance", () => {
  it("accepting the compiled proposal gives exactly the reviewed preview, as one Director transaction", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(
      ws,
      plan(ws, "v2", {
        order: ["event-3", "event-1", "event-2", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-5")],
        cutaways: { [id(s, "event-4")]: "keep" },
        rationale: [
          {
            clipId: id(s, "event-3"),
            reason: "Open on context.",
            evidence: [{ kind: "select", id: "sel-03" }],
          },
          { clipId: id(s, "event-1"), reason: "Then the emotion." },
          { clipId: id(s, "event-2"), reason: "Then the statement." },
          { clipId: id(s, "event-5"), reason: "Repeats." },
        ],
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect((r.proposal["operations"] as Array<{ op: string }>).map((o) => o.op)).toEqual([
      "remove",
      "reorder",
    ]);
    const out = acceptProposal(r.proposal, {
      ...ctxOf(ws),
      analysis: inventoryOf(ANALYSIS),
      ids: seededIds("story"),
    });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const after = seqOf(out.workspace, out.activeVersionId);
    const strip = (q: Sequence) =>
      Object.values(q.items).map(({ originTransactionId: _t, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(r.review.preview));
    const h = out.workspace.histories[out.activeVersionId]!;
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.transaction.commands.map((c) => c.type)).toEqual([
      "RippleDelete",
      "ReorderEdit",
    ]);
    expect(seqOf(undoIn(out.workspace, out.activeVersionId), out.activeVersionId)).toStrictEqual(s);
    const v1 = itemsOnTrack(after, after.tracks.find((t) => t.name === "V1")!.id).map(
      (i) => i.legacy?.decision.id,
    );
    expect(v1).toEqual(["event-3", "event-1", "event-2", "event-6"]);
  });

  it("compiling is pure: the workspace is never changed, accepted or not", () => {
    const ws = fresh();
    const before = JSON.stringify(ws);
    compile(ws, swap23(ws));
    compile(ws, swap23(ws, "v2", { cutaways: {} }));
    expect(JSON.stringify(ws)).toBe(before);
  });
});

describe("editorial safety: every retained cutaway stays over the same interview material", () => {
  it("a cutaway shifted by a ripple removal still covers the same frames of the same clip", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const [e6, e7] = [id(s, "event-6"), id(s, "event-7")];
    const r = compile(
      ws,
      plan(ws, "v2", {
        order: ["event-1", "event-2", "event-3", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-5")],
        rationale: [{ clipId: id(s, "event-5"), reason: "Repeats." }],
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.review.preview.items[e7]!.startFrame).toBe(564); // moved 144 frames earlier…
    const rel = r.cutaways.find((c) => c.id === e7)!;
    expect(rel.before).toEqual([{ itemId: e6, from: 12, to: 88 }]); // …over the same words
    expect(rel.after).toEqual(rel.before);
  });

  it("a cutaway carried by a reorder keeps its interview material; every cutaway is accounted for", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(ws, swap23(ws));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.cutaways.map((c) => [c.id, c.before, c.after])).toEqual([
      [
        id(s, "event-4"),
        [{ itemId: id(s, "event-3"), from: 12, to: 124 }],
        [{ itemId: id(s, "event-3"), from: 12, to: 124 }],
      ],
      [
        id(s, "event-7"),
        [{ itemId: id(s, "event-6"), from: 12, to: 88 }],
        [{ itemId: id(s, "event-6"), from: 12, to: 88 }],
      ],
    ]);
  });

  it("a cutaway whose underlying interview material would change is refused (checked directly, not by overlap rules)", () => {
    const s = importedSequence(director, projectClips);
    const [e2, e3, e4] = [id(s, "event-2"), id(s, "event-3"), id(s, "event-4")];
    // The clips under e4 swap places while e4 stays put: no overlap rule is
    // broken, but e4 would now sit over e2's words instead of e3's.
    const after = edited(s, (n) => {
      n.items[e3]!.startFrame = 240;
      n.items[e2]!.startFrame = 384;
      for (const it of Object.values(n.items))
        if (it.linkGroupId && it.id !== e2 && it.id !== e3) {
          const host =
            it.linkGroupId === n.items[e2]!.linkGroupId
              ? e2
              : it.linkGroupId === n.items[e3]!.linkGroupId
                ? e3
                : null;
          if (host) it.startFrame = n.items[host]!.startFrame;
        }
    });
    expect(findViolations(after, { media })).toEqual([]); // a perfectly valid timeline
    const out = cutawayRelationIssues(s, after, []);
    expect(out.issues.map((i) => [i.code, i.ids])).toEqual([
      ["cutaway-relationship-changed", [e4]],
    ]);
    const rel = out.relations.find((c) => c.id === e4)!;
    expect(rel.before.map((c) => c.itemId)).toEqual([e3]);
    expect(rel.after.map((c) => c.itemId)).toEqual([e2]); // e3's words → e2's
  });

  it("no cutaway may disappear unless the plan removes it — and a removed one must really be gone", () => {
    const s = importedSequence(director, projectClips);
    const e4 = id(s, "event-4");
    const without = edited(s, (n) => {
      delete n.items[e4];
    });
    expect(cutawayRelationIssues(s, without, []).issues.map((i) => i.code)).toEqual([
      "cutaway-lost",
    ]);
    expect(cutawayRelationIssues(s, without, [e4]).issues).toEqual([]);
    expect(cutawayRelationIssues(s, s, [e4]).issues.map((i) => i.code)).toEqual(["cutaway-lost"]);
  });

  it("every cutaway marked remove is a visible removal operation, marked as changed, and absent only from the proposed cut", () => {
    const ws = straddling();
    const s = seqOf(ws, "ver_w");
    const e4 = id(s, "event-4");
    const r = compile(ws, swap23(ws, "ver_w", { cutaways: { [e4]: "remove" } }), "ver_w");
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const ops = r.proposal["operations"] as Array<{
      op: string;
      itemIds: string[];
      ripple?: boolean;
    }>;
    expect(
      ops.filter((o) => o.op === "remove" && o.ripple === false).flatMap((o) => o.itemIds),
    ).toEqual([e4]);
    expect(r.review.changedIds).toContain(e4);
    expect(r.review.preview.items[e4]).toBeUndefined();
    expect(seqOf(ws, "ver_w").items[e4]).toBeDefined(); // still in the real cut until accepted
    expect(r.cutaways.map((c) => c.id)).not.toContain(e4);
  });

  it("a reorder blocked by straddling B-roll is refused and changes nothing", () => {
    const ws = straddling();
    const before = JSON.stringify(ws);
    const r = compile(ws, swap23(ws, "ver_w"), "ver_w");
    expect(codes(r)).toEqual(["cutaway-cannot-stay"]);
    expect(r.ok ? null : r.proposal).toBeUndefined(); // refused before anything was compiled
    expect(JSON.stringify(ws)).toBe(before);
    // Only an explicit, visible removal of that cutaway lets the reorder compile.
    const s = seqOf(ws, "ver_w");
    expect(
      compile(ws, swap23(ws, "ver_w", { cutaways: { [id(s, "event-4")]: "remove" } }), "ver_w").ok,
    ).toBe(true);
  });

  it("the accepted result matches the preview — cutaway relationships included", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const r = compile(
      ws,
      plan(ws, "v2", {
        order: ["event-3", "event-1", "event-2", "event-6"].map((n) => id(s, n)),
        remove: [id(s, "event-5")],
        cutaways: { [id(s, "event-4")]: "keep" },
        rationale: [
          { clipId: id(s, "event-3"), reason: "Context first." },
          { clipId: id(s, "event-1"), reason: "Then emotion." },
          { clipId: id(s, "event-2"), reason: "Then the statement." },
          { clipId: id(s, "event-5"), reason: "Repeats." },
        ],
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const out = acceptProposal(r.proposal, {
      ...ctxOf(ws),
      analysis: inventoryOf(ANALYSIS),
      ids: seededIds("rel"),
    });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const after = seqOf(out.workspace, out.activeVersionId);
    const strip = (q: Sequence) =>
      Object.values(q.items).map(({ originTransactionId: _t, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(r.review.preview));
    const accepted = cutawayRelationIssues(s, after, []);
    expect(accepted.issues).toEqual([]);
    expect(accepted.relations).toEqual(r.cutaways);
  });
});

/* ------------------------------ real projects ------------------------------ */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("every saved version: context built; a reversal plan compiles (or is refused for a stated reason); accept + undo exact; files untouched", () => {
      const a = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(a.clips) ? a.clips : Object.values(a.clips);
      const clips: Clip[] = rows.map(
        (c: { id: string; fps: number; duration_seconds: number; filename: string }) =>
          clip(c.id, c.fps, c.duration_seconds, { filename: c.filename }),
      );
      const realMedia = mediaOf(clips);
      const real = {
        selects: a.selects ?? [],
        transcript: a.transcript ?? [],
        stories: a.stories ?? [],
        chosenStoryId: null as string | null,
      };
      let compiled = 0;
      let refused = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        real.chosenStoryId = state.chosenStoryId ?? null;
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const ctx: ProposalContext = {
            workspace: ws,
            activeVersionId: v.id,
            clips,
            media: realMedia,
          };
          const c = buildStoryContext(ctx, real, clips)!;
          const s = sequenceOf(ws, v.id, clips)!;
          // Every line mapped to a clip belongs to its media and range.
          for (const x of c.interview) {
            expect(
              x.lines.every(
                (l) =>
                  linesOf(
                    s.items[x.id]!,
                    real.transcript.filter((t: TranscriptSegment) => t.id === l.id),
                  ).length === 1,
              ),
            ).toBe(true);
          }
          if (
            c.interview.length < 2 ||
            c.interview.some((x, n) => n < c.interview.length - 1 && !x.backToBackWithNext)
          )
            continue;
          const order = [...c.interview].reverse().map((x) => x.id);
          const decisions = Object.fromEntries(
            c.cutaways
              .filter((x) => x.over.length)
              .map((x) => [x.id, x.insideClipId ? "keep" : "remove"] as const),
          );
          const p: StoryPlan = {
            schema: STORY_PLAN_SCHEMA,
            base: { versionId: c.versionId, revision: c.revision },
            instruction: "Reverse the interview order",
            summary: "Plays the interview clips in reverse order.",
            order,
            cutaways: decisions,
            rationale: c.interview.map((x) => ({
              clipId: x.id,
              reason: "Reversal test.",
              ...(x.select ? { evidence: [{ kind: "select" as const, id: x.select.id }] } : {}),
            })),
          };
          const r = compileStoryPlan(p, ctx, real);
          if (!r.ok) {
            refused += 1;
            expect(
              r.issues.every((i) => i.code === "review-refused"),
              JSON.stringify(r.issues),
            ).toBe(true);
            continue;
          }
          compiled += 1;
          // Cutaways the plan removes are visible operations.
          const lifts = Object.entries(decisions)
            .filter(([, d]) => d === "remove")
            .map(([k]) => k);
          if (lifts.length)
            expect(
              (
                r.proposal["operations"] as Array<{
                  op: string;
                  itemIds: string[];
                  ripple?: boolean;
                }>
              )[0],
            ).toEqual({
              op: "remove",
              itemIds: expect.arrayContaining(lifts),
              ripple: false,
            });
          const out = acceptProposal(r.proposal, {
            ...ctx,
            analysis: inventoryOf(real),
            ids: seededIds("real"),
          });
          if (!out.ok) throw new Error(JSON.stringify(out.issues));
          expect(
            sequenceOf(undoIn(out.workspace, out.activeVersionId), out.activeVersionId, clips),
          ).toStrictEqual(s);
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(compiled + refused).toBeGreaterThan(0);
    });
  },
);
