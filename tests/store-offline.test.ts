// P0 Step 5: an unavailable engine must be an explicit "offline" error state —
// never a silent switch to Demo Mode fixture data. Mounts the real AEProvider
// (happy-dom) with the desktop bridge/worker APIs mocked the way
// electron/preload.cjs exposes them.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AEProvider, useAE } from "@/lib/ae/store";
import { demoProject } from "@/lib/ae/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useAE>;
let ctx: Ctx | null = null;
let root: Root | null = null;

function Probe(): ReactNode {
  ctx = useAE();
  return null;
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(createElement(AEProvider, null, createElement(Probe)));
  });
}

async function settle(until: (c: Ctx) => boolean) {
  for (let i = 0; i < 100; i++) {
    if (ctx && until(ctx)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`state never settled (connection=${ctx?.connection})`);
}

const unreachable = vi.fn(async () => ({
  status: 0,
  body: null,
  error: "Worker unreachable at 127.0.0.1:32145",
}));

beforeEach(() => {
  window.localStorage.clear();
  window.assistantEditorBridge = { request: unreachable };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  ctx = null;
  delete window.assistantEditorBridge;
  delete window.assistantEditorWorker;
  vi.clearAllMocks();
});

function workerApi(
  status: Awaited<ReturnType<NonNullable<Window["assistantEditorWorker"]>["status"]>>,
) {
  return {
    available: true as const,
    status: vi.fn(async () => status),
    waitUntilReady: vi.fn(async () => status),
    restart: vi.fn(async () => status),
  };
}

describe("engine unavailable → explicit offline state, never Demo Mode", () => {
  it("surfaces a worker startup failure (with its log lines) instead of loading fixtures", async () => {
    window.assistantEditorWorker = workerApi({
      state: "error",
      owned: false,
      pid: null,
      url: "http://127.0.0.1:32145",
      error: {
        kind: "exited-early",
        message: "The worker exited before it became healthy (exit code 1).",
        logTail: ["ModuleNotFoundError: No module named 'flask'"],
      },
    });
    await mount();
    await settle((c) => c.connection !== "connecting");

    expect(ctx!.connection).toBe("offline");
    expect(ctx!.mode).toBe("auto");
    expect(ctx!.connectionError).toContain("exited before it became healthy");
    expect(ctx!.engineStartupError?.logTail).toEqual([
      "ModuleNotFoundError: No module named 'flask'",
    ]);
    // Nothing from the fixtures leaked in.
    expect(ctx!.project?.id).not.toBe(demoProject.id);
    expect(ctx!.selects).toEqual([]);
    expect(ctx!.stories).toEqual([]);
    expect(ctx!.versions).toHaveLength(1);
    expect(ctx!.versions[0]!.timeline.decisions).toEqual([]);
    // It never even tried the engine before the worker reported ready.
    expect(unreachable).not.toHaveBeenCalled();
  });

  it("goes offline (not demo) when /health is unreachable, with or without the desktop worker API", async () => {
    await mount();
    await settle((c) => c.connection !== "connecting");
    expect(ctx!.connection).toBe("offline");
    expect(ctx!.connectionError).toContain("Worker unreachable");
    expect(ctx!.project?.id).not.toBe(demoProject.id);
  });

  it("never fabricates a Director edit or a fake analysis while offline", async () => {
    await mount();
    await settle((c) => c.connection === "offline");
    await act(async () => {
      await ctx!.runCommand("make the opening stronger");
    });
    expect(ctx!.versions).toHaveLength(1); // no simulated version appeared
    expect(ctx!.connectionError).toContain("offline");
  });

  it("asks the desktop worker to restart on Reconnect after a failure", async () => {
    const api = workerApi({
      state: "error",
      owned: false,
      pid: null,
      url: "x",
      error: { kind: "health-timeout", message: "timed out" },
    });
    window.assistantEditorWorker = api;
    await mount();
    await settle((c) => c.connection === "offline");
    await act(async () => {
      ctx!.retryConnection();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(api.restart).toHaveBeenCalledTimes(1);
  });

  it("still allows Demo Mode when it is chosen deliberately", async () => {
    await mount();
    await settle((c) => c.connection === "offline");
    await act(async () => ctx!.setMode("demo"));
    await settle((c) => c.connection === "demo");
    expect(ctx!.project?.id).toBe(demoProject.id);
  });
});
