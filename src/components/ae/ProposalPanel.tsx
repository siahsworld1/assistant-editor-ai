// The Director proposal under review in CUT: what it is, what it would do,
// whether it may (and why not), Original / Proposed comparison, Accept and
// Reject. The proposal itself lives in useProposalPreview (memory only).
//
// Phase 3 has no natural-language Director yet: proposals come only from the
// clearly labeled developer demonstration (src/lib/timeline/demo-proposals.ts),
// shown in development builds only.
import { AlertTriangle, Check, Eye, FlaskConical, X } from "lucide-react";
import { describeOperation, type ProposalPreview } from "@/lib/ae/proposal-preview";
import type { EditorApi } from "@/lib/ae/store";
import { DEMO_KINDS, demoProposal } from "@/lib/timeline/demo-proposals";
import type { EditProposal, ProposalIssueCode } from "@/lib/timeline/proposals";
import { cn } from "@/lib/utils";

const ISSUE_TITLE: Record<ProposalIssueCode, string> = {
  malformed: "Not a valid proposal",
  "unsupported-operation": "Unsupported change",
  "self-authorization": "Tried to authorize itself",
  stale: "Out of date",
  "unknown-version": "Wrong version",
  "unknown-item": "Unknown clip",
  "invalid-range": "Impossible edit",
  "unverifiable-evidence": "Unverifiable evidence",
  protected: "Protected material",
  "manual-conflict": "Your hand edits",
  "ownership-unknown": "Unverified material",
  "engine-rejected": "Not allowed by the timeline rules",
};

export function ProposalPanel({
  editor,
  preview,
  onBeforeChange,
  demo,
}: {
  editor: EditorApi;
  preview: ProposalPreview;
  /** Called before accept / mode changes (pauses playback). */
  onBeforeChange?: () => void;
  /** Show the developer demonstration (development builds only). */
  demo: boolean;
}) {
  const { review, pending, notice } = preview;
  const proposal: EditProposal | null = review?.proposal ?? null;
  const ok = !!review?.ok;
  const stale = !!review && !review.ok && review.issues.some((i) => i.code === "stale");

  if (!pending && !notice && !demo) return null;

  return (
    <div className="panel p-4" data-testid="proposal-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Director proposal
        </div>
        {demo && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="proposal-demo">
            <span
              className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 font-tc text-[10px] text-muted-foreground"
              title="Deterministic demonstration for development — no AI provider is called."
            >
              <FlaskConical className="size-3" /> DEV DEMO · no AI
            </span>
            {DEMO_KINDS.map(({ kind, label }) => (
              <button
                key={kind}
                type="button"
                data-testid={`demo-${kind}`}
                className="h-6 rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                onClick={() => {
                  onBeforeChange?.();
                  const r = demoProposal(kind, editor.proposalContext());
                  if (r.ok) preview.propose(r.proposal);
                  else preview.inform(r.reason);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {notice && !pending && (
        <p
          data-testid="proposal-notice"
          data-kind={notice.kind}
          className={cn(
            "mt-2 text-xs",
            notice.kind === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {notice.message}
        </p>
      )}

      {pending !== null && review && (
        <div
          className="mt-3 space-y-3"
          data-testid="proposal-review"
          data-valid={ok ? "true" : "false"}
        >
          {proposal && (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium" data-testid="proposal-instruction">
                  {proposal.instruction}
                </span>
                <span
                  data-testid="proposal-status"
                  className={cn(
                    "rounded px-1.5 py-0.5 font-tc text-[10px]",
                    ok
                      ? "bg-primary/15 text-primary"
                      : stale
                        ? "bg-warning/15 text-warning"
                        : "bg-destructive/15 text-destructive",
                  )}
                >
                  {ok ? "Ready to review" : stale ? "Out of date" : "Refused"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="proposal-summary">
                {proposal.summary}
              </p>
              <ol
                className="mt-2 list-decimal space-y-0.5 pl-5 text-xs"
                data-testid="proposal-operations"
              >
                {proposal.operations.map((op, i) => (
                  <li key={i}>
                    {describeOperation(op, editor.sequence)}
                    {proposal.rationale
                      ?.filter((r) => r.opIndex === i)
                      .map((r, j) => (
                        <span key={j} className="block text-[11px] text-muted-foreground">
                          Why: {r.reason}
                        </span>
                      ))}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!proposal && (
            <p className="text-xs text-muted-foreground">This proposal could not be read.</p>
          )}

          {!ok && (
            <ul className="space-y-1" data-testid="proposal-issues">
              {(review.ok ? [] : review.issues).map((issue, i) => (
                <li
                  key={i}
                  className="flex gap-1.5 text-xs text-destructive"
                  data-code={issue.code}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-medium">{ISSUE_TITLE[issue.code]}:</span> {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-border" role="group">
              {(["before", "after"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`compare-${m}`}
                  aria-pressed={preview.mode === m}
                  disabled={!ok}
                  onClick={() => {
                    onBeforeChange?.();
                    preview.setMode(m);
                  }}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 px-2.5 text-[11px] disabled:opacity-40",
                    preview.mode === m && ok
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  <Eye className="size-3.5" /> {m === "before" ? "Original" : "Proposed"}
                </button>
              ))}
            </div>
            <span className="ml-auto" />
            <button
              type="button"
              data-testid="proposal-reject"
              onClick={() => preview.reject()}
              className="inline-flex h-7 items-center gap-1 rounded border border-border px-2.5 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <X className="size-3.5" /> Reject
            </button>
            <button
              type="button"
              data-testid="proposal-accept"
              disabled={!ok}
              onClick={() => {
                onBeforeChange?.();
                preview.accept();
              }}
              className="inline-flex h-7 items-center gap-1 rounded border border-primary/60 bg-primary/10 px-2.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-40"
            >
              <Check className="size-3.5" /> Accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
