// Director AI 2.0 — Phase 4: typed instructions in CUT. The real store, the
// real playback hook and the real proposal panel + timeline (cut-harness);
// the instruction is typed into the panel and submitted, then reviewed,
// previewed, accepted or rejected through the existing proposal workflow.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
  pb,
  q,
  quit,
  schema1File,
  seq,
  settle,
  snappingOff,
  teardown,
  wait,
} from "./helpers/cut-harness";
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

/** Types into the instruction field (as React sees typing) and submits. */
function instruct(text: string) {
  const input = q("instruction-input") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    (q("instruction-submit") as HTMLButtonElement).click();
  });
}
const text = (id: string) => q(id)?.textContent ?? "";

describe("typed instructions → proposals", () => {
  it("moves the selected clip: understood, previewed, accepted as one undoable edit, saved", async () => {
    const disk = freshDisk();
    await launch(disk);
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    instruct("Move the selected clip 2 seconds earlier.");
    expect(text("interpretation-action")).toBe("Move the clip 48 frames (2 s) earlier");
    expect(text("interpretation-clips")).toMatch(/^"b-roll event-7" \(V2 · CLIP-004\.MP4\)$/);
    expect(text("interpretation-expected")).toBe("starts at 00:00:27:12 instead of 00:00:29:12.");
    expect(text("proposal-status")).toBe("Ready to review");
    // Preview: the proposed position, highlighted; nothing written.
    expect(itemEl(e7.id).dataset.start).toBe(String(708 - 48));
    expect(itemEl(e7.id).dataset.proposal).toBe("changed");
    expect(seq().items[e7.id]!.startFrame).toBe(708);
    await wait(30);
    expect(pb!.overlays.some((o) => Math.round(o.decision.timelineStartSeconds * 24) === 660)).toBe(
      true,
    );
    act(() => q("proposal-accept")!.click());
    expect(seq().items[e7.id]!.startFrame).toBe(660);
    expect(ctx!.editor.nextUndoLabel).toBe("Director: Move the selected clip 2 seconds earlier.");
    expect(seq().items[e7.id]!.editedBy).toBe("director");
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    expect(JSON.parse(disk.v2!).histories[ctx!.activeVersionId].past).toHaveLength(1);
    key("z", { metaKey: true });
    expect(seq().items[e7.id]!.startFrame).toBe(708);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq().items[e7.id]!.startFrame).toBe(660);
  }, 30000);

  it("trims a linked interview clip and its audio; reject leaves everything as it was", async () => {
    const disk = freshDisk();
    await launch(disk);
    const e6 = itemOf(seq(), "event-6");
    click(itemEl(e6.id), 720);
    instruct("Trim 1 second from the end");
    expect(text("interpretation-action")).toBe("Trim 24 frames (1 s) from the end of the clip");
    expect(text("instruction-interpretation")).toMatch(/linked sync audio is trimmed/);
    const marked = [...document.querySelectorAll<HTMLElement>("[data-proposal=changed]")];
    expect(marked.map((e) => e.dataset.track).sort()).toEqual(["A1", "V1"]);
    expect(Number(itemEl(e6.id).dataset.end)).toBeLessThan(792);
    const before = seq();
    act(() => q("proposal-reject")!.click());
    expect(seq()).toBe(before);
    expect(endFrame(seq().items[e6.id]!)).toBe(792);
    await wait(600);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("removes and closes the gap where ripple rules allow — and explains when they don't", async () => {
    await launch(freshDisk());
    const e5 = itemOf(seq(), "event-5");
    click(itemEl(e5.id), 600);
    instruct("Remove the selected clip and close the gap");
    expect(text("interpretation-expected")).toMatch(/later clips move up 144 frames/);
    expect(document.querySelectorAll("[data-testid=proposal-removed]")).toHaveLength(2);
    act(() => q("proposal-reject")!.click());
    // Event 3 has a cutaway over it: no silent lift — a plain refusal.
    const e3 = itemOf(seq(), "event-3");
    click(itemEl(e3.id), 450);
    instruct("Remove the selected clip and close the gap");
    expect(text("proposal-status")).toBe("Refused");
    expect(text("proposal-issues")).toMatch(/Closing this gap would affect overlapping footage/);
    expect(text("proposal-operations")).toMatch(/and close the gap/);
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
  }, 30000);

  it("explains refusals: no selection, several clips, unknown wording, protected, hand-edited", async () => {
    await launch(freshDisk());
    instruct("Move the selected clip 2 seconds earlier");
    expect(text("proposal-notice")).toMatch(/Select a clip in the timeline/);
    const e4 = itemOf(seq(), "event-4");
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e4.id), 450);
    click(itemEl(e7.id), 740, { shiftKey: true });
    instruct("Move this clip 2 seconds earlier");
    expect(text("proposal-notice")).toMatch(/Select one clip.*2 are selected/);
    instruct("Make the opening more engaging");
    expect(text("proposal-notice")).toMatch(/I can't interpret that instruction yet/);
    // Protected. (Clear the two-clip selection first.)
    click(q("track-row-A2")!, 0);
    click(itemEl(e7.id), 740);
    act(() => q("ai-protect-toggle")!.click());
    instruct("Move this clip 10 frames later");
    expect(text("proposal-issues")).toMatch(/That clip is protected from AI editing/);
    act(() => q("proposal-reject")!.click());
    // Hand-edited.
    snappingOff();
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 444);
    instruct("Move this clip 10 frames later");
    expect(text("proposal-issues")).toMatch(
      /edited by hand — the Director never changes your edits/,
    );
  }, 30000);

  it("typing an instruction never triggers timeline shortcuts", async () => {
    await launch(freshDisk());
    const input = q("instruction-input")!;
    for (const k of ["b", "s", " ", "Delete", "ArrowRight"]) key(k, {}, input);
    expect(q("timeline-editor")!.dataset.tool).toBe("select");
    expect(q("timeline-editor")!.dataset.snapping).toBe("on");
    expect(q("playhead")!.dataset.frame).toBe("0");
  }, 30000);

  it("a stale instruction proposal can't be accepted; accepted ones survive relaunch", async () => {
    const disk = freshDisk();
    await launch(disk);
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    instruct("Move this clip 15 frames later");
    act(() => ctx!.setActiveVersion("v1"));
    expect(text("proposal-status")).toBe("Out of date");
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    act(() => ctx!.setActiveVersion("v2"));
    expect(text("proposal-status")).toBe("Ready to review");
    act(() => q("proposal-accept")!.click());
    const working = ctx!.activeVersionId;
    const after = seq();
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(after);
    expect(seq().items[e7.id]!.startFrame).toBe(723);
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);
});
