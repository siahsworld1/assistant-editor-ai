// Phase 6, Milestone 2 — the `reorder` proposal operation
// (src/lib/timeline/proposals.ts), compiled 1:1 to ReorderEdit. Reviewed,
// previewed and accepted exactly like every other proposal: the same
// existence, protection, ownership and dry-run checks, one Director
// transaction on accept, nothing on reject.
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 (inside e3) · e7 708–784 (inside e6)
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion } from "@/lib/ae/types";
import { buildCmx3600Edl, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml } from "@/lib/nle/xmeml";
import { commands } from "@/lib/timeline/commands";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import {
  acceptProposal,
  rejectProposal,
  reviewProposal,
  type ProposalContext,
} from "@/lib/timeline/proposals";
import { endFrame, itemsOnTrack } from "@/lib/timeline/selectors";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Command, Sequence } from "@/lib/timeline/types";
import {
  derivedTimeline,
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
const director: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.1",
  command: "c",
  summary: "s",
  createdAt: "—",
  changes: [],
  timeline: directorCut,
};
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const ctxOf = (ws: Workspace, active = "v2"): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});
const seqOf = (ws: Workspace, v = "v2") => sequenceOf(ws, v, projectClips)!;
const ids = (s: Sequence, ...names: string[]) => names.map((n) => itemIdOf(s, n));
const reorderP = (ws: Workspace, order: string[], v = "v2", extra = {}) =>
  proposal(v, seqOf(ws, v), [{ op: "reorder", itemIds: order }], {
    id: "prp_reorder",
    instruction: "Play these in a new order",
    summary: "Reorders interview clips.",
    ...extra,
  });
const codes = (r: ReturnType<typeof reviewProposal>) => (r.ok ? [] : r.issues.map((i) => i.code));
const engine = (r: ReturnType<typeof reviewProposal>) =>
  r.ok ? [] : r.issues.map((i) => i.engineCode ?? null);
const span = (s: Sequence, id: string) => [s.items[id]!.startFrame, endFrame(s.items[id]!)];
const partnerOf = (s: Sequence, id: string) =>
  Object.values(s.items).find(
    (i) => i.linkGroupId && i.linkGroupId === s.items[id]!.linkGroupId && i.id !== id,
  )!.id;

/** A working version whose sequence was changed directly (test setup only). */
function workingWith(change: (s: Sequence) => Sequence): Workspace {
  const seq = change(importedSequence(director, projectClips));
  return deepFreeze({
    versions: [
      structuredClone(director),
      { ...structuredClone(director), id: "ver_w", kind: "edited" as const, parentId: "v2" },
    ],
    histories: { ver_w: createHistory(seq) },
  } as Workspace);
}
const edited = (s: Sequence, fn: (n: Sequence) => void) => {
  const n = structuredClone(s) as Sequence;
  fn(n);
  return deepFreeze(n);
};

describe("valid reorder proposals", () => {
  it("two clips: reviewed, previewed in memory, linked audio in sync", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const [e1, e2] = ids(s, "event-1", "event-2");
    const r = reviewProposal(reorderP(ws, [e2!, e1!]), ctxOf(ws));
    expect(r.ok, JSON.stringify(codes(r))).toBe(true);
    if (!r.ok) return;
    expect([span(r.preview, e2!), span(r.preview, e1!)]).toEqual([
      [0, 168],
      [168, 408],
    ]);
    for (const id of [e1!, e2!])
      expect(span(r.preview, partnerOf(s, id))).toEqual(span(r.preview, id));
    expect(r.changedIds.sort()).toEqual([e1!, e2!, partnerOf(s, e1!), partnerOf(s, e2!)].sort());
    expect(findViolations(r.preview, { media })).toEqual([]);
    // Nothing was written.
    expect(seqOf(ws)).toBe(s);
  });

  it("several clips, with a cutaway wholly inside one of them carried along", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const order = ids(s, "event-6", "event-5", "event-3", "event-2", "event-1");
    const r = reviewProposal(reorderP(ws, order), ctxOf(ws));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(order.map((id) => span(r.preview, id))).toEqual([
      [0, 96],
      [96, 240],
      [240, 384],
      [384, 552],
      [552, 792],
    ]);
    expect(span(r.preview, itemIdOf(s, "event-7"))).toEqual([12, 88]);
    expect(span(r.preview, itemIdOf(s, "event-4"))).toEqual([252, 364]);
    expect(r.changedIds).toContain(itemIdOf(s, "event-7"));
  });
});

describe("refused reorder proposals — with a reason, never converted into something else", () => {
  it.each<[string, (s: Sequence) => unknown[], string]>([
    ["a single clip", (s) => ids(s, "event-1"), "malformed"],
    ["a duplicate id", (s) => ids(s, "event-1", "event-2", "event-1"), "malformed"],
    ["an empty list", () => [], "malformed"],
    ["a malformed id", (s) => [...ids(s, "event-1"), "../x"], "malformed"],
  ])("%s: not a valid proposal", (_n, order, code) => {
    const ws = fresh();
    const r = reviewProposal(reorderP(ws, order(seqOf(ws)) as string[]), ctxOf(ws));
    expect(codes(r)).toEqual([code]);
  });

  it("an invented id: unknown clip", () => {
    const ws = fresh();
    const [e1] = ids(seqOf(ws), "event-1");
    const r = reviewProposal(reorderP(ws, ["itm_invented", e1!]), ctxOf(ws));
    expect(codes(r)).toEqual(["unknown-item"]);
  });

  it("clips that aren't back to back, or are on two tracks: refused by the timeline rules", () => {
    const ws = fresh();
    const s = seqOf(ws);
    for (const order of [ids(s, "event-3", "event-1"), ids(s, "event-3", "event-4")]) {
      const r = reviewProposal(reorderP(ws, order), ctxOf(ws));
      expect(codes(r)).toEqual(["engine-rejected"]);
      expect(engine(r)).toEqual(["invalid-params"]);
    }
  });

  it("extra fields or self-authorization on the operation are refused", () => {
    const ws = fresh();
    const order = ids(seqOf(ws), "event-2", "event-1");
    for (const [extra, code] of [
      [{ deltaFrames: 5 }, "malformed"],
      [{ force: true }, "self-authorization"],
    ] as const) {
      const p = proposal("v2", seqOf(ws), [{ op: "reorder", itemIds: order, ...extra }]);
      expect(codes(reviewProposal(p, ctxOf(ws)))).toContain(code);
    }
  });

  it("B-roll across a cut in the run: refused with that footage named — not removed, not moved", () => {
    const e4 = itemIdOf(importedSequence(director, projectClips), "event-4");
    const ws = workingWith((s) =>
      edited(s, (n) => {
        n.items[e4]!.startFrame = 396; // across the e2/e3 cut
      }),
    );
    const s = seqOf(ws, "ver_w");
    const r = reviewProposal(
      reorderP(ws, ids(s, "event-3", "event-2"), "ver_w"),
      ctxOf(ws, "ver_w"),
    );
    expect(codes(r)).toEqual(["engine-rejected"]);
    expect(engine(r)).toEqual(["reorder-blocked"]);
    if (!r.ok) {
      expect(r.issues[0]!.itemIds).toEqual([e4]);
      expect(r.issues[0]!.message).toMatch(/remove or move it first/);
    }
    expect(seqOf(ws, "ver_w")).toBe(s);
    // Only an explicit, visible removal in the same proposal makes it possible.
    const explicit = proposal("ver_w", s, [
      { op: "remove", itemIds: [e4], ripple: false },
      { op: "reorder", itemIds: ids(s, "event-3", "event-2") },
    ]);
    const ok = reviewProposal(explicit, ctxOf(ws, "ver_w"));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.preview.items[e4]).toBeUndefined();
  });

  it("AI-protected or locked clips and tracks, linked audio and carried cutaways included", () => {
    const base = importedSequence(director, projectClips);
    const [e5, e6, e7] = ids(base, "event-5", "event-6", "event-7");
    const cases: Array<[string, Sequence]> = [
      ["aiLocked clip", protect(base, { itemId: e5! }, { aiLocked: true })],
      ["locked clip", protect(base, { itemId: e6! }, { locked: true })],
      [
        "aiLocked linked audio",
        protect(base, { itemId: partnerOf(base, e6!) }, { aiLocked: true }),
      ],
      ["aiLocked V1 track", protect(base, { trackName: "V1" }, { aiLocked: true })],
      ["locked carried cutaway", protect(base, { itemId: e7! }, { locked: true })],
    ];
    for (const [name, seq] of cases) {
      const ws = workingWith(() => seq);
      const r = reviewProposal(reorderP(ws, [e6!, e5!], "ver_w"), ctxOf(ws, "ver_w"));
      expect(codes(r), name).toEqual(["protected"]);
    }
  });

  it("hand-edited or unverifiable clips — named, linked or carried — are never moved", () => {
    const base = importedSequence(director, projectClips);
    const [e5, e6, e7] = ids(base, "event-5", "event-6", "event-7");
    const cases: Array<[string, string, string]> = [
      ["hand-edited clip", e5!, "manual-conflict"],
      ["hand-edited linked audio", partnerOf(base, e6!), "manual-conflict"],
      ["hand-edited carried cutaway", e7!, "manual-conflict"],
    ];
    for (const [name, id, code] of cases) {
      const ws = workingWith((s) =>
        edited(s, (n) => {
          n.items[id]!.editedBy = "manual";
        }),
      );
      const r = reviewProposal(reorderP(ws, [e6!, e5!], "ver_w"), ctxOf(ws, "ver_w"));
      expect(codes(r), name).toContain(code);
    }
    const unknown = workingWith((s) =>
      edited(s, (n) => {
        n.items[e5!]!.editedBy = "unknown";
      }),
    );
    expect(
      codes(reviewProposal(reorderP(unknown, [e6!, e5!], "ver_w"), ctxOf(unknown, "ver_w"))),
    ).toContain("ownership-unknown");
  });

  it("a hand edit in the working version's history refuses the Director's reorder", () => {
    const ws = fresh();
    const g = seededIds("hand");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Trim", "manual", [
        commands.trim(g, itemIdOf(seqOf(ws), "event-5"), "out", -2) as unknown as Command,
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    const s = seqOf(out.workspace, out.activeVersionId);
    // e5 is now 2 frames short: e5/e6 aren't back to back, so swap e1/e2 instead
    // — fine — and e2/e3 with e5 involved is refused for ownership.
    const okR = reviewProposal(
      reorderP(out.workspace, ids(s, "event-2", "event-1"), out.activeVersionId),
      ctxOf(out.workspace, out.activeVersionId),
    );
    expect(okR.ok).toBe(true);
    const r = reviewProposal(
      reorderP(out.workspace, ids(s, "event-5", "event-3"), out.activeVersionId),
      ctxOf(out.workspace, out.activeVersionId),
    );
    expect(codes(r)).toContain("manual-conflict");
  });

  it("stale: the cut changed after the proposal was made", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const p = reorderP(ws, ids(s, "event-2", "event-1"));
    const g = seededIds("later");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Nudge", "manual", [
        commands.move(g, [itemIdOf(s, "event-7")], 1) as unknown as Command,
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    expect(codes(reviewProposal(p, ctxOf(out.workspace, out.activeVersionId)))).toEqual(["stale"]);
  });
});

describe("accept, reject, undo, persistence, export", () => {
  it("accept = ONE Director transaction equal to the preview; reject changes nothing", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const p = reorderP(ws, ids(s, "event-5", "event-2", "event-3"));
    const r = reviewProposal(p, ctxOf(ws));
    if (!r.ok) throw new Error("review failed");

    expect(rejectProposal(ws)).toBe(ws);

    const out = acceptProposal(p, { ...ctxOf(ws), ids: seededIds("acc"), now: "19:00" });
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    expect(out.forkedFrom).toBe("v2");
    const w = out.activeVersionId;
    const history = out.workspace.histories[w]!;
    expect(history.past).toHaveLength(1);
    expect(history.past[0]!.transaction.origin).toBe("director");
    expect(history.past[0]!.transaction.commands.map((c) => c.type)).toEqual(["ReorderEdit"]);
    const after = seqOf(out.workspace, w);
    const strip = (q: Sequence) =>
      Object.values(q.items).map(({ originTransactionId: _t, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(r.preview));
    expect(after.items[itemIdOf(s, "event-5")]!.editedBy).toBe("director");
    expect(seqOf(out.workspace, "v2")).toStrictEqual(s); // the Director version is untouched

    // Undo / redo.
    expect(seqOf(undoIn(out.workspace, w), w)).toStrictEqual(s);
    expect(seqOf(redoIn(undoIn(out.workspace, w), w), w)).toStrictEqual(after);

    // Save → reload → same cut, same undo.
    const json = JSON.stringify(
      serializeWorkspace(
        out.workspace,
        { activeVersionId: w, chosenStoryId: null, targetSeconds: 30, storyboardSelectIds: [] },
        "analysis-A",
        "",
        projectClips,
      ),
    );
    const restored = parseSavedEditStateV2(JSON.parse(json), "analysis-A", projectClips)!;
    expect(seqOf(restored.workspace, w)).toStrictEqual(after);
    expect(seqOf(undoIn(restored.workspace, w), w)).toStrictEqual(s);

    // Exports play the new order.
    const timeline = derivedTimeline(after);
    const { usable } = validateTimelineForExport(timeline, projectClips);
    expect(usable).toHaveLength(timeline.decisions.length);
    expect(buildXmeml(timeline, usable, projectClips, "/Media").xml).toContain("<xmeml");
    expect(buildCmx3600Edl(timeline, usable, projectClips)).toContain("TITLE:");
    const v1 = itemsOnTrack(after, after.tracks.find((t) => t.name === "V1")!.id).map(
      (i) => i.legacy?.decision.id,
    );
    expect(v1).toEqual(["event-1", "event-5", "event-2", "event-3", "event-6"]);
  });

  it("an accepted reorder that went stale is refused at accept time", () => {
    const ws = fresh();
    const s = seqOf(ws);
    const p = reorderP(ws, ids(s, "event-2", "event-1"));
    const first = acceptProposal(p, { ...ctxOf(ws), ids: seededIds("a1") });
    if (!first.ok) throw new Error("first accept failed");
    const again = acceptProposal(p, {
      ...ctxOf(first.workspace, first.activeVersionId),
      ids: seededIds("a2"),
    });
    expect(again.ok ? [] : again.issues.map((i) => i.code)).toEqual(["stale"]);
  });
});

describe("compatibility with existing operations", () => {
  it("move, trim and remove proposals review exactly as before", () => {
    const ws = fresh();
    const s = seqOf(ws);
    for (const p of [moveCutaway("v2", s), trimOut("v2", s), rippleRemove("v2", s)])
      expect(reviewProposal(p, ctxOf(ws)).ok, String(p["id"])).toBe(true);
  });

  it("other still-unsupported operations are refused by name", () => {
    const ws = fresh();
    const s = seqOf(ws);
    for (const op of ["split", "insert", "replaceAssembly", "rippleTrim"]) {
      const r = reviewProposal(proposal("v2", s, [{ op }]), ctxOf(ws));
      expect(codes(r)).toEqual(["unsupported-operation"]);
    }
  });
});

/* ------------------------------ real projects ------------------------------ */

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("a reorder proposal on every saved version: accepted and undone exactly, or refused with a reason — files untouched", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips: Clip[] = rows.map((c: { id: string; fps: number; duration_seconds: number }) =>
        clip(c.id, c.fps, c.duration_seconds),
      );
      const realMedia = mediaOf(clips);
      let tried = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const s = sequenceOf(ws, v.id, clips)!;
          const v1 = s.tracks.find((t) => t.name === "V1");
          const items = v1 ? itemsOnTrack(s, v1.id) : [];
          const pair = items.slice(1).find((b, n) => b.startFrame === endFrame(items[n]!));
          if (!pair) continue;
          const a = items[items.indexOf(pair) - 1]!;
          tried += 1;
          const ctx: ProposalContext = {
            workspace: ws,
            activeVersionId: v.id,
            clips,
            media: realMedia,
          };
          const p = proposal(v.id, s, [{ op: "reorder", itemIds: [pair.id, a.id] }]);
          const r = reviewProposal(p, ctx);
          if (!r.ok) {
            expect(r.issues.every((i) => i.code !== "malformed")).toBe(true);
            continue;
          }
          const out = acceptProposal(p, { ...ctx, ids: seededIds("real") });
          if (!out.ok) throw new Error(JSON.stringify(out.issues));
          const w = out.activeVersionId;
          expect(out.workspace.histories[w]!.past).toHaveLength(1);
          expect(sequenceOf(undoIn(out.workspace, w), w, clips)).toStrictEqual(s);
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(tried).toBeGreaterThan(0);
    });
  },
);
