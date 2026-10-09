// Phase 7, Milestone 3 — deterministic B-roll coverage analysis. Pure: reads
// the live sequence and the project's existing analysis, never changes either,
// never places anything, makes no AI call.
//
//  1. Media roles: which files are B-roll. A filmmaker override always wins;
//     otherwise the worker's local dialogue assessment (worker/dialogue.py)
//     plus logged visual evidence decide. Anything not clearly B-roll is
//     "uncertain" and never offered as B-roll without an override.
//  2. Interview cuts: every back-to-back join on the interview track,
//     classified (same-source jump / continuous / different source) and with
//     its coverage (covered / partial / uncovered) on the visible overlay
//     tracks, in integer frames at the sequence's own rate. A same-source
//     jump is a POTENTIAL jump cut — the picture isn't inspected.
//  3. B-roll inventory: one provisional source window per usable logged
//     visual moment on a B-roll file. A sampled frame is a single moment, not
//     a verified shot: the window (1 s before to 1.5 s after it) is a starting
//     point for review, and its boundaries are not shot boundaries.
import type { Clip, VisualEvidence } from "@/lib/ae/types";
import { mediaEndFrame } from "./invariants";
import { sequenceRevision } from "./proposals";
import {
  endFrame,
  isLockedFrom,
  isOwnedAgainstDirector,
  isTrackProtectedFrom,
  itemsOnTrack,
} from "./selectors";
import { frameToTc, rateFromFps, secondsToFrames, sequenceDurationFrames, tcToFrame } from "./time";
import type { ClipItem, FrameRate, Sequence, Track } from "./types";

export const COVERAGE_SCHEMA = "ae.coverage/1" as const;

export type MediaRoleOverrides = Readonly<Record<string, "b-roll" | "interview">>;

/* ------------------------------- media roles ------------------------------ */

export type MediaRole = "interview" | "b-roll" | "uncertain";

export interface MediaRoleInfo {
  clipId: string;
  /** The override key: the file's path relative to the media folder. */
  file: string;
  role: MediaRole;
  source: "override" | "automatic";
  reasons: string[];
}

type RoleClip = Pick<Clip, "id" | "filename"> & Partial<Pick<Clip, "relPath" | "dialogue">>;

/** The key a filmmaker override is stored under (relative path, else name). */
export const overrideKey = (c: Pick<Clip, "filename"> & Partial<Pick<Clip, "relPath">>) =>
  c.relPath || c.filename;

/**
 * Role of every clip. Override first; then the worker's dialogue status:
 * non-dialogue → B-roll; dialogue → interview only with a logged face or when
 * the clip is already used on the interview track of `seq` — speech alone
 * (e.g. ambient voices at an event) doesn't make a file an interview; anything
 * else → uncertain.
 */
export function mediaRoles(
  clips: readonly RoleClip[],
  visualEvidence: readonly Pick<VisualEvidence, "clipId" | "kind">[],
  overrides: MediaRoleOverrides | undefined,
  seq: Sequence | null,
): Map<string, MediaRoleInfo> {
  const interviewTrack = seq ? dialogueTrack(seq) : null;
  const onInterviewTrack = new Set(
    seq && interviewTrack ? itemsOnTrack(seq, interviewTrack.id).map((i) => i.mediaClipId) : [],
  );
  const faces = new Set(visualEvidence.filter((v) => v.kind === "face").map((v) => v.clipId));
  const out = new Map<string, MediaRoleInfo>();
  for (const c of clips) {
    const file = overrideKey(c);
    const override = overrides?.[file];
    const base = { clipId: c.id, file };
    if (override === "b-roll" || override === "interview") {
      out.set(c.id, {
        ...base,
        role: override,
        source: "override",
        reasons: ["set by the filmmaker"],
      });
      continue;
    }
    const d = c.dialogue;
    if (!d) {
      out.set(c.id, {
        ...base,
        role: onInterviewTrack.has(c.id) ? "interview" : "uncertain",
        source: "automatic",
        reasons: onInterviewTrack.has(c.id)
          ? ["used as interview in this cut"]
          : ["not classified by this engine version"],
      });
      continue;
    }
    if (d.status === "non-dialogue") {
      out.set(c.id, { ...base, role: "b-roll", source: "automatic", reasons: d.reasons });
    } else if (d.status === "dialogue" && faces.has(c.id)) {
      out.set(c.id, {
        ...base,
        role: "interview",
        source: "automatic",
        reasons: [...d.reasons, "a face is logged on camera"],
      });
    } else if (d.status === "dialogue" && onInterviewTrack.has(c.id)) {
      out.set(c.id, {
        ...base,
        role: "interview",
        source: "automatic",
        reasons: [...d.reasons, "used as interview in this cut"],
      });
    } else if (d.status === "dialogue") {
      out.set(c.id, {
        ...base,
        role: "uncertain",
        source: "automatic",
        reasons: [
          ...d.reasons,
          "no face is logged — it may be B-roll with ambient speech; confirm its role",
        ],
      });
    } else {
      out.set(c.id, { ...base, role: "uncertain", source: "automatic", reasons: d.reasons });
    }
  }
  return out;
}

/* ------------------------------ interview cuts ----------------------------- */

export type CutKind = "jump" | "continuous" | "source-change";
export type CutCoverage = "covered" | "partial" | "uncovered";

export type CoverBlockerCode =
  | "locked-footage"
  | "ai-protected-footage"
  | "no-overlay-track"
  | "locked-track"
  | "ai-protected-track"
  | "hidden-track"
  | "overlay-conflict";

export interface CoverBlocker {
  code: CoverBlockerCode;
  message: string;
  ids?: string[] | undefined;
}

export interface CoverageCut {
  /** Stable for this pair of clips at this frame; bind to `revision`. */
  id: string;
  frame: number;
  tc: string;
  leftId: string;
  rightId: string;
  leftMediaId: string;
  rightMediaId: string;
  kind: CutKind;
  /** Same media only: right source in − left source out, in media frames. */
  sourceGapFrames: number | null;
  coverage: CutCoverage;
  /** Overlays on screen across the cut. */
  coveringIds: string[];
  /** Overlay frames before / after the cut (0 when uncovered). */
  coveredBefore: number;
  coveredAfter: number;
  /** A potential jump cut not yet fully covered. */
  potentialJump: boolean;
  /** Either side was edited by hand (or can't be verified) — reported only;
   * covering it doesn't change it. */
  handEdited: boolean;
  /** May the Director place B-roll over this cut at all? */
  directorMayCover: boolean;
  blockers: CoverBlocker[];
}

export interface CoverageAnalysis {
  schema: typeof COVERAGE_SCHEMA;
  versionId: string;
  revision: string;
  rate: FrameRate;
  /** Frames an overlay must extend on each side of a cut (≥ 0.5 s). */
  marginFrames: number;
  interviewTrackId: string | null;
  /** The first overlay video track (V2) — where B-roll would be placed. */
  overlayTrackId: string | null;
  cuts: CoverageCut[];
  summary: {
    cuts: number;
    jump: number;
    continuous: number;
    sourceChange: number;
    covered: number;
    partial: number;
    uncovered: number;
    potentialJumpsNeedingCover: number;
  };
}

const intersects = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** The interview (dialogue) video track: V1 by role. */
function dialogueTrack(seq: Sequence): Track | null {
  return (
    seq.tracks.find((t) => t.kind === "video" && t.role === "dialogue") ??
    seq.tracks.find((t) => t.kind === "video" && t.order === 0) ??
    null
  );
}

/** Whole frames that last at least half a second at `rate` (exact). */
export function halfSecondFrames(rate: FrameRate): number {
  return Math.ceil(rate.num / (2 * rate.den));
}

/** Coverage of every interview cut of `seq` (version `versionId`). */
export function analyzeCoverage(seq: Sequence, versionId: string): CoverageAnalysis {
  const interview = dialogueTrack(seq);
  const margin = halfSecondFrames(seq.rate);
  const overlayTracks = seq.tracks
    .filter((t) => t.kind === "video" && interview && t.order > interview.order)
    .sort((a, b) => a.order - b.order);
  const overlayTrack = overlayTracks[0] ?? null;
  const visibleOverlayTrackIds = new Set(overlayTracks.filter((t) => !t.hidden).map((t) => t.id));
  const overlays = Object.values(seq.items)
    .filter((i) => i.enabled && visibleOverlayTrackIds.has(i.trackId))
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
  const clips = interview ? itemsOnTrack(seq, interview.id).filter((i) => i.enabled) : [];

  // Union of visible overlay coverage (touching shots join up).
  const union: Array<[number, number]> = [];
  for (const o of overlays) {
    const last = union[union.length - 1];
    if (last && o.startFrame <= last[1]) last[1] = Math.max(last[1], endFrame(o));
    else union.push([o.startFrame, endFrame(o)]);
  }

  const cuts: CoverageCut[] = [];
  for (let n = 1; n < clips.length; n += 1) {
    const left = clips[n - 1]!;
    const right = clips[n]!;
    if (endFrame(left) !== right.startFrame) continue; // a gap, not a cut
    const frame = right.startFrame;
    const sameMedia = left.mediaClipId === right.mediaClipId;
    const gap = sameMedia ? right.sourceInFrame - left.sourceOutFrame : null;
    const kind: CutKind =
      gap === null ? "source-change" : Math.abs(gap) > 1 ? "jump" : "continuous";

    const span = union.find(([a, b]) => a < frame && b > frame);
    const before = span ? frame - span[0] : 0;
    const after = span ? span[1] - frame : 0;
    const coverage: CutCoverage = !span
      ? "uncovered"
      : before >= margin && after >= margin
        ? "covered"
        : "partial";
    const coveringIds = span
      ? overlays
          .filter((o) => intersects(o.startFrame, endFrame(o), span[0], span[1]))
          .map((o) => o.id)
      : [];

    // What would stop the Director covering it (nothing is decided here).
    const blockers: CoverBlocker[] = [];
    const lo = frame - margin;
    const hi = frame + margin;
    const beneath = Object.values(seq.items).filter((i) => {
      const t = seq.tracks.find((x) => x.id === i.trackId);
      return (
        t?.kind === "video" &&
        overlayTrack !== null &&
        t.order < overlayTrack.order &&
        intersects(i.startFrame, endFrame(i), lo, hi)
      );
    });
    const lockedBeneath = beneath.filter((i) => isLockedFrom(seq, i, "director"));
    const hardLocked = lockedBeneath.filter((i) => isLockedFrom(seq, i, "manual"));
    const aiOnly = lockedBeneath.filter((i) => !isLockedFrom(seq, i, "manual"));
    if (hardLocked.length)
      blockers.push({
        code: "locked-footage",
        message: `${names(hardLocked)} ${verb(hardLocked)} locked.`,
        ids: hardLocked.map((i) => i.id),
      });
    if (aiOnly.length)
      blockers.push({
        code: "ai-protected-footage",
        message: `${names(aiOnly)} ${verb(aiOnly)} protected from AI changes.`,
        ids: aiOnly.map((i) => i.id),
      });
    if (!overlayTrack)
      blockers.push({ code: "no-overlay-track", message: "There's no overlay video track (V2)." });
    else {
      if (overlayTrack.protection.locked)
        blockers.push({ code: "locked-track", message: `${overlayTrack.name} is locked.` });
      else if (isTrackProtectedFrom(overlayTrack, "director"))
        blockers.push({
          code: "ai-protected-track",
          message: `${overlayTrack.name} is protected from AI changes.`,
        });
      if (overlayTrack.hidden)
        blockers.push({ code: "hidden-track", message: `${overlayTrack.name} is hidden.` });
      if (coverage !== "covered") {
        const occupying = itemsOnTrack(seq, overlayTrack.id).filter((i) =>
          intersects(i.startFrame, endFrame(i), lo, hi),
        );
        if (occupying.length)
          blockers.push({
            code: "overlay-conflict",
            message: `${names(occupying)} already ${occupying.length > 1 ? "occupy" : "occupies"} ${overlayTrack.name} within half a second of the cut.`,
            ids: occupying.map((i) => i.id),
          });
      }
    }

    cuts.push({
      id: `cut:${left.id}|${right.id}@${frame}`,
      frame,
      tc: frameToTc(frame, seq.rate),
      leftId: left.id,
      rightId: right.id,
      leftMediaId: left.mediaClipId,
      rightMediaId: right.mediaClipId,
      kind,
      sourceGapFrames: gap,
      coverage,
      coveringIds,
      coveredBefore: before,
      coveredAfter: after,
      potentialJump: kind === "jump" && coverage !== "covered",
      handEdited: [left, right].some((i) => isOwnedAgainstDirector(i)),
      directorMayCover: blockers.length === 0,
      blockers,
    });
  }

  const count = (f: (c: CoverageCut) => boolean) => cuts.filter(f).length;
  return {
    schema: COVERAGE_SCHEMA,
    versionId,
    revision: sequenceRevision(seq),
    rate: seq.rate,
    marginFrames: margin,
    interviewTrackId: interview?.id ?? null,
    overlayTrackId: overlayTrack?.id ?? null,
    cuts,
    summary: {
      cuts: cuts.length,
      jump: count((c) => c.kind === "jump"),
      continuous: count((c) => c.kind === "continuous"),
      sourceChange: count((c) => c.kind === "source-change"),
      covered: count((c) => c.coverage === "covered"),
      partial: count((c) => c.coverage === "partial"),
      uncovered: count((c) => c.coverage === "uncovered"),
      potentialJumpsNeedingCover: count((c) => c.potentialJump),
    },
  };
}

const names = (items: ClipItem[]) => items.map((i) => `"${i.label}"`).join(", ");
const verb = (items: unknown[]) => (items.length > 1 ? "are" : "is");

/* ------------------------------ B-roll inventory --------------------------- */

/** Visual evidence kinds a cutaway may come from (not faces, not problems). */
const CUTAWAY_KINDS = new Set(["b-roll", "scene", "motion", "graphic"]);
/** The provisional window around a logged moment, in seconds. */
export const WINDOW_LEAD_S = 1;
export const WINDOW_TAIL_S = 1.5;

export type CandidateFlag =
  "used-in-cut" | "overlaps-another-candidate" | "clamped-at-media-start" | "clamped-at-media-end";

export interface BrollCandidate {
  id: string;
  mediaClipId: string;
  file: string;
  mediaRate: FrameRate;
  mediaFps: number;
  durationSeconds: number;
  mediaEndFrame: number;
  role: MediaRoleInfo;
  evidence: {
    id: string;
    kind: string;
    label: string;
    atTc: string;
    atFrame: number;
    confidence: number;
  };
  /** Provisional: around ONE sampled frame — not a verified shot. */
  window: {
    sourceInFrame: number;
    sourceOutFrame: number;
    inTc: string;
    outTc: string;
    /** Its length on this sequence's timeline. */
    sequenceFrames: number;
    provisional: true;
    basis: string;
  };
  /** Timeline items already using part of this source window. */
  usedBy: Array<{ itemId: string; track: string; overlapFrames: number }>;
  /** Other candidates whose windows overlap this one (same media). */
  overlaps: string[];
  flags: CandidateFlag[];
}

export type ExclusionCode =
  | "missing-media"
  | "not-analyzed"
  | "not-b-roll"
  | "uncertain-role"
  | "unknown-frame-rate"
  | "unknown-duration"
  | "unusable-kind"
  | "bad-confidence"
  | "bad-timestamp"
  | "outside-media"
  | "too-short"
  | "duplicate-evidence"
  | "duplicate-window";

export interface ExcludedEvidence {
  evidenceId: string;
  mediaClipId: string;
  code: ExclusionCode;
  message: string;
}

export interface BrollInventory {
  revision: string;
  roles: MediaRoleInfo[];
  candidates: BrollCandidate[];
  excluded: ExcludedEvidence[];
}

type InventoryClip = RoleClip & Partial<Pick<Clip, "fps" | "durationSeconds" | "state">>;

export interface InventoryAnalysis {
  clips: readonly InventoryClip[];
  visualEvidence: readonly VisualEvidence[];
  overrides?: MediaRoleOverrides | undefined;
}

/**
 * Candidate B-roll windows from logged visual evidence. Nothing is guessed:
 * media without a known frame rate or length, timestamps outside the media,
 * non-B-roll or uncertain files and windows too short to cover a cut are
 * excluded — each with its reason.
 */
export function brollInventory(seq: Sequence, analysis: InventoryAnalysis): BrollInventory {
  const roles = mediaRoles(analysis.clips, analysis.visualEvidence, analysis.overrides, seq);
  const clips = new Map(analysis.clips.map((c) => [c.id, c]));
  const minFrames = 2 * halfSecondFrames(seq.rate); // must reach half a second each side of a cut
  const excluded: ExcludedEvidence[] = [];
  const candidates: BrollCandidate[] = [];
  const seen = new Set<string>();
  const windows = new Map<string, string>(); // "media|in|out" → candidate id
  const exclude = (e: VisualEvidence, code: ExclusionCode, message: string) =>
    excluded.push({ evidenceId: e.id, mediaClipId: e.clipId, code, message });

  for (const e of analysis.visualEvidence) {
    if (seen.has(e.id)) {
      exclude(e, "duplicate-evidence", "This evidence id appears more than once.");
      continue;
    }
    seen.add(e.id);
    const c = clips.get(e.clipId);
    if (!c) {
      exclude(e, "missing-media", "The evidence refers to media that isn't in this project.");
      continue;
    }
    const role = roles.get(c.id)!;
    if (role.role === "interview") {
      exclude(e, "not-b-roll", `${role.file} is an interview (${role.reasons.join("; ")}).`);
      continue;
    }
    if (role.role === "uncertain") {
      exclude(
        e,
        "uncertain-role",
        `${role.file}'s role isn't certain (${role.reasons.join("; ")}).`,
      );
      continue;
    }
    if (c.state !== undefined && c.state !== "analyzed") {
      exclude(e, "not-analyzed", `${role.file} hasn't been analyzed.`);
      continue;
    }
    if (!(typeof c.fps === "number" && Number.isFinite(c.fps) && c.fps > 0)) {
      exclude(e, "unknown-frame-rate", `${role.file}'s frame rate isn't known.`);
      continue;
    }
    if (!(
      typeof c.durationSeconds === "number" &&
      Number.isFinite(c.durationSeconds) &&
      c.durationSeconds > 0
    )) {
      exclude(e, "unknown-duration", `${role.file}'s length isn't known.`);
      continue;
    }
    if (!CUTAWAY_KINDS.has(e.kind)) {
      exclude(e, "unusable-kind", `A "${e.kind}" moment isn't offered as a cutaway.`);
      continue;
    }
    if (!(Number.isFinite(e.confidence) && e.confidence >= 0 && e.confidence <= 1)) {
      exclude(e, "bad-confidence", "The evidence confidence is missing or out of range.");
      continue;
    }
    const rate = rateFromFps(c.fps);
    const end = mediaEndFrame(
      { mediaClipId: c.id, mediaRate: rate } as ClipItem,
      new Map([[c.id, { durationSeconds: c.durationSeconds }]]),
    )!;
    const at = tcToFrame(e.atTc, rate);
    if (at === null) {
      exclude(e, "bad-timestamp", `The timestamp "${e.atTc}" can't be read.`);
      continue;
    }
    if (at < 0 || at >= end) {
      exclude(e, "outside-media", `${e.atTc} is outside ${role.file} (it ends at frame ${end}).`);
      continue;
    }
    const wantIn = at - secondsToFrames(WINDOW_LEAD_S, rate);
    const wantOut = at + secondsToFrames(WINDOW_TAIL_S, rate);
    const sourceIn = Math.max(0, wantIn);
    const sourceOut = Math.min(end, wantOut);
    const sequenceFrames = sequenceDurationFrames(sourceIn, sourceOut, rate, seq.rate);
    if (sourceOut <= sourceIn || sequenceFrames < minFrames) {
      exclude(
        e,
        "too-short",
        `Only ${sequenceFrames} frames are available around ${e.atTc} (at least ${minFrames} needed).`,
      );
      continue;
    }
    const key = `${c.id}|${sourceIn}|${sourceOut}`;
    if (windows.has(key)) {
      exclude(e, "duplicate-window", `Same source window as ${windows.get(key)}.`);
      continue;
    }
    const id = `cand:${e.id}`;
    windows.set(key, id);
    const usedBy = Object.values(seq.items)
      .filter(
        (i) =>
          i.mediaClipId === c.id &&
          intersects(i.sourceInFrame, i.sourceOutFrame, sourceIn, sourceOut),
      )
      .map((i) => ({
        itemId: i.id,
        track: seq.tracks.find((t) => t.id === i.trackId)?.name ?? "?",
        overlapFrames: Math.min(i.sourceOutFrame, sourceOut) - Math.max(i.sourceInFrame, sourceIn),
      }));
    const flags: CandidateFlag[] = [];
    if (usedBy.length) flags.push("used-in-cut");
    if (wantIn < 0) flags.push("clamped-at-media-start");
    if (wantOut > end) flags.push("clamped-at-media-end");
    candidates.push({
      id,
      mediaClipId: c.id,
      file: role.file,
      mediaRate: rate,
      mediaFps: c.fps,
      durationSeconds: c.durationSeconds,
      mediaEndFrame: end,
      role,
      evidence: {
        id: e.id,
        kind: e.kind,
        label: e.label,
        atTc: e.atTc,
        atFrame: at,
        confidence: e.confidence,
      },
      window: {
        sourceInFrame: sourceIn,
        sourceOutFrame: sourceOut,
        inTc: frameToTc(sourceIn, rate),
        outTc: frameToTc(sourceOut, rate),
        sequenceFrames,
        provisional: true,
        basis: `${WINDOW_LEAD_S} s before to ${WINDOW_TAIL_S} s after one sampled frame at ${e.atTc} — not a verified shot`,
      },
      usedBy,
      overlaps: [],
      flags,
    });
  }
  // Overlapping windows on the same media: likely the same moment twice.
  for (const a of candidates)
    for (const b of candidates)
      if (
        a !== b &&
        a.mediaClipId === b.mediaClipId &&
        intersects(
          a.window.sourceInFrame,
          a.window.sourceOutFrame,
          b.window.sourceInFrame,
          b.window.sourceOutFrame,
        )
      )
        a.overlaps.push(b.id);
  for (const a of candidates) if (a.overlaps.length) a.flags.push("overlaps-another-candidate");
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { revision: sequenceRevision(seq), roles: [...roles.values()], candidates, excluded };
}
