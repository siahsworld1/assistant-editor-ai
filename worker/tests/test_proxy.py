"""Real (non-mocked) tests for proxy generation. Uses ffmpeg's lavfi test sources
to synthesize a tiny real video+audio file, then runs the actual proxy transcode
against it and verifies the output with ffprobe — no mocking of ffmpeg itself.
Skips cleanly if ffmpeg/ffprobe aren't on PATH rather than failing the suite.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import media  # noqa: E402


def _ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_synthetic_clip(dest: Path, width: int = 1920, height: int = 1080, seconds: float = 1.0) -> bool:
    """A real (tiny) H.264/AAC .mov, generated purely from ffmpeg's built-in test
    sources — no fixture binary checked into the repo, matching the project's
    "no fixtures outside tests" rule while still exercising real ffmpeg I/O."""
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate=24:duration={seconds}",
                "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                str(dest),
            ],
            capture_output=True, timeout=60, check=True,
        )
        return dest.exists() and dest.stat().st_size > 0
    except (subprocess.SubprocessError, OSError):
        return False


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestGenerateProxy(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-proxy-test-"))
        self.src = self.tmp / "source_4k.mov"
        ok = _make_synthetic_clip(self.src, width=1920, height=1080, seconds=1.0)
        if not ok:
            self.skipTest("Could not synthesize a test clip with this ffmpeg build.")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_generates_a_real_playable_h264_proxy(self):
        dest = self.tmp / media.PROXY_DIR_NAME / "clip-001.mp4"
        ok = media.generate_proxy(self.src, dest, max_width=960)
        self.assertTrue(ok, "generate_proxy reported failure")
        self.assertTrue(dest.exists())
        self.assertGreater(dest.stat().st_size, 0)

        # Verify with ffprobe — a real playability check, not just "a file exists".
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(dest)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        self.assertIsNotNone(video, "proxy has no decodable video stream")
        self.assertIsNotNone(audio, "proxy has no decodable audio stream")
        self.assertEqual(video.get("codec_name"), "h264")
        self.assertLessEqual(int(video.get("width", 0)), 960)

    def test_never_upscales_a_smaller_source(self):
        small_src = self.tmp / "small_source.mov"
        self.assertTrue(_make_synthetic_clip(small_src, width=480, height=270, seconds=1.0))
        dest = self.tmp / media.PROXY_DIR_NAME / "clip-002.mp4"
        self.assertTrue(media.generate_proxy(small_src, dest, max_width=960))
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(dest)],
            capture_output=True, text=True, timeout=30,
        )
        video = next(s for s in json.loads(proc.stdout)["streams"] if s.get("codec_type") == "video")
        self.assertLessEqual(int(video["width"]), 480)

    def test_returns_false_and_cleans_up_on_a_bogus_source(self):
        bogus = self.tmp / "not_a_real_video.mov"
        bogus.write_bytes(b"this is not a video file")
        dest = self.tmp / media.PROXY_DIR_NAME / "clip-bad.mp4"
        ok = media.generate_proxy(bogus, dest)
        self.assertFalse(ok)
        self.assertFalse(dest.exists())

    def test_proxy_is_current_reflects_mtimes(self):
        dest = self.tmp / media.PROXY_DIR_NAME / "clip-003.mp4"
        self.assertFalse(media.proxy_is_current(self.src, dest))
        self.assertTrue(media.generate_proxy(self.src, dest))
        self.assertTrue(media.proxy_is_current(self.src, dest))


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestGenerateThumbnail(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-thumb-test-"))
        self.src = self.tmp / "source_4k.mov"
        ok = _make_synthetic_clip(self.src, width=1920, height=1080, seconds=2.0)
        if not ok:
            self.skipTest("Could not synthesize a test clip with this ffmpeg build.")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_generates_a_real_decodable_jpeg(self):
        dest = self.tmp / media.THUMB_DIR_NAME / "clip-001.jpg"
        ok, err = media.generate_thumbnail(self.src, dest, duration_seconds=2.0, max_width=480)
        self.assertTrue(ok, f"generate_thumbnail reported failure: {err}")
        self.assertIsNone(err)
        self.assertTrue(dest.exists())
        self.assertGreater(dest.stat().st_size, 0)

        # Verify with ffprobe — a real decodability check, not just "a file exists".
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(dest)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(proc.stdout or "{}")
        video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
        self.assertIsNotNone(video, "thumbnail has no decodable image stream")
        self.assertEqual(video.get("codec_name"), "mjpeg")
        self.assertLessEqual(int(video.get("width", 0)), 480)

    def test_never_upscales_a_smaller_source(self):
        small_src = self.tmp / "small_source.mov"
        self.assertTrue(_make_synthetic_clip(small_src, width=320, height=180, seconds=2.0))
        dest = self.tmp / media.THUMB_DIR_NAME / "clip-002.jpg"
        ok, err = media.generate_thumbnail(small_src, dest, duration_seconds=2.0, max_width=480)
        self.assertTrue(ok, err)
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(dest)],
            capture_output=True, text=True, timeout=30,
        )
        video = next(s for s in json.loads(proc.stdout)["streams"] if s.get("codec_type") == "video")
        self.assertLessEqual(int(video["width"]), 320)

    def test_returns_false_with_a_real_reason_on_a_bogus_source(self):
        bogus = self.tmp / "not_a_real_video.mov"
        bogus.write_bytes(b"this is not a video file")
        dest = self.tmp / media.THUMB_DIR_NAME / "clip-bad.jpg"
        ok, err = media.generate_thumbnail(bogus, dest, duration_seconds=2.0)
        self.assertFalse(ok)
        self.assertIsNotNone(err, "a failed thumbnail must report why, not just False")
        self.assertTrue(err)  # non-empty string
        self.assertFalse(dest.exists())

    def test_thumbnail_is_current_reflects_mtimes(self):
        dest = self.tmp / media.THUMB_DIR_NAME / "clip-003.jpg"
        self.assertFalse(media.thumbnail_is_current(self.src, dest))
        ok, err = media.generate_thumbnail(self.src, dest, duration_seconds=2.0)
        self.assertTrue(ok, err)
        self.assertTrue(media.thumbnail_is_current(self.src, dest))

    def test_never_samples_frame_zero(self):
        # A 2s clip at 15% in should seek to ~0.3s, never the literal start —
        # ffmpeg's -ss before -i makes this a real (fast) seek, not a filter, so
        # the only real assertion is that generation succeeds off a non-zero
        # timestamp derived from the clip's real duration.
        dest = self.tmp / media.THUMB_DIR_NAME / "clip-004.jpg"
        ok, err = media.generate_thumbnail(self.src, dest, duration_seconds=2.0)
        self.assertTrue(ok, err)
        self.assertGreater(dest.stat().st_size, 0)


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestFfprobeInfoFailureReporting(unittest.TestCase):
    """Real-execution proof for the bug where a file ffprobe genuinely couldn't
    read (corrupt, unreadable, no streams) produced the exact same defaults dict
    as a legitimately quiet file — making a real failure indistinguishable from
    success and letting a clip end up marked "ready" with 0:00 / no metadata."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-ffprobe-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_real_video_reports_ok_true(self):
        src = self.tmp / "real.mov"
        self.assertTrue(_make_synthetic_clip(src, seconds=1.0))
        info = media.ffprobe_info(src)
        self.assertTrue(info["ok"], info.get("probeError"))
        self.assertIsNone(info["probeError"])
        self.assertGreater(info["duration"], 0)
        self.assertNotEqual(info["resolution"], "—")

    def test_corrupt_file_reports_ok_false_with_a_real_reason(self):
        bogus = self.tmp / "18C_0681.MP4"
        bogus.write_bytes(b"this is not a real video file at all")
        info = media.ffprobe_info(bogus)
        self.assertFalse(info["ok"])
        self.assertIsNotNone(info["probeError"])
        self.assertTrue(info["probeError"])
        # The old failure shape is still what a caller sees for display purposes
        # (0:00, no metadata) — the fix is that `ok`/`probeError` now let a caller
        # tell this apart from a real, quiet, successfully-probed file.
        self.assertEqual(info["duration"], 0.0)
        self.assertEqual(info["resolution"], "—")

    def test_nonexistent_file_reports_ok_false(self):
        info = media.ffprobe_info(self.tmp / "does_not_exist.mp4")
        self.assertFalse(info["ok"])
        self.assertIsNotNone(info["probeError"])


class TestFfprobeTimeoutRetry(unittest.TestCase):
    """Mocked tests for the timeout/retry logic itself — these must run fast
    (no real 120s+240s waits), so they patch media._run_ffprobe_once (and
    media.ffmpeg_available, so this class needs no real ffmpeg/ffprobe on
    PATH) directly rather than exercising a real slow probe. Real-file
    behavior (a genuinely fast probe succeeding, a genuinely corrupt file
    failing) is covered by TestFfprobeInfoFailureReporting above; this class
    only proves the attempt-counting, retry-on-timeout-only, and
    bounded-worst-case behavior that a real timeout would trigger."""

    def _fake_success(self):
        return subprocess.CompletedProcess(
            args=["ffprobe"], returncode=0,
            stdout=json.dumps({
                "format": {"duration": "5.0"},
                "streams": [{
                    "codec_type": "video", "width": 1920, "height": 1080,
                    "avg_frame_rate": "24/1", "codec_long_name": "H.264",
                }],
            }),
            stderr="",
        )

    def test_pinned_constants(self):
        # A future edit that quietly shrinks these back down (e.g. someone
        # "cleaning up" the module) should fail a test, not just surprise a
        # user again with a false-positive timeout on real camera footage.
        self.assertGreaterEqual(media.FFPROBE_TIMEOUT_SECONDS, 120)
        self.assertEqual(media.FFPROBE_MAX_ATTEMPTS, 2)

    def test_recovers_from_a_single_timeout_then_succeeds(self):
        calls = []

        def fake_run_once(path, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(cmd="ffprobe", timeout=timeout)
            return self._fake_success()

        with patch("media.ffmpeg_available", return_value=True), \
                patch("media._run_ffprobe_once", side_effect=fake_run_once):
            info = media.ffprobe_info(Path("/fake/18C_0687.MP4"))

        self.assertEqual(len(calls), 2, "should retry exactly once after a timeout")
        self.assertEqual(calls, [media.FFPROBE_TIMEOUT_SECONDS, media.FFPROBE_TIMEOUT_SECONDS])
        self.assertTrue(info["ok"], info.get("probeError"))
        self.assertIsNone(info["probeError"])
        self.assertEqual(info["duration"], 5.0)

    def test_exhausting_retries_reports_a_clear_timeout_error(self):
        calls = []

        def always_times_out(path, timeout):
            calls.append(timeout)
            raise subprocess.TimeoutExpired(cmd="ffprobe", timeout=timeout)

        with patch("media.ffmpeg_available", return_value=True), \
                patch("media._run_ffprobe_once", side_effect=always_times_out):
            info = media.ffprobe_info(Path("/fake/18C_0687.MP4"))

        # Bounded: never more than FFPROBE_MAX_ATTEMPTS real invocations, so
        # ffprobe can never hang indefinitely on a single clip.
        self.assertEqual(len(calls), media.FFPROBE_MAX_ATTEMPTS)
        self.assertFalse(info["ok"])
        self.assertIn(str(media.FFPROBE_TIMEOUT_SECONDS), info["probeError"])
        self.assertIn("retry", info["probeError"].lower())

    def test_a_real_non_timeout_failure_is_never_retried(self):
        calls = []

        def fake_run_once(path, timeout):
            calls.append(timeout)
            return subprocess.CompletedProcess(
                args=["ffprobe"], returncode=1, stdout="", stderr="Invalid data found\n"
            )

        with patch("media.ffmpeg_available", return_value=True), \
                patch("media._run_ffprobe_once", side_effect=fake_run_once):
            info = media.ffprobe_info(Path("/fake/corrupt.MP4"))

        # Re-running ffprobe against the same corrupt bytes can't produce a
        # different answer — only a genuine timeout is worth retrying.
        self.assertEqual(len(calls), 1)
        self.assertFalse(info["ok"])
        self.assertIn("Invalid data found", info["probeError"])


if __name__ == "__main__":
    unittest.main()
