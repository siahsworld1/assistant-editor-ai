import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import { applyCommand, commands } from "@/lib/timeline/commands";
import type { PlaceEditParams } from "@/lib/timeline/commands/types";
import { commit, createHistory, redo, undo } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations, type MediaInventory } from "@/lib/timeline/invariants";
import { sequenceToLegacy } from "@/lib/timeline/legacy-adapter";
import { rateFromFps, sequenceDurationFrames } from "@/lib/timeline/time";
import { applyTransaction, makeTransaction, replay } from "@/lib/timeline/transactions";
import type { Command, Sequence, TransactionOrigin } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  parseSavedEditStateV2,
  sequenceOf,
  serializeWorkspace,
  workspaceFromVersions,
  undoIn,
} from "@/lib/timeline/workspace";
import { deepFreeze, directorSequence, media, mediaOf, protect, track } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";

const params = (seq: Sequence): PlaceEditParams => ({
  itemId: "placed-cutaway",
  mediaClipId: "clip-005",
  mediaRate: rateFromFps(23.976),
  sourceInFrame: 24,
  sourceOutFrame: 84,
  startFrame: 216,
  trackId: track(seq, "V2").id,
  label: "New cutaway",
});
const command = (p: PlaceEditParams): Command => ({
  id: "place-command",
  type: "PlaceEdit",
  params: p as unknown as Record<string, unknown>,
});
const apply = (
  seq: Sequence,
  p = params(seq),
  origin: TransactionOrigin = "director",
  inventory: MediaInventory | undefined = media,
) => applyCommand(seq, command(p), { origin, transactionId: "placement-txn", media: inventory });

function added(seq: Sequence) {
  const out = apply(seq);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error(out.error.message);
  return out.sequence;
}

describe("PlaceEdit overlay command", () => {
  it("adds only picture on V2, stamps ownership, and keeps every existing item and link unchanged", () => {
    const seq = directorSequence();
    const next = added(seq);
    expect(findViolations(next, { media })).toEqual([]);
    const it = next.items[params(seq).itemId]!;
    expect(it).toMatchObject({
      origin: "director",
      editedBy: "director",
      originTransactionId: "placement-txn",
      enabled: true,
    });
    expect(it.linkGroupId).toBeUndefined();
    expect(it.legacy).toBeUndefined();
    expect(next.links).toEqual(seq.links);
    expect(next.tracks).toBe(seq.tracks);
    expect(next.targetFrames).toBe(seq.targetFrames);
    for (const [id, item] of Object.entries(seq.items)) expect(next.items[id]).toBe(item);
  });

  it.each([23.976, 24, 25, 29.97, 30])(
    "uses the canonical conversion at %s fps, including mixed-rate media",
    (fps) => {
      for (const sourceFps of [fps, 23.976]) {
        const seq = deepFreeze({ ...directorSequence(), rate: rateFromFps(fps) });
        const p = {
          ...params(seq),
          mediaRate: rateFromFps(sourceFps),
          sourceInFrame: 1,
          sourceOutFrame: 61,
          startFrame: 100,
        };
        const out = apply(seq, p);
        expect(out.ok).toBe(true);
        if (out.ok)
          expect(out.sequence.items[p.itemId]!.durationFrames).toBe(
            sequenceDurationFrames(1, 61, p.mediaRate, seq.rate),
          );
      }
    },
  );

  it.each([
    { sourceInFrame: -1 },
    { sourceInFrame: 1.5 },
    { sourceOutFrame: 24 },
    { sourceOutFrame: 0 },
    { sourceOutFrame: Infinity },
    { sourceOutFrame: NaN },
    { startFrame: -1 },
    { startFrame: 0.25 },
    { startFrame: Number.MAX_SAFE_INTEGER },
    { mediaRate: { num: 0, den: 1 } },
    { mediaRate: { num: 24, den: 0 } },
    { mediaRate: { num: NaN, den: 1 } },
    { label: " " },
    { itemId: "" },
  ])("refuses invalid parameters %j without a sequence", (patch) => {
    const seq = directorSequence();
    const out = apply(seq, { ...params(seq), ...patch });
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty("sequence");
  });

  it("requires known finite media bounds and refuses an out point beyond the source", () => {
    const seq = directorSequence();
    for (const inventory of [
      new Map(),
      new Map([["clip-005", { durationSeconds: 0 }]]),
      new Map([["clip-005", { durationSeconds: Infinity }]]),
    ]) {
      expect(apply(seq, params(seq), "director", inventory).ok).toBe(false);
    }
    expect(
      applyCommand(seq, command(params(seq)), { origin: "director", transactionId: "x" }).ok,
    ).toBe(false);
    expect(apply(seq, { ...params(seq), sourceOutFrame: 1000 }).ok).toBe(false);
    expect(apply(seq, { ...params(seq), mediaClipId: "missing" }).ok).toBe(false);
  });

  it("refuses ids colliding with the sequence, tracks, items, links, or object keys", () => {
    const seq = directorSequence();
    for (const itemId of [
      seq.id,
      seq.tracks[0]!.id,
      Object.keys(seq.items)[0]!,
      Object.keys(seq.links)[0]!,
      "__proto__",
    ]) {
      expect(apply(seq, { ...params(seq), itemId }).ok).toBe(false);
    }
  });

  it("allows adjacent items but refuses overlaps, even with disabled or manual footage", () => {
    const seq = directorSequence();
    const cutaway = Object.values(seq.items).find((i) => i.trackId === track(seq, "V2").id)!;
    const p = { ...params(seq), startFrame: cutaway.startFrame + cutaway.durationFrames };
    expect(apply(seq, p).ok).toBe(true);
    const blocked = deepFreeze({
      ...seq,
      items: {
        ...seq.items,
        [cutaway.id]: {
          ...cutaway,
          enabled: false,
          editedBy: "manual" as const,
          protection: { locked: true, aiLocked: true },
        },
      },
    });
    const out = apply(blocked, { ...p, startFrame: cutaway.startFrame });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("overlap");
  });

  it("refuses V1, audio, and unknown tracks; allows higher overlay tracks", () => {
    const seq = directorSequence();
    for (const trackId of [track(seq, "V1").id, track(seq, "A1").id, "missing"])
      expect(apply(seq, { ...params(seq), trackId }).ok).toBe(false);
    const higher = deepFreeze({
      ...seq,
      tracks: [...seq.tracks, { ...track(seq, "V2"), id: "v3", name: "V3", order: 2 }],
    });
    expect(apply(higher, { ...params(seq), trackId: "v3" }).ok).toBe(true);
  });

  it("honors track protection and stamps manual/system placements as filmmaker-owned", () => {
    const seq = directorSequence();
    const locked = protect(seq, { trackName: "V2" }, { locked: true });
    const aiLocked = protect(seq, { trackName: "V2" }, { aiLocked: true });
    for (const origin of ["director", "manual", "system"] as const) {
      expect(apply(locked, params(seq), origin).ok).toBe(false);
      const out = apply(aiLocked, params(seq), origin);
      expect(out.ok).toBe(origin !== "director");
      if (out.ok) expect(out.sequence.items[params(seq).itemId]!.editedBy).toBe("manual");
    }
  });

  it("fixes ids once, replays identically, and supports exact undo/redo with atomic rejection", () => {
    const seq = directorSequence();
    const ids = seededIds("place");
    const { itemId: _id, ...p } = params(seq);
    const cmd = commands.place(ids, p);
    const txn = makeTransaction(
      ids,
      "Place cutaway",
      "director",
      [cmd as unknown as Command],
      "fixed",
    );
    const out = commit(createHistory(seq), txn, { media });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(undo(out.history).present).toBe(seq);
    expect(redo(undo(out.history)).present).toBe(out.history.present);
    const replayed = replay(seq, [txn], { media });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.sequence).toEqual(out.history.present);
    const bad = makeTransaction(ids, "Atomic", "director", [
      cmd as unknown as Command,
      command({ ...p, itemId: "second" }),
    ]);
    expect(applyTransaction(seq, bad, { media }).ok).toBe(false);
    expect(Object.keys(seq.items)).not.toContain(cmd.params.itemId);
  });

  it("persists through the actual workspace save/reload path with its undo history intact", () => {
    const version: EditVersion = {
      id: "v1",
      version: "v1.2",
      label: "Director cut",
      command: "build",
      summary: "",
      createdAt: "fixed",
      changes: [],
      timeline: directorCut,
    };
    const ws = workspaceFromVersions([version]);
    const seq = sequenceOf(ws, version.id, projectClips)!;
    const ids = seededIds("saved-place");
    const { itemId: _id, ...p } = params(seq);
    const txn = makeTransaction(ids, "Place", "director", [
      commands.place(ids, p) as unknown as Command,
    ]);
    const out = dispatchTransaction(ws, version.id, txn, { clips: projectClips, media, ids });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const selections = {
      activeVersionId: out.activeVersionId,
      chosenStoryId: null,
      targetSeconds: 30,
      storyboardSelectIds: [],
    };
    const saved = serializeWorkspace(out.workspace, selections, "analysis", "fixed", projectClips);
    const restored = parseSavedEditStateV2(
      JSON.parse(JSON.stringify(saved)),
      "analysis",
      projectClips,
    )!;
    expect(restored.warnings).toEqual([]);
    const h = restored.workspace.histories[out.activeVersionId]!;
    expect(h.present).toEqual(sequenceOf(out.workspace, out.activeVersionId, projectClips));
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toEqual(seq);
    expect(redo(undo(h)).present).toEqual(h.present);
    const undone = undoIn(out.workspace, out.activeVersionId);
    const undoneSaved = serializeWorkspace(undone, selections, "analysis", "fixed", projectClips);
    const undoneRestored = parseSavedEditStateV2(
      JSON.parse(JSON.stringify(undoneSaved)),
      "analysis",
      projectClips,
    )!;
    expect(undoneRestored.warnings).toEqual([]);
    const undoneHistory = undoneRestored.workspace.histories[out.activeVersionId]!;
    expect(undoneHistory.future).toHaveLength(1);
    expect(redo(undoneHistory).present).toEqual(h.present);
  });

  it("exports the added V2 placement with source boundaries and leaves interview decisions unchanged", () => {
    const seq = directorSequence();
    const tl = sequenceToLegacy(added(seq)).timeline;
    const before = sequenceToLegacy(seq).timeline;
    expect(tl.decisions.filter((d) => d.lane !== "b-roll")).toEqual(
      before.decisions.filter((d) => d.lane !== "b-roll"),
    );
    const d = tl.decisions.find((d) => d.label === "New cutaway")!;
    expect(d.lane).toBe("b-roll");
    expect(d.timelineStartSeconds).toBe(9);
    const { usable } = validateTimelineForExport(tl, projectClips);
    expect(usable).toContainEqual(d);
    const x = buildXmeml(tl, usable, projectClips, "/media");
    const f = buildFcpxml(tl, usable, projectClips, "/media");
    expect(x.warnings).toEqual([]);
    expect(x.xml).toContain("CLIP-005.MP4");
    expect(x.xml).toContain("<start>216</start>");
    expect(x.xml).toContain("<in>24</in>");
    expect(x.xml).toContain("<out>84</out>");
    // The existing spine-only FCPXML exporter explicitly drops overlays.
    // Preserve that warning rather than claiming lossless overlay export.
    expect(f.warnings).toContain(
      '"New cutaway" overlaps the previous spine item and was dropped from the FCPXML export.',
    );
    expect(buildCmx3600Edl(tl, usable, projectClips)).toContain("CLIP-005.MP4");
  });
});

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .filter((p) => p && existsSync(p));
const analysisFile = process.env.AE_ANALYSIS_FILE;
describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "PlaceEdit real-project replay",
  () => {
    it("places and undoes on every saved version without changing any source file", () => {
      const analysisBefore = readFileSync(analysisFile!, "utf8");
      const a = JSON.parse(analysisBefore);
      const clips: Clip[] = (Array.isArray(a.clips) ? a.clips : Object.values(a.clips)).map(
        (c: { id: string; fps: number; duration_seconds: number; filename: string }) =>
          clip(c.id, c.fps, c.duration_seconds, { filename: c.filename }),
      );
      const inventory = mediaOf(clips);
      let checked = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws =
          state.schema === 2
            ? parseSavedEditStateV2(state, state.analysisId, clips)!.workspace
            : workspaceFromVersions(state.versions);
        for (const version of ws.versions) {
          const seq = deepFreeze(sequenceOf(ws, version.id, clips)!);
          const source = clips.find((c) => c.durationSeconds > 3)!;
          const overlay = seq.tracks.find((t) => t.kind === "video" && t.order === 1)!;
          const start = Math.max(
            0,
            ...Object.values(seq.items).map((i) => i.startFrame + i.durationFrames),
          );
          const ids = seededIds(`real-place-${version.id}`);
          const cmd = commands.place(ids, {
            mediaClipId: source.id,
            mediaRate: rateFromFps(source.fps),
            sourceInFrame: 0,
            sourceOutFrame: Math.round(source.fps),
            startFrame: start,
            trackId: overlay.id,
            label: "Replay placement",
          });
          const txn = makeTransaction(ids, "Place", "director", [cmd as unknown as Command]);
          const result = commit(createHistory(seq), txn, { media: inventory });
          expect(result.ok, version.version).toBe(true);
          if (result.ok) {
            expect(undo(result.history).present).toBe(seq);
            expect(redo(undo(result.history)).present).toEqual(result.history.present);
            const replayed = replay(seq, [txn], { media: inventory });
            expect(replayed.ok).toBe(true);
            if (replayed.ok) expect(replayed.sequence).toEqual(result.history.present);
            expect(findViolations(result.history.present, { media: inventory })).toEqual(
              findViolations(seq, { media: inventory }),
            );
          }
          checked++;
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(checked).toBeGreaterThan(0);
      expect(readFileSync(analysisFile!, "utf8")).toBe(analysisBefore);
    });
  },
);
