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
// Every distinct source file gets exactly ONE real <file id="..."> definition
// in the whole document — the first clipitem that references it — and every
// later clipitem referencing that same file (a repeated selection from the
// same interview clip, or that clip's own linked audio on A1) gets a bare,
// self-closing <file id="..."/> reference instead. This isn't just a size
// optimization: a real Premiere Pro XML import test failed outright ("File
// Import Failure", no further detail) the first time this exporter emitted
// the SAME file id more than once with CONFLICTING content — a video-only
// <media> block from one clipitem, an audio-only one from another. Premiere's
// importer treats <file id="..."> as a real cross-reference key; redefining
// it with contradictory content breaks the import. See the definedFileIds
// Set and fileBlockXml() in buildXmeml() below.
//
// Verified against two real Premiere Pro XML import tests (first real
// end-to-end runs, real H.265 footage): (1) Premiere's Events window reported
// six "Matrix cannot be inverted" errors on import (3 video events × 2 — once
// for the sequence format, once per clip's file media), and the imported
// sequence had video on V1 with no corresponding audio on A1 — fixed via
// frameDimensions()/videoSamplecharacteristics() and the interview-audio-
// linking block in buildXmeml(). (2) After that fix, a full "File Import
// Failure" on the very next real test — fixed via the file-id dedup described
// above, once real per-clip repeat usage (the same interview clip selected
// more than once) combined with the new linked-audio clipitems to produce
// conflicting same-id definitions that the first fix's test fixture (every
// clip used only once) never happened to exercise. (3) After THAT fix, a
// third real test: clean import, correct V1/A1/dedup, but Events window still
// reported exactly ONE "Matrix cannot be inverted" (down from six) — with
// width/height/anamorphic/pixelaspectratio/fielddominance/rate all present
// and byte-identical between the sequence-level format block and every
// per-file block, ruling out a mismatch. Fixed via <colordepth> (see
// VIDEO_COLOR_DEPTH_BITS/videoSamplecharacteristics() below) — the one field
// Apple's own canonical sequence-format example includes that this exporter
// never emitted anywhere — plus a real `id` attribute on <sequence> (real
// Premiere exports always have one; the DTD's #IMPLIED just means Premiere's
// own *exporter* isn't required to include it, not that its *importer* is
// happy without it). (4) That fix (colordepth added to EVERY video
// samplecharacteristics block, sequence and per-file alike) imported cleanly
// but Events reported exactly TWO new "Matrix cannot be inverted" — matching
// this timeline's exactly two distinct <file id> definitions. Adding
// colordepth to the per-file blocks (which sit directly under <video>, with
// no <format> wrapper — unlike the sequence block, which does) is what
// regressed; the sequence-level addition alone still accounts for the
// original single error going away. <colordepth> is now scoped to the
// once-per-sequence, <format>-wrapped block only — see the real-test-#3/#4
// comment on videoSamplecharacteristics() below for the full evidence.
// (5) Inspecting a real test5 export byte-for-byte: the sequence was
// correctly 24fps/NTSC-FALSE, but both real source clips were actually
// 23.976fps and their <file><rate> blocks were STILL emitted as 24fps/
// NTSC-FALSE — a rate-model bug, not a geometry one. Root cause: a single
// `fps` (the timeline's) was threaded into both the timeline-position math
// AND the source-frame math, so fileBlockXml() always described the file in
// the sequence's rate instead of the clip's own. Fixed by giving every
// per-decision FrameRange its own `clipFps` (clip.fps, falling back to the
// timeline's) and using it for everything that describes the SOURCE media —
// <in>/<out>, the file's own <rate>/<duration> — while <start>/<end>/the
// clipitem's own <rate>/<duration> and the sequence's own <duration> stay in
// the timeline's rate throughout. See the real-test-#5 comment on
// toFrameRanges() below for the full Apple-docs citation.
// (6) With the Matrix errors fully gone: V1 imports and plays, A1 clipitems
// appear on the timeline with correct timing/links, but there's no
// usable/playable audio, despite the real source clips having real embedded
// audio. Root cause: no clipitem this exporter builds ever carried a
// <sourcetrack> — the element that tells Premiere which of a referenced
// <file>'s media kinds (here, always both <video> and <audio>, since an
// interview clip is referenced by both its V1 and A1 clipitem) a given
// clipitem actually draws from. Fixed via sourceTrackXml()/clipItemXml()
// below — see the real-test-#6 comment on sourceTrackXml() for the DTD
// citation and the real Premiere-XML precedent this was checked against.
// (7) With <sourcetrack> in place, A1 played "static/hiss": the real source
// (18C_0681.MP4, AAC stereo) has its dialogue only on channel 2, and the
// single A1 clipitem's <trackindex>1 told Premiere to play channel 1 only.
// Fixed by reproducing the source's real channel layout the way Premiere's
// own export does (exploded stereo track pair, one clipitem per channel,
// <channelcount>, sequence <outputs>) — see the real-test-#7 comment above
// LinkRef below.

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
  /** Source-media frame position — in the CLIP's own native rate (clipFps
   * below), never the sequence's. See the real-test-#5 comment below. */
  inFrame: number;
  outFrame: number;
  /** Timeline position — in the SEQUENCE's rate. */
  startFrame: number;
  /** The sequence-frame span this decision occupies on the timeline — NOT
   * outFrame - inFrame once clip and sequence rates differ (see below). Used
   * for the clipitem's own <duration> and <end>. */
  timelineDurationFrames: number;
  /** The fps actually used for inFrame/outFrame — clip.fps, falling back to
   * the sequence fps and then 24 only when a clip has no measured rate. */
  clipFps: number;
}

// Real Premiere test #5 (on top of acaab01): the remaining single "Matrix
// cannot be inverted" traced to a rate-model bug, not geometry. Real source
// clips shot at 23.976fps were cut into a 24fps sequence, but every
// <file><rate> (and the nested <media><video><samplecharacteristics><rate>)
// was emitted at the SEQUENCE's 24fps/NTSC-FALSE instead of the clip's real
// 23.976fps/NTSC-TRUE — because a single `fps` (the timeline's) was being
// threaded into both the timeline-position math AND the source-frame math.
//
// Per Apple's own XMEML reference ("XMEML Topics" > "Timing Values"): <in>
// and <out> "specify the media content associated with a clip or clipitem"
// and convert to timecode "using the starting timecode in the media" — i.e.
// the file's own native rate — while <start> and <end> "encode the ... start
// and end of a clipitem in an enclosing sequence" and convert "using the
// timecode in the containing sequence" — the sequence's rate. The same
// section explicitly notes a clipitem's <duration> "may not match the
// duration value of the corresponding media, even when ... perfectly
// aligned" once framerate is involved — exactly this scenario. This app's own
// backend already treats sourceInTc/sourceOutTc as clip-native:
// worker/pipeline.py::_validate_decisions computes `fps = clip.fps or 24.0`
// before parsing them — confirming the timecodes were always meant to be
// interpreted at the clip's real measured rate, not the timeline's.
//
// So: <in>/<out> (and the file's own <rate>/<duration>) now use the clip's
// real fps; <start>/<end>/the sequence's own <duration>, and the clipitem's
// own <rate>, stay in the sequence's fps, unchanged.
function toFrameRanges(
  decisions: UniversalTimeline["decisions"],
  clips: Clip[],
  timelineFps: number,
  warnings: string[],
): FrameRange[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  return [...decisions]
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
    .map((d) => {
      const clip = byId.get(d.clipId);
      const clipFps = clip?.fps || timelineFps || 24;
      const inSeconds = tcToSeconds(d.sourceInTc, clipFps);
      const outSeconds = tcToSeconds(d.sourceOutTc, clipFps);
      let inFrame = inSeconds !== null ? framesForSeconds(inSeconds, clipFps) : 0;
      let outFrame =
        outSeconds !== null ? framesForSeconds(outSeconds, clipFps) : inFrame + framesForSeconds(d.durationSeconds, clipFps);
      if (outFrame <= inFrame) {
        warnings.push(`"${d.label}" had a non-positive source duration after frame rounding — padded to 1 frame.`);
        outFrame = inFrame + 1;
      }
      const startFrame = framesForSeconds(d.timelineStartSeconds, timelineFps);
      const timelineDurationFrames = Math.max(1, framesForSeconds(d.durationSeconds, timelineFps));
      return { decision: d, clip, inFrame, outFrame, startFrame, timelineDurationFrames, clipFps };
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

// Real Premiere test #3 (after 2d7ef23): import succeeded — sequence created,
// V1/A1 events and dedup all correct — but Premiere's Events window still
// reported exactly ONE "Matrix cannot be inverted", down from six. The real
// exported XML (inspected byte-for-byte, not regenerated) showed width/height/
// anamorphic/pixelaspectratio/fielddominance/rate all present and IDENTICAL
// between the sequence-level <video><format><samplecharacteristics> block and
// both per-file <file><media><video><samplecharacteristics> blocks — ruling
// out a value mismatch. Per Apple's own XMEML reference (DTD: samplecharacteristics
// allows width|height|anamorphic|pixelaspectratio|fielddominance|colordepth|
// codec|depth|samplerate|rate, all optional/unordered), the FULL canonical
// example of a sequence-format samplecharacteristics block (Final Cut Pro XML
// Interchange Format, "Basics of Encoding") includes <colordepth> — which this
// exporter had never emitted anywhere.
//
// Real Premiere test #4 (commit 2b84d1f, which added <colordepth> to EVERY
// video samplecharacteristics block, sequence and per-file alike, plus a real
// `id` attribute on <sequence>): the real exported XML (test4.xml, inspected
// byte-for-byte) now imports cleanly, V1/A1 still correct — but the Events
// window reported exactly TWO new "Matrix cannot be inverted" errors, not
// zero. This timeline has exactly two distinct <file id="..."> definitions
// (file-clip-002, file-clip-001 — the same file-id dedup from 2d7ef23, so
// each real source file still gets exactly one full <file> definition). Two
// unique files, two new errors: the count lines up exactly with "one per
// per-file video samplecharacteristics block", not with the sequence (there's
// only one of those) or anything else in the document. The math also fits the
// PREVIOUS test cleanly — 1 sequence-level error + 0 per-file errors before
// this change vs. 0 sequence-level + 2 per-file errors after it — meaning the
// sequence-level <colordepth> addition really did fix the original error, and
// it was ONLY adding it to the per-file blocks that regressed.
//
// The one structural difference between the two contexts: the sequence-level
// block sits inside <video><format><samplecharacteristics>, matching Apple's
// own <colordepth> example exactly (Listing 3-11 always wraps in <format>).
// The per-file blocks sit directly under <video><samplecharacteristics>, with
// NO <format> wrapper (matching Apple's minimal Listing 3-5, which never
// carries <colordepth> either) — this asymmetry already existed pre-2b84d1f
// and was harmless as long as neither block had colordepth; it's only once
// colordepth entered the picture that the un-wrapped, file-level context
// started producing a singular matrix. So <colordepth> stays scoped to the
// <format>-wrapped, once-per-sequence block only — the per-file blocks go
// back to exactly their proven-good 2d7ef23 shape (width/height/anamorphic/
// pixelaspectratio/fielddominance/rate, nothing more).
const VIDEO_COLOR_DEPTH_BITS = 24;

function videoSamplecharacteristics(
  width: number,
  height: number,
  fps: number,
  indent: string,
  includeColordepth: boolean,
): string {
  return [
    `${indent}<samplecharacteristics>`,
    `${indent}  <width>${width}</width>`,
    `${indent}  <height>${height}</height>`,
    `${indent}  <anamorphic>FALSE</anamorphic>`,
    `${indent}  <pixelaspectratio>square</pixelaspectratio>`,
    `${indent}  <fielddominance>none</fielddominance>`,
    rateBlock(fps, `${indent}  `),
    ...(includeColordepth ? [`${indent}  <colordepth>${VIDEO_COLOR_DEPTH_BITS}</colordepth>`] : []),
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

// Real Premiere test #6 (on top of 2e59af3, Matrix errors now fully gone):
// V1 imports and plays correctly, and A1 clipitems appear on the timeline
// with correct timing/links — but there's no usable/playable audio, even
// though the source clips (18C_0681.MP4, 18C_0687.MP4) definitely have real
// embedded audio (this app's own WATCH transcription used it).
//
// The gap: every clipitem this exporter builds has <file id="..."> (a full
// definition the first time, a bare reference every time after — see
// fileBlockXml above) but NEVER a <sourcetrack>. Per Apple's own XMEML
// Elements Catalog, <sourcetrack> (parents: clip, clipitem, generatoritem;
// children: mediatype, trackindex) "encodes details of the media connected
// with a clip," and "the designated media can be a specific piece of media
// or a nested sequence with multiple types of media" — exactly our case: one
// <file> whose <media> has BOTH a <video> and an <audio> block (an
// interview clip is always both), referenced by TWO different clipitems (one
// on V1, one on A1). Without <sourcetrack>, a clipitem sitting on an audio
// track that references a file carrying both video and audio media has no
// explicit instruction telling Premiere "play this file's AUDIO," which is
// consistent with V1 (video) working while A1 (audio) silently doesn't.
//
// This matches real Premiere-generated XML: a real-world example (an actual
// Premiere XML export, audio clipitem referencing a bare `<file id="..."/>`)
// shows exactly `<file id="..."/>` immediately followed by
// `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex>
// </sourcetrack>` — no other new fields. trackindex identifies which
// channel/stream of that media type to use; this exporter only ever models
// one video stream and one audio stream per source file (no multi-channel
// audio), so trackindex is always 1. Added uniformly to every clipitem this
// exporter builds (V1/V2 get a video sourcetrack, A1/A2 get an audio one) —
// not just A1 — since the same ambiguity (a clipitem on one track type
// referencing a <file> that also carries the other type) exists for V1 too
// whenever a source clip has embedded audio; it just happened not to
// manifest as a symptom yet.
//
// Real Premiere test #7 refined the trackindex part of this: for audio,
// <trackindex> selects the SOURCE CHANNEL, so "always 1" meant "channel 1
// only" for a stereo source. It's now the channel this clipitem carries — see
// the real-test-#7 comment above LinkRef.
function sourceTrackXml(mediaType: "video" | "audio", trackIndex: number, indent: string): string {
  return [
    `${indent}<sourcetrack>`,
    `${indent}  <mediatype>${mediaType}</mediatype>`,
    `${indent}  <trackindex>${trackIndex}</trackindex>`,
    `${indent}</sourcetrack>`,
  ].join("\n");
}

// Real Premiere test #7 (on top of 65d0c47): A1 imported with waveforms but
// played "mostly static/hiss/extremely quiet". Measured with ffprobe/astats,
// the real source (18C_0681.MP4, AAC stereo 48kHz) carries its dialogue ONLY
// on source channel 2 (RMS -24 dB); channel 1 is a near-silent input (RMS
// -69.6 dB, hiss). Premiere's own direct import of that file is a single
// Stereo clip, L->L / R->R. This exporter emitted ONE audio clipitem with
// <sourcetrack><trackindex>1</trackindex> and no <channelcount> — i.e. "source
// channel 1 only" — which is exactly the hiss channel the user heard.
//
// The fix mirrors how Premiere's OWN XMEML export represents a stereo source
// (Premiere-exported fixtures premiere_example.xml / premiere_generators.xml
// in OpenTimelineIO's FCP-XML adapter test data), not a hard-coded channel:
//   - <file><media><audio> declares the real <channelcount> (ffprobe-measured,
//     Clip.audioChannels);
//   - a stereo sequence track is "exploded" into two XML <track>s with
//     premiereTrackType="Stereo", currentExplodedTrackIndex 0/1,
//     totalExplodedTrackCount 2 and <outputchannelindex> 1/2;
//   - a stereo source becomes TWO clipitems (premiereChannelType="stereo"),
//     one per exploded track, with <sourcetrack><trackindex> 1 and 2 — both
//     channels preserved, routed L->1 / R->2 exactly like the source; a mono
//     source is ONE clipitem (premiereChannelType="mono") on exploded track 0;
//   - the sequence <audio> declares <numOutputChannels>2 and an <outputs>
//     block of two one-channel groups;
//   - the video clipitem links to itself plus every audio channel clipitem,
//     and each audio channel clipitem carries the same full set of links, with
//     <clipindex> = the clip's 1-based position on that link's track and
//     <groupindex>1 (the source's single audio channel group) on audio links.
// No channel is chosen as "the dialogue channel" — the source's own layout is
// reproduced, and the editor mixes it in Premiere as they would the original.

/** One <link> entry — DTD: <!ELEMENT link (linkclipref | mediatype |
 * trackindex | clipindex | groupindex)*>. Every clipitem of a synced group
 * (V1 picture + each of its audio channels) carries the SAME full list, which
 * is what makes an NLE move/trim/delete them together. */
interface LinkRef {
  id: string;
  mediaType: "video" | "audio";
  /** 1-based index among the sequence's tracks of that media type. */
  trackIndex: number;
  /** 1-based position of this clipitem within its own track. */
  clipIndex: number;
  /** Present on audio links only (Premiere omits it on the video link). */
  groupIndex?: number;
}

/** Sequence-level <outputs>: one single-channel group per output channel,
 * exactly the shape Premiere exports for a stereo sequence. */
function sequenceOutputsXml(indent: string): string {
  const groups = Array.from({ length: EXPLODED_STEREO_TRACKS }, (_, i) =>
    [
      `${indent}  <group>`,
      `${indent}    <index>${i + 1}</index>`,
      `${indent}    <numchannels>1</numchannels>`,
      `${indent}    <downmix>0</downmix>`,
      `${indent}    <channel>`,
      `${indent}      <index>${i + 1}</index>`,
      `${indent}    </channel>`,
      `${indent}  </group>`,
    ].join("\n"),
  );
  return [`${indent}<outputs>`, ...groups, `${indent}</outputs>`].join("\n");
}

function linksXml(links: readonly LinkRef[], indent: string): string {
  return links
    .map((l) =>
      [
        `${indent}<link>`,
        `${indent}  <linkclipref>${l.id}</linkclipref>`,
        `${indent}  <mediatype>${l.mediaType}</mediatype>`,
        `${indent}  <trackindex>${l.trackIndex}</trackindex>`,
        `${indent}  <clipindex>${l.clipIndex}</clipindex>`,
        ...(l.groupIndex !== undefined ? [`${indent}  <groupindex>${l.groupIndex}</groupindex>`] : []),
        `${indent}</link>`,
      ].join("\n"),
    )
    .join("\n");
}

/** Premiere represents a stereo sequence track as this many XML <track>s. */
const EXPLODED_STEREO_TRACKS = 2;

/** The source's real audio channel count, or undefined when unknown (no audio
 * stream, or metadata from a worker that predates Clip.audioChannels). */
function sourceAudioChannels(clip: Clip | undefined): number | undefined {
  const n = clip?.audioChannels;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** How many channel clipitems (1 or 2) a source gets on an exploded stereo
 * pair. Unknown layouts keep the pre-#7 single-clipitem shape rather than
 * guessing; >2 channels can't be represented on one stereo pair, so channels
 * 1-2 are exported and the rest are reported, never silently dropped. */
function exportedChannelCount(clip: Clip | undefined, name: string, warnings: string[]): 1 | 2 {
  const n = sourceAudioChannels(clip);
  if (n === undefined || n === 1) return 1;
  if (n > EXPLODED_STEREO_TRACKS) {
    warnings.push(
      `"${name}" has ${n} audio channels — only channels 1-2 were exported as a stereo pair; add channels 3-${n} manually in Premiere.`,
    );
  }
  return 2;
}

/**
 * Builds the real <file id="..."> definition for a source clip exactly once —
 * covering every media kind (`kinds`) it's used as anywhere in this timeline,
 * e.g. an interview clip that's both a V1 video event and its own linked A1
 * audio gets one <file> with both a <video> and an <audio> block. Every later
 * call for the same fileId (tracked via `definedFileIds`, shared across the
 * whole buildXmeml() call) returns a bare, self-closing reference instead —
 * see the top-of-file comment for why redefining the same id with different
 * content broke a real Premiere import.
 *
 * `clipFps` is the SOURCE clip's own real rate (see the real-test-#5 comment
 * on toFrameRanges() above) — never the timeline's — because everything built
 * here (the file's own <rate>, its total <duration>, and the nested
 * samplecharacteristics <rate>) describes the real source media, not the
 * sequence it's cut into.
 */
function fileBlockXml(
  fileId: string,
  clip: Clip | undefined,
  name: string,
  mediaRoot: string,
  clipFps: number,
  kinds: ReadonlySet<"video" | "audio">,
  fallbackDurationFrames: number,
  warnings: string[],
  definedFileIds: Set<string>,
  indent: string,
): string {
  if (definedFileIds.has(fileId)) {
    return `${indent}<file id="${fileId}"/>`;
  }
  definedFileIds.add(fileId);

  const { url, resolved } = fileUrlForClip(clip, mediaRoot);
  if (!resolved) {
    warnings.push(`Could not resolve an absolute path for "${name}" — you'll need to relink media after import.`);
  }
  const sourceDurationFrames = clip?.durationSeconds
    ? framesForSeconds(clip.durationSeconds, clipFps)
    : fallbackDurationFrames;

  const mediaParts: string[] = [];
  if (kinds.has("video")) {
    const { width, height } = frameDimensions(clip);
    // includeColordepth: false — see the real-test-#4 comment above
    // videoSamplecharacteristics(): this per-file block has no <format>
    // wrapper, and colordepth in that bare context is what caused the two
    // new "Matrix cannot be inverted" errors in commit 2b84d1f.
    mediaParts.push(
      `${indent}    <video>\n${videoSamplecharacteristics(width, height, clipFps, `${indent}      `, false)}\n${indent}    </video>`,
    );
  }
  if (kinds.has("audio")) {
    // Real-test-#7: the measured channel count, placed after
    // <samplecharacteristics> exactly as Premiere's own export does. Omitted
    // (pre-#7 shape) when unknown rather than guessed.
    const channels = sourceAudioChannels(clip);
    mediaParts.push(
      [
        `${indent}    <audio>`,
        audioSamplecharacteristics(`${indent}      `),
        ...(channels !== undefined ? [`${indent}      <channelcount>${channels}</channelcount>`] : []),
        `${indent}    </audio>`,
      ].join("\n"),
    );
  }

  return [
    `${indent}<file id="${fileId}">`,
    `${indent}  <name>${name}</name>`,
    `${indent}  <pathurl>${xmlEscape(url)}</pathurl>`,
    rateBlock(clipFps, `${indent}  `),
    `${indent}  <duration>${sourceDurationFrames}</duration>`,
    `${indent}  <media>`,
    ...mediaParts,
    `${indent}  </media>`,
    `${indent}</file>`,
  ].join("\n");
}

// timelineFps here is the SEQUENCE's rate — it governs the clipitem's own
// <rate> and its <start>/<end>/<duration> (its placement on the timeline).
// <in>/<out> are deliberately NOT derived from timelineFps/duration — they're
// range.inFrame/outFrame, already computed in the clip's own real rate by
// toFrameRanges() (see the real-test-#5 comment there). When a clip's native
// rate differs from the sequence's, out-in (source frames) and end-start
// (sequence frames) are legitimately different numbers for the same real-time
// span — Apple's own XMEML docs call this out explicitly for clipitem
// <duration> once framerate is involved.
interface ClipItemSource {
  /** Which of the referenced file's media kinds this clipitem draws from —
   * see the real-test-#6 comment on sourceTrackXml() above. */
  mediaType: "video" | "audio";
  /** <sourcetrack><trackindex>: for audio, the SOURCE CHANNEL (1-based) —
   * see the real-test-#7 comment above LinkRef. Always 1 for video. */
  trackIndex: number;
  /** premiereChannelType attribute on audio clipitems (real-test-#7). */
  channelType?: "mono" | "stereo";
}

function clipItemXml(
  range: FrameRange,
  itemId: string,
  timelineFps: number,
  fileBlock: string,
  source: ClipItemSource,
  links: readonly LinkRef[],
): string {
  const { decision, clip, inFrame, outFrame, startFrame, timelineDurationFrames } = range;
  const name = xmlEscape(clip?.filename ?? decision.label ?? decision.clipId);
  const channelAttr = source.channelType ? ` premiereChannelType="${source.channelType}"` : "";

  return [
    `      <clipitem id="${itemId}"${channelAttr}>`,
    `        <name>${name}</name>`,
    `        <duration>${timelineDurationFrames}</duration>`,
    rateBlock(timelineFps, "        "),
    `        <start>${startFrame}</start>`,
    `        <end>${startFrame + timelineDurationFrames}</end>`,
    `        <in>${inFrame}</in>`,
    `        <out>${outFrame}</out>`,
    fileBlock,
    sourceTrackXml(source.mediaType, source.trackIndex, "        "),
    ...(links.length > 0 ? [linksXml(links, "        ")] : []),
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

  // Real-test-#5: r.outFrame - r.inFrame is now a SOURCE-frame span (the
  // clip's own rate — see toFrameRanges() above), not a timeline-frame one,
  // so it can no longer be added to the timeline-frame r.startFrame here.
  // r.timelineDurationFrames is the correct sequence-frame span to use — the
  // whole point of this sequence-duration computation is staying in the
  // sequence's own fps end to end.
  const totalFrames = Math.max(
    framesForSeconds(timeline.totalSeconds, fps),
    ...[...interview, ...broll, ...standaloneAudio].map((r) => r.startFrame + r.timelineDurationFrames),
    0,
  );

  // Sequence-level frame geometry: the first clip with a real, parseable
  // resolution (interview or b-roll), else the same safe fallback
  // frameDimensions() uses per-clip.
  const sequenceClip = [...interview, ...broll].map((r) => r.clip).find((c) => c?.resolution);
  const { width: seqWidth, height: seqHeight } = frameDimensions(sequenceClip);

  // Every media kind a given source clip is actually used as anywhere in this
  // timeline — an interview clip is always both "video" (its own V1 event)
  // and "audio" (its linked A1 counterpart); b-roll is video-only; a
  // standalone "audio"-lane clip is audio-only. Drives fileBlockXml()'s
  // single-real-definition-per-file behavior below.
  const clipKinds = new Map<string, Set<"video" | "audio">>();
  const addKind = (clipId: string, kind: "video" | "audio") => {
    if (!clipKinds.has(clipId)) clipKinds.set(clipId, new Set());
    clipKinds.get(clipId)!.add(kind);
  };
  for (const r of interview) {
    addKind(r.decision.clipId, "video");
    addKind(r.decision.clipId, "audio");
  }
  for (const r of broll) addKind(r.decision.clipId, "video");
  for (const r of standaloneAudio) addKind(r.decision.clipId, "audio");

  // Fallback source-file duration (in frames) when a clip has no known real
  // durationSeconds — the widest out-point actually used against that clip
  // anywhere in the timeline, so the file's declared duration is never
  // shorter than a real event trimmed from it.
  const clipFallbackFrames = new Map<string, number>();
  for (const r of [...interview, ...broll, ...standaloneAudio]) {
    const prev = clipFallbackFrames.get(r.decision.clipId) ?? 0;
    clipFallbackFrames.set(r.decision.clipId, Math.max(prev, r.outFrame + 1));
  }

  const definedFileIds = new Set<string>();
  const fileBlockFor = (range: FrameRange, index: number, indent: string): string => {
    const fileId = sanitizeXmlId(`file-${range.decision.clipId}`, `file-${index + 1}`);
    const name = xmlEscape(range.clip?.filename ?? range.decision.label ?? range.decision.clipId);
    const kinds = clipKinds.get(range.decision.clipId) ?? new Set<"video" | "audio">();
    const fallback = clipFallbackFrames.get(range.decision.clipId) ?? 1;
    // range.clipFps — the source clip's own real rate, NOT the timeline's
    // `fps` — see the real-test-#5 comment on toFrameRanges() above. This was
    // the actual bug: every <file><rate> was previously emitted at the
    // sequence's rate regardless of what the real source clip was shot at.
    return fileBlockXml(fileId, range.clip, name, mediaRoot, range.clipFps, kinds, fallback, warnings, definedFileIds, indent);
  };

  // Real-test-#7: one channel count per SOURCE clip, resolved once (so a
  // >2-channel warning is reported once per clip, not once per use).
  const channelCountByClip = new Map<string, 1 | 2>();
  const channelsFor = (r: FrameRange): 1 | 2 => {
    const key = r.decision.clipId;
    let n = channelCountByClip.get(key);
    if (n === undefined) {
      n = exportedChannelCount(r.clip, r.clip?.filename ?? r.decision.label ?? key, warnings);
      channelCountByClip.set(key, n);
    }
    return n;
  };

  /** One audio channel clipitem of an event, placed on an exploded stereo
   * track pair. `trackIndex` is its 1-based index among ALL audio tracks. */
  interface AudioChannelItem {
    id: string;
    channel: number;
    trackIndex: number;
    clipIndex: number;
  }

  // Lays out a lane's events on an exploded stereo pair (real-test-#7): every
  // event puts its channel-1 clipitem on the pair's first track; stereo events
  // also put a channel-2 clipitem on the second. `clipIndex` is the item's real
  // position on ITS track, which differs between the two tracks as soon as a
  // lane mixes mono and stereo sources. Channel 1 keeps the pre-#7 id
  // ("a1-<decision>") so existing references stay stable.
  const layoutAudioPair = (ranges: FrameRange[], prefix: string, firstTrackIndex: number): AudioChannelItem[][] => {
    const perTrackCount = Array.from({ length: EXPLODED_STEREO_TRACKS }, () => 0);
    return ranges.map((r, i) => {
      const items: AudioChannelItem[] = [];
      for (let channel = 1; channel <= channelsFor(r); channel++) {
        perTrackCount[channel - 1] = (perTrackCount[channel - 1] ?? 0) + 1;
        const suffix = channel === 1 ? "" : `-ch${channel}`;
        items.push({
          id: sanitizeXmlId(`${prefix}-${r.decision.id}${suffix}`, `${prefix}-clip-${i + 1}${suffix}`),
          channel,
          trackIndex: firstTrackIndex + channel - 1,
          clipIndex: perTrackCount[channel - 1] ?? 1,
        });
      }
      return items;
    });
  };

  const audioLinkRefs = (items: AudioChannelItem[]): LinkRef[] =>
    items.map((a) => ({ id: a.id, mediaType: "audio", trackIndex: a.trackIndex, clipIndex: a.clipIndex, groupIndex: 1 }));

  // A1 pair = the interview lane's own synced production audio (the same
  // dialogue that made it into the transcript), linked to its V1 picture. The
  // A2 pair is the app's own "audio" decision lane (e.g. a narration insert
  // with no picture of its own) — a different kind of event, not a synced
  // partner of anything on V1/V2, so it's only linked within itself.
  const interviewAudio = layoutAudioPair(interview, "a1", 1);
  const standaloneLayoutBase = interview.length > 0 ? EXPLODED_STEREO_TRACKS + 1 : 1;
  const standaloneAudioItems = layoutAudioPair(standaloneAudio, "a2", standaloneLayoutBase);

  const v1Id = (r: FrameRange, i: number) => sanitizeXmlId(`v1-${r.decision.id}`, `v1-clip-${i + 1}`);
  // Premiere's own export: the picture's link (no groupindex) followed by one
  // link per audio channel clipitem — the identical list on every member.
  const interviewLinks = (r: FrameRange, i: number): LinkRef[] => [
    { id: v1Id(r, i), mediaType: "video", trackIndex: 1, clipIndex: i + 1 },
    ...audioLinkRefs(interviewAudio[i] ?? []),
  ];

  const videoTracks = [
    interview.length > 0
      ? `    <track>\n${interview
          .map((r, i) =>
            clipItemXml(r, v1Id(r, i), fps, fileBlockFor(r, i, "        "), { mediaType: "video", trackIndex: 1 }, interviewLinks(r, i)),
          )
          .join("\n")}\n    </track>`
      : null,
    broll.length > 0
      ? `    <track>\n${broll
          .map((r, i) =>
            clipItemXml(
              r,
              sanitizeXmlId(`v2-${r.decision.id}`, `v2-clip-${i + 1}`),
              fps,
              fileBlockFor(r, i, "        "),
              { mediaType: "video", trackIndex: 1 },
              [],
            ),
          )
          .join("\n")}\n    </track>`
      : null,
  ].filter((t): t is string => t !== null);

  /** Emits a lane as Premiere's exploded stereo track pair. */
  const explodedPairXml = (
    ranges: FrameRange[],
    items: AudioChannelItem[][],
    linksFor: (r: FrameRange, i: number) => LinkRef[],
  ): string[] =>
    Array.from({ length: EXPLODED_STEREO_TRACKS }, (_, t) => {
      const channel = t + 1;
      const clipitems = ranges
        .map((r, i) => {
          const item = (items[i] ?? []).find((a) => a.channel === channel);
          if (!item) return null;
          const channelType = (items[i] ?? []).length > 1 ? "stereo" : "mono";
          return clipItemXml(
            r,
            item.id,
            fps,
            fileBlockFor(r, i, "        "),
            { mediaType: "audio", trackIndex: channel, channelType },
            linksFor(r, i),
          );
        })
        .filter((c): c is string => c !== null);
      return [
        `    <track currentExplodedTrackIndex="${t}" totalExplodedTrackCount="${EXPLODED_STEREO_TRACKS}" premiereTrackType="Stereo">`,
        ...clipitems,
        `      <outputchannelindex>${channel}</outputchannelindex>`,
        `    </track>`,
      ].join("\n");
    });

  const audioTracks: string[] = [];
  if (interview.length > 0) {
    audioTracks.push(...explodedPairXml(interview, interviewAudio, interviewLinks));
  }
  if (standaloneAudio.length > 0) {
    // Mono standalone events stay unlinked (nothing to link to); a stereo one
    // links its two channel clipitems to each other.
    const standaloneLinks = (_r: FrameRange, i: number): LinkRef[] => {
      const items = standaloneAudioItems[i] ?? [];
      return items.length > 1 ? audioLinkRefs(items) : [];
    };
    audioTracks.push(...explodedPairXml(standaloneAudio, standaloneAudioItems, standaloneLinks));
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    // Real Premiere-generated XMEML always gives <sequence> an id attribute
    // (DTD marks it #IMPLIED/optional, but every real export has one). Adding
    // it costs nothing and matches what a real Premiere export looks like —
    // included alongside the colordepth fix above as cheap, zero-risk
    // insurance for the same once-per-sequence surface the user pointed at.
    `  <sequence id="sequence-1">`,
    `    <name>${xmlEscape(timeline.name)}</name>`,
    `    <duration>${totalFrames}</duration>`,
    rateBlock(fps, "    "),
    `    <media>`,
    `      <video>`,
    `        <format>`,
    // includeColordepth: true — this is the once-per-sequence, <format>-
    // wrapped block; see the real-test-#3/#4 comment above
    // videoSamplecharacteristics() for why colordepth stays here but not in
    // the per-file blocks below.
    videoSamplecharacteristics(seqWidth, seqHeight, fps, "          ", true),
    `        </format>`,
    ...videoTracks,
    `      </video>`,
    ...(audioTracks.length > 0
      ? [
          `      <audio>`,
          // Real-test-#7: a stereo sequence, declared the way Premiere's own
          // export does — two output channels, one per exploded track
          // (<outputchannelindex> 1/2 on each track pair above).
          `        <numOutputChannels>${EXPLODED_STEREO_TRACKS}</numOutputChannels>`,
          `        <format>`,
          audioSamplecharacteristics("          "),
          `        </format>`,
          sequenceOutputsXml("        "),
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
