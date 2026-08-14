// Packaged-runtime smoke test: exercises the production code path (embedded
// renderer child process on a dynamic loopback port) without electron-builder.
// Run: ASSISTANT_EDITOR_EMBEDDED=1 electron electron/smoke-test-packaged.cjs
const { app, BrowserWindow } = require("electron");
process.env["ASSISTANT_EDITOR_EMBEDDED"] = "1";
require("./main.cjs");

const results = [];
function check(name, pass, detail) {
  results.push({ pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

function waitForWindow(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) return resolve(win);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

app.whenReady().then(async () => {
  const win = await waitForWindow(45000);
  check("embedded renderer window created", !!win);
  if (!win) return app.exit(1);

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once("did-finish-load", r));
  }
  const origin = new URL(win.webContents.getURL()).origin;
  check("loads from loopback, not the Vite dev server", /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), origin);
  check("dynamic port is not 8080", !origin.endsWith(":8080"));

  await win.loadURL(`${origin}/settings`);
  const text = await win.webContents.executeJavaScript("document.body.innerText");
  check("/settings renders", text.includes("Settings") && text.includes("Engine diagnostics"));
  check("version still v0.3.1-connected", text.includes("v0.3.1-connected"));

  const hasBridge = await win.webContents.executeJavaScript(
    "typeof window.assistantEditorBridge?.request === 'function'",
  );
  check("bridge injected in packaged renderer", hasBridge === true);

  const run = (req) =>
    win.webContents.executeJavaScript(
      `window.assistantEditorBridge.request(${JSON.stringify(req)})`,
      true,
    );
  const health = await run({ method: "GET", path: "/health" });
  check("worker bridge reaches stub /health", health.status === 200 && health.body.ok === true);
  const rejected = await run({ method: "GET", path: "https://example.com" });
  check("allowlist still rejects foreign hosts", rejected.status === 0 && !!rejected.error);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
