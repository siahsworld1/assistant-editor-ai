const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require("electron");
const path = require("node:path");
const { validateRequest, sanitizeHeaders } = require("./allowlist.cjs");
const { EmbeddedRenderer } = require("./renderer-server.cjs");
const { DesktopCapabilities, handleDesktopAction } = require("./desktop-capabilities.cjs");
const { PremiereBridge } = require("./premiere-bridge.cjs");
const {
  registerMediaProtocolPrivileges,
  createMediaProtocolHandler,
} = require("./media-protocol.cjs");

// Must happen before app.whenReady() — Electron silently ignores privilege
// registration for a scheme that's already been used or after boot.
registerMediaProtocolPrivileges(protocol);

const isDev = !app.isPackaged || process.env["ASSISTANT_EDITOR_DEV"] === "1";
const DEV_RENDERER_URL = process.env["ASSISTANT_EDITOR_RENDERER_URL"] || "http://localhost:8080";
/** Forces the packaged code path (embedded renderer) while developing/testing. */
const FORCE_EMBEDDED = process.env["ASSISTANT_EDITOR_EMBEDDED"] === "1";
const DEFAULT_TIMEOUT_MS = 8000;

const embedded = new EmbeddedRenderer();
/** Loopback contract server for the Premiere Pro UXP panel (v0.4.0). */
const premiere = new PremiereBridge();
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
      devTools: isDev,
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
      devTools: isDev,
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
  // Re-authorise roots persisted by previous sessions.
  void capabilities.readAll();
  void premiere.start().then((res) => {
    if (!res.ok) console.warn(`[assistant-editor] ${res.error}`);
  });
  void boot();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  embedded.stop();
  premiere.stop();
});
app.on("quit", () => {
  embedded.stop();
  premiere.stop();
});
process.on("exit", () => {
  embedded.stop();
  premiere.stop();
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

module.exports = { embedded, premiere };
