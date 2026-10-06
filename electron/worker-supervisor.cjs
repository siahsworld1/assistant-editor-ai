// Owns the local Assistant Editor worker (the engine at 127.0.0.1:32145) for the
// lifetime of the desktop app, so nobody has to start `python3 worker/server.py`
// by hand.
//
// Three separable pieces, so Step 6 (a packaged worker executable) only has to
// change resolveWorkerLaunch():
//   - resolveWorkerLaunch(): WHAT to run (dev: python3 worker/server.py).
//   - probePort():           WHO is already on the port, if anyone.
//   - WorkerSupervisor:      start (health-gated, bounded) / track / stop.
//
// Ownership rule: the supervisor only ever signals the ChildProcess it spawned
// itself. It never kills anything by port or by pid lookup — a healthy
// Assistant Editor worker that was already running is adopted (and left alone
// on quit), and anything else on the port is reported as a conflict.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/** The worker's self-identification in GET /health (worker/store.py). */
const WORKER_SERVICE_ID = "assistant-editor-worker";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 32145;
/** Cold Python start + importing the AI SDKs can take several seconds. */
const DEFAULT_START_TIMEOUT_MS = 45000;
const DEFAULT_STOP_GRACE_MS = 3000;
const LOG_TAIL_LINES = 60;

/**
 * What to run for the worker. Dev: the repo's worker/server.py under Python.
 * Packaged (Step 6): will return the bundled worker executable instead — until
 * then a packaged build gets an explicit error rather than a guess.
 * @returns {{ ok: true, command: string, args: string[], cwd: string, description: string }
 *         | { ok: false, kind: string, message: string }}
 */
function resolveWorkerLaunch({ isPackaged, appPath, env = process.env, exists = fs.existsSync }) {
  if (isPackaged) {
    return {
      ok: false,
      kind: "not-bundled",
      message:
        "This build does not include the Assistant Editor worker yet (packaging is pending).",
    };
  }
  const workerDir = path.join(appPath, "worker");
  const script = path.join(workerDir, "server.py");
  if (!exists(script)) {
    return { ok: false, kind: "script-missing", message: `Worker script not found: ${script}` };
  }
  const venvPython = path.join(workerDir, ".venv", "bin", "python3");
  const command = env.ASSISTANT_EDITOR_PYTHON || (exists(venvPython) ? venvPython : "python3");
  return { ok: true, command, args: [script], cwd: workerDir, description: `${command} ${script}` };
}

/**
 * Who, if anyone, is listening on host:port.
 * @returns {Promise<{ kind: "free" }
 *   | { kind: "assistant-editor-worker", pid: number | null, version: string | null }
 *   | { kind: "legacy-assistant-editor-worker" }
 *   | { kind: "unrelated", detail: string }>}
 */
async function probePort({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500 } = {}) {
  const tcp = await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done("timeout"));
    socket.once("connect", () => done("open"));
    socket.once("error", (err) =>
      done(err && err.code === "ECONNREFUSED" ? "refused" : `error:${err && err.code}`),
    );
  });
  if (tcp === "refused") return { kind: "free" };
  if (tcp !== "open")
    return { kind: "unrelated", detail: `port ${port} did not behave like a free port (${tcp})` };

  const health = await fetchHealth({ host, port, timeoutMs });
  if (!health.ok) return { kind: "unrelated", detail: health.detail };
  const body = health.body;
  if (body && body.service === WORKER_SERVICE_ID) {
    return {
      kind: "assistant-editor-worker",
      pid: Number.isInteger(body.pid) ? body.pid : null,
      version: typeof body.version === "string" ? body.version : null,
    };
  }
  // Pre-Step-5 workers answered /health without a service id. It's ours, but
  // an older build — almost always a stale manually-started worker that would
  // silently mask the code this app expects.
  if (body && body.ok === true && body.capabilities && typeof body.capabilities === "object") {
    return { kind: "legacy-assistant-editor-worker" };
  }
  return {
    kind: "unrelated",
    detail: `GET /health on port ${port} is not an Assistant Editor worker`,
  };
}

/** One GET /health. Never throws. */
async function fetchHealth({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    const text = await res.text();
    if (res.status !== 200) return { ok: false, detail: `GET /health returned HTTP ${res.status}` };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, detail: "GET /health returned a non-JSON response" };
    }
  } catch (err) {
    return {
      ok: false,
      detail: err && err.name === "AbortError" ? "GET /health timed out" : "GET /health failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Masks values of secret-looking env vars and API-key-shaped tokens. */
function makeRedactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(
      ([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && typeof v === "string" && v.length >= 8,
    )
    .map(([, v]) => v);
  return (line) => {
    let out = line;
    for (const s of secrets) out = out.split(s).join("[redacted]");
    return out.replace(/\b(sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WorkerSupervisor {
  /**
   * @param {{
   *   launch: () => ReturnType<typeof resolveWorkerLaunch>,
   *   host?: string, port?: number,
   *   startTimeoutMs?: number, stopGraceMs?: number,
   *   env?: NodeJS.ProcessEnv,
   *   spawnImpl?: typeof spawn,
   *   log?: (line: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.launch = opts.launch;
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.env = opts.env ?? process.env;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.log = opts.log ?? ((line) => console.log(`[worker] ${line}`));
    this.redact = makeRedactor(this.env);

    /** @type {"idle" | "starting" | "ready" | "error" | "stopped"} */
    this.state = "idle";
    this.owned = false;
    this.child = null;
    this.pid = null;
    this.error = null;
    this.logTail = [];
    this.startPromise = null;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  /** Renderer-safe snapshot (no env, no secrets). */
  status() {
    return {
      state: this.state,
      owned: this.owned,
      pid: this.pid,
      url: this.url,
      error: this.error ? { ...this.error } : null,
    };
  }

  record(chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = this.redact(raw.trimEnd());
      if (!line) continue;
      this.logTail.push(line);
      if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
      this.log(line);
    }
  }

  fail(kind, message) {
    this.state = "error";
    this.error = { kind, message: this.redact(message), logTail: this.logTail.slice(-15) };
    this.log(`startup failed (${kind}): ${this.error.message}`);
    return this.status();
  }

  /** Idempotent while a start is in flight; resolves once ready or failed. */
  start() {
    if (this.state === "ready") return Promise.resolve(this.status());
    if (!this.startPromise) {
      this.startPromise = this._start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  /** Resolves with the settled status (ready or error), starting if idle. */
  waitUntilReady() {
    if (this.state === "ready" || this.state === "error") return Promise.resolve(this.status());
    return this.start();
  }

  /** Stops whatever we own, then starts again (renderer "Reconnect"). */
  async restart() {
    await this.stop();
    return this.start();
  }

  async _start() {
    this.state = "starting";
    this.error = null;
    this.owned = false;
    this.pid = null;
    this.logTail = [];

    const occupant = await probePort({ host: this.host, port: this.port });
    if (occupant.kind === "assistant-editor-worker") {
      // Adopt, never own: it was started outside this app, so it's not ours to stop.
      this.state = "ready";
      this.pid = occupant.pid;
      this.log(
        `using an Assistant Editor worker that was already running on ${this.url} (pid ${occupant.pid ?? "?"}); it will be left running on quit`,
      );
      return this.status();
    }
    if (occupant.kind === "legacy-assistant-editor-worker") {
      return this.fail(
        "port-conflict",
        `An older Assistant Editor worker is already running on ${this.url} (probably started manually). Stop it so the app can start the current worker.`,
      );
    }
    if (occupant.kind === "unrelated") {
      return this.fail(
        "port-conflict",
        `Port ${this.port} is in use by another program (${occupant.detail}). Quit that program, then Reconnect.`,
      );
    }

    const spec = this.launch();
    if (!spec.ok) return this.fail(spec.kind, spec.message);
    this.log(`starting: ${spec.description}`);

    let spawnError = null;
    let exitInfo = null;
    let child;
    try {
      child = this.spawnImpl(spec.command, spec.args, {
        cwd: spec.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...this.env,
          PYTHONUNBUFFERED: "1",
          // worker/server.py exits on its own if this process disappears
          // without a clean quit, so a crash can't leave an orphan behind.
          ASSISTANT_EDITOR_PARENT_PID: String(process.pid),
        },
      });
    } catch (err) {
      return this.fail("spawn-failed", `Could not start ${spec.command}: ${err && err.message}`);
    }
    this.child = child;
    this.owned = true;
    this.pid = child.pid ?? null;
    child.stdout?.on("data", (c) => this.record(c));
    child.stderr?.on("data", (c) => this.record(c));
    child.once("error", (err) => {
      spawnError = err;
    });
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      if (this.child === child) this.child = null;
      if (this.state === "ready" && this.owned) {
        this.fail("crashed", `The worker stopped unexpectedly (${signal || `exit code ${code}`}).`);
      }
    });

    const deadline = Date.now() + this.startTimeoutMs;
    let delay = 150;
    while (Date.now() < deadline) {
      if (spawnError) {
        this.child = null;
        this.owned = false;
        const missing = spawnError.code === "ENOENT";
        return this.fail(
          missing ? "python-missing" : "spawn-failed",
          missing
            ? `Python was not found (${spec.command}). Install Python 3 or set ASSISTANT_EDITOR_PYTHON.`
            : `Could not start ${spec.command}: ${spawnError.message}`,
        );
      }
      if (exitInfo) {
        this.owned = false;
        return this.fail(
          "exited-early",
          `The worker exited before it became healthy (${exitInfo.signal || `exit code ${exitInfo.code}`}). See the log lines for the cause.`,
        );
      }
      const health = await fetchHealth({ host: this.host, port: this.port, timeoutMs: 1000 });
      if (health.ok && health.body && health.body.service === WORKER_SERVICE_ID) {
        if (Number.isInteger(health.body.pid) && health.body.pid !== child.pid) {
          // Someone else answered on our port — never treat that as our worker.
          await this.stop();
          return this.fail(
            "port-conflict",
            `Another Assistant Editor worker (pid ${health.body.pid}) answered on ${this.url}.`,
          );
        }
        this.state = "ready";
        this.log(`ready on ${this.url} (pid ${child.pid})`);
        return this.status();
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(Math.round(delay * 1.5), 2000);
    }
    await this.stop();
    return this.fail(
      "health-timeout",
      `The worker did not answer GET /health within ${Math.round(this.startTimeoutMs / 1000)}s.`,
    );
  }

  /**
   * Stops the worker only if this supervisor spawned it: SIGTERM, then SIGKILL
   * after the grace period. An adopted worker is never signalled.
   */
  async stop() {
    const child = this.child;
    const wasError = this.state === "error";
    this.child = null;
    if (!wasError) this.state = "stopped";
    if (!child || !this.owned) {
      this.owned = false;
      return;
    }
    this.owned = false;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      sleep(this.stopGraceMs).then(() => false),
    ]);
    if (!graceful) {
      this.log(`worker did not exit within ${this.stopGraceMs}ms of SIGTERM; sending SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([exited, sleep(1000)]);
    }
  }

  /** Last-resort synchronous kill for process 'exit' (no awaiting possible). */
  killNow() {
    if (this.child && this.owned) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = {
  WORKER_SERVICE_ID,
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  resolveWorkerLaunch,
  probePort,
  fetchHealth,
  makeRedactor,
  WorkerSupervisor,
};
