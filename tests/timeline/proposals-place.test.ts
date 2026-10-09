import { describe, expect, it } from "vitest";
import type { EditVersion } from "@/lib/ae/types";
import { seededIds } from "@/lib/timeline/ids";
import {
  acceptProposal,
  parseProposal,
  reviewProposal,
  type ProposalContext,
  type ProposalOp,
} from "@/lib/timeline/proposals";
import { sequenceToLegacy } from "@/lib/timeline/legacy-adapter";
import { rateFromFps } from "@/lib/timeline/time";
import {
  parseSavedEditStateV2,
  sequenceOf,
  serializeWorkspace,
  undoIn,
  redoIn,
  workspaceFromVersions,
} from "@/lib/timeline/workspace";
import { createHistory } from "@/lib/timeline/history";
import { deepFreeze, mediaOf, protect, track } from "./engine-helpers";
import { directorCut, projectClips } from "./legacy-fixtures";
import { proposal } from "./proposal-fixtures";

const version: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.2",
  command: "build",
  summary: "",
  createdAt: "fixed",
  changes: [],
  timeline: directorCut,
};
const fresh = (): ProposalContext => ({
  workspace: workspaceFromVersions([version]),
  activeVersionId: version.id,
  clips: projectClips,
  media: mediaOf(projectClips),
  analysis: {
    visualIds: new Set(["visual-real"]),
    selectIds: new Set(),
    transcriptIds: new Set(["line-real"]),
  },
});
const seq = (ctx: ProposalContext) => sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips)!;
const placement = (ctx: ProposalContext): Extract<ProposalOp, { op: "place" }> => ({
  op: "place",
  mediaClipId: "clip-005",
  trackId: track(seq(ctx), "V2").id,
  sourceInFrame: 24,
  sourceOutFrame: 84,
  startFrame: 216,
  label: "Park cutaway",
});
const p = (ctx: ProposalContext, ops: unknown[] = [placement(ctx)]) =>
  proposal(ctx.activeVersionId, seq(ctx), ops, {
    rationale: [
      {
        opIndex: 0,
        reason: "Illustrates the interview context",
        evidence: [
          { kind: "visual", id: "visual-real" },
          { kind: "transcript", id: "line-real" },
        ],
      },
    ],
  });

function withSeq(ctx: ProposalContext, s: ReturnType<typeof seq>) {
  return {
    ...ctx,
    workspace: { ...ctx.workspace, histories: { [ctx.activeVersionId]: createHistory(s) } },
  };
}

describe("picture-only placement proposals", () => {
  it("strictly parses a place op including zero start and source in, while refusing unsupported insert", () => {
    const ctx = fresh();
    expect(parseProposal(p(ctx, [{ ...placement(ctx), startFrame: 0, sourceInFrame: 0 }])).ok).toBe(
      true,
    );
    const r = parseProposal(p(ctx, [{ op: "insert" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe("unsupported-operation");
  });

  it.each([
    { startFrame: -1 },
    { startFrame: 1.2 },
    { startFrame: 5_184_001 },
    { sourceInFrame: -1 },
    { sourceOutFrame: 24 },
    { sourceOutFrame: Infinity },
    { mediaClipId: "" },
    { trackId: "" },
    { label: "" },
    { label: "x".repeat(2001) },
    { itemId: "injected-id" },
    { mediaRate: rateFromFps(1000) },
    { linkedAudio: true },
    { durationFrames: 1 },
    { allowProtected: true },
    { override: true },
  ])("rejects malformed or self-authorizing placements %j", (patch) => {
    const ctx = fresh();
    expect(reviewProposal(p(ctx, [{ ...placement(ctx), ...patch }]), ctx).ok).toBe(false);
  });

  it("previews without mutation and derives media rate locally; ids match acceptance exactly", () => {
    const ctx = fresh();
    const before = deepFreeze(seq(ctx));
    const raw = p(ctx);
    const reviewed = reviewProposal(raw, ctx);
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(seq(ctx)).toEqual(before);
    expect(ctx.workspace.histories).toEqual({});
    expect(reviewed.changedIds).toHaveLength(1);
    const id = reviewed.changedIds[0]!;
    expect(reviewed.preview.items[id]).toMatchObject({
      mediaRate: rateFromFps(23.976),
      editedBy: "director",
    });
    expect(reviewed.preview.items[id]!.linkGroupId).toBeUndefined();
    for (const existing of Object.keys(before.items))
      expect(reviewed.preview.items[existing]).toBe(before.items[existing]);
    const again = reviewProposal(raw, ctx);
    expect(again.ok && again.changedIds).toEqual(reviewed.changedIds);
    const accepted = acceptProposal(raw, { ...ctx, ids: seededIds("accept") });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const after = sequenceOf(accepted.workspace, accepted.activeVersionId, projectClips)!;
    expect(Object.keys(after.items)).toEqual(Object.keys(reviewed.preview.items));
    const strip = (s: typeof before) =>
      Object.values(s.items).map(({ originTransactionId: _t, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(reviewed.preview));
    expect(sequenceToLegacy(after).timeline).toEqual(sequenceToLegacy(reviewed.preview).timeline);
    expect(after.links).toEqual(before.links);
  });

  it("rejects missing project media, unbounded sources, unknown tracks, V1/audio placement, and overlap", () => {
    const ctx = fresh();
    for (const patch of [
      { mediaClipId: "unknown" },
      { sourceOutFrame: 1000 },
      { trackId: "unknown" },
      { trackId: track(seq(ctx), "V1").id },
      { trackId: track(seq(ctx), "A1").id },
      { startFrame: 421 },
    ])
      expect(reviewProposal(p(ctx, [{ ...placement(ctx), ...patch }]), ctx).ok).toBe(false);
    expect(reviewProposal(p(ctx), { ...ctx, media: undefined }).ok).toBe(false);
  });

  it("refuses locked/AI-locked destinations and invalid evidence", () => {
    const ctx = fresh();
    for (const protection of [{ locked: true }, { aiLocked: true }]) {
      const locked = withSeq(ctx, protect(seq(ctx), { trackName: "V2" }, protection));
      const r = reviewProposal(p(locked), locked);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]!.code).toBe("protected");
    }
    const missing = reviewProposal(p(ctx), { ...ctx, analysis: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]!.code).toBe("unverifiable-evidence");
  });

  it("multiple placements accept atomically as one undo step and survive save/reload/redo", () => {
    const ctx = fresh();
    const before = seq(ctx);
    const raw = p(ctx, [placement(ctx), { ...placement(ctx), startFrame: 300 }]);
    const out = acceptProposal(raw, { ...ctx, ids: seededIds("multi") });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.transaction.commands.map((c) => c.type)).toEqual(["PlaceEdit", "PlaceEdit"]);
    const history = out.workspace.histories[out.activeVersionId]!;
    expect(history.past).toHaveLength(1);
    const after = history.present;
    const selections = {
      activeVersionId: out.activeVersionId,
      chosenStoryId: null,
      targetSeconds: 30,
      storyboardSelectIds: [],
    };
    const saved = serializeWorkspace(out.workspace, selections, "analysis", "fixed", projectClips);
    const restored = parseSavedEditStateV2(
      JSON.parse(JSON.stringify(saved)),
      "analysis",
      projectClips,
    )!;
    expect(restored.warnings).toEqual([]);
    expect(sequenceOf(restored.workspace, out.activeVersionId, projectClips)).toEqual(after);
    const undone = undoIn(restored.workspace, out.activeVersionId);
    expect(sequenceOf(undone, out.activeVersionId, projectClips)).toEqual(before);
    expect(
      sequenceOf(redoIn(undone, out.activeVersionId), out.activeVersionId, projectClips),
    ).toEqual(after);
  });

  it("a second placement conflicting with the first causes no fork or partial mutation", () => {
    const ctx = fresh();
    const before = JSON.stringify(ctx.workspace);
    const raw = p(ctx, [placement(ctx), { ...placement(ctx), startFrame: 230 }]);
    expect(acceptProposal(raw, { ...ctx, ids: seededIds("bad") }).ok).toBe(false);
    expect(JSON.stringify(ctx.workspace)).toBe(before);
  });

  it("rechecks stale revisions on accept and refuses reuse of a created id", () => {
    const ctx = fresh();
    const raw = p(ctx);
    const changed = withSeq(ctx, protect(seq(ctx), { trackName: "V2" }, { aiLocked: true }));
    const stale = acceptProposal(raw, { ...changed, ids: seededIds("stale") });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issues[0]!.code).toBe("stale");
    const out = acceptProposal(raw, { ...ctx, ids: seededIds("once") });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const now = { ...ctx, workspace: out.workspace, activeVersionId: out.activeVersionId };
    // Even a refreshed envelope cannot overwrite the item a reused proposal id created.
    const repeated = p(now, [{ ...placement(now), startFrame: 300 }]);
    expect(acceptProposal(repeated, { ...now, ids: seededIds("twice") }).ok).toBe(false);
  });
});
