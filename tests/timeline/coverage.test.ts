// Phase 7, Milestone 3 — deterministic coverage analysis and B-roll inventory
// (src/lib/timeline/coverage.ts). Pure: nothing is placed or changed.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 (clip-002 01:02–01:12) · e2 240–408 (clip-002 00:25–00:32)
//       e3 408–552 (clip-002 00:43–00:49) · e5 552–696 (clip-001) · e6 696–792 (clip-002)
//   V2: e4 420–532 (clip-003) · e7 708–784 (clip-004) · A1 under every V1 clip
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion, UniversalTimeline, VisualEvidence } from "@/lib/ae/types";
import { sanitizeMediaRoles } from "@/lib/ae/projects";
import {
  analyzeCoverage,
  brollInventory,
  halfSecondFrames,
  mediaRoles,
  type CoverageCut,
} from "@/lib/timeline/coverage";
import { legacyToSequence } from "@/lib/timeline/legacy-adapter";
import { sequenceRevision } from "@/lib/timeline/proposals";
import { rateFromFps } from "@/lib/timeline/time";
import type { ClipItem, Sequence } from "@/lib/timeline/types";
import { sequenceOf, workspaceFromVersions } from "@/lib/timeline/workspace";
import { deepFreeze, directorSequence, item, protect } from "./engine-helpers";
import { clip, projectClips } from "./legacy-fixtures";

const edit = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return deepFreeze(n);
};
const cutAt = (s: Sequence, frame: number) =>
  analyzeCoverage(s, "v2").cuts.find((c) => c.frame === frame)!;
const shape = (c: CoverageCut) => [c.kind, c.coverage, c.coveredBefore, c.coveredAfter];

/** A one-track interview cut built from schema-1 decisions (fps any). */
function cutOf(
  fps: number,
  decisions: Array<[string, string, string, number, number]>, // clip, in, out, start s, dur s
  clips: Clip[],
  broll: Array<[string, string, string, number, number]> = [],
): Sequence {
  const tl: UniversalTimeline = {
    id: "tl",
    name: "t",
    fps,
    targetSeconds: 60,
    totalSeconds: 60,
    decisions: [
      ...decisions.map(([clipId, i, o, start, dur], n) => ({
        id: `d${n}`,
        lane: "interview" as const,
        clipId,
        label: `d${n}`,
        sourceInTc: i,
        sourceOutTc: o,
        timelineStartSeconds: start,
        durationSeconds: dur,
      })),
      ...broll.map(([clipId, i, o, start, dur], n) => ({
        id: `b${n}`,
        lane: "b-roll" as const,
        clipId,
        label: `b${n}`,
        sourceInTc: i,
        sourceOutTc: o,
        timelineStartSeconds: start,
        durationSeconds: dur,
      })),
    ],
  };
  return deepFreeze(legacyToSequence(tl, clips, { scope: `cut-${fps}` }));
}

describe("interview cuts", () => {
  it("classifies the Director cut: two potential same-source jumps, two source changes, none covered", () => {
    const s = directorSequence();
    const a = analyzeCoverage(s, "v2");
    expect(a.revision).toBe(sequenceRevision(s));
    expect(a.marginFrames).toBe(12);
    expect(a.cuts.map((c) => [c.tc, c.kind, c.coverage, c.potentialJump])).toEqual([
      ["00:00:10:00", "jump", "uncovered", true],
      ["00:00:17:00", "jump", "uncovered", true],
      ["00:00:23:00", "source-change", "uncovered", false],
      ["00:00:29:00", "source-change", "uncovered", false],
    ]);
    expect(a.summary).toMatchObject({
      cuts: 4,
      jump: 2,
      sourceChange: 2,
      potentialJumpsNeedingCover: 2,
    });
    const first = a.cuts[0]!;
    expect(first.id).toBe(`cut:${item(s, "event-1").id}|${item(s, "event-2").id}@240`);
    expect([first.leftMediaId, first.rightMediaId]).toEqual(["clip-002", "clip-002"]);
    expect(first.sourceGapFrames).not.toBeNull();
    expect(analyzeCoverage(s, "v2")).toStrictEqual(a); // deterministic
  });

  it("a cut with continuous source is not a jump; a gap between clips is not a cut", () => {
    const c = [clip("c1", 24, 60)];
    const s = cutOf(
      24,
      [
        ["c1", "00:00:10:00", "00:00:12:00", 0, 2],
        ["c1", "00:00:12:00", "00:00:14:00", 2, 2], // continuous
        ["c1", "00:00:20:00", "00:00:22:00", 5, 2], // after a 1 s gap: not a cut
      ],
      c,
    );
    const a = analyzeCoverage(s, "v");
    expect(a.cuts.map((x) => [x.kind, x.sourceGapFrames])).toEqual([["continuous", 0]]);
  });

  it("covered needs at least half a second on BOTH sides; less is partial; not crossing is uncovered", () => {
    const base = directorSequence();
    const e4 = item(base, "event-4"); // 112 frames long
    const at = (start: number) =>
      shape(
        cutAt(
          edit(base, (n) => void (n.items[e4.id]!.startFrame = start)),
          408,
        ),
      );
    expect(at(396)).toEqual(["jump", "covered", 12, 100]); // exactly 12 before
    expect(at(397)).toEqual(["jump", "partial", 11, 101]); // one frame short
    expect(at(408 - 112 + 12)).toEqual(["jump", "covered", 100, 12]); // exactly 12 after
    expect(at(408 - 112 + 11)).toEqual(["jump", "partial", 101, 11]);
    expect(at(408 - 112)).toEqual(["jump", "uncovered", 0, 0]); // ends exactly at the cut
    expect(at(420)).toEqual(["jump", "uncovered", 0, 0]); // starts after it
  });

  it("touching overlays (even on different tracks) cover a cut together; hidden or disabled overlays don't", () => {
    const base = directorSequence();
    const [e4, e7] = [item(base, "event-4"), item(base, "event-7")];
    const joined = edit(base, (n) => {
      n.items[e4.id]!.startFrame = 408 - 112; // ends at 408
      n.items[e7.id]!.startFrame = 408; // starts at 408
    });
    expect(shape(cutAt(joined, 408))).toEqual(["jump", "covered", 112, 76]);
    const crossing = edit(base, (n) => void (n.items[e4.id]!.startFrame = 396));
    const hidden = edit(
      crossing,
      (n) => void (n.tracks.find((t) => t.name === "V2")!.hidden = true),
    );
    expect(cutAt(hidden, 408).coverage).toBe("uncovered");
    expect(cutAt(hidden, 408).blockers.map((b) => b.code)).toContain("hidden-track");
    const disabled = edit(crossing, (n) => void (n.items[e4.id]!.enabled = false));
    expect(cutAt(disabled, 408).coverage).toBe("uncovered");
  });

  it.each([
    [23.976, 12],
    [24, 12],
    [25, 13],
    [29.97, 15],
    [30, 15],
  ])("at %s fps half a second is %i frames — and the rule holds exactly there", (fps, m) => {
    expect(halfSecondFrames(rateFromFps(fps))).toBe(m);
    const c = [clip("c1", fps, 120), clip("c2", fps, 60)];
    const s = cutOf(
      fps,
      [
        ["c1", "00:00:10:00", "00:00:14:00", 0, 4],
        ["c1", "00:00:30:00", "00:00:34:00", 4, 4],
      ],
      c,
    );
    const cut = analyzeCoverage(s, "v").cuts[0]!;
    expect(cut.kind).toBe("jump");
    const v2 = s.tracks.find((t) => t.name === "V2")!.id;
    const withOverlay = (before: number) =>
      edit(s, (n) => {
        n.items["itm_overlay"] = {
          ...structuredClone(Object.values(s.items)[0]!),
          id: "itm_overlay",
          trackId: v2,
          mediaClipId: "c2",
          startFrame: cut.frame - before,
          durationFrames: before + m,
          linkGroupId: undefined,
          legacy: undefined,
        } as ClipItem;
      });
    expect(analyzeCoverage(withOverlay(m), "v").cuts[0]!.coverage).toBe("covered");
    expect(analyzeCoverage(withOverlay(m - 1), "v").cuts[0]!.coverage).toBe("partial");
  });
});

describe("who may cover a cut", () => {
  it("hand-edited interview: reported, not a blocker", () => {
    const base = directorSequence();
    const s = edit(base, (n) => void (n.items[item(base, "event-1").id]!.editedBy = "manual"));
    const c = cutAt(s, 240);
    expect([c.handEdited, c.directorMayCover, c.blockers]).toEqual([true, true, []]);
  });

  it("locked or AI-protected footage under the cover window blocks the Director — and says which", () => {
    const base = directorSequence();
    const e2 = item(base, "event-2").id;
    const ai = cutAt(protect(base, { itemId: e2 }, { aiLocked: true }), 240);
    expect([ai.directorMayCover, ai.blockers.map((b) => [b.code, b.ids])]).toEqual([
      false,
      [["ai-protected-footage", [e2]]],
    ]);
    const locked = cutAt(protect(base, { itemId: e2 }, { locked: true }), 240);
    expect(locked.blockers.map((b) => b.code)).toEqual(["locked-footage"]);
    // A protected clip far from this cut doesn't block it.
    expect(
      cutAt(protect(base, { itemId: item(base, "event-6").id }, { aiLocked: true }), 240)
        .directorMayCover,
    ).toBe(true);
  });

  it("a locked, AI-protected or missing overlay track blocks the Director", () => {
    const base = directorSequence();
    expect(
      cutAt(protect(base, { trackName: "V2" }, { locked: true }), 240).blockers.map((b) => b.code),
    ).toEqual(["locked-track"]);
    expect(
      cutAt(protect(base, { trackName: "V2" }, { aiLocked: true }), 240).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(["ai-protected-track"]);
    const noV2 = edit(base, (n) => {
      const v2 = n.tracks.find((t) => t.name === "V2")!.id;
      n.tracks = n.tracks.filter((t) => t.id !== v2);
      for (const [id, it] of Object.entries(n.items)) if (it.trackId === v2) delete n.items[id];
    });
    expect(cutAt(noV2, 240).blockers.map((b) => b.code)).toEqual(["no-overlay-track"]);
  });

  it("existing B-roll within half a second of an uncovered cut is a conflict", () => {
    const base = directorSequence();
    const e4 = item(base, "event-4");
    const s = edit(base, (n) => void (n.items[e4.id]!.startFrame = 410)); // 2 frames after the cut at 408
    const c = cutAt(s, 408);
    expect(c.coverage).toBe("uncovered");
    expect(c.blockers.map((b) => [b.code, b.ids])).toEqual([["overlay-conflict", [e4.id]]]);
  });

  it("analysis never changes the sequence (frozen input)", () => {
    const s = directorSequence();
    const before = JSON.stringify(s);
    analyzeCoverage(s, "v2");
    brollInventory(s, { clips: projectClips, visualEvidence: [] });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("large timelines", () => {
  it("500 interview clips and 250 overlays analyse quickly and exactly", () => {
    const c = [clip("big", 24, 4000), clip("br", 24, 600)];
    const decisions: Array<[string, string, string, number, number]> = [];
    const broll: Array<[string, string, string, number, number]> = [];
    const tc = (s: number) =>
      `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:00`;
    for (let n = 0; n < 500; n += 1) {
      const src = n * 3 + (n % 2 ? 1 : 0); // alternately jumps and continues
      decisions.push(["big", tc(src), tc(src + 2), n * 2, 2]);
      if (n % 2 === 0 && n > 0) broll.push(["br", tc(n), tc(n + 1), n * 2 - 0.5, 1]); // covers even cuts
    }
    const s = cutOf(24, decisions, c, broll);
    const t0 = performance.now();
    const a = analyzeCoverage(s, "v");
    const ms = performance.now() - t0;
    expect(a.cuts).toHaveLength(499);
    expect(a.summary.covered).toBe(249);
    // Alternate cuts jump by 2 s / continue the source exactly.
    expect([a.summary.jump, a.summary.continuous]).toEqual([250, 249]);
    expect(ms).toBeLessThan(1500);
  });
});

/* -------------------------------- inventory -------------------------------- */

const ev = (
  id: string,
  clipId: string,
  atTc: string,
  extra: Partial<VisualEvidence> = {},
): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label: `moment ${id}`,
  atTc,
  confidence: 0.8,
  ...extra,
});
const withDialogue = (c: Clip, status: "dialogue" | "non-dialogue" | "uncertain"): Clip => ({
  ...c,
  dialogue: { status, reasons: [`fixture: ${status}`] },
});

describe("media roles", () => {
  const s = directorSequence(); // clip-001 and clip-002 are on V1
  const clips = [
    withDialogue(projectClips[0]!, "dialogue"), // clip-001, on V1
    withDialogue(projectClips[2]!, "dialogue"), // clip-003, not on V1, no face
    withDialogue(projectClips[3]!, "non-dialogue"), // clip-004
    withDialogue(projectClips[4]!, "uncertain"), // clip-005
    projectClips[5]!, // clip-006, never classified
  ];
  const faces = [ev("f1", "clip-003", "00:00:01:00", { kind: "face" })];

  it("automatic: non-dialogue → B-roll; speech with a face, or already on V1 → interview; anything else uncertain", () => {
    const roles = mediaRoles(clips, [], undefined, s);
    expect([...roles.values()].map((r) => [r.clipId, r.role, r.source])).toEqual([
      ["clip-001", "interview", "automatic"],
      ["clip-003", "uncertain", "automatic"],
      ["clip-004", "b-roll", "automatic"],
      ["clip-005", "uncertain", "automatic"],
      ["clip-006", "uncertain", "automatic"],
    ]);
    expect(roles.get("clip-003")!.reasons.join(" ")).toMatch(/may be B-roll with ambient speech/);
    expect(mediaRoles(clips, faces, undefined, s).get("clip-003")!.role).toBe("interview");
  });

  it("a filmmaker override always wins, keyed by relative path", () => {
    const overrides = { "CLIP-003.MP4": "b-roll" as const, "CLIP-004.MP4": "interview" as const };
    const roles = mediaRoles(clips, faces, overrides, s);
    expect(roles.get("clip-003")).toMatchObject({ role: "b-roll", source: "override" });
    expect(roles.get("clip-004")).toMatchObject({ role: "interview", source: "override" });
  });

  it("only well-formed overrides survive sanitising", () => {
    expect(
      sanitizeMediaRoles({
        "a.mp4": "b-roll",
        "b.mp4": "interview",
        "c.mp4": "ambient",
        "": "b-roll",
        "x\u0001": "b-roll",
      }),
    ).toEqual({ "a.mp4": "b-roll", "b.mp4": "interview" });
    expect(sanitizeMediaRoles(["a"])).toEqual({});
    expect(sanitizeMediaRoles(null)).toEqual({});
  });
});

describe("B-roll inventory", () => {
  const s = directorSequence();
  const broll = (id: string, fps: number, dur: number, extra: Partial<Clip> = {}) =>
    withDialogue(clip(id, fps, dur, extra), "non-dialogue");

  it("one provisional window per usable moment: 1 s before to 1.5 s after, at the media's own rate", () => {
    const inv = brollInventory(s, {
      clips: [broll("clip-005", 23.976, 9.4)],
      visualEvidence: [ev("e1", "clip-005", "00:00:04:00")],
    });
    expect(inv.excluded).toEqual([]);
    const c = inv.candidates[0]!;
    expect(c).toMatchObject({
      id: "cand:e1",
      mediaClipId: "clip-005",
      file: "CLIP-005.MP4",
      mediaFps: 23.976,
      durationSeconds: 9.4,
      mediaEndFrame: 225,
      evidence: { id: "e1", atTc: "00:00:04:00", atFrame: 96, confidence: 0.8, kind: "b-roll" },
      window: {
        sourceInFrame: 72,
        sourceOutFrame: 132,
        inTc: "00:00:03:00",
        outTc: "00:00:05:12",
        provisional: true,
      },
      usedBy: [],
      overlaps: [],
      flags: [],
    });
    expect(c.window.basis).toMatch(/one sampled frame .* not a verified shot/);
    expect(c.window.sequenceFrames).toBe(60);
    expect(inv.revision).toBe(sequenceRevision(s));
  });

  it("clamps at the media's start and end, and flags it", () => {
    const inv = brollInventory(s, {
      clips: [broll("clip-005", 24, 4)],
      visualEvidence: [
        ev("start", "clip-005", "00:00:00:12"),
        ev("end", "clip-005", "00:00:03:12"),
      ],
    });
    const byId = new Map(inv.candidates.map((c) => [c.id, c]));
    expect(byId.get("cand:start")!.window.sourceInFrame).toBe(0);
    expect(byId.get("cand:start")!.flags).toContain("clamped-at-media-start");
    expect(byId.get("cand:end")!.window.sourceOutFrame).toBe(96);
    expect(byId.get("cand:end")!.flags).toContain("clamped-at-media-end");
  });

  it("flags source already used in the cut, and overlapping candidates", () => {
    // e7 on V2 uses clip-004 00:00:04:20–00:00:08:00.
    const inv = brollInventory(s, {
      clips: [broll("clip-004", 23.976, 34.1)],
      visualEvidence: [
        ev("used", "clip-004", "00:00:05:00"),
        ev("near", "clip-004", "00:00:06:00"),
        ev("free", "clip-004", "00:00:20:00"),
      ],
    });
    const byId = new Map(inv.candidates.map((c) => [c.id, c]));
    expect(byId.get("cand:used")!.usedBy).toEqual([
      expect.objectContaining({ itemId: item(s, "event-7").id, track: "V2" }),
    ]);
    expect(byId.get("cand:used")!.flags).toEqual(["used-in-cut", "overlaps-another-candidate"]);
    expect(byId.get("cand:used")!.overlaps).toEqual(["cand:near"]);
    expect(byId.get("cand:free")!.flags).toEqual([]);
  });

  it.each<[string, Partial<{ clips: Clip[]; ev: VisualEvidence[] }>, string]>([
    ["media not in the project", { ev: [ev("x", "clip-999", "00:00:01:00")] }, "missing-media"],
    [
      "an interview file",
      {
        clips: [withDialogue(projectClips[1]!, "dialogue")],
        ev: [ev("x", "clip-002", "00:00:01:00")],
      },
      "not-b-roll",
    ],
    [
      "an uncertain file",
      {
        clips: [withDialogue(projectClips[4]!, "uncertain")],
        ev: [ev("x", "clip-005", "00:00:01:00")],
      },
      "uncertain-role",
    ],
    [
      "an unanalyzed file",
      { clips: [broll("clip-005", 24, 9, { state: "queued" })] },
      "not-analyzed",
    ],
    ["an unknown frame rate", { clips: [broll("clip-005", 0, 9)] }, "unknown-frame-rate"],
    ["an unknown length", { clips: [broll("clip-005", 24, 0)] }, "unknown-duration"],
    ["a face", { ev: [ev("x", "clip-005", "00:00:01:00", { kind: "face" })] }, "unusable-kind"],
    [
      "a technical note",
      { ev: [ev("x", "clip-005", "00:00:01:00", { kind: "technical" })] },
      "unusable-kind",
    ],
    [
      "a bad confidence",
      { ev: [ev("x", "clip-005", "00:00:01:00", { confidence: 1.5 })] },
      "bad-confidence",
    ],
    ["an unreadable timestamp", { ev: [ev("x", "clip-005", "soon")] }, "bad-timestamp"],
    ["a timestamp past the end", { ev: [ev("x", "clip-005", "00:00:20:00")] }, "outside-media"],
    [
      "too little media around it",
      { clips: [broll("clip-005", 24, 0.5)], ev: [ev("x", "clip-005", "00:00:00:06")] },
      "too-short",
    ],
  ])("excludes %s — with a reason", (_n, p, code) => {
    const inv = brollInventory(s, {
      clips: p.clips ?? [broll("clip-005", 24, 9)],
      visualEvidence: p.ev ?? [ev("x", "clip-005", "00:00:01:00")],
    });
    expect(inv.candidates).toEqual([]);
    expect(inv.excluded.map((e) => e.code)).toEqual([code]);
    expect(inv.excluded[0]!.message.length).toBeGreaterThan(10);
  });

  it("duplicate evidence ids and identical windows are reported once each", () => {
    const inv = brollInventory(s, {
      clips: [broll("clip-005", 24, 9)],
      visualEvidence: [
        ev("a", "clip-005", "00:00:04:00"),
        ev("a", "clip-005", "00:00:05:00"),
        ev("b", "clip-005", "00:00:04:00"),
      ],
    });
    expect(inv.candidates.map((c) => c.id)).toEqual(["cand:a"]);
    expect(inv.excluded.map((e) => [e.evidenceId, e.code])).toEqual([
      ["a", "duplicate-evidence"],
      ["b", "duplicate-window"],
    ]);
  });

  it("an override brings an uncertain file in; overriding to interview takes it out", () => {
    const clips = [withDialogue(projectClips[2]!, "dialogue")]; // clip-003, no face
    const evs = [ev("m", "clip-003", "00:00:05:00")];
    expect(brollInventory(s, { clips, visualEvidence: evs }).excluded[0]!.code).toBe(
      "uncertain-role",
    );
    expect(
      brollInventory(s, { clips, visualEvidence: evs, overrides: { "CLIP-003.MP4": "b-roll" } })
        .candidates,
    ).toHaveLength(1);
    const b = [withDialogue(projectClips[3]!, "non-dialogue")];
    expect(
      brollInventory(s, {
        clips: b,
        visualEvidence: [ev("n", "clip-004", "00:00:20:00")],
        overrides: { "CLIP-004.MP4": "interview" },
      }).excluded[0]!.code,
    ).toBe("not-b-roll");
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
  it("matches the observed coverage, identifies the B-roll files (clip-003 needs confirmation) and changes nothing", () => {
    const a = JSON.parse(readFileSync(analysisFile!, "utf8"));
    // The REAL worker classification (worker/dialogue.py), run locally — no AI.
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
            "clips = {c['id']: C(c) for c in a['clips']}",
            "print(json.dumps(dialogue.assess_project(clips, a['transcript'], a['visualEvidence'])))",
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
    const byVersion: Record<string, ReturnType<typeof analyzeCoverage>["summary"]> = {};
    for (const file of stateFiles) {
      const before = readFileSync(file, "utf8");
      const state = JSON.parse(before);
      const ws = workspaceFromVersions(state.versions);
      for (const v of state.versions as EditVersion[]) {
        const seq = sequenceOf(ws, v.id, clips)!;
        if (!Object.keys(seq.items).length) continue;
        const an = analyzeCoverage(seq, v.id);
        byVersion[v.version] = an.summary;
        for (const c of an.cuts) expect(c.coveredBefore >= 0 && c.coveredAfter >= 0).toBe(true);
        const inv = brollInventory(seq, { clips, visualEvidence: a.visualEvidence });
        const role = new Map(inv.roles.map((r) => [r.clipId, r.role]));
        expect(role.get("clip-003")).toBe("uncertain");
        expect(["clip-004", "clip-005", "clip-006"].map((id) => role.get(id))).toEqual([
          "b-roll",
          "b-roll",
          "b-roll",
        ]);
        expect(new Set(inv.candidates.map((c) => c.mediaClipId))).toEqual(
          new Set(["clip-004", "clip-005", "clip-006"]),
        );
        for (const c of inv.candidates) {
          expect(c.window.sourceOutFrame).toBeLessThanOrEqual(c.mediaEndFrame);
          expect(c.window.provisional).toBe(true);
        }
        const overridden = brollInventory(seq, {
          clips,
          visualEvidence: a.visualEvidence,
          overrides: { [clips.find((c) => c.id === "clip-003")!.relPath!]: "b-roll" },
        });
        expect(overridden.candidates.some((c) => c.mediaClipId === "clip-003")).toBe(true);
      }
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    // As observed earlier (worker/editorial.py): v1.2 has 2 uncovered jump cuts, v1.3/v1.4 2 covered.
    expect(byVersion["v1.2"]).toMatchObject({
      jump: 2,
      uncovered: 4,
      potentialJumpsNeedingCover: 2,
    });
    expect(byVersion["v1.4"]).toMatchObject({ jump: 2, covered: 2, potentialJumpsNeedingCover: 0 });
    expect(byVersion["v1.3"]).toMatchObject({ jump: 2, covered: 2 });
  });
});
