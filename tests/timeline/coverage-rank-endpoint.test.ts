// Phase 7, Milestone 6 — the app side of POST /propose/coverage-rank: the
// service maps every worker answer to a typed result without trusting it, and
// the renderer's bridge allowlist admits the route (POST only).
import { describe, expect, it } from "vitest";
import { EngineClient, type EngineTransport } from "@/lib/ae/service";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateRequest } = require("../../electron/allowlist.cjs");

const client = (answer: unknown) => {
  const calls: Array<{ path: string; method?: string; body?: unknown; timeoutMs?: number }> = [];
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

describe("EngineClient.rankCoverage", () => {
  it("posts only the ranking context to /propose/coverage-rank, once", async () => {
    const { c, calls } = client({ status: "refused", reason: "No match." });
    await c.rankCoverage({ schema: "ae.coverage-rank-context/1" });
    expect(calls).toEqual([
      expect.objectContaining({
        path: "/propose/coverage-rank",
        method: "POST",
        body: { context: { schema: "ae.coverage-rank-context/1" } },
      }),
    ]);
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    [
      "a ranking",
      { status: "ranking", ranking: { rankings: [] } },
      { status: "ranking", ranking: { rankings: [] } },
    ],
    [
      "a ranking that isn't an object",
      { status: "ranking", ranking: ["x"] },
      { status: "invalid" },
    ],
    [
      "a refusal",
      { status: "refused", reason: "Nothing fits." },
      { status: "refused", reason: "Nothing fits." },
    ],
    [
      "a provider failure",
      { status: "failed", aiFailure: { message: "needs an Anthropic API key", retryable: false } },
      { status: "failed", message: "needs an Anthropic API key", retryable: false },
    ],
    [
      "an unusable reply",
      { status: "invalid-response", reason: "Not a ranking." },
      { status: "invalid", reason: "Not a ranking." },
    ],
    [
      "a bad request",
      { status: "invalid-request", reason: "Too large." },
      { status: "invalid", reason: "Too large." },
    ],
    [
      "an older engine",
      { error: "not found" },
      { status: "invalid", reason: "The engine doesn't support AI ranking yet." },
    ],
  ])("maps %s", async (_n, answer, want) => {
    expect(await client(answer).c.rankCoverage({})).toMatchObject(want);
  });

  it("bounds the worker's text it passes on", async () => {
    const out = await client({ status: "refused", reason: "x".repeat(5000) }).c.rankCoverage({});
    expect(out.status === "refused" && out.reason.length).toBe(1000);
  });

  it("never throws: the engine not answering is a retryable failure", async () => {
    const out = await client(new Error("socket hang up")).c.rankCoverage({});
    expect(out).toMatchObject({ status: "failed", retryable: true });
  });

  it("the route is allowlisted for the renderer — POST only", () => {
    expect(validateRequest("POST", "/propose/coverage-rank").ok).toBe(true);
    expect(validateRequest("GET", "/propose/coverage-rank").ok).toBe(false);
    expect(validateRequest("POST", "/propose/coverage-rank/x").ok).toBe(false);
    expect(validateRequest("POST", "/propose/coverage").ok).toBe(false);
  });
});
