// Drives real playback of a UniversalTimeline: walks its edit decisions in
// timeline order, swapping the underlying <video> source (via a single
// MediaPlayer instance, ref-controlled) at each decision boundary so pressing
// play on the CUT page actually plays the assembled sequence — not just one
// clip. "Audio" lane items are excluded from the walk: in this app's data
// model that lane is a static ambient bed (see cut.tsx), not per-decision
// source clips with their own in/out points.
import { useCallback, useMemo, useRef, useState } from "react";
import type { MediaPlayerHandle } from "@/components/ae/MediaPlayer";
import { tcToSeconds } from "@/lib/nle/timecode";
import { previewSrcForClip } from "./media-url";
import type { Clip, EditDecision, UniversalTimeline } from "./types";

export interface PlayableSegment {
  decision: EditDecision;
  clip: Clip | undefined;
  /** ae-media:// URL, or null if this clip has no real, playable media yet. */
  src: string | null;
  sourceInSeconds: number;
  sourceOutSeconds: number;
}

function buildSegments(timeline: UniversalTimeline, clips: Clip[]): PlayableSegment[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  return timeline.decisions
    .filter((d) => d.lane !== "audio")
    .slice()
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
    .map((d) => {
      const clip = byId.get(d.clipId);
      const sourceInSeconds = tcToSeconds(d.sourceInTc, timeline.fps) ?? 0;
      const parsedOut = tcToSeconds(d.sourceOutTc, timeline.fps);
      const sourceOutSeconds = parsedOut !== null && parsedOut > sourceInSeconds ? parsedOut : sourceInSeconds + d.durationSeconds;
      return { decision: d, clip, src: previewSrcForClip(clip), sourceInSeconds, sourceOutSeconds };
    });
}

export function useTimelinePlayback(timeline: UniversalTimeline, clips: Clip[]) {
  const segments = useMemo(() => buildSegments(timeline, clips), [timeline, clips]);
  const hasPlayableMedia = segments.some((s) => s.src);

  const playerRef = useRef<MediaPlayerHandle | null>(null);
  const wantPlayingRef = useRef(false);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [pendingStart, setPendingStart] = useState(0);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const activeSegment = activeIndex !== null ? (segments[activeIndex] ?? null) : null;

  const nextPlayableIndex = useCallback(
    (from: number): number | null => {
      for (let i = from; i < segments.length; i++) {
        if (segments[i]!.src) return i;
      }
      return null;
    },
    [segments],
  );

  const goToSegment = useCallback((index: number, localStart: number) => {
    setActiveIndex(index);
    setPendingStart(localStart);
  }, []);

  const play = useCallback(() => {
    if (segments.length === 0) return;
    wantPlayingRef.current = true;
    if (activeIndex !== null && segments[activeIndex]?.src) {
      playerRef.current?.play();
      return;
    }
    const start = nextPlayableIndex(activeIndex ?? 0);
    if (start === null) return; // nothing in this timeline is playable
    goToSegment(start, segments[start]!.sourceInSeconds);
    // Actual play() fires from handleSegmentReady once the new src's metadata loads.
  }, [segments, activeIndex, nextPlayableIndex, goToSegment]);

  const pause = useCallback(() => {
    wantPlayingRef.current = false;
    playerRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  /** Seeks to an absolute position on the *timeline* (not within one clip). */
  const seek = useCallback(
    (globalSeconds: number) => {
      if (segments.length === 0) return;
      const clamped = Math.max(0, Math.min(globalSeconds, timeline.totalSeconds));
      let target = segments.findIndex(
        (s) =>
          clamped >= s.decision.timelineStartSeconds &&
          clamped < s.decision.timelineStartSeconds + s.decision.durationSeconds,
      );
      if (target === -1) {
        // In a gap or past the end — land on the last segment that starts at or
        // before this point, so scrubbing past the tail doesn't silently no-op.
        target = segments.reduce(
          (best, s, i) => (s.decision.timelineStartSeconds <= clamped ? i : best),
          0,
        );
      }
      const seg = segments[target]!;
      const local = Math.min(
        seg.sourceOutSeconds,
        Math.max(seg.sourceInSeconds, seg.sourceInSeconds + (clamped - seg.decision.timelineStartSeconds)),
      );
      setPlayheadSeconds(clamped);
      if (target === activeIndex && seg.src) {
        playerRef.current?.seek(local);
      } else {
        goToSegment(target, local);
      }
    },
    [segments, activeIndex, timeline.totalSeconds, goToSegment],
  );

  /** Wire to MediaPlayer's onTimeUpdate for the currently active segment. */
  const handleTimeUpdate = useCallback(
    (localSeconds: number) => {
      const seg = activeIndex !== null ? segments[activeIndex] : undefined;
      if (!seg) return;
      const global = seg.decision.timelineStartSeconds + Math.max(0, localSeconds - seg.sourceInSeconds);
      setPlayheadSeconds(global);
      if (localSeconds >= seg.sourceOutSeconds - 0.03) {
        const next = nextPlayableIndex(activeIndex! + 1);
        if (next !== null) {
          goToSegment(next, segments[next]!.sourceInSeconds);
        } else {
          wantPlayingRef.current = false;
          setPlayheadSeconds(timeline.totalSeconds);
        }
      }
    },
    [activeIndex, segments, nextPlayableIndex, goToSegment, timeline.totalSeconds],
  );

  /** Wire to MediaPlayer's onDurationChange — fires once the (possibly new) src
   * has real metadata loaded, which is the earliest point it's safe to call play(). */
  const handleSegmentReady = useCallback(() => {
    if (wantPlayingRef.current) playerRef.current?.play();
  }, []);

  const handlePlayStateChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const handleEnded = useCallback(() => {
    wantPlayingRef.current = false;
  }, []);

  return {
    segments,
    activeSegment,
    hasPlayableMedia,
    playerRef,
    pendingStart,
    playheadSeconds,
    isPlaying,
    play,
    pause,
    togglePlay,
    seek,
    handleTimeUpdate,
    handleSegmentReady,
    handlePlayStateChange,
    handleEnded,
  };
}

export type TimelinePlayback = ReturnType<typeof useTimelinePlayback>;
