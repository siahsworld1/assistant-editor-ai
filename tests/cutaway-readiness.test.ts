// CUT preview: a V2 cutaway must not cover V1 until its own first frame is
// decoded. Packaged validation of 6811abd caught one fully black frame at
// 17.5 s, the instant the display-board cutaway became active: the cutaway
// <video> (now correctly stacked above V1) showed its black background while
// it was still loading/seeking. Same rule as the V1 double-buffer: never
// replace a valid visible frame with an unready element.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SequencePlayer } from "@/components/ae/SequencePlayer";
import { CutawayOverlay } from "@/components/ae/SourceVisuals";
import type { PlayableSegment, TimelinePlayback } from "@/lib/ae/timeline-playback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const playback = {
  hasPlayableMedia: true,
  frontSlot: 0,
  waiting: false,
  attachSlot0: () => {},
  attachSlot1: () => {},
} as unknown as TimelinePlayback;

function cutaway(id: string, start: number, sourceIn: number, duration: number): PlayableSegment {
  return {
    decision: {
      id,
      lane: "b-roll",
      clipId: `clip-${id}`,
      label: id,
      sourceInTc: "00:00:00:00",
      sourceOutTc: "00:00:01:00",
      timelineStartSeconds: start,
      durationSeconds: duration,
    },
    clip: undefined,
    src: `ae-media://clip/${id}`,
    sourceInSeconds: sourceIn,
    sourceOutSeconds: sourceIn + duration,
  };
}

// Display board 17.5–22.17 s (source from 6.96 s), park sign 29.5–32.67 s (source from 4.83 s).
const board = cutaway("board", 17.5, 6.96, 4.67);
const sign = cutaway("sign", 29.5, 4.83, 3.17);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(
  overlay: PlayableSegment | null,
  playheadSeconds: number,
  opts: { playing?: boolean; rate?: number } = {},
) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      createElement(
        "div",
        { className: "relative mx-auto max-w-md" },
        createElement(SequencePlayer, { playback }),
        createElement(CutawayOverlay, {
          overlay,
          playheadSeconds,
          playing: opts.playing ?? true,
          rate: opts.rate ?? 1,
        }),
      ),
    ),
  );
}

const v1Front = () => host!.querySelector<HTMLVideoElement>("video[data-front=true]")!;
const v2 = () => host!.querySelector<HTMLVideoElement>("[data-testid=cutaway-overlay]");

/** Gives the cutaway element real-looking media state (the DOM test
 * environment never loads media). */
function media(
  el: HTMLVideoElement,
  state: { readyState: number; seeking: boolean; currentTime: number },
) {
  let t = state.currentTime;
  Object.defineProperty(el, "readyState", { configurable: true, get: () => state.readyState });
  Object.defineProperty(el, "seeking", { configurable: true, get: () => state.seeking });
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => t,
    set: (v: number) => {
      t = v;
    },
  });
  Object.defineProperty(el, "paused", { configurable: true, get: () => false });
  el.play = () => Promise.resolve();
  el.pause = () => {};
  return state;
}

async function fire(el: HTMLElement, type: string) {
  await act(async () => {
    el.dispatchEvent(new Event(type));
  });
}

const has = (el: Element, cls: string) =>
  new RegExp(`(?:^|\\s)${cls.replace(/[[\]]/g, "\\$&")}(?:\\s|$)`).test(el.className);

/** Can the viewer see this element's box at all (painted, non-transparent)? */
const isVisible = (el: Element) => !has(el, "opacity-0") && !has(el, "invisible");
/** Would it paint a black box over V1 right now? */
const paintsBlack = (el: Element) => isVisible(el) && has(el, "bg-black");

function zIndex(el: Element): number {
  const m = el.className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/);
  return m ? Number(m[1] ?? m[2]) : 0;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("V2 cutaway readiness", () => {
  it("1–2: a newly active cutaway stays hidden, and V1 stays visible, until its frame is decoded", async () => {
    await render(null, 17.4);
    await render(board, 17.5); // cutaway becomes active; nothing loaded yet
    const el = v2()!;
    media(el, { readyState: 0, seeking: false, currentTime: 0 });
    expect(isVisible(el)).toBe(false);
    expect(paintsBlack(el)).toBe(false);
    expect(isVisible(v1Front())).toBe(true);

    // Metadata alone (no decoded frame yet) is still not enough.
    await fire(el, "loadedmetadata");
    expect(isVisible(el)).toBe(false);
  });

  it("3: once its frame at the cutaway position is decoded, V2 is revealed above V1", async () => {
    await render(board, 17.5);
    const el = v2()!;
    const s = media(el, { readyState: 1, seeking: true, currentTime: 0 });
    await fire(el, "loadedmetadata"); // positions the element at the in-point
    expect(el.currentTime).toBeCloseTo(6.96, 2);
    expect(isVisible(el)).toBe(false);
    s.readyState = 4;
    s.seeking = false;
    await fire(el, "seeked");
    expect(isVisible(el)).toBe(true);
    expect(zIndex(el)).toBeGreaterThan(zIndex(v1Front()));
  });

  it("4: switching to another cutaway resets readiness", async () => {
    await render(board, 18);
    const first = v2()!;
    media(first, { readyState: 4, seeking: false, currentTime: 6.96 + 0.5 });
    await fire(first, "loadeddata");
    expect(isVisible(first)).toBe(true);

    await render(sign, 29.5);
    const second = v2()!;
    expect(second).not.toBe(first);
    media(second, { readyState: 0, seeking: false, currentTime: 0 });
    expect(isVisible(second)).toBe(false);
    expect(paintsBlack(second)).toBe(false);
    expect(isVisible(v1Front())).toBe(true);
  });

  it("4b: leaving a cutaway and re-entering the same one starts unready again", async () => {
    await render(board, 18);
    const first = v2()!;
    media(first, { readyState: 4, seeking: false, currentTime: 6.96 + 0.5 });
    await fire(first, "loadeddata");
    expect(isVisible(first)).toBe(true);

    await render(null, 25); // past the cutaway
    expect(v2()).toBeNull();
    await render(board, 19); // seek back into the same cutaway: a fresh element
    const again = v2()!;
    expect(again).not.toBe(first);
    media(again, { readyState: 0, seeking: true, currentTime: 0 });
    expect(isVisible(again)).toBe(false);
    expect(isVisible(v1Front())).toBe(true);
  });

  it("5: seeking straight into a cutaway never exposes an unready video", async () => {
    await render(null, 3);
    await render(board, 20); // seek lands 2.5 s inside the cutaway
    const el = v2()!;
    const s = media(el, { readyState: 4, seeking: false, currentTime: 0 }); // decoded, but at the wrong position
    await fire(el, "loadeddata");
    expect(isVisible(el)).toBe(false);
    await fire(el, "loadedmetadata"); // moves to source 6.96 + 2.5
    expect(el.currentTime).toBeCloseTo(9.46, 2);
    s.seeking = false;
    await fire(el, "seeked");
    expect(isVisible(el)).toBe(true);
  });

  it("6: with no active cutaway, normal V1 playback is unchanged", async () => {
    await render(null, 12);
    expect(v2()).toBeNull();
    const front = v1Front();
    expect(has(front, "opacity-100")).toBe(true);
    expect(zIndex(front)).toBe(1);
  });

  it("7: paused frame steps move the cutaway one frame at a time; playing tolerates drift", async () => {
    await render(board, 18, { playing: false });
    const el = v2()!;
    media(el, { readyState: 4, seeking: false, currentTime: 6.96 + 0.5 });
    await fire(el, "seeked");
    await render(board, 18 + 1 / 24, { playing: false }); // one frame on (→ / ←)
    expect(el.currentTime).toBeCloseTo(6.96 + 0.5 + 1 / 24, 6);
    expect(isVisible(el)).toBe(true); // the decoded frame stays up while it seeks
    const before = el.currentTime;
    await render(board, 18 + 2 / 24, { playing: true }); // playing: a frame of drift is fine
    expect(el.currentTime).toBe(before);
  });

  it("8: the cutaway plays at the shuttle speed", async () => {
    await render(board, 18, { rate: 4 });
    expect(v2()!.playbackRate).toBe(4);
    await render(board, 18, { rate: 1 });
    expect(v2()!.playbackRate).toBe(1);
  });
});
