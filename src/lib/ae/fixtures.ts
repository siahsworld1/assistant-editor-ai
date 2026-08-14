import type {
  Clip,
  EditVersion,
  NLEStatus,
  ProjectBrain,
  Select,
  StoryCandidate,
  TranscriptSegment,
  UniversalTimeline,
  VisualEvidence,
} from "./types";

const tc = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * 24);
  return [h, m, sec, f].map((n) => String(n).padStart(2, "0")).join(":");
};

export const demoClips: Clip[] = [
  {
    id: "clip-001",
    filename: "A001_INT_MARISOL_01.mov",
    role: "interview",
    durationSeconds: 2410,
    camera: "CAM A / FX6",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: ["Marisol Reyes"],
    state: "analyzed",
    progress: 100,
    hasTranscript: true,
    visualEvidenceCount: 42,
    technicalIssues: [],
    thumbHue: 28,
  },
  {
    id: "clip-002",
    filename: "A002_INT_DEVON_01.mov",
    role: "interview",
    durationSeconds: 1980,
    camera: "CAM A / FX6",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: ["Devon Clarke"],
    state: "analyzed",
    progress: 100,
    hasTranscript: true,
    visualEvidenceCount: 37,
    technicalIssues: ["HVAC hum 120Hz"],
    thumbHue: 12,
  },
  {
    id: "clip-003",
    filename: "A003_INT_GRACE_02.mov",
    role: "interview",
    durationSeconds: 2260,
    camera: "CAM B / FX3",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: ["Grace Okonkwo"],
    state: "analyzed",
    progress: 100,
    hasTranscript: true,
    visualEvidenceCount: 51,
    technicalIssues: ["Soft focus 00:04:12–00:04:38"],
    thumbHue: 200,
  },
  {
    id: "clip-004",
    filename: "B101_BROLL_GARDEN_SUNRISE.mov",
    role: "b-roll",
    durationSeconds: 312,
    camera: "CAM C / FX3",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: [],
    state: "analyzed",
    progress: 100,
    hasTranscript: false,
    visualEvidenceCount: 18,
    technicalIssues: [],
    thumbHue: 46,
  },
  {
    id: "clip-005",
    filename: "B104_BROLL_KITCHEN_HANDS.mov",
    role: "b-roll",
    durationSeconds: 244,
    camera: "CAM C / FX3",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: [],
    state: "analyzed",
    progress: 100,
    hasTranscript: false,
    visualEvidenceCount: 22,
    technicalIssues: [],
    thumbHue: 18,
  },
  {
    id: "clip-006",
    filename: "B109_BROLL_BLOCK_PARTY.mov",
    role: "b-roll",
    durationSeconds: 486,
    camera: "CAM C / FX3",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: [],
    state: "analyzing",
    progress: 62,
    hasTranscript: false,
    visualEvidenceCount: 9,
    technicalIssues: ["Rolling shutter on pan"],
    thumbHue: 320,
  },
  {
    id: "clip-007",
    filename: "B112_BROLL_MURAL_WALL.mov",
    role: "b-roll",
    durationSeconds: 178,
    camera: "CAM C / FX3",
    resolution: "3840x2160",
    fps: 23.976,
    speakers: [],
    state: "pending",
    progress: 0,
    hasTranscript: false,
    visualEvidenceCount: 0,
    technicalIssues: [],
    thumbHue: 260,
  },
  {
    id: "clip-008",
    filename: "S201_AMBI_STREET_ROOM_TONE.wav",
    role: "ambient",
    durationSeconds: 600,
    camera: "MixPre-6",
    resolution: "48kHz / 24-bit",
    fps: 0,
    speakers: [],
    state: "analyzed",
    progress: 100,
    hasTranscript: false,
    visualEvidenceCount: 0,
    technicalIssues: [],
    thumbHue: 150,
    note: "Room tone bed",
  },
];

export const demoTranscript: TranscriptSegment[] = [
  {
    id: "t1",
    clipId: "clip-001",
    speaker: "Marisol Reyes",
    startTc: "00:04:12:06",
    endTc: "00:04:31:18",
    text: "When the lot flooded the second time, nobody waited for the city. We just showed up with shovels.",
    confidence: 0.96,
  },
  {
    id: "t2",
    clipId: "clip-002",
    speaker: "Devon Clarke",
    startTc: "00:11:48:02",
    endTc: "00:12:09:11",
    text: "I grew up three blocks from here and I never once saw anybody garden. Now there's a waitlist.",
    confidence: 0.94,
  },
  {
    id: "t3",
    clipId: "clip-003",
    speaker: "Grace Okonkwo",
    startTc: "00:22:03:14",
    endTc: "00:22:29:00",
    text: "My mother's hands are in that soil. That's not a metaphor, she planted the first row herself.",
    confidence: 0.97,
  },
];

export const demoVisualEvidence: VisualEvidence[] = [
  { id: "v1", clipId: "clip-004", kind: "b-roll", label: "Golden-hour wide, garden rows", atTc: "00:00:14:00", confidence: 0.91 },
  { id: "v2", clipId: "clip-005", kind: "motion", label: "Close hands kneading dough", atTc: "00:01:02:12", confidence: 0.88 },
  { id: "v3", clipId: "clip-003", kind: "face", label: "Tears welling, sustained 6s", atTc: "00:22:18:04", confidence: 0.83 },
  { id: "v4", clipId: "clip-006", kind: "scene", label: "Crowd, block party, dusk", atTc: "00:02:41:09", confidence: 0.79 },
];

export const demoSelects: Select[] = [
  {
    id: "sel-01",
    rank: 1,
    speaker: "Grace Okonkwo",
    clipId: "clip-003",
    clipName: "A003_INT_GRACE_02.mov",
    startTc: "00:22:03:14",
    endTc: "00:22:29:00",
    durationSeconds: 25.6,
    score: 96,
    category: "emotional",
    transcriptExcerpt:
      "My mother's hands are in that soil. That's not a metaphor, she planted the first row herself.",
    reasons: [
      "Personal stake stated in first sentence",
      "Concrete image carries the theme without narration",
      "Clean in/out points at sentence boundaries",
    ],
    evidence: [
      { kind: "emotion", detail: "Vocal tremor + sustained eye contact (0.83)" },
      { kind: "visual", detail: "Face close-up, stable frame, no cutaway needed" },
      { kind: "audio", detail: "-18 LUFS, no HVAC bleed" },
    ],
  },
  {
    id: "sel-02",
    rank: 2,
    speaker: "Marisol Reyes",
    clipId: "clip-001",
    clipName: "A001_INT_MARISOL_01.mov",
    startTc: "00:04:12:06",
    endTc: "00:04:31:18",
    durationSeconds: 19.5,
    score: 92,
    category: "strong-statement",
    transcriptExcerpt:
      "When the lot flooded the second time, nobody waited for the city. We just showed up with shovels.",
    reasons: [
      "Sets conflict and agency in one bite",
      "Strong cold-open candidate",
      "Pairs with B101 sunrise wide",
    ],
    evidence: [
      { kind: "transcript", detail: "Confidence 0.96, no crosstalk" },
      { kind: "visual", detail: "Matching B-roll available: B101, B109" },
    ],
  },
  {
    id: "sel-03",
    rank: 3,
    speaker: "Devon Clarke",
    clipId: "clip-002",
    clipName: "A002_INT_DEVON_01.mov",
    startTc: "00:11:48:02",
    endTc: "00:12:09:11",
    durationSeconds: 21.4,
    score: 88,
    category: "context",
    transcriptExcerpt:
      "I grew up three blocks from here and I never once saw anybody garden. Now there's a waitlist.",
    reasons: ["Before/after contrast in a single line", "Good mid-act turn"],
    evidence: [
      { kind: "transcript", detail: "Confidence 0.94" },
      { kind: "audio", detail: "120Hz hum — notch filter suggested" },
    ],
  },
  {
    id: "sel-04",
    rank: 4,
    speaker: "Marisol Reyes",
    clipId: "clip-001",
    clipName: "A001_INT_MARISOL_01.mov",
    startTc: "00:31:02:00",
    endTc: "00:31:18:09",
    durationSeconds: 16.4,
    score: 84,
    category: "closing",
    transcriptExcerpt:
      "In ten years I want somebody else standing here telling you it was always like this.",
    reasons: ["Forward-looking closer", "Natural button on the sentence"],
    evidence: [{ kind: "transcript", detail: "Confidence 0.95" }],
  },
  {
    id: "sel-05",
    rank: 5,
    speaker: "Grace Okonkwo",
    clipId: "clip-003",
    clipName: "A003_INT_GRACE_02.mov",
    startTc: "00:08:44:20",
    endTc: "00:09:01:02",
    durationSeconds: 16.3,
    score: 79,
    category: "humor",
    transcriptExcerpt:
      "The zoning board thought we'd last one summer. We outlasted three board members.",
    reasons: ["Levity beat, releases tension after act one"],
    evidence: [{ kind: "emotion", detail: "Laughter detected off-camera" }],
  },
  {
    id: "sel-06",
    rank: 6,
    speaker: "Devon Clarke",
    clipId: "clip-002",
    clipName: "A002_INT_DEVON_01.mov",
    startTc: "00:19:22:11",
    endTc: "00:19:41:00",
    durationSeconds: 18.6,
    score: 76,
    category: "strong-statement",
    transcriptExcerpt:
      "Food is the excuse. What people actually come for is somebody knowing their name.",
    reasons: ["Thesis line, works as a chapter head"],
    evidence: [{ kind: "transcript", detail: "Confidence 0.92" }],
    alternateOf: "sel-03",
  },
];

export const demoStories: StoryCandidate[] = [
  {
    id: "story-01",
    title: "The Lot That Refused",
    premise:
      "A flooded vacant lot becomes the neighborhood's proof that they don't need permission to fix their own block.",
    estimatedSeconds: 372,
    confidence: 0.91,
    beats: [
      { id: "b1", label: "Cold open", intent: "Flood, shovels, no city", estimatedSeconds: 42, selectIds: ["sel-02"] },
      { id: "b2", label: "Who they were", intent: "Devon's before/after", estimatedSeconds: 68, selectIds: ["sel-03"] },
      { id: "b3", label: "The turn", intent: "Zoning board levity", estimatedSeconds: 54, selectIds: ["sel-05"] },
      { id: "b4", label: "The heart", intent: "Grace's mother's hands", estimatedSeconds: 96, selectIds: ["sel-01"] },
      { id: "b5", label: "Close", intent: "Ten years forward", estimatedSeconds: 62, selectIds: ["sel-04"] },
    ],
    supportingSelectIds: ["sel-01", "sel-02", "sel-03", "sel-04", "sel-05"],
  },
  {
    id: "story-02",
    title: "Somebody Knows Your Name",
    premise:
      "Told through the food: the garden is a pretext, and belonging is the actual harvest.",
    estimatedSeconds: 298,
    confidence: 0.84,
    beats: [
      { id: "b1", label: "Hands, dough, morning", intent: "Sensory open, no VO", estimatedSeconds: 34, selectIds: [] },
      { id: "b2", label: "Thesis", intent: "Devon names the real reason", estimatedSeconds: 58, selectIds: ["sel-06"] },
      { id: "b3", label: "Lineage", intent: "Grace's mother", estimatedSeconds: 90, selectIds: ["sel-01"] },
      { id: "b4", label: "Block party", intent: "Payoff montage", estimatedSeconds: 74, selectIds: [] },
    ],
    supportingSelectIds: ["sel-06", "sel-01", "sel-03"],
  },
  {
    id: "story-03",
    title: "Three Board Members Later",
    premise:
      "A wry procedural about outlasting bureaucracy, cut fast and funny with a late emotional drop.",
    estimatedSeconds: 226,
    confidence: 0.72,
    beats: [
      { id: "b1", label: "Cold open", intent: "Zoning board joke", estimatedSeconds: 28, selectIds: ["sel-05"] },
      { id: "b2", label: "Escalation", intent: "Flood, shovels", estimatedSeconds: 62, selectIds: ["sel-02"] },
      { id: "b3", label: "Drop", intent: "Grace lands the weight", estimatedSeconds: 78, selectIds: ["sel-01"] },
      { id: "b4", label: "Button", intent: "Forward look", estimatedSeconds: 46, selectIds: ["sel-04"] },
    ],
    supportingSelectIds: ["sel-05", "sel-02", "sel-01", "sel-04"],
  },
];

function buildTimeline(name: string, targetSeconds: number): UniversalTimeline {
  const spec: Array<[string, string, number, string | undefined]> = [
    ["interview", "Marisol — 'nobody waited for the city'", 19.5, "sel-02"],
    ["b-roll", "B101 garden sunrise wide", 8, undefined],
    ["interview", "Devon — 'never saw anybody garden'", 21.4, "sel-03"],
    ["b-roll", "B105 kitchen hands", 6.5, undefined],
    ["interview", "Grace — zoning board", 16.3, "sel-05"],
    ["b-roll", "B109 block party dusk", 9, undefined],
    ["interview", "Grace — 'my mother's hands'", 25.6, "sel-01"],
    ["b-roll", "B112 mural wall", 5.5, undefined],
    ["interview", "Marisol — ten years forward", 16.4, "sel-04"],
  ];
  let cursor = 0;
  const decisions = spec.map(([lane, label, dur, selectId], i) => {
    const start = cursor;
    cursor += dur;
    return {
      id: `ed-${i + 1}`,
      lane: lane as "interview" | "b-roll",
      clipId: lane === "interview" ? "clip-001" : "clip-004",
      label,
      sourceInTc: tc(60 + i * 37),
      sourceOutTc: tc(60 + i * 37 + dur),
      timelineStartSeconds: start,
      durationSeconds: dur,
      selectId,
    };
  });
  return {
    id: `tl-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    fps: 23.976,
    targetSeconds,
    totalSeconds: Math.round(cursor),
    decisions,
  };
}

export const demoTimeline = buildTimeline("Community Documentary — Assembly", 360);

export const demoVersions: EditVersion[] = [
  {
    id: "v1",
    label: "First assembly",
    version: "v1.0",
    command: "Build assembly from 'The Lot That Refused'",
    summary: "9 events across 2 lanes, 2m 08s against a 6m target.",
    createdAt: "09:41",
    changes: ["Assembled 5 beats", "Auto-placed 4 B-roll covers", "Room tone bed laid under full timeline"],
    timeline: demoTimeline,
  },
];

export const demoNle: NLEStatus[] = [
  { id: "premiere", name: "Premiere Pro", version: "25.1", detected: true, projectLinked: "Community_Doc_v3.prproj" },
  { id: "fcp", name: "Final Cut Pro", version: "11.0.1", detected: true, projectLinked: null, note: "No library open" },
  { id: "resolve", name: "DaVinci Resolve", detected: false, note: "Not installed on this workstation" },
];

export const demoProject: ProjectBrain = {
  id: "proj-community-doc",
  name: "Community Documentary",
  client: "Northside Collective",
  format: "23.976 / UHD / Rec.709",
  createdAt: "2026-08-02",
  mediaRoot: "/Volumes/POST_RAID/CommunityDoc/01_MEDIA",
  clips: demoClips,
  transcript: demoTranscript,
  visualEvidence: demoVisualEvidence,
  summary: {
    speakers: 3,
    strongStatements: 24,
    emotionalMoments: 9,
    brollOpportunities: 31,
    technicalIssues: 3,
    transcribedMinutes: 114,
  },
  analysisState: "complete",
  analysisProgress: 82,
};
