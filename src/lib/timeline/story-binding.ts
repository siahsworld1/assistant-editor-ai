// Phase 6, Milestone 4 — the trust boundary for a story plan from the AI
// Director (POST /propose/story).
//
// Everything in the reply is untrusted model output. What the plan applies to
// — its schema, instruction and base (version + revision) — comes from what
// the app itself sent, never from the reply; a reply claiming any other base
// is refused, and one that arrives after the project, version or cut changed
// is refused as stale. Everything else (order, removals, cutaway decisions,
// rationale — and any field the model added) is kept exactly as received for
// compileStoryPlan, the single judge of ids, evidence, cutaways and
// protection. Nothing here edits anything.
import { MAX_REPLY_CHARS, type DirectorBinding } from "./ai-context";
import { STORY_PLAN_SCHEMA } from "./story-plan";

export type BoundStoryPlan =
  { ok: true; plan: Record<string, unknown> } | { ok: false; reason: string };

export function bindStoryPlan(
  reply: unknown,
  sent: { instruction: string; binding: DirectorBinding },
  live: DirectorBinding | null,
): BoundStoryPlan {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply))
    return { ok: false, reason: "The Director's reply was not a usable story plan." };
  let size = Infinity;
  try {
    size = JSON.stringify(reply).length;
  } catch {
    /* unserializable — refused below */
  }
  if (size > MAX_REPLY_CHARS)
    return { ok: false, reason: "The Director's reply was too large to be a story plan." };
  const r = reply as Record<string, unknown>;
  const base = r["base"] as Record<string, unknown> | null | undefined;
  if (
    !base ||
    typeof base !== "object" ||
    Object.keys(base).length !== 2 ||
    base["versionId"] !== sent.binding.versionId ||
    base["revision"] !== sent.binding.revision
  )
    return {
      ok: false,
      reason: "The reply claimed a different version of the cut than the one it was asked about.",
    };
  if (
    !live ||
    live.projectId !== sent.binding.projectId ||
    live.versionId !== sent.binding.versionId ||
    live.revision !== sent.binding.revision
  )
    return {
      ok: false,
      reason:
        "The cut changed while the Director was working, so its plan no longer applies. Ask again to use the current cut.",
    };
  return {
    ok: true,
    plan: {
      ...r,
      schema: STORY_PLAN_SCHEMA,
      instruction: sent.instruction,
      base: { versionId: sent.binding.versionId, revision: sent.binding.revision },
    },
  };
}
