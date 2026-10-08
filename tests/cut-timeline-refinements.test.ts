// 1.1 Step 7 — professional editing refinements on the CUT timeline:
// transport keys (Space, J/K/L, arrows, Home/End), integer-frame playhead
// navigation, playhead visibility, zoom around the playhead, nudging, trim
// feedback, linked/locked indicators, edge auto-scroll, and the playback and
// persistence guarantees across all of it. Real store + real playback hook
// (tests/helpers/cut-harness.ts); real pointer and keyboard events.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineEditor, type TimelineTransport } from "@/components/ae/TimelineEditor";
import { AEProvider, type EditorApi } from "@/lib/ae/store";
import { buildPlaybackPlan, nextShuttleRate } from "@/lib/ae/timeline-playback";
import { seededIds } from "@/lib/timeline/ids";
import { endFrame } from "@/lib/timeline/selectors";
import { importedSequence } from "@/lib/timeline/workspace";
import {
  click,
  ctx,
  director,
  drag,
  freshDisk,
  install,
  itemEl,
  itemOf,
  key,
  launch,
  partnerOf,
  pauseSpy,
  pb,
  pointer,
  ppf,
  q,
  quit,
  schema1File,
  seq,
  settle,
  shuttleSpy,
  snappingOff,
  teardown,
  togglePlaySpy,
  wait,
} from "./helpers/cut-harness";
import { directorSequence, protect, item as itemIn } from "./timeline/engine-helpers";
import { directorCut, projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const playheadFrame = () => Number(q("playhead")!.dataset.frame);
const scroller = () => q("timeline-scroll")!;

describe("Pass A — transport and navigation keys", () => {
  it("Space toggles play/pause; J/K/L shuttle; none of them fire while typing", async () => {
    await launch(freshDisk());
    key(" ");
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);
    key("l");
    await wait(20);
    expect(pb!.shuttleRate).toBe(1);
    key("l");
    await wait(20);
    expect(pb!.shuttleRate).toBe(2);
    expect(q("shuttle-rate")!.textContent).toContain("2×");
    key("k");
    await wait(20);
    expect(pb!.shuttleRate).toBe(0);
    expect(shuttleSpy.mock.calls.map((c) => c[0])).toEqual([1, 1]);
    // While typing: nothing.
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    document.body.append(input, area);
    for (const k of [" ", "j", "k", "l", "ArrowRight", "Home", "End"]) {
      key(k, {}, input);
      key(k, {}, area);
    }
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);
    expect(shuttleSpy).toHaveBeenCalledTimes(2);
    expect(playheadFrame()).toBe(0);
  }, 30000);

  it("shuttle speeds double per press to 8×; the other direction restarts at 1×", () => {
    expect(nextShuttleRate(0, 1)).toBe(1);
    expect(nextShuttleRate(1, 1)).toBe(2);
    expect(nextShuttleRate(4, 1)).toBe(8);
    expect(nextShuttleRate(8, 1)).toBe(8);
    expect(nextShuttleRate(4, -1)).toBe(-1);
    expect(nextShuttleRate(-2, -1)).toBe(-4);
  });

  it("J shuttles backwards along whole frames and stops at the start", async () => {
    await launch(freshDisk());
    act(() => pb!.seekFrame(30));
    await wait(20);
    key("j");
    expect(shuttleSpy).toHaveBeenLastCalledWith(-1);
    await wait(250);
    const f = playheadFrame();
    expect(f).toBeLessThan(30);
    expect(Math.abs(pb!.playheadSeconds * 24 - Math.round(pb!.playheadSeconds * 24))).toBeLessThan(
      1e-6,
    );
    await wait(2000);
    expect(playheadFrame()).toBe(0);
    expect(pb!.shuttleRate).toBe(0);
  }, 30000);

  it("←/→ step one frame, ⇧ ten, Home/End jump — always whole sequence frames", async () => {
    await launch(freshDisk());
    key("ArrowRight");
    expect(playheadFrame()).toBe(1);
    key("ArrowRight", { shiftKey: true });
    expect(playheadFrame()).toBe(11);
    key("ArrowLeft");
    expect(playheadFrame()).toBe(10);
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    expect(playheadFrame()).toBe(0); // clamped at the start
    key("End");
    expect(playheadFrame()).toBe(792);
    key("ArrowRight");
    expect(playheadFrame()).toBe(792); // clamped at the end
    key("Home");
    expect(playheadFrame()).toBe(0);
    for (const f of [1, 11, 10, 792, 0]) expect(Number.isInteger(f)).toBe(true);
    expect(Math.abs(pb!.playheadSeconds * 24 - Math.round(pb!.playheadSeconds * 24))).toBeLessThan(
      1e-9,
    );
    expect(q("playhead-tc")!.textContent).toBe("00:00:00:00");
  }, 30000);

  it("keyboard navigation brings the playhead into view; zoom keeps the playhead where it is", async () => {
    await launch(freshDisk());
    for (let i = 0; i < 6; i += 1) act(() => q("zoom-in")!.click());
    const zoomed = ppf();
    expect(792 * zoomed).toBeGreaterThan(960 * 4); // far wider than the view
    key("End");
    const s = scroller();
    expect(s.scrollLeft).toBeGreaterThan(0);
    const x = 792 * zoomed - s.scrollLeft;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(960);
    key("Home");
    expect(s.scrollLeft).toBe(0);
    // Zoom around a visible playhead: it stays at the same on-screen x.
    act(() => {
      s.scrollLeft = 400 * ppf() - 300; // the user scrolls to the middle
      s.dispatchEvent(new Event("scroll"));
    });
    act(() => pb!.seekFrame(400));
    await wait(20);
    const before = 400 * ppf() - s.scrollLeft;
    expect(before).toBeCloseTo(300, 6);
    act(() => q("zoom-out")!.click());
    expect(400 * ppf() - s.scrollLeft).toBeCloseTo(before, 6);
    act(() => q("zoom-in")!.click());
    expect(400 * ppf() - s.scrollLeft).toBeCloseTo(before, 6);
    // Near the end the view cannot scroll past the cut: it stops at the end.
    key("End");
    act(() => q("zoom-out")!.click());
    expect(s.scrollLeft).toBeLessThanOrEqual(Math.ceil(792 * ppf()) + 160 - 960 + 1e-6);
    // Fit returns to the whole cut, from the start.
    act(() => q("zoom-fit")!.click());
    expect(792 * ppf()).toBeLessThanOrEqual(960);
    expect(s.scrollLeft).toBe(0);
  }, 30000);

  it("scrubbing the ruler pauses and lands on whole frames", async () => {
    await launch(freshDisk());
    const ruler = q("timeline-ruler")!;
    act(() => {
      ruler.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 123.4 * ppf() }),
      );
    });
    pointer(window, "pointerup", 123.4);
    expect(playheadFrame()).toBe(123);
    expect(Math.abs(pb!.playheadSeconds * 24 - 123)).toBeLessThan(1e-9);
  }, 30000);
});

describe("Pass B — precision editing", () => {
  it("⌥←/⌥→ nudge the selection one frame, ⌥⇧ ten — through MoveEdit, linked audio included", async () => {
    await launch(freshDisk());
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    key("ArrowRight", { altKey: true });
    expect(seq().items[e7.id]!.startFrame).toBe(709);
    expect(ctx!.editor.nextUndoLabel).toBe("Nudge");
    key("ArrowLeft", { altKey: true, shiftKey: true });
    expect(seq().items[e7.id]!.startFrame).toBe(699);
    expect(ctx!.editor.nextUndoLabel).toBe("Nudge −10");
    expect(playheadFrame()).toBe(0); // nudging never moves the playhead

    const e6 = itemOf(seq(), "event-6");
    const a6 = partnerOf(seq(), e6);
    click(itemEl(e6.id), 720);
    key("ArrowRight", { altKey: true, shiftKey: true });
    expect([seq().items[e6.id]!.startFrame, seq().items[a6.id]!.startFrame]).toEqual([706, 706]);
    expect(pauseSpy).toHaveBeenCalled(); // an edit pauses playback
  }, 30000);

  it("an invalid nudge is refused with a clear message and changes nothing", async () => {
    await launch(freshDisk());
    const before = seq();
    key("ArrowRight", { altKey: true });
    expect(q("timeline-message")!.textContent).toMatch(/Select a clip/);
    const e1 = itemOf(before, "event-1");
    click(itemEl(e1.id), 100);
    key("ArrowRight", { altKey: true });
    expect(seq()).toBe(before);
    expect(q("timeline-message")!.textContent).toMatch(/overlap/);
    expect(q("timeline-message")!.querySelector("[role=alert]")).not.toBeNull();
    expect(ctx!.versions).toHaveLength(2); // no fork
  }, 30000);

  it("trimming shows frame-accurate feedback: source timecode, sequence position, Δ frames", async () => {
    await launch(freshDisk());
    snappingOff();
    const e6 = itemOf(seq(), "event-6");
    drag(itemEl(e6.id).querySelector<HTMLElement>("[data-edge=out]")!, 791, 767, {
      release: false,
    });
    const r = q("gesture-readout")!;
    expect(r.dataset.valid).toBe("true");
    expect(r.textContent).toMatch(/^Out 00:01:3\d:\d\d · 00:00:32:00 · −24f · 72f$/);
    // The linked A1 is visibly carried along — not shown as selected.
    const a6 = partnerOf(seq(), e6);
    expect(itemEl(a6.id).dataset.affected).toBe("linked");
    expect(itemEl(a6.id).dataset.selected).toBe("false");
    expect(q("timeline-message")!.textContent).toContain("linked audio follows (1)");
    pointer(window, "pointerup", 767);
    // What the readout said is what was committed.
    const t = seq().items[e6.id]!;
    expect(endFrame(t)).toBe(768);
    expect(q("gesture-readout")).toBeNull();

    // In-edge readout shows the source IN; an invalid trim says why.
    const e5 = itemOf(seq(), "event-5");
    drag(itemEl(e5.id).querySelector<HTMLElement>("[data-edge=out]")!, 695, 725, {
      release: false,
    });
    expect(q("gesture-readout")!.dataset.valid).toBe("false");
    expect(q("gesture-readout")!.textContent).toMatch(/overlap/);
    key("Escape");
    const e1 = itemOf(seq(), "event-1");
    drag(itemEl(e1.id).querySelector<HTMLElement>("[data-edge=in]")!, 0, 12, { release: false });
    expect(q("gesture-readout")!.textContent).toMatch(
      /^In 00:01:02:\d\d · 00:00:00:1\d · \+1\df · 2\d\df$/,
    );
    key("Escape");
  }, 30000);

  it("move feedback shows the new start and the offset", async () => {
    await launch(freshDisk());
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 728, { release: false });
    expect(q("gesture-readout")!.textContent).toBe("00:00:29:00 · −12f");
    key("Escape");
  }, 30000);
});

describe("Pass B — selection", () => {
  it("selected (solid) and linked (dashed, labelled) are distinct; ⌘-click toggles like ⇧-click", async () => {
    await launch(freshDisk());
    const e3 = itemOf(seq(), "event-3");
    const a3 = partnerOf(seq(), e3);
    click(itemEl(e3.id), 450);
    expect(itemEl(e3.id).dataset.selected).toBe("true");
    expect(itemEl(e3.id).dataset.linked).toBe("false");
    expect(itemEl(a3.id).dataset.selected).toBe("false");
    expect(itemEl(a3.id).dataset.linked).toBe("true");
    expect(itemEl(a3.id).textContent).toContain("linked");
    expect(itemEl(a3.id).className).toContain("outline-dashed");
    expect(itemEl(a3.id).className).not.toContain("ring-2");
    const e5 = itemOf(seq(), "event-5");
    click(itemEl(e5.id), 600, { metaKey: true });
    expect(itemEl(e5.id).dataset.selected).toBe("true");
    click(itemEl(e3.id), 450, { metaKey: true });
    expect(itemEl(e3.id).dataset.selected).toBe("false");
    expect(itemEl(a3.id).dataset.linked).toBe("false");
  }, 30000);

  it("a multi-clip move commits once and keeps every selected clip's spacing", async () => {
    await launch(freshDisk());
    snappingOff();
    const e4 = itemOf(seq(), "event-4");
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e4.id), 450);
    click(itemEl(e7.id), 740, { shiftKey: true });
    drag(itemEl(e4.id), 450, 444);
    expect([seq().items[e4.id]!.startFrame, seq().items[e7.id]!.startFrame]).toEqual([414, 702]);
    act(() => ctx!.editor.undo());
    expect(ctx!.editor.canUndo).toBe(false);
  }, 30000);

  it("shows locks, refuses gestures on locked clips through the engine, and labels tracks", async () => {
    let s = protect(
      directorSequence(),
      { itemId: itemIn(directorSequence(), "event-3").id },
      { locked: true },
    );
    s = protect(s, { itemId: itemIn(s, "event-4").id }, { aiLocked: true });
    s = protect(s, { trackName: "A2" }, { locked: true });
    const dispatch = vi.fn();
    const editor = {
      sequence: s,
      ids: seededIds("locks"),
      dispatchTransaction: dispatch,
      undo: () => {},
      redo: () => {},
      canUndo: false,
      canRedo: false,
      nextUndoLabel: null,
      nextRedoLabel: null,
      edited: false,
      persistence: { status: "saved", message: null },
      retrySave: () => {},
    } as unknown as EditorApi;
    const transport: TimelineTransport = {
      playheadSeconds: 0,
      playheadFrame: 0,
      endFrame: 792,
      isPlaying: false,
      shuttleRate: 0,
      seek: () => {},
      seekFrame: () => {},
      pause: () => {},
      togglePlay: () => {},
      shuttle: () => {},
    };
    install(freshDisk()); // a fake engine/desktop for the provider
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    try {
      await act(async () =>
        r.render(
          createElement(
            AEProvider,
            null,
            createElement(TimelineEditor, { editor, playback: transport, clips: projectClips }),
          ),
        ),
      );
      const e3 = itemIn(s, "event-3");
      const e4 = itemIn(s, "event-4");
      expect(itemEl(e3.id).dataset.locked).toBe("true");
      expect(itemEl(e3.id).querySelector("[data-testid=lock-indicator]")).not.toBeNull();
      expect(itemEl(e3.id).querySelector("[data-edge]")).toBeNull(); // no trim handles
      expect(itemEl(e4.id).dataset.locked).toBe("ai");
      expect(itemEl(e4.id).querySelector("[data-testid=ai-lock-indicator]")).not.toBeNull();
      expect(q("track-header-A2")!.querySelector("[aria-label='Track locked']")).not.toBeNull();
      expect(q("track-header-V1")!.textContent).toContain("V1 · Interview");
      expect(q("track-header-V1")!.textContent).toContain("5 clips");
      // A gesture on a locked clip is validated by the engine and refused.
      drag(itemEl(e3.id), 450, 470, { release: false });
      expect(q("gesture-readout")!.dataset.valid).toBe("false");
      pointer(window, "pointerup", 470);
      expect(dispatch).not.toHaveBeenCalled();
      expect(q("timeline-message")!.textContent).toMatch(/lock/i);
      // An AI-locked clip is still editable by hand.
      drag(itemEl(e4.id), 450, 440, { release: false });
      expect(q("gesture-readout")!.dataset.valid).toBe("true");
      key("Escape");
    } finally {
      await act(async () => r.unmount());
      host.remove();
    }
  }, 30000);
});

describe("Pass B — edge auto-scroll", () => {
  it("dragging near the right edge scrolls the timeline and keeps extending the move", async () => {
    // happy-dom runs animation frames back to back; use a 60 Hz display.
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    await launch(freshDisk());
    snappingOff();
    for (let i = 0; i < 4; i += 1) act(() => q("zoom-in")!.click());
    const s = scroller();
    Object.defineProperty(s, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 200,
        width: 400,
        height: 200,
        x: 0,
        y: 0,
      }),
    });
    const e7 = itemOf(seq(), "event-7");
    const el = itemEl(e7.id);
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 200 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    const before = Number(itemEl(e7.id).dataset.start);
    expect(before).toBe(708 + Math.round(100 / ppf()));
    expect(s.scrollLeft).toBe(0);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 395 }));
    });
    await wait(300);
    expect(s.scrollLeft).toBeGreaterThan(0);
    const after = Number(itemEl(e7.id).dataset.start);
    // The move follows the content under the pointer, scroll included.
    expect(after).toBe(708 + Math.round((395 - 200 + s.scrollLeft) / ppf()));
    expect(after).toBeGreaterThan(708 + Math.round(195 / ppf()));
    // Back away from the edge: scrolling stops.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 }));
    });
    const stopped = s.scrollLeft;
    await wait(150);
    expect(s.scrollLeft).toBe(stopped);
    key("Escape");
    expect(seq().items[e7.id]!.startFrame).toBe(708); // cancelled: nothing committed
    vi.unstubAllGlobals();
  }, 30000);
});

describe("Playback safety across edits", () => {
  it("cuts, trims, splits, nudges and undo/redo all pause, keep the playhead, rebuild the plan", async () => {
    await launch(freshDisk());
    snappingOff();
    act(() => pb!.seekFrame(500));
    await wait(30);
    const ops: Array<[string, () => void]> = [
      ["move", () => drag(itemEl(itemOf(seq(), "event-7").id), 740, 730)],
      [
        "trim",
        () =>
          drag(
            itemEl(itemOf(seq(), "event-6").id).querySelector<HTMLElement>("[data-edge=out]")!,
            791,
            780,
          ),
      ],
      [
        "split",
        () => {
          click(q("track-row-A2")!, 0); // nothing selected: cut everything under the playhead
          key("k", { metaKey: true });
        },
      ],
      [
        "nudge",
        () => {
          click(itemEl(itemOf(seq(), "event-4").id), 450);
          key("ArrowLeft", { altKey: true });
        },
      ],
      ["undo", () => key("z", { metaKey: true })],
      ["redo", () => key("z", { metaKey: true, shiftKey: true })],
    ];
    for (const [name, op] of ops) {
      pauseSpy.mockClear();
      const before = seq();
      op();
      await wait(30);
      expect(seq(), name).not.toBe(before);
      expect(pauseSpy, name).toHaveBeenCalled();
      expect(pb!.isPlaying, name).toBe(false);
      expect(playheadFrame(), name).toBe(500);
      const version = ctx!.versions.find((v) => v.id === ctx!.activeVersionId)!;
      expect(pb!.overlays, name).toEqual(
        buildPlaybackPlan(version.timeline, ctx!.project!.clips).overlays,
      );
      expect(
        pb!.segments.map((x) => x.decision),
        name,
      ).toEqual(
        buildPlaybackPlan(version.timeline, ctx!.project!.clips).sequence.map((x) => x.decision),
      );
    }
    // V1/A1 stay aligned through all of it.
    const s = seq();
    for (const it of Object.values(s.items)) {
      if (!it.linkGroupId) continue;
      const p = partnerOf(s, it);
      expect([it.startFrame, it.durationFrames, it.sourceInFrame]).toEqual([
        p.startFrame,
        p.durationFrames,
        p.sourceInFrame,
      ]);
    }
  }, 30000);

  it("switching versions keeps the playhead (clamped) and shows the untouched Director cut", async () => {
    await launch(freshDisk());
    snappingOff();
    act(() => pb!.seekFrame(780));
    await wait(30);
    // Shorten the edited version so the playhead is past its end.
    click(itemEl(itemOf(seq(), "event-6").id), 720);
    key("Delete", { shiftKey: true }); // refused: a cutaway sits over it
    click(itemEl(itemOf(seq(), "event-7").id), 740);
    key("Backspace");
    click(itemEl(itemOf(seq(), "event-6").id), 720);
    key("Backspace");
    await wait(30);
    const edited = ctx!.activeVersionId;
    expect(playheadFrame()).toBe(696); // clamped to the shorter cut
    act(() => ctx!.setActiveVersion("v2"));
    await wait(30);
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
    expect(playheadFrame()).toBe(696);
    expect(pb!.isPlaying).toBe(false);
    act(() => ctx!.setActiveVersion(edited));
    await wait(30);
    expect(playheadFrame()).toBe(696);
  }, 30000);
});

describe("Persistence of refined edits", () => {
  it("nudges and trims save, survive relaunch with history; Director and schema-1 stay untouched", async () => {
    const disk = freshDisk();
    await launch(disk);
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    key("ArrowRight", { altKey: true, shiftKey: true });
    drag(
      itemEl(itemOf(seq(), "event-6").id).querySelector<HTMLElement>("[data-edge=out]")!,
      791,
      784,
    );
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    await settle(() => JSON.parse(disk.v2!).histories[ctx!.activeVersionId]?.past.length === 2);
    const working = ctx!.activeVersionId;
    const edited = seq();
    expect(ctx!.versions.find((v) => v.id === "v2")!.timeline).toStrictEqual(directorCut);
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(edited);
    expect(q("undo-button")!.textContent).toContain("Undo Trim out point");
    key("z", { metaKey: true });
    expect(q("undo-button")!.textContent).toContain("Undo Nudge +10");
    expect(disk.v1).toBe(schema1File);

    // A failed save stays visible; Retry recovers.
    disk.fail2 = "write-failed";
    click(itemEl(e7.id), 750);
    key("ArrowLeft", { altKey: true });
    await settle(() => q("persistence-status")?.dataset.status === "error");
    disk.fail2 = null;
    act(() => q("retry-save")!.click());
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    expect(disk.v1).toBe(schema1File);
  }, 30000);
});
