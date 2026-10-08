// The developer demonstration (src/lib/timeline/demo-proposals.ts): labeled,
// deterministic, never an AI call. Valid demos are engine-validated and avoid
// hand-edited / protected material; conflict demos are refused by review.
import { describe, expect, it } from "vitest";
import type { EditVersion } from "@/lib/ae/types";
import { commands } from "@/lib/timeline/commands";
import { seededIds } from "@/lib/timeline/ids";
import { DEMO_KINDS, demoProposal } from "@/lib/timeline/demo-proposals";
import { reviewProposal, type ProposalContext } from "@/lib/timeline/proposals";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Command } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  sequenceOf,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { mediaOf } from "./engine-helpers";
import { directorCut, projectClips } from "./legacy-fixtures";
import { itemIdOf } from "./proposal-fixtures";

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
const ctxOf = (ws: Workspace, active: string): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});

describe("developer demo proposals", () => {
  it("are labeled as demos and the valid four pass review on a Director cut", () => {
    const ws = workspaceFromVersions([director]);
    for (const kind of [
      "move-broll",
      "trim-interview",
      "ripple-remove",
      "reorder-interview",
    ] as const) {
      const r = demoProposal(kind, ctxOf(ws, "v2"));
      expect(r.ok, kind).toBe(true);
      if (!r.ok) continue;
      expect(String(r.proposal["instruction"])).toMatch(/^\[Demo\] /);
      expect(String(r.proposal["id"])).toMatch(/^prp_demo_/);
      expect(reviewProposal(r.proposal, ctxOf(ws, "v2")).ok, kind).toBe(true);
    }
    expect(DEMO_KINDS.map((d) => d.kind)).toHaveLength(6);
  });

  it("conflict demos explain when there is nothing to conflict with — and are refused when there is", () => {
    const ws = workspaceFromVersions([director]);
    const none = demoProposal("manual-conflict", ctxOf(ws, "v2"));
    expect(none.ok).toBe(false);
    const g = seededIds("demo-manual");
    const s = sequenceOf(ws, "v2", projectClips)!;
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Move", "manual", [
        commands.move(g, [itemIdOf(s, "event-7")], 2) as unknown as Command,
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    const conflict = demoProposal("manual-conflict", ctxOf(out.workspace, out.activeVersionId));
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    const r = reviewProposal(conflict.proposal, ctxOf(out.workspace, out.activeVersionId));
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["manual-conflict"]);
    // The valid demos steer around the hand-edited clip.
    const move = demoProposal("move-broll", ctxOf(out.workspace, out.activeVersionId));
    expect(move.ok && JSON.stringify(move.proposal)).not.toContain(itemIdOf(s, "event-7"));
  });
});

describe("remove-section demo", () => {
  it("lifts (gap left) when ripple rules forbid closing any gap, and says so", () => {
    // Cover every V1 clip with a cutaway: no ripple removal is allowed anywhere.
    const covered = {
      ...directorCut,
      decisions: [
        ...directorCut.decisions,
        {
          id: "c1",
          lane: "b-roll" as const,
          clipId: "clip-003",
          label: "cover 1",
          sourceInTc: "00:00:01:00",
          sourceOutTc: "00:00:09:00",
          timelineStartSeconds: 2,
          durationSeconds: 8,
        },
        {
          id: "c2",
          lane: "b-roll" as const,
          clipId: "clip-005",
          label: "cover 2",
          sourceInTc: "00:00:01:00",
          sourceOutTc: "00:00:08:00",
          timelineStartSeconds: 11,
          durationSeconds: 7,
        },
        {
          id: "c3",
          lane: "b-roll" as const,
          clipId: "clip-006",
          label: "cover 3",
          sourceInTc: "00:00:01:00",
          sourceOutTc: "00:00:05:00",
          timelineStartSeconds: 23.5,
          durationSeconds: 4,
        },
      ],
    };
    const ws = workspaceFromVersions([{ ...director, timeline: covered }]);
    const r = demoProposal("ripple-remove", ctxOf(ws, "v2"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.proposal["operations"] as Array<{ ripple: boolean }>;
    expect(ops[0]!.ripple).toBe(false);
    expect(String(r.proposal["summary"])).toMatch(/gap is left/);
    expect(reviewProposal(r.proposal, ctxOf(ws, "v2")).ok).toBe(true);
  });
});
