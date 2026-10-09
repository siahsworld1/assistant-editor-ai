// Phase 7, Milestone 1 — PlaceEdit protection and saved-project integrity.
//  - The Director may not cover footage the filmmaker locked or AI-protected;
//    hand-edited footage may be covered and is never changed by it.
//  - A saved undo log is replayed WITH the project's media inventory, so a
//    tampered or inconsistent log is dropped rather than trusted; the saved
//    cut is opened unchanged (never repaired) and media problems it gained
//    since its parent's import are reported.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 · e7 708–784 · A1 under every V1 clip
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion, UniversalTimeline } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import { seededIds, type IdGenerator } from "@/lib/timeline/ids";
import type { MediaInventory } from "@/lib/timeline/invariants";
import { endFrame, itemsOnTrack } from "@/lib/timeline/selectors";
import { rateFromFps } from "@/lib/timeline/time";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { Command, Sequence, TransactionOrigin } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  parseSavedEditStateV2,
  redoIn,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import {
  deepFreeze,
  directorSequence,
  item,
  media,
  mediaOf,
  partner,
  protect,
  track,
} from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";

/** clip-005 is 9.4 s of 23.976 media (225 frames). Over the e1/e2 cut at 240. */
function placeCmd(ids: IdGenerator, seq: Sequence, p: Partial<Record<string, unknown>> = {}) {
  return commands.place(ids, {
    trackId: track(seq, "V2").id,
    mediaClipId: "clip-005",
    mediaRate: rateFromFps(23.976),
    sourceInFrame: 24,
    sourceOutFrame: 84,
    startFrame: 216,
    label: "Park sign",
    ...p,
  } as Parameters<typeof commands.place>[1]);
}
function place(
  seq: Sequence,
  origin: TransactionOrigin = "director",
  p: Partial<Record<string, unknown>> = {},
  m: MediaInventory | undefined = media,
) {
  const ids = seededIds("place");
  return applyTransaction(
    seq,
    makeTransaction(ids, "Place", origin, [placeCmd(ids, seq, p) as unknown as Command], "t"),
    m ? { media: m } : {},
  );
}
const code = (o: ReturnType<typeof place>) => (o.ok ? null : o.error.code);
const edit = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return deepFreeze(n);
};

describe("protection: covering is not modifying", () => {
  it("the Director won't cover interview footage locked or AI-protected — on the clip or its track", () => {
    const base = directorSequence();
    const e2 = item(base, "event-2"); // 240–408, under the placement (216–276)
    const cases: Array<[string, Sequence, string[]]> = [
      ["AI-protected clip", protect(base, { itemId: e2.id }, { aiLocked: true }), [e2.id]],
      ["locked clip", protect(base, { itemId: e2.id }, { locked: true }), [e2.id]],
      ["AI-protected V1 track", protect(base, { trackName: "V1" }, { aiLocked: true }), []],
      ["locked V1 track", protect(base, { trackName: "V1" }, { locked: true }), []],
    ];
    for (const [name, seq, ids] of cases) {
      const r = place(seq, "director");
      expect(code(r), name).toBe("protected");
      if (!r.ok && ids.length) expect(r.error.itemIds, name).toEqual(ids);
      // The filmmaker may still place over it by hand.
      expect(place(seq, "manual").ok, name).toBe(true);
    }
  });

  it("only footage actually beneath the placement counts — an adjacent protected clip doesn't block it", () => {
    const base = directorSequence();
    const e2 = item(base, "event-2"); // starts at 240
    const seq = protect(base, { itemId: e2.id }, { aiLocked: true });
    // 180–240: ends exactly where the protected clip begins.
    expect(place(seq, "director", { startFrame: 180 }).ok).toBe(true);
    expect(code(place(seq, "director", { startFrame: 181 }))).toBe("protected");
  });

  it("protected B-roll elsewhere, or protection on audio, doesn't block an unrelated placement", () => {
    const base = directorSequence();
    const e4 = item(base, "event-4"); // V2 420–532, not beneath a V2 placement
    const a1 = partner(base, item(base, "event-2")); // audio under the placement
    expect(place(protect(base, { itemId: e4.id }, { aiLocked: true }), "director").ok).toBe(true);
    expect(place(protect(base, { itemId: a1.id }, { aiLocked: true }), "director").ok).toBe(true);
  });

  it("a hand-edited interview may be covered — it, its sync audio and its ownership are untouched", () => {
    const base = directorSequence();
    const e2 = item(base, "event-2");
    const seq = edit(base, (n) => {
      n.items[e2.id]!.editedBy = "manual";
    });
    const r = place(seq, "director");
    if (!r.ok) throw new Error(r.error.message);
    const a1 = partner(seq, seq.items[e2.id]!);
    expect(r.sequence.items[e2.id]).toBe(seq.items[e2.id]);
    expect(r.sequence.items[a1.id]).toBe(seq.items[a1.id]);
    expect(r.sequence.items[e2.id]!.editedBy).toBe("manual");
    expect(Object.keys(r.sequence.links)).toEqual(Object.keys(seq.links));
    const placed = Object.values(r.sequence.items).find((i) => !seq.items[i.id])!;
    expect([placed.editedBy, placed.linkGroupId]).toEqual(["director", undefined]);
  });
});

describe("saved projects: replay with media, report — never repair", () => {
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
  const SEL = { chosenStoryId: null, targetSeconds: 30, storyboardSelectIds: [] };

  /** A Director placement on a fresh working version, saved. */
  function savedWithPlacement(versions: EditVersion[] = [director]) {
    const ws = deepFreeze(workspaceFromVersions(structuredClone(versions))) as Workspace;
    const before = sequenceOf(ws, "v2", projectClips)!;
    const ids = seededIds("ws");
    const cmd = placeCmd(ids, before);
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(ids, "Director: cover", "director", [cmd as unknown as Command]),
      { clips: projectClips, media, ids, now: "t" },
    );
    if (!out.ok) throw new Error(out.error.message);
    const w = out.activeVersionId;
    const saved = JSON.parse(
      JSON.stringify(
        serializeWorkspace(out.workspace, { ...SEL, activeVersionId: w }, "A", "", projectClips),
      ),
    );
    return {
      saved,
      w,
      itemId: cmd.params.itemId,
      before,
      after: sequenceOf(out.workspace, w, projectClips)!,
    };
  }
  const load = (
    saved: unknown,
    clips: Parameters<typeof parseSavedEditStateV2>[2] = projectClips,
  ) => parseSavedEditStateV2(JSON.parse(JSON.stringify(saved)), "A", clips)!;

  it("an untampered save reopens with its undo history and no warnings; undo after reopening removes the placement", () => {
    const { saved, w, itemId, before, after } = savedWithPlacement();
    const r = load(saved);
    expect(r.warnings).toEqual([]);
    expect(r.workspace.histories[w]!.past).toHaveLength(1);
    expect(sequenceOf(r.workspace, w, projectClips)).toStrictEqual(after);
    const undone = undoIn(r.workspace, w);
    expect(sequenceOf(undone, w, projectClips)!.items[itemId]).toBeUndefined();
    expect(sequenceOf(undone, w, projectClips)).toStrictEqual(before);
    expect(sequenceOf(redoIn(undone, w), w, projectClips)).toStrictEqual(after);
  });

  it("unknown media in the saved log and cut: undo history dropped, cut opened unchanged, both reported", () => {
    const { saved, w, itemId } = savedWithPlacement();
    const h = saved.histories[w];
    h.past[0].commands[0].params.mediaClipId = "clip-999";
    h.present.items[itemId].mediaClipId = "clip-999";
    const r = load(saved);
    expect(r.workspace.histories[w]!.past).toHaveLength(0);
    expect(sequenceOf(r.workspace, w, projectClips)!.items[itemId]!.mediaClipId).toBe("clip-999"); // not repaired
    expect(r.warnings.join(" ")).toMatch(/Undo history for .* could not be fully restored/);
    expect(r.warnings.join(" ")).toMatch(
      /refers to media that is missing or shorter than the cut uses \(1 clip\)/,
    );
  });

  it("an out-of-range source in the saved log and cut: same — dropped, unchanged, reported", () => {
    const { saved, w, itemId } = savedWithPlacement();
    const h = saved.histories[w];
    h.past[0].commands[0].params.sourceOutFrame = 9999;
    h.present.items[itemId].sourceOutFrame = 9999;
    const r = load(saved);
    expect(r.workspace.histories[w]!.past).toHaveLength(0);
    expect(sequenceOf(r.workspace, w, projectClips)!.items[itemId]!.sourceOutFrame).toBe(9999);
    expect(r.warnings.join(" ")).toMatch(/missing or shorter than the cut uses/);
  });

  it("a log that no longer matches the saved cut: the cut wins, the log is dropped", () => {
    const { saved, w, itemId, after } = savedWithPlacement();
    saved.histories[w].past[0].commands[0].params.startFrame = 0;
    const r = load(saved);
    expect(r.workspace.histories[w]!.past).toHaveLength(0);
    expect(sequenceOf(r.workspace, w, projectClips)!.items[itemId]!.startFrame).toBe(
      after.items[itemId]!.startFrame,
    );
    expect(r.warnings.join(" ")).toMatch(/could not be fully restored/);
  });

  it("missing media inventory: the command refuses; a loader with rates only can't replay a placement and keeps the cut", () => {
    const seq = directorSequence();
    const ids = seededIds("noinv");
    const noInventory = applyTransaction(
      seq,
      makeTransaction(ids, "Place", "director", [placeCmd(ids, seq) as unknown as Command], "t"),
    );
    expect(code(noInventory)).toBe("out-of-bounds");
    const { saved, w, itemId } = savedWithPlacement();
    const rateOnly = projectClips.map((c) => ({ id: c.id, fps: c.fps }));
    const r = load(saved, rateOnly);
    expect(r.workspace.histories[w]!.past).toHaveLength(0);
    expect(sequenceOf(r.workspace, w, rateOnly)!.items[itemId]).toBeDefined();
    expect(r.warnings.join(" ")).not.toMatch(/missing or shorter/); // media unknown: nothing claimed
  });

  it("problems an imported legacy cut already had are not reported again", () => {
    // A Director cut whose B-roll already runs past its media (clip-005 is 9.4 s).
    const legacy: UniversalTimeline = {
      ...directorCut,
      decisions: [
        ...directorCut.decisions,
        {
          id: "event-x",
          lane: "b-roll",
          clipId: "clip-005",
          label: "b-roll event-x",
          sourceInTc: "00:00:08:00",
          sourceOutTc: "00:00:12:00",
          timelineStartSeconds: 1,
          durationSeconds: 4,
        },
      ],
    };
    const { saved, w } = savedWithPlacement([{ ...director, timeline: legacy }]);
    const r = load(saved);
    expect(r.workspace.histories[w]!.past).toHaveLength(1);
    expect(r.warnings).toEqual([]);
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
    it("a placement on every saved version saves and reopens with its undo history and NO integrity warnings — files untouched", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map((c: { id: string; fps: number; duration_seconds: number }) =>
        clip(c.id, c.fps, c.duration_seconds),
      );
      const realMedia = mediaOf(clips);
      const broll = clips.find((c) => c.id === "clip-005") ?? clips[clips.length - 1]!;
      let checked = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const seq = sequenceOf(ws, v.id, clips)!;
          const v1 = seq.tracks.find((t) => t.name === "V1");
          const v2 = seq.tracks.find((t) => t.name === "V2");
          if (!v1 || !v2 || !itemsOnTrack(seq, v1.id).length) continue;
          let start = 0;
          for (const i of itemsOnTrack(seq, v2.id)) {
            if (i.startFrame - start >= 48) break;
            start = Math.max(start, endFrame(i));
          }
          const ids = seededIds("real");
          const cmd = commands.place(ids, {
            trackId: v2.id,
            mediaClipId: broll.id,
            mediaRate: rateFromFps(broll.fps),
            sourceInFrame: 0,
            sourceOutFrame: 48,
            startFrame: start,
            label: "Real placement",
          });
          const out = dispatchTransaction(
            ws,
            v.id,
            makeTransaction(ids, "Director: place", "director", [cmd as unknown as Command]),
            { clips, media: realMedia, ids },
          );
          if (!out.ok) continue; // e.g. protected material beneath — refused, nothing changed
          const w = out.activeVersionId;
          const saved = JSON.parse(
            JSON.stringify(
              serializeWorkspace(
                out.workspace,
                {
                  activeVersionId: w,
                  chosenStoryId: null,
                  targetSeconds: 30,
                  storyboardSelectIds: [],
                },
                "A",
                "",
                clips,
              ),
            ),
          );
          const r = parseSavedEditStateV2(saved, "A", clips)!;
          expect(r.warnings, v.version).toEqual([]);
          expect(r.workspace.histories[w]!.past, v.version).toHaveLength(1);
          expect(sequenceOf(undoIn(r.workspace, w), w, clips), v.version).toStrictEqual(seq);
          checked += 1;
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(checked).toBeGreaterThan(0);
    });
  },
);
