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
// de-duplicated form is what a hand-built Premiere project would produce.
//
// Verified against a real Premiere Pro XML import (first real end-to-end test,
// real H.265 footage): Premiere's Events window reported six "Matrix cannot be
// inverted" errors on import (3 video events × 2 — once for the sequence
// format, once per clip's file media), and the imported sequence had video on
// V1 with no corresponding audio on A1. Both are fixed below — see
// frameDimensions()/videoFormatSamplecharacteristics() for the matrix bug, and
// the interview-audio-linking block in buildXmeml() for the missing A1 audio.

import type { Clip, EditDecisionLane, UniversalTimeline } from "../ae/types";
// Explicit ".ts" extensions — see the comment on the equivalent import in
// edl.ts: these are real runtime imports and scripts/export-timeline.ts runs
// this file directly under Node with no bundler in front of it.
import { fileUrlForClip, sanitizeXmlId, xmlEscape, type XmlExportResult } from "./xml-utils.ts";
import { framesForSeconds, tcToSeconds } from "./timecode.ts";

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

// Premiere's XML importer builds a frame-to-sequence affine transform for
// every clip (and for the sequence format itself) from real pixel width and
// height. Per Apple's own XMEML reference (Final Cut Pro XML Interchange
// Format, "Basics of Encoding" — Listing 3-5 and 3-11), <width>/<height> are
// required fields of every video <samplecharacteristics> block, both at the
// sequence <format> level and inside each clip's <file><media><video> block.
// This exporter never emitted either — the resulting geometry was undefined,
// so Premiere's transform matrix was singular and it reported "Matrix cannot
// be inverted" once per computation. Falls back to a standard 1080p frame
// when a clip's resolution string can't be parsed into real pixel dimensions
// (e.g. a label like "4K" instead of literal "3840x2160", or an audio-only
// clip with no resolution at all) — any real, non-zero, non-degenerate
// geometry keeps the matrix invertible, so the exact fallback number only
// matters for clips too broken to carry real dimensions in the first place.
const FALLBACK_FRAME_WIDTH = 1920;
const FALLBACK_FRAME_HEIGHT = 1080;

function frameDimensions(clip: Clip | undefined): { width: number; height: number } {
  const match = clip?.resolution?.match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: FALLBACK_FRAME_WIDTH, height: FALLBACK_FRAME_HEIGHT };
}

function videoSamplecharacteristics(width: number, height: number, fps: number, indent: string): string {
  return [
    `${indent}<samplecharacteristics>`,
    `${indent}  <width>${width}</width>`,
    `${indent}  <height>${height}</height>`,
    `${indent}  <anamorphic>FALSE</anamorphic>`,
    `${indent}  <pixelaspectratio>square</pixelaspectratio>`,
    `${indent}  <fielddominance>none</fielddominance>`,
    rateBlock(fps, `${indent}  `),
    `${indent}</samplecharacteristics>`,
  ].join("\n");
}

// Camera-original production audio is near-universally 48kHz/16-bit; the
// app's Clip type doesn't currently carry a real measured sample rate/bit
// depth (worker/media.py::ffprobe_info only records whether an audio stream
// exists at all), so these are safe, standard defaults rather than measured
// values — call out clearly as such, not presented as a real measurement.
const AUDIO_SAMPLE_DEPTH_BITS = 16;
const AUDIO_SAMPLE_RATE_HZ = 48000;

function audioSamplecharacteristics(indent: string): string {
  return [
    `${indent}<samplecharacteristics>`,
    `${indent}  <depth>${AUDIO_SAMPLE_DEPTH_BITS}</depth>`,
    `${indent}  <samplerate>${AUDIO_SAMPLE_RATE_HZ}</samplerate>`,
    `${indent}</samplecharacteristics>`,
  ].join("\n");
}

/** A clipitem's <link> pairing to its synced counterpart on another track —
 * DTD: <!ELEMENT link (mediatype | trackindex | clipindex | groupindex |
 * linkclipref)*>. Both the video and the audio clipitem of a synced pair each
 * carry two <link> blocks: one referencing themselves, one referencing their
 * partner — this is what makes an NLE move/trim/delete them together instead
 * of treating the video and its own production audio as unrelated events. */
interface LinkPartner {
  selfId: string;
  selfMediaType: "video" | "audio";
  selfTrackIndex: number;
  partnerId: string;
  partnerMediaType: "video" | "audio";
  partnerTrackIndex: number;
  clipIndex: number;
  groupIndex: number;
}

function linkBlockXml(link: LinkPartner, indent: string): string {
  const one = (linkclipref: string, mediatype: string, trackindex: number) =>
    [
      `${indent}<link>`,
      `${indent}  <linkclipref>${linkclipref}</linkclipref>`,
      `${indent}  <mediatype>${mediatype}</mediatype>`,
      `${indent}  <trackindex>${trackindex}</trackindex>`,
      `${indent}  <clipindex>${link.clipIndex}</clipindex>`,
      `${indent}  <groupindex>${link.groupIndex}</groupindex>`,
      `${indent}</link>`,
    ].join("\n");
  return [
    one(link.selfId, link.selfMediaType, link.selfTrackIndex),
    one(link.partnerId, link.partnerMediaType, link.partnerTrackIndex),
  ].join("\n");
}

function clipItemXml(
  range: FrameRange,
  index: number,
  trackPrefix: string,
  fps: number,
  mediaRoot: string,
  mediaType: "video" | "audio",
  warnings: string[],
  link?: LinkPartner,
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
      ? (() => {
          const { width, height } = frameDimensions(clip);
          return `        <media>\n          <video>\n${videoSamplecharacteristics(width, height, fps, "            ")}\n          </video>\n        </media>`;
        })()
      : `        <media>\n          <audio>\n${audioSamplecharacteristics("            ")}\n          </audio>\n        </media>`;

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
    ...(link ? [linkBlockXml(link, "        ")] : []),
    `      </clipitem>`,
  ].join("\n");
}

/**
 * Builds an XMEML sequence with real parallel tracks: V1 = interview,
 * V2 = b-roll, A1 = the interview lane's own synced production audio (linked
 * back to V1 — see LinkPartner above), A2 = audio-lane decisions (if the
 * timeline has any as discrete events — the app's usual "ambient bed" audio
 * lane is a UI-only construct, not a decision, and isn't exported here).
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
  const standaloneAudio = toFrameRanges(byLane("audio"), clips, fps, warnings);

  const totalFrames = Math.max(
    framesForSeconds(timeline.totalSeconds, fps),
    ...[...interview, ...broll, ...standaloneAudio].map((r) => r.startFrame + (r.outFrame - r.inFrame)),
    0,
  );

  // Sequence-level frame geometry: the first clip with a real, parseable
  // resolution (interview or b-roll), else the same safe fallback
  // frameDimensions() uses per-clip.
  const sequenceClip = [...interview, ...broll].map((r) => r.clip).find((c) => c?.resolution);
  const { width: seqWidth, height: seqHeight } = frameDimensions(sequenceClip);

  const interviewLink = (i: number): LinkPartner => ({
    selfId: sanitizeXmlId(`v1-${interview[i].decision.id}`, `v1-clip-${i + 1}`),
    selfMediaType: "video",
    selfTrackIndex: 1,
    partnerId: sanitizeXmlId(`a1-${interview[i].decision.id}`, `a1-clip-${i + 1}`),
    partnerMediaType: "audio",
    partnerTrackIndex: 1,
    clipIndex: i + 1,
    groupIndex: i + 1,
  });
  const interviewAudioLink = (i: number): LinkPartner => ({
    selfId: sanitizeXmlId(`a1-${interview[i].decision.id}`, `a1-clip-${i + 1}`),
    selfMediaType: "audio",
    selfTrackIndex: 1,
    partnerId: sanitizeXmlId(`v1-${interview[i].decision.id}`, `v1-clip-${i + 1}`),
    partnerMediaType: "video",
    partnerTrackIndex: 1,
    clipIndex: i + 1,
    groupIndex: i + 1,
  });

  const videoTracks = [
    interview.length > 0
      ? `    <track>\n${interview
          .map((r, i) => clipItemXml(r, i, "v1", fps, mediaRoot, "video", warnings, interviewLink(i)))
          .join("\n")}\n    </track>`
      : null,
    broll.length > 0
      ? `    <track>\n${broll.map((r, i) => clipItemXml(r, i, "v2", fps, mediaRoot, "video", warnings)).join("\n")}\n    </track>`
      : null,
  ].filter((t): t is string => t !== null);

  // A1 carries the interview lane's own synced production audio — the same
  // dialogue that made it into the transcript — linked back to its V1 video
  // via <link>, so an NLE moves/trims them together instead of the video
  // arriving on V1 with silence where dialogue should be (the exact bug this
  // fixes: real interview picture reached Premiere with no matching audio on
  // A1). A2, built separately below, is the app's own "audio" decision lane
  // (e.g. a narration insert with no video component of its own) — kept on
  // its own track since it's a different kind of audio event, not a synced
  // partner of anything on V1/V2.
  const audioTracks: string[] = [];
  if (interview.length > 0) {
    audioTracks.push(
      `    <track>\n${interview
        .map((r, i) => clipItemXml(r, i, "a1", fps, mediaRoot, "audio", warnings, interviewAudioLink(i)))
        .join("\n")}\n    </track>`,
    );
  }
  if (standaloneAudio.length > 0) {
    audioTracks.push(
      `    <track>\n${standaloneAudio
        .map((r, i) => clipItemXml(r, i, "a2", fps, mediaRoot, "audio", warnings))
        .join("\n")}\n    </track>`,
    );
  }

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
    videoSamplecharacteristics(seqWidth, seqHeight, fps, "          "),
    `        </format>`,
    ...videoTracks,
    `      </video>`,
    ...(audioTracks.length > 0
      ? [
          `      <audio>`,
          `        <format>`,
          audioSamplecharacteristics("          "),
          `        </format>`,
          ...audioTracks,
          `      </audio>`,
        ]
      : []),
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
