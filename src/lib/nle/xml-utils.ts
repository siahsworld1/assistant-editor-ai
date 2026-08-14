// Small helpers shared by the XML-based export formats (xmeml.ts, fcpxml.ts).
// Kept separate from edl.ts because CMX3600 is plain text with no XML concerns.

import type { Clip } from "../ae/types";

export interface XmlExportResult {
  xml: string;
  /** Non-fatal notes (e.g. a clip's absolute path could not be resolved, or an
   * overlapping decision was dropped). Distinct from validateTimelineForExport's
   * errors, which are about decisions dropped before export ever runs. */
  warnings: string[];
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** XMEML/FCPXML element ids must be simple tokens — sanitize whatever id the
 * engine (or a future AI-generated decision) happened to produce. */
export function sanitizeXmlId(id: string, fallback: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "");
  return cleaned || fallback;
}

export interface ResolvedMediaPath {
  url: string;
  /** Set when we could not build a real absolute path — the caller should warn. */
  resolved: boolean;
}

/**
 * Builds a `file://` URL for a clip's source media. Requires the project's real
 * mediaRoot (an absolute path the user picked via the native folder dialog) plus
 * the clip's relPath. Falls back to a bare-filename reference — which will not
 * resolve on import and needs manual relinking — only when one of those is
 * missing, and always reports that back via `resolved: false` rather than
 * silently pretending the path is real.
 */
export function fileUrlForClip(clip: Clip | undefined, mediaRoot: string): ResolvedMediaPath {
  const filename = clip?.filename || "unknown-clip";
  if (clip?.relPath && mediaRoot) {
    const root = mediaRoot.replace(/[/\\]+$/, "");
    const relParts = clip.relPath.split(/[/\\]/).map((seg) => encodeURIComponent(seg));
    const absParts = root.split(/[/\\]/).filter(Boolean).map((seg) => encodeURIComponent(seg));
    return { url: `file:///${[...absParts, ...relParts].join("/")}`, resolved: true };
  }
  return { url: `file:///${encodeURIComponent(filename)}`, resolved: false };
}
