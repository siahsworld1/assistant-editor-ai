// @vitest-environment node
// API-key storage and the renderer-facing credential service. Never touches the
// developer's real Keychain: the Keychain store is exercised against a fake
// `security` executable that records every argv and stdin it receives, so the
// tests can prove a secret never appears in a process argument list.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cred = require("../electron/credential-store.cjs");

const OPENAI_KEY = "sk-proj-TESTONLY-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPENAI_KEY_2 = "sk-proj-TESTONLY-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ANTHROPIC_KEY = "sk-ant-api03-TESTONLY-cccccccccccccccccccccccccccccc";

// Mimics /usr/bin/security for the four operations the store uses, backed by
// a JSON file; exit 44 = "item not found", exactly like the real tool.
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require("node:fs");
const db = process.env.FAKE_SECURITY_DB, log = process.env.FAKE_SECURITY_LOG;
const load = () => (fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8")) : {});
const save = (d) => fs.writeFileSync(db, JSON.stringify(d));
function opt(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function exec(args) {
  const d = load(); const id = opt(args, "-s") + "|" + opt(args, "-a");
  if (process.env.FAKE_SECURITY_FAIL === "1") { process.stderr.write("security: failed: " + args.join(" ") + "\\n"); return 1; }
  switch (args[0]) {
    case "find-generic-password":
      if (!(id in d)) { process.stderr.write("The specified item could not be found in the keychain.\\n"); return 44; }
      if (args.includes("-w")) process.stdout.write(d[id] + "\\n"); else process.stdout.write('keychain: "fake"\\n');
      return 0;
    case "add-generic-password":
      if (id in d && !args.includes("-U")) return 45;
      d[id] = opt(args, "-w"); save(d); return 0;
    case "delete-generic-password":
      if (!(id in d)) return 44;
      delete d[id]; save(d); return 0;
    default: return 2;
  }
}
const argv = process.argv.slice(2);
let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(log, JSON.stringify({ argv, stdin }) + "\\n");
let code = 0;
if (argv[0] === "-i") { for (const line of stdin.split("\\n").filter(Boolean)) code = exec(line.trim().split(/\\s+/)) || code; }
else code = exec(argv);
process.exit(code);
`;

let dir: string;
let db: string;
let log: string;
let securityPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ae-cred-test-"));
  db = path.join(dir, "keychain.json");
  log = path.join(dir, "calls.log");
  securityPath = path.join(dir, "security");
  writeFileSync(securityPath, FAKE_SECURITY);
  chmodSync(securityPath, 0o755);
  process.env.FAKE_SECURITY_DB = db;
  process.env.FAKE_SECURITY_LOG = log;
  delete process.env.FAKE_SECURITY_FAIL;
});

function calls(): Array<{ argv: string[]; stdin: string }> {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
}

describe("validateApiKey", () => {
  it("accepts well-formed keys and trims surrounding whitespace", () => {
    expect(cred.validateApiKey("openai", `  ${OPENAI_KEY}\n`)).toEqual({
      ok: true,
      key: OPENAI_KEY,
    });
    expect(cred.validateApiKey("anthropic", ANTHROPIC_KEY).ok).toBe(true);
  });
  it("rejects empty, short, malformed and swapped keys, and unknown providers", () => {
    expect(cred.validateApiKey("openai", "").ok).toBe(false);
    expect(cred.validateApiKey("openai", "sk-short").ok).toBe(false);
    expect(cred.validateApiKey("openai", `${OPENAI_KEY} extra`).ok).toBe(false);
    expect(cred.validateApiKey("openai", `${OPENAI_KEY}";rm -rf /`).ok).toBe(false);
    expect(cred.validateApiKey("openai", ANTHROPIC_KEY).error).toContain("Anthropic key");
    expect(cred.validateApiKey("anthropic", OPENAI_KEY).ok).toBe(false);
    expect(cred.validateApiKey("github", OPENAI_KEY).ok).toBe(false);
  });
});

describe("KeychainCredentialStore (fake `security`, never the real Keychain)", () => {
  const store = () => new cred.KeychainCredentialStore({ securityPath });

  it("reports a provider with no saved key as not configured", async () => {
    expect(await store().has("openai")).toBe(false);
    expect(await store().get("openai")).toBeNull();
  });

  it("saves a key under the app's service namespace — via stdin, never argv", async () => {
    const s = store();
    await s.set("openai", OPENAI_KEY);
    expect(await s.has("openai")).toBe(true);
    expect(await s.get("openai")).toBe(OPENAI_KEY);
    const all = calls();
    for (const c of all) expect(c.argv.join(" ")).not.toContain(OPENAI_KEY);
    const write = all.find((c) => c.argv[0] === "-i")!;
    expect(write.stdin).toContain(OPENAI_KEY);
    expect(write.stdin).toContain(`-s ${cred.KEYCHAIN_SERVICE} -a openai-api-key`);
    expect(write.stdin).toContain("-U"); // update-in-place semantics
  });

  it("updates an existing key in place and keeps providers separate", async () => {
    const s = store();
    await s.set("openai", OPENAI_KEY);
    await s.set("anthropic", ANTHROPIC_KEY);
    await s.set("openai", OPENAI_KEY_2);
    expect(await s.get("openai")).toBe(OPENAI_KEY_2);
    expect(await s.get("anthropic")).toBe(ANTHROPIC_KEY);
  });

  it("removes a key, and removing an absent key is not an error", async () => {
    const s = store();
    await s.set("openai", OPENAI_KEY);
    await s.delete("openai");
    expect(await s.has("openai")).toBe(false);
    await expect(s.delete("openai")).resolves.toBeUndefined();
  });

  it("never lets a key into an error message, even if `security` echoes it", async () => {
    process.env.FAKE_SECURITY_FAIL = "1";
    const err = await store()
      .set("openai", OPENAI_KEY)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain(OPENAI_KEY);
  });

  it("refuses to pass a malformed key to `security` at all", async () => {
    await expect(store().set("openai", "sk-has space-aaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(
      /malformed/,
    );
    expect(calls()).toHaveLength(0);
  });
});

type FakeSupervisor = {
  url: string;
  state: string;
  owned: boolean;
  status: () => {
    state: string;
    owned: boolean;
    url: string;
    pid: null;
    error: null | { message: string };
  };
  restart: ReturnType<typeof vi.fn>;
  addSecrets: ReturnType<typeof vi.fn>;
};

function fakeSupervisor(
  init: {
    state?: string;
    owned?: boolean;
    url?: string;
    restartTo?: { state: string; owned: boolean; error?: { message: string } };
  } = {},
): FakeSupervisor {
  const s: FakeSupervisor = {
    url: init.url ?? "http://127.0.0.1:1",
    state: init.state ?? "ready",
    owned: init.owned ?? true,
    status: () => ({ state: s.state, owned: s.owned, url: s.url, pid: null, error: null }),
    restart: vi.fn(async () => {
      const to = init.restartTo ?? { state: "ready", owned: true };
      s.state = to.state;
      s.owned = to.owned;
      return { ...s.status(), error: to.error ?? null };
    }),
    addSecrets: vi.fn(),
  };
  return s;
}

function service(
  opts: { injectIntoWorker?: boolean; supervisor?: FakeSupervisor; store?: unknown } = {},
) {
  const supervisor = opts.supervisor ?? fakeSupervisor();
  const store = opts.store ?? new cred.MemoryCredentialStore();
  return {
    supervisor,
    store,
    svc: new cred.CredentialService({
      store,
      supervisor,
      injectIntoWorker: opts.injectIntoWorker ?? true,
      log: () => {},
    }),
  };
}

const neverContainsAKey = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const k of [OPENAI_KEY, OPENAI_KEY_2, ANTHROPIC_KEY]) expect(json).not.toContain(k);
};

describe("CredentialService — what the renderer can see and do", () => {
  it("reports both providers as not configured when nothing is saved", async () => {
    const { svc } = service();
    const status = await svc.status();
    expect(status.providers.openai.configured).toBe(false);
    expect(status.providers.anthropic.configured).toBe(false);
  });

  it("save → configured; update; remove → not configured — and no response ever contains a key", async () => {
    const { svc, store } = service();
    const saved = await svc.save("openai", OPENAI_KEY);
    expect(saved.ok).toBe(true);
    expect(saved.providers.openai.configured).toBe(true);
    const updated = await svc.save("openai", OPENAI_KEY_2);
    expect(updated.ok).toBe(true);
    expect(await (store as { get(p: string): Promise<string> }).get("openai")).toBe(OPENAI_KEY_2);
    await svc.save("anthropic", ANTHROPIC_KEY);
    const status = await svc.status();
    const removed = await svc.remove("openai");
    expect(removed.providers.openai.configured).toBe(false);
    expect(removed.providers.anthropic.configured).toBe(true);
    for (const r of [saved, updated, status, removed]) neverContainsAKey(r);
  });

  it("returns validation errors without echoing what was typed", async () => {
    const { svc } = service();
    const res = await svc.save("anthropic", OPENAI_KEY);
    expect(res.ok).toBe(false);
    neverContainsAKey(res);
  });

  it("masks a key out of storage errors", async () => {
    const failing = {
      has: async () => false,
      get: async () => null,
      set: async (_p: string, k: string) => {
        throw new Error(`write failed for ${k}`);
      },
      delete: async () => {},
    };
    const { svc } = service({ store: failing });
    const res = await svc.save("openai", OPENAI_KEY);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[redacted]");
    neverContainsAKey(res);
  });

  it("has no operation that returns a stored key", () => {
    const { svc } = service();
    const callable = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter(
      (n) => n !== "constructor",
    );
    // workerEnv() is main-process only (supervisor hook) and is not wired to IPC.
    expect(callable.sort()).toEqual([
      "analysisRunning",
      "applyToWorker",
      "remove",
      "save",
      "status",
      "workerEnv",
    ]);
    const main = readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
    const handler = main.slice(
      main.indexOf('"assistant-editor:credentials"'),
      main.indexOf("// Worker lifecycle for the renderer"),
    );
    expect(handler).not.toMatch(/workerEnv|\.get\(/);
    const preload = readFileSync(path.join(__dirname, "../electron/preload.cjs"), "utf8");
    const api = preload.slice(preload.indexOf("assistantEditorCredentials"));
    expect(api).not.toMatch(/\bget\b|workerEnv|reveal|read/);
  });
});

describe("CredentialService — applying changes to the worker", () => {
  it("restarts the worker it owns after save and after remove", async () => {
    const { svc, supervisor } = service();
    const saved = await svc.save("openai", OPENAI_KEY);
    expect(supervisor.restart).toHaveBeenCalledTimes(1);
    expect(saved.worker).toMatchObject({
      applied: true,
      restarted: true,
      state: "ready",
      owned: true,
    });
    await svc.remove("openai");
    expect(supervisor.restart).toHaveBeenCalledTimes(2);
  });

  it("never restarts an adopted (externally started) worker — and says so", async () => {
    const { svc, supervisor } = service({ supervisor: fakeSupervisor({ owned: false }) });
    const res = await svc.save("openai", OPENAI_KEY);
    expect(res.ok).toBe(true);
    expect(supervisor.restart).not.toHaveBeenCalled();
    expect(res.worker).toMatchObject({ applied: false, reason: "adopted" });
  });

  it("surfaces a failed restart (masked) instead of claiming success", async () => {
    const { svc } = service({
      supervisor: fakeSupervisor({
        restartTo: { state: "error", owned: false, error: { message: `boom ${OPENAI_KEY}` } },
      }),
    });
    const res = await svc.save("openai", OPENAI_KEY);
    expect(res.worker).toMatchObject({ applied: false, reason: "restart-failed" });
    neverContainsAKey(res);
  });

  it("refuses to change keys mid-analysis (a restart would lose it) and leaves the store untouched", async () => {
    const srv = http.createServer((_q, r) =>
      r.end(JSON.stringify({ project: { analysisState: "running" } })),
    );
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const { svc, supervisor, store } = service({ supervisor: fakeSupervisor({ url }) });
      const res = await svc.save("openai", OPENAI_KEY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("analysis is running");
      expect(supervisor.restart).not.toHaveBeenCalled();
      expect(await (store as { has(p: string): Promise<boolean> }).has("openai")).toBe(false);
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });

  it("feeds keys to the worker environment only when injection is enabled", async () => {
    const store = new cred.MemoryCredentialStore({ openai: OPENAI_KEY, anthropic: ANTHROPIC_KEY });
    expect(await service({ store }).svc.workerEnv()).toEqual({
      OPENAI_API_KEY: OPENAI_KEY,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    });
    expect(await service({ store, injectIntoWorker: false }).svc.workerEnv()).toEqual({});
  });

  it("in development (no injection) never restarts the worker and points at the .env", async () => {
    const { svc, supervisor } = service({ injectIntoWorker: false });
    const res = await svc.save("openai", OPENAI_KEY);
    expect(res.ok).toBe(true);
    expect(supervisor.restart).not.toHaveBeenCalled();
    expect(res.worker).toMatchObject({ applied: false, reason: "development-dotenv" });
    expect(res.appliesTo).toBe("development-dotenv");
  });
});

describe("shouldInjectKeychainCredentials", () => {
  it("always for packaged builds; in development only on explicit opt-in", () => {
    expect(cred.shouldInjectKeychainCredentials({ isPackaged: true, env: {} })).toBe(true);
    expect(cred.shouldInjectKeychainCredentials({ isPackaged: false, env: {} })).toBe(false);
    expect(
      cred.shouldInjectKeychainCredentials({
        isPackaged: false,
        env: { ASSISTANT_EDITOR_DEV_USE_KEYCHAIN: "1" },
      }),
    ).toBe(true);
  });
});
