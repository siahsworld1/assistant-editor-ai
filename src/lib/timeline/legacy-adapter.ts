// Schema-1 (UniversalTimeline) ⇄ schema-2 (Sequence).
//
// IMPORT (legacyToSequence) converts a beta.1 cut into the canonical model:
//   - lanes become real tracks: interview → V1, b-roll → V2, audio → A2, and
//     every V1 item gets an explicit, linked A1 item (its sync audio — which
//     schema 1 never stored, every consumer derived it from V1);
//   - frames are computed exactly as the exporters compute them (time.ts);
//   - each item keeps the decision it came from as read-only provenance.
//   Import is deterministic: the same cut always yields the same ids (it runs
//   on every load until the cut is saved in schema 2).
//
// EXPORT (sequenceToLegacy) produces a UniversalTimeline for the consumers
// that still speak schema 1 (playback, XMEML/EDL/FCPXML, the Premiere bridge):
//   - an item still exactly as imported returns its original decision
//     verbatim, so an unedited cut is byte-identical to beta.1 everywhere;
//   - any other item is generated from its frames (the only source of truth);
//   - A1 items aligned with their V1 item are implicit again; anything schema 1
//     cannot express is reported in `warnings`, never silently changed.
import type { Clip, EditDecision, EditDecisionLane, UniversalTimeline } from "@/lib/ae/types";
import { stableId } from "./ids";
import {
  frameToTcPreferring,
  framesToSeconds,
  fpsOf,
  rateFromFps,
  secondsToFrames,
  tcClockSeconds,
  tcToFrame,
} from "./time";
import { tcToSeconds } from "@/lib/nle/timecode";
import {
  SEQUENCE_SCHEMA,
  UNPROTECTED,
  type ClipItem,
  type FrameRate,
  type ItemFingerprint,
  type Origin,
  type Sequence,
  type TcLabelHint,
  type Track,
  type TrackRole,
} from "./types";

type ClipRates = ReadonlyArray<Pick<Clip, "id" | "fps">>;

export interface LegacyImportOptions {
  /** Distinguishes cuts that share a timeline id (e.g. the version id). */
  scope?: string;
  /** Who made this cut (a Director build, its fallback, or manual work). */
  origin?: Origin;
}

export interface LegacyExport {
  timeline: UniversalTimeline;
  warnings: string[];
}

const TRACK_LAYOUT: ReadonlyArray<{
  name: string;
  kind: Track["kind"];
  order: number;
  role: TrackRole;
}> = [
  { name: "V1", kind: "video", order: 0, role: "dialogue" },
  { name: "V2", kind: "video", order: 1, role: "broll" },
  { name: "A1", kind: "audio", order: 0, role: "dialogue-audio" },
  { name: "A2", kind: "audio", order: 1, role: "ambient" },
];

const LANE_TRACK: Record<EditDecisionLane, string> = {
  interview: "V1",
  "b-roll": "V2",
  audio: "A2",
};

export function fingerprintOf(item: ClipItem): ItemFingerprint {
  return {
    trackId: item.trackId,
    mediaClipId: item.mediaClipId,
    startFrame: item.startFrame,
    durationFrames: item.durationFrames,
    sourceInFrame: item.sourceInFrame,
    sourceOutFrame: item.sourceOutFrame,
    label: item.label,
    selectId: item.selectId ?? null,
    enabled: item.enabled,
  };
}

/** True while an imported item is exactly as it was imported. */
export function isUneditedLegacyItem(item: ClipItem): boolean {
  if (!item.legacy) return false;
  const a = fingerprintOf(item);
  const b = item.legacy.fingerprint;
  return (Object.keys(a) as Array<keyof ItemFingerprint>).every((k) => a[k] === b[k]);
}

/* --------------------------------- import --------------------------------- */

export function legacyToSequence(
  timeline: UniversalTimeline,
  clips: ClipRates,
  options: LegacyImportOptions = {},
): Sequence {
  const scope = options.scope ?? "";
  const origin = options.origin ?? "director";
  const seqId = stableId("sequence", scope, timeline.id);
  // Exporters and playback read the timeline rate as `timeline.fps || 24` and a
  // clip's as `clip.fps || timeline.fps || 24`; rateFromFps applies the same
  // fallbacks.
  const rate = rateFromFps(timeline.fps);
  const rateById = new Map(clips.map((c) => [c.id, c.fps]));

  const tracks: Track[] = TRACK_LAYOUT.map((t) => ({
    id: stableId("track", seqId, t.name),
    kind: t.kind,
    name: t.name,
    order: t.order,
    role: t.role,
    protection: { ...UNPROTECTED },
    muted: false,
    solo: false,
    hidden: false,
  }));
  const trackId = (name: string) => tracks.find((t) => t.name === name)!.id;

  const items: Record<string, ClipItem> = {};
  const links: Sequence["links"] = {};
  const decisionOrder: string[] = [];
  const occurrences = new Map<string, number>();

  for (const d of timeline.decisions) {
    // A decision id repeated within one cut is disambiguated by how many times
    // it has occurred so far (only ever needed for malformed legacy data).
    const n = occurrences.get(d.id) ?? 0;
    occurrences.set(d.id, n + 1);
    const id = stableId("item", seqId, d.id, String(n));

    const mediaRate = rateFromFps(rateById.get(d.clipId) || timeline.fps);
    const sourceInFrame = tcToFrame(d.sourceInTc, mediaRate) ?? 0;
    const sourceOutFrame =
      tcToFrame(d.sourceOutTc, mediaRate) ??
      sourceInFrame + secondsToFrames(d.durationSeconds, mediaRate);
    const item: ClipItem = {
      id,
      trackId: trackId(LANE_TRACK[d.lane] ?? "V1"),
      mediaClipId: d.clipId,
      startFrame: secondsToFrames(d.timelineStartSeconds, rate),
      // The sequence length beta.1 actually placed (its exporters'
      // max(1, round(durationSeconds × sequence fps))). For a Director build
      // this equals sequenceDurationFrames(in, out), since the worker sets
      // durationSeconds = out − in on the timecode clock.
      durationFrames: Math.max(1, secondsToFrames(d.durationSeconds, rate)),
      sourceInFrame,
      sourceOutFrame,
      mediaRate,
      label: d.label,
      ...(d.selectId !== undefined ? { selectId: d.selectId } : {}),
      enabled: true,
      origin,
      protection: { ...UNPROTECTED },
    };
    const tcProvenance = sourceTcProvenance(d, sourceInFrame, sourceOutFrame, mediaRate);
    if (tcProvenance) item.sourceTcProvenance = tcProvenance;
    item.legacy = { decision: structuredClone(d), fingerprint: fingerprintOf(item) };
    items[id] = item;
    decisionOrder.push(id);

    if (d.lane === "interview") {
      // The sync audio schema 1 left implicit: explicit, linked, aligned.
      const audioId = stableId("item", seqId, d.id, String(n), "A1");
      const linkId = stableId("link", id);
      const { legacy: _provenance, ...picture } = item;
      items[audioId] = { ...picture, id: audioId, trackId: trackId("A1"), linkGroupId: linkId };
      item.linkGroupId = linkId;
      links[linkId] = { id: linkId, itemIds: [id, audioId] };
    }
  }

  const { decisions: _decisions, ...header } = timeline;
  return {
    schema: SEQUENCE_SCHEMA,
    id: seqId,
    name: timeline.name,
    rate,
    targetFrames: secondsToFrames(timeline.targetSeconds, rate),
    tracks,
    items,
    links,
    legacy: { timeline: structuredClone(header), decisionOrder },
  };
}

/* --------------------------------- export --------------------------------- */

function laneFor(track: Track): EditDecisionLane | null {
  if (track.kind === "video") return track.role === "dialogue" ? "interview" : "b-roll";
  if (track.role === "dialogue-audio") return null; // implicit in schema 1
  return "audio";
}

/** Is this A1 item exactly its linked V1 item's sync audio (schema-1 implicit)? */
function alignedCompanion(seq: Sequence, audio: ClipItem): ClipItem | null {
  const group = audio.linkGroupId ? seq.links[audio.linkGroupId] : undefined;
  for (const otherId of group?.itemIds ?? []) {
    const other = seq.items[otherId];
    if (!other || other.id === audio.id) continue;
    const track = seq.tracks.find((t) => t.id === other.trackId);
    if (track?.kind === "video" && track.role === "dialogue") {
      const aligned =
        other.startFrame === audio.startFrame &&
        other.durationFrames === audio.durationFrames &&
        other.sourceInFrame === audio.sourceInFrame &&
        other.sourceOutFrame === audio.sourceOutFrame &&
        other.mediaClipId === audio.mediaClipId;
      return aligned ? other : null;
    }
  }
  return null;
}

/**
 * The imported endpoint labels that `frameToTc` would NOT reproduce — the
 * second of two timecodes sharing one frame — recorded so the length rule and
 * the export can still read that endpoint as imported while its frame is
 * unchanged. Recorded only when it matters (otherwise undefined), and only
 * for a label that really names the frame.
 */
function sourceTcProvenance(
  d: EditDecision,
  sourceInFrame: number,
  sourceOutFrame: number,
  mediaRate: FrameRate,
): ClipItem["sourceTcProvenance"] {
  const fps = fpsOf(mediaRate);
  const hint = (tc: string, frame: number): TcLabelHint | null =>
    tcToFrame(tc, mediaRate) === frame && tcToSeconds(tc, fps) !== tcClockSeconds(frame, mediaRate)
      ? { frame, tc }
      : null;
  const hintIn = hint(d.sourceInTc, sourceInFrame);
  const hintOut = hint(d.sourceOutTc, sourceOutFrame);
  return hintIn || hintOut ? { in: hintIn, out: hintOut } : undefined;
}

function decisionFromFrames(seq: Sequence, item: ClipItem, lane: EditDecisionLane): EditDecision {
  return {
    id: item.legacy?.decision.id ?? item.id,
    lane,
    clipId: item.mediaClipId,
    label: item.label,
    // An endpoint still at its imported frame keeps its imported label.
    sourceInTc: frameToTcPreferring(
      item.sourceInFrame,
      item.mediaRate,
      item.sourceTcProvenance?.in,
    ),
    sourceOutTc: frameToTcPreferring(
      item.sourceOutFrame,
      item.mediaRate,
      item.sourceTcProvenance?.out,
    ),
    timelineStartSeconds: framesToSeconds(item.startFrame, seq.rate),
    // Exactly durationFrames on the sequence: every schema-1 consumer places
    // an item as round(durationSeconds × sequence fps), which returns it.
    durationSeconds: framesToSeconds(item.durationFrames, seq.rate),
    ...(item.selectId !== undefined ? { selectId: item.selectId } : {}),
  };
}

export function sequenceToLegacy(seq: Sequence): LegacyExport {
  const warnings: string[] = [];
  const trackById = new Map(seq.tracks.map((t) => [t.id, t]));
  const out: Array<{ item: ClipItem; decision: EditDecision; verbatim: boolean }> = [];

  for (const item of Object.values(seq.items)) {
    const track = trackById.get(item.trackId);
    if (!track) {
      warnings.push(`"${item.label}" is on a track that no longer exists — not exported.`);
      continue;
    }
    if (!item.enabled) {
      warnings.push(`"${item.label}" is disabled — not exported.`);
      continue;
    }
    const lane = laneFor(track);
    if (lane === null) {
      if (!alignedCompanion(seq, item)) {
        warnings.push(
          `"${item.label}" on ${track.name} is not aligned with linked V1 picture — schema 1 cannot represent it; not exported.`,
        );
      }
      continue;
    }
    const verbatim = isUneditedLegacyItem(item) && item.legacy!.decision.lane === lane;
    out.push({
      item,
      decision: verbatim
        ? structuredClone(item.legacy!.decision)
        : decisionFromFrames(seq, item, lane),
      verbatim,
    });
  }

  // Original decision order first, then anything new by position.
  const rank = new Map((seq.legacy?.decisionOrder ?? []).map((id, i) => [id, i]));
  const order = (t: Track | undefined) => (t ? (t.kind === "video" ? 0 : 10) + t.order : 99);
  out.sort((a, b) => {
    const ra = rank.get(a.item.id);
    const rb = rank.get(b.item.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return (
      a.item.startFrame - b.item.startFrame ||
      order(trackById.get(a.item.trackId)) - order(trackById.get(b.item.trackId)) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
    );
  });
  const decisions = out.map((o) => o.decision);

  const original = seq.legacy;
  const untouched =
    !!original &&
    out.every((o) => o.verbatim) &&
    out.length === original.decisionOrder.length &&
    out.every((o, i) => o.item.id === original.decisionOrder[i]);
  const total = decisions.reduce(
    (a, d) => Math.max(a, d.timelineStartSeconds + d.durationSeconds),
    0,
  );

  const timeline: UniversalTimeline = original
    ? {
        ...structuredClone(original.timeline),
        name: seq.name,
        targetSeconds:
          secondsToFrames(original.timeline.targetSeconds, seq.rate) === seq.targetFrames
            ? original.timeline.targetSeconds
            : framesToSeconds(seq.targetFrames, seq.rate),
        totalSeconds: untouched ? original.timeline.totalSeconds : Math.round(total),
        decisions,
      }
    : {
        id: seq.id,
        name: seq.name,
        fps: fpsOf(seq.rate),
        targetSeconds: framesToSeconds(seq.targetFrames, seq.rate),
        totalSeconds: Math.round(total),
        decisions,
      };
  return { timeline, warnings };
}
