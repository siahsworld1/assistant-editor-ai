// Phase 6, Milestone 5 — Story mode in CUT. The real store, playback hook,
// proposal panel and timeline (cut-harness); POST /propose/story is a
// scripted fake framed exactly as worker/story.py frames a model reply (no
// provider, no network, no paid call). A story plan is only ever a proposal:
// bound to the cut it was asked about, compiled, reviewed, previewed, and
// applied only on Accept — as one Director transaction.
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 (inside e3) · e7 708–784 (inside e6)
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml } from "@/lib/nle/xmeml";
import { importedSequence } from "@/lib/timeline/workspace";
import {
  click,
  ctx,
  director,
  drag,
  fakeAnalysis,
  fakeDirector,
  fakeStory,
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
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const ASK = "Start with the context, then the strong statement";
type Body = { instruction: string; context: Record<string, unknown> };

const TRANSCRIPT = [
  {
    id: "t-e2a",
    clipId: "clip-002",
    speaker: "Unknown speaker",
    startTc: "00:00:28:00",
    endTc: "00:00:31:00",
    text: "They built the highway right through our street.",
    confidence: 0.9,
  },
  {
    id: "t-e3a",
    clipId: "clip-002",
    speaker: "Unknown speaker",
    startTc: "00:00:44:00",
    endTc: "00:00:47:00",
    text: "Nobody asked us.",
    confidence: 0.2,
  },
];
const SELECTS = [
  {
    id: "sel-03",
    rank: 1,
    speaker: "Unknown speaker",
    clipId: "clip-002",
    clipName: "CLIP-002.MP4",
    startTc: "00:00:43:00",
    endTc: "00:00:49:00",
    durationSeconds: 6,
    score: 85,
    category: "context",
    transcriptExcerpt: "Nobody asked us.",
    reasons: [],
    evidence: [],
  },
];

function useAnalysis() {
  fakeAnalysis.transcript = TRANSCRIPT;
  fakeAnalysis.selects = SELECTS;
}

/** The interview clip ids the context described, by decision id. */
const ids = (...names: string[]) => names.map((n) => itemOf(seq(), n).id);

/** A worker reply: envelope from the request, plan fields from the "model". */
const plan = (model: (b: Body) => Record<string, unknown>) => (body: Body) => ({
  status: "plan",
  plan: {
    schema: "ae.story-plan/1",
    base: { versionId: body.context["versionId"], revision: body.context["revision"] },
    instruction: body.instruction,
    summary: "Context first, then the statement.",
    ...model(body),
  },
});
/** e3 before e2; e4 lies wholly inside e3 and travels with it. */
const swap = (e: { e1: string; e2: string; e3: string; e4: string; e5: string; e6: string }) =>
  plan(() => ({
    order: [e.e1, e.e3, e.e2, e.e5, e.e6],
    cutaways: { [e.e4]: "keep" },
    rationale: [
      {
        clipId: e.e3,
        reason: "Context first.",
        evidence: [
          { kind: "select", id: "sel-03" },
          { kind: "transcript", id: "t-e3a" },
        ],
      },
      {
        clipId: e.e2,
        reason: "Then the statement.",
        evidence: [{ kind: "transcript", id: "t-e2a" }],
      },
    ],
  }));
const E = () => {
  const [e1, e2, e3, e4, e5, e6] = ids(
    "event-1",
    "event-2",
    "event-3",
    "event-4",
    "event-5",
    "event-6",
  );
  return { e1: e1!, e2: e2!, e3: e3!, e4: e4!, e5: e5!, e6: e6! };
};

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
const storyMode = () => act(() => q("mode-story")!.click());
const editMode = () => act(() => q("mode-edit")!.click());
const text = (id: string) => q(id)?.textContent ?? "";
const aiState = () => q("ai-status")?.dataset.state ?? null;
const listed = (id: string) => [...q(id)!.querySelectorAll("li")].map((li) => li.textContent);
const marked = (mark: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(`[data-testid=timeline-item][data-proposal=${mark}]`),
  ].map((e) => e.dataset.itemId!);
const playOrder = () => pb!.segments.map((s) => s.decision.id);

describe("Edit and Story modes", () => {
  it("Edit is the default; Story sends every instruction to the story Director; Edit still works as before", async () => {
    await launch(freshDisk());
    expect(q("director-mode")!.dataset.mode).toBe("edit");
    expect(q("demo-move-broll")).not.toBeNull();
    storyMode();
    expect(q("director-mode")!.dataset.mode).toBe("story");
    expect(q("demo-move-broll")).toBeNull(); // demos belong to Edit
    expect((q("instruction-input") as HTMLInputElement).placeholder).toMatch(/Describe the story/);
    // Even precise wording goes to the story Director in Story mode.
    instruct("Move the selected clip 2 seconds earlier");
    await settle(() => aiState() !== "generating");
    expect(fakeStory.requests).toHaveLength(1);
    expect(fakeDirector.requests).toHaveLength(0);
    expect(text("ai-status")).toMatch(/No AI provider is configured/);
    // Back to Edit: the deterministic interpreter, unchanged.
    editMode();
    expect(q("ai-status")).toBeNull();
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    instruct("Move the selected clip 2 seconds earlier");
    expect(text("interpretation-action")).toBe("Move the clip 48 frames (2 s) earlier");
    expect(fakeStory.requests).toHaveLength(1);
  }, 30000);

  it("the mode can't change while a proposal is under review", async () => {
    await launch(freshDisk());
    act(() => q("demo-reorder-interview")!.click());
    expect((q("mode-story") as HTMLButtonElement).disabled).toBe(true);
    act(() => q("proposal-reject")!.click());
    expect((q("mode-story") as HTMLButtonElement).disabled).toBe(false);
  }, 30000);
});

describe("a story proposal", () => {
  it("is built from the CURRENT cut, explained, previewed and played — nothing written", async () => {
    useAnalysis();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const e = E();
    fakeStory.replies = [swap(e)];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "ready");
    // The request described this cut, at this revision.
    const sent = fakeStory.requests[0]!;
    expect(sent.instruction).toBe(ASK);
    expect(sent.context["schema"]).toBe("ae.story-context/1");
    expect(sent.context["versionId"]).toBe("v2");
    expect((sent.context["interview"] as Array<{ id: string }>).map((c) => c.id)).toEqual([
      e.e1,
      e.e2,
      e.e3,
      e.e5,
      e.e6,
    ]);
    // Explained.
    expect(text("story-summary")).toBe("Context first, then the statement.");
    const label = (id: string) => before.items[id]!.label;
    expect(listed("story-original")).toEqual([e.e1, e.e2, e.e3, e.e5, e.e6].map(label));
    expect(listed("story-proposed")).toEqual([e.e1, e.e3, e.e2, e.e5, e.e6].map(label));
    expect(q("story-proposed")!.querySelectorAll("[data-moved=true]")).toHaveLength(2);
    expect(text("story-reasons")).toMatch(/Context first\./);
    expect(text("story-reasons")).toMatch(/select sel-03: “context · score 85”/);
    expect(text("story-reasons")).toMatch(/transcript t-e2a: “They built the highway/);
    const low = q("story-reasons")!.querySelector("[data-evidence-id=t-e3a]") as HTMLElement;
    expect(low.dataset.lowConfidence).toBe("true");
    expect(low.textContent).toMatch(/low confidence, may be wrong/);
    expect(text("story-warnings")).toMatch(/low-confidence transcript \(t-e3a\)/);
    expect(text("story-warnings")).toMatch(/New jump cut at 00:00:10:00/);
    expect(q("story-broll-removed")).toBeNull();
    // Previewed: moved clips (and the cutaway they carry) highlighted.
    expect(marked("changed")).toEqual(expect.arrayContaining([e.e2, e.e3, e.e4]));
    expect(itemEl(e.e3).dataset.start).toBe("240");
    await wait(30);
    expect(playOrder().slice(0, 3)).toEqual(["event-1", "event-3", "event-2"]);
    act(() => q("compare-before")!.click());
    await wait(30);
    expect(playOrder().slice(0, 3)).toEqual(["event-1", "event-2", "event-3"]);
    act(() => q("compare-after")!.click());
    // Nothing written.
    expect(seq()).toBe(before);
    await wait(700);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("Accept = one Director transaction matching the preview; undo, redo, save, relaunch, export", async () => {
    useAnalysis();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const e = E();
    fakeStory.replies = [swap(e)];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "ready");
    const strip = (s: typeof before) =>
      Object.values(s.items).map(({ originTransactionId: _t, ...rest }) => rest);
    const proposed = pr!.review!.ok ? strip(pr!.review!.preview) : [];
    act(() => q("proposal-accept")!.click());
    expect(strip(seq())).toEqual(proposed);
    const working = ctx!.activeVersionId;
    expect(ctx!.editor.nextUndoLabel).toBe(`Director: ${ASK}`);
    expect(q("story-detail")).toBeNull(); // done
    await settle(() => q("persistence-status")?.dataset.status === "saved" && disk.saves2 > 0);
    const past = JSON.parse(disk.v2!).histories[working].past;
    expect(past).toHaveLength(1);
    expect(past[0].origin).toBe("director");
    const after = seq();
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(before);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toStrictEqual(after);
    await settle(() => q("persistence-status")?.dataset.status === "saved");
    await quit();
    await launch(disk, (c) => c.activeVersionId === working);
    expect(seq()).toStrictEqual(after);
    const version = ctx!.versions.find((v) => v.id === working)!;
    const { usable } = validateTimelineForExport(version.timeline, projectClips);
    expect(buildXmeml(version.timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(version.timeline, usable, projectClips)).toContain("TITLE:");
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);

  it("Reject leaves the project exactly as it was", async () => {
    useAnalysis();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    fakeStory.replies = [swap(E())];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "ready");
    act(() => q("proposal-reject")!.click());
    expect(seq()).toBe(before);
    expect(q("story-detail")).toBeNull();
    await wait(700);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("an explicitly removed cutaway is shown, marked on the timeline, and only gone in the proposed cut", async () => {
    useAnalysis();
    await launch(freshDisk());
    const e = E();
    fakeStory.replies = [
      plan(() => ({
        order: [e.e1, e.e2, e.e5, e.e6],
        remove: [e.e3],
        cutaways: { [e.e4]: "remove" },
        rationale: [{ clipId: e.e3, reason: "Repeats the statement." }],
      })),
    ];
    storyMode();
    instruct("Remove repetitive statements");
    await settle(() => aiState() === "ready");
    expect(listed("story-removed")).toEqual([seq().items[e.e3]!.label]);
    expect(text("story-broll-removed")).toMatch(
      /Removes B-roll ".+" \(the plan says so explicitly/,
    );
    expect(text("proposal-operations")).toMatch(/leaving the gap/); // the lift is an operation
    expect(document.querySelectorAll("[data-testid=proposal-removed]").length).toBeGreaterThan(0);
    act(() => q("compare-before")!.click());
    expect(marked("removed")).toContain(e.e4);
    expect(seq().items[e.e4]).toBeDefined(); // still in the real cut
  }, 30000);
});

describe("refusals — with the reason, never applied", () => {
  it("B-roll across a cut: keeping it is refused at plan level; removing a hand-edited one is refused by review", async () => {
    useAnalysis();
    await launch(freshDisk());
    snappingOff();
    const e = E();
    click(itemEl(e.e4), 450);
    drag(itemEl(e.e4), 450, 426); // 396–508, across the e2/e3 cut — now hand-edited
    const edited = seq();
    fakeStory.replies = [swap(e)];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("story-issues")).toMatch(
      /can't be kept: it runs across an edit point the plan changes/,
    );
    expect(q("proposal-accept")).toBeNull();
    expect(seq()).toBe(edited);
    fakeStory.replies = [
      plan(() => ({
        order: [e.e1, e.e3, e.e2, e.e5, e.e6],
        cutaways: { [e.e4]: "remove" },
        rationale: [
          { clipId: e.e3, reason: "Context first." },
          { clipId: e.e2, reason: "Then the statement." },
        ],
      })),
    ];
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "validation-failure" && !!q("proposal-issues"));
    expect(text("proposal-issues")).toMatch(/edited by hand/);
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    expect(seq()).toBe(edited);
  }, 30000);

  it("AI-protected and hand-edited interview clips are refused by review", async () => {
    useAnalysis();
    await launch(freshDisk());
    const e = E();
    click(itemEl(e.e3), 450);
    act(() => q("ai-protect-toggle")!.click());
    fakeStory.replies = [swap(e)];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("proposal-issues")).toMatch(/protected from AI editing/);
    expect(marked("blocked")).toContain(e.e3);
    act(() => q("proposal-reject")!.click());
    act(() => q("ai-protect-toggle")!.click()); // open it to AI again
    // Hand-edited e6 (moved out and back by hand — still back to back).
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
              params: { itemIds: [e.e6], deltaFrames: d },
            },
          ],
        });
      });
    expect(seq().items[e.e6]!.editedBy).toBe("manual");
    fakeStory.replies = [
      plan(() => ({
        order: [e.e1, e.e2, e.e3, e.e6, e.e5],
        cutaways: { [itemOf(seq(), "event-7").id]: "keep" },
        rationale: [
          { clipId: e.e6, reason: "Earlier." },
          { clipId: e.e5, reason: "Later." },
        ],
      })),
    ];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("proposal-issues")).toMatch(/edited by hand/);
  }, 30000);

  it("invented ids, a refusal, an unusable reply", async () => {
    useAnalysis();
    await launch(freshDisk());
    const e = E();
    storyMode();
    fakeStory.replies = [
      plan(() => ({
        order: [e.e1, "itm_invented", e.e3, e.e5, e.e6],
        remove: [e.e2],
        rationale: [{ clipId: e.e2, reason: "x" }],
      })),
    ];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("story-issues")).toMatch(/itm_invented is not in this cut/);
    fakeStory.replies = [{ status: "refused", reason: "Splitting clips isn't possible yet." }];
    instruct("Cut the second sentence");
    await settle(() => aiState() === "unsupported");
    expect(text("ai-status")).toBe("Unsupported instruction: Splitting clips isn't possible yet.");
    fakeStory.replies = [
      { status: "invalid-response", reason: "The Director's reply could not be read." },
    ];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("ai-status")).toMatch(/could not be read/);
  }, 30000);
});

describe("stale replies are refused before anything is shown", () => {
  it("the cut is edited while the Director works", async () => {
    useAnalysis();
    await launch(freshDisk());
    snappingOff();
    fakeStory.replies = [swap(E())];
    fakeStory.delayMs = 200;
    storyMode();
    instruct(ASK);
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    drag(itemEl(e7.id), 740, 744);
    await settle(() => aiState() !== "generating");
    expect(aiState()).toBe("validation-failure");
    expect(text("ai-status")).toMatch(/The cut changed while the Director was working/);
    expect(q("proposal-accept")).toBeNull();
    // Retry asks again about the CURRENT cut.
    fakeStory.delayMs = 0;
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "ready");
    expect(fakeStory.requests[1]!.context["revision"]).not.toBe(
      fakeStory.requests[0]!.context["revision"],
    );
    expect(fakeStory.requests[1]!.context["versionId"]).toBe(ctx!.activeVersionId);
  }, 30000);

  it("the version is switched while the Director works", async () => {
    useAnalysis();
    await launch(freshDisk());
    fakeStory.replies = [swap(E())];
    fakeStory.delayMs = 200;
    storyMode();
    instruct(ASK);
    act(() => ctx!.setActiveVersion("v1"));
    await settle(() => aiState() !== "generating");
    expect(text("ai-status")).toMatch(/The cut changed while the Director was working/);
    act(() => ctx!.setActiveVersion("v2"));
    await wait(50);
    expect(q("proposal-accept")).toBeNull();
  }, 30000);

  it("the project is switched while the Director works", async () => {
    useAnalysis();
    fakeAnalysis.otherProject = true;
    await launch(freshDisk());
    fakeStory.replies = [swap(E())];
    fakeStory.delayMs = 200;
    storyMode();
    instruct(ASK);
    await act(async () => {
      await ctx!.openProject("proj-2");
    });
    await wait(400);
    expect(q("proposal-accept")).toBeNull();
    expect(ctx!.activeProject?.id).toBe("proj-2");
    expect(text("ai-status")).toMatch(/The cut changed while the Director was working/);
  }, 30000);

  it("leaving Story mode, or closing the panel, drops the reply", async () => {
    useAnalysis();
    const disk = freshDisk();
    await launch(disk);
    fakeStory.replies = [swap(E())];
    fakeStory.delayMs = 150;
    storyMode();
    instruct(ASK);
    editMode();
    await wait(300);
    expect(q("ai-status")).toBeNull();
    expect(q("proposal-accept")).toBeNull();
    storyMode();
    instruct(ASK);
    await quit();
    await wait(300);
    expect(fakeStory.requests).toHaveLength(2);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);
});

describe("provider failures", () => {
  it("no provider configured: explained, not retryable", async () => {
    await launch(freshDisk());
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "provider-failure");
    expect(text("ai-status")).toMatch(/No AI provider is configured/);
    expect(q("ai-retry")).toBeNull();
  }, 30000);

  it("a provider failure: nothing changed; Retry is a fresh request that can succeed", async () => {
    useAnalysis();
    await launch(freshDisk());
    const before = seq();
    fakeStory.replies = [
      {
        status: "failed",
        aiFailure: {
          task: "story",
          status: "failed",
          category: "network",
          message: "The AI provider could not be reached",
          retryable: true,
        },
      },
      swap(E()),
    ];
    storyMode();
    instruct(ASK);
    await settle(() => aiState() === "provider-failure");
    expect(text("ai-status")).toMatch(/could not be reached\. Nothing was changed\./);
    expect(seq()).toBe(before);
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "ready");
    expect(fakeStory.requests).toHaveLength(2);
  }, 30000);
});
