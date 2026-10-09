// Phase 6, Milestone 3 — what a story-level Director is told about the cut.
//
// A structured description of the CURRENT sequence (the active version's own
// Sequence: an edited working version if that is on screen) for restructuring
// interview clips: the interview clips on V1 in timeline order — each with its
// id, source range, linked audio, ownership and protection, its select and the
// transcript lines that fall in it (and whether a line runs past the clip's in
// or out point) — the cutaways over them and how they overlap the interview
// edit points, and the chosen story's beats. Existing analysis only: nothing
// is re-transcribed, and no paths beyond file names are included.
//
// Transcript lines map to a clip on the clip's own media clock: a line's
// timecodes are converted with tcToFrame at the item's media rate — the same
// conversion the importer used for the item's source in/out — so the mapping
// is exact at 23.976, 24, 25, 29.97 and 30 fps.
import type { Clip, Select, StoryCandidate, TranscriptSegment } from "@/lib/ae/types";
import { ownershipOf, sequenceRevision, type ProposalContext } from "./proposals";
import { endFrame, isProtectedFrom, itemsOnTrack, sequenceEndFrame } from "./selectors";
import { fpsOf, frameToTc, tcToFrame } from "./time";
import type { ClipItem, Sequence } from "./types";
import { sequenceOf } from "./workspace";

export const STORY_CONTEXT_SCHEMA = "ae.story-context/1" as const;

/** Below this, a transcript line is shown but flagged as unreliable evidence. */
export const LOW_CONFIDENCE = 0.5;
const MAX_TEXT = 200;
const MAX_LINES_PER_CLIP = 60;

/** Where a transcript line sits relative to a clip's source range. */
export type LinePlacement =
  | "inside" // wholly within the clip
  | "crosses-in" // starts before the clip's in point
  | "crosses-out" // ends after the clip's out point
  | "spans"; // runs past both

export interface StoryLine {
  id: string;
  startTc: string;
  endTc: string;
  text: string;
  placement: LinePlacement;
  confidence: number;
  /** Below LOW_CONFIDENCE: not reliable evidence on its own. */
  lowConfidence: boolean;
  /** Ends with "?" — likely an interviewer's question. */
  question: boolean;
}

export interface StoryClip {
  id: string;
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
  /** Items linked to this one (its sync audio), by id. */
  linked: string[];
  owner: "director" | "manual" | "unknown";
  locked: boolean;
  aiLocked: boolean;
  /** May the Director change it at all (ownership + locks, incl. linked items)? */
  directorMayChange: boolean;
  select: { id: string; score: number; category: string } | null;
  /** Beats of the chosen story that use this clip's select. */
  beatIds: string[];
  lines: StoryLine[];
  /** Ends exactly where the next interview clip starts. */
  backToBackWithNext: boolean;
}

export interface StoryCutaway {
  id: string;
  track: string;
  label: string;
  file: string | null;
  start: number;
  end: number;
  owner: "director" | "manual" | "unknown";
  locked: boolean;
  aiLocked: boolean;
  /** Interview clips it overlaps. */
  over: string[];
  /** The one interview clip it lies wholly inside (it moves with that clip). */
  insideClipId: string | null;
  /** Runs across an interview edit point (a reorder can't carry it). */
  crossesCut: boolean;
}

export interface StoryContext {
  schema: typeof STORY_CONTEXT_SCHEMA;
  versionId: string;
  revision: string;
  fps: number;
  durationFrames: number;
  interview: StoryClip[];
  cutaways: StoryCutaway[];
  story: {
    id: string;
    title: string;
    beats: Array<{
      id: string;
      label: string;
      intent: string;
      selectIds: string[];
      clipIds: string[];
    }>;
  } | null;
  /** Selects the analysis offers, whether or not they are on the timeline. */
  selects: Array<{
    id: string;
    clipId: string;
    startTc: string;
    endTc: string;
    score: number;
    category: string;
  }>;
  /** Facts about the analysis the plan must not assume away. */
  caveats: string[];
}

export interface StoryAnalysis {
  selects: ReadonlyArray<Select>;
  transcript: ReadonlyArray<TranscriptSegment>;
  stories: ReadonlyArray<StoryCandidate>;
  chosenStoryId: string | null;
}

const excerpt = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** The interview (dialogue) video track: V1 by role, else by name. */
export function interviewTrackId(seq: Sequence): string | null {
  const byRole = seq.tracks.find((t) => t.kind === "video" && t.role === "dialogue");
  return (byRole ?? seq.tracks.find((t) => t.name === "V1"))?.id ?? null;
}

/** Transcript lines of this clip's media that fall in its source range. */
export function linesOf(
  item: ClipItem,
  transcript: ReadonlyArray<TranscriptSegment>,
): Array<TranscriptSegment & { placement: LinePlacement }> {
  const out: Array<TranscriptSegment & { placement: LinePlacement }> = [];
  for (const t of transcript) {
    if (t.clipId !== item.mediaClipId) continue;
    const a = tcToFrame(t.startTc, item.mediaRate);
    const b = tcToFrame(t.endTc, item.mediaRate);
    if (a === null || b === null || b <= a) continue;
    if (b <= item.sourceInFrame || a >= item.sourceOutFrame) continue;
    const before = a < item.sourceInFrame;
    const after = b > item.sourceOutFrame;
    out.push({
      ...t,
      placement:
        before && after ? "spans" : before ? "crosses-in" : after ? "crosses-out" : "inside",
    });
  }
  return out.sort(
    (x, y) => tcToFrame(x.startTc, item.mediaRate)! - tcToFrame(y.startTc, item.mediaRate)!,
  );
}

/** null when there is no sequence on screen. */
export function buildStoryContext(
  ctx: ProposalContext,
  analysis: StoryAnalysis,
  clips: ReadonlyArray<Pick<Clip, "id" | "filename">>,
): StoryContext | null {
  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq) return null;
  const owner = ownershipOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  const fileOf = new Map(clips.map((c) => [c.id, c.filename]));
  const trackOf = new Map(seq.tracks.map((t) => [t.id, t]));
  const v1 = interviewTrackId(seq);
  const interviewItems = v1 ? itemsOnTrack(seq, v1) : [];
  const selectById = new Map(analysis.selects.map((s) => [s.id, s]));
  const story = analysis.stories.find((s) => s.id === analysis.chosenStoryId) ?? null;

  const locks = (it: ClipItem) => {
    const t = trackOf.get(it.trackId);
    return {
      locked: it.protection.locked || !!t?.protection.locked,
      aiLocked: it.protection.aiLocked || !!t?.protection.aiLocked,
    };
  };
  const linkedOf = (it: ClipItem) =>
    it.linkGroupId ? (seq.links[it.linkGroupId]?.itemIds ?? []).filter((id) => id !== it.id) : [];
  const linkedSet = new Set(interviewItems.flatMap((it) => [it.id, ...linkedOf(it)]));

  const interview: StoryClip[] = interviewItems.map((it, n) => {
    const sel = it.selectId ? selectById.get(it.selectId) : undefined;
    const group = [
      it,
      ...linkedOf(it)
        .map((id) => seq.items[id]!)
        .filter(Boolean),
    ];
    const lines = linesOf(it, analysis.transcript)
      .slice(0, MAX_LINES_PER_CLIP)
      .map((t) => ({
        id: t.id,
        startTc: t.startTc,
        endTc: t.endTc,
        text: excerpt(t.text),
        placement: t.placement,
        confidence: t.confidence,
        lowConfidence: !(t.confidence >= LOW_CONFIDENCE),
        question: t.text.trim().endsWith("?"),
      }));
    return {
      id: it.id,
      label: excerpt(it.label),
      file: fileOf.get(it.mediaClipId) ?? null,
      mediaClipId: it.mediaClipId,
      mediaFps: fpsOf(it.mediaRate),
      start: it.startFrame,
      end: endFrame(it),
      sourceIn: it.sourceInFrame,
      sourceOut: it.sourceOutFrame,
      sourceInTc: frameToTc(it.sourceInFrame, it.mediaRate),
      sourceOutTc: frameToTc(it.sourceOutFrame, it.mediaRate),
      linked: linkedOf(it),
      owner: owner(it.id),
      ...locks(it),
      directorMayChange: group.every((g) => !isProtectedFrom(seq, g, "director")),
      select: sel ? { id: sel.id, score: sel.score, category: sel.category } : null,
      beatIds: story
        ? story.beats
            .filter((b) => it.selectId && b.selectIds.includes(it.selectId))
            .map((b) => b.id)
        : [],
      lines,
      backToBackWithNext:
        n + 1 < interviewItems.length && endFrame(it) === interviewItems[n + 1]!.startFrame,
    };
  });

  const cuts = interviewItems.slice(1).map((it) => it.startFrame);
  const cutaways: StoryCutaway[] = Object.values(seq.items)
    .filter((it) => it.trackId !== v1 && !linkedSet.has(it.id))
    .filter((it) => trackOf.get(it.trackId)?.kind === "video")
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1))
    .map((it) => {
      const over = interviewItems.filter(
        (c) => it.startFrame < endFrame(c) && endFrame(it) > c.startFrame,
      );
      const host =
        over.length === 1 &&
        over[0]!.startFrame <= it.startFrame &&
        endFrame(it) <= endFrame(over[0]!)
          ? over[0]!.id
          : null;
      return {
        id: it.id,
        track: trackOf.get(it.trackId)?.name ?? "?",
        label: excerpt(it.label),
        file: fileOf.get(it.mediaClipId) ?? null,
        start: it.startFrame,
        end: endFrame(it),
        owner: owner(it.id),
        ...locks(it),
        over: over.map((c) => c.id),
        insideClipId: host,
        crossesCut: cuts.some((c) => it.startFrame < c && c < endFrame(it)),
      };
    });

  const usedClipIds = (selectIds: string[]) =>
    interviewItems
      .filter((it) => it.selectId && selectIds.includes(it.selectId))
      .map((it) => it.id);

  const caveats: string[] = [];
  const speakers = new Set(analysis.transcript.map((t) => t.speaker));
  if (speakers.size <= 1 && [...speakers][0]?.toLowerCase().includes("unknown"))
    caveats.push(
      "Speakers are not identified: interviewer and subject can't be told apart except by questions.",
    );
  caveats.push(
    "Transcript lines are phrase-level with segment timings only (no word timings); they are evidence for whole clips, not cut points.",
  );
  if (interview.some((c) => c.lines.some((l) => l.lowConfidence)))
    caveats.push(
      `Some lines are low-confidence (below ${LOW_CONFIDENCE}); they are flagged and must not be relied on alone.`,
    );

  return {
    schema: STORY_CONTEXT_SCHEMA,
    versionId: ctx.activeVersionId,
    revision: sequenceRevision(seq),
    fps: fpsOf(seq.rate),
    durationFrames: sequenceEndFrame(seq),
    interview,
    cutaways,
    story: story
      ? {
          id: story.id,
          title: excerpt(story.title),
          beats: story.beats.map((b) => ({
            id: b.id,
            label: excerpt(b.label),
            intent: excerpt(b.intent),
            selectIds: [...b.selectIds],
            clipIds: usedClipIds(b.selectIds),
          })),
        }
      : null,
    selects: analysis.selects.map((s) => ({
      id: s.id,
      clipId: s.clipId,
      startTc: s.startTc,
      endTc: s.endTc,
      score: s.score,
      category: s.category,
    })),
    caveats,
  };
}
