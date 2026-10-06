// CUT preview picture: two stacked <video> elements driven by the
// double-buffered SequenceBuffer (src/lib/ae/sequence-buffer.ts). Only the
// front one is visible and audible (the buffer owns muting); the other
// pre-rolls the next edit, so a cut never shows the black background between
// source clips.
import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { describeMediaError } from "@/components/ae/MediaPlayer";
import type { TimelinePlayback } from "@/lib/ae/timeline-playback";
import { cn } from "@/lib/utils";

export function SequencePlayer({
  playback,
  className,
}: {
  playback: TimelinePlayback;
  className?: string;
}) {
  const [error, setError] = useState<{ slot: 0 | 1; message: string } | null>(null);
  const visibleError = error && error.slot === playback.frontSlot ? error.message : null;

  const video = (slot: 0 | 1) => (
    <video
      key={slot}
      ref={slot === 0 ? playback.attachSlot0 : playback.attachSlot1}
      data-slot={slot}
      data-front={playback.frontSlot === slot ? "true" : "false"}
      className={cn(
        "absolute inset-0 h-full w-full object-contain",
        // Hidden, not removed: the back element must keep decoding.
        playback.frontSlot === slot ? "z-[1] opacity-100" : "z-0 opacity-0",
      )}
      preload="auto"
      playsInline
      onLoadedData={() => setError((e) => (e?.slot === slot ? null : e))}
      onError={(e) => setError({ slot, message: describeMediaError(e.currentTarget.error) })}
    />
  );

  return (
    <div
      className={cn(
        "relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-black",
        className,
      )}
    >
      {playback.hasPlayableMedia ? (
        <>
          {video(0)}
          {video(1)}
        </>
      ) : (
        <p className="px-6 text-center text-xs text-muted-foreground">
          No real media to preview yet.
        </p>
      )}
      {playback.waiting && !visibleError && (
        <div className="absolute inset-0 z-[2] grid place-items-center">
          <Loader2 className="size-6 animate-spin text-foreground/80" />
        </div>
      )}
      {visibleError && (
        <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-2 bg-black/85 px-6 text-center">
          <AlertTriangle className="size-5 text-warning" />
          <p className="text-xs text-foreground/85">{visibleError}</p>
        </div>
      )}
    </div>
  );
}
