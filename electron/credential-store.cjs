// AI-provider API keys for the desktop app. The Electron main process is the
// security boundary:
//   - keys live in the macOS Keychain (via /usr/bin/security — no native module),
//   - the renderer can only ask "is it configured?", save a new key, or remove
//     one; nothing it can call ever returns a stored key,
//   - the main process reads keys only to put them in the environment of the
//     worker it owns (electron/worker-supervisor.cjs), never in argv or logs.
const { spawn } = require("node:child_process");

const KEYCHAIN_SERVICE = "com.1855andco.assistant-editor-ai";

/** Every provider the app can hold a key for. Nothing else is accepted over IPC. */
const PROVIDERS = {
  openai: {
    account: "openai-api-key",
    label: "AssistantEditorAI-OpenAI",
    env: "OPENAI_API_KEY",
    name: "OpenAI",
  },
  anthropic: {
    account: "anthropic-api-key",
    label: "AssistantEditorAI-Anthropic",
    env: "ANTHROPIC_API_KEY",
    name: "Anthropic",
  },
};

/** Keys are opaque tokens: no whitespace, quotes or shell/`security -i`
 * metacharacters are ever valid, which also keeps the stdin command safe. */
const KEY_CHARSET = /^[A-Za-z0-9_-]+$/;

function isProvider(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** @returns {{ ok: true, key: string } | { ok: false, error: string }} */
function validateApiKey(provider, raw) {
  if (!isProvider(provider)) return { ok: false, error: "Unknown provider." };
  const key = typeof raw === "string" ? raw.trim() : "";
  const name = PROVIDERS[provider].name;
  if (!key) return { ok: false, error: `Enter your ${name} API key.` };
  if (key.length < 20 || key.length > 512 || !KEY_CHARSET.test(key)) {
    return {
      ok: false,
      error: `That doesn't look like an ${name} API key — check for extra characters or spaces.`,
    };
  }
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return { ok: false, error: "Anthropic API keys start with “sk-ant-”." };
  }
  if (provider === "openai" && (!key.startsWith("sk-") || key.startsWith("sk-ant-"))) {
    return {
      ok: false,
      error: key.startsWith("sk-ant-")
        ? "That's an Anthropic key — paste it under Anthropic."
        : "OpenAI API keys start with “sk-”.",
    };
  }
  return { ok: true, key };
}

/** Replaces every given secret (and API-key-shaped token) in a message. */
function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets)
    if (typeof s === "string" && s.length >= 8) out = out.split(s).join("[redacted]");
  return out.replace(/\b(sk|sk-ant|sk-proj)-[A-Za-z0-9_*-]{6,}/g, "[redacted]");
}

/**
 * Whether Keychain keys go into the worker's environment. Packaged builds:
 * always (they have no other source). Development: only on explicit opt-in —
 * otherwise Keychain values would silently override the repository .env, since
 * python-dotenv never overrides variables that are already set.
 */
function shouldInjectKeychainCredentials({ isPackaged, env = process.env }) {
  return Boolean(isPackaged) || env.ASSISTANT_EDITOR_DEV_USE_KEYCHAIN === "1";
}

class CredentialStoreError extends Error {}

/**
 * macOS Keychain through /usr/bin/security. Writes go through `security -i`
 * with the command on STDIN, so the secret never appears in any process's
 * argument list (visible to every user via `ps`).
 */
class KeychainCredentialStore {
  constructor({
    securityPath = "/usr/bin/security",
    service = KEYCHAIN_SERVICE,
    spawnImpl = spawn,
    timeoutMs = 15000,
  } = {}) {
    this.securityPath = securityPath;
    this.service = service;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }

  run(args, stdin) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(this.securityPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch (err) {
        resolve({ code: -1, stdout: "", stderr: String(err && err.message) });
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", (err) => (stderr += String(err && err.message)));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.end(stdin ?? "");
    });
  }

  async has(provider) {
    const { account } = PROVIDERS[provider];
    const res = await this.run(["find-generic-password", "-s", this.service, "-a", account]);
    if (res.code === 0) return true;
    if (res.code === 44) return false;
    throw new CredentialStoreError(`Keychain lookup failed (${res.code}).`);
  }

  /** Main process only — never reachable from IPC. */
  async get(provider) {
    const { account } = PROVIDERS[provider];
    const res = await this.run(["find-generic-password", "-s", this.service, "-a", account, "-w"]);
    if (res.code === 44) return null;
    if (res.code !== 0) throw new CredentialStoreError(`Keychain read failed (${res.code}).`);
    const value = res.stdout.replace(/\r?\n$/, "");
    return value || null;
  }

  async set(provider, key) {
    const { account, label } = PROVIDERS[provider];
    if (!KEY_CHARSET.test(key))
      throw new CredentialStoreError("Refusing to store a malformed key.");
    // -U updates an existing item in place.
    const command = `add-generic-password -U -s ${this.service} -a ${account} -l ${label} -w ${key}\n`;
    const res = await this.run(["-i"], command);
    if (res.code !== 0) {
      throw new CredentialStoreError(
        `Keychain write failed (${res.code}): ${redactSecrets(res.stderr.trim(), [key]).slice(0, 200)}`,
      );
    }
    if (!(await this.has(provider)))
      throw new CredentialStoreError("Keychain write could not be verified.");
  }

  async delete(provider) {
    const { account } = PROVIDERS[provider];
    const res = await this.run(["delete-generic-password", "-s", this.service, "-a", account]);
    if (res.code !== 0 && res.code !== 44)
      throw new CredentialStoreError(`Keychain delete failed (${res.code}).`);
  }
}

/** Same interface, process memory only — for tests and non-macOS development. */
class MemoryCredentialStore {
  constructor(initial = {}) {
    this.items = new Map(Object.entries(initial));
  }
  async has(provider) {
    return this.items.has(provider);
  }
  async get(provider) {
    return this.items.get(provider) ?? null;
  }
  async set(provider, key) {
    this.items.set(provider, key);
  }
  async delete(provider) {
    this.items.delete(provider);
  }
}

/**
 * What the renderer is allowed to do with credentials, plus applying them to
 * the worker. Every return value is renderer-safe: provider status and worker
 * outcome only — a stored key is never included, and every error message is
 * scrubbed of any key it could contain.
 */
class CredentialService {
  /**
   * @param {{
   *   store: KeychainCredentialStore | MemoryCredentialStore,
   *   supervisor: import("./worker-supervisor.cjs").WorkerSupervisor,
   *   injectIntoWorker: boolean,
   *   log?: (line: string) => void,
   * }} opts
   */
  constructor({ store, supervisor, injectIntoWorker, log }) {
    this.store = store;
    this.supervisor = supervisor;
    this.injectIntoWorker = injectIntoWorker;
    this.log = log ?? ((line) => console.log(`[credentials] ${line}`));
  }

  /** Environment for the worker the supervisor is about to spawn. */
  async workerEnv() {
    if (!this.injectIntoWorker) return {};
    const env = {};
    for (const [provider, { env: name }] of Object.entries(PROVIDERS)) {
      const value = await this.store.get(provider);
      if (value) env[name] = value;
    }
    return env;
  }

  async status() {
    const providers = {};
    let error = null;
    for (const [provider, { name }] of Object.entries(PROVIDERS)) {
      try {
        providers[provider] = { name, configured: await this.store.has(provider) };
      } catch (err) {
        providers[provider] = { name, configured: false };
        error = redactSecrets(err && err.message);
      }
    }
    const worker = this.supervisor.status();
    return {
      ok: error === null,
      ...(error ? { error } : {}),
      providers,
      // Where saved keys take effect: "worker" (packaged app) or, in
      // development, the repository .env keeps driving the worker.
      appliesTo: this.injectIntoWorker ? "worker" : "development-dotenv",
      worker: { state: worker.state, owned: worker.owned },
    };
  }

  async save(provider, rawKey) {
    const checked = validateApiKey(provider, rawKey);
    if (!checked.ok) return { ...(await this.status()), ok: false, error: checked.error };
    const secret = checked.key;
    try {
      if (await this.analysisRunning()) {
        return {
          ...(await this.status()),
          ok: false,
          error:
            "An analysis is running — save the key after it finishes (applying it restarts the local engine).",
        };
      }
      await this.store.set(provider, secret);
      this.supervisor.addSecrets?.([secret]);
      this.log(`${PROVIDERS[provider].name} key saved to the Keychain.`);
      const applied = await this.applyToWorker();
      const status = await this.status();
      return { ...status, ok: true, worker: { ...status.worker, ...applied } };
    } catch (err) {
      return {
        ...(await this.status()),
        ok: false,
        error: redactSecrets(err && err.message, [secret]),
      };
    }
  }

  async remove(provider) {
    if (!isProvider(provider))
      return { ...(await this.status()), ok: false, error: "Unknown provider." };
    try {
      if (await this.analysisRunning()) {
        return {
          ...(await this.status()),
          ok: false,
          error:
            "An analysis is running — remove the key after it finishes (applying it restarts the local engine).",
        };
      }
      await this.store.delete(provider);
      this.log(`${PROVIDERS[provider].name} key removed from the Keychain.`);
      const applied = await this.applyToWorker();
      const status = await this.status();
      return { ...status, ok: true, worker: { ...status.worker, ...applied } };
    } catch (err) {
      return { ...(await this.status()), ok: false, error: redactSecrets(err && err.message) };
    }
  }

  /** True when the worker this app owns is mid-analysis (restart would lose it). */
  async analysisRunning() {
    const s = this.supervisor.status();
    if (s.state !== "ready" || !s.owned) return false;
    try {
      const res = await fetch(`${s.url}/project`, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      return body?.project?.analysisState === "running";
    } catch {
      return false;
    }
  }

  /**
   * Applies the current Keychain state to the worker. Only a worker this app
   * started is ever restarted; an adopted (externally started) one is left
   * alone and reported, since its environment can't be changed from here.
   */
  async applyToWorker() {
    if (!this.injectIntoWorker) {
      return { applied: false, reason: "development-dotenv" };
    }
    const before = this.supervisor.status();
    if (before.state === "ready" && !before.owned) {
      return { applied: false, reason: "adopted" };
    }
    const after = await this.supervisor.restart();
    if (after.state === "ready" && !after.owned) {
      // Someone started a worker on the port while we restarted — not ours.
      return { applied: false, reason: "adopted" };
    }
    return after.state === "ready"
      ? { applied: true, restarted: true }
      : {
          applied: false,
          reason: "restart-failed",
          error: after.error ? redactSecrets(after.error.message) : "The engine did not restart.",
        };
  }
}

module.exports = {
  KEYCHAIN_SERVICE,
  PROVIDERS,
  isProvider,
  validateApiKey,
  redactSecrets,
  shouldInjectKeychainCredentials,
  KeychainCredentialStore,
  MemoryCredentialStore,
  CredentialService,
};
