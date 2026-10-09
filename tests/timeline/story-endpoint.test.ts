// Phase 6, Milestone 4 — the app side of POST /propose/story: the service
// call, the trust boundary (story-binding.ts) and the compiler judging what a
// worker-framed plan carries. Worker behaviour itself is tested in Python
// (worker/tests/test_story.py); here the replies are shaped exactly as the
// worker frames them. No provider, no network, no paid call.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EditVersion, Select, TranscriptSegment } from "@/lib/ae/types";
import { EngineClient, type EngineTransport } from "@/lib/ae/service";
import { createHistory } from "@/lib/timeline/history";
import { sequenceRevision, type ProposalContext } from "@/lib/timeline/proposals";
import { bindStoryPlan } from "@/lib/timeline/story-binding";
import { buildStoryContext } from "@/lib/timeline/story-context";
import { compileStoryPlan, type CompiledStoryPlan } from "@/lib/timeline/story-plan";
import type { Sequence } from "@/lib/timeline/types";
import {
  importedSequence,
  sequenceOf,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf } from "./engine-helpers";
import { directorCut, projectClips } from "./legacy-fixtures";
import { itemIdOf } from "./proposal-fixtures";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateRequest } = require("../../electron/allowlist.cjs");

const media = mediaOf(projectClips);
const director: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.1",
  command: "c",
  summary: "s",
  createdAt: "—",
  changes: [],
  timeline: directorCut,
};
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const ctxOf = (ws: Workspace, active = "v2"): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});
const seqOf = (ws: Workspace, v = "v2") => sequenceOf(ws, v, projectClips)!;
const id = (s: Sequence, name: string) => itemIdOf(s, name);

const TRANSCRIPT: TranscriptSegment[] = [
  {
    id: "t-e2a",
    clipId: "clip-002",
    speaker: "Unknown speaker",
    startTc: "00:00:28:00",
    endTc: "00:00:31:00",
    text: "They built the highway right through it.",
    confidence: 0.9,
  },
];
const SELECTS: Select[] = [
  {
    id: "sel-03",
    rank: 1,
    speaker: "Unknown speaker",
    clipId: "clip-002",
    clipName: "clip-002",
    startTc: "00:00:43:00",
    endTc: "00:00:49:00",
    durationSeconds: 6,
    score: 85,
    category: "context",
    transcriptExcerpt: "…",
    reasons: [],
    evidence: [],
  },
];
const ANALYSIS = { selects: SELECTS, transcript: TRANSCRIPT, stories: [], chosenStoryId: null };
const ASK = "Start with the context, then the strong statement.";

/** A worker reply to POST /propose/story for this context, framed exactly as
 * worker/story.py frames it: envelope from the request, the rest from the model. */
function workerReply(ws: Workspace, model: Record<string, unknown>, v = "v2") {
  const c = buildStoryContext(ctxOf(ws, v), ANALYSIS, projectClips)!;
  const { status: _s, schema: _sc, base: _b, instruction: _i, ...rest } = model;
  return {
    status: "plan",
    plan: {
      schema: "ae.story-plan/1",
      base: { versionId: c.versionId, revision: c.revision },
      instruction: ASK,
      ...rest,
      summary: typeof rest["summary"] === "string" ? rest["summary"] : "Director story plan.",
    },
  };
}
/** What a model would answer: e3 before e2 (e4 lies wholly inside e3 — kept). */
const goodModel = (s: Sequence) => ({
  status: "plan",
  summary: "Context first, then the statement.",
  order: ["event-1", "event-3", "event-2", "event-5", "event-6"].map((n) => id(s, n)),
  cutaways: { [id(s, "event-4")]: "keep" },
  rationale: [
    {
      clipId: id(s, "event-3"),
      reason: "Context first.",
      evidence: [{ kind: "select", id: "sel-03" }],
    },
    {
      clipId: id(s, "event-2"),
      reason: "Then the statement.",
      evidence: [{ kind: "transcript", id: "t-e2a" }],
    },
  ],
});

const binding = (ws: Workspace, v = "v2", projectId = "proj-1") => ({
  projectId,
  versionId: v,
  revision: sequenceRevision(seqOf(ws, v)),
});
/** The whole app-side path after the service call: bind, then compile. */
function receive(ws: Workspace, reply: { plan: Record<string, unknown> }, live = binding(ws)) {
  const bound = bindStoryPlan(reply.plan, { instruction: ASK, binding: binding(ws) }, live);
  if (!bound.ok) return { bound };
  return { bound, compiled: compileStoryPlan(bound.plan, ctxOf(ws), ANALYSIS) };
}
const codes = (r: CompiledStoryPlan | undefined) =>
  !r ? [] : r.ok ? [] : r.issues.map((i) => i.code);

describe("EngineClient.proposeStory", () => {
  const client = (answer: unknown) => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const transport: EngineTransport = {
      id: "direct-loopback",
      label: "fake",
      target: "fake",
      request: async (req: { path: string; method?: string; body?: unknown }) => {
        calls.push(req);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as EngineTransport;
    return { c: new EngineClient(transport), calls };
  };

  it("posts the instruction and story context to /propose/story", async () => {
    const { c, calls } = client({ status: "refused", reason: "No." });
    await c.proposeStory(ASK, { schema: "ae.story-context/1" });
    expect(calls).toEqual([
      expect.objectContaining({
        path: "/propose/story",
        method: "POST",
        body: { instruction: ASK, context: { schema: "ae.story-context/1" } },
      }),
    ]);
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ["a plan", { status: "plan", plan: { order: [] } }, { status: "plan", plan: { order: [] } }],
    ["a plan that isn't an object", { status: "plan", plan: [1] }, { status: "invalid" }],
    [
      "a refusal",
      { status: "refused", reason: "Can't split clips yet." },
      { status: "refused", reason: "Can't split clips yet." },
    ],
    [
      "a provider failure",
      { status: "failed", aiFailure: { message: "needs an Anthropic API key", retryable: false } },
      { status: "failed", message: "needs an Anthropic API key", retryable: false },
    ],
    [
      "an unusable reply",
      { status: "invalid-response", reason: "Not a plan." },
      { status: "invalid", reason: "Not a plan." },
    ],
    [
      "a bad request",
      { status: "invalid-request", reason: "Too long." },
      { status: "invalid", reason: "Too long." },
    ],
    ["an older engine", { error: "not found" }, { status: "invalid" }],
  ])("maps %s", async (_n, answer, want) => {
    expect(await client(answer).c.proposeStory(ASK, {})).toMatchObject(want);
  });

  it("never throws: the engine not answering is a retryable failure", async () => {
    const out = await client(new Error("socket hang up")).c.proposeStory(ASK, {});
    expect(out).toMatchObject({ status: "failed", retryable: true });
  });

  it("the route is allowlisted for the renderer — POST only", () => {
    expect(validateRequest("POST", "/propose/story").ok).toBe(true);
    expect(validateRequest("GET", "/propose/story").ok).toBe(false);
    expect(validateRequest("POST", "/propose/story/x").ok).toBe(false);
    expect(validateRequest("POST", "/propose").ok).toBe(true); // Phase 5 unchanged
  });
});

describe("binding: the plan belongs to the exact cut it was asked about", () => {
  it("a well-formed worker plan binds, compiles and passes review", () => {
    const ws = fresh();
    const { bound, compiled } = receive(ws, workerReply(ws, goodModel(seqOf(ws))));
    expect(bound.ok).toBe(true);
    expect(compiled?.ok, JSON.stringify(compiled)).toBe(true);
    if (compiled?.ok)
      expect(compiled.proposal["operations"]).toEqual([
        { op: "reorder", itemIds: [id(seqOf(ws), "event-3"), id(seqOf(ws), "event-2")] },
      ]);
  });

  it("the app — not the reply — sets the schema, instruction and base", () => {
    const ws = fresh();
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    reply.plan.schema = "ae.story-plan/9";
    reply.plan.instruction = "Something else";
    const bound = bindStoryPlan(
      reply.plan,
      { instruction: ASK, binding: binding(ws) },
      binding(ws),
    );
    expect(bound.ok && [bound.plan["schema"], bound.plan["instruction"]]).toEqual([
      "ae.story-plan/1",
      ASK,
    ]);
  });

  it.each([
    ["another revision", { revision: "rev_0123456789abcdef_1a" }],
    ["another version", { versionId: "ver_other" }],
    ["an extra base field", { authorized: true }],
  ])("a reply claiming %s is refused", (_n, patch) => {
    const ws = fresh();
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    reply.plan.base = { ...(reply.plan.base as object), ...patch } as typeof reply.plan.base;
    const { bound } = receive(ws, reply);
    expect(bound.ok ? null : bound.reason).toMatch(/claimed a different version/);
  });

  it("stale: the cut, the version or the project changed while the Director worked", () => {
    const ws = fresh();
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    const live = binding(ws);
    for (const changed of [
      { ...live, revision: "rev_0123456789abcdef_9z" },
      { ...live, versionId: "ver_w" },
      { ...live, projectId: "proj-2" },
      null,
    ]) {
      const { bound } = receive(ws, reply, changed as typeof live);
      expect(bound.ok ? null : bound.reason).toMatch(
        /The cut changed while the Director was working/,
      );
    }
  });

  it("a plan made against a cut that has since changed is refused again by the compiler (defence in depth)", () => {
    const ws = fresh();
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    const later = deepFreeze({
      versions: [
        structuredClone(director),
        { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
      ],
      histories: {
        ver_w: createHistory(
          (() => {
            const s = structuredClone(importedSequence(director, projectClips)) as Sequence;
            s.items[id(s, "event-7")]!.startFrame += 1;
            return s;
          })(),
        ),
      },
    } as Workspace);
    const r = compileStoryPlan(
      { ...reply.plan, base: { ...(reply.plan.base as object), versionId: "ver_w" } },
      ctxOf(later, "ver_w"),
      ANALYSIS,
    );
    expect(codes(r)).toEqual(["stale"]);
  });

  it("an oversized reply is refused", () => {
    const ws = fresh();
    const reply = workerReply(ws, { ...goodModel(seqOf(ws)), summary: "x".repeat(70_000) });
    expect(receive(ws, reply).bound.ok).toBe(false);
  });
});

describe("what the worker passes through, the compiler judges", () => {
  const judge = (model: (s: Sequence) => Record<string, unknown>) => {
    const ws = fresh();
    const before = JSON.stringify(ws);
    const { compiled } = receive(ws, workerReply(ws, model(seqOf(ws))));
    expect(JSON.stringify(ws)).toBe(before); // nothing is ever applied
    return codes(compiled);
  };

  it.each<[string, (s: Sequence) => Record<string, unknown>, string[]]>([
    [
      "invented clip ids",
      (s) => ({
        ...goodModel(s),
        order: [...goodModel(s).order.slice(0, 4), "itm_invented", id(s, "event-6")],
      }),
      ["unknown-clip"],
    ],
    [
      "a missing clip",
      (s) => ({ ...goodModel(s), order: goodModel(s).order.slice(0, 4) }),
      ["incomplete-order"],
    ],
    [
      "invented evidence",
      (s) => ({
        ...goodModel(s),
        rationale: [
          { clipId: id(s, "event-3"), reason: "x", evidence: [{ kind: "select", id: "sel-404" }] },
          goodModel(s).rationale[1],
        ],
      }),
      ["unknown-evidence"],
    ],
    [
      "evidence from the wrong clip",
      (s) => ({
        ...goodModel(s),
        rationale: [
          {
            clipId: id(s, "event-3"),
            reason: "x",
            evidence: [{ kind: "transcript", id: "t-e2a" }],
          },
          goodModel(s).rationale[1],
        ],
      }),
      ["wrong-clip-evidence"],
    ],
    [
      "an invalid cutaway decision",
      (s) => ({ ...goodModel(s), cutaways: { [id(s, "event-4")]: "move" } }),
      ["malformed"],
    ],
    [
      "a decision for an unknown cutaway",
      (s) => ({ ...goodModel(s), cutaways: { [id(s, "event-4")]: "keep", itm_ghost: "remove" } }),
      ["invalid-cutaway-decision"],
    ],
    [
      "a missing cutaway decision",
      (s) => ({ ...goodModel(s), cutaways: {} }),
      ["cutaway-decision-missing"],
    ],
    [
      "no order",
      (s) => {
        const { order: _o, ...m } = goodModel(s);
        return m;
      },
      ["malformed"],
    ],
    [
      "no rationale for a moved clip",
      (s) => ({ ...goodModel(s), rationale: [goodModel(s).rationale[0]] }),
      ["missing-rationale"],
    ],
    ["frame positions", (s) => ({ ...goodModel(s), startFrame: 120 }), ["malformed"]],
    ["self-authorization", (s) => ({ ...goodModel(s), allowManual: true }), ["self-authorization"]],
  ])("%s", (_n, model, want) => {
    expect(judge(model)).toEqual(want);
  });
});

describe("trust boundary — end to end", () => {
  const protectedWs = (fn: (s: Sequence) => void) => {
    const s = structuredClone(importedSequence(director, projectClips)) as Sequence;
    fn(s);
    return deepFreeze({
      versions: [
        structuredClone(director),
        { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
      ],
      histories: { ver_w: createHistory(deepFreeze(s)) },
    } as Workspace);
  };

  it("protected and hand-edited clips stay protected: bind → compile → review refuses, nothing applied", () => {
    for (const [name, fn, code] of [
      [
        "AI-protected",
        (s: Sequence) => (s.items[id(s, "event-3")]!.protection.aiLocked = true),
        "protected",
      ],
      [
        "locked",
        (s: Sequence) => (s.items[id(s, "event-2")]!.protection.locked = true),
        "protected",
      ],
      [
        "hand-edited",
        (s: Sequence) => (s.items[id(s, "event-3")]!.editedBy = "manual"),
        "manual-conflict",
      ],
    ] as const) {
      const ws = protectedWs(fn);
      const before = JSON.stringify(ws);
      const reply = workerReply(ws, goodModel(seqOf(ws, "ver_w")), "ver_w");
      const live = binding(ws, "ver_w");
      const bound = bindStoryPlan(reply.plan, { instruction: ASK, binding: live }, live);
      if (!bound.ok) throw new Error(bound.reason);
      const r = compileStoryPlan(bound.plan, ctxOf(ws, "ver_w"), ANALYSIS);
      expect(r.ok, name).toBe(false);
      if (!r.ok)
        expect(
          r.issues.map((i) => i.review?.code),
          name,
        ).toContain(code);
      expect(JSON.stringify(ws)).toBe(before);
    }
  });

  it("extra fields anywhere in the plan are refused", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const m = goodModel(s);
    for (const model of [
      { ...m, rationale: [{ ...m.rationale[0], weight: 1 }, m.rationale[1]] },
      {
        ...m,
        rationale: [
          { ...m.rationale[0], evidence: [{ kind: "select", id: "sel-03", confidence: 1 }] },
          m.rationale[1],
        ],
      },
      { ...m, operations: [{ op: "reorder", itemIds: [] }] },
    ]) {
      const { compiled } = receive(ws, workerReply(ws, model));
      expect(codes(compiled)).toEqual(["malformed"]);
    }
  });

  it("a plan for one project can't be applied in another — even to an identical cut", () => {
    // Two projects with the same cut have the same version id and revision:
    // the compiler alone can't tell them apart; the binding's project check does.
    const ws = fresh();
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    const sent = binding(ws, "v2", "proj-1");
    const otherProject = { ...sent, projectId: "proj-2" };
    expect(compileStoryPlan(reply.plan, ctxOf(ws), ANALYSIS).ok).toBe(true); // identical cut
    const bound = bindStoryPlan(reply.plan, { instruction: ASK, binding: sent }, otherProject);
    expect(bound.ok ? null : bound.reason).toMatch(
      /The cut changed while the Director was working/,
    );
  });

  it("a delayed reply: the binding captured at send time is checked against the cut at arrival", () => {
    const ws = fresh();
    const sent = binding(ws); // captured BEFORE the request
    const reply = workerReply(ws, goodModel(seqOf(ws)));
    // While waiting, the filmmaker edits (a new revision in a working version)…
    const edited = protectedWs((s) => (s.items[id(s, "event-7")]!.startFrame += 1));
    const arrivalEdited = binding(edited, "ver_w");
    // …or switches back to the same version with nothing changed.
    for (const [live, ok] of [
      [arrivalEdited, false],
      [{ ...sent, versionId: "v1" }, false],
      [sent, true],
    ] as const) {
      const bound = bindStoryPlan(reply.plan, { instruction: ASK, binding: sent }, live);
      expect(bound.ok).toBe(ok);
    }
  });
});

/* A cross-language contract: the REAL worker module frames a fake model reply,
 * and the app's binding + compiler accept exactly that output. */

const WORKER = resolve(__dirname, "../../worker");
const PYTHON = resolve(WORKER, ".venv/bin/python");

function realWorker(
  instruction: string,
  context: unknown,
  model: unknown,
): Record<string, unknown> {
  const code = [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "import tests._no_real_credentials",
    "import story",
    "from tests.fakes import FakeReasoningProvider",
    "req = json.load(sys.stdin)",
    "print(json.dumps(story.propose_story(req['instruction'], req['context'],",
    "      reasoning_provider=FakeReasoningProvider(req['model']))))",
  ].join("\n");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };
  const out = execFileSync(PYTHON, ["-c", code], {
    cwd: WORKER,
    env,
    input: JSON.stringify({ instruction, context, model }),
  });
  const lines = out.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

describe.skipIf(!existsSync(PYTHON))("the real worker's output, through the app's boundary", () => {
  it("a plan from worker/story.py binds, compiles and passes review", () => {
    const ws = fresh();
    const context = buildStoryContext(ctxOf(ws), ANALYSIS, projectClips)!;
    const res = realWorker(ASK, context, {
      ...goodModel(seqOf(ws)),
      base: { versionId: "ver_spoofed", revision: "rev_0000000000000000_0" }, // ignored by the worker
    });
    expect(res["status"]).toBe("plan");
    const live = binding(ws);
    const bound = bindStoryPlan(res["plan"], { instruction: ASK, binding: live }, live);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const r = compileStoryPlan(bound.plan, ctxOf(ws), ANALYSIS);
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
  }, 30000);

  it("whatever the model adds is passed through by the worker and refused by the app", () => {
    const ws = fresh();
    const context = buildStoryContext(ctxOf(ws), ANALYSIS, projectClips)!;
    const s = seqOf(ws);
    for (const [extra, code] of [
      [{ allowManual: true }, "self-authorization"],
      [{ startFrame: 0 }, "malformed"],
      [{ order: ["itm_invented", ...goodModel(s).order.slice(1)] }, "unknown-clip"],
    ] as const) {
      const res = realWorker(ASK, context, { ...goodModel(s), ...extra });
      const live = binding(ws);
      const bound = bindStoryPlan(res["plan"], { instruction: ASK, binding: live }, live);
      if (!bound.ok) throw new Error(bound.reason);
      expect(codes(compileStoryPlan(bound.plan, ctxOf(ws), ANALYSIS))).toContain(code);
    }
  }, 30000);
});
