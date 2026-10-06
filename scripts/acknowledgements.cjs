// Third-party acknowledgements for the packaged app, generated at build time
// from what actually ships (see scripts/after-pack.cjs):
//
//   Resources/licenses/Acknowledgements.html   one page: every component, its
//                                               licence and licence text
//   Resources/licenses/LICENSES.chromium.html  Chromium's own (large) notices
//
// Sources:
//   - FFmpeg: Resources/ffmpeg/LICENSES (written by scripts/prepare-ffmpeg.py,
//     including the exact source URL, checksum and configure flags)
//   - Electron + Chromium: node_modules/electron/dist/LICENSE{,S.chromium.html}
//   - Python: the pinned interpreter's LICENSE.txt, plus the libraries
//     python-build-standalone compiles into libpython
//   - Python packages: the licence files inside the shipped worker bundle
//     (Resources/worker/_internal/*.dist-info — exactly what ships)
//   - npm packages: everything the interface imports (src/ + the bundled
//     server runtime), with their runtime dependencies, from node_modules
const fs = require("node:fs");
const path = require("node:path");

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)(\.|$|-)/i;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readIf(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Licence/notice files directly inside `dir` (and a dist-info `licenses/` tree). */
function licenceTexts(dir) {
  const out = [];
  const visit = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && /^licen[cs]es$/i.test(e.name)) visit(full, path.join(rel, e.name));
      else if (e.isDirectory() && rel) visit(full, path.join(rel, e.name));
      else if (e.isFile() && (rel || LICENSE_FILE.test(e.name))) {
        const text = readIf(full);
        if (text) out.push({ file: path.join(rel, e.name), text });
      }
    }
  };
  visit(dir, "");
  return out;
}

// --------------------------------------------------------------------------- //
// npm packages in the interface
// --------------------------------------------------------------------------- //
// Exactly the packages whose code is in the built interface: the client
// chunks' (hidden, never shipped) source maps list every bundled module, the
// server bundle names each bundled module in a `//#region <path>` comment, and
// the server's own node_modules ships as-is.

/** The package directory a bundled module path belongs to, or null. */
function packageDirOf(modulePath) {
  const marker = "/node_modules/";
  const at = modulePath.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = modulePath.slice(at + marker.length).split("/");
  if (!rest[0] || rest[0].startsWith(".")) return null; // e.g. node_modules/.nitro (generated)
  const depth = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length <= depth) return null;
  return modulePath.slice(0, at + marker.length) + rest.slice(0, depth).join("/");
}

function listFiles(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

/** Package directories whose modules are bundled into `distDir` (dist-desktop). */
function bundledPackageDirs({ distDir, repoRoot }) {
  const dirs = new Set();
  const add = (modulePath) => {
    const dir = packageDirOf(modulePath.replaceAll("\\", "/"));
    if (dir) dirs.add(dir);
  };
  const maps = listFiles(path.join(distDir, "public"), [".js.map"]);
  if (!maps.length) throw new Error(`no client source maps in ${distDir}/public — build with vite.desktop.config.ts`);
  for (const map of maps) {
    for (const source of JSON.parse(fs.readFileSync(map, "utf8")).sources || []) {
      add(path.resolve(path.dirname(map), source));
    }
  }
  for (const file of listFiles(path.join(distDir, "server"), [".mjs", ".js"])) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/^\/\/#region (\S+)/gm)) {
      add(path.resolve(repoRoot, m[1]));
    }
  }
  // Chunks without region comments: the intermediate SSR bundle Vite writes
  // for Nitro (same build) still has them, and lib chunks are named after
  // their packages ("h3+rou3+srvx.mjs", "radix-ui__number.mjs",
  // "@tanstack/router-core+[...].mjs").
  const ssrIntermediate = path.join(repoRoot, "node_modules", ".nitro", "vite", "services", "ssr");
  if (fs.existsSync(ssrIntermediate)) {
    for (const file of listFiles(ssrIntermediate, [".js", ".mjs"])) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/^\/\/#region (\S+)/gm)) add(path.resolve(repoRoot, m[1]));
    }
  }
  const libs = path.join(distDir, "server", "_libs");
  if (fs.existsSync(libs)) {
    for (const file of listFiles(libs, [".mjs"])) {
      const rel = path.relative(libs, file).replace(/\.mjs$/, "");
      const scope = rel.includes("/") ? `${rel.split("/")[0]}/` : "";
      for (const part of path.basename(rel).split("+")) {
        if (part === "[...]") continue;
        const name = scope ? scope + part : part.includes("__") ? `@${part.replace("__", "/")}` : part;
        const dir = path.join(repoRoot, "node_modules", name);
        if (fs.existsSync(path.join(dir, "package.json"))) add(path.join(dir, "index.js"));
      }
    }
  }
  const serverModules = path.join(distDir, "server", "node_modules");
  if (fs.existsSync(serverModules)) {
    for (const name of fs.readdirSync(serverModules)) {
      if (!name.startsWith(".")) add(path.join(serverModules, name, "index.js"));
    }
  }
  return dirs;
}

/** The interface's bundled npm packages, with licence details. */
function interfacePackages({ distDir, repoRoot }) {
  const packages = [];
  const missing = [];
  for (const dir of bundledPackageDirs({ distDir, repoRoot })) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) {
      missing.push(path.relative(repoRoot, dir));
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (!pkg.name) continue; // nested package.json used only for "type"/exports
    packages.push({
      name: pkg.name,
      version: pkg.version || "",
      license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type || "",
      homepage: pkg.homepage || "",
      // A traced copy can drop its licence file; the installed package has it.
      texts: licenceTexts(dir).length ? licenceTexts(dir) : licenceTexts(path.join(repoRoot, "node_modules", pkg.name)),
    });
  }
  const unique = new Map(packages.map((p) => [`${p.name}@${p.version}`, p]));
  return {
    packages: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    missing,
  };
}

// --------------------------------------------------------------------------- //
// Python packages in the worker bundle
// --------------------------------------------------------------------------- //
function metadataField(metadata, field) {
  const m = metadata.match(new RegExp(`^${field}: (.+)$`, "m"));
  return m ? m[1].trim() : "";
}

function workerPackages(internalDir) {
  const out = [];
  for (const entry of fs.readdirSync(internalDir).sort()) {
    if (!entry.endsWith(".dist-info")) continue;
    const dir = path.join(internalDir, entry);
    const metadata = readIf(path.join(dir, "METADATA")) || "";
    const classifiers = [...metadata.matchAll(/^Classifier: License :: (.+)$/gm)].map((m) => m[1]);
    out.push({
      name: metadataField(metadata, "Name") || entry,
      version: metadataField(metadata, "Version"),
      license:
        metadataField(metadata, "License-Expression") ||
        (metadataField(metadata, "License").length < 80 ? metadataField(metadata, "License") : "") ||
        classifiers.join("; "),
      homepage: metadataField(metadata, "Home-page"),
      texts: licenceTexts(dir),
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
function section(title, body) {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>\n`;
}

function pre(text) {
  return `<pre>${escapeHtml(text.trim())}</pre>`;
}

function componentList(items) {
  return items
    .map((p) => {
      const texts = p.texts.length
        ? p.texts.map((t) => `<details><summary>${escapeHtml(t.file)}</summary>${pre(t.text)}</details>`).join("")
        : "<p class=note>No licence file is shipped in this package; its declared licence is shown.</p>";
      return `<article><h3>${escapeHtml(p.name)} ${escapeHtml(p.version)}</h3><p>Licence: ${escapeHtml(
        p.license || "see licence text",
      )}${p.homepage ? ` — ${escapeHtml(p.homepage)}` : ""}</p>${texts}</article>`;
    })
    .join("\n");
}

/**
 * Builds Acknowledgements.html. `python` carries the interpreter's version,
 * LICENSE.txt and its statically linked libraries.
 */
function renderAcknowledgements({ appName, appVersion, ffmpegLicences, electron, python, workerPkgs, npmPkgs }) {
  const css = `body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:2em auto;padding:0 1em;color:#1d1d1f}
h1{font-size:1.6em}h2{margin-top:2em;border-bottom:1px solid #ddd}h3{margin:1.2em 0 .2em;font-size:1em}
pre{white-space:pre-wrap;background:#f5f5f7;padding:.8em;border-radius:6px;font-size:12px}
details summary{cursor:pointer;color:#06c}.note{color:#666}
@media (prefers-color-scheme:dark){body{background:#1d1d1f;color:#f5f5f7}pre{background:#2c2c2e}h2{border-color:#444}details summary{color:#4ea1ff}.note{color:#aaa}}`;
  const ffmpeg = ffmpegLicences
    .map((t) => `<details${t.file === "NOTICE.md" ? " open" : ""}><summary>${escapeHtml(t.file)}</summary>${pre(t.text)}</details>`)
    .join("");
  const pyStatic = python.staticLibraries
    .map((l) => `<li>${escapeHtml(l.name)}${l.version ? ` ${escapeHtml(l.version)}` : ""} — ${escapeHtml(l.license)}</li>`)
    .join("");
  const pyStaticTexts = python.staticLibraries
    .map((l) => `<details><summary>${escapeHtml(l.name)} licence</summary>${pre(l.text)}</details>`)
    .join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8><title>${escapeHtml(appName)} — Acknowledgements</title><style>${css}</style></head><body>
<h1>${escapeHtml(appName)} ${escapeHtml(appVersion)} — Acknowledgements</h1>
<p>${escapeHtml(appName)} includes the open-source software listed below. Each component remains under its own licence, reproduced here.</p>
${section(
  "FFmpeg",
  `<p>The bundled <code>ffmpeg</code> and <code>ffprobe</code> programs (Contents/Resources/ffmpeg) are FFmpeg, licensed under the GNU Lesser General Public License version 2.1 or later. They are separate programs run by ${escapeHtml(
    appName,
  )}, built from unmodified FFmpeg source; the notice below gives the exact source, checksum and build configuration.</p>${ffmpeg}`,
)}
${section(
  "Electron and Chromium",
  `<p>Electron ${escapeHtml(electron.version)} (MIT licence). Chromium and the third-party components it includes are listed in <a href="LICENSES.chromium.html">LICENSES.chromium.html</a>.</p>${pre(electron.licence)}`,
)}
${section(
  `Python ${python.version}`,
  `<p>The analysis engine runs on CPython ${escapeHtml(python.version)} (a python-build-standalone build), licensed under the Python Software Foundation License. That build also includes:</p><ul>${pyStatic}</ul>
<details><summary>Python licence (LICENSE.txt)</summary>${pre(python.licence)}</details>
${pyStaticTexts}`,
)}
${section(`Python packages (${workerPkgs.length})`, componentList(workerPkgs))}
${section(`Interface packages (${npmPkgs.length})`, componentList(npmPkgs))}
</body></html>
`;
}

module.exports = {
  escapeHtml,
  licenceTexts,
  packageDirOf,
  bundledPackageDirs,
  interfacePackages,
  workerPackages,
  renderAcknowledgements,
};
