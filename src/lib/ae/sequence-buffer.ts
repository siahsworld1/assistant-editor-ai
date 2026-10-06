// Double-buffered playback of the CUT sequence (V1), without black frames
// between edits.
//
// The preview used to be ONE <video> whose `src` was swapped at every edit to a
// different source clip. Changing `src` makes the browser drop the current
// frame at once, so the (black) element showed nothing while the next file
// loaded, seeked to its in-point and decoded — a visible black flash at every
// cross-source cut — and a same-source jump showed the loading overlay while
// the single element re-seeked.
//
// Here two media elements take turns. The visible ("front") one plays the
// current edit; the hidden, muted ("back") one is pre-loaded and pre-seeked to
// the NEXT edit's in-point. At the out-point the two swap, so the next frame is
// already decoded. If the back element isn't ready yet (after a scrub, or on a
// slow disk) the front one pauses on its last frame and keeps showing it until
// the next frame is ready — the picture never goes black. Edit points are
// checked every animation frame instead of on `timeupdate` (~4 Hz).
//
// Framework-free and driven through a tiny media interface, so the timing
// logic is unit-tested deterministically (tests/sequence-buffer.test.ts).
import type { PlayableSegment } from "./timeline-playback";

/** The slice of HTMLMediaElement this controller uses. */
export interface MediaLike {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  muted: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SequenceState {
  /** Index into segments of the edit on screen (null before playback). */
  activeIndex: number | null;
  /** Which of the two media elements is visible. */
  frontSlot: 0 | 1;
  playheadSeconds: number;
  playing: boolean;
  /** True only when NOTHING can be shown yet (first load) — a transition
   * never reports waiting, because the previous frame stays on screen. */
  waiting: boolean;
}

interface Slot {
  el: MediaLike | null;
  segIndex: number | null;
  src: string | null;
  target: number;
  ready: boolean;
  /** Being positioned for a segment (cue → ready). Only then does a media
   * event move it: a playing element must never be pulled back to its cue. */
  preparing: boolean;
  detach: (() => void) | null;
}

/** Within this of a target time, a decoded frame counts as "there". */
const POSITION_TOLERANCE = 0.06;
/** Advance this close to an out-point (half a frame at 23.976/24 fps). */
const OUT_POINT_EPSILON = 0.02;
const HAVE_CURRENT_DATA = 2;
const MEDIA_EVENTS = ["loadedmetadata", "loadeddata", "canplay", "seeked"] as const;

export class SequenceBuffer {
  private segments: PlayableSegment[] = [];
  private totalSeconds = 0;
  private slots: [Slot, Slot] = [this.emptySlot(), this.emptySlot()];
  private front: 0 | 1 = 0;
  /** A slot being prepared to replace the front one, and whether to play it. */
  private pending: { slot: 0 | 1; play: boolean } | null = null;
  private wantPlaying = false;
  private ended = false;
  private state: SequenceState = {
    activeIndex: null,
    frontSlot: 0,
    playheadSeconds: 0,
    playing: false,
    waiting: false,
  };

  constructor(private readonly onChange: (state: SequenceState) => void) {}

  /* --------------------------------- setup --------------------------------- */

  setSequence(segments: PlayableSegment[], totalSeconds: number): void {
    this.segments = segments;
    this.totalSeconds = totalSeconds;
    this.pending = null;
    this.wantPlaying = false;
    this.ended = false;
    for (const slot of this.slots) {
      slot.el?.pause();
      slot.segIndex = null;
      slot.src = null;
      slot.ready = false;
    }
    this.emit({ activeIndex: null, playheadSeconds: 0, playing: false, waiting: false });
  }

  /** Registers (or, with null, releases) the element for slot 0 or 1. */
  attach(slotIndex: 0 | 1, el: MediaLike | null): void {
    const slot = this.slots[slotIndex];
    if (slot.el === el) return;
    slot.detach?.();
    slot.el = el;
    slot.detach = null;
    slot.ready = false;
    slot.src = null;
    slot.segIndex = null;
    if (!el) return;
    el.muted = slotIndex !== this.front;
    const listener = () => this.onMediaEvent(slotIndex);
    for (const type of MEDIA_EVENTS) el.addEventListener(type, listener);
    slot.detach = () => {
      for (const type of MEDIA_EVENTS) el.removeEventListener(type, listener);
    };
  }

  /* -------------------------------- transport ------------------------------- */

  play(): void {
    this.wantPlaying = true;
    const front = this.slots[this.front];
    if (this.ended || front.segIndex === null) {
      const first = this.nextPlayable(this.ended ? 0 : (this.state.activeIndex ?? 0));
      this.ended = false;
      if (first === null) return;
      this.show(first, this.segments[first]!.sourceInSeconds, true);
      return;
    }
    if (this.pending) {
      this.pending.play = true;
      return;
    }
    void front.el?.play();
    this.emit({ playing: true });
  }

  pause(): void {
    this.wantPlaying = false;
    if (this.pending) this.pending.play = false;
    this.slots[this.front].el?.pause();
    this.emit({ playing: false });
  }

  /** Seeks to an absolute position on the timeline. */
  seek(globalSeconds: number): void {
    if (this.segments.length === 0) return;
    const clamped = Math.max(0, Math.min(globalSeconds, this.totalSeconds));
    let target = this.segments.findIndex(
      (s) =>
        clamped >= s.decision.timelineStartSeconds &&
        clamped < s.decision.timelineStartSeconds + s.decision.durationSeconds,
    );
    if (target === -1) {
      target = this.segments.reduce(
        (best, s, i) => (s.decision.timelineStartSeconds <= clamped ? i : best),
        0,
      );
    }
    const seg = this.segments[target]!;
    const local = Math.min(
      seg.sourceOutSeconds,
      Math.max(
        seg.sourceInSeconds,
        seg.sourceInSeconds + (clamped - seg.decision.timelineStartSeconds),
      ),
    );
    this.ended = false;
    this.emit({ playheadSeconds: clamped });
    if (!seg.src) return;
    const front = this.slots[this.front];
    if (front.segIndex === target && front.el && !this.pending) {
      // Inside the edit on screen: the element keeps its frame while seeking.
      front.target = local;
      front.el.currentTime = local;
      this.prefetchAfter(target);
      return;
    }
    this.show(target, local, this.wantPlaying);
  }

  /** Called every animation frame while mounted: advances at out-points. */
  tick(): void {
    if (this.pending) return;
    const front = this.slots[this.front];
    if (front.segIndex === null || !front.el) return;
    const seg = this.segments[front.segIndex];
    if (!seg) return;
    const t = front.el.currentTime;
    const playhead =
      seg.decision.timelineStartSeconds +
      Math.max(0, Math.min(t, seg.sourceOutSeconds) - seg.sourceInSeconds);
    if (Math.abs(playhead - this.state.playheadSeconds) > 0.04)
      this.emit({ playheadSeconds: playhead });
    if (!this.wantPlaying || t < seg.sourceOutSeconds - OUT_POINT_EPSILON) return;
    const next = this.nextPlayable(front.segIndex + 1);
    if (next === null) {
      // End of the cut: hold the last frame.
      this.wantPlaying = false;
      this.ended = true;
      front.el.pause();
      this.emit({ playing: false, playheadSeconds: this.totalSeconds });
      return;
    }
    this.show(next, this.segments[next]!.sourceInSeconds, true);
  }

  /* -------------------------------- internals ------------------------------- */

  /** Puts segment `segIndex` at `local` on screen — via the back slot, swapping
   * only once its frame is decoded; until then the front keeps its frame. */
  private show(segIndex: number, local: number, play: boolean): void {
    const backIndex: 0 | 1 = this.front === 0 ? 1 : 0;
    const front = this.slots[this.front];
    // Hold the outgoing picture still (and silent) while the next one readies.
    front.el?.pause();
    if (front.segIndex === null && !front.el?.src) {
      // Nothing on screen yet: load straight into the front slot.
      this.pending = { slot: this.front, play };
      this.cue(this.front, segIndex, local);
      if (this.pending) this.emit({ waiting: true });
      this.settle(this.front);
      return;
    }
    this.pending = { slot: backIndex, play };
    this.cue(backIndex, segIndex, local);
    this.settle(backIndex);
  }

  /** Swaps in the pending slot as soon as its frame is ready (it may already
   * be — pre-rolled, or loaded synchronously); otherwise keeps preparing it. */
  private settle(slotIndex: 0 | 1): void {
    const slot = this.slots[slotIndex];
    if (slot.preparing) this.onMediaEvent(slotIndex);
    else if (slot.ready && this.pending?.slot === slotIndex) this.promote(slotIndex);
  }

  private cue(slotIndex: 0 | 1, segIndex: number, local: number): void {
    const slot = this.slots[slotIndex];
    const seg = this.segments[segIndex];
    if (!slot.el || !seg?.src) return;
    slot.el.muted = true;
    slot.el.pause();
    if (
      slot.segIndex === segIndex &&
      slot.src === seg.src &&
      slot.ready &&
      Math.abs(slot.el.currentTime - local) < POSITION_TOLERANCE
    ) {
      return; // already pre-rolled exactly here
    }
    slot.segIndex = segIndex;
    slot.target = local;
    slot.ready = false;
    slot.preparing = true;
    if (slot.src !== seg.src) {
      slot.src = seg.src;
      slot.el.src = seg.src; // position is set once metadata arrives
    } else {
      slot.el.currentTime = local;
    }
  }

  private onMediaEvent(slotIndex: 0 | 1): void {
    const slot = this.slots[slotIndex];
    const el = slot.el;
    if (!el || slot.segIndex === null || !slot.preparing) return;
    // Metadata first, then position: a media element can't seek before it.
    if (
      el.readyState >= 1 &&
      Math.abs(el.currentTime - slot.target) >= POSITION_TOLERANCE &&
      !el.seeking
    ) {
      el.currentTime = slot.target;
      return;
    }
    slot.ready =
      el.readyState >= HAVE_CURRENT_DATA &&
      !el.seeking &&
      Math.abs(el.currentTime - slot.target) < POSITION_TOLERANCE;
    if (!slot.ready) return;
    slot.preparing = false;
    if (this.pending?.slot === slotIndex) this.promote(slotIndex);
  }

  private promote(slotIndex: 0 | 1): void {
    const play = this.pending?.play ?? false;
    this.pending = null;
    const incoming = this.slots[slotIndex];
    const outgoing = this.slots[this.front];
    if (slotIndex !== this.front) {
      outgoing.el?.pause();
      if (outgoing.el) outgoing.el.muted = true;
      this.front = slotIndex;
    }
    if (incoming.el) incoming.el.muted = false;
    if (play) void incoming.el?.play();
    const seg = this.segments[incoming.segIndex!]!;
    this.emit({
      activeIndex: incoming.segIndex,
      frontSlot: this.front,
      playing: play,
      waiting: false,
      playheadSeconds:
        seg.decision.timelineStartSeconds + Math.max(0, incoming.target - seg.sourceInSeconds),
    });
    this.prefetchAfter(incoming.segIndex!);
  }

  /** Pre-rolls the edit after `segIndex` into the hidden slot. */
  private prefetchAfter(segIndex: number): void {
    const next = this.nextPlayable(segIndex + 1);
    if (next === null) return;
    const backIndex: 0 | 1 = this.front === 0 ? 1 : 0;
    this.cue(backIndex, next, this.segments[next]!.sourceInSeconds);
    this.settle(backIndex);
  }

  private nextPlayable(from: number): number | null {
    for (let i = from; i < this.segments.length; i++) if (this.segments[i]!.src) return i;
    return null;
  }

  private emit(patch: Partial<SequenceState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private emptySlot(): Slot {
    return {
      el: null,
      segIndex: null,
      src: null,
      target: 0,
      ready: false,
      preparing: false,
      detach: null,
    };
  }
}
