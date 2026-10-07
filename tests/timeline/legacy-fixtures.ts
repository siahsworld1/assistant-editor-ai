// Schema-1 cuts for the legacy-adapter gates. Shapes and numbers mirror what
// beta.1 actually stores (Director builds, the editorial pass's re-timed and
// added cutaways, the demo assembly), with neutral labels — no footage text.
import { demoClips, demoTimeline } from "@/lib/ae/fixtures";
import type { Clip, EditDecision, UniversalTimeline } from "@/lib/ae/types";

export function clip(
  id: string,
  fps: number,
  durationSeconds: number,
  extra: Partial<Clip> = {},
): Clip {
  return {
    id,
    filename: `${id.toUpperCase()}.MP4`,
    relPath: `${id.toUpperCase()}.MP4`,
    role: "interview",
    durationSeconds,
    camera: "HEVC",
    resolution: "3840x2160",
    fps,
    speakers: [],
    state: "analyzed",
    progress: 100,
    hasTranscript: true,
    visualEvidenceCount: 0,
    technicalIssues: [],
    thumbHue: 0,
    ...extra,
  };
}

function d(
  id: string,
  lane: EditDecision["lane"],
  clipId: string,
  inTc: string,
  outTc: string,
  start: number,
  dur: number,
  selectId?: string,
): EditDecision {
  return {
    id,
    lane,
    clipId,
    label: `${lane} ${id}`,
    sourceInTc: inTc,
    sourceOutTc: outTc,
    timelineStartSeconds: start,
    durationSeconds: dur,
    ...(selectId ? { selectId } : {}),
  };
}

export const projectClips: Clip[] = [
  clip("clip-001", 23.976, 32.4),
  clip("clip-002", 23.976, 101.4),
  clip("clip-003", 23.976, 16.3),
  clip("clip-004", 23.976, 34.1),
  clip("clip-005", 23.976, 9.4),
  clip("clip-006", 23.976, 9.1),
];

/** A Director build at 30 s with model-placed cutaways (the validated v1.2 shape). */
export const directorCut: UniversalTimeline = {
  id: "tl-director",
  name: "Engine assembly",
  fps: 24,
  targetSeconds: 30,
  totalSeconds: 33,
  decisions: [
    d("event-1", "interview", "clip-002", "00:01:02:00", "00:01:12:00", 0, 10, "sel-02"),
    d("event-2", "interview", "clip-002", "00:00:25:00", "00:00:32:00", 10, 7, "sel-01"),
    d("event-3", "interview", "clip-002", "00:00:43:00", "00:00:49:00", 17, 6, "sel-03"),
    d("event-4", "b-roll", "clip-003", "00:00:06:23", "00:00:11:15", 17.5, 4.666333, "sel-03"),
    d("event-5", "interview", "clip-001", "00:00:22:00", "00:00:28:00", 23, 6),
    d("event-6", "interview", "clip-002", "00:01:28:00", "00:01:32:00", 29, 4),
    d("event-7", "b-roll", "clip-004", "00:00:04:20", "00:00:08:00", 29.5, 3.166498),
  ],
};

/** After the editorial pass: phrase-snapped float positions, a re-timed and an
 * added cutaway (the validated v1.4 / 37.92 s shape). */
export const refinedCut: UniversalTimeline = {
  id: "tl-refined",
  name: "Engine assembly",
  fps: 24,
  targetSeconds: 30,
  totalSeconds: 38,
  decisions: [
    d("event-1", "interview", "clip-002", "00:00:24:19", "00:00:35:21", 0, 11.083, "sel-01"),
    d("event-2", "b-roll", "clip-004", "00:00:04:20", "00:00:09:17", 10, 4.875, undefined),
    d(
      "event-3",
      "interview",
      "clip-002",
      "00:00:42:17",
      "00:00:55:02",
      11.083,
      12.374374,
      "sel-03",
    ),
    d(
      "event-4",
      "interview",
      "clip-002",
      "00:01:02:15",
      "00:01:17:02",
      23.457374,
      14.457791,
      "sel-02",
    ),
    d("event-5", "b-roll", "clip-003", "00:00:06:23", "00:00:11:15", 22.383, 4.666333),
    d("cutaway-1", "b-roll", "clip-005", "00:00:01:16", "00:00:04:04", 31.46, 2.5), // clear of the other V2 cutaways
  ],
};

/** Everything schema 1 tolerates that a clean build never produces. */
export const awkwardCut: UniversalTimeline = {
  id: "tl-awkward",
  name: "Awkward",
  fps: 0, // read as 24 everywhere
  targetSeconds: 45,
  totalSeconds: 41,
  decisions: [
    d("event-1", "interview", "clip-024", "00:00:01:00", "00:00:05:12", 0, 4.5), // 24 fps media
    d("event-1", "interview", "clip-030", "00:00:10:00", "00:00:12:00", 4.5, 2), // duplicate id, 29.97 media
    d("event-3", "b-roll", "missing-clip", "00:00:00:00", "00:00:03:00", 1, 3), // unknown clip
    d("event-4", "b-roll", "clip-024", "00:00:02:00", "00:00:06:00", 2, 4), // overlaps event-3 on V2
    d("event-5", "audio", "clip-024", "00:00:00:00", "00:00:40:00", 0, 40), // A2 bed
    d("event-6", "interview", "clip-024", "bad-tc", "00:00:20:00", 6.5, 3), // malformed in point
    d("event-7", "interview", "clip-024", "00:00:21:00", "nope", 9.5, 2.25), // malformed out point
    d("event-8", "interview", "clip-024", "00:00:30:00", "00:00:31:00", -1, 1), // negative start
  ],
};

export const awkwardClips: Clip[] = [clip("clip-024", 24, 120), clip("clip-030", 29.97, 60)];

export const emptyCut: UniversalTimeline = {
  id: "tl-empty",
  name: "Awaiting first build",
  fps: 24,
  targetSeconds: 360,
  totalSeconds: 0,
  decisions: [],
};

export const cases: Array<{ name: string; timeline: UniversalTimeline; clips: Clip[] }> = [
  { name: "Director cut (v1.2 shape)", timeline: directorCut, clips: projectClips },
  { name: "Refined cut (v1.4 shape)", timeline: refinedCut, clips: projectClips },
  { name: "Demo assembly", timeline: demoTimeline, clips: demoClips },
  { name: "Awkward legacy data", timeline: awkwardCut, clips: awkwardClips },
  { name: "Empty baseline", timeline: emptyCut, clips: projectClips },
];
