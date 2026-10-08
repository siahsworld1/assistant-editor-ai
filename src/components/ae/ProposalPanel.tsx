// The Director proposal under review in CUT: what it is, what it would do,
// whether it may (and why not), Original / Proposed comparison, Accept and
// Reject. The proposal itself lives in useProposalPreview (memory only).
//
// Proposals come from a typed instruction, interpreted deterministically
// (src/lib/timeline/instructions.ts — no AI provider), or from the clearly
// labeled developer demonstration (development builds only).
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  FlaskConical,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type { DirectorProposalResult } from "@/lib/ae/service";
import { describeOperation, type ProposalPreview } from "@/lib/ae/proposal-preview";
import type { EditorApi } from "@/lib/ae/store";
import { DEMO_KINDS, demoProposal } from "@/lib/timeline/demo-proposals";
import { EXAMPLES, interpretInstruction } from "@/lib/timeline/instructions";
import type { EditProposal, ProposalIssue, ProposalIssueCode } from "@/lib/timeline/proposals";
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

/** Why a proposal can't go ahead, in the filmmaker's terms. */
function plainReason(issue: ProposalIssue): string {
  switch (issue.code) {
    case "protected":
      return "That clip is protected from AI editing (locked or AI-protected).";
    case "manual-conflict":
      return "That clip was edited by hand — the Director never changes your edits.";
    case "ownership-unknown":
      return "That clip's edit history can't be verified, so the Director leaves it alone.";
    case "stale":
      return "The cut changed after this proposal was made — propose it again.";
    case "engine-rejected":
      if (issue.engineCode === "ripple-blocked")
        return "Closing this gap would affect overlapping footage on another track.";
      if (issue.engineCode === "overlap")
        return "That would overlap another clip on the same track.";
      if (issue.engineCode === "reorder-blocked")
        return `${issue.message.replace(/ Nothing was changed\.$/, "")} The Director never removes or repositions that footage itself — nothing was changed.`;
      return issue.message;
    case "invalid-range":
      return `That edit isn't possible: ${issue.message}`;
    default:
      return issue.message;
  }
}

export function ProposalPanel({
  editor,
  preview,
  selection = [],
  askDirector,
  onBeforeChange,
  demo,
}: {
  editor: EditorApi;
  preview: ProposalPreview;
  /** The clips selected in the timeline ("this clip" in an instruction). */
  selection?: readonly string[];
  /** Called before accept / mode changes (pauses playback). */
  onBeforeChange?: () => void;
  /** Show the developer demonstration (development builds only). */
  demo: boolean;
  /** The AI Director, for instructions the precise interpreter doesn't
   * cover. Absent: such instructions are refused as before. */
  askDirector?: (
    instruction: string,
    selection: readonly string[],
  ) => Promise<DirectorProposalResult>;
}) {
  const { review, pending, notice, interpretation } = preview;
  const proposal: EditProposal | null = review?.proposal ?? null;
  const ok = !!review?.ok;
  const stale = !!review && !review.ok && review.issues.some((i) => i.code === "stale");
  const [text, setText] = useState("");

  // The AI Director's progress for the last instruction it was asked.
  const [ai, setAi] = useState<AiState | null>(null);
  const request = useRef(0);
  // A reply that arrives after the panel is gone (another project, another
  // page) is dropped.
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const ask = async (instruction: string) => {
    if (!askDirector) return;
    const mine = ++request.current;
    preview.clear(); // nothing pending while the Director works
    setAi({ state: "generating", instruction });
    const res = await askDirector(instruction, selection);
    if (mine !== request.current) return; // superseded
    switch (res.status) {
      case "proposal":
        preview.propose(res.proposal);
        setAi({ state: "ready", instruction });
        break;
      case "refused":
        setAi({ state: "unsupported", instruction, message: res.reason });
        break;
      case "failed":
        setAi({
          state: "provider-failure",
          instruction,
          message: res.message,
          retryable: res.retryable,
        });
        break;
      case "invalid":
        setAi({ state: "invalid", instruction, message: res.reason });
        break;
    }
  };

  const submit = () => {
    if (!text.trim() || ai?.state === "generating") return;
    onBeforeChange?.();
    // Precise commands first (deterministic, Phase 4). Only wording it doesn't
    // recognise goes to the AI Director — a precise command it understood but
    // had to refuse (no selection, impossible trim…) is NOT re-tried by AI.
    const r = interpretInstruction(text, editor.proposalContext(), selection);
    if (r.ok) {
      setAi(null);
      preview.propose(r.proposal, r.interpretation);
    } else if (r.code === "unrecognized" && askDirector && text.trim()) {
      void ask(text.trim());
    } else {
      setAi(null);
      preview.inform(r.reason);
    }
  };
  const generating = ai?.state === "generating";

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

      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          data-testid="instruction-input"
          aria-label="Director instruction"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Tell the Director… e.g. "${EXAMPLES[0]}"`}
          disabled={pending !== null || generating}
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface px-2.5 text-xs placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          data-testid="instruction-submit"
          disabled={pending !== null || generating || !text.trim()}
          className="inline-flex h-8 items-center gap-1 rounded border border-border px-2.5 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
        >
          <Send className="size-3.5" /> Propose
        </button>
      </form>

      {ai && (
        <AiStatus
          ai={ai}
          pending={pending !== null}
          reviewOk={ok}
          onRetry={() => void ask(ai.instruction)}
        />
      )}

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
              {interpretation && (
                <dl
                  className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
                  data-testid="instruction-interpretation"
                >
                  <dt className="text-muted-foreground">Understood</dt>
                  <dd data-testid="interpretation-action">{interpretation.action}</dd>
                  <dt className="text-muted-foreground">Clip</dt>
                  <dd data-testid="interpretation-clips">{interpretation.clips.join(", ")}</dd>
                  {interpretation.expected && (
                    <>
                      <dt className="text-muted-foreground">Expected</dt>
                      <dd data-testid="interpretation-expected">{interpretation.expected}</dd>
                    </>
                  )}
                  {interpretation.limitations.map((l, i) => (
                    <dd
                      key={i}
                      className="col-start-2 text-muted-foreground"
                      data-testid="interpretation-note"
                    >
                      Note: {l}
                    </dd>
                  ))}
                </dl>
              )}
              <ol
                className="mt-2 list-decimal space-y-0.5 pl-5 text-xs"
                data-testid="proposal-operations"
              >
                {proposal.operations.map((op, i) => (
                  <li key={i}>
                    {describeOperation(op, editor.sequence)}
                    {op.op === "reorder" && (
                      <ReorderDetail order={op.itemIds} seq={editor.sequence} />
                    )}
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
                    <span className="font-medium">{ISSUE_TITLE[issue.code]}:</span>{" "}
                    {plainReason(issue)}
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

/** Original vs proposed order of a reorder, by clip name. */
function ReorderDetail({ order, seq }: { order: string[]; seq: EditorApi["sequence"] }) {
  const name = (id: string) => seq?.items[id]?.label ?? id;
  const original = [...order].sort(
    (a, b) => (seq?.items[a]?.startFrame ?? 0) - (seq?.items[b]?.startFrame ?? 0),
  );
  const list = (ids: string[], testId: string, title: string) => (
    <div className="min-w-0 flex-1">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</span>
      <ol className="list-decimal pl-4 text-[11px]" data-testid={testId}>
        {ids.map((id) => (
          <li
            key={id}
            data-item-id={id}
            data-moved={
              title === "Proposed" && original.indexOf(id) !== order.indexOf(id)
                ? "true"
                : undefined
            }
            className={cn(
              title === "Proposed" && original.indexOf(id) !== order.indexOf(id) && "text-primary",
            )}
          >
            {name(id)}
          </li>
        ))}
      </ol>
    </div>
  );
  return (
    <div className="mt-1 flex gap-4" data-testid="reorder-detail">
      {list(original, "reorder-original", "Original")}
      {list(order, "reorder-proposed", "Proposed")}
    </div>
  );
}

type AiState =
  | { state: "generating" | "ready"; instruction: string }
  | { state: "unsupported" | "invalid"; instruction: string; message: string }
  | { state: "provider-failure"; instruction: string; message: string; retryable: boolean };

/** Where the AI Director is with the last instruction. A proposal it returns
 * is still only a proposal: "ready" means it passed validation and can be
 * previewed; otherwise it is reported as a validation failure. */
function AiStatus({
  ai,
  pending,
  reviewOk,
  onRetry,
}: {
  ai: AiState;
  pending: boolean;
  reviewOk: boolean;
  onRetry: () => void;
}) {
  if (ai.state === "ready" && !pending) return null; // accepted or rejected since
  const state =
    ai.state === "ready" && !reviewOk
      ? "validation-failure"
      : ai.state === "invalid"
        ? "validation-failure"
        : ai.state;
  const retry =
    state === "provider-failure"
      ? (ai as { retryable: boolean }).retryable
      : state === "validation-failure" && ai.state === "invalid";
  const text =
    state === "generating"
      ? "Generating a proposal — the AI Director is reading the current cut…"
      : state === "ready"
        ? "AI proposal ready — preview it below, then accept or reject it."
        : state === "unsupported"
          ? `Unsupported instruction: ${(ai as { message: string }).message}`
          : state === "provider-failure"
            ? `AI provider failure — ${(ai as { message: string }).message}. Nothing was changed.`
            : ai.state === "invalid"
              ? `Validation failure: ${ai.message} Nothing was changed.`
              : "Validation failure: the AI proposal breaks the timeline's rules (see below). Nothing was changed.";
  return (
    <div
      data-testid="ai-status"
      data-state={state}
      className={cn(
        "mt-2 flex items-start gap-1.5 text-xs",
        state === "ready" || state === "generating" ? "text-muted-foreground" : "text-destructive",
      )}
    >
      {state === "generating" ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
      ) : state === "ready" ? (
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
      ) : (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {retry && (
        <button
          type="button"
          data-testid="ai-retry"
          onClick={onRetry}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        >
          <RotateCcw className="size-3" /> Retry
        </button>
      )}
    </div>
  );
}
