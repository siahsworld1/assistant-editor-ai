// Local bridge between the Adobe Premiere Pro UXP panel and the Assistant
// Editor desktop companion.
//
// Why an HTTP loopback server: a UXP panel runs in Premiere's own process and
// cannot use Electron IPC. UXP *can* perform fetch() to loopback. The surface
// is therefore deliberately tiny:
//   GET  /premiere/health   -> handshake state + protocol version
//   GET  /premiere/commands -> drains queued desktop -> plugin commands
//   POST /premiere/message  -> one validated plugin -> desktop message
// Everything else (any other path, method, host or oversized body) is rejected
// by electron/premiere-protocol.cjs before any state changes.
//
// This server never proxies to the worker, never touches the filesystem and
// never shells out. The Electron renderer bridge and its allowlist are
// untouched; the worker origin stays http://127.0.0.1:32145.

const http = require("node:http");
const crypto = require("node:crypto");
const {
  BRIDGE_HOST,
  BRIDGE_PORT,
  PREMIERE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PLUGIN_VERSION,
  validateBridgeRoute,
  validateRawBody,
  validateCommand,
  isAllowedOrigin,
  MAX_MESSAGE_BYTES,
} = require("./premiere-protocol.cjs");

const MAX_QUEUE = 25;
const STALE_MS = 30_000;

class PremiereBridge {
  constructor({ port = BRIDGE_PORT, host = BRIDGE_HOST } = {}) {
    this.port = port;
    this.host = host;
    this.server = null;
    /** Rotated per app run; the panel echoes it back after handshake. */
    this.sessionToken = crypto.randomBytes(16).toString("hex");
    this.state = {
      connected: false,
      pluginVersion: null,
      hostVersion: null,
      host: null,
      capabilities: {},
      project: null,
      sequence: null,
      selection: [],
      lastMessageAt: null,
      lastError: null,
      messagesReceived: 0,
      rejected: 0,
    };
    this.queue = [];
  }

  /** Snapshot for Settings diagnostics. Safe to send to the renderer. */
  status() {
    const stale =
      this.state.lastMessageAt !== null && Date.now() - this.state.lastMessageAt > STALE_MS;
    return {
      listening: Boolean(this.server && this.server.listening),
      endpoint: `http://${this.host}:${this.port}`,
      protocolVersion: PREMIERE_PROTOCOL_VERSION,
      minPluginVersion: MIN_SUPPORTED_PLUGIN_VERSION,
      connected: this.state.connected && !stale,
      stale,
      pluginVersion: this.state.pluginVersion,
      host: this.state.host,
      hostVersion: this.state.hostVersion,
      capabilities: this.state.capabilities,
      project: this.state.project,
      sequence: this.state.sequence,
      selectionCount: this.state.selection.length,
      lastMessageAt: this.state.lastMessageAt,
      lastError: this.state.lastError,
      messagesReceived: this.state.messagesReceived,
      rejected: this.state.rejected,
      queued: this.queue.length,
    };
  }

  /** Desktop -> plugin. Returns a normalized error for unknown commands. */
  enqueueCommand(raw) {
    const check = validateCommand(raw);
    if (!check.ok) return check;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(check.command);
    return { ok: true, command: check.command, queued: this.queue.length };
  }

  drainCommands() {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Applies one already-validated plugin message to bridge state. */
  applyMessage(message) {
    this.state.messagesReceived += 1;
    this.state.lastMessageAt = Date.now();
    switch (message.type) {
      case "handshake":
        this.state.connected = true;
        this.state.pluginVersion = message.payload.pluginVersion;
        this.state.host = message.payload.host;
        this.state.hostVersion = message.payload.hostVersion;
        this.state.capabilities = message.payload.capabilities;
        this.state.lastError = null;
        return {
          ok: true,
          type: "handshake.ack",
          protocolVersion: PREMIERE_PROTOCOL_VERSION,
          sessionToken: this.sessionToken,
          companion: { name: "Assistant Editor AI", integrationVersion: "0.4.0" },
        };
      case "capabilities":
        this.state.capabilities = message.payload.capabilities;
        return { ok: true, type: "capabilities.ack" };
      case "project.state":
        this.state.project = message.payload;
        return { ok: true, type: "project.ack" };
      case "sequence.state":
        this.state.sequence = message.payload;
        return { ok: true, type: "sequence.ack" };
      case "selection.state":
        this.state.selection = message.payload.items;
        return { ok: true, type: "selection.ack", accepted: message.payload.items.length };
      case "media.metadata":
        return { ok: true, type: "media.ack", accepted: message.payload.items.length };
      case "diagnostics.ping":
        return { ok: true, type: "pong", at: Date.now() };
      case "error":
        this.state.lastError = message.payload.message;
        return { ok: true, type: "error.ack" };
      default:
        return { ok: false, error: "Unhandled message type" };
    }
  }

  handle(method, url, origin, body) {
    if (!isAllowedOrigin(origin)) {
      this.state.rejected += 1;
      return { status: 403, body: { ok: false, error: "Origin not allowed" } };
    }
    const route = validateBridgeRoute(method, url);
    if (!route.ok) {
      this.state.rejected += 1;
      return { status: route.code === "method_not_allowed" ? 405 : 404, body: { ok: false, error: route.error } };
    }
    if (route.method === "GET" && route.path === "/premiere/health") {
      return { status: 200, body: { ok: true, ...this.status() } };
    }
    if (route.method === "GET" && route.path === "/premiere/commands") {
      return { status: 200, body: { ok: true, commands: this.drainCommands() } };
    }
    const parsed = validateRawBody(body);
    if (!parsed.ok) {
      this.state.rejected += 1;
      this.state.lastError = parsed.error;
      return { status: 400, body: { ok: false, code: parsed.code, error: parsed.error } };
    }
    const result = this.applyMessage(parsed.message);
    return { status: result.ok ? 200 : 400, body: { id: parsed.message.id, ...result } };
  }

  start() {
    if (this.server) return Promise.resolve({ ok: true, endpoint: `http://${this.host}:${this.port}` });
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_MESSAGE_BYTES) {
            aborted = true;
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Message too large" }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (aborted) return;
          const out = this.handle(
            req.method,
            req.url,
            req.headers.origin,
            Buffer.concat(chunks).toString("utf8"),
          );
          res.writeHead(out.status, {
            "content-type": "application/json",
            // UXP panels present an app:// origin; only they are answered.
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(out.body));
        });
        req.on("error", () => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      });
      server.on("error", (err) => {
        this.server = null;
        resolve({ ok: false, error: `Premiere bridge could not listen on ${this.host}:${this.port} (${err.code || "error"})` });
      });
      // Loopback only. Never 0.0.0.0.
      server.listen(this.port, this.host, () => {
        this.server = server;
        resolve({ ok: true, endpoint: `http://${this.host}:${this.port}` });
      });
    });
  }

  stop() {
    if (!this.server) return;
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    this.server = null;
  }
}

module.exports = { PremiereBridge, MAX_QUEUE, STALE_MS };