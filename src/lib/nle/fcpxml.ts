// Final Cut Pro X / DaVinci Resolve export — FCPXML 1.9. A structurally
// different format from XMEML (xmeml.ts): resources are declared once and
// referenced by id, and the timeline is a single primary "spine" rather than
// arbitrary parallel tracks.
//
// Scope, stated plainly rather than silently overreaching: this exporter
// builds ONE spine from every non-audio decision, ordered by timeline
// position, with explicit <gap> elements filling any timing gaps so the spine
// stays contiguous (FCPXML requires that). It does not attempt FCPXML's
// connected-clip/lane anchoring for genuinely overlapping decisions (e.g. a
// b-roll cutaway meant to sit *over* an interview's audio at the same
// timeline position) — getting that anchoring math wrong produces a file that
// silently misplaces clips on import, which is worse than not supporting it,
// and there was no real Final Cut Pro or Resolve install available in this
// session to verify it against. Today's actual pipeline (worker/pipeline.py)
// never produces overlapping decisions, so this covers everything the app can
// currently generate; if a decision does overlap an earlier one, it's dropped
// with a warning rather than guessed at. Audio-lane decisions are skipped the
// same way (see the file-level comment on the audio-lane data model in
// src/routes/cut.tsx). Premiere Pro does not import FCPXML natively — use the
// XMEML export (xmeml.ts) for Premiere.

import type { Clip, UniversalTimeline } from "../ae/types";
// Explicit ".ts" extensions — see the comment on the equivalent import in
// edl.ts: these are real runtime imports and scripts/export-timeline.ts runs
// this file directly under Node with no bundler in front of it.
import { fileUrlForClip, sanitizeXmlId, xmlEscape, type XmlExportResult } from "./xml-utils.ts";
import { framesForSeconds, tcToSeconds } from "./timecode.ts";

/** Formats a frame count as FCPXML's rational time string, e.g. "240/24s". */
function rational(frames: number, fps: number): string {
  const wholeFps = Math.max(1, Math.round(fps));
  return `${frames}/${wholeFps}s`;
}

interface SpineItem {
  decision: UniversalTimeline["decisions"][number];
  clip: Clip | undefined;
  startFrame: number;
  inFrame: number;
  outFrame: number;
}

export function buildFcpxml(
  timeline: UniversalTimeline,
  usableDecisions: UniversalTimeline["decisions"],
  clips: Clip[],
  mediaRoot: string,
): XmlExportResult {
  const fps = timeline.fps || 24;
  const wholeFps = Math.max(1, Math.round(fps));
  const warnings: string[] = [];
  const byId = new Map(clips.map((c) => [c.id, c]));

  const audioCount = usableDecisions.filter((d) => d.lane === "audio").length;
  if (audioCount > 0) {
    warnings.push(
      `${audioCount} audio-lane decision(s) were not included in the FCPXML spine — audio-lane export isn't supported by this exporter yet.`,
    );
  }

  const candidates: SpineItem[] = usableDecisions
    .filter((d) => d.lane !== "audio")
    .slice()
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
    .map((d) => {
      const clip = byId.get(d.clipId);
      const inSeconds = tcToSeconds(d.sourceInTc, fps);
      const outSeconds = tcToSeconds(d.sourceOutTc, fps);
      const inFrame = inSeconds !== null ? framesForSeconds(inSeconds, fps) : 0;
      const rawOutFrame = outSeconds !== null ? framesForSeconds(outSeconds, fps) : inFrame + framesForSeconds(d.durationSeconds, fps);
      const outFrame = rawOutFrame > inFrame ? rawOutFrame : inFrame + 1;
      return { decision: d, clip, startFrame: framesForSeconds(d.timelineStartSeconds, fps), inFrame, outFrame };
    });

  // Build a contiguous, non-overlapping spine: fill gaps, drop true overlaps
  // (see file-level comment) rather than guessing at lane placement.
  const spineParts: string[] = [];
  const assetByClipId = new Map<string, { assetId: string; clip: Clip | undefined }>();
  const resourceParts: string[] = [];
  let cursorFrame = 0;
  let assetCounter = 0;
  let formatId = "";

  if (fps > 0) {
    formatId = "r1";
    resourceParts.push(
      `    <format id="${formatId}" name="FFVideoFormat${wholeFps}p" frameDuration="1/${wholeFps}s"/>`,
    );
  }

  for (const item of candidates) {
    if (item.startFrame < cursorFrame) {
      warnings.push(`"${item.decision.label}" overlaps the previous spine item and was dropped from the FCPXML export.`);
      continue;
    }
    if (item.startFrame > cursorFrame) {
      const gapFrames = item.startFrame - cursorFrame;
      spineParts.push(
        `      <gap name="Gap" offset="${rational(cursorFrame, fps)}" duration="${rational(gapFrames, fps)}"/>`,
      );
    }

    let assetEntry = assetByClipId.get(item.decision.clipId);
    if (!assetEntry) {
      assetCounter += 1;
      const assetId = sanitizeXmlId(`asset-${item.decision.clipId}`, `a${assetCounter}`);
      const name = xmlEscape(item.clip?.filename ?? item.decision.clipId);
      const { url, resolved } = fileUrlForClip(item.clip, mediaRoot);
      if (!resolved) {
        warnings.push(`Could not resolve an absolute path for "${name}" — you'll need to relink media after import.`);
      }
      const durationFrames = item.clip?.durationSeconds
        ? framesForSeconds(item.clip.durationSeconds, fps)
        : item.outFrame + 1;
      resourceParts.push(
        [
          `    <asset id="${assetId}" name="${name}" src="${xmlEscape(url)}"`,
          `           start="0s" duration="${rational(durationFrames, fps)}"`,
          `           hasVideo="1" hasAudio="1"${formatId ? ` format="${formatId}"` : ""}/>`,
        ].join("\n"),
      );
      assetEntry = { assetId, clip: item.clip };
      assetByClipId.set(item.decision.clipId, assetEntry);
    }

    const durationFrames = item.outFrame - item.inFrame;
    const name = xmlEscape(item.clip?.filename ?? item.decision.label ?? item.decision.clipId);
    spineParts.push(
      [
        `      <asset-clip ref="${assetEntry.assetId}" name="${name}"`,
        `                  offset="${rational(item.startFrame, fps)}"`,
        `                  duration="${rational(durationFrames, fps)}"`,
        `                  start="${rational(item.inFrame, fps)}"/>`,
      ].join("\n"),
    );
    cursorFrame = item.startFrame + durationFrames;
  }

  const totalFrames = Math.max(framesForSeconds(timeline.totalSeconds, fps), cursorFrame);
  const sequenceName = xmlEscape(timeline.name);

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.9">`,
    `  <resources>`,
    ...resourceParts,
    `  </resources>`,
    `  <library>`,
    `    <event name="Assistant Editor AI">`,
    `      <project name="${sequenceName}">`,
    `        <sequence format="${formatId || "r1"}" duration="${rational(totalFrames, fps)}" tcStart="0s" tcFormat="NDF">`,
    `          <spine>`,
    ...spineParts,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    "",
  ].join("\n");

  return { xml, warnings };
}

export function fcpxmlFilename(timeline: UniversalTimeline): string {
  const slug = timeline.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${slug || "assistant-editor-sequence"}.fcpxml`;
}
