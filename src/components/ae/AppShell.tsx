import { Link, useRouterState } from "@tanstack/react-router";
import {
  Clapperboard,
  Eye,
  Film,
  LayoutGrid,
  MessageSquare,
  Scissors,
  Settings as SettingsIcon,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAE } from "@/lib/ae/store";
import { ENGINE_BASE_URL } from "@/lib/ae/service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const nav: Array<{ to: string; label: string; icon: LucideIcon; hint: string }> = [
  { to: "/", label: "Projects", icon: LayoutGrid, hint: "Library" },
  { to: "/watch", label: "WATCH", icon: Eye, hint: "Ingest & analysis" },
  { to: "/selects", label: "SELECTS", icon: SlidersHorizontal, hint: "Ranked bites" },
  { to: "/story", label: "STORY", icon: Film, hint: "Candidates" },
  { to: "/cut", label: "CUT", icon: Scissors, hint: "Assembly" },
  { to: "/chat", label: "CHAT", icon: MessageSquare, hint: "Director Mode" },
];

function NleCard({
  name,
  detected,
  version,
  detail,
}: {
  name: string;
  detected: boolean;
  version?: string | undefined;
  detail?: string | null | undefined;
}) {
  return (
    <div
      className={cn(
        "flex min-w-[186px] items-center gap-2.5 rounded-md border px-3 py-1.5",
        detected
          ? "border-border bg-surface-raised"
          : "border-border/60 bg-surface opacity-70",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          detected ? "bg-positive" : "bg-muted-foreground/50",
        )}
      />
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{name}</span>
          {version && (
            <span className="font-tc text-[10px] text-muted-foreground">{version}</span>
          )}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {detected ? (detail ?? "Idle — no project linked") : (detail ?? "Not detected")}
        </div>
      </div>
    </div>
  );
}

const CONNECTION_LABEL: Record<string, string> = {
  live: "Local engine online",
  connecting: "Probing local engine…",
  degraded: "Engine degraded — reconnecting",
  "bridge-required": "Desktop Bridge Required",
  demo: "Demo Mode — fixture data",
};

function StatusBar() {
  const {
    project,
    nle,
    nleReported,
    connection,
    health,
    connectionError,
    blockedReason,
    transportLabel,
    retryConnection,
    setMode,
    mode,
  } = useAE();

  const dotClass =
    connection === "live"
      ? "bg-positive"
      : connection === "connecting"
        ? "animate-pulse bg-warning"
        : connection === "degraded"
          ? "animate-pulse bg-warning"
          : "bg-warning";

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-surface px-5 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Active project
        </div>
        <div className="truncate text-sm font-medium text-foreground">
          {project?.name ?? "No project"}
          {project && (
            <span className="ml-2 font-tc text-[11px] font-normal text-muted-foreground">
              {project.format}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 rounded-md border border-border bg-surface-raised px-3 py-1.5">
        <span className={cn("size-1.5 rounded-full", dotClass)} />
        <div>
          <div className="text-xs font-medium text-foreground">
            {CONNECTION_LABEL[connection] ?? connection}
          </div>
          <div className="font-tc text-[10px] text-muted-foreground">
            {connection === "bridge-required" ? transportLabel : ENGINE_BASE_URL}
            {health?.version ? ` · ${health.version}` : ""}
          </div>
        </div>
        {connection !== "connecting" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={retryConnection}
          >
            Reconnect
          </Button>
        )}
        {connection !== "demo" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode("demo")}
          >
            Use Demo Mode
          </Button>
        )}
        {connection === "demo" && mode === "demo" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode("auto")}
          >
            Try engine
          </Button>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {nle.map((n) => (
          <NleCard
            key={n.id}
            name={n.name}
            detected={n.detected}
            version={n.version}
            detail={n.projectLinked ?? n.note ?? (nleReported ? undefined : "Bridge not reported")}
          />
        ))}
      </div>

      {connection === "bridge-required" && blockedReason && (
        <div className="w-full text-[11px] text-warning">{blockedReason}</div>
      )}

      {connection === "degraded" && connectionError && (
        <div className="w-full text-[11px] text-warning">
          {connectionError} — showing the last data received from the engine.
        </div>
      )}

      {connectionError && connection === "demo" && (
        <div className="w-full text-[11px] text-warning">
          {connectionError} — showing labeled demo fixtures; every action is simulated.
        </div>
      )}
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { connection, project, appVersion } = useAE();

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2.5 border-b border-sidebar-border px-5 py-4">
          <div className="grid size-8 place-items-center rounded-md border border-primary/40 bg-primary/10">
            <Clapperboard className="size-4 text-primary" />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-[0.06em] text-sidebar-foreground">
              ASSISTANT EDITOR
            </div>
            <div className="font-tc text-[10px] text-muted-foreground">AI · {appVersion}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {nav.map((item) => {
            const active =
              item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <item.icon
                  className={cn("size-4", active ? "text-primary" : "text-current")}
                />
                <span className="flex-1 tracking-[0.06em]">{item.label}</span>
                <span className="text-[10px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
                  {item.hint}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="space-y-2 border-t border-sidebar-border px-3 py-3">
          <Link
            to="/settings"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              pathname.startsWith("/settings")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <SettingsIcon className="size-4" />
            Settings
          </Link>
          <div className="rounded-md border border-sidebar-border bg-surface px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Mode
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "h-5 border-border px-1.5 text-[10px]",
                  connection === "live" ? "text-positive" : "text-warning",
                )}
              >
                {connection === "live"
                  ? "ENGINE"
                  : connection === "degraded"
                    ? "DEGRADED"
                    : connection === "bridge-required"
                      ? "BRIDGE"
                      : connection === "connecting"
                        ? "PROBING"
                        : "DEMO"}
              </Badge>
            </div>
            <div className="mt-1 truncate font-tc text-[10px] text-muted-foreground">
              {project?.mediaRoot ?? "—"}
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBar />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border bg-surface/60 px-6 py-5">
      <div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-primary">
          {eyebrow}
        </div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
