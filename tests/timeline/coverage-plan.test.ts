// Phase 7, Milestone 4 — the deterministic coverage planner and compiler
// (src/lib/timeline/coverage-plan.ts). Pure: plans B-roll over uncovered
// potential jump cuts, compiles ordinary `place` operations, and runs the
// existing review. Nothing is accepted here except where a test says so.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 (clip-002 01:02–01:12) · e2 240–408 (clip-002 00:25–00:32)
//       e3 408–552 (clip-002 00:43–00:49) · e5 552–696 · e6 696–792
//   V2: e4 420–532 (clip-003) · e7 708–784 (clip-004 00:04:20–00:08:00)
//   Potential jump cuts: 240 (e1|e2) and 408 (e2|e3), both uncovered.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import { buildXmeml } from "@/lib/nle/xmeml";
import { validateTimelineForExport } from "@/lib/nle/edl";
import { analyzeCoverage, brollInventory, type MediaRoleOverrides } from "@/lib/timeline/coverage";
import {
  compileCoverageProposal,
  planCoverage,
  type CoveragePlan,
} from "@/lib/timeline/coverage-plan";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { acceptProposal, sequenceRevision } from "@/lib/timeline/proposals";
import { itemsOnTrack } from "@/lib/timeline/selectors";
import { rateFromFps, sequenceDurationFrames, tcToFrame } from "@/lib/timeline/time";
import type { Sequence } from "@/lib/timeline/types";
import {
  derivedTimeline,
  redoIn,
  sequenceOf,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, directorSequence, item, mediaOf, protect } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";

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
const withDialogue = (c: Clip, status: "dialogue" | "non-dialogue" | "uncertain"): Clip => ({
  ...c,
  dialogue: { status, reasons: [`fixture: ${status}`] },
});
/** Interviews (on V1) and B-roll files: clip-005 (9.4 s), clip-006 (9.1 s) are B-roll. */
const CLIPS: Clip[] = [
  withDialogue(projectClips[0]!, "dialogue"),
  withDialogue(projectClips[1]!, "dialogue"),
  withDialogue(projectClips[2]!, "dialogue"), // clip-003: no face → uncertain
  withDialogue(projectClips[3]!, "non-dialogue"), // clip-004 (used by e7)
  withDialogue(projectClips[4]!, "non-dialogue"), // clip-005
  withDialogue(projectClips[5]!, "non-dialogue"), // clip-006
];
const media = mediaOf(CLIPS);
const ev = (
  id: string,
  clipId: string,
  atTc: string,
  label: string,
  extra: Partial<VisualEvidence> = {},
): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label,
  atTc,
  confidence: 0.8,
  ...extra,
});
const line = (
  id: string,
  clipId: string,
  a: string,
  b: string,
  text: string,
): TranscriptSegment => ({
  id,
  clipId,
  speaker: "A",
  startTc: a,
  endTc: b,
  text,
  confidence: 0.9,
});
/** Interview lines next to the cuts: e1's end (01:08–01:12), e2's start (00:25–00:28). */
const TRANSCRIPT = [
  line(
    "t-e1",
    "clip-002",
    "00:01:08:00",
    "00:01:11:00",
    "The highway cut straight through our neighborhood.",
  ),
  line("t-e2", "clip-002", "00:00:25:00", "00:00:28:00", "Now the park brings everyone back."),
  line("t-q", "clip-002", "00:00:28:00", "00:00:30:00", "Was the park busy?"), // a question: ignored
];

interface Setup {
  seq?: Sequence;
  evidence?: VisualEvidence[];
  transcript?: TranscriptSegment[];
  clips?: Clip[];
  overrides?: MediaRoleOverrides;
  planEvidence?: VisualEvidence[];
}
function plan(o: Setup = {}) {
  const seq = o.seq ?? directorSequence();
  const evidence = o.evidence ?? [
    ev("park-1", "clip-005", "00:00:03:00", "Park sign at the entrance"),
    ev("street-1", "clip-006", "00:00:04:00", "Empty street corner"),
  ];
  const clips = o.clips ?? CLIPS;
  const analysis = analyzeCoverage(seq, "v2");
  const inventory = brollInventory(seq, {
    clips,
    visualEvidence: evidence,
    overrides: o.overrides,
  });
  return {
    seq,
    evidence,
    result: planCoverage({
      seq,
      versionId: "v2",
      media: mediaOf(clips),
      analysis,
      inventory,
      visualEvidence: o.planEvidence ?? evidence,
      transcript: o.transcript ?? TRANSCRIPT,
    }),
  };
}
const planOf = (r: ReturnType<typeof planCoverage>): CoveragePlan => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.plan;
};
const edit = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return deepFreeze(n);
};
/** Cover the cut at 408 with e4 so only 240 is open. */
const only240 = () =>
  edit(directorSequence(), (n) => void (n.items[item(n, "event-4").id]!.startFrame = 396));

describe("planning one cut", () => {
  it("places ~1 s before and 1.5 s after, frame-exact, with the logged moment on the cut", () => {
    const { seq, result } = plan({ seq: only240() });
    const p = planOf(result);
    expect(p.placements).toHaveLength(1);
    const x = p.placements[0]!;
    expect([x.cutTc, x.startFrame, x.endFrame, x.before, x.after]).toEqual([
      "00:00:10:00",
      216,
      276,
      24,
      36,
    ]);
    const rate = rateFromFps(23.976);
    expect(sequenceDurationFrames(x.sourceInFrame, x.sourceOutFrame, rate, seq.rate)).toBe(60);
    const at = tcToFrame(x.evidenceAtTc, rate)!;
    expect(at - x.sourceInFrame).toBe(24); // the logged moment lands on the cut
    expect(x.sourceOutFrame).toBeLessThanOrEqual(225); // inside the 9.4 s media
    expect(p.skipped.map((s) => [s.cutTc, s.code])).toEqual([["00:00:17:00", "already-covered"]]);
    expect(p.limitations.join(" ")).toMatch(/one sampled frame/);
  });

  it("is deterministic", () => {
    expect(plan({ seq: only240() }).result).toStrictEqual(plan({ seq: only240() }).result);
  });
});

describe("planning several cuts", () => {
  it("covers both open jump cuts without colliding with each other, V2 or each other's footage", () => {
    const { seq, result } = plan();
    const p = planOf(result);
    expect(p.placements.map((x) => [x.cutTc, x.before, x.after])).toEqual([
      ["00:00:10:00", 24, 36],
      ["00:00:17:00", 24, 12], // e4 starts 12 frames after the cut: only half a second fits
    ]);
    const spans = [
      ...itemsOnTrack(seq, seq.tracks.find((t) => t.name === "V2")!.id).map((i) => [
        i.startFrame,
        i.startFrame + i.durationFrames,
      ]),
      ...p.placements.map((x) => [x.startFrame, x.endFrame]),
    ].sort((a, b) => a[0]! - b[0]!);
    for (let n = 1; n < spans.length; n += 1)
      expect(spans[n]![0]).toBeGreaterThanOrEqual(spans[n - 1]![1]!);
    const [a, b] = p.placements;
    const sameMedia = a!.mediaClipId === b!.mediaClipId;
    if (sameMedia)
      expect(a!.sourceOutFrame <= b!.sourceInFrame || b!.sourceOutFrame <= a!.sourceInFrame).toBe(
        true,
      );
  });

  it("never reuses footage: with one usable moment, the second cut is reported, not covered twice", () => {
    const { result } = plan({ evidence: [ev("only", "clip-005", "00:00:03:00", "Park sign")] });
    const p = planOf(result);
    expect(p.placements).toHaveLength(1);
    expect(p.skipped.map((s) => s.code)).toEqual(["no-candidate"]);
  });

  it("source already in the cut is rejected before ranking", () => {
    // clip-004 00:00:05:00 lies inside e7's source (04:20–08:00).
    const { result } = plan({
      seq: only240(),
      evidence: [
        ev("used", "clip-004", "00:00:05:00", "Park sign"),
        ev("free", "clip-006", "00:00:04:00", "Street"),
      ],
    });
    const p = planOf(result);
    expect(p.rejected).toEqual([
      { candidateId: "cand:used", reason: "its source is already used in this cut" },
    ]);
    expect(p.placements[0]!.evidenceId).toBe("free");
  });
});

describe("cuts that aren't covered — and why", () => {
  it("already covered: nothing to add; partially covered: left alone", () => {
    const covered = edit(only240(), (n) => void (n.items[item(n, "event-7").id]!.startFrame = 216));
    expect(plan({ seq: covered }).result).toMatchObject({ ok: false, code: "nothing-to-cover" });
    const partial = edit(
      directorSequence(),
      (n) => void (n.items[item(n, "event-4").id]!.startFrame = 400),
    ); // 8 before 408
    const p = planOf(plan({ seq: partial }).result);
    expect(p.skipped.find((s) => s.cutTc === "00:00:17:00")!.code).toBe("partially-covered");
    expect(p.placements.map((x) => x.cutTc)).toEqual(["00:00:10:00"]);
  });

  it("locked or AI-protected footage, or a protected V2, stops the Director — said per cut", () => {
    const base = directorSequence();
    const e2 = item(base, "event-2").id; // under both cuts
    const r = plan({ seq: protect(base, { itemId: e2 }, { aiLocked: true }) }).result;
    expect(r).toMatchObject({ ok: false, code: "no-safe-coverage" });
    if (!r.ok)
      expect(r.plan!.skipped.map((s) => s.code)).toEqual([
        "director-may-not-cover",
        "director-may-not-cover",
      ]);
    const lockedV2 = plan({ seq: protect(base, { trackName: "V2" }, { locked: true }) }).result;
    expect(lockedV2.ok).toBe(false);
    if (!lockedV2.ok) expect(lockedV2.message).toMatch(/V2 is locked/);
  });

  it("a hand-edited interview cut is still covered — and stays exactly as it was", () => {
    const base = only240();
    const e1 = item(base, "event-1").id;
    const seq = edit(base, (n) => void (n.items[e1]!.editedBy = "manual"));
    const p = planOf(plan({ seq }).result);
    expect(p.placements).toHaveLength(1);
  });

  it("B-roll within half a second of the cut blocks it; exactly half a second of room is used exactly", () => {
    const at = (start: number) =>
      plan({
        seq: edit(only240(), (n) => void (n.items[item(n, "event-7").id]!.startFrame = start)),
      }).result;
    const blocked = at(240 + 11); // 11 frames of room after the cut at 240
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.plan!.skipped[0]).toMatchObject({
        cutTc: "00:00:10:00",
        code: "director-may-not-cover",
      });
      expect(blocked.plan!.skipped[0]!.message).toMatch(/within half a second of the cut/);
    }
    const x = planOf(at(240 + 12)).placements[0]!; // exactly 12
    expect([x.before, x.after, x.endFrame]).toEqual([24, 12, 252]);
  });

  it("uncertain or missing media isn't used; with nothing usable the refusal says why", () => {
    const uncertain = plan({ evidence: [ev("u", "clip-003", "00:00:05:00", "Park sign")] }).result;
    expect(uncertain).toMatchObject({ ok: false, code: "no-safe-coverage" });
    if (!uncertain.ok)
      expect(uncertain.message).toMatch(/uncertain files need confirming as B-roll/);
    // The same file confirmed as B-roll by the filmmaker is usable.
    expect(
      plan({
        evidence: [ev("u", "clip-003", "00:00:05:00", "Park sign")],
        overrides: { "CLIP-003.MP4": "b-roll" },
      }).result.ok,
    ).toBe(true);
    // Media the project's inventory doesn't have is rejected.
    const noMedia = plan({ clips: CLIPS, evidence: [ev("p", "clip-005", "00:00:03:00", "Park")] });
    const r = planCoverage({
      seq: noMedia.seq,
      versionId: "v2",
      media: new Map(),
      analysis: analyzeCoverage(noMedia.seq, "v2"),
      inventory: brollInventory(noMedia.seq, { clips: CLIPS, visualEvidence: noMedia.evidence }),
      visualEvidence: noMedia.evidence,
      transcript: TRANSCRIPT,
    });
    expect(r.ok ? null : r.plan!.rejected.map((x) => x.reason)).toEqual([
      "media not in the project",
    ]);
  });

  it("evidence the project doesn't have is rejected", () => {
    const r = plan({ planEvidence: [] }).result;
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(new Set(r.plan!.rejected.map((x) => x.reason))).toEqual(
        new Set(["its evidence id isn't in the project's analysis"]),
      );
  });

  it("no B-roll at all", () => {
    expect(plan({ evidence: [] }).result).toMatchObject({ ok: false, code: "no-safe-coverage" });
  });

  it("a stale analysis or another version is refused", () => {
    const seq = directorSequence();
    const analysis = analyzeCoverage(seq, "v2");
    const inventory = brollInventory(seq, { clips: CLIPS, visualEvidence: [] });
    const later = edit(seq, (n) => void (n.items[item(n, "event-7").id]!.startFrame += 1));
    const base = { media, inventory, visualEvidence: [], transcript: TRANSCRIPT };
    expect(planCoverage({ ...base, seq: later, versionId: "v2", analysis }).ok).toBe(false);
    expect(planCoverage({ ...base, seq: later, versionId: "v2", analysis })).toMatchObject({
      code: "stale",
    });
    expect(planCoverage({ ...base, seq, versionId: "v9", analysis })).toMatchObject({
      code: "stale",
    });
  });
});

describe("ranking", () => {
  it("label words shared with the nearby interview win over confidence; the overlap is recorded and cited", () => {
    const { result } = plan({
      seq: only240(),
      evidence: [
        ev("hi-conf", "clip-006", "00:00:04:00", "Empty street corner", { confidence: 0.99 }),
        ev("relevant", "clip-005", "00:00:03:00", "Highway overpass over the neighborhood", {
          confidence: 0.6,
        }),
      ],
    });
    const x = planOf(result).placements[0]!;
    expect(x.evidenceId).toBe("relevant");
    expect(x.rank.sharedWords).toEqual(["highway", "neighborhood"]);
    expect(x.transcriptIds).toEqual(["t-e1"]);
    expect(x.considered).toBe(2);
    expect(x.reason).toMatch(/shares "highway", "neighborhood"/);
  });

  it("without shared words it says relevance isn't established; questions don't count", () => {
    const { result } = plan({
      seq: only240(),
      evidence: [ev("q", "clip-005", "00:00:03:00", "Busy park")], // "park" appears only in e2's lines; "busy" only in a question
    });
    const x = planOf(result).placements[0]!;
    expect(x.rank.sharedWords).toEqual(["park"]); // from "Now the park brings everyone back"
    const none = planOf(
      plan({ seq: only240(), evidence: [ev("n", "clip-005", "00:00:03:00", "Blue sky")] }).result,
    ).placements[0]!;
    expect(none.rank.relevance).toBe(0);
    expect(none.uncertainty.join(" ")).toMatch(/relevance isn't established/);
  });

  it("equal scores fall back to the candidate id", () => {
    const { result } = plan({
      seq: only240(),
      evidence: [
        ev("b-shot", "clip-006", "00:00:04:00", "Sky"),
        ev("a-shot", "clip-005", "00:00:03:00", "Sky"),
      ],
    });
    expect(planOf(result).placements[0]!.evidenceId).toBe("a-shot");
  });
});

describe("source-frame accuracy at another media rate", () => {
  it("29.97 media into a 24 fps cut: exact frames, inside the window and the media", () => {
    const clips = [
      ...CLIPS.filter((c) => c.id !== "clip-006"),
      withDialogue(clip("clip-006", 29.97, 9.1), "non-dialogue"),
    ];
    const { seq, result } = plan({
      seq: only240(),
      clips,
      evidence: [ev("c30", "clip-006", "00:00:04:00", "Street")],
    });
    const x = planOf(result).placements[0]!;
    const rate = rateFromFps(29.97);
    expect(sequenceDurationFrames(x.sourceInFrame, x.sourceOutFrame, rate, seq.rate)).toBe(
      x.before + x.after,
    );
    expect(x.sourceOutFrame).toBeLessThanOrEqual(Math.round(9.1 * 29.97));
    expect(Number.isInteger(x.sourceInFrame) && Number.isInteger(x.sourceOutFrame)).toBe(true);
  });
});

describe("compiling and accepting", () => {
  const ws = () => deepFreeze(workspaceFromVersions([structuredClone(director)])) as Workspace;
  const inventoryOf = (evidence: VisualEvidence[]) => ({
    selectIds: new Set<string>(),
    transcriptIds: new Set(TRANSCRIPT.map((t) => t.id)),
    visualIds: new Set(evidence.map((e) => e.id)),
  });

  function compiled(w: Workspace, evidence: VisualEvidence[]) {
    const seq = sequenceOf(w, "v2", CLIPS)!;
    const r = planCoverage({
      seq,
      versionId: "v2",
      media,
      analysis: analyzeCoverage(seq, "v2"),
      inventory: brollInventory(seq, { clips: CLIPS, visualEvidence: evidence }),
      visualEvidence: evidence,
      transcript: TRANSCRIPT,
    });
    return compileCoverageProposal(planOf(r), {
      workspace: w,
      activeVersionId: "v2",
      clips: CLIPS,
      media,
      analysis: inventoryOf(evidence),
    });
  }
  const EVIDENCE = [
    ev("park-1", "clip-005", "00:00:03:00", "Park sign at the entrance"),
    ev("street-1", "clip-006", "00:00:04:00", "Highway street corner"),
  ];

  it("compiles ordinary place ops with evidence-backed rationale; the engine dry run passes; nothing is applied", () => {
    const w = ws();
    const c = compiled(w, EVIDENCE);
    if (!c.ok) throw new Error(c.message);
    const ops = c.proposal["operations"] as Array<Record<string, unknown>>;
    expect(ops.map((o) => o["op"])).toEqual(["place", "place"]);
    const v2 = sequenceOf(w, "v2", CLIPS)!.tracks.find((t) => t.name === "V2")!.id;
    expect(ops.every((o) => o["trackId"] === v2)).toBe(true);
    const rat = c.proposal["rationale"] as Array<{
      evidence: Array<{ kind: string; id: string }>;
      reason: string;
    }>;
    expect(rat.every((r) => r.evidence[0]!.kind === "visual")).toBe(true);
    expect(rat.some((r) => r.evidence.some((e) => e.kind === "transcript"))).toBe(true);
    expect(rat[0]!.reason).toMatch(/one sampled frame/);
    expect(findViolations(c.review.preview, { media })).toEqual([]);
    expect(c.review.changedIds).toHaveLength(2);
    expect(sequenceOf(w, "v2", CLIPS)!.items).toStrictEqual(sequenceOf(ws(), "v2", CLIPS)!.items); // untouched
  });

  it("evidence the review can't verify, or a cut that changed, is refused at compile time", () => {
    const w = ws();
    const seq = sequenceOf(w, "v2", CLIPS)!;
    const plan0 = planOf(
      planCoverage({
        seq,
        versionId: "v2",
        media,
        analysis: analyzeCoverage(seq, "v2"),
        inventory: brollInventory(seq, { clips: CLIPS, visualEvidence: EVIDENCE }),
        visualEvidence: EVIDENCE,
        transcript: TRANSCRIPT,
      }),
    );
    const noVisual = compileCoverageProposal(plan0, {
      workspace: w,
      activeVersionId: "v2",
      clips: CLIPS,
      media,
      analysis: { ...inventoryOf(EVIDENCE), visualIds: new Set() },
    });
    expect(noVisual.ok).toBe(false);
    const changed = deepFreeze({
      versions: [
        structuredClone(director),
        { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
      ],
      histories: {
        ver_w: createHistory(
          edit(seq, (n) => void (n.items[item(n, "event-7").id]!.startFrame += 1)),
        ),
      },
    } as Workspace);
    const stale = compileCoverageProposal(
      { ...plan0, versionId: "ver_w" },
      {
        workspace: changed,
        activeVersionId: "ver_w",
        clips: CLIPS,
        media,
        analysis: inventoryOf(EVIDENCE),
      },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.review?.ok ? null : stale.review?.issues[0]!.code).toBe("stale");
  });

  it("accepting is ONE Director transaction; V1/A1 untouched; undo and redo exact; Premiere XML carries both", () => {
    const w = ws();
    const before = sequenceOf(w, "v2", CLIPS)!;
    const c = compiled(w, EVIDENCE);
    if (!c.ok) throw new Error(c.message);
    const out = acceptProposal(c.proposal, {
      workspace: w,
      activeVersionId: "v2",
      clips: CLIPS,
      media,
      analysis: inventoryOf(EVIDENCE),
      ids: seededIds("acc"),
    });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const v = out.activeVersionId;
    const after = sequenceOf(out.workspace, v, CLIPS)!;
    const past = out.workspace.histories[v]!.past;
    expect(past).toHaveLength(1);
    expect(past[0]!.transaction.commands.map((x) => x.type)).toEqual(["PlaceEdit", "PlaceEdit"]);
    for (const it of Object.values(before.items)) expect(after.items[it.id]).toStrictEqual(it);
    const added = Object.values(after.items).filter((i) => !before.items[i.id]);
    expect(added.map((i) => i.editedBy)).toEqual(["director", "director"]);
    expect(sequenceOf(undoIn(out.workspace, v), v, CLIPS)).toStrictEqual(before);
    expect(sequenceOf(redoIn(undoIn(out.workspace, v), v), v, CLIPS)).toStrictEqual(after);
    const count = (s: Sequence) => {
      const tl = derivedTimeline(s);
      return (
        buildXmeml(tl, validateTimelineForExport(tl, CLIPS).usable, CLIPS, "/Media").xml.split(
          "<clipitem",
        ).length - 1
      );
    };
    expect(count(after)).toBe(count(before) + 2);
    expect(sequenceRevision(before)).toBe(c.plan.revision);
  });
});

/* ------------------------------ real projects ------------------------------ */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;
const PYTHON = resolve(__dirname, "../../worker/.venv/bin/python");

describe.skipIf(
  !stateFiles.length || !analysisFile || !existsSync(analysisFile) || !existsSync(PYTHON),
)("real saved projects", () => {
  it("v1.2's two open jump cuts are covered by a reviewed proposal (accept + undo exact); v1.3/v1.4 get nothing; files untouched", () => {
    const a = JSON.parse(readFileSync(analysisFile!, "utf8"));
    const statuses = JSON.parse(
      execFileSync(
        PYTHON,
        [
          "-c",
          [
            "import json, sys",
            "sys.path.insert(0, '.')",
            "import dialogue",
            "a = json.load(open(sys.argv[1]))",
            "class C:",
            "    def __init__(s, c): s.id=c['id']; s.has_transcript=c.get('has_transcript'); s.ai={}",
            "print(json.dumps(dialogue.assess_project({c['id']: C(c) for c in a['clips']}, a['transcript'], a['visualEvidence'])))",
          ].join("\n"),
          analysisFile!,
        ],
        { cwd: resolve(__dirname, "../../worker"), env: { PATH: process.env.PATH ?? "" } },
      ).toString(),
    );
    const clips: Clip[] = a.clips.map(
      (c: {
        id: string;
        filename: string;
        rel_path: string;
        fps: number;
        duration_seconds: number;
      }) => ({
        ...clip(c.id, c.fps, c.duration_seconds, { filename: c.filename, relPath: c.rel_path }),
        dialogue: statuses[c.id],
      }),
    );
    const realMedia = mediaOf(clips);
    const inventoryIds = {
      selectIds: new Set<string>(a.selects.map((x: { id: string }) => x.id)),
      transcriptIds: new Set<string>(a.transcript.map((x: { id: string }) => x.id)),
      visualIds: new Set<string>(a.visualEvidence.map((x: { id: string }) => x.id)),
    };
    const seen: Record<string, string> = {};
    for (const file of stateFiles) {
      const before = readFileSync(file, "utf8");
      const state = JSON.parse(before);
      const w = workspaceFromVersions(state.versions);
      for (const v of state.versions as EditVersion[]) {
        const seq = sequenceOf(w, v.id, clips)!;
        if (!Object.keys(seq.items).length) continue;
        const r = planCoverage({
          seq,
          versionId: v.id,
          media: realMedia,
          analysis: analyzeCoverage(seq, v.id),
          inventory: brollInventory(seq, { clips, visualEvidence: a.visualEvidence }),
          visualEvidence: a.visualEvidence,
          transcript: a.transcript,
        });
        seen[v.version] = r.ok ? `plan:${r.plan.placements.length}` : r.code;
        if (!r.ok) continue;
        for (const p of r.plan.placements)
          expect(["clip-004", "clip-005", "clip-006"]).toContain(p.mediaClipId);
        const ctx = {
          workspace: w,
          activeVersionId: v.id,
          clips,
          media: realMedia,
          analysis: inventoryIds,
        };
        const c = compileCoverageProposal(r.plan, ctx);
        if (!c.ok) throw new Error(`${v.version}: ${c.message}`);
        const out = acceptProposal(c.proposal, { ...ctx, ids: seededIds("real") });
        if (!out.ok) throw new Error(JSON.stringify(out.issues));
        const after = sequenceOf(out.workspace, out.activeVersionId, clips)!;
        expect(analyzeCoverage(after, out.activeVersionId).summary.potentialJumpsNeedingCover).toBe(
          0,
        );
        expect(
          sequenceOf(undoIn(out.workspace, out.activeVersionId), out.activeVersionId, clips),
        ).toStrictEqual(seq);
      }
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(seen["v1.2"]).toBe("plan:2");
    expect([seen["v1.3"], seen["v1.4"]]).toEqual(["nothing-to-cover", "nothing-to-cover"]);
  });
});
