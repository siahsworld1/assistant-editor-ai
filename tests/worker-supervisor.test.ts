// @vitest-environment node
// Real child processes and real loopback sockets: the supervisor is exercised
// against a tiny fake worker (a Node script) whose behavior is chosen per test,
// on a free port per test — never the real 32145.
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sup = require("../electron/worker-supervisor.cjs");

type Status = {
  state: string;
  owned: boolean;
  pid: number | null;
  error: { kind: string; message: string; logTail?: string[] } | null;
};
type Supervisor = {
  start(): Promise<Status>;
  stop(): Promise<void>;
  status(): Status;
  waitUntilReady(): Promise<Status>;
  restart(): Promise<Status>;
  logTail: string[];
};

const FAKE_WORKER = `
const http = require("node:http");
const mode = process.env.FAKE_MODE;
const port = Number(process.env.FAKE_PORT);
if (process.env.FAKE_PRINT) console.log(process.env.FAKE_PRINT);
if (mode === "exit") { console.error("ModuleNotFoundError: No module named 'flask'"); process.exit(3); }
if (mode === "ignore-term") process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
if (mode === "never") { setInterval(() => {}, 1000); return; }
const delay = Number(process.env.FAKE_DELAY || 0);
setTimeout(() => {
  http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const pid = mode === "wrong-pid" ? 1 : process.pid;
    res.end(JSON.stringify({ ok: true, service: "assistant-editor-worker", pid, version: "test" }));
  }).listen(port, "127.0.0.1", () => console.log("fake worker listening"));
  if (mode === "crash-after-ready") setTimeout(() => process.exit(9), 300);
}, delay);
`;
const dir = mkdtempSync(path.join(tmpdir(), "ae-supervisor-test-"));
const script = path.join(dir, "fake-worker.cjs");
writeFileSync(script, FAKE_WORKER);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeSupervisor(
  port: number,
  opts: {
    mode?: string;
    extraEnv?: Record<string, string>;
    command?: string;
    startTimeoutMs?: number;
    stopGraceMs?: number;
    spawnImpl?: unknown;
  } = {},
): Supervisor {
  const s: Supervisor = new sup.WorkerSupervisor({
    port,
    startTimeoutMs: opts.startTimeoutMs ?? 8000,
    stopGraceMs: opts.stopGraceMs ?? 1000,
    env: {
      ...process.env,
      FAKE_MODE: opts.mode ?? "healthy",
      FAKE_PORT: String(port),
      ...opts.extraEnv,
    },
    launch: () => ({
      ok: true,
      command: opts.command ?? process.execPath,
      args: [script],
      cwd: dir,
      description: "fake worker",
    }),
    log: () => {},
    ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
  });
  cleanups.push(() => s.stop());
  return s;
}

function serve(port: number, handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(port, "127.0.0.1", () => resolve(srv));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => r());
        }),
    );
  });
}

describe("WorkerSupervisor — startup", () => {
  it("spawns the worker, waits for a healthy /health from THAT process, and owns it", async () => {
    const port = await freePort();
    const s = makeSupervisor(port, { extraEnv: { FAKE_DELAY: "400" } }); // not listening immediately
    const status = await s.start();
    expect(status.state).toBe("ready");
    expect(status.owned).toBe(true);
    expect(status.pid).toBeGreaterThan(0);
    const health = await sup.fetchHealth({ port });
    expect(health.body.pid).toBe(status.pid);
  });

  it("gives up after the bounded startup timeout and kills the worker it started", async () => {
    const port = await freePort();
    const s = makeSupervisor(port, { mode: "never", startTimeoutMs: 700 });
    const started = Date.now();
    const status = await s.start();
    expect(status.state).toBe("error");
    expect(status.error!.kind).toBe("health-timeout");
    expect(Date.now() - started).toBeLessThan(5000);
    // The pid it spawned is gone — no orphan left behind.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(status.pid!)).toBe(false);
  });

  it("reports a worker that exits before becoming healthy, with its real stderr", async () => {
    const port = await freePort();
    const status = await makeSupervisor(port, { mode: "exit" }).start();
    expect(status.state).toBe("error");
    expect(status.error!.kind).toBe("exited-early");
    expect(status.error!.message).toContain("exit code 3");
    expect(status.error!.logTail!.join("\n")).toContain("No module named 'flask'");
  });

  it("reports a missing Python executable clearly", async () => {
    const port = await freePort();
    const status = await makeSupervisor(port, { command: "/definitely/not/python3" }).start();
    expect(status.state).toBe("error");
    expect(status.error!.kind).toBe("python-missing");
    expect(status.error!.message).toContain("/definitely/not/python3");
  });

  it("refuses a worker whose /health is answered by a different process", async () => {
    const port = await freePort();
    const status = await makeSupervisor(port, { mode: "wrong-pid" }).start();
    expect(status.state).toBe("error");
    expect(status.error!.kind).toBe("port-conflict");
  });

  it("flags a worker that crashes after becoming ready", async () => {
    const port = await freePort();
    const s = makeSupervisor(port, { mode: "crash-after-ready" });
    expect((await s.start()).state).toBe("ready");
    await new Promise((r) => setTimeout(r, 800));
    expect(s.status().state).toBe("error");
    expect(s.status().error!.kind).toBe("crashed");
  });

  it("restart() brings a failed worker back", async () => {
    const port = await freePort();
    const s = makeSupervisor(port, { mode: "crash-after-ready" });
    await s.start();
    await new Promise((r) => setTimeout(r, 800));
    expect(s.status().state).toBe("error");
    expect((await s.restart()).state).toBe("ready");
  });
});

describe("WorkerSupervisor — port already in use", () => {
  it("adopts a healthy Assistant Editor worker that is already running, without spawning or owning it", async () => {
    const port = await freePort();
    await serve(port, (_req, res) =>
      res.end(JSON.stringify({ ok: true, service: "assistant-editor-worker", pid: 4242 })),
    );
    const spawnImpl = vi.fn();
    const s = makeSupervisor(port, { spawnImpl });
    const status = await s.start();
    expect(status.state).toBe("ready");
    expect(status.owned).toBe(false);
    expect(status.pid).toBe(4242);
    expect(spawnImpl).not.toHaveBeenCalled();
    await s.stop(); // must not touch the adopted worker
    expect((await sup.fetchHealth({ port })).ok).toBe(true);
  });

  it("reports an unrelated HTTP server as a conflict and leaves it running", async () => {
    const port = await freePort();
    await serve(port, (_req, res) => {
      res.statusCode = 404;
      res.end("<html>not here</html>");
    });
    const spawnImpl = vi.fn();
    const status = await makeSupervisor(port, { spawnImpl }).start();
    expect(status.state).toBe("error");
    expect(status.error!.kind).toBe("port-conflict");
    expect(status.error!.message).toContain(`Port ${port} is in use by another program`);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404); // untouched
  });

  it("reports a non-HTTP listener on the port as a conflict", async () => {
    const port = await freePort();
    const sockets = new Set<net.Socket>();
    const srv = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {}); // the probe hangs up abruptly — expected
      sock.end("not http\r\n");
    });
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          for (const sock of sockets) sock.destroy();
          srv.close(() => r());
        }),
    );
    const status = await makeSupervisor(port, { spawnImpl: vi.fn() }).start();
    expect(status.error!.kind).toBe("port-conflict");
  });

  it("reports an older (pre-identity) Assistant Editor worker instead of silently using stale code", async () => {
    const port = await freePort();
    await serve(port, (_req, res) =>
      res.end(
        JSON.stringify({ ok: true, version: "0.1.0-real-engine", capabilities: { health: true } }),
      ),
    );
    const status = await makeSupervisor(port, { spawnImpl: vi.fn() }).start();
    expect(status.error!.kind).toBe("port-conflict");
    expect(status.error!.message).toContain("older Assistant Editor worker");
  });
});

describe("WorkerSupervisor — shutdown", () => {
  it("stops the worker it owns and leaves no process behind", async () => {
    const port = await freePort();
    const s = makeSupervisor(port);
    const { pid } = await s.start();
    expect(isAlive(pid!)).toBe(true);
    await s.stop();
    expect(isAlive(pid!)).toBe(false);
    expect(s.status().owned).toBe(false);
    expect((await sup.fetchHealth({ port, timeoutMs: 300 })).ok).toBe(false);
  });

  it("escalates to SIGKILL when the worker ignores SIGTERM", async () => {
    const port = await freePort();
    const s = makeSupervisor(port, { mode: "ignore-term", stopGraceMs: 300 });
    const { pid } = await s.start();
    await s.stop();
    expect(isAlive(pid!)).toBe(false);
  });
});

describe("WorkerSupervisor — logging", () => {
  it("redacts API keys from captured worker output", async () => {
    const port = await freePort();
    const secret = "sk-test-0123456789abcdefSECRET";
    const s = makeSupervisor(port, {
      mode: "exit",
      extraEnv: {
        OPENAI_API_KEY: secret,
        FAKE_PRINT: `debug key=${secret} other=sk-ant-ABCDEFGHIJKLMNOP`,
      },
    });
    const status = await s.start();
    const tail = status.error!.logTail!.join("\n");
    expect(tail).toContain("debug key=[redacted] other=[redacted]");
    expect(tail).not.toContain(secret);
  });
});

describe("resolveWorkerLaunch", () => {
  const appPath = "/repo";
  const exists = (p: string) => p === "/repo/worker/server.py";

  it("runs python3 worker/server.py from the repo in development", () => {
    const spec = sup.resolveWorkerLaunch({ isPackaged: false, appPath, env: {}, exists });
    expect(spec).toEqual({
      ok: true,
      command: "python3",
      args: ["/repo/worker/server.py"],
      cwd: "/repo/worker",
      description: "python3 /repo/worker/server.py",
    });
  });

  it("prefers the worker's own virtualenv, and an explicit override over both", () => {
    const withVenv = (p: string) => exists(p) || p === "/repo/worker/.venv/bin/python3";
    expect(
      sup.resolveWorkerLaunch({ isPackaged: false, appPath, env: {}, exists: withVenv }).command,
    ).toBe("/repo/worker/.venv/bin/python3");
    expect(
      sup.resolveWorkerLaunch({
        isPackaged: false,
        appPath,
        env: { ASSISTANT_EDITOR_PYTHON: "/opt/py" },
        exists: withVenv,
      }).command,
    ).toBe("/opt/py");
  });

  it("reports a missing worker script", () => {
    const spec = sup.resolveWorkerLaunch({
      isPackaged: false,
      appPath,
      env: {},
      exists: () => false,
    });
    expect(spec.ok).toBe(false);
    expect(spec.kind).toBe("script-missing");
  });

  it("returns an explicit error for packaged builds until the worker is bundled (Step 6)", () => {
    const spec = sup.resolveWorkerLaunch({ isPackaged: true, appPath, env: {}, exists });
    expect(spec.ok).toBe(false);
    expect(spec.kind).toBe("not-bundled");
  });
});
