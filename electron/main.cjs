const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require("electron");
const { disableRemoteDebugging } = require("./debug-switches.cjs");

// First thing, before Chromium starts any service: a packaged app ignores
// --remote-debugging-port and friends (see debug-switches.cjs).
const strippedDebugSwitches = disableRemoteDebugging({ isPackaged: app.isPackaged, commandLine: app.commandLine });
if (strippedDebugSwitches.length) {
  console.warn(`[assistant-editor] ignored debugging switches: ${strippedDebugSwitches.join(", ")}`);
}

const fs = require("node:fs");
const path = require("node:path");
const { validateRequest, sanitizeHeaders } = require("./allowlist.cjs");
const { EmbeddedRenderer } = require("./renderer-server.cjs");
const { DesktopCapabilities, handleDesktopAction } = require("./desktop-capabilities.cjs");
const { PremiereBridge } = require("./premiere-bridge.cjs");
const { configureAppIdentity } = require("./app-identity.cjs");
const { WorkerSupervisor, resolveWorkerLaunch } = require("./worker-supervisor.cjs");
const {
  CredentialService,
  KeychainCredentialStore,
  MemoryCredentialStore,
  redactSecrets,
  shouldInjectKeychainCredentials,
} = require("./credential-store.cjs");
const {
  registerMediaProtocolPrivileges,
  createMediaProtocolHandler,
} = require("./media-protocol.cjs");

// Must happen before app.whenReady() — Electron silently ignores privilege
// registration for a scheme that's already been used or after boot.
registerMediaProtocolPrivileges(protocol);

// Real product identity for local app data (was the template's
// "tanstack_start_ts"); copies legacy projects over once. Before "ready".
const identity = configureAppIdentity(app);
if (identity.migration.migrated) {
  console.log(
    `[assistant-editor] copied legacy app data (${identity.migration.copied.join(", ")}) into ${identity.userData}`,
  );
}

// Developer tools exist only in development builds — never in the packaged
// app, whatever its environment says.
const devToolsEnabled = !app.isPackaged;
const DEV_RENDERER_URL = process.env["ASSISTANT_EDITOR_RENDERER_URL"] || "http://localhost:8080";
/** Forces the packaged code path (embedded renderer) while developing/testing. */
const FORCE_EMBEDDED = process.env["ASSISTANT_EDITOR_EMBEDDED"] === "1";
const DEFAULT_TIMEOUT_MS = 8000;

const embedded = new EmbeddedRenderer();
/** Loopback contract server for the Premiere Pro UXP panel (v0.4.0). */
const premiere = new PremiereBridge();
/**
 * Provider API keys live in the macOS Keychain and reach only the worker's
 * environment. Packaged builds always inject them; development keeps using
 * the repository .env unless ASSISTANT_EDITOR_DEV_USE_KEYCHAIN=1 opts in
 * (Keychain values would otherwise silently override the .env ones).
 */
const injectKeychainCredentials = shouldInjectKeychainCredentials({ isPackaged: app.isPackaged });
const credentialStore =
  process.platform === "darwin" ? new KeychainCredentialStore() : new MemoryCredentialStore();
/** @type {CredentialService} */
let credentialService;
/** The local engine (worker/server.py in dev). Started at launch, stopped on quit. */
const worker = new WorkerSupervisor({
  credentials: () => credentialService.workerEnv(),
  launch: () =>
    resolveWorkerLaunch({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
});
/** Project persistence + user-gated media indexing. Created after app ready. */
let capabilities = null;
/** Resolved at boot: dev server URL, or the embedded renderer's loopback URL. */
let rendererUrl = null;
let mainWindow = null;
let errorWindow = null;

function useEmbeddedRenderer() {
  return app.isPackaged || FORCE_EMBEDDED;
}

/** Origins the renderer window may ever navigate to. */
function isTrustedTarget(rawUrl) {
  if (!rendererUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1280,
    backgroundColor: "#0b0c0e",
    title: "Assistant Editor AI",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: devToolsEnabled,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // No popups. External http(s) links open in the user's browser instead.
    try {
      const { protocol } = new URL(url);
      if ((protocol === "http:" || protocol === "https:") && !isTrustedTarget(url)) {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed urls */
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedTarget(url)) event.preventDefault();
  });
  // A server-side redirect must not take the window off the interface either.
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedTarget(url)) event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(rendererUrl);
  return mainWindow;
}

function showStartupError(message) {
  if (errorWindow && !errorWindow.isDestroyed()) {
    errorWindow.webContents.send("assistant-editor:startup-error", message);
    errorWindow.focus();
    return;
  }
  errorWindow = new BrowserWindow({
    width: 640,
    height: 440,
    resizable: false,
    backgroundColor: "#0b0c0e",
    title: "Assistant Editor AI",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "error-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: devToolsEnabled,
    },
  });
  errorWindow.on("closed", () => {
    errorWindow = null;
  });
  errorWindow.loadFile(path.join(__dirname, "startup-error.html"));
  errorWindow.webContents.once("did-finish-load", () => {
    errorWindow?.webContents.send("assistant-editor:startup-error", message);
  });
}

/** Third-party notices written into the packaged app by scripts/after-pack.cjs. */
function acknowledgementsPath() {
  return path.join(process.resourcesPath, "licenses", "Acknowledgements.html");
}

/** macOS menu: the standard app/Edit/View/Window menus, and Help → Acknowledgements
 * in place of Electron's default links to electronjs.org. */
function installApplicationMenu() {
  app.setAboutPanelOptions({
    applicationName: "Assistant Editor AI",
    applicationVersion: app.getVersion(),
    credits: "Includes open-source software — see Help › Acknowledgements.",
  });
  const help = [];
  if (fs.existsSync(acknowledgementsPath())) {
    help.push({ label: "Acknowledgements", click: () => void shell.openPath(acknowledgementsPath()) });
  }
  const viewItems = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (devToolsEnabled) viewItems.unshift({ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { label: "View", submenu: viewItems },
      { role: "windowMenu" },
      { role: "help", submenu: help },
    ]),
  );
}

/** The interface needs no device or browser permissions (camera, microphone,
 * notifications, clipboard API, geolocation, …): deny every request. */
function denyWebPermissions() {
  const allowed = new Set(["fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

/** Boot: resolve a renderer URL, then open the app window (or the error window). */
async function boot() {
  if (!useEmbeddedRenderer()) {
    rendererUrl = DEV_RENDERER_URL;
    createWindow();
    return;
  }
  const result = await embedded.start(app);
  if (!result.ok) {
    rendererUrl = null;
    showStartupError(result.error);
    return;
  }
  rendererUrl = result.url;
  if (errorWindow && !errorWindow.isDestroyed()) errorWindow.close();
  createWindow();
}

ipcMain.on("assistant-editor:startup-retry", () => {
  void boot();
});
ipcMain.on("assistant-editor:startup-quit", () => {
  app.quit();
});

ipcMain.handle("assistant-editor:desktop", async (_event, payload) => {
  if (!capabilities) return { ok: false, error: "Desktop capabilities are not ready yet." };
  return handleDesktopAction(capabilities, payload?.action, payload?.payload);
});

// Narrow renderer surface for the Premiere integration: read status, send one
// of a fixed set of commands. The renderer can never reach the bridge socket.
ipcMain.handle("assistant-editor:premiere", async (_event, payload) => {
  const action = typeof payload?.action === "string" ? payload.action : "";
  if (action === "status") return { ok: true, status: premiere.status() };
  if (action === "command") {
    const result = premiere.enqueueCommand({
      type: payload?.payload?.type,
      payload: payload?.payload?.payload,
    });
    return result.ok
      ? { ok: true, status: premiere.status() }
      : { ok: false, error: result.error };
  }
  return { ok: false, error: `Unknown Premiere action: ${action || "(none)"}` };
});

credentialService = new CredentialService({
  store: credentialStore,
  supervisor: worker,
  injectIntoWorker: injectKeychainCredentials,
});

// AI-provider credentials for the renderer: status, save, remove. Nothing on
// this channel ever returns a stored key; errors are scrubbed of the key.
ipcMain.handle("assistant-editor:credentials", async (_event, payload) => {
  const action = typeof payload?.action === "string" ? payload.action : "";
  const submitted = typeof payload?.key === "string" ? payload.key : "";
  try {
    if (action === "status") return await credentialService.status();
    if (action === "save") return await credentialService.save(payload?.provider, submitted);
    if (action === "remove") return await credentialService.remove(payload?.provider);
    return { ok: false, error: `Unknown credential action: ${action || "(none)"}` };
  } catch (err) {
    return { ok: false, error: redactSecrets(err && err.message, [submitted]) };
  }
});

// Worker lifecycle for the renderer: read status, wait for startup to settle,
// or restart after a failure. Never exposes paths, env or the child process.
ipcMain.handle("assistant-editor:worker", async (_event, payload) => {
  const action = typeof payload?.action === "string" ? payload.action : "";
  if (action === "status") return worker.status();
  if (action === "waitUntilReady") return worker.waitUntilReady();
  if (action === "restart") return worker.restart();
  return {
    state: "error",
    owned: false,
    pid: null,
    url: worker.url,
    error: { kind: "bad-request", message: `Unknown worker action: ${action || "(none)"}` },
  };
});

ipcMain.handle("assistant-editor:request", async (_event, payload) => {
  const check = validateRequest(payload?.method, payload?.path);
  if (!check.ok) {
    return { status: 0, body: null, error: check.error };
  }
  const controller = new AbortController();
  // Ceiling raised from 60s to 120s: a real engine's /build call makes a synchronous
  // LLM request (see worker/ai_client.py::build_timeline) that can occasionally run
  // long. /analyze itself returns almost immediately (the worker backgrounds the
  // actual work), so this only affects the slower, blocking routes.
  const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || DEFAULT_TIMEOUT_MS, 500), 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(check.url, {
      method: check.method,
      signal: controller.signal,
      headers: sanitizeHeaders(payload?.headers),
      ...(check.method === "POST" ? { body: JSON.stringify(payload?.body ?? {}) } : {}),
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return { status: res.status, body: null, error: "Engine returned a non-JSON payload" };
      }
    }
    return { status: res.status, body };
  } catch (err) {
    // Normalized message only — never a stack trace.
    const aborted = err && err.name === "AbortError";
    return {
      status: 0,
      body: null,
      error: aborted
        ? `Worker did not respond within ${timeoutMs}ms`
        : `Worker unreachable at 127.0.0.1:32145`,
    };
  } finally {
    clearTimeout(timer);
  }
});

app.whenReady().then(() => {
  capabilities = new DesktopCapabilities({
    userDataDir: app.getPath("userData"),
    // The path never comes from the renderer: the user picks it in the OS dialog.
    showFolderDialog: async () => {
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const res = await (parent
        ? dialog.showOpenDialog(parent, {
            title: "Choose a media folder",
            properties: ["openDirectory", "createDirectory"],
          })
        : dialog.showOpenDialog({
            title: "Choose a media folder",
            properties: ["openDirectory", "createDirectory"],
          }));
      return res.canceled ? null : res.filePaths;
    },
    // Same principle as the folder dialog: the renderer supplies content + a
    // suggested name, the OS save dialog picks the actual destination path.
    // Filters follow the suggested filename's extension so each of the three
    // export formats (CMX3600 EDL, Premiere XMEML, FCPXML) gets a sensible
    // default in the OS dialog rather than one hardcoded to ".edl".
    showSaveDialog: async (suggestedName) => {
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const ext = path.extname(String(suggestedName || "")).toLowerCase();
      const filterByExt = {
        ".edl": { name: "CMX3600 EDL", extensions: ["edl"] },
        ".xml": { name: "Premiere / Final Cut Pro 7 XML (XMEML)", extensions: ["xml"] },
        ".fcpxml": { name: "Final Cut Pro X / Resolve XML (FCPXML)", extensions: ["fcpxml"] },
      };
      const primary = filterByExt[ext];
      const options = {
        title: "Export sequence",
        defaultPath: suggestedName,
        filters: [...(primary ? [primary] : []), { name: "All files", extensions: ["*"] }],
      };
      const res = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options));
      return res.canceled || !res.filePath ? null : res.filePath;
    },
  });
  // Serves real media (originals + generated proxies) to the renderer's <video>
  // elements, scoped to whichever mediaRoot the renderer has authorized via
  // setActiveMediaRoot (see desktop-capabilities.cjs). Registered once, here,
  // after `capabilities` exists so the handler always reads its *current* state.
  protocol.handle("ae-media", createMediaProtocolHandler(() => capabilities?.activeMediaRoot ?? null));
  denyWebPermissions();
  if (process.platform === "darwin") installApplicationMenu();
  // Re-authorise roots persisted by previous sessions.
  void capabilities.readAll();
  void premiere.start().then((res) => {
    if (!res.ok) console.warn(`[assistant-editor] ${res.error}`);
  });
  // Started in parallel with the window; the renderer waits on it via the
  // assistant-editor:worker IPC before treating the engine as available.
  void worker.start();
  void boot();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let workerStopped = false;
app.on("before-quit", (event) => {
  embedded.stop();
  premiere.stop();
  // Give the worker we own its graceful SIGTERM (bounded by the supervisor's
  // grace period + SIGKILL) before the app actually exits. Finish with
  // app.exit(), not app.quit(): on macOS a quit that arrived as an Apple Event
  // (Cmd-Q, Dock "Quit", `osascript quit`) and was deferred here swallows a
  // re-issued app.quit(), leaving the app running with its worker already
  // stopped (found in the packaged-app smoke test). All cleanup has run by now.
  if (!workerStopped) {
    event.preventDefault();
    workerStopped = true;
    void worker.stop().finally(() => app.exit(0));
  }
});
app.on("quit", () => {
  embedded.stop();
  premiere.stop();
});
process.on("exit", () => {
  embedded.stop();
  premiere.stop();
  worker.killNow();
});
// Ctrl+C / `concurrently -k` in dev: go through the normal quit path so the
// worker is stopped gracefully (its parent watchdog covers a hard kill).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => app.quit());
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // Every window (including the startup-error page) stays on the interface and
  // opens no popups; createWindow() replaces the popup handler for the main
  // window so external links go to the user's browser.
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedTarget(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

module.exports = { embedded, premiere, worker };
