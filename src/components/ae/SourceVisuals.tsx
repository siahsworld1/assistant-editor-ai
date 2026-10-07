// Real pictures of real source moments, for SELECTS / STORY / CUT.
//
// Every image here is an actual frame of the referenced clip at the referenced
// SOURCE time, extracted by the local engine (POST /frames — from the clip's
// proxy when it has one, cached on disk by the source's identity). Nothing is
// a stand-in: when a frame isn't available yet the slot shows a neutral
// placeholder, never another clip's image.
import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Play } from "lucide-react";
import { MediaPlayer, type MediaPlayerHandle } from "@/components/ae/MediaPlayer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAE } from "@/lib/ae/store";
import { mediaUrl, previewSrcForClip } from "@/lib/ae/media-url";
import type { Clip } from "@/lib/ae/types";
import { secondsToTc } from "@/lib/nle/timecode";
import { cn } from "@/lib/utils";

type Width = 160 | 240 | 320;

/** analysisId|clipId|t|width → ae-media URL ("" = engine said unavailable). */
const frameCache = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();

const key = (analysisId: string, clipId: string, t: number, w: Width) =>
  `${analysisId}|${clipId}|${t.toFixed(2)}|${w}`;

/** Frame URLs for `times` of one clip (aligned; null while loading/unavailable). */
export function useSourceFrames(
  clipId: string | undefined,
  times: number[],
  width: Width = 240,
): Array<string | null> {
  const { fetchFrames, project } = useAE();
  const analysisId = project?.analysisId ?? null;
  const [, setVersion] = useState(0);
  const timesKey = times.map((t) => t.toFixed(2)).join(",");

  useEffect(() => {
    if (!clipId || !analysisId || times.length === 0) return;
    const wanted = times.filter((t) => !frameCache.has(key(analysisId, clipId, t, width)));
    const missing = wanted.filter((t) => !inflight.has(key(analysisId, clipId, t, width)));
    let alive = true;
    if (missing.length > 0) {
      const job = fetchFrames(clipId, missing, width).then((frames) => {
        missing.forEach((t, i) => {
          const f = frames[i];
          frameCache.set(key(analysisId, clipId, t, width), f ? mediaUrl(f.relPath) : "");
          inflight.delete(key(analysisId, clipId, t, width));
        });
      });
      for (const t of missing) inflight.set(key(analysisId, clipId, t, width), job);
    }
    const pending = wanted
      .map((t) => inflight.get(key(analysisId, clipId, t, width)))
      .filter(Boolean);
    if (pending.length > 0) void Promise.all(pending).then(() => alive && setVersion((v) => v + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, analysisId, timesKey, width, fetchFrames]);

  if (!clipId || !analysisId) return times.map(() => null);
  return times.map((t) => frameCache.get(key(analysisId, clipId, t, width)) || null);
}

function FrameImage({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  return src ? (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      draggable={false}
      className={cn("h-full w-full object-cover", className)}
    />
  ) : (
    <div
      className={cn(
        "grid h-full w-full place-items-center bg-surface-raised text-muted-foreground",
        className,
      )}
    >
      <Film className="size-3.5 opacity-40" />
    </div>
  );
}

/** One real frame of `clip` at source `seconds`; clicking opens the source. */
export function SourceThumb({
  clip,
  seconds,
  className,
  onClick,
  label,
}: {
  clip: Clip | undefined;
  seconds: number;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
  label?: string | undefined;
}) {
  const src = useSourceFrames(clip?.id, [seconds], 240)[0] ?? null;
  const body = (
    <>
      <FrameImage src={src} alt={`${clip?.filename ?? "clip"} at ${seconds.toFixed(1)}s`} />
      {onClick && (
        <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100">
          <Play className="size-5 text-white drop-shadow" />
        </span>
      )}
      {label && (
        <span className="absolute bottom-0.5 right-1 rounded bg-black/60 px-1 font-tc text-[9px] text-white">
          {label}
        </span>
      )}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative aspect-video overflow-hidden rounded border border-border bg-black",
        className,
      )}
      title={`Preview ${clip?.filename ?? ""} from ${label ?? seconds.toFixed(1) + "s"}`}
    >
      {body}
    </button>
  ) : (
    <div
      className={cn(
        "relative aspect-video overflow-hidden rounded border border-border bg-black",
        className,
      )}
    >
      {body}
    </div>
  );
}

/** Evenly spaced real frames across a source range (a filmstrip). */
export function Filmstrip({
  clip,
  inSeconds,
  outSeconds,
  count,
  className,
}: {
  clip: Clip | undefined;
  inSeconds: number;
  outSeconds: number;
  count: number;
  className?: string;
}) {
  const times = useMemo(() => {
    const n = Math.max(1, Math.min(8, Math.round(count)));
    const span = Math.max(0, outSeconds - inSeconds);
    return Array.from({ length: n }, (_, i) => inSeconds + (span * (i + 0.5)) / n);
  }, [inSeconds, outSeconds, count]);
  const frames = useSourceFrames(clip?.id, times, 160);
  return (
    <div className={cn("flex h-full w-full", className)}>
      {frames.map((src, i) => (
        <div key={i} className="h-full min-w-0 flex-1 border-r border-black/40 last:border-r-0">
          <FrameImage src={src} alt="" />
        </div>
      ))}
    </div>
  );
}

export interface PreviewTarget {
  clip: Clip;
  inSeconds: number;
  outSeconds: number;
  title: string;
  subtitle?: string;
}

/** Plays the actual source moment (proxy or original) from its in-point. */
export function SourcePreviewDialog({
  target,
  onClose,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const playerRef = useRef<MediaPlayerHandle | null>(null);
  const [current, setCurrent] = useState(0);
  const src = target ? previewSrcForClip(target.clip) : null;
  const fps = target?.clip.fps || 24;

  useEffect(() => {
    if (target) setCurrent(target.inSeconds);
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle className="truncate text-sm">{target.title}</DialogTitle>
              <DialogDescription className="font-tc text-[11px]">
                {target.clip.filename} · source {secondsToTc(target.inSeconds, fps)} →{" "}
                {secondsToTc(target.outSeconds, fps)}
                {target.subtitle ? ` · ${target.subtitle}` : ""}
              </DialogDescription>
            </DialogHeader>
            {src ? (
              <MediaPlayer
                ref={playerRef}
                src={src}
                startAtSeconds={target.inSeconds}
                onDurationChange={() => playerRef.current?.play()}
                onTimeUpdate={(t) => {
                  setCurrent(t);
                  // Stop at the moment's out-point; the editor can still scrub on.
                  if (t >= target.outSeconds && t < target.outSeconds + 0.3)
                    playerRef.current?.pause();
                }}
              />
            ) : (
              <p className="text-xs text-muted-foreground">This clip has no playable media yet.</p>
            )}
            <div className="flex items-center justify-between font-tc text-[11px] text-muted-foreground">
              <span>
                Source TC <span className="text-primary">{secondsToTc(current, fps)}</span>
              </span>
              <span>{fps} fps</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const HAVE_CURRENT_DATA = 2;
/** A decoded frame this close to the cutaway's expected source time counts as
 * ready (CutawayOverlay's drift correction re-seeks beyond 0.25 s). */
const CUTAWAY_READY_TOLERANCE = 0.5;

/**
 * CUT's V2 layer: the b-roll cutaway that is on screen at the playhead, drawn
 * over the V1 player. Picture only (muted) — the interview's sync audio keeps
 * playing from V1 underneath, exactly as in the exported sequence.
 *
 * A cutaway stays transparent until it has a decoded frame at its own
 * position, so V1's picture shows through while it loads and seeks — the same
 * rule as the V1 double-buffer: never cover a valid frame with an unready
 * (black) element. Readiness is the media element's own state, reset for every
 * new cutaway.
 */
export function CutawayOverlay({
  overlay,
  playheadSeconds,
  playing,
}: {
  overlay: import("@/lib/ae/timeline-playback").PlayableSegment | null;
  playheadSeconds: number;
  playing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const expected = overlay
    ? overlay.sourceInSeconds + Math.max(0, playheadSeconds - overlay.decision.timelineStartSeconds)
    : 0;
  const expectedRef = useRef(expected);
  expectedRef.current = expected;
  const cutawayId = overlay?.decision.id ?? null;
  // The cutaway whose frame is decoded; any other (or none) is not ready yet.
  const [readyId, setReadyId] = useState<string | null>(null);
  // Every change of active cutaway — including leaving one and coming back to
  // it, which mounts a fresh <video> — starts unready.
  const [activeId, setActiveId] = useState<string | null>(cutawayId);
  if (activeId !== cutawayId) {
    setActiveId(cutawayId);
    setReadyId(null);
  }
  const ready = cutawayId !== null && activeId === cutawayId && readyId === cutawayId;
  const revealWhenDecoded = (v: HTMLVideoElement) => {
    if (
      v.readyState >= HAVE_CURRENT_DATA &&
      !v.seeking &&
      Math.abs(v.currentTime - expectedRef.current) <= CUTAWAY_READY_TOLERANCE
    ) {
      setReadyId(cutawayId);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !overlay) return;
    if (Math.abs(v.currentTime - expected) > 0.25) {
      try {
        v.currentTime = expected;
      } catch {
        /* not seekable yet — onLoadedMetadata will place it */
      }
    }
    if (playing && v.paused) void v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [overlay, expected, playing]);

  if (!overlay?.src) return null;
  return (
    <video
      key={overlay.decision.id}
      ref={videoRef}
      src={overlay.src}
      muted
      playsInline
      preload="auto"
      data-testid="cutaway-overlay"
      data-ready={ready ? "true" : "false"}
      // z-[2]: above SequencePlayer's visible V1 video (z-[1]); both share the
      // CUT preview wrapper's stacking context. Until its frame is decoded it
      // is fully transparent (no black backing), so V1 stays visible.
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-[2] aspect-video w-full rounded-md object-contain",
        ready ? "bg-black opacity-100" : "opacity-0",
      )}
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = expected;
        if (playing) void e.currentTarget.play().catch(() => {});
        revealWhenDecoded(e.currentTarget);
      }}
      onLoadedData={(e) => revealWhenDecoded(e.currentTarget)}
      onCanPlay={(e) => revealWhenDecoded(e.currentTarget)}
      onSeeked={(e) => revealWhenDecoded(e.currentTarget)}
    />
  );
}
