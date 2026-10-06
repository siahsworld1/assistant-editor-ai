// @vitest-environment node
// P0 Step 8: what survives quitting the app (main-process side), and the move
// of local app data from the template identity "tanstack_start_ts" to
// "Assistant Editor AI". Real files in temp folders — never the user's.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
