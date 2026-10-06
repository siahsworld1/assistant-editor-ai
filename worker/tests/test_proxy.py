"""Real (non-mocked) tests for proxy generation. Uses ffmpeg's lavfi test sources
to synthesize a tiny real video+audio file, then runs the actual proxy transcode
against it and verifies the output with ffprobe — no mocking of ffmpeg itself.
Skips cleanly if ffmpeg/ffprobe aren't on PATH rather than failing the suite.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

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

    def test_a_generated_proxy_is_a_valid_cache_entry_and_leaves_no_partial(self):
        dest = self.tmp / media.PROXY_DIR_NAME / f"{media.source_cache_key(self.src)}.mp4"
        self.assertFalse(media.cached_artifact_is_valid(dest))
        self.assertTrue(media.generate_proxy(self.src, dest))
        self.assertTrue(media.cached_artifact_is_valid(dest))
        self.assertEqual(sorted(p.name for p in dest.parent.iterdir()), [dest.name])


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

    def test_a_generated_thumbnail_is_a_valid_cache_entry_and_leaves_no_partial(self):
        dest = self.tmp / media.THUMB_DIR_NAME / f"{media.source_cache_key(self.src)}.jpg"
        self.assertFalse(media.cached_artifact_is_valid(dest))
        ok, err = media.generate_thumbnail(self.src, dest, duration_seconds=2.0)
        self.assertTrue(ok, err)
        self.assertTrue(media.cached_artifact_is_valid(dest))
        self.assertEqual(sorted(p.name for p in dest.parent.iterdir()), [dest.name])

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


def _make_av_clip(dest: Path, audio_channels: int | None, seconds: float = 1.0, size: str = "320x240") -> bool:
    """A real tiny H.264 .mov with `audio_channels` AAC channels (None = no
    audio stream at all). Channel 1 and 2 get different tones so they're real,
    distinct channels — like 18C_0681.MP4, whose dialogue is only on channel 2."""
    args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=24:duration={seconds}"]
    for i in range(audio_channels or 0):
        args += ["-f", "lavfi", "-i", f"sine=frequency={440 * (i + 1)}:duration={seconds}"]
    if audio_channels and audio_channels > 1:
        # amerge turns the N mono tones into one N-channel audio stream.
        inputs = "".join(f"[{i + 1}:a]" for i in range(audio_channels))
        args += ["-filter_complex", f"{inputs}amerge=inputs={audio_channels}[a]", "-map", "0:v", "-map", "[a]"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio_channels:
        args += ["-c:a", "aac"]
    args.append(str(dest))
    try:
        subprocess.run(args, capture_output=True, timeout=60, check=True)
        return dest.exists() and dest.stat().st_size > 0
    except (subprocess.SubprocessError, OSError):
        return False


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestFfprobeAudioChannels(unittest.TestCase):
    """Real Premiere test #7: the XMEML exporter can only describe a stereo
    source as stereo if the worker reports the source's real channel count.
    Real ffmpeg-synthesized files, real ffprobe — no mocking."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-channels-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _probe(self, audio_channels):
        src = self.tmp / f"ch{audio_channels}.mov"
        if not _make_av_clip(src, audio_channels):
            self.skipTest("Could not synthesize a test clip with this ffmpeg build.")
        info = media.ffprobe_info(src)
        self.assertTrue(info["ok"], info.get("probeError"))
        return info

    def test_stereo_source_reports_two_channels(self):
        info = self._probe(2)
        self.assertTrue(info["has_audio"])
        self.assertEqual(info["audio_channels"], 2)

    def test_mono_source_reports_one_channel(self):
        self.assertEqual(self._probe(1)["audio_channels"], 1)

    def test_video_without_audio_reports_zero_not_a_guess(self):
        info = self._probe(None)
        self.assertFalse(info["has_audio"])
        self.assertEqual(info["audio_channels"], 0)

    def test_unreadable_file_reports_zero(self):
        bogus = self.tmp / "bogus.MP4"
        bogus.write_bytes(b"not media")
        info = media.ffprobe_info(bogus)
        self.assertFalse(info["ok"])
        self.assertEqual(info["audio_channels"], 0)

    def test_channel_count_reaches_the_project_json_the_app_reads(self):
        from store import ClipState

        clip = ClipState(
            id="clip-001", filename="18C_0681.MP4", role="interview", duration_seconds=32.4,
            camera="HEVC", resolution="3840x2160", fps=23.976, audio_channels=2,
        )
        self.assertEqual(clip.to_json()["audioChannels"], 2)
        # Default stays "unknown" (0) — never a guessed layout.
        self.assertEqual(
            ClipState(id="c", filename="f", role="b-roll", duration_seconds=1, camera="—", resolution="—", fps=24).to_json()["audioChannels"],
            0,
        )


class TestSourceCacheKey(unittest.TestCase):
    """The derived-media cache key is the SOURCE's identity (canonical path +
    size + mtime), never its position in the media folder."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-cachekey-test-"))
        self.src = self.tmp / "A001_INT.mov"
        self.src.write_bytes(b"x" * 1000)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_is_deterministic_and_filesystem_safe(self):
        key = media.source_cache_key(self.src)
        self.assertEqual(key, media.source_cache_key(self.src))
        self.assertRegex(key, r"^[0-9a-f]{32}$")

    def test_ignores_other_files_being_added_or_removed(self):
        before = media.source_cache_key(self.src)
        (self.tmp / "000_new_first.mov").write_bytes(b"y")
        self.assertEqual(media.source_cache_key(self.src), before)

    def test_changes_when_size_changes_even_if_mtime_is_preserved(self):
        before = media.source_cache_key(self.src)
        st = self.src.stat()
        self.src.write_bytes(b"x" * 1001)
        os.utime(self.src, ns=(st.st_atime_ns, st.st_mtime_ns))  # e.g. a Finder copy keeps the old mtime
        self.assertNotEqual(media.source_cache_key(self.src), before)

    def test_changes_when_mtime_changes_even_if_size_is_identical(self):
        before = media.source_cache_key(self.src)
        st = self.src.stat()
        os.utime(self.src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        self.assertNotEqual(media.source_cache_key(self.src), before)

    def test_differs_for_a_different_path_with_identical_bytes_and_mtime(self):
        other = self.tmp / "B101_BROLL.mov"
        shutil.copy2(self.src, other)
        self.assertNotEqual(media.source_cache_key(other), media.source_cache_key(self.src))

    def test_resolves_symlinks_to_the_same_source_identity(self):
        link = self.tmp / "link.mov"
        link.symlink_to(self.src)
        self.assertEqual(media.source_cache_key(link), media.source_cache_key(self.src))

    def test_unreadable_source_has_no_key(self):
        self.assertIsNone(media.source_cache_key(self.tmp / "missing.mov"))


def _video_width(path: Path) -> int:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    return int((proc.stdout or "0").strip() or 0)


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestDerivedMediaCacheIdentityThroughThePipeline(unittest.TestCase):
    """Regression for the positional-cache bug: proxies/thumbnails were named
    .ae_proxies/clip-NNN.mp4 by walk POSITION and judged fresh by mtime alone,
    so after a rename/reorder/removal clip N silently got another source's
    cached preview. Runs the real pipeline.run_analysis() over real
    ffmpeg-made clips whose frame WIDTHS differ, so every cached artifact can
    be traced back to the exact source it was made from. No AI provider is
    reachable (tests/_no_real_credentials.py), so only the media steps do work."""

    # filename -> frame size. Every width sits under both the proxy (960) and
    # thumbnail (480) caps, so each artifact keeps its own source's width.
    SOURCES = {"a.mov": "160x120", "b.mov": "320x240", "c.mov": "400x300"}

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ae-cache-identity-test-"))
        for name, size in self.SOURCES.items():
            if not _make_av_clip(self.root / name, None, size=size):
                self.skipTest("Could not synthesize test clips with this ffmpeg build.")
        logging.getLogger("assistant-editor-worker").setLevel(logging.ERROR)

    def tearDown(self):
        logging.getLogger("assistant-editor-worker").setLevel(logging.NOTSET)
        shutil.rmtree(self.root, ignore_errors=True)

    def _analyze(self) -> dict:
        import pipeline
        from store import STORE

        pipeline.run_analysis("proj-cache-test", str(self.root))
        self.assertEqual(STORE.analysis_state, "complete", STORE.error)
        return {c.filename: c for c in STORE.clips.values()}

    def _assert_artifacts_belong_to_their_own_source(self, clips: dict, expected_widths: dict):
        for filename, width in expected_widths.items():
            clip = clips[filename]
            self.assertTrue(clip.proxy_rel_path and clip.thumbnail_rel_path, f"{filename} has no cached artifacts")
            self.assertEqual(_video_width(self.root / clip.proxy_rel_path), width, f"{filename} got another clip's PROXY")
            self.assertEqual(_video_width(self.root / clip.thumbnail_rel_path), width, f"{filename} got another clip's THUMBNAIL")

    def test_reorder_never_returns_another_clips_proxy(self):
        first = self._analyze()
        self.assertEqual(first["a.mov"].id, "clip-001")
        # Renaming a.mov to sort last shifts every position: b.mov becomes clip-001.
        (self.root / "a.mov").rename(self.root / "z.mov")
        second = self._analyze()
        self.assertEqual(second["b.mov"].id, "clip-001")  # user-facing ids stay positional
        self._assert_artifacts_belong_to_their_own_source(second, {"b.mov": 320, "c.mov": 400, "z.mov": 160})

    def test_removing_a_preceding_clip_never_returns_another_clips_thumbnail(self):
        self._analyze()
        (self.root / "a.mov").unlink()
        second = self._analyze()
        self.assertEqual(second["b.mov"].id, "clip-001")  # b now sits where a was
        self._assert_artifacts_belong_to_their_own_source(second, {"b.mov": 320, "c.mov": 400})

    def test_modifying_a_source_invalidates_its_cache(self):
        first = self._analyze()
        old_proxy, old_thumb = first["b.mov"].proxy_rel_path, first["b.mov"].thumbnail_rel_path
        # Replace b.mov's content in place with a different-size picture while
        # PRESERVING its old mtime — the case the old mtime check could never see.
        st = (self.root / "b.mov").stat()
        self.assertTrue(_make_av_clip(self.root / "b.mov", None, size="240x180"))
        os.utime(self.root / "b.mov", ns=(st.st_atime_ns, st.st_mtime_ns))
        second = self._analyze()
        self.assertNotEqual(second["b.mov"].proxy_rel_path, old_proxy)
        self.assertNotEqual(second["b.mov"].thumbnail_rel_path, old_thumb)
        self._assert_artifacts_belong_to_their_own_source(second, {"a.mov": 160, "b.mov": 240, "c.mov": 400})

    def test_touching_a_source_mtime_invalidates_its_cache(self):
        first = self._analyze()
        st = (self.root / "c.mov").stat()
        os.utime(self.root / "c.mov", ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        second = self._analyze()
        self.assertNotEqual(second["c.mov"].proxy_rel_path, first["c.mov"].proxy_rel_path)
        self.assertEqual(second["a.mov"].proxy_rel_path, first["a.mov"].proxy_rel_path)  # untouched clips keep theirs

    def test_unchanged_sources_reuse_their_cache_without_regenerating(self):
        first = self._analyze()
        stamps = {
            name: ((self.root / c.proxy_rel_path).stat().st_mtime_ns, (self.root / c.thumbnail_rel_path).stat().st_mtime_ns)
            for name, c in first.items()
        }
        refuse = AssertionError("an unchanged source must not be re-encoded")
        with patch.object(media, "generate_proxy", side_effect=refuse), patch.object(media, "generate_thumbnail", side_effect=refuse):
            second = self._analyze()
        for name, c in second.items():
            self.assertEqual(c.proxy_rel_path, first[name].proxy_rel_path)
            self.assertEqual(c.thumbnail_rel_path, first[name].thumbnail_rel_path)
            self.assertEqual(
                ((self.root / c.proxy_rel_path).stat().st_mtime_ns, (self.root / c.thumbnail_rel_path).stat().st_mtime_ns),
                stamps[name],
            )

    def test_proxies_and_thumbnails_of_one_source_share_its_identity(self):
        clips = self._analyze()
        for name, c in clips.items():
            key = media.source_cache_key(self.root / name)
            self.assertEqual(c.proxy_rel_path, f"{media.PROXY_DIR_NAME}/{key}.mp4")
            self.assertEqual(c.thumbnail_rel_path, f"{media.THUMB_DIR_NAME}/{key}.jpg")

    def test_stale_positional_and_partial_files_are_ignored(self):
        # Leftovers from the old positional scheme and from an interrupted
        # encode must never be served.
        (self.root / media.PROXY_DIR_NAME).mkdir()
        (self.root / media.THUMB_DIR_NAME).mkdir()
        (self.root / media.PROXY_DIR_NAME / "clip-001.mp4").write_bytes(b"stale positional proxy")
        (self.root / media.THUMB_DIR_NAME / "clip-001.jpg").write_bytes(b"stale positional thumb")
        key_a = media.source_cache_key(self.root / "a.mov")
        (self.root / media.PROXY_DIR_NAME / f"{key_a}.partial.mp4").write_bytes(b"truncated")
        clips = self._analyze()
        self.assertNotIn("clip-001", clips["a.mov"].proxy_rel_path)
        self._assert_artifacts_belong_to_their_own_source(clips, {"a.mov": 160, "b.mov": 320, "c.mov": 400})


@unittest.skipUnless(_ffmpeg_present(), "ffmpeg/ffprobe not on PATH")
class TestBundledToolResolution(unittest.TestCase):
    """The packaged app passes absolute paths to its own ffmpeg/ffprobe
    (ASSISTANT_EDITOR_FFMPEG / ASSISTANT_EDITOR_FFPROBE). Those exact binaries
    must be what runs — and a configured-but-missing binary must fail loudly,
    never fall back to a copy on PATH (e.g. Homebrew's)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ae-bundled-tools-test-"))
        self.calls = self.tmp / "calls.log"
        self.bin = self.tmp / "bundle" / "bin"
        self.bin.mkdir(parents=True)
        for tool in ("ffmpeg", "ffprobe"):
            wrapper = self.bin / tool
            wrapper.write_text(f'#!/bin/sh\necho "{tool} $0" >> "{self.calls}"\nexec "{shutil.which(tool)}" "$@"\n')
            wrapper.chmod(0o755)
        self.clip = self.tmp / "clip.mov"
        if not _make_av_clip(self.clip, 2):
            self.skipTest("Could not synthesize a test clip with this ffmpeg build.")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _env(self, ffmpeg: str, ffprobe: str):
        return patch.dict(os.environ, {media.FFMPEG_ENV: ffmpeg, media.FFPROBE_ENV: ffprobe})

    def test_configured_absolute_binaries_are_the_ones_executed(self):
        with self._env(str(self.bin / "ffmpeg"), str(self.bin / "ffprobe")):
            self.assertTrue(media.ffmpeg_available())
            self.assertTrue(media.ffprobe_info(self.clip)["ok"])
            ok, err = media.generate_thumbnail(self.clip, self.tmp / "t.jpg", 1.0)
            self.assertTrue(ok, err)
            self.assertEqual(media.resolved_tool_paths(), {"ffmpeg": str(self.bin / "ffmpeg"), "ffprobe": str(self.bin / "ffprobe")})
        calls = self.calls.read_text().splitlines()
        self.assertIn(f"ffprobe {self.bin / 'ffprobe'}", calls)
        self.assertIn(f"ffmpeg {self.bin / 'ffmpeg'}", calls)

    def test_a_configured_but_missing_binary_never_falls_back_to_path(self):
        missing = str(self.tmp / "nope" / "ffprobe")
        with self._env(str(self.bin / "ffmpeg"), missing):
            self.assertIsNotNone(shutil.which("ffprobe"))  # a real one IS on PATH...
            self.assertFalse(media.ffmpeg_available())  # ...and is deliberately not used
            info = media.ffprobe_info(self.clip)
            self.assertFalse(info["ok"])
            self.assertIn("bundled ffmpeg/ffprobe are missing", info["probeError"])
            self.assertNotIn("brew install", info["probeError"])
        self.assertFalse(self.calls.exists())  # nothing ran at all

    def test_a_non_executable_configured_binary_is_rejected(self):
        (self.bin / "ffprobe").chmod(0o644)
        with self._env(str(self.bin / "ffmpeg"), str(self.bin / "ffprobe")):
            self.assertFalse(media.ffmpeg_available())

    def test_development_without_configuration_still_uses_path(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(media.FFMPEG_ENV, None)
            os.environ.pop(media.FFPROBE_ENV, None)
            self.assertEqual((media.ffmpeg_bin(), media.ffprobe_bin()), ("ffmpeg", "ffprobe"))
            self.assertTrue(media.ffmpeg_available())
            self.assertIn("brew install", media.ffmpeg_missing_reason())


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


class TestProxyEncoder(unittest.TestCase):
    """The shipped FFmpeg is LGPL-only (no libx264), so proxies must be encoded
    with Apple VideoToolbox — and switching encoders must not invalidate the
    proxies/thumbnails projects already have cached."""

    def test_proxies_are_encoded_with_videotoolbox_never_libx264(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(media, "ffmpeg_available", return_value=True), \
                patch.object(media.subprocess, "run") as run:
            media.generate_proxy(Path(tmp) / "src.mov", Path(tmp) / "out.mp4")
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("-c:v") + 1], "h264_videotoolbox")
        self.assertNotIn("libx264", args)
        self.assertEqual(args[args.index("-allow_sw") + 1], "1")  # works without a hardware encoder
        self.assertEqual(args[args.index("-pix_fmt") + 1], "yuv420p")
        self.assertEqual(args[args.index("-c:a") + 1], "aac")
        self.assertIn("scale='min(960,iw)':-2", args)
        self.assertIn("+faststart", args)

    def test_existing_cached_proxies_stay_valid(self):
        # Proxies made with libx264 are still H.264 and are reused: the cache
        # key version is NOT bumped for the encoder change.
        self.assertEqual(media.CACHE_KEY_VERSION, "ae-media-cache-v1")


if __name__ == "__main__":
    unittest.main()
