import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Clock, Film, FolderOpen, HardDrive, Plus, Trash2, Users } from "lucide-react";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROJECT_PROFILES } from "@/lib/ae/projects";
import type { EditingProfile } from "@/lib/ae/types";
import { useAE } from "@/lib/ae/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Projects — Assistant Editor AI" },
      {
        name: "description",
        content:
          "Project library for Assistant Editor AI: open a documentary, commercial, or corporate cut and pick up where the engine left off.",
      },
      { property: "og:title", content: "Projects — Assistant Editor AI" },
      {
        property: "og:description",
        content: "Project library for the Assistant Editor AI post-production assistant.",
      },
    ],
  }),
  component: ProjectsPage,
});

function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (input: {
    name: string;
    client: string;
    format: string;
    profile: EditingProfile;
  }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [format, setFormat] = useState("Documentary short");
  const [profile, setProfile] = useState<EditingProfile>("documentary");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Project metadata is stored locally on this workstation. Media is imported afterwards
            from WATCH.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="np-name">Project name</Label>
            <Input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Community Documentary"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-client">Client</Label>
            <Input
              id="np-client"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="Internal"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-format">Format</Label>
            <Input
              id="np-format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Editing profile</Label>
            <SelectRoot value={profile} onValueChange={(v) => setProfile(v as EditingProfile)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_PROFILES.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || busy}
            onClick={() => onCreate({ name: name.trim(), client, format, profile })}
          >
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectsPage() {
  const {
    project,
    loading,
    connection,
    selects,
    versions,
    projects,
    activeProject,
    projectsLoading,
    projectBusy,
    projectError,
    projectStoreLabel,
    createProject,
    openProject,
    deleteProject,
  } = useAE();
  const [dialogOpen, setDialogOpen] = useState(false);
  const others = projects.filter((p) => p.id !== activeProject?.id);

  return (
    <div>
      <PageHeader
        eyebrow="Library"
        title="Projects"
        description="Every project keeps its own ProjectBrain — media index, transcripts, visual evidence, selects and edit versions."
        actions={
          <Button onClick={() => setDialogOpen(true)} disabled={projectBusy}>
            <Plus className="size-4" /> New project
          </Button>
        }
      />

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        busy={projectBusy}
        onCreate={async (input) => {
          const created = await createProject(input);
          if (created) setDialogOpen(false);
        }}
      />

      <div className="space-y-8 px-6 py-6">
        <section>
          <h2 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Open
          </h2>
          {(loading || projectsLoading) && (
            <div className="panel h-40 animate-pulse bg-card/60" aria-hidden />
          )}
          {!loading && !projectsLoading && !project && (
            <div className="panel flex flex-col items-start gap-3 p-8">
              <Film className="size-6 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-medium">No project open</h3>
                <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                  Create a project to start a local ProjectBrain, then import a media folder in
                  WATCH so the engine can index it. Nothing is uploaded.
                </p>
              </div>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" /> Create project
              </Button>
            </div>
          )}
          {!loading && project && (
            <div className="panel overflow-hidden">
              <div className="flex flex-wrap items-start gap-6 p-6">
                <div className="hairline-grid grid h-28 w-48 shrink-0 place-items-center rounded-md border border-border bg-surface">
                  <Film className="size-7 text-primary/70" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold">{project.name}</h3>
                    <Badge variant="outline" className="border-primary/40 text-primary">
                      Active
                    </Badge>
                    {connection === "demo" && (
                      <Badge variant="outline" className="border-warning/40 text-warning">
                        Demo data
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {project.client} · {project.format}
                  </p>
                  <p className="mt-1 font-tc text-xs text-muted-foreground">
                    {project.mediaRoot}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-6 text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <HardDrive className="size-4" /> {project.clips.length} clips
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Users className="size-4" /> {project.summary.speakers} speakers
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="size-4" /> {project.summary.transcribedMinutes} min
                      transcribed
                    </span>
                    <span className="text-muted-foreground">
                      {selects.length} selects · {versions.length} cut versions
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Button asChild>
                    <Link to="/watch">
                      Open in WATCH <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to="/cut">Jump to CUT</Link>
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Local projects
            </h2>
            <span className="font-tc text-[11px] text-muted-foreground">{projectStoreLabel}</span>
          </div>
          {projectError && (
            <p className="mb-3 rounded-md border border-warning/40 bg-warning/[0.06] px-3 py-2 text-[11px] text-warning">
              {projectError}
            </p>
          )}
          <div className="grid gap-3 lg:grid-cols-3">
            {others.map((p) => (
              <div key={p.id} className="panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-medium">{p.name}</h3>
                  <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                    {p.profile}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.client} · {p.mediaCount} media files indexed
                </p>
                <p className="mt-1 truncate font-tc text-[10px] text-muted-foreground">
                  {p.mediaRoot || "No media folder yet"}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={projectBusy}
                    onClick={() => void openProject(p.id)}
                  >
                    <FolderOpen className="size-3.5" /> Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={projectBusy}
                    onClick={() => void deleteProject(p.id)}
                    aria-label={`Remove ${p.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
            {others.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other projects saved on this workstation yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
