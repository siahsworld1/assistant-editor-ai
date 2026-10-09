// @vitest-environment node
// P0 Step 8: what survives quitting the app (main-process side), and the move
// of local app data from the template identity "tanstack_start_ts" to
// "Assistant Editor AI". Real files in temp folders — never the user's.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);

const { DesktopCapabilities, handleDesktopAction } = require_(
  "../electron/desktop-capabilities.cjs",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identity = require_("../electron/app-identity.cjs") as any;

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const caps = () =>
  new DesktopCapabilities({ userDataDir: tmp("ae-userdata-"), showFolderDialog: async () => null });
const savedState = (analysisId: string) => ({
  schema: 1,
  analysisId,
  versions: [
    { id: "v1", timeline: { decisions: [] } },
    { id: "v2", timeline: { decisions: [{ id: "e1" }] } },
  ],
  activeVersionId: "v2",
  chosenStoryId: "story-02",
  targetSeconds: 30,
  storyboardSelectIds: ["sel-03"],
});

describe("per-project edit state (versions, active cut, chosen story)", () => {
  it("round-trips through the real IPC dispatcher", async () => {
    const c = caps();
    expect(
      (await handleDesktopAction(c, "saveEditState", { id: "proj-1", state: savedState("a1") })).ok,
    ).toBe(true);
    const loaded = await handleDesktopAction(c, "loadEditState", { id: "proj-1" });
    expect(loaded).toEqual({ ok: true, state: savedState("a1") });
    expect(
      (await handleDesktopAction(c, "loadEditState", { id: "proj-unknown" })).state,
    ).toBeNull();
  });

  it("writes atomically: no partial file is ever left behind, and an interrupted write keeps the last good state", async () => {
    const c = caps();
    await c.saveEditState("proj-1", savedState("a1"));
    const dir = path.join(c.userDataDir, "edit-state");
    expect(readdirSync(dir)).toEqual(["proj-1.json"]);
    // A crash mid-write leaves only a .partial next to the real file.
    writeFileSync(path.join(dir, "proj-1.json.partial"), "{ truncated");
    expect((await c.loadEditState("proj-1")).state).toEqual(savedState("a1"));
    await c.saveEditState("proj-1", savedState("a2"));
    expect((await c.loadEditState("proj-1")).state.analysisId).toBe("a2");
    expect(readdirSync(dir)).toEqual(["proj-1.json"]);
  });

  it("rejects ids that could escape the edit-state folder, and oversized state", async () => {
    const c = caps();
    for (const id of ["../projects", "a/b", "", "x".repeat(65)]) {
      expect((await c.saveEditState(id, savedState("a"))).ok).toBe(false);
      expect((await c.loadEditState(id)).ok).toBe(false);
    }
    const huge = { ...savedState("a"), blob: "x".repeat(9 * 1024 * 1024) };
    expect((await c.saveEditState("proj-1", huge)).ok).toBe(false);
    expect(existsSync(path.join(c.userDataDir, "edit-state", "proj-1.json"))).toBe(false);
  });

  it("is removed with its project", async () => {
    const c = caps();
    await c.saveEditState("proj-1", savedState("a1"));
    await c.deleteProject("proj-1");
    expect((await c.loadEditState("proj-1")).state).toBeNull();
  });
});

describe("schema-2 edit state (1.1) beside beta.1's schema-1 file", () => {
  const v2State = (analysisId: string) => ({
    schema: 2,
    analysisId,
    versions: [{ id: "v2", timeline: { decisions: [] } }],
    histories: {},
    activeVersionId: "v2",
    chosenStoryId: null,
    targetSeconds: 30,
    storyboardSelectIds: [],
  });

  it("lives in its own file and never touches the schema-1 file", async () => {
    const c = caps();
    await c.saveEditState("proj-1", savedState("a1"));
    const v1File = path.join(c.userDataDir, "edit-state", "proj-1.json");
    const v1Bytes = readFileSync(v1File);
    expect((await handleDesktopAction(c, "loadEditStateV2", { id: "proj-1" })).state).toBeNull();
    expect(
      (await handleDesktopAction(c, "saveEditStateV2", { id: "proj-1", state: v2State("a1") })).ok,
    ).toBe(true);
    expect(readdirSync(path.join(c.userDataDir, "edit-state")).sort()).toEqual([
      "proj-1.json",
      "proj-1.v2.json",
    ]);
    expect(readFileSync(v1File).equals(v1Bytes)).toBe(true);
    expect((await handleDesktopAction(c, "loadEditStateV2", { id: "proj-1" })).state).toEqual(
      v2State("a1"),
    );
    expect((await c.loadEditState("proj-1")).state).toEqual(savedState("a1"));
  });

  it("accepts only schema-2 state, with the same id and size rules", async () => {
    const c = caps();
    expect((await c.saveEditStateV2("proj-1", savedState("a1"))).ok).toBe(false); // schema 1
    for (const id of ["../projects", "a/b", ""]) {
      expect((await c.saveEditStateV2(id, v2State("a"))).ok).toBe(false);
      expect((await c.loadEditStateV2(id)).ok).toBe(false);
    }
    const huge = { ...v2State("a"), blob: "x".repeat(9 * 1024 * 1024) };
    expect((await c.saveEditStateV2("proj-1", huge)).ok).toBe(false);
  });

  /** A project with a valid schema-2 file already on disk. */
  async function withSavedFile() {
    const c = caps();
    expect((await c.saveEditStateV2("proj-1", v2State("a1"))).ok).toBe(true);
    const file = path.join(c.userDataDir, "edit-state", "proj-1.v2.json");
    return { c, file, before: readFileSync(file) };
  }
  const leftovers = (c: { userDataDir: string }) =>
    readdirSync(path.join(c.userDataDir, "edit-state")).filter((f) => f.endsWith(".partial"));

  it("a damaged file reads as no state, and a copy is kept (once) before a later save can replace it", async () => {
    const { c, file } = await withSavedFile();
    const damaged = readFileSync(file).subarray(0, 20);
    writeFileSync(file, damaged);
    const dir = path.join(c.userDataDir, "edit-state");
    const first = await handleDesktopAction(c, "loadEditStateV2", { id: "proj-1" });
    expect(first).toMatchObject({ ok: true, state: null, unreadable: true });
    expect(first.preservedAs).toMatch(/^proj-1\.v2\.unreadable-[0-9a-f]{12}\.json$/);
    expect(readFileSync(path.join(dir, first.preservedAs)).equals(damaged)).toBe(true);
    // Reopening the same damaged file keeps the one copy.
    const again = await handleDesktopAction(c, "loadEditStateV2", { id: "proj-1" });
    expect(again.preservedAs).toBe(first.preservedAs);
    expect(readdirSync(dir).filter((f) => f.includes("unreadable"))).toEqual([first.preservedAs]);
    // The next save replaces the damaged file; the copy stays.
    expect((await c.saveEditStateV2("proj-1", v2State("a2"))).ok).toBe(true);
    expect((await c.loadEditStateV2("proj-1")).state).toEqual(v2State("a2"));
    expect(readFileSync(path.join(dir, first.preservedAs)).equals(damaged)).toBe(true);
    // A readable file is never copied.
    expect(readdirSync(dir).filter((f) => f.includes("unreadable"))).toHaveLength(1);
  });

  it("rejects an oversize save (in bytes, not characters) and keeps the previous file", async () => {
    const { c, file, before } = await withSavedFile();
    const huge = { ...v2State("a1"), blob: "x".repeat(9 * 1024 * 1024) };
    expect(await c.saveEditStateV2("proj-1", huge)).toEqual({
      ok: false,
      code: "too-large",
      error: "Edit state is too large to save.",
    });
    // 4.5 M two-byte characters: under 8 M characters, over 8 MB on disk.
    const wide = { ...v2State("a1"), blob: "é".repeat(4.5 * 1024 * 1024) };
    expect((await c.saveEditStateV2("proj-1", wide)).code).toBe("too-large");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(leftovers(c)).toEqual([]);
  });

  it("a failed write keeps the previous file intact, leaves no partial file and says so", async () => {
    const { c, file, before } = await withSavedFile();
    const rename = vi
      .spyOn(fsp, "rename")
      .mockRejectedValueOnce(
        Object.assign(new Error("EIO: i/o error, /private/x"), { code: "EIO" }),
      );
    try {
      const res = await handleDesktopAction(c, "saveEditStateV2", {
        id: "proj-1",
        state: { ...v2State("a1"), targetSeconds: 99 },
      });
      expect(res).toEqual({
        ok: false,
        code: "write-failed",
        error: "The edit state could not be written.",
      });
      expect(JSON.stringify(res)).not.toMatch(/EIO|private/); // no system details leak
    } finally {
      rename.mockRestore();
    }
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(leftovers(c)).toEqual([]);
    // Retrying succeeds and replaces the file.
    expect((await c.saveEditStateV2("proj-1", { ...v2State("a1"), targetSeconds: 99 })).ok).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(file, "utf8")).targetSeconds).toBe(99);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a real disk failure (read-only folder) keeps the previous file; retry succeeds once writable",
    async () => {
      const { c, file, before } = await withSavedFile();
      const dir = path.dirname(file);
      chmodSync(dir, 0o500);
      try {
        const res = await c.saveEditStateV2("proj-1", { ...v2State("a1"), targetSeconds: 77 });
        expect(res.ok).toBe(false);
        expect(res.code).toBe("write-failed");
        expect(readFileSync(file).equals(before)).toBe(true);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(leftovers(c)).toEqual([]);
      expect((await c.saveEditStateV2("proj-1", { ...v2State("a1"), targetSeconds: 77 })).ok).toBe(
        true,
      );
      expect(JSON.parse(readFileSync(file, "utf8")).targetSeconds).toBe(77);
    },
  );

  it("is removed with its project, together with the schema-1 file", async () => {
    const c = caps();
    await c.saveEditState("proj-1", savedState("a1"));
    await c.saveEditStateV2("proj-1", v2State("a1"));
    await c.deleteProject("proj-1");
    expect((await c.loadEditState("proj-1")).state).toBeNull();
    expect((await c.loadEditStateV2("proj-1")).state).toBeNull();
  });
});

describe("active project (which project reopens on launch)", () => {
  it("persists in the main process, independent of the renderer's origin", async () => {
    const c = caps();
    expect(await handleDesktopAction(c, "getActiveProject", {})).toEqual({ ok: true, id: null });
    expect((await handleDesktopAction(c, "setActiveProject", { id: "proj-2" })).ok).toBe(true);
    // A brand-new capabilities object = a relaunch reading the same folder.
    const relaunched = new DesktopCapabilities({
      userDataDir: c.userDataDir,
      showFolderDialog: async () => null,
    });
    expect(await relaunched.getActiveProject()).toEqual({ ok: true, id: "proj-2" });
    expect((await relaunched.setActiveProject("../evil")).ok).toBe(false);
  });
});

describe("app identity: tanstack_start_ts → Assistant Editor AI", () => {
  const digest = (dir: string) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .sort()
      .map((f) => {
        const p = path.join(dir, f);
        try {
          return `${f}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
        } catch {
          return `${f}/`;
        }
      })
      .join("\n");

  function legacyFolder() {
    const appData = tmp("ae-appdata-");
    const legacy = path.join(appData, identity.LEGACY_DIR_NAME);
    mkdirSync(path.join(legacy, "edit-state"), { recursive: true });
    writeFileSync(
      path.join(legacy, "projects.json"),
      JSON.stringify({ projects: [{ id: "proj-1", name: "Doc" }] }),
    );
    writeFileSync(
      path.join(legacy, "app-state.json"),
      JSON.stringify({ activeProjectId: "proj-1" }),
    );
    writeFileSync(path.join(legacy, "edit-state", "proj-1.json"), JSON.stringify(savedState("a1")));
    writeFileSync(path.join(legacy, "Cookies"), "chromium state that is NOT migrated");
    return { appData, legacy };
  }

  it("copies projects, active project and edit state — and leaves the legacy folder byte-identical", () => {
    const { appData, legacy } = legacyFolder();
    const before = digest(legacy);
    const target = path.join(appData, identity.PRODUCT_NAME);
    const res = identity.migrateLegacyUserData({ legacyDir: legacy, targetDir: target });
    expect(res).toEqual({
      migrated: true,
      copied: ["projects.json", "app-state.json", "edit-state"],
    });
    expect(
      JSON.parse(readFileSync(path.join(target, "projects.json"), "utf8")).projects[0].id,
    ).toBe("proj-1");
    expect(
      JSON.parse(readFileSync(path.join(target, "edit-state", "proj-1.json"), "utf8")).analysisId,
    ).toBe("a1");
    expect(existsSync(path.join(target, "Cookies"))).toBe(false);
    expect(digest(legacy)).toBe(before); // copy-only: nothing moved, deleted or changed
  });

  it("never overwrites a folder that already has projects, and is a no-op without legacy data", () => {
    const { appData, legacy } = legacyFolder();
    const target = path.join(appData, identity.PRODUCT_NAME);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "projects.json"),
      JSON.stringify({ projects: [{ id: "newer", name: "Kept" }] }),
    );
    expect(identity.migrateLegacyUserData({ legacyDir: legacy, targetDir: target })).toEqual({
      migrated: false,
      reason: "target-has-data",
    });
    expect(
      JSON.parse(readFileSync(path.join(target, "projects.json"), "utf8")).projects[0].id,
    ).toBe("newer");
    const empty = tmp("ae-appdata-empty-");
    expect(
      identity.migrateLegacyUserData({
        legacyDir: path.join(empty, "nope"),
        targetDir: path.join(empty, "t"),
      }).reason,
    ).toBe("nothing-to-migrate");
  });

  it("uses the product identity for packaged builds and a separate folder for development", () => {
    for (const isPackaged of [true, false]) {
      const { appData } = legacyFolder();
      const calls: Record<string, unknown> = {};
      const app = {
        isPackaged,
        setName: (n: string) => (calls.name = n),
        getPath: (k: string) => (k === "appData" ? appData : ""),
        setPath: (k: string, v: string) => (calls[k] = v),
      };
      const res = identity.configureAppIdentity(app);
      const expectedDir = isPackaged ? "Assistant Editor AI" : "Assistant Editor AI (Development)";
      expect(calls.name).toBe("Assistant Editor AI");
      expect(calls.userData).toBe(path.join(appData, expectedDir));
      expect(res.migration.migrated).toBe(true);
    }
  });
});
