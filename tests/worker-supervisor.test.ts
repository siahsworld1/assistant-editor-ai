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
if (process.env.FAKE_REPORT_KEYS) {
  // Proves which keys reached THIS process's environment (by hash), and echoes
  // one raw so the supervisor's log masking is exercised for real.
  const sha = (v) => require("node:crypto").createHash("sha256").update(v || "").digest("hex");
  console.log("KEYS openai=" + sha(process.env.OPENAI_API_KEY) + " anthropic=" + sha(process.env.ANTHROPIC_API_KEY));
  console.log("RAW " + (process.env.OPENAI_API_KEY || ""));
  console.log("ARGV " + JSON.stringify(process.argv.slice(1)));
}
if (process.env.FAKE_REPORT_TOKEN) console.log("TOKEN " + (process.env.ASSISTANT_EDITOR_WORKER_TOKEN || ""));
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
  const TOKEN = "dev-shared-token-0123456789abcdef";
  /** An Assistant Editor worker already on the port (another app's, or by hand). */
  const otherWorker = (port: number, auth: "token" | "open") =>
    serve(port, (req, res) => {
      if (req.url === "/health")
        return res.end(
          JSON.stringify({ ok: true, service: "assistant-editor-worker", pid: 4242, auth }),
        );
      const ok = auth === "open" || req.headers["x-assistant-editor-token"] === TOKEN;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { project: {} } : { error: "unauthorized" }));
    });

  it("never adopts an Assistant Editor worker it didn't start — another copy or build of the app — and leaves it running", async () => {
    for (const auth of ["open", "token"] as const) {
      const port = await freePort();
      await otherWorker(port, auth);
      const spawnImpl = vi.fn();
      const s = makeSupervisor(port, { spawnImpl });
      const status = await s.start();
      expect(status.state).toBe("error");
      expect(status.error!.kind).toBe("port-conflict");
      expect(status.error!.message).toMatch(
        /Another Assistant Editor engine is already running.*only uses an engine it started itself/,
      );
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(s.authHeaders()).toEqual({});
      expect((await sup.fetchHealth({ port })).ok).toBe(true); // untouched
    }
  });

  it("adopts one only with a developer-supplied token that the worker actually enforces", async () => {
    const port = await freePort();
    await otherWorker(port, "token");
    const spawnImpl = vi.fn();
    const s = makeSupervisor(port, {
      spawnImpl,
      extraEnv: { ASSISTANT_EDITOR_WORKER_TOKEN: TOKEN },
    });
    const status = await s.start();
    expect(status).toMatchObject({ state: "ready", owned: false, pid: 4242 });
    expect(s.authHeaders()).toEqual({ "x-assistant-editor-token": TOKEN });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(spawnImpl).not.toHaveBeenCalled();
    await s.stop(); // must not touch the adopted worker
    expect((await sup.fetchHealth({ port })).ok).toBe(true);
  });

  it("refuses an open worker, or one that rejects the token, even when a token is configured", async () => {
    const open = await freePort();
    await otherWorker(open, "open"); // accepts anything: proves nothing
    const a = makeSupervisor(open, { extraEnv: { ASSISTANT_EDITOR_WORKER_TOKEN: TOKEN } });
    expect((await a.start()).error!.kind).toBe("port-conflict");
    const other = await freePort();
    await otherWorker(other, "token");
    const b = makeSupervisor(other, {
      extraEnv: { ASSISTANT_EDITOR_WORKER_TOKEN: "a-different-token-0123456789" },
    });
    expect((await b.start()).error!.kind).toBe("port-conflict");
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

describe("WorkerSupervisor — launch environment", () => {
  it("passes the launch spec's environment (bundled tool paths, sanitized PATH) to the worker", async () => {
    const port = await freePort();
    const s: Supervisor = new sup.WorkerSupervisor({
      port,
      startTimeoutMs: 8000,
      env: { ...process.env, FAKE_MODE: "exit", FAKE_PORT: String(port), FAKE_PRINT: "x" },
      launch: () => ({
        ok: true,
        command: process.execPath,
        args: [
          "-e",
          "console.log('ENV', process.env.ASSISTANT_EDITOR_FFMPEG, process.env.PATH); process.exit(4)",
        ],
        cwd: dir,
        env: {
          ASSISTANT_EDITOR_FFMPEG: "/bundle/ffmpeg/bin/ffmpeg",
          PATH: sup.PACKAGED_WORKER_PATH,
        },
        description: "env probe",
      }),
      log: () => {},
    });
    cleanups.push(() => s.stop());
    const status = await s.start();
    expect(status.error!.logTail!.join("\n")).toContain(
      `ENV /bundle/ffmpeg/bin/ffmpeg ${sup.PACKAGED_WORKER_PATH}`,
    );
  });
});

describe("WorkerSupervisor — provider credentials (Step 7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cred = require("../electron/credential-store.cjs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto");
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const KEY_A = "sk-proj-TESTONLY-1111111111111111111111111111111111";
  const KEY_B = "sk-proj-TESTONLY-2222222222222222222222222222222222";
  const ANT = "sk-ant-api03-TESTONLY-33333333333333333333333333333";

  function credentialedSupervisor(
    port: number,
    store: unknown,
    spawnSpy?: ReturnType<typeof vi.fn>,
    extraEnv: Record<string, string> = {},
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process");
    let svc: { workerEnv(): Promise<Record<string, string>> } | null = null;
    const s: Supervisor & { addSecrets(v: string[]): void } = new sup.WorkerSupervisor({
      port,
      startTimeoutMs: 8000,
      stopGraceMs: 1000,
      env: {
        ...process.env,
        FAKE_MODE: "healthy",
        FAKE_PORT: String(port),
        FAKE_REPORT_KEYS: "1",
        ...extraEnv,
      },
      credentials: () => svc!.workerEnv(),
      launch: () => ({
        ok: true,
        command: process.execPath,
        args: [script],
        cwd: dir,
        description: "fake worker",
      }),
      log: () => {},
      spawnImpl: (cmd: string, args: string[], opts: unknown) => {
        spawnSpy?.(cmd, args, opts);
        return spawn(cmd, args, opts);
      },
    });
    cleanups.push(() => s.stop());
    svc = new cred.CredentialService({
      store,
      supervisor: s,
      injectIntoWorker: true,
      log: () => {},
    });
    return {
      s,
      svc: svc as unknown as { save(p: string, k: string): Promise<Record<string, unknown>> },
    };
  }

  it("puts Keychain keys in the owned worker's environment — never its argv — and masks them in logs", async () => {
    const port = await freePort();
    const spawnSpy = vi.fn();
    const store = new cred.MemoryCredentialStore({ openai: KEY_A, anthropic: ANT });
    const { s } = credentialedSupervisor(port, store, spawnSpy);
    expect((await s.start()).state).toBe("ready");
    const [, args] = spawnSpy.mock.calls[0]!;
    expect(JSON.stringify(args)).not.toContain(KEY_A);
    const tail = s.logTail.join("\n");
    expect(tail).toContain(`KEYS openai=${sha(KEY_A)} anthropic=${sha(ANT)}`); // values arrived via env
    expect(tail).toContain("RAW [redacted]"); // and a worker printing one is masked
    expect(tail).not.toContain(KEY_A);
    expect(tail).not.toContain(KEY_B);
  });

  it("a saved key reaches the worker through a real, health-gated restart of the owned process", async () => {
    const port = await freePort();
    const store = new cred.MemoryCredentialStore({ openai: KEY_A });
    const { s, svc } = credentialedSupervisor(port, store);
    const first = await s.start();
    const res = await svc.save("openai", KEY_B);
    expect(res.ok).toBe(true);
    expect(res.worker).toMatchObject({ applied: true, restarted: true });
    const after = s.status();
    expect(after.state).toBe("ready");
    expect(after.pid).not.toBe(first.pid); // a new process...
    expect(isAlive(first.pid!)).toBe(false); // ...the old one is gone
    expect(s.logTail.join("\n")).toContain(`KEYS openai=${sha(KEY_B)}`); // ...with the new key
    expect(JSON.stringify(res)).not.toContain(KEY_B);
  });

  it("never kills or restarts an adopted worker when a key changes", async () => {
    const port = await freePort();
    const token = "dev-shared-token-0123456789abcdef";
    await serve(port, (req, res) => {
      if (req.url === "/health")
        return res.end(
          JSON.stringify({
            ok: true,
            service: "assistant-editor-worker",
            pid: 4242,
            auth: "token",
          }),
        );
      const ok = req.headers["x-assistant-editor-token"] === token;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { project: { analysisState: "complete" } } : {}));
    });
    const spawnSpy = vi.fn();
    const { s, svc } = credentialedSupervisor(port, new cred.MemoryCredentialStore(), spawnSpy, {
      ASSISTANT_EDITOR_WORKER_TOKEN: token, // adoption needs the worker's token now
    });
    expect((await s.start()).owned).toBe(false);
    const res = await svc.save("openai", KEY_A);
    expect(res.worker).toMatchObject({ applied: false, reason: "adopted" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect((await sup.fetchHealth({ port })).ok).toBe(true); // still running, untouched
  });
});

describe("WorkerSupervisor — the worker it starts belongs to it", () => {
  it("gets a fresh random token through its environment only — never argv, logs or status()", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const port = await freePort();
      const s = makeSupervisor(port, {
        extraEnv: { FAKE_REPORT_TOKEN: "1", FAKE_REPORT_KEYS: "1" },
      });
      const status = await s.start();
      expect(status.state).toBe("ready");
      expect(status.owned).toBe(true);
      const token = s.authHeaders()["x-assistant-editor-token"]!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      tokens.push(token);
      const tail = s.logTail.join("\n");
      expect(tail).toContain("TOKEN [redacted]"); // the worker had it; the log doesn't
      expect(tail).not.toContain(token);
      expect(tail).toMatch(/ARGV \[[^\]]*\]/);
      expect(tail.match(/ARGV (.*)/)![1]).not.toContain(token);
      expect(JSON.stringify(status)).not.toContain(token);
      await s.stop();
    }
    expect(tokens[0]).not.toBe(tokens[1]); // a new token every start
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

  describe("packaged app", () => {
    const resources = "/Applications/Assistant Editor AI.app/Contents/Resources";
    const bundled = new Set([
      `${resources}/worker/assistant-editor-worker`,
      `${resources}/ffmpeg/bin/ffmpeg`,
      `${resources}/ffmpeg/bin/ffprobe`,
    ]);
    const launch = (exists: (p: string) => boolean, env: Record<string, string> = {}) =>
      sup.resolveWorkerLaunch({
        isPackaged: true,
        appPath: "/ignored/app.asar",
        resourcesPath: resources,
        env,
        exists,
      });

    it("launches the bundled worker from Resources with absolute bundled ffmpeg/ffprobe", () => {
      const spec = launch((p) => bundled.has(p));
      expect(spec.ok).toBe(true);
      expect(spec.command).toBe(`${resources}/worker/assistant-editor-worker`);
      expect(spec.args).toEqual([]);
      expect(spec.cwd).toBe(`${resources}/worker`);
      expect(spec.env.ASSISTANT_EDITOR_FFMPEG).toBe(`${resources}/ffmpeg/bin/ffmpeg`);
      expect(spec.env.ASSISTANT_EDITOR_FFPROBE).toBe(`${resources}/ffmpeg/bin/ffprobe`);
    });

    it("never uses system Python, the repo, or a Homebrew PATH — even if the environment points there", () => {
      const spec = launch((p) => bundled.has(p), {
        ASSISTANT_EDITOR_PYTHON: "/opt/homebrew/bin/python3",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
      });
      expect(spec.command).not.toMatch(/python/);
      expect(spec.args).toEqual([]);
      expect(spec.env.PATH).toBe(sup.PACKAGED_WORKER_PATH);
      expect(spec.env.PATH).not.toMatch(/homebrew|\/usr\/local/);
      expect(spec.env.ASSISTANT_EDITOR_SKIP_DOTENV).toBe("1");
      expect(spec.env.FLASK_SKIP_DOTENV).toBe("1");
    });

    it("works wherever the app is installed", () => {
      const elsewhere = "/Users/me/Desktop/Assistant Editor AI.app/Contents/Resources";
      const spec = sup.resolveWorkerLaunch({
        isPackaged: true,
        appPath: "x",
        resourcesPath: elsewhere,
        env: {},
        exists: () => true,
      });
      expect(spec.command).toBe(`${elsewhere}/worker/assistant-editor-worker`);
      expect(spec.env.ASSISTANT_EDITOR_FFMPEG).toBe(`${elsewhere}/ffmpeg/bin/ffmpeg`);
    });

    it("reports a missing bundled worker explicitly", () => {
      const spec = launch((p) => bundled.has(p) && !p.endsWith("assistant-editor-worker"));
      expect(spec.ok).toBe(false);
      expect(spec.kind).toBe("not-bundled");
    });

    it("reports missing bundled ffmpeg/ffprobe explicitly instead of falling back", () => {
      const spec = launch((p) => bundled.has(p) && !p.endsWith("ffprobe"));
      expect(spec.ok).toBe(false);
      expect(spec.kind).toBe("ffmpeg-missing");
      expect(spec.message).toContain("ffprobe");
    });
  });
});
