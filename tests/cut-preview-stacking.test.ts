// CUT preview compositing: an active V2 cutaway must be drawn ABOVE the V1
// picture. Found in packaged playback validation of 1.0.0-beta.1: the
// double-buffered SequencePlayer gives its visible V1 video z-[1], and the
// cutaway had no z-index, so V2 played underneath V1 (the caption named the
// cutaway; the screen showed the interview). The DOM test environment has no
// CSS layout, so this checks the stacking order the Tailwind classes encode,
// in the same wrapper the CUT route renders them in.
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

const cutaway: PlayableSegment = {
  decision: {
    id: "b1",
    lane: "b-roll",
    clipId: "clip-003",
    label: "Display board",
    sourceInTc: "00:00:06:23",
    sourceOutTc: "00:00:11:15",
    timelineStartSeconds: 17.5,
    durationSeconds: 4.67,
  },
  clip: undefined,
  src: "ae-media://clip/clip-003",
  sourceInSeconds: 6.96,
  sourceOutSeconds: 11.63,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Renders the CUT preview exactly as src/routes/cut.tsx composes it. */
async function renderPreview(overlay: PlayableSegment | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        "div",
        { className: "relative mx-auto max-w-md", "data-testid": "preview-wrapper" },
        createElement(SequencePlayer, { playback }),
        createElement(CutawayOverlay, { overlay, playheadSeconds: 19, playing: true }),
      ),
    ),
  );
  return host.querySelector<HTMLElement>("[data-testid=preview-wrapper]")!;
}

function zIndex(el: Element): number {
  const m = el.className.toString().match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/);
  return m ? Number(m[1] ?? m[2]) : 0;
}

/** Whether an element starts its own stacking context (positioned + z-index, or isolate). */
function startsStackingContext(el: Element): boolean {
  const cls = el.className.toString();
  return (
    /(?:^|\s)isolate(?:\s|$)/.test(cls) ||
    (/(?:^|\s)(relative|absolute|fixed|sticky)(?:\s|$)/.test(cls) && zIndex(el) > 0)
  );
}

/** Every ancestor of `el` strictly inside `wrapper` is stacking-context-neutral. */
function sharesContextWith(wrapper: Element, el: Element): boolean {
  for (let p = el.parentElement; p && p !== wrapper; p = p.parentElement) {
    if (startsStackingContext(p)) return false;
  }
  return true;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("CUT preview stacking", () => {
  it("draws an active V2 cutaway above the visible V1 picture", async () => {
    const wrapper = await renderPreview(cutaway);
    const front = wrapper.querySelector<HTMLVideoElement>("video[data-front=true]")!;
    const back = wrapper.querySelector<HTMLVideoElement>("video[data-front=false]")!;
    const v2 = wrapper.querySelector<HTMLVideoElement>("[data-testid=cutaway-overlay]")!;
    expect(front).toBeTruthy();
    expect(v2).toBeTruthy();
    expect(v2.className).toMatch(/(?:^|\s)absolute(?:\s|$)/);
    // Same stacking context, so z-index alone decides the order…
    expect(sharesContextWith(wrapper, front)).toBe(true);
    expect(sharesContextWith(wrapper, v2)).toBe(true);
    // …and V2 is above both V1 buffers.
    expect(zIndex(v2)).toBeGreaterThan(zIndex(front));
    expect(zIndex(v2)).toBeGreaterThan(zIndex(back));
  });

  it("leaves normal V1 playback unchanged when no cutaway is active", async () => {
    const wrapper = await renderPreview(null);
    expect(wrapper.querySelector("[data-testid=cutaway-overlay]")).toBeNull();
    const videos = [...wrapper.querySelectorAll<HTMLVideoElement>("video[data-slot]")];
    expect(videos).toHaveLength(2);
    const front = videos.find((v) => v.dataset.front === "true")!;
    const back = videos.find((v) => v.dataset.front === "false")!;
    expect(front.className).toMatch(/(?:^|\s)opacity-100(?:\s|$)/);
    expect(back.className).toMatch(/(?:^|\s)opacity-0(?:\s|$)/);
    // Nothing in the preview is stacked above the visible V1 video.
    const above = [...wrapper.querySelectorAll("*")].filter(
      (el) => el !== front && zIndex(el) > zIndex(front),
    );
    expect(above).toEqual([]);
  });
});
