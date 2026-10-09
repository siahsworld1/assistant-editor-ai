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
//
// Rendering: clip blocks are memoized, and every handler reads the latest
// state through one ref, so a pointer move or a playhead tick re-renders only
// the blocks whose props changed (the dragged ones), not the whole timeline.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  EyeOff,
  Link2,
  Loader2,
  Lock,
  Magnet,
  MousePointer2,
  Redo2,
  Scissors,
  ShieldCheck,
  Undo2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Filmstrip } from "@/components/ae/SourceVisuals";
import { isTypingTarget } from "@/lib/ae/keyboard";
import type { ProposalCompare, ProposalMark } from "@/lib/ae/proposal-preview";
import type { EditorApi } from "@/lib/ae/store";
import type { TimelinePlayback } from "@/lib/ae/timeline-playback";
import type { Clip } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import { analyzeCoverage } from "@/lib/timeline/coverage";
import { CUT_STATE_TEXT, cutState, type CutState } from "@/lib/ae/coverage-request";
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
import { fpsOf, frameToTc, framesToSeconds, tcClockSeconds } from "@/lib/timeline/time";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { ClipItem, Command, FrameRate, Sequence, Track } from "@/lib/timeline/types";
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
const HANDLE_PX = 8;
/** Dragging within this distance of the timeline's edge scrolls it. */
export const AUTO_SCROLL_EDGE_PX = 32;
/** Fastest auto-scroll, in pixels per animation frame. */
const AUTO_SCROLL_MAX_PX = 24;
const FALLBACK_WIDTH = 960;
const MIN_PX_PER_FRAME = 0.02;
const MAX_PX_PER_FRAME = 24;
const ZOOM_STEP = 1.5;
const PREVIEW_PAUSED = "Reviewing a Director proposal — accept or reject it before editing.";

type Tool = "select" | "blade";

/** What the timeline needs from the preview transport. */
export type TimelineTransport = Pick<
  TimelinePlayback,
  | "playheadSeconds"
  | "playheadFrame"
  | "endFrame"
  | "isPlaying"
  | "shuttleRate"
  | "seek"
  | "seekFrame"
  | "pause"
  | "togglePlay"
  | "shuttle"
>;

interface Preview {
  kind: "move" | "trim";
  proposal: Proposal;
  /** Where the dragged items would go, drawn even when the engine refuses. */
  ghosts: Array<{ id: string; start: number; end: number }>;
  /** Items the gesture moves only because they are linked to a dragged one. */
  linked: ReadonlySet<string>;
  /** The item the readout describes, its edge, and the frame offset. */
  itemId: string;
  edge: "in" | "out" | null;
  dxFrames: number;
  edgeFrame: number;
}

interface Gesture {
  /** The viewport's on-screen left edge and width, read once at press time. */
  left: number;
  width: number;
  startClientX: number;
  startFrame: number;
  lastClientX: number;
  lastDx: number | null;
  dragging: boolean;
  propose: (dxFrames: number) => Preview;
  latest: Preview | null;
  autoScroll: number;
}

export function TimelineEditor({
  editor,
  playback,
  clips,
  className,
  compare = null,
  onSelectionChange,
  showCoverage = false,
}: {
  editor: EditorApi;
  playback: TimelineTransport;
  clips: Clip[];
  className?: string;
  /** A Director proposal under review: draw this picture (current or
   * proposed), mark the affected clips, and pause editing until it is
   * accepted or rejected. Playback and navigation keep working. */
  compare?: ProposalCompare | null;
  /** Reports the selected clip ids (e.g. for "this clip" in a Director instruction). */
  onSelectionChange?: (ids: string[]) => void;
  /** Cover mode: mark potential jump cuts on the ruler with their coverage. */
  showCoverage?: boolean;
}) {
  const seq = editor.sequence;
  const readOnly = !!compare;
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
  const gestureRef = useRef<Gesture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** Set by keyboard navigation: bring the playhead into view once. */
  const revealRef = useRef(false);
  /** Set by zooming: the frame to keep under the same on-screen x. */
  const anchorRef = useRef<{ frame: number; px: number } | null>(null);
  /** The scroll viewport's width and offset, kept up to date by a
   * ResizeObserver and scroll events. Reading them from the DOM after a render
   * would force a synchronous layout of the whole page on every playhead tick,
   * zoom step and drag move — the main cost on long sequences. */
  const viewRef = useRef({ width: FALLBACK_WIDTH, scrollLeft: 0, contentWidth: 0 });
  const setScroll = useCallback((left: number) => {
    const { contentWidth, width } = viewRef.current;
    const v = Math.max(0, Math.min(left, contentWidth ? contentWidth - width : left));
    viewRef.current.scrollLeft = v;
    if (scrollRef.current) scrollRef.current.scrollLeft = v;
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    viewRef.current.width = el.clientWidth || FALLBACK_WIDTH; // once, on mount
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) viewRef.current.width = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rate: FrameRate = seq?.rate ?? { num: 24, den: 1 };
  const endOfCut = seq ? sequenceEndFrame(seq) : 0;
  const playheadFrame = Math.min(playback.playheadFrame, Math.max(endOfCut, 0));
  const viewFrames = Math.max(endOfCut, seq?.targetFrames ?? 0, fpsOf(rate) * 5);

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    onSelectionChangeRef.current?.([...selected]);
  }, [selected]);

  // Selection follows the Sequence: ids that no longer exist drop out.
  useEffect(() => {
    if (!seq) return;
    setSelected((cur) => {
      const kept = [...cur].filter((id) => seq.items[id]);
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [seq]);

  /* ------------------------- latest state, for handlers ------------------------ */

  const latest = useRef({
    seq,
    selected,
    tool,
    snapping,
    pxPerFrame,
    playheadFrame,
    endOfCut,
    editor,
    playback,
    media,
    readOnly,
  });
  latest.current = {
    seq,
    selected,
    tool,
    snapping,
    pxPerFrame,
    playheadFrame,
    endOfCut,
    editor,
    playback,
    media,
    readOnly,
  };

  /* --------------------------------- zoom --------------------------------- */

  const clampZoom = (p: number) => Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, p));
  const viewportWidth = () => viewRef.current.width;

  const fit = useCallback(() => {
    const L = latest.current;
    const frames = Math.max(L.endOfCut, L.seq?.targetFrames ?? 0, 1);
    anchorRef.current = { frame: 0, px: 0 };
    setPxPerFrame(clampZoom((viewportWidth() - 24) / frames));
  }, []);

  /** Zooms keeping one frame fixed on screen: the pointer's frame when given,
   * else the playhead when it is in view, else the middle of the view. */
  const zoomBy = useCallback((factor: number, clientX?: number) => {
    const el = scrollRef.current;
    const L = latest.current;
    const old = L.pxPerFrame;
    const width = viewportWidth();
    const scrollLeft = viewRef.current.scrollLeft;
    let anchor: { frame: number; px: number };
    if (clientX !== undefined) {
      const px = clientX - (el?.getBoundingClientRect().left ?? 0);
      anchor = { frame: (scrollLeft + px) / old, px };
    } else {
      const playheadPx = L.playheadFrame * old - scrollLeft;
      anchor =
        playheadPx >= 0 && playheadPx <= width
          ? { frame: L.playheadFrame, px: playheadPx }
          : { frame: (scrollLeft + width / 2) / old, px: width / 2 };
    }
    anchorRef.current = anchor;
    setPxPerFrame(clampZoom(old * factor));
  }, []);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    setScroll(a.frame * pxPerFrame - a.px);
  }, [pxPerFrame, setScroll]);

  // Fit when a different sequence is shown (not after every edit: the view
  // must not jump under the pointer).
  const seqId = seq?.id ?? null;
  useLayoutEffect(() => {
    fit();
  }, [seqId, fit]);

  // Pinch / ⌘-wheel zooms around the pointer; a plain wheel scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // Keep the playhead in view while playing / shuttling, and after keyboard
  // navigation. Never during a drag (the view must stay put under the pointer).
  useLayoutEffect(() => {
    if (!scrollRef.current || gestureRef.current) return;
    const moving = playback.isPlaying || playback.shuttleRate !== 0;
    if (!moving && !revealRef.current) return;
    revealRef.current = false;
    const { width, scrollLeft } = viewRef.current;
    const x = playheadFrame * pxPerFrame;
    const margin = Math.min(48, width / 8);
    const reverse = playback.shuttleRate < 0;
    if (x > scrollLeft + width - margin) {
      // Playing forward: page ahead, leaving the next stretch in view. A jump
      // (End, ⇧→): bring it in near the right, keeping what led up to it.
      setScroll(moving && !reverse ? x - width * 0.15 : x - width * 0.85);
    } else if (x < scrollLeft + (moving ? 0 : margin)) {
      setScroll(moving && reverse ? x - width * 0.85 : x - width * 0.15);
    }
  }, [playheadFrame, pxPerFrame, playback.isPlaying, playback.shuttleRate, setScroll]);

  /* ------------------------------ coordinates ----------------------------- */

  /** The viewport's left edge on screen (one layout read, at press time). */
  const viewportLeft = () => scrollRef.current?.getBoundingClientRect().left ?? 0;
  /** The (fractional) sequence frame under a client x, scroll included. */
  const frameAtExact = useCallback(
    (clientX: number, left: number = viewportLeft()) =>
      Math.max(0, (clientX - left + viewRef.current.scrollLeft) / latest.current.pxPerFrame),
    [],
  );
  const frameAt = useCallback(
    (clientX: number) => Math.round(frameAtExact(clientX)),
    [frameAtExact],
  );
  const snapOptions = (): SnapOptions => {
    const L = latest.current;
    return {
      enabled: L.snapping,
      playheadFrame: L.playheadFrame,
      threshold: snapThresholdFrames(L.pxPerFrame),
    };
  };

  /* -------------------------------- commits ------------------------------- */

  const commit = useCallback(
    (label: string, build: (ids: EditorApi["ids"]) => TypedCommand[]): boolean => {
      const { editor: ed, playback: pb } = latest.current;
      pb.pause(); // never edit under a playing preview
      const ids = ed.ids;
      const cmds = build(ids) as unknown as Command[]; // typed builders → the log's shape
      const out = ed.dispatchTransaction(makeTransaction(ids, label, "manual", cmds));
      if (!out.ok) {
        setMessage(out.error.message);
        return false;
      }
      setMessage(null);
      return true;
    },
    [],
  );

  /* ------------------------------- gestures ------------------------------- */

  const endGesture = useCallback(() => {
    const g = gestureRef.current;
    if (g?.autoScroll) cancelAnimationFrame(g.autoScroll);
    cleanupRef.current?.();
    cleanupRef.current = null;
    gestureRef.current = null;
    setPreview(null);
  }, []);

  /** Re-proposes for the pointer's current frame (only when it changed). */
  const updateGesture = useCallback(
    (g: Gesture) => {
      const dx = Math.round(frameAtExact(g.lastClientX, g.left) - g.startFrame);
      if (dx === g.lastDx) return;
      g.lastDx = dx;
      g.latest = g.propose(dx);
      setPreview(g.latest);
    },
    [frameAtExact],
  );

  /** While the pointer is near either edge, scroll and keep proposing. */
  const autoScroll = useCallback(
    (g: Gesture) => {
      if (!scrollRef.current || typeof requestAnimationFrame !== "function" || !g.width) return;
      const depth = () =>
        Math.max(
          AUTO_SCROLL_EDGE_PX - (g.lastClientX - g.left),
          AUTO_SCROLL_EDGE_PX - (g.left + g.width - g.lastClientX),
        );
      if (depth() <= 0) {
        if (g.autoScroll) cancelAnimationFrame(g.autoScroll);
        g.autoScroll = 0;
        return;
      }
      if (g.autoScroll) return;
      const step = () => {
        if (gestureRef.current !== g) return;
        const d = depth();
        if (d <= 0) {
          g.autoScroll = 0;
          return;
        }
        const towardsRight = g.lastClientX - g.left > g.width / 2;
        const speed = Math.ceil(
          (Math.min(d, AUTO_SCROLL_EDGE_PX) / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_PX,
        );
        setScroll(viewRef.current.scrollLeft + (towardsRight ? speed : -speed));
        updateGesture(g);
        g.autoScroll = requestAnimationFrame(step);
      };
      g.autoScroll = requestAnimationFrame(step);
    },
    [setScroll, updateGesture],
  );

  const beginGesture = useCallback(
    (g: Gesture) => {
      gestureRef.current = g;
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        cur.lastClientX = ev.clientX;
        if (!cur.dragging && Math.abs(ev.clientX - cur.startClientX) < DRAG_START_PX) return;
        cur.dragging = true;
        updateGesture(cur);
        autoScroll(cur);
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
        if (p.sequence === latest.current.seq) return; // no change
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
    [autoScroll, commit, endGesture, updateGesture],
  );
  useEffect(() => () => cleanupRef.current?.(), []);

  const onItemPointerDown = useCallback(
    (e: ReactPointerEvent, item: ClipItem) => {
      const L = latest.current;
      const s = L.seq;
      if (!s || e.button !== 0) return;
      e.stopPropagation();
      if (L.readOnly) {
        setMessage(PREVIEW_PAUSED);
        return;
      }
      if (L.tool === "blade") {
        const at = bladeFrame(s, item.id, frameAt(e.clientX), snapOptions());
        if (at === null) {
          setMessage("Click inside a clip to cut it.");
          return;
        }
        commit("Blade", (ids) => [commands.split(ids, s, item.id, at)]);
        return;
      }
      const edgeAttr = (e.target as HTMLElement)
        .closest?.("[data-edge]")
        ?.getAttribute("data-edge");
      const edge = edgeAttr === "in" || edgeAttr === "out" ? edgeAttr : null;
      const toggle = e.shiftKey || e.metaKey || e.ctrlKey;

      let ids: string[];
      if (toggle) {
        const next = new Set(L.selected);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        setSelected(next);
        if (!next.has(item.id)) return; // toggled off: no drag
        ids = edge ? [item.id] : [...next];
      } else if (L.selected.has(item.id) && !edge) {
        ids = [...L.selected];
      } else {
        setSelected(new Set([item.id]));
        ids = [item.id];
      }
      setMessage(null);
      const snap = snapOptions();
      const media = L.media;
      const rect = scrollRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const base: Omit<Gesture, "propose"> = {
        left,
        width: rect?.width || viewRef.current.width,
        startClientX: e.clientX,
        startFrame: frameAtExact(e.clientX, left),
        lastClientX: e.clientX,
        lastDx: null,
        dragging: false,
        latest: null,
        autoScroll: 0,
      };

      if (edge) {
        const original = edge === "in" ? item.startFrame : endFrame(item);
        const partners = expandLinked(s, [item.id]);
        const linked = new Set(partners.filter((id) => id !== item.id));
        beginGesture({
          ...base,
          propose: (dx) => {
            const proposal = proposeTrim(s, item.id, edge, original + dx, snap, media);
            const edgeFrame = proposal.edgeFrame;
            return {
              kind: "trim",
              proposal,
              linked,
              itemId: item.id,
              edge,
              dxFrames: edgeFrame - original,
              edgeFrame,
              ghosts: partners.map((id) => {
                const it = s.items[id]!;
                return edge === "in"
                  ? { id, start: Math.min(edgeFrame, endFrame(it) - 1), end: endFrame(it) }
                  : { id, start: it.startFrame, end: Math.max(edgeFrame, it.startFrame + 1) };
              }),
            };
          },
        });
        return;
      }
      const moving = expandLinked(s, ids);
      const direct = new Set(ids);
      const linked = new Set(moving.filter((id) => !direct.has(id)));
      beginGesture({
        ...base,
        propose: (dx) => {
          const proposal = proposeMove(s, ids, dx, snap, media);
          return {
            kind: "move",
            proposal,
            linked,
            itemId: item.id,
            edge: null,
            dxFrames: proposal.deltaFrames,
            edgeFrame: item.startFrame + proposal.deltaFrames,
            ghosts: moving.map((id) => {
              const it = s.items[id]!;
              return {
                id,
                start: it.startFrame + proposal.deltaFrames,
                end: endFrame(it) + proposal.deltaFrames,
              };
            }),
          };
        },
      });
    },
    [beginGesture, commit, frameAt, frameAtExact],
  );

  const onTrackPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || latest.current.readOnly) return;
    setSelected(new Set()); // empty space deselects
  }, []);

  /** Scrubbing: one seek per animation frame, on whole frames. */
  const onRulerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const L = latest.current;
      if (e.button !== 0 || !L.seq) return;
      if (L.playback.isPlaying || L.playback.shuttleRate !== 0) L.playback.pause();
      let pendingX: number | null = null;
      let raf = 0;
      const seekTo = (clientX: number) =>
        latest.current.playback.seekFrame(Math.min(frameAt(clientX), latest.current.endOfCut));
      seekTo(e.clientX);
      const onMove = (ev: PointerEvent) => {
        pendingX = ev.clientX;
        if (raf || typeof requestAnimationFrame !== "function") {
          if (!raf) seekTo(ev.clientX);
          return;
        }
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pendingX !== null) seekTo(pendingX);
        });
      };
      const onUp = (ev: PointerEvent) => {
        if (raf) cancelAnimationFrame(raf);
        seekTo(ev.clientX);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [frameAt],
  );

  /* ------------------------------ protection ------------------------------ */

  /** Locks / AI-protects the selection (linked partners follow) — one
   * undoable filmmaker transaction (SetProtection). */
  const setSelectionProtection = useCallback(
    (field: "locked" | "aiLocked", value: boolean) => {
      const { seq: s, selected: sel } = latest.current;
      if (!s || !sel.size) return;
      const targets = linkRepresentatives(s, sel);
      const label =
        field === "locked"
          ? value
            ? "Lock clips"
            : "Unlock clips"
          : value
            ? "Protect from AI"
            : "Allow AI changes";
      commit(label, (ids) => [commands.setProtection(ids, targets, { [field]: value })]);
    },
    [commit],
  );

  /* ------------------------------- keyboard ------------------------------- */

  useEffect(() => {
    const stepPlayhead = (to: number) => {
      const { playback: pb, endOfCut: end } = latest.current;
      if (pb.isPlaying || pb.shuttleRate !== 0) pb.pause();
      revealRef.current = true;
      pb.seekFrame(Math.max(0, Math.min(to, end)));
    };
    const nudge = (frames: number) => {
      const { seq: s, selected: sel } = latest.current;
      if (!s || !sel.size) {
        setMessage("Select a clip to nudge it.");
        return;
      }
      const targets = linkRepresentatives(s, sel);
      commit(
        Math.abs(frames) > 1 ? `Nudge ${frames > 0 ? "+" : "−"}${Math.abs(frames)}` : "Nudge",
        (ids) => [commands.move(ids, targets, frames)],
      );
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const L = latest.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const handled = () => e.preventDefault();

      if (key === "Escape") {
        if (gestureRef.current) {
          endGesture();
          setMessage("Cancelled.");
        } else if (L.tool === "blade") setTool("select");
        else setSelected(new Set());
        handled();
        return;
      }
      if (gestureRef.current) return; // nothing else mid-drag
      // While a proposal is under review, editing keys are paused (playback,
      // navigation, zoom and snapping keep working).
      const editingKey =
        (mod && (key === "z" || key === "k")) ||
        key === "Delete" ||
        key === "Backspace" ||
        ((key === "ArrowLeft" || key === "ArrowRight") && e.altKey) ||
        (!mod && (key === "b" || key === "v" || key === "a"));
      if (L.readOnly && editingKey) {
        setMessage(PREVIEW_PAUSED);
        handled();
        return;
      }
      if (mod && key === "z") {
        L.playback.pause();
        if (e.shiftKey) L.editor.redo();
        else L.editor.undo();
        handled();
        return;
      }
      if (mod && key === "k") {
        handled();
        if (!L.seq) return;
        const targets = splitAtPlayheadTargets(L.seq, L.selected, L.playheadFrame);
        if (!targets.length) {
          setMessage("Nothing to split at the playhead.");
          return;
        }
        const s = L.seq;
        const at = L.playheadFrame;
        commit(targets.length > 1 ? "Split clips at playhead" : "Split at playhead", (ids) =>
          targets.map((id) => commands.split(ids, s, id, at)),
        );
        return;
      }
      if (mod) return;

      // Transport and navigation.
      if (key === " " && !e.altKey) {
        L.playback.togglePlay();
        handled();
        return;
      }
      if ((key === "ArrowLeft" || key === "ArrowRight") && !e.altKey) {
        const n = (e.shiftKey ? 10 : 1) * (key === "ArrowLeft" ? -1 : 1);
        stepPlayhead(L.playheadFrame + n);
        handled();
        return;
      }
      if ((key === "ArrowLeft" || key === "ArrowRight") && e.altKey) {
        nudge((e.shiftKey ? 10 : 1) * (key === "ArrowLeft" ? -1 : 1));
        handled();
        return;
      }
      if (key === "Home" || key === "End") {
        stepPlayhead(key === "Home" ? 0 : L.endOfCut);
        handled();
        return;
      }
      if (e.altKey) return;
      if (key === "j" || key === "l") {
        L.playback.shuttle(key === "j" ? -1 : 1);
        handled();
        return;
      }
      if (key === "k") {
        L.playback.pause();
        handled();
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        if (!L.seq || !L.selected.size) return;
        const targets = linkRepresentatives(L.seq, L.selected);
        handled();
        const ok = e.shiftKey
          ? commit("Ripple delete", (ids) => [commands.rippleDelete(ids, targets)])
          : commit("Lift", (ids) => [commands.delete(ids, targets)]);
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
        zoomBy(ZOOM_STEP);
        handled();
      } else if (key === "-") {
        zoomBy(1 / ZOOM_STEP);
        handled();
      } else if (key === "\\") {
        fit();
        handled();
      }
    };
    // A focused button must not also "click" on the Space we just used.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [commit, endGesture, fit, zoomBy]);

  /* -------------------------------- render -------------------------------- */

  const shown = compare ? compare.sequence : preview?.proposal.ok ? preview.proposal.sequence : seq;
  const itemsByTrack = useMemo(() => {
    const m = new Map<string, ClipItem[]>();
    for (const it of Object.values(shown?.items ?? {})) {
      const list = m.get(it.trackId);
      if (list) list.push(it);
      else m.set(it.trackId, [it]);
    }
    return m;
  }, [shown]);
  const linkedToSelection = useMemo(
    () =>
      seq
        ? new Set(
            expandLinked(
              seq,
              [...selected].filter((id) => seq.items[id]),
            ),
          )
        : new Set<string>(),
    [seq, selected],
  );

  // Cover mode's markers, for the picture on screen (current or proposed).
  const coverageMarks = useMemo(
    () =>
      showCoverage && shown
        ? analyzeCoverage(shown, "view")
            .cuts.filter((c) => c.kind === "jump")
            .map((c) => ({ cut: c, state: cutState(c) }))
        : [],
    [showCoverage, shown],
  );

  if (!seq || !shown) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>No sequence to edit.</div>
    );
  }

  const ghostById = new Map((preview?.ghosts ?? []).map((g) => [g.id, g]));
  const invalid = !!preview && !preview.proposal.ok;
  const trackByName = new Map(seq.tracks.map((t) => [t.name, t]));
  const contentWidth = Math.ceil(viewFrames * pxPerFrame) + 160;
  viewRef.current.contentWidth = contentWidth;
  const snappedTo = preview?.proposal.snappedTo ?? null;
  const px = (frames: number) => frames * pxPerFrame;
  const tickStep = rulerStep(pxPerFrame, fpsOf(rate));
  const ticks: number[] = [];
  for (let f = 0; f <= viewFrames + tickStep; f += tickStep) ticks.push(f);
  const shuttle = playback.shuttleRate;
  const selectedItems = [...selected].map((id) => seq.items[id]).filter((i): i is ClipItem => !!i);
  const selectionLocked = !!selectedItems.length && selectedItems.every((i) => i.protection.locked);
  const selectionAiLocked =
    !!selectedItems.length && selectedItems.every((i) => i.protection.aiLocked);

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
          disabled={readOnly || !editor.canUndo}
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
          disabled={readOnly || !editor.canRedo}
          title={editor.nextRedoLabel ? `Redo ${editor.nextRedoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
          testId="redo-button"
        >
          <Redo2 className="size-3.5" />
          {editor.nextRedoLabel && (
            <span className="max-w-[140px] truncate">Redo {editor.nextRedoLabel}</span>
          )}
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton onClick={() => zoomBy(1 / ZOOM_STEP)} title="Zoom out (−)" testId="zoom-out">
          <ZoomOut className="size-3.5" />
        </ToolButton>
        <ToolButton onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in (=)" testId="zoom-in">
          <ZoomIn className="size-3.5" />
        </ToolButton>
        <ToolButton onClick={fit} title="Zoom to fit (\)" testId="zoom-fit">
          Fit
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          active={selectionLocked}
          disabled={readOnly || !selectedItems.length}
          onClick={() => setSelectionProtection("locked", !selectionLocked)}
          title={
            selectionLocked
              ? "Unlock the selected clips (and their linked audio)"
              : "Lock the selected clips (and their linked audio) — no one can change them"
          }
          testId="lock-toggle"
        >
          <Lock className="size-3.5" />
          {selectionLocked ? "Locked" : "Lock"}
        </ToolButton>
        <ToolButton
          active={selectionAiLocked}
          disabled={readOnly || !selectedItems.length}
          onClick={() => setSelectionProtection("aiLocked", !selectionAiLocked)}
          title={
            selectionAiLocked
              ? "Allow the Director to change the selected clips again"
              : "Protect the selected clips (and their linked audio) from Director changes"
          }
          testId="ai-protect-toggle"
        >
          <ShieldCheck className="size-3.5" />
          {selectionAiLocked ? "AI-protected" : "AI-protect"}
        </ToolButton>
        <span
          className="ml-2 font-tc text-[11px] text-primary"
          data-testid="playhead-tc"
          title="Playhead (sequence timecode) — ←/→ frame, ⇧←/→ 10 frames, Home/End"
        >
          {frameToTc(playheadFrame, rate)}
        </span>
        {shuttle !== 0 && (
          <span className="font-tc text-[11px] text-warning" data-testid="shuttle-rate">
            {shuttle > 0 ? "▶" : "◀"} {Math.abs(shuttle)}×
          </span>
        )}
        <span className="ml-auto" />
        <PersistenceStatus
          edited={editor.edited}
          status={editor.persistence}
          onRetry={editor.retrySave}
        />
      </div>

      {compare && (
        <div
          data-testid="proposal-banner"
          data-mode={compare.mode}
          className="rounded border border-warning/50 bg-warning/10 px-3 py-1.5 text-[11px] text-foreground"
        >
          {compare.mode === "after"
            ? "Showing the Director's PROPOSED cut — highlighted clips change, dashed outlines are removed. Editing is paused."
            : "Showing the ORIGINAL cut — highlighted clips are what the proposal would change. Editing is paused."}
        </div>
      )}

      {showCoverage && (
        <div
          data-testid="coverage-legend"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
        >
          <span>Potential jump cuts (same interview take — not a confirmed defect):</span>
          {(Object.keys(CUT_STATE_TEXT) as CutState[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={cn("inline-block size-2 rotate-45 border", MARK_CLASS[k])} />
              {CUT_STATE_TEXT[k]}
            </span>
          ))}
        </div>
      )}

      <div className="flex">
        <div className="w-[112px] shrink-0">
          <div className="h-6" />
          {ROWS.map((name) => (
            <TrackHeader
              key={name}
              name={name}
              track={trackByName.get(name)}
              count={itemsByTrack.get(trackByName.get(name)?.id ?? "")?.length ?? 0}
            />
          ))}
        </div>
        <div
          ref={scrollRef}
          onScroll={(e) => {
            viewRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          data-testid="timeline-scroll"
        >
          <div className="relative" style={{ width: contentWidth }}>
            <div
              className="relative h-6 cursor-text touch-none select-none border-b border-border"
              data-testid="timeline-ruler"
              onPointerDown={onRulerPointerDown}
            >
              {coverageMarks.map(({ cut, state }) => (
                <span
                  key={cut.id}
                  data-testid="coverage-marker"
                  data-state={state}
                  data-frame={cut.frame}
                  role="img"
                  aria-label={`Potential jump cut at ${cut.tc}: ${CUT_STATE_TEXT[state]}`}
                  title={`Potential jump cut at ${cut.tc} (same interview take; not visually verified): ${CUT_STATE_TEXT[state]}${state === "blocked" ? ` — ${cut.blockers.map((b) => b.message).join(" ")}` : ""}`}
                  className={cn(
                    "pointer-events-none absolute bottom-0.5 z-10 size-2 -translate-x-1/2 rotate-45 border",
                    MARK_CLASS[state],
                  )}
                  style={{ left: px(cut.frame) }}
                />
              ))}
              {ticks.map((f) => (
                <span
                  key={f}
                  className="pointer-events-none absolute top-0 h-full border-l border-border/70 pl-1 font-tc text-[10px] text-muted-foreground"
                  style={{ left: px(f) }}
                >
                  {frameToTc(f, rate).slice(3, 8)}
                </span>
              ))}
            </div>

            {ROWS.map((name) => {
              const track = trackByName.get(name);
              const items = track ? (itemsByTrack.get(track.id) ?? []) : [];
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
                    track?.hidden && "opacity-50",
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
                        pxPerFrame={pxPerFrame}
                        selected={selected.has(item.id)}
                        linkedSelected={!selected.has(item.id) && linkedToSelection.has(item.id)}
                        affected={!!preview && preview.linked.has(item.id)}
                        blade={tool === "blade" && !readOnly}
                        mark={compare?.marks.get(item.id) ?? null}
                        readOnly={readOnly}
                        onPointerDown={onItemPointerDown}
                      />
                    ))}
                  {track &&
                    compare?.removed
                      .filter((r) => r.trackId === track.id)
                      .map((r) => (
                        <div
                          key={`removed-${r.id}`}
                          data-testid="proposal-removed"
                          data-item-id={r.id}
                          title={`Removed by the proposal: ${r.label}`}
                          className="pointer-events-none absolute inset-y-1 rounded-sm border-2 border-dashed border-destructive/80 bg-destructive/10"
                          style={{
                            left: px(r.startFrame),
                            width: Math.max(2, px(r.durationFrames)),
                          }}
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
                className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-primary will-change-transform"
                style={{ transform: `translateX(${px(snappedTo)}px)` }}
              />
            )}
            {preview && (
              <GestureReadout
                preview={preview}
                seq={seq}
                left={px(preview.edgeFrame)}
                align={readoutAlign(px(preview.edgeFrame), viewRef.current)}
              />
            )}
            <div
              data-testid="playhead"
              data-frame={playheadFrame}
              // Its own compositor layer, moved by transform: a moving playhead
              // never re-rasterizes the clip blocks underneath it (on a long cut
              // that re-raster stalled frames for hundreds of milliseconds).
              className="pointer-events-none absolute inset-y-0 left-0 z-30 w-px bg-warning will-change-transform"
              style={{ transform: `translateX(${px(playheadFrame)}px)` }}
            />
          </div>
        </div>
      </div>

      <div className="min-h-4 text-[11px]" data-testid="timeline-message" role="status">
        {preview && (
          <span className={invalid ? "text-destructive" : "text-muted-foreground"}>
            {preview.proposal.ok
              ? `${preview.proposal.label}${preview.linked.size ? ` · linked audio follows (${preview.linked.size})` : ""}${snappedTo !== null ? ` · snapped to ${frameToTc(snappedTo, rate)}` : ""}`
              : preview.proposal.error.message}
          </span>
        )}
        {!preview && message && (
          <span className="inline-flex items-center gap-1 text-destructive" role="alert">
            <AlertTriangle className="size-3.5" />
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

/** Ruler tick spacing in frames: the smallest "nice" step at least 64px wide. */
const MARK_CLASS: Record<CutState, string> = {
  uncovered: "border-warning bg-warning",
  partial: "border-warning bg-background",
  covered: "border-positive bg-positive",
  blocked: "border-destructive bg-destructive/40",
};

function rulerStep(pxPerFrame: number, fps: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const nominal = Math.max(1, Math.round(fps));
  for (const s of steps) if (s * nominal * pxPerFrame >= 64) return s * nominal;
  return 3600 * nominal;
}

/** Keeps the readout on screen: it grows away from the nearer viewport edge. */
function readoutAlign(
  x: number,
  view: { scrollLeft: number; width: number },
): "start" | "center" | "end" {
  const rel = (x - view.scrollLeft) / Math.max(1, view.width);
  return rel > 0.7 ? "end" : rel < 0.3 ? "start" : "center";
}

/** Frame-accurate feedback beside the dragged edge: the sequence position,
 * the source timecode it lands on, the change in frames — or why not. */
function GestureReadout({
  preview,
  seq,
  left,
  align,
}: {
  preview: Preview;
  seq: Sequence;
  left: number;
  align: "start" | "center" | "end";
}) {
  const p = preview.proposal;
  const sign = preview.dxFrames > 0 ? "+" : preview.dxFrames < 0 ? "−" : "±";
  const delta = `${sign}${Math.abs(preview.dxFrames)}f`;
  let text: string;
  if (!p.ok) {
    text = p.error.message;
  } else {
    const it = p.sequence.items[preview.itemId]!;
    if (preview.kind === "trim") {
      const src =
        preview.edge === "in"
          ? `In ${frameToTc(it.sourceInFrame, it.mediaRate)}`
          : `Out ${frameToTc(it.sourceOutFrame, it.mediaRate)}`;
      text = `${src} · ${frameToTc(preview.edgeFrame, seq.rate)} · ${delta} · ${it.durationFrames}f`;
    } else {
      text = `${frameToTc(it.startFrame, seq.rate)} · ${delta}`;
    }
  }
  return (
    <div
      data-testid="gesture-readout"
      data-valid={p.ok ? "true" : "false"}
      className={cn(
        "pointer-events-none absolute top-6 z-40 -translate-y-full whitespace-nowrap rounded border px-1.5 py-0.5 font-tc text-[10px] shadow",
        align === "center" ? "-translate-x-1/2" : align === "end" ? "-translate-x-full" : "",
        p.ok
          ? "border-primary/50 bg-background text-foreground"
          : "border-destructive bg-destructive/90 text-destructive-foreground",
      )}
      style={{ left }}
    >
      {text}
    </div>
  );
}

function TrackHeader({
  name,
  track,
  count,
}: {
  name: (typeof ROWS)[number];
  track: Track | undefined;
  count: number;
}) {
  const locked = !!track?.protection.locked;
  const aiLocked = !!track?.protection.aiLocked;
  return (
    <div
      data-testid={`track-header-${name}`}
      className={cn(
        "mb-1 flex flex-col justify-center pr-2 font-tc text-[11px] text-muted-foreground",
        name.startsWith("V") ? "h-14" : "h-9",
      )}
    >
      <span className="flex items-center gap-1">
        <span className="truncate">{ROW_LABEL[name]}</span>
        {locked && <Lock className="size-3 shrink-0" aria-label="Track locked" />}
        {!locked && aiLocked && (
          <ShieldCheck className="size-3 shrink-0" aria-label="Protected from Director changes" />
        )}
        {track?.hidden && <EyeOff className="size-3 shrink-0" aria-label="Hidden" />}
        {track?.muted && <VolumeX className="size-3 shrink-0" aria-label="Muted" />}
      </span>
      {name.startsWith("V") && (
        <span className="text-[10px] text-muted-foreground/70">{count} clips</span>
      )}
    </div>
  );
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
  children: ReactNode;
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

/** One clip block. Memoized: re-renders only when its own props change. */
const TimelineItem = memo(function TimelineItem({
  item,
  track,
  clip,
  sequenceRate,
  pxPerFrame,
  selected,
  linkedSelected,
  affected,
  blade,
  mark = null,
  readOnly = false,
  onPointerDown,
}: {
  item: ClipItem;
  track: Track;
  clip: Clip | undefined;
  sequenceRate: FrameRate;
  pxPerFrame: number;
  selected: boolean;
  linkedSelected: boolean;
  affected: boolean;
  blade: boolean;
  /** How a proposal under review affects this clip. */
  mark?: ProposalMark | null;
  readOnly?: boolean;
  onPointerDown: (e: ReactPointerEvent, item: ClipItem) => void;
}) {
  const video = track.kind === "video";
  const left = item.startFrame * pxPerFrame;
  const width = item.durationFrames * pxPerFrame;
  const name = clip?.filename ?? item.label;
  const locked = item.protection.locked || track.protection.locked;
  const aiLocked = item.protection.aiLocked || track.protection.aiLocked;
  const handle = Math.min(HANDLE_PX, Math.max(2, width / 4));
  const inSeconds = useMemo(
    () => tcClockSeconds(item.sourceInFrame, item.mediaRate),
    [item.sourceInFrame, item.mediaRate],
  );
  const outSeconds = useMemo(
    () => tcClockSeconds(item.sourceOutFrame, item.mediaRate),
    [item.sourceOutFrame, item.mediaRate],
  );
  return (
    <div
      data-testid="timeline-item"
      data-item-id={item.id}
      data-track={track.name}
      data-start={item.startFrame}
      data-end={endFrame(item)}
      data-selected={selected ? "true" : "false"}
      data-linked={linkedSelected ? "true" : "false"}
      data-affected={affected ? "linked" : undefined}
      data-locked={locked ? "true" : aiLocked ? "ai" : undefined}
      data-proposal={mark ?? undefined}
      title={`${name} · ${item.label} · ${frameToTc(item.sourceInFrame, item.mediaRate)}–${frameToTc(item.sourceOutFrame, item.mediaRate)}${locked ? " · locked" : ""}`}
      onPointerDown={(e) => onPointerDown(e, item)}
      className={cn(
        "group absolute inset-y-1 touch-none select-none overflow-hidden rounded-sm border border-black/50",
        video
          ? "bg-black"
          : track.role === "dialogue-audio"
            ? "bg-lane-interview/70"
            : "bg-lane-audio",
        readOnly
          ? "cursor-default"
          : locked
            ? "cursor-not-allowed"
            : blade
              ? "cursor-crosshair"
              : "cursor-grab active:cursor-grabbing",
        // Selected: solid ring. Linked to a selection, or carried along by a
        // gesture: dashed outline — never mistaken for a selection.
        selected && "z-10 ring-2 ring-primary",
        (linkedSelected || affected) &&
          "outline-dashed outline-1 outline-offset-[-2px] outline-primary",
        !item.enabled && "opacity-40",
        // A proposal under review: what it changes / adds / removes, or the
        // protected clip it was refused for.
        mark === "changed" && "z-10 ring-2 ring-warning",
        mark === "added" && "z-10 ring-2 ring-warning ring-offset-1 ring-offset-background",
        mark === "removed" && "z-10 opacity-60 ring-2 ring-destructive",
        mark === "blocked" && "z-10 ring-2 ring-destructive",
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
          "pointer-events-none relative flex items-center gap-1 truncate px-2 pt-0.5 text-[10px] font-medium",
          video ? "text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]" : "text-black/85",
        )}
      >
        {item.linkGroupId && (
          <Link2
            className="size-3 shrink-0"
            aria-label="Linked video/audio"
            data-testid="link-indicator"
          />
        )}
        {locked && (
          <Lock className="size-3 shrink-0" aria-label="Locked" data-testid="lock-indicator" />
        )}
        {!locked && aiLocked && (
          <ShieldCheck
            className="size-3 shrink-0"
            aria-label="Protected from Director changes"
            data-testid="ai-lock-indicator"
          />
        )}
        <span className="truncate">{name}</span>
        {(linkedSelected || affected) && (
          <span className="shrink-0 rounded bg-primary/80 px-1 text-[9px] text-black">linked</span>
        )}
      </span>
      {video && (
        <span className="pointer-events-none relative block truncate px-2 font-tc text-[9px] text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
          {frameToTc(item.sourceInFrame, item.mediaRate)} ·{" "}
          {framesToSeconds(item.durationFrames, sequenceRate).toFixed(1)}s
        </span>
      )}
      {!blade && !locked && !readOnly && (
        <>
          <div
            data-edge="in"
            data-testid="trim-in"
            title="Trim in point"
            className={cn(
              "absolute inset-y-0 left-0 cursor-w-resize border-l-[3px] border-transparent hover:border-primary hover:bg-primary/25",
              selected && "border-primary/70",
            )}
            style={{ width: handle }}
          />
          <div
            data-edge="out"
            data-testid="trim-out"
            title="Trim out point"
            className={cn(
              "absolute inset-y-0 right-0 cursor-e-resize border-r-[3px] border-transparent hover:border-primary hover:bg-primary/25",
              selected && "border-primary/70",
            )}
            style={{ width: handle }}
          />
        </>
      )}
    </div>
  );
});
