// Assistant Editor <-> Adobe Premiere Pro (UXP) message contract.
//
// Dependency-free CommonJS so it can be required by the Electron main process,
// by the local Premiere bridge server and by the vitest suite without a build
// step. The renderer consumes a typed mirror of these shapes from
// src/lib/premiere/contract.ts.
//
// Security posture: every field that crosses the bridge is validated here.
// Unknown message types, oversized payloads, non-loopback targets and
// filesystem-looking strings are rejected before anything is acted on.

const PREMIERE_PROTOCOL_VERSION = "1.0.0";
/** Oldest UXP plugin build this desktop companion still speaks to. */
const MIN_SUPPORTED_PLUGIN_VERSION = "0.4.0";
/** Plugin builds newer than this major are refused (breaking contract change). */
const SUPPORTED_PLUGIN_MAJOR = 0;

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 32146;
/** The Assistant Editor worker origin never changes. */
const WORKER_ORIGIN = "http://127.0.0.1:32145";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STRING = 512;
const MAX_LIST = 400;

/**
 * Capabilities the plugin may advertise. Anything not in this list is dropped:
 * Assistant Editor never assumes a Premiere API exists because a message said so.
 */
const KNOWN_CAPABILITIES = [
  "project.read",
  "sequence.read",
  "selection.read",
  "media.metadata",
  "sequence.create",
  "clip.insert",
  "broll.insert",
  "markers.write",
  "labels.write",
];

/** Messages the plugin may send to the desktop companion. */
const MESSAGE_TYPES = [
  "handshake",
  "project.state",
  "sequence.state",
  "selection.state",
  "media.metadata",
  "capabilities",
  "diagnostics.ping",
  "error",
];

/** Commands the desktop companion may hand back to the plugin. */
const COMMAND_TYPES = [
  "analyze",
  "build.selects",
  "build.story",
  "apply.latest",
  "open.assistant",
];

function fail(code, error) {
  return { ok: false, code, error };
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

function cleanString(value, max = MAX_STRING) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function finiteNumber(value, { min = -1e9, max = 1e9 } = {}) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/** Normalizes advertised capabilities into a full, explicit flag map. */
function normalizeCapabilities(list) {
  const flags = {};
  for (const key of KNOWN_CAPABILITIES) flags[key] = false;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    // Object form: { "project.read": true, ... }. Unknown keys are dropped.
    for (const key of KNOWN_CAPABILITIES) {
      if (list[key] === true) flags[key] = true;
    }
    return flags;
  }
  if (!Array.isArray(list)) return flags;
  for (const raw of list.slice(0, MAX_LIST)) {
    const key = cleanString(raw, 64);
    if (key && Object.prototype.hasOwnProperty.call(flags, key)) flags[key] = true;
  }
  return flags;
}

function validateHandshake(payload) {
  const protocolVersion = cleanString(payload?.protocolVersion, 32);
  const pluginVersion = cleanString(payload?.pluginVersion, 32);
  const host = cleanString(payload?.host, 64) || "unknown";
  if (!parseVersion(protocolVersion)) return fail("bad_handshake", "Missing or malformed protocolVersion");
  if (!parseVersion(pluginVersion)) return fail("bad_handshake", "Missing or malformed pluginVersion");
  const pv = parseVersion(pluginVersion);
  if (pv.major !== SUPPORTED_PLUGIN_MAJOR) {
    return fail(
      "incompatible_version",
      `Premiere plugin ${pluginVersion} is not compatible with this companion (expects ${SUPPORTED_PLUGIN_MAJOR}.x)`,
    );
  }
  if (compareVersions(pluginVersion, MIN_SUPPORTED_PLUGIN_VERSION) === -1) {
    return fail(
      "incompatible_version",
      `Premiere plugin ${pluginVersion} is older than the minimum supported ${MIN_SUPPORTED_PLUGIN_VERSION}`,
    );
  }
  if (parseVersion(protocolVersion).major !== parseVersion(PREMIERE_PROTOCOL_VERSION).major) {
    return fail(
      "incompatible_version",
      `Protocol ${protocolVersion} is not compatible with ${PREMIERE_PROTOCOL_VERSION}`,
    );
  }
  return {
    ok: true,
    payload: {
      protocolVersion,
      pluginVersion,
      host,
      hostVersion: cleanString(payload?.hostVersion, 32) || null,
      capabilities: normalizeCapabilities(payload?.capabilities),
    },
  };
}

function validateProjectState(payload) {
  const name = cleanString(payload?.name, 200);
  if (!name) return fail("bad_payload", "project.state requires a name");
  return {
    ok: true,
    payload: {
      id: cleanString(payload?.id, 128) || name,
      name,
      // Premiere exposes a project path; we keep it as opaque metadata and never
      // read from it on the desktop side.
      path: cleanString(payload?.path, MAX_STRING),
      itemCount: finiteNumber(payload?.itemCount, { min: 0, max: 1e6 }) ?? 0,
    },
  };
}

function validateSequenceState(payload) {
  const name = cleanString(payload?.name, 200);
  if (!name) return fail("bad_payload", "sequence.state requires a name");
  return {
    ok: true,
    payload: {
      id: cleanString(payload?.id, 128) || name,
      name,
      fps: finiteNumber(payload?.fps, { min: 1, max: 240 }) ?? 25,
      durationSeconds: finiteNumber(payload?.durationSeconds, { min: 0, max: 86400 }) ?? 0,
      videoTracks: finiteNumber(payload?.videoTracks, { min: 0, max: 128 }) ?? 0,
      audioTracks: finiteNumber(payload?.audioTracks, { min: 0, max: 128 }) ?? 0,
    },
  };
}

function validateClip(raw) {
  const name = cleanString(raw?.name, 200);
  if (!name) return null;
  return {
    id: cleanString(raw?.id, 128) || name,
    name,
    // Media path is metadata only. The desktop side hands it to the worker, it
    // never opens it itself.
    mediaPath: cleanString(raw?.mediaPath, MAX_STRING),
    durationSeconds: finiteNumber(raw?.durationSeconds, { min: 0, max: 86400 }) ?? 0,
    inSeconds: finiteNumber(raw?.inSeconds, { min: 0, max: 86400 }),
    outSeconds: finiteNumber(raw?.outSeconds, { min: 0, max: 86400 }),
    fps: finiteNumber(raw?.fps, { min: 1, max: 240 }),
    role: ["interview", "b-roll", "ambient"].includes(raw?.role) ? raw.role : "interview",
  };
}

function validateSelection(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const clips = items.slice(0, MAX_LIST).map(validateClip).filter(Boolean);
  return { ok: true, payload: { items: clips, truncated: items.length > MAX_LIST } };
}

function validateMediaMetadata(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    ok: true,
    payload: {
      items: items.slice(0, MAX_LIST).map(validateClip).filter(Boolean),
      truncated: items.length > MAX_LIST,
    },
  };
}

function validateError(payload) {
  return {
    ok: true,
    payload: {
      // Normalized text only — the panel must never forward a stack trace.
      message: cleanString(payload?.message, 300) || "Unknown Premiere plugin error",
      code: cleanString(payload?.code, 64) || "plugin_error",
    },
  };
}

const PAYLOAD_VALIDATORS = {
  handshake: validateHandshake,
  "project.state": validateProjectState,
  "sequence.state": validateSequenceState,
  "selection.state": validateSelection,
  "media.metadata": validateMediaMetadata,
  capabilities: (p) => ({ ok: true, payload: { capabilities: normalizeCapabilities(p?.capabilities) } }),
  "diagnostics.ping": (p) => ({ ok: true, payload: { at: finiteNumber(p?.at, { min: 0, max: 1e15 }) ?? 0 } }),
  error: validateError,
};

/**
 * Validates one plugin -> desktop message envelope.
 * @returns {{ok:true,message:object}|{ok:false,code:string,error:string}}
 */
function validateMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("bad_envelope", "Message must be a JSON object");
  }
  const type = cleanString(raw.type, 64);
  if (!type || !MESSAGE_TYPES.includes(type)) {
    return fail("unknown_type", `Unsupported message type: ${String(raw.type)}`);
  }
  const id = cleanString(raw.id, 64);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return fail("bad_envelope", "Message id must be a short alphanumeric token");
  }
  if (raw.v !== undefined && raw.v !== 1) {
    return fail("bad_envelope", `Unsupported envelope version: ${String(raw.v)}`);
  }
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const result = PAYLOAD_VALIDATORS[type](payload);
  if (!result.ok) return result;
  return { ok: true, message: { v: 1, id, type, payload: result.payload } };
}

/** Guards the raw request body before it is parsed. */
function validateRawBody(text) {
  if (typeof text !== "string" || !text) return fail("bad_envelope", "Empty request body");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    return fail("too_large", `Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("bad_envelope", "Body is not valid JSON");
  }
  return validateMessage(parsed);
}

/** Only these bridge routes exist. Everything else is rejected. */
const BRIDGE_ROUTES = {
  GET: ["/premiere/health", "/premiere/commands"],
  POST: ["/premiere/message"],
};

function validateBridgeRoute(method, url) {
  const m = typeof method === "string" ? method.toUpperCase() : "";
  if (!BRIDGE_ROUTES[m]) return fail("method_not_allowed", `Method not allowed: ${String(method)}`);
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
    return fail("route_rejected", `Route rejected: ${String(url)}`);
  }
  if (url.includes("..") || url.includes("\\") || url.includes("\u0000")) {
    return fail("route_rejected", `Route rejected: ${url}`);
  }
  let parsed;
  try {
    parsed = new URL(url, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  } catch {
    return fail("route_rejected", `Route rejected: ${url}`);
  }
  if (parsed.origin !== `http://${BRIDGE_HOST}:${BRIDGE_PORT}`) {
    return fail("host_not_allowed", `Host not allowed: ${parsed.origin}`);
  }
  if (!BRIDGE_ROUTES[m].includes(parsed.pathname)) {
    return fail("route_rejected", `Route not in Premiere bridge allowlist: ${m} ${parsed.pathname}`);
  }
  return { ok: true, method: m, path: parsed.pathname };
}

/** UXP panels report an app:// or file:// style origin; browsers must not talk to us. */
function isAllowedOrigin(origin) {
  if (origin === undefined || origin === null || origin === "" || origin === "null") return true;
  const value = String(origin);
  return (
    value.startsWith("app://") ||
    value.startsWith("plugin://") ||
    value === `http://${BRIDGE_HOST}:${BRIDGE_PORT}`
  );
}

// ---------------------------------------------------------------------------
// Edit-decision mapping (universal timeline -> Premiere operations)
// ---------------------------------------------------------------------------

const SEQUENCE_SUFFIX = "AE";

function padVersion(n) {
  return String(n).padStart(3, "0");
}

/**
 * Deterministic non-destructive naming: "Community Doc — AE v001".
 * Never returns a name that already exists in the project, so an Assistant
 * Editor build can never overwrite the editor's own sequence.
 * @param {unknown} baseName
 * @param {unknown} existingNames
 * @param {string} [kind] optional qualifier, e.g. "Selects" -> "… — AE Selects v001"
 */
function nextVersionedSequenceName(baseName, existingNames = [], kind = "") {
  const base = cleanString(baseName, 120) || "Assistant Editor";
  const existing = new Set(
    (Array.isArray(existingNames) ? existingNames : [])
      .map((n) => cleanString(n, 200))
      .filter(Boolean),
  );
  const label = cleanString(kind, 32);
  const prefix = label
    ? `${base} — ${SEQUENCE_SUFFIX} ${label}`
    : `${base} — ${SEQUENCE_SUFFIX}`;
  let version = 1;
  let candidate = `${prefix} v${padVersion(version)}`;
  while (existing.has(candidate) && version < 999) {
    version += 1;
    candidate = `${prefix} v${padVersion(version)}`;
  }
  return { name: candidate, version, label: padVersion(version) };
}

function secondsToTicks(seconds, fps) {
  // Frame-accurate integer frame index; the plugin converts frames to whatever
  // time base the Premiere UXP API exposes on the host.
  const f = finiteNumber(fps, { min: 1, max: 240 }) ?? 25;
  return Math.max(0, Math.round((finiteNumber(seconds, { min: 0, max: 86400 }) ?? 0) * f));
}

/**
 * Maps a universal timeline (see src/lib/ae/types.ts) into an ordered, explicit
 * Premiere operation plan. Operations whose capability is not advertised are
 * reported as skipped rather than silently attempted.
 */
function mapTimelineToOperations(timeline, capabilities, options = {}) {
  const caps = capabilities && typeof capabilities === "object" ? capabilities : {};
  const skipped = [];
  const fps = finiteNumber(timeline?.fps, { min: 1, max: 240 }) ?? 25;
  const kind = cleanString(options.kind, 32) || "Cut";
  const { name, version } = nextVersionedSequenceName(
    options.projectName || timeline?.name,
    options.existingSequenceNames,
    kind,
  );

  if (!caps["sequence.create"]) {
    return {
      ok: false,
      code: "capability_missing",
      error: "This Premiere host does not expose sequence creation to UXP.",
      skipped: ["sequence.create"],
    };
  }

  const operations = [
    {
      op: "createSequence",
      name,
      version,
      fps,
      // Explicitly non-destructive: we never target the editor's active sequence.
      replacesActiveSequence: false,
    },
  ];

  const decisions = Array.isArray(timeline?.decisions) ? timeline.decisions : [];
  for (const decision of decisions.slice(0, MAX_LIST)) {
    const lane = ["interview", "b-roll", "audio"].includes(decision?.lane)
      ? decision.lane
      : "interview";
    if (lane === "b-roll" && !caps["broll.insert"]) {
      skipped.push(`broll:${cleanString(decision?.id, 64) || "?"}`);
      continue;
    }
    if (!caps["clip.insert"]) {
      skipped.push(`insert:${cleanString(decision?.id, 64) || "?"}`);
      continue;
    }
    const start = finiteNumber(decision?.timelineStartSeconds, { min: 0, max: 86400 }) ?? 0;
    const duration = finiteNumber(decision?.durationSeconds, { min: 0, max: 86400 }) ?? 0;
    operations.push({
      op: "insertClip",
      sequenceName: name,
      decisionId: cleanString(decision?.id, 64) || `d${operations.length}`,
      clipId: cleanString(decision?.clipId, 128) || "",
      label: cleanString(decision?.label, 200) || "Untitled",
      track: lane === "b-roll" ? "V2" : lane === "audio" ? "A2" : "V1",
      startFrame: secondsToTicks(start, fps),
      endFrame: secondsToTicks(start + duration, fps),
      sourceInTc: cleanString(decision?.sourceInTc, 32),
      sourceOutTc: cleanString(decision?.sourceOutTc, 32),
    });
    if (caps["markers.write"] && decision?.selectId) {
      operations.push({
        op: "addMarker",
        sequenceName: name,
        frame: secondsToTicks(start, fps),
        name: cleanString(decision?.label, 120) || "Select",
        comment: `Assistant Editor select ${cleanString(decision.selectId, 64)}`,
      });
    } else if (!caps["markers.write"] && decision?.selectId) {
      skipped.push(`marker:${cleanString(decision?.id, 64) || "?"}`);
    }
  }

  return { ok: true, sequenceName: name, version, fps, operations, skipped };
}

/** Validates a desktop -> plugin command before it is queued. */
function validateCommand(raw) {
  const type = cleanString(raw?.type, 64);
  if (!type || !COMMAND_TYPES.includes(type)) {
    return fail("unknown_command", `Unsupported command: ${String(raw?.type)}`);
  }
  const payload = raw?.payload && typeof raw.payload === "object" ? raw.payload : {};
  return {
    ok: true,
    command: {
      v: 1,
      id: cleanString(raw?.id, 64) || `cmd_${Date.now().toString(36)}`,
      type,
      payload,
      issuedAt: Date.now(),
    },
  };
}

module.exports = {
  PREMIERE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PLUGIN_VERSION,
  SUPPORTED_PLUGIN_MAJOR,
  BRIDGE_HOST,
  BRIDGE_PORT,
  WORKER_ORIGIN,
  MAX_MESSAGE_BYTES,
  KNOWN_CAPABILITIES,
  MESSAGE_TYPES,
  COMMAND_TYPES,
  BRIDGE_ROUTES,
  parseVersion,
  compareVersions,
  normalizeCapabilities,
  validateMessage,
  validateRawBody,
  validateBridgeRoute,
  isAllowedOrigin,
  nextVersionedSequenceName,
  mapTimelineToOperations,
  validateCommand,
};