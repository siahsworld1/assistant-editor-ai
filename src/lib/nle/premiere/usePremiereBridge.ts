import { useEffect, useState } from "react";
import type { PremiereBridgeStatus, PremiereRendererApi } from "./contract";

/** Reads the Premiere bridge status from the desktop shell (no-op in browsers). */
export function getPremiereApi(): PremiereRendererApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { assistantEditorPremiere?: PremiereRendererApi })
    .assistantEditorPremiere;
  return api ?? null;
}

export interface PremiereBridgeView {
  available: boolean;
  status: PremiereBridgeStatus | null;
  label: string;
}

export function usePremiereBridge(pollMs = 10_000): PremiereBridgeView {
  const [status, setStatus] = useState<PremiereBridgeStatus | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const api = getPremiereApi();
    setAvailable(Boolean(api));
    if (!api) return;
    let cancelled = false;
    const tick = async () => {
      const res = await api.status().catch(() => null);
      if (!cancelled && res?.ok && res.status) setStatus(res.status);
    };
    void tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  const label = !available
    ? "unavailable (browser)"
    : !status?.listening
      ? "bridge not listening"
      : status.connected
        ? `panel connected · plugin ${status.pluginVersion ?? "?"}`
        : "listening · no panel";

  return { available, status, label };
}