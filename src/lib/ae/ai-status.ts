// Presentation helpers for the engine's AI step status (worker/ai_status.py).
import type { AiTaskStatus, AnalysisOutcome, ProjectBrain } from "./types";

const TASK_LABELS: Record<string, string> = {
  transcription: "Transcription",
  "visual-analysis": "Visual analysis",
  selects: "Select ranking",
  stories: "Story generation",
};

export function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? task;
}

export interface AiIssueGroup {
  /** "Transcription couldn't connect to OpenAI" */
  text: string;
  /** Clips affected (0 for project-level steps such as select ranking). */
  clips: number;
  retryable: boolean;
}

/** Collapses per-clip failures that share task + message into one line. */
export function groupAiIssues(issues: AiTaskStatus[]): AiIssueGroup[] {
  const groups = new Map<string, AiIssueGroup>();
  for (const issue of issues) {
    const text = `${taskLabel(issue.task)} ${issue.message ?? "failed"}`;
    const group = groups.get(text) ?? { text, clips: 0, retryable: issue.retryable === true };
    if (issue.clipId) group.clips += 1;
    groups.set(text, group);
  }
  return [...groups.values()];
}

/** True when a completed analysis has AI steps worth (re)trying. */
export function canRetryAi(project: ProjectBrain | null): boolean {
  return (
    project?.analysisState === "complete" &&
    (project.analysisOutcome === "partial" || project.analysisOutcome === "failed") &&
    (project.aiIssues?.length ?? 0) > 0
  );
}

export function outcomeHeading(outcome: AnalysisOutcome | null | undefined): string | null {
  if (outcome === "failed") return "AI analysis failed";
  if (outcome === "partial") return "AI analysis incomplete";
  return null;
}
