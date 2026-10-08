// Director AI 2.0 — Phase 3: reviewing a Director proposal in CUT.
// The real store + the real playback hook + the real proposal panel and
// timeline (tests/helpers/cut-harness.ts mirrors src/routes/cut.tsx), driven
// with real clicks and keys. Proposals come from the labeled developer demo
// (no AI provider). Preview is in memory only; accept is one Director
// transaction saved like any edit; reject leaves the project untouched.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml } from "@/lib/nle/xmeml";
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
  pr,
  q,
  quit,
  schema1File,
  seq,
  settle,
  snappingOff,
  teardown,
  wait,
} from "./helpers/cut-harness";
import { directorCut, projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const demo = (kind: string) => act(() => q(`demo-${kind}`)!.click());
const status = () => q("proposal-status")?.textContent;
const marked = (mark: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(`[data-testid=timeline-item][data-proposal=${mark}]`),
  ].map((e) => e.dataset.itemId!);

describe("preview is non-destructive", () => {
  it("a demo proposal previews in memory: nothing saved, no version, no history, sequence untouched", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const e7 = itemOf(before, "event-7");
    demo("move-broll");
    expect(q("proposal-panel")!.textContent).toContain("DEV DEMO · no AI");
    expect(status()).toBe("Ready to review");
    expect(q("proposal-instruction")!.textContent).toMatch(/^\[Demo\] Move "/);
    expect(q("proposal-operations")!.textContent).toMatch(
      /^Move ".+" \d+ frames (earlier|later)Why:/,
    );
    expect(q("proposal-operations")!.textContent).not.toContain("linked audio"); // B-roll has none
    // The timeline shows the PROPOSED cut, the moved clip highlighted.
    expect(q("proposal-banner")!.dataset.mode).toBe("after");
    const moved = marked("changed");
    expect(moved).toHaveLength(1);
    const target = moved[0]!;
    expect(Number(itemEl(target).dataset.start)).not.toBe(before.items[target]!.startFrame);
    // …while the project is untouched.
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
    expect(ctx!.editor.canUndo).toBe(false);
    await wait(700);
    expect([disk.saves2, disk.v2, disk.v1]).toEqual([0, null, schema1File]);
    expect(e7).toBeDefined();
  }, 30000);

  it("Original / Proposed switch the picture and the playback plan; affected clips are marked in both", async () => {
    await launch(freshDisk());
    const before = seq();
    demo("move-broll");
    const target = marked("changed")[0]!;
    const proposedStart = Number(itemEl(target).dataset.start);
    const overlayOf = () =>
      pb!.overlays.find((o) => o.decision.timelineStartSeconds * 24 === proposedStart);
    await wait(30);
    expect(overlayOf()).toBeDefined(); // playback plays the PROPOSED cut
    act(() => q("compare-before")!.click());
    await wait(30);
    expect(q("proposal-banner")!.dataset.mode).toBe("before");
    expect(Number(itemEl(target).dataset.start)).toBe(before.items[target]!.startFrame);
    expect(marked("changed")).toEqual([target]);
    expect(overlayOf()).toBeUndefined(); // and back to the original cut
    act(() => q("compare-after")!.click());
    expect(Number(itemEl(target).dataset.start)).toBe(proposedStart);
  }, 30000);

  it("a section removal shows the removed clips outlined in Proposed and marked in Original", async () => {
    await launch(freshDisk());
    demo("ripple-remove");
    expect(status()).toBe("Ready to review");
    expect(q("proposal-operations")!.textContent).toMatch(/and close the gap/);
    const removed = [
      ...document.querySelectorAll<HTMLElement>("[data-testid=proposal-removed]"),
    ].map((e) => e.dataset.itemId);
    expect(removed.length).toBe(2); // the V1 clip and its sync audio
    act(() => q("compare-before")!.click());
    expect(marked("removed").sort()).toEqual([...removed].sort());
  }, 30000);

  it("editing is paused while a proposal is under review", async () => {
    await launch(freshDisk());
    snappingOff();
    demo("move-broll");
    const shown = itemOf(pr!.compare!.sequence, "event-1");
    drag(itemEl(shown.id), 100, 130);
    key("Backspace");
    key("z", { metaKey: true });
    expect(q("timeline-message")!.textContent).toMatch(/accept or reject it before editing/);
    expect(ctx!.versions).toHaveLength(2);
    expect((q("lock-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect((q("undo-button") as HTMLButtonElement).disabled).toBe(true);
  }, 30000);
});

describe("accept and reject", () => {
  it("accept = one undoable Director transaction, forked from the Director version, saved", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo("trim-interview");
    const instruction = q("proposal-instruction")!.textContent!;
    const proposed = pr!.review!.ok ? pr!.review!.preview : null;
    act(() => q("proposal-accept")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("accepted");
    expect(q("proposal-banner")).toBeNull(); // back to normal editing
    const active = ctx!.versions.find((v) => v.id === ctx!.activeVersionId)!;
    expect(active).toMatchObject({ kind: "edited", parentId: "v2", command: instruction });
    expect(ctx!.editor.nextUndoLabel).toBe(`Director: ${instruction}`);
    const strip = (s: typeof before) =>
      Object.values(s.items).map(({ originTransactionId: _t, ...r }) => r);
    expect(strip(seq())).toEqual(strip(proposed!));
    expect(ctx!.versions.find((v) => v.id === "v2")!.timeline).toStrictEqual(directorCut);
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    expect(JSON.parse(disk.v2!).histories[active.id].past[0].origin).toBe("director");
    expect(JSON.parse(disk.v2!).histories[active.id].past).toHaveLength(1); // ONE transaction
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(before);
    expect(ctx!.editor.canUndo).toBe(false);
    key("z", { metaKey: true, shiftKey: true });
    expect(strip(seq())).toEqual(strip(proposed!));
  }, 30000);

  it("reject discards it: same sequence, nothing saved, no version", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo("ripple-remove");
    act(() => q("proposal-reject")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("rejected");
    expect(q("proposal-banner")).toBeNull();
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
    await wait(700);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("a proposal that went stale is shown as out of date and can't be accepted", async () => {
    await launch(freshDisk());
    demo("move-broll");
    expect(status()).toBe("Ready to review");
    // The cut changes underneath it (another window, an earlier tab…).
    const s = seq();
    act(() => {
      const g = ctx!.editor.ids;
      const e1 = itemOf(s, "event-1");
      ctx!.editor.dispatchTransaction({
        id: g.next("transaction"),
        label: "Elsewhere",
        origin: "manual",
        createdAt: "x",
        commands: [
          {
            id: g.next("command"),
            type: "TrimEdit",
            params: { itemId: e1.id, edge: "out", deltaSourceFrames: -2 },
          },
        ],
      });
    });
    expect(status()).toBe("Out of date");
    expect(q("proposal-issues")!.querySelector("[data-code=stale]")).not.toBeNull();
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    const out = pr!.accept();
    expect(out && !out.ok && out.issues[0]!.code).toBe("stale");
    expect(ctx!.editor.nextUndoLabel).toBe("Elsewhere"); // nothing else committed
  }, 30000);

  it("accepted edits survive quit → relaunch, with their undo", async () => {
    const disk = freshDisk();
    await launch(disk);
    demo("move-broll");
    const instruction = q("proposal-instruction")!.textContent!;
    act(() => q("proposal-accept")!.click());
    const working = ctx!.activeVersionId;
    const after = seq();
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(after);
    expect(q("undo-button")!.textContent).toContain(`Undo Director: ${instruction}`.slice(0, 40));
    // Exports still work from the derived timeline of the accepted version.
    const version = ctx!.versions.find((v) => v.id === working)!;
    const { usable } = validateTimelineForExport(version.timeline, projectClips);
    expect(buildXmeml(version.timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(version.timeline, usable, projectClips)).toContain("TITLE:");
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);
});

describe("protection in CUT", () => {
  it("Lock / AI-protect the selection (linked audio follows), undoable, shown on the clips", async () => {
    await launch(freshDisk());
    const e6 = itemOf(seq(), "event-6");
    const a6 = Object.values(seq().items).find(
      (i) => i.linkGroupId === e6.linkGroupId && i.id !== e6.id,
    )!;
    click(itemEl(e6.id), 720);
    act(() => q("ai-protect-toggle")!.click());
    expect([itemEl(e6.id).dataset.locked, itemEl(a6.id).dataset.locked]).toEqual(["ai", "ai"]);
    expect(q("ai-protect-toggle")!.getAttribute("aria-pressed")).toBe("true");
    expect(ctx!.editor.nextUndoLabel).toBe("Protect from AI");
    act(() => q("lock-toggle")!.click());
    expect(itemEl(e6.id).dataset.locked).toBe("true");
    expect(ctx!.editor.nextUndoLabel).toBe("Lock clips");
    // Locked: the filmmaker's own edits are refused until unlocked.
    snappingOff();
    drag(itemEl(e6.id), 720, 740);
    expect(seq().items[e6.id]!.startFrame).toBe(696);
    expect(q("timeline-message")!.textContent).toMatch(/locked/);
    key("z", { metaKey: true }); // undo the lock
    expect(itemEl(e6.id).dataset.locked).toBe("ai");
    key("z", { metaKey: true }); // undo the AI protection
    expect(itemEl(e6.id).dataset.locked).toBeUndefined();
    // Protection is not an edit: the clip is still the Director's material.
    expect(seq().items[e6.id]!.editedBy).toBeUndefined();
  }, 30000);

  it("the Director demo refuses AI-protected and locked clips, and marks them", async () => {
    await launch(freshDisk());
    demo("protected-conflict");
    expect(q("proposal-notice")!.textContent).toMatch(/protect one/);
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    act(() => q("ai-protect-toggle")!.click());
    demo("protected-conflict");
    expect(status()).toBe("Refused");
    expect(q("proposal-issues")!.querySelector("[data-code=protected]")).not.toBeNull();
    expect(marked("blocked")).toContain(e7.id);
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    act(() => q("proposal-reject")!.click());
    expect(ctx!.editor.nextUndoLabel).toBe("Protect from AI");
  }, 30000);

  it("the Director demo refuses clips edited by hand", async () => {
    await launch(freshDisk());
    demo("manual-conflict");
    expect(q("proposal-notice")!.textContent).toMatch(/edited by hand yet/);
    snappingOff();
    const e7 = itemOf(seq(), "event-7");
    drag(itemEl(e7.id), 740, 730); // a hand edit
    expect(seq().items[e7.id]!.editedBy).toBe("manual");
    demo("manual-conflict");
    expect(status()).toBe("Refused");
    expect(q("proposal-issues")!.querySelector("[data-code=manual-conflict]")).not.toBeNull();
    expect(marked("blocked")).toContain(e7.id);
    const before = seq();
    act(() => q("proposal-accept")!.click()); // disabled — nothing happens
    expect(seq()).toBe(before);
    // Valid demos avoid hand-edited material on their own.
    demo("move-broll");
    expect(status()).toBe("Ready to review");
    expect(marked("changed")).not.toContain(e7.id);
    expect(endFrame(seq().items[e7.id]!)).toBe(784 - 10);
  }, 30000);
});
