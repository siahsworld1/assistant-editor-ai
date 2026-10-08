// Director AI 2.0 — Phase 5: instructions that need AI reasoning, in CUT.
// The real store, playback hook, proposal panel and timeline (cut-harness);
// the worker's POST /propose is a scripted fake (no provider, no network, no
// paid call). Whatever the AI answers is only a proposal: it is validated by
// the same deterministic engine, previewed without mutation, and changes the
// project only when the filmmaker accepts it — as one Director transaction.
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateRequest } = require("../electron/allowlist.cjs");

afterEach(teardown);

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
const aiState = () => q("ai-status")?.dataset.state ?? null;
type Body = { instruction: string; context: Record<string, unknown> };

/** What the worker returns: the model's operations wrapped in the app schema,
 * bound to the context it was sent. */
const wrap =
  (
    operations: (body: Body) => unknown[],
    summary = "Moves the closing cutaway a second earlier.",
  ) =>
  (body: Body) => ({
    status: "proposal",
    proposal: {
      schema: PROPOSAL_SCHEMA,
      id: "prp_ai_test",
      instruction: body.instruction,
      summary,
      base: { versionId: body.context["versionId"], revision: body.context["revision"] },
      operations: operations(body),
    },
  });
const moveE7 = wrap(() => [
  { op: "move", itemIds: [itemOf(seq(), "event-7").id], deltaFrames: -24 },
]);
const ASK = "Make the ending land on the last line";

describe("routing", () => {
  it("POST /propose is the only new route the renderer may reach", () => {
    expect(validateRequest("POST", "/propose").ok).toBe(true);
    expect(validateRequest("GET", "/propose").ok).toBe(false);
  });

  it("precise commands stay deterministic; only other wording goes to the AI Director", async () => {
    await launch(freshDisk());
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    instruct("Move the selected clip 2 seconds earlier");
    expect(text("interpretation-action")).toBe("Move the clip 48 frames (2 s) earlier");
    act(() => q("proposal-reject")!.click());
    // A precise command it understood but must refuse is not retried by AI.
    instruct("Move it 0 frames earlier");
    instruct("Split this clip");
    await wait(20);
    expect(fakeDirector.requests).toHaveLength(0);
    expect(q("ai-status")).toBeNull();
    fakeDirector.replies = [moveE7];
    instruct(ASK);
    await wait(20);
    expect(fakeDirector.requests).toHaveLength(1);
    expect(fakeDirector.requests[0]!.instruction).toBe(ASK);
  }, 30000);

  it("sends the CURRENT edited sequence, its revision, ownership and the selection", async () => {
    await launch(freshDisk());
    snappingOff();
    const e4 = itemOf(seq(), "event-4");
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 456); // a hand edit forks a working version
    const working = ctx!.activeVersionId;
    expect(working).not.toBe("v2");
    fakeDirector.replies = [moveE7];
    instruct(ASK);
    await settle(() => aiState() === "ready");
    const sent = fakeDirector.requests[0]!.context as {
      schema: string;
      versionId: string;
      revision: string;
      fps: number;
      selection: string[];
      clips: Array<{ id: string; start: number; owner: string }>;
    };
    expect(sent.schema).toBe("ae.context/1");
    expect(sent.versionId).toBe(working);
    expect(sent.fps).toBe(24);
    expect(sent.selection).toEqual([e4.id]);
    const moved = sent.clips.find((c) => c.id === e4.id)!;
    expect(moved.start).toBe(seq().items[e4.id]!.startFrame);
    expect(moved.start).not.toBe(e4.startFrame);
    expect(moved.owner).toBe("manual");
    expect(sent.clips).toHaveLength(Object.keys(seq().items).length);
    // Nothing secret or absolute in what leaves the app.
    expect(JSON.stringify(sent)).not.toMatch(/\/Users\/|sk-|apiKey/i);
  }, 30000);
});

describe("an AI proposal is only a proposal", () => {
  it("generating → ready → preview without mutation → accept as ONE Director edit → undo, redo, relaunch, export", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    const e7 = itemOf(seq(), "event-7");
    fakeDirector.replies = [moveE7];
    fakeDirector.delayMs = 150;
    instruct(ASK);
    expect(aiState()).toBe("generating");
    expect(text("ai-status")).toMatch(/Generating a proposal/);
    expect((q("instruction-input") as HTMLInputElement).disabled).toBe(true);
    await settle(() => aiState() === "ready");
    expect(text("ai-status")).toMatch(/AI proposal ready/);
    expect(text("proposal-status")).toBe("Ready to review");
    // Preview only.
    expect(itemEl(e7.id).dataset.start).toBe(String(708 - 24));
    expect(itemEl(e7.id).dataset.proposal).toBe("changed");
    expect(seq()).toBe(before);
    await wait(600);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
    // Accept.
    act(() => q("proposal-accept")!.click());
    expect(seq().items[e7.id]!.startFrame).toBe(684);
    expect(seq().items[e7.id]!.editedBy).toBe("director");
    expect(ctx!.editor.nextUndoLabel).toBe(`Director: ${ASK}`);
    expect(q("ai-status")).toBeNull();
    const working = ctx!.activeVersionId;
    const after = seq();
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
    const version = ctx!.versions.find((v) => v.id === working)!;
    const { usable } = validateTimelineForExport(version.timeline, projectClips);
    expect(buildXmeml(version.timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(version.timeline, usable, projectClips)).toContain("TITLE:");
    key("z", { metaKey: true });
    expect(seq()).toStrictEqual(importedSequence(director, projectClips));
  }, 30000);

  it("reject leaves everything as it was", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    fakeDirector.replies = [moveE7];
    instruct(ASK);
    await settle(() => aiState() === "ready");
    act(() => q("proposal-reject")!.click());
    expect(seq()).toBe(before);
    expect(q("ai-status")).toBeNull();
    await wait(600);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);
});

describe("validation failures — nothing changes, nothing can be accepted", () => {
  const cases: Array<[string, (body: Body) => unknown, string]> = [
    [
      "an invented clip id",
      wrap(() => [{ op: "move", itemIds: ["itm_invented"], deltaFrames: 3 }]),
      "unknown-item",
    ],
    [
      "an operation the Director may not perform",
      wrap(() => [{ op: "replaceAssembly", sequence: {} }]),
      "unsupported-operation",
    ],
    [
      "self-authorization smuggled into an operation",
      wrap(() => [
        { op: "move", itemIds: [itemOf(seq(), "event-7").id], deltaFrames: -24, force: true },
      ]),
      "self-authorization",
    ],
    [
      "evidence that doesn't exist",
      (body: Body) => {
        const r = moveE7(body);
        return {
          ...r,
          proposal: {
            ...r.proposal,
            rationale: [{ opIndex: 0, reason: "x", evidence: [{ kind: "select", id: "sel-404" }] }],
          },
        };
      },
      "unverifiable-evidence",
    ],
    [
      "a proposal-level attempt to authorize itself",
      (body: Body) => {
        const r = moveE7(body);
        return { ...r, proposal: { ...r.proposal, allowManual: true } };
      },
      "self-authorization",
    ],
  ];

  it.each(cases)(
    "%s",
    async (_name, reply, issue) => {
      const disk = freshDisk();
      await launch(disk);
      const before = seq();
      fakeDirector.replies = [reply];
      instruct(ASK);
      await settle(() => aiState() === "validation-failure");
      expect(text("ai-status")).toMatch(/Validation failure.*Nothing was changed/);
      const accept = q("proposal-accept") as HTMLButtonElement | null;
      expect(accept === null || accept.disabled).toBe(true);
      const codes = [...document.querySelectorAll<HTMLElement>("[data-code]")].map(
        (e) => e.dataset.code,
      );
      expect(codes).toEqual([issue]);
      expect(seq()).toBe(before);
      await wait(600);
      expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
    },
    30000,
  );

  it("a malformed reply is a validation failure with Retry; retry can succeed", async () => {
    await launch(freshDisk());
    fakeDirector.replies = [
      { status: "invalid-response", reason: "The reply wasn't valid JSON." },
      moveE7,
    ];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("ai-status")).toMatch(/The reply wasn't valid JSON/);
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "ready");
    expect(fakeDirector.requests.map((r) => r.instruction)).toEqual([ASK, ASK]);
  }, 30000);

  it("AI-protected and hand-edited clips are refused even when the AI targets them", async () => {
    await launch(freshDisk());
    const e7 = itemOf(seq(), "event-7");
    click(itemEl(e7.id), 740);
    act(() => q("ai-protect-toggle")!.click());
    fakeDirector.replies = [moveE7];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("proposal-issues")).toMatch(/protected from AI editing/);
    act(() => q("proposal-reject")!.click());
    // Hand-edited.
    snappingOff();
    const e4 = itemOf(seq(), "event-4");
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 444);
    const handEdited = seq();
    fakeDirector.replies = [wrap(() => [{ op: "move", itemIds: [e4.id], deltaFrames: 10 }])];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("proposal-issues")).toMatch(/edited by hand/);
    expect(seq()).toBe(handEdited);
  }, 30000);
});

describe("sequence revision integrity — a reply belongs to the exact cut it was asked about", () => {
  const rebased = (patch: Record<string, unknown>) => (body: Body) => {
    const r = moveE7(body);
    return { ...r, proposal: { ...r.proposal, base: { ...r.proposal.base, ...patch } } };
  };

  it.each([
    ["another revision", { revision: "rev_0123456789abcdef_1a" }],
    ["another version", { versionId: "v1" }],
    ["an extra base field", { authorized: true }],
  ])(
    "a reply claiming %s is refused before preview — the AI never sets its own base",
    async (_n, patch) => {
      const disk = freshDisk();
      await launch(disk);
      const before = seq();
      fakeDirector.replies = [rebased(patch)];
      instruct(ASK);
      await settle(() => aiState() === "validation-failure");
      expect(text("ai-status")).toMatch(/claimed a different version of the cut/);
      expect(q("proposal-accept")).toBeNull(); // nothing previewed
      expect(seq()).toBe(before);
      await wait(600);
      expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
    },
    30000,
  );

  it("the cut is edited while the AI works: refused before preview; Retry asks about the CURRENT cut", async () => {
    await launch(freshDisk());
    fakeDirector.replies = [moveE7];
    fakeDirector.delayMs = 200;
    snappingOff();
    instruct(ASK);
    const sentFirst = () => fakeDirector.requests[0]!.context;
    // The filmmaker keeps editing while the Director is working.
    const e4 = itemOf(seq(), "event-4");
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 444);
    const edited = seq();
    await settle(() => aiState() !== "generating");
    expect(aiState()).toBe("validation-failure");
    expect(text("ai-status")).toMatch(/The cut changed while the Director was working/);
    expect(q("proposal-accept")).toBeNull();
    expect(seq()).toBe(edited);
    // Retry re-reads the cut: the new request describes the edited version.
    fakeDirector.delayMs = 0;
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "ready");
    const second = fakeDirector.requests[1]!.context;
    expect(second["revision"]).not.toBe(sentFirst()["revision"]);
    expect(second["versionId"]).toBe(ctx!.activeVersionId);
    expect(text("proposal-status")).toBe("Ready to review");
    act(() => q("proposal-accept")!.click());
    expect(seq().items[itemOf(seq(), "event-7").id]!.startFrame).toBe(684);
    expect(seq().items[e4.id]!.startFrame).toBe(edited.items[e4.id]!.startFrame); // the hand edit kept
  }, 30000);

  it("the filmmaker switches versions while the AI works: refused before preview", async () => {
    await launch(freshDisk());
    const e7 = itemOf(seq(), "event-7").id; // fixed now: the fake must not read the new version
    fakeDirector.replies = [wrap(() => [{ op: "move", itemIds: [e7], deltaFrames: -24 }])];
    fakeDirector.delayMs = 200;
    instruct(ASK);
    act(() => ctx!.setActiveVersion("v1"));
    await settle(() => aiState() !== "generating");
    expect(aiState()).toBe("validation-failure");
    expect(text("ai-status")).toMatch(/The cut changed while the Director was working/);
    expect(q("proposal-accept")).toBeNull();
    // Switching back does not resurrect the old answer.
    act(() => ctx!.setActiveVersion("v2"));
    await wait(50);
    expect(q("proposal-accept")).toBeNull();
  }, 30000);

  it("undo while the AI works also makes the answer stale", async () => {
    await launch(freshDisk());
    snappingOff();
    const e4 = itemOf(seq(), "event-4");
    click(itemEl(e4.id), 450);
    drag(itemEl(e4.id), 450, 444);
    fakeDirector.replies = [moveE7];
    fakeDirector.delayMs = 200;
    instruct(ASK);
    key("z", { metaKey: true });
    await settle(() => aiState() !== "generating");
    expect(aiState()).toBe("validation-failure");
    expect(q("proposal-accept")).toBeNull();
  }, 30000);

  it("a ready AI proposal goes out of date if the cut changes under review, and can't be accepted", async () => {
    await launch(freshDisk());
    fakeDirector.replies = [moveE7];
    instruct(ASK);
    await settle(() => aiState() === "ready");
    act(() => {
      const g = ctx!.editor.ids;
      ctx!.editor.dispatchTransaction({
        id: g.next("transaction"),
        label: "Elsewhere",
        origin: "manual",
        createdAt: "x",
        commands: [
          {
            id: g.next("command"),
            type: "TrimEdit",
            params: { itemId: itemOf(seq(), "event-1").id, edge: "out", deltaSourceFrames: -2 },
          },
        ],
      });
    });
    expect(text("proposal-status")).toBe("Out of date");
    expect(aiState()).toBe("validation-failure");
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    expect(ctx!.editor.nextUndoLabel).toBe("Elsewhere");
  }, 30000);

  it("a reply that arrives after leaving CUT is dropped — nothing saved, nothing applied", async () => {
    const disk = freshDisk();
    await launch(disk);
    fakeDirector.replies = [moveE7];
    fakeDirector.delayMs = 150;
    instruct(ASK);
    await quit();
    await wait(400);
    expect(fakeDirector.requests).toHaveLength(1);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("an oversized reply is refused", async () => {
    await launch(freshDisk());
    fakeDirector.replies = [
      (body: Body) => {
        const r = moveE7(body);
        return { ...r, proposal: { ...r.proposal, summary: "x".repeat(70_000) } };
      },
    ];
    instruct(ASK);
    await settle(() => aiState() === "validation-failure");
    expect(text("ai-status")).toMatch(/too large/);
    expect(q("proposal-accept")).toBeNull();
  }, 30000);
});

describe("refusals and provider failures", () => {
  it("a refusal is shown as an unsupported instruction; no proposal", async () => {
    await launch(freshDisk());
    fakeDirector.replies = [
      { status: "refused", reason: "Which line do you mean? Select the clip first." },
    ];
    instruct(ASK);
    await settle(() => aiState() === "unsupported");
    expect(text("ai-status")).toBe(
      "Unsupported instruction: Which line do you mean? Select the clip first.",
    );
    expect(q("proposal-accept")).toBeNull();
    expect(q("ai-retry")).toBeNull();
  }, 30000);

  it("a provider failure is reported (no secrets), Retry re-asks, and nothing changed meanwhile", async () => {
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    fakeDirector.replies = [
      {
        status: "failed",
        aiFailure: {
          task: "director",
          status: "failed",
          category: "network",
          message: "The AI provider could not be reached",
          retryable: true,
        },
      },
      moveE7,
    ];
    instruct(ASK);
    await settle(() => aiState() === "provider-failure");
    expect(text("ai-status")).toMatch(
      /^AI provider failure — The AI provider could not be reached\. Nothing was changed\.\s*Retry$/,
    );
    expect(seq()).toBe(before);
    act(() => q("ai-retry")!.click());
    await settle(() => aiState() === "ready");
    expect(fakeDirector.requests).toHaveLength(2);
  }, 30000);

  it("no provider configured: not retryable; the engine not answering: retryable", async () => {
    await launch(freshDisk());
    instruct(ASK); // the default script: no AI key configured
    await settle(() => aiState() === "provider-failure");
    expect(text("ai-status")).toMatch(/No AI provider is configured/);
    expect(q("ai-retry")).toBeNull();
    fakeDirector.replies = [new Error("socket hang up")];
    instruct(ASK);
    await settle(() => aiState() === "provider-failure" && !!q("ai-retry"));
    expect(text("ai-status")).toMatch(/local engine didn't answer/);
  }, 30000);
});
