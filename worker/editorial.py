"""Deterministic editorial pass over a validated assembly.

Runs after the Director (or the fallback) returns decisions and after
pipeline._validate_decisions() has checked them. It fixes the two problems the
packaged validation found in the saved v3 cut, without any AI call:

1. Phrase boundaries. The Director only saw whole-second select in/outs, so it
   guessed trim points and 9 of 10 dialogue cut points landed inside a spoken
   phrase. Each dialogue in/out that falls inside a transcript segment is
   moved to a segment edge — preferring a sentence edge, then a clause edge,
   then a plain phrase edge — within a per-edge budget, never extending
   through a likely interviewer question, and always inside the clip.
   A phrase edge is not always the end of a thought, so an edit that stops on
   a trailing comma/semicolon or an obviously unfinished word ("…here to",
   "when the") is then carried on to the end of its sentence, and one that
   starts just after such a phrase is taken back to the sentence's start —
   only on that strong evidence, within the same budgets.
2. Jump cuts. Consecutive dialogue edits from the same clip with a
   discontinuous source range are jump cuts. Each is covered on V2 — by an
   existing cutaway already within a few seconds of it, or a new one from a
   logged visual moment on a clip with no reliable dialogue — or, when no
   material fits, named in the change notes. Interview timing never moves to
   make room for B-roll, and V2 events never overlap.

Every adjustment is recorded as a change note. Durations are always
re-derived from frame-exact source timecodes (transcript segment edges are
already frame timecodes at the clip's rate).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import dialogue
import media

DIALOGUE_LANE = "interview"
BROLL_LANE = "b-roll"

# A boundary within this of a segment edge is already on it (~1 frame).
EDGE_TOLERANCE = 0.05
# Silence this long between segments ends a thought even without punctuation.
PAUSE_SECONDS = 0.5
# Furthest one edge of an edit may be extended to reach a better boundary.
MAX_EXTEND_SECONDS = 8.0
# Trimming may remove at most this share of an edit, and must leave this much.
MAX_TRIM_SHARE = 0.5
MIN_DIALOGUE_SECONDS = 1.5
# When nothing fits those limits, the nearest phrase edge is used anyway —
# landing mid-phrase is never acceptable — keeping at least this much.
MIN_RELAXED_SECONDS = 0.5
# Completing a thought may lengthen an edit to at most this multiple of the
# Director's length (or by MIN_GROWTH_SECONDS, whichever is more).
MAX_GROWTH_FACTOR = 2.5
MIN_GROWTH_SECONDS = 4.0

# Jump-cut cover: ideally from 1s before the cut to at least 1s after it; never
# less than half a second either side.
COVER_LEAD = 1.0
COVER_TAIL = 1.5
COVER_MIN_SIDE = 0.5
# An existing cutaway is only moved onto a cut if it's already this close.
MAX_COVER_SHIFT = 3.0
# A V2 event shorter than this after trimming is removed rather than kept.
MIN_OVERLAY_SECONDS = 0.5
# Overshoot this small (under a frame) is rounding, not a conflict.
OVERLAY_TOLERANCE = 1 / 48

# Logged moment kinds usable as a cutaway, best first.
COVER_KINDS = ("b-roll", "scene", "graphic", "motion")

_SENTENCE_END = (".", "!", "?", "…", "。", "！", "？")
_CLAUSE_END = (",", ";", ":", "—", "–", "，", "、")
_TIER_NAME = {0: "sentence", 1: "clause", 2: "phrase"}


@dataclass
class Seg:
    start: float
    end: float
    start_tc: str
    end_tc: str
    text: str

    @property
    def stripped(self) -> str:
        return self.text.rstrip().rstrip("\"'”’)")

    @property
    def question(self) -> bool:
        return self.stripped.endswith(("?", "？"))


def clip_segments(clip_id: str, transcript: list[dict], fps: float) -> list[Seg]:
    """The clip's transcript segments that look like real speech, in order."""
    out = []
    for t in transcript:
        if t.get("clipId") != clip_id or dialogue.is_suspect(t):
            continue
        s = media.tc_to_seconds(str(t.get("startTc", "")), fps)
        e = media.tc_to_seconds(str(t.get("endTc", "")), fps)
        if s is None or e is None or e <= s:
            continue
        out.append(Seg(s, e, t["startTc"], t["endTc"], str(t.get("text", "")).strip()))
    out.sort(key=lambda g: g.start)
    return out


def _end_tier(segs: list[Seg], i: int) -> int:
    seg = segs[i]
    if seg.stripped.endswith(_SENTENCE_END):
        return 0
    if i == len(segs) - 1 or segs[i + 1].start - seg.end >= PAUSE_SECONDS:
        return 0
    return 1 if seg.stripped.endswith(_CLAUSE_END) else 2


def _start_tier(segs: list[Seg], i: int) -> int:
    return 0 if i == 0 else _end_tier(segs, i - 1)


def _inside(segs: list[Seg], t: float) -> int | None:
    for i, g in enumerate(segs):
        if g.start + EDGE_TOLERANCE < t < g.end - EDGE_TOLERANCE:
            return i
    return None


def _best(cands: list[tuple[int, float, float, str, str]], relaxed: list[tuple[int, float, float, str, str]]):
    """(tier, distance, seconds, tc, direction) → best by tier, then distance;
    if nothing fits the usual limits, the nearest relaxed option."""
    if cands:
        return min(cands, key=lambda c: (c[0], c[1]))
    return min(relaxed, key=lambda c: c[1]) if relaxed else None


def snap_in(segs: list[Seg], t: float, out_t: float):
    """A better in point for an edit starting at t (None = leave as is)."""
    k = _inside(segs, t)
    if k is None:
        return None
    max_trim = min(MAX_TRIM_SHARE * (out_t - t), out_t - t - MIN_DIALOGUE_SECONDS)
    cands = []
    # Back to an earlier segment start: the edit would then include segments
    # j..k whole — never through a likely question.
    for j in range(k, -1, -1):
        if segs[j].question or t - segs[j].start > MAX_EXTEND_SECONDS:
            break
        cands.append((_start_tier(segs, j), t - segs[j].start, segs[j].start, segs[j].start_tc, "back"))
    # Forward to a later segment start, dropping the fragment.
    for j in range(k + 1, len(segs)):
        d = segs[j].start - t
        if d > max_trim:
            break
        cands.append((_start_tier(segs, j), d, segs[j].start, segs[j].start_tc, "forward"))
    relaxed = []
    if k + 1 < len(segs) and segs[k + 1].start < out_t - MIN_RELAXED_SECONDS:
        relaxed.append((_start_tier(segs, k + 1), segs[k + 1].start - t, segs[k + 1].start, segs[k + 1].start_tc, "forward"))
    if not segs[k].question or not relaxed:
        relaxed.append((_start_tier(segs, k), t - segs[k].start, segs[k].start, segs[k].start_tc, "back"))
    return _best(cands, relaxed)


def snap_out(segs: list[Seg], t: float, in_t: float, max_end: float | None = None):
    """A better out point for an edit ending at t (None = leave as is).
    max_end caps how far the edit may grow."""
    k = _inside(segs, t)
    if k is None:
        return None
    max_trim = min(MAX_TRIM_SHARE * (t - in_t), t - in_t - MIN_DIALOGUE_SECONDS)
    cands = []
    # On to a later segment end — never into the next likely question.
    for j in range(k, len(segs)):
        if (j > k and segs[j].question) or segs[j].end - t > MAX_EXTEND_SECONDS:
            break
        if max_end is not None and segs[j].end > max_end:
            break
        cands.append((_end_tier(segs, j), segs[j].end - t, segs[j].end, segs[j].end_tc, "forward"))
    # Back to an earlier segment end, dropping the fragment.
    for j in range(k - 1, -1, -1):
        d = t - segs[j].end
        if d > max_trim:
            break
        cands.append((_end_tier(segs, j), d, segs[j].end, segs[j].end_tc, "back"))
    relaxed = []
    if k > 0 and segs[k - 1].end > in_t + MIN_RELAXED_SECONDS:
        relaxed.append((_end_tier(segs, k - 1), t - segs[k - 1].end, segs[k - 1].end, segs[k - 1].end_tc, "back"))
    if not segs[k].question or not relaxed:
        relaxed.append((_end_tier(segs, k), segs[k].end - t, segs[k].end, segs[k].end_tc, "forward"))
    return _best(cands, relaxed)


# Words a complete thought practically never ends on (articles, prepositions,
# conjunctions, auxiliaries, possessives). Ending on one is strong evidence the
# speaker carried on in the next phrase. Deliberately short: anything doubtful
# is left out so intentionally clipped statements are preserved.
_UNFINISHED_WORDS = frozenset("""
a an the to of for with from into onto about at by in on as than
and or but nor so because since unless until while when whenever where whereas if though although
that which who whom whose
is are was were be been being am has have had do does did will would can could should shall may might must
my our your their his her its this these those
that's it's we're i'm they're there's he's she's you're we've i've they've what's
""".split())


# A comma before one of these usually closes a whole clause ("…closed the old
# bakery, and today…"): the speaker starts a new idea, so the comma alone
# isn't evidence the thought before it is unfinished.
_COORDINATORS = frozenset({"and", "but", "so", "or", "then", "yet"})


def _first_word(text: str) -> str:
    words = re.findall(r"[\w']+", text.lower())
    return words[0] if words else ""


def _last_word(text: str) -> str:
    words = re.findall(r"[\w']+", text.lower())
    return words[-1] if words else ""


def _continues(segs: list[Seg], k: int) -> str | None:
    """Why the thought obviously carries on past segs[k] into segs[k+1] —
    None when there's no strong evidence (or no contiguous next phrase)."""
    if k + 1 >= len(segs) or segs[k + 1].start - segs[k].end >= PAUSE_SECONDS:
        return None
    s = segs[k].stripped
    if not s or s.endswith(_SENTENCE_END):
        return None
    if s.endswith(_CLAUSE_END) and _first_word(segs[k + 1].text) not in _COORDINATORS:
        return f"a trailing '{s[-1]}'"
    w = _last_word(s)
    if w in _UNFINISHED_WORDS:
        return f"the unfinished '…{w}'"
    return None


def _edge(segs: list[Seg], t: float, attr: str) -> int | None:
    for i, g in enumerate(segs):
        if abs(getattr(g, attr) - t) <= EDGE_TOLERANCE:
            return i
    return None


def complete_out(segs: list[Seg], t: float, max_end: float):
    """An edit ending at phrase edge t on an unfinished thought: the end of the
    sentence it belongs to as (seconds, tc, why), ("blocked", why) when that's
    out of reach, or None when the thought isn't evidently unfinished."""
    k = _edge(segs, t, "end")
    why = _continues(segs, k) if k is not None else None
    if not why:
        return None
    for j in range(k + 1, len(segs)):
        if segs[j].question or segs[j].start - segs[j - 1].end >= PAUSE_SECONDS:
            break
        if segs[j].end - t > MAX_EXTEND_SECONDS or segs[j].end > max_end:
            break
        if _end_tier(segs, j) == 0:
            return segs[j].end, segs[j].end_tc, why
    return "blocked", why


def complete_in(segs: list[Seg], t: float, min_start: float):
    """An edit starting at phrase edge t right after an unfinished phrase: the
    start of that sentence, ("blocked", why), or None. Never pulls in a
    question (an interviewer's line)."""
    k = _edge(segs, t, "start")
    if k is None or k == 0 or segs[k - 1].question:
        return None
    why = _continues(segs, k - 1)
    if not why:
        return None
    for j in range(k - 1, -1, -1):
        if segs[j].question or segs[j + 1].start - segs[j].end >= PAUSE_SECONDS:
            break
        if t - segs[j].start > MAX_EXTEND_SECONDS or segs[j].start < min_start:
            break
        if _start_tier(segs, j) == 0:
            return segs[j].start, segs[j].start_tc, why
    return "blocked", why


def _words(segs: list[Seg], a: float, b: float) -> str:
    return " ".join(g.text for g in segs if g.start >= a - EDGE_TOLERANCE and g.end <= b + EDGE_TOLERANCE)


def _clamp_to_clip(tc: str, seconds: float, clip, fps: float) -> tuple[str, float]:
    end = getattr(clip, "duration_seconds", 0) or 0
    if end > 0 and seconds > end:
        tc = media.seconds_to_tc(end, fps)
        seconds = media.tc_to_seconds(tc, fps) or end
    return tc, seconds


def snap_dialogue(decisions: list[dict], clips: dict, transcript: list[dict]) -> tuple[list[dict], list[str], list[dict]]:
    """Moves dialogue in/out points onto phrase boundaries. Returns the new
    decisions, change notes and a per-edit report (for diagnostics/tests)."""
    notes: list[str] = []
    report: list[dict] = []
    out = []
    for d in decisions:
        if d.get("lane", DIALOGUE_LANE) != DIALOGUE_LANE or d.get("clipId") not in clips:
            out.append(d)
            continue
        clip = clips[d["clipId"]]
        fps = clip.fps or 24.0
        segs = clip_segments(d["clipId"], transcript, fps)
        in_tc, out_tc = d["sourceInTc"], d["sourceOutTc"]
        in_s, out_s = media.tc_to_seconds(in_tc, fps), media.tc_to_seconds(out_tc, fps)
        entry = {"label": d.get("label", ""), "clipId": d["clipId"], "before": (in_tc, out_tc), "reasons": []}
        if segs and in_s is not None and out_s is not None:
            original = out_s - in_s
            new_in = snap_in(segs, in_s, out_s)
            if new_in:
                tier, _, sec, tc, direction = new_in
                verb = "moved back to the start of" if direction == "back" else "moved forward past a partial phrase to the start of"
                entry["reasons"].append(f"in {verb} a {_TIER_NAME[tier]} ({in_tc} → {tc})")
                in_s, in_tc = sec, tc
            new_out = snap_out(segs, out_s, in_s, in_s + max(MAX_GROWTH_FACTOR * original, original + MIN_GROWTH_SECONDS))
            if new_out:
                tier, _, sec, tc, direction = new_out
                verb = "extended to the end of" if direction == "forward" else "trimmed back to the end of"
                tc, sec = _clamp_to_clip(tc, sec, clip, fps)
                entry["reasons"].append(f"out {verb} a {_TIER_NAME[tier]} ({out_tc} → {tc})")
                out_s, out_tc = sec, tc
            # Complete-thought pass: a phrase edge isn't always a thought's end.
            cap = max(MAX_GROWTH_FACTOR * original, original + MIN_GROWTH_SECONDS)
            done = complete_out(segs, out_s, in_s + cap)
            if done and done[0] == "blocked":
                entry["reasons"].append(f"out ends on {done[1]} but the rest of the sentence is out of reach — left as is")
            elif done:
                sec, tc, why = done
                tc, sec = _clamp_to_clip(tc, sec, clip, fps)
                entry["reasons"].append(f"out ended on {why}; carried on to the end of the thought ({out_tc} → {tc}, +{sec - out_s:.2f}s)")
                out_s, out_tc = sec, tc
            done = complete_in(segs, in_s, out_s - cap)
            if done and done[0] == "blocked":
                entry["reasons"].append(f"in follows {done[1]} but the sentence start is out of reach — left as is")
            elif done:
                sec, tc, why = done
                entry["reasons"].append(f"in followed {why}; moved back to the start of the sentence ({in_tc} → {tc}, +{in_s - sec:.2f}s)")
                in_s, in_tc = sec, tc
        duration = round(out_s - in_s, 6) if in_s is not None and out_s is not None else d.get("durationSeconds")
        entry.update(after=(in_tc, out_tc), durationSeconds=duration, text=_words(segs, in_s or 0, out_s or 0))
        report.append(entry)
        if entry["reasons"]:
            notes.append(f"Phrase boundaries for '{entry['label']}': " + "; ".join(entry["reasons"]) + ".")
        out.append({**d, "sourceInTc": in_tc, "sourceOutTc": out_tc, "durationSeconds": duration})
    return out, notes, report


def _source_in(d: dict, clips: dict) -> float:
    fps = (clips[d["clipId"]].fps or 24.0) if d.get("clipId") in clips else 24.0
    return media.tc_to_seconds(d["sourceInTc"], fps) or 0.0


def relayout(before: list[dict], after: list[dict], clips: dict) -> list[dict]:
    """Re-packs dialogue events with their new durations (keeping the
    Director's order and any gaps it left) and re-anchors every other event: one
    that straddled a cut between two dialogue edits stays on that same cut (it
    was covering it); any other stays over the same spoken moment."""
    dlg = sorted(
        (i for i, d in enumerate(after) if d.get("lane", DIALOGUE_LANE) == DIALOGUE_LANE),
        key=lambda i: before[i]["timelineStartSeconds"],
    )
    new_start: dict[int, float] = {}
    prev_old_end = prev_new_end = None
    for i in dlg:
        old_start = before[i]["timelineStartSeconds"]
        if prev_old_end is None:
            start = old_start
        else:
            start = prev_new_end + max(0.0, old_start - prev_old_end)
        new_start[i] = round(start, 6)
        prev_old_end = old_start + before[i]["durationSeconds"]
        prev_new_end = start + after[i]["durationSeconds"]

    # Cuts between consecutive dialogue edits: (old time, new time).
    cuts = [(before[b]["timelineStartSeconds"], new_start[b]) for b in dlg[1:]]

    result = []
    for i, d in enumerate(after):
        if i in new_start:
            result.append({**d, "timelineStartSeconds": new_start[i]})
            continue
        t = d["timelineStartSeconds"]
        straddled = next(
            (c for c in cuts if t < c[0] - EDGE_TOLERANCE and t + d["durationSeconds"] > c[0] + EDGE_TOLERANCE), None
        )
        if straddled:
            result.append({**d, "timelineStartSeconds": round(straddled[1] - (straddled[0] - t), 6)})
            continue
        host = None
        for h in dlg:
            if before[h]["timelineStartSeconds"] <= t + 1e-6:
                host = h
        if host is None:
            host = dlg[0] if dlg else None
        if host is None:
            result.append(d)
            continue
        # Same spoken moment: source time under the cutaway, before → after.
        src = _source_in(before[host], clips) + (t - before[host]["timelineStartSeconds"])
        offset = src - _source_in(after[host], clips)
        offset = max(0.0, min(offset, max(0.0, after[host]["durationSeconds"] - COVER_MIN_SIDE)))
        result.append({**d, "timelineStartSeconds": round(new_start[host] + offset, 6)})
    return result


def _end(d: dict) -> float:
    return d["timelineStartSeconds"] + d["durationSeconds"]


def _retime(d: dict, clip, start: float, duration: float) -> dict:
    """d placed at `start` with its source out moved so it lasts `duration`
    (frame-exact at the clip's rate)."""
    fps = clip.fps or 24.0
    src_in = media.tc_to_seconds(d["sourceInTc"], fps) or 0.0
    out_tc = media.seconds_to_tc(src_in + duration + 1e-6, fps)
    real = round((media.tc_to_seconds(out_tc, fps) or src_in) - src_in, 6)
    return {**d, "sourceOutTc": out_tc, "durationSeconds": real, "timelineStartSeconds": round(start, 6)}


def fit_overlays(decisions: list[dict], clips: dict, notes: list[str]) -> list[dict]:
    """Keeps V2 inside the sequence and free of overlaps after re-layout, by
    trimming an event's tail (never its head, never V1)."""
    total = max((_end(d) for d in decisions if d.get("lane", DIALOGUE_LANE) == DIALOGUE_LANE), default=0.0)
    idx = sorted((i for i, d in enumerate(decisions) if d.get("lane") == BROLL_LANE),
                 key=lambda i: decisions[i]["timelineStartSeconds"])
    drop = set()
    for n, i in enumerate(idx):
        d = decisions[i]
        limit = total
        if n + 1 < len(idx):
            limit = min(limit, decisions[idx[n + 1]]["timelineStartSeconds"])
        if _end(d) > limit + OVERLAY_TOLERANCE:
            keep = limit - d["timelineStartSeconds"]
            if keep < MIN_OVERLAY_SECONDS or d.get("clipId") not in clips:
                drop.add(i)
                notes.append(f"Removed cutaway '{d.get('label', '')}': no room left on V2 after re-timing the dialogue.")
            else:
                decisions[i] = _retime(d, clips[d["clipId"]], d["timelineStartSeconds"], keep)
                notes.append(f"Shortened cutaway '{d.get('label', '')}' to {decisions[i]['durationSeconds']:.2f}s so V2 doesn't overlap.")
    return [d for i, d in enumerate(decisions) if i not in drop]


def find_jump_cuts(decisions: list[dict], clips: dict) -> list[dict]:
    """Consecutive dialogue edits from the same clip whose source isn't
    continuous: same camera and composition, different moment — a jump cut."""
    v1 = sorted((d for d in decisions if d.get("lane", DIALOGUE_LANE) == DIALOGUE_LANE),
                key=lambda d: d["timelineStartSeconds"])
    cuts = []
    for a, b in zip(v1, v1[1:]):
        if a.get("clipId") != b.get("clipId") or a.get("clipId") not in clips:
            continue
        fps = clips[a["clipId"]].fps or 24.0
        a_out = media.tc_to_seconds(a["sourceOutTc"], fps)
        b_in = media.tc_to_seconds(b["sourceInTc"], fps)
        if a_out is None or b_in is None or abs(b_in - a_out) <= 1.5 / fps:
            continue
        cuts.append({"at": b["timelineStartSeconds"], "clipId": a["clipId"], "from": a.get("label", ""),
                     "to": b.get("label", ""), "sourceJump": round(b_in - a_out, 3)})
    return cuts


def _free(decisions: list[dict], a: float, b: float, ignore: dict | None = None) -> bool:
    return all(
        d is ignore or d.get("lane") != BROLL_LANE or _end(d) <= a + 1e-6 or d["timelineStartSeconds"] >= b - 1e-6
        for d in decisions
    )


def _window(decisions: list[dict], at: float, total: float, ignore: dict | None = None) -> tuple[float, float]:
    """The free V2 span around time `at`."""
    lo, hi = 0.0, total
    for d in decisions:
        if d is ignore or d.get("lane") != BROLL_LANE:
            continue
        if _end(d) <= at + 1e-6:
            lo = max(lo, _end(d))
        elif d["timelineStartSeconds"] >= at - 1e-6:
            hi = min(hi, d["timelineStartSeconds"])
    return lo, hi


def _covers(d: dict, at: float) -> bool:
    return (d.get("lane") == BROLL_LANE and d["timelineStartSeconds"] <= at - COVER_MIN_SIDE + 1e-6
            and _end(d) >= at + COVER_MIN_SIDE - 1e-6)


def _used_ranges(decisions: list[dict], clips: dict) -> list[tuple[str, float, float]]:
    used = []
    for d in decisions:
        if d.get("clipId") not in clips:
            continue
        fps = clips[d["clipId"]].fps or 24.0
        a, b = media.tc_to_seconds(d["sourceInTc"], fps), media.tc_to_seconds(d["sourceOutTc"], fps)
        if a is not None and b is not None:
            used.append((d["clipId"], a, b))
    return used


def _cutaway_material(clips: dict, visual: list[dict], assessment: dict) -> list[dict]:
    """Logged visual moments usable as a cutaway, best first: clips judged to
    have no reliable dialogue, then uncertain ones; never dialogue clips."""
    rank = {dialogue.NON_DIALOGUE: 0, dialogue.UNCERTAIN: 1}
    out = []
    for v in visual:
        cid = v.get("clipId")
        status = assessment.get(cid, {}).get("status")
        if cid not in clips or status not in rank or v.get("kind") not in COVER_KINDS:
            continue
        clip = clips[cid]
        at = media.tc_to_seconds(str(v.get("atTc", "")), clip.fps or 24.0)
        if at is None or getattr(clip, "state", "analyzed") != "analyzed":
            continue
        out.append({"clipId": cid, "at": at, "kind": v["kind"], "label": str(v.get("label", "")),
                    "key": (rank[status], COVER_KINDS.index(v["kind"]), cid, at)})
    out.sort(key=lambda m: m["key"])
    return out


def cover_jump_cuts(decisions: list[dict], clips: dict, visual: list[dict], assessment: dict) -> tuple[list[dict], list[str], list[dict]]:
    """Covers each jump cut on V2. Returns decisions, notes and a per-cut report."""
    decisions = [dict(d) for d in decisions]
    notes: list[str] = []
    report: list[dict] = []
    total = max((_end(d) for d in decisions if d.get("lane", DIALOGUE_LANE) == DIALOGUE_LANE), default=0.0)
    material = _cutaway_material(clips, visual, assessment)
    added = 0
    for cut in find_jump_cuts(decisions, clips):
        at = cut["at"]
        entry = {**cut, "coveredBy": None, "how": "uncovered"}
        report.append(entry)
        existing = next((d for d in decisions if _covers(d, at)), None)
        if existing:
            entry.update(coveredBy=existing.get("label", ""), how="already covered")
            continue

        # 1) Slide a nearby cutaway onto the cut (its length unchanged).
        moved = None
        nearby = sorted(
            (d for d in decisions if d.get("lane") == BROLL_LANE and d["durationSeconds"] >= 2 * COVER_MIN_SIDE
             and min(abs(d["timelineStartSeconds"] - at), abs(_end(d) - at)) <= MAX_COVER_SHIFT),
            key=lambda d: abs(d["timelineStartSeconds"] - at),
        )
        for d in nearby:
            lo, hi = _window(decisions, at, total, ignore=d)
            lead = min(COVER_LEAD, d["durationSeconds"] / 2)
            start = max(lo, at - lead)
            if start + d["durationSeconds"] > hi:
                start = hi - d["durationSeconds"]
            if (start >= lo - 1e-6 and start <= at - COVER_MIN_SIDE + 1e-6
                    and start + d["durationSeconds"] >= at + COVER_MIN_SIDE - 1e-6
                    and abs(start - d["timelineStartSeconds"]) <= MAX_COVER_SHIFT):
                old = d["timelineStartSeconds"]
                d["timelineStartSeconds"] = round(start, 6)
                moved = d
                notes.append(
                    f"Moved cutaway '{d.get('label', '')}' from {old:.2f}s to {start:.2f}s to cover the jump cut at {at:.2f}s."
                )
                entry.update(coveredBy=d.get("label", ""), how=f"moved existing cutaway ({old:.2f}s → {start:.2f}s)")
                break
        if moved:
            continue

        # 2) Add a cutaway from a logged visual moment not already on screen.
        lo, hi = _window(decisions, at, total)
        start = max(lo, at - COVER_LEAD)
        room = hi - start
        placed = None
        used = _used_ranges(decisions, clips)
        in_cut = {c for c, _, _ in used}
        # Prefer a clip the cut doesn't show yet (stable: material is pre-sorted).
        for m in sorted(material, key=lambda m: (m["key"][0], m["clipId"] in in_cut)):
            clip = clips[m["clipId"]]
            fps = clip.fps or 24.0
            clip_len = clip.duration_seconds or 0
            want = min(COVER_LEAD + COVER_TAIL, room, clip_len)
            if start > at - COVER_MIN_SIDE + 1e-6 or start + want < at + COVER_MIN_SIDE - 1e-6:
                continue
            src_in = max(0.0, min(m["at"] - COVER_LEAD, clip_len - want))
            in_tc = media.seconds_to_tc(src_in, fps)
            src_in = media.tc_to_seconds(in_tc, fps) or 0.0
            if any(c == m["clipId"] and a < src_in + want and src_in < b for c, a, b in used):
                continue  # don't repeat a shot already in the cut
            d = _retime({"lane": BROLL_LANE, "clipId": m["clipId"], "sourceInTc": in_tc}, clip, start, want)
            if d["durationSeconds"] < 2 * COVER_MIN_SIDE or not _free(decisions, start, start + d["durationSeconds"]):
                continue
            added += 1
            d.update(id=f"cutaway-{added}", label=f"Cutaway: {m['label'][:60]}")
            placed = d
            break
        if placed:
            decisions.append(placed)
            notes.append(
                f"Added cutaway '{placed['label']}' ({placed['sourceInTc']}–{placed['sourceOutTc']}) at "
                f"{placed['timelineStartSeconds']:.2f}s to cover the jump cut at {at:.2f}s."
            )
            entry.update(coveredBy=placed["label"], how="added cutaway")
        else:
            notes.append(
                f"Jump cut at {at:.2f}s ('{cut['from']}' → '{cut['to']}', same clip) is uncovered: "
                "no suitable cutaway material fits on V2."
            )
    return decisions, notes, report


def refine(decisions: list[dict], clips: dict, transcript: list[dict], visual: list[dict]) -> tuple[list[dict], list[str], dict]:
    """The whole pass. Input must already be validated (pipeline._validate_decisions)."""
    if not decisions:
        return decisions, [], {"edits": [], "jumpCuts": [], "dialogue": {}}
    assessment = dialogue.assess_project(clips, transcript, visual)
    snapped, notes, edits = snap_dialogue(decisions, clips, transcript)
    laid = relayout(decisions, snapped, clips)
    laid = fit_overlays(laid, clips, notes)
    covered, cover_notes, cuts = cover_jump_cuts(laid, clips, visual, assessment)
    return covered, notes + cover_notes, {"edits": edits, "jumpCuts": cuts, "dialogue": assessment}
