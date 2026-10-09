// Phase 7, Milestone 6 — the optional AI ranking in CUT's Cover mode, through
// the REAL store, preview hook, ProposalPanel and TimelineEditor
// (tests/helpers/cut-harness.ts). POST /propose/coverage-rank is scripted
// (fakeRank) — no provider, no paid call.
// On the v1.2-shaped Director cut: potential jump cuts at 240 and 408; the
// deterministic plan puts the park sign (clip-005) at 240 and the street
// (clip-006) at 408. The scripted AI prefers the street at 240.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Clip, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import {
  ctx,
  fakeAnalysis,
  fakeDirector,
  fakeRank,
  fakeStory,
  freshDisk,
  itemOf,
  key,
  launch,
  MEDIA_ROOT,
  NOT_CONFIGURED,
  pr,
  q,
  quit,
  schema1File,
  seq,
  settle,
  teardown,
  wait,
} from "./helpers/cut-harness";
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const CLIPS: Clip[] = projectClips.map((c, i) => ({
  ...c,
  dialogue: { status: i < 3 ? "dialogue" : "non-dialogue", reasons: ["fixture"] },
}));
const ev = (id: string, clipId: string, atTc: string, label: string): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label,
  atTc,
  confidence: 0.8,
});
const line = (id: string, a: string, b: string, text: string): TranscriptSegment => ({
  id,
  clipId: "clip-002",
  speaker: "A",
  startTc: a,
  endTc: b,
  text,
  confidence: 0.9,
});
function prepare() {
  fakeAnalysis.clips = CLIPS;
  fakeAnalysis.visualEvidence = [
    ev("park-1", "clip-005", "00:00:03:00", "Park sign at the entrance"),
    ev("street-1", "clip-006", "00:00:04:00", "Empty street corner"),
  ];
  fakeAnalysis.transcript = [
    line(
      "t-e1",
      "00:01:08:00",
      "00:01:11:00",
      "The highway cut straight through our neighborhood.",
    ),
    line("t-e2", "00:00:25:00", "00:00:28:00", "Now the park brings everyone back."),
  ];
}

type Ctx = {
  versionId: string;
  revision: string;
  inventory: string;
  cuts: Array<{ id: string; tc: string }>;
};
/** The worker's framing of a model reply: envelope from the request. */
const ranking =
  (rankings: (c: Ctx) => unknown, extra: Record<string, unknown> = {}) =>
  (body: { context: Record<string, unknown> }) => {
    const c = body.context as unknown as Ctx;
    return {
      status: "ranking",
      ranking: {
        schema: "ae.coverage-ranking/1",
        base: { versionId: c.versionId, revision: c.revision, inventory: c.inventory },
        summary: "Street first where the highway is mentioned.",
        rankings: rankings(c),
        ...extra,
      },
    };
  };
const cutAt = (c: Ctx, tc: string) => c.cuts.find((x) => x.tc === tc)!.id;
const STREET_AT_240 = ranking((c) => [
  {
    cutId: cutAt(c, "00:00:10:00"),
    choices: [{ candidateId: "cand:street-1", reason: "An empty street for the highway line." }],
  },
]);

const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const click = (id: string) => act(() => q(id)!.click());
const cover = () => click("mode-cover");
const improve = () => click("cover-ai");
const aiState = () => q("cover-ai-status")?.dataset.state ?? null;
const aiText = () => q("cover-ai-status")?.textContent ?? "";
const source = () => q("cover-source")?.dataset.source ?? null;
const pendingId = () => (pr!.pending as { id: string } | null)?.id ?? null;
const markers = () => all('[data-testid="coverage-marker"]').map((m) => m.dataset.state);
const sources = () => all('[data-testid="placement-source"]').map((e) => e.textContent);
const rankings = () => all('[data-testid="placement-ranking"]').map((e) => e.dataset.ranking);
function dispatch(type: string, params: Record<string, unknown>) {
  act(() => {
    const out = ctx!.editor.dispatchTransaction({
      id: ctx!.editor.ids.next("transaction"),
      label: type,
      origin: "manual",
      createdAt: "fixed",
      commands: [{ id: ctx!.editor.ids.next("command"), type, params }] as never,
    });
    expect(out.ok).toBe(true);
  });
}

describe("asking for AI ranking", () => {
  it("is never automatic: entering Cover is deterministic and makes no request; one click sends one bounded request with no paths", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    cover();
    expect(source()).toBe("deterministic");
    expect(q("cover-ai")!.textContent!.trim()).toBe("Improve recommendations with AI");
    expect(q("cover-ai-panel")!.textContent).toMatch(/only when you click — no automatic retry/);
    await wait(200);
    expect(fakeRank.requests).toHaveLength(0);
    const deterministicId = pendingId();

    fakeRank.replies = [STREET_AT_240];
    fakeRank.delayMs = 150;
    improve();
    expect(aiState()).toBe("requesting");
    expect(aiText()).toMatch(/Asking the AI to rank/);
    expect((q("cover-ai") as HTMLButtonElement).disabled).toBe(true);
    expect(pendingId()).toBe(deterministicId); // still under review while the AI works
    await settle(() => aiState() === "ready");
    expect(fakeRank.requests).toHaveLength(1);
    const sent = JSON.stringify(fakeRank.requests[0]);
    expect(sent).not.toContain(MEDIA_ROOT);
    expect(sent).not.toMatch(/sourceInFrame|startFrame|apiKey|API_KEY|"speaker"/);
    const context = fakeRank.requests[0]!.context;
    expect(context["schema"]).toBe("ae.coverage-rank-context/1");
    expect(
      (context["candidates"] as Array<{ id: string; file: string }>).map((c) => [c.id, c.file]),
    ).toEqual([
      ["cand:park-1", "CLIP-005.MP4"],
      ["cand:street-1", "CLIP-006.MP4"],
    ]);
    expect(fakeDirector.requests).toHaveLength(0);
    expect(fakeStory.requests).toHaveLength(0);

    // The AI-assisted proposal replaces the deterministic one — clearly marked.
    expect(source()).toBe("ai-assisted");
    expect(pendingId()).not.toBe(deterministicId);
    expect(q("proposal-status")!.textContent).toBe("Ready to review");
    expect(aiText()).toMatch(/AI summary: “Street first/);
    expect(sources()).toEqual(["CLIP-006.MP4", "CLIP-005.MP4"]);
    expect(rankings()).toEqual(["ai", "deterministic"]);
    expect(q("placement-ranking")!.textContent).toMatch(/An empty street for the highway line/);
    expect(all('[data-testid="coverage-cut"]')[0]!.textContent).toMatch(/\(AI-ranked\)/);
    await wait(300);
    expect(disk.saves2).toBe(0);
  }, 30000);

  it("the filmmaker can return to the deterministic recommendation", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    const deterministic = structuredClone(pr!.pending);
    fakeRank.replies = [STREET_AT_240];
    improve();
    await settle(() => source() === "ai-assisted");
    click("cover-deterministic");
    expect(source()).toBe("deterministic");
    expect(pr!.pending).toEqual(deterministic);
    expect(rankings()).toEqual(["deterministic", "deterministic"]);
    expect(q("cover-ai-status")).toBeNull();
  }, 30000);
});

describe("the AI-assisted proposal goes through the same review", () => {
  it("Original / Proposed: the AI's B-roll on V2 in Proposed, the cut as it is in Original; V1 and A1 untouched", async () => {
    prepare();
    await launch(freshDisk());
    const before = seq();
    cover();
    fakeRank.replies = [STREET_AT_240];
    improve();
    await settle(() => source() === "ai-assisted");
    expect(markers()).toEqual(["covered", "covered"]);
    expect(all('[data-proposal="added"]')).toHaveLength(2);
    const preview = pr!.review!.ok ? pr!.review!.preview : null;
    for (const [id, it] of Object.entries(before.items))
      expect(preview!.items[id]).toStrictEqual(it);
    click("compare-before");
    expect(pr!.previewTimeline).toBeNull();
    expect(markers()).toEqual(["uncovered", "uncovered"]);
    click("compare-after");
    expect(pr!.previewTimeline!.decisions.filter((d) => d.lane === "b-roll")).toHaveLength(4);
    expect(seq()).toBe(before);
  }, 30000);

  it("Reject leaves the cut and the saved project unchanged", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    cover();
    fakeRank.replies = [STREET_AT_240];
    improve();
    await settle(() => source() === "ai-assisted");
    click("proposal-reject");
    expect(seq()).toBe(before);
    expect(q("cover-ai-status")).toBeNull(); // "ready" is only shown with its proposal
    await wait(400);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("Accept: one saved Director transaction with the AI's choice, kept after relaunch, undone and redone exactly — and nothing more to rank", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    cover();
    fakeRank.replies = [STREET_AT_240];
    improve();
    await settle(() => source() === "ai-assisted");
    click("proposal-accept");
    const active = ctx!.activeVersionId;
    const after = seq();
    const placed = Object.values(after.items).filter((i) => !before.items[i.id]);
    expect(placed.map((i) => [i.mediaClipId, i.startFrame]).sort()).toEqual([
      ["clip-005", 384],
      ["clip-006", 216],
    ]);
    for (const [id, it] of Object.entries(before.items)) expect(after.items[id]).toStrictEqual(it);
    await settle(() => disk.saves2 > 0 && q("persistence-status")?.dataset.status === "saved");
    const past = JSON.parse(disk.v2!).histories[active].past;
    expect(past).toHaveLength(1);
    expect(past[0].commands.map((c: { type: string }) => c.type)).toEqual([
      "PlaceEdit",
      "PlaceEdit",
    ]);

    improve(); // every cut is covered now: refused before any request
    expect(fakeRank.requests).toHaveLength(1);
    await settle(() => aiState() === "refused");
    expect(aiText()).toMatch(/nothing to rank/);

    await quit();
    await launch(disk, (c) => c.activeVersionId === active);
    expect(seq()).toEqual(after);
    key("z", { metaKey: true });
    expect(seq()).toEqual(before);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toEqual(after);
  }, 30000);
});

describe("invalid replies are refused whole; the deterministic recommendation stays", () => {
  it.each([
    [
      "an unknown candidate",
      ranking((c) => [
        {
          cutId: cutAt(c, "00:00:10:00"),
          choices: [{ candidateId: "cand:invented", reason: "x" }],
        },
      ]),
      /footage it wasn't offered/,
    ],
    [
      "a duplicate candidate",
      ranking((c) => [
        { cutId: cutAt(c, "00:00:10:00"), choices: [{ candidateId: "cand:park-1", reason: "x" }] },
        { cutId: cutAt(c, "00:00:17:00"), choices: [{ candidateId: "cand:park-1", reason: "y" }] },
      ]),
      /more than once/,
    ],
    [
      "an invalid cut",
      ranking(() => [
        { cutId: "cut:nope", choices: [{ candidateId: "cand:park-1", reason: "x" }] },
      ]),
      /cut it wasn't offered/,
    ],
    [
      "a source range",
      ranking((c) => [
        {
          cutId: cutAt(c, "00:00:10:00"),
          choices: [{ candidateId: "cand:park-1", reason: "x", sourceInFrame: 0 }],
        },
      ]),
      /may not have/,
    ],
    [
      "timeline commands",
      ranking(
        (c) => [
          {
            cutId: cutAt(c, "00:00:10:00"),
            choices: [{ candidateId: "cand:park-1", reason: "x" }],
          },
        ],
        { operations: [{ op: "place" }] },
      ),
      /may not have/,
    ],
    ["a malformed reply", { status: "ranking", ranking: "street first" }, /not a usable ranking/],
    [
      "the worker's invalid-response",
      { status: "invalid-response", reason: "The AI's reply could not be read." },
      /could not be read/,
    ],
  ])(
    "%s",
    async (_n, reply, msg) => {
      prepare();
      const disk = freshDisk();
      await launch(disk);
      const before = seq();
      cover();
      const deterministicId = pendingId();
      fakeRank.replies = [reply];
      improve();
      await settle(() => aiState() === "invalid");
      expect(aiText()).toMatch(msg);
      expect(aiText()).toMatch(
        /Nothing was changed; the deterministic recommendation is still available/,
      );
      expect(pendingId()).toBe(deterministicId);
      expect(source()).toBe("deterministic");
      expect(seq()).toBe(before);
      expect(fakeRank.requests).toHaveLength(1);
      await wait(200);
      expect(disk.saves2).toBe(0);
    },
    30000,
  );
});

describe("provider failure", () => {
  it("is explained, changes nothing, keeps the deterministic proposal, and is not retried by itself", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    cover();
    const deterministicId = pendingId();
    improve(); // no reply scripted: the worker answers "not configured"
    await settle(() => aiState() === "failed");
    expect(aiText()).toMatch(/AI ranking failed — No AI provider is configured/);
    expect(pendingId()).toBe(deterministicId);
    expect(seq()).toBe(before);
    await wait(500);
    expect(fakeRank.requests).toHaveLength(1);
    // The deterministic workflow still works end to end.
    click("proposal-accept");
    expect(Object.keys(seq().items)).toHaveLength(Object.keys(before.items).length + 2);
    expect(NOT_CONFIGURED.status).toBe("failed");
    await settle(() => disk.saves2 > 0);
  }, 30000);

  it("an engine that doesn't answer is a failure too", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    fakeRank.replies = [new Error("connection refused")];
    improve();
    await settle(() => aiState() === "failed");
    expect(aiText()).toMatch(/The local engine didn't answer/);
    expect(source()).toBe("deterministic");
  }, 30000);
});

describe("staleness and cancellation: a late reply never alters the proposal", () => {
  const slow = () => {
    fakeRank.replies = [STREET_AT_240];
    fakeRank.delayMs = 200;
  };

  it("the timeline changed while the AI was ranking", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    slow();
    improve();
    const e1 = itemOf(seq(), "event-1");
    dispatch("TrimEdit", { itemId: e1.id, edge: "in", deltaSourceFrames: 1 });
    await settle(() => aiState() === "stale");
    expect(aiText()).toMatch(/changed while the AI was ranking/);
    expect(source()).toBe("deterministic");
    expect(q("proposal-status")!.textContent).toBe("Out of date");
  }, 30000);

  it("another version was opened while the AI was ranking", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    slow();
    improve();
    act(() => ctx!.setActiveVersion("v1"));
    await settle(() => aiState() === "stale");
    expect(source()).toBe("deterministic");
  }, 30000);

  it("the B-roll inventory changed while the AI was ranking (a media role)", async () => {
    prepare();
    await launch(freshDisk());
    slow();
    let out: Awaited<ReturnType<NonNullable<typeof ctx>["askCoverageRanking"]>> | null = null;
    const asked = ctx!.askCoverageRanking().then((r) => (out = r));
    await act(async () => {
      expect(await ctx!.setMediaRole("clip-005", "interview")).toBe(true);
    });
    await act(async () => void (await asked));
    expect(out).toMatchObject({ status: "stale" });
    expect(fakeRank.requests).toHaveLength(1);
  }, 30000);

  it("Cancel: the answer is ignored when it arrives", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    const deterministicId = pendingId();
    slow();
    improve();
    click("cover-ai-cancel");
    expect(aiState()).toBe("cancelled");
    await wait(400);
    expect(fakeRank.requests).toHaveLength(1);
    expect(aiState()).toBe("cancelled");
    expect(pendingId()).toBe(deterministicId);
  }, 30000);

  it("leaving Cover mode, or asking again, drops the reply", async () => {
    prepare();
    await launch(freshDisk());
    cover();
    slow();
    improve();
    click("mode-edit");
    await wait(400);
    expect(pr!.pending).toBeNull();
    expect(q("cover-ai-status")).toBeNull();
    cover();
    slow();
    improve();
    click("cover-propose");
    await wait(400);
    expect(source()).toBe("deterministic");
    expect(q("cover-ai-status")).toBeNull();
  }, 30000);

  it("closing CUT while the AI is ranking saves nothing", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    cover();
    slow();
    improve();
    await quit();
    await wait(400);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);
});

describe("protection", () => {
  it("cuts touching protected interview footage are never offered; with none left, nothing is sent", async () => {
    prepare();
    await launch(freshDisk());
    const e2 = itemOf(seq(), "event-2");
    dispatch("SetProtection", { itemIds: [e2.id], aiLocked: true });
    cover();
    improve();
    await settle(() => aiState() === "refused");
    expect(aiText()).toMatch(/nothing to rank/);
    expect(fakeRank.requests).toHaveLength(0);
  }, 30000);

  it("with one cut protected, only the other is offered — and a ranking for the protected one is refused", async () => {
    prepare();
    await launch(freshDisk());
    const e3 = itemOf(seq(), "event-3");
    dispatch("SetProtection", { itemIds: [e3.id], aiLocked: true });
    cover();
    let protectedCut = "";
    fakeRank.replies = [
      (body: { context: Record<string, unknown> }) => {
        const c = body.context as unknown as Ctx;
        expect(c.cuts.map((x) => x.tc)).toEqual(["00:00:10:00"]);
        protectedCut = `cut:${itemOf(seq(), "event-2").id}|${e3.id}@408`;
        return ranking(() => [
          { cutId: protectedCut, choices: [{ candidateId: "cand:park-1", reason: "x" }] },
        ])(body);
      },
    ];
    improve();
    await settle(() => aiState() === "invalid");
    expect(aiText()).toMatch(/cut it wasn't offered/);
    expect(protectedCut).toMatch(/@408$/);
  }, 30000);
});
