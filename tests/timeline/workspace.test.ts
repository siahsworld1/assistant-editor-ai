// Editor workspace (src/lib/timeline/workspace.ts): fork-on-edit, working
// versions, undo/redo, schema-2 persistence (save → reload exactness, ids,
// undo/redo across reload, the 200-entry cap, malformed-file recovery),
// version switching, and the export/playback bridges after reload.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion, UniversalTimeline } from "@/lib/ae/types";
import { buildPlaybackPlan } from "@/lib/ae/timeline-playback";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import { commands } from "@/lib/timeline/commands";
import { seededIds, type IdGenerator } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { itemsOnTrack } from "@/lib/timeline/selectors";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Sequence, Transaction } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  editorStatus,
  importedSequence,
  parseSavedEditStateV2,
  redoIn,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";

const MEDIA_ROOT = "/Users/editor/Footage";
const media = mediaOf(projectClips);
const SEL = {
  activeVersionId: "v2",
  chosenStoryId: "story-01",
  targetSeconds: 30,
  storyboardSelectIds: [],
};

const baseline: EditVersion = {
  id: "v1",
  label: "Awaiting first build",
  version: "v1.0",
  command: "—",
  summary: "No sequence built yet.",
  createdAt: "—",
  changes: [],
  timeline: {
    id: "tl-empty",
    name: "Empty",
    fps: 24,
    targetSeconds: 360,
    totalSeconds: 0,
    decisions: [],
  },
};
const director: EditVersion = {
  id: "v2",
  label: "Create a 30-second rough cut",
  version: "v1.1",
  command: "Create a 30-second rough cut",
  summary: "Director build.",
  createdAt: "18:16",
  changes: ["Built from story-01"],
  timeline: directorCut,
  parentId: "v1",
};

function freshWorkspace(): Workspace {
  return deepFreeze(workspaceFromVersions([structuredClone(baseline), structuredClone(director)]));
}

function v2Of(ws: Workspace): EditVersion {
  return ws.versions.find((v) => v.id === "v2")!;
}

function itemOf(seq: Sequence, decisionId: string) {
  return Object.values(seq.items).find((i) => i.legacy?.decision.id === decisionId)!;
}

let counter = 0;
function txn(
  ids: IdGenerator,
  label: string,
  build: (ids: IdGenerator) => Transaction["commands"],
): Transaction {
  counter += 1;
  return makeTransaction(
    ids,
    label,
    "manual",
    build(ids),
    `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
  );
}

function apply(ws: Workspace, active: string, t: Transaction, ids: IdGenerator) {
  const out = dispatchTransaction(ws, active, t, { clips: projectClips, media, ids, now: "19:00" });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return out;
}

/** Save → JSON on disk → load, exactly as the app does it (with the
 * project's clips, so parent-import references are written and resolved). */
function reload(ws: Workspace, activeVersionId: string) {
  const json = JSON.stringify(
    serializeWorkspace(ws, { ...SEL, activeVersionId }, "analysis-A", "", projectClips),
  );
  const restored = parseSavedEditStateV2(JSON.parse(json), "analysis-A", projectClips);
  if (!restored) throw new Error("did not reload");
  return { ...restored, bytes: json.length };
}

function exportsOf(timeline: UniversalTimeline, clips: Clip[]) {
  const { usable } = validateTimelineForExport(timeline, clips);
  return {
    xmeml: buildXmeml(timeline, usable, clips, MEDIA_ROOT).xml,
    edl: buildCmx3600Edl(timeline, usable, clips),
    fcpxml: buildFcpxml(timeline, usable, clips, MEDIA_ROOT).xml,
  };
}

/** One edit against the Director version: forks, returns the working state. */
function editOnce() {
  const ws = freshWorkspace();
  const ids = seededIds("ws");
  const seq = sequenceOf(ws, "v2", projectClips)!;
  const out = apply(
    ws,
    "v2",
    txn(ids, "Move event 6", (i) => [commands.move(i, [itemOf(seq, "event-6").id], 24)]),
    ids,
  );
  return { ws, ids, seq, out };
}

describe("schema 1 in memory", () => {
  it("converts a Director version to a Sequence deterministically, without touching it", () => {
    const ws = freshWorkspace();
    const before = structuredClone(v2Of(ws));
    const a = sequenceOf(ws, "v2", projectClips)!;
    const b = sequenceOf(ws, "v2", projectClips)!;
    expect(a).toBe(b); // cached: same object while the version is unchanged
    expect(importedSequence(structuredClone(director), projectClips)).toStrictEqual(a); // and the same ids every time
    expect(v2Of(ws)).toStrictEqual(before);
    expect(editorStatus(ws, "v2")).toEqual({
      edited: false,
      canUndo: false,
      canRedo: false,
      nextUndoLabel: null,
      nextRedoLabel: null,
    });
  });
});

describe("fork-on-edit", () => {
  it("the first manual edit forks an edited working version; the Director version is untouched", () => {
    const { ws, out } = editOnce();
    expect(out.forkedFrom).toBe("v2");
    const forked = out.workspace.versions.find((v) => v.id === out.activeVersionId)!;
    expect(forked).toMatchObject({
      kind: "edited",
      parentId: "v2",
      version: "v1.1 · edited",
      label: "Create a 30-second rough cut · edited",
    });
    expect(forked.id).toMatch(/^ver_[0-9a-f]{32}$/);
    expect(out.workspace.versions).toHaveLength(3);
    expect(v2Of(out.workspace)).toBe(v2Of(ws)); // same object
    expect(v2Of(out.workspace).timeline).toStrictEqual(directorCut);
    expect(editorStatus(out.workspace, forked.id)).toMatchObject({
      edited: true,
      canUndo: true,
      nextUndoLabel: "Move event 6",
    });
    // The working version's schema-1 view is derived from its Sequence.
    const moved = forked.timeline.decisions.find((d) => d.id === "event-6")!;
    expect(Math.round(moved.timelineStartSeconds * 24)).toBe(
      itemOf(sequenceOf(ws, "v2", projectClips)!, "event-6").startFrame + 24,
    );
  });

  it("second and third edits continue the same working version", () => {
    const { ids, seq, out } = editOnce();
    const w = out.activeVersionId;
    const two = apply(
      out.workspace,
      w,
      txn(ids, "Trim event 1", (i) => [commands.trim(i, itemOf(seq, "event-1").id, "out", -12)]),
      ids,
    );
    const three = apply(
      two.workspace,
      w,
      txn(ids, "Lift event 3", (i) => [commands.delete(i, [itemOf(seq, "event-3").id])]),
      ids,
    );
    expect([two.forkedFrom, three.forkedFrom, three.activeVersionId]).toEqual([null, null, w]);
    expect(three.workspace.versions).toHaveLength(3);
    expect(three.workspace.histories[w]!.past.map((e) => e.transaction.label)).toEqual([
      "Move event 6",
      "Trim event 1",
      "Lift event 3",
    ]);
    expect(three.workspace.versions.find((v) => v.id === w)!.changes).toEqual([
      "Move event 6",
      "Trim event 1",
      "Lift event 3",
    ]);
  });

  it("editing the Director version again forks a sibling and leaves the first child's history alone", () => {
    const { ids, seq, out } = editOnce();
    const first = out.activeVersionId;
    const firstHistory = out.workspace.histories[first]!;
    const again = apply(
      out.workspace,
      "v2",
      txn(ids, "Lift event 7", (i) => [commands.delete(i, [itemOf(seq, "event-7").id])]),
      ids,
    );
    expect(again.forkedFrom).toBe("v2");
    expect(again.activeVersionId).not.toBe(first);
    expect(again.workspace.versions.find((v) => v.id === again.activeVersionId)!.version).toBe(
      "v1.1 · edited 2",
    );
    expect(again.workspace.histories[first]).toBe(firstHistory);
  });

  it("a rejected transaction forks nothing and changes nothing", () => {
    const ws = freshWorkspace();
    const ids = seededIds("reject");
    const seq = sequenceOf(ws, "v2", projectClips)!;
    const out = dispatchTransaction(
      ws,
      "v2",
      txn(ids, "Bad move", (i) => [commands.move(i, [itemOf(seq, "event-1").id], 10)]),
      {
        clips: projectClips,
        media,
        ids,
      },
    );
    expect(out.ok).toBe(false);
    expect(ws.versions).toHaveLength(2);
  });

  it("undo/redo move through the working version's history", () => {
    const { seq, out } = editOnce();
    const w = out.activeVersionId;
    const undone = undoIn(out.workspace, w);
    expect(sequenceOf(undone, w, projectClips)).toBe(seq);
    expect(editorStatus(undone, w)).toMatchObject({
      canUndo: false,
      canRedo: true,
      nextRedoLabel: "Move event 6",
    });
    expect(sequenceOf(redoIn(undone, w), w, projectClips)).toBe(
      sequenceOf(out.workspace, w, projectClips),
    );
    expect(undoIn(undone, w)).toBe(undone); // nothing left to undo
  });
});

describe("schema-2 persistence", () => {
  it("save → reload gives the exact edited Sequence, with identical ids", () => {
    const { ids, seq, out } = editOnce();
    const w = out.activeVersionId;
    const e2 = itemOf(seq, "event-2");
    const split = commands.split(ids, seq, e2.id, e2.startFrame + 50);
    const two = apply(out.workspace, w, makeTransaction(ids, "Split", "manual", [split], "x"), ids);
    const r = reload(two.workspace, w);
    expect(r.warnings).toEqual([]);
    expect(r.activeVersionId).toBe(w);
    expect(sequenceOf(r.workspace, w, projectClips)).toStrictEqual(
      sequenceOf(two.workspace, w, projectClips),
    );
    expect(Object.keys(sequenceOf(r.workspace, w, projectClips)!.items).sort()).toEqual(
      Object.keys(sequenceOf(two.workspace, w, projectClips)!.items).sort(),
    );
    expect(
      sequenceOf(r.workspace, w, projectClips)!.items[split.params.rightItemIds[e2.id]!],
    ).toBeDefined();
    // Versions survive too, Director ones byte-for-byte.
    expect(v2Of(r.workspace)).toStrictEqual(director);
    expect(r.workspace.versions.find((v) => v.id === w)).toStrictEqual(
      two.workspace.versions.find((v) => v.id === w),
    );
  });

  it("save → reload → undo gives the exact pre-edit Sequence", () => {
    const { seq, out } = editOnce();
    const w = out.activeVersionId;
    const r = reload(out.workspace, w);
    expect(sequenceOf(undoIn(r.workspace, w), w, projectClips)).toStrictEqual(seq);
  });

  it("edit → undo → save → reload → redo gives the exact edited Sequence", () => {
    const { out } = editOnce();
    const w = out.activeVersionId;
    const edited = sequenceOf(out.workspace, w, projectClips)!;
    const r = reload(undoIn(out.workspace, w), w);
    expect(editorStatus(r.workspace, w)).toMatchObject({ canUndo: false, canRedo: true });
    expect(sequenceOf(redoIn(r.workspace, w), w, projectClips)).toStrictEqual(edited);
  });

  it("keeps 200 transactions across a reload, oldest dropped", () => {
    let { ws, ids, seq, out } = editOnce(); // eslint-disable-line prefer-const
    const w = out.activeVersionId;
    ws = out.workspace;
    const e6 = itemOf(seq, "event-6").id;
    for (let n = 2; n <= 205; n += 1) {
      ws = apply(
        ws,
        w,
        txn(ids, `step ${n}`, (i) => [commands.move(i, [e6], n % 2 ? 1 : -1)]),
        ids,
      ).workspace;
    }
    const r = reload(ws, w);
    const h = r.workspace.histories[w]!;
    expect(h.past).toHaveLength(200);
    expect(h.past[0]!.transaction.label).toBe("step 6");
    expect(r.warnings).toEqual([]);
    let back = r.workspace;
    for (let n = 0; n < 200; n += 1) back = undoIn(back, w);
    expect(editorStatus(back, w).canUndo).toBe(false);
    expect(sequenceOf(back, w, projectClips)).toStrictEqual(ws.histories[w]!.past[0]!.before);
  });

  it("recovers from malformed schema-2 data", () => {
    const { out } = editOnce();
    const w = out.activeVersionId;
    const good = JSON.parse(
      JSON.stringify(
        serializeWorkspace(out.workspace, { ...SEL, activeVersionId: w }, "analysis-A"),
      ),
    );
    // Not schema 2 / another analysis / not an object → fall back to schema 1.
    expect(parseSavedEditStateV2({ ...good, schema: 1 }, "analysis-A")).toBeNull();
    expect(parseSavedEditStateV2(good, "analysis-B")).toBeNull();
    expect(parseSavedEditStateV2("garbage", "analysis-A")).toBeNull();
    expect(parseSavedEditStateV2({ ...good, versions: "nope" }, "analysis-A")).toBeNull();
    // A damaged undo log keeps the edited present, drops the history.
    const tampered = structuredClone(good);
    tampered.histories[w].past[0].commands[0].params.deltaFrames = 999;
    const r1 = parseSavedEditStateV2(tampered, "analysis-A")!;
    expect(sequenceOf(r1.workspace, w, projectClips)).toStrictEqual(
      sequenceOf(out.workspace, w, projectClips),
    );
    expect(editorStatus(r1.workspace, w).canUndo).toBe(false);
    expect(r1.warnings.join(" ")).toMatch(/Undo history .* could not be fully restored/);
    // An edited version whose Sequence is unreadable is dropped; the rest loads.
    const broken = structuredClone(good);
    broken.histories[w].present = { schema: 2 };
    const r2 = parseSavedEditStateV2(broken, "analysis-A")!;
    expect(r2.workspace.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(r2.activeVersionId).toBe("v2");
    expect(r2.warnings.join(" ")).toMatch(/could not be restored/);
  });
});

describe("compact persistence (references to the parent Director import)", () => {
  function saved(ws: Workspace, w: string, clips: Clip[] | null = projectClips) {
    return JSON.parse(
      JSON.stringify(
        serializeWorkspace(ws, { ...SEL, activeVersionId: w }, "analysis-A", "", clips),
      ),
    );
  }

  it("stores the base, unchanged items and provenance by reference — and restores them exactly", () => {
    const { seq, out } = editOnce();
    const w = out.activeVersionId;
    const file = saved(out.workspace, w);
    const h = file.histories[w];
    expect(h.base).toBe("parent");
    expect(h.present.legacy).toBe("parent");
    const moved = itemOf(out.workspace.histories[w]!.present, "event-6");
    expect(h.present.items[moved.id].legacy).toBe("parent"); // edited item: provenance by ref
    expect(h.present.items[moved.id].startFrame).toBe(moved.startFrame);
    const refs = Object.values(h.present.items).filter((i) => i === "parent").length;
    expect(refs).toBe(Object.keys(seq.items).length - 2); // all but the moved V1 + its A1
    expect(JSON.stringify(h)).not.toContain("sourceInTc"); // no decision copies
    const full = saved(out.workspace, w, null);
    expect(JSON.stringify(file).length).toBeLessThan(JSON.stringify(full).length / 2);

    const r = parseSavedEditStateV2(file, "analysis-A", projectClips)!;
    expect(r.warnings).toEqual([]);
    const restored = r.workspace.histories[w]!;
    expect(restored.present).toStrictEqual(out.workspace.histories[w]!.present);
    expect(undoIn(r.workspace, w).histories[w]!.present).toStrictEqual(seq);
    expect(redoIn(undoIn(r.workspace, w), w).histories[w]!.present).toStrictEqual(
      out.workspace.histories[w]!.present,
    );
  });

  it("split pieces: the new piece is stored in full, the original by reference; undo/redo exact", () => {
    const ws = freshWorkspace();
    const ids = seededIds("compact-split");
    const seq = sequenceOf(ws, "v2", projectClips)!;
    const e2 = itemOf(seq, "event-2");
    const split = commands.split(ids, seq, e2.id, e2.startFrame + 60);
    const out = apply(
      ws,
      "v2",
      txn(ids, "Split", () => [split]),
      ids,
    );
    const w = out.activeVersionId;
    const file = saved(out.workspace, w);
    const right = split.params.rightItemIds[e2.id]!;
    expect(file.histories[w].present.items[right].legacy).toBeUndefined();
    expect(file.histories[w].present.items[right].id).toBe(right);
    expect(file.histories[w].present.items[e2.id].legacy).toBe("parent");
    const r = parseSavedEditStateV2(file, "analysis-A", projectClips)!;
    expect(r.workspace.histories[w]!.present).toStrictEqual(out.workspace.histories[w]!.present);
    const undone = undoIn(r.workspace, w);
    expect(undone.histories[w]!.present).toStrictEqual(seq);
    expect(redoIn(undone, w).histories[w]!.present.items[right]).toStrictEqual(
      out.workspace.histories[w]!.present.items[right],
    );
  });

  it("once the cap drops the parent state, the base is stored (still compacted) and replays exactly", () => {
    const ws = freshWorkspace();
    const ids = seededIds("compact-cap");
    const e6 = itemOf(sequenceOf(ws, "v2", projectClips)!, "event-6").id;
    let cur = ws;
    let active = "v2";
    for (let n = 1; n <= 203; n += 1) {
      const o = apply(
        cur,
        active,
        txn(ids, `s${n}`, (i) => [commands.move(i, [e6], n % 2 ? 1 : -1)]),
        ids,
      );
      cur = o.workspace;
      active = o.activeVersionId;
    }
    const file = saved(cur, active);
    expect(file.histories[active].base).not.toBe("parent");
    expect(file.histories[active].base.legacy).toBe("parent");
    const r = parseSavedEditStateV2(file, "analysis-A", projectClips)!;
    expect(r.warnings).toEqual([]);
    expect(r.workspace.histories[active]!.past[0]!.before).toStrictEqual(
      cur.histories[active]!.past[0]!.before,
    );
  });

  it("a file written in full (no references) still loads, with or without clips", () => {
    const { out } = editOnce();
    const w = out.activeVersionId;
    const full = saved(out.workspace, w, null);
    expect(full.histories[w].base).not.toBe("parent");
    for (const clips of [projectClips, null]) {
      const r = parseSavedEditStateV2(full, "analysis-A", clips)!;
      expect(r.warnings).toEqual([]);
      expect(r.workspace.histories[w]!.present).toStrictEqual(out.workspace.histories[w]!.present);
    }
  });

  it("references never resolve against a different import — reported, never silently re-derived", () => {
    const { out } = editOnce();
    const w = out.activeVersionId;
    const file = saved(out.workspace, w);
    const otherRates = projectClips.map((c) => (c.id === "clip-002" ? { ...c, fps: 25 } : c));
    const tamperedDigest = structuredClone(file);
    tamperedDigest.histories[w].parentDigest = "seq_0";
    for (const [raw, clips] of [
      [file, null], // the parent cannot be reproduced at all
      [file, otherRates], // reproduced differently (another clip rate)
      [tamperedDigest, projectClips], // written against another import
    ] as const) {
      const r = parseSavedEditStateV2(raw, "analysis-A", clips)!;
      expect(r.workspace.histories[w]).toBeUndefined();
      expect(r.workspace.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
      expect(r.warnings.join(" ")).toMatch(/could not be restored/);
    }
  });
});

describe("version switching", () => {
  it("the Director version shows its untouched cut; the edited child its Sequence and history", () => {
    const { seq, out } = editOnce();
    const w = out.activeVersionId;
    const r = reload(out.workspace, w);
    expect(sequenceOf(r.workspace, "v2", projectClips)).toStrictEqual(seq);
    expect(v2Of(r.workspace).timeline).toStrictEqual(directorCut);
    expect(editorStatus(r.workspace, "v2").edited).toBe(false);
    expect(sequenceOf(r.workspace, w, projectClips)).toStrictEqual(
      sequenceOf(out.workspace, w, projectClips),
    );
    expect(editorStatus(r.workspace, w)).toMatchObject({ edited: true, canUndo: true });
  });
});

describe("export bridge after reload (Sequence → adapter → existing exporters)", () => {
  type Case = [
    string,
    (seq: Sequence, ids: IdGenerator) => Transaction["commands"],
    (tl: UniversalTimeline, seq: Sequence) => void,
  ];
  const frames = (xml: string, tag: string) =>
    [...xml.matchAll(new RegExp(`<${tag}>(\\d+)</${tag}>`, "g"))].map((m) => Number(m[1]));
  const cases: Case[] = [
    [
      "move",
      (seq, ids) => [commands.move(ids, [itemOf(seq, "event-6").id], 24)],
      (tl) => expect(frames(exportsOf(tl, projectClips).xmeml, "start")).toContain(696 + 24),
    ],
    [
      "trim",
      (seq, ids) => [commands.trim(ids, itemOf(seq, "event-6").id, "out", -24)],
      (tl, seq) => {
        const t = itemOf(seq, "event-6");
        expect(frames(exportsOf(tl, projectClips).xmeml, "out")).toContain(t.sourceOutFrame - 24);
      },
    ],
    [
      "split",
      (seq, ids) => [commands.split(ids, seq, itemOf(seq, "event-1").id, 100)],
      (tl) => {
        const x = exportsOf(tl, projectClips).xmeml;
        expect(x).toMatch(/<start>0<\/start>\s*<end>100<\/end>/);
        expect(x).toMatch(/<start>100<\/start>\s*<end>240<\/end>/);
      },
    ],
    [
      "delete",
      (seq, ids) => [commands.delete(ids, [itemOf(seq, "event-3").id])],
      (tl) => {
        expect(tl.decisions.some((d) => d.id === "event-3")).toBe(false);
        expect(frames(exportsOf(tl, projectClips).xmeml, "start")).not.toContain(408);
      },
    ],
    [
      "ripple delete",
      (seq, ids) => [commands.rippleDelete(ids, [itemOf(seq, "event-2").id])],
      (tl) => {
        const starts = frames(exportsOf(tl, projectClips).xmeml, "start");
        for (const s of [408 - 168, 552 - 168, 696 - 168, 420 - 168, 708 - 168])
          expect(starts).toContain(s);
        expect(exportsOf(tl, projectClips).edl).toContain("00:00:10:00 00:00:16:00"); // event 3, rippled
      },
    ],
  ];

  it.each(cases)(
    "%s is reflected in XMEML/EDL/FCPXML after save → reload",
    (_name, build, check) => {
      const ws = freshWorkspace();
      const ids = seededIds("export");
      const seq = sequenceOf(ws, "v2", projectClips)!;
      const out = apply(ws, "v2", makeTransaction(ids, _name, "manual", build(seq, ids), "x"), ids);
      const r = reload(out.workspace, out.activeVersionId);
      const edited = r.workspace.versions.find((v) => v.id === out.activeVersionId)!;
      expect(findViolations(sequenceOf(r.workspace, edited.id, projectClips)!)).toEqual([]);
      check(edited.timeline, seq);
      const e = exportsOf(edited.timeline, projectClips);
      expect(e.xmeml).toContain("<xmeml");
      expect(e.fcpxml).toContain("<fcpxml");
    },
  );

  it("the untouched Director version still exports byte-identically", () => {
    const { out } = editOnce();
    const r = reload(out.workspace, out.activeVersionId);
    expect(exportsOf(v2Of(r.workspace).timeline, projectClips)).toEqual(
      exportsOf(directorCut, projectClips),
    );
  });
});

describe("playback bridge", () => {
  it("an edited working Sequence generates the existing playback plan", () => {
    const ws = freshWorkspace();
    const ids = seededIds("play");
    const seq = sequenceOf(ws, "v2", projectClips)!;
    const out = apply(
      ws,
      "v2",
      makeTransaction(
        ids,
        "Ripple",
        "manual",
        [commands.rippleDelete(ids, [itemOf(seq, "event-2").id])],
        "x",
      ),
      ids,
    );
    const edited = out.workspace.versions.find((v) => v.id === out.activeVersionId)!;
    const plan = buildPlaybackPlan(edited.timeline, projectClips);
    expect(plan.sequence.map((s) => s.decision.id)).toEqual([
      "event-1",
      "event-3",
      "event-5",
      "event-6",
    ]);
    expect(plan.sequence.map((s) => Math.round(s.decision.timelineStartSeconds * 24))).toEqual(
      itemsOnTrack(
        sequenceOf(out.workspace, edited.id, projectClips)!,
        sequenceOf(out.workspace, edited.id, projectClips)!.tracks[0]!.id,
      ).map((i) => i.startFrame),
    );
    expect(plan.overlays.map((s) => Math.round(s.decision.timelineStartSeconds * 24))).toEqual([
      420 - 168,
      708 - 168,
    ]);
  });
});

/* --------- optional: real saved schema-1 projects still load (local files) --------- */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(stateFiles.length === 0 || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("every saved version loads into the workspace and can be edited, saved and reloaded", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map((c: { id: string; fps: number; duration_seconds: number }) =>
        clip(c.id, c.fps, c.duration_seconds),
      );
      let loaded = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const seq = sequenceOf(ws, v.id, clips)!;
          expect(seq.schema).toBe(2);
          loaded += 1;
          const first = Object.values(seq.items).find(
            (i) => seq.tracks.find((t) => t.id === i.trackId)?.name === "V1",
          );
          if (!first) continue;
          const ids = seededIds(`real-${v.id}`);
          const out = dispatchTransaction(
            ws,
            v.id,
            makeTransaction(ids, "Lift", "manual", [commands.delete(ids, [first.id])], "x"),
            {
              clips,
              ids,
            },
          );
          expect(out.ok).toBe(true);
          if (out.ok) {
            const json = JSON.stringify(
              serializeWorkspace(
                out.workspace,
                { ...SEL, activeVersionId: out.activeVersionId },
                state.analysisId,
                "",
                clips,
              ),
            );
            const back = parseSavedEditStateV2(JSON.parse(json), state.analysisId, clips)!;
            expect(back.warnings).toEqual([]);
            const saved = JSON.parse(json).histories[out.activeVersionId];
            expect(saved.base).toBe("parent"); // reconstructed, not duplicated
            expect(sequenceOf(back.workspace, out.activeVersionId, clips)).toStrictEqual(
              sequenceOf(out.workspace, out.activeVersionId, clips),
            );
          }
        }
        expect(readFileSync(file, "utf8")).toBe(before); // never written
      }
      expect(loaded).toBe(8);
    });
  },
);
