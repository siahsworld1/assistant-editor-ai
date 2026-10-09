import { createFileRoute } from "@tanstack/react-router";
import { Download, Hammer, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { SequencePlayer } from "@/components/ae/SequencePlayer";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  CutawayOverlay,
  SourcePreviewDialog,
  type PreviewTarget,
} from "@/components/ae/SourceVisuals";
import { ProposalPanel } from "@/components/ae/ProposalPanel";
import { RestoreWarnings } from "@/components/ae/RestoreWarnings";
import { TimelineEditor } from "@/components/ae/TimelineEditor";
import { useProposalPreview } from "@/lib/ae/proposal-preview";
import { decisionSourceRange } from "@/lib/ae/source-range";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { formatDuration, useAE } from "@/lib/ae/store";
import { useTimelinePlayback } from "@/lib/ae/timeline-playback";
import type { Clip, EditDecisionLane, UniversalTimeline } from "@/lib/ae/types";
import { buildCmx3600Edl, edlFilename, validateTimelineForExport } from "@/lib/nle/edl";
import { buildFcpxml, fcpxmlFilename } from "@/lib/nle/fcpxml";
import { buildXmeml, xmemlFilename } from "@/lib/nle/xmeml";

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
  audio: { label: "A2 · Audio", color: "bg-lane-audio" },
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
    editor,
    askDirector,
    askStory,
    coverCuts,
    askCoverageRanking,
    setMediaRole,
    restoreWarnings,
  } = useAE();

  const version = versions.find((v) => v.id === activeVersionId) ?? versions[0]!;
  const timeline = version.timeline;
  const story = stories.find((s) => s.id === chosenStoryId);
  const clips = project?.clips ?? [];
  const mediaRoot = project?.mediaRoot ?? "";

  // A Director proposal under review is previewed in memory only; while its
  // "Proposed" picture is shown, playback plays the proposed cut.
  const proposals = useProposalPreview(editor);
  // The timeline's selection — what "this clip" means in a Director instruction.
  const [selection, setSelection] = useState<string[]>([]);
  // Cover mode marks potential jump cuts on the timeline ruler.
  const [coverageVisible, setCoverageVisible] = useState(false);
  const playback = useTimelinePlayback(proposals.previewTimeline ?? timeline, clips);

  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const clipById = new Map(clips.map((c) => [c.id, c]));
  /** An edit's real source range, read at its clip's own frame rate. */
  const sourceRange = (d: UniversalTimeline["decisions"][number]) => {
    const r = decisionSourceRange(d, clipById);
    return { clip: r?.clip, inSeconds: r?.inSeconds ?? 0, outSeconds: r?.outSeconds ?? 0 };
  };
  const openSource = (d: UniversalTimeline["decisions"][number]) => {
    const { clip, inSeconds, outSeconds } = sourceRange(d);
    if (clip)
      setPreview({
        clip,
        inSeconds,
        outSeconds,
        title: d.label,
        subtitle: `${d.lane} · timeline ${d.timelineStartSeconds.toFixed(1)}s`,
      });
  };
  const openSourceRef = useRef(openSource);
  openSourceRef.current = openSource;
  const onOpenSource = useCallback(
    (d: UniversalTimeline["decisions"][number]) => openSourceRef.current(d),
    [],
  );
  type ExportFormat = "edl" | "xmeml" | "fcpxml";
  const FORMAT_LABEL: Record<ExportFormat, string> = {
    edl: "CMX3600 EDL",
    xmeml: "Premiere / FCP7 XML (XMEML)",
    fcpxml: "Final Cut Pro X / Resolve XML (FCPXML)",
  };

  // Real export: validated against the actual clip list, then written to disk via
  // the native save dialog. Three formats share one validation gate
  // (validateTimelineForExport) — see src/lib/nle/{edl,xmeml,fcpxml}.ts for what
  // each format actually is and which apps import it natively.
  const exportTimeline = async (targetName: string, timelineToExport: UniversalTimeline, format: ExportFormat) => {
    if (!desktopCapabilities || !window.assistantEditorDesktop) {
      toast.error("Export requires the desktop companion", {
        description: "Run the app with `npm run dev:desktop`, not a plain browser tab.",
      });
      return;
    }
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

    let content: string;
    let filename: string;
    let warnings: string[] = [];
    if (format === "edl") {
      content = buildCmx3600Edl(timelineToExport, usable, clips);
      filename = edlFilename(timelineToExport);
    } else if (format === "xmeml") {
      const built = buildXmeml(timelineToExport, usable, clips, mediaRoot);
      content = built.xml;
      warnings = built.warnings;
      filename = xmemlFilename(timelineToExport);
    } else {
      const built = buildFcpxml(timelineToExport, usable, clips, mediaRoot);
      content = built.xml;
      warnings = built.warnings;
      filename = fcpxmlFilename(timelineToExport);
    }

    const result = await window.assistantEditorDesktop.exportFile(filename, content);
    if (result.cancelled) return;
    if (!result.ok) {
      toast.error("Export failed", { description: result.error ?? "Unknown error." });
      return;
    }
    if (warnings.length > 0) {
      toast.warning(`Exported with ${warnings.length} note(s)`, { description: warnings[0] });
    }
    toast.success(`Exported to ${targetName}`, {
      description: `${usable.length} events written as ${FORMAT_LABEL[format]} → ${result.path}`,
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
            {desktopCapabilities && (
              <div className="panel p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Preview
                  </div>
                  {!playback.hasPlayableMedia && (
                    <span className="text-[11px] text-muted-foreground">
                      No analyzed clips with a real preview yet
                    </span>
                  )}
                </div>
                <div className="relative mx-auto max-w-md">
                  <SequencePlayer playback={playback} />
                  <CutawayOverlay
                    overlay={playback.overlay}
                    playheadSeconds={playback.playheadSeconds}
                    playing={playback.isPlaying}
                    rate={playback.shuttleRate > 0 ? playback.shuttleRate : 1}
                  />
                </div>
                <div className="mx-auto mt-1 max-w-md truncate font-tc text-[10px] text-muted-foreground">
                  {playback.activeSegment
                    ? `V1 ${playback.activeSegment.clip?.filename ?? ""} · ${playback.activeSegment.decision.sourceInTc}`
                    : ""}
                  {playback.overlay ? ` · V2 ${playback.overlay.clip?.filename ?? ""}` : ""}
                </div>
                <div className="mx-auto mt-2 flex max-w-md items-center gap-3">
                  <button
                    type="button"
                    onClick={playback.togglePlay}
                    disabled={!playback.hasPlayableMedia}
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground disabled:opacity-40"
                  >
                    {playback.isPlaying ? (
                      <Pause className="size-3.5" />
                    ) : (
                      <Play className="size-3.5 translate-x-px" />
                    )}
                  </button>
                  <span className="font-tc text-[11px] text-primary">
                    {formatDuration(playback.playheadSeconds)}
                  </span>
                  <span className="font-tc text-[11px] text-muted-foreground">
                    / {formatDuration((proposals.previewTimeline ?? timeline).totalSeconds)}
                  </span>
                </div>
              </div>
            )}

            <RestoreWarnings warnings={restoreWarnings} />

            <ProposalPanel
              editor={editor}
              preview={proposals}
              selection={selection}
              askDirector={askDirector}
              askStory={askStory}
              coverCuts={coverCuts}
              rankCoverage={askCoverageRanking}
              setMediaRole={setMediaRole}
              onModeChange={(m) => setCoverageVisible(m === "cover")}
              onBeforeChange={playback.pause}
              demo={import.meta.env.DEV}
            />

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

              <TimelineEditor
                className="mt-5"
                editor={editor}
                playback={playback}
                clips={clips}
                compare={proposals.compare}
                showCoverage={coverageVisible}
                onSelectionChange={setSelection}
              />
            </div>

            <div className="panel">
              <div className="border-b border-border px-5 py-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Edit decision list
              </div>
              <EdlTable decisions={timeline.decisions} clips={clips} onOpen={onOpenSource} />
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
                  <li key={n.id} className="rounded border border-border bg-surface px-3 py-2">
                    <div className="mb-1.5 truncate text-xs font-medium">{n.name}</div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void exportTimeline(n.name, timeline, "edl")}
                      >
                        <Download className="size-3" /> EDL
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void exportTimeline(n.name, timeline, "xmeml")}
                      >
                        <Download className="size-3" /> XML
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void exportTimeline(n.name, timeline, "fcpxml")}
                      >
                        <Download className="size-3" /> FCPXML
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Writes a real file to disk via the native save dialog — nothing is sent
                anywhere. EDL and XML (XMEML) import into Premiere Pro and Final Cut Pro 7;
                FCPXML imports natively into Final Cut Pro X and DaVinci Resolve. Import
                manually in each application; there is no live-push integration for these
                three yet (Premiere has a separate, experimental live bridge — see Settings).
              </p>
            </div>
          </aside>
        </div>
      </div>
      <SourcePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

/**
 * The edit decision list. Memoized: the CUT page re-renders on every playhead
 * tick, and on a long cut re-rendering every row each tick was the largest
 * per-frame cost; the rows only change when the cut does.
 */
const EdlTable = memo(function EdlTable({
  decisions,
  clips,
  onOpen,
}: {
  decisions: UniversalTimeline["decisions"];
  clips: Clip[];
  onOpen: (d: UniversalTimeline["decisions"][number]) => void;
}) {
  const clipById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <tr className="border-b border-border">
          <th className="px-5 py-2 font-normal">#</th>
          <th className="px-3 py-2 font-normal">Lane</th>
          <th className="px-3 py-2 font-normal">Event</th>
          <th className="px-3 py-2 font-normal">Source</th>
          <th className="px-3 py-2 font-normal">Source in</th>
          <th className="px-3 py-2 font-normal">Source out</th>
          <th className="px-3 py-2 font-normal">Duration</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {decisions.map((d, i) => (
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
            <td className="px-3 py-2 font-tc text-[11px] text-muted-foreground">
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => onOpen(d)}
                title="Preview this edit's source range"
              >
                <Play className="size-3" /> {clipById.get(d.clipId)?.filename ?? d.clipId}
              </button>
            </td>
            <td className="px-3 py-2 font-tc text-muted-foreground">{d.sourceInTc}</td>
            <td className="px-3 py-2 font-tc text-muted-foreground">{d.sourceOutTc}</td>
            <td className="px-3 py-2 font-tc">{d.durationSeconds.toFixed(1)}s</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});
