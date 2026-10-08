// Director AI 2.0 — Phase 2: durable manual-edit ownership (ClipItem.editedBy)
// and protection controls (SetProtection). Ownership is stamped by every
// command, lives in the Sequence, and survives save/reload, undo/redo and
// history truncation; protection is filmmaker-only and never an edit.
import { describe, expect, it } from "vitest";
import type { EditVersion, UniversalTimeline } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml } from "@/lib/nle/fcpxml";
import { buildXmeml } from "@/lib/nle/xmeml";
import { commands } from "@/lib/timeline/commands";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { assemblyFromLegacy } from "@/lib/timeline/commands/replace-assembly";
import { legacyToSequence, sequenceToLegacy } from "@/lib/timeline/legacy-adapter";
import { ownershipOf, reviewProposal } from "@/lib/timeline/proposals";
import { applyTransaction, makeTransaction } from "@/lib/timeline/transactions";
import type { Command, Sequence, TransactionOrigin } from "@/lib/timeline/types";
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
import { cases, directorCut, projectClips, refinedCut } from "./legacy-fixtures";
import { itemIdOf, moveCutaway, proposal, rippleRemove } from "./proposal-fixtures";

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
  command: "c",
  summary: "s",
  createdAt: "18:16",
  changes: [],
  timeline: directorCut,
  parentId: "v1",
};
const fresh = (): Workspace =>
  deepFreeze(workspaceFromVersions([structuredClone(baseline), structuredClone(director)]));
const seqOf = (ws: Workspace, v: string) => sequenceOf(ws, v, projectClips)!;

/** Commits `build` as one transaction of `origin` on the active version. */
function commit(
  ws: Workspace,
  active: string,
  origin: TransactionOrigin,
  build: (s: Sequence, ids: ReturnType<typeof seededIds>) => Command[],
  seed = `${origin}-${active}-${Math.random()}`,
) {
  const g = seededIds(seed);
  const out = dispatchTransaction(
    ws,
    active,
    makeTransaction(g, origin, origin, build(seqOf(ws, active), g)),
    {
      clips: projectClips,
      media,
      ids: g,
    },
  );
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return { ws: out.workspace, active: out.activeVersionId };
}
const move =
  (decisionId: string, delta: number) => (s: Sequence, g: ReturnType<typeof seededIds>) => [
    commands.move(g, [itemIdOf(s, decisionId)], delta) as unknown as Command,
  ];
const partnerOf = (s: Sequence, id: string) => {
  const it = s.items[id]!;
  return Object.values(s.items).find((i) => i.linkGroupId === it.linkGroupId && i.id !== id)!;
};
const reload = (ws: Workspace, active: string) => {
  const json = JSON.stringify(
    serializeWorkspace(ws, { ...SEL, activeVersionId: active }, "a", "", projectClips),
  );
  const back = parseSavedEditStateV2(JSON.parse(json), "a", projectClips)!;
  return { ws: back.workspace, warnings: back.warnings, json };
};

describe("durable ownership is stamped by every command", () => {
  it("untouched imports carry none; a manual edit marks the item AND its linked audio manual", () => {
    const s0 = importedSequence(director, projectClips);
    expect(
      Object.values(s0.items).every((i) => i.editedBy === undefined && !i.originTransactionId),
    ).toBe(true);
    const m = commit(fresh(), "v2", "manual", move("event-6", 4));
    const s = seqOf(m.ws, m.active);
    const e6 = itemIdOf(s, "event-6");
    expect([s.items[e6]!.editedBy, partnerOf(s, e6).editedBy]).toEqual(["manual", "manual"]);
    expect(s.items[itemIdOf(s, "event-1")]!.editedBy).toBeUndefined(); // untouched
  });

  it("ripple-shifted clips are stamped with the shifting transaction's ownership", () => {
    const m = commit(fresh(), "v2", "manual", (s, g) => [
      commands.rippleDelete(g, [itemIdOf(s, "event-5")]) as unknown as Command,
    ]);
    const s = seqOf(m.ws, m.active);
    for (const d of ["event-6", "event-7"])
      expect(s.items[itemIdOf(s, d)]!.editedBy, d).toBe("manual");
    expect(s.items[itemIdOf(s, "event-3")]!.editedBy).toBeUndefined();
  });

  it("Director-only edits are the Director's; manual is sticky; split pieces inherit the editor", () => {
    let st = commit(fresh(), "v2", "director", move("event-7", -2));
    expect(
      seqOf(st.ws, st.active).items[itemIdOf(seqOf(st.ws, st.active), "event-7")]!.editedBy,
    ).toBe("director");
    st = commit(st.ws, st.active, "manual", move("event-7", 1));
    expect(
      seqOf(st.ws, st.active).items[itemIdOf(seqOf(st.ws, st.active), "event-7")]!.editedBy,
    ).toBe("manual");
    // Once manual, the Director can't change it at all (engine-level).
    const s1 = st;
    expect(() => commit(s1.ws, s1.active, "director", move("event-7", 1))).toThrow(
      /edited by hand/,
    );
    let right = "";
    st = commit(st.ws, st.active, "manual", (s, g) => {
      const c = commands.split(g, s, itemIdOf(s, "event-1"), 100);
      right = c.params.rightItemIds[itemIdOf(s, "event-1")]!;
      return [c as unknown as Command];
    });
    const s = seqOf(st.ws, st.active);
    expect([s.items[itemIdOf(s, "event-1")]!.editedBy, s.items[right]!.editedBy]).toEqual([
      "manual",
      "manual",
    ]);
  });

  it("system transactions count as manual (fail closed)", () => {
    const st = commit(fresh(), "v2", "system", move("event-7", -2));
    expect(
      seqOf(st.ws, st.active).items[itemIdOf(seqOf(st.ws, st.active), "event-7")]!.editedBy,
    ).toBe("manual");
  });
});

describe("ownership survives save/reload, undo/redo and history truncation", () => {
  it("save → reload keeps ownership exactly", () => {
    const m = commit(fresh(), "v2", "manual", move("event-7", 2));
    const back = reload(m.ws, m.active);
    expect(back.warnings).toEqual([]);
    expect(JSON.parse(back.json).histories[m.active].provenance).toBe(1);
    expect(seqOf(back.ws, m.active)).toStrictEqual(seqOf(m.ws, m.active));
    const s = seqOf(back.ws, m.active);
    expect(s.items[itemIdOf(s, "event-7")]!.editedBy).toBe("manual");
  });

  it("undo restores the previous ownership; redo restores the edit's", () => {
    const m = commit(fresh(), "v2", "manual", move("event-7", 2));
    const id = itemIdOf(seqOf(m.ws, m.active), "event-7");
    const u = undoIn(m.ws, m.active);
    expect(seqOf(u, m.active).items[id]!.editedBy).toBeUndefined();
    expect(ownershipOf(u, m.active, projectClips)(id)).toBe("director");
    const r = redoIn(u, m.active);
    expect(seqOf(r, m.active).items[id]!.editedBy).toBe("manual");
    expect(ownershipOf(r, m.active, projectClips)(id)).toBe("manual");
  });

  it("a manual edit stays manual after 200+ later transactions and a reload", () => {
    let st = commit(fresh(), "v2", "manual", move("event-7", 2));
    for (let n = 0; n < 205; n += 1)
      st = commit(st.ws, st.active, "director", move("event-4", n % 2 ? 1 : -1), `d${n}`);
    const h = st.ws.histories[st.active]!;
    expect(h.past.some((e) => e.transaction.origin === "manual")).toBe(false); // gone from history
    const id = itemIdOf(seqOf(st.ws, st.active), "event-7");
    expect(ownershipOf(st.ws, st.active, projectClips)(id)).toBe("manual");
    const back = reload(st.ws, st.active);
    expect(back.warnings).toEqual([]);
    expect(ownershipOf(back.ws, st.active, projectClips)(id)).toBe("manual");
    const s = seqOf(back.ws, st.active);
    expect(
      reviewProposal(moveCutaway(st.active, s), {
        workspace: back.ws,
        activeVersionId: st.active,
        clips: projectClips,
        media,
      }).ok,
    ).toBe(false);
  });
});

describe("SetProtection", () => {
  const run = (
    seq: Sequence,
    origin: TransactionOrigin,
    cmds: (g: ReturnType<typeof seededIds>) => Command[],
  ) => {
    const g = seededIds(`p-${origin}`);
    return applyTransaction(seq, makeTransaction(g, "Protect", origin, cmds(g), "x"), { media });
  };
  const base = () => deepFreeze(importedSequence(director, projectClips));

  it("locks a clip and its linked audio, without stamping or changing ownership", () => {
    const s = base();
    const e6 = itemIdOf(s, "event-6");
    const out = run(s, "manual", (g) => [
      commands.setProtection(g, [e6], { locked: true }) as unknown as Command,
    ]);
    if (!out.ok) throw new Error(out.error.message);
    for (const id of [e6, partnerOf(s, e6).id]) {
      const it = out.sequence.items[id]!;
      expect(it.protection).toEqual({ locked: true, aiLocked: false });
      expect(it.editedBy).toBeUndefined();
      expect(it.originTransactionId).toBeUndefined();
    }
    expect(out.changedIds.sort()).toEqual([e6, partnerOf(s, e6).id].sort());
  });

  it("a locked clip refuses edits; the filmmaker can unlock it; lock + edit in one step is refused", () => {
    const s = base();
    const e7 = itemIdOf(s, "event-7");
    const locked = run(s, "manual", (g) => [
      commands.setProtection(g, [e7], { locked: true }) as unknown as Command,
    ]);
    if (!locked.ok) throw new Error("lock failed");
    const edit = run(locked.sequence, "manual", (g) => [
      commands.move(g, [e7], 2) as unknown as Command,
    ]);
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error.code).toBe("protected");
    const unlocked = run(locked.sequence, "manual", (g) => [
      commands.setProtection(g, [e7], { locked: false }) as unknown as Command,
    ]);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) expect(unlocked.sequence.items[e7]!.protection.locked).toBe(false);
    const both = run(locked.sequence, "manual", (g) => [
      commands.setProtection(g, [e7], { locked: false }) as unknown as Command,
      commands.move(g, [e7], 2) as unknown as Command,
    ]);
    expect(both.ok).toBe(false); // unlock first, edit separately
  });

  it("only the filmmaker can change protection; the Director and the system cannot", () => {
    const s = protect(base(), { itemId: itemIdOf(base(), "event-7") }, { aiLocked: true });
    const e7 = itemIdOf(s, "event-7");
    for (const origin of ["director", "system"] as const) {
      const out = run(s, origin, (g) => [
        commands.setProtection(g, [e7], { aiLocked: false }) as unknown as Command,
      ]);
      expect(out.ok, origin).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("protected");
    }
  });

  it("respects track protection, validates its params, and is a no-op when nothing changes", () => {
    const onLocked = protect(base(), { trackName: "V2" }, { locked: true });
    const e7 = itemIdOf(onLocked, "event-7");
    const r = run(onLocked, "manual", (g) => [
      commands.setProtection(g, [e7], { aiLocked: true }) as unknown as Command,
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/locked track/);
    const s = base();
    const bad = run(s, "manual", (g) => [
      commands.reserved(
        g,
        "SetProtection" as never,
        { itemIds: [itemIdOf(s, "event-7")] } as never,
      ) as unknown as Command,
    ]);
    expect(bad.ok).toBe(false);
    const same = run(s, "manual", (g) => [
      commands.setProtection(g, [itemIdOf(s, "event-7")], { locked: false }) as unknown as Command,
    ]);
    expect(same.ok && same.sequence).toBe(s);
  });

  it("is undoable, persists, and protects against proposals (locked and AI-locked)", () => {
    for (const p of [{ locked: true }, { aiLocked: true }]) {
      const st = commit(fresh(), "v2", "manual", (s, g) => [
        commands.setProtection(g, [itemIdOf(s, "event-7")], p) as unknown as Command,
      ]);
      const back = reload(st.ws, st.active);
      expect(back.warnings).toEqual([]);
      const s = seqOf(back.ws, st.active);
      const e7 = itemIdOf(s, "event-7");
      expect(s.items[e7]!.protection).toMatchObject(p);
      // Locking is not an edit: the clip is still the Director's material.
      expect(ownershipOf(back.ws, st.active, projectClips)(e7)).toBe("director");
      const r = reviewProposal(moveCutaway(st.active, s), {
        workspace: back.ws,
        activeVersionId: st.active,
        clips: projectClips,
        media,
      });
      expect(r.ok ? [] : r.issues.map((i) => i.code), JSON.stringify(p)).toEqual(["protected"]);
      const undone = undoIn(back.ws, st.active);
      expect(seqOf(undone, st.active).items[e7]!.protection).toEqual({
        locked: false,
        aiLocked: false,
      });
    }
  });

  it("ripple operations never move protected material — by hand or by proposal", () => {
    // By hand: rippling event 5 out would shift the locked event 6.
    const s = protect(base(), { itemId: itemIdOf(base(), "event-6") }, { locked: true });
    const manual = run(s, "manual", (g) => [
      commands.rippleDelete(g, [itemIdOf(s, "event-5")]) as unknown as Command,
    ]);
    expect(manual.ok).toBe(false);
    // By proposal: event 7 is AI-locked on a working version; rippling event 5
    // out would shift it, so the proposal is refused.
    const ai = protect(base(), { itemId: itemIdOf(base(), "event-7") }, { aiLocked: true });
    const ws = deepFreeze({
      versions: [
        structuredClone(baseline),
        structuredClone(director),
        { ...structuredClone(director), id: "ver_p", kind: "edited" as const, parentId: "v2" },
      ],
      histories: { ver_p: createHistory(ai) },
    } as Workspace);
    const r = reviewProposal(rippleRemove("ver_p", ai), {
      workspace: ws,
      activeVersionId: "ver_p",
      clips: projectClips,
      media,
    });
    expect(r.ok ? [] : r.issues.map((x) => x.code)).toEqual(["protected"]);
    if (!r.ok) expect(r.issues[0]!.itemIds).toEqual([itemIdOf(ai, "event-7")]);
  });
});

describe("compatibility", () => {
  it("imported beta.1 cuts: no ownership recorded, all the Director's, proposals allowed", () => {
    for (const { name, timeline, clips } of cases) {
      const s = legacyToSequence(timeline, clips, { scope: name });
      expect(
        Object.values(s.items).every((i) => i.editedBy === undefined),
        name,
      ).toBe(true);
    }
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const own = ownershipOf(ws, "v2", projectClips);
    expect(Object.keys(s.items).every((id) => own(id) === "director")).toBe(true);
    expect(
      reviewProposal(moveCutaway("v2", s), {
        workspace: ws,
        activeVersionId: "v2",
        clips: projectClips,
        media,
      }).ok,
    ).toBe(true);
  });

  it("an existing (pre-ownership) schema-2 project loads with its undo history and keeps manual protection", () => {
    const st = commit(fresh(), "v2", "manual", move("event-7", 2));
    const saved = JSON.parse(
      JSON.stringify(
        serializeWorkspace(st.ws, { ...SEL, activeVersionId: st.active }, "a", "", projectClips),
      ),
    );
    const h = saved.histories[st.active];
    delete h.provenance;
    for (const it of Object.values(h.present.items as Record<string, unknown>))
      if (it && typeof it === "object") delete (it as { editedBy?: unknown }).editedBy;
    const back = parseSavedEditStateV2(saved, "a", projectClips)!;
    expect(back.warnings).toEqual([]); // history kept, not dropped
    const s = seqOf(back.workspace, st.active);
    const e7 = itemIdOf(s, "event-7");
    expect(back.workspace.histories[st.active]!.past).toHaveLength(1);
    expect(s.items[e7]!.editedBy).toBe("manual"); // re-derived by replay
    expect(ownershipOf(back.workspace, st.active, projectClips)(e7)).toBe("manual");
    // With its history lost, the same project refuses rather than trusting it.
    h.past[0].commands[0].params.deltaFrames = 999;
    const lost = parseSavedEditStateV2(saved, "a", projectClips)!;
    expect(lost.warnings.join(" ")).toMatch(/could not be fully restored/);
    expect(ownershipOf(lost.workspace, st.active, projectClips)(e7)).toBe("unknown");
    expect(
      reviewProposal(moveCutaway(st.active, s), {
        workspace: lost.workspace,
        activeVersionId: st.active,
        clips: projectClips,
        media,
      }).ok,
    ).toBe(false);
  });

  it("untouched sequences export byte-identically — also after locking clips", () => {
    const exportsOf = (tl: UniversalTimeline) => {
      const { usable } = validateTimelineForExport(tl, projectClips);
      return {
        xmeml: buildXmeml(tl, usable, projectClips, "/Media").xml,
        edl: buildCmx3600Edl(tl, usable, projectClips),
        fcpxml: buildFcpxml(tl, usable, projectClips, "/Media").xml,
      };
    };
    const original = exportsOf(directorCut);
    const s = importedSequence(director, projectClips);
    expect(exportsOf(sequenceToLegacy(s).timeline)).toStrictEqual(original);
    const st = commit(fresh(), "v2", "manual", (sq, g) => [
      commands.setProtection(g, [itemIdOf(sq, "event-7"), itemIdOf(sq, "event-1")], {
        locked: true,
      }) as unknown as Command,
    ]);
    expect(exportsOf(sequenceToLegacy(seqOf(st.ws, st.active)).timeline)).toStrictEqual(original);
    expect(sequenceToLegacy(seqOf(st.ws, st.active)).timeline).toStrictEqual(directorCut);
  });

  it("proposal fixtures still compile with the new command in the engine", () => {
    const ws = fresh();
    const s = seqOf(ws, "v2");
    expect(
      reviewProposal(
        proposal("v2", s, [{ op: "move", itemIds: [itemIdOf(s, "event-7")], deltaFrames: -1 }]),
        {
          workspace: ws,
          activeVersionId: "v2",
          clips: projectClips,
          media,
        },
      ).ok,
    ).toBe(true);
  });
});

describe("engine-level Director protection (no proposal layer involved)", () => {
  // Direct engine calls — applyTransaction / dispatchTransaction — exactly as
  // any future caller could make them. The proposal layer is not involved.
  const engineRun = (
    seq: Sequence,
    origin: TransactionOrigin,
    cmds: (g: ReturnType<typeof seededIds>) => Command[],
  ) => {
    const g = seededIds(`eng-${origin}`);
    return applyTransaction(seq, makeTransaction(g, "direct", origin, cmds(g), "x"), { media });
  };
  /** The Director cut with event 6 (and its linked A1) edited by hand. */
  const withManual = () => {
    const m = commit(fresh(), "v2", "manual", move("event-6", 4), "manual-e6");
    return { ...m, seq: deepFreeze(seqOf(m.ws, m.active)) };
  };
  const C = (c: unknown) => c as Command;

  it("refuses every Director command on a manual clip — directly, via linked audio, ripple shift or split", () => {
    const { seq } = withManual();
    const e6 = itemIdOf(seq, "event-6");
    const a6 = partnerOf(seq, e6).id;
    const attempts: Array<[string, (g: ReturnType<typeof seededIds>) => Command[]]> = [
      ["move", (g) => [C(commands.move(g, [e6], 2))]],
      ["move linked A1 only", (g) => [C(commands.move(g, [a6], 2))]],
      ["trim", (g) => [C(commands.trim(g, e6, "out", -6))]],
      ["trim linked A1 only", (g) => [C(commands.trim(g, a6, "in", 6))]],
      ["split", (g) => [C(commands.split(g, seq, e6, seq.items[e6]!.startFrame + 24))]],
      ["lift", (g) => [C(commands.delete(g, [e6]))]],
      ["ripple delete", (g) => [C(commands.rippleDelete(g, [e6]))]],
      // Indirect: rippling out event 5 would shift the manual event 6.
      ["ripple shift", (g) => [C(commands.rippleDelete(g, [itemIdOf(seq, "event-5")]))]],
    ];
    for (const [name, build] of attempts) {
      const out = engineRun(seq, "director", build);
      expect(out.ok, name).toBe(false);
      if (!out.ok) expect(out.error.code, name).toBe("protected");
    }
    // The same edits are fine for the filmmaker (subject to locks).
    expect(engineRun(seq, "manual", (g) => [C(commands.trim(g, e6, "out", -6))]).ok).toBe(true);
    // The filmmaker may ripple through their own edits (it shifts event 6 and
    // the cutaway over it) — exactly what the Director was refused above.
    expect(
      engineRun(seq, "manual", (g) => [C(commands.rippleDelete(g, [itemIdOf(seq, "event-5")]))]).ok,
    ).toBe(true);
    expect(engineRun(seq, "system", (g) => [C(commands.move(g, [e6], 2))]).ok).toBe(true);
  });

  it("ReplaceAssembly from the Director keeps manual clips — and refuses an assembly that would overwrite one", () => {
    const { seq } = withManual();
    const e6 = itemIdOf(seq, "event-6");
    const a6 = partnerOf(seq, e6).id;
    // A full Director rebuild over the cut: every unprotected clip is replaced,
    // but it would land on top of the hand-edited event 6 → refused, atomically.
    const g = seededIds("rebuild");
    const rebuild = engineRun(seq, "director", () => [
      C(commands.replaceAssembly(g, assemblyFromLegacy(seq, refinedCut, projectClips, g))),
    ]);
    expect(rebuild.ok).toBe(false);
    if (!rebuild.ok) expect(["invariant", "protected"]).toContain(rebuild.error.code);
    // An assembly that fits around it: the manual clip and its audio survive untouched.
    const small: UniversalTimeline = {
      ...directorCut,
      decisions: directorCut.decisions.slice(0, 2),
    };
    const g2 = seededIds("small");
    const fits = engineRun(seq, "director", () => [
      C(commands.replaceAssembly(g2, assemblyFromLegacy(seq, small, projectClips, g2))),
    ]);
    expect(fits.ok).toBe(true);
    if (fits.ok) {
      expect(fits.sequence.items[e6]).toBe(seq.items[e6]);
      expect(fits.sequence.items[a6]).toBe(seq.items[a6]);
      expect(fits.changedIds).not.toContain(e6);
    }
    // An assembly item reusing the manual clip's id is refused outright.
    const g3 = seededIds("clash");
    const params = assemblyFromLegacy(seq, small, projectClips, g3);
    params.items[0] = { ...params.items[0]!, id: e6 };
    const clash = engineRun(seq, "director", () => [C(commands.replaceAssembly(g3, params))]);
    expect(clash.ok).toBe(false);
  });

  it("unknown ownership — and pre-ownership edits — are protected the same way", () => {
    const base = importedSequence(director, projectClips);
    const e7 = itemIdOf(base, "event-7");
    const variants: Array<[string, Partial<Sequence["items"][string]>]> = [
      ["unknown", { editedBy: "unknown", originTransactionId: "txn_x" }],
      ["pre-ownership edit", { originTransactionId: "txn_old" }],
    ];
    for (const [name, patch] of variants) {
      const seq = deepFreeze({
        ...base,
        items: { ...base.items, [e7]: { ...base.items[e7]!, ...patch } },
      });
      const out = engineRun(seq, "director", (g) => [C(commands.move(g, [e7], -2))]);
      expect(out.ok, name).toBe(false);
      expect(engineRun(seq, "manual", (g) => [C(commands.move(g, [e7], -2))]).ok, name).toBe(true);
    }
  });

  it("Director assembly creation from unmodified footage, and Director-only material, still work", () => {
    const seq = deepFreeze(importedSequence(director, projectClips));
    const g = seededIds("fresh-rebuild");
    const rebuild = engineRun(seq, "director", () => [
      C(commands.replaceAssembly(g, assemblyFromLegacy(seq, refinedCut, projectClips, g))),
    ]);
    expect(rebuild.ok).toBe(true);
    let st = commit(fresh(), "v2", "director", move("event-7", -2), "d1");
    st = commit(st.ws, st.active, "director", move("event-7", -2), "d2"); // its own edit again
    expect(
      seqOf(st.ws, st.active).items[itemIdOf(seqOf(st.ws, st.active), "event-7")]!.editedBy,
    ).toBe("director");
  });

  it("locks are unchanged: locked stops everyone, aiLocked only the Director", () => {
    const base = importedSequence(director, projectClips);
    const e7 = itemIdOf(base, "event-7");
    const locked = protect(base, { itemId: e7 }, { locked: true });
    const ai = protect(base, { itemId: e7 }, { aiLocked: true });
    expect(engineRun(locked, "manual", (g) => [C(commands.move(g, [e7], -2))]).ok).toBe(false);
    expect(engineRun(locked, "director", (g) => [C(commands.move(g, [e7], -2))]).ok).toBe(false);
    expect(engineRun(ai, "director", (g) => [C(commands.move(g, [e7], -2))]).ok).toBe(false);
    expect(engineRun(ai, "manual", (g) => [C(commands.move(g, [e7], -2))]).ok).toBe(true);
  });

  it("a refused Director transaction is atomic: no fork, no history, nothing persisted changes", () => {
    const m = withManual();
    const before = JSON.stringify(
      serializeWorkspace(m.ws, { ...SEL, activeVersionId: m.active }, "a", "", projectClips),
    );
    const g = seededIds("atomic");
    const txn = makeTransaction(g, "Director", "director", [
      C(commands.move(g, [itemIdOf(m.seq, "event-4")], -2)), // fine on its own
      C(commands.move(g, [itemIdOf(m.seq, "event-6")], 2)), // manual → refused
    ]);
    const out = dispatchTransaction(m.ws, m.active, txn, { clips: projectClips, media, ids: g });
    expect(out.ok).toBe(false);
    expect(m.ws.histories[m.active]!.past).toHaveLength(1); // only the manual edit
    expect(seqOf(m.ws, m.active)).toBe(m.seq);
    expect(
      JSON.stringify(
        serializeWorkspace(m.ws, { ...SEL, activeVersionId: m.active }, "a", "", projectClips),
      ),
    ).toBe(before);
    // On an untouched Director version: no fork is created either.
    const ws = fresh();
    const s = seqOf(ws, "v2");
    const bad = makeTransaction(g, "Director", "director", [
      C(commands.move(g, [itemIdOf(s, "event-1")], 24)),
    ]);
    expect(dispatchTransaction(ws, "v2", bad, { clips: projectClips, media, ids: g }).ok).toBe(
      false,
    );
    expect(ws.versions).toHaveLength(2);
  });
});
