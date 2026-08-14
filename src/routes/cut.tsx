import { createFileRoute } from "@tanstack/react-router";
import { Download, Hammer, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatDuration, useAE } from "@/lib/ae/store";
import type { EditDecisionLane, UniversalTimeline } from "@/lib/ae/types";
import { buildCmx3600Edl, edlFilename, validateTimelineForExport } from "@/lib/nle/edl";

export const Route = createFileRoute("/cut")({
  head: () => ({
    meta: [
      { title: "CUT — Timeline Assembly | Assistant Editor AI" },
      {
        name: "description",
        content:
          "Universal timeline assembly with interview and B-roll lanes, target duration, version tracking and NLE export targets.",
      },
      { property: "og:title", content: "CUT — Timeline Assembly" },
      {
        property: "og:description",
        content: "Assembly view with interview and B-roll lanes and NLE export targets.",
      },
    ],
  }),
  component: CutPage,
});

const laneMeta: Record<EditDecisionLane, { label: string; color: string }> = {
  interview: { label: "V1 · Interview", color: "bg-lane-interview" },
  "b-roll": { label: "V2 · B-roll", color: "bg-lane-broll" },
  audio: { label: "A1 · Ambient", color: "bg-lane-audio" },
};

function CutPage() {
  const {
    versions,
    activeVersionId,
    setActiveVersion,
    targetSeconds,
    setTargetSeconds,
    runCommand,
    building,
    nle,
    stories,
    chosenStoryId,
    project,
    desktopCapabilities,
  } = useAE();

  const version = versions.find((v) => v.id === activeVersionId) ?? versions[0]!;
  const timeline = version.timeline;
  const scale = Math.max(timeline.totalSeconds, targetSeconds);
  const story = stories.find((s) => s.id === chosenStoryId);

  const lanes: EditDecisionLane[] = ["interview", "b-roll", "audio"];

  // Real export: validated against the actual clip list, then written to disk via
  // the native save dialog. Currently CMX3600 EDL only — see src/lib/nle/edl.ts for
  // why that's the one real format shipped so far, rather than three unverified ones.
  const exportTimeline = async (targetName: string, timelineToExport: UniversalTimeline) => {
    if (!desktopCapabilities || !window.assistantEditorDesktop) {
      toast.error("Export requires the desktop companion", {
        description: "Run the app with `npm run dev:desktop`, not a plain browser tab.",
      });
      return;
    }
    const clips = project?.clips ?? [];
    const { ok, errors, usable } = validateTimelineForExport(timelineToExport, clips);
    if (!ok) {
      toast.error("Nothing valid to export", { description: errors[0] ?? "Timeline failed validation." });
      return;
    }
    if (errors.length > 0) {
      toast.warning(`Exporting ${usable.length} of ${timelineToExport.decisions.length} events`, {
        description: `${errors.length} event(s) were dropped: ${errors[0]}`,
      });
    }
    const edl = buildCmx3600Edl(timelineToExport, usable, clips);
    const result = await window.assistantEditorDesktop.exportFile(edlFilename(timelineToExport), edl);
    if (result.cancelled) return;
    if (!result.ok) {
      toast.error("Export failed", { description: result.error ?? "Unknown error." });
      return;
    }
    toast.success(`Exported to ${targetName}`, {
      description: `${usable.length} events written as CMX3600 EDL → ${result.path}`,
    });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Stage 04"
        title="CUT"
        description="A universal timeline the engine can translate into any NLE. Every build produces a new version — nothing overwrites your previous cut."
        actions={
          <>
            <Badge variant="outline" className="h-8 border-border px-3 font-tc text-xs">
              {version.version}
            </Badge>
            <Button
              onClick={() => void runCommand(`Build sequence at ${targetSeconds}s`)}
              disabled={building}
            >
              {building ? <Loader2 className="size-4 animate-spin" /> : <Hammer className="size-4" />}
              Build New Sequence
            </Button>
          </>
        }
      />

      <div className="space-y-4 px-6 py-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <div className="panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{timeline.name}</div>
                  <div className="font-tc text-[11px] text-muted-foreground">
                    {timeline.fps} fps · {timeline.decisions.length} events ·{" "}
                    {formatDuration(timeline.totalSeconds)} assembled
                  </div>
                </div>
                <div className="w-[280px]">
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="uppercase tracking-[0.14em] text-muted-foreground">
                      Target duration
                    </span>
                    <span className="font-tc text-primary">{formatDuration(targetSeconds)}</span>
                  </div>
                  <Slider
                    value={[targetSeconds]}
                    min={30}
                    max={600}
                    step={15}
                    onValueChange={([v]) => setTargetSeconds(v ?? targetSeconds)}
                  />
                </div>
              </div>

              <div className="mt-5 space-y-2">
                <div className="relative h-5 border-b border-border">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <span
                      key={i}
                      className="absolute top-0 font-tc text-[10px] text-muted-foreground"
                      style={{ left: `${(i / 8) * 100}%` }}
                    >
                      {formatDuration((scale / 8) * i)}
                    </span>
                  ))}
                </div>

                {lanes.map((lane) => {
                  const items = timeline.decisions.filter((d) => d.lane === lane);
                  return (
                    <div key={lane} className="flex items-stretch gap-3">
                      <div className="w-[112px] shrink-0 pt-3 font-tc text-[11px] text-muted-foreground">
                        {laneMeta[lane].label}
                      </div>
                      <div className="hairline-grid relative h-12 flex-1 rounded border border-border bg-surface">
                        {lane === "audio" ? (
                          <div className="absolute inset-y-1.5 left-0 right-0 rounded-sm bg-lane-audio/25 px-2 text-[10px] leading-9 text-foreground/70">
                            S201 room tone bed — full timeline
                          </div>
                        ) : (
                          items.map((d) => (
                            <div
                              key={d.id}
                              title={`${d.label} · ${d.sourceInTc}–${d.sourceOutTc}`}
                              className={cn(
                                "absolute inset-y-1.5 overflow-hidden rounded-sm border border-black/30 px-2 py-1",
                                laneMeta[lane].color,
                                "opacity-90",
                              )}
                              style={{
                                left: `${(d.timelineStartSeconds / scale) * 100}%`,
                                width: `${(d.durationSeconds / scale) * 100}%`,
                              }}
                            >
                              <span className="block truncate text-[10px] font-medium text-black/85">
                                {d.label}
                              </span>
                              <span className="font-tc block truncate text-[9px] text-black/60">
                                {d.sourceInTc}
                              </span>
                            </div>
                          ))
                        )}
                        {targetSeconds < scale && (
                          <div
                            className="absolute inset-y-0 w-px bg-primary"
                            style={{ left: `${(targetSeconds / scale) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel">
              <div className="border-b border-border px-5 py-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Edit decision list
              </div>
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-5 py-2 font-normal">#</th>
                    <th className="px-3 py-2 font-normal">Lane</th>
                    <th className="px-3 py-2 font-normal">Event</th>
                    <th className="px-3 py-2 font-normal">Source in</th>
                    <th className="px-3 py-2 font-normal">Source out</th>
                    <th className="px-3 py-2 font-normal">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {timeline.decisions.map((d, i) => (
                    <tr key={d.id} className="hover:bg-accent/30">
                      <td className="px-5 py-2 font-tc text-muted-foreground">
                        {String(i + 1).padStart(3, "0")}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "inline-block size-2 rounded-sm align-middle",
                            laneMeta[d.lane].color,
                          )}
                        />
                        <span className="ml-2 text-muted-foreground">{d.lane}</span>
                      </td>
                      <td className="px-3 py-2">{d.label}</td>
                      <td className="px-3 py-2 font-tc text-muted-foreground">{d.sourceInTc}</td>
                      <td className="px-3 py-2 font-tc text-muted-foreground">{d.sourceOutTc}</td>
                      <td className="px-3 py-2 font-tc">{d.durationSeconds.toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="panel p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Story spine
              </div>
              <div className="mt-1.5 text-sm font-medium">{story?.title ?? "None chosen"}</div>
              <p className="mt-1 text-xs text-muted-foreground">{story?.premise}</p>
            </div>

            <div className="panel p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Versions
              </div>
              <ul className="mt-2 space-y-1.5">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button
                      onClick={() => setActiveVersion(v.id)}
                      className={cn(
                        "w-full rounded border px-3 py-2 text-left transition-colors",
                        v.id === activeVersionId
                          ? "border-primary/50 bg-primary/[0.06]"
                          : "border-border hover:bg-accent/40",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-tc text-xs text-primary">{v.version}</span>
                        <span className="font-tc text-[10px] text-muted-foreground">
                          {v.createdAt}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs">{v.label}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="panel p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Export targets
              </div>
              <ul className="mt-2 space-y-2">
                {nle.map((n) => (
                  <li
                    key={n.id}
                    className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{n.name}</div>
                      <div className="truncate font-tc text-[10px] text-muted-foreground">
                        CMX3600 EDL (File → Import)
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void exportTimeline(n.name, timeline)}
                    >
                      <Download className="size-3.5" /> Export
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Writes a real .edl file to disk via the native save dialog — nothing is sent
                anywhere. Import it manually in each application; there is no live-push
                integration for these three yet (Premiere has a separate, experimental live
                bridge — see Settings).
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
