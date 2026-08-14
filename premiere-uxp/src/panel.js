/* eslint-disable */
// Panel controller: handshake, live state sync, action wiring, diagnostics.
// Every action degrades gracefully: if a capability is false the button is
// disabled, but handshake/diagnostics keep working so the panel is usable.

(function () {
  "use strict";

  var Bridge = window.AssistantEditorBridgeClient;
  var adapter = new window.AssistantEditorAdapter.UxpPremiereAdapter();

  var el = function (id) { return document.getElementById(id); };
  var state = { caps: {}, connected: false, busy: false };

  function setStatus(text) { el("status").textContent = text; }

  function setConnection(kind, label) {
    el("conn-dot").className = "dot " + kind;
    el("conn-state").textContent = label;
  }

  function setError(message) {
    var node = el("d-error");
    if (!message) { node.hidden = true; node.textContent = ""; return; }
    node.hidden = false;
    node.textContent = message;
  }

  function capOn(key) { return state.caps[key] === true; }

  function refreshButtons() {
    var live = state.connected;
    el("btn-analyze").disabled = !live || state.busy;
    el("btn-send-selection").disabled = !live || state.busy || !capOn("selection.read");
    el("btn-open").disabled = !live || state.busy;
    var canBuild = live && capOn("sequence.create") && capOn("clip.insert");
    el("btn-build-selects").disabled = !canBuild || state.busy;
    el("btn-build-story").disabled = !canBuild || state.busy;
    el("btn-apply-latest").disabled = !canBuild || state.busy;
  }

  async function handshake() {
    var identity = await adapter.identify();
    state.caps = await adapter.capabilities();
    el("d-host").textContent = identity.host + (identity.hostVersion ? " " + identity.hostVersion : "");
    var res = await Bridge.send("handshake", {
      protocolVersion: identity.protocolVersion,
      pluginVersion: identity.pluginVersion,
      host: identity.host,
      hostVersion: identity.hostVersion,
      capabilities: state.caps,
    });
    if (!res.ok) {
      state.connected = false;
      setConnection("off", "not connected");
      setError(res.error || "Handshake rejected");
      refreshButtons();
      return false;
    }
    state.connected = true;
    setConnection("live", "connected");
    setError(null);
    el("d-protocol").textContent = res.protocolVersion + " \u00b7 plugin " + identity.pluginVersion;
    refreshButtons();
    return true;
  }

  async function pushHostState() {
    if (!state.connected) return;
    try {
      var project = capOn("project.read") ? await adapter.getActiveProject() : null;
      if (project) {
        el("project-name").textContent = project.name;
        await Bridge.send("project.state", project);
      } else {
        el("project-name").textContent = capOn("project.read") ? "no project open" : "unavailable";
      }
      var sequence = capOn("sequence.read") ? await adapter.getActiveSequence() : null;
      if (sequence) {
        el("sequence-name").textContent = sequence.name;
        await Bridge.send("sequence.state", sequence);
      } else {
        el("sequence-name").textContent = capOn("sequence.read") ? "no active sequence" : "unavailable";
      }
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
    }
  }

  async function drainCommands() {
    var res = await Bridge.commands();
    if (!res.ok || !res.commands || !res.commands.length) return;
    setStatus("Desktop requested: " + res.commands[res.commands.length - 1].type);
  }

  async function refreshDiagnostics() {
    var health = await Bridge.health();
    el("d-endpoint").textContent = Bridge.endpoint;
    if (!health.ok) {
      state.connected = false;
      setConnection("off", "desktop offline");
      setError(health.error || "Desktop companion unreachable");
      refreshButtons();
      return;
    }
    if (!health.connected) {
      setConnection("warn", "handshaking\u2026");
      await handshake();
    } else {
      state.connected = true;
      setConnection("live", "connected");
      setError(null);
    }
    el("d-protocol").textContent = health.protocolVersion + " \u00b7 min plugin " + health.minPluginVersion;
    el("d-sync").textContent = health.lastMessageAt
      ? new Date(health.lastMessageAt).toLocaleTimeString()
      : "never";
    var enabled = Object.keys(state.caps).filter(capOn);
    el("d-caps").textContent = enabled.length ? enabled.join(", ") : "read-only / none advertised";
    await drainCommands();
    refreshButtons();
  }

  async function run(label, fn) {
    state.busy = true;
    refreshButtons();
    setStatus(label + "\u2026");
    try {
      await fn();
    } catch (e) {
      var msg = e && e.name === "NotImplementedInHost"
        ? label + " needs a Premiere host capability that is not available yet."
        : label + " failed: " + (e && e.message ? e.message : String(e));
      setStatus(msg);
      setError(msg);
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  el("btn-analyze").addEventListener("click", function () {
    run("Analyze Footage", async function () {
      var media = capOn("media.metadata") ? await adapter.getProjectMedia() : [];
      await Bridge.send("media.metadata", { items: media });
      var res = await Bridge.send("diagnostics.ping", {});
      setStatus(res.ok ? "Sent " + media.length + " project items for analysis." : "Desktop unreachable.");
    });
  });

  el("btn-send-selection").addEventListener("click", function () {
    run("Send Selection", async function () {
      var items = await adapter.getSelectedItems();
      el("selection-count").textContent = items.length + " items";
      var res = await Bridge.send("selection.state", { items: items });
      setStatus(res.ok ? "Sent " + items.length + " selected clips." : "Desktop unreachable.");
    });
  });

  el("btn-open").addEventListener("click", function () {
    run("Open Assistant Editor", async function () {
      var res = await Bridge.send("diagnostics.ping", { intent: "focus" });
      setStatus(res.ok ? "Asked Assistant Editor Desktop to come forward." : "Desktop unreachable.");
    });
  });

  function buildHandler(label, kind) {
    return function () {
      run(label, async function () {
        if (!capOn("sequence.create") || !capOn("clip.insert")) {
          throw window.AssistantEditorAdapter.notImplemented("sequence.create");
        }
        var names = await adapter.listSequenceNames();
        await Bridge.send("diagnostics.ping", { intent: kind, existing: names.length });
        setStatus(label + " requested.");
      });
    };
  }

  el("btn-build-selects").addEventListener("click", buildHandler("Build Selects Sequence", "selects"));
  el("btn-build-story").addEventListener("click", buildHandler("Build Story Cut", "story"));
  el("btn-apply-latest").addEventListener("click", buildHandler("Apply Latest Cut", "apply"));
  el("btn-refresh").addEventListener("click", function () {
    run("Refresh", async function () {
      await refreshDiagnostics();
      await pushHostState();
      setStatus("Diagnostics refreshed.");
    });
  });

  (async function init() {
    setConnection("warn", "connecting\u2026");
    await refreshDiagnostics();
    await pushHostState();
    setStatus(state.connected ? "Ready." : "Start Assistant Editor Desktop to connect.");
    setInterval(function () { if (!state.busy) refreshDiagnostics(); }, 6000);
  })();
})();