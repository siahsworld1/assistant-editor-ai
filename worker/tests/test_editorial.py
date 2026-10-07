"""Editorial-quality pass: phrase-boundary editing, jump-cut coverage and
dialogue validity (worker/editorial.py, worker/dialogue.py).

The saved-v3 regression mirrors the packaged-validation cut exactly — the
same five dialogue edits, two cutaways, clip lengths and transcript segment
timings and end punctuation — with neutral placeholder words instead of the
footage's real transcript. To replay the real saved files as well, point
AE_V3_ANALYSIS at the media folder's .ae_analysis.json and AE_V3_EDIT_STATE at
the project's edit-state JSON.

Run from worker/: `.venv/bin/python -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

import dialogue  # noqa: E402
import editorial  # noqa: E402
import media  # noqa: E402
import pipeline  # noqa: E402
from providers.base import TranscriptSegment  # noqa: E402
from store import STORE, ClipState  # noqa: E402
from tests.fakes import FakeReasoningProvider, FakeTranscriptionProvider  # noqa: E402

FPS = 23.976


def clip(cid: str, seconds: float, **kw) -> ClipState:
    return ClipState(id=cid, filename=f"{cid}.MP4", rel_path=f"{cid}.MP4", role="interview",
                     duration_seconds=seconds, camera="HEVC", resolution="3840x2160", fps=FPS,
                     state="analyzed", has_transcript=kw.pop("has_transcript", True), **kw)


def seg(cid: str, start: str, end: str, text: str, **extra) -> dict:
    return {"clipId": cid, "speaker": "S", "startTc": start, "endTc": end, "text": text,
            "confidence": extra.pop("confidence", 0.75), **extra}


def ev(lane, cid, tin, tout, start, label, dur=None) -> dict:
    a, b = media.tc_to_seconds(tin, FPS), media.tc_to_seconds(tout, FPS)
    return {"lane": lane, "clipId": cid, "label": label, "sourceInTc": tin, "sourceOutTc": tout,
            "timelineStartSeconds": start, "durationSeconds": round(b - a, 6) if dur is None else dur}


def secs(tc: str) -> float:
    return media.tc_to_seconds(tc, FPS)


# --------------------------------------------------------------------------
# The saved v3 cut, mirrored (timings + end punctuation, placeholder words).
# --------------------------------------------------------------------------

_V3_SEGMENTS = {
    "clip-001": [
        ("00:00:00:00", "00:00:09:00", "."), ("00:00:09:00", "00:00:13:19", "."),
        ("00:00:13:19", "00:00:19:12", ""), ("00:00:19:12", "00:00:23:20", "."),
        ("00:00:23:20", "00:00:30:03", ""), ("00:00:30:03", "00:00:32:10", "."),
    ],
    "clip-002": [
        ("00:00:00:00", "00:00:01:04", "?"), ("00:00:04:05", "00:00:10:17", "."),
        ("00:00:10:17", "00:00:13:16", "."), ("00:00:16:00", "00:00:19:06", "?"),
        ("00:00:19:06", "00:00:21:15", ""), ("00:00:21:15", "00:00:24:19", "."),
        ("00:00:24:19", "00:00:27:07", ""), ("00:00:27:07", "00:00:29:23", ""),
        ("00:00:29:23", "00:00:32:06", ""), ("00:00:32:06", "00:00:34:12", ","),
        ("00:00:34:12", "00:00:35:21", ","), ("00:00:35:21", "00:00:37:21", ","),
        ("00:00:37:21", "00:00:39:11", "."), ("00:00:39:11", "00:00:41:09", ""),
        ("00:00:41:09", "00:00:42:17", "."), ("00:00:42:17", "00:00:45:00", ""),
        ("00:00:45:00", "00:00:47:09", ""), ("00:00:47:09", "00:00:49:15", ""),
        ("00:00:49:15", "00:00:52:00", ""), ("00:00:52:00", "00:00:55:02", "."),
        ("00:00:55:02", "00:00:58:01", "?"), ("00:00:58:01", "00:01:02:09", "."),
        ("00:01:02:15", "00:01:04:13", ""), ("00:01:04:13", "00:01:06:10", "."),
        ("00:01:06:10", "00:01:08:09", ""), ("00:01:08:09", "00:01:11:02", ","),
        ("00:01:11:02", "00:01:14:00", ""), ("00:01:14:00", "00:01:17:02", "."),
        ("00:01:17:02", "00:01:20:03", "."), ("00:01:20:03", "00:01:21:20", ","),
        ("00:01:21:20", "00:01:23:22", "."), ("00:01:23:22", "00:01:26:00", "."),
        ("00:01:26:13", "00:01:29:22", ""), ("00:01:29:22", "00:01:33:02", "."),
        ("00:01:33:02", "00:01:34:11", "."), ("00:01:34:11", "00:01:37:06", ","),
        ("00:01:37:06", "00:01:40:00", "."), ("00:01:40:00", "00:01:41:08", "."),
    ],
}


def v3_material():
    clips = {
        "clip-001": clip("clip-001", 32.4), "clip-002": clip("clip-002", 101.4),
        "clip-003": clip("clip-003", 16.3), "clip-004": clip("clip-004", 34.1),
        "clip-005": clip("clip-005", 9.4), "clip-006": clip("clip-006", 9.1),
    }
    transcript = []
    for cid, rows in _V3_SEGMENTS.items():
        for n, (a, b, p) in enumerate(rows):
            transcript.append(seg(cid, a, b, f"{cid} phrase {n + 1} words{p}"))
    # The B-roll clips' Whisper output on silence, as saved.
    transcript += [
        seg("clip-003", "00:00:00:00", "00:00:16:00", "Background chatter near the display table, so."),
        seg("clip-004", "00:00:00:00", "00:00:02:00", "합니다.", confidence=0.0),
        seg("clip-004", "00:00:30:00", "00:00:34:00", "Abone olmayı ve videoyu beğenmeyi unutmayın.", confidence=0.68),
        seg("clip-005", "00:00:00:00", "00:00:09:10", "Thanks for watching and don't forget to like and subscribe!", confidence=0.64),
        seg("clip-006", "00:00:00:00", "00:00:09:00", "ご視聴ありがとうございました", confidence=0.63),
    ]
    visual = [
        {"clipId": "clip-002", "kind": "face", "label": "Direct address", "atTc": "00:00:14:11"},
        {"clipId": "clip-003", "kind": "b-roll", "label": "Historical display board", "atTc": "00:00:06:23"},
        {"clipId": "clip-004", "kind": "b-roll", "label": "Park sign establishing", "atTc": "00:00:04:20"},
        {"clipId": "clip-004", "kind": "b-roll", "label": "Park sign detail", "atTc": "00:00:29:05"},
        {"clipId": "clip-005", "kind": "b-roll", "label": "Community house exterior", "atTc": "00:00:02:16"},
        {"clipId": "clip-006", "kind": "b-roll", "label": "Logo on window", "atTc": "00:00:01:07"},
    ]
    decisions = [
        ev("interview", "clip-002", "00:01:02:00", "00:01:12:00", 0, "e1 opening"),
        ev("interview", "clip-002", "00:00:25:00", "00:00:32:00", 10, "e2 highway"),
        ev("interview", "clip-002", "00:00:43:00", "00:00:49:00", 17, "e3 stories"),
        ev("b-roll", "clip-003", "00:00:06:23", "00:00:11:15", 17.5, "b1 display board"),
        ev("interview", "clip-001", "00:00:22:00", "00:00:28:00", 23, "e5 team"),
        ev("interview", "clip-002", "00:01:28:00", "00:01:32:00", 29, "e6 invitation"),
        ev("b-roll", "clip-004", "00:00:04:20", "00:00:08:00", 29.5, "b2 park sign"),
    ]
    return clips, transcript, visual, decisions


def assert_cut_is_sound(tc: unittest.TestCase, decisions, clips, transcript):
    """No mid-phrase dialogue edge, valid ranges, no same-lane overlap, V2 inside V1."""
    for d in decisions:
        c = clips[d["clipId"]]
        a, b = media.tc_to_seconds(d["sourceInTc"], c.fps), media.tc_to_seconds(d["sourceOutTc"], c.fps)
        tc.assertIsNotNone(a)
        tc.assertLess(a, b)
        tc.assertGreaterEqual(a, 0)
        tc.assertLessEqual(b, c.duration_seconds + 1e-6, d["label"])
        tc.assertAlmostEqual(d["durationSeconds"], b - a, places=5)  # audio stays locked to picture
        if d["lane"] == "interview":
            segs = editorial.clip_segments(d["clipId"], transcript, c.fps)
            tc.assertIsNone(editorial._inside(segs, a), f"{d['label']} starts mid-phrase")
            tc.assertIsNone(editorial._inside(segs, b), f"{d['label']} ends mid-phrase")
    total = max(d["timelineStartSeconds"] + d["durationSeconds"] for d in decisions if d["lane"] == "interview")
    for lane in ("interview", "b-roll"):
        evs = sorted((d for d in decisions if d["lane"] == lane), key=lambda d: d["timelineStartSeconds"])
        for x, y in zip(evs, evs[1:]):
            tc.assertLessEqual(x["timelineStartSeconds"] + x["durationSeconds"], y["timelineStartSeconds"] + 1e-6,
                               f"{lane} overlap: {x['label']} / {y['label']}")
    for d in decisions:
        if d["lane"] == "b-roll":
            tc.assertGreaterEqual(d["timelineStartSeconds"], 0)
            tc.assertLessEqual(d["timelineStartSeconds"] + d["durationSeconds"], total + editorial.OVERLAY_TOLERANCE)


class TestSavedV3Regression(unittest.TestCase):
    def setUp(self):
        self.clips, self.transcript, self.visual, self.decisions = v3_material()
        self.out, self.notes, self.report = editorial.refine(self.decisions, self.clips, self.transcript, self.visual)
        self.v1 = sorted((d for d in self.out if d["lane"] == "interview"), key=lambda d: d["timelineStartSeconds"])

    def test_every_dialogue_edit_lands_on_whole_sentences(self):
        self.assertEqual(
            [(d["label"], d["sourceInTc"], d["sourceOutTc"]) for d in self.v1],
            [
                ("e1 opening", "00:01:02:15", "00:01:17:02"),     # interviewer fragment dropped; sentence finished
                ("e2 highway", "00:00:24:19", "00:00:39:11"),     # now reaches the highway and its outcome
                ("e3 stories", "00:00:42:17", "00:00:55:02"),
                ("e5 team", "00:00:23:20", "00:00:32:09"),        # clamped to the clip's last frame
                ("e6 invitation", "00:01:26:13", "00:01:33:02"),
            ],
        )
        assert_cut_is_sound(self, self.out, self.clips, self.transcript)

    def test_opening_interviewer_fragment_is_removed(self):
        e1 = self.v1[0]
        self.assertGreater(secs(e1["sourceInTc"]), secs("00:01:02:09"))  # end of the question run
        self.assertIn("moved forward past a partial phrase", " ".join(self.notes))

    def test_v1_stays_back_to_back_and_reports_the_new_length(self):
        t = 0.0
        for d in self.v1:
            self.assertAlmostEqual(d["timelineStartSeconds"], t, places=5)
            t += d["durationSeconds"]
        self.assertAlmostEqual(t, 56.58, places=1)  # over the 30s target rather than cutting thoughts

    def test_both_same_camera_jump_cuts_are_found_and_covered(self):
        cuts = self.report["jumpCuts"]
        self.assertEqual([round(c["at"], 2) for c in cuts], [14.46, 29.12])
        self.assertTrue(all(c["clipId"] == "clip-002" for c in cuts))
        self.assertEqual(cuts[0]["how"], "added cutaway")
        self.assertEqual(cuts[0]["coveredBy"], "Cutaway: Community house exterior")
        self.assertTrue(cuts[1]["how"].startswith("moved existing cutaway"))
        self.assertEqual(cuts[1]["coveredBy"], "b1 display board")
        broll = [d for d in self.out if d["lane"] == "b-roll"]
        for c in cuts:
            cover = next(d for d in broll if d["label"] == c["coveredBy"])
            self.assertLessEqual(cover["timelineStartSeconds"], c["at"] - editorial.COVER_MIN_SIDE)
            self.assertGreaterEqual(cover["timelineStartSeconds"] + cover["durationSeconds"], c["at"] + 1.0)

    def test_cut_between_different_clips_is_not_a_jump_cut(self):
        # e3 (clip-002) → e5 (clip-001) and e5 → e6 change camera.
        self.assertEqual(len(editorial.find_jump_cuts(self.out, self.clips)), 2)

    def test_b_roll_clips_are_recognised(self):
        status = {k: v["status"] for k, v in self.report["dialogue"].items()}
        self.assertEqual(status["clip-004"], dialogue.NON_DIALOGUE)
        self.assertEqual(status["clip-005"], dialogue.NON_DIALOGUE)
        self.assertEqual(status["clip-006"], dialogue.NON_DIALOGUE)
        self.assertEqual(status["clip-002"], dialogue.DIALOGUE)

    def test_every_adjustment_is_in_the_change_notes(self):
        self.assertEqual(sum(n.startswith("Phrase boundaries for") for n in self.notes), 5)
        self.assertTrue(any(n.startswith("Added cutaway") for n in self.notes))
        self.assertTrue(any(n.startswith("Moved cutaway 'b1 display board'") for n in self.notes))

    def test_the_whole_build_path_applies_the_pass_and_exports_stay_consistent(self):
        STORE.reset()
        for c in self.clips.values():
            STORE.upsert_clip(c)
        STORE.transcript, STORE.visual_evidence = self.transcript, self.visual
        STORE.selects = [{"id": "sel-01", "clipId": "clip-002", "speaker": "S", "startTc": "00:00:19:00",
                          "endTc": "00:00:39:00", "durationSeconds": 20, "transcriptExcerpt": "x", "score": 90,
                          "category": "context"}]
        STORE.stories = [{"id": "story-01", "title": "T", "premise": "", "beats": [
            {"label": "b", "intent": "", "selectIds": ["sel-01"]}]}]
        STORE.complete()
        fake = FakeReasoningProvider(responses=[{"summary": "s", "changes": [], "decisions": self.decisions}])
        res = pipeline.build_timeline("p", "story-01", 30, "Create a 30-second rough cut", reasoning_provider=fake)
        brief = fake.calls[0][1][0].text
        self.assertIn('phrase 00:00:19:06–00:00:21:15 "clip-002 phrase 5 words"', brief)  # real cut points
        self.assertIn("clip-005 | clip-005.MP4 | 9.4 | no (likely B-roll)", brief)
        self.assertEqual(res["status"], "built")
        self.assertEqual(
            [(d["sourceInTc"], d["sourceOutTc"]) for d in res["decisions"] if d["lane"] == "interview"],
            [(d["sourceInTc"], d["sourceOutTc"]) for d in self.out if d["lane"] == "interview"],
        )
        assert_cut_is_sound(self, res["decisions"], self.clips, self.transcript)
        self.assertTrue(any("Phrase boundaries" in c for c in res["changes"]))


@unittest.skipUnless(os.environ.get("AE_V3_ANALYSIS") and os.environ.get("AE_V3_EDIT_STATE"),
                     "set AE_V3_ANALYSIS and AE_V3_EDIT_STATE to replay the real saved v3 cut")
class TestRealSavedV3(unittest.TestCase):
    def test_replay(self):
        a = json.loads(Path(os.environ["AE_V3_ANALYSIS"]).read_text())
        e = json.loads(Path(os.environ["AE_V3_EDIT_STATE"]).read_text())
        fields = ClipState.__dataclass_fields__
        rows = a["clips"].values() if isinstance(a["clips"], dict) else a["clips"]
        clips = {c["id"]: ClipState(**{k: v for k, v in c.items() if k in fields}) for c in rows}
        v3 = next(v for v in e["versions"] if v["id"] == "v3")
        decisions = (v3.get("timeline") or v3)["decisions"]
        out, notes, report = editorial.refine(decisions, clips, a["transcript"], a["visualEvidence"])
        assert_cut_is_sound(self, out, clips, a["transcript"])
        first = min((d for d in out if d["lane"] == "interview"), key=lambda d: d["timelineStartSeconds"])
        self.assertEqual(first["sourceInTc"], "00:01:02:15")
        self.assertEqual(len(report["jumpCuts"]), 2)
        self.assertTrue(all(c["coveredBy"] for c in report["jumpCuts"]))


# --------------------------------------------------------------------------
# Focused cases
# --------------------------------------------------------------------------

def simple_segments():
    # Two sentences, the first split into clauses/phrases, a question before them.
    return [
        seg("c1", "00:00:00:00", "00:00:02:00", "So what happened that day?"),
        seg("c1", "00:00:02:12", "00:00:04:00", "We came down early,"),
        seg("c1", "00:00:04:00", "00:00:06:00", "and the whole street"),
        seg("c1", "00:00:06:00", "00:00:08:00", "was already gone."),
        seg("c1", "00:00:08:00", "00:00:10:00", "Nobody told us."),
    ]


class TestPhraseBoundaries(unittest.TestCase):
    def setUp(self):
        self.clips = {"c1": clip("c1", 12.0)}
        self.tr = simple_segments()

    def snap(self, tin, tout):
        out, notes, rep = editorial.snap_dialogue([ev("interview", "c1", tin, tout, 0, "x")], self.clips, self.tr)
        return out[0], notes

    def test_mid_phrase_out_point_extends_to_the_sentence_end(self):
        d, notes = self.snap("00:00:02:12", "00:00:05:00")
        self.assertEqual(d["sourceOutTc"], "00:00:08:00")
        self.assertIn("extended to the end of a sentence", notes[0])
        self.assertAlmostEqual(d["durationSeconds"], secs("00:00:08:00") - secs("00:00:02:12"), places=5)

    def test_mid_phrase_in_point_moves_to_the_sentence_start(self):
        d, _ = self.snap("00:00:03:00", "00:00:08:00")
        self.assertEqual(d["sourceInTc"], "00:00:02:12")

    def test_edits_already_on_boundaries_are_untouched(self):
        d, notes = self.snap("00:00:02:12", "00:00:08:00")
        self.assertEqual((d["sourceInTc"], d["sourceOutTc"], notes), ("00:00:02:12", "00:00:08:00", []))

    def test_a_cut_in_the_silence_between_phrases_is_left_alone(self):
        d, notes = self.snap("00:00:02:04", "00:00:08:00")
        self.assertEqual((d["sourceInTc"], notes), ("00:00:02:04", []))

    def test_growth_is_capped_so_a_short_edit_cannot_balloon(self):
        long = [seg("c2", "00:00:00:00", "00:00:01:00", "Start"),
                seg("c2", "00:00:01:00", "00:00:09:00", "a very long run-on phrase that ends here.")]
        clips = {"c2": clip("c2", 10.0)}
        out, _, _ = editorial.snap_dialogue([ev("interview", "c2", "00:00:00:00", "00:00:01:12", 0, "x")], clips, long)
        # The sentence end is 7.5s away (past 2.5 × 1.5s and 1.5s + 4s), and trimming would leave less
        # than the usual minimum — so the nearest phrase edge wins rather than staying mid-phrase.
        self.assertEqual(out[0]["sourceOutTc"], "00:00:01:00")

    def test_never_leaves_the_clip(self):
        tr = [seg("c3", "00:00:00:00", "00:00:05:10", "Ends past the media.")]
        clips = {"c3": clip("c3", 5.0)}
        out, _, _ = editorial.snap_dialogue([ev("interview", "c3", "00:00:00:00", "00:00:03:00", 0, "x")], clips, tr)
        self.assertLessEqual(secs(out[0]["sourceOutTc"]), 5.0)

    def test_filler_segments_are_not_used_as_cut_points(self):
        tr = self.tr + [seg("c1", "00:00:10:00", "00:00:11:20", "Thanks for watching!")]
        segs = editorial.clip_segments("c1", tr, FPS)
        self.assertEqual(len(segs), 5)


class TestQuestions(unittest.TestCase):
    def setUp(self):
        self.clips = {"c1": clip("c1", 12.0)}
        self.tr = simple_segments()

    def test_an_edit_starting_inside_the_question_skips_to_the_answer(self):
        out, notes, _ = editorial.snap_dialogue(
            [ev("interview", "c1", "00:00:01:12", "00:00:08:00", 0, "x")], self.clips, self.tr)
        self.assertEqual(out[0]["sourceInTc"], "00:00:02:12")
        self.assertIn("moved forward past a partial phrase", notes[0])

    def test_extending_back_never_pulls_in_a_question(self):
        segs = editorial.clip_segments("c1", self.tr, FPS)
        cand = editorial.snap_in(segs, secs("00:00:02:20"), secs("00:00:08:00"))
        self.assertEqual(cand[3], "00:00:02:12")

    def test_a_question_the_director_deliberately_included_is_kept(self):
        out, notes, _ = editorial.snap_dialogue(
            [ev("interview", "c1", "00:00:00:00", "00:00:08:00", 0, "x")], self.clips, self.tr)
        self.assertEqual((out[0]["sourceInTc"], notes), ("00:00:00:00", []))

    def test_extending_forward_stops_before_the_next_question(self):
        tr = [seg("c4", "00:00:00:00", "00:00:02:00", "It was a good day"),
              seg("c4", "00:00:02:00", "00:00:04:00", "and then you asked?"),
              seg("c4", "00:00:04:00", "00:00:06:00", "Answer.")]
        clips = {"c4": clip("c4", 8.0)}
        out, _, _ = editorial.snap_dialogue([ev("interview", "c4", "00:00:00:00", "00:00:01:12", 0, "x")], clips, tr)
        self.assertEqual(out[0]["sourceOutTc"], "00:00:02:00")


class TestJumpCuts(unittest.TestCase):
    def setUp(self):
        self.clips = {"a": clip("a", 60.0), "b": clip("b", 20.0, has_transcript=False), "c": clip("c", 60.0)}
        self.visual = [{"clipId": "b", "kind": "b-roll", "label": "Street", "atTc": "00:00:05:00"}]
        self.assess = dialogue.assess_project(self.clips, [], self.visual)

    def v1(self):
        return [ev("interview", "a", "00:00:00:00", "00:00:05:00", 0, "one"),
                ev("interview", "a", "00:00:20:00", "00:00:25:00", 5, "two")]

    def test_detection(self):
        self.assertEqual([c["at"] for c in editorial.find_jump_cuts(self.v1(), self.clips)], [5])
        contiguous = [ev("interview", "a", "00:00:00:00", "00:00:05:00", 0, "one"),
                      ev("interview", "a", "00:00:05:00", "00:00:10:00", 5, "two")]
        self.assertEqual(editorial.find_jump_cuts(contiguous, self.clips), [])
        other_cam = [ev("interview", "a", "00:00:00:00", "00:00:05:00", 0, "one"),
                     ev("interview", "c", "00:00:20:00", "00:00:25:00", 5, "two")]
        self.assertEqual(editorial.find_jump_cuts(other_cam, self.clips), [])

    def test_adds_a_cutaway_from_a_non_dialogue_clip(self):
        out, notes, rep = editorial.cover_jump_cuts(self.v1(), self.clips, self.visual, self.assess)
        added = [d for d in out if d["lane"] == "b-roll"]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]["clipId"], "b")
        self.assertAlmostEqual(added[0]["timelineStartSeconds"], 4.0)  # 1s before the cut
        self.assertGreaterEqual(added[0]["timelineStartSeconds"] + added[0]["durationSeconds"], 6.0)
        self.assertEqual(rep[0]["how"], "added cutaway")
        self.assertEqual([d for d in out if d["lane"] == "interview"], self.v1())  # V1 untouched

    def test_slides_a_nearby_existing_cutaway_instead_of_adding_one(self):
        decisions = self.v1() + [ev("b-roll", "b", "00:00:02:00", "00:00:05:00", 6.5, "near")]
        out, notes, rep = editorial.cover_jump_cuts(decisions, self.clips, self.visual, self.assess)
        near = next(d for d in out if d["label"] == "near")
        self.assertAlmostEqual(near["timelineStartSeconds"], 4.0)
        self.assertEqual(len([d for d in out if d["lane"] == "b-roll"]), 1)

    def test_already_covered_cut_is_left_alone(self):
        decisions = self.v1() + [ev("b-roll", "b", "00:00:02:00", "00:00:05:00", 4.0, "cover")]
        out, notes, rep = editorial.cover_jump_cuts(decisions, self.clips, self.visual, self.assess)
        self.assertEqual((rep[0]["how"], notes), ("already covered", []))

    def test_insufficient_b_roll_leaves_v1_intact_and_says_so(self):
        out, notes, rep = editorial.cover_jump_cuts(self.v1(), self.clips, [], self.assess)
        self.assertEqual(out, self.v1())
        self.assertIn("Jump cut at 5.00s", notes[0])
        self.assertIn("uncovered", notes[0])
        self.assertEqual(rep[0]["how"], "uncovered")

    def test_dialogue_clips_are_never_used_as_cutaways(self):
        visual = [{"clipId": "c", "kind": "b-roll", "label": "Interview room", "atTc": "00:00:05:00"}]
        tr = [seg("c", "00:00:00:00", "00:00:10:00", "Real speech here.")]
        assess = dialogue.assess_project(self.clips, tr, visual)
        out, notes, rep = editorial.cover_jump_cuts(self.v1(), self.clips, visual, assess)
        self.assertEqual(rep[0]["how"], "uncovered")

    def test_a_cutaway_never_overlaps_existing_v2(self):
        # Existing V2 right after the cut leaves only 0.8s of room past it.
        decisions = self.v1() + [ev("b-roll", "b", "00:00:12:00", "00:00:14:00", 5.8, "busy")]
        out, notes, rep = editorial.cover_jump_cuts(decisions, self.clips, self.visual, self.assess)
        broll = sorted((d for d in out if d["lane"] == "b-roll"), key=lambda d: d["timelineStartSeconds"])
        for x, y in zip(broll, broll[1:]):
            self.assertLessEqual(x["timelineStartSeconds"] + x["durationSeconds"], y["timelineStartSeconds"] + 1e-6)

    def test_a_shot_already_in_the_cut_is_not_repeated(self):
        decisions = self.v1() + [ev("b-roll", "b", "00:00:04:00", "00:00:07:00", 20, "far away")]
        out, notes, rep = editorial.cover_jump_cuts(decisions, self.clips, self.visual, self.assess)
        self.assertEqual(rep[0]["how"], "uncovered")

    def test_relayout_keeps_cutaways_over_the_same_words_and_v2_inside_the_cut(self):
        clips, tr, visual, decisions = v3_material()
        out, _, _ = editorial.refine(decisions, clips, tr, visual)
        b2 = next(d for d in out if d["label"] == "b2 park sign")
        e6 = next(d for d in out if d["label"] == "e6 invitation")
        # b2 sat 0.5s into e6's source 01:28:00 → still over source 01:28:12.
        self.assertAlmostEqual(
            b2["timelineStartSeconds"] - e6["timelineStartSeconds"],
            secs("00:01:28:00") + 0.5 - secs(e6["sourceInTc"]), places=5)


def thought_segments(texts: list[tuple[str, str, str]], cid: str = "t1") -> list[dict]:
    return [seg(cid, a, b, t) for a, b, t in texts]


class TestCompleteThoughts(unittest.TestCase):
    """A phrase edge is not always a thought's edge (live Director build v1.3)."""

    def setUp(self):
        self.clips = {"t1": clip("t1", 30.0)}

    def run_edit(self, tr, tin, tout, cid="t1", clips=None):
        out, notes, _ = editorial.snap_dialogue([ev("interview", cid, tin, tout, 0, "x")], clips or self.clips, tr)
        return out[0], " ".join(notes)

    def test_comma_followed_by_continuation_is_carried_to_the_sentence_end(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "When the storm rolled in,"),
                               ("00:00:02:00", "00:00:04:00", "it flooded the street."),
                               ("00:00:04:00", "00:00:06:00", "Then we rebuilt.")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual(d["sourceOutTc"], "00:00:04:00")
        self.assertIn("trailing ','", notes)

    def test_obviously_unfinished_wording_is_completed(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "We are going over to"),
                               ("00:00:02:00", "00:00:04:00", "finish the mural and we're glad it's done."),
                               ("00:00:04:00", "00:00:06:00", "It is a big day.")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual(d["sourceOutTc"], "00:00:04:00")
        self.assertIn("unfinished '…to'", notes)
        self.assertAlmostEqual(d["durationSeconds"], 4.0, places=5)

    def test_a_complete_sentence_is_left_alone(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "We rebuilt the whole street."),
                               ("00:00:02:00", "00:00:04:00", "and then more,")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual((d["sourceInTc"], d["sourceOutTc"], notes), ("00:00:00:00", "00:00:02:00", ""))

    def test_comma_before_a_new_coordinated_clause_keeps_the_directors_trim(self):
        # "…closed the old bakery, and today…" — the Director cut the second clause on purpose.
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "It closed the old bakery,"),
                               ("00:00:02:00", "00:00:04:00", "and today we're painting,"),
                               ("00:00:04:00", "00:00:06:00", "and it's a bright new start.")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual((d["sourceOutTc"], notes), ("00:00:02:00", ""))

    def test_mid_sentence_in_point_goes_back_to_the_sentence_start(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "It was cold."),
                               ("00:00:02:00", "00:00:04:12", "The corner shop is a place that's"),
                               ("00:00:04:12", "00:00:07:00", "been open a long time.")])
        d, notes = self.run_edit(tr, "00:00:04:12", "00:00:07:00")
        self.assertEqual(d["sourceInTc"], "00:00:02:00")
        self.assertIn("unfinished '…that's'", notes)

    def test_an_interviewer_question_is_never_pulled_back_in(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "So what brings you out?"),
                               ("00:00:02:00", "00:00:04:00", "We came out today to"),
                               ("00:00:04:00", "00:00:06:00", "see the new garden.")])
        d, _ = self.run_edit(tr, "00:00:04:00", "00:00:06:00")
        self.assertEqual(d["sourceInTc"], "00:00:02:00")  # back to the answer's start, not into the question
        d, notes = self.run_edit(tr, "00:00:02:00", "00:00:06:00")
        self.assertEqual((d["sourceInTc"], notes), ("00:00:02:00", ""))  # right after a question: nothing to do
        tr2 = thought_segments([("00:00:00:00", "00:00:02:00", "What did the flood do to the"),
                                ("00:00:02:00", "00:00:04:00", "neighborhood?"),
                                ("00:00:04:00", "00:00:06:00", "It took everything.")])
        d, _ = self.run_edit(tr2, "00:00:04:00", "00:00:06:00")
        self.assertEqual(d["sourceInTc"], "00:00:04:00")

    def test_weak_or_missing_punctuation_is_not_treated_as_evidence(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "we built it ourselves"),
                               ("00:00:02:00", "00:00:04:00", "every single board of it")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual((d["sourceOutTc"], notes), ("00:00:02:00", ""))

    def test_unfinished_but_no_sentence_end_in_reach_is_left_and_noted(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "we came here to"),
                               ("00:00:02:00", "00:00:06:00", "see it happen and then"),
                               ("00:00:06:00", "00:00:20:00", "a very long ramble with no ending")])
        d, notes = self.run_edit(tr, "00:00:00:00", "00:00:02:00")
        self.assertEqual(d["sourceOutTc"], "00:00:02:00")
        self.assertIn("out of reach — left as is", notes)

    def test_completion_stays_inside_the_clip(self):
        tr = thought_segments([("00:00:00:00", "00:00:02:00", "And this is for the"),
                               ("00:00:02:00", "00:00:05:10", "whole neighborhood.")], cid="t2")
        clips = {"t2": clip("t2", 5.0)}
        d, _ = self.run_edit(tr, "00:00:00:00", "00:00:02:00", cid="t2", clips=clips)
        self.assertLessEqual(secs(d["sourceOutTc"]), 5.0)
        self.assertGreater(secs(d["sourceOutTc"]), 4.5)

    def test_v1_v2_and_jump_cuts_are_revalidated_after_completion(self):
        clips = {"a": clip("a", 60.0), "b": clip("b", 20.0, has_transcript=False)}
        tr = thought_segments([("00:00:00:00", "00:00:03:00", "We came here to"),
                               ("00:00:03:00", "00:00:06:00", "celebrate the park."),
                               ("00:00:20:00", "00:00:24:00", "It is home again.")], cid="a")
        visual = [{"clipId": "b", "kind": "b-roll", "label": "Street", "atTc": "00:00:05:00"}]
        decisions = [ev("interview", "a", "00:00:00:00", "00:00:03:00", 0, "one"),
                     ev("b-roll", "b", "00:00:02:00", "00:00:05:00", 2.0, "cover"),  # covering the cut at 3.0
                     ev("interview", "a", "00:00:20:00", "00:00:24:00", 3.0, "two")]
        out, notes, rep = editorial.refine(decisions, clips, tr, visual)
        one = next(d for d in out if d["label"] == "one")
        two = next(d for d in out if d["label"] == "two")
        cover = next(d for d in out if d["label"] == "cover")
        self.assertEqual(one["sourceOutTc"], "00:00:06:00")
        self.assertAlmostEqual(two["timelineStartSeconds"], 6.0, places=5)  # V1 re-packed
        self.assertAlmostEqual(cover["timelineStartSeconds"], 5.0, places=5)  # still straddles the moved cut
        self.assertEqual(rep["jumpCuts"][0]["how"], "already covered")
        assert_cut_is_sound(self, out, clips, tr)


def v13_material():
    """The live Director build v1.3 (raw reply), on the v3 mirror, with the
    words that decide completeness kept and everything else neutral."""
    clips, transcript, visual, _ = v3_material()
    words = {
        "00:00:24:19": "placeholder place that's",
        "00:00:27:07": "been placeholder long time",
        "00:00:29:23": "since placeholder, when the",
        "00:00:32:06": "placeholder rolled in, it closed down,",
        "00:00:34:12": "emptied the whole block,",
        "00:00:35:21": "and today placeholder,",
        "00:00:37:21": "and placeholder start.",
        "00:00:49:15": "placeholder and we came over to",
        "00:00:52:00": "see that and placeholder done.",
    }
    for t in transcript:
        if t["clipId"] == "clip-002" and t["startTc"] in words:
            t["text"] = words[t["startTc"]]
    decisions = [
        {**ev("interview", "clip-002", "00:00:27:07", "00:00:35:21", 0.0, "Highway"), "durationSeconds": 8.467},
        {**ev("b-roll", "clip-004", "00:00:04:20", "00:00:09:17", 7.5, "Park sign"), "durationSeconds": 4.9},
        {**ev("interview", "clip-002", "00:00:42:17", "00:00:52:00", 8.467, "Stories"), "durationSeconds": 9.278},
        {**ev("interview", "clip-002", "00:01:02:15", "00:01:17:02", 17.745, "Excited"), "durationSeconds": 14.312},
        {**ev("b-roll", "clip-003", "00:00:06:23", "00:00:11:15", 16.8, "Display board"), "durationSeconds": 4.8},
    ]
    return clips, transcript, visual, decisions


class TestLiveBuildV13Regression(unittest.TestCase):
    def setUp(self):
        self.clips, self.tr, self.visual, raw = v13_material()
        STORE.reset()
        for c in self.clips.values():
            STORE.upsert_clip(c)
        STORE.transcript, STORE.visual_evidence = self.tr, self.visual
        validated, _ = pipeline._validate_decisions(raw, self.clips)
        self.out, self.notes = pipeline._refine(validated, self.clips)
        self.v1 = sorted((d for d in self.out if d["lane"] == "interview"), key=lambda d: d["timelineStartSeconds"])

    def test_incomplete_thoughts_are_completed_and_the_trimmed_repetition_stays_out(self):
        self.assertEqual(
            [(d["label"], d["sourceInTc"], d["sourceOutTc"]) for d in self.v1],
            [("Highway", "00:00:24:19", "00:00:35:21"),   # back to "…place that's" sentence start; ", and today" stays cut
             ("Stories", "00:00:42:17", "00:00:55:02"),   # "…over to" carried on to "…done."
             ("Excited", "00:01:02:15", "00:01:17:02")],  # already complete
        )
        total = self.v1[-1]["timelineStartSeconds"] + self.v1[-1]["durationSeconds"]
        self.assertAlmostEqual(total, 37.92, places=1)
        assert_cut_is_sound(self, self.out, self.clips, self.tr)

    def test_the_directors_cutaways_stay_on_their_jump_cuts(self):
        cuts = editorial.find_jump_cuts(self.out, self.clips)
        self.assertEqual(len(cuts), 2)
        for c in cuts:
            self.assertTrue(any(editorial._covers(d, c["at"]) for d in self.out), c)
        self.assertFalse(any(n.startswith(("Added cutaway", "Jump cut at")) for n in self.notes))


class TestDialogueValidity(unittest.TestCase):
    def test_filler_patterns(self):
        for text in ["Thanks for watching and don't forget to like and subscribe!", "Thank you for watching.",
                     "Please subscribe to my channel", "ご視聴ありがとうございました",
                     "Abone olmayı ve videoyu beğenmeyi unutmayın.", "Subtitles by the Amara.org community"]:
            self.assertTrue(dialogue.is_filler(text), text)
        for text in ["I subscribe to that idea completely.", "Thanks for coming out today.",
                     "We watched the whole thing happen."]:
            self.assertFalse(dialogue.is_filler(text), text)

    def test_multilingual_speech_is_not_discarded(self):
        clips = {"en": clip("en", 10), "es": clip("es", 10)}
        tr = [seg("en", "00:00:00:00", "00:00:05:00", "We built this park together."),
              seg("es", "00:00:00:00", "00:00:05:00", "Construimos este parque juntos."),
              seg("es", "00:00:05:00", "00:00:08:00", "Привет, это моя улица.")]
        a = dialogue.assess_project(clips, tr, [])
        self.assertEqual(a["es"]["status"], dialogue.DIALOGUE)

    def test_foreign_script_alone_is_dialogue_but_with_b_roll_visuals_is_uncertain(self):
        clips = {"en": clip("en", 10), "jp": clip("jp", 10)}
        tr = [seg("en", "00:00:00:00", "00:00:05:00", "We built this park together."),
              seg("jp", "00:00:00:00", "00:00:05:00", "この公園をみんなで作りました。")]
        self.assertEqual(dialogue.assess_project(clips, tr, [])["jp"]["status"], dialogue.DIALOGUE)
        vis = [{"clipId": "jp", "kind": "b-roll", "label": "Park sign"}]
        self.assertEqual(dialogue.assess_project(clips, tr, vis)["jp"]["status"], dialogue.UNCERTAIN)

    def test_all_filler_but_a_face_on_camera_is_uncertain(self):
        clips = {"x": clip("x", 10)}
        tr = [seg("x", "00:00:00:00", "00:00:05:00", "Thanks for watching!")]
        vis = [{"clipId": "x", "kind": "face", "label": "Person smiling"}]
        self.assertEqual(dialogue.assess_project(clips, tr, vis)["x"]["status"], dialogue.UNCERTAIN)

    def test_old_analyses_without_no_speech_data_still_assess(self):
        clips, tr, visual, _ = v3_material()
        self.assertFalse(any("noSpeechProb" in t for t in tr))
        a = dialogue.assess_project(clips, tr, visual)
        self.assertEqual(a["clip-005"]["status"], dialogue.NON_DIALOGUE)

    def test_no_speech_probability_is_used_when_present(self):
        clips = {"en": clip("en", 10), "q": clip("q", 10)}
        tr = [seg("en", "00:00:00:00", "00:00:05:00", "We built this park together."),
              seg("q", "00:00:00:00", "00:00:05:00", "Okay.", noSpeechProb=0.92)]
        self.assertEqual(dialogue.segment_flags(tr[1]), ["no-speech"])
        self.assertEqual(dialogue.assess_project(clips, tr, [])["q"]["status"], dialogue.NON_DIALOGUE)
        tr[1]["noSpeechProb"] = 0.05
        self.assertEqual(dialogue.assess_project(clips, tr, [])["q"]["status"], dialogue.DIALOGUE)

    def test_failed_transcription_is_uncertain_not_b_roll(self):
        c = clip("f", 10, has_transcript=False)
        c.ai["transcription"] = {"status": "failed"}
        self.assertEqual(dialogue.assess_project({"f": c}, [], [])["f"]["status"], dialogue.UNCERTAIN)

    def test_selects_brief_leaves_out_hallucinated_lines(self):
        clips, tr, visual, _ = v3_material()
        STORE.reset()
        for c in clips.values():
            STORE.upsert_clip(c)
        STORE.transcript, STORE.visual_evidence = tr, visual
        fake = FakeReasoningProvider(responses=[[]])
        pipeline._generate_selects(fake)
        brief = fake.calls[0][1][0].text
        self.assertNotIn("like and subscribe", brief)
        self.assertNotIn("ご視聴", brief)
        self.assertIn("clip-002 phrase 5 words", brief)


class TestNoSpeechMetadata(unittest.TestCase):
    def test_segment_json_includes_it_only_when_known(self):
        self.assertNotIn("noSpeechProb", TranscriptSegment(0, 1, "a", 0.9).to_json())
        self.assertEqual(TranscriptSegment(0, 1, "a", 0.9, 0.42).to_json()["noSpeechProb"], 0.42)

    def test_openai_provider_reads_whisper_no_speech_prob(self):
        from providers import openai_provider

        resp = SimpleNamespace(segments=[
            {"start": 0.0, "end": 1.0, "text": " hi ", "avg_logprob": -0.2, "no_speech_prob": 0.873},
            {"start": 1.0, "end": 2.0, "text": "there", "avg_logprob": -0.2},
        ], text="hi there")
        fake_client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=lambda **kw: resp)))
        with tempfile.NamedTemporaryFile(suffix=".wav") as f, \
                mock.patch.object(openai_provider, "_client", return_value=fake_client):
            segs = openai_provider.OpenAIWhisperTranscriptionProvider().transcribe(Path(f.name))
        self.assertEqual([s.no_speech_prob for s in segs], [0.873, None])

    def test_pipeline_saves_it_with_the_transcript(self):
        c = clip("n", 4.0)
        STORE.reset()
        STORE.upsert_clip(c)
        provider = FakeTranscriptionProvider(segments=[TranscriptSegment(0.0, 1.0, "Hello.", 0.9, 0.12),
                                                       TranscriptSegment(1.0, 2.0, "Again.", 0.9)])
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(media, "extract_audio", return_value=True):
            pipeline._transcribe_clip(c, Path(tmp) / "n.mov", Path(tmp), None, provider, [], detect_hum=False)
        self.assertEqual([t.get("noSpeechProb") for t in STORE.transcript], [0.12, None])


if __name__ == "__main__":
    unittest.main()
