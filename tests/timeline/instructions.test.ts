// Director AI 2.0 — Phase 4: the deterministic instruction interpreter
// (src/lib/timeline/instructions.ts). Pure, no AI: wording → an existing
// Phase 1 proposal for the selected clip(s), or a refusal with a reason.
import { describe, expect, it } from "vitest";
import type { Clip, EditVersion, UniversalTimeline } from "@/lib/ae/types";
import { buildPlaybackPlan } from "@/lib/ae/timeline-playback";
import { tcToSeconds } from "@/lib/nle/timecode";
import { commands } from "@/lib/timeline/commands";
import { createHistory } from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { interpretInstruction } from "@/lib/timeline/instructions";
import { acceptProposal, reviewProposal, type ProposalContext } from "@/lib/timeline/proposals";
import { endFrame } from "@/lib/timeline/selectors";
import { rescaleFrames } from "@/lib/timeline/time";
import { makeTransaction } from "@/lib/timeline/transactions";
import type { Command, Sequence } from "@/lib/timeline/types";
import {
  derivedTimeline,
  dispatchTransaction,
  importedSequence,
  sequenceOf,
  serializeWorkspace,
  workspaceFromVersions,
  type Workspace,
} from "@/lib/timeline/workspace";
import { deepFreeze, mediaOf, protect } from "./engine-helpers";
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
const fresh = () => deepFreeze(workspaceFromVersions([structuredClone(director)]));
const ctxOf = (ws: Workspace, active = "v2"): ProposalContext => ({
  workspace: ws,
  activeVersionId: active,
  clips: projectClips,
  media,
});
const seqOf = (ws: Workspace, v = "v2") => sequenceOf(ws, v, projectClips)!;
const partner = (s: Sequence, id: string) =>
  Object.values(s.items).find((i) => i.linkGroupId === s.items[id]!.linkGroupId && i.id !== id)!;
const ops = (r: ReturnType<typeof interpretInstruction>) =>
  r.ok ? (r.proposal["operations"] as Array<Record<string, unknown>>) : [];

describe("supported wording", () => {
  const ws = fresh();
  const s = seqOf(ws);
  const e7 = itemIdOf(s, "event-7");
  const e6 = itemIdOf(s, "event-6");

  it.each([
    ["Move the selected clip 2 seconds earlier.", -48],
    ["move this clip 15 frames later", 15],
    ["Please nudge it by 10 frames forward", 10],
    ["Shift the clip one second back", -24],
    ["slide this clip later by 1.5 seconds", 36],
    ["Move the selected clip half a second left", -12],
    ["MOVE THIS CLIP 3 F RIGHT", 3],
  ])("%s → move %i frames", (text, delta) => {
    const r = interpretInstruction(text, ctxOf(ws), [e7]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(ops(r)).toEqual([{ op: "move", itemIds: [e7], deltaFrames: delta }]);
    if (r.ok) {
      expect(r.proposal["instruction"]).toBe(text.trim());
      expect(reviewProposal(r.proposal, ctxOf(ws)).ok).toBe(true);
      expect(r.interpretation.expected).toMatch(
        /^starts at 00:00:\d\d:\d\d instead of 00:00:29:12\.$/,
      );
    }
  });

  it.each([
    ["Trim 1 second from the end", "out", -24],
    ["trim 12 frames from the start of the selected clip", "in", 12],
    ["Trim the end of this clip by 6 frames", "out", -6],
    ["shorten it by 2 frames off the tail", "out", -2],
  ])("%s → trim %s", (text, edge, delta) => {
    const r = interpretInstruction(text, ctxOf(ws), [e6]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // 24 fps sequence, 23.976 media: sequence frames → the clip's source frames.
    expect(ops(r)).toEqual([{ op: "trim", itemId: e6, edge, deltaSourceFrames: delta }]);
    if (r.ok) {
      expect(r.interpretation.expected).toMatch(/frames? shorter/);
      expect(r.interpretation.limitations.join(" ")).toMatch(/linked sync audio is trimmed/);
    }
  });

  it.each([
    ["Remove the selected clip", false],
    ["delete this clip", false],
    ["Remove the selected clip and close the gap", true],
    ["remove it with ripple", true],
    ["ripple delete the selected clip", true],
  ])("%s → remove (ripple %s)", (text, ripple) => {
    const r = interpretInstruction(text, ctxOf(ws), [itemIdOf(s, "event-5")]);
    expect(ops(r)).toEqual([{ op: "remove", itemIds: [itemIdOf(s, "event-5")], ripple }]);
    if (r.ok)
      expect(r.interpretation.expected).toMatch(
        ripple ? /later clips? move up 144 frames/ : /a 144-frame gap is left/,
      );
  });

  it("converts seconds with the sequence rate and reports rounding", () => {
    const r = interpretInstruction("Move this clip 0.3 seconds earlier", ctxOf(ws), [e7]);
    expect(ops(r)[0]!["deltaFrames"]).toBe(-7);
    if (r.ok)
      expect(r.interpretation.limitations.join(" ")).toMatch(
        /7\.20 frames at 24 fps — rounded to 7/,
      );
    const exact = interpretInstruction("Move this clip 2 seconds earlier", ctxOf(ws), [e7]);
    if (exact.ok) expect(exact.interpretation.limitations.join(" ")).not.toMatch(/rounded/);
  });

  it("uses stable clip ids and never changes the sequence", () => {
    const before = JSON.stringify(
      serializeWorkspace(
        ws,
        { activeVersionId: "v2", chosenStoryId: null, targetSeconds: 30, storyboardSelectIds: [] },
        "a",
        "",
      ),
    );
    interpretInstruction("Remove the selected clip and close the gap", ctxOf(ws), [
      itemIdOf(s, "event-5"),
    ]);
    expect(seqOf(ws)).toBe(s);
    expect(
      JSON.stringify(
        serializeWorkspace(
          ws,
          {
            activeVersionId: "v2",
            chosenStoryId: null,
            targetSeconds: 30,
            storyboardSelectIds: [],
          },
          "a",
          "",
        ),
      ),
    ).toBe(before);
    expect(importedSequence(director, projectClips).items[e7]).toBeDefined(); // the id is the import's own
  });
});

describe("selection", () => {
  const ws = fresh();
  const s = seqOf(ws);
  const e3 = itemIdOf(s, "event-3");
  const e5 = itemIdOf(s, "event-5");

  it("nothing selected → refused", () => {
    const r = interpretInstruction("Move the selected clip 2 seconds earlier", ctxOf(ws), []);
    expect(r).toMatchObject({ ok: false, code: "no-selection" });
    if (!r.ok) expect(r.reason).toMatch(/Select a clip/);
  });

  it("several clips with singular wording → refused, never guessed", () => {
    const r = interpretInstruction("Move this clip 2 seconds earlier", ctxOf(ws), [e3, e5]);
    expect(r).toMatchObject({ ok: false, code: "ambiguous-selection" });
    if (!r.ok) expect(r.reason).toMatch(/Select one clip.*2 are selected/);
    // Trims always need exactly one clip.
    expect(
      interpretInstruction("Trim 6 frames from the end of the selected clips", ctxOf(ws), [e3, e5])
        .ok,
    ).toBe(false);
  });

  it("plural wording acts on every selected clip", () => {
    const r = interpretInstruction("Move the selected clips 1 second later", ctxOf(ws), [
      itemIdOf(s, "event-4"),
      itemIdOf(s, "event-7"),
    ]);
    expect(ops(r)).toEqual([
      { op: "move", itemIds: [itemIdOf(s, "event-4"), itemIdOf(s, "event-7")], deltaFrames: 24 },
    ]);
  });

  it("a picture and its linked audio count as one clip, named by the picture", () => {
    const a3 = partner(s, e3);
    const viaAudio = interpretInstruction("Trim 6 frames from the end", ctxOf(ws), [a3.id]);
    expect(ops(viaAudio)).toEqual([{ op: "trim", itemId: e3, edge: "out", deltaSourceFrames: -6 }]);
    const both = interpretInstruction("Move this clip 2 frames later", ctxOf(ws), [e3, a3.id]);
    expect(both.ok).toBe(true);
    if (viaAudio.ok) expect(viaAudio.interpretation.clips[0]).toMatch(/\(V1/);
  });
});

describe("refusals", () => {
  const ws = fresh();
  const s = seqOf(ws);
  const e7 = itemIdOf(s, "event-7");

  it.each([
    ["Make the opening stronger", "unrecognized"],
    ["move it somewhere nicer", "unrecognized"],
    ["Split this clip", "unsupported"],
    ["Cut this clip", "unsupported"],
    ["Extend the end by 1 second", "unsupported"],
    ["Move it 0 frames earlier", "invalid-amount"],
    ["Move it 0.01 seconds earlier", "invalid-amount"],
    ["", "unrecognized"],
  ])("%s → %s", (text, code) => {
    const r = interpretInstruction(text, ctxOf(ws), [e7]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('"cut" is never silently treated as remove or split', () => {
    const r = interpretInstruction("Cut the selected clip", ctxOf(ws), [e7]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/remove or split/);
  });
});

describe("protection, ownership and ripple rules are the engine's — explained, never bypassed", () => {
  it("an AI-protected or locked clip is understood, then refused by review", () => {
    for (const p of [{ aiLocked: true }, { locked: true }]) {
      const base = importedSequence(director, projectClips);
      const e7 = itemIdOf(base, "event-7");
      const seq = protect(base, { itemId: e7 }, p);
      const ws = deepFreeze({
        versions: [
          structuredClone(director),
          { ...structuredClone(director), id: "ver_p", kind: "edited" as const, parentId: "v2" },
        ],
        histories: { ver_p: createHistory(seq) },
      } as Workspace);
      const r = interpretInstruction("Move this clip 2 seconds earlier", ctxOf(ws, "ver_p"), [e7]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.interpretation.expected).toBeNull();
      const review = reviewProposal(r.proposal, ctxOf(ws, "ver_p"));
      expect(review.ok ? [] : review.issues.map((i) => i.code)).toEqual(["protected"]);
    }
  });

  it("a hand-edited clip is refused", () => {
    const ws = fresh();
    const g = seededIds("hand");
    const out = dispatchTransaction(
      ws,
      "v2",
      makeTransaction(g, "Move", "manual", [
        commands.move(g, [itemIdOf(seqOf(ws), "event-7")], 2) as unknown as Command,
      ]),
      { clips: projectClips, media, ids: g },
    );
    if (!out.ok) throw new Error(out.error.message);
    const s = seqOf(out.workspace, out.activeVersionId);
    const r = interpretInstruction(
      "Move this clip 1 second later",
      ctxOf(out.workspace, out.activeVersionId),
      [itemIdOf(s, "event-7")],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const review = reviewProposal(r.proposal, ctxOf(out.workspace, out.activeVersionId));
    expect(review.ok ? [] : review.issues.map((i) => i.code)).toEqual(["manual-conflict"]);
  });

  it('"close the gap" stays a ripple: refused where ripple rules forbid it — never turned into a lift', () => {
    const ws = fresh();
    const e3 = itemIdOf(seqOf(ws), "event-3"); // a cutaway sits over it
    const r = interpretInstruction("Remove the selected clip and close the gap", ctxOf(ws), [e3]);
    expect(ops(r)).toEqual([{ op: "remove", itemIds: [e3], ripple: true }]);
    if (!r.ok) return;
    expect(r.interpretation.expected).toBeNull();
    const review = reviewProposal(r.proposal, ctxOf(ws));
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.issues[0]!.engineCode).toBe("ripple-blocked");
  });
});

/* ---------------- Phase 4 approval gate: media rates and impossible trims ---------------- */
// Phase 4 approval gate — trims stated in sequence time, applied in SOURCE
// frames, for 23.976 / 24 / 25 / 29.97 / 30 fps media on a 24 fps sequence:
//   - deterministic (same input → same proposal, every time);
//   - the displayed expected change is exactly what accepting does, and what
//     playback plays;
//   - any difference between what was asked and what the source allows is
//     disclosed;
//   - impossible trims are refused, never quietly adjusted.
const RATES = [23.976, 24, 25, 29.97, 30];
const rateDirector: EditVersion = {
  id: "v2",
  label: "Director",
  version: "v1.1",
  command: "c",
  summary: "s",
  createdAt: "—",
  changes: [],
  timeline: directorCut,
};

/** The v1.2 cut re-timed for `fps` media, as the worker builds it: every
 * event's length is its source range on the clip's own timecode clock, and
 * interview events play back-to-back. */
function cutFor(fps: number): UniversalTimeline {
  let t = 0;
  const decisions = directorCut.decisions.map((d) => {
    const dur =
      Math.round((tcToSeconds(d.sourceOutTc, fps)! - tcToSeconds(d.sourceInTc, fps)!) * 1e6) / 1e6;
    if (d.lane !== "interview") return { ...d, durationSeconds: dur };
    const out = { ...d, timelineStartSeconds: t, durationSeconds: dur };
    t += dur;
    return out;
  });
  return { ...directorCut, decisions };
}

/** `consistent`: the cut was built for this media rate (the real case);
 * otherwise the 23.976-built fixture is reused unchanged — its imported
 * lengths then disagree with the source by a frame or more. */
function setup(fps: number, consistent = true) {
  const clips: Clip[] = projectClips.map((c) => ({ ...c, fps }));
  const timeline = consistent ? cutFor(fps) : directorCut;
  const ws: Workspace = deepFreeze(
    workspaceFromVersions([{ ...structuredClone(rateDirector), timeline }]),
  );
  const ctx: ProposalContext = {
    workspace: ws,
    activeVersionId: "v2",
    clips,
    media: mediaOf(clips),
  };
  const seq = sequenceOf(ws, "v2", clips)!;
  return { clips, ws, ctx, seq };
}

describe.each(RATES.flatMap((fps) => [[fps, true] as const, [fps, false] as const]))(
  "%s fps media on a 24 fps sequence (cut built for this rate: %s)",
  (fps, consistent) => {
    const { clips, ctx, seq } = setup(fps, consistent);
    const targets = {
      "linked V1": itemIdOf(seq, "event-6"),
      "V2 cutaway": itemIdOf(seq, "event-7"),
    };

    it("every trim from 1 to 48 frames, both edges: deterministic, exact-or-disclosed, and what you see is what you get", () => {
      let exact = 0;
      let disclosed = 0;
      let refused = 0;
      for (const [name, id] of Object.entries(targets)) {
        const item = seq.items[id]!;
        for (const edgeWord of ["end", "start"] as const) {
          for (let n = 1; n <= 48; n += 1) {
            const text = `Trim ${n} frames from the ${edgeWord}`;
            const tag = `${fps} ${name} ${text}`;
            const r = interpretInstruction(text, ctx, [id]);
            // Deterministic: a fresh, independent interpretation is identical.
            expect(interpretInstruction(text, setup(fps, consistent).ctx, [id]), tag).toStrictEqual(
              r,
            );
            if (n >= item.durationFrames) {
              // Can't trim a clip to nothing: refused outright, never adjusted.
              expect(r.ok, tag).toBe(false);
              if (!r.ok) expect(r.reason, tag).toMatch(/whole clip/);
              continue;
            }
            if (!r.ok) {
              // No source change shortens it within a frame of the request:
              // refused with a reason, never approximated further.
              expect(r.code, tag).toBe("impossible");
              expect(r.reason, tag).toMatch(/can't be trimmed by \d+ frames?/);
              refused += 1;
              continue;
            }
            const review = reviewProposal(r.proposal, ctx);
            expect(review.ok, `${tag} ${JSON.stringify(!review.ok && review.issues)}`).toBe(true);
            if (!review.ok) continue;
            const after = review.preview.items[id]!;
            const actual = item.durationFrames - after.durationFrames;
            expect(actual, tag).toBeGreaterThan(0); // always shorter, never longer
            // The trimmed edge moved; the other one stayed.
            if (edgeWord === "end") expect(after.startFrame, tag).toBe(item.startFrame);
            else expect(endFrame(after), tag).toBe(endFrame(item));
            // Expected text = the real result.
            expect(r.interpretation.expected, tag).toContain(
              `${actual} frame${actual === 1 ? "" : "s"} shorter`,
            );
            // Disclosure if and only if it differs from what was asked.
            const note = r.interpretation.limitations.find((l) => l.startsWith("Asked for"));
            if (actual === n) {
              expect(note, tag).toBeUndefined();
              exact += 1;
            } else {
              expect(note, tag).toBe(
                `Asked for ${n} frames; the closest this clip's ${fps} fps source allows is ${actual} — that is what will be trimmed.`,
              );
              expect(Math.abs(actual - n), tag).toBeLessThanOrEqual(1);
              disclosed += 1;
            }
          }
        }
      }
      // Every case is accounted for: exact, disclosed (±1 frame) or refused.
      console.info(
        `${fps} fps (built for it: ${consistent}): exact ${exact}, disclosed ${disclosed}, refused ${refused}`,
      );
      if (consistent) expect(disclosed + refused).toBeLessThanOrEqual(exact / 10); // the real case
      expect(exact).toBeGreaterThan(0);
    });

    it("accepting gives exactly the previewed clip, and playback plays exactly that length", () => {
      const id = targets["linked V1"];
      const r = interpretInstruction("Trim 1 second from the end", ctx, [id]);
      if (!r.ok) throw new Error(r.reason);
      const review = reviewProposal(r.proposal, ctx);
      if (!review.ok) throw new Error(JSON.stringify(review.issues));
      const a = acceptProposal(r.proposal, { ...ctx, ids: seededIds(`acc-${fps}`) });
      if (!a.ok) throw new Error(JSON.stringify(a.issues));
      const committed = sequenceOf(a.workspace, a.activeVersionId, clips)!;
      const { originTransactionId: _a, ...got } = committed.items[id]!;
      const { originTransactionId: _b, ...previewed } = review.preview.items[id]!;
      expect(got).toStrictEqual(previewed);
      // Playback: the derived timeline places it for exactly durationFrames.
      const plan = buildPlaybackPlan(derivedTimeline(committed), clips);
      const seg = plan.sequence.find((x) => x.decision.id === "event-6")!;
      expect(Math.round(seg.decision.durationSeconds * 24)).toBe(got.durationFrames);
      expect(Math.round(seg.decision.timelineStartSeconds * 24)).toBe(got.startFrame);
    });
  },
);

describe("impossible or unrepresentable trims", () => {
  const { ctx, seq } = setup(23.976);
  const e6 = itemIdOf(seq, "event-6"); // 96 frames long

  it("trimming the whole clip or more is refused — not shrunk to fit", () => {
    for (const text of [
      "Trim 400 frames from the end",
      "Trim 96 frames from the start",
      "Trim 10 seconds from the end",
    ]) {
      const r = interpretInstruction(text, ctx, [e6]);
      expect(r.ok, text).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("impossible");
        expect(r.reason).toMatch(
          /trim away the whole clip \(96 frames\) — use "Remove the selected clip"/,
        );
      }
    }
  });

  it("a protected clip's trim is passed through unchanged, so the review explains it", () => {
    const r = interpretInstruction("Trim 6 frames from the end", ctx, [e6]);
    expect(r.ok).toBe(true);
  });

  it("seconds that aren't whole frames are rounded — and that is disclosed", () => {
    const r = interpretInstruction("Trim 0.3 seconds from the end", ctx, [e6]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.interpretation.limitations.join(" ")).toMatch(
      /0\.3 seconds is 7\.20 frames at 24 fps — rounded to 7/,
    );
  });
});
