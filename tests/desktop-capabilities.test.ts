// Validates the Electron-side capability boundary (CommonJS module under electron/).
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const caps = require_("../electron/desktop-capabilities.cjs") as typeof import("../electron/desktop-capabilities.cjs");
const { DesktopCapabilities, handleDesktopAction, sanitizeProjectRecord, isAuthorizedRoot, isMediaFile, roleForFile } = caps as any;

function fixtureTree() {
  const root = mkdtempSync(path.join(tmpdir(), "ae-media-"));
  mkdirSync(path.join(root, "day01"), { recursive: true });
  mkdirSync(path.join(root, ".hidden"), { recursive: true });
  writeFileSync(path.join(root, "day01", "INT_marisol_A001.mov"), "x");
  writeFileSync(path.join(root, "day01", "broll_sunrise.mp4"), "x");
  writeFileSync(path.join(root, "room_tone.wav"), "x");
  writeFileSync(path.join(root, "notes.txt"), "secret");
  writeFileSync(path.join(root, ".hidden", "hidden.mov"), "x");
  return root;
}

function makeCaps(pick: string | null) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "ae-user-"));
  return new DesktopCapabilities({
    userDataDir,
    showFolderDialog: async () => (pick ? [pick] : null),
  });
}

describe("capability allowlist", () => {
  it("rejects unknown actions", async () => {
    const res = await handleDesktopAction(makeCaps(null), "readFile", { path: "/etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not allowed/);
  });

  it("rejects paths the user never picked", async () => {
    const c = makeCaps(null);
    const res = await handleDesktopAction(c, "indexMedia", { path: "/etc" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not been authorised/);
  });

  it("never authorises traversal or relative roots", () => {
    const allowed = new Set(["/Volumes/Media"]);
    expect(isAuthorizedRoot("/Volumes/Media", allowed)).toBe(true);
    expect(isAuthorizedRoot("/Volumes/Media/../../etc", allowed)).toBe(false);
    expect(isAuthorizedRoot("Media", allowed)).toBe(false);
    expect(isAuthorizedRoot("/etc", allowed)).toBe(false);
  });
});

describe("user-gated media indexing", () => {
  it("indexes only media files under a picked folder", async () => {
    const root = fixtureTree();
    const c = makeCaps(root);
    const picked = await handleDesktopAction(c, "chooseMediaFolder", {});
    expect(picked.ok && picked.path).toBeTruthy();

    const indexed = await handleDesktopAction(c, "indexMedia", { path: root });
    expect(indexed.ok).toBe(true);
    const names = indexed.files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(["INT_marisol_A001.mov", "broll_sunrise.mp4", "room_tone.wav"]);
    expect(names).not.toContain("notes.txt");
    expect(names).not.toContain("hidden.mov");
    expect(indexed.files.every((f: { sizeBytes: number }) => typeof f.sizeBytes === "number")).toBe(true);
  });

  it("does not follow symlinks out of the root", async () => {
    const root = fixtureTree();
    try {
      symlinkSync("/etc", path.join(root, "escape"));
    } catch {
      return; // symlinks unavailable in this sandbox
    }
    const c = makeCaps(root);
    await handleDesktopAction(c, "chooseMediaFolder", {});
    const indexed = await handleDesktopAction(c, "indexMedia", { path: root });
    expect(indexed.files.some((f: { relPath: string }) => f.relPath.startsWith("escape"))).toBe(false);
  });

  it("reports cancellation without authorising anything", async () => {
    const c = makeCaps(null);
    const res = await handleDesktopAction(c, "chooseMediaFolder", {});
    expect(res).toEqual({ ok: true, cancelled: true });
    expect(c.authorizedRoots.size).toBe(0);
  });

  it("classifies roles from filenames", () => {
    expect(isMediaFile("A001.MOV")).toBe(true);
    expect(isMediaFile("notes.txt")).toBe(false);
    expect(roleForFile("broll_city.mp4")).toBe("b-roll");
    expect(roleForFile("room.wav")).toBe("ambient");
  });
});

describe("project persistence", () => {
  it("round-trips records through the main-process store", async () => {
    const root = fixtureTree();
    const c = makeCaps(root);
    await handleDesktopAction(c, "chooseMediaFolder", {});
    const saved = await handleDesktopAction(c, "saveProject", {
      project: { id: "doc-01", name: "Community Documentary", mediaRoot: root },
    });
    expect(saved.ok).toBe(true);
    const listed = await handleDesktopAction(c, "listProjects", {});
    expect(listed.projects).toHaveLength(1);
    const removed = await handleDesktopAction(c, "deleteProject", { id: "doc-01" });
    expect(removed.projects).toHaveLength(0);
  });

  it("refuses to persist a media root that was never picked", async () => {
    const c = makeCaps(null);
    const res = await handleDesktopAction(c, "saveProject", {
      project: { id: "doc-02", name: "Sneaky", mediaRoot: "/etc" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/desktop picker/);
  });

  it("rejects malformed records outright", () => {
    expect(sanitizeProjectRecord({ id: "../x", name: "y" })).toBeNull();
    expect(sanitizeProjectRecord({ id: "x", name: "y", mediaRoot: "/a/../b" })).toBeNull();
  });
});
