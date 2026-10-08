// Director AI 2.0 — Phase 1: deterministic edit proposals.
//
// An EditProposal is a structured request to change ONE version's Sequence,
// written by the Director (eventually from a natural-language instruction; in
// Phase 1 only fixtures). It never touches timeline state itself:
//
//   parse (strict schema) → stale check (version + content revision)
//   → reference / protection / ownership checks → compile to EXISTING commands
//   → dry run (applyTransaction, pure) = the preview
//   → accept: one atomic "director" transaction through dispatchTransaction
//     (fork-on-edit, history, undo/redo, persistence are the workspace's)
//   → reject: nothing to undo, because nothing was ever written.
//
// Safety rules (fail closed):
//   - Only the operations listed below exist. Anything else — including a
//     request to rebuild the sequence — is refused, never approximated.
//   - A proposal cannot authorize itself: any authorization/override field is
//     a rejection.
//   - Locked and AI-locked material is never changed (checked here, and again
//     by the engine for a "director" transaction).
//   - Nothing a person edited may be changed by a proposal. Ownership is
//     derived from the version's transaction history; whenever it cannot be
//     established reliably (history trimmed by the cap, or lost on restore),
//     the item is treated as manual and the proposal is refused.
//   - Ownership is checked on everything the dry run ACTUALLY changed — so a
//     ripple that would shift someone's manual edit is refused too.
import type { Clip } from "@/lib/ae/types";
import { commands, type TimelineError } from "./commands";
import type { TypedCommand } from "./commands/types";
import type { History } from "./history";
import type { IdGenerator } from "./ids";
import { seededIds } from "./ids";
import type { MediaInventory } from "./invariants";
import { expandLinked, isLockedFrom } from "./selectors";
import { applyTransaction, makeTransaction } from "./transactions";
import type { ClipItem, Command, Sequence, Transaction } from "./types";
import {
  dispatchTransaction,
  importedSequence,
  sequenceOf,
  type DispatchOutcome,
  type Workspace,
} from "./workspace";

export const PROPOSAL_SCHEMA = "ae.proposal/1" as const;

/* ---------------------------------- schema --------------------------------- */

/** Evidence the Director cites for an operation — checked against the
 * project's analysis; an invented reference rejects the proposal. */
export type SourceRef =
  | { kind: "select"; id: string }
  | { kind: "transcript"; id: string }
  | { kind: "visual"; id: string };

/** The operations proposals support, each compiled 1:1 to an existing command. */
export type ProposalOp =
  /** MoveEdit: move items (linked partners follow) by whole sequence frames. */
  | { op: "move"; itemIds: string[]; deltaFrames: number }
  /** TrimEdit: move one edge of an item (linked partners follow) in source frames. */
  | { op: "trim"; itemId: string; edge: "in" | "out"; deltaSourceFrames: number }
  /** DeleteEdit (lift, gap stays) or RippleDelete (close the gap, conservative). */
  | { op: "remove"; itemIds: string[]; ripple: boolean }
  /** ReorderEdit: a back-to-back run on one track, listed in its NEW order
   * (linked audio follows; footage across a cut in the run refuses it). */
  | { op: "reorder"; itemIds: string[] };

export interface EditProposal {
  schema: typeof PROPOSAL_SCHEMA;
  id: string;
  /** What the director asked for (shown with the proposal and as the undo label). */
  instruction: string;
  /** What the proposal does, in the Director's words. */
  summary: string;
  /** The exact Sequence this was proposed against. */
  base: { versionId: string; revision: string };
  operations: ProposalOp[];
  rationale?: Array<{ opIndex: number; reason: string; evidence?: SourceRef[] }> | undefined;
}

export type ProposalIssueCode =
  | "malformed"
  | "unsupported-operation"
  | "self-authorization"
  | "stale"
  | "unknown-version"
  | "unknown-item"
  | "invalid-range"
  | "unverifiable-evidence"
  | "protected"
  | "manual-conflict"
  | "ownership-unknown"
  | "engine-rejected";

export interface ProposalIssue {
  code: ProposalIssueCode;
  /** Where in the proposal (e.g. "operations[1].itemIds[0]"), when relevant. */
  path?: string | undefined;
  message: string;
  itemIds?: string[] | undefined;
  /** For "engine-rejected": the timeline rule that refused it (e.g. "overlap",
   * "ripple-blocked"), so the reason can be explained plainly. */
  engineCode?: TimelineError["code"] | undefined;
}

export type Parsed = { ok: true; proposal: EditProposal } | { ok: false; issues: ProposalIssue[] };

/** Operations that exist in the editing model but not (yet) as proposals —
 * named so a request for one is refused explicitly, not misread. */
const KNOWN_UNSUPPORTED = new Set([
  "split",
  "insert",
  "overwrite",
  "replace",
  "replaceSource",
  "replaceAssembly",
  "rebuild",
  "slip",
  "slide",
  "roll",
  "rippleTrim",
  "link",
  "unlink",
  "setProtection",
  "lock",
  "unlock",
]);
/** Fields by which a proposal might try to authorize itself. Always refused. */
const AUTHORIZATION_KEYS = [
  "authorization",
  "authorize",
  "authorized",
  "override",
  "overrides",
  "force",
  "allowManual",
  "allowProtected",
  "touchesManual",
  "touchesProtected",
];

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_OPS = 50;
const MAX_ITEMS_PER_OP = 50;
const MAX_TEXT = 2000;
const MAX_REASON = 1000;
const MAX_EVIDENCE = 20;
/** No legitimate single proposal moves anything further than this (≈ 24 h at 60 fps). */
const MAX_ABS_FRAMES = 5_184_000;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Strict structural validation: exact keys, exact types, bounded sizes. */
export function parseProposal(raw: unknown): Parsed {
  const issues: ProposalIssue[] = [];
  const bad = (path: string, message: string, code: ProposalIssueCode = "malformed") =>
    issues.push({ code, path, message });

  if (!isObj(raw))
    return { ok: false, issues: [{ code: "malformed", message: "A proposal must be an object." }] };
  for (const k of AUTHORIZATION_KEYS) {
    if (k in raw)
      bad(
        k,
        "A proposal cannot authorize itself to override protected or manual edits.",
        "self-authorization",
      );
  }
  const allowed = new Set([
    "schema",
    "id",
    "instruction",
    "summary",
    "base",
    "operations",
    "rationale",
  ]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k) && !AUTHORIZATION_KEYS.includes(k)) bad(k, `Unknown field "${k}".`);
  }
  if (raw["schema"] !== PROPOSAL_SCHEMA) bad("schema", `Schema must be "${PROPOSAL_SCHEMA}".`);
  if (typeof raw["id"] !== "string" || !ID_RE.test(raw["id"]))
    bad("id", "Proposal id is missing or invalid.");
  for (const k of ["instruction", "summary"] as const) {
    const v = raw[k];
    if (typeof v !== "string" || !v.trim() || v.length > MAX_TEXT)
      bad(k, `"${k}" must be non-empty text of at most ${MAX_TEXT} characters.`);
  }

  const base = raw["base"];
  if (!isObj(base) || Object.keys(base).some((k) => k !== "versionId" && k !== "revision")) {
    bad("base", "base must be { versionId, revision }.");
  } else {
    if (typeof base["versionId"] !== "string" || !ID_RE.test(base["versionId"]))
      bad("base.versionId", "base.versionId is missing or invalid.");
    if (
      typeof base["revision"] !== "string" ||
      !/^rev_[0-9a-f]{16}_[0-9a-z]+$/.test(base["revision"])
    )
      bad("base.revision", "base.revision is missing or invalid.");
  }

  const ops = raw["operations"];
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) {
    bad("operations", `operations must list 1–${MAX_OPS} operations.`);
  } else {
    ops.forEach((op, i) => parseOp(op, `operations[${i}]`, bad));
  }

  const rationale = raw["rationale"];
  if (rationale !== undefined) {
    if (!Array.isArray(rationale) || rationale.length > MAX_OPS)
      bad("rationale", "rationale must be a list.");
    else
      rationale.forEach((r, i) => {
        const p = `rationale[${i}]`;
        if (
          !isObj(r) ||
          Object.keys(r).some((k) => !["opIndex", "reason", "evidence"].includes(k))
        ) {
          bad(p, "Each rationale entry is { opIndex, reason, evidence? }.");
          return;
        }
        if (
          !isInt(r["opIndex"]) ||
          r["opIndex"] < 0 ||
          !Array.isArray(ops) ||
          r["opIndex"] >= ops.length
        )
          bad(`${p}.opIndex`, "opIndex does not name an operation.");
        if (
          typeof r["reason"] !== "string" ||
          !r["reason"].trim() ||
          r["reason"].length > MAX_REASON
        )
          bad(`${p}.reason`, `reason must be non-empty text of at most ${MAX_REASON} characters.`);
        const ev = r["evidence"];
        if (ev !== undefined) {
          if (!Array.isArray(ev) || ev.length > MAX_EVIDENCE)
            bad(`${p}.evidence`, "evidence must be a short list.");
          else
            ev.forEach((e, j) => {
              if (
                !isObj(e) ||
                Object.keys(e).length !== 2 ||
                !["select", "transcript", "visual"].includes(e["kind"] as string) ||
                typeof e["id"] !== "string" ||
                !ID_RE.test(e["id"])
              )
                bad(`${p}.evidence[${j}]`, "Evidence is { kind: select|transcript|visual, id }.");
            });
        }
      });
  }

  return issues.length
    ? { ok: false, issues }
    : { ok: true, proposal: structuredClone(raw) as unknown as EditProposal };
}

function parseOp(
  op: unknown,
  path: string,
  bad: (p: string, m: string, c?: ProposalIssueCode) => void,
) {
  if (!isObj(op) || typeof op["op"] !== "string") return bad(path, 'Each operation needs an "op".');
  const kind = op["op"];
  for (const k of AUTHORIZATION_KEYS) {
    if (k in op)
      bad(
        `${path}.${k}`,
        "An operation cannot authorize itself to override protected or manual edits.",
        "self-authorization",
      );
  }
  const keys = (allowed: string[]) => {
    for (const k of Object.keys(op))
      if (!allowed.includes(k) && !AUTHORIZATION_KEYS.includes(k))
        bad(`${path}.${k}`, `Unknown field "${k}".`);
  };
  const itemList = (k: string) => {
    const v = op[k];
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ITEMS_PER_OP)
      return bad(`${path}.${k}`, `${k} must list 1–${MAX_ITEMS_PER_OP} item ids.`);
    v.forEach((id, j) => {
      if (typeof id !== "string" || !ID_RE.test(id)) bad(`${path}.${k}[${j}]`, "Invalid item id.");
    });
    if (new Set(v).size !== v.length) bad(`${path}.${k}`, "An item id is listed twice.");
  };
  const frames = (k: string) => {
    const v = op[k];
    if (!isInt(v))
      return bad(`${path}.${k}`, `${k} must be a whole number of frames.`, "invalid-range");
    if (v === 0) return bad(`${path}.${k}`, `${k} must not be zero.`, "invalid-range");
    if (Math.abs(v) > MAX_ABS_FRAMES) bad(`${path}.${k}`, `${k} is out of range.`, "invalid-range");
  };
  if (kind === "move") {
    keys(["op", "itemIds", "deltaFrames"]);
    itemList("itemIds");
    frames("deltaFrames");
  } else if (kind === "trim") {
    keys(["op", "itemId", "edge", "deltaSourceFrames"]);
    if (typeof op["itemId"] !== "string" || !ID_RE.test(op["itemId"]))
      bad(`${path}.itemId`, "Invalid item id.");
    if (op["edge"] !== "in" && op["edge"] !== "out")
      bad(`${path}.edge`, 'edge must be "in" or "out".');
    frames("deltaSourceFrames");
  } else if (kind === "remove") {
    keys(["op", "itemIds", "ripple"]);
    itemList("itemIds");
    if (typeof op["ripple"] !== "boolean") bad(`${path}.ripple`, "ripple must be true or false.");
  } else if (kind === "reorder") {
    keys(["op", "itemIds"]);
    itemList("itemIds");
    if (Array.isArray(op["itemIds"]) && op["itemIds"].length === 1)
      bad(`${path}.itemIds`, "A reorder lists at least two clips, in their new order.");
  } else {
    bad(
      `${path}.op`,
      KNOWN_UNSUPPORTED.has(kind)
        ? `"${kind}" is not supported by proposals yet — nothing was changed.`
        : `Unknown operation "${kind}".`,
      "unsupported-operation",
    );
  }
}

/* --------------------------------- revision -------------------------------- */

/** JSON with sorted keys and no undefined values: the same content always
 * gives the same text (a restored Sequence's key order may differ). */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function fnv32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const revisionCache = new WeakMap<Sequence, string>();

/** A content revision of a Sequence: identical content ⇔ identical revision
 * (two independent 32-bit FNV-1a hashes plus the length), across relaunches. */
export function sequenceRevision(seq: Sequence): string {
  let r = revisionCache.get(seq);
  if (!r) {
    const s = canonicalJson(seq);
    const a = fnv32(s, 0x811c9dc5).toString(16).padStart(8, "0");
    const b = fnv32(s, 0x2b992ddf).toString(16).padStart(8, "0");
    r = `rev_${a}${b}_${s.length.toString(36)}`;
    revisionCache.set(seq, r);
  }
  return r;
}

/* --------------------------------- ownership ------------------------------- */

export type Ownership = "director" | "manual" | "unknown";

/**
 * Who has shaped each item of a version — for deciding what a proposal may
 * touch. Durable ownership (`ClipItem.editedBy`, stamped by every command and
 * stored in the Sequence) decides first; the retained transaction history is
 * consulted as well, and is the only source for items edited before durable
 * ownership existed. Fail closed throughout:
 *   - manual if ownership says so, OR the history shows a non-Director
 *     transaction changing the item's content (protection changes aside), OR
 *     the transaction that last stamped it was not the Director's;
 *   - unknown if ownership says so, or for a pre-ownership item whose history
 *     doesn't reach back to the import (trimmed by the cap, or lost);
 *   - the Director's only when it is untouched since import, or provably
 *     changed by the Director alone.
 */
export function ownershipOf(
  ws: Workspace,
  versionId: string,
  clips: ReadonlyArray<Pick<Clip, "id" | "fps">>,
): (itemId: string) => Ownership {
  const seq = sequenceOf(ws, versionId, clips);
  const history: History | undefined = ws.histories[versionId];
  const manual = new Set<string>();
  const originOf = new Map<string, string>();
  let complete = !history; // a Director version is its own, untouched import
  if (history) {
    const version = ws.versions.find((v) => v.id === versionId);
    const parent = version?.parentId
      ? ws.versions.find((v) => v.id === version.parentId)
      : undefined;
    const imported = parent && parent.kind !== "edited" ? importedSequence(parent, clips) : null;
    const first = history.past[0]?.before ?? history.present;
    complete =
      !!imported && (first === imported || sequenceRevision(first) === sequenceRevision(imported));
    for (const e of history.past) {
      originOf.set(e.transaction.id, e.transaction.origin);
      if (e.transaction.origin === "director") continue;
      for (const id of new Set([...Object.keys(e.before.items), ...Object.keys(e.after.items)])) {
        const a = e.before.items[id];
        const b = e.after.items[id];
        if (a !== b && !(a && b && sameContent(a, b))) manual.add(id);
      }
    }
  }
  return (itemId) => {
    const item = seq?.items[itemId];
    if (!item) return "unknown";
    if (item.editedBy === "manual" || manual.has(itemId)) return "manual";
    if (item.editedBy === "unknown") return "unknown";
    if (!item.originTransactionId) return "director"; // untouched since import
    const stampedBy = originOf.get(item.originTransactionId);
    if (stampedBy !== undefined && stampedBy !== "director") return "manual";
    if (item.editedBy === "director") return "director"; // durable: Director-only
    // Edited before durable ownership: the Director's only if the history we
    // have reaches the import and shows the Director stamping it.
    return complete && stampedBy === "director" ? "director" : "unknown";
  };
}

/** Same item content, ignoring protection (locking isn't an edit). */
function sameContent(a: ClipItem, b: ClipItem): boolean {
  const { protection: _a, ...ra } = a;
  const { protection: _b, ...rb } = b;
  return canonicalJson(ra) === canonicalJson(rb);
}

/* ---------------------------------- review --------------------------------- */

/** What the project's analysis offers as evidence (ids only). */
export interface AnalysisInventory {
  selectIds: ReadonlySet<string>;
  transcriptIds: ReadonlySet<string>;
  visualIds: ReadonlySet<string>;
}

export interface ProposalContext {
  workspace: Workspace;
  activeVersionId: string;
  clips: ReadonlyArray<Pick<Clip, "id" | "fps">>;
  media?: MediaInventory | undefined;
  /** Required for proposals that cite evidence; without it, evidence cannot be
   * verified and the proposal is refused. */
  analysis?: AnalysisInventory | undefined;
}

export type Review =
  | {
      ok: true;
      proposal: EditProposal;
      /** The proposed Sequence — computed in memory only. */
      preview: Sequence;
      /** Every item the proposal would change, add or remove. */
      changedIds: string[];
      notes: string[];
    }
  | { ok: false; proposal: EditProposal | null; issues: ProposalIssue[] };

function compile(p: EditProposal, ids: IdGenerator): TypedCommand[] {
  return p.operations.map((op) => {
    switch (op.op) {
      case "move":
        return commands.move(ids, op.itemIds, op.deltaFrames);
      case "trim":
        return commands.trim(ids, op.itemId, op.edge, op.deltaSourceFrames);
      case "remove":
        return op.ripple
          ? commands.rippleDelete(ids, op.itemIds)
          : commands.delete(ids, op.itemIds);
      case "reorder":
        return commands.reorder(ids, op.itemIds);
    }
  });
}

function transactionFor(p: EditProposal, ids: IdGenerator, createdAt?: string): Transaction {
  const cmds = compile(p, ids) as unknown as Command[]; // typed builders → the log's shape
  const label = `Director: ${p.instruction.trim()}`.slice(0, 120);
  return makeTransaction(ids, label, "director", cmds, createdAt);
}

/**
 * Validates a proposal against the active version and computes its preview.
 * Pure: the workspace, its histories and anything persisted are untouched.
 */
export function reviewProposal(raw: unknown, ctx: ProposalContext): Review {
  const parsed = parseProposal(raw);
  if (!parsed.ok) return { ok: false, proposal: null, issues: parsed.issues };
  const p = parsed.proposal;
  const fail = (issues: ProposalIssue[]): Review => ({ ok: false, proposal: p, issues });

  // 1. The proposal must target the version on screen, exactly as it is now.
  if (!ctx.workspace.versions.some((v) => v.id === p.base.versionId))
    return fail([
      {
        code: "unknown-version",
        path: "base.versionId",
        message: "The proposal names a version this project does not have.",
      },
    ]);
  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq) return fail([{ code: "unknown-version", message: "There is no active sequence." }]);
  if (p.base.versionId !== ctx.activeVersionId || p.base.revision !== sequenceRevision(seq))
    return fail([
      {
        code: "stale",
        path: "base",
        message:
          "The sequence changed after this proposal was made. Ask the Director to propose again.",
      },
    ]);

  // 2. Every referenced item exists in that sequence.
  const issues: ProposalIssue[] = [];
  const referenced: string[] = [];
  p.operations.forEach((op, i) => {
    const list = op.op === "trim" ? [op.itemId] : op.itemIds;
    list.forEach((id, j) => {
      if (!seq.items[id])
        issues.push({
          code: "unknown-item",
          path: op.op === "trim" ? `operations[${i}].itemId` : `operations[${i}].itemIds[${j}]`,
          message: `Item ${id} is not in this sequence.`,
          itemIds: [id],
        });
      else referenced.push(id);
    });
  });

  // 3. Cited evidence exists in the project's analysis.
  for (const [i, r] of (p.rationale ?? []).entries()) {
    for (const [j, e] of (r.evidence ?? []).entries()) {
      const set =
        e.kind === "select"
          ? ctx.analysis?.selectIds
          : e.kind === "transcript"
            ? ctx.analysis?.transcriptIds
            : ctx.analysis?.visualIds;
      if (!set || !set.has(e.id))
        issues.push({
          code: "unverifiable-evidence",
          path: `rationale[${i}].evidence[${j}]`,
          message: set
            ? `Cited ${e.kind} ${e.id} does not exist in this project's analysis.`
            : "Evidence cannot be verified without the project's analysis.",
        });
    }
  }
  if (issues.length) return fail(issues);

  // 4. Protection and ownership of what the proposal names (with partners).
  const owner = ownershipOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  const named = expandLinked(seq, [...new Set(referenced)]);
  // Locks here; ownership just below, with its own, more precise reasons.
  const protectedIds = named.filter((id) => isLockedFrom(seq, seq.items[id]!, "director"));
  if (protectedIds.length)
    issues.push({
      code: "protected",
      message: "The proposal touches locked or AI-locked material.",
      itemIds: protectedIds,
    });
  ownershipIssues(named, owner, issues);
  if (issues.length) return fail(issues);

  // 5. Dry run: the exact transaction acceptance would commit.
  const run = applyTransaction(seq, transactionFor(p, seededIds(`preview:${p.id}`), "preview"), {
    media: ctx.media,
  });
  if (!run.ok) {
    // The engine refuses a Director change to manual / unknown-owned material
    // on its own (e.g. a ripple shifting a hand-edited clip). Say which, and why.
    if (run.error.code === "protected" || run.error.code === "invariant") {
      const flagged = [
        ...(run.error.itemIds ?? []),
        ...(run.error.violations ?? []).flatMap((v) => v.ids),
      ].filter((id) => seq.items[id]);
      ownershipIssues([...new Set(flagged)], owner, issues);
      if (issues.length) return fail(issues);
    }
    return fail([engineIssue(run.error)]);
  }

  // 6. Ownership of everything it would actually change (ripples shift
  //    items the proposal never named).
  const touchedExisting = run.changedIds.filter((id) => seq.items[id]);
  ownershipIssues(touchedExisting, owner, issues);
  if (issues.length) return fail(issues);

  return {
    ok: true,
    proposal: p,
    preview: run.sequence,
    changedIds: run.changedIds,
    notes: run.notes,
  };
}

function ownershipIssues(ids: string[], owner: (id: string) => Ownership, issues: ProposalIssue[]) {
  const manual = ids.filter((id) => owner(id) === "manual");
  const unknown = ids.filter((id) => owner(id) === "unknown");
  if (manual.length)
    issues.push({
      code: "manual-conflict",
      message:
        "The proposal would change material that was edited by hand. The Director never overrides manual edits.",
      itemIds: manual,
    });
  if (unknown.length)
    issues.push({
      code: "ownership-unknown",
      message:
        "It can't be established whether this material was edited by hand (its edit history is not fully available), so it is treated as manual and left alone.",
      itemIds: unknown,
    });
}

function engineIssue(e: TimelineError): ProposalIssue {
  const code: ProposalIssueCode =
    e.code === "protected"
      ? "protected"
      : e.code === "unknown-item"
        ? "unknown-item"
        : e.code === "invalid-range" || e.code === "out-of-bounds"
          ? "invalid-range"
          : "engine-rejected";
  return { code, message: e.message, itemIds: e.itemIds, engineCode: e.code };
}

/* ------------------------------- accept / reject ---------------------------- */

export type AcceptOutcome =
  | {
      ok: true;
      workspace: Workspace;
      activeVersionId: string;
      forkedFrom: string | null;
      transaction: Transaction;
    }
  | { ok: false; issues: ProposalIssue[] };

/**
 * Accepts a proposal: re-reviews it against the CURRENT state (it may have
 * gone stale since the preview), then commits it as ONE "director"
 * transaction through the workspace — forking a working version if the
 * active one is a Director version. One undo reverts all of it.
 */
export function acceptProposal(
  raw: unknown,
  ctx: ProposalContext & { ids: IdGenerator; now?: string },
): AcceptOutcome {
  const review = reviewProposal(raw, ctx);
  if (!review.ok) return { ok: false, issues: review.issues };
  const p = review.proposal;
  const txn = transactionFor(p, ctx.ids);
  const out: DispatchOutcome = dispatchTransaction(ctx.workspace, ctx.activeVersionId, txn, {
    clips: ctx.clips,
    media: ctx.media,
    ids: ctx.ids,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    fork: { command: p.instruction, summary: p.summary },
  });
  if (!out.ok) return { ok: false, issues: [engineIssue(out.error)] };
  return {
    ok: true,
    workspace: out.workspace,
    activeVersionId: out.activeVersionId,
    forkedFrom: out.forkedFrom,
    transaction: txn,
  };
}

/** Rejecting a proposal changes nothing: there is nothing to undo, because a
 * proposal is never written anywhere until it is accepted. */
export function rejectProposal(ws: Workspace): Workspace {
  return ws;
}
