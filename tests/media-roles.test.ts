// Phase 7, Milestone 3 — media roles reach the app: the engine's dialogue
// assessment is parsed onto each clip, and a filmmaker override is saved on
// the project record (by relative filename) through the existing project
// store — never in the timeline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProjectPatch } from "@/lib/ae/normalize";
import { ctx, freshDisk, launch, teardown } from "./helpers/cut-harness";

afterEach(teardown);

describe("dialogue assessment from the engine", () => {
  it("is parsed onto clips; anything malformed is ignored, not guessed", () => {
    const patch = normalizeProjectPatch({
      project: {
        clips: [
          {
            id: "a",
            filename: "A.MP4",
            dialogue: { status: "non-dialogue", reasons: ["no speech"] },
          },
          { id: "b", filename: "B.MP4", dialogue: { status: "maybe", reasons: [] } },
          { id: "c", filename: "C.MP4" },
        ],
      },
    });
    const byId = new Map((patch.clips ?? []).map((c) => [c.id, c]));
    expect(byId.get("a")!.dialogue).toEqual({ status: "non-dialogue", reasons: ["no speech"] });
    expect(byId.get("b")!.dialogue).toBeUndefined();
    expect(byId.get("c")!.dialogue).toBeUndefined();
  });
});

describe("filmmaker media-role overrides", () => {
  it("are saved on the project record by relative filename, and can be cleared", async () => {
    await launch(freshDisk());
    const save = window.assistantEditorDesktop!.saveProject as ReturnType<typeof vi.fn>;
    const clip = ctx!.project!.clips.find((c) => c.id === "clip-003")!;
    const key = clip.relPath ?? clip.filename;
    let ok = false;
    await vi.waitFor(async () => {
      ok = await ctx!.setMediaRole("clip-003", "b-roll");
      expect(ok).toBe(true);
    });
    const saved = save.mock.calls.at(-1)![0] as { mediaRoles?: Record<string, string> };
    expect(saved.mediaRoles).toEqual({ [key]: "b-roll" });
    expect(await ctx!.setMediaRole("clip-003", null)).toBe(true);
    expect(
      (save.mock.calls.at(-1)![0] as { mediaRoles?: Record<string, string> }).mediaRoles,
    ).toEqual({});
    expect(await ctx!.setMediaRole("clip-999", "b-roll")).toBe(false); // unknown clip
  }, 30000);
});
