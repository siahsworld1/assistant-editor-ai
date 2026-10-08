// Phase 6, Milestone 2 — reorder proposals in CUT. The real store, playback
// hook, proposal panel and timeline (cut-harness). A reorder is reviewed like
// every proposal: Original and Proposed order listed, affected clips marked,
// the proposed cut playable, accepted as ONE Director transaction or rejected
// with nothing changed. Proposals come from the labeled developer demo, or
// from the scripted (fake) AI Director — no provider, no paid call.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml } from "@/lib/nle/xmeml";
import { PROPOSAL_SCHEMA } from "@/lib/timeline/proposals";
import { importedSequence } from "@/lib/timeline/workspace";
import {
  click,
  ctx,
  director,
  drag,
  fakeDirector,
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

const demo = (kind: string) => act(() => q(`demo-${kind}`)!.click());
const text = (id: string) => q(id)?.textContent ?? "";
const marked = (mark: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(`[data-testid=timeline-item][data-proposal=${mark}]`),
  ].map((e) => e.dataset.itemId!);
const listed = (id: string) =>
  [...q(id)!.querySelectorAll<HTMLElement>("li")].map((li) => li.textContent);
/** Interview decisions in the order playback will play them. */
const playOrder = () => pb!.segments.map((s) => s.decision.id);
const label = (name: string) => itemOf(seq(), name).label;

function instruct(t: string) {
  const input = q("instruction-input") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, t);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    (q("instruction-submit") as HTMLButtonElement).click();
  });
}

describe("reviewing a reorder", () => {
  it("shows Original and Proposed order, marks the clips, previews and plays the new order — nothing written", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const [e1, e2] = [itemOf(before, "event-1"), itemOf(before, "event-2")];
    demo("reorder-interview");
    expect(text("proposal-status")).toBe("Ready to review");
    expect(text("proposal-operations")).toMatch(
      /^Reorder 2 clips: ".+", ".+" \(linked audio follows\)/,
    );
    expect(listed("reorder-original")).toEqual([label("event-1"), label("event-2")]);
    expect(listed("reorder-proposed")).toEqual([label("event-2"), label("event-1")]);
    expect(q("reorder-proposed")!.querySelectorAll("[data-moved=true]")).toHaveLength(2);
    // Affected: both clips and their sync audio.
    expect(marked("changed").sort()).toEqual(
      [e1.id, e2.id, ...[e1, e2].map((e) => before.links[e.linkGroupId!]!.itemIds).flat()]
        .filter((id, i, a) => a.indexOf(id) === i)
        .sort(),
    );
    // Proposed: new positions on the timeline, and in the playback plan.
    expect([itemEl(e2.id).dataset.start, itemEl(e1.id).dataset.start]).toEqual(["0", "168"]);
    await wait(30);
    expect(playOrder().slice(0, 3)).toEqual(["event-2", "event-1", "event-3"]);
    // Original: as it is.
    act(() => q("compare-before")!.click());
    await wait(30);
    expect([itemEl(e1.id).dataset.start, itemEl(e2.id).dataset.start]).toEqual(["0", "240"]);
    expect(playOrder().slice(0, 3)).toEqual(["event-1", "event-2", "event-3"]);
    act(() => q("compare-after")!.click());
    // Nothing written.
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
    expect(ctx!.editor.canUndo).toBe(false);
    await wait(700);
    expect([disk.saves2, disk.v2, disk.v1]).toEqual([0, null, schema1File]);
  }, 30000);

  it("reject leaves the project exactly as it was", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo("reorder-interview");
    act(() => q("proposal-reject")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("rejected");
    expect(seq()).toBe(before);
    await wait(30);
    expect(playOrder().slice(0, 2)).toEqual(["event-1", "event-2"]);
    await wait(700);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);
});

describe("accepting a reorder", () => {
  it("one Director transaction: undo, redo, save, relaunch and export", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo("reorder-interview");
    const instruction = text("proposal-instruction");
    act(() => q("proposal-accept")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("accepted");
    const working = ctx!.activeVersionId;
    expect(working).not.toBe("v2");
    expect(ctx!.editor.nextUndoLabel).toBe(`Director: ${instruction}`);
    const after = seq();
    expect(after.items[itemOf(before, "event-2").id]!.startFrame).toBe(0);
    expect(after.items[itemOf(before, "event-2").id]!.editedBy).toBe("director");
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    const past = JSON.parse(disk.v2!).histories[working].past;
    expect(past).toHaveLength(1);
    expect(past[0].origin).toBe("director");
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(before);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toStrictEqual(after);
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(after);
    await wait(30);
    expect(playOrder().slice(0, 2)).toEqual(["event-2", "event-1"]);
    const version = ctx!.versions.find((v) => v.id === working)!;
    const { usable } = validateTimelineForExport(version.timeline, projectClips);
    expect(buildXmeml(version.timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(version.timeline, usable, projectClips)).toContain("TITLE:");
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);
});

describe("a reorder from the AI Director (scripted fake — existing /propose path)", () => {
  const reply =
    (order: () => string[]) =>
    (body: { instruction: string; context: Record<string, unknown> }) => ({
      status: "proposal",
      proposal: {
        schema: PROPOSAL_SCHEMA,
        id: "prp_ai_000000000000000000000001",
        instruction: body.instruction,
        summary: "Plays the third interview section before the second.",
        base: { versionId: body.context["versionId"], revision: body.context["revision"] },
        operations: [{ op: "reorder", itemIds: order() }],
      },
    });
  const ASK = "Put the context section first";

  it("is validated and previewed like any proposal, and can be accepted", async () => {
    await launch(freshDisk());
    const s = seq();
    fakeDirector.replies = [reply(() => [itemOf(s, "event-3").id, itemOf(s, "event-2").id])];
    instruct(ASK);
    await settle(() => q("ai-status")?.dataset.state === "ready");
    expect(listed("reorder-proposed")).toEqual([label("event-3"), label("event-2")]);
    // e4 sits wholly inside e3: it is carried, and marked.
    expect(marked("changed")).toContain(itemOf(s, "event-4").id);
    act(() => q("proposal-accept")!.click());
    expect(seq().items[itemOf(s, "event-3").id]!.startFrame).toBe(240);
    expect(seq().items[itemOf(s, "event-4").id]!.startFrame).toBe(252);
  }, 30000);

  it("B-roll across a cut: refused with a plain reason — the footage is not removed or moved", async () => {
    await launch(freshDisk());
    snappingOff();
    const e4 = itemOf(seq(), "event-4");
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 426); // now 396–508, across the e2/e3 cut at 408
    const edited = seq();
    expect(edited.items[e4.id]!.startFrame).toBe(396);
    fakeDirector.replies = [
      reply(() => [itemOf(edited, "event-3").id, itemOf(edited, "event-2").id]),
    ];
    instruct(ASK);
    await settle(() => q("ai-status")?.dataset.state === "validation-failure");
    expect(q("proposal-issues")!.querySelector("[data-code=engine-rejected]")).not.toBeNull();
    expect(text("proposal-issues")).toMatch(
      /crosses a cut inside the reordered run .* The Director never removes or repositions that footage itself — nothing was changed\./,
    );
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    expect(marked("blocked")).toContain(e4.id);
    expect(seq()).toBe(edited);
  }, 30000);

  it("AI-protected and hand-edited clips are refused", async () => {
    await launch(freshDisk());
    const s = seq();
    const [e5, e6] = [itemOf(s, "event-5"), itemOf(s, "event-6")];
    click(itemEl(e5.id), 600);
    act(() => q("ai-protect-toggle")!.click());
    fakeDirector.replies = [reply(() => [e6.id, e5.id])];
    instruct(ASK);
    await settle(() => q("ai-status")?.dataset.state === "validation-failure");
    expect(text("proposal-issues")).toMatch(/protected from AI editing/);
    act(() => q("proposal-reject")!.click());
    // Hand-edited: e6 moved out and back by hand — still back to back, now the filmmaker's.
    for (const d of [10, -10])
      act(() => {
        const g = ctx!.editor.ids;
        ctx!.editor.dispatchTransaction({
          id: g.next("transaction"),
          label: "Hand move",
          origin: "manual",
          createdAt: "x",
          commands: [
            {
              id: g.next("command"),
              type: "MoveEdit",
              params: { itemIds: [e6.id], deltaFrames: d },
            },
          ],
        });
      });
    expect(seq().items[e6.id]!.editedBy).toBe("manual");
    act(() => {
      ctx!.editor.dispatchTransaction({
        id: ctx!.editor.ids.next("transaction"),
        label: "Unprotect",
        origin: "manual",
        createdAt: "x",
        commands: [
          {
            id: ctx!.editor.ids.next("command"),
            type: "SetProtection",
            params: { itemIds: [e5.id], aiLocked: false },
          },
        ],
      });
    });
    fakeDirector.replies = [reply(() => [e6.id, e5.id])];
    instruct(ASK);
    await settle(() => q("ai-status")?.dataset.state === "validation-failure");
    expect(text("proposal-issues")).toMatch(
      /edited by hand — the Director never changes your edits/,
    );
    expect(seq().items[e6.id]!.startFrame).toBe(696);
  }, 30000);
});
