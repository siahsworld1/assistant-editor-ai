// Real end-to-end export check, driven by worker/validate_e2e.py.
//
// Every other file in tests/ exercises the exporters against hand-written
// fixture data. This file is different: it's the one place the exporters run
// against decisions that actually came out of a live pipeline run — real
// footage, real transcription, real vision analysis, real reasoning-model edit
// decisions — captured by validate_e2e.py into a JSON file and handed to this
// test via the AE_E2E_FIXTURE env var.
//
// It is inert during normal `npm test` runs: with AE_E2E_FIXTURE unset, the
// whole suite is skipped, so this file never affects the regular test suite or
// CI-style runs. It only does anything when validate_e2e.py's export stage
// explicitly invokes `npx vitest run tests/e2e-export.generated.test.ts` with
// the env var set.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCmx3600Edl, edlFilename, validateTimelineForExport } from "@/lib/nle/edl";
import { buildXmeml, xmemlFilename } from "@/lib/nle/xmeml";
import { buildFcpxml, fcpxmlFilename } from "@/lib/nle/fcpxml";
import type { Clip, UniversalTimeline } from "@/lib/ae/types";

interface E2eFixture {
  timeline: UniversalTimeline;
  clips: Clip[];
  mediaRoot: string;
}

const fixturePath = process.env.AE_E2E_FIXTURE;
const outDir = process.env.AE_E2E_OUTDIR || ".";

describe.skipIf(!fixturePath)("real end-to-end export (data from an actual validate_e2e.py pipeline run)", () => {
  it("builds real EDL/XMEML/FCPXML files from the pipeline's actual validated edit decisions", () => {
    const fixture: E2eFixture = JSON.parse(readFileSync(fixturePath as string, "utf-8"));
    const { timeline, clips, mediaRoot } = fixture;

    expect(timeline.decisions.length, "fixture has zero decisions — validate_e2e.py should not have reached the export stage").toBeGreaterThan(0);

    const { usable, errors: validationErrors } = validateTimelineForExport(timeline, clips);
    expect(usable.length, "none of the pipeline's real decisions survived export validation").toBeGreaterThan(0);

    const edl = buildCmx3600Edl(timeline, usable, clips);
    const xmeml = buildXmeml(timeline, usable, clips, mediaRoot);
    const fcpxml = buildFcpxml(timeline, usable, clips, mediaRoot);

    // Structural sanity — the same markers a human would look for opening these
    // files, not just "is this a non-empty string."
    expect(edl).toContain("TITLE:");
    expect(edl.length).toBeGreaterThan(20);
    expect(xmeml.xml).toContain("<!DOCTYPE xmeml>");
    expect(fcpxml.xml).toContain("<!DOCTYPE fcpxml>");

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, edlFilename(timeline)), edl, "utf-8");
    writeFileSync(join(outDir, xmemlFilename(timeline)), xmeml.xml, "utf-8");
    writeFileSync(join(outDir, fcpxmlFilename(timeline)), fcpxml.xml, "utf-8");

    // A machine-readable summary for validate_e2e.py to fold into its own
    // PASS/FAIL report, rather than scraping vitest's stdout.
    writeFileSync(
      join(outDir, "export-summary.json"),
      JSON.stringify(
        {
          decisionsInTimeline: timeline.decisions.length,
          usableDecisions: usable.length,
          validationErrors,
          xmemlWarnings: xmeml.warnings,
          fcpxmlWarnings: fcpxml.warnings,
          files: [edlFilename(timeline), xmemlFilename(timeline), fcpxmlFilename(timeline)],
        },
        null,
        2,
      ),
      "utf-8",
    );
  });
});
