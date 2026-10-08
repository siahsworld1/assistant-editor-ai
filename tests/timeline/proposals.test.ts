// Director AI 2.0 — Phase 1: deterministic edit proposals
// (src/lib/timeline/proposals.ts). Strict schema, stale detection, reference /
// evidence / protection / manual-ownership checks (fail closed), compilation
// to existing commands, preview isolation, atomic accept as ONE Director
// transaction with exact undo/redo and persistence, and reject = no change.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import {
  acceptProposal,
  ownershipOf,
  parseProposal,
  rejectProposal,
  reviewProposal,
  sequenceRevision,
  type ProposalContext,
} from "@/lib/timeline/proposals";
import { endFrame } from "@/lib/timeline/selectors";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Sequence } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  importedSequence,
  parseSavedEditStateV2,
  redoIn,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf, protect } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";
import { itemIdOf, moveCutaway, proposal, rippleRemove, trimOut } from "./proposal-fixtures";

const media = mediaOf(projectClips);
const SEL = {
  activeVersionId: "v2",
  chosenStoryId: null,
  targetSeconds: 30,
  storyboardSelectIds: [],
};
const baseline: EditVersion = {
  id: "v1",
  label: "Awaiting first build",
  version: "v1.0",
  command: "—",
  summary: "",
  createdAt: "—",
  changes: [],
  timeline: {
    id: "tl-empty",
    name: "Empty",
    fps: 24,
    targetSeconds: 30,
    totalSeconds: 0,
    decisions: [],
  },
};
const director: EditVersion = {
  id: "v2",
  label: "Create a 30-second rough cut",
  version: "v1.1",
  command: "Create a 30-second rough cut",
  summary: "Director build.",
  createdAt: "18:16",
  changes: [],
  timeline: directorCut,
  parentId: "v1",
};

function fresh(): Workspace {
  return deepFreeze(workspaceFromVersions([structuredClone(baseline), structuredClone(director)]));
}
function ctxFor(
  ws: Workspace,
  active: string,
  extra: Partial<ProposalContext> = {},
): ProposalContext {
  return { workspace: ws, activeVersionId: active, clips: projectClips, media, ...extra };
}
const seqOf = (ws: Workspace, v: string) => sequenceOf(ws, v, projectClips)!;
const ids = () => seededIds("prop-test");
function codes(r: ReturnType<typeof reviewProposal> | ReturnType<typeof parseProposal>) {
  return r.ok ? [] : r.issues.map((i) => i.code);
}

/** A manual edit (as the CUT timeline would commit it) on the active version. */
function manualMove(ws: Workspace, active: string, decisionId: string, delta: number) {
  const g = seededIds(`manual-${decisionId}-${delta}`);
  const s = seqOf(ws, active);
  const out = dispatchTransaction(
    ws,
    active,
    makeTransaction(g, "Move clip", "manual", [commands.move(g, [itemIdOf(s, decisionId)], delta)]),
    { clips: projectClips, media, ids: g, now: "19:00" },
  );
  if (!out.ok) throw new Error(out.error.message);
  return out;
}

/** Ignores which transaction stamped an item (preview vs commit ids differ). */
function sansStamps(seq: Sequence) {
  const items = Object.fromEntries(
    Object.entries(seq.items).map(([id, it]) => {
      const { originTransactionId: _t, ...rest } = it;
      return [id, rest];
    }),
  );
  return { ...seq, items };
}

/** n Director transactions nudging `decisionId` back and forth. */
function directorNudges(ws: Workspace, active: string, decisionId: string, n: number) {
  const g = seededIds(`dn-${decisionId}-${n}-${active}`);
  for (let k = 0; k < n; k += 1) {
    const s = seqOf(ws, active);
    const out = dispatchTransaction(
      ws,
      active,
      makeTransaction(g, "Director nudge", "director", [
        commands.move(g, [itemIdOf(s, decisionId)], k % 2 ? 1 : -1),
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    ws = out.workspace;
    active = out.activeVersionId;
  }
  return { ws, active };
}

/**
 * Save → reload, as a project saved BEFORE durable ownership would be: no
 * `editedBy` on any item and no provenance marker (unless `keepOwnership`).
 * `loseHistory` damages the undo log so only the present survives.
 */
function asPreOwnership(
  ws: Workspace,
  active: string,
  opts: { loseHistory?: boolean; keepOwnership?: boolean } = {},
): Workspace {
  const saved = JSON.parse(
    JSON.stringify(
      serializeWorkspace(ws, { ...SEL, activeVersionId: active }, "a", "", projectClips),
    ),
  );
  const h = saved.histories[active];
  if (!opts.keepOwnership) {
    delete h.provenance;
    const strip = (seq: { items: Record<string, unknown> } | string) => {
      if (typeof seq === "string") return;
      for (const it of Object.values(seq.items))
        if (it && typeof it === "object") delete (it as { editedBy?: unknown }).editedBy;
    };
    strip(h.present);
    strip(h.base);
  }
  if (opts.loseHistory) h.past[0].commands[0].params.deltaFrames = 999_999;
  const back = parseSavedEditStateV2(saved, "a", projectClips);
  if (!back) throw new Error("did not reload");
  return back.workspace;
}

describe("schema: strict validation", () => {
  const s = () => importedSequence(director, projectClips);

  it("accepts the three demonstration fixtures", () => {
    for (const f of [moveCutaway, trimOut, rippleRemove])
      expect(parseProposal(f("v2", s())).ok).toBe(true);
  });

  it("rejects malformed proposals with precise paths", () => {
    const good = moveCutaway("v2", s());
    const cases: Array<[unknown, string]> = [
      [null, "malformed"],
      ["a string", "malformed"],
      [[good], "malformed"],
      [{ ...good, schema: "ae.proposal/2" }, "malformed"],
      [{ ...good, id: "" }, "malformed"],
      [{ ...good, id: "bad id with spaces" }, "malformed"],
      [{ ...good, instruction: "  " }, "malformed"],
      [{ ...good, summary: "x".repeat(2001) }, "malformed"],
      [{ ...good, base: { versionId: "v2" } }, "malformed"],
      [{ ...good, base: { versionId: "v2", revision: "abc" } }, "malformed"],
      [{ ...good, operations: [] }, "malformed"],
      [{ ...good, operations: "move" }, "malformed"],
      [{ ...good, surprise: 1 }, "malformed"],
      [{ ...good, operations: [{ op: "move", itemIds: [], deltaFrames: 1 }] }, "malformed"],
      [{ ...good, operations: [{ op: "move", itemIds: ["a", "a"], deltaFrames: 1 }] }, "malformed"],
      [
        { ...good, operations: [{ op: "move", itemIds: ["a"], deltaFrames: 1, extra: true }] },
        "malformed",
      ],
      [
        {
          ...good,
          operations: [{ op: "trim", itemId: "a", edge: "middle", deltaSourceFrames: 1 }],
        },
        "malformed",
      ],
      [{ ...good, operations: [{ op: "remove", itemIds: ["a"], ripple: "yes" }] }, "malformed"],
      [{ ...good, rationale: [{ opIndex: 5, reason: "x" }] }, "malformed"],
      [
        {
          ...good,
          rationale: [{ opIndex: 0, reason: "x", evidence: [{ kind: "rumour", id: "x" }] }],
        },
        "malformed",
      ],
    ];
    for (const [raw, code] of cases) {
      const r = parseProposal(raw);
      expect(r.ok, JSON.stringify(raw)?.slice(0, 80)).toBe(false);
      expect(codes(r)).toContain(code);
    }
  });

  it("rejects invalid frame ranges before anything runs", () => {
    const good = moveCutaway("v2", s());
    for (const deltaFrames of [0, 1.5, Number.NaN, 1e12, "12"]) {
      const r = parseProposal({
        ...good,
        operations: [{ op: "move", itemIds: ["a"], deltaFrames }],
      });
      expect(codes(r)).toContain("invalid-range");
    }
    const t = parseProposal({
      ...good,
      operations: [{ op: "trim", itemId: "a", edge: "in", deltaSourceFrames: 0 }],
    });
    expect(codes(t)).toContain("invalid-range");
  });

  it("refuses unsupported operations explicitly — never a silent rebuild", () => {
    const good = moveCutaway("v2", s());
    for (const op of [
      "replaceAssembly",
      "rebuild",
      "split",
      "insert",
      "rippleTrim", // ("reorder" is supported since Phase 6 — see proposals-reorder.test.ts)
      "setProtection",
      "teleport",
    ]) {
      const r = parseProposal({ ...good, operations: [{ op, itemIds: ["x"] }] });
      expect(codes(r)).toEqual(["unsupported-operation"]);
      expect(r.ok ? "" : r.issues[0]!.message).toMatch(/not supported|Unknown operation/);
    }
  });

  it("a proposal can never authorize itself", () => {
    const good = moveCutaway("v2", s());
    for (const extra of [
      { authorization: { touchesManual: ["x"] } },
      { override: true },
      { allowManual: true },
      { force: true },
    ]) {
      expect(codes(parseProposal({ ...good, ...extra }))).toContain("self-authorization");
    }
    const opLevel = parseProposal({
      ...good,
      operations: [{ op: "move", itemIds: ["a"], deltaFrames: 1, force: true }],
    });
    expect(codes(opLevel)).toContain("self-authorization");
  });
});

describe("revision: stale detection", () => {
  it("is content-based, stable across save/reload, and changes with any edit", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    expect(sequenceRevision(s)).toBe(sequenceRevision(structuredClone(s)));
    // Same content, different key order → same revision.
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as unknown as Sequence;
    expect(sequenceRevision(reordered)).toBe(sequenceRevision(s));
    const edited = manualMove(ws, "v2", "event-7", 2);
    const w = edited.activeVersionId;
    const after = seqOf(edited.workspace, w);
    expect(sequenceRevision(after)).not.toBe(sequenceRevision(s));
    const json = JSON.stringify(
      serializeWorkspace(edited.workspace, { ...SEL, activeVersionId: w }, "a", "", projectClips),
    );
    const back = parseSavedEditStateV2(JSON.parse(json), "a", projectClips)!;
    expect(sequenceRevision(seqOf(back.workspace, w))).toBe(sequenceRevision(after));
  });

  it("refuses a proposal made before the sequence changed, or aimed at another version", () => {
    const ws = fresh();
    const p = moveCutaway("v2", seqOf(ws, "v2"));
    expect(reviewProposal(p, ctxFor(ws, "v2")).ok).toBe(true);
    // Meanwhile the director edits by hand: v2 forks to a working version.
    const edited = manualMove(ws, "v2", "event-4", -2);
    const w = edited.activeVersionId;
    expect(codes(reviewProposal(p, ctxFor(edited.workspace, w)))).toEqual(["stale"]);
    // Re-targeted at the working version but with the old revision: still stale.
    const retargeted = {
      ...p,
      base: { versionId: w, revision: (p.base as { revision: string }).revision },
    };
    expect(codes(reviewProposal(retargeted, ctxFor(edited.workspace, w)))).toEqual(["stale"]);
    // A version the project doesn't have.
    const ghost = {
      ...p,
      base: { versionId: "ver_nope", revision: (p.base as { revision: string }).revision },
    };
    expect(codes(reviewProposal(ghost, ctxFor(ws, "v2")))).toEqual(["unknown-version"]);
  });

  it("accept re-checks: a proposal that went stale after its preview is refused", () => {
    const ws = fresh();
    const p = trimOut("v2", seqOf(ws, "v2"));
    expect(reviewProposal(p, ctxFor(ws, "v2")).ok).toBe(true);
    const edited = manualMove(ws, "v2", "event-4", -2);
    const a = acceptProposal(p, {
      ...ctxFor(edited.workspace, edited.activeVersionId),
      ids: ids(),
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.issues.map((i) => i.code)).toEqual(["stale"]);
  });
});

describe("references, ranges and evidence", () => {
  it("refuses invented item ids", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const r = reviewProposal(
      proposal("v2", s, [
        { op: "move", itemIds: ["itm_00000000000000000000000000000000"], deltaFrames: 4 },
      ]),
      ctxFor(ws, "v2"),
    );
    expect(codes(r)).toEqual(["unknown-item"]);
    if (!r.ok) expect(r.issues[0]!.path).toBe("operations[0].itemIds[0]");
  });

  it("refuses ranges the engine cannot represent, with the engine's reason", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const e1 = itemIdOf(s, "event-1");
    const cases: Array<[unknown[], string]> = [
      [[{ op: "move", itemIds: [e1], deltaFrames: -10 }], "invalid-range"], // before frame 0
      [[{ op: "trim", itemId: e1, edge: "in", deltaSourceFrames: 100_000 }], "invalid-range"], // empties it
      [
        [{ op: "trim", itemId: itemIdOf(s, "event-6"), edge: "out", deltaSourceFrames: 50_000 }],
        "invalid-range",
      ], // past media
      [[{ op: "move", itemIds: [e1], deltaFrames: 24 }], "engine-rejected"], // overlaps event 2
    ];
    for (const [ops, code] of cases) {
      const r = reviewProposal(proposal("v2", s, ops), ctxFor(ws, "v2"));
      expect(codes(r), JSON.stringify(ops)).toEqual([code]);
    }
  });

  it("cited evidence must exist in the project's analysis — and cannot be verified without it", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const withEvidence = (id: string) => ({
      ...moveCutaway("v2", s),
      rationale: [{ opIndex: 0, reason: "Matches the line.", evidence: [{ kind: "select", id }] }],
    });
    const analysis = {
      selectIds: new Set(["sel-01"]),
      transcriptIds: new Set<string>(),
      visualIds: new Set<string>(),
    };
    expect(reviewProposal(withEvidence("sel-01"), ctxFor(ws, "v2", { analysis })).ok).toBe(true);
    expect(codes(reviewProposal(withEvidence("sel-99"), ctxFor(ws, "v2", { analysis })))).toEqual([
      "unverifiable-evidence",
    ]);
    expect(codes(reviewProposal(withEvidence("sel-01"), ctxFor(ws, "v2")))).toEqual([
      "unverifiable-evidence",
    ]);
  });

  it("is atomic: one bad operation refuses the whole proposal", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const before = serializeWorkspace(ws, SEL, "a", "", projectClips);
    const p = proposal("v2", s, [
      { op: "move", itemIds: [itemIdOf(s, "event-7")], deltaFrames: -24 }, // fine alone
      { op: "move", itemIds: [itemIdOf(s, "event-1")], deltaFrames: 24 }, // overlaps
    ]);
    expect(reviewProposal(p, ctxFor(ws, "v2")).ok).toBe(false);
    expect(acceptProposal(p, { ...ctxFor(ws, "v2"), ids: ids() }).ok).toBe(false);
    expect(serializeWorkspace(ws, SEL, "a", "", projectClips)).toStrictEqual(before);
  });
});

describe("demonstration: the three supported operations", () => {
  it("move an unprotected clip: preview only, then one Director transaction", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const p = moveCutaway("v2", s);
    const before = JSON.stringify(serializeWorkspace(ws, SEL, "a", "", projectClips));
    const review = reviewProposal(p, ctxFor(ws, "v2"));
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const e7 = itemIdOf(s, "event-7");
    expect(review.preview.items[e7]!.startFrame).toBe(684);
    expect(review.changedIds).toEqual([e7]);
    // Preview isolation: nothing about the project changed.
    expect(seqOf(ws, "v2")).toBe(s);
    expect(ws.histories).toEqual({});
    expect(JSON.stringify(serializeWorkspace(ws, SEL, "a", "", projectClips))).toBe(before);

    const a = acceptProposal(p, { ...ctxFor(ws, "v2"), ids: ids(), now: "20:00" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.forkedFrom).toBe("v2"); // the Director version stays immutable
    const forked = a.workspace.versions.find((v) => v.id === a.activeVersionId)!;
    expect(forked).toMatchObject({
      kind: "edited",
      parentId: "v2",
      command: "Bring the last cutaway in a second earlier",
      summary: "Moves the closing cutaway 24 frames earlier, still over the final interview line.",
    });
    const h = a.workspace.histories[a.activeVersionId]!;
    expect(h.past).toHaveLength(1); // ONE transaction
    expect(h.past[0]!.transaction.origin).toBe("director");
    expect(h.past[0]!.transaction.label).toBe(
      "Director: Bring the last cutaway in a second earlier",
    );
    expect(sansStamps(h.present)).toStrictEqual(sansStamps(review.preview)); // preview = result
    expect(seqOf(a.workspace, "v2")).toStrictEqual(importedSequence(director, projectClips));
  });

  it("trim an unprotected clip: linked sync audio follows; undo/redo are exact", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const a = acceptProposal(trimOut("v2", s), { ...ctxFor(ws, "v2"), ids: ids() });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const w = a.activeVersionId;
    const e6 = itemIdOf(s, "event-6");
    const after = seqOf(a.workspace, w);
    const a6 = Object.values(after.items).find(
      (i) => i.linkGroupId === after.items[e6]!.linkGroupId && i.id !== e6,
    )!;
    expect(endFrame(after.items[e6]!)).toBeLessThan(792);
    expect(endFrame(a6)).toBe(endFrame(after.items[e6]!));
    const undone = undoIn(a.workspace, w);
    expect(seqOf(undone, w)).toStrictEqual(s);
    expect(seqOf(redoIn(undone, w), w)).toBe(after);
  });

  it("remove a section and close the gap where ripple rules permit — and refuse where they don't", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const a = acceptProposal(rippleRemove("v2", s), { ...ctxFor(ws, "v2"), ids: ids() });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const after = seqOf(a.workspace, a.activeVersionId);
    expect(after.items[itemIdOf(s, "event-5")]).toBeUndefined();
    expect(after.items[itemIdOf(s, "event-6")]!.startFrame).toBe(696 - 144);
    expect(after.items[itemIdOf(s, "event-7")]!.startFrame).toBe(708 - 144);
    // Event 3 has a cutaway (event 4) over it: conservative ripple refuses.
    const blocked = reviewProposal(
      proposal("v2", s, [{ op: "remove", itemIds: [itemIdOf(s, "event-3")], ripple: true }]),
      ctxFor(ws, "v2"),
    );
    expect(codes(blocked)).toEqual(["engine-rejected"]);
    // Lift (no ripple) is fine: the gap stays.
    const lift = reviewProposal(
      proposal("v2", s, [{ op: "remove", itemIds: [itemIdOf(s, "event-3")], ripple: false }]),
      ctxFor(ws, "v2"),
    );
    expect(lift.ok && lift.preview.items[itemIdOf(s, "event-5")]!.startFrame).toBe(552);
  });

  it("an accepted proposal persists: save → reload → same sequence, Director-owned, undoable", () => {
    const ws = fresh();
    const a = acceptProposal(moveCutaway("v2", seqOf(ws, "v2")), {
      ...ctxFor(ws, "v2"),
      ids: ids(),
    });
    if (!a.ok) throw new Error("not accepted");
    const w = a.activeVersionId;
    const json = JSON.stringify(
      serializeWorkspace(a.workspace, { ...SEL, activeVersionId: w }, "a", "", projectClips),
    );
    const back = parseSavedEditStateV2(JSON.parse(json), "a", projectClips)!;
    expect(back.warnings).toEqual([]);
    expect(seqOf(back.workspace, w)).toStrictEqual(seqOf(a.workspace, w));
    expect(back.workspace.histories[w]!.past[0]!.transaction.origin).toBe("director");
    const own = ownershipOf(back.workspace, w, projectClips);
    expect(own(itemIdOf(seqOf(ws, "v2"), "event-7"))).toBe("director"); // its own edit
    // A follow-up proposal against the reloaded version is accepted too.
    const next = trimOut(w, seqOf(back.workspace, w));
    expect(reviewProposal(next, ctxFor(back.workspace, w)).ok).toBe(true);
    expect(seqOf(undoIn(back.workspace, w), w)).toStrictEqual(
      importedSequence(director, projectClips),
    );
  });

  it("reject changes nothing", () => {
    const ws = fresh();
    const before = JSON.stringify(serializeWorkspace(ws, SEL, "a", "", projectClips));
    const review = reviewProposal(rippleRemove("v2", seqOf(ws, "v2")), ctxFor(ws, "v2"));
    expect(review.ok).toBe(true);
    expect(rejectProposal(ws)).toBe(ws);
    expect(JSON.stringify(serializeWorkspace(ws, SEL, "a", "", projectClips))).toBe(before);
  });
});

describe("protection and manual edits (fail closed)", () => {
  /** A working version whose present has the given protection applied. */
  function protectedWorkspace(
    target: { itemId?: string; trackName?: string },
    p: { locked?: boolean; aiLocked?: boolean },
  ) {
    const base = importedSequence(director, projectClips);
    const seq = protect(base, target, p);
    const edited: EditVersion = {
      ...structuredClone(director),
      id: "ver_protected",
      kind: "edited",
      parentId: "v2",
      version: "v1.1 · edited",
    };
    return deepFreeze({
      versions: [structuredClone(baseline), structuredClone(director), edited],
      histories: { ver_protected: createHistory(seq) },
    } as Workspace);
  }

  it("locked and AI-locked items (and locked tracks) are never touched", () => {
    const base = importedSequence(director, projectClips);
    const e7 = itemIdOf(base, "event-7");
    for (const [target, prot] of [
      [{ itemId: e7 }, { locked: true }],
      [{ itemId: e7 }, { aiLocked: true }],
      [{ trackName: "V2" }, { aiLocked: true }],
    ] as const) {
      const ws = protectedWorkspace(target, prot);
      const r = reviewProposal(
        moveCutaway("ver_protected", seqOf(ws, "ver_protected")),
        ctxFor(ws, "ver_protected"),
      );
      expect(codes(r), JSON.stringify(prot)).toEqual(["protected"]);
      if (!r.ok) expect(r.issues[0]!.itemIds).toEqual([e7]);
    }
  });

  it("refuses to change anything edited by hand — directly, as a linked partner, or by a ripple shift", () => {
    const ws = fresh();
    const edited = manualMove(ws, "v2", "event-7", 2); // a manual edit on the cutaway
    const w = edited.activeVersionId;
    const s = seqOf(edited.workspace, w);
    // Directly.
    const direct = reviewProposal(
      proposal(w, s, [{ op: "move", itemIds: [itemIdOf(s, "event-7")], deltaFrames: -2 }]),
      ctxFor(edited.workspace, w),
    );
    expect(codes(direct)).toEqual(["manual-conflict"]);
    // Indirectly: rippling event 5 out would shift the manually moved cutaway.
    const ripple = reviewProposal(
      proposal(w, s, [{ op: "remove", itemIds: [itemIdOf(s, "event-5")], ripple: true }]),
      ctxFor(edited.workspace, w),
    );
    expect(codes(ripple)).toEqual(["manual-conflict"]);
    if (!ripple.ok) expect(ripple.issues[0]!.itemIds).toEqual([itemIdOf(s, "event-7")]);
    // Material nobody touched by hand is still the Director's to change.
    const untouched = reviewProposal(
      proposal(w, s, [
        { op: "trim", itemId: itemIdOf(s, "event-1"), edge: "out", deltaSourceFrames: -12 },
      ]),
      ctxFor(edited.workspace, w),
    );
    expect(untouched.ok).toBe(true);
  });

  it("a manual edit on V1 also protects its linked A1 (and vice versa)", () => {
    const ws = fresh();
    const edited = manualMove(ws, "v2", "event-6", 4); // V1 + its A1, by hand
    const w = edited.activeVersionId;
    const s = seqOf(edited.workspace, w);
    const r = reviewProposal(
      proposal(w, s, [
        { op: "trim", itemId: itemIdOf(s, "event-6"), edge: "out", deltaSourceFrames: -12 },
      ]),
      ctxFor(edited.workspace, w),
    );
    expect(codes(r)).toEqual(["manual-conflict"]);
    if (!r.ok) expect(r.issues[0]!.itemIds).toHaveLength(2);
  });

  it("an undone manual edit no longer counts; a redone one does", () => {
    const ws = fresh();
    const edited = manualMove(ws, "v2", "event-7", 2);
    const w = edited.activeVersionId;
    const undone = undoIn(edited.workspace, w);
    const s = seqOf(undone, w);
    expect(reviewProposal(moveCutaway(w, s), ctxFor(undone, w)).ok).toBe(true);
    const redone = redoIn(undone, w);
    expect(codes(reviewProposal(moveCutaway(w, seqOf(redone, w)), ctxFor(redone, w)))).toEqual([
      "manual-conflict",
    ]);
  });

  it("past the 200-entry cap, durable ownership still knows: Director-only stays the Director's, manual stays manual", () => {
    const one = directorNudges(fresh(), "v2", "event-4", 1);
    const capped = directorNudges(one.ws, one.active, "event-7", 200); // event 4's edit leaves the history
    const s = seqOf(capped.ws, capped.active);
    const own = ownershipOf(capped.ws, capped.active, projectClips);
    expect(own(itemIdOf(s, "event-4"))).toBe("director");
    expect(own(itemIdOf(s, "event-1"))).toBe("director"); // untouched
    const ok = reviewProposal(
      proposal(capped.active, s, [
        { op: "move", itemIds: [itemIdOf(s, "event-4")], deltaFrames: -2 },
      ]),
      ctxFor(capped.ws, capped.active),
    );
    expect(ok.ok).toBe(true);
  });

  it("fails closed for a pre-ownership project whose history no longer reaches its edits", () => {
    const one = directorNudges(fresh(), "v2", "event-4", 1);
    const capped = directorNudges(one.ws, one.active, "event-7", 200);
    const old = asPreOwnership(capped.ws, capped.active);
    const s = seqOf(old, capped.active);
    expect(ownershipOf(old, capped.active, projectClips)(itemIdOf(s, "event-4"))).toBe("unknown");
    const r = reviewProposal(
      proposal(capped.active, s, [
        { op: "move", itemIds: [itemIdOf(s, "event-4")], deltaFrames: -2 },
      ]),
      ctxFor(old, capped.active),
    );
    expect(codes(r)).toEqual(["ownership-unknown"]);
  });

  it("fails closed for a pre-ownership project whose history was lost on reload", () => {
    const once = directorNudges(fresh(), "v2", "event-4", 1);
    const lost = asPreOwnership(once.ws, once.active, { loseHistory: true });
    const s = seqOf(lost, once.active);
    const r = reviewProposal(
      proposal(once.active, s, [{ op: "move", itemIds: [itemIdOf(s, "event-4")], deltaFrames: 2 }]),
      ctxFor(lost, once.active),
    );
    expect(codes(r)).toEqual(["ownership-unknown"]);
    // Untouched material stays usable.
    expect(reviewProposal(trimOut(once.active, s), ctxFor(lost, once.active)).ok).toBe(true);
    // The same project saved WITH ownership keeps it, even with its history lost.
    const kept = asPreOwnership(once.ws, once.active, { loseHistory: true, keepOwnership: true });
    expect(ownershipOf(kept, once.active, projectClips)(itemIdOf(s, "event-4"))).toBe("director");
  });
});

describe("Phase 1 approval gate (re-run with durable ownership)", () => {
  const allOps = (s: Sequence, decisionId: string): unknown[][] => {
    const id = itemIdOf(s, decisionId);
    return [
      [{ op: "move", itemIds: [id], deltaFrames: -1 }],
      [{ op: "trim", itemId: id, edge: "out", deltaSourceFrames: -1 }],
      [{ op: "remove", itemIds: [id], ripple: false }],
      [{ op: "remove", itemIds: [id], ripple: true }],
    ];
  };

  it("1. unknown ownership always blocks — every operation, at review and at accept", () => {
    // Unknown can now only arise for edits made before durable ownership:
    // (a) history trimmed by the cap, (b) history lost, (c) parent missing.
    const one = directorNudges(fresh(), "v2", "event-4", 1);
    const capped = (() => {
      const c = directorNudges(one.ws, one.active, "event-7", 200);
      return { ws: asPreOwnership(c.ws, c.active), active: c.active };
    })();
    const lost = {
      ws: asPreOwnership(one.ws, one.active, { loseHistory: true }),
      active: one.active,
    };
    const orphan = (() => {
      // (Reloading a pre-ownership project with its history intact replays it
      // and recovers provable ownership; an orphan only matters without it.)
      const ws = asPreOwnership(one.ws, one.active, { loseHistory: true });
      return {
        ws: {
          ...ws,
          versions: ws.versions.map((v) =>
            v.id === one.active ? { ...v, parentId: "v-missing" } : v,
          ),
        },
        active: one.active,
      };
    })();
    for (const [name, { ws, active }] of Object.entries({ capped, lost, orphan })) {
      const s = seqOf(ws, active);
      expect(ownershipOf(ws, active, projectClips)(itemIdOf(s, "event-4")), name).toBe("unknown");
      for (const ops of allOps(s, "event-4")) {
        const p = proposal(active, s, ops);
        const r = reviewProposal(p, ctxFor(ws, active));
        expect(r.ok, `${name} ${JSON.stringify(ops)}`).toBe(false);
        expect(codes(r), `${name} ${JSON.stringify(ops)}`).toContain("ownership-unknown");
        expect(acceptProposal(p, { ...ctxFor(ws, active), ids: ids() }).ok).toBe(false);
      }
    }
  });

  it("2. a manual edit can never be laundered into 'safe' by a missing or trimmed history", () => {
    // Manual edit on event 7. A Director change to the same clip is refused by
    // the engine itself; 200 Director transactions elsewhere then push the
    // manual edit out of the history.
    const m = manualMove(fresh(), "v2", "event-7", 2);
    let { ws, active } = { ws: m.workspace, active: m.activeVersionId };
    expect(() => directorNudges(ws, active, "event-7", 1)).toThrow(/edited by hand/);
    ({ ws, active } = directorNudges(ws, active, "event-4", 200));
    expect(ws.histories[active]!.past.some((e) => e.transaction.origin === "manual")).toBe(false);
    const s = seqOf(ws, active);
    // Durable ownership: still manual — not merely unknown.
    expect(ownershipOf(ws, active, projectClips)(itemIdOf(s, "event-7"))).toBe("manual");
    expect(codes(reviewProposal(moveCutaway(active, s), ctxFor(ws, active)))).toEqual([
      "manual-conflict",
    ]);
    // …and after save → reload, and with the history lost.
    for (const opts of [{}, { loseHistory: true }]) {
      const back = asPreOwnership(ws, active, { ...opts, keepOwnership: true });
      expect(
        ownershipOf(back, active, projectClips)(itemIdOf(s, "event-7")),
        JSON.stringify(opts),
      ).toBe("manual");
    }
    // A pre-ownership project in the same state: unknown — still refused.
    const old = asPreOwnership(ws, active);
    expect(ownershipOf(old, active, projectClips)(itemIdOf(s, "event-7"))).toBe("unknown");
    // A history entry that under-reports what it changed still marks it manual.
    const entry = m.workspace.histories[m.activeVersionId]!.past[0]!;
    const faulty = {
      ...m.workspace,
      histories: {
        [m.activeVersionId]: {
          ...m.workspace.histories[m.activeVersionId]!,
          past: [{ ...entry, changedIds: [] }],
        },
      },
    };
    expect(ownershipOf(faulty, m.activeVersionId, projectClips)(itemIdOf(s, "event-7"))).toBe(
      "manual",
    );
  });

  it("3. indirect effects get the same checks: linked audio and ripple-shifted clips", () => {
    // A manual move of V1 event 6 also moved its A1 — both are manual.
    const m = manualMove(fresh(), "v2", "event-6", 4);
    const w = m.activeVersionId;
    const s = seqOf(m.workspace, w);
    const v6 = s.items[itemIdOf(s, "event-6")]!;
    const a6 = Object.values(s.items).find(
      (i) => i.linkGroupId === v6.linkGroupId && i.id !== v6.id,
    )!;
    expect([v6.editedBy, a6.editedBy]).toEqual(["manual", "manual"]);
    const viaAudio = reviewProposal(
      proposal(w, s, [{ op: "trim", itemId: a6.id, edge: "in", deltaSourceFrames: 2 }]),
      ctxFor(m.workspace, w),
    );
    expect(codes(viaAudio)).toEqual(["manual-conflict"]);
    if (!viaAudio.ok) expect(new Set(viaAudio.issues[0]!.itemIds)).toEqual(new Set([v6.id, a6.id]));
    const viaRipple = reviewProposal(
      proposal(w, s, [{ op: "remove", itemIds: [itemIdOf(s, "event-5")], ripple: true }]),
      ctxFor(m.workspace, w),
    );
    expect(codes(viaRipple)).toEqual(["manual-conflict"]);
    if (!viaRipple.ok)
      expect(viaRipple.issues[0]!.itemIds).toEqual(expect.arrayContaining([v6.id, a6.id]));
    // A ripple that would shift a clip of UNKNOWN ownership (pre-ownership project).
    const one = directorNudges(fresh(), "v2", "event-7", 1);
    const capped = directorNudges(one.ws, one.active, "event-4", 200);
    const old = asPreOwnership(capped.ws, capped.active);
    const cs = seqOf(old, capped.active);
    const r = reviewProposal(
      proposal(capped.active, cs, [
        { op: "remove", itemIds: [itemIdOf(cs, "event-5")], ripple: true },
      ]),
      ctxFor(old, capped.active),
    );
    expect(codes(r)).toEqual(["ownership-unknown"]);
    if (!r.ok) expect(r.issues[0]!.itemIds).toEqual([itemIdOf(cs, "event-7")]);
  });

  it("4. preview and rejection never mutate the active sequence or anything persisted", () => {
    const m = manualMove(fresh(), "v2", "event-7", 2);
    const ws = deepFreeze(m.workspace);
    const w = m.activeVersionId;
    const s = seqOf(ws, w);
    const before = {
      json: JSON.stringify(
        serializeWorkspace(ws, { ...SEL, activeVersionId: w }, "a", "", projectClips),
      ),
      revision: sequenceRevision(s),
      history: ws.histories[w],
    };
    const tries: unknown[] = [
      trimOut(w, s), // valid
      rippleRemove(w, s), // refused: would shift the manual edit
      moveCutaway(w, s), // refused: manual
      proposal(w, s, [{ op: "move", itemIds: [itemIdOf(s, "event-1")], deltaFrames: 24 }]), // overlap
      { schema: "ae.proposal/1" }, // malformed
    ];
    for (const t of tries) {
      reviewProposal(t, ctxFor(ws, w));
      expect(rejectProposal(ws)).toBe(ws);
    }
    expect(seqOf(ws, w)).toBe(s);
    expect(ws.histories[w]).toBe(before.history);
    expect(sequenceRevision(seqOf(ws, w))).toBe(before.revision);
    expect(
      JSON.stringify(serializeWorkspace(ws, { ...SEL, activeVersionId: w }, "a", "", projectClips)),
    ).toBe(before.json);
  });

  it("5. accept is one atomic, undoable transaction — a failing op leaves no trace", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const multi = proposal("v2", s, [
      { op: "move", itemIds: [itemIdOf(s, "event-7")], deltaFrames: -24 },
      { op: "trim", itemId: itemIdOf(s, "event-6"), edge: "out", deltaSourceFrames: -24 },
      { op: "remove", itemIds: [itemIdOf(s, "event-4")], ripple: false },
    ]);
    const a = acceptProposal(multi, { ...ctxFor(ws, "v2"), ids: ids() });
    if (!a.ok) throw new Error(JSON.stringify(a.issues));
    const h = a.workspace.histories[a.activeVersionId]!;
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.transaction.commands).toHaveLength(3);
    const after = h.present;
    const undone = undoIn(a.workspace, a.activeVersionId);
    expect(seqOf(undone, a.activeVersionId)).toStrictEqual(s);
    expect(seqOf(redoIn(undone, a.activeVersionId), a.activeVersionId)).toBe(after);
    // Third op invalid (overlap): nothing committed, no fork, no history.
    const bad = proposal("v2", s, [
      { op: "move", itemIds: [itemIdOf(s, "event-7")], deltaFrames: -24 },
      { op: "trim", itemId: itemIdOf(s, "event-6"), edge: "out", deltaSourceFrames: -24 },
      { op: "move", itemIds: [itemIdOf(s, "event-1")], deltaFrames: 24 },
    ]);
    const b = acceptProposal(bad, { ...ctxFor(ws, "v2"), ids: ids() });
    expect(b.ok).toBe(false);
    expect(ws.versions).toHaveLength(2);
    expect(ws.histories).toEqual({});
    expect(seqOf(ws, "v2")).toBe(s);
  });
});

/* ------------------------- real saved projects (opt-in) ------------------------ */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("every saved version accepts a fixture proposal, persists it, and undoes it exactly — files untouched", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map((c: { id: string; fps: number; duration_seconds: number }) =>
        clip(c.id, c.fps, c.duration_seconds),
      );
      const realMedia = mediaOf(clips);
      let checked = 0;
      let versions = 0;
      let empty = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const s = sequenceOf(ws, v.id, clips)!;
          versions += 1;
          const items = Object.values(s.items);
          const track = (id: string) => s.tracks.find((t) => t.id === id)!.name;
          const v2 = items.find((i) => track(i.trackId) === "V2");
          const v1 = items
            .filter((i) => track(i.trackId) === "V1")
            .sort((a, b) => endFrame(b) - endFrame(a))[0];
          if (!v1) {
            empty += 1; // "Awaiting first build": nothing to propose against
            continue;
          }
          const ops = v2
            ? [{ op: "trim", itemId: v2.id, edge: "out", deltaSourceFrames: -1 }]
            : [{ op: "trim", itemId: v1.id, edge: "out", deltaSourceFrames: -1 }];
          const p = proposal(v.id, s, ops);
          const ctx = { workspace: ws, activeVersionId: v.id, clips, media: realMedia };
          const review = reviewProposal(p, ctx);
          expect(review.ok, `${v.id}: ${JSON.stringify(!review.ok && review.issues)}`).toBe(true);
          const a = acceptProposal(p, { ...ctx, ids: seededIds(`real-${v.id}`) });
          if (!a.ok) throw new Error(JSON.stringify(a.issues));
          const json = JSON.stringify(
            serializeWorkspace(
              a.workspace,
              { ...SEL, activeVersionId: a.activeVersionId },
              state.analysisId,
              "",
              clips,
            ),
          );
          const back = parseSavedEditStateV2(JSON.parse(json), state.analysisId, clips)!;
          expect(back.warnings).toEqual([]);
          expect(
            sequenceOf(undoIn(back.workspace, a.activeVersionId), a.activeVersionId, clips),
          ).toStrictEqual(s);
          checked += 1;
        }
        expect(readFileSync(file, "utf8")).toBe(before); // never written
      }
      expect(versions).toBe(8);
      expect(checked).toBe(versions - empty);
      expect(checked).toBeGreaterThanOrEqual(6);
    });
  },
);
