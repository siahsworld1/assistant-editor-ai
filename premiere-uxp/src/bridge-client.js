/* eslint-disable */
// Tiny loopback client for the Assistant Editor desktop companion.
// The ONLY origin this panel ever talks to is http://127.0.0.1:32146, which is
// also the only entry in manifest.json requiredPermissions.network.domains.

(function (global) {
  "use strict";

  var ENDPOINT = "http://127.0.0.1:32146";
  var TIMEOUT_MS = 6000;

  function uid() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function call(path, init) {
    if (path !== "/premiere/health" && path !== "/premiere/commands" && path !== "/premiere/message") {
      throw new Error("Blocked path: " + path);
    }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    try {
      var res = await fetch(ENDPOINT + path, Object.assign({ signal: controller && controller.signal }, init));
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        return { ok: false, error: body.error || "Desktop companion returned " + res.status };
      }
      return body;
    } catch (e) {
      return { ok: false, error: "Assistant Editor Desktop is not reachable on 127.0.0.1:32146." };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  global.AssistantEditorBridgeClient = {
    endpoint: ENDPOINT,
    health: function () {
      return call("/premiere/health", { method: "GET" });
    },
    commands: function () {
      return call("/premiere/commands", { method: "GET" });
    },
    send: function (type, payload) {
      return call("/premiere/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, id: uid(), type: type, payload: payload || {} }),
      });
    },
  };
})(typeof window !== "undefined" ? window : globalThis);