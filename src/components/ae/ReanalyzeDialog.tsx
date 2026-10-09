// Asked before "Analyze Footage" replaces a completed analysis: the saved
// selects, stories and cuts depend on it (cuts only open against the analysis
// they were made from). Tied to one project and that analysis's id; Cancel is
// the default. The engine keeps the replaced analysis as a backup, and never
// lets an incomplete analysis (no transcript or visual evidence — e.g. no AI
// provider set up) replace it unless the filmmaker allows that here.
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ExistingAnalysis } from "@/lib/ae/normalize";

export interface ReanalyzeRequest {
  projectId: string;
  projectName: string;
  existing: ExistingAnalysis;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReanalyzeDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ReanalyzeRequest | null;
  onCancel: () => void;
  onConfirm: (allowIncomplete: boolean) => void;
}) {
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  // A new question always starts from the safe choice.
  useEffect(() => setAllowIncomplete(false), [request]);
  const e = request?.existing;
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="reanalyze-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Re-analyze this footage?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {e && (
                <p data-testid="reanalyze-existing">
                  “{request.projectName}” already has a completed analysis (
                  <span className="font-tc">{e.analysisId.slice(0, 8)}</span>):{" "}
                  {plural(e.clips, "clip")}, {plural(e.transcript, "transcript line")},{" "}
                  {plural(e.visualEvidence, "visual moment")}, {plural(e.selects, "select")} and{" "}
                  {plural(e.stories, "story", "stories")}.
                </p>
              )}
              <p>
                Re-analyzing creates a new analysis. Its selects and stories replace these, and the
                cuts saved from this analysis won&apos;t open with the new one — they stay on disk,
                nothing is deleted. The current analysis is kept as a backup beside the footage.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="reanalyze-allow-incomplete"
            className="mt-0.5"
            checked={allowIncomplete}
            onChange={(ev) => setAllowIncomplete(ev.target.checked)}
          />
          <span>
            Replace it even if transcription or visual analysis can&apos;t run (for example, no AI
            provider is set up). Without this, a new analysis with less transcript or visual
            evidence never replaces the current one.
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="reanalyze-cancel" autoFocus onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="reanalyze-confirm"
            onClick={() => onConfirm(allowIncomplete)}
          >
            Re-analyze
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
