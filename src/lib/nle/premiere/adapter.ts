// PremiereAdapter — the ONLY place Premiere-specific host calls are allowed.
//
// Everything else in Assistant Editor stays NLE-agnostic and talks to this
// interface. Methods whose UXP API surface could not be verified in this build
// environment are declared here and implemented as explicit NotImplemented
// stubs with capability=false in premiere-uxp/src/adapter.js — never faked.

import type {
  PremiereCapabilities,
  PremiereClipMeta,
  PremiereOperation,
  PremiereProjectMeta,
  PremiereSequenceMeta,
} from "./contract";
import type { UniversalTimeline } from "@/lib/ae/types";

export class NotImplementedInHost extends Error {
  constructor(
    readonly capability: keyof PremiereCapabilities,
    message?: string,
  ) {
    super(
      message ??
        `Premiere host does not expose "${capability}" to UXP in this build. Requires validation inside a real Premiere UXP host.`,
    );
    this.name = "NotImplementedInHost";
  }
}

export interface PremiereIdentity {
  pluginVersion: string;
  protocolVersion: string;
  host: string;
  hostVersion: string | null;
}

export interface PremiereAdapter {
  /** Identity/version handshake. Always available — never capability-gated. */
  identify(): Promise<PremiereIdentity>;
  /** Advertised capability flags, resolved against the live host. */
  capabilities(): Promise<PremiereCapabilities>;

  getActiveProject(): Promise<PremiereProjectMeta | null>;
  getActiveSequence(): Promise<PremiereSequenceMeta | null>;
  getSelectedItems(): Promise<PremiereClipMeta[]>;
  /** Project media metadata where Premiere exposes it. */
  getProjectMedia(): Promise<PremiereClipMeta[]>;

  /** Existing sequence names, used for non-destructive version naming. */
  listSequenceNames(): Promise<string[]>;

  /**
   * Applies an already-validated, non-destructive operation plan.
   * Implementations MUST create a new sequence and MUST NOT modify the
   * editor's active sequence.
   */
  applyOperations(operations: PremiereOperation[]): Promise<PremiereApplyResult>;

  /** Optional: markers/labels. Throws NotImplementedInHost when unsupported. */
  addMarker(sequenceName: string, frame: number, name: string, comment: string): Promise<void>;
  setClipLabel(clipId: string, label: string): Promise<void>;
}

export interface PremiereApplyResult {
  ok: boolean;
  sequenceName?: string;
  applied: number;
  skipped: string[];
  error?: string;
}

/** Mirrors electron/premiere-protocol.cjs mapTimelineToOperations() typing. */
export interface TimelineMappingOptions {
  projectName?: string;
  existingSequenceNames?: string[];
  kind?: "Selects" | "Cut" | string;
}

export type TimelineMapper = (
  timeline: UniversalTimeline,
  capabilities: Partial<PremiereCapabilities>,
  options?: TimelineMappingOptions,
) => unknown;