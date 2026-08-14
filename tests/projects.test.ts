import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_STORE_KEY,
  BrowserProjectStore,
  brainFromRecord,
  clipFromMedia,
  newProjectRecord,
  sanitizeMediaIndex,
  sanitizeProject,
  sanitizeProjects,
  type IndexedMediaFile,
} from "../src/lib/ae/projects";

const file = (over: Partial<IndexedMediaFile> = {}): IndexedMediaFile => ({
  name: "INT_marisol_A001.mov",
  relPath: "day01/INT_marisol_A001.mov",
  sizeBytes: 12_000_000_000,
  modifiedAt: "2026-08-01T10:00:00.000Z",
  ext: ".mov",
  role: "interview",
  ...over,
});

describe("project record sanitisation", () => {
  it("accepts a well-formed record", () => {
    const rec = sanitizeProject({ id: "doc-01", name: "Community Documentary", profile: "wedding" });
    expect(rec?.id).toBe("doc-01");
    expect(rec?.profile).toBe("wedding");
    expect(rec?.client).toBe("Unassigned");
  });

  it("rejects unusable ids and traversal media roots", () => {
    expect(sanitizeProject({ id: "../etc", name: "x" })).toBeNull();
    expect(sanitizeProject({ id: "ok", name: "" })).toBeNull();
    expect(sanitizeProject({ id: "ok", name: "x", mediaRoot: "/media/../../etc" })).toBeNull();
    expect(sanitizeProject(null)).toBeNull();
  });

  it("falls back to a known profile and clamps counts", () => {
    const rec = sanitizeProject({ id: "a", name: "b", profile: "hacker", mediaCount: -5 });
    expect(rec?.profile).toBe("documentary");
    expect(rec?.mediaCount).toBe(0);
  });

  it("drops duplicates and junk from a stored list", () => {
    const list = sanitizeProjects({
      projects: [
        { id: "a", name: "A" },
        { id: "a", name: "A again" },
        { id: "!!", name: "bad" },
        "nope",
      ],
    });
    expect(list.map((p) => p.id)).toEqual(["a"]);
  });

  it("mints new records with a slug id", () => {
    const rec = newProjectRecord({ name: "Community Documentary" });
    expect(rec.id).toMatch(/^community-documentary-[a-z0-9]{5}$/);
    expect(rec.mediaRoot).toBe("");
  });
});

describe("media index normalisation", () => {
  it("normalises a bridge response and unknown roles", () => {
    const index = sanitizeMediaIndex({
      root: "/Volumes/Media/CommunityDoc",
      files: [file(), { name: "x.wav", role: "weird" }, null],
      truncated: true,
    });
    expect(index?.files).toHaveLength(2);
    expect(index?.files[1]?.role).toBe("interview");
    expect(index?.truncated).toBe(true);
  });

  it("rejects a rootless payload", () => {
    expect(sanitizeMediaIndex({ files: [] })).toBeNull();
  });
});

describe("indexed media drives the project brain", () => {
  it("creates pending clips with no invented analysis data", () => {
    const clip = clipFromMedia(file(), 0);
    expect(clip.id).toBe("clip-001");
    expect(clip.state).toBe("pending");
    expect(clip.hasTranscript).toBe(false);
    expect(clip.durationSeconds).toBe(0);
  });

  it("builds a fixture-free brain from a record plus index", () => {
    const rec = newProjectRecord({ name: "Doc" });
    const brain = brainFromRecord(
      { ...rec, mediaRoot: "/Volumes/Media" },
      { root: "/Volumes/Media", files: [file(), file({ name: "b.wav", role: "ambient" })], truncated: false },
    );
    expect(brain.clips).toHaveLength(2);
    expect(brain.transcript).toHaveLength(0);
    expect(brain.summary.speakers).toBe(0);
    expect(brain.analysisState).toBe("idle");
  });

  it("shows an honest placeholder when no media is imported", () => {
    const brain = brainFromRecord(newProjectRecord({ name: "Doc" }), null);
    expect(brain.clips).toHaveLength(0);
    expect(brain.mediaRoot).toMatch(/No media folder/);
  });
});

describe("browser project store", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists, updates and removes records", async () => {
    const store = new BrowserProjectStore();
    const rec = newProjectRecord({ name: "Doc" });
    await store.save(rec);
    expect(await store.list()).toHaveLength(1);
    await store.save({ ...rec, name: "Doc v2" });
    expect((await store.list())[0]?.name).toBe("Doc v2");
    expect(await store.remove(rec.id)).toHaveLength(0);
  });

  it("survives a corrupted store", async () => {
    window.localStorage.setItem(BROWSER_STORE_KEY, "{{not json");
    expect(await new BrowserProjectStore().list()).toEqual([]);
  });
});
