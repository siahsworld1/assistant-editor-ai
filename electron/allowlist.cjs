// Shared, dependency-free allowlist for the Assistant Editor desktop bridge.
// Required by the Electron main process and by the smoke test.

const ENGINE_ORIGIN = "http://127.0.0.1:32145";

/** method -> allowed paths. Nothing else may ever be proxied. */
const ALLOWED_ROUTES = {
  GET: ["/health", "/selects", "/stories", "/project", "/nle"],
  POST: ["/analyze", "/build"],
};

const OPTIONAL_ROUTES = ["/project", "/nle"];

/**
 * @param {unknown} method
 * @param {unknown} path
 * @returns {{ ok: true, method: string, path: string, url: string } | { ok: false, error: string }}
 */
function validateRequest(method, path) {
  const m = typeof method === "string" ? method.toUpperCase() : "";
  if (m !== "GET" && m !== "POST") {
    return { ok: false, error: `Method not allowed: ${String(method)}` };
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { ok: false, error: `Path must be a relative engine route, got: ${String(path)}` };
  }
  // Reject protocol-relative URLs, traversal, fragments and backslash tricks.
  if (path.startsWith("//") || path.includes("..") || path.includes("\\") || path.includes("#")) {
    return { ok: false, error: `Path rejected: ${path}` };
  }
  let parsed;
  try {
    parsed = new URL(path, ENGINE_ORIGIN);
  } catch {
    return { ok: false, error: `Path rejected: ${path}` };
  }
  if (parsed.origin !== ENGINE_ORIGIN) {
    return { ok: false, error: `Host not allowed: ${parsed.origin}` };
  }
  const allowed = ALLOWED_ROUTES[m];
  if (!allowed.includes(parsed.pathname)) {
    return { ok: false, error: `Route not in Assistant Editor allowlist: ${m} ${parsed.pathname}` };
  }
  // Only a bounded query string is forwarded (the engine accepts project scoping).
  if (parsed.search.length > 256) {
    return { ok: false, error: "Query string too long" };
  }
  return {
    ok: true,
    method: m,
    path: parsed.pathname + parsed.search,
    url: `${ENGINE_ORIGIN}${parsed.pathname}${parsed.search}`,
  };
}

/** Only a tiny set of request headers may cross the bridge. */
function sanitizeHeaders(headers) {
  const out = { "content-type": "application/json", accept: "application/json" };
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      const key = k.toLowerCase();
      if (key === "x-assistant-editor-client" && typeof v === "string") out[key] = v.slice(0, 128);
    }
  }
  return out;
}

module.exports = { ENGINE_ORIGIN, ALLOWED_ROUTES, OPTIONAL_ROUTES, validateRequest, sanitizeHeaders };
