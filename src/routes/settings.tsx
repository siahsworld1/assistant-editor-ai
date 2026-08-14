import { createFileRoute } from "@tanstack/react-router";
import { Cloud, HardDrive, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ae/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAE } from "@/lib/ae/store";
import { ENGINE_BASE_URL } from "@/lib/ae/service";
import { usePremiereBridge } from "@/lib/nle/premiere/usePremiereBridge";
import type { EditingProfile } from "@/lib/ae/types";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Assistant Editor AI" },
      {
        name: "description",
        content:
          "Processing location, media privacy, transcription, NLE integrations, cache and editing profiles for Assistant Editor AI.",
      },
      { property: "og:title", content: "Settings — Assistant Editor AI" },
      {
        property: "og:description",
        content: "Local-first processing, transcription, NLE integrations and editing profiles.",
      },
    ],
  }),
  component: SettingsPage,
});

const profiles: Array<{ id: EditingProfile; label: string; blurb: string }> = [
  { id: "documentary", label: "Documentary", blurb: "Long holds, sync-led, evidence-first selects" },
  { id: "commercial", label: "Commercial", blurb: "Tight bites, high B-roll ratio, beat-driven" },
  { id: "wedding", label: "Wedding", blurb: "Emotion weighting, music-led pacing, vows priority" },
  { id: "corporate", label: "Corporate", blurb: "Message clarity, filler removal, brand-safe takes" },
  { id: "social", label: "Social", blurb: "Sub-60s targets, vertical-safe framing, hook-first" },
];

const STATE_DOT: Record<string, string> = {
  ok: "bg-positive",
  pending: "animate-pulse bg-warning",
  error: "bg-destructive",
  unsupported: "bg-muted-foreground/60",
  blocked: "bg-warning",
  unknown: "bg-muted-foreground/40",
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function SettingsPage() {
  const {
    settings,
    updateSettings,
    nle,
    connection,
    retryConnection,
    connectionError,
    diagnostics,
    capabilities,
    transportLabel,
    hostContext,
    blockedReason,
    lastHealthAt,
    mode,
    setMode,
    appVersion,
    desktopCapabilities,
    projectStoreLabel,
  } = useAE();
  const premiere = usePremiereBridge();

  return (
    <div>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Assistant Editor is local-first. Cloud processing is strictly opt-in and never enabled by default."
      />

      <div className="grid gap-4 px-6 py-5 2xl:grid-cols-2">
        <Section
          title="Media processing"
          description="Where transcription, vision analysis and story reasoning are executed."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                {
                  id: "local" as const,
                  icon: HardDrive,
                  title: "Local / Private",
                  blurb: "Everything runs on this workstation. Default.",
                },
                {
                  id: "cloud" as const,
                  icon: Cloud,
                  title: "Cloud assist",
                  blurb: "Opt-in. Uploads proxies for heavier reasoning.",
                },
              ]
            ).map((opt) => (
              <button
                key={opt.id}
                onClick={() => updateSettings({ processing: opt.id })}
                className={cn(
                  "rounded-md border p-4 text-left transition-colors",
                  settings.processing === opt.id
                    ? "border-primary/60 bg-primary/[0.05]"
                    : "border-border hover:bg-accent/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <opt.icon className="size-4 text-primary" />
                  <span className="text-sm font-medium">{opt.title}</span>
                  {opt.id === "local" && (
                    <Badge variant="secondary" className="h-4 text-[10px]">
                      recommended
                    </Badge>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{opt.blurb}</p>
              </button>
            ))}
          </div>

          <div className="rounded-md border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Lock className="size-3.5 text-positive" /> Media privacy
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              In Local / Private mode your camera originals, audio and transcripts stay on this
              machine. The app talks only to the Assistant Editor engine on{" "}
              <span className="font-tc text-foreground/80">{ENGINE_BASE_URL}</span> over loopback —
              no frames, no audio and no transcript text are transmitted off-device. Enabling Cloud
              assist uploads low-bitrate proxies and transcript text only, and is disclosed per
              project before any transfer.
            </p>
          </div>
        </Section>

        <Section title="Transcription" description="Speech-to-text and speaker handling.">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">Model</Label>
              <UiSelect
                value={settings.transcriptionModel}
                onValueChange={(v) => updateSettings({ transcriptionModel: v })}
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whisper-large-v3 (local)">whisper-large-v3 (local)</SelectItem>
                  <SelectItem value="whisper-medium (local)">whisper-medium (local)</SelectItem>
                  <SelectItem value="parakeet-rnnt (local)">parakeet-rnnt (local)</SelectItem>
                </SelectContent>
              </UiSelect>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Language</Label>
              <UiSelect
                value={settings.transcriptionLanguage}
                onValueChange={(v) => updateSettings({ transcriptionLanguage: v })}
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en-US">English (US)</SelectItem>
                  <SelectItem value="en-GB">English (UK)</SelectItem>
                  <SelectItem value="es-ES">Spanish</SelectItem>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                </SelectContent>
              </UiSelect>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
            <div>
              <div className="text-xs font-medium">Speaker diarization</div>
              <p className="text-[11px] text-muted-foreground">Label each speaker across clips.</p>
            </div>
            <Switch
              checked={settings.speakerDiarization}
              onCheckedChange={(v) => updateSettings({ speakerDiarization: v })}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
            <div>
              <div className="text-xs font-medium">Keep filler words</div>
              <p className="text-[11px] text-muted-foreground">
                Retain "um" / "you know" in select in-points.
              </p>
            </div>
            <Switch
              checked={settings.filler_words}
              onCheckedChange={(v) => updateSettings({ filler_words: v })}
            />
          </div>
        </Section>

        <Section
          title="NLE integrations"
          description="Detected editing applications on this workstation."
        >
          <ul className="space-y-2">
            {nle.map((n) => (
              <li
                key={n.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        n.detected ? "bg-positive" : "bg-muted-foreground/50",
                      )}
                    />
                    {n.name}
                    {n.version && (
                      <span className="font-tc text-[10px] text-muted-foreground">{n.version}</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {n.projectLinked ?? n.note ?? "Idle"}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={!n.detected}>
                  {n.detected ? "Link project" : "Not installed"}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
            <div>
              <div className="text-xs font-medium">Engine connection</div>
              <p className="font-tc text-[11px] text-muted-foreground">
                {ENGINE_BASE_URL} ·{" "}
                {connection === "live"
                  ? "online"
                  : connection === "degraded"
                    ? "degraded — reconnecting"
                    : connection === "bridge-required"
                      ? "desktop bridge required"
                      : connection === "demo"
                        ? "Demo Mode"
                        : "probing"}
              </p>
              {connectionError && (
                <p className="mt-1 text-[11px] text-warning">{connectionError}</p>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={retryConnection}>
              <RefreshCw className="size-3.5" /> Reconnect
            </Button>
          </div>
        </Section>

        <Section
          title="Engine diagnostics"
          description="Per-endpoint state for the local Assistant Editor worker. Optional endpoints never affect Live mode."
        >
          <div className="grid gap-2 rounded-md border border-border bg-surface p-3 text-[11px] sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Transport</span>
              <div className="font-tc text-foreground/85">{transportLabel}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Host context</span>
              <div className="font-tc text-foreground/85">{hostContext}</div>
            </div>
            <div>
              <span className="text-muted-foreground">App build</span>
              <div className="font-tc text-foreground/85">{appVersion}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Last health</span>
              <div className="font-tc text-foreground/85">
                {lastHealthAt ? new Date(lastHealthAt).toLocaleTimeString() : "never"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Desktop bridge</span>
              <div className="font-tc text-foreground/85">
                {hostContext === "desktop-bridge" ? "active" : "inactive"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Desktop capabilities</span>
              <div className="font-tc text-foreground/85">
                {desktopCapabilities ? "projects + media import" : "unavailable (browser)"}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Project store</span>
              <div className="font-tc text-foreground/85">{projectStoreLabel}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Premiere panel</span>
              <div className="font-tc text-foreground/85">{premiere.label}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Worker</span>
              <div className="font-tc text-foreground/85">
                {connection === "live"
                  ? "healthy"
                  : connection === "degraded"
                    ? "degraded"
                    : connection === "demo"
                      ? "not queried (demo mode)"
                      : "unreachable"}
              </div>
            </div>
          </div>

          {blockedReason && (
            <p className="rounded-md border border-warning/40 bg-warning/[0.06] p-3 text-[11px] leading-relaxed text-warning">
              {blockedReason}
            </p>
          )}

          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {Object.values(diagnostics).map((d) => (
              <li key={d.endpoint} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-1.5 rounded-full", STATE_DOT[d.state])} />
                    <span className="font-tc text-[11px] text-foreground">/{d.endpoint}</span>
                    {d.optional && (
                      <Badge variant="outline" className="h-4 border-border text-[9px]">
                        optional
                      </Badge>
                    )}
                    {capabilities && (
                      <span className="text-[10px] text-muted-foreground">
                        {capabilities[d.endpoint] ? "advertised" : "not advertised"}
                      </span>
                    )}
                  </div>
                  {d.error && (
                    <p className="mt-0.5 truncate text-[11px] text-warning" title={d.error}>
                      {d.error}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] capitalize text-foreground/80">{d.state}</div>
                  <div className="font-tc text-[10px] text-muted-foreground">
                    {d.lastSuccessAt
                      ? `ok ${new Date(d.lastSuccessAt).toLocaleTimeString()}`
                      : "no success yet"}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
            <div>
              <div className="text-xs font-medium">Data source</div>
              <p className="text-[11px] text-muted-foreground">
                Demo Mode is explicit — fixtures are never mixed into a live engine session.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={mode === "auto" ? "secondary" : "outline"}
                onClick={() => setMode("auto")}
              >
                Live engine
              </Button>
              <Button
                size="sm"
                variant={mode === "demo" ? "secondary" : "outline"}
                onClick={() => setMode("demo")}
              >
                Demo Mode
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Storage & cache" description="Proxies, analysis artefacts and thumbnails.">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Cache ceiling</span>
              <span className="font-tc text-primary">{settings.cacheGb} GB</span>
            </div>
            <Slider
              value={[settings.cacheGb]}
              min={8}
              max={512}
              step={8}
              onValueChange={([v]) => updateSettings({ cacheGb: v ?? settings.cacheGb })}
            />
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-secondary">
              <div className="h-full bg-primary/70" style={{ width: "38%" }} />
            </div>
            <p className="mt-1.5 font-tc text-[11px] text-muted-foreground">
              {Math.round(settings.cacheGb * 0.38)} GB used · /Library/Caches/AssistantEditor
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
            <div>
              <div className="text-xs font-medium">Generate proxy media</div>
              <p className="text-[11px] text-muted-foreground">1/4 res ProRes Proxy for scrubbing.</p>
            </div>
            <Switch
              checked={settings.proxyMedia}
              onCheckedChange={(v) => updateSettings({ proxyMedia: v })}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => toast("Cache purge requested", { description: "Engine will reclaim analysis artefacts." })}
          >
            Purge analysis cache
          </Button>
        </Section>

        <Section
          title="Editing profile"
          description="Profiles bias select scoring, pacing targets and B-roll ratios."
        >
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => updateSettings({ profile: p.id })}
                className={cn(
                  "rounded-md border p-3 text-left transition-colors",
                  settings.profile === p.id
                    ? "border-primary/60 bg-primary/[0.05]"
                    : "border-border hover:bg-accent/30",
                )}
              >
                <div className="text-xs font-medium">{p.label}</div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{p.blurb}</p>
              </button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
