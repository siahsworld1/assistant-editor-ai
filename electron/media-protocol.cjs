// A privileged, read-only, streaming protocol for real video/audio preview.
//
// Why this exists instead of `file://` or a loopback HTTP server: `file://` is
// blocked from a sandboxed, contextIsolated renderer by design (and would let the
// renderer name arbitrary paths if it weren't), and a second HTTP server is one
// more open port and one more thing to allowlist/CORS for no real benefit — the
// renderer and main process already share this process's memory. `protocol.handle`
// lets the main process answer `ae-media://` requests directly, entirely in-process,
// with the same "only what the user authorized" boundary already used for project
// persistence and media indexing (electron/desktop-capabilities.cjs).
//
// Security model, mirroring desktop-capabilities.cjs:
//  - Every request is resolved against exactly one root: the *active* project's
//    mediaRoot, which was itself only ever set from a path the user picked through
//    the native folder dialog (see DesktopCapabilities.chooseMediaFolder/authorizedRoots).
//  - The requested relative path is rejected outright if it contains "..", a null
//    byte, or resolves (after normalization) outside that root.
//  - Only read access; no directory listing; no arbitrary host/path forwarding.
//  - Range requests are honored (required for <video> scrubbing) but bounded to the
//    real file size — never trusts a client-supplied range blindly.
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  // Real WATCH-page media-bin thumbnails (worker/media.py::generate_thumbnail)
  // are served through this same protocol, under mediaRoot/.ae_thumbs/*.jpg.
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Must run before `app.whenReady()` — Electron ignores privilege registration afterward. */
function registerMediaProtocolPrivileges(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "ae-media",
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: false,
        bypassCSP: false,
      },
    },
  ]);
}

/** True only for a relative path that, once joined to `root`, cannot escape it. */
function resolveWithinRoot(root, relPath) {
  if (typeof root !== "string" || !root) return null;
  if (typeof relPath !== "string" || !relPath) return null;
  if (relPath.includes("\u0000") || relPath.includes("..")) return null;
  if (path.isAbsolute(relPath)) return null;
  const normalizedRoot = path.normalize(root);
  const resolved = path.normalize(path.join(normalizedRoot, relPath));
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  if (resolved !== normalizedRoot && !resolved.startsWith(withSep)) return null;
  return resolved;
}

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * @param {() => string | null} getActiveMediaRoot
 * @returns {(request: Request) => Promise<Response>}
 */
function createMediaProtocolHandler(getActiveMediaRoot) {
  return async function handleMediaRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const relPath = url.searchParams.get("path") || "";
    const root = getActiveMediaRoot();
    if (!root) {
      return new Response("No project media folder is active in this session.", { status: 404 });
    }
    const resolved = resolveWithinRoot(root, decodeURIComponent(relPath));
    if (!resolved) {
      return new Response("Path rejected.", { status: 403 });
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return new Response("Not found.", { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response("Not found.", { status: 404 });
    }

    const contentType = contentTypeFor(resolved);
    const range = request.headers.get("range");

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        return new Response("Invalid range.", { status: 416 });
      }
      const size = stat.size;
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new Response("Range not satisfiable.", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);
      const nodeStream = fs.createReadStream(resolved, { start, end });
      return new Response(Readable.toWeb(nodeStream), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }

    const nodeStream = fs.createReadStream(resolved);
    return new Response(Readable.toWeb(nodeStream), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  };
}

module.exports = {
  registerMediaProtocolPrivileges,
  createMediaProtocolHandler,
  resolveWithinRoot,
  contentTypeFor,
  CONTENT_TYPES,
};
