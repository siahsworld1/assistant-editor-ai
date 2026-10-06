// Settings → AI providers. Keys are stored by the desktop app in the macOS
// Keychain (electron/credential-store.cjs). This component can only ask whether
// a provider is configured, submit a new key, or remove one — the bridge has no
// way to read a stored key back, so a saved key is never shown again, in full
// or in part. A typed key lives in component state only until it's submitted.
import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type {
  CredentialChangeResponse,
  CredentialProvider,
  CredentialStatusResponse,
} from "@/types/bridge";

const PROVIDERS: Array<{
  id: CredentialProvider;
  name: string;
  hint: string;
  placeholder: string;
}> = [
  { id: "openai", name: "OpenAI", hint: "Used for transcription (Whisper).", placeholder: "sk-…" },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Used for visual analysis, selects, stories and builds (Claude).",
    placeholder: "sk-ant-…",
  },
];

type Feedback = { kind: "ok" | "error"; text: string } | null;

/** What a successful save/remove means for the running engine. */
function workerOutcome(res: CredentialChangeResponse, verb: string): Feedback {
  const w = res.worker;
  if (w?.reason === "development-dotenv") {
    return {
      kind: "ok",
      text: `${verb}. In development the engine uses the repository .env — Keychain keys apply to the packaged app.`,
    };
  }
  if (w?.reason === "adopted") {
    return {
      kind: "error",
      text: `${verb}, but the local engine was started outside this app, so it can't be given the change. Restart that engine yourself (or quit it and Reconnect) to use it.`,
    };
  }
  if (w?.reason === "restart-failed") {
    return {
      kind: "error",
      text: `${verb}, but the local engine didn't restart: ${w.error ?? "unknown error"}`,
    };
  }
  return {
    kind: "ok",
    text: `${verb}. The local engine restarted with the change.`,
  };
}

export function ProviderCredentials({ onEngineRestarted }: { onEngineRestarted: () => void }) {
  const api = typeof window === "undefined" ? undefined : window.assistantEditorCredentials;
  const [status, setStatus] = useState<CredentialStatusResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<CredentialProvider, string>>({
    openai: "",
    anthropic: "",
  });
  const [busy, setBusy] = useState<CredentialProvider | null>(null);
  const [feedback, setFeedback] = useState<Record<CredentialProvider, Feedback>>({
    openai: null,
    anthropic: null,
  });

  const refresh = useCallback(async () => {
    if (!api) return;
    setStatus(await api.status());
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async (provider: CredentialProvider, action: "save" | "remove") => {
    if (!api) return;
    setBusy(provider);
    setFeedback((f) => ({ ...f, [provider]: null }));
    try {
      const res =
        action === "save" ? await api.save(provider, drafts[provider]) : await api.remove(provider);
      if (res.providers) setStatus(res as CredentialStatusResponse);
      if (!res.ok) {
        setFeedback((f) => ({
          ...f,
          [provider]: { kind: "error", text: res.error ?? "Something went wrong." },
        }));
        toast.error(res.error ?? "Something went wrong.");
        return;
      }
      // Saved: the typed key leaves the UI immediately and is never shown again.
      if (action === "save") setDrafts((d) => ({ ...d, [provider]: "" }));
      const outcome = workerOutcome(
        res,
        action === "save" ? "Saved to the Keychain" : "Removed from the Keychain",
      );
      setFeedback((f) => ({ ...f, [provider]: outcome }));
      if (outcome?.kind === "ok") toast.success(outcome.text);
      else if (outcome) toast.warning(outcome.text);
      if (res.worker?.restarted) onEngineRestarted();
    } finally {
      setBusy(null);
    }
  };

  if (!api) {
    return (
      <p className="text-xs text-muted-foreground">
        API keys are managed by the Assistant Editor desktop app and stored in the macOS Keychain.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {status?.error && <p className="text-[11px] text-destructive">{status.error}</p>}
      {status?.appliesTo === "development-dotenv" && (
        <p className="rounded border border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
          Development build: the local engine uses the repository <code>.env</code>. Keys saved here
          are stored in the Keychain and used by the packaged app.
        </p>
      )}
      {PROVIDERS.map((p) => {
        const configured = status?.providers[p.id]?.configured ?? false;
        const fb = feedback[p.id];
        const inputId = `api-key-${p.id}`;
        return (
          <div
            key={p.id}
            className="rounded border border-border bg-surface p-3"
            data-testid={`provider-${p.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={inputId} className="flex items-center gap-1.5 text-xs font-medium">
                <KeyRound className="size-3.5" /> {p.name} API key
              </Label>
              <Badge
                variant="outline"
                data-testid={`status-${p.id}`}
                className={cn(
                  "text-[10px]",
                  configured ? "border-positive/50 text-positive" : "text-muted-foreground",
                )}
              >
                {status ? (configured ? "Configured" : "Not configured") : "Checking…"}
              </Badge>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{p.hint}</p>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void apply(p.id, "save");
              }}
            >
              <Input
                id={inputId}
                data-testid={`input-${p.id}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  configured ? "Enter a new key to replace the saved one" : p.placeholder
                }
                value={drafts[p.id]}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                className="h-8 font-tc text-xs"
                disabled={busy !== null}
              />
              <Button
                type="submit"
                size="sm"
                data-testid={`save-${p.id}`}
                disabled={busy !== null || !drafts[p.id].trim()}
              >
                {busy === p.id ? "Saving…" : configured ? "Update" : "Save"}
              </Button>
              {configured && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`remove-${p.id}`}
                  disabled={busy !== null}
                  onClick={() => void apply(p.id, "remove")}
                >
                  Remove
                </Button>
              )}
            </form>
            {fb && (
              <p
                data-testid={`feedback-${p.id}`}
                className={cn(
                  "mt-1.5 text-[11px]",
                  fb.kind === "ok" ? "text-positive" : "text-destructive",
                )}
              >
                {fb.text}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        Keys are stored in your macOS Keychain and passed only to the local engine. Saving or
        removing a key restarts the engine; it can't be done while an analysis is running.
      </p>
    </div>
  );
}
