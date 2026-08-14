// @vitest-environment node
// Real loopback HTTP server test: needs node fetch, not the jsdom-style env.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PremiereBridge } = require("../electron/premiere-bridge.cjs");

type Bridge = {
  start(): Promise<{ ok: boolean; endpoint?: string; error?: string }>;
  stop(): void;
  status(): Record<string, unknown>;
  enqueueCommand(cmd: unknown): { ok: boolean; error?: string };
  port: number;
};

const bridge: Bridge = new PremiereBridge({ port: 32246 });
const base = "http://127.0.0.1:32246";

const post = (body: unknown, origin = "app://premierepro") =>
  fetch(`${base}/premiere/message`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  const res = await bridge.start();
  expect(res.ok).toBe(true);
});
afterAll(() => bridge.stop());

describe("premiere bridge server", () => {
  it("serves health before any handshake", async () => {
    const body = await (await fetch(`${base}/premiere/health`)).json();
    expect(body.ok).toBe(true);
    expect(body.connected).toBe(false);
    expect(body.protocolVersion).toBe("1.0.0");
  });

  it("completes a handshake and reports capabilities", async () => {
    const res = await post({
      v: 1,
      id: "h1",
      type: "handshake",
      payload: {
        protocolVersion: "1.0.0",
        pluginVersion: "0.4.0",
        host: "premierepro",
        hostVersion: "25.1.0",
        capabilities: { "project.read": true, "sequence.read": true },
      },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.type).toBe("handshake.ack");
    expect(body.sessionToken).toBeTruthy();

    const health = await (await fetch(`${base}/premiere/health`)).json();
    expect(health.connected).toBe(true);
    expect(health.pluginVersion).toBe("0.4.0");
    expect(health.capabilities["project.read"]).toBe(true);
  });

  it("records project and sequence state", async () => {
    await post({ v: 1, id: "p1", type: "project.state", payload: { id: "pr1", name: "Community Doc", itemCount: 12 } });
    await post({ v: 1, id: "s1", type: "sequence.state", payload: { id: "sq1", name: "Rough Cut", fps: 25 } });
    const health = await (await fetch(`${base}/premiere/health`)).json();
    expect(health.project.name).toBe("Community Doc");
    expect(health.sequence.name).toBe("Rough Cut");
  });

  it("queues and drains only allowlisted commands", async () => {
    expect(bridge.enqueueCommand({ type: "analyze" }).ok).toBe(true);
    expect(bridge.enqueueCommand({ type: "shell.exec" }).ok).toBe(false);
    const drained = await (await fetch(`${base}/premiere/commands`)).json();
    expect(drained.commands).toHaveLength(1);
    expect(drained.commands[0].type).toBe("analyze");
    const again = await (await fetch(`${base}/premiere/commands`)).json();
    expect(again.commands).toHaveLength(0);
  });

  it("rejects unknown routes, methods and browser origins", async () => {
    expect((await fetch(`${base}/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/premiere/message`)).status).toBe(404);
    expect((await fetch(`${base}/premiere/health`, { method: "DELETE" })).status).toBe(405);
    const browser = await post({ v: 1, id: "x1", type: "diagnostics.ping", payload: {} }, "https://evil.test");
    expect(browser.status).toBe(403);
  });

  it("rejects malformed and oversized payloads without crashing", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ v: 1, id: "x2", type: "exec", payload: {} })).status).toBe(400);
    const big = JSON.stringify({ v: 1, id: "x3", type: "diagnostics.ping", payload: { blob: "a".repeat(80000) } });
    expect((await post(big)).status).toBe(413);
    const health = await (await fetch(`${base}/premiere/health`)).json();
    expect(health.connected).toBe(true);
    expect(health.rejected).toBeGreaterThan(0);
  });
});