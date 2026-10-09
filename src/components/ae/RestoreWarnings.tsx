// What couldn't be restored when a project's saved edits were opened
// (store.restoreWarnings): a damaged or out-of-date file, a dropped undo
// history, media the cut no longer matches. Shown once per opening until the
// filmmaker dismisses it — nothing is repaired or hidden silently.
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export function RestoreWarnings({ warnings }: { warnings: readonly string[] }) {
  const [dismissed, setDismissed] = useState<readonly string[] | null>(null);
  if (!warnings.length || dismissed === warnings) return null;
  return (
    <div
      role="alert"
      data-testid="restore-warnings"
      className="flex items-start gap-2 rounded border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-foreground"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">Some saved edits couldn&apos;t be fully restored</div>
        <ul className="space-y-0.5">
          {warnings.map((w, i) => (
            <li key={i} data-testid="restore-warning">
              {w}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        data-testid="restore-warnings-dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(warnings)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
