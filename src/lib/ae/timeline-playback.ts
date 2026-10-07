// Drives real playback of a UniversalTimeline: walks its V1 edit decisions in
// timeline order through a double-buffered pair of <video> elements
// (./sequence-buffer.ts), so pressing play on the CUT page plays the assembled
// sequence edit to edit without black frames. V2 cutaways are returned as
// overlays. "Audio" lane items are excluded from the walk: in this app's data
// model that lane is a static ambient bed (see cut.tsx), not per-decision
// source clips with their own in/out points.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tcToSeconds } from "@/lib/nle/timecode";
import { previewSrcForClip } from "./media-url";
import { SequenceBuffer, type MediaLike, type SequenceState } from "./sequence-buffer";
import type { Clip, EditDecision, UniversalTimeline } from "./types";

export interface PlayableSegment {
  decision: EditDecision;
  clip: Clip | undefined;
  /** ae-media:// URL, or null if this clip has no real, playable media yet. */
  src: string | null;
  sourceInSeconds: number;
  sourceOutSeconds: number;
}

function toSegments(
  decisions: EditDecision[],
  byId: Map<string, Clip>,
  timelineFps: number,
): PlayableSegment[] {
  return decisions
    .slice()
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
    .map((d) => {
      const clip = byId.get(d.clipId);
      // Source timecodes are in the CLIP's own rate (a 23.976 source's frame
      // field is 1/23.976s) — the same rule the worker validation and the
      // XMEML exporter use. Reading them at the timeline's rate drifted up to
      // a frame per edit.
      const fps = clip?.fps || timelineFps || 24;
      const sourceInSeconds = tcToSeconds(d.sourceInTc, fps) ?? 0;
      const parsedOut = tcToSeconds(d.sourceOutTc, fps);
      const sourceOutSeconds = parsedOut !== null && parsedOut > sourceInSeconds ? parsedOut : sourceInSeconds + d.durationSeconds;
      return { decision: d, clip, src: previewSrcForClip(clip), sourceInSeconds, sourceOutSeconds };
    });
}

/**
 * The primary playback sequence is V1 (interview) — its picture AND its sync
 * audio, so audio always follows picture. B-roll (V2) is NOT part of the
 * sequence: those events are cutaways laid over V1 and are returned separately
 * as overlays. Previously V1 and V2 were played as one interleaved sequence, so
 * a cutaway over an interview jumped away from the interview's audio. A
 * timeline with no V1 events plays its V2 events as the sequence instead.
 */
export function buildPlaybackPlan(timeline: UniversalTimeline, clips: Clip[]) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const v1 = timeline.decisions.filter((d) => d.lane === "interview");
  const v2 = timeline.decisions.filter((d) => d.lane === "b-roll");
  return v1.length > 0
    ? { sequence: toSegments(v1, byId, timeline.fps), overlays: toSegments(v2, byId, timeline.fps) }
    : { sequence: toSegments(v2, byId, timeline.fps), overlays: [] as PlayableSegment[] };
}

/** The V2 overlay visible at a timeline position, if any. */
export function overlayAt(
  overlays: PlayableSegment[],
  timelineSeconds: number,
): PlayableSegment | null {
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i]!;
    const start = o.decision.timelineStartSeconds;
    if (o.src && timelineSeconds >= start && timelineSeconds < start + o.decision.durationSeconds)
      return o;
  }
  return null;
}

/** The exact end of the cut (its last event's end). `totalSeconds` is a
 * whole-second figure for display; the playhead needs the real end. */
export function sequenceEndSeconds(timeline: UniversalTimeline): number {
  const end = timeline.decisions.reduce(
    (a, d) => Math.max(a, d.timelineStartSeconds + d.durationSeconds),
    0,
  );
  return end > 0 ? end : timeline.totalSeconds;
}

/** Where the playhead stays when the sequence changes: the same position,
 * clamped to the new sequence length. */
export function keptPlayhead(playheadSeconds: number, totalSeconds: number): number {
  return Math.max(0, Math.min(playheadSeconds, Math.max(0, totalSeconds)));
}

export function useTimelinePlayback(timeline: UniversalTimeline, clips: Clip[]) {
  const plan = useMemo(() => buildPlaybackPlan(timeline, clips), [timeline, clips]);
  const segments = plan.sequence;
  const hasPlayableMedia = segments.some((s) => s.src);

  const [state, setState] = useState<SequenceState>({
    activeIndex: null,
    frontSlot: 0,
    playheadSeconds: 0,
    playing: false,
    waiting: false,
  });
  const bufferRef = useRef<SequenceBuffer | null>(null);
  if (!bufferRef.current) bufferRef.current = new SequenceBuffer(setState);
  const buffer = bufferRef.current;

  // A new plan (an edit, undo/redo, another version) stops playback and
  // rebuilds the buffer — but keeps the playhead where it was on the sequence,
  // clamped to the new length. Playback resumes only on an explicit Play.
  const playheadRef = useRef(state.playheadSeconds);
  playheadRef.current = state.playheadSeconds;
  const endSeconds = useMemo(() => sequenceEndSeconds(timeline), [timeline]);
  useEffect(() => {
    const keep = keptPlayhead(playheadRef.current, endSeconds);
    buffer.setSequence(segments, endSeconds);
    if (keep > 0) buffer.seek(keep);
  }, [buffer, segments, endSeconds]);

  // Edit points are checked every animation frame (not on ~4 Hz timeupdate).
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    const loop = () => {
      buffer.tick();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [buffer]);

  /** Ref callbacks for the two stacked <video> elements (slot 0 and 1). */
  const attachSlot0 = useCallback((el: MediaLike | null) => buffer.attach(0, el), [buffer]);
  const attachSlot1 = useCallback((el: MediaLike | null) => buffer.attach(1, el), [buffer]);

  const play = useCallback(() => buffer.play(), [buffer]);
  const pause = useCallback(() => buffer.pause(), [buffer]);
  const togglePlay = useCallback(() => (state.playing ? buffer.pause() : buffer.play()), [buffer, state.playing]);
  /** Seeks to an absolute position on the *timeline* (not within one clip). */
  const seek = useCallback((globalSeconds: number) => buffer.seek(globalSeconds), [buffer]);

  const activeSegment = state.activeIndex !== null ? (segments[state.activeIndex] ?? null) : null;
  const overlay = overlayAt(plan.overlays, state.playheadSeconds);

  return {
    segments,
    overlays: plan.overlays,
    /** The V2 cutaway to show over the player right now (picture only). */
    overlay,
    activeSegment,
    hasPlayableMedia,
    playheadSeconds: state.playheadSeconds,
    isPlaying: state.playing,
    /** Nothing can be shown yet (first load only). */
    waiting: state.waiting,
    /** Which of the two stacked <video> elements is visible. */
    frontSlot: state.frontSlot,
    attachSlot0,
    attachSlot1,
    play,
    pause,
    togglePlay,
    seek,
  };
}

export type TimelinePlayback = ReturnType<typeof useTimelinePlayback>;
