// Phase 7, Milestone 5 — Cover mode in CUT, through the REAL store, preview
// hook, ProposalPanel and TimelineEditor (tests/helpers/cut-harness.ts).
// Deterministic and local: no AI provider is asked for anything.
// On the v1.2-shaped Director cut (24 fps sequence of 23.976 media):
//   V1: e1 0–240 · e2 240–408 · e3 408–552 · e5 552–696 · e6 696–792
//   V2: e4 420–532 · e7 708–784
//   Potential jump cuts: 240 (e1|e2) and 408 (e2|e3), both uncovered.
// B-roll: clip-005 (9.4 s) and clip-006 (9.1 s), each with a logged moment.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Clip, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import {
  ctx,
  fakeAnalysis,
  fakeDirector,
  fakeStory,
  freshDisk,
  itemOf,
  key,
  launch,
  pr,
  q,
  quit,
  schema1File,
  seq,
  settle,
  teardown,
  wait,
} from "./helpers/cut-harness";
import { projectClips } from "./timeline/legacy-fixtures";

afterEach(teardown);

const withDialogue = (c: Clip, status: "dialogue" | "non-dialogue"): Clip => ({
  ...c,
  dialogue: { status, reasons: [`fixture: ${status}`] },
});
const CLIPS: Clip[] = projectClips.map((c, i) =>
  withDialogue(c, i < 3 ? "dialogue" : "non-dialogue"),
);
const ev = (id: string, clipId: string, atTc: string, label: string): VisualEvidence => ({
  id,
  clipId,
  kind: "b-roll",
  label,
  atTc,
  confidence: 0.8,
});
const EVIDENCE = [
  ev("park-1", "clip-005", "00:00:03:00", "Park sign at the entrance"),
  ev("street-1", "clip-006", "00:00:04:00", "Empty street corner"),
];
const line = (id: string, a: string, b: string, text: string): TranscriptSegment => ({
  id,
  clipId: "clip-002",
  speaker: "A",
  startTc: a,
  endTc: b,
  text,
  confidence: 0.9,
});
const TRANSCRIPT = [
  line("t-e1", "00:01:08:00", "00:01:11:00", "The highway cut straight through our neighborhood."),
  line("t-e2", "00:00:25:00", "00:00:28:00", "Now the park brings everyone back."),
];
function prepare(o: { clips?: Clip[]; evidence?: VisualEvidence[] } = {}) {
  fakeAnalysis.clips = o.clips ?? CLIPS;
  fakeAnalysis.visualEvidence = o.evidence ?? EVIDENCE;
  fakeAnalysis.transcript = TRANSCRIPT;
}

const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const markers = () => all('[data-testid="coverage-marker"]').map((m) => m.dataset.state);
const mode = (m: "edit" | "story" | "cover") => act(() => q(`mode-${m}`)!.click());
const status = () => q("proposal-status")?.textContent ?? null;
const proposalId = () => (pr!.pending as { id: string } | null)?.id ?? null;
const added = () => all('[data-proposal="added"]');
function dispatch(type: string, params: Record<string, unknown>) {
  act(() => {
    const out = ctx!.editor.dispatchTransaction({
      id: ctx!.editor.ids.next("transaction"),
      label: type,
      origin: "manual",
      createdAt: "fixed",
      commands: [{ id: ctx!.editor.ids.next("command"), type, params }] as never,
    });
    expect(out.ok).toBe(true);
  });
}

describe("Cover mode", () => {
  it("is a third mode: it analyses the live cut and puts a local proposal up for review — nothing applied, nothing saved, no AI", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    expect(q("coverage-legend")).toBeNull();
    expect(markers()).toEqual([]);
    mode("cover");
    expect(q("director-mode")!.dataset.mode).toBe("cover");
    expect(q("coverage-panel")).not.toBeNull();
    expect(q("instruction-input")!.closest("form")!.hidden).toBe(true);
    expect(q("proposal-demo")).toBeNull();
    expect(status()).toBe("Ready to review");
    expect(q("coverage-summary")!.textContent).toBe(
      "2 potential jump cuts · 2 uncovered · 0 partly covered · 0 covered · 0 can't be covered safely",
    );
    expect(
      all('[data-testid="coverage-cut"]').map((c) => [c.dataset.cutTc, c.dataset.state]),
    ).toEqual([
      ["00:00:10:00", "uncovered"],
      ["00:00:17:00", "uncovered"],
    ]);
    expect(q("coverage-legend")!.textContent).toMatch(/not a confirmed defect/);
    expect(seq()).toBe(before);
    await wait(400);
    expect(disk.saves2).toBe(0);
    expect(fakeDirector.requests).toHaveLength(0);
    expect(fakeStory.requests).toHaveLength(0);
  }, 30000);

  it("each placement shows its file, source and timeline ranges, the cut, the evidence, why — and what is uncertain", async () => {
    prepare();
    await launch(freshDisk());
    mode("cover");
    const details = all('[data-testid="placement-detail"]');
    expect(details).toHaveLength(2);
    const cuts = details.map((d) => d.querySelector('[data-testid="placement-cut"]')!.textContent);
    expect(cuts[0]).toMatch(
      /^the potential jump cut at 00:00:10:00 \(24 frames before, 36 after\)/,
    );
    expect(cuts[1]).toMatch(
      /^the potential jump cut at 00:00:17:00 \(24 frames before, 12 after\)/,
    );
    const files = details.map(
      (d) => d.querySelector('[data-testid="placement-source"]')!.textContent,
    );
    expect([...files].sort()).toEqual(["CLIP-005.MP4", "CLIP-006.MP4"]);
    for (const d of details) {
      expect(d.querySelector('[data-testid="placement-source-range"]')!.textContent).toMatch(
        /^\d\d:\d\d:\d\d:\d\d – \d\d:\d\d:\d\d:\d\d/,
      );
      expect(d.querySelector('[data-testid="placement-timeline"]')!.textContent).toMatch(/^V2 · /);
      expect(d.querySelector('[data-testid="placement-evidence"]')!.textContent).toMatch(
        /“(Park sign at the entrance|Empty street corner)” — logged at/,
      );
      expect(d.querySelector('[data-testid="placement-why"]')!.textContent).toMatch(
        /^Covers the potential jump cut/,
      );
      expect(d.querySelector('[data-testid="placement-uncertainty"]')!.textContent).toMatch(
        /one sampled frame.*aren't verified/,
      );
    }
    // The park shot shares "park" with the interview line right after the cut at 240.
    const park = details.find((d) => d.textContent!.includes("Park sign"))!;
    expect(park.querySelector('[data-testid="placement-cut"]')!.textContent).toMatch(/00:00:10:00/);
    expect(park.querySelector('[data-testid="placement-why"]')!.textContent).toMatch(
      /shares "park"/,
    );
    const notes = q("coverage-limitations")!.textContent!;
    expect(notes).toMatch(/one sampled frame; shot boundaries.*not verified/);
    expect(notes).toMatch(/only the stored analysis/);
  }, 30000);

  it("is deterministic: asking again for the same cut gives the identical proposal", async () => {
    prepare();
    await launch(freshDisk());
    mode("cover");
    const first = structuredClone(pr!.pending);
    act(() => q("cover-propose")!.click());
    expect(pr!.pending).toEqual(first);
    mode("edit");
    mode("cover");
    expect(pr!.pending).toEqual(first);
  }, 30000);
});

describe("Original / Proposed", () => {
  it("Proposed adds the B-roll on V2 (markers covered); Original is the cut as it is (markers uncovered); V1 and A1 are untouched", async () => {
    prepare();
    await launch(freshDisk());
    const before = seq();
    mode("cover");
    expect(q("proposal-banner")!.dataset.mode).toBe("after");
    expect(added()).toHaveLength(2);
    expect(markers()).toEqual(["covered", "covered"]);
    const proposed = pr!.previewTimeline!;
    expect(proposed.decisions.filter((d) => d.lane === "b-roll")).toHaveLength(4);
    // Every V1/A1 clip is in the proposed cut exactly as it is now.
    const preview = pr!.review!.ok ? pr!.review!.preview : null;
    for (const [id, it] of Object.entries(before.items))
      expect(preview!.items[id]).toStrictEqual(it);

    act(() => q("compare-before")!.click());
    expect(q("proposal-banner")!.dataset.mode).toBe("before");
    expect(pr!.previewTimeline).toBeNull(); // playback plays the current cut
    expect(markers()).toEqual(["uncovered", "uncovered"]);
    act(() => q("compare-after")!.click());
    expect(pr!.previewTimeline).not.toBeNull();
    expect(seq()).toBe(before);
  }, 30000);
});

describe("Accept and Reject", () => {
  it("Reject leaves the cut and the saved project unchanged", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    mode("cover");
    act(() => q("proposal-reject")!.click());
    expect(pr!.pending).toBeNull();
    expect(seq()).toBe(before);
    expect(markers()).toEqual(["uncovered", "uncovered"]);
    await wait(400);
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);

  it("Accept applies both placements as one saved Director edit that survives relaunch, keeps V1/A1, and undoes and redoes exactly", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    mode("cover");
    act(() => q("proposal-accept")!.click());
    const active = ctx!.activeVersionId;
    const after = seq();
    expect(Object.keys(after.items)).toHaveLength(Object.keys(before.items).length + 2);
    for (const [id, it] of Object.entries(before.items)) expect(after.items[id]).toStrictEqual(it);
    expect(markers()).toEqual(["covered", "covered"]);
    expect(q("coverage-summary")!.textContent).toMatch(
      /0 uncovered · 0 partly covered · 2 covered/,
    );
    await settle(() => disk.saves2 > 0 && q("persistence-status")?.dataset.status === "saved");
    const past = JSON.parse(disk.v2!).histories[active].past;
    expect(past).toHaveLength(1);
    expect(past[0].origin).toBe("director");
    expect(past[0].commands.map((c: { type: string }) => c.type)).toEqual([
      "PlaceEdit",
      "PlaceEdit",
    ]);
    // Nothing left to cover.
    act(() => q("cover-propose")!.click());
    expect(q("coverage-outcome")!.dataset.code).toBe("nothing-to-cover");
    expect(q("coverage-outcome")!.textContent).toBe(
      "Every potential jump cut is already covered — nothing to add.",
    );
    expect(q("proposal-accept")).toBeNull();

    await quit();
    await launch(disk, (c) => c.activeVersionId === active);
    expect(seq()).toEqual(after);
    key("z", { metaKey: true });
    expect(seq()).toEqual(before);
    key("z", { metaKey: true, shiftKey: true });
    expect(seq()).toEqual(after);
  }, 30000);

  it("Accept re-validates: a proposal made stale by a later edit can't be accepted; asking again plans for the new cut", async () => {
    prepare();
    await launch(freshDisk());
    mode("cover");
    const e1 = itemOf(seq(), "event-1");
    dispatch("TrimEdit", { itemId: e1.id, edge: "in", deltaSourceFrames: 1 });
    expect(status()).toBe("Out of date");
    expect((q("proposal-accept") as HTMLButtonElement).disabled).toBe(true);
    const now = seq();
    expect(pr!.accept()?.ok).toBe(false);
    expect(seq()).toBe(now);
    act(() => q("cover-propose")!.click());
    expect(status()).toBe("Ready to review");
  }, 30000);
});

describe("leaving Cover mode", () => {
  it("switching to Edit or Story cancels the pending proposal without applying it", async () => {
    prepare();
    const disk = freshDisk();
    await launch(disk);
    const before = seq();
    for (const other of ["edit", "story"] as const) {
      mode("cover");
      expect(proposalId()).toMatch(/^prp_cover_/);
      expect((q(`mode-${other}`) as HTMLButtonElement).disabled).toBe(false);
      mode(other);
      expect(pr!.pending).toBeNull();
      expect(q("proposal-review")).toBeNull();
      expect(q("coverage-panel")).toBeNull();
      expect(markers()).toEqual([]);
      expect(seq()).toBe(before);
    }
    mode("cover");
    await quit(); // closing CUT with a proposal pending
    expect([disk.saves2, disk.v1]).toEqual([0, schema1File]);
  }, 30000);
});

describe("blocked and empty states", () => {
  it("protected interview footage: both cuts are marked as unsafe to cover, with the reason, and nothing is proposed", async () => {
    prepare();
    await launch(freshDisk());
    const e2 = itemOf(seq(), "event-2");
    dispatch("SetProtection", { itemIds: [e2.id], aiLocked: true });
    mode("cover");
    expect(pr!.pending).toBeNull();
    expect(markers()).toEqual(["blocked", "blocked"]);
    expect(q("coverage-outcome")!.dataset.code).toBe("no-safe-coverage");
    expect(q("coverage-outcome")!.textContent).toMatch(/protected from AI changes/);
    expect(all("[data-skip]").map((s) => s.dataset.skip)).toEqual([
      "director-may-not-cover",
      "director-may-not-cover",
    ]);
    expect(q("proposal-accept")).toBeNull();
  }, 30000);

  it("no logged B-roll, and B-roll too short to cover a cut, are explained — no empty edit", async () => {
    prepare({ evidence: [] });
    await launch(freshDisk());
    const versions = ctx!.versions.length;
    mode("cover");
    expect(q("coverage-outcome")!.dataset.code).toBe("no-safe-coverage");
    expect(q("coverage-outcome")!.textContent).toMatch(/No usable B-roll is available/);
    expect(q("coverage-inventory")!.dataset.candidates).toBe("0");
    expect(ctx!.versions).toHaveLength(versions);
    await quit();

    const short = CLIPS.map((c) => (c.id === "clip-005" ? { ...c, durationSeconds: 0.5 } : c));
    prepare({ clips: short, evidence: [EVIDENCE[0]!] });
    await launch(freshDisk());
    mode("cover");
    expect(q("coverage-outcome")!.textContent).toMatch(/No usable B-roll is available/);
    expect(q("proposal-accept")).toBeNull();
  }, 30000);
});

describe("media roles", () => {
  it("uncertain files are marked and unused; confirming one as B-roll is saved, wins over the automatic role, and replans with it", async () => {
    // clip-005 has speech and no logged face: its role is uncertain.
    const clips = CLIPS.map((c) => (c.id === "clip-005" ? withDialogue(c, "dialogue") : c));
    const evidence = [
      ev("park-1", "clip-005", "00:00:02:00", "Park sign at the entrance"),
      ev("park-2", "clip-005", "00:00:07:00", "Kids on the park swings"),
    ];
    prepare({ clips, evidence });
    const disk = freshDisk();
    await launch(disk);
    mode("cover");
    expect(pr!.pending).toBeNull();
    expect(q("coverage-uncertain-hint")!.textContent).toMatch(
      /^2 logged moments are in files whose role is uncertain/,
    );
    expect(q("coverage-inventory")!.dataset.candidates).toBe("0");
    const row = () => q("media-roles")!.querySelector<HTMLElement>('[data-clip-id="clip-005"]')!;
    expect(row().dataset.role).toBe("uncertain");
    expect(row().className).toMatch(/border-warning/);
    expect((q("media-roles") as HTMLDetailsElement).open).toBe(true);

    const select = row().querySelector("select")!;
    await act(async () => {
      select.value = "b-roll";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(() => row().dataset.source === "override");
    expect(row().dataset.role).toBe("b-roll");
    expect((disk.project as { mediaRoles?: unknown }).mediaRoles).toEqual({
      "CLIP-005.MP4": "b-roll",
    });
    expect(q("coverage-inventory")!.dataset.candidates).toBe("2");
    await settle(() => status() === "Ready to review");
    expect(all('[data-testid="placement-source"]').map((e) => e.textContent)).toEqual([
      "CLIP-005.MP4",
      "CLIP-005.MP4",
    ]);

    // The override persists: after relaunch it is still B-roll.
    await quit();
    await launch(disk);
    mode("cover");
    expect(row().dataset.source).toBe("override");
    expect(status()).toBe("Ready to review");
    // Back to automatic: uncertain again, and unused.
    await act(async () => {
      const s = row().querySelector("select")!;
      s.value = "auto";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(() => row().dataset.source === "automatic");
    expect(row().dataset.role).toBe("uncertain");
    await settle(() => pr!.pending === null);
  }, 30000);
});
