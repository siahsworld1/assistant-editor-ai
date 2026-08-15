// CMX3600 EDL export — a real, working exporter, not a native-format simulator.
//
// Why CMX3600 and not three "native" exporters (Premiere Project XML, FCPXML,
// Resolve AAF): those are three genuinely different, non-trivial file formats.
// Building all three without being able to test any of them against the real
// applications would mean shipping three unverified "looks done" exporters —
// exactly the kind of fake-but-labeled-finished feature this project's rules
// rule out. CMX3600 EDL is a single, simple, well-specified text format that
// Premiere Pro, DaVinci Resolve, and Final Cut Pro (7 and X, via import) all
// genuinely import natively. It's a real, if blunt, instrument: one video track
// worth of cuts plus audio, sourced from real reel names and real timecodes.
// A richer multi-track interchange format (XMEML/FCPXML) is the natural next
// step once this path is verified against real NLEs — see WORKER/README "Known
// limitations".

import type { Clip, UniversalTimeline } from "../ae/types";
// Explicit ".ts" extension (allowImportingTsExtensions is on in tsconfig.json,
// and Vite/Vitest resolve it fine either way): this is a real runtime import,
// and scripts/export-timeline.ts runs these exporters directly under Node's
// --experimental-strip-types with no bundler in front of it, which — unlike
// Vite — never resolves extensionless relative specifiers.
import { TC_RE, secondsToTc } from "./timecode.ts";

export interface TimelineValidationResult {
  ok: boolean;
  errors: string[];
  /** Decisions that passed validation, in record order. */
  usable: UniversalTimeline["decisions"];
}

/**
 * Frontend-side validation gate, independent of (and in addition to) the
 * worker's own validation in worker/pipeline.py::_validate_decisions. Runs
 * against whatever timeline is actually about to be exported — including a
 * Demo Mode timeline — so the export button can never fire on data that
 * doesn't check out.
 */
export function validateTimelineForExport(
  timeline: UniversalTimeline,
  clips: Clip[],
): TimelineValidationResult {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const errors: string[] = [];
  const usable: UniversalTimeline["decisions"] = [];

  if (timeline.decisions.length === 0) {
    return { ok: false, errors: ["Timeline has no edit decisions yet — build a sequence first."], usable };
  }

  for (const d of timeline.decisions) {
    const clip = byId.get(d.clipId);
    if (!clip) {
      errors.push(`"${d.label}" references clip ${d.clipId}, which isn't in this project.`);
      continue;
    }
    if (!TC_RE.test(d.sourceInTc) || !TC_RE.test(d.sourceOutTc)) {
      errors.push(`"${d.label}" has a malformed source timecode (${d.sourceInTc} → ${d.sourceOutTc}).`);
      continue;
    }
    if (d.durationSeconds <= 0) {
      errors.push(`"${d.label}" has zero or negative duration.`);
      continue;
    }
    usable.push(d);
  }

  return { ok: usable.length > 0, errors, usable };
}

/** CMX3600 reel names are conventionally short, uppercase, alnum-only. */
function reelName(clip: Clip | undefined, fallback: string): string {
  const base = (clip?.filename ?? fallback).replace(/\.[^./\\]+$/, "");
  const cleaned = base.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (cleaned || "CLIP").slice(0, 8);
}

/**
 * Builds a CMX3600 EDL string from an already-validated set of decisions.
 * Callers should pass `validateTimelineForExport(...).usable`, not
 * `timeline.decisions` directly.
 */
export function buildCmx3600Edl(
  timeline: UniversalTimeline,
  usableDecisions: UniversalTimeline["decisions"],
  clips: Clip[],
): string {
  const fps = Math.round(timeline.fps) || 24;
  const byId = new Map(clips.map((c) => [c.id, c]));
  const ordered = [...usableDecisions].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds);

  const lines: string[] = [
    `TITLE: ${timeline.name.replace(/[\r\n]/g, " ").slice(0, 70)}`,
    `FCM: NON-DROP FRAME`,
    "",
  ];

  ordered.forEach((d, i) => {
    const clip = byId.get(d.clipId);
    const track = d.lane === "audio" ? "A" : "V";
    const reel = reelName(clip, d.clipId).padEnd(8, " ");
    const recIn = secondsToTc(d.timelineStartSeconds, fps);
    const recOut = secondsToTc(d.timelineStartSeconds + d.durationSeconds, fps);
    const num = String(i + 1).padStart(3, "0");
    lines.push(`${num}  ${reel} ${track}     C        ${d.sourceInTc} ${d.sourceOutTc} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${clip?.filename ?? d.clipId}`);
    if (d.label) lines.push(`* ${d.label.replace(/[\r\n]/g, " ").slice(0, 100)}`);
    lines.push("");
  });

  return lines.join("\n");
}

export function edlFilename(timeline: UniversalTimeline): string {
  const slug = timeline.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${slug || "assistant-editor-sequence"}.edl`;
}
