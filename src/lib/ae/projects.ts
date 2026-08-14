// Local project workflow: metadata records, media indexing results and the
// persistence layer behind them.
//
// Persistence has two backends:
//  - DesktopProjectStore  → main-process JSON file (userData/projects.json)
//  - BrowserProjectStore  → localStorage, for `npm run dev:web` sessions
// Both go through the same pure sanitiser so a corrupted store can never inject
// unexpected shapes into app state.

import type { Clip, ClipRole, EditingProfile, ProjectBrain } from "./types";

export interface ProjectRecord {
  id: string;
  name: string;
  client: string;
  format: string;
  profile: EditingProfile;
  /** Absolute folder chosen by the user in the desktop picker. "" until imported. */
  mediaRoot: string;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IndexedMediaFile {
  name: string;
  relPath: string;
  sizeBytes: number;
  modifiedAt: string;
  ext: string;
  role: ClipRole;
}

export interface MediaIndex {
  root: string;
  files: IndexedMediaFile[];
  truncated: boolean;
}

export const PROJECT_PROFILES: EditingProfile[] = [
  "documentary",
  "commercial",
  "wedding",
  "corporate",
  "social",
];

const MAX_PROJECTS = 60;

function str(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim().replace(/[\u0000-\u001f]/g, "");
  return clean.slice(0, max) || fallback;
}

export function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || "project"}-${suffix}`;
}

/** Pure, defensive normalizer shared by every persistence backend. */
export function sanitizeProject(input: unknown): ProjectRecord | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = str(raw["id"], 64);
  const name = str(raw["name"], 120);
  if (!id || !name || !/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const mediaRoot = str(raw["mediaRoot"], 1024);
  if (mediaRoot.includes("..")) return null;
  const profileRaw = str(raw["profile"], 32, "documentary") as EditingProfile;
  const count = Number(raw["mediaCount"]);
  return {
    id,
    name,
    client: str(raw["client"], 120, "Unassigned"),
    format: str(raw["format"], 80, "Documentary"),
    profile: PROJECT_PROFILES.includes(profileRaw) ? profileRaw : "documentary",
    mediaRoot,
    mediaCount: Number.isFinite(count) ? Math.max(0, Math.min(100000, Math.floor(count))) : 0,
    createdAt: str(raw["createdAt"], 40) || new Date().toISOString(),
    updatedAt: str(raw["updatedAt"], 40) || new Date().toISOString(),
  };
}

export function sanitizeProjects(input: unknown): ProjectRecord[] {
  const list = Array.isArray(input)
    ? input
    : Array.isArray((input as { projects?: unknown })?.projects)
      ? ((input as { projects: unknown[] }).projects)
      : [];
  const out: ProjectRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const clean = sanitizeProject(item);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_PROJECTS) break;
  }
  return out;
}

export function sanitizeMediaIndex(input: unknown): MediaIndex | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const root = str(raw["root"], 1024);
  if (!root) return null;
  const files: IndexedMediaFile[] = [];
  for (const item of Array.isArray(raw["files"]) ? (raw["files"] as unknown[]) : []) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const name = str(f["name"], 260);
    if (!name) continue;
    const roleRaw = str(f["role"], 20, "interview");
    const size = Number(f["sizeBytes"]);
    files.push({
      name,
      relPath: str(f["relPath"], 1024, name),
      sizeBytes: Number.isFinite(size) ? Math.max(0, size) : 0,
      modifiedAt: str(f["modifiedAt"], 40),
      ext: str(f["ext"], 12).toLowerCase(),
      role: (["interview", "b-roll", "ambient"] as const).includes(roleRaw as ClipRole)
        ? (roleRaw as ClipRole)
        : "interview",
    });
  }
  return { root, files, truncated: raw["truncated"] === true };
}

/** Deterministic hue so a clip keeps its colour between sessions. */
function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/**
 * Turn an indexed file into a pending clip. Duration/resolution stay unknown
 * until the engine reports them — the browser never probes video.
 */
export function clipFromMedia(file: IndexedMediaFile, i: number): Clip {
  return {
    id: `clip-${String(i + 1).padStart(3, "0")}`,
    filename: file.name,
    relPath: file.relPath,
    role: file.role,
    durationSeconds: 0,
    camera: file.relPath.includes("/") ? file.relPath.split("/")[0]! : "Media root",
    resolution: "—",
    fps: 0,
    speakers: [],
    state: "pending",
    progress: 0,
    hasTranscript: false,
    visualEvidenceCount: 0,
    technicalIssues: [],
    thumbHue: hueFor(file.relPath),
    note: `${(file.sizeBytes / 1_000_000_000).toFixed(2)} GB · awaiting engine analysis`,
  };
}

/** A ProjectBrain shell for a real, user-created project (no fixture data). */
export function brainFromRecord(record: ProjectRecord, index: MediaIndex | null): ProjectBrain {
  const files = index?.files ?? [];
  return {
    id: record.id,
    name: record.name,
    client: record.client,
    format: record.format,
    createdAt: record.createdAt,
    mediaRoot: record.mediaRoot || "No media folder imported yet",
    clips: files.map(clipFromMedia),
    transcript: [],
    visualEvidence: [],
    summary: {
      speakers: 0,
      strongStatements: 0,
      emotionalMoments: 0,
      brollOpportunities: 0,
      technicalIssues: 0,
      transcribedMinutes: 0,
    },
    analysisState: "idle",
    analysisProgress: 0,
  };
}

export function newProjectRecord(input: {
  name: string;
  client?: string;
  format?: string;
  profile?: EditingProfile;
}): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: slugId(input.name),
    name: str(input.name, 120, "Untitled project"),
    client: str(input.client, 120, "Unassigned"),
    format: str(input.format, 80, "Documentary"),
    profile: input.profile && PROJECT_PROFILES.includes(input.profile) ? input.profile : "documentary",
    mediaRoot: "",
    mediaCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------- persistence

export interface ProjectStore {
  readonly id: "desktop" | "browser" | "memory";
  readonly label: string;
  list(): Promise<ProjectRecord[]>;
  save(record: ProjectRecord): Promise<ProjectRecord[]>;
  remove(id: string): Promise<ProjectRecord[]>;
}

export class DesktopProjectStore implements ProjectStore {
  readonly id = "desktop" as const;
  readonly label = "Desktop companion (userData/projects.json)";

  constructor(private readonly api: NonNullable<Window["assistantEditorDesktop"]>) {}

  async list() {
    const res = await this.api.listProjects();
    if (!res.ok) throw new Error(res.error ?? "Could not read saved projects.");
    return sanitizeProjects(res.projects);
  }

  async save(record: ProjectRecord) {
    const res = await this.api.saveProject(record);
    if (!res.ok) throw new Error(res.error ?? "Could not save this project.");
    return sanitizeProjects(res.projects ?? []);
  }

  async remove(id: string) {
    const res = await this.api.deleteProject(id);
    if (!res.ok) throw new Error(res.error ?? "Could not delete this project.");
    return sanitizeProjects(res.projects ?? []);
  }
}

export const BROWSER_STORE_KEY = "assistant-editor.projects.v1";

/** Dev-only backend so localhost sessions keep their project list too. */
export class BrowserProjectStore implements ProjectStore {
  readonly id = "browser" as const;
  readonly label = "Browser storage (development)";

  private read(): ProjectRecord[] {
    try {
      return sanitizeProjects(JSON.parse(window.localStorage.getItem(BROWSER_STORE_KEY) ?? "[]"));
    } catch {
      return [];
    }
  }

  private write(list: ProjectRecord[]) {
    window.localStorage.setItem(BROWSER_STORE_KEY, JSON.stringify(list));
    return list;
  }

  async list() {
    return this.read();
  }

  async save(record: ProjectRecord) {
    const list = this.read();
    const idx = list.findIndex((p) => p.id === record.id);
    if (idx >= 0) list[idx] = record;
    else list.unshift(record);
    return this.write(list.slice(0, MAX_PROJECTS));
  }

  async remove(id: string) {
    return this.write(this.read().filter((p) => p.id !== id));
  }
}

export class MemoryProjectStore implements ProjectStore {
  readonly id = "memory" as const;
  readonly label = "In-memory (not persisted)";
  private list_: ProjectRecord[] = [];

  async list() {
    return this.list_;
  }
  async save(record: ProjectRecord) {
    const idx = this.list_.findIndex((p) => p.id === record.id);
    if (idx >= 0) this.list_[idx] = record;
    else this.list_ = [record, ...this.list_];
    return this.list_;
  }
  async remove(id: string) {
    this.list_ = this.list_.filter((p) => p.id !== id);
    return this.list_;
  }
}

export function resolveProjectStore(): ProjectStore {
  if (typeof window === "undefined") return new MemoryProjectStore();
  const desktop = window.assistantEditorDesktop;
  if (desktop?.available) return new DesktopProjectStore(desktop);
  try {
    window.localStorage.getItem(BROWSER_STORE_KEY);
    return new BrowserProjectStore();
  } catch {
    return new MemoryProjectStore();
  }
}

export interface MediaImportOutcome {
  status: "imported" | "cancelled" | "unavailable" | "error";
  index?: MediaIndex;
  error?: string;
}

/** Native folder pick + metadata-only index. Desktop companion only. */
export async function importMediaFolder(): Promise<MediaImportOutcome> {
  const desktop = typeof window === "undefined" ? undefined : window.assistantEditorDesktop;
  if (!desktop?.available) {
    return {
      status: "unavailable",
      error:
        "Media import needs the Assistant Editor desktop companion — a browser tab cannot read a media folder.",
    };
  }
  const picked = await desktop.chooseMediaFolder();
  if (!picked.ok) return { status: "error", error: picked.error ?? "Folder picker failed." };
  if (picked.cancelled || !picked.path) return { status: "cancelled" };
  const indexed = await desktop.indexMedia(picked.path);
  if (!indexed.ok) return { status: "error", error: indexed.error ?? "Could not index this folder." };
  const index = sanitizeMediaIndex(indexed);
  if (!index) return { status: "error", error: "The media index came back in an unreadable shape." };
  return { status: "imported", index };
}
