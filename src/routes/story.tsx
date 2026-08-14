import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration, useAE } from "@/lib/ae/store";

export const Route = createFileRoute("/story")({
  head: () => ({
    meta: [
      { title: "STORY — Narrative Candidates | Assistant Editor AI" },
      {
        name: "description",
        content:
          "Three narrative candidates with premise, beat structure, estimated duration and the selects that support each act.",
      },
      { property: "og:title", content: "STORY — Narrative Candidates" },
      {
        property: "og:description",
        content: "Compare story candidates with beat structure and supporting selects.",
      },
    ],
  }),
  component: StoryPage,
});

function StoryPage() {
  const { stories, selects, chosenStoryId, chooseStory, setTargetSeconds } = useAE();
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        eyebrow="Stage 03"
        title="STORY"
        description="Each candidate is a different reading of the same footage. Choosing one sets the spine for the assembly — it does not delete the others."
      />

      <div className="grid gap-4 px-6 py-5 2xl:grid-cols-3">
        {stories.map((story) => {
          const chosen = chosenStoryId === story.id;
          return (
            <article
              key={story.id}
              className={cn(
                "panel flex flex-col p-5 transition-colors",
                chosen && "border-primary/60 bg-primary/[0.04]",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{story.title}</h2>
                  <div className="mt-1 flex items-center gap-3 font-tc text-[11px] text-muted-foreground">
                    <span>{formatDuration(story.estimatedSeconds)} est.</span>
                    <span>{story.beats.length} beats</span>
                    <span>confidence {(story.confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
                {chosen && (
                  <Badge className="gap-1 bg-primary/15 text-primary hover:bg-primary/15">
                    <Check className="size-3" /> Chosen
                  </Badge>
                )}
              </div>

              <p className="mt-3 text-sm leading-relaxed text-foreground/85">{story.premise}</p>

              <div className="mt-4 flex h-1.5 overflow-hidden rounded">
                {story.beats.map((b, i) => (
                  <div
                    key={b.id}
                    className="h-full"
                    style={{
                      width: `${(b.estimatedSeconds / story.estimatedSeconds) * 100}%`,
                      background: `oklch(${0.5 + i * 0.06} 0.1 ${52 + i * 22})`,
                    }}
                  />
                ))}
              </div>

              <ol className="mt-4 flex-1 space-y-2.5">
                {story.beats.map((beat, i) => (
                  <li key={beat.id} className="rounded border border-border bg-surface p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        <span className="font-tc mr-2 text-muted-foreground">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {beat.label}
                      </span>
                      <span className="font-tc text-[11px] text-muted-foreground">
                        {beat.estimatedSeconds}s
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{beat.intent}</p>
                    {beat.selectIds.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {beat.selectIds.map((id) => {
                          const s = selects.find((x) => x.id === id);
                          return (
                            <span
                              key={id}
                              className="rounded border border-border px-1.5 py-0.5 font-tc text-[10px] text-muted-foreground"
                            >
                              {s ? `${s.speaker.split(" ")[0]} · ${s.startTc}` : id}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Supporting selects
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {story.supportingSelectIds.map((id) => {
                    const s = selects.find((x) => x.id === id);
                    return (
                      <span
                        key={id}
                        className="rounded bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
                      >
                        {s ? s.speaker : id}
                        {s && <span className="ml-1.5 font-tc text-muted-foreground">{s.score}</span>}
                      </span>
                    );
                  })}
                </div>
              </div>

              <Button
                className="mt-4"
                variant={chosen ? "secondary" : "default"}
                onClick={() => {
                  chooseStory(story.id);
                  setTargetSeconds(story.estimatedSeconds);
                  toast("Story spine selected", { description: story.title });
                  void navigate({ to: "/cut" });
                }}
              >
                <Sparkles className="size-4" />
                {chosen ? "Re-run with this story" : "Choose this story"}
              </Button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
