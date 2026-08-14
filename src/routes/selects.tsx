import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Headphones, Plus, Shuffle, Square } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAE } from "@/lib/ae/store";

export const Route = createFileRoute("/selects")({
  head: () => ({
    meta: [
      { title: "SELECTS — Ranked Interview Bites | Assistant Editor AI" },
      {
        name: "description",
        content:
          "Ranked interview selects with speaker, timecode, score, transcript excerpt and the evidence behind each recommendation.",
      },
      { property: "og:title", content: "SELECTS — Ranked Interview Bites" },
      {
        property: "og:description",
        content: "Ranked interview selects with score, transcript excerpt and evidence.",
      },
    ],
  }),
  component: SelectsPage,
});

const categories = [
  { id: "all", label: "All" },
  { id: "strong-statement", label: "Strong statement" },
  { id: "emotional", label: "Emotional" },
  { id: "context", label: "Context" },
  { id: "humor", label: "Humor" },
  { id: "closing", label: "Closing" },
] as const;

function SelectsPage() {
  const { selects, storyboardSelectIds, toggleStorySelect, audition, auditionId, loading } =
    useAE();
  const [cat, setCat] = useState<(typeof categories)[number]["id"]>("all");
  const [speaker, setSpeaker] = useState<string>("all");

  const speakers = Array.from(new Set(selects.map((s) => s.speaker)));
  const rows = selects.filter(
    (s) =>
      (cat === "all" || s.category === cat) && (speaker === "all" || s.speaker === speaker),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Stage 02"
        title="SELECTS"
        description="Every bite is ranked from transcript, audio and visual evidence. Nothing is discarded — lower-ranked takes stay available as alternates."
        actions={
          <Badge variant="outline" className="h-8 gap-2 border-border px-3 text-xs">
            {storyboardSelectIds.length} added to story
          </Badge>
        }
      />

      <div className="px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                cat === c.id
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
          <span className="mx-2 h-4 w-px bg-border" />
          <button
            onClick={() => setSpeaker("all")}
            className={cn(
              "rounded px-2.5 py-1 text-xs",
              speaker === "all" ? "bg-secondary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            All speakers
          </button>
          {speakers.map((s) => (
            <button
              key={s}
              onClick={() => setSpeaker(s)}
              className={cn(
                "rounded px-2.5 py-1 text-xs",
                speaker === s ? "bg-secondary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>

        {loading && <div className="panel h-56 animate-pulse bg-card/60" aria-hidden />}

        <div className="space-y-3">
          {rows.map((s) => {
            const added = storyboardSelectIds.includes(s.id);
            const auditioning = auditionId === s.id;
            return (
              <article
                key={s.id}
                className={cn(
                  "panel p-5 transition-colors",
                  auditioning && "border-primary/50 bg-primary/[0.04]",
                )}
              >
                <div className="flex flex-wrap items-start gap-5">
                  <div className="flex w-12 shrink-0 flex-col items-center">
                    <span className="font-tc text-xl text-primary">
                      {String(s.rank).padStart(2, "0")}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      rank
                    </span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{s.speaker}</h3>
                      <Badge variant="secondary" className="h-5 text-[10px] uppercase">
                        {s.category.replace("-", " ")}
                      </Badge>
                      {s.alternateOf && (
                        <Badge variant="outline" className="h-5 border-border text-[10px]">
                          alternate bite
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 font-tc text-[11px] text-muted-foreground">
                      <span>{s.clipName}</span>
                      <span className="text-primary/80">
                        {s.startTc} → {s.endTc}
                      </span>
                      <span>{s.durationSeconds.toFixed(1)}s</span>
                    </div>

                    <blockquote className="mt-3 border-l-2 border-primary/50 pl-3 text-sm leading-relaxed text-foreground/90">
                      "{s.transcriptExcerpt}"
                    </blockquote>

                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <div>
                        <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          Why it ranked
                        </div>
                        <ul className="space-y-1 text-xs text-foreground/85">
                          {s.reasons.map((r) => (
                            <li key={r} className="flex gap-2">
                              <span className="mt-[6px] size-1 shrink-0 rounded-full bg-primary/70" />
                              {r}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          Evidence
                        </div>
                        <ul className="space-y-1 text-xs">
                          {s.evidence.map((e) => (
                            <li key={e.detail} className="flex gap-2">
                              <span className="font-tc text-[10px] uppercase text-muted-foreground">
                                {e.kind}
                              </span>
                              <span className="text-foreground/85">{e.detail}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div className="flex w-[188px] shrink-0 flex-col items-end gap-2">
                    <div className="w-full rounded-md border border-border bg-surface px-3 py-2 text-right">
                      <div className="font-tc text-2xl text-foreground">{s.score}</div>
                      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        select score
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded bg-secondary">
                        <div className="h-full bg-primary" style={{ width: `${s.score}%` }} />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={auditioning ? "secondary" : "outline"}
                      className="w-full"
                      onClick={() => audition(auditioning ? null : s.id)}
                    >
                      {auditioning ? <Square className="size-3.5" /> : <Headphones className="size-3.5" />}
                      {auditioning ? "Stop audition" : "Audition"}
                    </Button>
                    <Button
                      size="sm"
                      variant={added ? "secondary" : "default"}
                      className="w-full"
                      onClick={() => toggleStorySelect(s.id)}
                    >
                      {added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                      {added ? "In story" : "Add to story"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full text-muted-foreground"
                      onClick={() =>
                        toast("Alternate bite requested", {
                          description: `Engine will surface the next-best take for ${s.speaker}.`,
                        })
                      }
                    >
                      <Shuffle className="size-3.5" /> Alternate bite
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
