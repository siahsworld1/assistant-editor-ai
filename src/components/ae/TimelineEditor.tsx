// The interactive CUT timeline (1.1). A view over the canonical schema-2
// Sequence (editor.sequence) — it never edits a Sequence itself:
//   - every gesture becomes an existing Step-4 command (src/lib/timeline/
//     gestures.ts), dry-run against the engine while the pointer is down for a
//     live preview, and committed as ONE transaction on release through
//     editor.dispatchTransaction (fork-on-edit, history and saving are the
//     store's — Step 5);
//   - nothing is written to the store while dragging, Escape cancels, and a
//     rejected proposal leaves the timeline exactly as it was;
//   - an edit pauses playback; the playback hook keeps the playhead on the
//     same sequence frame when the plan is rebuilt.
// Positions are integer sequence frames throughout; pixels only for drawing.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Link2,
  Loader2,
  Magnet,
  MousePointer2,
  Redo2,
  Scissors,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Filmstrip } from "@/components/ae/SourceVisuals";
import type { EditorApi } from "@/lib/ae/store";
import type { TimelinePlayback } from "@/lib/ae/timeline-playback";
import type { Clip } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import type { TypedCommand } from "@/lib/timeline/commands/types";
import type { MediaInventory } from "@/lib/timeline/invariants";
import {
  bladeFrame,
  linkRepresentatives,
  proposeMove,
  proposeTrim,
  snapThresholdFrames,
  splitAtPlayheadTargets,
  type Proposal,
  type SnapOptions,
} from "@/lib/timeline/gestures";
import { endFrame, expandLinked, sequenceEndFrame } from "@/lib/timeline/selectors";
import {
  fpsOf,
  frameToTc,
  framesToSeconds,
  secondsToFrames,
  tcClockSeconds,
} from "@/lib/timeline/time";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { ClipItem, Command, Sequence, Track } from "@/lib/timeline/types";
import { isTypingTarget } from "@/lib/ae/keyboard";
import { cn } from "@/lib/utils";

/** Rows top to bottom, as in an NLE. */
const ROWS = ["V2", "V1", "A1", "A2"] as const;
const ROW_LABEL: Record<(typeof ROWS)[number], string> = {
  V2: "V2 · B-roll",
  V1: "V1 · Interview",
  A1: "A1 · Interview audio",
  A2: "A2 · Audio",
};
/** A pointer must travel this far before a press becomes a drag. */
const DRAG_START_PX = 3;
/** Width of the trim handles at each end of a clip. */
const HANDLE_PX = 6;
const FALLBACK_WIDTH = 960;
const MIN_PX_PER_FRAME = 0.02;
const MAX_PX_PER_FRAME = 24;

type Tool = "select" | "blade";

interface Preview {
  proposal: Proposal;
  /** Where the dragged items would go, drawn even when the engine refuses. */
  ghosts: Array<{ id: string; start: number; end: number }>;
}

interface Gesture {
  kind: "move" | "trim";
  startX: number;
  dragging: boolean;
  itemIds: string[];
  itemId: string;
  edge: "in" | "out";
  propose: (dxFrames: number) => Preview;
  latest: Preview | null;
}

export function TimelineEditor({
  editor,
  playback,
  clips,
  className,
}: {
  editor: EditorApi;
  playback: Pick<TimelinePlayback, "playheadSeconds" | "seek" | "pause">;
  clips: Clip[];
  className?: string;
}) {
  const seq = editor.sequence;
  const media = useMemo<MediaInventory>(
    () => new Map(clips.map((c) => [c.id, { durationSeconds: c.durationSeconds }])),
    [clips],
  );
  const clipById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = useState<Tool>("select");
  const [snapping, setSnapping] = useState(true);
  const [pxPerFrame, setPxPerFrame] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const rate = seq?.rate ?? { num: 24, den: 1 };
  const playheadFrame = secondsToFrames(playback.playheadSeconds, rate);
  const endOfCut = seq ? sequenceEndFrame(seq) : 0;
  const viewFrames = Math.max(endOfCut, seq?.targetFrames ?? 0, fpsOf(rate) * 5);

  // Selection follows the Sequence: ids that no longer exist drop out.
  useEffect(() => {
    if (!seq) return;
    setSelected((cur) => {
      const kept = [...cur].filter((id) => seq.items[id]);
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [seq]);

  /* --------------------------------- zoom --------------------------------- */

  const fit = useCallback(() => {
    const width = scrollRef.current?.clientWidth || FALLBACK_WIDTH;
    const frames = Math.max(endOfCut, seq?.targetFrames ?? 0, 1);
    setPxPerFrame(Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, (width - 24) / frames)));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [endOfCut, seq?.targetFrames]);
  const zoom = useCallback(
    (factor: number) =>
      setPxPerFrame((p) => Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, p * factor))),
    [],
  );
  // Fit when a different sequence is shown (not after every edit: the view
  // must not jump under the pointer).
  const seqId = seq?.id ?? null;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    fitRef.current();
  }, [seqId]);

  /* ------------------------------ coordinates ----------------------------- */

  const frameAt = useCallback(
    (clientX: number) => {
      const left = contentRef.current?.getBoundingClientRect().left ?? 0;
      return Math.max(0, Math.round((clientX - left) / pxPerFrame));
    },
    [pxPerFrame],
  );
  const snapOptions = useCallback(
    (): SnapOptions => ({
      enabled: snapping,
      playheadFrame,
      threshold: snapThresholdFrames(pxPerFrame),
    }),
    [snapping, playheadFrame, pxPerFrame],
  );

  /* -------------------------------- commits ------------------------------- */

  const commit = useCallback(
    (label: string, build: (ids: EditorApi["ids"]) => TypedCommand[]): boolean => {
      playback.pause(); // never edit under a playing preview
      const ids = editor.ids;
      const cmds = build(ids) as unknown as Command[]; // typed builders → the log's shape
      const out = editor.dispatchTransaction(makeTransaction(ids, label, "manual", cmds));
      if (!out.ok) {
        setMessage(out.error.message);
        return false;
      }
      setMessage(null);
      return true;
    },
    [editor, playback],
  );

  /* ------------------------------- gestures ------------------------------- */

  const endGesture = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    gestureRef.current = null;
    setPreview(null);
  }, []);

  const beginGesture = useCallback(
    (g: Gesture) => {
      gestureRef.current = g;
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        const dx = ev.clientX - cur.startX;
        if (!cur.dragging && Math.abs(dx) < DRAG_START_PX) return;
        cur.dragging = true;
        const next = cur.propose(Math.round(dx / pxPerFrame));
        cur.latest = next;
        setPreview(next);
      };
      const onUp = () => {
        const cur = gestureRef.current;
        endGesture();
        if (!cur?.dragging || !cur.latest) return;
        const p = cur.latest.proposal;
        if (!p.ok) {
          setMessage(p.error.message);
          return;
        }
        if (p.sequence === seqRef.current) return; // no change
        commit(p.label, (ids) => [p.build(ids)]);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", endGesture);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", endGesture);
      };
    },
    [commit, endGesture, pxPerFrame],
  );
  useEffect(() => () => cleanupRef.current?.(), []);

  const seqRef = useRef(seq);
  seqRef.current = seq;

  const onItemPointerDown = (e: React.PointerEvent, item: ClipItem) => {
    if (!seq || e.button !== 0) return;
    e.stopPropagation();
    if (tool === "blade") {
      const at = bladeFrame(seq, item.id, frameAt(e.clientX), snapOptions());
      if (at === null) {
        setMessage("Click inside a clip to cut it.");
        return;
      }
      commit("Blade", (ids) => [commands.split(ids, seq, item.id, at)]);
      return;
    }
    const edgeAttr = (e.target as HTMLElement).closest?.("[data-edge]")?.getAttribute("data-edge");
    const edge = edgeAttr === "in" || edgeAttr === "out" ? edgeAttr : null;

    let ids: string[];
    if (e.shiftKey) {
      const next = new Set(selected);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      setSelected(next);
      if (!next.has(item.id)) return; // shift-click deselected it: no drag
      ids = [...next];
    } else if (selected.has(item.id) && !edge) {
      ids = [...selected];
    } else {
      setSelected(new Set([item.id]));
      ids = [item.id];
    }
    setMessage(null);
    const snap = snapOptions();

    if (edge) {
      const original = edge === "in" ? item.startFrame : endFrame(item);
      const partners = expandLinked(seq, [item.id]);
      beginGesture({
        kind: "trim",
        startX: e.clientX,
        dragging: false,
        itemIds: [item.id],
        itemId: item.id,
        edge,
        latest: null,
        propose: (dx) => {
          const proposal = proposeTrim(seq, item.id, edge, original + dx, snap, media);
          const edgeFrame = proposal.edgeFrame;
          return {
            proposal,
            ghosts: partners.map((id) => {
              const it = seq.items[id]!;
              return edge === "in"
                ? { id, start: Math.min(edgeFrame, endFrame(it) - 1), end: endFrame(it) }
                : { id, start: it.startFrame, end: Math.max(edgeFrame, it.startFrame + 1) };
            }),
          };
        },
      });
      return;
    }
    const moving = expandLinked(seq, ids);
    beginGesture({
      kind: "move",
      startX: e.clientX,
      dragging: false,
      itemIds: ids,
      itemId: item.id,
      edge: "in",
      latest: null,
      propose: (dx) => {
        const proposal = proposeMove(seq, ids, dx, snap, media);
        return {
          proposal,
          ghosts: moving.map((id) => {
            const it = seq.items[id]!;
            return {
              id,
              start: it.startFrame + proposal.deltaFrames,
              end: endFrame(it) + proposal.deltaFrames,
            };
          }),
        };
      },
    });
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.shiftKey) return;
    setSelected(new Set()); // empty space deselects
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !seq) return;
    const seekTo = (clientX: number) =>
      playback.seek(framesToSeconds(Math.min(frameAt(clientX), endOfCut), rate));
    seekTo(e.clientX);
    const onMove = (ev: PointerEvent) => seekTo(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* ------------------------------- keyboard ------------------------------- */

  const keyState = useRef({ seq, selected, playheadFrame, editor, commit, endGesture });
  keyState.current = { seq, selected, playheadFrame, editor, commit, endGesture };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const k = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const handled = () => e.preventDefault();

      if (key === "escape") {
        if (gestureRef.current) {
          k.endGesture();
          setMessage("Cancelled.");
        } else if (tool === "blade") setTool("select");
        else setSelected(new Set());
        handled();
        return;
      }
      if (gestureRef.current) return; // nothing else mid-drag
      if (mod && key === "z") {
        playback.pause();
        if (e.shiftKey) k.editor.redo();
        else k.editor.undo();
        handled();
        return;
      }
      if (mod && key === "k") {
        if (!k.seq) return;
        const targets = splitAtPlayheadTargets(k.seq, k.selected, k.playheadFrame);
        handled();
        if (!targets.length) {
          setMessage("Nothing to split at the playhead.");
          return;
        }
        const seqNow = k.seq;
        k.commit(targets.length > 1 ? "Split clips at playhead" : "Split at playhead", (ids) =>
          targets.map((id) => commands.split(ids, seqNow, id, k.playheadFrame)),
        );
        return;
      }
      if (mod || e.altKey) return;
      if (key === "delete" || key === "backspace") {
        if (!k.seq || !k.selected.size) return;
        const targets = linkRepresentatives(k.seq, k.selected);
        handled();
        const ok = e.shiftKey
          ? k.commit("Ripple delete", (ids) => [commands.rippleDelete(ids, targets)])
          : k.commit("Lift", (ids) => [commands.delete(ids, targets)]);
        if (ok) setSelected(new Set());
        return;
      }
      if (key === "b") {
        setTool((t) => (t === "blade" ? "select" : "blade"));
        handled();
      } else if (key === "v" || key === "a") {
        setTool("select");
        handled();
      } else if (key === "s") {
        setSnapping((s) => !s);
        handled();
      } else if (key === "=" || key === "+") {
        zoom(1.5);
        handled();
      } else if (key === "-") {
        zoom(1 / 1.5);
        handled();
      } else if (key === "\\") {
        fitRef.current();
        handled();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, playback, zoom]);

  /* -------------------------------- render -------------------------------- */

  if (!seq) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>No sequence to edit.</div>
    );
  }

  const shown = preview?.proposal.ok ? preview.proposal.sequence : seq;
  const ghostById = new Map((preview?.ghosts ?? []).map((g) => [g.id, g]));
  const invalid = !!preview && !preview.proposal.ok;
  const trackByName = new Map(seq.tracks.map((t) => [t.name, t]));
  const contentWidth = Math.ceil(viewFrames * pxPerFrame) + 160;
  const linkedToSelection = new Set(
    expandLinked(
      seq,
      [...selected].filter((id) => seq.items[id]),
    ),
  );
  const snappedTo = preview?.proposal.snappedTo ?? null;
  const px = (frames: number) => frames * pxPerFrame;
  const tickStep = rulerStep(pxPerFrame, fpsOf(rate));
  const ticks: number[] = [];
  for (let f = 0; f <= viewFrames + tickStep; f += tickStep) ticks.push(f);
  const status = editor.persistence;

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="timeline-editor"
      data-tool={tool}
      data-snapping={snapping ? "on" : "off"}
      data-px-per-frame={pxPerFrame}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <ToolButton
          active={tool === "select"}
          onClick={() => setTool("select")}
          title="Selection tool (V)"
          testId="tool-select"
        >
          <MousePointer2 className="size-3.5" />
        </ToolButton>
        <ToolButton
          active={tool === "blade"}
          onClick={() => setTool((t) => (t === "blade" ? "select" : "blade"))}
          title="Blade tool (B) — click a clip to cut it; ⌘K cuts at the playhead"
          testId="tool-blade"
        >
          <Scissors className="size-3.5" />
        </ToolButton>
        <ToolButton
          active={snapping}
          onClick={() => setSnapping((s) => !s)}
          title={`Snapping (S) — to the playhead and clip edges within ${snapThresholdFrames(pxPerFrame)} frame(s)`}
          testId="snap-toggle"
        >
          <Magnet className="size-3.5" />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          onClick={() => {
            playback.pause();
            editor.undo();
          }}
          disabled={!editor.canUndo}
          title={editor.nextUndoLabel ? `Undo ${editor.nextUndoLabel} (⌘Z)` : "Undo (⌘Z)"}
          testId="undo-button"
        >
          <Undo2 className="size-3.5" />
          {editor.nextUndoLabel && (
            <span className="max-w-[140px] truncate">Undo {editor.nextUndoLabel}</span>
          )}
        </ToolButton>
        <ToolButton
          onClick={() => {
            playback.pause();
            editor.redo();
          }}
          disabled={!editor.canRedo}
          title={editor.nextRedoLabel ? `Redo ${editor.nextRedoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
          testId="redo-button"
        >
          <Redo2 className="size-3.5" />
          {editor.nextRedoLabel && (
            <span className="max-w-[140px] truncate">Redo {editor.nextRedoLabel}</span>
          )}
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton onClick={() => zoom(1 / 1.5)} title="Zoom out (−)" testId="zoom-out">
          <ZoomOut className="size-3.5" />
        </ToolButton>
        <ToolButton onClick={() => zoom(1.5)} title="Zoom in (=)" testId="zoom-in">
          <ZoomIn className="size-3.5" />
        </ToolButton>
        <ToolButton onClick={fit} title="Zoom to fit (\)" testId="zoom-fit">
          Fit
        </ToolButton>
        <span
          className="ml-2 font-tc text-[11px] text-primary"
          data-testid="playhead-tc"
          title="Playhead (sequence timecode)"
        >
          {frameToTc(Math.min(playheadFrame, Math.max(endOfCut, 0)), rate)}
        </span>
        <span className="ml-auto" />
        <PersistenceStatus edited={editor.edited} status={status} onRetry={editor.retrySave} />
      </div>

      <div className="flex">
        <div className="w-[112px] shrink-0">
          <div className="h-6" />
          {ROWS.map((name) => (
            <div
              key={name}
              className={cn(
                "flex items-center font-tc text-[11px] text-muted-foreground",
                name.startsWith("V") ? "h-14" : "h-9",
                "mb-1",
              )}
            >
              {ROW_LABEL[name]}
            </div>
          ))}
        </div>
        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          data-testid="timeline-scroll"
        >
          <div ref={contentRef} className="relative" style={{ width: contentWidth }}>
            <div
              className="relative h-6 cursor-text border-b border-border"
              data-testid="timeline-ruler"
              onPointerDown={onRulerPointerDown}
            >
              {ticks.map((f) => (
                <span
                  key={f}
                  className="absolute top-0 h-full border-l border-border/70 pl-1 font-tc text-[10px] text-muted-foreground"
                  style={{ left: px(f) }}
                >
                  {frameToTc(f, rate).slice(3, 8)}
                </span>
              ))}
            </div>

            {ROWS.map((name) => {
              const track = trackByName.get(name);
              const items = track
                ? Object.values(shown.items).filter((i) => i.trackId === track.id)
                : [];
              return (
                <div
                  key={name}
                  data-testid={`track-row-${name}`}
                  data-track={name}
                  onPointerDown={onTrackPointerDown}
                  className={cn(
                    "hairline-grid relative mb-1 rounded border border-border bg-surface",
                    name.startsWith("V") ? "h-14" : "h-9",
                    tool === "blade" && "cursor-crosshair",
                  )}
                >
                  {track &&
                    items.map((item) => (
                      <TimelineItem
                        key={item.id}
                        item={item}
                        track={track}
                        clip={clipById.get(item.mediaClipId)}
                        sequenceRate={rate}
                        left={px(item.startFrame)}
                        width={px(item.durationFrames)}
                        selected={selected.has(item.id)}
                        linkedSelected={!selected.has(item.id) && linkedToSelection.has(item.id)}
                        blade={tool === "blade"}
                        onPointerDown={(e) => onItemPointerDown(e, item)}
                      />
                    ))}
                  {track &&
                    invalid &&
                    [...ghostById.values()]
                      .filter((g) => seq.items[g.id]?.trackId === track.id)
                      .map((g) => (
                        <div
                          key={`ghost-${g.id}`}
                          data-testid="timeline-ghost"
                          className="pointer-events-none absolute inset-y-1 rounded-sm border-2 border-dashed border-destructive bg-destructive/15"
                          style={{ left: px(g.start), width: Math.max(2, px(g.end - g.start)) }}
                        />
                      ))}
                </div>
              );
            })}

            {seq.targetFrames > 0 && seq.targetFrames < viewFrames + 1 && (
              <div
                className="pointer-events-none absolute bottom-0 top-6 w-px bg-primary/60"
                style={{ left: px(seq.targetFrames) }}
                title="Target duration"
              />
            )}
            {snappedTo !== null && (
              <div
                data-testid="snap-indicator"
                data-frame={snappedTo}
                className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary"
                style={{ left: px(snappedTo) }}
              />
            )}
            <div
              data-testid="playhead"
              data-frame={playheadFrame}
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-warning"
              style={{ left: px(playheadFrame) }}
            />
          </div>
        </div>
      </div>

      <div className="min-h-4 text-[11px]" data-testid="timeline-message" role="status">
        {preview && (
          <span className={invalid ? "text-destructive" : "text-muted-foreground"}>
            {preview.proposal.ok
              ? `${preview.proposal.label}${snappedTo !== null ? ` · snapped to ${frameToTc(snappedTo, rate)}` : ""}`
              : preview.proposal.error.message}
          </span>
        )}
        {!preview && message && <span className="text-destructive">{message}</span>}
      </div>
    </div>
  );
}

/** Ruler tick spacing in frames: the smallest "nice" step at least 64px wide. */
function rulerStep(pxPerFrame: number, fps: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const nominal = Math.max(1, Math.round(fps));
  for (const s of steps) if (s * nominal * pxPerFrame >= 64) return s * nominal;
  return 3600 * nominal;
}

function ToolButton({
  active,
  disabled,
  onClick,
  title,
  testId,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded border px-2 transition-colors disabled:opacity-40",
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PersistenceStatus({
  edited,
  status,
  onRetry,
}: {
  edited: boolean;
  status: EditorApi["persistence"];
  onRetry: () => void;
}) {
  if (!edited && status.status === "saved") return null;
  if (status.status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-destructive"
        data-testid="persistence-status"
        data-status="error"
        title={status.message ?? undefined}
      >
        <AlertTriangle className="size-3.5" /> Save failed
        <button
          type="button"
          className="rounded border border-destructive/50 px-1.5 py-0.5 hover:bg-destructive/10"
          data-testid="retry-save"
          onClick={onRetry}
        >
          Retry
        </button>
      </span>
    );
  }
  return status.status === "saving" ? (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground"
      data-testid="persistence-status"
      data-status="saving"
    >
      <Loader2 className="size-3.5 animate-spin" /> Saving…
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground"
      data-testid="persistence-status"
      data-status="saved"
    >
      <Check className="size-3.5" /> Saved
    </span>
  );
}

function TimelineItem({
  item,
  track,
  clip,
  sequenceRate,
  left,
  width,
  selected,
  linkedSelected,
  blade,
  onPointerDown,
}: {
  item: ClipItem;
  track: Track;
  clip: Clip | undefined;
  sequenceRate: Sequence["rate"];
  left: number;
  width: number;
  selected: boolean;
  linkedSelected: boolean;
  blade: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const video = track.kind === "video";
  const inSeconds = tcClockSeconds(item.sourceInFrame, item.mediaRate);
  const outSeconds = tcClockSeconds(item.sourceOutFrame, item.mediaRate);
  const name = clip?.filename ?? item.label;
  return (
    <div
      data-testid="timeline-item"
      data-item-id={item.id}
      data-track={track.name}
      data-start={item.startFrame}
      data-end={endFrame(item)}
      data-selected={selected ? "true" : "false"}
      title={`${name} · ${item.label} · ${frameToTc(item.sourceInFrame, item.mediaRate)}–${frameToTc(item.sourceOutFrame, item.mediaRate)}`}
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-1 select-none overflow-hidden rounded-sm border border-black/50",
        video
          ? "bg-black"
          : track.role === "dialogue-audio"
            ? "bg-lane-interview/70"
            : "bg-lane-audio",
        blade ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
        selected && "z-10 ring-2 ring-primary",
        linkedSelected && "ring-1 ring-primary/60",
        !item.enabled && "opacity-40",
      )}
      style={{ left, width: Math.max(2, width) }}
    >
      {video && (
        <Filmstrip
          clip={clip}
          inSeconds={inSeconds}
          outSeconds={outSeconds}
          count={Math.max(1, Math.min(6, Math.round(width / 80)))}
          className="pointer-events-none absolute inset-0 opacity-80"
        />
      )}
      <span
        className={cn(
          "pointer-events-none relative flex items-center gap-1 truncate px-1.5 pt-0.5 text-[10px] font-medium",
          video ? "text-white drop-shadow" : "text-black/85",
        )}
      >
        {item.linkGroupId && (
          <Link2
            className="size-3 shrink-0"
            aria-label="Linked video/audio"
            data-testid="link-indicator"
          />
        )}
        <span className="truncate">{name}</span>
      </span>
      {video && (
        <span className="pointer-events-none relative block truncate px-1.5 font-tc text-[9px] text-white/80 drop-shadow">
          {frameToTc(item.sourceInFrame, item.mediaRate)} ·{" "}
          {framesToSeconds(item.durationFrames, sequenceRate).toFixed(1)}s
        </span>
      )}
      {!blade && (
        <>
          <div
            data-edge="in"
            data-testid="trim-in"
            className="absolute inset-y-0 left-0 cursor-ew-resize hover:bg-primary/40"
            style={{ width: Math.min(HANDLE_PX, Math.max(2, width / 3)) }}
          />
          <div
            data-edge="out"
            data-testid="trim-out"
            className="absolute inset-y-0 right-0 cursor-ew-resize hover:bg-primary/40"
            style={{ width: Math.min(HANDLE_PX, Math.max(2, width / 3)) }}
          />
        </>
      )}
    </div>
  );
}
