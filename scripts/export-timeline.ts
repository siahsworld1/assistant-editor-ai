#!/usr/bin/env node
// Direct Node/TypeScript export runner: builds a real CMX3600 EDL, a real
// XMEML sequence, and a real FCPXML sequence from a fixture JSON file, using
// the exact same exporter functions the app itself calls (src/lib/nle/edl.ts,
// xmeml.ts, fcpxml.ts) — no mocking, no reimplementation.
//
// This replaces the previous approach of shelling out to `npx vitest run` on
// a generated test file to produce these files. Vitest is a test runner, not
// an export mechanism, and depending on it here meant this path only worked
// when node_modules was fully installed and vitest behaved as a CLI tool
// rather than a test harness. This script has zero npm dependencies: it runs
// under plain `node --experimental-strip-types` (Node >=22.6), which strips
// TypeScript type syntax and executes the real .ts source directly. The only
// reason that works without a bundler is that edl.ts/xmeml.ts/fcpxml.ts's
// relative runtime imports now carry explicit ".ts" extensions (see the
// comments on those imports) — plain Node ESM, unlike Vite, never resolves
// extensionless specifiers.
//
// Usage:
//   node --experimental-strip-types scripts/export-timeline.ts <fixture.json> <outDir>
//
// <fixture.json> must contain { timeline: UniversalTimeline, clips: Clip[],
// mediaRoot: string } — exactly the shape worker/validate_e2e.py writes to
// worker/validation-output/e2e-fixture.json after a real /build call.
//
// Exit code 0 and all four files written on success; nonzero and a clear
// stderr message on failure. Never partially writes: either all four files
// (.edl, the XMEML .xml, .fcpxml, export-summary.json) land, or none do.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCmx3600Edl, edlFilename, validateTimelineForExport } from "../src/lib/nle/edl.ts";
import { buildXmeml, xmemlFilename } from "../src/lib/nle/xmeml.ts";
import { buildFcpxml, fcpxmlFilename } from "../src/lib/nle/fcpxml.ts";
// Type-only — erased entirely under --experimental-strip-types, so this never
// needs runtime resolution. Kept as a normal top-level `import type` (not an
// inline `import("...")` type query) so there's no ambiguity for a
// syntax-level stripper between a type-position import and a real one.
import type { Clip, UniversalTimeline } from "../src/lib/ae/types.ts";

function fail(message: string): never {
  console.error(`export-timeline: ${message}`);
  process.exit(1);
}

const [, , fixtureArg, outDirArg] = process.argv;
if (!fixtureArg || !outDirArg) {
  fail("usage: node --experimental-strip-types scripts/export-timeline.ts <fixture.json> <outDir>");
}

const fixturePath = resolve(fixtureArg);
const outDir = resolve(outDirArg);

if (!existsSync(fixturePath)) {
  fail(`fixture not found: ${fixturePath}`);
}

let fixture: { timeline?: unknown; clips?: unknown; mediaRoot?: unknown };
try {
  fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
} catch (err) {
  fail(`fixture is not valid JSON: ${(err as Error).message}`);
}

const timeline = fixture.timeline as UniversalTimeline | undefined;
const clips = (fixture.clips ?? []) as Clip[];
const mediaRoot = typeof fixture.mediaRoot === "string" ? fixture.mediaRoot : "";

if (!timeline || !Array.isArray(timeline.decisions)) {
  fail(`fixture.timeline is missing or has no decisions array: ${fixturePath}`);
}
if (timeline.decisions.length === 0) {
  fail("fixture has zero decisions — nothing to export. Re-run the pipeline through /build first.");
}

const { usable, errors: validationErrors } = validateTimelineForExport(timeline, clips);
if (usable.length === 0) {
  fail(
    `none of the fixture's ${timeline.decisions.length} decision(s) survived export validation: ` +
      validationErrors.join("; "),
  );
}

const edl = buildCmx3600Edl(timeline, usable, clips);
const xmeml = buildXmeml(timeline, usable, clips, mediaRoot);
const fcpxml = buildFcpxml(timeline, usable, clips, mediaRoot);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const edlPath = join(outDir, edlFilename(timeline));
const xmemlPath = join(outDir, xmemlFilename(timeline));
const fcpxmlPath = join(outDir, fcpxmlFilename(timeline));

writeFileSync(edlPath, edl, "utf-8");
writeFileSync(xmemlPath, xmeml.xml, "utf-8");
writeFileSync(fcpxmlPath, fcpxml.xml, "utf-8");

const summary = {
  decisionsInTimeline: timeline.decisions.length,
  usableDecisions: usable.length,
  validationErrors,
  xmemlWarnings: xmeml.warnings,
  fcpxmlWarnings: fcpxml.warnings,
  files: [edlFilename(timeline), xmemlFilename(timeline), fcpxmlFilename(timeline)],
};
writeFileSync(join(outDir, "export-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

console.log(`export-timeline: wrote ${summary.files.join(", ")} to ${outDir}`);
console.log(
  `export-timeline: ${summary.usableDecisions}/${summary.decisionsInTimeline} decisions exported` +
    (validationErrors.length ? `, ${validationErrors.length} dropped by export validation` : "") +
    (xmeml.warnings.length ? `, ${xmeml.warnings.length} XMEML warning(s)` : "") +
    (fcpxml.warnings.length ? `, ${fcpxml.warnings.length} FCPXML warning(s)` : ""),
);
