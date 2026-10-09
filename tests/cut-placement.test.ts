import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { proposal } from "./timeline/proposal-fixtures";
import {
  click,
  ctx,
  fakeDirector,
  freshDisk,
  itemEl,
  key,
  launch,
  pb,
  pr,
  q,
  quit,
  seq,
  settle,
  teardown,
  wait,
} from "./helpers/cut-harness";

afterEach(teardown);
const demo = () => act(() => q("demo-place-broll")!.click());
const added = () => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="timeline-item"][data-proposal="added"]'),
];

describe("CUT B-roll placement proposals", () => {
  it("shows source and placement facts, an added V2 clip, and Original/Proposed playback plans without writing", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo();
    expect(q("proposal-status")!.textContent).toBe("Ready to review");
    expect(q("proposal-panel")!.textContent).toContain("DEV DEMO · no AI");
    expect(q("proposal-operations")!.textContent).toMatch(
      /Add .+ on V2 at .+picture only; interview audio stays/,
    );
    expect(q("placement-detail")!.textContent).toContain("Source in / out");
    expect(q("placement-detail")!.textContent).toContain("Timeline in / out");
    expect(added()).toHaveLength(1);
    const id = added()[0]!.dataset.itemId!;
    const preview = pr!.compare!.sequence;
    expect(preview.items[id]!.trackId).toBe(before.tracks.find((t) => t.name === "V2")!.id);
    expect(preview.items[id]!.linkGroupId).toBeUndefined();
    expect(preview.links).toEqual(before.links);
    for (const [oldId, item] of Object.entries(before.items))
      expect(preview.items[oldId]).toBe(item);
    await wait(30);
    expect(pb!.overlays.some((o) => o.decision.label === "Demo B-roll placement")).toBe(true);
    act(() => q("compare-before")!.click());
    await wait(30);
    expect(added()).toHaveLength(0);
    expect(document.querySelector(`[data-item-id="${id}"]`)).toBeNull();
    expect(pb!.overlays.some((o) => o.decision.label === "Demo B-roll placement")).toBe(false);
    act(() => q("compare-after")!.click());
    expect(added()[0]!.dataset.itemId).toBe(id);
    expect(seq()).toBe(before);
    expect(ctx!.editor.canUndo).toBe(false);
    await wait(700);
    expect(disk.saves2).toBe(0);
    expect(fakeDirector.requests).toHaveLength(0);
  }, 30000);

  it("Reject discards the addition without a new version or a saved edit", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo();
    act(() => q("proposal-reject")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("rejected");
    expect(added()).toHaveLength(0);
    expect(seq()).toBe(before);
    expect(ctx!.versions).toHaveLength(2);
    await wait(700);
    expect(disk.saves2).toBe(0);
  }, 30000);

  it("Accept keeps the previewed id, saves one transaction, and survives relaunch with exact undo/redo", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    demo();
    const id = added()[0]!.dataset.itemId!;
    const shown = pr!.compare!.sequence.items[id]!;
    act(() => q("proposal-accept")!.click());
    expect(q("proposal-notice")!.dataset.kind).toBe("accepted");
    const { originTransactionId: _a, ...previewed } = shown;
    const { originTransactionId: _b, ...accepted } = seq().items[id]!;
    expect(accepted).toEqual(previewed);
    expect(seq().links).toEqual(before.links);
    const active = ctx!.activeVersionId;
    const after = seq();
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    const saved = JSON.parse(disk.v2!);
    expect(saved.histories[active].past).toHaveLength(1);
    expect(saved.histories[active].past[0].commands[0].type).toBe("PlaceEdit");
    await quit();
    await launch(disk, (c) => c.activeVersionId === active);
    expect(seq()).toEqual(after);
    key("z", { metaKey: true });
    expect(seq()).toEqual(before);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toEqual(after);
    expect(itemEl(id)).toBeDefined();
  }, 30000);

  it("a placement turned stale disables Accept and cannot modify the cut", async () => {
    await launch(freshDisk());
    demo();
    const before = seq();
    const interview = Object.values(before.items).find((i) => i.linkGroupId)!;
    act(() =>
      ctx!.editor.dispatchTransaction({
        id: "elsewhere",
        label: "Elsewhere",
        origin: "manual",
        createdAt: "fixed",
        commands: [
          {
            id: "trim",
            type: "TrimEdit",
            params: { itemId: interview.id, edge: "out", deltaSourceFrames: -1 },
          },
        ],
      }),
    );
    expect(q("proposal-status")!.textContent).toBe("Out of date");
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    const now = seq();
    const outcome = pr!.accept();
    expect(outcome?.ok).toBe(false);
    expect(seq()).toBe(now);
  }, 30000);

  it("a remove-and-place replacement visibly marks both clips and accepts as one edit", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const track = before.tracks.find((t) => t.name === "V2")!;
    const target = Object.values(before.items).find((i) => i.trackId === track.id)!;
    const raw = proposal(ctx!.activeVersionId, before, [
      { op: "remove", itemIds: [target.id], ripple: false },
      {
        op: "place",
        mediaClipId: target.mediaClipId,
        trackId: track.id,
        startFrame: target.startFrame,
        sourceInFrame: target.sourceInFrame,
        sourceOutFrame: target.sourceOutFrame,
        label: "Replacement cutaway",
      },
    ]);
    act(() => pr!.propose(raw));
    expect(q("proposal-status")!.textContent).toBe("Ready to review");
    expect(q("proposal-operations")!.textContent).toContain("Remove");
    expect(q("proposal-operations")!.textContent).toContain("Replacement cutaway");
    expect(
      document.querySelector(`[data-testid="proposal-removed"][data-item-id="${target.id}"]`),
    ).not.toBeNull();
    const id = added()[0]!.dataset.itemId!;
    act(() => q("proposal-accept")!.click());
    expect(seq().items[target.id]).toBeUndefined();
    expect(seq().items[id]!.label).toBe("Replacement cutaway");
    key("z", { metaKey: true });
    expect(seq()).toEqual(before);
  }, 30000);
});
