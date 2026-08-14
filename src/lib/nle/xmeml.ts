// Premiere Pro / Final Cut Pro 7 "XML" export — XMEML, the sequence interchange
// format both applications actually call "Export > XML" / "Export > Final Cut
// Pro XML" respectively (they're the same DTD; FCP7 and Premiere have shared
// this format for years). DaVinci Resolve also imports it via File > Import >
// AAF/XML. This is a genuinely different, richer format than the CMX3600 EDL
// already shipped in edl.ts: XMEML supports real parallel tracks, so unlike the
// EDL exporter (which flattens everything onto one V track), b-roll actually
// lands on its own V2 track here — the way an editor opening this in Premiere
// would expect a rough assembly to look.
//
// Scope/honesty note: multiple clip references to the same source file each get
// their own <file> block (same id, repeated) rather than a single de-duplicated
// definition referenced by id — both are valid per the XMEML DTD, but the
// de-duplicated form is what a hand-built Premiere project would produce. This
// was not verified against a real Premiere import in this session (no Premiere
// available) — see the validation checklist for the real-import step you should
// run once footage is available.

import type { Clip, EditDecisionLane, UniversalTimeline } from "../ae/types";
import { fileUrlForClip, sanitizeXmlId, xmlEscape, type XmlExportResult } from "./xml-utils";
import { framesForSeconds, tcToSeconds } from "./timecode";

export type { XmlExportResult };

interface FrameRange {
  decision: UniversalTimeline["decisions"][number];
  clip: Clip | undefined;
  inFrame: number;
  outFrame: number;
  startFrame: number;
}

function toFrameRanges(
  decisions: UniversalTimeline["decisions"],
  clips: Clip[],
  fps: number,
  warnings: string[],
): FrameRange[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  return [...decisions]
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
    .map((d) => {
      const clip = byId.get(d.clipId);
      const inSeconds = tcToSeconds(d.sourceInTc, fps);
      const outSeconds = tcToSeconds(d.sourceOutTc, fps);
      let inFrame = inSeconds !== null ? framesForSeconds(inSeconds, fps) : 0;
      let outFrame = outSeconds !== null ? framesForSeconds(outSeconds, fps) : inFrame + framesForSeconds(d.durationSeconds, fps);
      if (outFrame <= inFrame) {
        warnings.push(`"${d.label}" had a non-positive source duration after frame rounding — padded to 1 frame.`);
        outFrame = inFrame + 1;
      }
      const startFrame = framesForSeconds(d.timelineStartSeconds, fps);
      return { decision: d, clip, inFrame, outFrame, startFrame };
    });
}

function rateBlock(fps: number, indent: string): string {
  const whole = Math.round(fps);
  const isNtsc = Math.abs(fps - whole) > 0.001; // e.g. 23.976 vs 24
  return `${indent}<rate>\n${indent}  <timebase>${whole}</timebase>\n${indent}  <ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc>\n${indent}</rate>`;
}

function clipItemXml(
  range: FrameRange,
  index: number,
  trackPrefix: string,
  fps: number,
  mediaRoot: string,
  mediaType: "video" | "audio",
  warnings: string[],
): string {
  const { decision, clip, inFrame, outFrame, startFrame } = range;
  const duration = outFrame - inFrame;
  const itemId = sanitizeXmlId(`${trackPrefix}-${decision.id}`, `${trackPrefix}-clip-${index + 1}`);
  const fileId = sanitizeXmlId(`file-${decision.clipId}`, `file-${index + 1}`);
  const name = xmlEscape(clip?.filename ?? decision.label ?? decision.clipId);
  const { url, resolved } = fileUrlForClip(clip, mediaRoot);
  if (!resolved) {
    warnings.push(`Could not resolve an absolute path for "${name}" — you'll need to relink media after import.`);
  }
  const sourceDurationFrames = clip?.durationSeconds
    ? framesForSeconds(clip.durationSeconds, fps)
    : outFrame + 1;
  const mediaBlock =
    mediaType === "video"
      ? `        <media>\n          <video>\n            <samplecharacteristics>\n${rateBlock(fps, "              ")}\n            </samplecharacteristics>\n          </video>\n        </media>`
      : `        <media>\n          <audio>\n            <samplecharacteristics>\n${rateBlock(fps, "              ")}\n            </samplecharacteristics>\n          </audio>\n        </media>`;

  return [
    `      <clipitem id="${itemId}">`,
    `        <name>${name}</name>`,
    `        <duration>${duration}</duration>`,
    rateBlock(fps, "        "),
    `        <start>${startFrame}</start>`,
    `        <end>${startFrame + duration}</end>`,
    `        <in>${inFrame}</in>`,
    `        <out>${outFrame}</out>`,
    `        <file id="${fileId}">`,
    `          <name>${name}</name>`,
    `          <pathurl>${xmlEscape(url)}</pathurl>`,
    rateBlock(fps, "          "),
    `          <duration>${sourceDurationFrames}</duration>`,
    mediaBlock,
    `        </file>`,
    `      </clipitem>`,
  ].join("\n");
}

/**
 * Builds an XMEML sequence with real parallel tracks: V1 = interview, V2 =
 * b-roll, A1 = audio-lane decisions (if the timeline has any as discrete
 * events — the app's usual "ambient bed" audio lane is a UI-only construct,
 * not a decision, and isn't exported here).
 */
export function buildXmeml(
  timeline: UniversalTimeline,
  usableDecisions: UniversalTimeline["decisions"],
  clips: Clip[],
  mediaRoot: string,
): XmlExportResult {
  const fps = timeline.fps || 24;
  const warnings: string[] = [];
  const byLane = (lane: EditDecisionLane) => usableDecisions.filter((d) => d.lane === lane);

  const interview = toFrameRanges(byLane("interview"), clips, fps, warnings);
  const broll = toFrameRanges(byLane("b-roll"), clips, fps, warnings);
  const audio = toFrameRanges(byLane("audio"), clips, fps, warnings);

  const totalFrames = Math.max(
    framesForSeconds(timeline.totalSeconds, fps),
    ...[...interview, ...broll, ...audio].map((r) => r.startFrame + (r.outFrame - r.inFrame)),
    0,
  );

  const videoTracks = [
    interview.length > 0
      ? `    <track>\n${interview.map((r, i) => clipItemXml(r, i, "v1", fps, mediaRoot, "video", warnings)).join("\n")}\n    </track>`
      : null,
    broll.length > 0
      ? `    <track>\n${broll.map((r, i) => clipItemXml(r, i, "v2", fps, mediaRoot, "video", warnings)).join("\n")}\n    </track>`
      : null,
  ].filter((t): t is string => t !== null);

  const audioTracks =
    audio.length > 0
      ? [`    <track>\n${audio.map((r, i) => clipItemXml(r, i, "a1", fps, mediaRoot, "audio", warnings)).join("\n")}\n    </track>`]
      : [];

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    `  <sequence>`,
    `    <name>${xmlEscape(timeline.name)}</name>`,
    `    <duration>${totalFrames}</duration>`,
    rateBlock(fps, "    "),
    `    <media>`,
    `      <video>`,
    `        <format>`,
    `          <samplecharacteristics>`,
    rateBlock(fps, "            "),
    `          </samplecharacteristics>`,
    `        </format>`,
    ...videoTracks,
    `      </video>`,
    ...(audioTracks.length > 0 ? [`      <audio>`, ...audioTracks, `      </audio>`] : []),
    `    </media>`,
    `  </sequence>`,
    `</xmeml>`,
    "",
  ].join("\n");

  return { xml, warnings };
}

export function xmemlFilename(timeline: UniversalTimeline): string {
  const slug = timeline.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${slug || "assistant-editor-sequence"}.xml`;
}
