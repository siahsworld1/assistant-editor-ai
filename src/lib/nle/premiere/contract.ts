// Typed mirror of the Premiere <-> Assistant Editor message contract.
// The runtime validator lives in electron/premiere-protocol.cjs (dependency-free
// CommonJS so Electron main, the bridge server and vitest can all use it).
// These types are what the renderer and adapter code compile against.

export const PREMIERE_PROTOCOL_VERSION = "1.0.0";
export const PREMIERE_INTEGRATION_VERSION = "0.4.0";
export const PREMIERE_BRIDGE_ENDPOINT = "http://127.0.0.1:32146";

export const PREMIERE_CAPABILITY_KEYS = [
  "project.read",
  "sequence.read",
  "selection.read",
  "media.metadata",
  "sequence.create",
  "clip.insert",
  "broll.insert",
  "markers.write",
  "labels.write",
] as const;

export type PremiereCapabilityKey = (typeof PREMIERE_CAPABILITY_KEYS)[number];
export type PremiereCapabilities = Record<PremiereCapabilityKey, boolean>;

export type PremiereMessageType =
  | "handshake"
  | "project.state"
  | "sequence.state"
  | "selection.state"
  | "media.metadata"
  | "capabilities"
  | "diagnostics.ping"
  | "error";

export type PremiereCommandType =
  | "analyze"
  | "build.selects"
  | "build.story"
  | "apply.latest"
  | "open.assistant";

export interface PremiereEnvelope<T = unknown> {
  v: 1;
  id: string;
  type: PremiereMessageType;
  payload: T;
}

export interface PremiereHandshakePayload {
  protocolVersion: string;
  pluginVersion: string;
  host: string;
  hostVersion: string | null;
  capabilities: PremiereCapabilities;
}

export interface PremiereProjectMeta {
  id: string;
  name: string;
  path: string | null;
  itemCount: number;
}

export interface PremiereSequenceMeta {
  id: string;
  name: string;
  fps: number;
  durationSeconds: number;
  videoTracks: number;
  audioTracks: number;
}

export interface PremiereClipMeta {
  id: string;
  name: string;
  mediaPath: string | null;
  durationSeconds: number;
  inSeconds: number | null;
  outSeconds: number | null;
  fps: number | null;
  role: "interview" | "b-roll" | "ambient";
}

/** Ordered, explicit plan handed back to the panel. Never destructive. */
export type PremiereOperation =
  | {
      op: "createSequence";
      name: string;
      version: number;
      fps: number;
      replacesActiveSequence: false;
    }
  | {
      op: "insertClip";
      sequenceName: string;
      decisionId: string;
      clipId: string;
      label: string;
      track: "V1" | "V2" | "A2";
      startFrame: number;
      endFrame: number;
      sourceInTc: string | null;
      sourceOutTc: string | null;
    }
  | { op: "addMarker"; sequenceName: string; frame: number; name: string; comment: string };

export interface PremiereOperationPlan {
  ok: true;
  sequenceName: string;
  version: number;
  fps: number;
  operations: PremiereOperation[];
  /** Decisions dropped because the host did not advertise the capability. */
  skipped: string[];
}

export interface PremiereOperationPlanError {
  ok: false;
  code: string;
  error: string;
  skipped: string[];
}

export interface PremiereBridgeStatus {
  listening: boolean;
  endpoint: string;
  protocolVersion: string;
  minPluginVersion: string;
  connected: boolean;
  stale: boolean;
  pluginVersion: string | null;
  host: string | null;
  hostVersion: string | null;
  capabilities: Partial<PremiereCapabilities>;
  project: PremiereProjectMeta | null;
  sequence: PremiereSequenceMeta | null;
  selectionCount: number;
  lastMessageAt: number | null;
  lastError: string | null;
  messagesReceived: number;
  rejected: number;
  queued: number;
}

export interface PremiereRendererApi {
  available: true;
  integrationVersion: string;
  status(): Promise<{ ok: boolean; error?: string; status?: PremiereBridgeStatus }>;
  sendCommand(
    type: PremiereCommandType,
    payload?: unknown,
  ): Promise<{ ok: boolean; error?: string; status?: PremiereBridgeStatus }>;
}