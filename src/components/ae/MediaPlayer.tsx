// Real in-app video/audio preview. A plain <video> element underneath (Electron's
// renderer is just Chromium — no native player integration exists or is needed),
// with fully custom transport controls so playback matches this app's design
// system instead of the browser's native chrome. No `controls` attribute, no
// fake progress bar: every control here reflects the underlying element's real
// state (readyState, currentTime, duration, error).
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AlertTriangle, Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MediaPlayerHandle {
  play(): void;
  pause(): void;
  /** Seeks within the *current* src. No-op if nothing is loaded yet. */
  seek(seconds: number): void;
  getCurrentTime(): number;
  getDuration(): number;
}

export interface MediaPlayerProps {
  /** ae-media:// URL, or null when there's nothing real to preview yet. */
  src: string | null;
  /** Local (within-clip) time to start at whenever `src` changes. Default 0. */
  startAtSeconds?: number;
  className?: string;
  style?: CSSProperties;
  onTimeUpdate?: (currentTimeSeconds: number) => void;
  onDurationChange?: (durationSeconds: number) => void;
  onEnded?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
  /** Hides the built-in transport bar — used when an external controller (the
   * CUT page's timeline playhead) drives play/pause/seek instead. */
  hideControls?: boolean;
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** MediaError.code -> a human explanation, since the DOM's default is a bare number. */
function describeMediaError(err: MediaError | null): string {
  if (!err) return "Playback failed for an unknown reason.";
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was aborted.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "The preview file could not be read from disk.";
    case MediaError.MEDIA_ERR_DECODE:
      return "This file is corrupt or uses a codec this player can't decode.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This format isn't supported for inline preview. Re-run Analyze to generate a preview proxy for this clip.";
    default:
      return "Playback failed for an unknown reason.";
  }
}

export const MediaPlayer = forwardRef<MediaPlayerHandle, MediaPlayerProps>(function MediaPlayer(
  { src, startAtSeconds = 0, className, style, onTimeUpdate, onDurationChange, onEnded, onPlayStateChange, hideControls },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingStartRef = useRef(startAtSeconds);
  pendingStartRef.current = startAtSeconds;

  useImperativeHandle(
    ref,
    () => ({
      play: () => void videoRef.current?.play().catch(() => {}),
      pause: () => videoRef.current?.pause(),
      seek: (seconds: number) => {
        const el = videoRef.current;
        if (!el) return;
        try {
          el.currentTime = Math.max(0, seconds);
        } catch {
          /* not seekable yet (metadata not loaded) — ignored, matches native behavior */
        }
      },
      getCurrentTime: () => videoRef.current?.currentTime ?? 0,
      getDuration: () => videoRef.current?.duration ?? 0,
    }),
    [],
  );

  // A new src means a new clip: reset transport state and seek to the requested
  // start once metadata is available (a <video> can't seek before that).
  useEffect(() => {
    setError(null);
    setCurrentTime(pendingStartRef.current);
    setDuration(0);
    setLoading(Boolean(src));
  }, [src]);

  const notifyPlayState = (playing: boolean) => {
    setIsPlaying(playing);
    onPlayStateChange?.(playing);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)} style={style}>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-black">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            className="h-full w-full object-contain"
            preload="metadata"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              setDuration(el.duration || 0);
              onDurationChange?.(el.duration || 0);
              if (pendingStartRef.current > 0) {
                try {
                  el.currentTime = pendingStartRef.current;
                } catch {
                  /* ignore */
                }
              }
              setLoading(false);
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              setCurrentTime(t);
              onTimeUpdate?.(t);
            }}
            onPlay={() => notifyPlayState(true)}
            onPause={() => notifyPlayState(false)}
            onEnded={() => {
              notifyPlayState(false);
              onEnded?.();
            }}
            onWaiting={() => setLoading(true)}
            onPlaying={() => setLoading(false)}
            onError={(e) => {
              setLoading(false);
              setError(describeMediaError(e.currentTarget.error));
            }}
          />
        ) : (
          <p className="px-6 text-center text-xs text-muted-foreground">
            No real media to preview yet.
          </p>
        )}

        {loading && !error && src && (
          <div className="absolute inset-0 grid place-items-center bg-black/30">
            <Loader2 className="size-6 animate-spin text-foreground/80" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 px-6 text-center">
            <AlertTriangle className="size-5 text-warning" />
            <p className="text-xs text-foreground/85">{error}</p>
          </div>
        )}
      </div>

      {!hideControls && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              if (el.paused) void el.play().catch((err) => setError(String(err)));
              else el.pause();
            }}
            disabled={!src || Boolean(error)}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground disabled:opacity-40"
          >
            {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
          </button>
          <span className="font-tc w-9 shrink-0 text-[11px] text-muted-foreground">{fmt(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={Math.min(currentTime, duration || 0)}
            disabled={!src || !duration || Boolean(error)}
            onChange={(e) => {
              const el = videoRef.current;
              const t = Number(e.target.value);
              if (el) el.currentTime = t;
              setCurrentTime(t);
            }}
            className="h-1 flex-1 cursor-pointer accent-primary disabled:cursor-default"
          />
          <span className="font-tc w-9 shrink-0 text-[11px] text-muted-foreground">{fmt(duration)}</span>
        </div>
      )}
    </div>
  );
});
