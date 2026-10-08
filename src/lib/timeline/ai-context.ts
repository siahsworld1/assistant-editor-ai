// Director AI 2.0, Phase 5 — what the AI Director is told about the cut.
//
// A compact, structured description of the CURRENT sequence (the active
// version's own Sequence — an edited working version if that is what is on
// screen, never an earlier Director assembly): its rate and length, every
// clip with stable id, track, name, source reference, timeline position,
// source range, link group, ownership and protection, the filmmaker's
// selection, and the analysis evidence the AI may cite by id. No media, no
// frames, no paths beyond file names; transcript limited to the clips and
// source ranges actually on the timeline.
//
// The AI's answer is bound to `revision`, so a proposal made against this
// description is refused as stale if the cut changes before it is accepted.
import type { Clip, Select, TranscriptSegment, VisualEvidence } from "@/lib/ae/types";
import { tcToSeconds } from "@/lib/nle/timecode";
import { ownershipOf, PROPOSAL_SCHEMA, sequenceRevision, type ProposalContext } from "./proposals";
import { endFrame, sequenceEndFrame } from "./selectors";
import { fpsOf, frameToTc, tcClockSeconds } from "./time";
import { sequenceOf } from "./workspace";

export const CONTEXT_SCHEMA = "ae.context/1" as const;

/** Evidence limits — enough to reason with, small enough to send cheaply. */
const MAX_TRANSCRIPT = 150;
const MAX_VISUAL = 120;
const MAX_TEXT = 200;
/** Transcript around a clip's used range, in seconds either side. */
const TRANSCRIPT_MARGIN_S = 10;

export interface SequenceContext {
  schema: typeof CONTEXT_SCHEMA;
  versionId: string;
  revision: string;
  fps: number;
  durationFrames: number;
  targetFrames: number;
  tracks: Array<{ name: string; kind: string; locked: boolean; aiLocked: boolean }>;
  clips: Array<{
    id: string;
    track: string;
    label: string;
    file: string | null;
    mediaClipId: string;
    mediaFps: number;
    start: number;
    end: number;
    sourceIn: number;
    sourceOut: number;
    sourceInTc: string;
    sourceOutTc: string;
    link: string | null;
    owner: "director" | "manual" | "unknown";
    locked: boolean;
    aiLocked: boolean;
    selectId: string | null;
  }>;
  selection: string[];
  evidence: {
    selects: Array<{
      id: string;
      clipId: string;
      startTc: string;
      endTc: string;
      score: number;
      category: string;
      excerpt: string;
    }>;
    transcript: Array<{ id: string; clipId: string; startTc: string; endTc: string; text: string }>;
    visual: Array<{ id: string; clipId: string; atTc: string; kind: string; label: string }>;
  };
}

export interface AnalysisEvidence {
  selects: ReadonlyArray<Select>;
  transcript: ReadonlyArray<TranscriptSegment>;
  visualEvidence: ReadonlyArray<VisualEvidence>;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** null when there is no sequence on screen. */
export function buildSequenceContext(
  ctx: ProposalContext,
  selection: readonly string[],
  evidence: AnalysisEvidence,
  clips: ReadonlyArray<Pick<Clip, "id" | "fps" | "filename">>,
): SequenceContext | null {
  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq) return null;
  const owner = ownershipOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  const trackById = new Map(seq.tracks.map((t) => [t.id, t]));
  const fileOf = new Map(clips.map((c) => [c.id, c.filename]));
  const items = Object.values(seq.items).sort(
    (a, b) =>
      (trackById.get(a.trackId)?.name ?? "").localeCompare(trackById.get(b.trackId)?.name ?? "") ||
      a.startFrame - b.startFrame ||
      (a.id < b.id ? -1 : 1),
  );

  // Source ranges in use, per media clip (seconds on its own clock).
  const used = new Map<string, Array<[number, number]>>();
  for (const it of items) {
    const list = used.get(it.mediaClipId) ?? [];
    list.push([
      tcClockSeconds(it.sourceInFrame, it.mediaRate) - TRANSCRIPT_MARGIN_S,
      tcClockSeconds(it.sourceOutFrame, it.mediaRate) + TRANSCRIPT_MARGIN_S,
    ]);
    used.set(it.mediaClipId, list);
  }
  const fpsOfClip = new Map(clips.map((c) => [c.id, c.fps || 24]));
  const transcript = evidence.transcript
    .filter((t) => {
      const ranges = used.get(t.clipId);
      if (!ranges) return false;
      const fps = fpsOfClip.get(t.clipId) ?? 24;
      const a = tcToSeconds(t.startTc, fps);
      const b = tcToSeconds(t.endTc, fps);
      return a !== null && b !== null && ranges.some(([x, y]) => b > x && a < y);
    })
    .slice(0, MAX_TRANSCRIPT)
    .map((t) => ({
      id: t.id,
      clipId: t.clipId,
      startTc: t.startTc,
      endTc: t.endTc,
      text: clip(t.text),
    }));

  return {
    schema: CONTEXT_SCHEMA,
    versionId: ctx.activeVersionId,
    revision: sequenceRevision(seq),
    fps: fpsOf(seq.rate),
    durationFrames: sequenceEndFrame(seq),
    targetFrames: seq.targetFrames,
    tracks: [...seq.tracks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        kind: t.kind,
        locked: t.protection.locked,
        aiLocked: t.protection.aiLocked,
      })),
    clips: items.map((it) => {
      const track = trackById.get(it.trackId);
      return {
        id: it.id,
        track: track?.name ?? "?",
        label: clip(it.label),
        file: fileOf.get(it.mediaClipId) ?? null,
        mediaClipId: it.mediaClipId,
        mediaFps: fpsOf(it.mediaRate),
        start: it.startFrame,
        end: endFrame(it),
        sourceIn: it.sourceInFrame,
        sourceOut: it.sourceOutFrame,
        sourceInTc: frameToTc(it.sourceInFrame, it.mediaRate),
        sourceOutTc: frameToTc(it.sourceOutFrame, it.mediaRate),
        link: it.linkGroupId ?? null,
        owner: owner(it.id),
        locked: it.protection.locked || !!track?.protection.locked,
        aiLocked: it.protection.aiLocked || !!track?.protection.aiLocked,
        selectId: it.selectId ?? null,
      };
    }),
    selection: selection.filter((id) => seq.items[id]),
    evidence: {
      selects: evidence.selects.map((s) => ({
        id: s.id,
        clipId: s.clipId,
        startTc: s.startTc,
        endTc: s.endTc,
        score: s.score,
        category: s.category,
        excerpt: clip(s.transcriptExcerpt),
      })),
      transcript,
      visual: evidence.visualEvidence.slice(0, MAX_VISUAL).map((v) => ({
        id: v.id,
        clipId: v.clipId,
        atTc: v.atTc,
        kind: v.kind,
        label: clip(v.label),
      })),
    },
  };
}

/** The largest Director reply the app will consider (the proposal engine also
 * bounds every operation, text and list inside it). */
export const MAX_REPLY_CHARS = 64_000;

/** Exactly which cut a request described: the project, version and revision. */
export interface DirectorBinding {
  projectId: string | null;
  versionId: string;
  revision: string;
}

export type BoundProposal =
  { ok: true; proposal: Record<string, unknown> } | { ok: false; reason: string };

/**
 * The trust boundary for an AI Director reply. Everything in it is untrusted
 * model output. The envelope that says WHAT the proposal applies to — schema,
 * instruction and base (version + revision) — comes from what the app itself
 * sent, never from the reply; a reply claiming any other base is refused, and
 * a reply that arrives after the project, version or cut has changed is
 * refused as stale before anything is previewed. Only summary, operations and
 * rationale are taken from the reply; any other field it carries (an attempt
 * to authorize itself, say) is kept so the proposal engine refuses it rather
 * than having it silently dropped.
 */
export function bindDirectorProposal(
  reply: unknown,
  sent: { instruction: string; binding: DirectorBinding },
  live: DirectorBinding | null,
): BoundProposal {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply))
    return { ok: false, reason: "The Director's reply was not a usable proposal." };
  let size = Infinity;
  try {
    size = JSON.stringify(reply).length;
  } catch {
    /* unserializable — refused below */
  }
  if (size > MAX_REPLY_CHARS)
    return { ok: false, reason: "The Director's reply was too large to be a proposal." };
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
        "The cut changed while the Director was working, so its answer no longer applies. Ask again to use the current cut.",
    };
  const id =
    typeof r["id"] === "string" && /^prp_ai_[0-9a-f]{24}$/.test(r["id"])
      ? r["id"]
      : "prp_ai_unidentified";
  return {
    ok: true,
    proposal: {
      ...r,
      schema: PROPOSAL_SCHEMA,
      id,
      instruction: sent.instruction,
      base: { versionId: sent.binding.versionId, revision: sent.binding.revision },
    },
  };
}
