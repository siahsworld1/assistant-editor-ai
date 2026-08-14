// Builds ae-media:// URLs for the desktop companion's playback protocol
// (electron/media-protocol.cjs). Pure string logic — the actual authorization
// and path-traversal checks happen in the main process, which is the only
// place that can tell a real path from a spoofed one. This module never
// fabricates a URL for data that isn't real: no relPath means no preview.

import type { Clip } from "./types";

/** Builds the ae-media:// URL for a path relative to the active project's mediaRoot. */
export function mediaUrl(relPath: string): string {
  return `ae-media://local/stream?path=${encodeURIComponent(relPath)}`;
}

/**
 * The best available real preview source for a clip: the generated proxy if
 * analysis has produced one (smaller, and guaranteed H.264/AAC so Chromium can
 * always decode it), falling back to the original file otherwise. Returns null
 * — never a fabricated URL — when this clip has no real file on disk to point
 * at (Demo Mode clips, or a clip indexed but not yet analyzed with no relPath).
 */
export function previewSrcForClip(clip: Clip | null | undefined): string | null {
  if (!clip) return null;
  const rel = clip.proxyRelPath || clip.relPath;
  if (!rel) return null;
  return mediaUrl(rel);
}
