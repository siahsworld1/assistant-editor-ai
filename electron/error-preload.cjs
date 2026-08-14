// Preload for the startup error window only. Exposes two no-argument actions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantEditorShell", {
  retry: () => ipcRenderer.send("assistant-editor:startup-retry"),
  quit: () => ipcRenderer.send("assistant-editor:startup-quit"),
  onMessage: (cb) =>
    ipcRenderer.on("assistant-editor:startup-error", (_e, message) => cb(String(message ?? ""))),
});
