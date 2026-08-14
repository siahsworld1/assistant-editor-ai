import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, GitBranch, Loader2, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatDuration, useAE } from "@/lib/ae/store";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "CHAT — Director Mode | Assistant Editor AI" },
      {
        name: "description",
        content:
          "Director Mode: conversational edit commands where every instruction creates a new, non-destructive version of the cut.",
      },
      { property: "og:title", content: "CHAT — Director Mode" },
      {
        property: "og:description",
        content: "Conversational edit commands with a full non-destructive version history.",
      },
    ],
  }),
  component: ChatPage,
});

const suggestions = [
  "Make the opening stronger",
  "Cut this to 60 seconds",
  "Use more B-roll",
  "Give the middle more breathing room",
  "Show me three alternate endings",
];

function ChatPage() {
  const { versions, activeVersionId, setActiveVersion, runCommand, building, connection } =
    useAE();
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [versions.length]);

  const send = async (text: string) => {
    const cmd = text.trim();
    if (!cmd || building) return;
    setInput("");
    await runCommand(cmd);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Stage 05"
        title="CHAT — Director Mode"
        description="Talk to the cut. Every command is interpreted against the current timeline and produces a new version card; previous versions stay intact."
        actions={
          <Badge variant="outline" className="h-8 border-border px-3 text-xs">
            {versions.length} versions
          </Badge>
        }
      />

      <div className="grid flex-1 gap-4 px-6 py-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="panel p-4 text-sm text-muted-foreground">
              Director Mode is connected to{" "}
              {connection === "live" ? "the local engine" : "Demo Mode fixtures"}. Commands are
              non-destructive: each one branches from the version you have selected.
            </div>

            {versions.map((v, i) => (
              <div key={v.id} className="space-y-2">
                {i > 0 && (
                  <div className="flex justify-end">
                    <div className="max-w-[70%] rounded-lg rounded-br-sm border border-border bg-secondary px-4 py-2.5 text-sm">
                      {v.command}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setActiveVersion(v.id)}
                  className={cn(
                    "panel block w-full p-4 text-left transition-colors",
                    v.id === activeVersionId
                      ? "border-primary/50 bg-primary/[0.04]"
                      : "hover:bg-accent/30",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles className="size-3.5 text-primary" />
                    <span className="font-tc text-xs text-primary">{v.version}</span>
                    {v.parentId && (
                      <span className="flex items-center gap-1 font-tc text-[10px] text-muted-foreground">
                        <GitBranch className="size-3" /> from{" "}
                        {versions.find((p) => p.id === v.parentId)?.version}
                      </span>
                    )}
                    <span className="ml-auto font-tc text-[10px] text-muted-foreground">
                      {v.createdAt}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-foreground/90">{v.summary}</p>
                  <ul className="mt-2 space-y-1">
                    {v.changes.map((c) => (
                      <li key={c} className="flex gap-2 text-xs text-muted-foreground">
                        <span className="mt-[6px] size-1 shrink-0 rounded-full bg-primary/60" />
                        {c}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center gap-4 border-t border-border pt-2 font-tc text-[11px] text-muted-foreground">
                    <span>{v.timeline.decisions.length} events</span>
                    <span>{formatDuration(v.timeline.totalSeconds)} assembled</span>
                    <span>target {formatDuration(v.timeline.targetSeconds)}</span>
                    {v.id === activeVersionId && (
                      <span className="ml-auto text-primary">active in CUT</span>
                    )}
                  </div>
                </button>
              </div>
            ))}

            {building && (
              <div className="panel flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" /> Re-deriving timeline from
                the ProjectBrain…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="mt-4">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  disabled={building}
                  className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="panel flex items-end gap-2 p-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder="Describe the change — 'tighten act two and end on Grace'"
                className="min-h-0 resize-none border-0 bg-transparent focus-visible:ring-0"
              />
              <Button onClick={() => void send(input)} disabled={building || !input.trim()}>
                <CornerDownLeft className="size-4" /> Send
              </Button>
            </div>
          </div>
        </div>

        <aside className="panel h-fit p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Version history
          </div>
          <ol className="mt-3 space-y-0">
            {versions.map((v, i) => (
              <li key={v.id} className="relative pl-5">
                <span className="absolute left-[5px] top-1.5 size-2 rounded-full bg-primary" />
                {i < versions.length - 1 && (
                  <span className="absolute left-[9px] top-4 h-[calc(100%-0.5rem)] w-px bg-border" />
                )}
                <button
                  onClick={() => setActiveVersion(v.id)}
                  className="w-full pb-4 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "font-tc text-xs",
                        v.id === activeVersionId ? "text-primary" : "text-foreground",
                      )}
                    >
                      {v.version}
                    </span>
                    <span className="font-tc text-[10px] text-muted-foreground">
                      {v.createdAt}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{v.label}</div>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
