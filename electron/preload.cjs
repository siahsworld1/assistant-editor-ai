// Preload runs with sandbox: true and contextIsolation: true.
// It exposes exactly one narrow, typed function to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantEditorBridge", {
  version: "0.3.1-connected-desktop",
  target: "http://127.0.0.1:32145",
  request: (req) =>
    ipcRenderer.invoke("assistant-editor:request", {
      method: typeof req?.method === "string" ? req.method : "GET",
      path: typeof req?.path === "string" ? req.path : "",
      body: req?.body,
      headers: req?.headers,
      timeoutMs: typeof req?.timeoutMs === "number" ? req.timeoutMs : undefined,
    }),
});

// Narrowly scoped desktop capabilities: project persistence and user-gated
// media folder choice/indexing. No arbitrary filesystem access is exposed.
contextBridge.exposeInMainWorld("assistantEditorDesktop", {
  available: true,
  version: "0.3.1-connected-desktop",
  listProjects: () => ipcRenderer.invoke("assistant-editor:desktop", { action: "listProjects" }),
  saveProject: (project) =>
    ipcRenderer.invoke("assistant-editor:desktop", { action: "saveProject", payload: { project } }),
  deleteProject: (id) =>
    ipcRenderer.invoke("assistant-editor:desktop", {
      action: "deleteProject",
      payload: { id: typeof id === "string" ? id : "" },
    }),
  chooseMediaFolder: () =>
    ipcRenderer.invoke("assistant-editor:desktop", { action: "chooseMediaFolder" }),
  indexMedia: (folderPath) =>
    ipcRenderer.invoke("assistant-editor:desktop", {
      action: "indexMedia",
      payload: { path: typeof folderPath === "string" ? folderPath : "" },
    }),
  exportFile: (suggestedName, content) =>
    ipcRenderer.invoke("assistant-editor:desktop", {
      action: "exportFile",
      payload: {
        suggestedName: typeof suggestedName === "string" ? suggestedName : "",
        content: typeof content === "string" ? content : "",
      },
    }),
  // Authorizes the ae-media:// playback protocol to serve from this root (must
  // already be a folder the user picked via chooseMediaFolder). Pass "" to
  // deauthorize (e.g. when no project is open).
  setActiveMediaRoot: (root) =>
    ipcRenderer.invoke("assistant-editor:desktop", {
      action: "setActiveMediaRoot",
      payload: { root: typeof root === "string" ? root : "" },
    }),
});

// Premiere Pro (UXP) integration status + a fixed command vocabulary.
// No socket, path or URL ever comes from the renderer.
contextBridge.exposeInMainWorld("assistantEditorPremiere", {
  available: true,
  integrationVersion: "0.4.0",
  status: () => ipcRenderer.invoke("assistant-editor:premiere", { action: "status" }),
  sendCommand: (type, payload) =>
    ipcRenderer.invoke("assistant-editor:premiere", {
      action: "command",
      payload: { type: typeof type === "string" ? type : "", payload },
    }),
});
