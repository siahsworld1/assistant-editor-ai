// Where the app keeps its local data. Electron derives the userData folder
// from package.json "name", which is still the Lovable template's
// "tanstack_start_ts" — so projects lived in ~/Library/Application Support/
// tanstack_start_ts. The app now uses its real product identity:
//   - packaged:    ~/Library/Application Support/Assistant Editor AI
//   - development: ~/Library/Application Support/Assistant Editor AI (Development)
// (separate, so a dev session can never rewrite the real app's projects).
//
// Existing data is COPIED (never moved or deleted) from the legacy folder the
// first time a new folder has no projects of its own, so nobody loses a
// project in the transition and the legacy folder stays as a fallback.
const fs = require("node:fs");
const path = require("node:path");

const PRODUCT_NAME = "Assistant Editor AI";
const LEGACY_DIR_NAME = "tanstack_start_ts";
const MIGRATED_ITEMS = ["projects.json", "app-state.json", "edit-state"];
const MIGRATION_MARKER = "migrated-from-tanstack_start_ts.json";

function userDataDirName(isPackaged) {
  return isPackaged ? PRODUCT_NAME : `${PRODUCT_NAME} (Development)`;
}

/** Copy-only, idempotent, synchronous (runs before app "ready"). Never throws. */
function migrateLegacyUserData({ legacyDir, targetDir }) {
  try {
    if (fs.existsSync(path.join(targetDir, "projects.json"))) {
      return { migrated: false, reason: "target-has-data" };
    }
    if (!fs.existsSync(path.join(legacyDir, "projects.json"))) {
      return { migrated: false, reason: "nothing-to-migrate" };
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const copied = [];
    for (const item of MIGRATED_ITEMS) {
      const from = path.join(legacyDir, item);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(targetDir, item), {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      copied.push(item);
    }
    fs.writeFileSync(
      path.join(targetDir, MIGRATION_MARKER),
      JSON.stringify({ from: legacyDir, copied, at: new Date().toISOString() }, null, 2),
    );
    return { migrated: true, copied };
  } catch (err) {
    return { migrated: false, reason: `error: ${err && err.message}` };
  }
}

/** Call before app "ready". */
function configureAppIdentity(app) {
  app.setName(PRODUCT_NAME);
  const appData = app.getPath("appData");
  const targetDir = path.join(appData, userDataDirName(app.isPackaged));
  const migration = migrateLegacyUserData({
    legacyDir: path.join(appData, LEGACY_DIR_NAME),
    targetDir,
  });
  app.setPath("userData", targetDir);
  return { userData: targetDir, migration };
}

module.exports = {
  PRODUCT_NAME,
  LEGACY_DIR_NAME,
  MIGRATION_MARKER,
  userDataDirName,
  migrateLegacyUserData,
  configureAppIdentity,
};
