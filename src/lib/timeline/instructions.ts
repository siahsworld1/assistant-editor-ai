// Director AI 2.0 — Phase 4: deterministic natural-language instructions.
//
// A small, closed grammar turns a typed editing instruction into an existing
// Phase 1 EditProposal. No AI provider is involved, nothing is guessed:
//   - "this clip" / "the selected clip" means the ONE selected clip (a V1
//     picture and its linked A1 audio count as one clip); with none or several
//     selected, the instruction is refused. Plural references ("the selected
//     clips", "the selection") act on every selected clip where that is safe.
//   - Times are converted with the sequence's own frame rate; a fraction of a
//     frame is rounded and the rounding is reported.
//   - Clips are referenced by their stable ids; no clip, footage or timecode is
//     ever invented.
//   - Unsupported or ambiguous wording is refused with a reason, never mapped
//     to a different edit ("remove and close the gap" never becomes a lift).
// Interpretation is pure: it reads the active sequence and the selection, and
// dry-runs the proposal through reviewProposal only to describe its effect.
//
// Supported grammar (case-insensitive; leading "please", trailing "." ok):
//   MOVE    (move|shift|slide|nudge) REF [by] AMOUNT UNIT (earlier|later|left|right|back|forward)
//           (move|shift|slide|nudge) REF (earlier|later|…) by AMOUNT UNIT
//   TRIM    (trim|shorten) [REF] [by] AMOUNT UNIT (from|off) [the] (end|start|beginning|head|tail|out point|in point) [of REF]
//           (trim|shorten) the (end|start|…) of REF by AMOUNT UNIT
//   REMOVE  (remove|delete|lift) REF [and close the gap | and ripple | with ripple]
//           ripple (delete|remove) REF
//   REF     this clip · that clip · the clip · it · this · the selected clip · selected clip
//           (plural) the selected clips · selected clips · these clips · the selection · selection
//   AMOUNT  a number (2, 1.5) · a/an/one…ten · "half a"
//   UNIT    frame(s) · f · second(s) · sec(s) · s
import type { Clip } from "@/lib/ae/types";
import {
  PROPOSAL_SCHEMA,
  reviewProposal,
  sequenceRevision,
  type ProposalContext,
  type ProposalOp,
} from "./proposals";
import { endFrame, expandLinked } from "./selectors";
import { commands } from "./commands";
import { dryRun } from "./gestures";
import { fpsOf, frameToTc, rescaleFrames } from "./time";
import type { ClipItem, Sequence } from "./types";
import { sequenceOf } from "./workspace";

export type InstructionRefusal =
  | "unrecognized"
  | "unsupported"
  | "no-selection"
  | "ambiguous-selection"
  | "invalid-amount"
  | "impossible"
  | "no-sequence";

export interface Interpretation {
  /** What the Director understood, in words ("Move 2 seconds earlier"). */
  action: string;
  /** The clip(s) it acts on, by name. */
  clips: string[];
  /** The expected change on the timeline — null when the review refuses it. */
  expected: string | null;
  /** Anything the filmmaker should know before accepting. */
  limitations: string[];
}

export type InstructionResult =
  | { ok: true; proposal: Record<string, unknown>; interpretation: Interpretation }
  | { ok: false; code: InstructionRefusal; reason: string };

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const AMOUNT = String.raw`(half an?|\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten)`;
const UNIT = String.raw`(frames?|f|seconds?|secs?|s)`;
const SINGULAR_REF = String.raw`(?:this clip|that clip|the clip|it|this|the selected clip|selected clip|the current clip)`;
const PLURAL_REF = String.raw`(?:the selected clips|selected clips|these clips|the selection|selection)`;
const REF = String.raw`(${PLURAL_REF}|${SINGULAR_REF})`;
const EARLIER = ["earlier", "left", "back", "backward", "backwards"];
const LATER = ["later", "right", "forward", "forwards", "ahead"];
const DIR = String.raw`(${[...EARLIER, ...LATER].join("|")})`;
const EDGE = String.raw`(end|start|beginning|head|tail|out point|in point|out|in)`;
const MOVE_VERB = String.raw`(?:move|shift|slide|nudge)`;
const TRIM_VERB = String.raw`(?:trim|shorten)`;

const RE = {
  moveA: new RegExp(String.raw`^${MOVE_VERB} ${REF} (?:by )?${AMOUNT} ${UNIT} ${DIR}$`),
  moveB: new RegExp(String.raw`^${MOVE_VERB} ${REF} ${DIR} by ${AMOUNT} ${UNIT}$`),
  trimA: new RegExp(
    String.raw`^${TRIM_VERB}(?: ${REF})? (?:by )?${AMOUNT} ${UNIT} (?:from|off|off of) (?:the )?${EDGE}(?: of ${REF})?$`,
  ),
  trimB: new RegExp(String.raw`^${TRIM_VERB} the ${EDGE} of ${REF} by ${AMOUNT} ${UNIT}$`),
  remove: new RegExp(
    String.raw`^(?:remove|delete|lift) ${REF}( and close the gap| closing the gap| and ripple| with ripple| with a ripple)?$`,
  ),
  rippleRemove: new RegExp(String.raw`^ripple(?:[- ]delete| remove) ${REF}$`),
};

export const EXAMPLES = [
  "Move the selected clip 2 seconds earlier",
  "Move this clip 15 frames later",
  "Trim 1 second from the end",
  "Remove the selected clip",
  "Remove the selected clip and close the gap",
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[.!]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please |director,? |can you |could you )+/, "")
    .replace(/ please$/, "");
}

function amountOf(word: string): number | null {
  if (word.startsWith("half")) return 0.5;
  if (word in WORD_NUMBERS) return WORD_NUMBERS[word]!;
  const n = Number(word);
  return Number.isFinite(n) ? n : null;
}

function refusal(code: InstructionRefusal, reason: string): InstructionResult {
  return { ok: false, code, reason };
}

const isPlural = (ref: string | undefined) => !!ref && new RegExp(`^${PLURAL_REF}$`).test(ref);

/** One clip per link group (prefer the picture over its sync audio). */
function selectedClips(seq: Sequence, selection: readonly string[]): ClipItem[] {
  const seen = new Set<string>();
  const out: ClipItem[] = [];
  for (const id of selection) {
    if (!seq.items[id] || seen.has(id)) continue;
    const group = expandLinked(seq, [id]).map((m) => seq.items[m]!);
    for (const m of group) seen.add(m.id);
    const video = group.find((m) => seq.tracks.find((t) => t.id === m.trackId)?.kind === "video");
    out.push(video ?? seq.items[id]!);
  }
  return out;
}

const clipLabel = (seq: Sequence, item: ClipItem, clips: ReadonlyArray<Pick<Clip, "id">>) => {
  const track = seq.tracks.find((t) => t.id === item.trackId)?.name ?? "";
  const file = (clips as ReadonlyArray<Pick<Clip, "id"> & { filename?: string }>).find(
    (c) => c.id === item.mediaClipId,
  )?.filename;
  return `"${item.label}" (${track}${file ? ` · ${file}` : ""})`;
};

type TrimPlan =
  | { kind: "exact" | "nearest"; deltaSourceFrames: number; achieved: number }
  | { kind: "as-asked"; deltaSourceFrames: number }
  | { kind: "impossible"; reason: string };

/**
 * The source-frame change that shortens `item` by exactly `frames` sequence
 * frames. TrimEdit works in the clip's SOURCE frames and re-derives the
 * sequence length from the timecode clock, so a given source change can land
 * a frame either way. Candidates around the rate-converted amount are dry-run
 * (deterministically, in a fixed order):
 *   - exact: one shortens by exactly `frames`;
 *   - nearest: none does, but one shortens by `frames ± 1` — used, and
 *     disclosed to the filmmaker;
 *   - impossible: candidates run but none shortens within a frame — refused;
 *   - as-asked: the engine refuses every candidate (protected, too long…) —
 *     the request goes through unchanged so the review explains why.
 */
function planTrim(
  seq: Sequence,
  item: ClipItem,
  edge: "in" | "out",
  frames: number,
  media: ProposalContext["media"],
): TrimPlan {
  const sign = edge === "out" ? -1 : 1;
  const guess = rescaleFrames(frames, seq.rate, item.mediaRate);
  const shortening = (s: Sequence) => {
    const after = s.items[item.id]!;
    return item.durationFrames - after.durationFrames;
  };
  let ran = false;
  let best: { d: number; achieved: number } | null = null;
  for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    const magnitude = guess + offset;
    if (magnitude <= 0) continue;
    const d = sign * magnitude;
    const out = dryRun(seq, (g) => [commands.trim(g, item.id, edge, d)], media);
    if (!out.ok) continue;
    ran = true;
    const achieved = shortening(out.sequence);
    if (achieved === frames) return { kind: "exact", deltaSourceFrames: d, achieved };
    if (
      achieved > 0 &&
      Math.abs(achieved - frames) <= 1 &&
      (!best || Math.abs(achieved - frames) < Math.abs(best.achieved - frames))
    )
      best = { d, achieved };
  }
  if (best) return { kind: "nearest", deltaSourceFrames: best.d, achieved: best.achieved };
  if (!ran) return { kind: "as-asked", deltaSourceFrames: sign * guess };
  return {
    kind: "impossible",
    reason: `This clip's ${fpsOf(item.mediaRate)} fps source can't be trimmed by ${frames} frame${frames === 1 ? "" : "s"} on this ${fpsOf(seq.rate)} fps sequence — try a slightly different amount.`,
  };
}

/**
 * Interprets one instruction against the active sequence and the current
 * timeline selection. Pure: nothing is changed; the returned proposal still
 * goes through the normal review / preview / accept workflow.
 */
export function interpretInstruction(
  text: string,
  ctx: ProposalContext,
  selection: readonly string[],
): InstructionResult {
  const seq = sequenceOf(ctx.workspace, ctx.activeVersionId, ctx.clips);
  if (!seq) return refusal("no-sequence", "There is no cut to edit yet.");
  const t = normalize(text);
  if (!t) return refusal("unrecognized", "Type an editing instruction first.");

  // Recognised but not supported yet — say so, rather than doing something else.
  if (/^(?:split|blade|razor)\b/.test(t) || /^cut (?:this|that|the|it|selected)/.test(t)) {
    return refusal(
      "unsupported",
      /^cut /.test(t)
        ? 'I can\'t tell whether "cut" means remove or split. Say "remove the selected clip" — splitting isn\'t supported by the Director yet.'
        : "Splitting isn't supported by the Director yet — use the Blade tool (B).",
    );
  }
  if (/^(?:extend|lengthen|slip|slide .* source|roll|replace|swap|add|insert|reorder)\b/.test(t)) {
    return refusal(
      "unsupported",
      "I can move, trim or remove a selected clip — that kind of edit isn't supported yet.",
    );
  }

  let kind: "move" | "trim" | "remove";
  let ref: string | undefined;
  let amount: number | null = null;
  let unit = "";
  let direction = 0;
  let edge: "in" | "out" = "out";
  let ripple = false;
  let m: RegExpMatchArray | null;
  if ((m = t.match(RE.moveA))) {
    kind = "move";
    ref = m[1];
    amount = amountOf(m[2]!);
    unit = m[3]!;
    direction = EARLIER.includes(m[4]!) ? -1 : 1;
  } else if ((m = t.match(RE.moveB))) {
    kind = "move";
    ref = m[1];
    direction = EARLIER.includes(m[2]!) ? -1 : 1;
    amount = amountOf(m[3]!);
    unit = m[4]!;
  } else if ((m = t.match(RE.trimA))) {
    kind = "trim";
    if (m[1] && m[5])
      return refusal(
        "unrecognized",
        'Name the clip once — e.g. "Trim 1 second from the end of the selected clip".',
      );
    ref = m[1] ?? m[5];
    amount = amountOf(m[2]!);
    unit = m[3]!;
    edge = /^(end|tail|out point|out)$/.test(m[4]!) ? "out" : "in";
  } else if ((m = t.match(RE.trimB))) {
    kind = "trim";
    edge = /^(end|tail|out point|out)$/.test(m[1]!) ? "out" : "in";
    ref = m[2];
    amount = amountOf(m[3]!);
    unit = m[4]!;
  } else if ((m = t.match(RE.remove))) {
    kind = "remove";
    ref = m[1];
    ripple = !!m[2];
  } else if ((m = t.match(RE.rippleRemove))) {
    kind = "remove";
    ref = m[1];
    ripple = true;
  } else {
    return refusal(
      "unrecognized",
      `I can't interpret that instruction yet. Try, for example: "${EXAMPLES[0]}", "${EXAMPLES[2]}" or "${EXAMPLES[4]}".`,
    );
  }

  // Who: the selection, exactly as the wording requires.
  const chosen = selectedClips(seq, selection);
  const plural = isPlural(ref) && kind !== "trim";
  if (!chosen.length)
    return refusal(
      "no-selection",
      "Select a clip in the timeline before issuing this instruction.",
    );
  if (!plural && chosen.length > 1)
    return refusal(
      "ambiguous-selection",
      kind === "trim"
        ? "Select one clip before trimming — several are selected."
        : `Select one clip before issuing this instruction — ${chosen.length} are selected. (Say "the selected clips" to act on all of them.)`,
    );

  // How much: whole sequence frames at the sequence's rate.
  const fps = fpsOf(seq.rate);
  const limitations: string[] = [];
  let frames = 0;
  if (kind !== "remove") {
    if (amount === null || !(amount > 0))
      return refusal("invalid-amount", "The amount must be more than zero.");
    const isSeconds = !/^f(rames?)?$/.test(unit);
    const exact = isSeconds ? amount * fps : amount;
    frames = Math.round(exact);
    if (frames < 1) return refusal("invalid-amount", "That is less than one frame.");
    if (Math.abs(exact - frames) > 1e-6)
      limitations.push(
        `${amount} ${isSeconds ? "second" : "frame"}${amount === 1 ? "" : "s"} is ${exact.toFixed(2)} frames at ${fps} fps — rounded to ${frames}.`,
      );
  }

  const labels = chosen.map((c) => clipLabel(seq, c, ctx.clips));
  const linked = chosen.some((c) => c.linkGroupId);
  const ops: ProposalOp[] = [];
  let action: string;
  const ids = chosen.map((c) => c.id);
  const amountText = (n: number) =>
    `${n} frame${n === 1 ? "" : "s"}${unit && !/^f/.test(unit) ? ` (${(n / fps).toFixed(2).replace(/\.?0+$/, "")} s)` : ""}`;

  if (kind === "move") {
    ops.push({ op: "move", itemIds: ids, deltaFrames: direction * frames });
    action = `Move ${chosen.length > 1 ? `${chosen.length} clips` : "the clip"} ${amountText(frames)} ${direction < 0 ? "earlier" : "later"}`;
    if (linked) limitations.push("Linked sync audio moves with its picture.");
  } else if (kind === "trim") {
    const item = chosen[0]!;
    if (frames >= item.durationFrames)
      return refusal(
        "impossible",
        `That would trim away the whole clip (${item.durationFrames} frames) — use "Remove the selected clip" instead.`,
      );
    const plan = planTrim(seq, item, edge, frames, ctx.media);
    if (plan.kind === "impossible") return refusal("impossible", plan.reason);
    ops.push({ op: "trim", itemId: item.id, edge, deltaSourceFrames: plan.deltaSourceFrames });
    if (plan.kind === "nearest") {
      limitations.push(
        `Asked for ${frames} frame${frames === 1 ? "" : "s"}; the closest this clip's ${fpsOf(item.mediaRate)} fps source allows is ${plan.achieved} — that is what will be trimmed.`,
      );
    }
    action = `Trim ${amountText(frames)} from the ${edge === "out" ? "end" : "start"} of the clip`;
    if (linked) limitations.push("Its linked sync audio is trimmed with it.");
    limitations.push(
      edge === "out"
        ? "The clip keeps its start; a gap opens after it."
        : "The clip keeps its end; a gap opens before it.",
    );
  } else {
    ops.push({ op: "remove", itemIds: ids, ripple });
    action = `Remove ${chosen.length > 1 ? `${chosen.length} clips` : "the clip"}${ripple ? " and close the gap" : ", leaving the gap"}`;
    if (linked) limitations.push("Linked sync audio is removed with its picture.");
    if (ripple) limitations.push("Closing the gap moves every later clip on all tracks earlier.");
  }

  const base = { versionId: ctx.activeVersionId, revision: sequenceRevision(seq) };
  const proposal = {
    schema: PROPOSAL_SCHEMA,
    id: `prp_nl_${kind}_${base.revision.slice(4, 12)}_${Math.abs(direction * frames)}`,
    instruction: text.trim().slice(0, 500),
    summary: `${action}: ${labels.join(", ")}.`,
    base,
    operations: ops,
  };

  // Describe the exact effect by dry-running it (nothing is stored).
  const review = reviewProposal(proposal, ctx);
  let expected: string | null = null;
  if (review.ok) {
    const after = review.preview;
    const tc = (f: number) => frameToTc(f, seq.rate);
    const parts = chosen.map((c) => {
      const a = after.items[c.id];
      if (kind === "move" && a)
        return `starts at ${tc(a.startFrame)} instead of ${tc(c.startFrame)}`;
      if (kind === "trim" && a) {
        const d = c.durationFrames - a.durationFrames;
        return `${d} frame${d === 1 ? "" : "s"} shorter (${tc(a.startFrame)}–${tc(endFrame(a))})`;
      }
      if (kind === "remove" && !a) {
        const shifted = Object.values(after.items).filter(
          (i) => seq.items[i.id] && i.startFrame !== seq.items[i.id]!.startFrame,
        );
        return ripple
          ? `removed; ${shifted.length} later clip${shifted.length === 1 ? "" : "s"} move up ${c.durationFrames} frames`
          : `removed; a ${c.durationFrames}-frame gap is left at ${tc(c.startFrame)}`;
      }
      return "changed";
    });
    expected = `${chosen.length > 1 ? "Each clip: " : ""}${[...new Set(parts)].join("; ")}.`;
  }
  return { ok: true, proposal, interpretation: { action, clips: labels, expected, limitations } };
}
