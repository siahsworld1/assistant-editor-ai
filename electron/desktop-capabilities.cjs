// Narrowly scoped desktop capabilities for the Assistant Editor companion.
//
// Security model:
//  - The renderer can never name an arbitrary filesystem path. Media indexing is
//    only performed for roots the *user* picked through the native folder dialog
//    (or roots the main process itself persisted from a previous pick).
//  - Only directory metadata is read: filename, size, mtime, extension. File
//    contents are never read, written or transmitted.
//  - Project metadata is persisted by the main process into userData/projects.json
//    after strict sanitisation, with hard caps on count and string lengths.
//  - No shell execution, no arbitrary write paths, no network access here.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MEDIA_EXTENSIONS = new Set([
  ".mov", ".mp4", ".mxf", ".m4v", ".avi", ".mkv", ".braw", ".r3d", ".arri", ".ari",
  ".wav", ".aif", ".aiff", ".mp3", ".flac", ".m4a",
]);
const ROLE_BY_EXT = {
  audio: new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".m4a"]),
};

const MAX_PROJECTS = 60;
const MAX_FILES = 4000;
const MAX_DEPTH = 4;
const PROJECT_FILE = "projects.json";

function clampString(value, max, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/[\u0000-\u001f]/g, "");
  return trimmed.slice(0, max) || fallback;
}

/** True for absolute, traversal-free paths only. */
function isSafeAbsolutePath(p) {
  if (typeof p !== "string" || !p) return false;
  if (p.includes("\u0000") || p.includes("..")) return false;
  return path.isAbsolute(p) && path.normalize(p) === p.replace(/[/\\]+$/, "") + (p === path.parse(p).root ? "" : "");
}

/** A renderer-supplied root is usable only if the main process authorised it. */
function isAuthorizedRoot(root, authorized) {
  if (typeof root !== "string" || !root) return false;
  if (root.includes("\u0000") || root.includes("..")) return false;
  if (!path.isAbsolute(root)) return false;
  return authorized.has(path.normalize(root));
}

function isMediaFile(filename) {
  return MEDIA_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}

function roleForFile(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  if (ROLE_BY_EXT.audio.has(ext)) return "ambient";
  const base = path.basename(String(filename)).toLowerCase();
  if (/(^|[^a-z])(int|interview|ivw|cam[ab])([^a-z]|$)/.test(base)) return "interview";
  if (/(^|[^a-z])(b[-_ ]?roll|broll|gv|cutaway)([^a-z]|$)/.test(base)) return "b-roll";
  return "interview";
}

/** Strict shape for anything we agree to persist. Unknown fields are dropped. */
function sanitizeProjectRecord(input) {
  if (!input || typeof input !== "object") return null;
  const id = clampString(input.id, 64);
  const name = clampString(input.name, 120);
  if (!id || !name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const mediaRoot = typeof input.mediaRoot === "string" && input.mediaRoot ? input.mediaRoot : "";
  if (mediaRoot && (mediaRoot.includes("\u0000") || mediaRoot.includes(".."))) return null;
  const format = clampString(input.format, 80, "Documentary");
  const profile = clampString(input.profile, 32, "documentary");
  const mediaCount = Number.isFinite(input.mediaCount)
    ? Math.max(0, Math.min(100000, Math.floor(input.mediaCount)))
    : 0;
  return {
    id,
    name,
    client: clampString(input.client, 120, "Unassigned"),
    format,
    profile,
    mediaRoot,
    mediaCount,
    createdAt: clampString(input.createdAt, 40) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const MAX_EXPORT_CHARS = 25_000_000; // ~25MB of text — generous ceiling for an EDL/XML export

class DesktopCapabilities {
  /**
   * @param {{ userDataDir: string, showFolderDialog: () => Promise<string[] | null>,
   *           showSaveDialog: (suggestedName: string) => Promise<string | null> }} deps
   */
  constructor(deps) {
    this.userDataDir = deps.userDataDir;
    this.showFolderDialog = deps.showFolderDialog;
    this.showSaveDialog = deps.showSaveDialog;
    /** Roots the user explicitly picked (or previously persisted). */
    this.authorizedRoots = new Set();
  }

  get storePath() {
    return path.join(this.userDataDir, PROJECT_FILE);
  }

  async readAll() {
    try {
      const raw = await fsp.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.projects) ? parsed.projects : [];
      const projects = list.map(sanitizeProjectRecord).filter(Boolean).slice(0, MAX_PROJECTS);
      for (const p of projects) {
        if (p.mediaRoot) this.authorizedRoots.add(path.normalize(p.mediaRoot));
      }
      return projects;
    } catch {
      return [];
    }
  }

  async writeAll(projects) {
    await fsp.mkdir(this.userDataDir, { recursive: true });
    await fsp.writeFile(this.storePath, JSON.stringify({ projects }, null, 2), "utf8");
  }

  async listProjects() {
    return { ok: true, projects: await this.readAll() };
  }

  async saveProject(record) {
    const clean = sanitizeProjectRecord(record);
    if (!clean) return { ok: false, error: "Project metadata was rejected as invalid." };
    if (clean.mediaRoot && !isAuthorizedRoot(clean.mediaRoot, this.authorizedRoots)) {
      return { ok: false, error: "Media folder was not chosen through the desktop picker." };
    }
    const projects = await this.readAll();
    const idx = projects.findIndex((p) => p.id === clean.id);
    if (idx >= 0) projects[idx] = { ...projects[idx], ...clean };
    else projects.unshift(clean);
    const trimmed = projects.slice(0, MAX_PROJECTS);
    await this.writeAll(trimmed);
    return { ok: true, project: clean, projects: trimmed };
  }

  async deleteProject(id) {
    const key = clampString(id, 64);
    if (!key) return { ok: false, error: "Missing project id." };
    const projects = (await this.readAll()).filter((p) => p.id !== key);
    await this.writeAll(projects);
    return { ok: true, projects };
  }

  /** User-gated: opens the OS folder picker. The renderer cannot pass a path in. */
  async chooseMediaFolder() {
    const picked = await this.showFolderDialog();
    if (!picked || picked.length === 0) return { ok: true, cancelled: true };
    const root = path.normalize(picked[0]);
    this.authorizedRoots.add(root);
    return { ok: true, cancelled: false, path: root };
  }

  /**
   * User-gated file export: the renderer supplies content + a suggested filename
   * only — the OS save dialog picks the real destination path, so the renderer
   * can never write to an arbitrary location on disk. Used for EDL/XML export.
   */
  async exportFile(suggestedName, content) {
    if (typeof content !== "string" || !content) {
      return { ok: false, error: "Nothing to export — empty file content." };
    }
    if (content.length > MAX_EXPORT_CHARS) {
      return { ok: false, error: "Export is larger than the allowed size limit." };
    }
    const safeName = clampString(suggestedName, 120, "assistant-editor-export.edl")
      .replace(/[/\\]/g, "-")
      .replace(/^\.+/, "");
    const destPath = await this.showSaveDialog(safeName || "assistant-editor-export.edl");
    if (!destPath) return { ok: true, cancelled: true };
    try {
      await fsp.writeFile(destPath, content, "utf8");
      return { ok: true, cancelled: false, path: destPath };
    } catch {
      return { ok: false, error: "Could not write the export file to that location." };
    }
  }

  /** Metadata-only recursive listing of an authorised root. */
  async indexMedia(root) {
    if (!isAuthorizedRoot(root, this.authorizedRoots)) {
      return { ok: false, error: "This folder has not been authorised by the desktop picker." };
    }
    const normalized = path.normalize(root);
    let stat;
    try {
      stat = await fsp.stat(normalized);
    } catch {
      return { ok: false, error: "The media folder is no longer available on this workstation." };
    }
    if (!stat.isDirectory()) return { ok: false, error: "The chosen path is not a folder." };

    const files = [];
    let truncated = false;
    const walk = async (dir, depth) => {
      if (depth > MAX_DEPTH || truncated) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // never follow links out of the root
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || !isMediaFile(entry.name)) continue;
        let s;
        try {
          s = await fsp.stat(full);
        } catch {
          continue;
        }
        files.push({
          name: entry.name,
          relPath: path.relative(normalized, full),
          sizeBytes: s.size,
          modifiedAt: s.mtime.toISOString(),
          ext: path.extname(entry.name).toLowerCase(),
          role: roleForFile(entry.name),
        });
        if (files.length >= MAX_FILES) truncated = true;
      }
    };
    await walk(normalized, 0);
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { ok: true, root: normalized, files, truncated };
  }
}

const ACTIONS = new Set([
  "listProjects",
  "saveProject",
  "deleteProject",
  "chooseMediaFolder",
  "indexMedia",
  "exportFile",
]);

/** Dispatcher used by the IPC handler. Rejects anything outside the action list. */
async function handleDesktopAction(caps, action, payload) {
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return { ok: false, error: `Desktop capability not allowed: ${String(action)}` };
  }
  try {
    switch (action) {
      case "listProjects":
        return await caps.listProjects();
      case "saveProject":
        return await caps.saveProject(payload?.project);
      case "deleteProject":
        return await caps.deleteProject(payload?.id);
      case "chooseMediaFolder":
        return await caps.chooseMediaFolder();
      case "indexMedia":
        return await caps.indexMedia(payload?.path);
      case "exportFile":
        return await caps.exportFile(payload?.suggestedName, payload?.content);
      default:
        return { ok: false, error: "Unsupported action" };
    }
  } catch {
    // Normalized message only — no stack traces reach the renderer.
    return { ok: false, error: "The desktop companion could not complete that request." };
  }
}

module.exports = {
  DesktopCapabilities,
  handleDesktopAction,
  sanitizeProjectRecord,
  isAuthorizedRoot,
  isMediaFile,
  roleForFile,
  ACTIONS,
  MAX_FILES,
  MAX_DEPTH,
  MEDIA_EXTENSIONS,
  isSafeAbsolutePath,
  fsExists: (p) => fs.existsSync(p),
};
