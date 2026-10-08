// Director AI 2.0 — Phase 5: what the AI Director is told about the cut
// (src/lib/timeline/ai-context.ts). Pure: the CURRENT sequence (an edited
// working version when that is on screen, never the Director original behind
// it), with ids, positions, source ranges, links, ownership, protection, the
// selection, and the evidence the AI may cite — and nothing else.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EditVersion, Select, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import {
  bindDirectorProposal,
  buildSequenceContext,
  CONTEXT_SCHEMA,
  MAX_REPLY_CHARS,
  type DirectorBinding,
} from "@/lib/timeline/ai-context";
import { commands } from "@/lib/timeline/commands";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import {
  PROPOSAL_SCHEMA,
  reviewProposal,
  sequenceRevision,
  type ProposalContext,
} from "@/lib/timeline/proposals";
import { endFrame } from "@/lib/timeline/selectors";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Command } from "@/lib/timeline/types";
import {
  dispatchTransaction,
  importedSequence,
  sequenceOf,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf, protect } from "./engine-helpers";
import { clip, directorCut, projectClips } from "./legacy-fixtures";
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
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const ctxOf = (ws: Workspace, active = "v2"): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});
const NO_EVIDENCE = { selects: [], transcript: [], visualEvidence: [] };
const build = (
  ws: Workspace,
  active = "v2",
  selection: string[] = [],
  evidence: Parameters<typeof buildSequenceContext>[2] = NO_EVIDENCE,
) => buildSequenceContext(ctxOf(ws, active), selection, evidence, projectClips)!;

function seg(
  id: string,
  clipId: string,
  startTc: string,
  endTc: string,
  text = "words",
): TranscriptSegment {
  return { id, clipId, speaker: "A", startTc, endTc, text, confidence: 1 };
}
function sel(id: string, clipId: string, excerpt = "a line"): Select {
  return {
    id,
    rank: 1,
    speaker: "A",
    clipId,
    clipName: clipId,
    startTc: "00:01:02:00",
    endTc: "00:01:12:00",
    durationSeconds: 10,
    score: 0.9,
    category: "strong-statement",
    transcriptExcerpt: excerpt,
    reasons: [],
    evidence: [],
  };
}
const vis = (id: string, clipId: string, label = "a shot"): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label,
  atTc: "00:00:05:00",
  confidence: 1,
});

describe("the current sequence, accurately", () => {
  it("rate, length, every clip with its id, track, source, position, range, link and owner", () => {
    const ws = fresh();
    const seq = sequenceOf(ws, "v2", projectClips)!;
    const c = build(ws);
    expect(c.schema).toBe(CONTEXT_SCHEMA);
    expect(c.versionId).toBe("v2");
    expect(c.revision).toBe(sequenceRevision(seq));
    expect([c.fps, c.durationFrames, c.targetFrames]).toEqual([24, 792, seq.targetFrames]);
    expect(c.tracks.map((t) => t.name)).toEqual([...seq.tracks.map((t) => t.name)].sort());
    expect(c.clips).toHaveLength(Object.keys(seq.items).length);
    for (const out of c.clips) {
      const it = seq.items[out.id]!;
      expect(out.start).toBe(it.startFrame);
      expect(out.end).toBe(endFrame(it));
      expect([out.sourceIn, out.sourceOut]).toEqual([it.sourceInFrame, it.sourceOutFrame]);
      expect(out.mediaClipId).toBe(it.mediaClipId);
      expect(out.link).toBe(it.linkGroupId ?? null);
      expect(out.owner).toBe("director");
      expect([out.locked, out.aiLocked]).toEqual([false, false]);
    }
    const e1 = c.clips.find((x) => x.id === itemIdOf(seq, "event-1"))!;
    expect(e1).toMatchObject({
      track: "V1",
      file: "CLIP-002.MP4",
      mediaFps: 23.976,
      start: 0,
      end: 240,
      sourceInTc: "00:01:02:00",
      sourceOutTc: "00:01:12:00",
      selectId: "sel-02",
    });
    // Linked sync audio shares the link group.
    const a1 = c.clips.filter((x) => x.link === e1.link);
    expect(a1.map((x) => x.track).sort()).toEqual(["A1", "V1"]);
    // Order: by track, then position — stable for the same cut.
    expect(build(fresh())).toEqual(c);
    // No media paths, only file names.
    expect(JSON.stringify(c)).not.toMatch(/\/Users\/|relPath/);
  });

  it("an edited working version is described as edited — not the Director original behind it", () => {
    const ws = fresh();
    const e7 = itemIdOf(sequenceOf(ws, "v2", projectClips)!, "event-7");
    const g = seededIds("hand");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Move", "manual", [commands.move(g, [e7], 2) as unknown as Command]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    expect(out.activeVersionId).not.toBe("v2");
    const edited = build(out.workspace, out.activeVersionId, [e7]);
    const original = build(out.workspace, "v2");
    expect(edited.versionId).toBe(out.activeVersionId);
    expect(edited.revision).not.toBe(original.revision);
    const moved = edited.clips.find((x) => x.id === e7)!;
    expect([moved.start, moved.owner]).toEqual([710, "manual"]);
    expect(original.clips.find((x) => x.id === e7)!.start).toBe(708);
    expect(edited.selection).toEqual([e7]);
  });

  it("protection on the clip or its track is stated", () => {
    const base = importedSequence(director, projectClips);
    const e7 = itemIdOf(base, "event-7");
    const e1 = itemIdOf(base, "event-1");
    const seq = protect(
      protect(base, { itemId: e7 }, { aiLocked: true }),
      { trackName: "V1" },
      { locked: true },
    );
    const ws = deepFreeze({
      versions: [
        structuredClone(director),
        { ...structuredClone(director), id: "ver_p", kind: "edited" as const, parentId: "v2" },
      ],
      histories: { ver_p: createHistory(seq) },
    } as Workspace);
    const c = build(ws, "ver_p");
    expect(c.clips.find((x) => x.id === e7)).toMatchObject({ aiLocked: true, locked: false });
    expect(c.clips.find((x) => x.id === e1)).toMatchObject({ locked: true });
    expect(c.tracks.find((t) => t.name === "V1")).toMatchObject({ locked: true, aiLocked: false });
  });

  it("selection keeps only clips in this sequence; nothing on screen → null", () => {
    const ws = fresh();
    const e7 = itemIdOf(sequenceOf(ws, "v2", projectClips)!, "event-7");
    expect(build(ws, "v2", [e7, "itm_gone"]).selection).toEqual([e7]);
    expect(buildSequenceContext(ctxOf(ws, "nope"), [], NO_EVIDENCE, projectClips)).toBeNull();
  });
});

describe("evidence the AI may cite", () => {
  it("transcript only around source ranges actually on the timeline; selects and visual by id", () => {
    const ws = fresh();
    const c = build(ws, "v2", [], {
      selects: [sel("sel-01", "clip-002", "x".repeat(500))],
      transcript: [
        seg("t-in", "clip-002", "00:01:05:00", "00:01:07:00"), // inside event-1
        seg("t-near", "clip-002", "00:01:15:00", "00:01:17:00"), // within the margin
        seg("t-far", "clip-002", "00:00:02:00", "00:00:04:00"), // unused part of the clip
        seg("t-off", "clip-005", "00:00:01:00", "00:00:03:00"), // clip not in the cut
      ],
      visualEvidence: [vis("v-1", "clip-003")],
    });
    expect(c.evidence.transcript.map((t) => t.id)).toEqual(["t-in", "t-near"]);
    expect(c.evidence.selects[0]).toMatchObject({
      id: "sel-01",
      clipId: "clip-002",
      category: "strong-statement",
    });
    expect(c.evidence.selects[0]!.excerpt.length).toBeLessThanOrEqual(200);
    expect(c.evidence.visual).toEqual([
      { id: "v-1", clipId: "clip-003", atTc: "00:00:05:00", kind: "b-roll", label: "a shot" },
    ]);
  });

  it("is bounded however large the analysis is", () => {
    const ws = fresh();
    const many = Array.from({ length: 1000 }, (_, i) =>
      seg(`t-${i}`, "clip-002", "00:01:03:00", "00:01:04:00", "y".repeat(1000)),
    );
    const c = build(ws, "v2", [], {
      selects: [],
      transcript: many,
      visualEvidence: Array.from({ length: 1000 }, (_, i) => vis(`v-${i}`, "clip-003")),
    });
    expect(c.evidence.transcript).toHaveLength(150);
    expect(c.evidence.visual).toHaveLength(120);
    expect(c.evidence.transcript.every((t) => t.text.length <= 200)).toBe(true);
    expect(JSON.stringify(c).length).toBeLessThan(120_000); // the worker's limit
  });
});

describe("a proposal bound to this context", () => {
  it("passes review while the cut is unchanged, and is stale once it changes", () => {
    const ws = fresh();
    const seq = sequenceOf(ws, "v2", projectClips)!;
    const e7 = itemIdOf(seq, "event-7");
    const c = build(ws);
    // What the worker wraps around the model's operations.
    const p = {
      schema: PROPOSAL_SCHEMA,
      id: "prp_ai_fixture",
      instruction: "Bring the last cutaway in a second earlier",
      summary: "Moves it 24 frames earlier.",
      base: { versionId: c.versionId, revision: c.revision },
      operations: [{ op: "move", itemIds: [e7], deltaFrames: -24 }],
    };
    expect(reviewProposal(p, ctxOf(ws)).ok).toBe(true);
    const g = seededIds("later");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Move", "manual", [
        commands.move(g, [itemIdOf(seq, "event-4")], 1) as unknown as Command,
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    const r = reviewProposal(p, ctxOf(out.workspace, out.activeVersionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("stale");
  });
});

describe("binding an AI reply to the cut it was asked about (the trust boundary)", () => {
  const ws = fresh();
  const seq = sequenceOf(ws, "v2", projectClips)!;
  const e7 = itemIdOf(seq, "event-7");
  const binding: DirectorBinding = {
    projectId: "proj-1",
    versionId: "v2",
    revision: sequenceRevision(seq),
  };
  const sent = { instruction: "Bring it in", binding };
  const reply = (extra: Record<string, unknown> = {}) => ({
    schema: PROPOSAL_SCHEMA,
    id: "prp_ai_0123456789abcdef01234567",
    instruction: "Bring it in",
    summary: "Moves it.",
    base: { versionId: "v2", revision: binding.revision },
    operations: [{ op: "move", itemIds: [e7], deltaFrames: -24 }],
    ...extra,
  });

  it("an unchanged cut: the app's own envelope, then the engine's review", () => {
    const out = bindDirectorProposal(
      reply({ schema: "ae.proposal/9", instruction: "Something else entirely" }),
      sent,
      binding,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal["schema"]).toBe(PROPOSAL_SCHEMA);
    expect(out.proposal["instruction"]).toBe("Bring it in"); // what the filmmaker typed
    expect(out.proposal["base"]).toEqual({ versionId: "v2", revision: binding.revision });
    expect(reviewProposal(out.proposal, ctxOf(ws)).ok).toBe(true);
    // A malformed id is replaced, never trusted.
    const odd = bindDirectorProposal(reply({ id: "../../etc" }), sent, binding);
    expect(odd.ok && odd.proposal["id"]).toBe("prp_ai_unidentified");
  });

  it.each([
    ["another revision", { base: { versionId: "v2", revision: "rev_0123456789abcdef_1a" } }],
    ["another version", { base: { versionId: "v1", revision: binding.revision } }],
    ["an extra base field", { base: { versionId: "v2", revision: binding.revision, ok: true } }],
    ["no base", { base: undefined }],
  ])("a reply claiming %s is refused", (_n, extra) => {
    const out = bindDirectorProposal(reply(extra), sent, binding);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/claimed a different version/);
  });

  it.each([
    ["the project changed", { ...binding, projectId: "proj-2" }],
    ["the version changed", { ...binding, versionId: "ver_edit" }],
    ["the cut changed", { ...binding, revision: "rev_0123456789abcdef_1a" }],
    ["nothing is on screen", null],
  ])("stale when %s — refused before any preview", (_n, live) => {
    const out = bindDirectorProposal(reply(), sent, live);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/The cut changed while the Director was working/);
  });

  it("smuggled authorization is kept for the engine to refuse, not silently dropped", () => {
    const out = bindDirectorProposal(reply({ force: true, allowProtected: true }), sent, binding);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = reviewProposal(out.proposal, ctxOf(ws));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("self-authorization");
  });

  it("malformed or oversized replies are refused", () => {
    for (const bad of [null, "x", [1], 42])
      expect(bindDirectorProposal(bad, sent, binding).ok).toBe(false);
    const huge = reply({ summary: "x".repeat(MAX_REPLY_CHARS) });
    const out = bindDirectorProposal(huge, sent, binding);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/too large/);
    const cyclic: Record<string, unknown> = reply();
    cyclic["self"] = cyclic;
    expect(bindDirectorProposal(cyclic, sent, binding).ok).toBe(false);
  });
});

const stateFiles = (process.env.AE_EDIT_STATE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter((f) => f && existsSync(f));
const analysisFile = process.env.AE_ANALYSIS_FILE;

describe.skipIf(!stateFiles.length || !analysisFile || !existsSync(analysisFile))(
  "real saved projects",
  () => {
    it("every saved version is described exactly, within the size limit, citing only real evidence — files untouched", () => {
      const analysis = JSON.parse(readFileSync(analysisFile!, "utf8"));
      const rows = Array.isArray(analysis.clips) ? analysis.clips : Object.values(analysis.clips);
      const clips = rows.map(
        (c: { id: string; fps: number; duration_seconds: number; filename: string }) =>
          clip(c.id, c.fps, c.duration_seconds, { filename: c.filename }),
      );
      const evidence = {
        selects: analysis.selects ?? [],
        transcript: analysis.transcript ?? [],
        visualEvidence: analysis.visualEvidence ?? [],
      };
      const ids = (xs: Array<{ id: string }>) => new Set(xs.map((x) => x.id));
      const known = {
        selects: ids(evidence.selects),
        transcript: ids(evidence.transcript),
        visual: ids(evidence.visualEvidence),
      };
      let described = 0;
      for (const file of stateFiles) {
        const before = readFileSync(file, "utf8");
        const state = JSON.parse(before);
        const ws = workspaceFromVersions(state.versions);
        for (const v of state.versions as EditVersion[]) {
          const seq = sequenceOf(ws, v.id, clips)!;
          const c = buildSequenceContext(
            { workspace: ws, activeVersionId: v.id, clips, media: mediaOf(clips) },
            [],
            evidence,
            clips,
          )!;
          expect(c.revision).toBe(sequenceRevision(seq));
          expect(c.clips.map((x) => x.id).sort()).toEqual(Object.keys(seq.items).sort());
          for (const x of c.clips) {
            const it = seq.items[x.id]!;
            expect([x.start, x.end, x.sourceIn, x.sourceOut]).toEqual([
              it.startFrame,
              endFrame(it),
              it.sourceInFrame,
              it.sourceOutFrame,
            ]);
          }
          const onTimeline = new Set(c.clips.map((x) => x.mediaClipId));
          expect(c.evidence.selects.every((x) => known.selects.has(x.id))).toBe(true);
          expect(c.evidence.visual.every((x) => known.visual.has(x.id))).toBe(true);
          expect(
            c.evidence.transcript.every(
              (x) => known.transcript.has(x.id) && onTimeline.has(x.clipId),
            ),
          ).toBe(true);
          const size = JSON.stringify(c).length;
          expect(size).toBeLessThan(120_000);
          expect(JSON.stringify(c)).not.toMatch(/\/Users\//);
          described += 1;
        }
        expect(readFileSync(file, "utf8")).toBe(before);
      }
      expect(described).toBeGreaterThan(0);
    });
  },
);
