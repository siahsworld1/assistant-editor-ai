import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const protocol = require("../electron/premiere-protocol.cjs");

const {
  PREMIERE_PROTOCOL_VERSION,
  validateMessage,
  validateRawBody,
  validateBridgeRoute,
  isAllowedOrigin,
  validateCommand,
  normalizeCapabilities,
  nextVersionedSequenceName,
  mapTimelineToOperations,
  compareVersions,
} = protocol;

const caps = {
  "project.read": true,
  "sequence.read": true,
  "selection.read": true,
  "media.metadata": true,
  "sequence.create": true,
  "clip.insert": true,
  "broll.insert": true,
  "markers.write": true,
  "labels.write": false,
};

const handshake = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: "m1",
  type: "handshake",
  payload: {
    protocolVersion: PREMIERE_PROTOCOL_VERSION,
    pluginVersion: "0.4.0",
    host: "premierepro",
    hostVersion: "25.1.0",
    capabilities: caps,
    ...over,
  },
});

describe("premiere message validation", () => {
  it("accepts a well-formed handshake", () => {
    const res = validateMessage(handshake());
    expect(res.ok).toBe(true);
    expect(res.message.payload.pluginVersion).toBe("0.4.0");
    expect(res.message.payload.capabilities["sequence.create"]).toBe(true);
  });

  it("rejects unknown message types", () => {
    const res = validateMessage({ v: 1, id: "m1", type: "exec.shell", payload: {} });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_type");
  });

  it("rejects malformed envelopes and ids", () => {
    expect(validateMessage(null as unknown as object).ok).toBe(false);
    expect(validateMessage({ id: "../../etc/passwd", type: "diagnostics.ping" }).ok).toBe(false);
    expect(validateMessage({ v: 2, id: "m1", type: "diagnostics.ping" }).ok).toBe(false);
  });

  it("rejects non-JSON and oversized bodies", () => {
    expect(validateRawBody("").ok).toBe(false);
    expect(validateRawBody("{nope").code).toBe("bad_envelope");
    const huge = JSON.stringify({ v: 1, id: "m1", type: "diagnostics.ping", payload: { x: "a".repeat(70000) } });
    expect(validateRawBody(huge).code).toBe("too_large");
  });
});

describe("handshake / version compatibility", () => {
  it("rejects a plugin older than the minimum", () => {
    const res = validateMessage(handshake({ pluginVersion: "0.3.0" }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("incompatible_version");
  });

  it("rejects a breaking plugin major", () => {
    expect(validateMessage(handshake({ pluginVersion: "1.0.0" })).code).toBe("incompatible_version");
  });

  it("rejects a mismatched protocol major", () => {
    expect(validateMessage(handshake({ protocolVersion: "2.0.0" })).code).toBe("incompatible_version");
  });

  it("rejects missing/garbage versions", () => {
    expect(validateMessage(handshake({ pluginVersion: "banana" })).ok).toBe(false);
    expect(validateMessage(handshake({ protocolVersion: undefined })).ok).toBe(false);
  });

  it("accepts a newer compatible patch build", () => {
    expect(validateMessage(handshake({ pluginVersion: "0.4.9" })).ok).toBe(true);
    expect(compareVersions("0.4.9", "0.4.0")).toBe(1);
  });
});

describe("capability flags", () => {
  it("normalizes array and object forms and drops unknown keys", () => {
    const fromArray = normalizeCapabilities(["project.read", "shell.exec"]);
    expect(fromArray["project.read"]).toBe(true);
    expect(fromArray["shell.exec"]).toBeUndefined();
    const fromObject = normalizeCapabilities({ "clip.insert": true, "fs.write": true });
    expect(fromObject["clip.insert"]).toBe(true);
    expect(fromObject["fs.write"]).toBeUndefined();
    expect(fromObject["markers.write"]).toBe(false);
  });

  it("defaults everything to false for junk input", () => {
    const flags = normalizeCapabilities("everything");
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });
});

describe("non-destructive sequence naming", () => {
  it("produces zero-padded v001 names", () => {
    expect(nextVersionedSequenceName("Community Doc", []).name).toBe("Community Doc — AE v001");
    expect(nextVersionedSequenceName("Community Doc", [], "Selects").name).toBe(
      "Community Doc — AE Selects v001",
    );
  });

  it("skips collisions", () => {
    const existing = ["Community Doc — AE v001", "Community Doc — AE v002"];
    const next = nextVersionedSequenceName("Community Doc", existing);
    expect(next.name).toBe("Community Doc — AE v003");
    expect(next.version).toBe(3);
  });

  it("never returns the editor's own sequence name", () => {
    const active = "Community Doc — AE v001";
    expect(nextVersionedSequenceName("Community Doc", [active]).name).not.toBe(active);
  });

  it("handles malformed input", () => {
    expect(nextVersionedSequenceName(null, null).name).toBe("Assistant Editor — AE v001");
    expect(nextVersionedSequenceName(42, [null, 7, undefined]).name).toBe("Assistant Editor — AE v001");
    expect(nextVersionedSequenceName("  ", ["x"]).name).toBe("Assistant Editor — AE v001");
    const long = nextVersionedSequenceName("x".repeat(500), []);
    expect(long.name.length).toBeLessThan(200);
  });
});

describe("edit-decision mapping", () => {
  const timeline = {
    name: "Community Doc",
    fps: 25,
    decisions: [
      { id: "d1", clipId: "c1", label: "Opening line", lane: "interview", timelineStartSeconds: 0, durationSeconds: 4, selectId: "s1" },
      { id: "d2", clipId: "c2", label: "Street cutaway", lane: "b-roll", timelineStartSeconds: 4, durationSeconds: 2 },
    ],
  };

  it("creates a new sequence and never replaces the active one", () => {
    const plan = mapTimelineToOperations(timeline, caps, { existingSequenceNames: ["Community Doc — AE Cut v001"] });
    expect(plan.ok).toBe(true);
    expect(plan.operations[0]).toMatchObject({ op: "createSequence", replacesActiveSequence: false });
    expect(plan.sequenceName).toBe("Community Doc — AE Cut v002");
  });

  it("maps lanes to tracks and seconds to frames", () => {
    const plan = mapTimelineToOperations(timeline, caps, {});
    const inserts = plan.operations.filter((o: { op: string }) => o.op === "insertClip");
    expect(inserts[0]).toMatchObject({ track: "V1", startFrame: 0, endFrame: 100 });
    expect(inserts[1]).toMatchObject({ track: "V2", startFrame: 100, endFrame: 150 });
  });

  it("skips operations whose capability is missing instead of attempting them", () => {
    const plan = mapTimelineToOperations(timeline, { ...caps, "broll.insert": false, "markers.write": false }, {});
    expect(plan.ok).toBe(true);
    expect(plan.skipped).toContain("broll:d2");
    expect(plan.skipped).toContain("marker:d1");
  });

  it("fails cleanly when sequence.create is unavailable", () => {
    const plan = mapTimelineToOperations(timeline, { ...caps, "sequence.create": false }, {});
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("capability_missing");
  });
});

describe("security rejections", () => {
  it("rejects arbitrary routes, hosts and traversal", () => {
    expect(validateBridgeRoute("GET", "/premiere/health").ok).toBe(true);
    expect(validateBridgeRoute("GET", "https://example.com/premiere/health").ok).toBe(false);
    expect(validateBridgeRoute("GET", "/etc/passwd").ok).toBe(false);
    expect(validateBridgeRoute("GET", "/premiere/../../etc/passwd").ok).toBe(false);
    expect(validateBridgeRoute("POST", "/premiere/health").ok).toBe(false);
    expect(validateBridgeRoute("DELETE", "/premiere/message").code).toBe("method_not_allowed");
    expect(validateBridgeRoute("GET", "//evil.test/premiere/health").ok).toBe(false);
  });

  it("only allows UXP-style origins", () => {
    expect(isAllowedOrigin("app://premierepro")).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("https://evil.test")).toBe(false);
    expect(isAllowedOrigin("http://localhost:8080")).toBe(false);
  });

  it("rejects unknown desktop -> plugin commands", () => {
    expect(validateCommand({ type: "analyze" }).ok).toBe(true);
    expect(validateCommand({ type: "rm -rf /" }).code).toBe("unknown_command");
    expect(validateCommand({}).ok).toBe(false);
  });
});