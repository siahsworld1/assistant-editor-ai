// Phase 7, Milestone 5 — Cover mode's deterministic run
// (src/lib/ae/coverage-request.ts): the states CUT can't reach by a gesture
// (track locks, a hidden or missing overlay track, a cut with no jumps,
// missing media), and how cuts are classified for display.
import { describe, expect, it } from "vitest";
import { cutState, runCoverage } from "@/lib/ae/coverage-request";
import type { Clip, EditVersion, VisualEvidence } from "@/lib/ae/types";
import type { CoverageCut } from "@/lib/timeline/coverage";
import { createHistory } from "@/lib/timeline/history";
import type { ProposalContext } from "@/lib/timeline/proposals";
import type { Sequence } from "@/lib/timeline/types";
import { sequenceOf, workspaceFromVersions, type Workspace } from "@/lib/timeline/workspace";
import { deepFreeze, item, mediaOf, protect } from "./timeline/engine-helpers";
import { directorCut, projectClips } from "./timeline/legacy-fixtures";

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
  dialogue: { status: i < 3 ? "dialogue" : "non-dialogue", reasons: ["fixture"] },
}));
const EVIDENCE: VisualEvidence[] = [
  {
    id: "park-1",
    clipId: "clip-005",
    kind: "b-roll",
    label: "Park sign",
    atTc: "00:00:03:00",
    confidence: 0.8,
  },
  {
    id: "street-1",
    clipId: "clip-006",
    kind: "b-roll",
    label: "Street",
    atTc: "00:00:04:00",
    confidence: 0.8,
  },
];
const base = () => sequenceOf(workspaceFromVersions([structuredClone(director)]), "v2", CLIPS)!;
function ctxFor(s: Sequence | null, media = true): ProposalContext {
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
    clips: CLIPS,
    media: media ? mediaOf(CLIPS) : undefined,
    analysis: {
      selectIds: new Set(),
      transcriptIds: new Set(),
      visualIds: new Set(EVIDENCE.map((e) => e.id)),
    },
  };
}
const run = (s: Sequence | null, media = true) =>
  runCoverage(ctxFor(s, media), { clips: CLIPS, visualEvidence: EVIDENCE, transcript: [] })!;
const edit = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return n;
};

describe("runCoverage", () => {
  it("plans and compiles a reviewed proposal for the version on screen", () => {
    const r = run(null);
    expect(r.versionId).toBe("v2");
    expect(r.plan.ok).toBe(true);
    expect(r.compiled?.ok).toBe(true);
    if (r.compiled?.ok) expect(r.compiled.review.preview).toBeDefined();
  });

  it.each([
    ["locked", { locked: true }, /V2 is locked/],
    ["AI-protected", { aiLocked: true }, /V2 is protected from AI changes/],
  ])("a %s overlay track: every cut is unsafe to cover, nothing compiled", (_n, p, msg) => {
    const r = run(protect(base(), { trackName: "V2" }, p));
    expect(r.plan.ok).toBe(false);
    if (!r.plan.ok) {
      expect(r.plan.code).toBe("no-safe-coverage");
      expect(r.plan.message).toMatch(msg);
    }
    expect(r.compiled).toBeNull();
    expect(r.analysis.cuts.filter((c) => c.kind === "jump").map(cutState)).toEqual([
      "blocked",
      "blocked",
    ]);
  });

  it("a hidden overlay track is unavailable too", () => {
    const r = run(edit(base(), (n) => void (n.tracks.find((t) => t.name === "V2")!.hidden = true)));
    expect(!r.plan.ok && r.plan.message).toMatch(/V2 is hidden/);
  });

  it("a cut with no potential jump cuts says so", () => {
    // e2 from another interview file: no two pieces of the same take meet.
    const r = run(
      edit(base(), (n) => {
        const e2 = item(n, "event-2");
        n.items[e2.id]!.mediaClipId = "clip-001";
      }),
    );
    expect(r.plan.ok).toBe(false);
    if (!r.plan.ok) {
      expect(r.plan.code).toBe("nothing-to-cover");
      expect(r.plan.message).toBe("This cut has no potential jump cuts to cover.");
    }
  });

  it("without the project's media inventory nothing is placed — sources are never guessed", () => {
    const r = run(null, false);
    expect(r.plan.ok).toBe(false);
    expect(r.plan.plan?.rejected.every((x) => x.reason === "media not in the project")).toBe(true);
  });
});

describe("cutState", () => {
  const cut = (o: Partial<CoverageCut>) =>
    ({ coverage: "uncovered", directorMayCover: true, ...o }) as CoverageCut;
  it("covered, partly covered, uncovered — or blocked when the Director may not cover it", () => {
    expect(cutState(cut({ coverage: "covered" }))).toBe("covered");
    expect(cutState(cut({ coverage: "partial", directorMayCover: false }))).toBe("partial");
    expect(cutState(cut({}))).toBe("uncovered");
    expect(cutState(cut({ directorMayCover: false }))).toBe("blocked");
  });
});
