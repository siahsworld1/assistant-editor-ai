// The editor workspace: a project's cut versions plus, for every manually
// edited working version, its schema-2 Sequence and transaction history.
//
// - Director versions are immutable. Their Sequence is imported from the
//   schema-1 timeline on demand (deterministically — same ids every time).
// - The first manual transaction against a Director version FORKS it: a new
//   working version ("v1.2 · edited") is created with the imported Sequence as
//   its base, and the transaction is committed to the working version's
//   history. Further transactions on that working version continue its
//   history. A transaction against a Director version that already has an
//   edited child forks a NEW sibling ("· edited 2"): the gesture was made
//   against the untouched Director cut, so it must not be replayed onto a
//   different (edited) sequence, and existing history is never disturbed.
// - A working version's schema-1 `timeline` is DERIVED from its Sequence
//   (legacy adapter) for the consumers that still read schema 1 — CUT
//   rendering, playback and the exporters. It is never edited and never
//   persisted; the Sequence is the only source of truth.
//
// Persistence (schema 2) stores each working version's history compactly — the
// oldest retained base sequence, the present sequence and the transaction log
// — and rebuilds the undo/redo snapshots by deterministic replay on load.
// Command ids (and every id they create) are recorded in the log, so nothing
// is regenerated; the replayed present must equal the saved present exactly.
// Anything the immutable parent Director version reproduces deterministically
// is stored as a reference to it, not duplicated: the base, while it is still
// the parent's imported Sequence, and each item's read-only legacy provenance
// (and the sequence's), while unchanged from the parent's. References are
// expanded on load from the parent version saved in the same file.
import type { Clip, EditVersion, UniversalTimeline } from "@/lib/ae/types";
import type { TimelineError } from "./commands";
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  HISTORY_CAP,
  nextRedo,
  nextUndo,
  redo,
  undo,
  type History,
  type HistoryEntry,
} from "./history";
import { stableId, type IdGenerator } from "./ids";
import type { MediaInventory } from "./invariants";
import { legacyToSequence, sequenceToLegacy } from "./legacy-adapter";
import { applyTransaction } from "./transactions";
import type { ClipItem, Sequence, Transaction } from "./types";

export interface Workspace {
  versions: EditVersion[];
  /** Working version id → its history (present = the editable Sequence). */
  histories: Record<string, History>;
}

type ClipRates = ReadonlyArray<Pick<Clip, "id" | "fps">>;

export function workspaceFromVersions(versions: EditVersion[]): Workspace {
  return { versions, histories: {} };
}

/* ------------------------------ reading state ----------------------------- */

const importCache = new WeakMap<EditVersion, Map<string, Sequence>>();

/** A Director version's Sequence, imported deterministically (cached per
 * version object and clip-rate signature, so the same object is returned for
 * as long as neither changes). */
export function importedSequence(version: EditVersion, clips: ClipRates): Sequence {
  const signature = clips.map((c) => `${c.id}@${c.fps}`).join("|");
  let byClips = importCache.get(version);
  if (!byClips) importCache.set(version, (byClips = new Map()));
  let seq = byClips.get(signature);
  if (!seq) {
    seq = legacyToSequence(version.timeline, clips, { scope: version.id, origin: "director" });
    byClips.set(signature, seq);
  }
  return seq;
}

/** The canonical Sequence a version shows: its working Sequence if it is an
 * edited version, otherwise its imported Director Sequence. */
export function sequenceOf(ws: Workspace, versionId: string, clips: ClipRates): Sequence | null {
  const history = ws.histories[versionId];
  if (history) return history.present;
  const version = ws.versions.find((v) => v.id === versionId);
  return version ? importedSequence(version, clips) : null;
}

export interface EditorStatus {
  edited: boolean;
  canUndo: boolean;
  canRedo: boolean;
  nextUndoLabel: string | null;
  nextRedoLabel: string | null;
}

export function editorStatus(ws: Workspace, versionId: string): EditorStatus {
  const h = ws.histories[versionId];
  return {
    edited: !!h,
    canUndo: !!h && canUndo(h),
    canRedo: !!h && canRedo(h),
    nextUndoLabel: h ? (nextUndo(h)?.label ?? null) : null,
    nextRedoLabel: h ? (nextRedo(h)?.label ?? null) : null,
  };
}

/* -------------------------------- changing it ------------------------------ */

/** The schema-1 view of a Sequence, for the consumers that still read it. */
export function derivedTimeline(seq: Sequence): UniversalTimeline {
  return sequenceToLegacy(seq).timeline;
}

function refreshed(version: EditVersion, history: History): EditVersion {
  return {
    ...version,
    timeline: derivedTimeline(history.present),
    changes: history.past.map((e) => e.transaction.label),
  };
}

function withHistory(ws: Workspace, versionId: string, history: History): Workspace {
  return {
    versions: ws.versions.map((v) => (v.id === versionId ? refreshed(v, history) : v)),
    histories: { ...ws.histories, [versionId]: history },
  };
}

export interface DispatchOptions {
  clips: ClipRates;
  media?: MediaInventory | undefined;
  /** Used only to name a new working version when the transaction forks one. */
  ids: IdGenerator;
  now?: string;
  /** How a fork made by this transaction describes itself (default: a manual
   * edit). An accepted Director proposal names its instruction here. */
  fork?: { command: string; summary: string } | undefined;
}

export type DispatchOutcome =
  | {
      ok: true;
      workspace: Workspace;
      /** The version now showing the edit (a new working version after a fork). */
      activeVersionId: string;
      forkedFrom: string | null;
      entry: HistoryEntry;
    }
  | { ok: false; error: TimelineError };

/** Commits one transaction to the active version — forking a working version
 * first if the active version is an (immutable) Director version. A rejected
 * transaction changes nothing and creates no fork. */
export function dispatchTransaction(
  ws: Workspace,
  activeVersionId: string,
  txn: Transaction,
  options: DispatchOptions,
): DispatchOutcome {
  const existing = ws.histories[activeVersionId];
  if (existing) {
    const c = commit(existing, txn, { media: options.media });
    if (!c.ok) return { ok: false, error: c.error };
    return {
      ok: true,
      workspace: withHistory(ws, activeVersionId, c.history),
      activeVersionId,
      forkedFrom: null,
      entry: c.entry,
    };
  }
  const parent = ws.versions.find((v) => v.id === activeVersionId);
  if (!parent)
    return {
      ok: false,
      error: { code: "invalid-params", message: `No version ${activeVersionId}.` },
    };
  const c = commit(createHistory(importedSequence(parent, options.clips)), txn, {
    media: options.media,
  });
  if (!c.ok) return { ok: false, error: c.error };

  const siblings = ws.versions.filter(
    (v) => v.kind === "edited" && v.parentId === parent.id,
  ).length;
  const suffix = siblings ? ` · edited ${siblings + 1}` : " · edited";
  const id = options.ids.next("version");
  const forked = refreshed(
    {
      id,
      label: `${parent.label}${suffix}`,
      version: `${parent.version}${suffix}`,
      command: options.fork?.command ?? "Manual edit",
      summary: options.fork?.summary ?? `Manual edits to ${parent.version}.`,
      createdAt:
        options.now ?? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      changes: [],
      timeline: parent.timeline,
      parentId: parent.id,
      kind: "edited",
    },
    c.history,
  );
  return {
    ok: true,
    workspace: {
      versions: [...ws.versions, forked],
      histories: { ...ws.histories, [id]: c.history },
    },
    activeVersionId: id,
    forkedFrom: parent.id,
    entry: c.entry,
  };
}

export function undoIn(ws: Workspace, versionId: string): Workspace {
  const h = ws.histories[versionId];
  return h && canUndo(h) ? withHistory(ws, versionId, undo(h)) : ws;
}

export function redoIn(ws: Workspace, versionId: string): Workspace {
  const h = ws.histories[versionId];
  return h && canRedo(h) ? withHistory(ws, versionId, redo(h)) : ws;
}

/* -------------------------------- persistence ------------------------------ */

export const EDIT_STATE_V2_SCHEMA = 2 as const;

/** Stands for "exactly what the parent Director version imports to". */
export const FROM_PARENT = "parent" as const;

/** An item as stored: the parent's item outright when it is unchanged from
 * the parent's import (same id), else the item with its legacy provenance by
 * reference when only that is unchanged (it is read-only, so it usually is). */
export type PersistedItem =
  | (Omit<ClipItem, "legacy"> & { legacy?: ClipItem["legacy"] | typeof FROM_PARENT })
  | typeof FROM_PARENT;

/** A Sequence as stored, with references to the parent version's import. */
export type PersistedSequence = Omit<Sequence, "items" | "legacy"> & {
  items: Record<string, PersistedItem>;
  legacy?: Sequence["legacy"] | typeof FROM_PARENT;
};

/** A working version's history, as stored: replayable, ids included. */
export interface PersistedHistory {
  /** The sequence before the oldest retained transaction — `FROM_PARENT` when
   * that is still the parent Director version's imported Sequence. */
  base: PersistedSequence | typeof FROM_PARENT;
  /** The current sequence — checked against the replayed result on load. */
  present: PersistedSequence;
  /** Committed transactions, oldest first (the undo stack). */
  past: Transaction[];
  /** Undone transactions, next-to-redo first (the redo stack). */
  future: Transaction[];
  cap: number;
  /** Content digest of the parent import the references were written
   * against; references are resolved only against an identical import. */
  parentDigest?: string | undefined;
  /** 1 once items carry durable edit ownership (`ClipItem.editedBy`). A
   * history saved before that has none: it is replayed with ownership
   * derived, and checked against the saved present ignoring ownership. */
  provenance?: 1 | undefined;
}

/** A version as stored: an edited version's derived `timeline` is omitted. */
export type PersistedVersion = Omit<EditVersion, "timeline"> & {
  timeline?: UniversalTimeline | undefined;
};

export interface SavedEditStateV2 {
  schema: typeof EDIT_STATE_V2_SCHEMA;
  analysisId: string;
  versions: PersistedVersion[];
  histories: Record<string, PersistedHistory>;
  activeVersionId: string;
  chosenStoryId: string | null;
  targetSeconds: number;
  storyboardSelectIds: string[];
  savedAt: string;
}

export interface EditorSelections {
  activeVersionId: string;
  chosenStoryId: string | null;
  targetSeconds: number;
  storyboardSelectIds: string[];
}

/** `seq` with everything that equals the parent's import replaced by a
 * reference: unchanged items, else unchanged item provenance, and the
 * sequence's own provenance. */
function compactSequence(seq: Sequence, parent: Sequence | null): PersistedSequence {
  if (!parent) return seq;
  const items: PersistedSequence["items"] = {};
  for (const [id, item] of Object.entries(seq.items)) {
    const from = parent.items[id];
    if (from && deepEqual(item, from)) items[id] = FROM_PARENT;
    else if (item.legacy && from?.legacy && deepEqual(item.legacy, from.legacy))
      items[id] = { ...item, legacy: FROM_PARENT };
    else items[id] = item;
  }
  const out: PersistedSequence = { ...seq, items };
  if (seq.legacy && parent.legacy && deepEqual(seq.legacy, parent.legacy)) out.legacy = FROM_PARENT;
  return out;
}

/** Inverse of `compactSequence`: references become copies of the parent's
 * import. null when a reference cannot be resolved. */
function expandSequence(p: PersistedSequence, parent: Sequence | null): Sequence | null {
  const items: Record<string, ClipItem> = {};
  for (const [id, item] of Object.entries(p.items)) {
    const from = parent?.items[id];
    if (item === FROM_PARENT) {
      if (!from) return null;
      items[id] = structuredClone(from);
    } else if (item.legacy === FROM_PARENT) {
      if (!from?.legacy) return null;
      items[id] = { ...item, legacy: structuredClone(from.legacy) };
    } else {
      items[id] = item as ClipItem;
    }
  }
  if (p.legacy === FROM_PARENT) {
    if (!parent?.legacy) return null;
    return { ...p, items, legacy: structuredClone(parent.legacy) };
  }
  return { ...p, items } as Sequence;
}

const digestCache = new WeakMap<Sequence, string>();

/** A content digest of a parent import (cached: imports are cached objects). */
function digestOf(seq: Sequence): string {
  let d = digestCache.get(seq);
  if (!d) digestCache.set(seq, (d = stableId("sequence", "parent-import", JSON.stringify(seq))));
  return d;
}

/** `parent`: the parent Director version's imported Sequence, when known —
 * whatever equals it is stored by reference. */
export function serializeHistory(h: History, parent: Sequence | null = null): PersistedHistory {
  const base = h.past[0]?.before ?? h.present;
  return {
    base: parent && deepEqual(base, parent) ? FROM_PARENT : compactSequence(base, parent),
    present: compactSequence(h.present, parent),
    past: h.past.map((e) => e.transaction),
    future: h.future.map((e) => e.transaction),
    cap: h.cap,
    ...(parent ? { parentDigest: digestOf(parent) } : {}),
    provenance: 1,
  };
}

/** The parent Director version a working version was forked from, if present. */
function parentOf(versions: readonly EditVersion[], v: EditVersion | undefined) {
  const parent = v?.parentId ? versions.find((p) => p.id === v.parentId) : undefined;
  return parent && parent.kind !== "edited" ? parent : undefined;
}

/** `clips`: the project's clips (their rates) — needed to reproduce a parent
 * Director version's import, and so to store references to it. Without them
 * everything is stored in full. */
export function serializeWorkspace(
  ws: Workspace,
  selections: EditorSelections,
  analysisId: string,
  savedAt: string = new Date().toISOString(),
  clips: ClipRates | null = null,
): SavedEditStateV2 {
  return {
    schema: EDIT_STATE_V2_SCHEMA,
    analysisId,
    versions: ws.versions.map((v) => {
      if (!ws.histories[v.id]) return v;
      const { timeline: _derived, ...rest } = v;
      return rest;
    }),
    histories: Object.fromEntries(
      Object.entries(ws.histories).map(([id, h]) => {
        const parent = parentOf(
          ws.versions,
          ws.versions.find((v) => v.id === id),
        );
        return [id, serializeHistory(h, parent && clips ? importedSequence(parent, clips) : null)];
      }),
    ),
    ...selections,
    savedAt,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSequence(v: unknown): v is PersistedSequence {
  return (
    isRecord(v) &&
    v["schema"] === 2 &&
    typeof v["id"] === "string" &&
    isRecord(v["rate"]) &&
    Array.isArray(v["tracks"]) &&
    isRecord(v["items"]) &&
    isRecord(v["links"])
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter(
    (k) => (a as Record<string, unknown>)[k] !== undefined,
  );
  const kb = Object.keys(b as object).filter(
    (k) => (b as Record<string, unknown>)[k] !== undefined,
  );
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Rebuilds a history by replaying its log. If the log no longer reproduces
 * the saved present exactly, the present is kept and the history dropped
 * (`lost`) — an edit is never lost to a damaged undo log. `parent` resolves
 * references to the parent Director version's import (see FROM_PARENT); null
 * when it cannot be reproduced, and then a history that needs it is unreadable. */
export function restoreHistory(
  p: unknown,
  parent: Sequence | null = null,
): { history: History; lost: boolean } | null {
  if (!isRecord(p) || !isSequence(p["present"])) return null;
  // References resolve only against the very import they were written against.
  if (parent && p["parentDigest"] !== digestOf(parent)) parent = null;
  const present = expandSequence(p["present"], parent);
  if (!present) return null;
  const cap = typeof p["cap"] === "number" && p["cap"] >= 1 ? Math.floor(p["cap"]) : HISTORY_CAP;
  const presentOnly = { history: createHistory(present, cap), lost: true };
  const base =
    p["base"] === FROM_PARENT
      ? parent
      : isSequence(p["base"])
        ? expandSequence(p["base"], parent)
        : null;
  if (!base || !Array.isArray(p["past"]) || !Array.isArray(p["future"])) return presentOnly;
  let h = createHistory(base, cap);
  for (const txn of p["past"] as Transaction[]) {
    const c = commit(h, txn);
    if (!c.ok) return presentOnly;
    h = c.history;
  }
  // A history saved before durable ownership replays WITH ownership; the saved
  // present has none, so only ownership may differ. The replay wins: it is the
  // same edit, now with its ownership recorded (anything older than the
  // retained history stays unknown — see proposals.ts).
  const matches =
    p["provenance"] === 1
      ? deepEqual(h.present, present)
      : deepEqual(withoutOwnership(h.present), withoutOwnership(present));
  if (!matches) return presentOnly;
  const future: HistoryEntry[] = [];
  let cur = h.present;
  for (const txn of p["future"] as Transaction[]) {
    const out = applyTransaction(cur, txn);
    if (!out.ok) break; // keep what replays; drop the rest of the redo stack
    future.push({
      transaction: txn,
      before: cur,
      after: out.sequence,
      changedIds: out.changedIds,
      notes: out.notes,
    });
    cur = out.sequence;
  }
  return { history: { ...h, future }, lost: future.length !== (p["future"] as unknown[]).length };
}

/** `seq` without durable ownership, for comparing with pre-ownership saves. */
function withoutOwnership(seq: Sequence): Sequence {
  const items: Record<string, ClipItem> = {};
  for (const [id, item] of Object.entries(seq.items)) {
    const { editedBy: _owner, ...rest } = item;
    items[id] = rest;
  }
  return { ...seq, items };
}

export interface RestoredEditState extends EditorSelections {
  workspace: Workspace;
  /** Human-readable notes about anything that could not be restored. */
  warnings: string[];
}

/** Parses a schema-2 file. null when it is not a well-formed schema-2 state
 * for `analysisId` (callers then fall back to schema 1). Damaged parts are
 * dropped individually and reported in `warnings`. `clips` (the project's
 * clips) reproduce parent Director imports for histories stored by reference. */
export function parseSavedEditStateV2(
  raw: unknown,
  analysisId: string | null | undefined,
  clips: ClipRates | null = null,
): RestoredEditState | null {
  if (!analysisId || !isRecord(raw)) return null;
  if (raw["schema"] !== EDIT_STATE_V2_SCHEMA || raw["analysisId"] !== analysisId) return null;
  if (!Array.isArray(raw["versions"])) return null;
  const savedHistories = isRecord(raw["histories"]) ? raw["histories"] : {};
  const warnings: string[] = [];
  const histories: Record<string, History> = {};
  const versions: EditVersion[] = [];
  // The (immutable, fully stored) Director versions working versions refer to.
  const directors = (raw["versions"] as unknown[]).filter(
    (v): v is EditVersion =>
      isRecord(v) &&
      typeof v["id"] === "string" &&
      v["kind"] !== "edited" &&
      isRecord(v["timeline"]) &&
      Array.isArray(v["timeline"]["decisions"]),
  );

  for (const v of raw["versions"] as unknown[]) {
    if (!isRecord(v) || typeof v["id"] !== "string") {
      warnings.push("Skipped an unreadable version.");
      continue;
    }
    const id = v["id"];
    if (v["kind"] === "edited") {
      const parentVersion = parentOf(directors, v as unknown as EditVersion);
      const parent = parentVersion && clips ? importedSequence(parentVersion, clips) : null;
      const restored = restoreHistory(savedHistories[id], parent);
      if (!restored) {
        warnings.push(`Edited version ${String(v["version"] ?? id)} could not be restored.`);
        continue;
      }
      if (restored.lost)
        warnings.push(
          `Undo history for ${String(v["version"] ?? id)} could not be fully restored.`,
        );
      histories[id] = restored.history;
      versions.push(
        refreshed(
          { ...(v as unknown as EditVersion), timeline: derivedTimeline(restored.history.present) },
          restored.history,
        ),
      );
    } else {
      const tl = v["timeline"];
      if (!isRecord(tl) || !Array.isArray(tl["decisions"])) {
        warnings.push(`Version ${String(v["version"] ?? id)} has no readable timeline.`);
        continue;
      }
      versions.push(v as unknown as EditVersion);
    }
  }
  if (versions.length === 0) return null;
  const active = typeof raw["activeVersionId"] === "string" ? raw["activeVersionId"] : "";
  const target = Number(raw["targetSeconds"]);
  return {
    workspace: { versions, histories },
    activeVersionId: versions.some((v) => v.id === active)
      ? active
      : versions[versions.length - 1]!.id,
    chosenStoryId: typeof raw["chosenStoryId"] === "string" ? raw["chosenStoryId"] : null,
    targetSeconds: Number.isFinite(target) && target >= 5 && target <= 36000 ? target : 360,
    storyboardSelectIds: Array.isArray(raw["storyboardSelectIds"])
      ? (raw["storyboardSelectIds"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    warnings,
  };
}
