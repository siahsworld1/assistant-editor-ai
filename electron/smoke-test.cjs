// Headless smoke test for the desktop bridge. Run: electron electron/smoke-test.cjs
const { app, BrowserWindow } = require("electron");
require("./main.cjs");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  const run = (req) =>
    win.webContents.executeJavaScript(
      `window.assistantEditorBridge.request(${JSON.stringify(req)})`,
      true,
    );

  const hasBridge = await win.webContents.executeJavaScript(
    "typeof window.assistantEditorBridge?.request === 'function'",
  );
  check("bridge detected in renderer", hasBridge === true);

  const health = await run({ method: "GET", path: "/health" });
  check("GET /health -> live", health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

  const selects = await run({ method: "GET", path: "/selects" });
  check("GET /selects wrapped payload", selects.status === 200 && Array.isArray(selects.body.selects));

  const stories = await run({ method: "GET", path: "/stories" });
  check("GET /stories wrapped payload", stories.status === 200 && Array.isArray(stories.body.stories));

  const analyze = await run({ method: "POST", path: "/analyze", body: { projectId: "demo" } });
  check("POST /analyze", analyze.status === 200);

  const build = await run({ method: "POST", path: "/build", body: {} });
  check("POST /build returns timeline", build.status === 200 && !!build.body.timeline);

  for (const p of ["/project", "/nle"]) {
    const r = await run({ method: "GET", path: p });
    check(`optional ${p} may 404 without error`, r.status === 404 && !r.error);
  }

  const q = await run({ method: "GET", path: "/selects?project=demo" });
  check("allows scoped /selects?project=", q.status === 200);
  for (const bad of ["https://example.com", "/etc/passwd", "//evil.com/health", "/health/../secret", "file:///etc/passwd"]) {
    const r = await run({ method: "GET", path: bad });
    check(`rejects ${bad}`, r.status === 0 && typeof r.error === "string" && r.body === null, r.error);
  }
  const badMethod = await run({ method: "DELETE", path: "/health" });
  check("rejects DELETE /health", badMethod.status === 0 && !!badMethod.error);

  const desk = (call) => win.webContents.executeJavaScript(call, true);

  // --- Premiere (UXP) integration ------------------------------------------
  check(
    "premiere renderer api exposed",
    (await desk("typeof window.assistantEditorPremiere?.status === 'function'")) === true,
  );
  const premStatus = await desk("window.assistantEditorPremiere.status()");
  check(
    "premiere bridge listening on 32146",
    premStatus.ok === true && premStatus.status.listening === true && premStatus.status.connected === false,
    premStatus.status && premStatus.status.endpoint,
  );
  const premOk = await desk("window.assistantEditorPremiere.sendCommand('analyze')");
  check("premiere allowlisted command queued", premOk.ok === true && premOk.status.queued === 1);
  const premBad = await desk("window.assistantEditorPremiere.sendCommand('shell.exec')");
  check("premiere rejects unknown command", premBad.ok === false, premBad.error);

  check(
    "desktop capabilities exposed",
    (await desk("typeof window.assistantEditorDesktop?.indexMedia === 'function'")) === true,
  );
  const list = await desk("window.assistantEditorDesktop.listProjects()");
  check("listProjects returns a project array", list.ok === true && Array.isArray(list.projects));

  const saved = await desk(
    "window.assistantEditorDesktop.saveProject({ id: 'smoke-doc', name: 'Smoke Doc' })",
  );
  check("saveProject persists a record", saved.ok === true && saved.projects.some((p) => p.id === "smoke-doc"));

  const sneaky = await desk(
    "window.assistantEditorDesktop.saveProject({ id: 'sneaky', name: 'Sneaky', mediaRoot: '/etc' })",
  );
  check("rejects unauthorised mediaRoot", sneaky.ok === false, sneaky.error);

  const unpicked = await desk("window.assistantEditorDesktop.indexMedia('/etc')");
  check("rejects indexing an unpicked folder", unpicked.ok === false, unpicked.error);

  const rogue = await win.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('assistant-editor:desktop', { action: 'readFile', payload: { path: '/etc/passwd' } }).catch((e) => ({ ok: false, error: String(e) }))",
    true,
  ).catch(() => ({ ok: false, error: "renderer has no ipcRenderer" }));
  check("renderer cannot invoke arbitrary desktop actions", rogue.ok === false, rogue.error);

  const cleaned = await desk("window.assistantEditorDesktop.deleteProject('smoke-doc')");
  check("deleteProject removes the record", cleaned.ok === true && !cleaned.projects.some((p) => p.id === "smoke-doc"));

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
