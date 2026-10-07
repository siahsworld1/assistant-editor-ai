// Timeline gestures → engine commands (framework-free).
//
// The interactive CUT timeline never edits a Sequence itself. A pointer
// gesture is turned into the parameters of an existing Step-4 command
// (MoveEdit, TrimEdit, SplitEdit, DeleteEdit, RippleDelete); while the pointer
// is down the proposal is validated by a DRY RUN of the real engine
// (applyTransaction on the current Sequence — pure, nothing is stored), and on
// release the same parameters are committed as one transaction through the
// store's dispatchTransaction. So the preview shows exactly what the commit
// will do, and an illegal proposal (overlap, empty source range, past the
// media) is reported without touching the timeline.
//
// Snapping works in integer sequence frames: to the playhead and to the
// starts/ends of other items, within a fixed on-screen distance (SNAP_PX)
// converted to frames at the current zoom.
import { commands } from "./commands";
import type { TimelineError } from "./commands";
import type { TypedCommand } from "./commands/types";
import { seededIds, type IdGenerator } from "./ids";
import type { MediaInventory } from "./invariants";
import { endFrame, expandLinked, sequenceEndFrame } from "./selectors";
import { rescaleFrames } from "./time";
import { applyTransaction, makeTransaction } from "./transactions";
import type { Command, Sequence } from "./types";

/** Snap distance on screen, in CSS pixels (constant at every zoom level). */
export const SNAP_PX = 8;

/** The snap distance in whole sequence frames at `pxPerFrame` (never < 1). */
export function snapThresholdFrames(pxPerFrame: number): number {
  return Math.max(1, Math.round(SNAP_PX / Math.max(pxPerFrame, 1e-6)));
}

/** Frames a gesture can snap to: the playhead and every other item's start
 * and end (items in `exclude` — the ones being dragged — are skipped). */
export function snapPoints(
  seq: Sequence,
  playheadFrame: number | null,
  exclude: ReadonlySet<string> = new Set(),
): number[] {
  const points = new Set<number>([0]);
  if (playheadFrame !== null) points.add(playheadFrame);
  for (const item of Object.values(seq.items)) {
    if (exclude.has(item.id)) continue;
    points.add(item.startFrame);
    points.add(endFrame(item));
  }
  return [...points].sort((a, b) => a - b);
}

export interface Snapped {
  frame: number;
  /** The snap point it moved to, or null when nothing was within reach. */
  snappedTo: number | null;
}

/** The nearest snap point within `threshold` frames (ties: the earlier point). */
export function snapFrame(frame: number, points: readonly number[], threshold: number): Snapped {
  let best: number | null = null;
  for (const p of points) {
    const d = Math.abs(p - frame);
    if (d <= threshold && (best === null || d < Math.abs(best - frame))) best = p;
  }
  return best === null ? { frame, snappedTo: null } : { frame: best, snappedTo: best };
}

export interface SnapOptions {
  enabled: boolean;
  playheadFrame: number | null;
  threshold: number;
}

/** A gesture's result: how to build the command to commit (with the
 * editor's id generator, at commit time), and what the engine says it does. */
export type Proposal =
  | {
      ok: true;
      build: (ids: IdGenerator) => TypedCommand;
      sequence: Sequence;
      snappedTo: number | null;
      label: string;
    }
  | { ok: false; error: TimelineError; snappedTo: number | null; label: string };

const PREVIEW_IDS = () => seededIds("timeline-preview");

/** Dry-runs commands against `seq` with the real engine. Nothing is stored. */
export function dryRun(
  seq: Sequence,
  build: (ids: IdGenerator) => TypedCommand[],
  media?: MediaInventory,
): { ok: true; sequence: Sequence } | { ok: false; error: TimelineError } {
  const ids = PREVIEW_IDS();
  const out = applyTransaction(
    seq,
    makeTransaction(ids, "preview", "manual", build(ids) as Command[], "preview"),
    { media },
  );
  return out.ok ? { ok: true, sequence: out.sequence } : { ok: false, error: out.error };
}

/* ---------------------------------- move ---------------------------------- */

/**
 * Moving `itemIds` (linked partners move too) by a raw pointer offset. With
 * snapping, the group's start or end — whichever lands nearer a snap point —
 * is pulled onto it. The group never starts before frame 0.
 */
export function proposeMove(
  seq: Sequence,
  itemIds: readonly string[],
  rawDeltaFrames: number,
  snap: SnapOptions,
  media?: MediaInventory,
): Proposal & { deltaFrames: number } {
  const ids = expandLinked(seq, itemIds);
  const items = ids.map((id) => seq.items[id]!);
  const groupStart = Math.min(...items.map((i) => i.startFrame));
  const groupEnd = Math.max(...items.map(endFrame));
  let delta = Math.round(rawDeltaFrames);
  let snappedTo: number | null = null;
  if (snap.enabled) {
    const points = snapPoints(seq, snap.playheadFrame, new Set(ids));
    const a = snapFrame(groupStart + delta, points, snap.threshold);
    const b = snapFrame(groupEnd + delta, points, snap.threshold);
    const da = a.snappedTo === null ? Infinity : Math.abs(a.frame - (groupStart + delta));
    const db = b.snappedTo === null ? Infinity : Math.abs(b.frame - (groupEnd + delta));
    if (da <= db && a.snappedTo !== null) {
      delta = a.frame - groupStart;
      snappedTo = a.snappedTo;
    } else if (b.snappedTo !== null) {
      delta = b.frame - groupEnd;
      snappedTo = b.snappedTo;
    }
  }
  delta = Math.max(delta, -groupStart);
  const label = linkRepresentatives(seq, itemIds).length > 1 ? "Move clips" : "Move clip";
  const build = (g: IdGenerator) => commands.move(g, [...itemIds], delta);
  const run = dryRun(seq, (g) => [build(g)], media);
  return run.ok
    ? { ok: true, build, sequence: run.sequence, snappedTo, label, deltaFrames: delta }
    : { ok: false, error: run.error, snappedTo, label, deltaFrames: delta };
}

/* ---------------------------------- trim ---------------------------------- */

/** Where a trimmed edge sits on the sequence after a dry-run trim. */
function trimmedEdge(seq: Sequence, itemId: string, edge: "in" | "out"): number {
  const item = seq.items[itemId]!;
  return edge === "in" ? item.startFrame : endFrame(item);
}

/**
 * Trimming one edge of `itemId` so that edge lands on `targetEdgeFrame`
 * (snapped first). TrimEdit works in SOURCE frames, so the source delta whose
 * result lands exactly on the target is searched around the rate-converted
 * guess; if no source frame lands exactly (23.976 media on a 24 fps sequence),
 * the nearest valid one is used. Linked partners trim identically (engine).
 */
export function proposeTrim(
  seq: Sequence,
  itemId: string,
  edge: "in" | "out",
  targetEdgeFrame: number,
  snap: SnapOptions,
  media?: MediaInventory,
): Proposal & { deltaSourceFrames: number; edgeFrame: number } {
  const item = seq.items[itemId]!;
  let target = Math.round(targetEdgeFrame);
  let snappedTo: number | null = null;
  if (snap.enabled) {
    const s = snapFrame(
      target,
      snapPoints(seq, snap.playheadFrame, new Set(expandLinked(seq, [itemId]))),
      snap.threshold,
    );
    target = s.frame;
    snappedTo = s.snappedTo;
  }
  const current = trimmedEdge(seq, itemId, edge);
  // An in-trim moving the edge right REMOVES source (positive source delta).
  const guess = rescaleFrames(target - current, seq.rate, item.mediaRate);
  const label = `Trim ${edge === "in" ? "in" : "out"} point`;
  if (target === current) {
    const build = (g: IdGenerator) => commands.trim(g, itemId, edge, 0);
    const run = dryRun(seq, (g) => [build(g)], media);
    return run.ok
      ? {
          ok: true,
          build,
          sequence: run.sequence,
          snappedTo,
          label,
          deltaSourceFrames: 0,
          edgeFrame: current,
        }
      : { ok: false, error: run.error, snappedTo, label, deltaSourceFrames: 0, edgeFrame: current };
  }
  let best: { d: number; seq: Sequence; edge: number } | null = null;
  let firstError: TimelineError | null = null;
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    const d = guess + offset;
    if (d === 0) continue;
    const run = dryRun(seq, (g) => [commands.trim(g, itemId, edge, d)], media);
    if (!run.ok) {
      firstError ??= run.error;
      continue;
    }
    const e = trimmedEdge(run.sequence, itemId, edge);
    if (!best || Math.abs(e - target) < Math.abs(best.edge - target))
      best = { d, seq: run.sequence, edge: e };
    if (e === target) break;
  }
  if (!best) {
    return {
      ok: false,
      error: firstError ?? { code: "invalid-params", message: "That trim is not possible." },
      snappedTo,
      label,
      deltaSourceFrames: guess,
      edgeFrame: target,
    };
  }
  return {
    ok: true,
    build: (g: IdGenerator) => commands.trim(g, itemId, edge, best.d),
    sequence: best.seq,
    snappedTo: best.edge === target ? snappedTo : null,
    label,
    deltaSourceFrames: best.d,
    edgeFrame: best.edge,
  };
}

/* ---------------------------------- blade --------------------------------- */

/** The frame a blade click on `itemId` cuts at (snapped), or null when it is
 * not strictly inside the item. */
export function bladeFrame(
  seq: Sequence,
  itemId: string,
  pointerFrame: number,
  snap: SnapOptions,
): number | null {
  const item = seq.items[itemId];
  if (!item) return null;
  let at = Math.round(pointerFrame);
  if (snap.enabled) {
    at = snapFrame(
      at,
      snapPoints(seq, snap.playheadFrame, new Set([item.id])),
      snap.threshold,
    ).frame;
  }
  return at > item.startFrame && at < endFrame(item) ? at : null;
}

/** One item per link group (the engine expands the rest), in a stable order. */
export function linkRepresentatives(seq: Sequence, itemIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of itemIds) {
    if (!seq.items[id] || seen.has(id)) continue;
    for (const m of expandLinked(seq, [id])) seen.add(m);
    out.push(id);
  }
  return out;
}

/** Items to cut at the playhead (⌘K): the selected ones that span it, or —
 * with nothing selected — every item that spans it. */
export function splitAtPlayheadTargets(
  seq: Sequence,
  selected: ReadonlySet<string>,
  playheadFrame: number,
): string[] {
  const spans = (id: string) => {
    const i = seq.items[id];
    return !!i && playheadFrame > i.startFrame && playheadFrame < endFrame(i);
  };
  const pool = selected.size ? [...selected] : Object.keys(seq.items).sort();
  return linkRepresentatives(seq, pool.filter(spans));
}

/** The sequence length in frames (for clamping the playhead after an edit). */
export function sequenceLength(seq: Sequence): number {
  return sequenceEndFrame(seq);
}
