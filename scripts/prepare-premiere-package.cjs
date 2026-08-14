#!/usr/bin/env node
// Copies premiere-uxp/ into dist-premiere/<pluginId>/ as a clean UXP package
// directory that the UXP Developer Tool can load and that the eventual
// one-step installer can ship next to the desktop companion.
//
// This does NOT produce a signed .ccx bundle: Adobe signing requires Adobe's
// UXP packager and developer credentials, which are not available here.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "premiere-uxp");
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const OUT_ROOT = path.join(ROOT, "dist-premiere");
const OUT = path.join(OUT_ROOT, manifest.id);

const ALLOWED_EXT = new Set([".json", ".html", ".js", ".css", ".png", ".svg", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "screenshots"]);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(src, dest);
    } else if (ALLOWED_EXT.has(path.extname(entry.name))) {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

fs.rmSync(OUT, { recursive: true, force: true });
const files = copyDir(SRC, OUT);

fs.writeFileSync(
  path.join(OUT_ROOT, "PACKAGE-INFO.json"),
  JSON.stringify(
    {
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      integrationVersion: "0.4.0",
      protocolVersion: "1.0.0",
      bridge: "http://127.0.0.1:32146",
      signed: false,
      ccx: false,
      note: "Unsigned UXP package directory. Adobe signing/.ccx packaging is still required for distribution.",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

console.log(`[premiere:prepare] ${files} files -> ${path.relative(ROOT, OUT)}`);
console.log("[premiere:prepare] unsigned package directory (no .ccx, no Adobe signing)");