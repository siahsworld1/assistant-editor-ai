import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertTriangle,
  AudioLines,
  Captions,
  Eye,
  FolderPlus,
  Loader2,
  Play,
  ScanEye,
} from "lucide-react";
import { MediaPlayer } from "@/components/ae/MediaPlayer";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useAE } from "@/lib/ae/store";
import { previewSrcForClip, thumbSrcForClip } from "@/lib/ae/media-url";
import type { Clip } from "@/lib/ae/types";

export const Route = createFileRoute("/watch")({
  head: () => ({
    meta: [
      { title: "WATCH — Footage Analysis | Assistant Editor AI" },
      {
        name: "description",
        content:
          "Media bin, transcription coverage and visual evidence for every clip, with analysis progress from the local engine.",
      },
      { property: "og:title", content: "WATCH — Footage Analysis" },
      {
        property: "og:description",
        content: "Media bin, transcription coverage and visual evidence per clip.",
      },
    ],
  }),
  component: WatchPage,
});

const filters = [
  { id: "all", label: "All media" },
  { id: "interview", label: "Interview" },
  { id: "b-roll", label: "B-roll" },
  { id: "ambient", label: "Audio" },
  { id: "issues", label: "Technical issues" },
] as const;

function secs(n: number) {
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function Thumb({ clip }: { clip: Clip }) {
  // Real thumbnails only ever apply to video clips (worker/pipeline.py never
  // generates one for audio-only files) — the gradient/play tile below remains
  // the permanent look for audio, and the fallback for a missing or broken image.
  const [failed, setFailed] = useState(false);
  const src = clip.role !== "ambient" ? thumbSrcForClip(clip) : null;
  const showImage = Boolean(src) && !failed;

  return (
    <div
      className="relative grid h-[52px] w-[92px] shrink-0 place-items-center overflow-hidden rounded border border-border"
      style={
        showImage
          ? undefined
          : {
              background: `linear-gradient(140deg, oklch(0.30 0.05 ${clip.thumbHue}), oklch(0.17 0.02 ${clip.thumbHue}))`,
            }
      }
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : clip.role === "ambient" ? (
        <AudioLines className="size-4 text-foreground/60" />
      ) : (
        <Play className="size-4 text-foreground/60" />
      )}
      <span className="absolute bottom-0.5 right-1 font-tc text-[9px] text-foreground/70">
        {secs(clip.durationSeconds)}
      </span>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className={cn("font-tc text-2xl", tone ?? "text-foreground")}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function WatchPage() {
  const {
    project,
    analyze,
    loading,
    connection,
    activeProject,
    mediaIndex,
    importMedia,
    projectBusy,
    desktopCapabilities,
  } = useAE();
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [selected, setSelected] = useState<string | null>("clip-001");
  const [importNote, setImportNote] = useState<string | null>(null);

  const runImport = async () => {
    setImportNote(null);
    const outcome = await importMedia();
    if (outcome.status === "imported" && outcome.index) {
      setImportNote(
        `Indexed ${outcome.index.files.length} media files from ${outcome.index.root}${
          outcome.index.truncated ? " (list truncated at the folder limit)" : ""
        }.`,
      );
    } else if (outcome.status === "cancelled") {
      setImportNote("Import cancelled.");
    } else if (outcome.error) {
      setImportNote(outcome.error);
    }
  };

  const clips = (project?.clips ?? []).filter((c) =>
    filter === "all"
      ? true
      : filter === "issues"
        ? c.technicalIssues.length > 0
        : c.role === filter,
  );
  const active = project?.clips.find((c) => c.id === selected) ?? clips[0];
  const hasMedia = (project?.clips.length ?? 0) > 0;
  const running = project?.analysisState === "running";

  return (
    <div>
      <PageHeader
        eyebrow="Stage 01"
        title="WATCH"
        description="The engine ingests every clip, transcribes speech, and logs visual evidence into the ProjectBrain."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void runImport()} disabled={projectBusy || connection === "demo"}>
              <FolderPlus className="size-4" /> Import media
            </Button>
          <Button onClick={analyze} disabled={running || loading || !hasMedia}>
            {running ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Analyzing…
              </>
            ) : (
              <>
                <ScanEye className="size-4" /> Analyze Footage
              </>
            )}
          </Button>
          </div>
        }
      />

      <div className="space-y-5 px-6 py-5">
        {!activeProject && connection !== "demo" && (
          <div className="panel px-5 py-6 text-sm text-muted-foreground">
            No project is open. Create or open one from{" "}
            <span className="text-foreground">Projects</span> before importing media.
          </div>
        )}

        {activeProject && (
          <div className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{activeProject.name}</div>
              <p className="truncate font-tc text-[11px] text-muted-foreground">
                {activeProject.mediaRoot || "No media folder imported yet"}
              </p>
            </div>
            <div className="text-right">
              <div className="font-tc text-sm text-primary">
                {mediaIndex?.files.length ?? activeProject.mediaCount}
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                media files indexed
              </div>
            </div>
          </div>
        )}

        {importNote && (
          <p className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
            {importNote}
          </p>
        )}
        {!desktopCapabilities && connection !== "demo" && (
          <p className="rounded-md border border-warning/40 bg-warning/[0.06] px-3 py-2 text-[11px] text-warning">
            Media import requires the Assistant Editor desktop companion. A browser tab cannot read
            a local media folder, and no video is ever processed in the browser.
          </p>
        )}

        <div className="panel px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">
                Analysis{" "}
                {project?.analysisState === "complete"
                  ? "complete"
                  : project?.analysisState === "error"
                    ? "failed"
                    : running
                      ? "in progress"
                      : "idle"}
              </div>
              <div className="text-xs text-muted-foreground">
                {connection === "demo"
                  ? "Simulated locally — no media leaves this workstation in Demo Mode."
                  : "Local engine job queue"}
              </div>
            </div>
            <span className="font-tc text-sm text-primary">
              {project?.analysisProgress ?? 0}%
            </span>
          </div>
          <Progress value={project?.analysisProgress ?? 0} className="mt-3 h-1.5" />
          {project?.analysisState === "error" && project.analysisError && (
            <p className="mt-3 rounded border border-warning/40 bg-warning/[0.06] px-3 py-2 text-[11px] text-warning">
              {project.analysisError}
            </p>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Speakers" value={project?.summary.speakers ?? 0} />
          <Metric label="Strong statements" value={project?.summary.strongStatements ?? 0} tone="text-primary" />
          <Metric label="Emotional moments" value={project?.summary.emotionalMoments ?? 0} />
          <Metric label="B-roll opportunities" value={project?.summary.brollOpportunities ?? 0} />
          <Metric label="Technical issues" value={project?.summary.technicalIssues ?? 0} tone="text-warning" />
          <Metric label="Minutes transcribed" value={project?.summary.transcribedMinutes ?? 0} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="panel overflow-hidden">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
              {filters.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs transition-colors",
                    filter === f.id
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto font-tc text-[11px] text-muted-foreground">
                {clips.length} items
              </span>
            </div>

            <ul className="divide-y divide-border">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <button
                    onClick={() => setSelected(clip.id)}
                    className={cn(
                      "flex w-full items-center gap-4 px-4 py-3 text-left transition-colors",
                      active?.id === clip.id ? "bg-accent/60" : "hover:bg-accent/30",
                    )}
                  >
                    <Thumb clip={clip} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-tc text-[13px]">{clip.filename}</span>
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] uppercase">
                          {clip.role}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{clip.camera}</span>
                        <span className="font-tc">{clip.resolution}</span>
                        {clip.speakers.length > 0 && <span>{clip.speakers.join(", ")}</span>}
                      </div>
                    </div>
                    <div className="flex w-[190px] shrink-0 items-center justify-end gap-2">
                      {clip.hasTranscript && (
                        <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <Captions className="size-3" /> transcript
                        </span>
                      )}
                      {clip.visualEvidenceCount > 0 && (
                        <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <Eye className="size-3" /> {clip.visualEvidenceCount}
                        </span>
                      )}
                      {clip.technicalIssues.length > 0 && (
                        <span className="flex items-center gap-1 rounded border border-warning/40 px-1.5 py-0.5 text-[10px] text-warning">
                          <AlertTriangle className="size-3" /> {clip.technicalIssues.length}
                        </span>
                      )}
                    </div>
                    <div className="w-20 shrink-0 text-right">
                      {clip.state === "analyzed" ? (
                        <span className="font-tc text-[11px] text-positive">ready</span>
                      ) : clip.state === "analyzing" ? (
                        <span className="font-tc text-[11px] text-warning">{clip.progress}%</span>
                      ) : clip.state === "error" ? (
                        <span className="font-tc text-[11px] text-warning">error</span>
                      ) : (
                        <span className="font-tc text-[11px] text-muted-foreground">queued</span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
              {clips.length === 0 && (
                <li className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {hasMedia
                    ? "No clips match this filter."
                    : connection === "demo"
                      ? "Demo Mode is loading its sample bin."
                      : "No media imported yet. Use Import media to index a folder on this workstation."}
                </li>
              )}
            </ul>
          </div>

          <aside className="panel h-fit p-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Clip inspector
            </div>
            {active ? (
              <div className="mt-3 space-y-4">
                <div className="font-tc text-sm">{active.filename}</div>

                {desktopCapabilities ? (
                  previewSrcForClip(active) ? (
                    <MediaPlayer key={active.id} src={previewSrcForClip(active)} />
                  ) : (
                    <p className="rounded border border-border bg-surface px-2.5 py-2 text-[11px] text-muted-foreground">
                      No preview yet — run Analyze (or re-run it) to generate a playable proxy
                      for this clip.
                    </p>
                  )
                ) : null}

                {active.state === "error" && active.note && (
                  <div className="rounded border border-warning/30 bg-warning/5 p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-warning">
                      <AlertTriangle className="size-3" /> Analysis could not read this file
                    </div>
                    <p className="text-xs text-foreground/85">{active.note}</p>
                  </div>
                )}

                <dl className="grid grid-cols-2 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd className="font-tc">{secs(active.durationSeconds)}</dd>
                  <dt className="text-muted-foreground">Frame rate</dt>
                  <dd className="font-tc">{active.fps ? `${active.fps} fps` : "—"}</dd>
                  <dt className="text-muted-foreground">Source</dt>
                  <dd>{active.camera}</dd>
                  <dt className="text-muted-foreground">Speakers</dt>
                  <dd>{active.speakers.join(", ") || "—"}</dd>
                </dl>

                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Transcript evidence
                  </div>
                  {project?.transcript
                    .filter((t) => t.clipId === active.id)
                    .map((t) => (
                      <p key={t.id} className="rounded border border-border bg-surface p-2.5 text-xs">
                        <span className="font-tc text-[10px] text-primary">
                          {t.startTc} → {t.endTc}
                        </span>
                        <span className="mt-1 block text-foreground/90">"{t.text}"</span>
                      </p>
                    )) ?? null}
                  {!project?.transcript.some((t) => t.clipId === active.id) && (
                    <p className="text-xs text-muted-foreground">
                      No dialogue detected in this clip.
                    </p>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Visual evidence
                  </div>
                  <ul className="space-y-1.5">
                    {(project?.visualEvidence ?? [])
                      .filter((v) => v.clipId === active.id)
                      .map((v) => (
                        <li key={v.id} className="flex items-start gap-2 text-xs">
                          <span className="font-tc text-[10px] text-primary">{v.atTc}</span>
                          <span className="text-foreground/85">{v.label}</span>
                        </li>
                      ))}
                    {!(project?.visualEvidence ?? []).some((v) => v.clipId === active.id) && (
                      <li className="text-xs text-muted-foreground">Nothing logged yet.</li>
                    )}
                  </ul>
                </div>

                {active.technicalIssues.length > 0 && (
                  <div className="rounded border border-warning/30 bg-warning/5 p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-warning">
                      <AlertTriangle className="size-3" /> Technical issues
                    </div>
                    <ul className="space-y-0.5 text-xs text-foreground/85">
                      {active.technicalIssues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Select a clip.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
