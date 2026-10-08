// 1.1 Step 6 — the interactive CUT timeline (src/components/ae/TimelineEditor.tsx)
// driven like a user would: pointer gestures and keyboard shortcuts against
// the REAL store and the REAL playback hook (tests/helpers/cut-harness.ts).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CutawayOverlay } from "@/components/ae/SourceVisuals";
import { buildPlaybackPlan } from "@/lib/ae/timeline-playback";
import { endFrame } from "@/lib/timeline/selectors";
import { importedSequence } from "@/lib/timeline/workspace";
import {
  click,
  ctx,
  director,
  drag,
  freshDisk,
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
  seq,
  settle,
  snappingOff,
  teardown,
  wait,
} from "./helpers/cut-harness";
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

/* ---------------------------------- tests --------------------------------- */

describe("CUT timeline: layout", () => {
  it("shows V1, V2, A1 and A2, a ruler, the playhead and clips placed by sequence frame", async () => {
    await launch(freshDisk());
    for (const t of ["V1", "V2", "A1", "A2"]) expect(q(`track-row-${t}`)).not.toBeNull();
    expect(q("timeline-ruler")).not.toBeNull();
    expect(q("playhead")!.dataset.frame).toBe("0");
    expect(q("playhead-tc")!.textContent).toBe("00:00:00:00");
    const e3 = itemOf(seq(), "event-3");
    const el = itemEl(e3.id);
    expect([el.dataset.track, el.dataset.start, el.dataset.end]).toEqual(["V1", "408", "552"]);
    expect(parseFloat(el.style.left)).toBeCloseTo(408 * ppf(), 5);
    expect(el.textContent).toContain("CLIP-002.MP4"); // the source clip's name
    expect(el.querySelector("[data-testid=link-indicator]")).not.toBeNull(); // linked to A1
    expect(itemEl(partnerOf(seq(), e3).id).dataset.track).toBe("A1");
    // Zoom-to-fit puts the whole cut in view; zooming changes the scale.
    const fitted = ppf();
    expect(792 * fitted).toBeLessThanOrEqual(960);
    act(() => q("zoom-in")!.click());
    expect(ppf()).toBeCloseTo(fitted * 1.5, 5);
    act(() => q("zoom-fit")!.click());
    expect(ppf()).toBeCloseTo(fitted, 5);
  }, 30000);
});

describe("CUT timeline: selection", () => {
  it("click selects, shift-click adds/removes, empty space deselects", async () => {
    await launch(freshDisk());
    const e3 = itemOf(seq(), "event-3");
    const e5 = itemOf(seq(), "event-5");
    click(itemEl(e3.id), 450);
    expect(itemEl(e3.id).dataset.selected).toBe("true");
    click(itemEl(e5.id), 600, { shiftKey: true });
    expect([itemEl(e3.id).dataset.selected, itemEl(e5.id).dataset.selected]).toEqual([
      "true",
      "true",
    ]);
    click(itemEl(e3.id), 450, { shiftKey: true });
    expect(itemEl(e3.id).dataset.selected).toBe("false");
    click(q("track-row-A2")!, 100);
    expect(document.querySelectorAll("[data-selected=true]")).toHaveLength(0);
    expect(ctx!.editor.edited).toBe(false); // selecting is not an edit
  }, 30000);
});

describe("CUT timeline: move", () => {
  it("previews while dragging without touching the store; one transaction on release", async () => {
    const disk = freshDisk();
    await launch(disk);
    snappingOff();
    const before = seq();
    const e7 = itemOf(before, "event-7");
    drag(itemEl(e7.id), 740, 740 - 40, { release: false });
    // Preview: drawn at the proposed frame, store untouched, nothing saved.
    expect(itemEl(e7.id).dataset.start).toBe(String(708 - 40));
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
    expect(q("timeline-message")!.textContent).toContain("Move clip");
    pointer(window, "pointerup", 700);
    expect(itemOf(seq(), "event-7").startFrame).toBe(708 - 40);
    expect(ctx!.editor.edited).toBe(true); // forked on the first edit
    expect(ctx!.editor.nextUndoLabel).toBe("Move clip");
    act(() => ctx!.editor.undo());
    expect(ctx!.editor.canUndo).toBe(false); // exactly one transaction
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
    expect(pauseSpy).toHaveBeenCalled(); // editing pauses playback
  }, 30000);

  it("moves linked V1/A1 together and moves a multi-selection as one", async () => {
    await launch(freshDisk());
    snappingOff();
    const e6 = itemOf(seq(), "event-6");
    const a6 = partnerOf(seq(), e6);
    drag(itemEl(e6.id), 720, 744);
    expect(seq().items[e6.id]!.startFrame).toBe(720);
    expect(seq().items[a6.id]!.startFrame).toBe(720);
    // V2 multi-selection: both cutaways shift by the same amount.
    const e4 = itemOf(seq(), "event-4");
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e4.id), 450);
    click(itemEl(e7.id), 750, { shiftKey: true });
    drag(itemEl(e7.id), 750, 740);
    expect([seq().items[e4.id]!.startFrame, seq().items[e7.id]!.startFrame]).toEqual([410, 698]);
    expect(ctx!.editor.nextUndoLabel).toBe("Move clips");
  }, 30000);

  it("an illegal overlap is shown, refused on release and changes nothing", async () => {
    await launch(freshDisk());
    snappingOff();
    const before = seq();
    const e1 = itemOf(before, "event-1");
    drag(itemEl(e1.id), 100, 124, { release: false });
    expect(q("timeline-ghost")).not.toBeNull(); // where it would go, marked invalid
    expect(q("timeline-message")!.textContent).toMatch(/overlap/);
    pointer(window, "pointerup", 124);
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2); // no fork, no history
    expect(ctx!.editor.canUndo).toBe(false);
    expect(q("timeline-message")!.textContent).toMatch(/overlap/);
  }, 30000);
});

describe("CUT timeline: trim", () => {
  it("drags the out and in edges through TrimEdit, keeping V1/A1 in sync", async () => {
    await launch(freshDisk());
    snappingOff();
    const e6 = itemOf(seq(), "event-6");
    const a6 = partnerOf(seq(), e6);
    drag(itemEl(e6.id).querySelector<HTMLElement>("[data-edge=out]")!, 791, 791 - 24, {
      release: false,
    });
    expect(itemEl(e6.id).dataset.end).toBe(String(792 - 24)); // proposed edge, previewed
    pointer(window, "pointerup", 767);
    expect(endFrame(seq().items[e6.id]!)).toBe(768);
    expect(endFrame(seq().items[a6.id]!)).toBe(768);
    expect(seq().items[e6.id]!.sourceOutFrame).toBeLessThan(e6.sourceOutFrame);
    expect(ctx!.editor.nextUndoLabel).toBe("Trim out point");

    const e1 = itemOf(seq(), "event-1");
    drag(itemEl(e1.id).querySelector<HTMLElement>("[data-edge=in]")!, 0, 24, { release: false });
    // 23.976 media on a 24 fps sequence: not every sequence frame has a source
    // frame; the trim lands on the nearest one — and the preview shows exactly
    // where the commit will put it.
    const proposed = Number(itemEl(e1.id).dataset.start);
    expect(Math.abs(proposed - 24)).toBeLessThanOrEqual(1);
    pointer(window, "pointerup", 24);
    const t1 = seq().items[e1.id]!;
    expect([t1.startFrame, endFrame(t1)]).toEqual([proposed, 240]); // end stays put
    expect(t1.sourceInFrame).toBeGreaterThan(e1.sourceInFrame);
    expect(seq().items[partnerOf(seq(), t1).id]!.startFrame).toBe(proposed);
  }, 30000);

  it("refuses a trim into a neighbour (overlap) and an empty source range", async () => {
    await launch(freshDisk());
    snappingOff();
    const before = seq();
    const e5 = itemOf(before, "event-5");
    drag(itemEl(e5.id).querySelector<HTMLElement>("[data-edge=out]")!, 695, 695 + 30);
    expect(seq()).toBe(before);
    expect(q("timeline-message")!.textContent).toMatch(/overlap/);
    drag(itemEl(e5.id).querySelector<HTMLElement>("[data-edge=out]")!, 695, 400);
    expect(seq()).toBe(before);
    expect(ctx!.editor.canUndo).toBe(false);
  }, 30000);
});

describe("CUT timeline: blade and ⌘K", () => {
  it("B toggles the blade; clicking a clip splits it (and its sync audio) there", async () => {
    await launch(freshDisk());
    snappingOff();
    key("b");
    expect(q("timeline-editor")!.dataset.tool).toBe("blade");
    const e1 = itemOf(seq(), "event-1");
    click(itemEl(e1.id), 100);
    const v1 = Object.values(seq().items)
      .filter((i) => seq().tracks.find((t) => t.id === i.trackId)!.name === "V1")
      .map((i) => [i.startFrame, endFrame(i)])
      .sort((a, b) => a[0]! - b[0]!);
    expect(v1.slice(0, 2)).toEqual([
      [0, 100],
      [100, 240],
    ]);
    const a1Count = Object.values(seq().items).filter(
      (i) => seq().tracks.find((t) => t.id === i.trackId)!.name === "A1",
    ).length;
    expect(a1Count).toBe(6); // the A1 partner was split with it
    expect(ctx!.editor.nextUndoLabel).toBe("Blade");
    key("b");
    expect(q("timeline-editor")!.dataset.tool).toBe("select");
  }, 30000);

  it("⌘K splits the selected clip at the playhead — or everything under it", async () => {
    await launch(freshDisk());
    act(() => pb!.seek(300 / 24));
    await wait(30);
    expect(q("playhead")!.dataset.frame).toBe("300");
    const e2 = itemOf(seq(), "event-2");
    click(itemEl(e2.id), 300);
    key("k", { metaKey: true });
    expect(seq().items[e2.id]!.durationFrames).toBe(60);
    expect(ctx!.editor.nextUndoLabel).toBe("Split at playhead");
    // Nothing selected: everything spanning the playhead (V1 e3 + V2 e4) is cut.
    click(q("track-row-A2")!, 0);
    act(() => pb!.seek(480 / 24));
    await wait(30);
    key("k", { metaKey: true });
    expect(seq().items[itemOf(seq(), "event-3").id]!.durationFrames).toBe(480 - 408);
    expect(seq().items[itemOf(seq(), "event-4").id]!.durationFrames).toBe(480 - 420);
    expect(ctx!.editor.nextUndoLabel).toBe("Split clips at playhead");
  }, 30000);
});

describe("CUT timeline: delete", () => {
  it("Delete lifts (gap stays); Shift+Delete ripples (conservatively)", async () => {
    await launch(freshDisk());
    const e3 = itemOf(seq(), "event-3");
    const a3 = partnerOf(seq(), e3);
    click(itemEl(e3.id), 450);
    key("Backspace");
    expect(seq().items[e3.id]).toBeUndefined();
    expect(seq().items[a3.id]).toBeUndefined(); // linked audio goes with it
    expect(itemOf(seq(), "event-5").startFrame).toBe(552); // lift: gap remains
    expect(ctx!.editor.nextUndoLabel).toBe("Lift");

    const e5 = itemOf(seq(), "event-5");
    click(itemEl(e5.id), 600);
    key("Delete", { shiftKey: true });
    expect(seq().items[e5.id]).toBeUndefined();
    expect(itemOf(seq(), "event-6").startFrame).toBe(696 - 144); // closed up
    expect(itemOf(seq(), "event-7").startFrame).toBe(708 - 144);
    expect(ctx!.editor.nextUndoLabel).toBe("Ripple delete");

    // Conservative: event 6 has the V2 cutaway event 7 laid over it, so
    // rippling it out is refused and nothing changes.
    const s = seq();
    const e6 = itemOf(s, "event-6");
    click(itemEl(e6.id), 600);
    key("Delete", { shiftKey: true });
    expect(seq()).toBe(s);
    expect(q("timeline-message")!.textContent).not.toBe("");
  }, 30000);
});

describe("CUT timeline: snapping", () => {
  it("snaps to clip edges and the playhead in whole frames; S toggles it", async () => {
    await launch(freshDisk());
    expect(q("timeline-editor")!.dataset.snapping).toBe("on");
    const e7 = itemOf(seq(), "event-7");
    // Drop e7's start 3 frames from e6's start (696): it snaps onto 696.
    drag(itemEl(e7.id), 740, 740 - 15, { release: false });
    expect(q("snap-indicator")!.dataset.frame).toBe("696");
    pointer(window, "pointerup", 725);
    expect(seq().items[e7.id]!.startFrame).toBe(696);
    act(() => ctx!.editor.undo());

    // To the playhead.
    act(() => pb!.seek(600 / 24));
    await wait(30);
    drag(itemEl(e7.id), 740, 740 - 110);
    expect(seq().items[e7.id]!.startFrame).toBe(600);
    act(() => ctx!.editor.undo());

    // Off: the same gesture lands exactly where the pointer put it.
    key("s");
    expect(q("timeline-editor")!.dataset.snapping).toBe("off");
    drag(itemEl(e7.id), 740, 740 - 15);
    expect(seq().items[e7.id]!.startFrame).toBe(708 - 15);
    expect(Number.isInteger(seq().items[e7.id]!.startFrame)).toBe(true);
  }, 30000);
});

describe("CUT timeline: undo/redo and Escape", () => {
  it("⌘Z / ⇧⌘Z undo and redo, with their labels on the buttons", async () => {
    await launch(freshDisk());
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730);
    const edited = seq();
    expect(q("undo-button")!.textContent).toContain("Undo Move clip");
    key("z", { metaKey: true });
    expect(seq().items[e7.id]!.startFrame).toBe(708);
    expect(q("redo-button")!.textContent).toContain("Redo Move clip");
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toBe(edited);
  }, 30000);

  it("Escape cancels a drag: nothing changes, even on release", async () => {
    await launch(freshDisk());
    snappingOff();
    const before = seq();
    const e7 = itemOf(before, "event-7");
    drag(itemEl(e7.id), 740, 700, { release: false });
    key("Escape");
    expect(itemEl(e7.id).dataset.start).toBe("708");
    pointer(window, "pointerup", 700);
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
  }, 30000);

  it("shortcuts do not fire while typing in an input or textarea", async () => {
    await launch(freshDisk());
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    document.body.append(input, area);
    key("b", {}, input);
    key("s", {}, area);
    expect(q("timeline-editor")!.dataset.tool).toBe("select");
    expect(q("timeline-editor")!.dataset.snapping).toBe("on");
    const e3 = itemOf(seq(), "event-3");
    click(itemEl(e3.id), 450);
    key("Backspace", {}, area);
    key("z", { metaKey: true }, input);
    expect(seq().items[e3.id]).toBeDefined();
  }, 30000);
});

describe("CUT timeline: playback integration", () => {
  it("keeps the playhead on its frame after an edit, and clamps it when the cut shrinks", async () => {
    await launch(freshDisk());
    snappingOff();
    act(() => pb!.seek(500 / 24));
    await wait(30);
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730);
    await wait(30);
    expect(pb!.isPlaying).toBe(false);
    expect(q("playhead")!.dataset.frame).toBe("500");
    // Ripple-delete event 1 (240 frames): the cut is now 552 frames long.
    act(() => pb!.seek(780 / 24));
    await wait(30);
    click(itemEl(itemOf(seq(), "event-1").id), 100);
    key("Delete", { shiftKey: true });
    await wait(30);
    const end = Math.max(...Object.values(seq().items).map(endFrame));
    expect(end).toBe(792 - 240);
    expect(Number(q("playhead")!.dataset.frame)).toBe(end);
  }, 30000);

  it("the edited Sequence regenerates the playback plan (V1 sequence and V2 overlays)", async () => {
    await launch(freshDisk());
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    const e6 = itemOf(seq(), "event-6");
    drag(itemEl(e7.id), 740, 730);
    drag(itemEl(e6.id), 720, 744);
    await wait(30);
    const overlay = pb!.overlays.find((o) => o.decision.id === "event-7")!;
    expect(overlay.decision.timelineStartSeconds).toBeCloseTo((708 - 10) / 24, 6);
    const v1 = pb!.segments.find((s) => s.decision.id === "event-6")!;
    expect(v1.decision.timelineStartSeconds).toBeCloseTo(720 / 24, 6);
    const version = ctx!.versions.find((v) => v.id === ctx!.activeVersionId)!;
    expect(buildPlaybackPlan(version.timeline, ctx!.project!.clips).overlays).toEqual(pb!.overlays);
  }, 30000);

  it("an edited V2 cutaway stays hidden until its frame is decoded (V1 shows, never black)", async () => {
    await launch(freshDisk());
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730);
    await wait(30);
    const moved = pb!.overlays.find((o) => o.decision.id === "event-7")!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () =>
      r.render(
        createElement(CutawayOverlay, {
          overlay: { ...moved, src: "ae-media://clip/clip-004" },
          playheadSeconds: moved.decision.timelineStartSeconds + 0.5,
          playing: false,
        }),
      ),
    );
    const v = host.querySelector<HTMLVideoElement>("[data-testid=cutaway-overlay]")!;
    expect(v.dataset.ready).toBe("false");
    expect(v.className).toContain("opacity-0");
    await act(async () => r.unmount());
  }, 30000);
});

describe("CUT timeline: persistence", () => {
  it("shows Saving…/Saved, Save failed with Retry, and never Saved after a failed save", async () => {
    const disk = freshDisk();
    await launch(disk);
    snappingOff();
    expect(q("persistence-status")).toBeNull(); // untouched Director cut: nothing to save
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730);
    expect(q("persistence-status")!.dataset.status).toBe("saving");
    expect(q("persistence-status")!.textContent).toContain("Saving…");
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    expect(q("persistence-status")!.textContent).toContain("Saved");

    disk.fail2 = "write-failed";
    drag(itemEl(e7.id), 740, 735);
    await settle(() => q("persistence-status")?.dataset.status === "error");
    expect(q("persistence-status")!.textContent).toContain("Save failed");
    act(() => q("retry-save")!.click());
    await wait(500);
    expect(q("persistence-status")!.dataset.status).toBe("error"); // still failing
    disk.fail2 = null;
    act(() => q("retry-save")!.click());
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    expect(JSON.parse(disk.v2!).histories[ctx!.activeVersionId].past).toHaveLength(2);
  }, 30000);

  it("UI-made edits survive quit → relaunch, with their undo history", async () => {
    const disk = freshDisk();
    await launch(disk);
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730);
    key("b");
    click(itemEl(itemOf(seq(), "event-1").id), 100);
    key("v");
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    await settle(() => JSON.parse(disk.v2!).histories[ctx!.activeVersionId]?.past.length === 2);
    const working = ctx!.activeVersionId;
    const edited = seq();
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(edited);
    expect(itemEl(e7.id).dataset.start).toBe(String(708 - 10));
    expect(q("undo-button")!.textContent).toContain("Undo Blade");
    key("z", { metaKey: true });
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);
});
