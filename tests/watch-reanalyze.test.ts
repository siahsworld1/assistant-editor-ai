// "Analyze Footage" on footage that already has a completed analysis asks
// first, for that project and that analysis only — through the REAL store and
// the real WATCH page, against a scripted engine (tests/helpers/cut-harness.ts).
// The engine side (refusing without the confirmation, keeping the saved
// analysis) is tested in worker/tests/test_analysis_protection.py.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ReanalyzeDialog } from "@/components/ae/ReanalyzeDialog";
import { normalizeAnalyze } from "@/lib/ae/normalize";
import { EngineClient, type EngineTransport } from "@/lib/ae/service";
import { AEProvider, useAE } from "@/lib/ae/store";
import { Route as WatchRoute } from "@/routes/watch";
import {
  ANALYSIS,
  fakeAnalysis,
  fakeAnalyze,
  freshDisk,
  install,
  teardown,
  wait,
} from "./helpers/cut-harness";

type Ctx = ReturnType<typeof useAE>;
let ae: Ctx | null = null;
let root: Root | null = null;
function Probe() {
  ae = useAE();
  return null;
}
const Watch = WatchRoute.options.component as () => React.ReactElement;

async function openWatch() {
  install(freshDisk());
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(createElement(AEProvider, null, createElement(Probe), createElement(Watch))),
  );
  for (
    let t = 0;
    t < 8000 && !(ae?.project?.analysisId === ANALYSIS && ae.project.clips.length);
    t += 25
  )
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  await wait(50);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  ae = null;
  await teardown();
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => q(id)!.click());

describe("Analyze Footage on an analyzed project", () => {
  it("asks first — what exists and what re-analysis affects — with Cancel as the default; Cancel starts nothing", async () => {
    await openWatch();
    click("analyze-footage");
    const dialog = q("reanalyze-dialog")!;
    expect(dialog).not.toBeNull();
    expect(q("reanalyze-existing")!.textContent).toMatch(
      new RegExp(`already has a completed analysis \\(${ANALYSIS.slice(0, 8)}\\): 6 clips`),
    );
    expect(dialog.textContent).toMatch(/selects and stories replace these/);
    expect(dialog.textContent).toMatch(/cuts saved from this analysis won.t open with the new one/);
    expect(dialog.textContent).toMatch(/kept as a backup/);
    expect(document.activeElement).toBe(q("reanalyze-cancel")); // the default
    expect((q("reanalyze-allow-incomplete") as HTMLInputElement).checked).toBe(false);
    click("reanalyze-cancel");
    await wait(50);
    expect(q("reanalyze-dialog")).toBeNull();
    expect(fakeAnalyze.requests).toHaveLength(0);
    expect(ae!.project!.analysisState).toBe("complete");
  }, 30000);

  it("Re-analyze sends one request confirming exactly this project's analysis", async () => {
    await openWatch();
    click("analyze-footage");
    click("reanalyze-confirm");
    await wait(100);
    expect(fakeAnalyze.requests).toEqual([
      expect.objectContaining({
        projectId: "proj-1",
        confirmReplace: { analysisId: ANALYSIS, allowIncomplete: false },
      }),
    ]);
    expect(ae!.project!.analysisState).toBe("running");
  }, 30000);

  it("allowing an incomplete analysis is an explicit, separate choice", async () => {
    await openWatch();
    click("analyze-footage");
    act(() => q("reanalyze-allow-incomplete")!.click());
    click("reanalyze-confirm");
    await wait(100);
    expect(fakeAnalyze.requests[0]!["confirmReplace"]).toEqual({
      analysisId: ANALYSIS,
      allowIncomplete: true,
    });
  }, 30000);

  it("if the saved analysis isn't the one confirmed, nothing starts and the filmmaker is asked about the current one", async () => {
    fakeAnalyze.replies = [
      {
        accepted: false,
        state: "confirmation-required",
        existing: {
          analysisId: "f00dcafe0000",
          clips: 2,
          transcript: 0,
          visualEvidence: 0,
          selects: 0,
          stories: 0,
        },
      },
    ];
    await openWatch();
    click("analyze-footage");
    click("reanalyze-confirm");
    await wait(100);
    expect(fakeAnalyze.requests).toHaveLength(1);
    expect(ae!.project!.analysisState).toBe("complete"); // not started
    expect(q("reanalyze-existing")!.textContent).toMatch(
      /\(f00dcafe\): 2 clips, 0 transcript lines/,
    );
    expect((q("reanalyze-allow-incomplete") as HTMLInputElement).checked).toBe(false);
  }, 30000);

  it("a confirmation for another project is refused without asking the engine", async () => {
    await openWatch();
    let out: Awaited<ReturnType<Ctx["analyze"]>> | null = null;
    await act(async () => {
      out = await ae!.analyze({
        projectId: "proj-2",
        analysisId: ANALYSIS,
        allowIncomplete: false,
      });
    });
    expect(out).toMatchObject({ status: "refused" });
    expect(fakeAnalyze.requests).toHaveLength(0);
  }, 30000);

  it("when the engine kept the saved analysis, WATCH says why", async () => {
    fakeAnalysis.analysisNote =
      "Re-analysis did not produce the transcript of 2 files the saved analysis has (for example, no AI provider is set up, or a step failed), so the previous analysis was kept.";
    await openWatch();
    expect(q("analysis-note")!.textContent).toMatch(/previous analysis was kept/);
  }, 30000);
});

describe("the dialog on its own", () => {
  it("starts from the safe choice for every new question", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createRoot(el);
    const existing = {
      analysisId: "aaaa1111",
      clips: 1,
      transcript: 1,
      visualEvidence: 1,
      selects: 1,
      stories: 1,
    };
    const render = (id: string) =>
      act(() =>
        r.render(
          createElement(ReanalyzeDialog, {
            request: {
              projectId: "p",
              projectName: "Doc",
              existing: { ...existing, analysisId: id },
            },
            onCancel: () => {},
            onConfirm: () => {},
          }),
        ),
      );
    render("aaaa1111");
    act(() => q("reanalyze-allow-incomplete")!.click());
    expect((q("reanalyze-allow-incomplete") as HTMLInputElement).checked).toBe(true);
    render("bbbb2222");
    expect((q("reanalyze-allow-incomplete") as HTMLInputElement).checked).toBe(false);
    expect(q("reanalyze-existing")!.textContent).toMatch(
      /1 clip, 1 transcript line, 1 visual moment, 1 select and 1 story\./,
    );
    act(() => r.unmount());
  });
});

describe("the engine contract", () => {
  it("parses the engine's confirmation request; a plain start is unchanged", () => {
    const need = normalizeAnalyze({
      accepted: false,
      state: "confirmation-required",
      existing: {
        analysisId: "a5dd09a1",
        clips: 6,
        transcript: 49,
        visualEvidence: 28,
        selects: 5,
        stories: 3,
      },
    });
    expect(need).toMatchObject({
      accepted: false,
      confirmationRequired: {
        analysisId: "a5dd09a1",
        clips: 6,
        transcript: 49,
        visualEvidence: 28,
        selects: 5,
        stories: 3,
      },
    });
    expect(normalizeAnalyze({ accepted: true, state: "running", progress: 2 })).toMatchObject({
      accepted: true,
      state: "running",
      confirmationRequired: null,
    });
  });

  it("the client sends the confirmation only when given", async () => {
    const calls: Array<{ body?: unknown }> = [];
    const transport = {
      id: "direct-loopback",
      label: "fake",
      target: "fake",
      request: async (req: { body?: unknown }) => {
        calls.push(req);
        return { accepted: true, state: "running" };
      },
    } as unknown as EngineTransport;
    const c = new EngineClient(transport);
    await c.analyze({ projectId: "p", mediaRoot: "/m" });
    await c.analyze({
      projectId: "p",
      mediaRoot: "/m",
      confirmReplace: { analysisId: "x", allowIncomplete: false },
    });
    expect(calls[0]!.body).not.toHaveProperty("confirmReplace");
    expect(calls[1]!.body).toMatchObject({
      confirmReplace: { analysisId: "x", allowIncomplete: false },
    });
  });
});
