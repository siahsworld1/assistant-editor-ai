// electron-builder afterPack hook (package.json build.afterPack). Runs on the
// packed .app before Electron fuses are flipped and before signing:
//
//   1. writes Resources/licenses/ (Acknowledgements.html + Chromium's notices)
//      from what actually ships — see scripts/acknowledgements.cjs;
//   2. audits the payload and FAILS the build if it finds npm packages inside
//      the app (the interface server and main process need none — see
//      electron/renderer-server.cjs), an app.asar.unpacked folder, or any
//      build-machine path (the home directory or this repository) in any file.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const ack = require("./acknowledgements.cjs");

const ROOT = path.resolve(__dirname, "..");

/**
 * The pinned Python runtime: its own licence, and the libraries compiled into
 * libpython with their upstream licence texts — extracted from the same pinned
 * build by scripts/python-runtime-licenses.py into licenses/python-runtime/
 * (each file checked against PROVENANCE.json here).
 */
function pythonRuntimeInfo() {
  const python = execFileSync(path.join(ROOT, "scripts", "worker-python.sh"), ["python"], { encoding: "utf8" }).trim();
  const version = execFileSync(python, ["-I", "-c", "import platform; print(platform.python_version())"], {
    encoding: "utf8",
  }).trim();
  const dir = path.join(ROOT, "licenses", "python-runtime");
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, "PROVENANCE.json"), "utf8"));
  if (provenance.python !== version) {
    throw new Error(
      `acknowledgements: licenses/python-runtime is for Python ${provenance.python}, the worker uses ${version} — run scripts/python-runtime-licenses.py`,
    );
  }
  const staticLibraries = provenance.components.map((c) => {
    const text = fs.readFileSync(path.join(dir, c.file), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== c.sha256) {
      throw new Error(`acknowledgements: licenses/python-runtime/${c.file} does not match PROVENANCE.json`);
    }
    return { name: c.name, version: c.version, license: c.license, text };
  });
  const home = path.dirname(path.dirname(python));
  return {
    version,
    licence: fs.readFileSync(path.join(home, "lib", `python${version.split(".").slice(0, 2).join(".")}`, "LICENSE.txt"), "utf8"),
    staticLibraries,
  };
}

function readAsarFileList(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8"));
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else files.push(p);
    }
  };
  walk(header, "");
  return files;
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

/** Problems with the packed app. Exported for tests. */
function auditPayload({ appDir, markers }) {
  const problems = [];
  const resources = path.join(appDir, "Contents", "Resources");
  const asar = path.join(resources, "app.asar");
  const inAsar = readAsarFileList(asar);
  const modules = inAsar.filter((f) => f.split("/").includes("node_modules"));
  if (modules.length) problems.push(`app.asar contains ${modules.length} node_modules files (e.g. ${modules[0]})`);
  if (fs.existsSync(path.join(resources, "app.asar.unpacked"))) problems.push("app.asar.unpacked exists");
  const needles = markers.filter(Boolean).map((m) => Buffer.from(m));
  for (const file of walkFiles(appDir)) {
    const data = fs.readFileSync(file);
    for (const needle of needles) {
      if (data.includes(needle)) problems.push(`${path.relative(appDir, file)} contains ${needle}`);
    }
  }
  return { problems, asarFiles: inAsar.length };
}

exports.auditPayload = auditPayload;
exports.readAsarFileList = readAsarFileList;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(appDir, "Contents", "Resources");
  const licences = path.join(resources, "licenses");
  fs.mkdirSync(licences, { recursive: true });

  const electronDist = path.join(ROOT, "node_modules", "electron", "dist");
  fs.copyFileSync(path.join(electronDist, "LICENSES.chromium.html"), path.join(licences, "LICENSES.chromium.html"));
  // dist-desktop is what electron-builder copied into Resources/renderer; its
  // hidden source maps (not shipped) say exactly which packages it contains.
  const npm = ack.interfacePackages({ distDir: path.join(ROOT, "dist-desktop"), repoRoot: ROOT });
  if (npm.missing.length) throw new Error(`acknowledgements: bundled packages without package.json: ${npm.missing.join(", ")}`);
  const html = ack.renderAcknowledgements({
    appName: context.packager.appInfo.productName,
    appVersion: context.packager.appInfo.version,
    // Written by scripts/prepare-ffmpeg.py; NOTICE.md carries the source URL,
    // checksum and configure flags.
    ffmpegLicences: ["NOTICE.md", "buildconf.txt", "COPYING.LGPLv2.1", "LICENSE.md", "CREDITS"].map((f) => ({
      file: f,
      text: fs.readFileSync(path.join(resources, "ffmpeg", "LICENSES", f), "utf8"),
    })),
    electron: {
      version: fs.readFileSync(path.join(electronDist, "version"), "utf8").trim(),
      licence: fs.readFileSync(path.join(electronDist, "LICENSE"), "utf8"),
    },
    python: pythonRuntimeInfo(),
    workerPkgs: ack.workerPackages(path.join(resources, "worker", "_internal")),
    npmPkgs: npm.packages,
  });
  fs.writeFileSync(path.join(licences, "Acknowledgements.html"), html);

  const { problems, asarFiles } = auditPayload({ appDir, markers: [os.homedir() + "/", ROOT] });
  if (problems.length) {
    throw new Error(`afterPack audit failed:\n  ${problems.slice(0, 30).join("\n  ")}`);
  }
  console.log(
    `  • afterPack: acknowledgements written (${npm.packages.length} interface packages); ` +
      `audit passed (${asarFiles} files in app.asar, no node_modules, no build-machine paths)`,
  );
};
