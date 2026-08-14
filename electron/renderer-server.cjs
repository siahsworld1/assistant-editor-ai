// Production renderer bootstrap.
//
// The packaged app ships the TanStack Start "node-server" build (dist-desktop)
// as an extraResource. We start it as a child process on a dynamically assigned
// loopback port and only create the window once it answers. Nothing here is
// reachable from the renderer or from IPC: paths are resolved from packaged
// resources only, and the child is spawned without a shell.
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 30000;

function resolveServerEntry(app) {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, "renderer")]
    : [path.join(__dirname, "..", "dist-desktop")];
  for (const root of roots) {
    const entry = path.join(root, "server", "index.mjs");
    if (fs.existsSync(entry)) return { root, entry };
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

class EmbeddedRenderer {
  constructor() {
    this.child = null;
    this.url = null;
    this.logTail = [];
  }

  record(chunk) {
    const line = String(chunk).trim();
    if (!line) return;
    this.logTail.push(line);
    if (this.logTail.length > 40) this.logTail.shift();
  }

  /** @returns {Promise<{ ok: true, url: string } | { ok: false, error: string }>} */
  async start(app) {
    const resolved = resolveServerEntry(app);
    if (!resolved) {
      return {
        ok: false,
        error:
          "The packaged interface files are missing from this build (renderer/server/index.mjs).",
      };
    }
    let port;
    try {
      port = await findFreePort();
    } catch {
      return { ok: false, error: "No local port was available to start the interface." };
    }

    const child = spawn(process.execPath, [resolved.entry], {
      cwd: resolved.root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        HOST,
        PORT: String(port),
      },
    });
    this.child = child;
    child.stdout.on("data", (c) => this.record(c));
    child.stderr.on("data", (c) => this.record(c));

    let exited = null;
    child.on("exit", (code, signal) => {
      exited = `interface process exited (${signal || code})`;
      if (this.child === child) this.child = null;
    });
    child.on("error", () => {
      exited = "interface process could not be started";
    });

    const url = `http://${HOST}:${port}`;
    const ready = await waitForReady(url, Date.now() + START_TIMEOUT_MS);
    if (!ready || exited) {
      this.stop();
      return { ok: false, error: exited || "The interface did not finish starting in time." };
    }
    this.url = url;
    return { ok: true, url };
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.url = null;
    if (!child || child.killed) return;
    try {
      child.kill();
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { EmbeddedRenderer, HOST, START_TIMEOUT_MS };
